import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, readFile, rm, symlink, unlink, utimes } from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { captureCandidate, removeCandidate, verifyCandidateFresh, type CandidateSnapshot } from "./verification-snapshot.ts";
import { parsePolicy, requiredChecks } from "./verification-policy.ts";
import { createGitRepo, dispose, git, testPolicy, writeRepoFile } from "./verification-test-helpers.ts";

async function sha256(file: string): Promise<string> {
	return createHash("sha256").update(await readFile(file)).digest("hex");
}

function statePath(root: string): string {
	return path.join(path.dirname(root), `verification-state-${path.basename(root)}`);
}

test("candidate snapshots include staged, unstaged, deleted, and untracked inputs without changing Git state", async () => {
	const root = await createGitRepo({ "src/remove.ts": "export const remove = true;\n" });
	const state = statePath(root);
	let candidate: CandidateSnapshot | undefined;
	try {
		await writeRepoFile(root, "src/main.ts", "export const value = 2;\n");
		git(root, ["add", "src/main.ts"]);
		await writeRepoFile(root, "README.md", "unstaged docs\n");
		await unlink(path.join(root, "src", "remove.ts"));
		await writeRepoFile(root, "test/new.test.ts", "test('new input', () => {});\n");
		const headBefore = git(root, ["rev-parse", "HEAD"]).trim();
		const refsBefore = git(root, ["for-each-ref", "--format=%(refname) %(objectname)"]);
		const index = path.join(root, ".git", "index");
		const indexBefore = await sha256(index);
		const objectsBefore = git(root, ["count-objects", "-v"]);
		candidate = await captureCandidate(root, parsePolicy(testPolicy()), { stateDirectory: state });
		assert.equal(candidate.head, headBefore);
		assert.notEqual(candidate.indexTree, candidate.inputTree);
		assert.deepEqual(new Set(candidate.changedPaths), new Set(["README.md", "src/main.ts", "src/remove.ts", "test/new.test.ts"]));
		assert.ok(candidate.inputPaths.includes("test/new.test.ts"));
		assert.ok(!candidate.inputPaths.includes("src/remove.ts"));
		assert.equal(candidate.repoRoot, root);
		assert.notEqual(candidate.storageDirectory, root);
		assert.equal(await sha256(index), indexBefore);
		assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), headBefore);
		assert.equal(git(root, ["for-each-ref", "--format=%(refname) %(objectname)"]), refsBefore);
		assert.equal(git(root, ["count-objects", "-v"]), objectsBefore);
	} finally {
		if (candidate) await removeCandidate(candidate);
		await rm(state, { recursive: true, force: true });
		await dispose(root);
	}
});
test("executable mode changes are candidate inputs and remain separate from the user index", async () => {
	const root = await createGitRepo({ "src/run.sh": "printf 'run\\n'\\n" });
	const state = statePath(root);
	let candidate: CandidateSnapshot | undefined;
	try {
		git(root, ["config", "core.filemode", "true"]);
		const indexPath = path.join(root, ".git", "index");
		const indexBefore = await sha256(indexPath);
		const headBefore = git(root, ["rev-parse", "HEAD"]).trim();
		await chmod(path.join(root, "src", "run.sh"), 0o755);
		candidate = await captureCandidate(root, parsePolicy(testPolicy()), { stateDirectory: state });
		assert.ok(candidate.changedPaths.includes("src/run.sh"));
		assert.match(git(root, ["diff", "--summary"]), /mode change 100644 => 100755/);
		assert.equal(await sha256(indexPath), indexBefore);
		assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), headBefore);
	} finally {
		if (candidate) await removeCandidate(candidate);
		await rm(state, { recursive: true, force: true });
		await dispose(root);
	}
});

test("untracked test inputs are included and any unclassified changed file refuses capture", async () => {
	const root = await createGitRepo();
	const state = statePath(root);
	let candidate: CandidateSnapshot | undefined;
	try {
		await writeRepoFile(root, "test/new.test.ts", "test('included', () => {});\n");
		candidate = await captureCandidate(root, parsePolicy(testPolicy()), { stateDirectory: state });
		assert.ok(candidate.inputPaths.includes("test/new.test.ts"));
		await removeCandidate(candidate);
		candidate = undefined;
		await writeRepoFile(root, "docs/new.md", "unclassified\n");
		await assert.rejects(captureCandidate(root, parsePolicy(testPolicy()), { stateDirectory: state }), /unclassified/);
	} finally {
		if (candidate) await removeCandidate(candidate);
		await rm(state, { recursive: true, force: true });
		await dispose(root);
	}
});

test("ignored source-like files and escaping symlinks are refused as incomplete candidates", async () => {
	const root = await createGitRepo();
	const state = statePath(root);
	try {
		await writeRepoFile(root, ".gitignore", "src/ignored.ts\n");
		git(root, ["add", ".gitignore"]);
		git(root, ["commit", "--quiet", "-m", "ignore rule"]);
		await writeRepoFile(root, "src/ignored.ts", "export const invisible = true;\n");
		await assert.rejects(captureCandidate(root, parsePolicy(testPolicy()), { stateDirectory: state }), /Ignored source-like input/);
		await unlink(path.join(root, "src", "ignored.ts"));
		await symlink("../../../etc/passwd", path.join(root, "src", "escape.ts"));
		await assert.rejects(captureCandidate(root, parsePolicy(testPolicy()), { stateDirectory: state }), /Symlink escapes/);
	} finally {
		await rm(state, { recursive: true, force: true });
		await dispose(root);
	}
});
test("absolute internal symlinks are refused in staged and working trees while relative internal symlinks remain capturable", async () => {
	const root = await createGitRepo({
		"src/target.ts": "export const target = 'unchanged';\n",
		"src/directory/inside.ts": "export const inside = true;\n",
	});
	const state = statePath(root);
	let candidate: CandidateSnapshot | undefined;
	try {
		const target = path.join(root, "src", "target.ts");
		const targetBefore = await readFile(target, "utf8");
		const directoryTarget = path.join(root, "src", "directory", "inside.ts");
		const directoryBefore = await readFile(directoryTarget, "utf8");
		const fileLink = path.join(root, "src", "absolute-file.ts");
		await symlink(target, fileLink);
		await assert.rejects(captureCandidate(root, parsePolicy(testPolicy()), { stateDirectory: state }), /Absolute symlink targets/);
		assert.equal(await readFile(target, "utf8"), targetBefore);
		await unlink(fileLink);

		const directoryLink = path.join(root, "src", "absolute-directory");
		await symlink(path.join(root, "src", "directory"), directoryLink);
		await assert.rejects(captureCandidate(root, parsePolicy(testPolicy()), { stateDirectory: state }), /Absolute symlink targets/);
		assert.equal(await readFile(target, "utf8"), targetBefore);
		assert.equal(await readFile(directoryTarget, "utf8"), directoryBefore);
		await unlink(directoryLink);

		await symlink("target.ts", path.join(root, "src", "relative-file.ts"));
		await symlink("directory", path.join(root, "src", "relative-directory"));
		candidate = await captureCandidate(root, parsePolicy(testPolicy()), { stateDirectory: state });
		assert.ok(candidate.inputPaths.includes("src/relative-file.ts"));
		assert.ok(candidate.inputPaths.includes("src/relative-directory"));
		await removeCandidate(candidate);
		candidate = undefined;

		const stagedLink = path.join(root, "src", "staged-absolute.ts");
		const index = path.join(root, ".git", "index");
		await symlink(target, stagedLink);
		git(root, ["add", "src/staged-absolute.ts"]);
		await unlink(stagedLink);
		await symlink("target.ts", stagedLink);
		const indexBefore = await sha256(index);
		await assert.rejects(captureCandidate(root, parsePolicy(testPolicy()), { stateDirectory: state }), /Absolute symlink targets/);
		assert.equal(await sha256(index), indexBefore);
		assert.equal(await readFile(target, "utf8"), targetBefore);
		assert.equal(await readFile(directoryTarget, "utf8"), directoryBefore);
	} finally {
		if (candidate) await removeCandidate(candidate);
		await rm(state, { recursive: true, force: true });
		await dispose(root);
	}
});

test("assume-unchanged tracked files are read from working bytes without changing the real index flag", async () => {
	const root = await createGitRepo();
	const state = statePath(root);
	const index = path.join(root, ".git", "index");
	let candidate: CandidateSnapshot | undefined;
	try {
		git(root, ["config", "core.trustctime", "false"]);
		git(root, ["config", "core.checkStat", "minimal"]);
		const stableTimestamp = new Date("2000-01-01T00:00:00Z");
		const sourceFile = path.join(root, "src", "main.ts");
		await utimes(sourceFile, stableTimestamp, stableTimestamp);
		git(root, ["add", "--", "src/main.ts"]);
		git(root, ["update-index", "--assume-unchanged", "--", "src/main.ts"]);
		const workingBytes = "export const value = 2;\n";
		await writeRepoFile(root, "src/main.ts", workingBytes);
		await utimes(sourceFile, stableTimestamp, stableTimestamp);
		const indexBefore = await sha256(index);
		const headBefore = git(root, ["rev-parse", "HEAD"]).trim();
		const refsBefore = git(root, ["for-each-ref", "--format=%(refname) %(objectname)"]);

		candidate = await captureCandidate(root, parsePolicy(testPolicy()), { stateDirectory: state });

		const objectEnvironment = {
			...process.env,
			GIT_INDEX_FILE: candidate.indexFile,
			GIT_OBJECT_DIRECTORY: candidate.objectDirectory,
			GIT_ALTERNATE_OBJECT_DIRECTORIES: candidate.sourceObjectDirectory,
		};
		assert.equal(git(root, ["show", `${candidate.inputTree}:src/main.ts`], objectEnvironment), workingBytes);
		assert.ok(candidate.changedPaths.includes("src/main.ts"));
		assert.ok(requiredChecks(parsePolicy(testPolicy()), { profile: "full", additionalChecks: [] }, candidate.changedPaths).includes("integration"));
		assert.equal(await sha256(index), indexBefore);
		assert.match(git(root, ["ls-files", "-v", "--", "src/main.ts"]), /^h /);
		assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), headBefore);
		assert.equal(git(root, ["for-each-ref", "--format=%(refname) %(objectname)"]), refsBefore);
		assert.equal(await readFile(path.join(root, "src", "main.ts"), "utf8"), workingBytes);
	} finally {
		if (candidate) await removeCandidate(candidate);
		await rm(state, { recursive: true, force: true });
		await dispose(root);
	}
});

test("skip-worktree entries are refused without changing the real index or its flag", async () => {
	const root = await createGitRepo();
	const state = statePath(root);
	const index = path.join(root, ".git", "index");
	try {
		git(root, ["update-index", "--skip-worktree", "--", "src/main.ts"]);
		const indexBefore = await sha256(index);
		const headBefore = git(root, ["rev-parse", "HEAD"]).trim();
		const refsBefore = git(root, ["for-each-ref", "--format=%(refname) %(objectname)"]);
		const statusBefore = git(root, ["status", "--porcelain=v2", "--untracked-files=all", "--ignore-submodules=none"]);

		await assert.rejects(captureCandidate(root, parsePolicy(testPolicy()), { stateDirectory: state }), /skip-worktree/);

		assert.equal(await sha256(index), indexBefore);
		assert.match(git(root, ["ls-files", "-v", "--", "src/main.ts"]), /^S /);
		assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), headBefore);
		assert.equal(git(root, ["for-each-ref", "--format=%(refname) %(objectname)"]), refsBefore);
		assert.equal(git(root, ["status", "--porcelain=v2", "--untracked-files=all", "--ignore-submodules=none"]), statusBefore);
	} finally {
		await rm(state, { recursive: true, force: true });
		await dispose(root);
	}
});

test("sparse-index entries are refused without changing the source checkout or index", async () => {
	const root = await createGitRepo();
	const state = statePath(root);
	const index = path.join(root, ".git", "index");
	try {
		git(root, ["sparse-checkout", "init", "--cone", "--sparse-index"]);
		git(root, ["sparse-checkout", "set", ".omp"]);
		assert.equal(git(root, ["config", "--bool", "index.sparse"]).trim(), "true");
		assert.ok(git(root, ["ls-files", "--sparse", "--stage", "-z"]).split("\0").some((entry) => entry.startsWith("040000 ") && /\tsrc\/?$/.test(entry)));
		const indexBefore = await sha256(index);
		const headBefore = git(root, ["rev-parse", "HEAD"]).trim();
		const refsBefore = git(root, ["for-each-ref", "--format=%(refname) %(objectname)"]);
		const statusBefore = git(root, ["status", "--porcelain=v2", "--untracked-files=all", "--ignore-submodules=none"]);

		await assert.rejects(captureCandidate(root, parsePolicy(testPolicy()), { stateDirectory: state }), /Sparse-index/);

		assert.equal(await sha256(index), indexBefore);
		assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), headBefore);
		assert.equal(git(root, ["for-each-ref", "--format=%(refname) %(objectname)"]), refsBefore);
		assert.equal(git(root, ["status", "--porcelain=v2", "--untracked-files=all", "--ignore-submodules=none"]), statusBefore);
	} finally {
		await rm(state, { recursive: true, force: true });
		await dispose(root);
	}
});

test("staged-only new migrations remain classified and select path-triggered mandatory checks after worktree deletion", async () => {
	const root = await createGitRepo();
	const state = statePath(root);
	const file = "src/migrations/001-initial.sql";
	const index = path.join(root, ".git", "index");
	let candidate: CandidateSnapshot | undefined;
	try {
		await writeRepoFile(root, file, "create table initial (id integer);\n");
		git(root, ["add", "--", file]);
		await unlink(path.join(root, file));
		const indexBefore = await sha256(index);

		candidate = await captureCandidate(root, parsePolicy(testPolicy()), { stateDirectory: state });

		assert.ok(candidate.changedPaths.includes(file));
		assert.ok(!candidate.inputPaths.includes(file));
		assert.notEqual(candidate.indexTree, candidate.inputTree);
		assert.ok(requiredChecks(parsePolicy(testPolicy()), { profile: "full", additionalChecks: [] }, candidate.changedPaths).includes("integration"));
		assert.equal(await sha256(index), indexBefore);
	} finally {
		if (candidate) await removeCandidate(candidate);
		await rm(state, { recursive: true, force: true });
		await dispose(root);
	}
});

test("staged changes reverted in the worktree remain classified and select path-triggered mandatory checks", async () => {
	const root = await createGitRepo();
	const state = statePath(root);
	const file = path.join(root, "src", "main.ts");
	const index = path.join(root, ".git", "index");
	let candidate: CandidateSnapshot | undefined;
	try {
		const originalBytes = await readFile(file, "utf8");
		await writeRepoFile(root, "src/main.ts", "export const value = 'staged';\n");
		git(root, ["add", "src/main.ts"]);
		await writeRepoFile(root, "src/main.ts", originalBytes);
		const indexBefore = await sha256(index);

		candidate = await captureCandidate(root, parsePolicy(testPolicy()), { stateDirectory: state });

		assert.ok(candidate.changedPaths.includes("src/main.ts"));
		assert.ok(requiredChecks(parsePolicy(testPolicy()), { profile: "full", additionalChecks: [] }, candidate.changedPaths).includes("integration"));
		const objectEnvironment = {
			...process.env,
			GIT_INDEX_FILE: candidate.indexFile,
			GIT_OBJECT_DIRECTORY: candidate.objectDirectory,
			GIT_ALTERNATE_OBJECT_DIRECTORIES: candidate.sourceObjectDirectory,
		};
		assert.equal(git(root, ["show", `${candidate.inputTree}:src/main.ts`], objectEnvironment), originalBytes);
		assert.equal(git(root, ["show", `${candidate.indexTree}:src/main.ts`], objectEnvironment), "export const value = 'staged';\n");
		assert.equal(await sha256(index), indexBefore);
	} finally {
		if (candidate) await removeCandidate(candidate);
		await rm(state, { recursive: true, force: true });
		await dispose(root);
	}
});

test("unknown staged-only paths are refused even when absent from the worktree", async () => {
	const root = await createGitRepo();
	const state = statePath(root);
	const file = "migrations/unknown.sql";
	const index = path.join(root, ".git", "index");
	try {
		await writeRepoFile(root, file, "create table unknown (id integer);\n");
		git(root, ["add", "--", file]);
		await unlink(path.join(root, file));
		const indexBefore = await sha256(index);

		await assert.rejects(captureCandidate(root, parsePolicy(testPolicy()), { stateDirectory: state }), /Changed input is unclassified/);

		assert.equal(await sha256(index), indexBefore);
	} finally {
		await rm(state, { recursive: true, force: true });
		await dispose(root);
	}
});

test("unresolved merge entries are refused without modifying user refs", async () => {
	const root = await createGitRepo();
	const state = statePath(root);
	try {
		const initial = git(root, ["rev-parse", "HEAD"]).trim();
		git(root, ["checkout", "-q", "-b", "side"]);
		await writeRepoFile(root, "src/main.ts", "export const value = 'side';\n");
		git(root, ["commit", "-qam", "side"]);
		git(root, ["checkout", "-q", initial]);
		await writeRepoFile(root, "src/main.ts", "export const value = 'main';\n");
		git(root, ["commit", "-qam", "main"]);
		try {
			execFileSync("git", ["merge", "side"], { cwd: root, stdio: "ignore" });
		} catch {
			// A real merge conflict is the condition under test.
		}
		const refsBefore = git(root, ["for-each-ref", "--format=%(refname) %(objectname)"]);
		await assert.rejects(captureCandidate(root, parsePolicy(testPolicy()), { stateDirectory: state }), /unresolved merge conflicts/);
		assert.equal(git(root, ["for-each-ref", "--format=%(refname) %(objectname)"]), refsBefore);
	} finally {
		await rm(state, { recursive: true, force: true });
		await dispose(root);
	}
});

test("policy, index, and refs freshness are exact and candidate cleanup is private", async () => {
	const root = await createGitRepo();
	const state = statePath(root);
	let candidate: CandidateSnapshot | undefined;
	try {
		candidate = await captureCandidate(root, parsePolicy(testPolicy()), { stateDirectory: state });
		await verifyCandidateFresh(candidate, parsePolicy(testPolicy()));
		await writeRepoFile(root, "README.md", "changed after approval\n");
		await assert.rejects(verifyCandidateFresh(candidate), /working-tree candidate changed/);
		await writeRepoFile(root, "README.md", "baseline\n");
		await writeRepoFile(root, "src/main.ts", "export const stale = true;\n");
		git(root, ["add", "src/main.ts"]);
		await assert.rejects(verifyCandidateFresh(candidate), /index changed/);
		git(root, ["reset", "--quiet", "HEAD", "--", "src/main.ts"]);
		git(root, ["tag", "candidate-stale"]);
		await assert.rejects(verifyCandidateFresh(candidate), /refs changed/);
	} finally {
		if (candidate) await removeCandidate(candidate);
		await rm(state, { recursive: true, force: true });
		await dispose(root);
	}
});
test("policy edits and deletion invalidate previously captured candidate evidence", async () => {
	const root = await createGitRepo();
	const state = statePath(root);
	let candidate: CandidateSnapshot | undefined;
	try {
		candidate = await captureCandidate(root, parsePolicy(testPolicy()), { stateDirectory: state });
		const changedPolicy = testPolicy();
		const checks = changedPolicy.checks as Record<string, Record<string, unknown>>;
		const unit = checks.unit;
		if (!unit) throw new Error("Test policy is missing the unit check.");
		unit.timeoutSeconds = 11;
		await writeRepoFile(root, ".omp/verification.json", JSON.stringify(changedPolicy, null, 2));
		await assert.rejects(verifyCandidateFresh(candidate), /policy changed or was removed/);
		await rm(path.join(root, ".omp", "verification.json"));
		await assert.rejects(verifyCandidateFresh(candidate), /policy changed or was removed/);
	} finally {
		if (candidate) await removeCandidate(candidate);
		await rm(state, { recursive: true, force: true });
		await dispose(root);
	}
});
