// Shadow pilot for TypeSafe's Jev decision model at two workflow hand-offs:
// "does this checkpoint leave a decision open?" and "is this request an epic,
// story, or task?". It records Jev's answer next to what actually happened and
// never changes the workflow. See hooks/JEV-SHADOW.md.
//
//   jev.sh status
//   jev.sh checkpoint FILE|- --step "N/M name" [--story ID] [--task ID]
//   jev.sh scope FILE|-
//   jev.sh outcome ID ACTUAL        checkpoint: decision | none · scope: epic | story | task
//   jev.sh report
//
// Every prediction command exits 0 and prints `jev=skipped reason=…` when it
// can't or mustn't run (disabled, denied repository, no key, network error).
//
// Runs as TypeScript directly: bun, or node >= 22.18 (built-in type stripping),
// so only erasable syntax is used here. jev.sh picks the runtime.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Kind = "checkpoint" | "scope";
type Probabilities = { epic?: number; story?: number; task?: number };

/** The `jev` section of the agent-skills config, narrowed field by field. */
interface JevConfig {
  enabled: boolean;
  deny: string[];
  /** Whatever the file held; only a non-empty string is used for requests. */
  model: unknown;
}

/** What the API answered for the single question `q`. */
interface Answer {
  noul?: number;
  choice?: string;
  confidence?: number;
  probabilities?: Probabilities;
}

type AskResult = { answer: Answer; model: string } | { error: string };

interface PredictionBase {
  type: "prediction";
  id: string;
  kind: Kind;
  at: string;
  repo: string | undefined;
  model: string;
  state_sha256: string;
  state_chars: number;
  step?: string;
  story?: string;
  task?: string;
}
interface CheckpointPrediction extends PredictionBase {
  kind: "checkpoint";
  p_open: number;
}
interface ScopePrediction extends PredictionBase {
  kind: "scope";
  choice: string;
  probabilities?: Probabilities;
  confidence?: number;
}
type Prediction = CheckpointPrediction | ScopePrediction;
interface Outcome {
  type: "outcome";
  id: string;
  at: string;
  actual: string;
}
type LogRecord = Prediction | Outcome;
type Paired = Prediction & { actual: string };

type Fields = Record<string, string | number | boolean | undefined>;
type State = { step: string; text: string } | { request: string };
type Meta = { step?: string; story?: string; task?: string };

const HOME = os.homedir();
const CONFIG_FILE =
  process.env.AGENT_SKILLS_CONFIG ||
  path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, ".config"), "agent-skills", "config.json");
const LOG_FILE =
  process.env.AGENT_SKILLS_JEV_LOG ||
  path.join(process.env.XDG_STATE_HOME || path.join(HOME, ".local", "state"), "agent-skills", "jev-shadow.jsonl");
const BASE_URL = (process.env.TYPESAFE_BASE_URL || "https://api.typesafe.ai").replace(/\/+$/, "");
const DEFAULT_MODEL = "jev-1.13.0"; // pinned: an alias moves and would shift the recorded probabilities
const TIMEOUT_MS = 10_000;
const OUTCOMES: Record<Kind, string[]> = { checkpoint: ["decision", "none"], scope: ["epic", "story", "task"] };

const CHECKPOINT_QUESTION = {
  type: "noul",
  instructions:
    "`text` is what one step of a software design workflow produced, shown to the user at a checkpoint before the next step builds on it. Does it leave a decision open that the user must make first?",
  criteria: {
    true: "It raises a choice between approaches, an unresolved trade-off, a missing or ambiguous requirement, or an assumption that needs the user's confirmation",
    false: "It only records settled facts or decisions; the next step can build on it as written",
  },
};

const SCOPE_QUESTION = {
  type: "choice",
  instructions:
    "`request` is a piece of software work, with any repository facts the agent gathered. Which planning scope does it belong to?",
  criteria: {
    epic: "A product, a new system, or several capabilities that could ship separately; users, goals, or scope are still unclear",
    story: "One user-facing capability that needs several tasks, or tasks that share a contract (API, table, status field, event); requirements are clear, the design isn't",
    task: "One change (a function, an endpoint, a fix, a config) that fits a focused session and changes no shared contract; requirements and design are clear",
  },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function out(fields: Fields): void {
  console.log(
    Object.entries(fields)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${k}=${v}`)
      .join(" "),
  );
}

function die(message: string): never {
  console.error(`jev: ${message}`);
  process.exit(2);
}

function readConfig(): JevConfig {
  const config: JevConfig = { enabled: false, deny: [], model: undefined };
  if (!fs.existsSync(CONFIG_FILE)) return config;
  const parsed: unknown = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  const jev = isObject(parsed) ? parsed.jev : undefined;
  if (!isObject(jev)) return config;
  config.enabled = jev.enabled === true;
  config.deny = Array.isArray(jev.deny) ? jev.deny.map((pattern) => String(pattern)) : [];
  config.model = jev.model;
  return config;
}

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** Names this repository goes by: the main worktree's folder and the origin remote's repo name. */
function repoNames(): string[] {
  const names = new Set<string>();
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common) {
    const base = path.basename(common);
    names.add(base === ".git" ? path.basename(path.dirname(common)) : base.replace(/\.git$/, ""));
  }
  const origin = git(["remote", "get-url", "origin"]);
  if (origin) names.add(origin.replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).pop() ?? "");
  names.delete("");
  return [...names];
}

/** Case-insensitive glob with `*` and `?`. */
function globMatch(pattern: string, name: string): boolean {
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${re}$`, "i").test(name);
}

/** Why a prediction must not run here, or undefined when it may. Fails closed. */
function blocker(config: JevConfig): string | undefined {
  if (!config.enabled) return "disabled";
  const names = repoNames();
  if (names.length === 0) return "no-repo";
  for (const pattern of config.deny) {
    const hit = names.find((n) => globMatch(pattern, n));
    if (hit) return `denied:${hit}`;
  }
  if (!process.env.TYPESAFE_API_KEY) return "no-key";
  return undefined;
}

function readState(source: string | undefined): string {
  if (!source) die("missing input: a file path, or - for stdin");
  const text = source === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(source, "utf8");
  if (!text.trim()) die("empty input");
  return text;
}

function parseFlags(args: string[], allowed: string[]): { flags: Record<string, string>; rest: string[] } {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (!allowed.includes(key)) die(`unknown flag ${a}`);
      if (i + 1 >= args.length) die(`${a} needs a value`);
      flags[key] = args[++i];
    } else rest.push(a);
  }
  return { flags, rest };
}

function append(record: LogRecord): void {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, `${JSON.stringify(record)}\n`);
}

function toProbabilities(value: unknown): Probabilities | undefined {
  if (!isObject(value)) return undefined;
  return { epic: num(value.epic), story: num(value.story), task: num(value.task) };
}

/** Narrows one parsed log line; lines that are neither a prediction nor an outcome are dropped. */
function toRecord(value: unknown): LogRecord | undefined {
  if (!isObject(value)) return undefined;
  const { id, at } = value;
  if (typeof id !== "string" || typeof at !== "string") return undefined;
  if (value.type === "outcome") {
    return typeof value.actual === "string" ? { type: "outcome", id, at, actual: value.actual } : undefined;
  }
  if (value.type !== "prediction") return undefined;
  const base = {
    type: "prediction" as const,
    id,
    at,
    repo: str(value.repo),
    model: str(value.model) ?? "",
    state_sha256: str(value.state_sha256) ?? "",
    state_chars: num(value.state_chars) ?? 0,
    step: str(value.step),
    story: str(value.story),
    task: str(value.task),
  };
  if (value.kind === "checkpoint") {
    const p_open = num(value.p_open);
    return p_open === undefined ? undefined : { ...base, kind: "checkpoint", p_open };
  }
  if (value.kind === "scope") {
    const choice = str(value.choice);
    if (choice === undefined) return undefined;
    return {
      ...base,
      kind: "scope",
      choice,
      probabilities: toProbabilities(value.probabilities),
      confidence: num(value.confidence),
    };
  }
  return undefined;
}

function readLog(): LogRecord[] {
  if (!fs.existsSync(LOG_FILE)) return [];
  const records: LogRecord[] = [];
  for (const line of fs.readFileSync(LOG_FILE, "utf8").split("\n")) {
    if (!line) continue;
    const record = toRecord(JSON.parse(line));
    if (record) records.push(record);
  }
  return records;
}

async function ask(model: string, state: State, question: object): Promise<AskResult> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/v1/systemone`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, state, questions: { q: question } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { error: err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network" };
  }
  if (!res.ok) return { error: `http-${res.status}` };
  try {
    const body: unknown = await res.json();
    const answers = isObject(body) ? body.answers : undefined;
    const q = isObject(answers) ? answers.q : undefined;
    if (!isObject(q) || !isObject(body)) return { error: "bad-response" };
    return {
      answer: {
        noul: num(q.noul),
        choice: str(q.choice),
        confidence: num(q.confidence),
        probabilities: toProbabilities(q.probabilities),
      },
      model: (typeof body.model === "string" && body.model) || model,
    };
  } catch {
    return { error: "bad-response" };
  }
}

async function predict(kind: Kind, state: State, meta: Meta): Promise<void> {
  const config = readConfig();
  const why = blocker(config);
  if (why) return out({ jev: "skipped", reason: why });
  const model = typeof config.model === "string" && config.model ? config.model : DEFAULT_MODEL;
  const question = kind === "checkpoint" ? CHECKPOINT_QUESTION : SCOPE_QUESTION;
  const result = await ask(model, state, question);
  if ("error" in result) return out({ jev: "skipped", reason: result.error });
  const { answer, model: used } = result;
  const id = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const serialized = JSON.stringify(state);
  const base = {
    type: "prediction" as const,
    id,
    at: new Date().toISOString(),
    repo: repoNames()[0],
    model: used,
    // The text itself is never stored: only its fingerprint and size.
    state_sha256: createHash("sha256").update(serialized).digest("hex"),
    state_chars: serialized.length,
    ...meta,
  };
  if (kind === "checkpoint") {
    if (answer.noul === undefined) return out({ jev: "skipped", reason: "bad-response" });
    append({ ...base, kind: "checkpoint", p_open: answer.noul });
    return out({ jev: id, p_open: answer.noul.toFixed(3), model: used });
  }
  if (answer.choice === undefined) return out({ jev: "skipped", reason: "bad-response" });
  append({
    ...base,
    kind: "scope",
    choice: answer.choice,
    probabilities: answer.probabilities,
    confidence: answer.confidence,
  });
  const p = answer.probabilities ?? {};
  return out({
    jev: id,
    scope: answer.choice,
    p_epic: p.epic?.toFixed(3),
    p_story: p.story?.toFixed(3),
    p_task: p.task?.toFixed(3),
    confidence: answer.confidence?.toFixed(3),
    model: used,
  });
}

function outcome(id: string | undefined, actual: string | undefined): void {
  if (!id || !actual) die("usage: jev.sh outcome ID ACTUAL");
  const prediction = readLog().find((r): r is Prediction => r.type === "prediction" && r.id === id);
  if (!prediction) die(`no prediction ${id} in ${LOG_FILE}`);
  const allowed = OUTCOMES[prediction.kind];
  if (!allowed.includes(actual)) die(`a ${prediction.kind} outcome is one of: ${allowed.join(", ")}`);
  append({ type: "outcome", id, at: new Date().toISOString(), actual });
  out({ jev: id, outcome: actual });
}

/** Latest outcome per prediction id; predictions with no outcome are left out. */
function pairs(records: LogRecord[]): Paired[] {
  const actual = new Map<string, string>();
  for (const r of records) if (r.type === "outcome") actual.set(r.id, r.actual);
  const paired: Paired[] = [];
  for (const r of records) {
    const a = r.type === "prediction" ? actual.get(r.id) : undefined;
    if (r.type === "prediction" && a !== undefined) paired.push({ ...r, actual: a });
  }
  return paired;
}

function report(): void {
  const records = readLog();
  const paired = pairs(records);
  const pending = records.filter((r) => r.type === "prediction").length - paired.length;
  console.log(`log: ${LOG_FILE}`);
  console.log(`predictions without an outcome: ${pending}`);

  const cps = paired.filter((r): r is CheckpointPrediction & { actual: string } => r.kind === "checkpoint");
  const decisions = cps.filter((r) => r.actual === "decision").length;
  console.log(`\ncheckpoint: ${cps.length} paired (${decisions} with a decision, ${cps.length - decisions} without)`);
  if (cps.length) {
    console.log("threshold  stops skipped  decisions missed");
    for (const t of [0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5]) {
      const skipped = cps.filter((r) => r.p_open < t);
      const missed = skipped.filter((r) => r.actual === "decision").length;
      console.log(
        `p_open<${t.toFixed(2)}  ${String(skipped.length).padStart(5)}/${cps.length}  ${String(missed).padStart(9)}/${decisions}`,
      );
    }
  }

  const scopes = paired.filter((r): r is ScopePrediction & { actual: string } => r.kind === "scope");
  const right = scopes.filter((r) => r.choice === r.actual).length;
  console.log(`\nscope: ${scopes.length} paired, Jev agreed with the settled scope ${right}/${scopes.length}`);
  if (scopes.length) {
    console.log("confidence  answered  agreed");
    for (const t of [0, 0.5, 0.7, 0.9]) {
      const sure = scopes.filter((r) => (r.confidence ?? 0) >= t);
      const ok = sure.filter((r) => r.choice === r.actual).length;
      console.log(`>=${t.toFixed(1)}  ${String(sure.length).padStart(13)}  ${String(ok).padStart(6)}`);
    }
  }
}

function status(): void {
  const config = readConfig();
  out({
    enabled: config.enabled,
    repo: repoNames().join(",") || "none",
    blocked: blocker(config) || "no",
    model: String(config.model || DEFAULT_MODEL),
    config: CONFIG_FILE,
    log: LOG_FILE,
  });
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case "status":
      return status();
    case "checkpoint": {
      const { flags, rest } = parseFlags(args, ["step", "story", "task"]);
      if (!flags.step) die('usage: jev.sh checkpoint FILE|- --step "N/M name" [--story ID] [--task ID]');
      return predict("checkpoint", { step: flags.step, text: readState(rest[0]) }, {
        step: flags.step,
        story: flags.story,
        task: flags.task,
      });
    }
    case "scope":
      return predict("scope", { request: readState(args[0]) }, {});
    case "outcome":
      return outcome(args[0], args[1]);
    case "report":
      return report();
    default:
      die("usage: jev.sh {status|checkpoint FILE|- --step S [--story ID] [--task ID]|scope FILE|-|outcome ID ACTUAL|report}");
  }
}

await main(process.argv.slice(2));
