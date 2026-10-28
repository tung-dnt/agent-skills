// work-state — resolve where work artifacts live, claim tasks safely across parallel
// sessions, and read and write task state. A TypeScript port of the former hooks/work_state with the
// same outputs, exit codes, file formats, fingerprints, and claim refs, so stories created or
// approved by either implementation stay valid for the other.
//
// Implements references/work-artifacts.md. Epics, stories, and tasks are notes in the format of
// the Obsidian project-manager plugin (dotpm): a project note per epic and story, one task note
// per task under the story's `_tasks/` folder. They live in the user's Obsidian vault when one
// is configured, else in the repo.
//
// A claim is the ref refs/heads/claim/STORY/TASK pointing at a unique commit with no parent and
// no files, whose message records the work branch and a claim id. Creating it with
// `git update-ref REF NEW ""` is atomic in one repository; pushing it with an empty
// --force-with-lease is atomic on the remote. The lock never carries work.
//
// Sections follow the bash script: store resolution, reading notes, writing notes, claims, ready,
// creating notes, approvals, brief, phase, status, migrate, root/configure/hint, dispatcher.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomInt } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";

/** Every operation the dispatcher accepts, in CLI spelling. */
export const OPS = [
	"root",
	"configure",
	"init-epic",
	"init-story",
	"new-task",
	"path",
	"field",
	"set",
	"log",
	"next",
	"ready",
	"claim",
	"release",
	"status",
	"brief",
	"phase",
	"approve",
	"approved",
	"approve-phase",
	"approved-phase",
	"adopt-approvals",
	"cites",
	"migrate",
	"hint",
] as const;

export interface WorkStateOptions {
	cwd: string;
	env?: Record<string, string | undefined>;
	/** Called for every chunk as it is produced, in order; the CLI uses it to keep stdout/stderr interleaved. */
	onWrite?: (stream: "stdout" | "stderr", text: string) => void;
}

export interface WorkStateResult {
	code: number;
	stdout: string;
	stderr: string;
}

const DEFAULT_STORIES = "docs/stories";
const DEFAULT_EPICS = "docs/epics";
const CONFIG = ".agent-skills.json";
const DOTPM_SETTINGS = ".obsidian/plugins/project-manager/data.json";
const NS = "claim";
const STATUSES = "todo in-progress blocked review done cancelled";
// Files that building a task regenerates as a side effect: a lockfile, a schema dump, generated
// queriers. Two tasks that both touch a file matching the same pattern share it even when their
// paths differ. `ready` applies this.
const SHARED_OUTPUTS = "*.lock package-lock.json npm-shrinkwrap.json pnpm-lock.yaml bun.lockb go.sum schema.sql structure.sql schema.rb *querier.go";

/** Thrown to stop the run with an exit code; the message, if any, was already written. */
class Exit extends Error {
	constructor(readonly code: number) {
		super(`exit ${code}`);
	}
}

// ── text helpers (awk/sed/tr equivalents) ────────────────────────────────────

// POSIX [[:space:]] for the C locale: JS \s also matches NBSP and other Unicode spaces.
const WS = " \\t\\n\\v\\f\\r";
const trim = (s: string) => s.replace(new RegExp(`^[${WS}]+|[${WS}]+$`, "g"), "");
const rtrim = (s: string) => s.replace(new RegExp(`[${WS}]+$`), "");
const hasText = (s: string) => new RegExp(`[^${WS}]`).test(s);
/** Command substitution drops trailing newlines. */
const chomp = (s: string) => s.replace(/\n+$/, "");
/** The lines of a text, as awk reads them. */
const linesOf = (text: string): string[] => {
	const a = text.split("\n");
	if (a[a.length - 1] === "") a.pop();
	return a;
};
/** `printf '%s\n' "$content"` read line by line. */
const contentLines = (content: string): string[] => linesOf(`${content}\n`);
/** Lines as awk prints them: each ends with a newline. */
const emit = (a: string[]): string => (a.length ? `${a.join("\n")}\n` : "");

const baseName = (p: string): string => {
	const t = p.replace(/\/+$/, "");
	return t.slice(t.lastIndexOf("/") + 1);
};
const dirName = (p: string): string => {
	const t = p.replace(/\/+$/, "");
	const i = t.lastIndexOf("/");
	return i < 0 ? "." : i === 0 ? "/" : t.slice(0, i);
};
const stripPrefix = (s: string, prefix: string): string => (s.startsWith(prefix) ? s.slice(prefix.length) : s);

const isDir = (p: string): boolean => {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
};
const isFile = (p: string): boolean => {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
};
const exists = (p: string): boolean => {
	try {
		fs.statSync(p);
		return true;
	} catch {
		return false;
	}
};
/** `DIR/*\/`: the visible subdirectories, as "DIR/name", in byte order. */
const globDirs = (dir: string): string[] => {
	try {
		return fs
			.readdirSync(dir)
			.filter(n => !n.startsWith(".") && isDir(`${dir}/${n}`))
			.sort()
			.map(n => `${dir}/${n}`);
	} catch {
		return [];
	}
};
/** `DIR/*.md` that are regular files, as full paths, in byte order. */
const globMd = (dir: string): string[] => {
	try {
		return fs
			.readdirSync(dir)
			.filter(n => !n.startsWith(".") && n.endsWith(".md") && isFile(`${dir}/${n}`))
			.sort()
			.map(n => `${dir}/${n}`);
	} catch {
		return [];
	}
};
const readText = (p: string): string => fs.readFileSync(p, "utf8");
const taskIdOf = (file: string): string => baseName(file).replace(/\.md$/, "");

/** A YAML double-quoted string. */
const q = (s: string): string => `"${chomp(s.replace(/\\/g, "\\\\").replace(/"/g, '\\"'))}"`;

const validId = (s: string): boolean => s !== "" && !s.includes("/") && !s.startsWith(".");
const complete = (status: string): boolean => status === "done" || status === "cancelled";

/** Strip "./" prefixes and trailing slashes; reject absolute or escaping paths. */
function normalizeDir(input: string): string | null {
	let d = input;
	while (d.startsWith("./")) d = d.slice(2);
	while (d.endsWith("/")) d = d.slice(0, -1);
	if (d === "" || d.startsWith("/") || d === ".." || d.startsWith("../") || d.includes("/../") || d.endsWith("/..")) return null;
	return d;
}

/** First top-level `"KEY": "value"` of a JSON-ish file; the last such pair on a line wins. */
function configGet(key: string, file: string): string {
	if (!isFile(file)) return "";
	const re = new RegExp(`^.*"${key}"[${WS}]*:[${WS}]*"([^"]*)".*$`, "s");
	for (const line of readText(file).split("\n")) {
		const m = re.exec(line);
		if (m) return m[1];
	}
	return "";
}

/** A task id from its title: lowercase, every run of characters other than a-z0-9 becomes one
 * "-", no leading or trailing "-", at most 60 characters. */
function slug(s: string): string {
	return s
		.replace(/[A-Z]/g, c => c.toLowerCase())
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+/, "")
		.slice(0, 60)
		.replace(/-+$/, "");
}

/** The title a task is stored under: letters, digits, and single spaces, at most 60 characters,
 * so its dotpm name is its slug, which is the id. Accents are transliterated first where they can be. */
function taskTitle(input: string): string {
	let t = input;
	const r = spawnSync("iconv", ["-f", "utf-8", "-t", "ascii//TRANSLIT"], { input: t, encoding: "utf8" });
	if (r.error) t = t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[đĐ]/g, c => (c === "đ" ? "d" : "D"));
	else if (r.status === 0) t = chomp(r.stdout);
	return t
		.replace(/[^A-Za-z0-9]+/g, " ")
		.replace(/^ /, "")
		.slice(0, 60)
		.replace(/ $/, "");
}

/** A title whose slug is ID ("t02-apply-event" → "T02 apply event"), else ID. */
function titleForId(id: string): string {
	const parts = id.split("-");
	const t = parts[0].replace(/[a-z]/g, c => c.toUpperCase()) + parts.slice(1).map(p => ` ${p}`).join("");
	return slug(t) === id ? t : id;
}

/** A dotpm id: 8 random base-36 characters, then the time in ms as base 36. */
function pmId(): string {
	const digits = "0123456789abcdefghijklmnopqrstuvwxyz";
	let r = "";
	while (r.length < 8) for (const b of randomBytes(16)) if (b < 252 && r.length < 8) r += digits[b % 36];
	return r + (Math.floor(Date.now() / 1000) * 1000).toString(36);
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const nowIso = (): string => `${new Date().toISOString().slice(0, 19)}.000Z`;
const today = (): string => {
	const d = new Date();
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const approvalStamp = (): string => `${new Date().toISOString().slice(0, 16)}Z`;

/** git hash-object --stdin, first 12 characters, of the lines as a text. */
function hashLines(a: string[]): string {
	const body = Buffer.from(emit(a), "utf8");
	return createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex").slice(0, 12);
}

// ── reading notes ────────────────────────────────────────────────────────────

/** A frontmatter value: quoted values are unquoted; plain ones lose comments. */
function fmVal(input: string): string {
	let v = trim(input);
	if (v.startsWith('"')) return v.slice(1).replace(/"[^"]*$/, "").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
	if (v.startsWith("'")) return v.slice(1).replace(/'[^']*$/, "");
	v = v.replace(new RegExp(`[${WS}]+#[\\s\\S]*$`), "");
	return v;
}

/** Top-level frontmatter value. */
function fm(a: string[], key: string): string {
	if (a[0] !== "---") return "";
	for (let n = 1; n < a.length; n++) {
		const l = a[n];
		if (l === "---") return "";
		const i = l.indexOf(":");
		if (i > 0 && l.slice(0, i) === key) return fmVal(l.slice(i + 1));
	}
	return "";
}

/** customFields.KEY of a task note. */
function cf(a: string[], key: string): string {
	if (a[0] !== "---") return "";
	let on = false;
	for (let n = 1; n < a.length; n++) {
		const l = a[n];
		if (l === "---") return "";
		if (new RegExp(`^[^${WS}]`).test(l)) {
			on = new RegExp(`^customFields:[${WS}]*$`).test(l);
			continue;
		}
		if (on) {
			const t = l.replace(new RegExp(`^[${WS}]+`), "");
			const i = t.indexOf(":");
			if (i > 0 && t.slice(0, i) === key) return fmVal(t.slice(i + 1));
		}
	}
	return "";
}

const FOOTER = /^(Project|Parent): \[\[/;

/** Lines of section "## NAME", up to the next heading or the dotpm footer. */
function section(a: string[], name: string): string[] {
	const h = `## ${name}`;
	const out: string[] = [];
	let on = false;
	for (const l of a) {
		if (l.startsWith("## ")) {
			on = rtrim(l) === h;
			continue;
		}
		if (FOOTER.test(l)) on = false;
		if (on) out.push(l);
	}
	return out;
}

/** The lines without section "## NAME": its heading and its lines. */
function withoutSection(a: string[], name: string): string[] {
	const h = `## ${name}`;
	const out: string[] = [];
	let on = false;
	for (const l of a) {
		if (l.startsWith("## ")) on = rtrim(l) === h;
		if (!on) out.push(l);
	}
	return out;
}

function checklist(a: string[]): string {
	let t = 0;
	let d = 0;
	for (const l of section(a, "Checklist")) {
		if (new RegExp(`^[${WS}]*- \\[[ xX]\\]`).test(l)) {
			t++;
			if (/- \[[xX]\]/.test(l)) d++;
		}
	}
	return t ? `${d}/${t}` : "";
}

function lastLog(a: string[]): string {
	let last = "";
	for (const l of section(a, "Log")) if (hasText(l) && !l.startsWith("<!--")) last = l;
	return last;
}

/** Dependency ids from the dotpm "dependencies:" list of wikilinks. */
function depsOf(a: string[]): string[] {
	if (a[0] !== "---") return [];
	const picked: string[] = [];
	let on = false;
	for (let n = 1; n < a.length; n++) {
		const l = a[n];
		if (l === "---") break;
		if (on && new RegExp(`^[${WS}]+-`).test(l)) {
			picked.push(l);
			continue;
		}
		if (on) break;
		if (l.startsWith("dependencies:")) {
			const v = l.slice(13);
			if (hasText(v)) {
				picked.push(v);
				break;
			}
			on = true;
		}
	}
	const ids: string[] = [];
	for (const l of picked) {
		for (const m of l.matchAll(/\[\[[^\]|]+/g)) {
			ids.push(m[0].replace(/^\[\[/, "").replace(/.*\//, "").replace(/\.md$/, ""));
		}
	}
	return ids.join(" ").split(new RegExp(`[${WS}]+`)).filter(Boolean);
}

/** Design refs of the task note, one id per line, sorted and unique. */
function refsOf(a: string[]): string[] {
	const v = cf(a, "design_refs").replace(/[[\]"]/g, "");
	return [...new Set(v.split(/[, ]/).filter(Boolean))].sort();
}

const refOrigin = (id: string): string => (/^E[0-9]/.test(id) ? "epic.md" : "spec.md");

// ── ready: which files a task touches ────────────────────────────────────────

const EXTENSIONS = new Set(
	"ts tsx js jsx mjs cjs json jsonc md mdx sql go py rb rs java kt kts swift sh bash zsh yml yaml toml css scss sass less html htm vue svelte gql graphql proto lock sum mod txt xml csv tf tfvars hcl env ini cfg conf gradle properties php cs c h cpp hpp lua ex exs erl hs scala dart svg png jpg jpeg gif ico snap".split(" "),
);
const SPECIAL_FILES = new Set("Makefile Dockerfile Gemfile Rakefile Procfile Jenkinsfile Vagrantfile .env .gitignore .npmrc .nvmrc .dockerignore .editorconfig".split(" "));
const HAS_SPACE = new RegExp(`[${WS}]`);

function cleanPath(input: string): string {
	let t = trim(input);
	while (t.startsWith("./")) t = t.slice(2);
	return t.replace(/:[0-9]+([-:][0-9]+)*$/, "").replace(/#L[0-9]+(-L?[0-9]+)?$/, "");
}

function pathlike(input: string): boolean {
	const t = cleanPath(input);
	if (t === "" || t.length > 200 || HAS_SPACE.test(t) || t.includes("://")) return false;
	if (/[=,;'"$|&!#%^\\(){}]/.test(t)) return false;
	const base = t.replace(/^.*\//, "");
	if (t.includes("/")) return t.endsWith("/") || t.includes("*") || /\.[A-Za-z0-9]+$/.test(base);
	if (SPECIAL_FILES.has(base)) return true;
	if (!/^[A-Za-z0-9_@~<>*-][A-Za-z0-9_@.~<>*-]*\.[A-Za-z0-9]+$/.test(base)) return false;
	return EXTENSIONS.has(base.toLowerCase().replace(/^.*\./, ""));
}

/** Strip decoration from a word: bold markers, leading brackets and quotes, trailing punctuation. */
function bare(input: string): string {
	let w = trim(input);
	if (w.length > 4 && w.startsWith("**") && w.endsWith("**")) w = w.slice(2, -2);
	while (w !== "" && "([<\"'".includes(w[0])) w = w.slice(1);
	while (w !== "" && ")]>\"',;:.".includes(w[w.length - 1])) w = w.slice(0, -1);
	return w;
}

function fileword(input: string): boolean {
	const w = bare(input);
	if (w.includes("/")) return !/[=;'"$|&!#%^\\(){}]/.test(w) && !w.includes("://");
	return pathlike(w);
}

const firstWord = (s: string): string => {
	const t = trim(s);
	const i = t.search(HAS_SPACE);
	return i >= 0 ? t.slice(0, i) : t;
};

const IS_FILES = new RegExp(`^[${WS}]*([-*+][${WS}]+)?(\\*\\*|__)?[Ff]iles?([^A-Za-z:*_\`][^:*_\`]*)?(\\*\\*|__)?:`);
const LABEL_HEAD = new RegExp(`^[${WS}]*([-*+][${WS}]+)?(\\*\\*|__)`);
const IS_LABEL = new RegExp(`^[${WS}]*([-*+][${WS}]+)?(\\*\\*|__)[^*_\`]+(\\*\\*|__)?:`);

function isLabel(l: string): boolean {
	if (!IS_LABEL.test(l)) return false;
	let t = l.replace(LABEL_HEAD, "");
	const i = t.indexOf(":");
	t = i < 0 ? "" : t.slice(0, i);
	return !t.includes("/") && !t.includes(".");
}

/**
 * The files the task note says it touches: every path in the "Files" block of its description,
 * and every path written in backticks in its `## Design`.
 *  - The block opens at a line that starts with "Files" and runs to a colon (`**Files likely
 *    touched:**`, `Files: …`, in a list or not), and ends at the next blank line (blank lines
 *    right after the label don't end it), heading, or bold label (`**Estimated scope:**`).
 *  - In the block, everything in backticks counts. A line without backticks gives the first word
 *    of each comma-separated piece, or of its list item, that reads as a path.
 *  - In the design, only a backticked token that reads as a file counts: a path with an
 *    extension, a directory ending in "/", a glob, or a bare file name with a known extension.
 * A path loses its "./" and a trailing ":12" or "#L12".
 */
function taskFiles(a: string[]): string[] {
	const paths: string[] = [];
	const seen = new Set<string>();
	const add = (input: string) => {
		const t = cleanPath(input);
		if (t === "" || t.length > 200 || HAS_SPACE.test(t) || t.includes("://")) return;
		if (!seen.has(t)) {
			seen.add(t);
			paths.push(t);
		}
	};
	const ticks = (input: string, strict: boolean): number => {
		let s = input;
		let c = 0;
		for (;;) {
			const i = s.indexOf("`");
			if (i < 0) break;
			s = s.slice(i + 1);
			const j = s.indexOf("`");
			if (j < 0) break;
			const t = s.slice(0, j);
			s = s.slice(j + 1);
			c++;
			if (!strict || pathlike(t)) add(t);
		}
		return c;
	};
	const linePaths = (s: string) => {
		if (ticks(s, false) > 0) return;
		const item = s.replace(new RegExp(`^[${WS}]*([-*+]|[0-9]+[.)])[${WS}]+`), "");
		if (item !== s) {
			const w = firstWord(item);
			if (fileword(w)) add(bare(w));
			return;
		}
		for (const part of s.split(",")) {
			const w = firstWord(part);
			if (fileword(w)) add(bare(w));
		}
	};

	let infm = false;
	let sect = 0;
	let inf = false;
	let got = false;
	a.forEach((raw, n) => {
		if (n === 0 && raw === "---") {
			infm = true;
			return;
		}
		if (infm) {
			if (raw === "---") infm = false;
			return;
		}
		const l = rtrim(raw);
		if (l === "## Design") {
			sect = 1;
			inf = false;
			return;
		}
		if (sect && (l.startsWith("## ") || FOOTER.test(l))) sect = 2;
		if (sect === 2) return;
		if (sect === 1) {
			ticks(raw, true);
			return;
		}
		if (IS_FILES.test(l)) {
			inf = true;
			got = false;
			const r = l.replace(/^[^:]*:/, "").replace(/^(\*\*|__)/, "");
			if (hasText(r)) {
				got = true;
				linePaths(r);
			}
			return;
		}
		if (!inf) return;
		if (new RegExp(`^[${WS}]*$`).test(l)) {
			if (got) inf = false;
			return;
		}
		if (new RegExp(`^#+[${WS}]`).test(l) || isLabel(l)) {
			inf = false;
			return;
		}
		got = true;
		linePaths(l);
	});
	return paths;
}

interface Held {
	owner: string;
	path: string;
}

const globToRe = (g: string): string => {
	let r = "";
	for (const c of g) r += c === "*" ? ".*" : "\\.^$+?(){}|[]".includes(c) ? `\\${c}` : c;
	return r;
};

/**
 * The first file a candidate shares with a task that holds files, as "overlaps OWNER on FILE";
 * "" when there is none. Paths are compared as written, once "./" is dropped. Two overlap when:
 *  - they are equal, or one is the tail of the other at a "/" (notes shorten paths: `auth.ts`
 *    meets `src/auth.ts`);
 *  - one is a directory (ends in "/", or has no extension) that holds the other;
 *  - one is a glob (`*`) that matches the other, or both are globs that could match one file (the
 *    same text before the first "*" and after the last);
 *  - both are files matching one pattern of SHARED_OUTPUTS, whatever their paths.
 */
function fileConflict(busy: Held[], cands: string[]): string {
	const shared = SHARED_OUTPUTS.split(" ");
	const wild = (k: string) => k.includes("*");
	const head = (k: string) => k.slice(0, k.indexOf("*"));
	const foot = (k: string) => k.slice(k.lastIndexOf("*") + 1);
	const rel = (x: string, y: string) => x === "" || y === "" || x.startsWith(y) || y.startsWith(x);
	const relend = (x: string, y: string) => (x.length >= y.length ? x.endsWith(y) : y.endsWith(x));
	const dir = (k: string) => k.endsWith("/");
	const inside = (p: string, d: string) => `/${p}`.includes(`/${d}`);
	const tail = (x: string, y: string) => y.length > x.length && y.endsWith(`/${x}`);
	const base = (k: string) => k.replace(/^.*\//, "");
	const noext = (k: string) => !base(k).includes(".");
	const hit = (g: string, p: string) => (dir(p) ? rel(head(g), p) : new RegExp(`(^|/)${globToRe(g)}$`).test(p));
	const overlap = (x: string, y: string): boolean => {
		if (x === y) return true;
		if (wild(x) && wild(y)) return rel(head(x), head(y)) && relend(foot(x), foot(y));
		if (wild(x)) return hit(x, y);
		if (wild(y)) return hit(y, x);
		if (dir(x) && dir(y)) return inside(x, y) || inside(y, x);
		if (dir(x)) return inside(y, x);
		if (dir(y)) return inside(x, y);
		return tail(x, y) || tail(y, x) || (noext(x) && inside(y, `${x}/`)) || (noext(y) && inside(x, `${y}/`));
	};
	const common = (x: string, y: string): string => {
		const bx = base(x);
		const by = base(y);
		for (const p of shared) {
			const re = new RegExp(`^${globToRe(p)}$`);
			if (re.test(bx) && re.test(by)) return p;
		}
		return "";
	};
	for (const b of busy) {
		for (const c of cands) {
			if (overlap(c, b.path)) return `overlaps ${b.owner} on ${c}${c === b.path ? "" : ` ~ ${b.path}`}`;
			const p = common(c, b.path);
			if (p !== "") return `overlaps ${b.owner} on shared output ${p} (${c}, ${b.path})`;
		}
	}
	return "";
}

/** Task ids in plan order: by the number after the leading "t" (so t2 comes before t10), then by
 * the rest of the id. An id without one sorts last. The order doesn't depend on the locale. */
function planOrder(ids: string[]): string[] {
	const key = (id: string): string => {
		let n = 999999999;
		let r = id;
		const m = /^[tT][0-9]+/.exec(id);
		if (m) {
			n = Number(m[0].slice(1));
			r = id.slice(m[0].length);
		}
		return `${String(n).padStart(9, "0")}\t${r}\t${id}`;
	};
	return ids
		.map(id => [key(id), id] as const)
		.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
		.map(x => x[1]);
}

// ── approvals: what a fingerprint reads ──────────────────────────────────────

/** Markdown without HTML comments, blank lines, or trailing spaces: the text a fingerprint reads,
 * so reformatting never voids an approval. */
function fingerprintLines(a: string[]): string[] {
	const comment = new RegExp(`^[${WS}]*<!--[\\s\\S]*-->[${WS}]*$`);
	const out: string[] = [];
	for (const l of a) {
		if (comment.test(l)) continue;
		if (hasText(l)) out.push(rtrim(l));
	}
	return out;
}

const designSection = (a: string[]): string[] => fingerprintLines(section(a, "Design"));

/** The description in a task note: its body above `## Design`. Ticked boxes read as unticked, so
 * ticking an acceptance criterion keeps the approval. */
function taskDescription(a: string[]): string[] {
	const out: string[] = [];
	let infm = false;
	for (let n = 0; n < a.length; n++) {
		let l = a[n];
		if (n === 0 && l === "---") {
			infm = true;
			continue;
		}
		if (infm) {
			if (l === "---") infm = false;
			continue;
		}
		if (rtrim(l) === "## Design") break;
		const m = new RegExp(`^[${WS}]*[-*+] \\[[xX]\\]`).exec(l);
		if (m) l = `${l.slice(0, m[0].length - 2)} ${l.slice(m[0].length - 1)}`;
		out.push(l);
	}
	return fingerprintLines(out);
}

/**
 * The parts of the markdown that define ID, which must appear as a whole word: the whole section
 * under a heading that names it (up to the next heading of the same or a higher level), else each
 * blank-line-separated block that mentions it, followed by the table right after it when the block
 * introduces one. A fenced code block never splits a block or ends a section.
 */
function blocksMentioning(id: string, a: string[]): string[] {
	const out: string[] = [];
	let b: string[] = [];
	let want = false;
	let prev = false;
	let sec = 0;
	let fence = false;
	const names = (s: string) => ` ${s.replace(/[^A-Za-z0-9_-]/g, " ")} `.includes(` ${id} `);
	const flush = () => {
		if (b.length) {
			const isTable = b[0].startsWith("|");
			if (want || (prev && isTable)) {
				out.push(...b, "");
				prev = !isTable && want;
			} else prev = false;
		}
		b = [];
		want = false;
	};
	for (const l of a) {
		if (new RegExp(`^[${WS}]*(\`\`\`|~~~)`).test(l)) fence = !fence;
		let h = 0;
		if (!fence) {
			const m = /^#+ /.exec(l);
			if (m && m[0].length <= 7) h = m[0].length - 1;
		}
		if (sec && h && h <= sec) {
			sec = 0;
			out.push("");
		}
		if (!sec && h && names(l)) {
			flush();
			sec = h;
			prev = false;
		}
		if (sec) {
			out.push(l);
			continue;
		}
		if (new RegExp(`^[${WS}]*$`).test(l) && !fence) {
			flush();
			continue;
		}
		b.push(l);
		if (names(l)) want = true;
	}
	if (sec) out.push("");
	else flush();
	return out;
}

// ── the work-state run ───────────────────────────────────────────────────────

interface GitResult {
	status: number;
	stdout: string;
	stderr: string;
}

type ApprovalState = { state: "ok"; date: string; code: 0 } | { state: "missing"; code: 6 } | { state: "stale"; code: 7 };

class WorkState {
	private readonly env: Record<string, string>;
	private stdout = "";
	private stderr = "";
	private quiet = false;

	// Set by resolve().
	private ROOT = "";
	private STORE = "";
	private VAULT = "";
	private STORIES = "";
	private EPICS = "";
	private OLD_STORIES = "";
	private OLD_EPICS = "";
	private CONFIGURED = false;
	private SOURCE = "";
	private NOTES = "";
	private USER_CONFIG: string;

	constructor(
		private readonly cwd: string,
		env: Record<string, string | undefined>,
		private readonly onWrite?: WorkStateOptions["onWrite"],
	) {
		this.env = {};
		for (const [k, v] of Object.entries(env)) if (v !== undefined) this.env[k] = v;
		const xdg = env.XDG_CONFIG_HOME || `${env.HOME || os.homedir()}/.config`;
		this.USER_CONFIG = env.AGENT_SKILLS_CONFIG || `${xdg}/agent-skills/config.json`;
	}

	// ── output and exits ──

	private out(text: string): void {
		this.stdout += text;
		this.onWrite?.("stdout", text);
	}
	private err(text: string): void {
		if (this.quiet) return;
		this.stderr += text;
		this.onWrite?.("stderr", text);
	}
	private echo(text: string): void {
		this.out(`${text}\n`);
	}
	private die(msg: string): never {
		this.err(`work-state: ${msg}\n`);
		throw new Exit(1);
	}

	async run(argv: string[]): Promise<WorkStateResult> {
		let code = 0;
		try {
			this.dispatch(argv);
		} catch (e) {
			if (e instanceof Exit) code = e.code;
			else {
				this.err(`work-state: ${e instanceof Error ? e.message : String(e)}\n`);
				code = 1;
			}
		}
		return { code, stdout: this.stdout, stderr: this.stderr };
	}

	// ── git and files ──

	private git(args: string[], input?: string): GitResult {
		const r = spawnSync("git", args, {
			cwd: this.cwd,
			env: this.env,
			input,
			encoding: "utf8",
			maxBuffer: 1 << 28,
			stdio: ["pipe", "pipe", "pipe"],
		});
		return { status: r.status ?? (r.error ? 127 : 1), stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
	}

	private repoRoot(): string {
		const r = this.git(["rev-parse", "--show-toplevel"]);
		return r.status === 0 ? chomp(r.stdout) : "";
	}

	/** Replace FILE atomically. */
	private replace(file: string, text: string): void {
		const tmp = `${file}.tmp.${process.pid}`;
		fs.writeFileSync(tmp, text);
		fs.renameSync(tmp, file);
	}

	private read(file: string): string[] {
		return linesOf(readText(file));
	}

	/** The repository's name: the main worktree's directory, so every worktree of a repository
	 * maps to the same vault folder. */
	private repoName(): string {
		const r = this.git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
		const common = r.status === 0 ? chomp(r.stdout) : "";
		if (!common) return baseName(this.ROOT);
		const name = baseName(common);
		return name === ".git" ? baseName(dirName(common)) : name.replace(/\.git$/, "");
	}

	// ── store resolution ──

	/** Sets ROOT, STORE, VAULT, STORIES, EPICS (absolute), OLD_STORIES, OLD_EPICS (the repo-store
	 * dirs), CONFIGURED, SOURCE, NOTES. */
	private resolve(): void {
		const root = this.repoRoot();
		if (!root) this.die("not inside a git repository");
		this.ROOT = root;
		this.NOTES = "";
		this.VAULT = "";
		let s = "";
		let e = "";
		let want = "";
		let folder = "";
		const cfgFile = `${root}/${CONFIG}`;
		if (isFile(cfgFile)) {
			s = normalizeDir(configGet("storiesDir", cfgFile)) ?? "";
			e = normalizeDir(configGet("epicsDir", cfgFile)) ?? "";
			want = configGet("store", cfgFile);
			folder = configGet("vaultFolder", cfgFile);
			this.CONFIGURED = true;
		} else this.CONFIGURED = false;
		this.OLD_STORIES = `${root}/${s || DEFAULT_STORIES}`;
		this.OLD_EPICS = `${root}/${e || DEFAULT_EPICS}`;
		this.VAULT = configGet("vault", this.USER_CONFIG);
		if (this.VAULT && !isDir(this.VAULT)) {
			this.NOTES += `configured vault not found: ${this.VAULT}; `;
			this.VAULT = "";
		}
		switch (want) {
			case "repo":
				this.STORE = "repo";
				break;
			case "vault":
				if (!this.VAULT) this.die(`${CONFIG} asks for the vault store, but no vault is configured in ${this.USER_CONFIG}`);
				this.STORE = "vault";
				break;
			case "":
				this.STORE = this.VAULT ? "vault" : "repo";
				break;
			default:
				this.die(`unknown store '${want}' in ${CONFIG} (use vault or repo)`);
		}
		if (this.STORE === "vault") {
			let projects = configGet("projectsFolder", this.USER_CONFIG);
			if (!projects) projects = configGet("projectsFolder", `${this.VAULT}/${DOTPM_SETTINGS}`);
			const p = normalizeDir(projects || "Projects");
			if (p === null) this.die("projectsFolder must be a relative folder inside the vault");
			if (folder) {
				const f = normalizeDir(folder);
				if (f === null) this.die(`vaultFolder in ${CONFIG} must be a relative folder`);
				folder = f;
			} else folder = this.repoName();
			this.STORIES = `${this.VAULT}/${p}/${folder}/stories`;
			this.EPICS = `${this.VAULT}/${p}/${folder}/epics`;
			this.SOURCE = want === "vault" ? "config" : "vault";
		} else {
			this.STORIES = this.OLD_STORIES;
			this.EPICS = this.OLD_EPICS;
			if (this.CONFIGURED) this.SOURCE = "config";
			else if (isDir(this.STORIES) || isDir(this.EPICS)) this.SOURCE = "detected";
			else this.SOURCE = "default";
			if (!this.CONFIGURED) {
				for (const d of ["specs", "docs/specs", "openspec"]) {
					if (isDir(`${root}/${d}`)) this.NOTES += `existing spec directory: ${d}; `;
				}
			}
		}
		if (isFile(`${root}/tasks/plan.md`)) this.NOTES += "legacy single-plan layout: tasks/plan.md; ";
		if (this.oldLayoutPresent()) this.NOTES += `old task layout under ${stripPrefix(this.OLD_STORIES, `${root}/`)}: run work_state migrate; `;
	}

	/** Stories still in the pre-dotpm layout: <stories>/<id>/tasks/*.md, or, with the vault store,
	 * any story or epic left in the repository. */
	private oldLayoutPresent(): boolean {
		for (const d of globDirs(this.OLD_STORIES)) if (isDir(`${d}/tasks`)) return true;
		if (this.STORE === "vault") {
			if (globDirs(this.OLD_STORIES).length || globDirs(this.OLD_EPICS).length) return true;
		}
		return false;
	}

	/** A story directory: any directory under the stories dir except the epics dir, which some
	 * repositories keep inside it. */
	private isStoryDir(d: string): boolean {
		const t = d.replace(/\/$/, "");
		return isDir(t) && t !== this.EPICS && t !== this.OLD_EPICS;
	}

	private storyDirs(root: string): string[] {
		return globDirs(root).filter(d => this.isStoryDir(d));
	}

	/** The remote claims are published to: origin if present, else the first remote. */
	private remoteName(): string {
		const names = chomp(this.git(["remote"]).stdout).split("\n").filter(Boolean);
		return names.includes("origin") ? "origin" : (names[0] ?? "");
	}

	/** Refresh remote claims; stale ones are pruned. Offline is not an error. */
	private refresh(): void {
		const r = this.remoteName();
		if (r) this.git(["fetch", "--prune", "--quiet", r]);
	}

	private currentBranch(): string {
		const r = this.git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
		return r.status === 0 ? chomp(r.stdout) : "HEAD";
	}

	private linkTarget(p: string): string {
		const t = this.STORE === "vault" ? stripPrefix(p, `${this.VAULT}/`) : baseName(p);
		return t.replace(/\.md$/, "");
	}

	/** [[target|title]]; the title defaults to the note's own. */
	private link(file: string, title?: string): string {
		return `[[${this.linkTarget(file)}|${title || fm(this.read(file), "title")}]]`;
	}

	/** The story's epic: the project note's parent link. */
	private storyEpic(story: string): string {
		const p = `${this.STORIES}/${story}/${story}.md`;
		if (!isFile(p)) return "";
		return fm(this.read(p), "parent")
			.replace(/^\[\[/, "")
			.replace(/\]\]$/, "")
			.replace(/\|.*/, "")
			.replace(/.*\//, "");
	}

	// ── writing notes ──

	/** Set (or, with del, delete) top-level frontmatter KEY to the raw YAML VAL. */
	private fmPut(file: string, key: string, val: string, del = false): void {
		const out: string[] = [];
		const entry = () => `${key}:${val.startsWith("\n") ? val : ` ${val}`}`;
		let infm = false;
		let skip = false;
		let done = false;
		this.read(file).forEach((l, n) => {
			if (n === 0 && l === "---") {
				infm = true;
				out.push(l);
				return;
			}
			if (infm && l === "---") {
				if (!done && !del) out.push(entry());
				infm = false;
				out.push(l);
				return;
			}
			if (infm && skip && new RegExp(`^[${WS}]`).test(l)) return;
			if (infm) skip = false;
			if (infm && l.startsWith(`${key}:`)) {
				done = true;
				skip = true;
				if (!del) out.push(entry());
				return;
			}
			out.push(l);
		});
		this.replace(file, emit(out));
	}

	/** Drop a frontmatter block left empty ("---" twice at the top). */
	private stripEmptyFm(file: string): void {
		const out: string[] = [];
		let first = false;
		let skip = false;
		this.read(file).forEach((l, n) => {
			if (n === 0 && l === "---") {
				first = true;
				return;
			}
			if (n === 1 && first && l === "---") {
				first = false;
				skip = true;
				return;
			}
			if (n === 1 && first) out.push("---");
			if (skip && n === 2 && l === "") return;
			out.push(l);
		});
		this.replace(file, emit(out));
	}

	/** Set customFields.KEY to the raw YAML VAL, creating the block when needed. */
	private cfPut(file: string, key: string, val: string): void {
		const out: string[] = [];
		let infm = false;
		let incf = false;
		let seen = false;
		let done = false;
		const add = () => {
			if (!done) {
				if (!seen) out.push("customFields:");
				out.push(`  ${key}: ${val}`);
				done = true;
			}
		};
		this.read(file).forEach((l, n) => {
			if (n === 0 && l === "---") {
				infm = true;
				out.push(l);
				return;
			}
			if (infm && l === "---") {
				add();
				infm = false;
				out.push(l);
				return;
			}
			if (infm && new RegExp(`^[^${WS}]`).test(l)) {
				if (incf) add();
				incf = l.startsWith("customFields:");
				if (incf) {
					seen = true;
					out.push("customFields:");
					return;
				}
				out.push(l);
				return;
			}
			if (infm && incf) {
				const t = l.replace(new RegExp(`^[${WS}]+`), "");
				if (t.startsWith(`${key}:`)) {
					out.push(`  ${key}: ${val}`);
					done = true;
					return;
				}
			}
			out.push(l);
		});
		this.replace(file, emit(out));
	}

	private touchUpdated(file: string): void {
		this.fmPut(file, "updatedAt", nowIso());
	}

	/** Append LINE as the last line of section "## NAME", creating the section before the dotpm
	 * footer when it is missing. */
	private sectionAppend(file: string, name: string, line: string): void {
		const a = this.read(file);
		const h = `## ${name}`;
		const n = a.length;
		const out: string[] = [];
		let s = -1;
		for (let i = 0; i < n; i++) {
			if (rtrim(a[i]) === h) {
				s = i;
				break;
			}
		}
		if (s < 0) {
			let f = n;
			for (let i = n - 1; i >= 0; i--) {
				if (FOOTER.test(a[i])) {
					f = i;
					break;
				}
			}
			out.push(...a.slice(0, f), h, line, "", ...a.slice(f));
		} else {
			let e = n;
			for (let i = s + 1; i < n; i++) {
				if (a[i].startsWith("## ") || FOOTER.test(a[i])) {
					e = i;
					break;
				}
			}
			let last = s;
			for (let i = s + 1; i < e; i++) if (hasText(a[i])) last = i;
			out.push(...a.slice(0, last + 1), line, ...a.slice(last + 1));
		}
		this.replace(file, emit(out));
	}

	/** Recompute a task's progress: 100 when done, else the share of ticked checklist boxes (left
	 * alone when there is no checklist). */
	private updateProgress(file: string): void {
		if (fm(this.read(file), "status") === "done") {
			this.fmPut(file, "progress", "100");
			return;
		}
		const c = checklist(this.read(file));
		if (c) {
			const [d, t] = c.split("/").map(Number);
			this.fmPut(file, "progress", String(Math.floor((d * 100) / t)));
		}
	}

	/** A dotpm project note. `fields` declares the agent's custom task fields. */
	private writeProject(file: string, title: string, parent: string, fields: boolean): void {
		const now = nowIso();
		fs.mkdirSync(dirName(file), { recursive: true });
		const out = ["---", "pm-project: true", `id: ${q(pmId())}`, `title: ${q(title)}`, 'description: ""', 'color: "#8b72be"', 'icon: "📋"', "taskIds: []"];
		if (parent) out.push(`parent: ${q(`[[${parent}]]`)}`);
		if (fields) {
			out.push("customFields:");
			for (const [id, name] of [["design_refs", "Design refs"], ["branch", "Branch"], ["design_approved", "Design approved"]]) {
				out.push(`  - id: "${id}"`, `    name: "${name}"`, '    type: "text"');
			}
		} else out.push("customFields: []");
		out.push("teamMembers: []", "savedViews: []", `createdAt: ${q(now)}`, `updatedAt: ${q(now)}`, "---", "", `# 📋 ${title}`, "");
		fs.writeFileSync(file, emit(out));
	}

	/** Add LINK to a project note's taskIds and to its "## Tasks" list. */
	private projectAddTask(file: string, linkText: string): void {
		const a = this.read(file);
		const n = a.length;
		const ql = q(linkText);
		let t = -1;
		let e = -1;
		for (let i = 0; i < n; i++) {
			if (a[i] === "## Tasks") {
				t = i;
				break;
			}
		}
		if (t >= 0) {
			e = t;
			for (let i = t + 1; i < n && !a[i].startsWith("## "); i++) if (a[i].startsWith("- [")) e = i;
		}
		const out: string[] = [];
		let infm = false;
		let blk = false;
		for (let i = 0; i < n; i++) {
			let l = a[i];
			if (i === 0 && l === "---") {
				infm = true;
				out.push(l);
				continue;
			}
			if (infm && blk && !new RegExp(`^[${WS}]+-`).test(l)) {
				out.push(`  - ${ql}`);
				blk = false;
			}
			if (infm && l === "---") infm = false;
			else if (infm && new RegExp(`^taskIds:[${WS}]*\\[\\][${WS}]*$`).test(l)) l = `taskIds: [${ql}]`;
			else if (infm && new RegExp(`^taskIds:[${WS}]*\\[.*\\][${WS}]*$`).test(l)) l = l.replace(new RegExp(`\\][${WS}]*$`), () => `, ${ql}]`);
			else if (infm && new RegExp(`^taskIds:[${WS}]*$`).test(l)) blk = true;
			out.push(l);
			if (t >= 0 && i === e) out.push(`- [ ] ${linkText}`);
		}
		if (t < 0) {
			if (a[n - 1] !== "") out.push("");
			out.push("## Tasks", `- [ ] ${linkText}`);
		}
		this.replace(file, emit(out));
	}

	/** Tick or untick a task's line in its project note's "## Tasks" list. */
	private projectTick(file: string, id: string, mark: string): void {
		const p = `- [ ] [[${id}|`;
		const x = `- [x] [[${id}|`;
		const out = this.read(file).map(l => (l.startsWith(p) || l.startsWith(x) ? `- [${mark}]${l.slice(5)}` : l));
		this.replace(file, emit(out));
	}

	// ── claims ──

	/** Claim ref for STORY/TASK: the local ref, else a remote one ("" if unclaimed). */
	private claimRef(story: string, task: string): string {
		const want = `${NS}/${story}/${task}`;
		if (this.git(["show-ref", "--verify", "--quiet", `refs/heads/${want}`]).status === 0) return want;
		const r = this.git(["for-each-ref", "--format=%(refname:short)", `refs/remotes/*/${want}`]);
		return r.stdout.split("\n")[0] ?? "";
	}

	/** Work branch recorded in a claim's commit message. */
	private claimWork(ref: string): string {
		const r = this.git(["log", "-1", "--format=%s", ref]);
		if (r.status !== 0) return "";
		const m = /^.* work=([^ ]*).*$/.exec(r.stdout.split("\n")[0] ?? "");
		return m ? m[1] : "";
	}

	private worktreeOf(branch: string): string {
		let p = "";
		for (const l of this.git(["worktree", "list", "--porcelain"]).stdout.split("\n")) {
			if (l.startsWith("worktree ")) p = l.slice(9);
			if (l === `branch refs/heads/${branch}`) return p;
		}
		return "";
	}

	/** Freshest copy of a task note. The vault store has one copy. The repo store reads the work
	 * branch's worktree (uncommitted edits included), then the work branch, then this checkout. */
	private taskContent(story: string, id: string, ref: string): string {
		if (this.STORE === "repo" && ref) {
			const rel = `${stripPrefix(this.STORIES, `${this.ROOT}/`)}/${story}/_tasks/${id}.md`;
			const work = this.claimWork(ref);
			if (work) {
				const wt = this.worktreeOf(work);
				if (wt && isFile(`${wt}/${rel}`)) return chomp(readText(`${wt}/${rel}`));
				const r = this.git(["show", `${work}:${rel}`]);
				if (r.status === 0) return chomp(r.stdout);
			}
		}
		return chomp(readText(`${this.STORIES}/${story}/_tasks/${id}.md`));
	}

	/** Path of the freshest writable copy of a task note (see taskContent). */
	private taskPath(story: string, id: string): string {
		if (this.STORE === "repo") {
			const ref = this.claimRef(story, id);
			if (ref) {
				const rel = `${stripPrefix(this.STORIES, `${this.ROOT}/`)}/${story}/_tasks/${id}.md`;
				const work = this.claimWork(ref);
				if (work) {
					const wt = this.worktreeOf(work);
					if (wt && isFile(`${wt}/${rel}`)) return `${wt}/${rel}`;
				}
			}
		}
		return `${this.STORIES}/${story}/_tasks/${id}.md`;
	}

	private needTask(story: string, task: string, op: string, extra = ""): void {
		if (!story || !task) this.die(`usage: work_state ${op} STORY TASK${extra ? ` ${extra}` : ""}`);
		this.resolve();
		if (!isFile(`${this.STORIES}/${story}/_tasks/${task}.md`)) this.die(`no task note ${this.STORIES}/${story}/_tasks/${task}.md`);
	}

	private needStory(story: string, op: string, extra = ""): void {
		if (!validId(story)) this.die(`usage: work_state ${op} STORY${extra ? ` ${extra}` : ""}`);
		this.resolve();
		if (!isFile(`${this.STORIES}/${story}/${story}.md`)) this.die(`no project note for story '${story}'; run work_state init-story first`);
	}

	/** Status, progress, completed date, and updatedAt in one go. In progress under a claim also
	 * records the claim's work branch. The vault store also ticks the task in its project note. */
	private applyStatus(story: string, task: string, status: string): void {
		const file = this.taskPath(story, task);
		this.fmPut(file, "status", status);
		if (complete(status)) this.fmPut(file, "completed", today());
		else this.fmPut(file, "completed", "", true);
		const ref = this.claimRef(story, task);
		if (status === "in-progress" && ref) this.cfPut(file, "branch", q(this.claimWork(ref)));
		this.updateProgress(file);
		this.touchUpdated(file);
		const proj = `${this.STORIES}/${story}/${story}.md`;
		if (this.STORE === "vault" && isFile(proj)) this.projectTick(proj, this.linkTarget(file), complete(status) ? "x" : " ");
	}

	private cmdClaim(story: string, task: string, given: string): void {
		this.needTask(story, task, "claim", "[WORK_BRANCH]");
		const work = given || this.currentBranch();
		const ref = `refs/heads/${NS}/${story}/${task}`;
		this.refresh();
		if (this.claimRef(story, task)) {
			this.echo(`taken: ${story}/${task}`);
			throw new Exit(3);
		}
		// A unique id per claim: the session that made it holds the id; nobody else can.
		const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
		const id = `${stamp}Z-${process.pid}-${randomInt(32768)}${randomInt(32768)}`;
		const tree = this.git(["mktree"], "");
		if (tree.status !== 0) this.failed(tree);
		const commit = this.git(["commit-tree", chomp(tree.stdout), "-m", `claim ${story}/${task} work=${work} id=${id} host=${os.hostname() || "unknown"}`]);
		if (commit.status !== 0) this.failed(commit);
		const c = chomp(commit.stdout);
		if (this.git(["update-ref", ref, c, ""]).status !== 0) {
			this.echo(`taken: ${story}/${task}`);
			throw new Exit(3);
		}
		const r = this.remoteName();
		if (r) {
			// Empty lease: the push succeeds only if no other machine holds the claim.
			// --no-verify: a pre-push hook for code must not decide who owns a lock.
			if (this.git(["push", "--quiet", "--no-verify", `--force-with-lease=${ref}:`, r, `${ref}:${ref}`]).status !== 0) {
				this.git(["update-ref", "-d", ref, c]);
				// Ask the push destination itself: fetch and push URLs can differ.
				const url = this.git(["remote", "get-url", "--push", r]);
				const target = url.status === 0 ? chomp(url.stdout) : r;
				if (this.git(["ls-remote", "--exit-code", target, ref]).status === 0) {
					this.echo(`taken: ${story}/${task}`);
					throw new Exit(3);
				}
				this.err(`error: could not publish the claim to remote '${r}' (offline or rejected); nothing was claimed\n`);
				throw new Exit(5);
			}
		}
		this.echo(`claimed: ${story}/${task} work=${work} id=${id}`);
		// Mark the note where the work happens. In the repo store a work branch with no checkout yet
		// would leave the change in this checkout, in the way of the merge, so the note is marked
		// from the new worktree instead.
		if (this.STORE === "vault" || work === this.currentBranch() || this.worktreeOf(work)) this.applyStatus(story, task, "in-progress");
		else this.echo(`next: once the worktree for ${work} exists, run there: work_state set ${story} ${task} in-progress`);
	}

	/** A failed git command under `set -e`: its message, then its exit code. */
	private failed(r: GitResult): never {
		this.err(r.stderr);
		throw new Exit(r.status);
	}

	private cmdRelease(story: string, task: string): void {
		if (!story || !task) this.die("usage: work_state release STORY TASK");
		this.resolve();
		const ref = `refs/heads/${NS}/${story}/${task}`;
		this.git(["update-ref", "-d", ref]);
		const r = this.remoteName();
		if (r) this.git(["push", "--quiet", "--no-verify", r, "--delete", ref]);
		this.echo(`released: ${story}/${task}`);
	}

	/** A dependency is finished when it is complete where `next` looks: in the repo store, in this
	 * checkout (merged here); in the vault store, complete with its lock released (a lock is
	 * released once the work is merged). */
	private depFinished(story: string, dep: string): boolean {
		const f = `${this.STORIES}/${story}/_tasks/${dep}.md`;
		if (!isFile(f)) return false;
		if (!complete(fm(this.read(f), "status"))) return false;
		if (this.STORE === "vault" && this.claimRef(story, dep)) return false;
		return true;
	}

	private depsDone(story: string, a: string[]): boolean {
		return depsOf(a).every(dep => this.depFinished(story, dep));
	}

	private cmdNext(only: string): void {
		this.resolve();
		this.refresh();
		for (const dir of this.storyDirs(this.STORIES)) {
			const s = baseName(dir);
			if (only && s !== only) continue;
			for (const f of globMd(`${this.STORIES}/${s}/_tasks`)) {
				const id = taskIdOf(f);
				const a = this.read(f);
				if (fm(a, "status") !== "todo") continue;
				if (this.claimRef(s, id)) continue;
				if (this.depsDone(s, a)) {
					this.echo(`${s}/${id}`);
					return;
				}
			}
		}
		throw new Exit(4);
	}

	// ── ready: every task a wave can start now ──
	//
	// `next` offers the first task that can start; `ready` offers all that can start together. A
	// task is listed when it is todo and unclaimed, its design approval holds (`approved` exits 0),
	// every dependency is complete as `next` counts it, and it shares no file with a task that is
	// claimed, in progress, in review, or blocked, or with a task listed before it. A task's files
	// come from its note: the "Files" block of its description (the Step 4 structure of
	// planning-and-task-breakdown, above `## Design`) and the paths written in backticks in `## Design`.

	private cmdReady(story: string): void {
		if (!validId(story)) this.die("usage: work_state ready STORY");
		this.resolve();
		if (!isDir(`${this.STORIES}/${story}`)) this.die(`no story '${story}' under ${this.STORIES}`);
		this.refresh();
		const ids = planOrder(globMd(`${this.STORIES}/${story}/_tasks`).map(taskIdOf));
		const cands: string[] = [];
		let busy: Held[] = [];
		// A task under way holds its files; a todo task nobody holds is a candidate.
		for (const id of ids) {
			const ref = this.claimRef(story, id);
			const a = contentLines(this.taskContent(story, id, ref));
			const status = fm(a, "status");
			const held = ref !== "" || status === "in-progress" || status === "review" || status === "blocked";
			if (held) busy.push(...taskFiles(a).map(path => ({ owner: `${story}/${id} (running)`, path })));
			else if (status === "todo") cands.push(id);
		}
		let n = 0;
		for (const id of cands) {
			const a = this.read(`${this.STORIES}/${story}/_tasks/${id}.md`);
			if (this.approvalState(story, id).code !== 0) continue;
			if (!this.depsDone(story, a)) continue;
			const cand = taskFiles(a);
			const hit = fileConflict(busy, cand);
			if (hit) {
				this.err(`skipped: ${story}/${id} ${hit}\n`);
				continue;
			}
			if (cand.length === 0) this.err(`note: ${story}/${id} lists no files, so its overlap with other tasks is unchecked\n`);
			this.echo(`${story}/${id}`);
			n++;
			busy = busy.concat(cand.map(path => ({ owner: `${story}/${id} (ready)`, path })));
		}
		if (n === 0) throw new Exit(4);
	}

	// ── creating epics, stories, and tasks ──

	private cmdInitEpic(epic: string, title: string): void {
		if (!(validId(epic) && title)) this.die("usage: work_state init-epic EPIC TITLE");
		this.resolve();
		const file = `${this.EPICS}/${epic}/${epic}.md`;
		if (isFile(file)) {
			this.echo(`exists: ${file}`);
			return;
		}
		this.writeProject(file, title, "", false);
		this.echo(`created: ${file}`);
	}

	private cmdInitStory(story: string, title: string, epicId: string): void {
		if (!(validId(story) && title)) this.die("usage: work_state init-story STORY TITLE [EPIC]");
		if (epicId && !validId(epicId)) this.die(`bad epic id: ${epicId}`);
		this.resolve();
		const file = `${this.STORIES}/${story}/${story}.md`;
		if (isFile(file)) {
			this.echo(`exists: ${file}`);
			return;
		}
		const epic = epicId ? this.linkTarget(`${this.EPICS}/${epicId}/${epicId}.md`) : "";
		this.writeProject(file, title, epic, true);
		this.echo(`created: ${file}`);
	}

	/** Write a dotpm task note. An empty body gets the section skeleton. */
	private writeTask(file: string, story: string, title: string, status: string, deps: string[], bodyText: string): void {
		const plink = this.link(`${this.STORIES}/${story}/${story}.md`);
		const now = nowIso();
		const body = chomp(bodyText);
		fs.mkdirSync(dirName(file), { recursive: true });
		const out = [
			"---",
			"pm-task: true",
			`projectId: ${q(plink)}`,
			"parentId:",
			`id: ${pmId()}`,
			`title: ${q(title)}`,
			"type: task",
			`status: ${status}`,
			"priority: medium",
			'start: ""',
			'due: ""',
			`progress: ${status === "done" ? 100 : 0}`,
			"assignees: []",
			"tags:",
			`  - story/${story}`,
			"subtaskIds: []",
		];
		if (deps.length === 0) out.push("dependencies: []");
		else {
			out.push("dependencies:");
			for (const dep of deps) out.push(`  - ${q(this.link(`${this.STORIES}/${story}/_tasks/${dep}.md`))}`);
		}
		out.push(`createdAt: ${now}`, `updatedAt: ${now}`);
		if (complete(status)) out.push(`completed: ${today()}`);
		out.push("---", "");
		if (body) out.push(body);
		else out.push("## Design", "", "## Summary", "", "## Checklist", "", "## Log");
		out.push("", `Project: ${plink}`);
		fs.writeFileSync(file, emit(out));
	}

	private cmdNewTask(args: string[]): void {
		const story = args[0] ?? "";
		const given = args[1] ?? "";
		if (!given) this.die("usage: work_state new-task STORY TITLE [DEP-ID...]");
		this.needStory(story, "new-task", "TITLE [DEP-ID...]");
		const title = taskTitle(given);
		const id = slug(title);
		if (!validId(id)) this.die(`title '${given}' gives no usable task id`);
		const file = `${this.STORIES}/${story}/_tasks/${id}.md`;
		if (isFile(file)) this.die(`task ${story}/${id} already exists`);
		const deps: string[] = [];
		for (const dep of args.slice(2)) {
			if (!isFile(`${this.STORIES}/${story}/_tasks/${dep}.md`)) this.die(`unknown dependency ${story}/${dep}`);
			deps.push(dep);
		}
		this.writeTask(file, story, title, "todo", deps, "");
		this.projectAddTask(`${this.STORIES}/${story}/${story}.md`, this.link(file, title));
		this.echo(`task=${id}`);
		this.echo(`path=${file}`);
	}

	private cmdPath(story: string, task: string): void {
		if (!validId(story)) this.die("usage: work_state path STORY [TASK]");
		this.resolve();
		if (!task) {
			this.echo(`${this.STORIES}/${story}`);
			return;
		}
		if (!isFile(`${this.STORIES}/${story}/_tasks/${task}.md`)) this.die(`no task note ${this.STORIES}/${story}/_tasks/${task}.md`);
		this.echo(this.taskPath(story, task));
	}

	private cmdField(story: string, task: string, key: string, value: string): void {
		this.needTask(story, task, "field", "KEY VALUE");
		if (key === "" || /[^A-Za-z0-9_-]/.test(key)) this.die("field names are letters, digits, _ and -");
		const file = this.taskPath(story, task);
		this.cfPut(file, key, q(value));
		this.touchUpdated(file);
		this.echo(`field: ${story}/${task} ${key}=${value}`);
	}

	private cmdSet(story: string, task: string, status: string): void {
		this.needTask(story, task, "set", "STATUS");
		if (!` ${STATUSES} `.includes(` ${status} `)) this.die(`status must be one of: ${STATUSES}`);
		this.applyStatus(story, task, status);
		this.echo(`set: ${story}/${task} status=${status}`);
	}

	private cmdLog(story: string, task: string, text: string): void {
		this.needTask(story, task, "log", "TEXT");
		if (!text) this.die("usage: work_state log STORY TASK TEXT");
		const file = this.taskPath(story, task);
		this.sectionAppend(file, "Log", `- ${today()} ${text}`);
		this.updateProgress(file);
		this.touchUpdated(file);
		this.echo(`logged: ${story}/${task}`);
	}

	// ── task approval ──
	//
	// The approval gate records `design_approved: <date> <hash>` in the task's customFields. <hash>
	// fingerprints what the builder works from: the task description above `## Design`, the
	// `## Design` section, the ids in `design_refs`, and the blocks that define those ids (in the
	// story's spec.md, or design.md; for E-ids, in its epic's `## Architecture`). Editing any of
	// them afterwards changes the hash, so the approval no longer holds.

	/** Fingerprint of the task note, for the story given. */
	private taskHash(story: string, a: string[]): string {
		const text = [...taskDescription(a), "## Design", ...designSection(a)];
		for (const id of refsOf(a)) text.push(`## ${id}`, ...fingerprintLines(this.refBlocks(story, id)));
		return hashLines(text);
	}

	/** What approvals fingerprinted before descriptions and contracts were covered: the `## Design`
	 * section alone. */
	private designHash(a: string[]): string {
		return hashLines(designSection(a));
	}

	/** "ok <date>", "missing", or "stale" for a task; exit 0, 6, or 7. */
	private approvalState(story: string, id: string): ApprovalState {
		const a = contentLines(this.taskContent(story, id, this.claimRef(story, id)));
		const value = cf(a, "design_approved");
		if (!value) return { state: "missing", code: 6 };
		if (value.slice(value.lastIndexOf(" ") + 1) !== this.taskHash(story, a)) return { state: "stale", code: 7 };
		return { state: "ok", date: value.split(" ")[0], code: 0 };
	}

	private approvalText(s: ApprovalState): string {
		return s.state === "ok" ? `ok ${s.date}` : s.state;
	}

	private cmdApprove(story: string, task: string, flag: string): void {
		this.needTask(story, task, "approve");
		const file = this.taskPath(story, task);
		const a = this.read(file);
		const design = designSection(a);
		if (design.length === 0) this.die("the task's ## Design section is empty; write the design note before approving");
		const lines = design.filter(hasText).length;
		if (lines > 15 && flag !== "--allow-long") {
			this.die(`the task's ## Design has ${lines} lines (limit 15): split the task (low-level-design step 7), or pass --allow-long only after the user chose to keep it whole at the gate`);
		}
		const stamp = `${approvalStamp()} ${this.taskHash(story, a)}`;
		this.cfPut(file, "design_approved", q(stamp));
		this.touchUpdated(file);
		this.echo(`approved: ${story}/${task} (${stamp})`);
	}

	private cmdApproved(story: string, task: string): void {
		this.needTask(story, task, "approved");
		const s = this.approvalState(story, task);
		switch (s.state) {
			case "ok":
				this.echo(`approved: ${story}/${task} (${s.date})`);
				break;
			case "missing":
				this.echo(`not approved: ${story}/${task} has no approved design; run the approval gate`);
				break;
			case "stale":
				this.echo(`not approved: ${story}/${task} changed after approval (its description, design, or a cited contract); run the gate again`);
				break;
		}
		if (s.code !== 0) throw new Exit(s.code);
	}

	/** Re-record the approval of the task note FILE, made under the earlier fingerprint, under the
	 * current one, but only when its `## Design` is unchanged since. False when there is no such approval. */
	private restampApproval(story: string, file: string): boolean {
		const a = this.read(file);
		const value = cf(a, "design_approved");
		if (!value || value.slice(value.lastIndexOf(" ") + 1) !== this.designHash(a)) return false;
		this.cfPut(file, "design_approved", q(`${value.split(" ")[0]} ${this.taskHash(story, a)}`));
		return true;
	}

	// ── phase approvals ──
	//
	// A story's gates record `spec_approved`, `design_approved`, and `plan_approved` as
	// `<date> <hash>` in the story project note's frontmatter, where <hash> fingerprints the
	// artifact the gate approved. Editing it afterwards changes the hash, so the approval no longer
	// holds. The values are top-level keys: the note's `customFields` is dotpm's list of field
	// definitions, not a map.

	private validPhase(p: string): boolean {
		return p === "spec" || p === "design" || p === "plan";
	}

	/** The file a story's phase approval covers. */
	private phaseFile(story: string, phase: string): string {
		return `${this.STORIES}/${story}/${phase === "plan" ? "plan.md" : "spec.md"}`;
	}

	/** The text a phase approval fingerprints: the spec without its `## Design`; the design (the
	 * spec's `## Design`, then design.md when the design lives there); the plan with the sorted ids
	 * of the story's task notes. */
	private phaseText(story: string, phase: string): string[] {
		const dir = `${this.STORIES}/${story}`;
		switch (phase) {
			case "spec":
				return fingerprintLines(withoutSection(this.read(`${dir}/spec.md`), "Design"));
			case "design": {
				const out = designSection(this.read(`${dir}/spec.md`));
				if (isFile(`${dir}/design.md`)) out.push(...fingerprintLines(this.read(`${dir}/design.md`)));
				return out;
			}
			default:
				return [...fingerprintLines(this.read(`${dir}/plan.md`)), ...globMd(`${dir}/_tasks`).map(taskIdOf).sort()];
		}
	}

	private phaseHash(story: string, phase: string): string {
		return hashLines(this.phaseText(story, phase));
	}

	/** Whether the story has no design: its approval then records a skipped phase. */
	private designSkipped(story: string): boolean {
		return this.phaseText(story, "design").length === 0;
	}

	/** "ok <date>", "missing", or "stale" for a story's PHASE approval; exit 0, 6, or 7. */
	private phaseState(story: string, phase: string): ApprovalState {
		const note = `${this.STORIES}/${story}/${story}.md`;
		const value = isFile(note) ? fm(this.read(note), `${phase}_approved`) : "";
		if (!value || !isFile(this.phaseFile(story, phase))) return { state: "missing", code: 6 };
		if (value.slice(value.lastIndexOf(" ") + 1) !== this.phaseHash(story, phase)) return { state: "stale", code: 7 };
		return { state: "ok", date: value.split(" ")[0], code: 0 };
	}

	private phaseOk(story: string, phase: string): boolean {
		return this.phaseState(story, phase).code === 0;
	}

	/** Record the approval of a story's PHASE for its files as they are now. */
	private recordPhase(story: string, phase: string): void {
		const stamp = `${approvalStamp()} ${this.phaseHash(story, phase)}`;
		this.fmPut(`${this.STORIES}/${story}/${story}.md`, `${phase}_approved`, q(stamp));
		const skipped = phase === "design" && this.designSkipped(story) ? " as skipped, none written" : "";
		this.echo(`approved: ${story} ${phase}${skipped} (${stamp})`);
	}

	private cmdApprovePhase(story: string, phase: string): void {
		this.needStory(story, "approve-phase", "spec|design|plan");
		if (!this.validPhase(phase)) this.die("usage: work_state approve-phase STORY spec|design|plan");
		const file = this.phaseFile(story, phase);
		if (!isFile(file)) this.die(`no ${baseName(file)} for story ${story}; write it before approving the ${phase}`);
		if (phase === "plan" && globMd(`${this.STORIES}/${story}/_tasks`).length === 0) {
			this.die(`story ${story} has no task notes; create them with new-task before approving the plan`);
		}
		this.recordPhase(story, phase);
	}

	private cmdApprovedPhase(story: string, phase: string): void {
		this.needStory(story, "approved-phase", "spec|design|plan");
		if (!this.validPhase(phase)) this.die("usage: work_state approved-phase STORY spec|design|plan");
		const s = this.phaseState(story, phase);
		switch (s.state) {
			case "ok":
				this.echo(`approved: ${story} ${phase} (${phase === "design" && this.designSkipped(story) ? "skipped, " : ""}${s.date})`);
				break;
			case "missing":
				this.echo(`not approved: ${story} has no approved ${phase}; run the ${phase} gate`);
				break;
			case "stale":
				this.echo(`not approved: ${story}'s ${phase} changed after approval; run the gate again`);
				break;
		}
		if (s.code !== 0) throw new Exit(s.code);
	}

	/** A planned story that predates recorded approvals: it has a spec, a plan, and task notes, and
	 * none of its three approvals is recorded. */
	private legacyStory(story: string): boolean {
		const dir = `${this.STORIES}/${story}`;
		const note = `${dir}/${story}.md`;
		if (!(isFile(note) && isFile(`${dir}/spec.md`) && isFile(`${dir}/plan.md`))) return false;
		const a = this.read(note);
		for (const k of ["spec", "design", "plan"]) if (fm(a, `${k}_approved`) !== "") return false;
		return globMd(`${dir}/_tasks`).length > 0;
	}

	/** One-shot, run on the user's say-so: record the spec, design, and plan of a planned story that
	 * predates approvals as approved, and re-record its task approvals. */
	private cmdAdoptApprovals(story: string): void {
		this.needStory(story, "adopt-approvals");
		if (!this.legacyStory(story)) {
			this.die("adopt-approvals is for a planned story (spec, plan, and task notes) with no recorded approvals; run its gates and approve-phase instead");
		}
		this.recordPhase(story, "spec");
		this.recordPhase(story, "design");
		this.recordPhase(story, "plan");
		for (const f of globMd(`${this.STORIES}/${story}/_tasks`)) {
			const id = taskIdOf(f);
			if (this.restampApproval(story, this.taskPath(story, id))) {
				this.echo(`approved: ${story}/${id} (re-recorded: the fingerprint now covers its description and cited contracts)`);
			}
		}
	}

	// ── brief: the minimum context one task needs ──

	/** The blocks that define design ref ID: what `brief` shows, and what an approval fingerprints.
	 * An E-id's are searched in the epic's `## Architecture` only. */
	private refBlocks(story: string, id: string): string[] {
		if (refOrigin(id) === "epic.md") {
			const epic = this.storyEpic(story);
			const file = `${this.EPICS}/${epic}/epic.md`;
			if (epic && isFile(file)) return blocksMentioning(id, section(this.read(file), "Architecture"));
			return [];
		}
		const out: string[] = [];
		for (const file of [`${this.STORIES}/${story}/spec.md`, `${this.STORIES}/${story}/design.md`]) {
			if (isFile(file)) out.push(...blocksMentioning(id, this.read(file)));
		}
		return out;
	}

	private cmdBrief(story: string, task: string): void {
		this.needTask(story, task, "brief");
		const content = this.taskContent(story, task, this.claimRef(story, task));
		const a = contentLines(content);
		const spec = `${this.STORIES}/${story}/spec.md`;
		const plan = `${this.STORIES}/${story}/plan.md`;
		this.echo(`== approval: ${this.approvalText(this.approvalState(story, task))}`);
		this.echo(`== task ${this.taskPath(story, task)}`);
		this.echo(content);
		if (isFile(plan)) {
			this.echo("");
			this.echo("== plan row");
			const rows = this.read(plan).filter(l => l.includes(task));
			if (rows.length) this.out(emit(rows));
			else this.echo("(not listed in plan.md)");
		}
		if (!isFile(spec)) {
			this.echo("");
			this.echo(`== no spec at ${spec}`);
			return;
		}
		for (const r of refsOf(a)) {
			this.echo("");
			this.echo(`== design ${r} (from ${refOrigin(r)})`);
			this.out(emit(this.refBlocks(story, r)));
		}
		// Requirement ids the task names in its own text (FR1, NFR3, ...).
		const req = new Set<string>();
		for (const l of a) for (const m of l.matchAll(/\bN?FR[0-9]+\b/g)) req.add(m[0]);
		const specLines = this.read(spec);
		for (const r of [...req].sort()) {
			this.echo("");
			this.echo(`== requirement ${r} (from spec.md)`);
			const re = new RegExp(`(^|[^A-Za-z0-9])${r}([^0-9]|$)`);
			this.out(emit(specLines.filter(l => re.test(l)).slice(0, 5)));
		}
	}

	/** The tasks of STORY whose design_refs include ID, one per line as "TASK STATUS": the ones to
	 * re-gate (those not done) after the contract ID changed. */
	private cmdCites(story: string, ref: string): void {
		if (!(validId(story) && ref)) this.die("usage: work_state cites STORY ID");
		this.resolve();
		if (!isDir(`${this.STORIES}/${story}`)) this.die(`no story '${story}' under ${this.STORIES}`);
		for (const f of globMd(`${this.STORIES}/${story}/_tasks`)) {
			const id = taskIdOf(f);
			const a = contentLines(this.taskContent(story, id, this.claimRef(story, id)));
			if (refsOf(a).includes(ref)) this.echo(`${id} ${fm(a, "status")}`);
		}
	}

	// ── phase: where a story stands ──
	//
	// none    no story directory yet
	// spec    no spec.md, or its approval is missing or stale     → write or re-gate the spec
	// design  spec approved; neither design nor plan is approved  → high-level design (approving it empty skips it)
	// plan    plan not approved: no plan.md or task notes yet, or either changed since → plan the tasks
	// build   plan approved, some task is not complete (one in review is not)         → build the tasks
	// done    plan approved, every task is done or cancelled
	// Each phase ends when its gate records `approve-phase`, and holds while the approved artifact
	// stays unchanged. An approved plan keeps a story past a design edited since: its tasks re-gate
	// on the contracts they cite.

	private cmdPhase(story: string): void {
		if (!validId(story)) this.die("usage: work_state phase STORY");
		this.resolve();
		if (!isDir(`${this.STORIES}/${story}`)) {
			this.echo("phase=none");
			return;
		}
		let phase: string;
		let open = 0;
		if (!this.phaseOk(story, "spec")) phase = "spec";
		else if (!this.phaseOk(story, "design") && !this.phaseOk(story, "plan")) phase = "design";
		else if (!this.phaseOk(story, "plan")) phase = "plan";
		else {
			for (const f of globMd(`${this.STORIES}/${story}/_tasks`)) {
				const id = taskIdOf(f);
				if (!complete(fm(contentLines(this.taskContent(story, id, this.claimRef(story, id))), "status"))) open++;
			}
			phase = open > 0 ? "build" : "done";
		}
		this.echo(`phase=${phase}`);
		if (phase === "build") this.echo(`open_tasks=${open}`);
		if (this.legacyStory(story)) this.echo(`approvals=missing run: work_state adopt-approvals ${story} (only if the user confirms its earlier gates passed)`);
	}

	// ── status tree ──

	private taskLine(story: string, file: string): string {
		const id = taskIdOf(file);
		const ref = this.claimRef(story, id);
		const content = this.taskContent(story, id, ref);
		const a = contentLines(content);
		const status = fm(a, "status");
		let mark: string;
		switch (status) {
			case "done":
			case "cancelled":
				mark = "[x]";
				break;
			case "blocked":
				mark = "[!]";
				break;
			case "in-progress":
			case "review":
				mark = "[~]";
				break;
			default:
				mark = ref ? "[~]" : "[ ]";
		}
		let extra = "";
		let work = "";
		if (status === "cancelled") extra = " cancelled";
		if (status === "review") extra = " review";
		if (ref) {
			work = this.claimWork(ref);
			extra += ` claimed: ${ref}`;
			if (work) extra += ` · work ${work}`;
			if (complete(status)) {
				if (work && this.git(["merge-base", "--is-ancestor", work, "HEAD"]).status === 0) extra += " · merged, release the lock";
				else extra += " · not yet merged";
			}
		}
		const chk = checklist(a);
		if (chk) extra += ` · checklist ${chk}`;
		if (!complete(status)) {
			const s = this.approvalState(story, id);
			if (s.state === "ok") extra += " · design ✓";
			else if (s.state === "stale") extra += " · design ✗ (changed since approval)";
			else extra += " · design ✗";
		}
		if (mark === "[~]" || mark === "[!]") {
			const wt = work ? this.worktreeOf(work) : "";
			if (wt && wt !== this.ROOT) extra += ` · worktree ${wt}`;
			const log = lastLog(a);
			if (log) extra += ` · last log: ${log}`;
		}
		return `    ${mark} ${id}${extra}`;
	}

	private groupMark(total: number, done: number, lines: string): string {
		if (total > 0 && done === total) return "[x]";
		if (/\[[x~!]\]/.test(lines)) return "[~]";
		return "[ ]";
	}

	/** The story's header and task lines, each line ending in a newline. */
	private storyBlock(story: string): string {
		let lines = "";
		for (const f of globMd(`${this.STORIES}/${story}/_tasks`)) lines += `${this.taskLine(story, f)}\n`;
		const all = lines.split("\n");
		const total = all.filter(l => l.startsWith("    [")).length;
		const done = all.filter(l => l.startsWith("    [x]")).length;
		return `  ${this.groupMark(total, done, lines)} story ${story}  ${done}/${total} tasks\n${lines}`;
	}

	private cmdStatus(only: string): void {
		this.resolve();
		if (!isDir(this.STORIES)) {
			this.echo(`no stories under ${this.STORIES}`);
			return;
		}
		if (only) {
			if (!isDir(`${this.STORIES}/${only}`)) this.die(`no story '${only}' under ${this.STORIES}`);
			this.out(this.storyBlock(only));
			return;
		}
		const stories = this.storyDirs(this.STORIES).map(baseName);
		const seen = new Set<string>();
		for (const s of stories) seen.add(this.storyEpic(s) || "_none");
		for (const e of seen) {
			let out = "";
			for (const s of stories) {
				if (this.storyEpic(s) !== (e === "_none" ? "" : e)) continue;
				out += `${chomp(this.storyBlock(s))}\n`;
			}
			const rows = out.split("\n");
			const n = rows.filter(l => /^ {2}\[.\] story /.test(l)).length;
			const d = rows.filter(l => l.startsWith("  [x] story ")).length;
			if (e === "_none") this.echo("(no epic)");
			else this.echo(`${this.groupMark(n, d, out)} epic ${e}  ${d}/${n} stories`);
			this.out(out);
		}
	}

	// ── migrate: the pre-dotpm layout into the store ──

	/** First "# " heading of FILE without a leading "Spec:"/"Epic:" label, else FALLBACK. */
	private headingOf(file: string, fallback: string): string {
		let h = "";
		if (isFile(file)) {
			const line = this.read(file).find(l => l.startsWith("# "));
			if (line !== undefined) h = line.slice(2).replace(new RegExp(`^(Spec|Epic|Story)[${WS}]*[:-][${WS}]*`), "");
		}
		return h || fallback;
	}

	/** Body of an old task file: frontmatter dropped, "## Subtasks" renamed, and the four sections present. */
	private oldTaskBody(a: string[]): string {
		const seen = new Set<string>();
		const b: string[] = [];
		let infm = false;
		a.forEach((raw, n) => {
			let l = raw;
			if (n === 0 && l === "---") {
				infm = true;
				return;
			}
			if (infm) {
				if (l === "---") infm = false;
				return;
			}
			if (new RegExp(`^## Subtasks[${WS}]*$`).test(l)) l = "## Checklist";
			const m = new RegExp(`^## (Design|Summary|Checklist|Log)[${WS}]*$`).exec(l);
			if (m) seen.add(m[1]);
			b.push(l);
		});
		const blank = new RegExp(`^[${WS}]*$`);
		let end = b.length;
		while (end > 0 && blank.test(b[end - 1])) end--;
		let start = 0;
		while (start < end && blank.test(b[start])) start++;
		const out = b.slice(start, end);
		for (const want of ["Design", "Summary", "Checklist", "Log"]) if (!seen.has(want)) out.push("", `## ${want}`);
		return emit(out);
	}

	private oldStatus(s: string): string {
		return s === "pending" || s === "" ? "todo" : s === "claimed" ? "in-progress" : s;
	}

	/** Old frontmatter list ("[a, b]" or a block list) as space-separated values. */
	private oldList(a: string[], key: string): string {
		if (a[0] !== "---") return "";
		const printed: string[] = [];
		let on = false;
		for (let n = 1; n < a.length; n++) {
			const l = a[n];
			if (l === "---") break;
			if (on && new RegExp(`^[${WS}]+-`).test(l)) {
				printed.push(l.replace(new RegExp(`^[${WS}]+-[${WS}]*`), ""));
				continue;
			}
			if (on) break;
			if (l.startsWith(`${key}:`)) {
				const v = l
					.slice(key.length + 1)
					.replace(new RegExp(`[${WS}]+#[\\s\\S]*$`), "")
					.replace(/[\][,]/g, " ");
				if (hasText(v)) {
					printed.push(v);
					break;
				}
				on = true;
			}
		}
		return printed
			.join(" ")
			.replace(/["']/g, "")
			.replace(new RegExp(`[${WS}]+`, "g"), " ")
			.replace(/^ /, "")
			.replace(/ $/, "");
	}

	/** Old task content: with a live claim, the work branch's worktree copy. */
	private oldTaskContent(story: string, id: string): string {
		const rel = `${stripPrefix(this.OLD_STORIES, `${this.ROOT}/`)}/${story}/tasks/${id}.md`;
		const ref = this.claimRef(story, id);
		if (ref) {
			const wt = this.worktreeOf(this.claimWork(ref));
			if (wt && isFile(`${wt}/${rel}`)) return chomp(readText(`${wt}/${rel}`));
		}
		return chomp(readText(`${this.ROOT}/${rel}`));
	}

	private migrateTask(story: string, old: string, migrateDeps: Map<string, string>): void {
		const id = taskIdOf(old);
		const a = contentLines(this.oldTaskContent(story, id));
		const status = this.oldStatus(fm(a, "status"));
		const deps = this.oldList(a, "depends_on");
		const refs = this.oldList(a, "design_refs").replace(/ /g, ", ");
		const owner = fm(a, "owner");
		const approved = fm(a, "design_approved");
		const file = `${this.STORIES}/${story}/_tasks/${id}.md`;
		this.writeTask(file, story, titleForId(id), status, [], this.oldTaskBody(a));
		// Dependencies point at task notes written in the same pass; add them after.
		if (deps) migrateDeps.set(id, deps);
		if (refs) this.cfPut(file, "design_refs", q(refs));
		if (owner) this.cfPut(file, "branch", q(owner));
		if (approved) {
			this.cfPut(file, "design_approved", q(approved));
			// Approvals made before descriptions and contracts were covered still hold when the design is unchanged.
			this.restampApproval(story, file);
		}
		this.projectAddTask(`${this.STORIES}/${story}/${story}.md`, this.link(file));
		if (this.STORE === "vault" && complete(status)) this.projectTick(`${this.STORIES}/${story}/${story}.md`, this.linkTarget(file), "x");
	}

	/** Rewrite the dependencies of migrated tasks as wikilinks. */
	private migrateDeps(story: string, migrateDeps: Map<string, string>): void {
		for (const [id, deps] of migrateDeps) {
			const file = `${this.STORIES}/${story}/_tasks/${id}.md`;
			let list = "";
			for (const dep of deps.split(new RegExp(`[${WS}]+`)).filter(Boolean)) {
				const df = `${this.STORIES}/${story}/_tasks/${dep}.md`;
				list += `\n  - ${q(isFile(df) ? this.link(df) : `[[${dep}]]`)}`;
			}
			this.fmPut(file, "dependencies", list);
		}
	}

	/** A story copied from the repo store still has bare wikilinks. Rewrite the ones that name its
	 * project note, its tasks, or its epic to the vault-path links `link` writes, and tick its
	 * finished tasks in the project note. */
	private vaultRelink(story: string): void {
		const dir = `${this.STORIES}/${story}`;
		if (!isFile(`${dir}/${story}.md`)) return;
		const map = new Map<string, string>();
		const epic = this.storyEpic(story);
		if (epic && isFile(`${this.EPICS}/${epic}/${epic}.md`)) map.set(epic, this.linkTarget(`${this.EPICS}/${epic}/${epic}.md`));
		const files = [`${dir}/${story}.md`, ...globMd(`${dir}/_tasks`)].filter(isFile);
		for (const f of files) map.set(baseName(f).replace(/\.md$/, ""), this.linkTarget(f));
		for (const f of files) {
			const out = this.read(f).map(line => {
				let res = "";
				let rest = line;
				for (let i = rest.indexOf("[["); i >= 0; i = rest.indexOf("[[")) {
					res += rest.slice(0, i + 2);
					rest = rest.slice(i + 2);
					const j = rest.indexOf("]]");
					if (j < 0) break;
					let inner = rest.slice(0, j);
					rest = rest.slice(j);
					const bar = inner.indexOf("|");
					const name = bar >= 0 ? inner.slice(0, bar) : inner;
					const target = map.get(name);
					if (target !== undefined) inner = target + (bar >= 0 ? inner.slice(bar) : "");
					res += inner;
				}
				return res + rest;
			});
			this.replace(f, emit(out));
		}
		for (const f of globMd(`${dir}/_tasks`)) {
			if (complete(fm(this.read(f), "status"))) this.projectTick(`${dir}/${story}.md`, this.linkTarget(f), "x");
		}
	}

	/** Copy the regular files under SRC to DEST, keeping modes and times; `skipTop` is pruned at SRC's top. */
	private copyTree(src: string, dest: string, skipTop = ""): void {
		const walk = (rel: string) => {
			for (const name of fs.readdirSync(`${src}/${rel}`.replace(/\/$/, ""))) {
				const r = rel ? `${rel}/${name}` : name;
				const st = fs.lstatSync(`${src}/${r}`);
				if (st.isDirectory()) {
					if (r !== skipTop) walk(r);
				} else if (st.isFile()) {
					fs.mkdirSync(dirName(`${dest}/${r}`), { recursive: true });
					fs.copyFileSync(`${src}/${r}`, `${dest}/${r}`);
					fs.chmodSync(`${dest}/${r}`, st.mode);
					fs.utimesSync(`${dest}/${r}`, st.atime, st.mtime);
				}
			}
		};
		walk("");
	}

	private migrateStory(story: string): void {
		const src = `${this.OLD_STORIES}/${story}`;
		const dest = `${this.STORIES}/${story}`;
		if (this.STORE === "repo") {
			if (!isDir(`${src}/tasks`)) return;
		} else if (exists(dest)) this.die(`${dest} already exists; move it aside before migrating ${story}`);
		// A claimed task's freshest note is in its work branch's worktree, not in this checkout, so a
		// story with live claims waits until they are released.
		const claims = chomp(this.git(["for-each-ref", "--format=%(refname:short)", `refs/heads/${NS}/${story}/*`, `refs/remotes/*/${NS}/${story}/*`]).stdout);
		if (claims) {
			this.echo(`skipped: ${story} has live claims (${claims.replace(/\n/g, " ")}); finish or release them, then migrate`);
			return;
		}
		if (this.STORE === "vault") {
			fs.mkdirSync(dest, { recursive: true });
			this.copyTree(src, dest, "tasks");
		}
		let epic = "";
		if (isFile(`${dest}/plan.md`)) {
			epic = fm(this.read(`${dest}/plan.md`), "epic");
			if (epic) {
				this.fmPut(`${dest}/plan.md`, "epic", "", true);
				this.stripEmptyFm(`${dest}/plan.md`);
			}
		}
		if (!epic && isFile(`${dest}/spec.md`)) epic = fm(this.read(`${dest}/spec.md`), "epic");
		epic = epic.replace(/[[\]"]/g, "").replace(/,.*/, "").replace(/^ */, "").replace(/ *$/, "");
		if (isDir(`${src}/tasks`) || isFile(`${dest}/plan.md`)) {
			const title = this.headingOf(`${dest}/spec.md`, story);
			if (epic) epic = this.linkTarget(`${this.EPICS}/${epic}/${epic}.md`);
			if (!isFile(`${dest}/${story}.md`)) this.writeProject(`${dest}/${story}.md`, title, epic, true);
			const deps = new Map<string, string>();
			for (const f of globMd(`${src}/tasks`)) this.migrateTask(story, f, deps);
			this.migrateDeps(story, deps);
		}
		if (this.STORE === "vault") {
			this.vaultRelink(story);
			fs.rmSync(src, { recursive: true, force: true });
			this.echo(`migrated: story ${story} → ${dest} (removed ${stripPrefix(src, `${this.ROOT}/`)} from the repository; commit the deletion)`);
		} else {
			fs.rmSync(`${src}/tasks`, { recursive: true, force: true });
			this.echo(`migrated: story ${story} → ${dest}/_tasks`);
		}
	}

	private migrateEpic(epic: string): void {
		const src = `${this.OLD_EPICS}/${epic}`;
		const dest = `${this.EPICS}/${epic}`;
		if (this.STORE === "vault") {
			if (exists(dest)) this.die(`${dest} already exists; move it aside before migrating epic ${epic}`);
			fs.mkdirSync(dest, { recursive: true });
			this.copyTree(src, dest);
		}
		if (!isFile(`${dest}/${epic}.md`)) this.writeProject(`${dest}/${epic}.md`, this.headingOf(`${dest}/epic.md`, epic), "", false);
		if (this.STORE === "vault") {
			fs.rmSync(src, { recursive: true, force: true });
			this.echo(`migrated: epic ${epic} → ${dest} (removed ${stripPrefix(src, `${this.ROOT}/`)} from the repository; commit the deletion)`);
		} else this.echo(`migrated: epic ${epic}`);
	}

	private cmdMigrate(only: string): void {
		this.resolve();
		let any = false;
		if (!only) {
			for (const d of globDirs(this.OLD_EPICS)) {
				const e = baseName(d);
				if (this.STORE === "repo" && isFile(`${this.EPICS}/${e}/${e}.md`)) continue;
				this.migrateEpic(e);
				any = true;
			}
		}
		for (const d of this.storyDirs(this.OLD_STORIES)) {
			const s = baseName(d);
			if (only && s !== only) continue;
			if (this.STORE === "repo" && !isDir(`${this.OLD_STORIES}/${s}/tasks`)) continue;
			this.migrateStory(s);
			any = true;
		}
		for (const d of [this.OLD_STORIES, this.OLD_EPICS]) {
			if (this.STORE === "vault" && isDir(d) && fs.readdirSync(d).length === 0) fs.rmdirSync(d);
		}
		if (!any) this.echo("nothing to migrate");
	}

	// ── configure / root / hint ──

	private cmdRoot(): void {
		this.resolve();
		this.echo(`store=${this.STORE}`);
		this.echo(`repo_root=${this.ROOT}`);
		this.echo(`stories_dir=${this.STORIES}`);
		this.echo(`epics_dir=${this.EPICS}`);
		this.echo(`configured=${this.CONFIGURED}`);
		this.echo(`source=${this.SOURCE}`);
		if (this.STORE === "vault") this.echo(`vault=${this.VAULT}`);
		if (this.NOTES) this.echo(`notes=${this.NOTES.replace(/; $/, "")}`);
	}

	private cmdConfigure(first: string, second: string): void {
		if (!first) this.die("usage: work_state configure STORIES_DIR [EPICS_DIR]");
		if (/["\\]/.test(first + second)) this.die("directory names may not contain quotes or backslashes");
		const s = normalizeDir(first);
		if (s === null) this.die(`use a relative path inside the repository: ${first}`);
		const e = normalizeDir(second || DEFAULT_EPICS);
		if (e === null) this.die(`use a relative path inside the repository: ${second}`);
		const root = this.repoRoot();
		if (!root) this.die("not inside a git repository");
		this.ROOT = root;
		const store = configGet("store", `${root}/${CONFIG}`);
		const folder = configGet("vaultFolder", `${root}/${CONFIG}`);
		let text = `{\n  "storiesDir": "${s}",\n  "epicsDir": "${e}"`;
		if (store) text += `,\n  "store": "${store}"`;
		if (folder) text += `,\n  "vaultFolder": "${folder}"`;
		text += "\n}\n";
		fs.writeFileSync(`${root}/${CONFIG}`, text);
		this.echo(`wrote ${CONFIG}: storiesDir=${s} epicsDir=${e}`);
	}

	/** The SessionStart context when claims exist ("" otherwise, and when the store can't be resolved). */
	hint(): string {
		const root = this.repoRoot();
		if (!root) return "";
		// Silent when the store can't be resolved: SessionStart must never complain.
		this.quiet = true;
		try {
			this.resolve();
		} catch (e) {
			if (e instanceof Exit) return "";
			throw e;
		} finally {
			this.quiet = false;
		}
		if (!isDir(this.STORIES)) return "";
		const branch = this.currentBranch();
		// Local claims only: SessionStart must stay fast and offline.
		const claims = chomp(this.git(["for-each-ref", "--format=%(refname:short)", `refs/heads/${NS}`]).stdout)
			.split("\n")
			.filter(Boolean);
		if (claims.length === 0) return "";
		const mine = claims.filter(c => this.claimWork(c) === branch).map(c => ` ${stripPrefix(c, `${NS}/`)}`).join("");
		const msg = mine
			? `Claimed task(s) with this checkout (${branch}) as their work branch:${mine}. Another session may still be working on them. If one is yours from a closed session, run /resume to restore its state; never continue it without that.`
			: `Tasks are claimed in this repository: ${claims.map(c => stripPrefix(c, `${NS}/`)).join(" ")}. Run /resume to see the state of each story.`;
		return `agent-skills: ${msg}`;
	}

	private cmdHint(): void {
		const text = this.hint();
		if (!text) return;
		const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').split("\n").join("\\n");
		this.echo(`{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "${escaped}"}}`);
	}

	// ── dispatcher ──

	private dispatch(argv: string[]): void {
		const [op = "", ...rest] = argv;
		const a = (i: number) => rest[i] ?? "";
		switch (op) {
			case "root":
				return this.cmdRoot();
			case "configure":
				return this.cmdConfigure(a(0), a(1));
			case "init-epic":
				return this.cmdInitEpic(a(0), a(1));
			case "init-story":
				return this.cmdInitStory(a(0), a(1), a(2));
			case "new-task":
				return this.cmdNewTask(rest);
			case "path":
				return this.cmdPath(a(0), a(1));
			case "field":
				return this.cmdField(a(0), a(1), a(2), a(3));
			case "set":
				return this.cmdSet(a(0), a(1), a(2));
			case "log":
				return this.cmdLog(a(0), a(1), a(2));
			case "next":
				return this.cmdNext(a(0));
			case "ready":
				return this.cmdReady(a(0));
			case "claim":
				return this.cmdClaim(a(0), a(1), a(2));
			case "release":
				return this.cmdRelease(a(0), a(1));
			case "status":
				return this.cmdStatus(a(0));
			case "brief":
				return this.cmdBrief(a(0), a(1));
			case "phase":
				return this.cmdPhase(a(0));
			case "approve":
				return this.cmdApprove(a(0), a(1), a(2));
			case "approved":
				return this.cmdApproved(a(0), a(1));
			case "approve-phase":
				return this.cmdApprovePhase(a(0), a(1));
			case "approved-phase":
				return this.cmdApprovedPhase(a(0), a(1));
			case "adopt-approvals":
				return this.cmdAdoptApprovals(a(0));
			case "cites":
				return this.cmdCites(a(0), a(1));
			case "migrate":
				return this.cmdMigrate(a(0));
			case "hint":
				return this.cmdHint();
			default:
				this.die(
					"usage: work_state {root|configure DIR [EPICS_DIR]|init-epic EPIC TITLE|init-story STORY TITLE [EPIC]|new-task STORY TITLE [DEP...]|path STORY [TASK]|field STORY TASK KEY VALUE|set STORY TASK STATUS|log STORY TASK TEXT|next [STORY]|ready STORY|claim STORY TASK [WORK]|release STORY TASK|status [STORY]|brief STORY TASK|phase STORY|approve STORY TASK [--allow-long]|approved STORY TASK|approve-phase STORY PHASE|approved-phase STORY PHASE|adopt-approvals STORY|cites STORY ID|migrate [STORY]|hint}",
				);
		}
	}
}

/** Run one work-state operation: `argv` is the op followed by its positional arguments. */
export async function runWorkState(argv: string[], opts: WorkStateOptions): Promise<WorkStateResult> {
	return new WorkState(opts.cwd, opts.env ?? process.env, opts.onWrite).run(argv);
}

/** The SessionStart hint (the text the bash `hint` op wraps in Claude hook JSON), or undefined when there is nothing to say. */
export function workStateHint(opts: Omit<WorkStateOptions, "onWrite">): string | undefined {
	try {
		return new WorkState(opts.cwd, opts.env ?? process.env).hint() || undefined;
	} catch {
		return undefined;
	}
}
