import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { captureCandidate, removeCandidate, type CandidateSnapshot } from "./verification-snapshot.ts";
import { getOutputPatterns, materialize, watchWorkspaceMutations, type ExecutionWorkspace, type WorkspaceMutationWatch } from "./verification-workspace.ts";
import { parsePolicy } from "./verification-policy.ts";
import { createGitRepo, dispose, git, testPolicy, writeRepoFile } from "./verification-test-helpers.ts";

function statePath(root: string): string {
	return path.join(path.dirname(root), `verification-workspace-state-${path.basename(root)}`);
}

async function fileDigest(file: string): Promise<string> {
	return createHash("sha256").update(await readFile(file)).digest("hex");
}

function addPreparation(policy: Record<string, unknown>, id: string, argv: string[], outputs: string[]): Record<string, unknown> {
	const preparations = policy.preparations as Record<string, unknown>;
	preparations[id] = { argv, timeoutSeconds: 20, outputs };
	const checks = policy.checks as Record<string, Record<string, unknown>>;
	const unit = checks.unit;
	if (!unit) throw new Error("Test policy is missing the unit check.");
	unit.preparations = [id];
	return policy;
}

test("materialized checkout preserves HEAD, refs, staged index, worktree diff, and untracked inputs", async () => {
	const root = await createGitRepo({ "src/remove.ts": "export const remove = true;\n" });
	const state = statePath(root);
	let candidate: CandidateSnapshot | undefined;
	let workspace: ExecutionWorkspace | undefined;
	try {
		await writeRepoFile(root, "src/main.ts", "export const value = 2;\n");
		git(root, ["add", "src/main.ts"]);
		await writeRepoFile(root, "README.md", "unstaged docs\n");
		await writeRepoFile(root, "test/new.test.ts", "test('candidate', () => {});\n");
		const expectedHead = git(root, ["rev-parse", "HEAD"]).trim();
		const expectedRefs = git(root, ["for-each-ref", "--format=%(refname) %(objectname)"]);
		const expectedCachedDiff = git(root, ["diff", "--cached", "--binary"]);
		const expectedWorktreeDiff = git(root, ["diff", "--binary"]);
		const expectedStatus = git(root, ["status", "--porcelain=v2", "--untracked-files=all"]);
		const expectedIndex = await fileDigest(path.join(root, ".git", "index"));
		candidate = await captureCandidate(root, parsePolicy(testPolicy()), { stateDirectory: state });
		workspace = await materialize(candidate, "full");
		assert.equal(git(workspace.root, ["rev-parse", "HEAD"], workspace.environment).trim(), expectedHead);
		assert.equal(git(workspace.root, ["for-each-ref", "--format=%(refname) %(objectname)"], workspace.environment), expectedRefs);
		assert.equal(git(workspace.root, ["diff", "--cached", "--binary"], workspace.environment), expectedCachedDiff);
		assert.equal(git(workspace.root, ["diff", "--binary"], workspace.environment), expectedWorktreeDiff);
		assert.equal(git(workspace.root, ["status", "--porcelain=v2", "--untracked-files=all"], workspace.environment), expectedStatus);
		assert.ok(candidate.inputPaths.includes("test/new.test.ts"));
		assert.ok(!(await lstat(path.join(workspace.root, "src", "main.ts"))).isSymbolicLink());
		await workspace.verifyInputsUnchanged();
		await writeRepoFile(workspace.root, "src/main.ts", "formatter changed candidate\n");
		await assert.rejects(workspace.verifyInputsUnchanged(), /changed the approved Git input/);
		assert.equal(await readFile(path.join(root, "src", "main.ts"), "utf8"), "export const value = 2;\n");
		assert.equal(await fileDigest(path.join(root, ".git", "index")), expectedIndex);
		assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), expectedHead);
		assert.equal(git(root, ["for-each-ref", "--format=%(refname) %(objectname)"]), expectedRefs);
	} finally {
		if (workspace) await workspace.cleanup();
		if (candidate) await removeCandidate(candidate);
		await rm(state, { recursive: true, force: true });
		await dispose(root);
	}
});

test("output-only generation is isolated and permitted, but code generation changing inputs invalidates its proof", async () => {
	const root = await createGitRepo();
	const state = statePath(root);
	let candidate: CandidateSnapshot | undefined;
	let workspace: ExecutionWorkspace | undefined;
	let mutationWatch: WorkspaceMutationWatch | undefined;
	try {
		const outputPolicy = addPreparation(testPolicy(), "generate-output", [process.execPath, "-e", "require('node:fs').mkdirSync('build', {recursive:true}); require('node:fs').writeFileSync('build/generated.txt', 'generated\\n')"], ["build/**"]);
		await writeRepoFile(root, ".omp/verification.json", JSON.stringify(outputPolicy, null, 2));
		candidate = await captureCandidate(root, parsePolicy(outputPolicy), { stateDirectory: state });
		workspace = await materialize(candidate, "full", { preparationIds: ["generate-output"] });
		mutationWatch = watchWorkspaceMutations(workspace.root, getOutputPatterns(workspace.policy, ["generate-output"]), workspace.policy);
		execFileSync(process.execPath, ["-e", "require('node:fs').mkdirSync('build', {recursive:true}); require('node:fs').writeFileSync('build/generated.txt', 'generated\\n')"], { cwd: workspace.root, env: workspace.environment });
		assert.equal(await mutationWatch.finish(), undefined);
		mutationWatch = undefined;
		await workspace.verifyInputsUnchanged();
		assert.equal(await readFile(path.join(workspace.root, "build", "generated.txt"), "utf8"), "generated\n");
		await workspace.cleanup();
		workspace = undefined;
		await removeCandidate(candidate);
		candidate = undefined;

		const codegenPolicy = addPreparation(testPolicy(), "generate-source", [process.execPath, "-e", "require('node:fs').writeFileSync('src/generated.ts', 'export const generated = true;\\n')"], ["build/**"]);
		await writeRepoFile(root, ".omp/verification.json", JSON.stringify(codegenPolicy, null, 2));
		candidate = await captureCandidate(root, parsePolicy(codegenPolicy), { stateDirectory: state });
		workspace = await materialize(candidate, "full", { preparationIds: ["generate-source"] });
		execFileSync(process.execPath, ["-e", "require('node:fs').writeFileSync('src/generated.ts', 'export const generated = true;\\n')"], { cwd: workspace.root, env: workspace.environment });
		await assert.rejects(workspace.verifyInputsUnchanged(), /changed the approved Git input/);
		await workspace.cleanup();
		workspace = undefined;
		await writeRepoFile(root, "src/generated.ts", "export const generated = true;\n");
		await removeCandidate(candidate);
		candidate = await captureCandidate(root, parsePolicy(codegenPolicy), { stateDirectory: state });
		workspace = await materialize(candidate, "full", { preparationIds: ["generate-source"] });
		execFileSync(process.execPath, ["-e", "require('node:fs').writeFileSync('src/generated.ts', 'export const generated = true;\\n')"], { cwd: workspace.root, env: workspace.environment });
		await workspace.verifyInputsUnchanged();
	} finally {
		if (mutationWatch) await mutationWatch.finish();
		if (workspace) await workspace.cleanup();
		if (candidate) await removeCandidate(candidate);
		await rm(state, { recursive: true, force: true });
		await dispose(root);
	}
});

test("preparation outputs cannot overlap files already included in the approved input tree", async () => {
	const root = await createGitRepo();
	const state = statePath(root);
	let candidate: CandidateSnapshot | undefined;
	try {
		const policyData = addPreparation(testPolicy(), "bad-output", [process.execPath, "-e", "process.exit(0)"], ["src/**"]);
		await writeRepoFile(root, ".omp/verification.json", JSON.stringify(policyData, null, 2));
		candidate = await captureCandidate(root, parsePolicy(policyData), { stateDirectory: state });
		await assert.rejects(materialize(candidate, "full", { preparationIds: ["bad-output"] }), /overlaps a candidate input/);
	} finally {
		if (candidate) await removeCandidate(candidate);
		await rm(state, { recursive: true, force: true });
		await dispose(root);
	}
});
test("preparation outputs under source, test, generated, configuration, ambiguous, or unclassified paths invalidate proof", async () => {
	const fixtures = [
		{ id: "source-output", pattern: "src/generated/**", file: "src/generated/created.ts" },
		{ id: "test-output", pattern: "test/generated/**", file: "test/generated/created.test.ts" },
		{ id: "generated-output", pattern: "generated/**", file: "generated/created.ts" },
		{ id: "configuration-output", pattern: ".omp/generated/**", file: ".omp/generated/created.json" },
		{ id: "ambiguous-output", pattern: "src/ambiguous/**", file: "src/ambiguous/created.ts", extraClassification: { pattern: "src/ambiguous/**", kind: "generated" } },
		{ id: "excluded-conflict-output", pattern: "build/**", file: "build/ambiguous/created.ts", extraClassification: { pattern: "build/ambiguous/**", kind: "source" } },
		{ id: "unclassified-output", pattern: "unclassified/**", file: "unclassified/created.bin" },
	];
	for (const fixture of fixtures) {
		const root = await createGitRepo();
		const state = statePath(root);
		let candidate: CandidateSnapshot | undefined;
		let workspace: ExecutionWorkspace | undefined;
		let mutationWatch: WorkspaceMutationWatch | undefined;
		try {
			const content = "prepared output\n";
			const target = JSON.stringify(fixture.file);
			const expected = JSON.stringify(content);
			const preparationScript = `const fs=require("node:fs");const path=require("node:path");const target=${target};fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,${expected});`;
			const checkScript = `const fs=require("node:fs");if(fs.readFileSync(${target},"utf8")!==${expected})process.exit(1);`;
			const policyData = addPreparation(testPolicy(), fixture.id, [process.execPath, "-e", preparationScript], [fixture.pattern]);
			const checks = policyData.checks as Record<string, Record<string, unknown>>;
			checks.unit!.argv = [process.execPath, "-e", checkScript];
			if ("extraClassification" in fixture && fixture.extraClassification) {
				(policyData.classifications as { pattern: string; kind: string }[]).push(fixture.extraClassification);
			}
			await writeRepoFile(root, ".omp/verification.json", JSON.stringify(policyData, null, 2));
			candidate = await captureCandidate(root, parsePolicy(policyData), { stateDirectory: state });
			workspace = await materialize(candidate, "full", { preparationIds: [fixture.id] });
			mutationWatch = watchWorkspaceMutations(workspace.root, getOutputPatterns(workspace.policy, [fixture.id]), workspace.policy);
			execFileSync(process.execPath, ["-e", preparationScript], { cwd: workspace.root, env: workspace.environment });
			execFileSync(process.execPath, ["-e", checkScript], { cwd: workspace.root, env: workspace.environment });
			assert.ok(await mutationWatch.finish());
			mutationWatch = undefined;
			await assert.rejects(workspace.verifyInputsUnchanged(), /changed the approved Git input/);
		} finally {
			if (mutationWatch) await mutationWatch.finish();
			if (workspace) await workspace.cleanup();
			if (candidate) await removeCandidate(candidate);
			await rm(state, { recursive: true, force: true });
			await dispose(root);
		}
	}
});

test("generated output cannot be used, byte-restored, and deleted without invalidating the mutation proof", async () => {
	const root = await createGitRepo();
	const state = statePath(root);
	let candidate: CandidateSnapshot | undefined;
	let workspace: ExecutionWorkspace | undefined;
	let mutationWatch: WorkspaceMutationWatch | undefined;
	try {
		const file = "generated/temporary.ts";
		const target = JSON.stringify(file);
		const original = JSON.stringify("generated bytes\n");
		const preparationScript = `const fs=require("node:fs");const path=require("node:path");const target=${target};fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,${original});`;
		const checkScript = `const fs=require("node:fs");const target=${target};if(fs.readFileSync(target,"utf8")!==${original})process.exit(1);fs.writeFileSync(target,"changed bytes\\n");fs.writeFileSync(target,${original});fs.unlinkSync(target);`;
		const policyData = addPreparation(testPolicy(), "generate-temporary", [process.execPath, "-e", preparationScript], ["generated/**"]);
		const checks = policyData.checks as Record<string, Record<string, unknown>>;
		checks.unit!.argv = [process.execPath, "-e", checkScript];
		await writeRepoFile(root, ".omp/verification.json", JSON.stringify(policyData, null, 2));
		candidate = await captureCandidate(root, parsePolicy(policyData), { stateDirectory: state });
		workspace = await materialize(candidate, "full", { preparationIds: ["generate-temporary"] });
		mutationWatch = watchWorkspaceMutations(workspace.root, getOutputPatterns(workspace.policy, ["generate-temporary"]), workspace.policy);
		execFileSync(process.execPath, ["-e", preparationScript], { cwd: workspace.root, env: workspace.environment });
		execFileSync(process.execPath, ["-e", checkScript], { cwd: workspace.root, env: workspace.environment });
		assert.ok(await mutationWatch.finish());
		mutationWatch = undefined;
		await workspace.verifyInputsUnchanged();
	} finally {
		if (mutationWatch) await mutationWatch.finish();
		if (workspace) await workspace.cleanup();
		if (candidate) await removeCandidate(candidate);
		await rm(state, { recursive: true, force: true });
		await dispose(root);
	}
});
test("globstar directory classifications reject suffix lookalikes and retain nested cache outputs", async () => {
	const scenarios = [
		{ id: "suffix-lookalike", outputPattern: "precache/**", outputFile: "precache/generated.js", allowed: false },
		{ id: "nested-cache-output", outputPattern: "nested/cache/**", outputFile: "nested/cache/generated.js", allowed: true },
	];
	for (const scenario of scenarios) {
		const root = await createGitRepo();
		const state = statePath(root);
		let candidate: CandidateSnapshot | undefined;
		let workspace: ExecutionWorkspace | undefined;
		let mutationWatch: WorkspaceMutationWatch | undefined;
		try {
			const content = "generated cache output\n";
			const target = JSON.stringify(scenario.outputFile);
			const expected = JSON.stringify(content);
			const preparationScript = `const fs=require("node:fs");const path=require("node:path");const target=${target};fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,${expected});`;
			const checkScript = `const fs=require("node:fs");if(fs.readFileSync(${target},"utf8")!==${expected})process.exit(1);`;
			const policyData = addPreparation(testPolicy(), scenario.id, [process.execPath, "-e", preparationScript], [scenario.outputPattern]);
			(policyData.classifications as { pattern: string; kind: string }[]).push({ pattern: "**/cache/**", kind: "excluded" });
			const checks = policyData.checks as Record<string, Record<string, unknown>>;
			checks.unit!.argv = [process.execPath, "-e", checkScript];
			await writeRepoFile(root, ".omp/verification.json", JSON.stringify(policyData, null, 2));
			candidate = await captureCandidate(root, parsePolicy(policyData), { stateDirectory: state });
			workspace = await materialize(candidate, "full", { preparationIds: [scenario.id] });
			if (scenario.allowed) await mkdir(path.dirname(path.join(workspace.root, scenario.outputFile)), { recursive: true });
			mutationWatch = watchWorkspaceMutations(workspace.root, getOutputPatterns(workspace.policy, [scenario.id]), workspace.policy);
			execFileSync(process.execPath, ["-e", preparationScript], { cwd: workspace.root, env: workspace.environment });
			execFileSync(process.execPath, ["-e", checkScript], { cwd: workspace.root, env: workspace.environment });
			const mutationViolation = await mutationWatch.finish();
			mutationWatch = undefined;
			let integrityError: unknown;
			try {
				await workspace.verifyInputsUnchanged();
			} catch (error) {
				integrityError = error;
			}
			if (scenario.allowed) {
				assert.equal(mutationViolation, undefined);
				assert.equal(integrityError, undefined);
			} else {
				assert.ok(mutationViolation);
				if (!(integrityError instanceof Error)) throw new Error("Expected integrity verification to reject the unclassified output.");
				assert.match(integrityError.message, /changed the approved Git input/);
			}
		} finally {
			if (mutationWatch) await mutationWatch.finish();
			if (workspace) await workspace.cleanup();
			if (candidate) await removeCandidate(candidate);
			await rm(state, { recursive: true, force: true });
			await dispose(root);
		}
	}
});
