// Tests for hooks/jev.sh against a local stub of the TypeSafe API.
// Run: node --test hooks/jev.test.ts
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";

const JEV = path.join(import.meta.dirname, "jev.sh");
const BASH = execFileSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).trim();

interface Run {
  stdout: string;
  status: number | null;
}

interface StubRequest {
  authorization: string | undefined;
  body: string;
}

let tmp = "";
let configFile = "";
let logFile = "";
let baseUrl = "";
let stub: http.Server;
const requests: StubRequest[] = [];
let apiKey: string | undefined;

/** Stub API: answers by question type, records requests, and returns 500 for a state containing FAIL. */
function startStub(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ authorization: req.headers.authorization, body });
      const parsed = JSON.parse(body);
      if (JSON.stringify(parsed.state).includes("FAIL")) {
        res.writeHead(500);
        res.end();
        return;
      }
      const question = parsed.questions.q;
      const answer =
        question.type === "noul"
          ? { type: "noul", noul: JSON.stringify(parsed.state).includes("OPEN") ? 0.9 : 0.04 }
          : { type: "choice", choice: "story", confidence: 0.8, probabilities: { epic: 0.05, story: 0.85, task: 0.1 } };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: parsed.model, answers: { q: answer }, usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  const { promise, resolve } = Promise.withResolvers<http.Server>();
  server.listen(0, "127.0.0.1", () => resolve(server));
  return promise;
}

/** Runs `bash hooks/jev.sh ARGS` asynchronously (the stub lives in this process, so no spawnSync). */
function jev(args: string[], opts: { cwd: string; input?: string; env?: NodeJS.ProcessEnv }): Promise<Run> {
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))),
    AGENT_SKILLS_CONFIG: configFile,
    AGENT_SKILLS_JEV_LOG: logFile,
    TYPESAFE_BASE_URL: baseUrl,
    ...opts.env,
  };
  if (apiKey === undefined) delete env.TYPESAFE_API_KEY;
  else env.TYPESAFE_API_KEY = apiKey;
  const { promise, resolve, reject } = Promise.withResolvers<Run>();
  const child = spawn(BASH, [JEV, ...args], { cwd: opts.cwd, env, stdio: ["pipe", "pipe", "ignore"] });
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.on("error", reject);
  child.on("close", (status) => resolve({ stdout: stdout.replace(/\n+$/, ""), status }));
  child.stdin.on("error", () => {});
  child.stdin.end(opts.input ?? "");
  return promise;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function idOf(line: string): string {
  return line.replace(/^jev=/, "").split(" ")[0];
}

function logLines(): number {
  return fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).length;
}

let app = "";
let portal = "";
let id1 = "";
let id2 = "";
let id3 = "";
let scopeId = "";

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jev-test-"));
  configFile = path.join(tmp, "config.json");
  logFile = path.join(tmp, "log.jsonl");
  stub = await startStub();
  baseUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  app = path.join(tmp, "app");
  portal = path.join(tmp, "client-portal");
  for (const dir of [app, portal]) {
    fs.mkdirSync(dir);
    git(dir, "init", "-q", "-b", "main");
  }
  git(app, "remote", "add", "origin", "git@github.com:acme/clinic-records.git");
  apiKey = "k-test";
});

after(async () => {
  stub.closeAllConnections();
  const closed = Promise.withResolvers<void>();
  stub.close(() => closed.resolve());
  await closed.promise;
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Off unless enabled, even with a key: nothing is sent.
test("no config", async () => {
  const r = await jev(["checkpoint", "-", "--step", "1/6"], { cwd: portal, input: "x\n" });
  assert.equal(r.stdout, "jev=skipped reason=disabled");
});

test("enabled false", async () => {
  fs.writeFileSync(configFile, '{"vault": "/v", "jev": {"enabled": false}}\n');
  const r = await jev(["scope", "-"], { cwd: portal, input: "x\n" });
  assert.equal(r.stdout, "jev=skipped reason=disabled");
});

// The deny list matches the worktree folder, case-insensitively.
test("denied by folder", async () => {
  fs.writeFileSync(configFile, '{"jev": {"enabled": true, "deny": ["CLIENT*"]}}\n');
  const r = await jev(["checkpoint", "-", "--step", "1/6"], { cwd: portal, input: "x\n" });
  assert.equal(r.stdout, "jev=skipped reason=denied:client-portal");
});

// ...and the origin remote's repo name, even when the folder is allowed.
test("denied by origin", async () => {
  fs.writeFileSync(configFile, '{"jev": {"enabled": true, "deny": ["clinic*"]}}\n');
  const r = await jev(["scope", "-"], { cwd: app, input: "x\n" });
  assert.equal(r.stdout, "jev=skipped reason=denied:clinic-records");
});

// Outside a repository it fails closed.
test("no repo", async () => {
  fs.writeFileSync(configFile, '{"jev": {"enabled": true, "deny": []}}\n');
  const r = await jev(["scope", "-"], { cwd: tmp, input: "x\n" });
  assert.equal(r.stdout, "jev=skipped reason=no-repo");
});

test("no key", async () => {
  apiKey = undefined;
  const r = await jev(["scope", "-"], { cwd: app, input: "x\n" });
  assert.equal(r.stdout, "jev=skipped reason=no-key");
});

test("nothing sent while blocked", () => {
  assert.equal(requests.length, 0);
});

// Allowed: predictions are sent with the key and pinned model, and logged without the text.
test("checkpoint answer", async () => {
  apiKey = "k-test";
  const cp1 = await jev(["checkpoint", "-", "--step", "4/11 Flows", "--story", "refunds"], {
    cwd: app,
    input: "OPEN: sync or async ingestion?\n",
  });
  assert.ok(cp1.stdout.includes("p_open=0.900 model=jev-1.13.0"), cp1.stdout);
  id1 = idOf(cp1.stdout);
  const cp2 = await jev(["checkpoint", "-", "--step", "3/11 Components", "--story", "refunds", "--task", "t01-api"], {
    cwd: app,
    input: "Components: webhook route, worker\n",
  });
  id2 = idOf(cp2.stdout);
  const cp3 = await jev(["checkpoint", "-", "--step", "2/11 Scope", "--story", "refunds"], {
    cwd: app,
    input: "Scope: refunds only\n",
  });
  id3 = idOf(cp3.stdout);
});

test("bearer key and pinned model sent", () => {
  const sent = requests.map((r) => `${r.authorization} ${r.body}`).join("\n");
  assert.ok(sent.includes('Bearer k-test {"model":"jev-1.13.0"'), sent);
});

test("scope answer", async () => {
  const sc = await jev(["scope", "-"], { cwd: app, input: "Add partial refunds\n" });
  assert.ok(
    sc.stdout.includes("scope=story p_epic=0.050 p_story=0.850 p_task=0.100 confidence=0.800"),
    sc.stdout,
  );
  scopeId = idOf(sc.stdout);
});

test("text not logged", () => {
  assert.equal(fs.readFileSync(logFile, "utf8").match(/sync or async|partial refunds/g), null);
});

// Failures never block: they print skipped and log nothing.
let linesBefore = 0;
test("http error", async () => {
  linesBefore = logLines();
  const r = await jev(["scope", "-"], { cwd: app, input: "FAIL\n" });
  assert.equal(r.stdout, "jev=skipped reason=http-500");
});

test("failure not logged", () => {
  assert.equal(logLines(), linesBefore);
});

test("unreachable", async () => {
  const r = await jev(["scope", "-"], { cwd: app, input: "x\n", env: { TYPESAFE_BASE_URL: "http://127.0.0.1:1" } });
  assert.equal(r.stdout, "jev=skipped reason=network");
});

// Outcomes are validated against the prediction's kind.
test("wrong outcome kind exits 2", async () => {
  assert.equal((await jev(["outcome", id1, "story"], { cwd: app })).status, 2);
});

test("unknown id exits 2", async () => {
  assert.equal((await jev(["outcome", "nope", "none"], { cwd: app })).status, 2);
});

let rep = "";
test("pending count", async () => {
  await jev(["outcome", id1, "decision"], { cwd: app });
  await jev(["outcome", id2, "none"], { cwd: app });
  await jev(["outcome", id3, "none"], { cwd: app });
  await jev(["outcome", id3, "decision"], { cwd: app }); // a later outcome replaces the earlier one
  await jev(["outcome", scopeId, "task"], { cwd: app });
  rep = (await jev(["report"], { cwd: app })).stdout;
  assert.ok(rep.includes("predictions without an outcome: 0"), rep);
});

test("checkpoint totals", () => {
  assert.ok(rep.includes("checkpoint: 3 paired (2 with a decision, 1 without)"), rep);
});

// Only cp2 (p_open 0.04, outcome none) and cp3 (0.04, latest outcome decision) fall under 0.05.
test("threshold row", () => {
  assert.ok(rep.includes("p_open<0.05      2/3          1/2"), rep);
});

test("scope agreement", () => {
  assert.ok(rep.includes("Jev agreed with the settled scope 0/1"), rep);
});

test("usage error exits 2", async () => {
  assert.equal((await jev(["checkpoint", "-"], { cwd: app })).status, 2);
});

// A node older than 22.18 cannot strip types, and with no bun the wrapper must skip, not crash.
test("old node without bun skips with no-runtime", async () => {
  const bin = path.join(tmp, "oldbin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "node"), "#!/bin/sh\necho 20.11.0\n", { mode: 0o755 });
  const r = await jev(["status"], { cwd: app, env: { PATH: bin } });
  assert.equal(r.stdout, "jev=skipped reason=no-runtime");
  assert.equal(r.status, 0);
});

test("status prints enabled", async () => {
  const r = await jev(["status"], { cwd: app });
  assert.ok(r.stdout.startsWith("enabled=true "), r.stdout);
});
