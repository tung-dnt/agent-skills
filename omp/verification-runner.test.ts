import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { parsePolicy } from "./verification-policy.ts";
import { createReceiptStore, readRunLog, type CheckRunRecord } from "./verification-receipts.ts";
import { captureCandidate, removeCandidate, type CandidateSnapshot } from "./verification-snapshot.ts";
import { VerificationRunner } from "./verification-runner.ts";
import { createGitRepo, dispose, writeRepoFile, testPolicy } from "./verification-test-helpers.ts";
import type { NativeVerificationBinding } from "./verification-bindings.ts";

interface RunnerFixture {
	readonly root: string;
	readonly stateDirectory: string;
	readonly candidate: CandidateSnapshot;
	readonly binding: NativeVerificationBinding;
	readonly runner: VerificationRunner;
}

async function runnerFixture(
	argv: readonly string[],
	options: { readonly timeoutSeconds?: number; readonly kind?: "static" | "runtime"; readonly preparation?: { readonly id: string; readonly argv: readonly string[]; readonly outputs: readonly string[] }; readonly resourceProbe?: readonly string[] } = {},
): Promise<RunnerFixture> {
	const root = await createGitRepo();
	const stateDirectory = path.join(path.dirname(root), `verification-runner-state-${path.basename(root)}`);
	const policy = testPolicy();
	const checks = policy.checks as Record<string, Record<string, unknown>>;
	const unit = checks.unit;
	if (!unit) throw new Error("Test policy is missing the unit check.");
	unit.argv = [...argv];
	unit.timeoutSeconds = options.timeoutSeconds ?? 10;
	unit.kind = options.kind ?? "static";
	if (unit.kind === "runtime") unit.resourceId = "test-runtime";
	else delete unit.resourceId;
	if (options.resourceProbe) {
		const resources = policy.resources as Record<string, Record<string, unknown>>;
		const resource = resources["test-runtime"];
		if (!resource) throw new Error("Test policy is missing the runtime generation resource.");
		resource.argv = [...options.resourceProbe];
	}
	if (options.preparation) {
		unit.preparations = [options.preparation.id];
		const preparations = policy.preparations as Record<string, unknown>;
		preparations[options.preparation.id] = { argv: options.preparation.argv, timeoutSeconds: 10, outputs: options.preparation.outputs };
	}
	await writeRepoFile(root, ".omp/verification.json", JSON.stringify(policy, null, 2));
	const parsedPolicy = parsePolicy(policy);
	const candidate = await captureCandidate(root, parsedPolicy, { stateDirectory });
	const binding: NativeVerificationBinding = {
		version: 1,
		bindingId: randomUUID(),
		workId: "w1",
		item: "[w1] Verify final candidate",
		ownerSessionHash: "a".repeat(64),
		branchAnchorId: "deadbeef",
		repoId: candidate.repoId,
		policyDigest: candidate.policyDigest,
		scopeArtifact: "scope.md",
		scopeDigest: "d".repeat(64),
		profile: "full",
		additionalChecks: [],
		requiredChecks: ["unit"],
		candidateId: candidate.id,
		snapshotRef: path.basename(candidate.storageDirectory),
		attemptId: randomUUID(),
		createdAt: new Date().toISOString(),
	};
	return { root, stateDirectory, candidate, binding, runner: new VerificationRunner({ stateDirectory }) };
}

// These integration tests exercise real OS children; fake clocks cannot advance their process exits or signals.
async function waitForTerminal(runner: VerificationRunner, runId: string): Promise<CheckRunRecord> {
	let current = await runner.status(runId);
	for (let attempt = 0; attempt < 600 && current.state === "running"; attempt += 1) {
		await delay(10);
		current = await runner.status(runId);
	}
	if (current.state === "running") throw new Error("Verification child did not reach an observed terminal state.");
	return current;
}

async function waitForFile(file: string): Promise<void> {
	for (let attempt = 0; attempt < 500; attempt += 1) {
		try {
			await access(file);
			return;
		} catch {
			await delay(10);
		}
	}
	throw new Error("Verification child did not create its start marker.");
}
async function processHasExited(pid: number): Promise<boolean> {
	try {
		process.kill(pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
		throw error;
	}
	if (process.platform !== "linux") return false;
	try {
		const stat = await readFile(`/proc/${pid}/stat`, "utf8");
		const closingParenthesis = stat.lastIndexOf(")");
		const state = closingParenthesis < 0 ? undefined : stat.slice(closingParenthesis + 1).trimStart()[0];
		// A zombie cannot execute, even if its parent has not reaped it yet.
		return state === "Z" || state === "X" || state === "x";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ESRCH") return true;
		throw error;
	}
}

async function waitForProcessExit(pid: number): Promise<void> {
	for (let attempt = 0; attempt < 500; attempt += 1) {
		if (await processHasExited(pid)) return;
		await delay(10);
	}
	throw new Error("Owned descendant survived process-group teardown.");
}

function processGroupFixtureArgv(pidFile: string, readyFile: string): readonly string[] {
	const descendantCode = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(readyFile)},'ready');setInterval(()=>{},1000)`;
	const leaderCode = `const {spawn}=require('node:child_process');const fs=require('node:fs');const descendant=spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(descendant.pid));setInterval(()=>{},1000)`;
	return [process.execPath, "-e", leaderCode];
}

async function killProcessAtFile(file: string): Promise<void> {
	try {
		const pid = Number(await readFile(file, "utf8"));
		if (Number.isInteger(pid) && pid > 0) {
			try {
				process.kill(pid, "SIGKILL");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
				throw error;
			}
			await waitForProcessExit(pid);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

const RESOURCE_TOKEN = "approved-resource-generation";

function noisyResourceProbe(counterFile: string, noisyInvocation: number): readonly string[] {
	const code = `const fs=require('node:fs');const file=${JSON.stringify(counterFile)};const invocation=Number(fs.readFileSync(file,'utf8'))+1;fs.writeFileSync(file,String(invocation));const token=${JSON.stringify(RESOURCE_TOKEN)};process.stdout.write(invocation===${noisyInvocation}?' '.repeat(1_000_100)+token:token)`;
	return [process.execPath, "-e", code];
}

async function cleanup(fixture: RunnerFixture): Promise<void> {
	await fixture.runner.interruptAll();
	await removeCandidate(fixture.candidate);
	await rm(fixture.stateDirectory, { recursive: true, force: true });
	await dispose(fixture.root);
}
async function assertResourceTokenOnlyHashed(
	fixture: RunnerFixture,
	record: CheckRunRecord,
	expectedHash: string | null,
): Promise<void> {
	assert.equal(record.resourceGeneration, expectedHash);
	assert.ok(!JSON.stringify(record).includes(RESOURCE_TOKEN));
	const store = await createReceiptStore(fixture.stateDirectory);
	assert.ok(!(await readRunLog(store, record.runId)).includes(RESOURCE_TOKEN));
}

test("only an observed zero exit from the named child creates a passing receipt", async () => {
	const fixture = await runnerFixture([process.execPath, "-e", "console.log('real child finished')"]);
	try {
		const started = await fixture.runner.startCheck({ binding: fixture.binding, candidate: fixture.candidate, checkId: "unit" });
		assert.equal(started.state, "running");
		const completed = await waitForTerminal(fixture.runner, started.runId);
		assert.equal(completed.state, "passed");
		assert.equal(completed.exitCode, 0);
		assert.equal(completed.attemptId, fixture.binding.attemptId);
	} finally {
		await cleanup(fixture);
	}
});
test("declared output-only preparation generation is isolated and does not dirty approved inputs", async () => {
	const generate = "require('node:fs').mkdirSync('build',{recursive:true});require('node:fs').writeFileSync('build/generated.txt','generated')";
	const fixture = await runnerFixture([process.execPath, "-e", "process.exit(0)"], {
		preparation: { id: "generate", argv: [process.execPath, "-e", generate], outputs: ["build/**"] },
	});
	try {
		const started = await fixture.runner.startCheck({ binding: fixture.binding, candidate: fixture.candidate, checkId: "unit" });
		const completed = await waitForTerminal(fixture.runner, started.runId);
		assert.equal(completed.state, "passed");
	} finally {
		await cleanup(fixture);
	}
});

test("a preparation cannot restore mutated inputs and then execute the approved check", async () => {
	const markerDirectory = await mkdtemp(path.join(tmpdir(), "verification-preparation-marker-"));
	const marker = path.join(markerDirectory, "check-started");
	const prepare = "const fs=require('node:fs');const file='src/main.ts';const original=fs.readFileSync(file);fs.writeFileSync(file,'temporary changed input');fs.writeFileSync(file,original)";
	const fixture = await runnerFixture([process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],'ran')", marker], {
		preparation: { id: "generate", argv: [process.execPath, "-e", prepare], outputs: ["build/**"] },
	});
	try {
		const started = await fixture.runner.startCheck({ binding: fixture.binding, candidate: fixture.candidate, checkId: "unit" });
		const completed = await waitForTerminal(fixture.runner, started.runId);
		assert.equal(completed.state, "failed");
		assert.equal(completed.failureCode, "INPUTS_CHANGED");
		await assert.rejects(access(marker), { code: "ENOENT" });
		assert.equal(await readFile(path.join(fixture.root, "src", "main.ts"), "utf8"), "export const value = 1;\n");
	} finally {
		await cleanup(fixture);
		await rm(markerDirectory, { recursive: true, force: true });
	}
});

test("stdout claiming success never overrides an actual non-zero child exit", async () => {
	const fixture = await runnerFixture([process.execPath, "-e", "console.log('PASSED'); process.exit(7)"]);
	try {
		const started = await fixture.runner.startCheck({ binding: fixture.binding, candidate: fixture.candidate, checkId: "unit" });
		const completed = await waitForTerminal(fixture.runner, started.runId);
		assert.equal(completed.state, "failed");
		assert.equal(completed.exitCode, 7);
		assert.equal(completed.failureCode, "NONZERO_EXIT");
		const store = await createReceiptStore(fixture.stateDirectory);
		assert.match(await readRunLog(store, started.runId), /PASSED/);
	} finally {
		await cleanup(fixture);
	}
});
test("an input changed and restored during a passing child still invalidates its evidence", async () => {
	const code = `const fs=require('node:fs');const file='src/main.ts';const original=fs.readFileSync(file);fs.writeFileSync(file,Buffer.concat([original,Buffer.from('transient')]));fs.writeFileSync(file,original);console.log('PASSED')`;
	const fixture = await runnerFixture([process.execPath, "-e", code]);
	try {
		const started = await fixture.runner.startCheck({ binding: fixture.binding, candidate: fixture.candidate, checkId: "unit" });
		const completed = await waitForTerminal(fixture.runner, started.runId);
		assert.equal(completed.state, "failed");
		assert.equal(completed.exitCode, 0);
		assert.equal(completed.failureCode, "INPUTS_CHANGED");
		const store = await createReceiptStore(fixture.stateDirectory);
		assert.match(await readRunLog(store, started.runId), /PASSED/);
	} finally {
		await cleanup(fixture);
	}
});
test("runtime proof refuses a resource reset between the pre-check and post-check probes", async () => {
	const markerRoot = await mkdtemp(path.join(tmpdir(), "verification-generation-change-"));
	const marker = path.join(markerRoot, "generation");
	await writeFile(marker, "generation-one");
	const probe = [process.execPath, "-e", `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(marker)},'utf8'))`];
	const mutate = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'generation-two'); console.log('PASSED')`;
	const fixture = await runnerFixture([process.execPath, "-e", mutate], { kind: "runtime", resourceProbe: probe });
	try {
		const started = await fixture.runner.startCheck({ binding: fixture.binding, candidate: fixture.candidate, checkId: "unit" });
		const completed = await waitForTerminal(fixture.runner, started.runId);
		assert.equal(completed.state, "failed");
		assert.equal(completed.exitCode, 0);
		assert.equal(completed.failureCode, "RESOURCE_GENERATION_CHANGED");
		assert.match(completed.resourceGeneration ?? "", /^[a-f0-9]{64}$/);
	} finally {
		await cleanup(fixture);
		await rm(markerRoot, { recursive: true, force: true });
	}
});

test("runtime proof re-reads the configured resource generation before certification", async () => {
	const markerRoot = await mkdtemp(path.join(tmpdir(), "verification-generation-current-"));
	const marker = path.join(markerRoot, "generation");
	await writeFile(marker, "generation-one");
	const probe = [process.execPath, "-e", `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(marker)},'utf8'))`];
	const fixture = await runnerFixture([process.execPath, "-e", "process.exit(0)"], { kind: "runtime", resourceProbe: probe });
	try {
		const started = await fixture.runner.startCheck({ binding: fixture.binding, candidate: fixture.candidate, checkId: "unit" });
		const completed = await waitForTerminal(fixture.runner, started.runId);
		assert.equal(completed.state, "passed");
		await fixture.runner.verifyCurrentResourceGenerations(fixture.binding, fixture.candidate, [completed]);
		await writeFile(marker, "generation-two");
		await assert.rejects(fixture.runner.verifyCurrentResourceGenerations(fixture.binding, fixture.candidate, [completed]), /RESOURCE_GENERATION_CHANGED/);
	} finally {
		await cleanup(fixture);
		await rm(markerRoot, { recursive: true, force: true });
	}
});

test("runtime proof rejects oversized whitespace-prefixed output from the pre-check probe", async () => {
	const markerRoot = await mkdtemp(path.join(tmpdir(), "verification-generation-pre-overflow-"));
	const counter = path.join(markerRoot, "calls");
	await writeFile(counter, "0");
	const fixture = await runnerFixture([process.execPath, "-e", "process.exit(0)"], {
		kind: "runtime",
		resourceProbe: noisyResourceProbe(counter, 1),
	});
	try {
		const started = await fixture.runner.startCheck({ binding: fixture.binding, candidate: fixture.candidate, checkId: "unit" });
		const completed = await waitForTerminal(fixture.runner, started.runId);
		assert.equal(completed.state, "failed");
		assert.equal(completed.failureCode, "RESOURCE_GENERATION_UNKNOWN");
		await assertResourceTokenOnlyHashed(fixture, completed, null);
	} finally {
		await cleanup(fixture);
		await rm(markerRoot, { recursive: true, force: true });
	}
});

test("runtime proof rejects oversized whitespace-prefixed output from the post-check probe", async () => {
	const markerRoot = await mkdtemp(path.join(tmpdir(), "verification-generation-post-overflow-"));
	const counter = path.join(markerRoot, "calls");
	await writeFile(counter, "0");
	const fixture = await runnerFixture([process.execPath, "-e", "process.exit(0)"], {
		kind: "runtime",
		resourceProbe: noisyResourceProbe(counter, 2),
	});
	try {
		const started = await fixture.runner.startCheck({ binding: fixture.binding, candidate: fixture.candidate, checkId: "unit" });
		const completed = await waitForTerminal(fixture.runner, started.runId);
		assert.equal(completed.state, "failed");
		assert.equal(completed.failureCode, "RESOURCE_GENERATION_UNKNOWN");
		const expectedHash = createHash("sha256").update(RESOURCE_TOKEN).digest("hex");
		await assertResourceTokenOnlyHashed(fixture, completed, expectedHash);
	} finally {
		await cleanup(fixture);
		await rm(markerRoot, { recursive: true, force: true });
	}
});

test("completion rejects oversized whitespace-prefixed generation output without persisting the raw token", async () => {
	const markerRoot = await mkdtemp(path.join(tmpdir(), "verification-generation-completion-overflow-"));
	const counter = path.join(markerRoot, "calls");
	await writeFile(counter, "0");
	const fixture = await runnerFixture([process.execPath, "-e", "process.exit(0)"], {
		kind: "runtime",
		resourceProbe: noisyResourceProbe(counter, 3),
	});
	try {
		const started = await fixture.runner.startCheck({ binding: fixture.binding, candidate: fixture.candidate, checkId: "unit" });
		const completed = await waitForTerminal(fixture.runner, started.runId);
		assert.equal(completed.state, "passed");
		const expectedHash = createHash("sha256").update(RESOURCE_TOKEN).digest("hex");
		await assertResourceTokenOnlyHashed(fixture, completed, expectedHash);
		await assert.rejects(
			fixture.runner.verifyCurrentResourceGenerations(fixture.binding, fixture.candidate, [completed]),
			/RESOURCE_GENERATION_UNKNOWN/,
		);
	} finally {
		await cleanup(fixture);
		await rm(markerRoot, { recursive: true, force: true });
	}
});

test("resource probes reject invalid UTF-8 and embedded line breaks", async () => {
	const malformedProbes = [
		[process.execPath, "-e", "process.stdout.write(Buffer.from([0xff]))"],
		[process.execPath, "-e", "process.stdout.write('first-line'+String.fromCharCode(10)+'second-line')"],
	] as const;
	for (const resourceProbe of malformedProbes) {
		const fixture = await runnerFixture([process.execPath, "-e", "process.exit(0)"], { kind: "runtime", resourceProbe });
		try {
			const started = await fixture.runner.startCheck({ binding: fixture.binding, candidate: fixture.candidate, checkId: "unit" });
			const completed = await waitForTerminal(fixture.runner, started.runId);
			assert.equal(completed.state, "failed");
			assert.equal(completed.failureCode, "RESOURCE_GENERATION_UNKNOWN");
		} finally {
			await cleanup(fixture);
		}
	}
});

test("completion runs approved preparation to recreate an excluded probe executable without rerunning the check", async () => {
	const markerRoot = await mkdtemp(path.join(tmpdir(), "verification-completion-preparation-"));
	const checkRuns = path.join(markerRoot, "check-runs");
	const preparationRuns = path.join(markerRoot, "preparation-runs");
	await writeFile(checkRuns, "");
	await writeFile(preparationRuns, "");
	const probeScript = "process.stdout.write('prepared-resource-generation')";
	const preparationCode = `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(preparationRuns)},'x');fs.mkdirSync('build',{recursive:true});fs.writeFileSync('build/resource-probe.js',${JSON.stringify(probeScript)})`;
	const fixture = await runnerFixture(
		[process.execPath, "-e", `require('node:fs').appendFileSync(${JSON.stringify(checkRuns)},'x')`],
		{
			kind: "runtime",
			resourceProbe: [process.execPath, "build/resource-probe.js"],
			preparation: {
				id: "generate-resource-probe",
				argv: [process.execPath, "-e", preparationCode],
				outputs: ["build/**"],
			},
		},
	);
	try {
		const started = await fixture.runner.startCheck({ binding: fixture.binding, candidate: fixture.candidate, checkId: "unit" });
		const completed = await waitForTerminal(fixture.runner, started.runId);
		assert.equal(completed.state, "passed");
		assert.equal(await readFile(checkRuns, "utf8"), "x");
		await fixture.runner.verifyCurrentResourceGenerations(fixture.binding, fixture.candidate, [completed]);
		assert.equal(await readFile(checkRuns, "utf8"), "x");
		assert.equal(await readFile(preparationRuns, "utf8"), "xx");
		assert.equal(
			completed.resourceGeneration,
			createHash("sha256").update("prepared-resource-generation").digest("hex"),
		);
	} finally {
		await cleanup(fixture);
		await rm(markerRoot, { recursive: true, force: true });
	}
});

test("completion refuses a failed approved preparation before probing a resource", async () => {
	const markerRoot = await mkdtemp(path.join(tmpdir(), "verification-completion-preparation-failure-"));
	const preparationRuns = path.join(markerRoot, "preparation-runs");
	await writeFile(preparationRuns, "");
	const probeScript = "process.stdout.write('prepared-resource-generation')";
	const preparationCode = `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(preparationRuns)},'x');if(fs.readFileSync(${JSON.stringify(preparationRuns)},'utf8').length>1)process.exit(7);fs.mkdirSync('build',{recursive:true});fs.writeFileSync('build/resource-probe.js',${JSON.stringify(probeScript)})`;
	const fixture = await runnerFixture([process.execPath, "-e", "process.exit(0)"], {
		kind: "runtime",
		resourceProbe: [process.execPath, "build/resource-probe.js"],
		preparation: { id: "generate-resource-probe", argv: [process.execPath, "-e", preparationCode], outputs: ["build/**"] },
	});
	try {
		const started = await fixture.runner.startCheck({ binding: fixture.binding, candidate: fixture.candidate, checkId: "unit" });
		const completed = await waitForTerminal(fixture.runner, started.runId);
		assert.equal(completed.state, "passed");
		await assert.rejects(
			fixture.runner.verifyCurrentResourceGenerations(fixture.binding, fixture.candidate, [completed]),
			/RESOURCE_PREPARATION_FAILED/,
		);
	} finally {
		await cleanup(fixture);
		await rm(markerRoot, { recursive: true, force: true });
	}
});

test("completion refuses a preparation that mutates approved inputs", async () => {
	const markerRoot = await mkdtemp(path.join(tmpdir(), "verification-completion-preparation-inputs-"));
	const preparationRuns = path.join(markerRoot, "preparation-runs");
	await writeFile(preparationRuns, "");
	const probeScript = "process.stdout.write('prepared-resource-generation')";
	const preparationCode = `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(preparationRuns)},'x');if(fs.readFileSync(${JSON.stringify(preparationRuns)},'utf8').length>1)fs.appendFileSync('src/main.ts','mutated');fs.mkdirSync('build',{recursive:true});fs.writeFileSync('build/resource-probe.js',${JSON.stringify(probeScript)})`;
	const fixture = await runnerFixture([process.execPath, "-e", "process.exit(0)"], {
		kind: "runtime",
		resourceProbe: [process.execPath, "build/resource-probe.js"],
		preparation: { id: "generate-resource-probe", argv: [process.execPath, "-e", preparationCode], outputs: ["build/**"] },
	});
	try {
		const started = await fixture.runner.startCheck({ binding: fixture.binding, candidate: fixture.candidate, checkId: "unit" });
		const completed = await waitForTerminal(fixture.runner, started.runId);
		assert.equal(completed.state, "passed");
		await assert.rejects(
			fixture.runner.verifyCurrentResourceGenerations(fixture.binding, fixture.candidate, [completed]),
			/INPUTS_CHANGED/,
		);
	} finally {
		await cleanup(fixture);
		await rm(markerRoot, { recursive: true, force: true });
	}
});

async function assertProcessGroupTeardown(kind: "cancel" | "timeout" | "interrupt"): Promise<void> {
	const markerRoot = await mkdtemp(path.join(tmpdir(), `verification-descendant-${kind}-`));
	const pidFile = path.join(markerRoot, "descendant-pid");
	const readyFile = path.join(markerRoot, "descendant-ready");
	const fixture = await runnerFixture(processGroupFixtureArgv(pidFile, readyFile), {
		timeoutSeconds: kind === "timeout" ? 1 : 10,
	});
	try {
		const started = await fixture.runner.startCheck({ binding: fixture.binding, candidate: fixture.candidate, checkId: "unit" });
		await waitForFile(readyFile);
		const descendantPid = Number(await readFile(pidFile, "utf8"));
		assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
		let terminal: CheckRunRecord;
		if (kind === "cancel") terminal = await fixture.runner.cancel(started.runId);
		else if (kind === "timeout") terminal = await waitForTerminal(fixture.runner, started.runId);
		else {
			await fixture.runner.interruptAll();
			terminal = await fixture.runner.status(started.runId);
		}
		assert.equal(terminal.state, kind === "cancel" ? "cancelled" : kind === "interrupt" ? "interrupted" : "failed");
		const expectedFailureCode = kind === "timeout" ? "CHECK_TIMEOUT" : kind === "cancel" ? "CANCELLED" : "HOST_INTERRUPTED";
		assert.ok(terminal.failureCode === expectedFailureCode || terminal.failureCode === "PROCESS_GROUP_TEARDOWN_UNKNOWN");
		await waitForProcessExit(descendantPid);
	} finally {
		try {
			await killProcessAtFile(pidFile);
		} finally {
			try {
				await cleanup(fixture);
			} finally {
				await rm(markerRoot, { recursive: true, force: true });
			}
		}
	}
}

const POSIX_PROCESS_GROUP_ONLY = process.platform === "win32"
	? "Windows child-process termination does not provide the POSIX process-group guarantee tested here."
	: false;

test("cancellation escalates to the owned process group after its leader exits", { skip: POSIX_PROCESS_GROUP_ONLY }, async () => {
	await assertProcessGroupTeardown("cancel");
});

test("timeout escalates to the owned process group after its leader exits", { skip: POSIX_PROCESS_GROUP_ONLY }, async () => {
	await assertProcessGroupTeardown("timeout");
});

test("interruption escalates to the owned process group after its leader exits", { skip: POSIX_PROCESS_GROUP_ONLY }, async () => {
	await assertProcessGroupTeardown("interrupt");
});

test("cancellation reports uncertain teardown when POSIX signal-zero observation fails", { skip: POSIX_PROCESS_GROUP_ONLY }, async () => {
	const markerRoot = await mkdtemp(path.join(tmpdir(), "verification-descendant-observation-failure-"));
	const pidFile = path.join(markerRoot, "descendant-pid");
	const readyFile = path.join(markerRoot, "descendant-ready");
	const fixture = await runnerFixture(processGroupFixtureArgv(pidFile, readyFile));
	const originalKill = process.kill;
	const realKill = originalKill.bind(process);
	try {
		const started = await fixture.runner.startCheck({ binding: fixture.binding, candidate: fixture.candidate, checkId: "unit" });
		await waitForFile(readyFile);
		const descendantPid = Number(await readFile(pidFile, "utf8"));
		process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
			if (pid < 0 && signal === 0) throw Object.assign(new Error("injected process-group observation failure"), { code: "EIO" });
			return realKill(pid, signal);
		}) as typeof process.kill;
		const cancelled = await fixture.runner.cancel(started.runId);
		process.kill = originalKill;
		assert.equal(cancelled.state, "cancelled");
		assert.equal(cancelled.failureCode, "PROCESS_GROUP_TEARDOWN_UNKNOWN");
		await waitForProcessExit(descendantPid);
	} finally {
		process.kill = originalKill;
		try {
			await killProcessAtFile(pidFile);
		} finally {
			try {
				await cleanup(fixture);
			} finally {
				await rm(markerRoot, { recursive: true, force: true });
			}
		}
	}
});

test("cancellation settles truthfully when a detached descendant retains an exited leader's pipes", { skip: POSIX_PROCESS_GROUP_ONLY }, async () => {
	const markerRoot = await mkdtemp(path.join(tmpdir(), "verification-retained-pipes-"));
	const pidFile = path.join(markerRoot, "detached-pid");
	const leaderFile = path.join(markerRoot, "leader-pid");
	const descendant = "setInterval(()=>{},1000)";
	const leader = `const fs=require('node:fs');const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:'inherit'});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));fs.writeFileSync(${JSON.stringify(leaderFile)},String(process.pid));child.unref()`;
	const fixture = await runnerFixture([process.execPath, "-e", leader]);
	const deadline = Promise.withResolvers<never>();
	let timer: NodeJS.Timeout | undefined;
	try {
		const started = await fixture.runner.startCheck({ binding: fixture.binding, candidate: fixture.candidate, checkId: "unit" });
		await waitForFile(leaderFile);
		const leaderPid = Number(await readFile(leaderFile, "utf8"));
		await waitForProcessExit(leaderPid);
		timer = setTimeout(() => deadline.reject(new Error("Cancellation waited indefinitely for inherited output pipes.")), 10_000);
		const cancelled = await Promise.race([fixture.runner.cancel(started.runId), deadline.promise]);
		assert.equal(cancelled.state, "cancelled");
		assert.equal(cancelled.failureCode, "PROCESS_GROUP_TEARDOWN_UNKNOWN");
		assert.equal(cancelled.exitCode, 0);
	} finally {
		clearTimeout(timer);
		try {
			await killProcessAtFile(pidFile);
		} finally {
			await cleanup(fixture);
			await rm(markerRoot, { recursive: true, force: true });
		}
	}
});

test("an executable that cannot start fails instead of synthesizing a receipt", async () => {
	const fixture = await runnerFixture(["/definitely-not-a-verification-executable"]);
	try {
		const started = await fixture.runner.startCheck({ binding: fixture.binding, candidate: fixture.candidate, checkId: "unit" });
		const completed = await waitForTerminal(fixture.runner, started.runId);
		assert.equal(completed.state, "failed");
		assert.equal(completed.failureCode, "PROCESS_START_FAILED");
	} finally {
		await cleanup(fixture);
	}
});

test("timeout observes and terminates a still-running child", async () => {
	const fixture = await runnerFixture([process.execPath, "-e", "setInterval(() => {}, 1000)"], { timeoutSeconds: 1 });
	try {
		const started = await fixture.runner.startCheck({ binding: fixture.binding, candidate: fixture.candidate, checkId: "unit" });
		const completed = await waitForTerminal(fixture.runner, started.runId);
		assert.equal(completed.state, "failed");
		assert.ok(completed.failureCode === "CHECK_TIMEOUT" || completed.failureCode === "PROCESS_GROUP_TEARDOWN_UNKNOWN");
	} finally {
		await cleanup(fixture);
	}
});

test("explicit cancellation terminates the owned child and remains cancellation, not pass", async () => {
	const markerRoot = await mkdtemp(path.join(tmpdir(), "verification-child-marker-"));
	const marker = path.join(markerRoot, "started");
	const fixture = await runnerFixture([process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setInterval(() => {}, 1000)`]);
	try {
		const started = await fixture.runner.startCheck({ binding: fixture.binding, candidate: fixture.candidate, checkId: "unit" });
		await waitForFile(marker);
		const cancelled = await fixture.runner.cancel(started.runId);
		assert.equal(cancelled.state, "cancelled");
		assert.ok(cancelled.failureCode === "CANCELLED" || cancelled.failureCode === "PROCESS_GROUP_TEARDOWN_UNKNOWN");
	} finally {
		await cleanup(fixture);
		await rm(markerRoot, { recursive: true, force: true });
	}
});

test("a new runner observes a surviving running record as interrupted rather than passing", async () => {
	const markerRoot = await mkdtemp(path.join(tmpdir(), "verification-interruption-marker-"));
	const marker = path.join(markerRoot, "started");
	const fixture = await runnerFixture([process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setInterval(() => {}, 1000)`]);
	try {
		const started = await fixture.runner.startCheck({ binding: fixture.binding, candidate: fixture.candidate, checkId: "unit" });
		await waitForFile(marker);
		const resumedRunner = new VerificationRunner({ stateDirectory: fixture.stateDirectory });
		const resumed = await resumedRunner.status(started.runId);
		assert.equal(resumed.state, "interrupted");
		assert.equal(resumed.failureCode, "HOST_PROCESS_LOST");
	} finally {
		await cleanup(fixture);
		await rm(markerRoot, { recursive: true, force: true });
	}
});
