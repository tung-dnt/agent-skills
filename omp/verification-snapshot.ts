import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { loadPolicy, matchesGlob, validateCandidateInputs, type VerificationPolicy } from "./verification-policy.ts";

export interface CandidateSnapshot {
	readonly version: 1;
	readonly id: string;
	readonly repoRoot: string;
	readonly repoId: string;
	readonly head: string;
	readonly symbolicHead: string | null;
	readonly objectFormat: string;
	readonly indexTree: string;
	readonly inputTree: string;
	readonly refsDigest: string;
	readonly policyDigest: string;
	readonly indexDigest: string;
	readonly statusDigest: string;
	readonly changedPaths: readonly string[];
	readonly inputPaths: readonly string[];
	readonly refs: readonly { readonly name: string; readonly oid: string }[];
	readonly sourceObjectDirectory: string;
	readonly stateDirectory: string;
	readonly storageDirectory: string;
	readonly objectDirectory: string;
	readonly indexFile: string;
}

export interface CaptureOptions {
	readonly stateDirectory?: string;
}

interface GitLayout {
	readonly root: string;
	readonly gitDirectory: string;
	readonly commonDirectory: string;
	readonly indexFile: string;
	readonly objectDirectory: string;
}

interface CapturedTree {
	readonly head: string;
	readonly symbolicHead: string | null;
	readonly objectFormat: string;
	readonly indexTree: string;
	readonly inputTree: string;
	readonly refs: readonly { readonly name: string; readonly oid: string }[];
	readonly refsDigest: string;
	readonly indexDigest: string;
	readonly statusDigest: string;
	readonly changedPaths: readonly string[];
	readonly inputPaths: readonly string[];
}

export async function captureCandidate(root: string, policy: VerificationPolicy, options: CaptureOptions = {}): Promise<CandidateSnapshot> {
	const loadedPolicy = await loadPolicy(root);
	if (loadedPolicy.status !== "protected") throw new Error(loadedPolicy.status === "refused" ? `${loadedPolicy.code}: ${loadedPolicy.reason}` : "Repository has no approved verification policy.");
	if (JSON.stringify(policy) !== JSON.stringify(loadedPolicy.policy)) throw new Error("The supplied policy no longer matches the repository policy.");
	const layout = await resolveGitLayout(loadedPolicy.root);
	const stateDirectory = await prepareStateDirectory(options.stateDirectory);
	const storageDirectory = await mkdtemp(path.join(stateDirectory, "snapshot-"));
	await chmod(storageDirectory, 0o700);
	const objectDirectory = path.join(storageDirectory, "objects");
	await mkdir(objectDirectory, { mode: 0o700 });
	const privateIndex = path.join(storageDirectory, "candidate.index");
	try {
		const first = await captureTree(layout, privateIndex, objectDirectory);
		const secondIndex = path.join(storageDirectory, "candidate-confirm.index");
		const second = await captureTree(layout, secondIndex, objectDirectory);
		if (!sameCapture(first, second)) {
			const changedIdentities = (Object.keys(first) as (keyof CapturedTree)[]).filter((key) => JSON.stringify(first[key]) !== JSON.stringify(second[key]));
			throw new Error(`Source changed during candidate capture (${changedIdentities.join(", ")}); retry after the workspace is stable.`);
		}
		validateCandidateInputs(loadedPolicy.policy, first.inputPaths, first.changedPaths);
		await rejectIgnoredInputs(layout.root, loadedPolicy.policy);
		const repoId = await repositoryIdentity(layout.root);
		const identity = [repoId, first.head, first.symbolicHead ?? "", first.objectFormat, first.indexTree, first.inputTree, first.refsDigest, loadedPolicy.digest].join("\0");
		const id = createHash("sha256").update(identity).digest("hex");
		const snapshot: CandidateSnapshot = {
			version: 1,
			id,
			repoRoot: layout.root,
			repoId,
			head: first.head,
			symbolicHead: first.symbolicHead,
			objectFormat: first.objectFormat,
			indexTree: first.indexTree,
			inputTree: first.inputTree,
			refsDigest: first.refsDigest,
			policyDigest: loadedPolicy.digest,
			indexDigest: first.indexDigest,
			statusDigest: first.statusDigest,
			changedPaths: first.changedPaths,
			inputPaths: first.inputPaths,
			refs: first.refs,
			sourceObjectDirectory: layout.objectDirectory,
			stateDirectory,
			storageDirectory,
			objectDirectory,
			indexFile: privateIndex,
		};
		await writeFile(path.join(storageDirectory, "candidate.json"), JSON.stringify(snapshot), { mode: 0o600 });
		return snapshot;
	} catch (error) {
		await rm(storageDirectory, { recursive: true, force: true });
		throw error;
	}
}

export async function verifyCandidateFresh(candidate: CandidateSnapshot, policy?: VerificationPolicy): Promise<void> {
	const currentPolicy = await loadPolicy(candidate.repoRoot);
	if (currentPolicy.status !== "protected" || currentPolicy.digest !== candidate.policyDigest) throw new Error("Verification policy changed or was removed after approval.");
	if (policy && JSON.stringify(policy) !== JSON.stringify(currentPolicy.policy)) throw new Error("The supplied policy no longer matches the repository policy.");
	const current = await captureCandidate(candidate.repoRoot, currentPolicy.policy, { stateDirectory: candidate.stateDirectory });
	try {
		if (current.head !== candidate.head) throw new Error("HEAD changed after candidate approval.");
		if (current.refsDigest !== candidate.refsDigest) throw new Error("Git refs changed after candidate approval.");
		if (current.indexTree !== candidate.indexTree || current.indexDigest !== candidate.indexDigest) throw new Error("The Git index changed after candidate approval.");
		if (
			current.id !== candidate.id ||
			current.symbolicHead !== candidate.symbolicHead ||
			current.objectFormat !== candidate.objectFormat ||
			current.statusDigest !== candidate.statusDigest ||
			JSON.stringify(current.changedPaths) !== JSON.stringify(candidate.changedPaths) ||
			JSON.stringify(current.inputPaths) !== JSON.stringify(candidate.inputPaths)
		) throw new Error("The working-tree candidate changed after approval.");
	} finally {
		await removeCandidate(current);
	}
}
export async function loadCandidateSnapshot(stateDirectory: string, snapshotRef: string): Promise<CandidateSnapshot> {
	if (!/^snapshot-[A-Za-z0-9-]{1,128}$/.test(snapshotRef)) throw new Error("Invalid private candidate reference.");
	const stateRoot = await realpath(stateDirectory);
	const storageDirectory = await realpath(path.join(stateRoot, snapshotRef));
	if (path.dirname(storageDirectory) !== stateRoot || path.basename(storageDirectory) !== snapshotRef) throw new Error("Candidate snapshot path escapes private verification state.");
	const candidateFile = await realpath(path.join(storageDirectory, "candidate.json"));
	if (!isWithin(storageDirectory, candidateFile)) throw new Error("Candidate metadata resolves outside its private snapshot.");
	const value: unknown = JSON.parse(await readFile(candidateFile, "utf8"));
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Candidate metadata is not an object.");
	const candidate = value as unknown as CandidateSnapshot;
	if (
		candidate.version !== 1 ||
		candidate.stateDirectory !== stateRoot ||
		candidate.storageDirectory !== storageDirectory ||
		candidate.objectDirectory !== path.join(storageDirectory, "objects") ||
		candidate.indexFile !== path.join(storageDirectory, "candidate.index") ||
		!/^([a-f0-9]{64})$/.test(candidate.id) ||
		!/^([a-f0-9]{64})$/.test(candidate.repoId) ||
		!/^([a-f0-9]{64})$/.test(candidate.policyDigest) ||
		!Array.isArray(candidate.changedPaths) ||
		!candidate.changedPaths.every((file) => typeof file === "string") ||
		!Array.isArray(candidate.inputPaths) ||
		!candidate.inputPaths.every((file) => typeof file === "string") ||
		!Array.isArray(candidate.refs) ||
		!candidate.refs.every((ref) => typeof ref.name === "string" && typeof ref.oid === "string")
	) throw new Error("Candidate metadata failed identity validation.");
	return candidate;
}

export async function removeCandidate(candidate: CandidateSnapshot): Promise<void> {
	const stateRoot = await realpath(candidate.stateDirectory);
	const storage = await realpath(candidate.storageDirectory);
	if (path.dirname(storage) !== stateRoot || !path.basename(storage).startsWith("snapshot-")) throw new Error("Refusing to remove a candidate outside its private verification state directory.");
	const marker = JSON.parse(await readFile(path.join(storage, "candidate.json"), "utf8")) as { id?: unknown; repoId?: unknown; version?: unknown };
	if (marker.version !== 1 || marker.id !== candidate.id || marker.repoId !== candidate.repoId) throw new Error("Candidate snapshot ownership record does not match.");
	await rm(storage, { recursive: true, force: true });
}

export async function resolveGitLayout(root: string): Promise<GitLayout> {
	const canonicalRoot = await realpath(root);
	const topLevel = git(canonicalRoot, ["rev-parse", "--show-toplevel"]).trim();
	const realTopLevel = await realpath(topLevel);
	if (realTopLevel !== canonicalRoot) throw new Error("Verification root must be the real Git repository root.");
	const gitDirectory = await realpath(git(canonicalRoot, ["rev-parse", "--absolute-git-dir"]).trim());
	const commonPath = git(canonicalRoot, ["rev-parse", "--git-common-dir"]).trim();
	const commonDirectory = await realpath(path.resolve(canonicalRoot, commonPath));
	const indexFile = path.resolve(canonicalRoot, git(canonicalRoot, ["rev-parse", "--git-path", "index"]).trim());
	const objectPath = git(canonicalRoot, ["rev-parse", "--git-path", "objects"]).trim();
	const objectDirectory = await realpath(path.resolve(canonicalRoot, objectPath));
	return { root: realTopLevel, gitDirectory, commonDirectory, indexFile, objectDirectory };
}
export async function repositoryIdentity(root: string): Promise<string> {
	return createHash("sha256").update(await realpath(root)).digest("hex");
}

export function defaultVerificationStateDirectory(): string {
	const configured = process.env.XDG_STATE_HOME;
	const stateHome = configured && path.isAbsolute(configured) ? configured : path.join(homedir(), ".local", "state");
	return path.join(stateHome, "agent-skills", "verification");
}

export function git(cwd: string, args: readonly string[], env = process.env): string {
	const stableEnvironment = { ...env, GIT_OPTIONAL_LOCKS: "0" };
	try {
		return execFileSync("git", [...args], { cwd, env: stableEnvironment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch (error) {
		const details = error instanceof Error ? error.message : String(error);
		throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${details}`);
	}
}

export async function candidateTreeInWorkspace(
	root: string,
	environment: Record<string, string | undefined>,
	excludedPatterns: readonly string[] = [],
): Promise<string> {
	const indexPath = environment.GIT_INDEX_FILE;
	if (!indexPath) throw new Error("Execution workspace has no private Git index.");
	const copy = `${indexPath}.integrity-${randomUUID()}`;
	await copyFile(indexPath, copy);
	try {
		const env = { ...environment, GIT_INDEX_FILE: copy, GIT_OPTIONAL_LOCKS: "0" };
		const exclusions = excludedPatterns.map((pattern) => `:(exclude,glob)${pattern}`);
		git(root, ["add", "-A", "--", ".", ...exclusions], env);
		return git(root, ["write-tree"], env).trim();
	} finally {
		await rm(copy, { force: true });
		await rm(`${copy}.lock`, { force: true });
	}
}

async function captureTree(layout: GitLayout, privateIndex: string, objectDirectory: string): Promise<CapturedTree> {
	const head = git(layout.root, ["rev-parse", "--verify", "HEAD"]).trim();
	const symbolic = gitAllowFailure(layout.root, ["symbolic-ref", "-q", "HEAD"]);
	const symbolicHead = symbolic.code === 0 ? symbolic.stdout.trim() : null;
	const objectFormat = git(layout.root, ["rev-parse", "--show-object-format"]).trim();
	if (objectFormat !== "sha1" && objectFormat !== "sha256") throw new Error(`Unsupported Git object format: ${objectFormat}`);
	const beforeIndex = await digestFile(layout.indexFile);
	if (await exists(`${layout.indexFile}.lock`)) throw new Error("The Git index is locked by another operation.");
	const beforeStatus = git(layout.root, ["status", "--porcelain=v2", "--untracked-files=all", "--ignore-submodules=none"]);
	const refs = readRefs(layout.root);
	const refsDigest = digestText(refs.map(({ name, oid }) => `${name} ${oid}`).join("\n"));
	const env = privateObjectEnvironment(objectDirectory, layout.objectDirectory, privateIndex);
	await rm(privateIndex, { force: true });
	if (await exists(layout.indexFile)) await copyFile(layout.indexFile, privateIndex);
	else git(layout.root, ["read-tree", head], env);
	assertSupportedIndex(layout, privateIndex, objectDirectory);
	git(layout.root, ["update-index", "--no-split-index"], env);
	if (git(layout.root, ["ls-files", "--unmerged", "-z"], env).length > 0) throw new Error("Git index contains unresolved merge conflicts.");
	await rejectUnsupportedEntries(layout, privateIndex, objectDirectory);
	const indexTree = git(layout.root, ["write-tree"], env).trim();
	const stagedChangedPaths = parseNulPaths(git(layout.root, ["diff", "--cached", "--name-only", "--no-renames", "-z", head], env));
	// Rebuild from staged blobs, not copied stat caches: unchanged metadata must
	// never conceal different working bytes, even after clearing index flags.
	await rm(privateIndex, { force: true });
	git(layout.root, ["read-tree", indexTree], env);
	git(layout.root, ["add", "-A", "--", "."], env);
	await rejectUnsupportedEntries(layout, privateIndex, objectDirectory);
	const inputTree = git(layout.root, ["write-tree"], env).trim();
	const inputChangedPaths = parseNulPaths(git(layout.root, ["diff", "--cached", "--name-only", "--no-renames", "-z", head], env));
	const changedPaths = [...new Set([...stagedChangedPaths, ...inputChangedPaths])].sort();
	const inputPaths = parseNulPaths(git(layout.root, ["ls-files", "-z"], env));
	const afterIndex = await digestFile(layout.indexFile);
	const afterStatus = git(layout.root, ["status", "--porcelain=v2", "--untracked-files=all", "--ignore-submodules=none"]);
	const afterHead = git(layout.root, ["rev-parse", "--verify", "HEAD"]).trim();
	const afterRefs = readRefs(layout.root);
	const afterRefsDigest = digestText(afterRefs.map(({ name, oid }) => `${name} ${oid}`).join("\n"));
	if (head !== afterHead || beforeIndex !== afterIndex || beforeStatus !== afterStatus || refsDigest !== afterRefsDigest) {
		throw new Error("HEAD, index, refs, or worktree changed during candidate capture.");
	}
	return {
		head,
		symbolicHead,
		objectFormat,
		indexTree,
		inputTree,
		refs,
		refsDigest,
		indexDigest: beforeIndex,
		statusDigest: digestText(beforeStatus),
		changedPaths,
		inputPaths,
	};
}

async function rejectIgnoredInputs(root: string, policy: VerificationPolicy): Promise<void> {
	const ignored = parseNulPaths(git(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]));
	for (const file of ignored) {
		const kinds = new Set(policy.classifications.filter((rule) => matchesGlob(rule.pattern, file)).map((rule) => rule.kind));
		if (kinds.size === 0) throw new Error(`Ignored candidate path is unclassified by policy: ${file}`);
		if (kinds.size > 1) throw new Error(`Ignored candidate path has ambiguous classifications: ${file}`);
		if ([...kinds][0] !== "excluded") throw new Error(`Ignored source-like input is not included in the candidate: ${file}`);
	}
}

function assertSupportedIndex(layout: GitLayout, indexFile: string, objectDirectory: string): void {
	const env = privateObjectEnvironment(objectDirectory, layout.objectDirectory, indexFile);
	const sparseEntries = git(layout.root, ["ls-files", "--sparse", "--stage", "-z"], env).split("\0").filter(Boolean);
	for (const entry of sparseEntries) {
		const tab = entry.indexOf("\t");
		if (tab < 0) throw new Error("Git returned an invalid sparse-index stage entry.");
		const [mode] = entry.slice(0, tab).split(" ");
		if (mode === "040000") throw new Error(`Sparse-index directory entries are unsupported verification inputs: ${entry.slice(tab + 1)}`);
	}

	const flags = git(layout.root, ["ls-files", "-v", "-z"], env).split("\0").filter(Boolean);
	for (const entry of flags) {
		const separator = entry.indexOf(" ");
		if (separator !== 1) throw new Error("Git returned an invalid index flag entry.");
		const tag = entry[0];
		const file = entry.slice(2);
		if (tag?.toUpperCase() === "S") throw new Error(`Git index contains a skip-worktree entry unsupported for verification: ${file}`);
	}
}

async function rejectUnsupportedEntries(layout: GitLayout, indexFile: string, objectDirectory: string): Promise<void> {
	const env = privateObjectEnvironment(objectDirectory, layout.objectDirectory, indexFile);
	const entries = git(layout.root, ["ls-files", "--stage", "-z"], env).split("\0").filter(Boolean);
	for (const entry of entries) {
		const tab = entry.indexOf("\t");
		if (tab < 0) throw new Error("Git returned an invalid stage entry.");
		const [mode, oid, stage] = entry.slice(0, tab).split(" ");
		const file = entry.slice(tab + 1);
		if (stage !== "0") throw new Error(`Candidate index contains unresolved stage data: ${file}`);
		if (mode === "160000") throw new Error(`Git submodules are unsupported verification inputs: ${file}`);
		if (mode !== "120000") continue;
		const target = git(layout.root, ["cat-file", "blob", oid ?? ""], env);
		if (path.isAbsolute(target)) throw new Error(`Absolute symlink targets are unsupported verification inputs: ${file}`);
		const resolved = path.resolve(layout.root, path.dirname(file), target);
		if (!isWithin(layout.root, resolved)) throw new Error(`Symlink escapes the repository: ${file}`);
		try {
			const physicalTarget = await realpath(resolved);
			if (!isWithin(layout.root, physicalTarget)) throw new Error(`Symlink resolves outside the repository: ${file}`);
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("Symlink resolves outside")) throw error;
			throw new Error(`Broken symlinks are unsupported verification inputs: ${file}`);
		}
	}
}

async function prepareStateDirectory(requested?: string): Promise<string> {
	const directory = path.resolve(requested ?? defaultVerificationStateDirectory());
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const details = await lstat(directory);
	if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("Verification state directory must be a real directory.");
	await chmod(directory, 0o700);
	return await realpath(directory);
}

function privateObjectEnvironment(objectDirectory: string, alternate: string, indexFile: string) {
	return {
		...process.env,
		GIT_INDEX_FILE: indexFile,
		GIT_OBJECT_DIRECTORY: objectDirectory,
		GIT_ALTERNATE_OBJECT_DIRECTORIES: alternate,
		GIT_OPTIONAL_LOCKS: "0",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "core.splitIndex",
		GIT_CONFIG_VALUE_0: "false",
		GIT_TERMINAL_PROMPT: "0",
	};
}

function readRefs(root: string): readonly { name: string; oid: string }[] {
	const output = git(root, ["for-each-ref", "--format=%(refname) %(objectname)"]);
	return output.split("\n").filter(Boolean).map((line) => {
		const separator = line.indexOf(" ");
		return { name: line.slice(0, separator), oid: line.slice(separator + 1) };
	});
}

function gitAllowFailure(cwd: string, args: readonly string[]): { readonly code: number; readonly stdout: string } {
	try {
		return { code: 0, stdout: execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }) };
	} catch (error) {
		const code = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 1;
		return { code, stdout: "" };
	}
}

async function digestFile(file: string): Promise<string> {
	try {
		return createHash("sha256").update(await readFile(file)).digest("hex");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return digestText("missing-index");
		throw error;
	}
}

function digestText(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function parseNulPaths(value: string): string[] {
	return value.split("\0").filter(Boolean).map((file) => file.replaceAll("\\", "/"));
}

function sameCapture(left: CapturedTree, right: CapturedTree): boolean {
	return left.head === right.head && left.symbolicHead === right.symbolicHead && left.objectFormat === right.objectFormat && left.indexTree === right.indexTree && left.inputTree === right.inputTree && left.refsDigest === right.refsDigest && left.indexDigest === right.indexDigest && left.statusDigest === right.statusDigest && JSON.stringify(left.changedPaths) === JSON.stringify(right.changedPaths) && JSON.stringify(left.inputPaths) === JSON.stringify(right.inputPaths);
}

async function exists(file: string): Promise<boolean> {
	try {
		await lstat(file);
		return true;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
