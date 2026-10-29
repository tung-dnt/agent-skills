// work-state.test.ts — Tests for the work_state tool (omp/work-state.ts, run through omp/cli.ts): store resolution
// (vault or repository), dotpm notes, claiming across sessions, worktrees, and machines, the ticked status tree,
// recorded approvals (a task's, and a story's spec, design, and plan) with the story phase they drive, migration
// from the old layout, and the SessionStart hint. Every test builds throwaway git repositories and vaults and runs
// the real CLI as a child process.
//
// Run: node --test omp/work-state.test.ts
//
// The CLI under test is `bun omp/cli.ts`; WORK_STATE_CMD overrides it (words split on spaces), e.g.
// WORK_STATE_CMD="bun /abs/path/omp/cli.ts".
//
// The tests of a section run in order and share one repository (like a shell session that cd's around): each test
// performs the steps that precede its check and then asserts. One test per check; the test names are the check
// names of the bash suite this file replaced (hooks/work-state-test.sh).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

// ---------------------------------------------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------------------------------------------

const TMP = realpathSync(mkdtempSync(join(tmpdir(), "work-state-test-")));
const REPO_ROOT = resolve(import.meta.dirname, "..");
const WS_CMD: string[] = process.env.WORK_STATE_CMD
	? process.env.WORK_STATE_CMD.split(" ").filter(Boolean)
	: ["bun", join(REPO_ROOT, "omp", "cli.ts")];
// No user config unless a test writes one: the repository store.
const USER_CONFIG = join(TMP, "user-config.json");

const BASE_ENV: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
	if (v === undefined) continue;
	if (k === "TYPESAFE_API_KEY" || k === "GIT_DIR" || k === "GIT_WORK_TREE" || k === "GIT_INDEX_FILE") continue;
	BASE_ENV[k] = v;
}
BASE_ENV.AGENT_SKILLS_CONFIG = USER_CONFIG;

let assertions = 0;

after(() => {
	rmSync(TMP, { recursive: true, force: true });
	console.log(`work-state.test: ${assertions} assertions`);
});

// ---------------------------------------------------------------------------------------------------------------
// Assertions: has = output contains, lacks = it does not, is = exact equality
// ---------------------------------------------------------------------------------------------------------------

function has(got: string, want: string): void {
	assertions++;
	assert.ok(got.includes(want), `expected to contain ${JSON.stringify(want)}\n--- got ---\n${got}`);
}
function lacks(got: string, unwanted: string): void {
	assertions++;
	assert.ok(!got.includes(unwanted), `expected NOT to contain ${JSON.stringify(unwanted)}\n--- got ---\n${got}`);
}
function is(got: string, want: string): void {
	assertions++;
	assert.equal(got, want);
}
/** A check with no assertion of its own beyond what the preceding step already proved (bash `ok`). */
function ok(): void {
	assertions++;
}

// ---------------------------------------------------------------------------------------------------------------
// Shell-like helpers (a global cwd stands in for the bash suite's `cd`)
// ---------------------------------------------------------------------------------------------------------------

let cwd = TMP;
const P = (rel: string): string => resolve(cwd, rel);
/** `$(...)` strips trailing newlines. */
const strip = (s: string): string => s.replace(/\n+$/, "");
const today = (): string => {
	const d = new Date();
	const p = (n: number): string => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function env(extra?: Record<string, string>): Record<string, string> {
	return extra ? { ...BASE_ENV, ...extra } : BASE_ENV;
}

/** stdout and stderr of one CLI call, interleaved like `2>&1`. */
function wsAt(dir: string, args: string[], extra?: Record<string, string>): string {
	const r = spawnSync("sh", ["-c", '"$@" 2>&1', "sh", ...WS_CMD, ...args], {
		cwd: dir, env: env(extra), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28,
	});
	return strip(r.stdout);
}
/** Exit status of one CLI call, output discarded. */
function wsStatus(dir: string, args: string[], extra?: Record<string, string>): number {
	const r = spawnSync(WS_CMD[0]!, [...WS_CMD.slice(1), ...args], {
		cwd: dir, env: env(extra), encoding: "utf8", stdio: ["ignore", "ignore", "ignore"],
	});
	return r.status ?? 128;
}
/** The CLI's stdout, raw. */
function wsStdout(dir: string, args: string[], extra?: Record<string, string>): string {
	const r = spawnSync(WS_CMD[0]!, [...WS_CMD.slice(1), ...args], {
		cwd: dir, env: env(extra), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 28,
	});
	return r.stdout;
}
/** The CLI's stderr, raw. */
function wsStderr(dir: string, args: string[]): string {
	const r = spawnSync(WS_CMD[0]!, [...WS_CMD.slice(1), ...args], {
		cwd: dir, env: env(), encoding: "utf8", stdio: ["ignore", "ignore", "pipe"], maxBuffer: 1 << 28,
	});
	return r.stderr;
}

const ws = (...args: string[]): string => wsAt(cwd, args);
const code = (...args: string[]): string => String(wsStatus(cwd, args));
const rdy = (...args: string[]): string => strip(wsStdout(cwd, ["ready", ...args])); // the listed tasks
const skips = (...args: string[]): string => strip(wsStderr(cwd, ["ready", ...args])); // why some were held back

function gitAt(dir: string, args: string[], input?: string): string {
	const r = spawnSync("git", args, { cwd: dir, env: env(), encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 1 << 28 });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} (in ${dir}) failed with ${r.status}: ${r.stderr}`);
	return r.stdout;
}
const git = (...args: string[]): string => gitAt(cwd, args);
const gitStatusAt = (dir: string, args: string[]): number =>
	spawnSync("git", args, { cwd: dir, env: env(), stdio: "ignore" }).status ?? 128;
/** Run steps until one fails, like `a && b && c`. */
function chain(...steps: Array<() => number>): void {
	for (const step of steps) if (step() !== 0) return;
}
const gitOk = (dir: string, ...args: string[]) => (): number => gitStatusAt(dir, args);
const wsOk = (dir: string, ...args: string[]) => (): number => wsStatus(dir, args);

function gitId(dir: string): void {
	gitAt(dir, ["config", "user.email", "t@example.invalid"]);
	gitAt(dir, ["config", "user.name", "Test"]);
}
function newRepo(name: string): void {
	const d = join(TMP, name);
	mkdirSync(d, { recursive: true });
	cwd = d;
	git("init", "--quiet", "-b", "main");
	gitId(d);
	git("commit", "--quiet", "--allow-empty", "-m", "init");
}
const cd = (dir: string): void => {
	cwd = resolve(cwd, dir);
};

const read = (rel: string): string => readFileSync(P(rel), "utf8");
const cat = (rel: string): string => strip(read(rel));
const write = (rel: string, content: string): void => writeFileSync(P(rel), content);
const append = (rel: string, content: string): void => writeFileSync(P(rel), read(rel) + content);
const mkdirp = (...rels: string[]): void => {
	for (const r of rels) mkdirSync(P(r), { recursive: true });
};
const touch = (rel: string): void => closeSync(openSync(P(rel), "a"));
const rmrf = (rel: string): void => rmSync(P(rel), { recursive: true, force: true });
/** `ls` (or `ls -A`) of a directory; "" when it cannot be listed. */
function ls(rel: string, all = false): string {
	try {
		return readdirSync(P(rel)).filter(n => all || !n.startsWith(".")).sort().join("\n");
	} catch {
		return "";
	}
}
const isDir = (rel: string): boolean => {
	try {
		return statSync(P(rel)).isDirectory();
	} catch {
		return false;
	}
};

/** `sed -i 's/FROM/TO/'`: the first match on each line. */
function sed(rel: string, from: string | RegExp, to: string): void {
	const lines = read(rel).split("\n").map(l => l.replace(from, () => to));
	write(rel, lines.join("\n"));
}
/** `sed -n 'START,ENDp'`: START is a regex or a line number, END a regex (the range runs to EOF when null). */
function sedRange(text: string, start: RegExp | number, end: RegExp | null): string {
	const lines = text.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	const out: string[] = [];
	let inRange = false;
	lines.forEach((line, i) => {
		if (inRange) {
			out.push(line);
			if (end && end.test(line)) inRange = false;
			return;
		}
		if (typeof start === "number" ? i + 1 === start : start.test(line)) {
			out.push(line);
			inRange = true;
			if (end === null) return;
		}
	});
	return out.join("\n");
}
const fileLines = (text: string): string[] => {
	const lines = text.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
};
const tail = (text: string, n: number): string => fileLines(text).slice(-n).join("\n");
const head = (text: string, n: number): string => fileLines(text).slice(0, n).join("\n");
/** `grep -c`: how many lines match. */
const grepc = (text: string, re: RegExp): string => String(fileLines(text).filter(l => re.test(l)).length);

// ---------------------------------------------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------------------------------------------

const story = (...args: string[]): void => void ws("init-story", ...args); // story title [epic]
const task = (...args: string[]): void => void ws("new-task", ...args); // story title [dep...]
const setStatus = (s: string, id: string, status: string): void => void ws("set", s, id, status);
const note = (s: string, id: string): string => `docs/stories/${s}/_tasks/${id}.md`;

/** Insert TEXT as the line after "## NAME" in FILE. */
function afterHeading(file: string, name: string, text: string): void {
	const t = strip(text);
	const out: string[] = [];
	for (const line of fileLines(read(file))) {
		out.push(line);
		if (line === `## ${name}`) out.push(t);
	}
	write(file, out.join("\n") + "\n");
}
/** Insert TEXT as the task description, above "## Design". */
function describeTask(file: string, text: string): void {
	const out: string[] = [];
	let done = false;
	for (const line of fileLines(read(file))) {
		if (line === "## Design" && !done) {
			out.push(text, "");
			done = true;
		}
		out.push(line);
	}
	write(file, out.join("\n") + "\n");
}
function newVault(dir: string, projectsFolder?: string): void {
	mkdirSync(join(dir, ".obsidian", "plugins", "project-manager"), { recursive: true });
	if (projectsFolder) {
		writeFileSync(
			join(dir, ".obsidian", "plugins", "project-manager", "data.json"),
			`{\n  "projectsFolder": "${projectsFolder}",\n  "peopleFolder": "People"\n}\n`,
		);
	}
	writeFileSync(USER_CONFIG, `{\n  "vault": "${dir}"\n}\n`);
}
const noVault = (): void => rmSync(USER_CONFIG, { force: true });

/**
 * A task ready for its gate: a description with a Files line, a design, no approval yet. The design is `design`,
 * the scope line `scope`.
 */
function readyTask(s: string, title: string, files: string, deps: string[] = [], opts: { design?: string; scope?: string } = {}): void {
	const out = ws("new-task", s, title, ...deps);
	const id = out.split("\n").find(l => l.startsWith("task="))?.slice("task=".length) ?? "";
	const file = ws("path", s, id);
	describeTask(file, `**Description:** ${title}.\n\n**Files likely touched:** ${files}\n\n**Estimated scope:** ${opts.scope || "S"}`);
	afterHeading(file, "Design", opts.design || "- Edge: x()");
}
const approveAll = (s: string, ...ids: string[]): void => {
	for (const id of ids) ws("approve", s, id);
};

// ===============================================================================================================

describe("root and configure (repository store)", () => {
	let out = "";
	before(() => newRepo("root"));
	test("no vault means the repository store", () => {
		out = ws("root");
		has(out, "store=repo");
	});
	test("defaults to docs/stories, as an absolute path", () => has(out, `stories_dir=${TMP}/root/docs/stories`));
	test("reports unconfigured", () => has(out, "configured=false"));
	test("notes an existing spec directory", () => {
		mkdirp("specs", "tasks");
		touch("tasks/plan.md");
		out = ws("root");
		has(out, "existing spec directory: specs");
	});
	test("notes the legacy single-plan layout", () => has(out, "legacy single-plan layout: tasks/plan.md"));
	test("detects an existing docs/stories", () => {
		mkdirp("docs/stories");
		has(ws("root"), "source=detected");
	});
	test("notes the old task layout", () => {
		mkdirp("docs/stories/old/tasks");
		touch("docs/stories/old/tasks/t01-a.md");
		has(ws("root"), "old task layout under docs/stories: run work_state migrate");
	});
	test("configure normalizes ./ and trailing slashes", () => {
		rmrf("docs/stories/old");
		has(ws("configure", "./work/stories/", "work/epics"), "storiesDir=work/stories");
	});
	test("reads storiesDir from config", () => {
		out = ws("root");
		has(out, `stories_dir=${TMP}/root/work/stories`);
	});
	test("reports configured", () => has(out, "configured=true"));
	test("configure rejects absolute paths", () => has(ws("configure", "/abs"), "relative path inside the repository"));
	test("configure rejects escaping paths", () => has(ws("configure", "../x"), "relative path inside the repository"));
	test("configure rejects quotes", () => has(ws("configure", 'a"b'), "may not contain quotes"));
	test("configure keeps the store key", () => {
		write(".agent-skills.json", '{\n  "storiesDir": "work/stories",\n  "store": "repo",\n  "vaultFolder": "grp/app"\n}\n');
		ws("configure", "s2");
		has(cat(".agent-skills.json"), '"store": "repo"');
	});
	test("configure keeps the vaultFolder key", () => has(cat(".agent-skills.json"), '"vaultFolder": "grp/app"'));
	test("resolves from a subdirectory", () => {
		mkdirp("sub/dir");
		cd("sub/dir");
		has(ws("root"), `stories_dir=${TMP}/root/s2`);
	});
});

describe("dotpm notes", () => {
	let proj = "";
	let t = "";
	let out = "";
	before(() => newRepo("notes"));
	test("new-task needs the story's project note", () => has(ws("new-task", "pay", "T01 model"), "run work_state init-story first"));
	test("init-story creates the project note", () => has(ws("init-story", "pay", "Payments"), `created: ${TMP}/notes/docs/stories/pay/pay.md`));
	test("init-story is idempotent", () => has(ws("init-story", "pay", "Payments"), "exists: "));
	test("project note is a dotpm project", () => {
		proj = cat("docs/stories/pay/pay.md");
		has(proj, "pm-project: true");
	});
	test("project note declares the agent's custom fields", () => has(proj, '  - id: "design_approved"'));
	test("new-task derives the id from the title", () => {
		out = ws("new-task", "pay", "T01 model");
		has(out, "task=t01-model");
	});
	test("new-task prints the note path", () => has(out, `path=${TMP}/notes/docs/stories/pay/_tasks/t01-model.md`));
	test("task note is a dotpm task", () => {
		task("pay", "T02 api", "t01-model");
		t = cat(note("pay", "t02-api"));
		has(t, "pm-task: true");
	});
	test("task links its project", () => has(t, 'projectId: "[[pay|Payments]]"'));
	test("task title is quoted", () => has(t, 'title: "T02 api"'));
	test("new tasks start as todo", () => has(t, "status: todo"));
	test("tasks are tagged with their story", () => has(t, "  - story/pay"));
	test("dependencies are wikilinks with titles", () => has(t, '  - "[[t01-model|T01 model]]"'));
	test("task note has the agent sections", () => has(t, "## Checklist"));
	test("task note never has a ## Subtasks heading", () => lacks(t, "## Subtasks"));
	test("task note ends with the dotpm footer", () => has(tail(read(note("pay", "t02-api")), 1), "Project: [[pay|Payments]]"));
	test("project note lists task ids", () => {
		proj = cat("docs/stories/pay/pay.md");
		has(proj, 'taskIds: ["[[t01-model|T01 model]]", "[[t02-api|T02 api]]"]');
	});
	test("project note lists tasks in order", () =>
		has(sedRange(read("docs/stories/pay/pay.md"), /^## Tasks/, null), "- [ ] [[t01-model|T01 model]]\n- [ ] [[t02-api|T02 api]]"));
	test("a duplicate task is refused", () => has(ws("new-task", "pay", "T01 model"), "already exists"));
	test("an unknown dependency is refused", () => has(ws("new-task", "pay", "T03 docs", "t09-nope"), "unknown dependency pay/t09-nope"));
	test("titles slug to link-safe ids", () => has(ws("new-task", "pay", 'T04 Fix: a/b, "x"=y +z'), "task=t04-fix-a-b-x-y-z"));

	// dotpm names a task note from its title and, when that isn't the file's name, saves a second note and trashes
	// ours, so the task id would change. dotpmName is its rule (YamlSerializer.taskSlug): the stored title must give
	// the id back.
	const dotpmName = (s: string): string => s.replace(/[\\/:*?"<>|]/g, "-").toLowerCase().replace(/\s+/g, "-").slice(0, 60);
	const storedTitle = (id: string): string =>
		fileLines(read(note("pay", id))).map(l => /^title: "(.*)"$/.exec(l)?.[1]).filter(m => m !== undefined).join("\n");
	function checkTitle(title: string, expected: string): void {
		let id = "";
		let stored = "";
		test(expected ? `id of '${title}'` : `'${title}' is stored as its title`, () => {
			id = ws("new-task", "pay", title).split("\n").find(l => l.startsWith("task="))?.slice("task=".length) ?? "";
			stored = storedTitle(id);
			if (expected) is(id, expected);
			else ok();
		});
		test(`dotpm names the stored title of '${title}' like its file`, () => is(dotpmName(stored), id));
		test(`the id of '${title}' is link-safe`, () => {
			assertions++;
			assert.match(id, /^[a-z0-9]+(-[a-z0-9]+)*$/);
		});
	}
	checkTitle("T05 Add: status endpoint", "t05-add-status-endpoint");
	checkTitle("T06 Retry 5xx (backoff)", "t06-retry-5xx-backoff");
	checkTitle("T07 Fix user's cart", "t07-fix-user-s-cart");
	checkTitle("T08 Upgrade to v1.2", "t08-upgrade-to-v1-2");
	checkTitle("T09 aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd eeeeeeeeeee tail", "t09-aaaaaaaaaa-bbbbbbbbbb-cccccccccc-dddddddddd-eeeeeeeeeee");
	const translit = spawnSync("iconv", ["-f", "utf-8", "-t", "ascii//TRANSLIT"], { input: "ế", encoding: "utf8" });
	checkTitle("T10 Thêm điểm cuối trạng thái", translit.status === 0 && strip(translit.stdout) === "e" ? "t10-them-diem-cuoi-trang-thai" : "");

	test("a title with no letters or digits gives no id", () => has(ws("new-task", "pay", "?!"), "gives no usable task id"));
	test("path prints the task note", () => has(ws("path", "pay", "t01-model"), `${TMP}/notes/docs/stories/pay/_tasks/t01-model.md`));
	test("path prints the story directory", () => has(ws("path", "pay"), `${TMP}/notes/docs/stories/pay`));
});

describe("set, log, field", () => {
	let f = "";
	before(() => {
		newRepo("setlog");
		story("shop", "Shop");
		task("shop", "T01 cart");
		f = note("shop", "t01-cart");
	});
	test("set validates the status", () => has(ws("set", "shop", "t01-cart", "claimed"), "status must be one of"));
	test("done sets progress to 100", () => {
		setStatus("shop", "t01-cart", "done");
		has(cat(f), "progress: 100");
	});
	test("done records the completion date", () => has(cat(f), `completed: ${today()}`));
	test("reopening drops the completion date", () => {
		setStatus("shop", "t01-cart", "todo");
		lacks(cat(f), "completed:");
	});
	test("log appends a dated line", () => {
		afterHeading(f, "Checklist", "- [x] model\n- [ ] ui");
		ws("log", "shop", "t01-cart", "wrote model; next: ui");
		has(sedRange(read(f), /^## Log/, null), `- ${today()} wrote model; next: ui`);
	});
	test("log line stays above the footer", () => has(head(tail(read(f), 3), 1), "wrote model"));
	test("progress follows the checklist", () => has(cat(f), "progress: 50"));
	test("log lines keep their order", () => {
		ws("log", "shop", "t01-cart", "second");
		has(grepc(sedRange(read(f), /^## Log/, /^Project/), new RegExp(today())), "2");
	});
	test("field writes customFields", () => {
		ws("field", "shop", "t01-cart", "design_refs", "C3, C5");
		has(sedRange(read(f), /^customFields:/, /^---/), '  design_refs: "C3, C5"');
	});
	test("field replaces a value", () => {
		ws("field", "shop", "t01-cart", "design_refs", "C4");
		has(grepc(read(f), /design_refs:/), "1");
	});
	test("field rejects odd names", () => has(ws("field", "shop", "t01-cart", "a b", "x"), "field names are"));
});

describe("next, claim, release (one checkout)", () => {
	let out = "";
	before(() => {
		newRepo("claims");
		story("pay", "Payments");
		task("pay", "T01 model");
		task("pay", "T02 api", "t01-model");
		task("pay", "T03 docs");
		git("add", "-A");
		git("commit", "--quiet", "-m", "plan");
	});
	test("next picks the first todo task", () => has(ws("next"), "pay/t01-model"));
	test("claim takes the lock", () => has(ws("claim", "pay", "t01-model"), "claimed: pay/t01-model work=main id="));
	test("claim is a namespaced ref", () => has(strip(git("for-each-ref", "--format=%(refname)", "refs/heads/claim")), "refs/heads/claim/pay/t01-model"));
	test("claim marks the task in progress", () => has(cat(note("pay", "t01-model")), "status: in-progress"));
	test("claim records the work branch", () => has(cat(note("pay", "t01-model")), '  branch: "main"'));
	test("second claim of the same task is refused (exit 3)", () => has(code("claim", "pay", "t01-model"), "3"));
	test("next skips claimed tasks and unmet dependencies", () => has(ws("next"), "pay/t03-docs"));
	test("next can be scoped to a story", () => has(ws("next", "pay"), "pay/t03-docs"));
	test("a branch named after the story does not block claims", () => {
		git("branch", "pay");
		has(ws("claim", "pay", "t03-docs"), "claimed: pay/t03-docs");
	});
	test("next exits 4 when nothing is claimable", () => has(code("next"), "4"));
	test("claimed task shows its lock and work branch", () => {
		out = ws("status", "pay");
		has(out, "[~] t01-model claimed: claim/pay/t01-model · work main");
	});
	test("done in this checkout shows as done before release", () => {
		setStatus("pay", "t01-model", "done");
		has(ws("status", "pay"), "[x] t01-model");
	});
	test("release drops the lock", () => has(ws("release", "pay", "t01-model"), "released: pay/t01-model"));
	test("released task shows no claim", () => lacks(ws("status", "pay"), "claim/pay/t01-model"));
	test("dependency done here unlocks the next task", () => {
		git("add", "-A");
		git("commit", "--quiet", "-m", "t01 done");
		has(ws("next"), "pay/t02-api");
	});
	test("quoted status values are understood", () => {
		sed(note("pay", "t03-docs"), /^status: .*/, 'status: "cancelled"');
		has(ws("status", "pay"), "[x] t03-docs cancelled");
	});
	test("a dependency in review is not finished", () => {
		task("pay", "T04 block", "t02-api");
		setStatus("pay", "t02-api", "review");
		lacks(ws("next", "pay"), "pay/t04-block");
	});
	test("review shows as in progress", () => has(ws("status", "pay"), "[~] t02-api review"));
});

describe("brief", () => {
	let out = "";
	before(() => {
		newRepo("brief");
		story("ship", "Shipping");
		write(
			"docs/stories/ship/spec.md",
			"# Spec\n\n- FR2: customer sees status\n- FR9: unrelated\n\n## Design\n\nComponents: api, worker.\n\nState transitions (C3):\n\n| from | to |\n|---|---|\n| a | b |\n\nIdempotency (C5): unique key.\n\nRetention (C7): 13 months.\n",
		);
		write("docs/stories/ship/plan.md", "| t02-apply | apply | t01 | C3, C5 |\n| t03-read | read | t02 | - |\n");
		task("ship", "T02 apply");
		describeTask(note("ship", "t02-apply"), "Implements FR2.");
		ws("field", "ship", "t02-apply", "design_refs", "C3, C5");
		git("add", "-A");
		git("commit", "--quiet", "-m", "plan");
		out = ws("brief", "ship", "t02-apply");
	});
	test("brief includes the task note", () => has(out, `== task ${TMP}/brief/docs/stories/ship/_tasks/t02-apply.md`));
	test("brief includes the plan row", () => has(out, "| t02-apply | apply |"));
	test("brief includes a cited contract and its table", () => has(out, "| a | b |"));
	test("brief includes every cited contract", () => has(out, "Idempotency (C5): unique key."));
	test("brief omits uncited contracts", () => lacks(out, "Retention (C7)"));
	test("brief omits unrelated spec text", () => lacks(out, "Components: api, worker."));
	test("brief includes requirements the task names", () => has(out, "FR2: customer sees status"));
	test("brief omits other requirements", () => lacks(out, "FR9"));
});

describe("phase", () => {
	let out = "";
	before(() => newRepo("phase"));
	test("no story directory is phase none", () => has(ws("phase", "cart"), "phase=none"));
	test("no spec is phase spec", () => {
		story("cart", "Cart");
		has(ws("phase", "cart"), "phase=spec");
	});
	// What /epic leaves behind as a story stub is a spec nobody has approved.
	test("a story stub with an unapproved spec is phase spec", () => {
		write("docs/stories/cart/spec.md", "# Spec\n- FR1: add item\n");
		has(ws("phase", "cart"), "phase=spec");
	});
	test("an approved spec without a design is phase design", () => {
		ws("approve-phase", "cart", "spec");
		has(ws("phase", "cart"), "phase=design");
	});
	test("a design that is still being written is phase design", () => {
		append("docs/stories/cart/spec.md", "\n## Design\nC1: cart API.\n");
		has(ws("phase", "cart"), "phase=design");
	});
	test("an approved design without a plan is phase plan", () => {
		ws("approve-phase", "cart", "design");
		has(ws("phase", "cart"), "phase=plan");
	});
	test("a plan without task notes is still phase plan", () => {
		write("docs/stories/cart/plan.md", "# Plan\n");
		has(ws("phase", "cart"), "phase=plan");
	});
	test("a plan and tasks nobody approved are phase plan", () => {
		task("cart", "T01 add");
		task("cart", "T02 remove");
		setStatus("cart", "t02-remove", "done");
		has(ws("phase", "cart"), "phase=plan");
	});
	test("an approved plan with open tasks is phase build", () => {
		ws("approve-phase", "cart", "plan");
		out = ws("phase", "cart");
		has(out, "phase=build");
	});
	test("phase build counts open tasks", () => has(out, "open_tasks=1"));
	test("a story with recorded approvals gets no migration note", () => lacks(out, "approvals=missing"));
	test("done and cancelled tasks make phase done", () => {
		setStatus("cart", "t01-add", "cancelled");
		has(ws("phase", "cart"), "phase=done");
	});
	test("an unapproved design stops a story whose plan is not approved either", () => {
		story("tiny", "Tiny");
		write("docs/stories/tiny/spec.md", "# Spec\n- FR1: one change\n");
		write("docs/stories/tiny/plan.md", "# Plan\n");
		task("tiny", "T01 change");
		ws("approve-phase", "tiny", "spec");
		has(ws("phase", "tiny"), "phase=design");
	});
	test("an approved plan carries a story past an unapproved design", () => {
		ws("approve-phase", "tiny", "plan");
		has(ws("phase", "tiny"), "phase=build");
	});
});

describe("design size limit", () => {
	let f = "";
	before(() => {
		newRepo("approval-size");
		story("pay", "Payments");
		task("pay", "T01 refund");
		f = note("pay", "t01-refund");
		afterHeading(f, "Design", Array.from({ length: 16 }, (_, i) => `- line ${i + 1}`).join("\n"));
	});
	test("approve refuses a design over 15 lines", () => has(ws("approve", "pay", "t01-refund"), "has 16 lines (limit 15)"));
	test("a refused long design stays unapproved", () => has(code("approved", "pay", "t01-refund"), "6"));
	test("--allow-long records a kept long design", () => has(ws("approve", "pay", "t01-refund", "--allow-long"), "approved: pay/t01-refund"));
});

describe("design approval", () => {
	let f = "";
	before(() => {
		newRepo("approval");
		story("pay", "Payments");
		task("pay", "T01 refund");
		f = note("pay", "t01-refund");
		afterHeading(f, "Design", "<!-- low-level-design note, added just before implementation -->");
		git("add", "-A");
		git("commit", "--quiet", "-m", "plan");
	});
	test("approve refuses an empty design", () => has(ws("approve", "pay", "t01-refund"), "Design section is empty"));
	test("unapproved task exits 6", () => has(code("approved", "pay", "t01-refund"), "6"));
	test("status marks an unapproved design", () => has(ws("status", "pay"), "t01-refund · design ✗"));
	test("brief shows missing approval", () => has(ws("brief", "pay", "t01-refund"), "== approval: missing"));
	test("approve records the approval", () => {
		afterHeading(f, "Design", "- Edge: refund(id, amount)\n- Rules: amount <= remaining");
		has(ws("approve", "pay", "t01-refund"), "approved: pay/t01-refund");
	});
	test("approval is stored in customFields", () => has(sedRange(read(f), /^customFields:/, /^---/), "  design_approved: "));
	test("approved task exits 0", () => has(code("approved", "pay", "t01-refund"), "0"));
	test("status marks an approved design", () => has(ws("status", "pay"), "t01-refund · design ✓"));
	test("brief shows the approval", () => has(ws("brief", "pay", "t01-refund"), "== approval: ok"));
	test("editing other sections keeps the approval", () => {
		afterHeading(f, "Summary", "- Note: summaries are not part of the design");
		ws("log", "pay", "t01-refund", "logging is not part of the design");
		has(code("approved", "pay", "t01-refund"), "0");
	});
	test("editing the design after approval voids it (exit 7)", () => {
		afterHeading(f, "Design", "- Failure: provider timeout -> PENDING");
		has(code("approved", "pay", "t01-refund"), "7");
	});
	test("status flags a design changed since approval", () => has(ws("status", "pay"), "design ✗ (changed since approval)"));
	test("re-approving restores it", () => {
		ws("approve", "pay", "t01-refund");
		has(code("approved", "pay", "t01-refund"), "0");
	});
	test("re-approving keeps one approval line", () => has(grepc(read(f), /design_approved:/), "1"));
	// In worktree mode the approval is read from, and written to, the work branch's worktree.
	test("approval made in the worktree is seen from the main checkout", () => {
		git("add", "-A");
		git("commit", "--quiet", "-m", "approved");
		task("pay", "T02 report");
		afterHeading(note("pay", "t02-report"), "Design", "- Edge: report()");
		git("add", "-A");
		git("commit", "--quiet", "-m", "t02");
		git("worktree", "add", "--quiet", "-b", "feat-report", join(TMP, "wt-report"));
		chain(
			wsOk(join(TMP, "wt-report"), "claim", "pay", "t02-report", "feat-report"),
			wsOk(join(TMP, "wt-report"), "approve", "pay", "t02-report"),
		);
		has(code("approved", "pay", "t02-report"), "0");
	});
	test("main checkout's copy was not touched", () => lacks(cat(note("pay", "t02-report")), "design_approved"));
});

describe("phase approvals", () => {
	let out = "";
	const specSed = (from: string, to: string): void => sed("docs/stories/pay/spec.md", from, to);
	before(() => {
		newRepo("gates");
		story("pay", "Payments");
	});
	test("approve-phase needs the story's project note", () => has(ws("approve-phase", "nope", "spec"), "no project note for story 'nope'"));
	test("approve-phase needs a known phase", () => has(ws("approve-phase", "pay", "build"), "usage: work_state approve-phase STORY spec|design|plan"));
	test("approved-phase needs a known phase", () => has(ws("approved-phase", "pay", "nope"), "usage: work_state approved-phase STORY spec|design|plan"));
	test("approving a spec needs a spec", () => has(ws("approve-phase", "pay", "spec"), "no spec.md for story pay"));
	test("approving a plan needs a plan", () => has(ws("approve-phase", "pay", "plan"), "no plan.md for story pay"));
	test("approving a plan needs task notes", () => {
		write("docs/stories/pay/spec.md", "# Spec\n- FR1: refund\n\n## Design\nC1: refund API.\n\n## Open questions\nNone.\n");
		write("docs/stories/pay/plan.md", "# Plan\n- t01-refund: refund\n");
		has(ws("approve-phase", "pay", "plan"), "has no task notes");
	});
	test("an unrecorded phase is not approved (exit 6)", () => has(code("approved-phase", "pay", "spec"), "6"));
	test("approved-phase says what is missing", () => has(ws("approved-phase", "pay", "spec"), "not approved: pay has no approved spec"));
	test("approve-phase records the spec", () => has(ws("approve-phase", "pay", "spec"), "approved: pay spec ("));
	test("a recorded spec is approved (exit 0)", () => has(code("approved-phase", "pay", "spec"), "0"));
	test("the approval is a frontmatter key of the story's project note", () =>
		has(sedRange(read("docs/stories/pay/pay.md"), 2, /^---$/), 'spec_approved: "'));
	test("customFields keeps only dotpm's field definitions", () => lacks(cat("docs/stories/pay/pay.md"), "  spec_approved"));
	test("editing the spec voids its approval (exit 7)", () => {
		specSed("FR1: refund", "FR1: refund in full");
		has(code("approved-phase", "pay", "spec"), "7");
	});
	test("approved-phase says the spec changed", () => has(ws("approved-phase", "pay", "spec"), "pay's spec changed after approval"));
	test("and phase returns to spec", () => has(ws("phase", "pay"), "phase=spec"));
	test("re-approving restores it", () => {
		ws("approve-phase", "pay", "spec");
		has(code("approved-phase", "pay", "spec"), "0");
	});
	test("re-approving keeps one approval line", () => has(grepc(read("docs/stories/pay/pay.md"), /^spec_approved:/), "1"));
	test("blank lines and comments are not edits", () => {
		append("docs/stories/pay/spec.md", "\n\n<!-- reviewed -->   \n");
		has(code("approved-phase", "pay", "spec"), "0");
	});
	test("editing the design keeps the spec approved", () => {
		specSed("C1: refund API.", "C1: refund API v2.");
		has(code("approved-phase", "pay", "spec"), "0");
	});
	test("an unrecorded design is not approved (exit 6)", () => has(code("approved-phase", "pay", "design"), "6"));
	test("approve-phase records the design", () => {
		out = ws("approve-phase", "pay", "design");
		has(out, "approved: pay design (");
	});
	test("a written design is not recorded as skipped", () => lacks(out, "skipped"));
	test("a recorded design is approved (exit 0)", () => has(code("approved-phase", "pay", "design"), "0"));
	test("editing the design voids its approval (exit 7)", () => {
		specSed("C1: refund API v2.", "C1: refund API v3.");
		has(code("approved-phase", "pay", "design"), "7");
	});
	test("with no approved plan, phase returns to design", () => has(ws("phase", "pay"), "phase=design"));
	test("an unrecorded plan is not approved (exit 6)", () => {
		ws("approve-phase", "pay", "design");
		task("pay", "T01 refund");
		has(code("approved-phase", "pay", "plan"), "6");
	});
	test("a recorded plan is approved (exit 0)", () => {
		ws("approve-phase", "pay", "plan");
		has(code("approved-phase", "pay", "plan"), "0");
	});
	test("with the spec, design, and plan recorded the story is in build", () => has(ws("phase", "pay"), "phase=build"));
	test("adding a task note voids the plan approval (exit 7)", () => {
		task("pay", "T02 report");
		has(code("approved-phase", "pay", "plan"), "7");
	});
	test("and phase returns to plan", () => has(ws("phase", "pay"), "phase=plan"));
	test("cancelling a task keeps the plan approval", () => {
		ws("approve-phase", "pay", "plan");
		setStatus("pay", "t02-report", "cancelled");
		has(code("approved-phase", "pay", "plan"), "0");
	});
	test("editing the plan voids its approval (exit 7)", () => {
		append("docs/stories/pay/plan.md", "- t02-report: report\n");
		has(code("approved-phase", "pay", "plan"), "7");
	});
	test("a design edited during build leaves the story in build", () => {
		ws("approve-phase", "pay", "plan");
		specSed("C1: refund API v3.", "C1: refund API v4.");
		has(ws("phase", "pay"), "phase=build");
	});
	test("a spec edited during build sends the story back to spec", () => {
		specSed("FR1: refund in full", "FR1: refund in full or in part");
		has(ws("phase", "pay"), "phase=spec");
	});
});

describe("design skipped, and a design kept in design.md", () => {
	before(() => {
		story("small", "Small");
		write("docs/stories/small/spec.md", "# Spec\n- FR1: tweak\n");
		ws("approve-phase", "small", "spec");
	});
	test("a story with no design records its skip", () => has(ws("approve-phase", "small", "design"), "approved: small design as skipped, none written"));
	test("a recorded skip is approved (exit 0)", () => has(code("approved-phase", "small", "design"), "0"));
	test("approved-phase says it was skipped", () => has(ws("approved-phase", "small", "design"), "(skipped, "));
	test("a recorded skip carries the story to plan", () => {
		write("docs/stories/small/plan.md", "# Plan\n");
		task("small", "T01 tweak");
		has(ws("phase", "small"), "phase=plan");
	});
	test("a design written after the skip voids it (exit 7)", () => {
		append("docs/stories/small/spec.md", "\n## Design\nC1: a contract nobody planned for.\n");
		has(code("approved-phase", "small", "design"), "7");
	});
	test("and the story returns to design", () => has(ws("phase", "small"), "phase=design"));
	test("a sibling design.md counts as the design", () => {
		story("long", "Long");
		write("docs/stories/long/spec.md", "# Spec\n- FR1: big\n");
		write("docs/stories/long/design.md", "# Design\nC1: kept in a sibling file.\n");
		ws("approve-phase", "long", "spec");
		lacks(ws("approve-phase", "long", "design"), "skipped");
	});
	test("editing design.md voids the design approval (exit 7)", () => {
		append("docs/stories/long/design.md", "C2: another.\n");
		has(code("approved-phase", "long", "design"), "7");
	});
	test("brief reads a cited contract from design.md", () => {
		task("long", "T01 use it");
		afterHeading(note("long", "t01-use-it"), "Design", "- Edge: use()");
		ws("field", "long", "t01-use-it", "design_refs", "C1");
		ws("approve", "long", "t01-use-it");
		has(ws("brief", "long", "t01-use-it"), "C1: kept in a sibling file.");
	});
	test("editing a contract in design.md voids a task approval (exit 7)", () => {
		sed("docs/stories/long/design.md", "kept in a sibling file", "kept elsewhere");
		has(code("approved", "long", "t01-use-it"), "7");
	});
});

describe("task approval covers the description and the cited contracts", () => {
	let f = "";
	let out = "";
	const specSed = (from: string, to: string): void => sed("docs/stories/pay/spec.md", from, to);
	before(() => {
		newRepo("contracts");
		ws("init-epic", "payments", "Payments");
		story("pay", "Payments", "payments");
		write(
			"docs/epics/payments/epic.md",
			"# Epic: Payments\n\n## Architecture\n\nE1 event bus: at-least-once, ordered per account.\n\nE2 auth: bearer tokens.\n\n## Story map\n\nThe pay story publishes on E1.\n",
		);
		write(
			"docs/stories/pay/spec.md",
			"# Spec\n- FR1: refund\n\n## Design\n\n### Shared contracts\n\nC1 refund API: POST /refunds.\n\nC2 status lifecycle: NEW to DONE.\n",
		);
		task("pay", "T01 refund");
		task("pay", "T02 report");
		task("pay", "T03 docs");
		f = note("pay", "t01-refund");
		describeTask(f, "Refunds a payment.\n\n**Acceptance criteria:**\n- [ ] refund stored\n  - [ ] nested detail");
		afterHeading(f, "Design", "- Edge: refund(paymentId)");
		ws("field", "pay", "t01-refund", "design_refs", "C1, E1");
		ws("approve", "pay", "t01-refund");
	});
	test("a design approval covers its task", () => has(code("approved", "pay", "t01-refund"), "0"));
	test("brief shows a cited story contract", () => {
		out = ws("brief", "pay", "t01-refund");
		has(out, "C1 refund API: POST /refunds.");
	});
	test("brief resolves an E-id from the parent epic", () => has(out, "== design E1 (from epic.md)"));
	test("and shows its text", () => has(out, "E1 event bus: at-least-once"));
	test("brief omits an epic contract the task does not cite", () => lacks(out, "E2 auth"));
	test("editing the description voids the approval (exit 7)", () => {
		sed(f, "Refunds a payment.", "Refunds a payment in full.");
		has(code("approved", "pay", "t01-refund"), "7");
	});
	test("status flags it", () => has(ws("status", "pay"), "t01-refund · design ✗ (changed since approval)"));
	test("ticking an acceptance criterion keeps the approval", () => {
		ws("approve", "pay", "t01-refund");
		sed(f, "- [ ] refund stored", "- [x] refund stored");
		has(code("approved", "pay", "t01-refund"), "0");
	});
	test("ticking an indented criterion keeps the approval", () => {
		sed(f, "  - [ ] nested detail", "  - [x] nested detail");
		has(code("approved", "pay", "t01-refund"), "0");
	});
	test("editing a cited story contract voids the approval (exit 7)", () => {
		specSed("POST /refunds", "POST /v2/refunds");
		has(code("approved", "pay", "t01-refund"), "7");
	});
	test("editing a contract the task does not cite keeps it", () => {
		ws("approve", "pay", "t01-refund");
		specSed("NEW to DONE", "NEW to PAID");
		has(code("approved", "pay", "t01-refund"), "0");
	});
	test("editing a cited epic contract voids the approval (exit 7)", () => {
		sed("docs/epics/payments/epic.md", "ordered per account", "ordered globally");
		has(code("approved", "pay", "t01-refund"), "7");
	});
	test("editing an uncited epic contract, or the epic outside its architecture, keeps it", () => {
		ws("approve", "pay", "t01-refund");
		sed("docs/epics/payments/epic.md", "bearer tokens", "mutual TLS");
		sed("docs/epics/payments/epic.md", "publishes on E1", "publishes events");
		has(code("approved", "pay", "t01-refund"), "0");
	});
	test("changing the cited ids voids the approval (exit 7)", () => {
		ws("field", "pay", "t01-refund", "design_refs", "C1");
		has(code("approved", "pay", "t01-refund"), "7");
	});
});

describe("cites", () => {
	before(() => {
		ws("field", "pay", "t01-refund", "design_refs", "C1, E1");
		ws("field", "pay", "t02-report", "design_refs", "C1, C2");
	});
	test("cites lists every task that cites a contract, with its status", () => is(ws("cites", "pay", "C1"), "t01-refund todo\nt02-report todo"));
	test("cites lists one task for a contract it alone cites", () => is(ws("cites", "pay", "C2"), "t02-report todo"));
	test("cites shows which citing tasks are already done", () => {
		setStatus("pay", "t02-report", "done");
		is(ws("cites", "pay", "C2"), "t02-report done");
	});
	test("cites finds an epic contract", () => is(ws("cites", "pay", "E1"), "t01-refund todo"));
	test("cites matches whole ids only", () => is(ws("cites", "pay", "C"), ""));
	test("cites says nothing for an id nobody cites", () => is(ws("cites", "pay", "C9"), ""));
	test("cites needs a known story", () => has(ws("cites", "nope", "C1"), "no story 'nope'"));
	test("cites needs an id", () => has(ws("cites", "pay"), "usage: work_state cites STORY ID"));
});

describe("contracts written under headings", () => {
	let f = "";
	let out = "";
	const specSed = (from: string, to: string): void => sed("docs/stories/pay/spec.md", from, to);
	before(() => {
		newRepo("headings");
		story("pay", "Payments");
		write(
			"docs/stories/pay/spec.md",
			'# Spec\n- FR1: refund\n\n## Design\n\n### Shared contracts\n\n#### C1 refund API\n\nPOST /refunds with a body.\n\n```json\n{ "amount": 5 }\n\n{ "note": "x" }\n```\n\n#### C2 status lifecycle\n\nNEW to DONE.\n',
		);
		task("pay", "T01 refund");
		f = note("pay", "t01-refund");
		afterHeading(f, "Design", "- Edge: refund()");
		ws("field", "pay", "t01-refund", "design_refs", "C1");
		ws("approve", "pay", "t01-refund");
		out = ws("brief", "pay", "t01-refund");
	});
	test("brief shows the whole section under the heading that names a contract", () => has(out, "POST /refunds with a body."));
	test("including a fenced example split by a blank line", () => has(out, '{ "note": "x" }'));
	test("but not the next contract's section", () => lacks(out, "NEW to DONE"));
	test("editing a contract's body voids the approval (exit 7)", () => {
		specSed("POST /refunds with a body", "DELETE /refunds with a body");
		has(code("approved", "pay", "t01-refund"), "7");
	});
	test("editing its fenced example voids the approval (exit 7)", () => {
		ws("approve", "pay", "t01-refund");
		specSed('"note": "x"', '"note": "y"');
		has(code("approved", "pay", "t01-refund"), "7");
	});
	test("editing the next contract's section keeps it", () => {
		ws("approve", "pay", "t01-refund");
		specSed("NEW to DONE", "NEW to PAID");
		has(code("approved", "pay", "t01-refund"), "0");
	});
});

describe("approvals do not depend on the locale", () => {
	before(() => {
		newRepo("locale");
		story("s", "S");
		write("docs/stories/s/spec.md", "# Spec\n- FR1: x\n\n## Design\n\nC2 beta: b.\n\nc1 alpha: a.\n");
		write("docs/stories/s/plan.md", "# Plan\n");
		task("s", "T1 b");
		task("s", "T10 a");
		afterHeading(note("s", "t1-b"), "Design", "- Edge: b()");
		ws("field", "s", "t1-b", "design_refs", "c1, C2");
		wsAt(cwd, ["approve-phase", "s", "plan"], { LC_ALL: "C" });
		wsAt(cwd, ["approve", "s", "t1-b"], { LC_ALL: "C" });
	});
	for (const loc of ["en_US.UTF-8", "en_GB.UTF-8"]) {
		test(`a plan approved under the C locale holds under ${loc}`, () =>
			has(String(wsStatus(cwd, ["approved-phase", "s", "plan"], { LC_ALL: loc })), "0"));
		test(`so does a task approval over mixed-case contract ids (${loc})`, () =>
			has(String(wsStatus(cwd, ["approved", "s", "t1-b"], { LC_ALL: loc })), "0"));
	}
});

describe("review status", () => {
	before(() => {
		newRepo("review");
		story("pay", "Payments");
		write("docs/stories/pay/spec.md", "# Spec\n- FR1: x\n");
		write("docs/stories/pay/plan.md", "# Plan\n");
		task("pay", "T01 first");
		task("pay", "T02 second", "t01-first");
		ws("approve-phase", "pay", "spec");
		ws("approve-phase", "pay", "design");
		ws("approve-phase", "pay", "plan");
	});
	test("review records no completion date", () => {
		setStatus("pay", "t01-first", "review");
		lacks(cat(note("pay", "t01-first")), "completed:");
	});
	test("review is not full progress", () => lacks(cat(note("pay", "t01-first")), "progress: 100"));
	test("a task in review keeps the story in build", () => has(ws("phase", "pay"), "open_tasks=2"));
	test("a task waiting on one in review is not offered", () => lacks(ws("next", "pay"), "pay/t02-second"));
	test("findings send a task back to in progress", () => {
		setStatus("pay", "t01-first", "in-progress");
		has(cat(note("pay", "t01-first")), "status: in-progress");
	});
	test("done after review completes the task", () => {
		setStatus("pay", "t01-first", "review");
		setStatus("pay", "t01-first", "done");
		has(cat(note("pay", "t01-first")), `completed: ${today()}`);
	});
	test("and unlocks its dependent", () => has(ws("next", "pay"), "pay/t02-second"));
	test("phase counts it as complete", () => has(ws("phase", "pay"), "open_tasks=1"));
});

describe("ready: the tasks a wave can start", () => {
	let f = "";
	let out = "";
	before(() => {
		newRepo("ready");
		story("shop", "Shop");
		readyTask("shop", "T01 schema", "`src/db/schema.ts`, `migrations/001_init.sql`");
		readyTask("shop", "T02 cart api", "`src/api/cart.ts`", ["t01-schema"]);
		readyTask("shop", "T03 cart ui", "`src/ui/cart.tsx`");
		readyTask("shop", "T04 seed data", "`src/db/schema.ts`");
		f = note("shop", "t01-schema");
		git("add", "-A");
		git("commit", "--quiet", "-m", "plan");
	});
	test("ready changes nothing", () => is(strip(wsStdout(cwd, ["ready", "shop"]) + git("status", "--porcelain")), ""));
	test("no approved design means nothing is ready (exit 4)", () => is(code("ready", "shop"), "4"));
	test("ready needs a story id", () => has(ws("ready"), "usage: work_state ready STORY"));
	test("ready needs a known story", () => has(ws("ready", "nope"), "no story 'nope'"));
	test("an approved task is listed as story/task", () => {
		ws("approve", "shop", "t01-schema");
		is(rdy("shop"), "shop/t01-schema");
	});
	test("a task whose approval went stale is not ready (approved says 7)", () => {
		describeTask(f, "Edited after the approval.");
		is(code("approved", "shop", "t01-schema") + code("ready", "shop"), "74");
	});
	test("ready lists what can start together, in plan order", () => {
		ws("approve", "shop", "t01-schema");
		approveAll("shop", "t02-cart-api", "t03-cart-ui", "t04-seed-data");
		out = rdy("shop");
		is(out, "shop/t01-schema\nshop/t03-cart-ui");
	});
	test("a task whose dependency is not complete is not ready", () => lacks(out, "t02-cart-api"));
	test("a candidate sharing a file with an earlier one is skipped, and stderr says why", () =>
		has(skips("shop"), "skipped: shop/t04-seed-data overlaps shop/t01-schema (ready) on src/db/schema.ts"));
	test("a claimed task is not offered again", () => {
		ws("claim", "shop", "t01-schema");
		is(rdy("shop"), "shop/t03-cart-ui");
	});
	test("a candidate sharing a file with a running task is skipped", () =>
		has(skips("shop"), "skipped: shop/t04-seed-data overlaps shop/t01-schema (running) on src/db/schema.ts"));
	test("a task in review still holds its files", () => {
		setStatus("shop", "t01-schema", "review");
		is(rdy("shop"), "shop/t03-cart-ui");
	});
	test("a finished dependency opens its dependent", () => {
		setStatus("shop", "t01-schema", "done");
		is(rdy("shop"), "shop/t02-cart-api\nshop/t03-cart-ui");
	});
	test("while the unreleased lock still holds its files", () => has(skips("shop"), "overlaps shop/t01-schema (running)"));
	test("releasing the lock frees them", () => {
		ws("release", "shop", "t01-schema");
		is(rdy("shop"), "shop/t02-cart-api\nshop/t03-cart-ui\nshop/t04-seed-data");
	});
	test("a blocked task holds its files even with no lock", () => {
		ws("claim", "shop", "t03-cart-ui");
		setStatus("shop", "t03-cart-ui", "blocked");
		ws("release", "shop", "t03-cart-ui");
		readyTask("shop", "T05 cart polish", "`src/ui/cart.tsx`");
		ws("approve", "shop", "t05-cart-polish");
		has(skips("shop"), "skipped: shop/t05-cart-polish overlaps shop/t03-cart-ui (running) on src/ui/cart.tsx");
	});

	describe("a chain of overlaps", () => {
		before(() => {
			newRepo("chain");
			story("chain", "Chain");
			readyTask("chain", "T01 one", "`src/a.ts`");
			readyTask("chain", "T02 two", "`src/a.ts`, `src/b.ts`");
			readyTask("chain", "T03 three", "`src/b.ts`");
			approveAll("chain", "t01-one", "t02-two", "t03-three");
		});
		test("a skipped candidate holds nothing back: only listed and running tasks do", () => is(rdy("chain"), "chain/t01-one\nchain/t03-three"));
	});
});

describe("ready follows a task through its worktree, merge, and release", () => {
	before(() => {
		newRepo("flow");
		story("api", "API");
		readyTask("api", "T01 model", "`src/model.ts`");
		readyTask("api", "T02 handler", "`src/handler.ts`", ["t01-model"]);
		readyTask("api", "T03 model tests", "`src/model.ts`");
		approveAll("api", "t01-model", "t02-handler", "t03-model-tests");
		git("add", "-A");
		git("commit", "--quiet", "-m", "plan, designs, approvals");
	});
	test("the first task starts; its dependent waits and the third shares its file", () => is(rdy("api"), "api/t01-model"));
	test("a task running in a worktree holds its files, though this checkout's note says todo", () => {
		ws("claim", "api", "t01-model", "task/api/t01-model");
		git("worktree", "add", "--quiet", "-b", "task/api/t01-model", join(TMP, "flow-t01"));
		wsStatus(join(TMP, "flow-t01"), ["set", "api", "t01-model", "in-progress"]);
		is(code("ready", "api"), "4");
	});
	test("and the reason names it", () => has(skips("api"), "skipped: api/t03-model-tests overlaps api/t01-model (running) on src/model.ts"));
	test("done on an unmerged work branch opens nothing in the repository store", () => {
		const wt = join(TMP, "flow-t01");
		chain(
			wsOk(wt, "set", "api", "t01-model", "review"),
			wsOk(wt, "set", "api", "t01-model", "done"),
			gitOk(wt, "add", "-A"),
			gitOk(wt, "commit", "--quiet", "-m", "t01 done"),
		);
		is(code("ready", "api"), "4");
	});
	test("merged, the dependent opens while the lock still holds the file", () => {
		git("merge", "--quiet", "--no-ff", "--no-edit", "task/api/t01-model");
		is(rdy("api"), "api/t02-handler");
	});
	test("released, the file is free", () => {
		ws("release", "api", "t01-model");
		is(rdy("api"), "api/t02-handler\napi/t03-model-tests");
	});
});

describe("ready: plan order, and what counts as a file", () => {
	before(() => {
		newRepo("order");
		story("ord", "Order");
		readyTask("ord", "T10 ten", "`src/ten.ts`");
		readyTask("ord", "T2 two", "`src/two.ts`");
		approveAll("ord", "t10-ten", "t2-two");
	});
	for (const loc of ["C", "en_US.UTF-8", "en_GB.UTF-8"]) {
		test(`plan order is numeric, whatever the locale (${loc})`, () =>
			is(strip(wsStdout(cwd, ["ready", "ord"], { LC_ALL: loc })), "ord/t2-two\nord/t10-ten"));
	}

	describe("files", () => {
		let pairs = 0;
		before(() => newRepo("files"));
		// overlapCase LABEL FILES-A FILES-B overlap|apart [DESIGN-B] [SCOPE]: two approved tasks in a story of their
		// own; the first is listed, and the second only when the two share nothing.
		function overlapCase(label: string, a: string, b: string, kind: "overlap" | "apart", design?: string, scope?: string): void {
			pairs++;
			const s = `pair${pairs}`;
			const n = pairs;
			test(label, () => {
				story(s, `Pair ${n}`);
				readyTask(s, "T01 first", a, [], { scope });
				readyTask(s, "T02 second", b, [], { design, scope });
				approveAll(s, "t01-first", "t02-second");
				is(rdy(s), kind === "overlap" ? `${s}/t01-first` : `${s}/t01-first\n${s}/t02-second`);
			});
		}
		overlapCase("the same file overlaps", "`src/a.ts`", "`src/a.ts`", "overlap");
		overlapCase("different files do not", "`src/a.ts`", "`src/b.ts`", "apart");
		overlapCase("a path and its shortened form overlap", "`graphql/types/user.gql`", "`user.gql`", "overlap");
		overlapCase("one name in two directories does not", "`src/a/index.ts`", "`src/b/index.ts`", "apart");
		overlapCase("a directory overlaps a file in it", "`src/auth/`", "`src/auth/login.ts`", "overlap");
		overlapCase("a path with no extension may be a directory", "`src/auth`", "`src/auth/login.ts`", "overlap");
		overlapCase("but only a whole directory name", "`src/auth`", "`src/author/login.ts`", "apart");
		overlapCase("a glob overlaps a file it matches", "`e2e/*`", "`e2e/fixtures/a.ts`", "overlap");
		overlapCase("two globs that could match one file overlap", "`docs/x.md`, `e2e/*.spec.ts`", "`e2e/fixtures/*`", "overlap");
		overlapCase("two globs that cannot match one file do not", "`src/*.ts`", "`src/*.css`", "apart");
		overlapCase("a line number is not part of the path", "`src/a.ts:10-20`", "`src/a.ts`", "overlap");
		overlapCase("the template's list form: every item counts", "\n- `src/x.ts`\n- `src/shared.ts`", "`src/shared.ts`", "overlap");
		overlapCase("a list after a blank line still belongs to the label", "\n\n- `src/shared.ts`", "`src/shared.ts`", "overlap");
		overlapCase("prose around inline paths is ignored", "`src/x.ts`, new `src/shared.ts` (+ test), deleted `src/old.ts`", "`src/shared.ts`", "overlap");
		overlapCase("paths without backticks count", "src/x.ts, src/shared.ts (new)", "`src/shared.ts`", "overlap");
		overlapCase("so do unbackticked list items", "\n- src/x.ts\n- src/shared.ts - the handler", "`src/shared.ts`", "overlap");
		overlapCase("backticks after the Files block are not files", "`src/x.ts`", "`src/y.ts`", "apart", undefined, "M. Repo: `shared-repo`");
		overlapCase("lockfiles of one kind overlap in any directory", "`web/package.json`, `web/package-lock.json`", "`api/package.json`, `api/package-lock.json`", "overlap");
		overlapCase("lockfiles of different kinds do not", "`web/package-lock.json`", "`svc/go.sum`", "apart");
		overlapCase("any two *.lock files overlap", "`Cargo.lock`", "`web/yarn.lock`", "overlap");
		overlapCase("generated querier files overlap", "`db/orders/querier.go`", "`db/users/querier.go`", "overlap");
		overlapCase("schema dumps overlap", "`db/a/schema.sql`", "`db/b/schema.sql`", "overlap");
		overlapCase("a path in backticks in the design counts", "`src/a.ts`", "`src/b.ts`", "overlap", "- Edge: `src/a.ts` gains a field");
		overlapCase(
			"code in the design is not a file", "`src/a.ts`", "`src/b.ts`", "apart",
			"- Rules: reads `router.query`, calls `useCart` and `Array.from`, a/b or c/d",
		);
		overlapCase("a lockfile named only in the design counts", "`web/package-lock.json`", "`api/x.ts`", "overlap", "- Edge: regenerates `api/package-lock.json`");
	});

	describe("no files", () => {
		before(() => {
			newRepo("nofiles");
			story("nf", "No files");
			readyTask("nf", "T01 bare", "");
			ws("approve", "nf", "t01-bare");
		});
		test("a task that lists no files is still listed", () => is(rdy("nf"), "nf/t01-bare"));
		test("and the note says its overlap is unchecked", () => has(skips("nf"), "note: nf/t01-bare lists no files"));
	});
});

describe("ready sees claims made on another machine", () => {
	before(() => {
		gitAt(TMP, ["init", "--quiet", "--bare", "-b", "main", join(TMP, "remote-ready.git")]);
		newRepo("seedr");
		story("api", "API");
		readyTask("api", "T01 a", "`src/a.ts`");
		readyTask("api", "T02 b", "`src/a.ts`");
		readyTask("api", "T03 c", "`src/c.ts`");
		approveAll("api", "t01-a", "t02-b", "t03-c");
		git("add", "-A");
		git("commit", "--quiet", "-m", "plan");
		git("remote", "add", "origin", join(TMP, "remote-ready.git"));
		git("push", "--quiet", "origin", "main");
		gitAt(TMP, ["clone", "--quiet", join(TMP, "remote-ready.git"), join(TMP, "ready-a")]);
		gitId(join(TMP, "ready-a"));
		gitAt(TMP, ["clone", "--quiet", join(TMP, "remote-ready.git"), join(TMP, "ready-b")]);
		gitId(join(TMP, "ready-b"));
		cwd = join(TMP, "ready-a");
	});
	test("machine A starts with both of the tasks that don't share a file", () => is(rdy("api"), "api/t01-a\napi/t03-c"));
	test("machine B does not offer the task machine A claimed", () => {
		ws("claim", "api", "t01-a");
		cwd = join(TMP, "ready-b");
		is(rdy("api"), "api/t03-c");
	});
	test("and holds back a task sharing its file", () => has(skips("api"), "skipped: api/t02-b overlaps api/t01-a (running) on src/a.ts"));
});

describe("adopting approvals for planned stories that predate them", () => {
	let out = "";
	// Approvals recorded before descriptions and contracts were covered fingerprint the design alone.
	const oldHash = (s: string): string => gitAt(cwd, ["hash-object", "--stdin"], `${s}\n`).trim().slice(0, 12);
	before(() => {
		newRepo("adopt");
		story("old", "Old");
		write("docs/stories/old/spec.md", "# Spec\n- FR1: x\n\n## Design\n\nC1: api.\n");
		write("docs/stories/old/plan.md", "# Plan\n");
		task("old", "T01 first");
		task("old", "T02 second");
		task("old", "T03 third");
		describeTask(note("old", "t01-first"), "Does the first thing.");
		afterHeading(note("old", "t01-first"), "Design", "- Edge: first()");
		afterHeading(note("old", "t02-second"), "Design", "- Edge: second()");
		ws("field", "old", "t01-first", "design_approved", `2026-10-01T10:00Z ${oldHash("- Edge: first()")}`);
		ws("field", "old", "t02-second", "design_approved", `2026-10-01T10:00Z ${oldHash("- Edge: second()")}`);
		afterHeading(note("old", "t02-second"), "Design", "- Edge: edited after its approval");
		setStatus("old", "t01-first", "in-progress");
	});
	test("a planned story with no recorded approvals is not past spec", () => {
		out = ws("phase", "old");
		has(out, "phase=spec");
	});
	test("phase points at adopt-approvals", () => has(out, "approvals=missing run: work_state adopt-approvals old"));
	test("the hint says to ask the user first", () => has(out, "only if the user confirms its earlier gates passed"));
	test("a task approved under the earlier fingerprint reads as changed (exit 7)", () => has(code("approved", "old", "t01-first"), "7"));
	test("adopt records the spec", () => {
		out = ws("adopt-approvals", "old");
		has(out, "approved: old spec (");
	});
	test("adopt records the design", () => has(out, "approved: old design ("));
	test("adopt records the plan", () => has(out, "approved: old plan ("));
	test("adopt re-records a task approval whose design is unchanged", () => has(out, "approved: old/t01-first (re-recorded"));
	test("adopt leaves a task whose design changed since its approval alone", () => lacks(out, "old/t02-second"));
	test("the re-recorded approval holds (exit 0)", () => has(code("approved", "old", "t01-first"), "0"));
	test("the edited design stays changed (exit 7)", () => has(code("approved", "old", "t02-second"), "7"));
	test("the adopted story is in build", () => {
		out = ws("phase", "old");
		has(out, "phase=build");
	});
	test("and no longer gets the note", () => lacks(out, "approvals=missing"));
	test("adopt is one-shot", () => has(ws("adopt-approvals", "old"), "with no recorded approvals"));
	test("a planned story whose tasks haven't started gets the note too", () => {
		story("calm", "Calm");
		write("docs/stories/calm/spec.md", "# Spec\n- FR1: y\n");
		write("docs/stories/calm/plan.md", "# Plan\n");
		task("calm", "T01 only");
		has(ws("phase", "calm"), "approvals=missing run: work_state adopt-approvals calm");
	});
	test("adopt records a story with no design as skipped", () => has(ws("adopt-approvals", "calm"), "approved: calm design as skipped, none written"));
	test("and that story is in build", () => has(ws("phase", "calm"), "phase=build"));
	test("adopt refuses a story that isn't planned", () => {
		story("young", "Young");
		write("docs/stories/young/spec.md", "# Spec\n- FR1: z\n");
		has(ws("adopt-approvals", "young"), "is for a planned story");
	});
	test("phase gives an unplanned story no note", () => lacks(ws("phase", "young"), "approvals=missing"));
});

describe("worktrees", () => {
	let out = "";
	const wtCart = join(TMP, "wt-cart");
	const wtPay = join(TMP, "wt-pay");
	before(() => {
		newRepo("wt");
		story("shop", "Shop");
		task("shop", "T01 cart");
		task("shop", "T02 pay");
		git("add", "-A");
		git("commit", "--quiet", "-m", "plan");
		git("worktree", "add", "--quiet", "-b", "feat-cart", wtCart);
		wsStatus(wtCart, ["claim", "shop", "t01-cart", "feat-cart"]);
	});
	test("claim from a worktree marks the worktree's copy", () => has(strip(readFileSync(join(wtCart, note("shop", "t01-cart")), "utf8")), "status: in-progress"));
	test("claim leaves the main checkout's copy alone", () => lacks(cat(note("shop", "t01-cart")), "in-progress"));
	test("path points at the worktree copy", () => has(ws("path", "shop", "t01-cart"), `${wtCart}/docs/stories/shop/_tasks/t01-cart.md`));
	test("claiming for a branch with no checkout yet says how to mark it", () => {
		out = ws("claim", "shop", "t02-pay", "feat-pay");
		has(out, "run there: work_state set shop t02-pay in-progress");
	});
	test("and leaves this checkout's note alone", () => lacks(cat(note("shop", "t02-pay")), "in-progress"));
	test("set in-progress from the worktree records the claim's branch", () => {
		git("worktree", "add", "--quiet", "-b", "feat-pay", wtPay);
		wsStatus(wtPay, ["set", "shop", "t02-pay", "in-progress"]);
		has(strip(readFileSync(join(wtPay, note("shop", "t02-pay")), "utf8")), '  branch: "feat-pay"');
	});
	// The builder edits the task note in its worktree and has not committed yet.
	test("status reads uncommitted progress from the worktree", () => {
		afterHeading(join(wtCart, note("shop", "t01-cart")), "Checklist", "- [x] model\n- [ ] ui");
		ws("log", "shop", "t01-cart", "wrote model; next: ui");
		out = ws("status", "shop");
		has(out, `last log: - ${today()} wrote model; next: ui`);
	});
	test("status shows the checklist from the worktree", () => has(out, "checklist 1/2"));
	test("status names the worktree", () => has(out, `worktree ${wtCart}`));
	test("claim is visible from every worktree", () => has(code("claim", "shop", "t01-cart"), "3"));
	test("blocked task keeps its claim and is flagged", () => {
		setStatus("shop", "t01-cart", "blocked");
		has(ws("status", "shop"), "[!] t01-cart claimed: claim/shop/t01-cart");
	});
	test("done on an unmerged work branch is labelled", () => {
		setStatus("shop", "t01-cart", "done");
		gitAt(wtCart, ["add", "-A"]);
		gitAt(wtCart, ["commit", "--quiet", "-m", "t01 done"]);
		has(ws("status", "shop"), "not yet merged");
	});
	test("done and merged work branch asks for release", () => {
		git("merge", "--quiet", "--no-edit", "feat-cart");
		has(ws("status", "shop"), "merged, release the lock");
	});
});

describe("two machines", () => {
	const remote = join(TMP, "remote.git");
	const nowhere = join(TMP, "nowhere.git");
	const machineA = join(TMP, "machine-a");
	const machineB = join(TMP, "machine-b");
	let wip = "";
	before(() => {
		gitAt(TMP, ["init", "--quiet", "--bare", "-b", "main", remote]);
		newRepo("seed");
		story("api", "API");
		task("api", "T01 a");
		task("api", "T02 b");
		git("add", "-A");
		git("commit", "--quiet", "-m", "plan");
		git("remote", "add", "origin", remote);
		git("push", "--quiet", "origin", "main");
		gitAt(TMP, ["clone", "--quiet", remote, machineA]);
		gitId(machineA);
		gitAt(TMP, ["clone", "--quiet", remote, machineB]);
		gitId(machineB);
		cwd = machineA;
	});
	test("machine A claims and publishes", () => has(ws("claim", "api", "t01-a"), "claimed: api/t01-a"));
	test("machine B sees the remote claim", () => {
		cwd = machineB;
		has(code("claim", "api", "t01-a"), "3");
	});
	test("machine B's next skips it", () => has(ws("next"), "api/t02-b"));
	// Machine B can't fetch, so it doesn't know about A's claim; the push lease must still refuse it.
	test("an unseen remote claim loses the push race", () => {
		gitStatusAt(cwd, ["update-ref", "-d", "refs/remotes/origin/claim/api/t01-a"]);
		git("remote", "set-url", "origin", nowhere);
		git("remote", "set-url", "--push", "origin", remote);
		has(code("claim", "api", "t01-a"), "3");
	});
	test("the losing local lock is removed", () => lacks(strip(git("for-each-ref", "refs/heads/claim")), "claim/api/t01-a"));
	test("a lost race leaves the task note alone", () => lacks(cat(note("api", "t01-a")), "in-progress"));
	test("a released remote claim is pruned and claimable again", () => {
		git("remote", "set-url", "origin", remote);
		git("remote", "set-url", "--push", "origin", remote);
		git("fetch", "--quiet", "origin");
		wsStatus(machineA, ["release", "api", "t01-a"]);
		cwd = machineB;
		has(ws("next"), "api/t01-a");
	});
	// An unreachable remote is an error (exit 5), not a lost race, and leaves no lock behind.
	test("unreachable remote is exit 5, not 3", () => {
		git("remote", "set-url", "origin", nowhere);
		git("remote", "set-url", "--push", "origin", nowhere);
		has(code("claim", "api", "t02-b"), "5");
	});
	test("failed publish leaves no local lock", () => lacks(strip(git("for-each-ref", "refs/heads/claim")), "claim/api/t02-b"));
	// A pre-push hook for code must not block publishing a claim.
	test("pre-push hook does not block a claim", () => {
		git("remote", "set-url", "origin", remote);
		git("remote", "set-url", "--push", "origin", remote);
		mkdirp(".git/hooks");
		write(".git/hooks/pre-push", "#!/bin/sh\nexit 1\n");
		chmodSync(P(".git/hooks/pre-push"), 0o755);
		has(ws("claim", "api", "t02-b"), "claimed: api/t02-b");
	});
	// A claim is a lock, not a push of this branch: local commits stay local.
	test("a claim is published on top of unpushed commits", () => {
		rmSync(P(".git/hooks/pre-push"), { force: true });
		ws("release", "api", "t02-b");
		git("commit", "--quiet", "--allow-empty", "-m", "local WIP, never pushed");
		wip = strip(git("rev-parse", "HEAD"));
		has(ws("claim", "api", "t02-b"), "claimed: api/t02-b");
	});
	test("the claim reached the remote", () =>
		has(strip(gitAt(remote, ["for-each-ref", "--format=%(refname)", "refs/heads/claim"])), "refs/heads/claim/api/t02-b"));
	test("a claim uploads no unpushed local commit", () => {
		assertions++;
		assert.notEqual(gitStatusAt(remote, ["cat-file", "-e", `${wip}^{commit}`]), 0, `the remote has ${wip}`);
	});
	test("the published claim has no parent", () =>
		is(String(strip(gitAt(remote, ["rev-list", "--parents", "-n", "1", "refs/heads/claim/api/t02-b"])).split(/\s+/).filter(Boolean).length), "1"));
});

describe("hint", () => {
	let out = "";
	before(() => newRepo("hint"));
	test("silent outside a story layout", () => has(`[${ws("hint")}]`, "[]"));
	test("silent when nothing is claimed", () => {
		story("shop", "Shop");
		task("shop", "T01 cart");
		git("add", "-A");
		git("commit", "--quiet", "-m", "plan");
		has(`[${ws("hint")}]`, "[]");
	});
	test("lists claims when this branch isn't a work branch", () => {
		git("checkout", "--quiet", "-b", "feat-x");
		ws("claim", "shop", "t01-cart", "feat-other");
		out = ws("hint");
		has(out, "Tasks are claimed in this repository: shop/t01-cart");
	});
	test("hint uses the SessionStart envelope", () => has(out, '"hookEventName": "SessionStart"'));
	test("on a work branch it lists the task without claiming ownership", () => {
		ws("release", "shop", "t01-cart");
		ws("claim", "shop", "t01-cart", "feat-x");
		out = ws("hint");
		has(out, "with this checkout (feat-x) as their work branch: shop/t01-cart");
	});
	test("hint warns another session may hold it", () => has(out, "Another session may still be working on them"));
	test("hint output is valid JSON", () => {
		assertions++;
		assert.doesNotThrow(() => JSON.parse(out), out);
	});
	test("silent when the store can't be resolved", () => {
		write(".agent-skills.json", '{"store": "vault"}\n');
		has(`[${ws("hint")}]`, "[]");
	});
	test("silent outside git", () => {
		cwd = TMP;
		has(`[${ws("hint")}]`, "[]");
	});
});

describe("status tree", () => {
	let out = "";
	before(() => {
		newRepo("tree");
		ws("init-epic", "payments", "Payments");
	});
	test("init-epic creates the epic's project note", () => has(cat("docs/epics/payments/payments.md"), "pm-project: true"));
	test("a story in an epic links it as its parent", () => {
		story("payouts", "Payouts", "payments");
		story("refunds", "Refunds", "payments");
		story("misc", "Misc");
		has(cat("docs/stories/payouts/payouts.md"), 'parent: "[[payments]]"');
	});
	test("epic groups its stories", () => {
		task("payouts", "T01 model");
		task("payouts", "T02 transfer");
		task("refunds", "T01 refund");
		task("misc", "T01 chore");
		setStatus("payouts", "t01-model", "done");
		setStatus("refunds", "t01-refund", "done");
		git("add", "-A");
		git("commit", "--quiet", "-m", "plan");
		ws("claim", "payouts", "t02-transfer");
		out = ws("status");
		has(out, "[~] epic payments  1/2 stories");
	});
	test("finished story is ticked", () => has(out, "  [x] story refunds  1/1 tasks"));
	test("story in progress shows counts", () => has(out, "  [~] story payouts  1/2 tasks"));
	test("stories without an epic are listed", () => has(out, "(no epic)"));
	test("unknown story is an error", () => has(ws("status", "nope"), "no story 'nope'"));
	test("the repository store never ticks the shared project note", () => lacks(cat("docs/stories/refunds/refunds.md"), "- [x]"));
});

describe("vault store", () => {
	const V = join(TMP, "vault one");
	const dataJson = join(V, ".obsidian", "plugins", "project-manager", "data.json");
	let out = "";
	before(() => {
		newVault(V, "PM");
		newRepo("app");
	});
	test("a configured vault is the store", () => {
		out = ws("root");
		has(out, "store=vault");
	});
	test("stories live under the vault's projects folder, per repository", () => has(out, `stories_dir=${V}/PM/app/stories`));
	test("epics sit next to them", () => has(out, `epics_dir=${V}/PM/app/epics`));
	test("root names the vault", () => has(out, `vault=${V}`));
	test("source says the vault decided", () => has(out, "source=vault"));
	test("a worktree maps to the same vault folder", () => {
		git("worktree", "add", "--quiet", "-b", "feat-a", join(TMP, "app-feat-a"));
		has(wsAt(join(TMP, "app-feat-a"), ["root"]), `stories_dir=${V}/PM/app/stories`);
	});
	test("projects folder defaults to Projects", () => {
		rmSync(dataJson);
		has(ws("root"), `stories_dir=${V}/Projects/app/stories`);
	});
	test("the user config can name the projects folder", () => {
		writeFileSync(USER_CONFIG, `{\n  "vault": "${V}",\n  "projectsFolder": "Work"\n}\n`);
		has(ws("root"), `stories_dir=${V}/Work/app/stories`);
	});
	test("vaultFolder overrides the repository name", () => {
		newVault(V, "PM");
		write(".agent-skills.json", '{\n  "vaultFolder": "grp/app"\n}\n');
		has(ws("root"), `stories_dir=${V}/PM/grp/app/stories`);
	});
	test("a repository can keep its tasks in git", () => {
		write(".agent-skills.json", '{\n  "store": "repo"\n}\n');
		has(ws("root"), "store=repo");
	});
	test("store vault without a vault is an error", () => {
		write(".agent-skills.json", '{\n  "store": "vault"\n}\n');
		noVault();
		has(ws("root"), "no vault is configured");
	});
	test("an unknown store is an error", () => {
		write(".agent-skills.json", '{\n  "store": "tape"\n}\n');
		has(ws("root"), "unknown store 'tape'");
	});
	test("a missing vault falls back to the repository", () => {
		rmrf(".agent-skills.json");
		writeFileSync(USER_CONFIG, `{\n  "vault": "${join(TMP, "missing")}"\n}\n`);
		out = ws("root");
		has(out, "store=repo");
	});
	test("a missing vault is noted", () => has(out, "configured vault not found"));
	test("notes are created in the vault", () => {
		newVault(V, "PM");
		story("shop", "Shop");
		has(ls(`${V}/PM/app/stories/shop`), "shop.md");
	});
	test("task notes go to the vault's _tasks folder", () => {
		task("shop", "T01 cart");
		task("shop", "T02 pay", "t01-cart");
		has(ws("path", "shop", "t01-cart"), `${V}/PM/app/stories/shop/_tasks/t01-cart.md`);
	});
	test("nothing is written to the repository", () => lacks(git("status", "--porcelain"), "docs/"));
	test("vault links carry the note's vault path", () => has(cat(`${V}/PM/app/stories/shop/_tasks/t02-pay.md`), 'projectId: "[[PM/app/stories/shop/shop|Shop]]"'));
	test("vault dependency links carry the path", () => has(cat(`${V}/PM/app/stories/shop/_tasks/t02-pay.md`), '  - "[[PM/app/stories/shop/_tasks/t01-cart|T01 cart]]"'));
	test("next still reads path-qualified dependencies", () => has(ws("next", "shop"), "shop/t01-cart"));
	test("claim marks the vault note", () => {
		ws("claim", "shop", "t01-cart", "feat-a");
		has(cat(`${V}/PM/app/stories/shop/_tasks/t01-cart.md`), "status: in-progress");
	});
	test("done ticks the task in the project note", () => {
		setStatus("shop", "t01-cart", "done");
		has(cat(`${V}/PM/app/stories/shop/shop.md`), "- [x] [[PM/app/stories/shop/_tasks/t01-cart|T01 cart]]");
	});
	test("a done dependency still claimed is not finished", () => has(code("next", "shop"), "4"));
	test("a released done dependency unlocks the next task", () => {
		ws("release", "shop", "t01-cart");
		has(ws("next", "shop"), "shop/t02-pay");
	});
	test("reopening unticks it", () => {
		setStatus("shop", "t01-cart", "in-progress");
		has(cat(`${V}/PM/app/stories/shop/shop.md`), "- [ ] [[PM/app/stories/shop/_tasks/t01-cart|T01 cart]]");
	});
	test("hint works with the vault store", () => {
		git("checkout", "--quiet", "-b", "feat-b");
		ws("claim", "shop", "t02-pay", "feat-b");
		has(ws("hint"), "with this checkout (feat-b) as their work branch: shop/t02-pay");
	});
	test("status reads the vault", () => has(ws("status", "shop"), "[~] t02-pay claimed: claim/shop/t02-pay"));
	test("phase approvals are recorded in the vault's project note", () => {
		write(`${V}/PM/app/stories/shop/spec.md`, "# Spec\n- FR1: cart\n");
		ws("approve-phase", "shop", "spec");
		has(cat(`${V}/PM/app/stories/shop/shop.md`), 'spec_approved: "');
	});
	test("phase reads them from the vault", () => has(ws("phase", "shop"), "phase=design"));
	test("an epic contract is read through the vault's parent link", () => {
		ws("init-epic", "payments", "Payments");
		story("ride", "Ride", "payments");
		write(`${V}/PM/app/stories/ride/spec.md`, "# Spec\n- FR1: ride\n");
		write(`${V}/PM/app/epics/payments/epic.md`, "# Epic\n\n## Architecture\n\nE1 event bus: ordered.\n");
		task("ride", "T01 go");
		afterHeading(`${V}/PM/app/stories/ride/_tasks/t01-go.md`, "Design", "- Edge: go()");
		ws("field", "ride", "t01-go", "design_refs", "E1");
		ws("approve", "ride", "t01-go");
		has(ws("brief", "ride", "t01-go"), "E1 event bus: ordered.");
	});
	test("editing it voids the task approval in the vault store (exit 7)", () => {
		sed(`${V}/PM/app/epics/payments/epic.md`, "ordered", "unordered");
		has(code("approved", "ride", "t01-go"), "7");
	});
});

describe("ready (vault store)", () => {
	before(() => {
		newVault(join(TMP, "vault one"), "PM");
		newRepo("readyv");
		story("ship", "Ship");
		readyTask("ship", "T01 core", "`src/core.ts`");
		readyTask("ship", "T02 api", "`src/api.ts`", ["t01-core"]);
		readyTask("ship", "T03 core docs", "`src/core.ts`");
		approveAll("ship", "t01-core", "t02-api", "t03-core-docs");
	});
	test("the vault store lists a ready task", () => is(rdy("ship"), "ship/t01-core"));
	test("and holds back one that shares its file", () => has(skips("ship"), "skipped: ship/t03-core-docs overlaps ship/t01-core (ready) on src/core.ts"));
	test("a claimed task holds its files there too", () => {
		ws("claim", "ship", "t01-core", "feat-core");
		is(code("ready", "ship"), "4");
	});
	test("a done dependency whose lock is still held is not finished", () => {
		setStatus("ship", "t01-core", "done");
		is(code("ready", "ship"), "4");
	});
	test("released, it opens its dependent and frees its file", () => {
		ws("release", "ship", "t01-core");
		is(rdy("ship"), "ship/t02-api\nship/t03-core-docs");
	});
	test("ready leaves the repository alone", () => lacks(git("status", "--porcelain"), "docs/"));
});

describe("migrate (repository store)", () => {
	let out = "";
	let p = "";
	let t = "";
	const dirsOfShip = (): string =>
		["tasks", "_tasks"].filter(d => isDir(`docs/stories/ship/${d}`)).map(d => `dir ${d}`).join("\n");
	before(() => {
		noVault();
		newRepo("mig");
		mkdirp("docs/stories/ship/tasks", "docs/epics/logistics");
		write("docs/epics/logistics/epic.md", "# Epic: Logistics\n");
		write("docs/stories/ship/spec.md", "# Spec: Shipment tracking\n\n## Design\nC3: states.\n");
		write("docs/stories/ship/plan.md", "---\nepic: logistics\n---\n# Plan\n| t01-route | route |\n");
		write(
			"docs/stories/ship/tasks/t01-route.md",
			"---\nid: t01-route\nstory: ship\nstatus: done\ndepends_on: []\ndesign_refs: [C5]\nowner:\n---\n\n## Task t01: Route\nBody one.\n\n## Design\n\n## Log\n- done\n",
		);
		write(
			"docs/stories/ship/tasks/t02-apply-event.md",
			"---\nid: t02-apply-event\nstory: ship\nstatus: pending\ndepends_on: [t01-route]\ndesign_refs: [C3, C4]\nowner: feat-apply\n---\n\n## Task t02: Apply\n\n## Design\n- Edge: apply()\n\n## Subtasks\n- [x] a\n- [ ] b\n",
		);
		const hash = gitAt(cwd, ["hash-object", "--stdin"], "- Edge: apply()\n").trim().slice(0, 12);
		sed("docs/stories/ship/tasks/t02-apply-event.md", /^owner: feat-apply$/, `owner: feat-apply\ndesign_approved: 2026-10-01T10:00Z ${hash}`);
		git("add", "-A");
		git("commit", "--quiet", "-m", "old");
	});
	test("migrate converts a story in place", () => {
		out = ws("migrate");
		has(out, `migrated: story ship → ${TMP}/mig/docs/stories/ship/_tasks`);
	});
	test("migrate creates the epic's project note", () => has(cat("docs/epics/logistics/logistics.md"), 'title: "Logistics"'));
	test("the old tasks folder is replaced by _tasks", () => has(dirsOfShip(), "dir _tasks"));
	test("no tasks folder remains", () => lacks(dirsOfShip(), "dir tasks"));
	test("the story project note takes the spec's title", () => {
		p = cat("docs/stories/ship/ship.md");
		has(p, 'title: "Shipment tracking"');
	});
	test("the plan's epic becomes the project's parent", () => has(p, 'parent: "[[logistics]]"'));
	test("plan.md loses its epic frontmatter", () => lacks(cat("docs/stories/ship/plan.md"), "epic:"));
	test("plan.md keeps its content", () => has(head(read("docs/stories/ship/plan.md"), 1), "# Plan"));
	test("ids are kept, with a title that slugs back to them", () => {
		t = cat(note("ship", "t02-apply-event"));
		has(t, 'title: "T02 apply event"');
	});
	test("pending becomes todo", () => has(t, "status: todo"));
	test("depends_on becomes wikilinks", () => has(t, '  - "[[t01-route|T01 route]]"'));
	test("design_refs move to customFields", () => has(t, '  design_refs: "C3, C4"'));
	test("owner becomes the branch field", () => has(t, '  branch: "feat-apply"'));
	test("## Subtasks becomes ## Checklist", () => has(t, "## Checklist\n- [x] a"));
	test("no ## Subtasks heading remains", () => lacks(t, "## Subtasks"));
	test("missing sections are added", () => has(t, "## Log"));
	test("the approval survives migration", () => has(code("approved", "ship", "t02-apply-event"), "0"));
	test("done keeps its completion", () => has(cat(note("ship", "t01-route")), "status: done"));
	test("migrated story reports its state", () => has(ws("status", "ship"), "[x] t01-route"));
	test("a second migrate finds nothing", () => has(ws("migrate"), "nothing to migrate"));
	test("a story with live claims is skipped", () => {
		mkdirp("docs/stories/live/tasks");
		write("docs/stories/live/tasks/t01-x.md", "---\nid: t01-x\nstatus: claimed\n---\n");
		git("add", "-A");
		git("commit", "--quiet", "-m", "live");
		const tree = strip(gitAt(cwd, ["mktree"], ""));
		const c = strip(git("commit-tree", tree, "-m", "claim live/t01-x work=feat-x id=1"));
		git("update-ref", "refs/heads/claim/live/t01-x", c);
		has(ws("migrate"), "skipped: live has live claims");
		// A claim another machine holds shows up as a remote-tracking ref.
		mkdirp("docs/stories/away/tasks");
		write("docs/stories/away/tasks/t01-y.md", "---\nid: t01-y\nstatus: pending\n---\n");
		git("update-ref", "refs/remotes/origin/claim/away/t01-y", c);
	});
	test("a claim held on the remote also skips a story", () => has(ws("migrate"), "skipped: away has live claims (origin/claim/away/t01-y)"));
	// A task id with quotes or backslashes must not break the project note's YAML.
	test("links in the project note's taskIds are YAML-escaped", () => {
		mkdirp("docs/stories/odd/tasks");
		write('docs/stories/odd/tasks/t01-say-"hi"-a\\b.md', "---\nid: odd\nstatus: pending\n---\n");
		ws("migrate");
		has(cat("docs/stories/odd/odd.md"), String.raw`taskIds: ["[[t01-say-\"hi\"-a\\b|t01-say-\"hi\"-a\\b]]"]`);
	});
});

describe("migrate (vault store)", () => {
	const V2 = join(TMP, "vault-two");
	let out = "";
	before(() => {
		newVault(V2);
		newRepo("migv");
		mkdirp("docs/stories/ship/tasks", "docs/stories/idea", "docs/epics/logistics");
		write("docs/epics/logistics/epic.md", "# Epic: Logistics\n");
		write("docs/stories/ship/spec.md", "# Spec: Ship\n");
		write("docs/stories/ship/plan.md", "---\nepic: logistics\n---\n# Plan\n");
		write("docs/stories/ship/tasks/t01-route.md", "---\nid: t01-route\nstatus: done\ndepends_on: []\n---\n\n## Task t01\n");
		write("docs/stories/idea/spec.md", "# Spec: Idea\n");
		git("add", "-A");
		git("commit", "--quiet", "-m", "old");
	});
	test("vault migrate moves the story", () => {
		out = ws("migrate");
		has(out, `migrated: story ship → ${V2}/Projects/migv/stories/ship`);
	});
	test("vault migrate asks to commit the deletion", () => has(out, "commit the deletion"));
	test("spec-only stories move too", () => has(ls(`${V2}/Projects/migv/stories/idea`), "spec.md"));
	test("epics move with their content", () => has(ls(`${V2}/Projects/migv/epics/logistics`), "epic.md"));
	test("the moved epic gets a project note", () => has(ls(`${V2}/Projects/migv/epics/logistics`), "logistics.md"));
	test("done tasks are ticked in the vault project note", () =>
		has(cat(`${V2}/Projects/migv/stories/ship/ship.md`), "- [x] [[Projects/migv/stories/ship/_tasks/t01-route|T01 route]]"));
	test("the vault story links its epic by path", () =>
		has(cat(`${V2}/Projects/migv/stories/ship/ship.md`), 'parent: "[[Projects/migv/epics/logistics/logistics]]"'));
	test("the vault status tree groups stories by epic", () => has(ws("status"), "[x] epic logistics  1/1 stories"));
	test("the repository copies are removed", () => has(`[${ls("docs")}]`, "[]"));
	test("root no longer flags the old layout", () => lacks(ws("root"), "old task layout"));

	describe("nested layout", () => {
		before(() => {
			newRepo("nested");
			write(".agent-skills.json", '{\n  "storiesDir": ".stories",\n  "epicsDir": ".stories/epics"\n}\n');
			mkdirp(".stories/s1/tasks", ".stories/epics/e1");
			write(".stories/epics/e1/epic.md", "# Epic: E1\n");
			write(".stories/s1/tasks/t01-a.md", "---\nid: t01-a\nstatus: done\n---\n");
		});
		test("an epics dir inside the stories dir is not a story", () => {
			out = ws("migrate");
			lacks(out, "story epics");
		});
		test("it migrates as the epics dir", () => has(out, "migrated: epic e1"));
		test("the nested layout is fully moved", () => has(`[${ls(".stories", true)}]`, "[]"));
	});
});

describe("migrate (vault store, repository notes already in dotpm format)", () => {
	const V3 = join(TMP, "vault-three");
	const mdotApi = join(TMP, "mdot-api");
	let t = "";
	let p = "";
	before(() => {
		noVault();
		newRepo("mdot");
		ws("init-epic", "payments", "Payments epic");
		story("pay", "Payments", "payments");
		task("pay", "T01 model");
		task("pay", "T02 api", "t01-model");
		setStatus("pay", "t01-model", "done");
		git("add", "-A");
		git("commit", "--quiet", "-m", "plan");
		git("worktree", "add", "--quiet", "-b", "feat-api", mdotApi);
		ws("claim", "pay", "t02-api", "feat-api");
		ws("log", "pay", "t02-api", "handler written");
		newVault(V3);
	});
	test("root flags a story left in the repository", () => has(ws("root"), "old task layout"));
	test("vault migrate skips a story with live claims", () => has(ws("migrate"), "skipped: pay has live claims"));
	test("its notes stay in the repository", () => has(ls("docs/stories/pay/_tasks"), "t02-api.md"));
	test("and nothing is copied to the vault", () => has(`[${ls(`${V3}/Projects/mdot/stories`)}]`, "[]"));
	// The work is finished: merged into the base branch, then the claim is released.
	test("a released story moves to the vault", () => {
		chain(gitOk(mdotApi, "add", "-A"), gitOk(mdotApi, "commit", "--quiet", "-m", "t02 progress"));
		git("merge", "--quiet", "--no-edit", "feat-api");
		ws("release", "pay", "t02-api");
		has(ws("migrate"), `migrated: story pay → ${V3}/Projects/mdot/stories/pay`);
	});
	test("the merged progress comes along", () => {
		t = cat(`${V3}/Projects/mdot/stories/pay/_tasks/t02-api.md`);
		has(t, "handler written");
	});
	test("the task links its project by vault path", () => has(t, 'projectId: "[[Projects/mdot/stories/pay/pay|Payments]]"'));
	test("its dependencies carry vault paths", () => has(t, '  - "[[Projects/mdot/stories/pay/_tasks/t01-model|T01 model]]"'));
	test("its footer carries the vault path", () =>
		has(tail(read(`${V3}/Projects/mdot/stories/pay/_tasks/t02-api.md`), 1), "Project: [[Projects/mdot/stories/pay/pay|Payments]]"));
	test("taskIds carry vault paths", () => {
		p = cat(`${V3}/Projects/mdot/stories/pay/pay.md`);
		has(
			p,
			'taskIds: ["[[Projects/mdot/stories/pay/_tasks/t01-model|T01 model]]", "[[Projects/mdot/stories/pay/_tasks/t02-api|T02 api]]"]',
		);
	});
	test("finished tasks are ticked in the project note", () => has(p, "- [x] [[Projects/mdot/stories/pay/_tasks/t01-model|T01 model]]"));
	test("open tasks stay open", () => has(p, "- [ ] [[Projects/mdot/stories/pay/_tasks/t02-api|T02 api]]"));
	test("the story links its epic by vault path", () => has(p, 'parent: "[[Projects/mdot/epics/payments/payments]]"'));
	test("done ticks a moved task", () => {
		setStatus("pay", "t02-api", "done");
		has(cat(`${V3}/Projects/mdot/stories/pay/pay.md`), "- [x] [[Projects/mdot/stories/pay/_tasks/t02-api|T02 api]]");
	});
	test("the repository copy is gone", () => has(ws("migrate"), "nothing to migrate"));
});
