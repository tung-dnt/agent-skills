import { createHash } from "node:crypto";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { lstatSync, watch as watchFs } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { candidateTreeInWorkspace, git, verifyCandidateFresh, type CandidateSnapshot } from "./verification-snapshot.ts";
import { loadPolicy, matchesGlob, type VerificationPolicy } from "./verification-policy.ts";

export interface MaterializeOptions {
	readonly preparationIds?: readonly string[];
}

export interface ExecutionWorkspace {
	readonly root: string;
	readonly storageDirectory: string;
	readonly gitDirectory: string;
	readonly candidate: CandidateSnapshot;
	readonly policy: VerificationPolicy;
	readonly profile: string;
	readonly environment: Record<string, string | undefined>;
	verifyInputsUnchanged(): Promise<void>;
	cleanup(): Promise<void>;
}

export interface WorkspaceMutationWatch {
	finish(): Promise<string | undefined>;
}

export function watchWorkspaceMutations(
	root: string,
	allowedOutputPatterns: readonly string[],
	policy: VerificationPolicy,
): WorkspaceMutationWatch {
	const watcher = watchFs(root, { recursive: true });
	const outputPatterns = excludedOutputPatterns(policy, allowedOutputPatterns);
	let violation: string | undefined;
	let finishPromise: Promise<string | undefined> | undefined;
	watcher.on("change", (_event: string, filename: string | Uint8Array | null) => {
		if (filename === null) {
			violation ??= "unknown-path";
			return;
		}
		const relative = path.relative(root, path.resolve(root, filename.toString())).split(path.sep).join("/");
		const hasLineTerminator = relative.includes("\n") || relative.includes("\r") || relative.includes("\u2028") || relative.includes("\u2029");
		if (
			hasLineTerminator ||
			relative === ".." ||
			relative.startsWith("../") ||
			path.isAbsolute(relative) ||
			relative === ".git" ||
			relative.startsWith(".git/") ||
			!isAllowedOutputEvent(relative, outputPatterns, policy, root)
		) violation ??= relative;
	});
	watcher.on("error", () => {
		violation ??= "watch-error";
	});
	return {
		finish() {
			if (!finishPromise) {
				finishPromise = (async () => {
					await waitForImmediate();
					// A finish requested inside a poll callback must not close the
					// observer in that same turn's check phase before pending I/O.
					await waitForImmediate();
					watcher.close();
					return violation;
				})();
			}
			return finishPromise;
		},
	};
}

export async function materialize(
	candidate: CandidateSnapshot,
	profile: string,
	options: MaterializeOptions = {},
): Promise<ExecutionWorkspace> {
	await verifyCandidateFresh(candidate);
	const policyResult = await loadPolicy(candidate.repoRoot);
	if (policyResult.status !== "protected" || policyResult.digest !== candidate.policyDigest) throw new Error("Verification policy changed before workspace preparation.");
	const minimumProfileIndex = policyResult.policy.profiles.findIndex((entry) => entry.id === policyResult.policy.minimumProfile);
	const selectedProfileIndex = policyResult.policy.profiles.findIndex((entry) => entry.id === profile);
	if (selectedProfileIndex < minimumProfileIndex) throw new Error(`Profile ${profile} is weaker than repository minimum ${policyResult.policy.minimumProfile}.`);
	const outputPatterns = getOutputPatterns(policyResult.policy, options.preparationIds ?? []);
	const integrityOutputPatterns = excludedOutputPatterns(policyResult.policy, outputPatterns);
	for (const file of candidate.inputPaths) {
		if (outputPatterns.some((pattern) => matchesGlob(pattern, file))) throw new Error(`Preparation output overlaps a candidate input: ${file}`);
	}
	const stateDirectory = await realpath(candidate.stateDirectory);
	const storageDirectory = await mkdtemp(path.join(stateDirectory, "workspace-"));
	const root = path.join(storageDirectory, "worktree");
	const gitDirectory = path.join(root, ".git");
	try {
		await mkdir(root, { recursive: false, mode: 0o700 });
		await writeFile(path.join(storageDirectory, "owner.json"), JSON.stringify({ version: 1, candidateId: candidate.id }), { mode: 0o600 });
		git(candidate.repoRoot, ["init", "--quiet", `--object-format=${candidate.objectFormat}`, root], cleanGitEnvironment());
		const objects = path.join(gitDirectory, "objects");
		await mkdir(path.join(objects, "info"), { recursive: true });
		await writeFile(path.join(objects, "info", "alternates"), `${candidate.objectDirectory}\n${candidate.sourceObjectDirectory}\n`, { mode: 0o600 });
		const environment = executionEnvironment(root, gitDirectory, objects, candidate);
		for (const ref of candidate.refs) git(root, ["update-ref", ref.name, ref.oid], environment);
		if (candidate.symbolicHead) git(root, ["symbolic-ref", "HEAD", candidate.symbolicHead], environment);
		else await writeFile(path.join(gitDirectory, "HEAD"), `${candidate.head}\n`);
		git(root, ["config", "core.bare", "false"], environment);
		git(root, ["config", "core.worktree", root], environment);
		git(root, ["read-tree", candidate.inputTree], environment);
		git(root, ["checkout-index", "--all", "--force"], environment);
		git(root, ["read-tree", candidate.indexTree], environment);
		const workspace: ExecutionWorkspace = {
			root,
			storageDirectory,
			gitDirectory,
			candidate,
			policy: policyResult.policy,
			profile,
			environment,
			async verifyInputsUnchanged() {
				const head = git(root, ["rev-parse", "--verify", "HEAD"], environment).trim();
				const symbolic = gitAllowFailure(root, ["symbolic-ref", "-q", "HEAD"], environment);
				const symbolicHead = symbolic.code === 0 ? symbolic.stdout.trim() : null;
				const indexTree = git(root, ["write-tree"], environment).trim();
				const refsDigest = digestRefs(git(root, ["for-each-ref", "--format=%(refname) %(objectname)"], environment));
				const inputTree = await candidateTreeInWorkspace(root, environment, integrityOutputPatterns);
				assertIntegrityOutputPathsSupported(root, environment, integrityOutputPatterns);
				if (head !== candidate.head || symbolicHead !== candidate.symbolicHead || refsDigest !== candidate.refsDigest || indexTree !== candidate.indexTree || inputTree !== candidate.inputTree) {
					throw new Error("Preparation or check changed the approved Git input, index, HEAD, or refs.");
				}
			},
			async cleanup() {
				const marker = JSON.parse(await readFile(path.join(storageDirectory, "owner.json"), "utf8")) as { version?: unknown; candidateId?: unknown };
				if (marker.version !== 1 || marker.candidateId !== candidate.id || path.dirname(storageDirectory) !== stateDirectory) {
					throw new Error("Refusing to remove an execution workspace without matching ownership evidence.");
				}
				await rm(storageDirectory, { recursive: true, force: true });
			},
		};
		await workspace.verifyInputsUnchanged();
		return workspace;
	} catch (error) {
		await rm(storageDirectory, { recursive: true, force: true });
		throw error;
	}
}


export function getOutputPatterns(policy: VerificationPolicy, preparationIds: readonly string[]): readonly string[] {
	const outputs = new Set<string>();
	for (const id of preparationIds) {
		const preparation = policy.preparations[id];
		if (!preparation) throw new Error(`Unknown preparation: ${id}`);
		for (const pattern of preparation.outputs) outputs.add(pattern);
	}
	return [...outputs].sort();
}

function isAllowedOutputEvent(
	relative: string,
	patterns: readonly string[],
	policy: VerificationPolicy,
	root: string,
): boolean {
	for (const pattern of patterns) if (matchesGlob(pattern, relative)) return true;
	if (relative.includes("*") || relative.includes("?")) return false;
	let isOutputDirectory = false;
	for (const pattern of patterns) {
		if (pattern.startsWith(`${relative}/`)) {
			isOutputDirectory = true;
			break;
		}
	}
	if (!isOutputDirectory || !isExclusivelyExcludedPattern(policy, `${relative}/**`)) return false;
	try {
		return lstatSync(path.resolve(root, relative)).isDirectory();
	} catch {
		return false;
	}
}

function excludedOutputPatterns(policy: VerificationPolicy, patterns: readonly string[]): readonly string[] {
	const excluded: string[] = [];
	for (const pattern of patterns) {
		if (isIntegrityGlobCompatible(pattern) && isExclusivelyExcludedPattern(policy, pattern)) excluded.push(pattern);
	}
	return excluded;
}

function isExclusivelyExcludedPattern(policy: VerificationPolicy, pattern: string): boolean {
	let hasExcludedCover = false;
	for (const rule of policy.classifications) {
		if (rule.kind === "excluded" && globIsSubset(pattern, rule.pattern)) {
			hasExcludedCover = true;
			break;
		}
	}
	if (!hasExcludedCover) return false;
	for (const rule of policy.classifications) {
		if (rule.kind !== "excluded" && globPatternsIntersect(pattern, rule.pattern)) return false;
	}
	return true;
}


function assertIntegrityOutputPathsSupported(
	root: string,
	environment: Record<string, string | undefined>,
	patterns: readonly string[],
): void {
	if (patterns.length === 0) return;
	const pathspecs = patterns.map((pattern) => `:(glob)${pattern}`);
	const paths = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...pathspecs], environment).split("\0");
	for (const file of paths) {
		if (
			file.includes("\n") ||
			file.includes("\r") ||
			file.includes("\u2028") ||
			file.includes("\u2029")
		) throw new Error(`Preparation output path contains an unsupported line separator: ${file}`);
	}
}

function isIntegrityGlobCompatible(pattern: string): boolean {
	if (
		pattern.includes("\n") ||
		pattern.includes("\r") ||
		pattern.includes("\u2028") ||
		pattern.includes("\u2029") ||
		pattern.startsWith("/") ||
		pattern.endsWith("/") ||
		pattern.includes("//")
	) return false;
	if (!pattern.includes("*") && !pattern.includes("?")) return !pattern.includes("[") && !pattern.includes("]");
	if (!pattern.endsWith("/**")) return false;
	const prefix = pattern.slice(0, -3);
	return prefix.length > 0 &&
		!prefix.includes("*") &&
		!prefix.includes("?") &&
		!prefix.includes("[") &&
		!prefix.includes("]");
}

// The automaton mirrors matchesGlob's UTF-16 glob body; line-terminator paths are refused at both proof boundaries.


type GlobToken =
	| { readonly kind: "literal"; readonly value: string }
	| { readonly kind: "question" | "star" | "globstar" | "globstar-directory-start" | "globstar-directory-body" };

function globIsSubset(candidate: string, container: string): boolean {
	const candidateTokens = globTokens(candidate);
	const containerTokens = globTokens(container);
	return everyGlobMatch(candidateTokens, containerTokens, (candidateAccepts, containerAccepts) => candidateAccepts && !containerAccepts);
}

function globPatternsIntersect(left: string, right: string): boolean {
	const leftTokens = globTokens(left);
	const rightTokens = globTokens(right);
	return everyGlobMatch(leftTokens, rightTokens, (leftAccepts, rightAccepts) => leftAccepts && rightAccepts, true);
}

function everyGlobMatch(
	left: readonly GlobToken[],
	right: readonly GlobToken[],
	isCounterexample: (leftAccepts: boolean, rightAccepts: boolean) => boolean,
	stopOnMatch = false,
): boolean {
	const alphabet = globAlphabet(left, right);
	const leftStart = epsilonClosure(left, [0]);
	const rightStart = epsilonClosure(right, [0]);
	const queue: { readonly left: readonly number[]; readonly right: readonly number[] }[] = [{ left: leftStart, right: rightStart }];
	const visited = new Set<string>();
	for (let cursor = 0; cursor < queue.length; cursor += 1) {
		const state = queue[cursor];
		if (!state) continue;
		const key = `${state.left.join(",")}|${state.right.join(",")}`;
		if (visited.has(key)) continue;
		visited.add(key);
		if (visited.size > 20_000) return stopOnMatch;
		const leftAccepts = state.left.includes(left.length);
		const rightAccepts = state.right.includes(right.length);
		if (isCounterexample(leftAccepts, rightAccepts)) return stopOnMatch ? true : false;
		for (const character of alphabet) {
			const nextLeft = globTransition(left, state.left, character);
			if (nextLeft.length === 0) continue;
			const nextRight = globTransition(right, state.right, character);
			if (stopOnMatch && nextRight.length === 0) continue;
			queue.push({ left: nextLeft, right: nextRight });
		}
	}
	return stopOnMatch ? false : true;
}

function globTokens(pattern: string): GlobToken[] {
	const tokens: GlobToken[] = [];
	for (let index = 0; index < pattern.length; index += 1) {
		const character = pattern[index];
		if (character === "*" && pattern[index + 1] === "*") {
			index += 1;
			if (pattern[index + 1] === "/") {
				index += 1;
				tokens.push({ kind: "globstar-directory-start" }, { kind: "globstar-directory-body" });
			} else tokens.push({ kind: "globstar" });
		} else if (character === "*") tokens.push({ kind: "star" });
		else if (character === "?") tokens.push({ kind: "question" });
		else tokens.push({ kind: "literal", value: character ?? "" });
	}
	return tokens;
}

function globAlphabet(left: readonly GlobToken[], right: readonly GlobToken[]): readonly string[] {
	const characters = new Set<string>(["/", "\n", "\r", "\u2028", "\u2029"]);
	for (const token of left) if (token.kind === "literal") characters.add(token.value);
	for (const token of right) if (token.kind === "literal") characters.add(token.value);
	let other = "\uE000";
	while (characters.has(other)) other = String.fromCharCode(other.charCodeAt(0) + 1);
	characters.add(other);
	return [...characters];
}

// The optional `**/` branch can skip only before consuming; its body can exit only on `/`.
function epsilonClosure(tokens: readonly GlobToken[], input: readonly number[]): number[] {
	const states = new Set(input);
	const pending = [...input];
	for (let cursor = 0; cursor < pending.length; cursor += 1) {
		const state = pending[cursor];
		if (state === undefined) continue;
		const token = tokens[state];
		if (!token) continue;
		if (token.kind === "globstar-directory-start" && !states.has(state + 2)) {
			states.add(state + 2);
			pending.push(state + 2);
		} else if (
			(token.kind === "star" || token.kind === "globstar") &&
			!states.has(state + 1)
		) {
			states.add(state + 1);
			pending.push(state + 1);
		}
	}
	return [...states].sort((left, right) => left - right);
}

function globTransition(tokens: readonly GlobToken[], states: readonly number[], character: string): number[] {
	const next = new Set<number>();
	for (const state of states) {
		const token = tokens[state];
		if (!token) continue;
		if (token.kind === "literal" && token.value === character) next.add(state + 1);
		else if (token.kind === "question" && character !== "/") next.add(state + 1);
		else if (token.kind === "star" && character !== "/") next.add(state);
		else if (token.kind === "globstar" && !isLineTerminator(character)) next.add(state);
		else if (token.kind === "globstar-directory-start" && !isLineTerminator(character)) {
			next.add(state + 1);
			if (character === "/") next.add(state + 2);
		} else if (token.kind === "globstar-directory-body" && !isLineTerminator(character)) {
			next.add(state);
			if (character === "/") next.add(state + 1);
		}
	}
	return epsilonClosure(tokens, [...next]);
}


function isLineTerminator(character: string): boolean {
	return character === "\n" || character === "\r" || character === "\u2028" || character === "\u2029";
}

function executionEnvironment(root: string, gitDirectory: string, objectDirectory: string, candidate: CandidateSnapshot): Record<string, string | undefined> {
	const environment = cleanGitEnvironment();
	return {
		...environment,
		GIT_DIR: gitDirectory,
		GIT_WORK_TREE: root,
		GIT_INDEX_FILE: path.join(gitDirectory, "index"),
		GIT_OBJECT_DIRECTORY: objectDirectory,
		GIT_ALTERNATE_OBJECT_DIRECTORIES: `${candidate.objectDirectory}${path.delimiter}${candidate.sourceObjectDirectory}`,
		GIT_OPTIONAL_LOCKS: "0",
	};
}

function cleanGitEnvironment(): Record<string, string | undefined> {
	const environment: Record<string, string | undefined> = { ...process.env };
	delete environment.GIT_DIR;
	delete environment.GIT_WORK_TREE;
	delete environment.GIT_INDEX_FILE;
	delete environment.GIT_OBJECT_DIRECTORY;
	delete environment.GIT_ALTERNATE_OBJECT_DIRECTORIES;
	delete environment.GIT_COMMON_DIR;
	delete environment.GIT_CEILING_DIRECTORIES;
	delete environment.GIT_PREFIX;
	environment.GIT_OPTIONAL_LOCKS = "0";
	environment.GIT_TERMINAL_PROMPT = "0";
	return environment;
}

function digestRefs(refs: string): string {
	return createHash("sha256").update(refs.trimEnd()).digest("hex");
}

function gitAllowFailure(cwd: string, args: readonly string[], environment: Record<string, string | undefined>): { readonly code: number; readonly stdout: string } {
	try {
		return { code: 0, stdout: execFileSync("git", [...args], { cwd, env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) };
	} catch (error) {
		const code = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 1;
		return { code, stdout: "" };
	}
}
