import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { loadPolicy, type VerificationCheck, type VerificationPolicy, type VerificationResource } from "./verification-policy.ts";
import { createReceiptStore, listRunRecords, readRunRecord, saveRunLog, saveRunRecord, type CheckRunRecord, type ReceiptStore } from "./verification-receipts.ts";
import { verifyCandidateFresh, type CandidateSnapshot } from "./verification-snapshot.ts";
import { getOutputPatterns, materialize, watchWorkspaceMutations, type ExecutionWorkspace } from "./verification-workspace.ts";
import type { NativeVerificationBinding } from "./verification-bindings.ts";

export interface VerificationRunnerOptions {
	readonly stateDirectory: string;
}

export interface RunCheckInput {
	readonly binding: NativeVerificationBinding;
	readonly candidate: CandidateSnapshot;
	readonly checkId: string;
}

interface ActiveRun {
	readonly controller: AbortController;
	completion: Promise<void>;
	terminalState: "cancelled" | "interrupted" | undefined;
}

interface ProcessOutcome {
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly timedOut: boolean;
	readonly aborted: boolean;
	readonly startFailed: boolean;
	readonly inputMutation?: string;
	readonly output: string;
	readonly captureFailure?: "overflow" | "invalid-encoding" | "stderr-output";
	readonly teardownFailure?: ProcessGroupFailureCode;
}

type ProcessGroupFailureCode = "PROCESS_GROUP_SURVIVED" | "PROCESS_GROUP_TEARDOWN_UNKNOWN";
type ProcessGroupObservation = "terminated" | "terminated-unreaped" | "survived" | "unknown";

class ProcessGroupTeardownError extends Error {
	readonly failureCode: ProcessGroupFailureCode;

	constructor(failureCode: ProcessGroupFailureCode) {
		super(failureCode);
		this.failureCode = failureCode;
	}
}
async function runObservedArgv(
	argv: readonly string[],
	workspace: ExecutionWorkspace,
	outputPatterns: readonly string[],
	timeoutSeconds: number,
	signal: AbortSignal,
	strictResourceOutput = false,
): Promise<ProcessOutcome> {
	const mutationWatch = watchWorkspaceMutations(workspace.root, outputPatterns, workspace.policy);
	try {
		const outcome = await runArgv(
			argv,
			workspace.root,
			workspace.environment,
			timeoutSeconds,
			signal,
			strictResourceOutput ? MAX_RESOURCE_OUTPUT_BYTES : undefined,
		);
		const inputMutation = await mutationWatch.finish();
		return { ...outcome, ...(inputMutation ? { inputMutation } : {}) };
	} catch (error) {
		await mutationWatch.finish();
		throw error;
	}
}
async function readResourceGeneration(
	resource: VerificationResource,
	workspace: ExecutionWorkspace,
	signal: AbortSignal,
): Promise<string> {
	const outcome = await runObservedArgv(resource.argv, workspace, [], resource.timeoutSeconds, signal, true);
	if (outcome.teardownFailure) throw new ProcessGroupTeardownError(outcome.teardownFailure);
	if (outcome.aborted) throw new Error("RESOURCE_GENERATION_ABORTED");
	if (outcome.timedOut || outcome.startFailed || outcome.exitCode !== 0 || outcome.signal !== null || outcome.inputMutation || outcome.captureFailure) {
		throw new Error("RESOURCE_GENERATION_UNKNOWN");
	}
	const token = outcome.output.trim();
	if (!token || /[\u0000-\u001f\u007f-\u009f]/.test(token) || new TextEncoder().encode(token).byteLength > MAX_RESOURCE_OUTPUT_BYTES) {
		throw new Error("RESOURCE_GENERATION_UNKNOWN");
	}
	return createHash("sha256").update(token).digest("hex");
}

interface AttemptOutcome {
	readonly state: "passed" | "failed" | "cancelled" | "interrupted";
	readonly exitCode?: number | null;
	readonly terminationSignal?: string;
	readonly failureCode?: string;
}

const MAX_CAPTURED_OUTPUT_CHARS = 1_000_000;
const MAX_RESOURCE_OUTPUT_BYTES = 4096;
const SECRET_ENVIRONMENT_NAME = /pass(word)?|secret|token|credential|auth|api.?key/i;
const PROCESS_GROUP_OBSERVATION_TIMEOUT_MS = 2_000;
const PROCESS_GROUP_OBSERVATION_INTERVAL_MS = 25;
const MAX_PROCESS_GROUP_INSPECTION_PIDS = 4096;

async function inspectLinuxProcessGroup(groupId: number): Promise<ProcessGroupObservation> {
	let sawMember = false;
	let entries: string[];
	try {
		entries = await readdir("/proc");
	} catch {
		return "unknown";
	}
	let inspected = 0;
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		if (++inspected > MAX_PROCESS_GROUP_INSPECTION_PIDS) return "unknown";
		let stat: string;
		try {
			stat = await readFile(`/proc/${entry}/stat`, "utf8");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ESRCH") continue;
			return "unknown";
		}
		const closingParenthesis = stat.lastIndexOf(")");
		if (closingParenthesis < 0) return "unknown";
		const fields = stat.slice(closingParenthesis + 1).trim().split(/\s+/);
		if (fields.length < 3 || !/^[A-Za-z]$/.test(fields[0] ?? "")) return "unknown";
		if (Number(fields[2]) !== groupId) continue;
		sawMember = true;
		if (fields[0] !== "Z" && fields[0] !== "X" && fields[0] !== "x") return "survived";
	}
	return sawMember ? "terminated-unreaped" : "unknown";
}

async function waitForProcessGroupExit(groupId: number): Promise<ProcessGroupObservation> {
	if (process.platform === "win32") return "unknown";
	const deadline = performance.now() + PROCESS_GROUP_OBSERVATION_TIMEOUT_MS;
	while (performance.now() < deadline) {
		try {
			process.kill(-groupId, 0);
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ESRCH" ? "terminated" : "unknown";
		}
		await delay(PROCESS_GROUP_OBSERVATION_INTERVAL_MS);
	}
	try {
		process.kill(-groupId, 0);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH" ? "terminated" : "unknown";
	}
	// Linux exposes process states, allowing zombie-only groups to be treated as terminated.
	// Other platforms cannot distinguish unreaped processes from live survivors, so report unknown.
	if (process.platform !== "linux") return "unknown";
	const linuxObservation = await inspectLinuxProcessGroup(groupId);
	if (linuxObservation !== "unknown") return linuxObservation;
	try {
		process.kill(-groupId, 0);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH" ? "terminated" : "unknown";
	}
	return "unknown";
}


export class VerificationRunner {
	private readonly storePromise: Promise<ReceiptStore>;
	private readonly activeRuns = new Map<string, ActiveRun>();

	constructor(options: VerificationRunnerOptions) {
		this.storePromise = createReceiptStore(options.stateDirectory);
	}

	async startCheck(input: RunCheckInput): Promise<CheckRunRecord> {
		const { binding, candidate, checkId } = input;
		if (!binding.requiredChecks.includes(checkId)) throw new Error(`Check ${checkId} is not included in the approved verification scope.`);
		if (candidate.id !== binding.candidateId || candidate.repoId !== binding.repoId || candidate.policyDigest !== binding.policyDigest) {
			throw new Error("Candidate identity does not match the approved native binding.");
		}
		const policyResult = await loadPolicy(candidate.repoRoot);
		if (policyResult.status !== "protected" || policyResult.digest !== binding.policyDigest) throw new Error("Verification policy changed or was removed after approval.");
		const check = policyResult.policy.checks[checkId];
		await verifyCandidateFresh(candidate, policyResult.policy);
		const runId = randomUUID();
		const record: CheckRunRecord = {
			version: 1,
			runId,
			bindingId: binding.bindingId,
			attemptId: binding.attemptId,
			candidateId: binding.candidateId,
			repoId: binding.repoId,
			policyDigest: binding.policyDigest,
			profile: binding.profile,
			checkId,
			kind: check.kind,
			resourceGeneration: null,
			state: "running",
			startedAt: new Date().toISOString(),
		};
		const store = await this.storePromise;
		await saveRunRecord(store, record);
		const active: ActiveRun = { controller: new AbortController(), completion: Promise.resolve(), terminalState: undefined };
		this.activeRuns.set(runId, active);
		active.completion = this.executeAttempt(store, active, record, binding, candidate, policyResult.policy, check)
			.catch(async () => {
				try {
					const current = await readRunRecord(store, runId);
					if (current.state === "running") {
						await saveRunRecord(store, { ...current, state: "failed", finishedAt: new Date().toISOString(), failureCode: "RECEIPT_WRITE_FAILED" });
					}
				} catch {
					// A missing durable terminal record is recovered as interrupted, never passed.
				}
			})
			.finally(() => this.activeRuns.delete(runId));
		return record;
	}

	async status(runId: string): Promise<CheckRunRecord> {
		const store = await this.storePromise;
		// A terminal write can finish while this read is pending. Remember local
		// ownership before I/O so a stale running read cannot overwrite that exit.
		const observedActiveRun = this.activeRuns.has(runId);
		const record = await readRunRecord(store, runId);
		if (record.state !== "running" || observedActiveRun) return record;
		return await this.markInterrupted(store, record);
	}

	async cancel(runId: string): Promise<CheckRunRecord> {
		const store = await this.storePromise;
		const record = await readRunRecord(store, runId);
		if (record.state !== "running") return record;
		const active = this.activeRuns.get(runId);
		if (!active) return await this.markInterrupted(store, record);
		active.terminalState = "cancelled";
		active.controller.abort();
		await active.completion;
		return await readRunRecord(store, runId);
	}

	async cancelBinding(bindingId: string): Promise<readonly CheckRunRecord[]> {
		const store = await this.storePromise;
		const records = await listRunRecords(store, bindingId);
		const outcomes: CheckRunRecord[] = [];
		for (const record of records) outcomes.push(record.state === "running" ? await this.cancel(record.runId) : record);
		return outcomes;
	}
	async verifyCurrentResourceGenerations(
		binding: NativeVerificationBinding,
		candidate: CandidateSnapshot,
		receipts: readonly CheckRunRecord[],
	): Promise<void> {
		const policyResult = await loadPolicy(candidate.repoRoot);
		if (policyResult.status !== "protected" || policyResult.digest !== binding.policyDigest) throw new Error("STALE_EVIDENCE: verification policy changed.");
		const expectedByResource = new Map<string, string>();
		const preparations = new Set<string>();
		for (const receipt of receipts) {
			if (receipt.kind !== "runtime") continue;
			if (receipt.bindingId !== binding.bindingId || receipt.attemptId !== binding.attemptId || receipt.candidateId !== binding.candidateId) {
				throw new Error("INVALID_EVIDENCE: runtime receipt identity does not match this binding attempt.");
			}
			const check = policyResult.policy.checks[receipt.checkId];
			const resourceId = check?.resourceId;
			const generation = receipt.resourceGeneration;
			if (!check || check.kind !== "runtime" || !resourceId || !generation || !/^[a-f0-9]{64}$/.test(generation)) {
				throw new Error("RESOURCE_GENERATION_UNKNOWN: runtime receipt has no known resource generation.");
			}
			const previous = expectedByResource.get(resourceId);
			if (previous && previous !== generation) throw new Error("RESOURCE_GENERATION_CHANGED: receipts for one resource use different generations.");
			expectedByResource.set(resourceId, generation);
			for (const preparation of check.preparations) preparations.add(preparation);
		}
		if (expectedByResource.size === 0) return;
		const preparationIds = [...preparations];
		const workspace = await materialize(candidate, binding.profile, { preparationIds });
		try {
			const preparationOutputPatterns = getOutputPatterns(policyResult.policy, preparationIds);
			for (const preparationId of preparationIds) {
				const preparation = policyResult.policy.preparations[preparationId];
				if (!preparation) throw new Error(`RESOURCE_PREPARATION_FAILED: approved prerequisite ${preparationId} is missing.`);
				const prepared = await runObservedArgv(
					preparation.argv,
					workspace,
					preparationOutputPatterns,
					preparation.timeoutSeconds,
					new AbortController().signal,
				);
				if (prepared.teardownFailure) throw new ProcessGroupTeardownError(prepared.teardownFailure);
				if (prepared.aborted || prepared.timedOut || prepared.startFailed || prepared.exitCode !== 0 || prepared.signal !== null) {
					throw new Error(`RESOURCE_PREPARATION_FAILED: approved prerequisite ${preparationId} did not exit successfully.`);
				}
				if (prepared.inputMutation) throw new Error("INPUTS_CHANGED: approved prerequisite changed candidate inputs.");
				try {
					await workspace.verifyInputsUnchanged();
				} catch {
					throw new Error("INPUTS_CHANGED: approved prerequisite changed candidate inputs.");
				}
			}
			for (const [resourceId, expected] of expectedByResource) {
				const resource = policyResult.policy.resources[resourceId];
				if (!resource) throw new Error("RESOURCE_GENERATION_UNKNOWN: configured generation probe is missing.");
				const current = await readResourceGeneration(resource, workspace, new AbortController().signal);
				if (current !== expected) throw new Error(`RESOURCE_GENERATION_CHANGED: resource ${resourceId} changed after its check.`);
			}
			await workspace.verifyInputsUnchanged();
			await verifyCandidateFresh(candidate, policyResult.policy);
		} finally {
			await workspace.cleanup();
		}
	}

	async interruptAll(): Promise<void> {
		const active = [...this.activeRuns.values()];
		for (const run of active) {
			run.terminalState = "interrupted";
			run.controller.abort();
		}
		await Promise.all(active.map((run) => run.completion));
	}

	private async executeAttempt(
		store: ReceiptStore,
		active: ActiveRun,
		record: CheckRunRecord,
		binding: NativeVerificationBinding,
		candidate: CandidateSnapshot,
		policy: VerificationPolicy,
		check: VerificationCheck,
	): Promise<void> {
		let workspace: ExecutionWorkspace | undefined;
		let output = "";
		let secrets = collectSecrets(process.env);
		let resourceGeneration: string | null = null;
		let outcome: AttemptOutcome = { state: "failed", failureCode: "RUNNER_FAILED" };
		let childExitCode: number | null | undefined;
		let childSignal: string | undefined;
		try {
			workspace = await materialize(candidate, binding.profile, { preparationIds: check.preparations });
			secrets = collectSecrets(workspace.environment);
			if (active.controller.signal.aborted) outcome = abortOutcome(active);
			for (const preparationId of check.preparations) {
				if (outcome.failureCode !== "RUNNER_FAILED" || active.controller.signal.aborted) break;
				const preparation = policy.preparations[preparationId];
				if (!preparation) throw new Error("PREPARATION_MISSING");
				const prepared = await runObservedArgv(preparation.argv, workspace, getOutputPatterns(policy, check.preparations), preparation.timeoutSeconds, active.controller.signal);
				output = appendOutput(output, prepared.output);
				childExitCode = prepared.exitCode;
				childSignal = prepared.signal ?? undefined;
				if (prepared.aborted) outcome = abortOutcome(active, prepared);
				else if (prepared.teardownFailure) outcome = { state: "failed", exitCode: prepared.exitCode, terminationSignal: prepared.signal ?? undefined, failureCode: prepared.teardownFailure };
				else if (prepared.timedOut) outcome = { state: "failed", exitCode: prepared.exitCode, terminationSignal: prepared.signal ?? undefined, failureCode: "PREPARATION_TIMEOUT" };
				else if (prepared.startFailed || prepared.exitCode !== 0) outcome = { state: "failed", exitCode: prepared.exitCode, terminationSignal: prepared.signal ?? undefined, failureCode: "PREPARATION_FAILED" };
				else if (prepared.inputMutation) outcome = { state: "failed", exitCode: prepared.exitCode, failureCode: "INPUTS_CHANGED" };
				else {
					try {
						await workspace.verifyInputsUnchanged();
					} catch {
						outcome = { state: "failed", exitCode: prepared.exitCode, failureCode: "INPUTS_CHANGED" };
					}
				}
			}
			if (outcome.failureCode === "RUNNER_FAILED" && !active.controller.signal.aborted && check.kind === "runtime") {
				const resource = check.resourceId ? policy.resources[check.resourceId] : undefined;
				if (!resource) outcome = { state: "failed", failureCode: "RESOURCE_GENERATION_UNKNOWN" };
				else {
					try {
						resourceGeneration = await readResourceGeneration(resource, workspace, active.controller.signal);
						await saveRunRecord(store, { ...record, resourceGeneration });
					} catch (error) {
						const teardownFailure = error instanceof ProcessGroupTeardownError ? error.failureCode : undefined;
						outcome = active.controller.signal.aborted
							? abortOutcome(active, undefined, teardownFailure)
							: { state: "failed", failureCode: teardownFailure ?? "RESOURCE_GENERATION_UNKNOWN" };
					}
				}
			}
			if (outcome.failureCode === "RUNNER_FAILED" && !active.controller.signal.aborted) {
				const result = await runObservedArgv(check.argv, workspace, getOutputPatterns(policy, check.preparations), check.timeoutSeconds, active.controller.signal);
				output = appendOutput(output, result.output);
				childExitCode = result.exitCode;
				childSignal = result.signal ?? undefined;
				let afterGeneration: string | undefined;
				let generationFailure: "RESOURCE_GENERATION_UNKNOWN" | "RESOURCE_GENERATION_CHANGED" | ProcessGroupFailureCode | undefined;
				let generationTeardownFailure: ProcessGroupFailureCode | undefined;
				if (check.kind === "runtime" && !result.aborted) {
					try {
						const resourceId = check.resourceId;
						const resource = resourceId ? policy.resources[resourceId] : undefined;
						if (!resource) throw new Error("RESOURCE_GENERATION_UNKNOWN");
						afterGeneration = await readResourceGeneration(resource, workspace, active.controller.signal);
						if (resourceGeneration !== afterGeneration) generationFailure = "RESOURCE_GENERATION_CHANGED";
					} catch (error) {
						generationTeardownFailure = error instanceof ProcessGroupTeardownError ? error.failureCode : undefined;
						generationFailure = active.controller.signal.aborted ? undefined : generationTeardownFailure ?? "RESOURCE_GENERATION_UNKNOWN";
					}
				}
				if (result.aborted) outcome = abortOutcome(active, result);
				else if (active.controller.signal.aborted) outcome = abortOutcome(active, undefined, generationTeardownFailure);
				else if (result.teardownFailure) outcome = { state: "failed", exitCode: result.exitCode, terminationSignal: result.signal ?? undefined, failureCode: result.teardownFailure };
				else if (generationTeardownFailure) outcome = { state: "failed", exitCode: result.exitCode, failureCode: generationTeardownFailure };
				else if (result.timedOut) outcome = { state: "failed", exitCode: result.exitCode, terminationSignal: result.signal ?? undefined, failureCode: "CHECK_TIMEOUT" };
				else if (result.startFailed) outcome = { state: "failed", exitCode: null, failureCode: "PROCESS_START_FAILED" };
				else if (result.exitCode !== 0 || result.signal !== null) outcome = { state: "failed", exitCode: result.exitCode, terminationSignal: result.signal ?? undefined, failureCode: "NONZERO_EXIT" };
				else if (result.inputMutation) outcome = { state: "failed", exitCode: result.exitCode, failureCode: "INPUTS_CHANGED" };
				else if (generationFailure) outcome = { state: "failed", exitCode: result.exitCode, failureCode: generationFailure };
				else {
					try {
						await workspace.verifyInputsUnchanged();
						await verifyCandidateFresh(candidate, policy);
						outcome = { state: "passed", exitCode: 0 };
					} catch {
						outcome = { state: "failed", exitCode: result.exitCode, failureCode: "INPUTS_CHANGED" };
					}
				}
			}
		} catch (error) {
			const teardownFailure = error instanceof ProcessGroupTeardownError ? error.failureCode : undefined;
			outcome = active.controller.signal.aborted
				? abortOutcome(active, undefined, teardownFailure)
				: { state: "failed", exitCode: childExitCode, terminationSignal: childSignal, failureCode: teardownFailure ?? "WORKSPACE_PREPARATION_FAILED" };
		} finally {
			if (workspace) {
				try {
					await workspace.cleanup();
				} catch {
					const teardownFailure = outcome.failureCode === "PROCESS_GROUP_SURVIVED" || outcome.failureCode === "PROCESS_GROUP_TEARDOWN_UNKNOWN"
						? outcome.failureCode
						: "WORKSPACE_CLEANUP_FAILED";
					outcome = { state: "failed", exitCode: childExitCode, terminationSignal: childSignal, failureCode: teardownFailure };
				}
			}
		}
		const logPath = await saveRunLog(store, record.runId, redact(output, secrets));
		if (active.controller.signal.aborted && outcome.state === "passed") outcome = abortOutcome(active);
		const finished: CheckRunRecord = {
			...record,
			resourceGeneration,
			state: outcome.state,
			finishedAt: new Date().toISOString(),
			...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
			...(outcome.terminationSignal ? { terminationSignal: outcome.terminationSignal } : {}),
			...(outcome.failureCode ? { failureCode: outcome.failureCode } : {}),
			logPath,
		};
		await saveRunRecord(store, finished);
	}

	private async markInterrupted(store: ReceiptStore, record: CheckRunRecord): Promise<CheckRunRecord> {
		const interrupted: CheckRunRecord = { ...record, state: "interrupted", finishedAt: new Date().toISOString(), failureCode: "HOST_PROCESS_LOST" };
		await saveRunRecord(store, interrupted);
		return interrupted;
	}
}

async function runArgv(
	argv: readonly string[],
	cwd: string,
	environment: Record<string, string | undefined>,
	timeoutSeconds: number,
	signal: AbortSignal,
	maxOutputBytes?: number,
): Promise<ProcessOutcome> {
	if (signal.aborted) return { exitCode: null, signal: null, timedOut: false, aborted: true, startFailed: false, output: "" };
	const { promise, resolve } = Promise.withResolvers<ProcessOutcome>();
	let output = "";
	let outputBytes = 0;
	let captureFailure: ProcessOutcome["captureFailure"];
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	let killHandle: ReturnType<typeof setTimeout> | undefined;
	let settled = false;
	let teardownPending = false;
	let pendingOutcome: ProcessOutcome | undefined;
	let teardownFailure: ProcessGroupFailureCode | undefined;
	let timedOut = false;
	let aborted = false;
	let startFailed = false;
	let childSignal: string | null = null;
	let childExitCode: number | null = null;
	let killRequested = false;
	let capturedOutput: Pick<ProcessOutcome, "output" | "captureFailure"> | undefined;
	const strictCapture = maxOutputBytes !== undefined;
	const outputByteLimit = maxOutputBytes ?? 0;
	const child = spawn(argv[0] ?? "", [...argv.slice(1)], {
		cwd,
		env: environment,
		shell: false,
		windowsHide: true,
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const stdoutDecoder = new TextDecoder("utf-8", { fatal: strictCapture });
	const stderrDecoder = new TextDecoder("utf-8", { fatal: strictCapture });
	const capture = (chunk: Uint8Array, decoder: TextDecoder, stderr: boolean) => {
		if (strictCapture) {
			outputBytes += chunk.byteLength;
			if (stderr && chunk.byteLength > 0) captureFailure ??= "stderr-output";
			if (outputBytes > outputByteLimit) captureFailure ??= "overflow";
			if (captureFailure) return;
			try {
				output += decoder.decode(chunk, { stream: true });
			} catch {
				output = "";
				captureFailure = "invalid-encoding";
			}
			return;
		}
		output = appendOutput(output, decoder.decode(chunk, { stream: true }));
	};
	const finishCapture = (): Pick<ProcessOutcome, "output" | "captureFailure"> => {
		if (capturedOutput) return capturedOutput;
		if (strictCapture) {
			if (!captureFailure) {
				try {
					output += stdoutDecoder.decode();
					if (stderrDecoder.decode()) captureFailure = "stderr-output";
				} catch {
					captureFailure = "invalid-encoding";
					output = "";
				}
			}
			capturedOutput = { output, ...(captureFailure ? { captureFailure } : {}) };
			return capturedOutput;
		}
		capturedOutput = { output: output + stdoutDecoder.decode() + stderrDecoder.decode() };
		return capturedOutput;
	};
	child.stdout?.on("data", (chunk: Uint8Array) => capture(chunk, stdoutDecoder, false));
	child.stderr?.on("data", (chunk: Uint8Array) => capture(chunk, stderrDecoder, true));
	const signalOwnedProcess = (termination: NodeJS.Signals, pid: number) => {
		if (process.platform !== "win32") {
			try {
				process.kill(-pid, termination);
				return;
			} catch {
				// Fall back to the leader if the process group is already unavailable.
			}
		}
		try {
			child.kill(termination);
		} catch {
			// The child may have exited between the process-group signal and fallback.
		}
	};
	const finishTeardown = (observation: ProcessGroupObservation) => {
		if (observation === "survived") teardownFailure = "PROCESS_GROUP_SURVIVED";
		else if (observation === "unknown") teardownFailure = "PROCESS_GROUP_TEARDOWN_UNKNOWN";
		teardownPending = false;
		if (pendingOutcome) {
			finish(pendingOutcome);
			return;
		}
		// An exited leader's detached descendant can retain its pipes forever.
		// Absence of close is uncertainty, not evidence of successful cleanup.
		teardownFailure ??= "PROCESS_GROUP_TEARDOWN_UNKNOWN";
		const captured = finishCapture();
		child.stdout?.destroy();
		child.stderr?.destroy();
		child.unref();
		finish({ exitCode: child.exitCode ?? null, signal: child.signalCode ?? null, timedOut, aborted, startFailed, ...captured });
	};
	const killOwnedProcess = () => {
		if (killRequested) return;
		killRequested = true;
		clearTimeout(timeoutHandle);
		timeoutHandle = undefined;
		const pid = child.pid;
		if (pid === undefined) return;
		teardownPending = true;
		signalOwnedProcess("SIGTERM", pid);
		killHandle = setTimeout(() => {
			signalOwnedProcess("SIGKILL", pid);
			killHandle = undefined;
			void waitForProcessGroupExit(pid).then(finishTeardown, () => finishTeardown("unknown"));
		}, 1000);
	};
	const finish = (processOutcome: ProcessOutcome) => {
		if (settled) return;
		const observedOutcome = teardownFailure ? { ...processOutcome, teardownFailure } : processOutcome;
		if (teardownPending) {
			pendingOutcome = observedOutcome;
			return;
		}
		settled = true;
		clearTimeout(timeoutHandle);
		clearTimeout(killHandle);
		signal.removeEventListener("abort", onAbort);
		resolve(observedOutcome);
	};
	const onAbort = () => {
		aborted = true;
		killOwnedProcess();
	};
	child.once("error", () => {
		startFailed = true;
		finish({
			exitCode: null,
			signal: null,
			timedOut,
			aborted,
			startFailed,
			...finishCapture(),
		});
	});
	child.once("close", (code: number | null, termination: string | null) => {
		childExitCode = code;
		childSignal = termination;
		finish({
			exitCode: childExitCode,
			signal: childSignal,
			timedOut,
			aborted,
			startFailed,
			...finishCapture(),
		});
	});
	signal.addEventListener("abort", onAbort, { once: true });
	timeoutHandle = setTimeout(() => {
		timedOut = true;
		killOwnedProcess();
	}, timeoutSeconds * 1000);
	if (signal.aborted) onAbort();
	return promise;
}

function abortOutcome(
	active: ActiveRun,
	child?: ProcessOutcome,
	teardownFailure?: ProcessGroupFailureCode,
): AttemptOutcome {
	return {
		state: active.terminalState ?? "cancelled",
		exitCode: child?.exitCode ?? null,
		...(child?.signal ? { terminationSignal: child.signal } : {}),
		failureCode: teardownFailure ?? child?.teardownFailure ?? (active.terminalState === "interrupted" ? "HOST_INTERRUPTED" : "CANCELLED"),
	};
}

function appendOutput(current: string, next: string): string {
	if (next.length >= MAX_CAPTURED_OUTPUT_CHARS) return next.slice(-MAX_CAPTURED_OUTPUT_CHARS);
	const currentLimit = MAX_CAPTURED_OUTPUT_CHARS - next.length;
	const retainedCurrent = current.length > currentLimit ? current.slice(-currentLimit) : current;
	return retainedCurrent + next;
}

function collectSecrets(environment: Record<string, string | undefined>): readonly string[] {
	const secrets: string[] = [];
	for (const [name, value] of Object.entries(environment)) {
		if (SECRET_ENVIRONMENT_NAME.test(name) && typeof value === "string" && value.length >= 4) secrets.push(value);
	}
	return secrets.sort((left, right) => right.length - left.length);
}

function redact(value: string, secrets: readonly string[]): string {
	let redacted = value;
	for (const secret of secrets) redacted = redacted.replaceAll(secret, "[REDACTED]");
	return redacted;
}
