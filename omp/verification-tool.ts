import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { requestUserApproval } from "./verification-approval.ts";
import {
	BINDING_CUSTOM_TYPE,
	activeBranchAnchor,
	appendBindingEvent,
	appendCancellationEvent,
	appendCertificationEvent,
	appendRunEvent,
	createBindingEvent,
	nativeSessionIdentity,
	resolveScopeArtifact,
	restoreBindingState,
	restoreBindingStates,
	type NativeBindingState,
	type NativeBranchEntry,
	type NativeVerificationBinding,
} from "./verification-bindings.ts";
import { validateCertifiedCompletion, validateEvidence, type EvidenceDecision } from "./verification-gate.ts";
import { loadPolicy, requiredChecks } from "./verification-policy.ts";
import { createReceiptStore, readRunRecord, type CheckRunRecord, type ReceiptStore } from "./verification-receipts.ts";
import { captureCandidate, defaultVerificationStateDirectory, loadCandidateSnapshot, removeCandidate, repositoryIdentity, verifyCandidateFresh, git } from "./verification-snapshot.ts";
import { VerificationRunner } from "./verification-runner.ts";
import { latestTodoSnapshot, type NativeTodoGateContext } from "./native-todo-gate.ts";

export const VERIFICATION_OPERATIONS = ["begin", "run", "status", "complete", "cancel"] as const;
export type VerificationOperation = (typeof VERIFICATION_OPERATIONS)[number];

export type VerificationRequest =
	| { readonly op: "begin"; readonly workId: string; readonly item: string; readonly scopeArtifact: string; readonly profile?: string; readonly additionalChecks?: readonly string[] }
	| { readonly op: "run"; readonly workId: string; readonly checkId: string }
	| { readonly op: "status"; readonly workId: string }
	| { readonly op: "complete"; readonly workId: string }
	| { readonly op: "cancel"; readonly workId: string };

export interface VerificationHostContext extends NativeTodoGateContext {
	readonly cwd: string;
	readonly hasUI: boolean;
	readonly ui: {
		confirm(title: string, message: string): Promise<boolean>;
		notify(message: string, level: "info" | "warning" | "error"): void;
	};
}

export interface VerificationToolResponse {
	readonly content: { readonly type: "text"; readonly text: string }[];
	readonly details: Record<string, string | number | boolean | readonly string[]>;
	readonly isError?: boolean;
}

export interface VerificationServiceOptions {
	readonly stateDirectory?: string;
}

const REQUEST_KEYS = ["op", "workId", "item", "scopeArtifact", "profile", "additionalChecks", "checkId"];
const WORK_ID = /^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,127}$/u;
const CHECK_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/;

export class VerificationService {
	readonly stateDirectory: string;
	readonly runner: VerificationRunner;
	private readonly appendEntry: (customType: string, data: unknown) => void | Promise<void>;

	constructor(api: { readonly appendEntry: (customType: string, data: unknown) => void | Promise<void> }, options: VerificationServiceOptions = {}) {
		this.appendEntry = api.appendEntry;
		this.stateDirectory = path.resolve(options.stateDirectory ?? defaultVerificationStateDirectory());
		this.runner = new VerificationRunner({ stateDirectory: this.stateDirectory });
	}

	async executeUnknown(value: unknown, context: VerificationHostContext): Promise<VerificationToolResponse> {
		try {
			return await this.execute(parseVerificationRequest(value), context);
		} catch (error) {
			return failure("VERIFICATION_FAILED", errorMessage(error));
		}
	}

	async execute(request: VerificationRequest, context: VerificationHostContext): Promise<VerificationToolResponse> {
		try {
			if (context.agent?.kind === "sub") throw new Error("Native verification is owned by the main session; subagents cannot bind or certify todo work.");
			switch (request.op) {
				case "begin": return await this.begin(request, context);
				case "run": return await this.run(request, context);
				case "status": return await this.status(request, context);
				case "complete": return await this.complete(request, context);
				case "cancel": return await this.cancel(request, context);
			}
		} catch (error) {
			return failure("VERIFICATION_FAILED", errorMessage(error), request.op, request.workId);
		}
	}

	async bindingStates(context: NativeTodoGateContext): Promise<readonly NativeBindingState[]> {
		const branch = context.sessionManager.getBranch();
		if (!branch.some((entry) => entry.type === "custom" && entry.customType === BINDING_CUSTOM_TYPE)) return [];
		const ownerSessionHash = await nativeSessionIdentity(context.sessionManager.getSessionFile());
		return restoreBindingStates(branch, ownerSessionHash);
	}

	async validateBindingState(state: NativeBindingState, context: NativeTodoGateContext): Promise<EvidenceDecision> {
		if (state.isCancelled) return { allowed: false, code: "CANCELLED", reason: "The native verification binding was cancelled." };
		if (!state.certification) return { allowed: false, code: "MISSING_EVIDENCE", reason: "No native completion certification exists for this todo item." };
		try {
			await this.assertBindingScopeMatches(context, state.binding);
			const candidate = await loadCandidateSnapshot(this.stateDirectory, state.binding.snapshotRef);
			const store = await createReceiptStore(this.stateDirectory);
			const receipts = await readReferencedReceipts(store, state.runIds);
			await this.runner.verifyCurrentResourceGenerations(state.binding, candidate, receipts);
			const decision = await validateCertifiedCompletion(state.binding, state, candidate, receipts);
			await this.assertBindingScopeMatches(context, state.binding);
			return decision;
		} catch (error) {
			return { allowed: false, code: "STALE_EVIDENCE", reason: errorMessage(error) };
		}
	}

	private async begin(request: Extract<VerificationRequest, { op: "begin" }>, context: VerificationHostContext): Promise<VerificationToolResponse> {
		const repositoryRoot = await realpath(git(context.cwd, ["rev-parse", "--show-toplevel"]).trim());
		const policyResult = await loadPolicy(repositoryRoot);
		if (policyResult.status === "unprotected") throw new Error("This repository has no .omp/verification.json policy; verification remains unprotected and no binding was created.");
		if (policyResult.status === "refused") throw new Error(`${policyResult.code}: ${policyResult.reason}`);
		const profile = request.profile ?? policyResult.policy.minimumProfile;
		const additionalChecks = request.additionalChecks ?? [];
		const ownerSessionFile = context.sessionManager.getSessionFile();
		const ownerSessionHash = await nativeSessionIdentity(ownerSessionFile);
		const branch = context.sessionManager.getBranch();
		const branchAnchorId = activeBranchAnchor(branch);
		const todo = latestTodoSnapshot(branch);
		if (!todo) throw new Error("Native todo state is unknown. Read the current todo view before binding verification.");
		const matchingItems = todo.phases.flatMap((phase) => phase.tasks).filter((task) => task.content === request.item);
		if (matchingItems.length !== 1 || matchingItems[0]?.status === "completed" || matchingItems[0]?.status === "abandoned") {
			throw new Error("begin requires one exact, unfinished native todo item on the active branch.");
		}
		const existing = restoreBindingState(branch, ownerSessionHash, request.workId);
		const liveItemBinding = restoreBindingStates(branch, ownerSessionHash).find((state) => !state.isCancelled && state.binding.item === request.item && state.binding.workId !== request.workId);
		if (liveItemBinding) throw new Error(`This todo item already has active verification under ${liveItemBinding.binding.workId}; use that work ID or explicitly cancel it first.`);
		const candidate = await captureCandidate(repositoryRoot, policyResult.policy, { stateDirectory: this.stateDirectory });
		let bindingWritten = false;
		try {
			if (candidate.policyDigest !== policyResult.digest) throw new Error("Repository policy changed while capturing the candidate.");
			const scope = await resolveScopeArtifact(request.scopeArtifact, { repositoryRoot, sessionFile: ownerSessionFile });
			const mandatoryChecks = requiredChecks(policyResult.policy, { profile, additionalChecks }, candidate.changedPaths);
			const approvedCommands = mandatoryChecks.map((id) => {
				const check = policyResult.policy.checks[id];
				if (!check) throw new Error(`Mandatory check ${id} is missing from policy.`);
				const preparations = check.preparations.map((preparationId) => {
					const preparation = policyResult.policy.preparations[preparationId];
					if (!preparation) throw new Error(`Preparation ${preparationId} is missing from policy.`);
					return { id: preparationId, argv: preparation.argv };
				});
				const resource = check.resourceId ? policyResult.policy.resources[check.resourceId] : undefined;
				if (check.kind === "runtime" && !resource) throw new Error(`Runtime check ${id} has no configured resource generation probe.`);
				return { id, kind: check.kind, argv: check.argv, preparations, ...(resource && check.resourceId ? { resource: { id: check.resourceId, argv: resource.argv } } : {}) };
			});
			const approval = await requestUserApproval(
				{ hasUI: context.hasUI, confirm: (title, message) => context.ui.confirm(title, message) },
				{
					title: existing ? "Approve native verification rebind" : "Approve native verification scope",
					workId: request.workId,
					item: request.item,
					repository: repositoryRoot,
					policyDigest: policyResult.digest,
					scopeArtifact: scope.reference,
					scopeDigest: scope.digest,
					scopeText: scope.text,
					profile,
					checks: mandatoryChecks,
					commands: approvedCommands,
					changedPaths: candidate.changedPaths,
				},
			);
			if (!approval.allowed) throw new Error(approval.reason);
			const nextPolicy = await loadPolicy(repositoryRoot);
			if (nextPolicy.status !== "protected" || nextPolicy.digest !== candidate.policyDigest) throw new Error("Verification policy changed during user approval.");
			const scopeAfterApproval = await resolveScopeArtifact(request.scopeArtifact, { repositoryRoot, sessionFile: ownerSessionFile });
			if (scopeAfterApproval.digest !== scope.digest) throw new Error("Scope artifact changed during user approval.");
			await verifyCandidateFresh(candidate, nextPolicy.policy);
			const branchAfterApproval = context.sessionManager.getBranch();
			if (activeBranchAnchor(branchAfterApproval) !== branchAnchorId) throw new Error("The active native branch changed during user approval; read todo view and approve again.");
			const sessionAfterApproval = await nativeSessionIdentity(context.sessionManager.getSessionFile());
			if (sessionAfterApproval !== ownerSessionHash) throw new Error("The owner native session changed during user approval.");
			const todoAfterApproval = latestTodoSnapshot(branchAfterApproval);
			const currentItem = todoAfterApproval?.phases.flatMap((phase) => phase.tasks).filter((task) => task.content === request.item) ?? [];
			if (currentItem.length !== 1 || currentItem[0]?.status === "completed" || currentItem[0]?.status === "abandoned") throw new Error("The approved native todo item changed during user approval.");
			const binding: NativeVerificationBinding = {
				version: 1,
				bindingId: randomUUID(),
				workId: request.workId,
				item: request.item,
				ownerSessionHash,
				branchAnchorId,
				repoId: candidate.repoId,
				policyDigest: candidate.policyDigest,
				scopeArtifact: scope.reference,
				scopeDigest: scope.digest,
				profile,
				additionalChecks,
				requiredChecks: mandatoryChecks,
				candidateId: candidate.id,
				snapshotRef: path.basename(candidate.storageDirectory),
				attemptId: randomUUID(),
				createdAt: new Date().toISOString(),
			};
			await appendBindingEvent({ appendEntry: this.appendEntry }, createBindingEvent(binding));
			bindingWritten = true;
			if (existing) {
				await this.runner.cancelBinding(existing.binding.bindingId);
				await this.removeCandidateForBinding(existing.binding);
			}
			return success(request.op, request.workId, `Verification scope approved and bound to the exact native todo item. Required checks: ${mandatoryChecks.join(", ")}. No todo status was changed.`, { bindingId: binding.bindingId, candidateId: binding.candidateId, requiredChecks: mandatoryChecks });
		} finally {
			if (!bindingWritten) await removeCandidate(candidate);
		}
	}

	private async run(request: Extract<VerificationRequest, { op: "run" }>, context: VerificationHostContext): Promise<VerificationToolResponse> {
		const { state } = await this.currentBinding(context, request.workId);
		if (!state) throw new Error(`No native verification binding exists for ${request.workId}; begin must receive user approval first.`);
		if (state.isCancelled) throw new Error("This verification binding was cancelled; begin a newly approved scope before running checks.");
		await this.assertBindingScopeMatches(context, state.binding);
		const candidate = await loadCandidateSnapshot(this.stateDirectory, state.binding.snapshotRef);
		const record = await this.runner.startCheck({ binding: state.binding, candidate, checkId: request.checkId });
		const refreshed = await this.currentBinding(context, request.workId);
		if (refreshed.state?.binding.bindingId !== state.binding.bindingId) {
			await this.runner.cancel(record.runId);
			throw new Error("The active native branch or binding changed while starting the check.");
		}
		try {
			await appendRunEvent({ appendEntry: this.appendEntry }, state.binding, record.runId, record.checkId);
		} catch (error) {
			await this.runner.cancel(record.runId);
			throw error;
		}
		return success(request.op, request.workId, `Started approved check ${record.checkId}. Use verification status for its observed process outcome.`, { runId: record.runId, checkId: record.checkId, state: record.state });
	}

	private async status(request: Extract<VerificationRequest, { op: "status" }>, context: VerificationHostContext): Promise<VerificationToolResponse> {
		const { state } = await this.currentBinding(context, request.workId);
		if (!state) throw new Error(`No native verification binding exists for ${request.workId}.`);
		const records: CheckRunRecord[] = [];
		for (const runId of state.runIds) records.push(await this.runner.status(runId));
		let freshness = "fresh";
		if (!state.isCancelled) {
			try {
				await this.assertBindingScopeMatches(context, state.binding);
				const candidate = await loadCandidateSnapshot(this.stateDirectory, state.binding.snapshotRef);
				await verifyCandidateFresh(candidate);
			} catch {
				freshness = "stale";
			}
		}
		const summary = records.length === 0 ? "No verification checks have been run." : records.map((record) => `${record.checkId}: ${record.state}${record.exitCode === undefined ? "" : ` (exit ${record.exitCode})`}${record.failureCode ? ` [${record.failureCode}]` : ""}`).join("\n");
		const certificateText = state.certification ? `Certified receipt digest: ${state.certification.evidenceDigest}` : "No completion certification is recorded.";
		return success(request.op, request.workId, `Verification evidence: ${freshness}${state.isCancelled ? "; cancelled" : ""}.\n${summary}\n${certificateText}`, { freshness, isCancelled: state.isCancelled, runIds: state.runIds });
	}

	private async complete(request: Extract<VerificationRequest, { op: "complete" }>, context: VerificationHostContext): Promise<VerificationToolResponse> {
		const { state } = await this.currentBinding(context, request.workId);
		if (!state) throw new Error(`No native verification binding exists for ${request.workId}.`);
		if (state.isCancelled) throw new Error("Cancelled verification cannot certify native todo completion.");
		await this.assertBindingScopeMatches(context, state.binding);
		const candidate = await loadCandidateSnapshot(this.stateDirectory, state.binding.snapshotRef);
		const store = await createReceiptStore(this.stateDirectory);
		const receipts = await readReferencedReceipts(store, state.runIds);
		await this.runner.verifyCurrentResourceGenerations(state.binding, candidate, receipts);
		const decision = await validateEvidence(state.binding, candidate, state.runIds, receipts);
		if (!decision.allowed) throw new Error(`${decision.code}: ${decision.reason}`);
		await this.assertBindingScopeMatches(context, state.binding);
		if (state.certification?.evidenceDigest === decision.evidenceDigest) {
			return success(request.op, request.workId, "Current evidence is already certified. Native todo progress was not changed.", { evidenceDigest: decision.evidenceDigest, receiptIds: decision.receiptIds });
		}
		const refreshed = await this.currentBinding(context, request.workId);
		if (refreshed.state?.binding.bindingId !== state.binding.bindingId) throw new Error("The active native branch or binding changed before certification.");
		await appendCertificationEvent({ appendEntry: this.appendEntry }, state.binding, decision.receiptIds, decision.evidenceDigest);
		return success(request.op, request.workId, "Fresh verification evidence was certified on the active native branch. Native todo remains the only progress source.", { evidenceDigest: decision.evidenceDigest, receiptIds: decision.receiptIds });
	}

	private async cancel(request: Extract<VerificationRequest, { op: "cancel" }>, context: VerificationHostContext): Promise<VerificationToolResponse> {
		const { state } = await this.currentBinding(context, request.workId);
		if (!state) throw new Error(`No native verification binding exists for ${request.workId}.`);
		if (!context.hasUI) throw new Error("Verification cancellation requires an interactive user-facing confirmation.");
		const confirmed = await context.ui.confirm("Cancel native verification", `Cancel verification for ${state.binding.item}? This requests termination of its current attempt, reports uncertain cleanup, and does not mark the native todo complete.`);
		if (!confirmed) throw new Error("The user declined verification cancellation.");
		const refreshed = await this.currentBinding(context, request.workId);
		if (refreshed.state?.binding.bindingId !== state.binding.bindingId) throw new Error("The active native branch or binding changed before cancellation.");
		const runRecords = await this.runner.cancelBinding(state.binding.bindingId);
		await appendCancellationEvent({ appendEntry: this.appendEntry }, state.binding);
		await this.removeCandidateForBinding(state.binding);
		const uncertainRuns: string[] = [];
		for (const record of runRecords) {
			if (record.failureCode === "PROCESS_GROUP_SURVIVED" || record.failureCode === "PROCESS_GROUP_TEARDOWN_UNKNOWN") uncertainRuns.push(record.runId);
		}
		if (uncertainRuns.length > 0) {
			return failure("PROCESS_GROUP_TEARDOWN_UNCONFIRMED", `Cancellation was recorded, but owned-process cleanup could not be confirmed for runs ${uncertainRuns.join(", ")}. Inspect verification status; resources may still be active. This is not passing evidence.`, request.op, request.workId);
		}
		return success(request.op, request.workId, "Verification was cancelled. This is not passing evidence and does not complete the native todo.", { cancelledRuns: runRecords.map((record) => record.runId) });
	}

	private async assertBindingScopeMatches(context: NativeTodoGateContext, binding: NativeVerificationBinding): Promise<void> {
		if (!context.cwd) throw new Error("The current session working directory is unavailable.");
		const root = await realpath(git(context.cwd, ["rev-parse", "--show-toplevel"]).trim());
		const repositoryId = await repositoryIdentity(root);
		if (repositoryId !== binding.repoId) throw new Error("Verification binding belongs to a different repository or Git worktree; rebind through user approval.");
		const scope = await resolveScopeArtifact(binding.scopeArtifact, {
			repositoryRoot: root,
			sessionFile: context.sessionManager.getSessionFile(),
		});
		if (scope.digest !== binding.scopeDigest) throw new Error("The approved scope artifact changed; begin a newly approved binding before running or completing verification.");
	}

	private async currentBinding(context: VerificationHostContext, workId: string): Promise<{ readonly branch: readonly NativeBranchEntry[]; readonly ownerSessionHash: string; readonly state: NativeBindingState | undefined }> {
		const branch = context.sessionManager.getBranch();
		const ownerSessionHash = await nativeSessionIdentity(context.sessionManager.getSessionFile());
		const state = restoreBindingState(branch, ownerSessionHash, workId);
		return { branch, ownerSessionHash, state };
	}

	private async removeCandidateForBinding(binding: NativeVerificationBinding): Promise<void> {
		try {
			const candidate = await loadCandidateSnapshot(this.stateDirectory, binding.snapshotRef);
			await removeCandidate(candidate);
		} catch {
			// A missing or already-cleaned private snapshot cannot create passing evidence.
		}
	}
}

export function parseVerificationRequest(value: unknown): VerificationRequest {
	const record = asRecord(value);
	if (!record) throw new Error("Verification arguments must be a flat object.");
	for (const key of Object.keys(record)) if (!REQUEST_KEYS.includes(key)) throw new Error(`Unknown verification argument: ${key}`);
	if (typeof record.op !== "string" || !(VERIFICATION_OPERATIONS as readonly string[]).includes(record.op)) throw new Error("op must be begin, run, status, complete, or cancel.");
	const op = record.op as VerificationOperation;
	if (typeof record.workId !== "string" || !WORK_ID.test(record.workId)) throw new Error("workId must be a non-empty stable native-work label.");
	if (op === "begin") {
		if (typeof record.item !== "string" || record.item.length === 0 || record.item.length > 2048) throw new Error("begin requires the exact native todo item in item.");
		if (typeof record.scopeArtifact !== "string" || record.scopeArtifact.length === 0 || record.scopeArtifact.length > 1024) throw new Error("begin requires a repository or owner-session scopeArtifact path.");
		if (record.profile !== undefined && (typeof record.profile !== "string" || !CHECK_ID.test(record.profile))) throw new Error("profile must name a verification profile.");
		if (record.additionalChecks !== undefined && (!Array.isArray(record.additionalChecks) || !record.additionalChecks.every((check) => typeof check === "string" && CHECK_ID.test(check)))) throw new Error("additionalChecks must contain named check ids only.");
		if (Array.isArray(record.additionalChecks) && new Set(record.additionalChecks).size !== record.additionalChecks.length) throw new Error("additionalChecks cannot contain duplicate check ids.");
		if (record.checkId !== undefined) throw new Error("begin does not accept checkId.");
		return {
			op: "begin",
			workId: record.workId,
			item: record.item,
			scopeArtifact: record.scopeArtifact,
			...(typeof record.profile === "string" ? { profile: record.profile } : {}),
			...(Array.isArray(record.additionalChecks) ? { additionalChecks: record.additionalChecks as string[] } : {}),
		};
	}
	if (record.item !== undefined || record.scopeArtifact !== undefined || record.profile !== undefined || record.additionalChecks !== undefined) throw new Error(`${op} does not accept scope-approval fields.`);
	if (op === "run") {
		if (typeof record.checkId !== "string" || !CHECK_ID.test(record.checkId)) throw new Error("run requires a named checkId.");
		return { op: "run", workId: record.workId, checkId: record.checkId };
	}
	if (record.checkId !== undefined) throw new Error(`${op} does not accept checkId.`);
	return { op, workId: record.workId };
}

export function parseVerificationCommand(args: string): VerificationRequest {
	const tokens = tokenizeCommand(args);
	const op = tokens.shift();
	if (!op) throw new Error("Usage: /verification <begin|run|status|complete|cancel> --work-id ID ...");
	const allowed: Record<string, true> = {
		"--work-id": true,
		"--item": true,
		"--scope-artifact": true,
		"--profile": true,
		"--add-check": true,
		"--check-id": true,
	};
	const values = new Map<string, string[]>();
	for (let index = 0; index < tokens.length; index += 1) {
		const key = tokens[index];
		if (!key || !allowed[key]) throw new Error(`Unknown verification command option: ${key ?? ""}`);
		const value = tokens[index + 1];
		if (value === undefined) throw new Error(`Missing value for ${key}.`);
		const previous = values.get(key) ?? [];
		if (key !== "--add-check" && previous.length > 0) throw new Error(`Option ${key} may appear only once.`);
		previous.push(value);
		values.set(key, previous);
		index += 1;
	}
	const request: Record<string, unknown> = {
		op,
		workId: values.get("--work-id")?.[0],
		...(values.get("--item")?.[0] !== undefined ? { item: values.get("--item")?.[0] } : {}),
		...(values.get("--scope-artifact")?.[0] !== undefined ? { scopeArtifact: values.get("--scope-artifact")?.[0] } : {}),
		...(values.get("--profile")?.[0] !== undefined ? { profile: values.get("--profile")?.[0] } : {}),
		...(values.get("--add-check") ? { additionalChecks: values.get("--add-check") } : {}),
		...(values.get("--check-id")?.[0] !== undefined ? { checkId: values.get("--check-id")?.[0] } : {}),
	};
	return parseVerificationRequest(request);
}

export function registerVerificationTool(pi: ExtensionAPI, service: VerificationService): void {
	const z = pi.zod;
	pi.registerTool({
		name: "verification",
		label: "Verification",
		description: "User-approved native verification: begin binds one exact native todo item and scope, run starts one repository-named check, status reports actual child outcomes, complete records only fresh evidence, and cancel requires user confirmation. No arbitrary commands, receipt injection, todo status mutation, or approve flag is accepted.",
		strict: true,
		parameters: z.object({
			op: z.enum(VERIFICATION_OPERATIONS),
			workId: z.string(),
			item: z.string().optional(),
			scopeArtifact: z.string().optional(),
			profile: z.string().optional(),
			additionalChecks: z.array(z.string()).optional(),
			checkId: z.string().optional(),
		}),
		async execute(_toolCallId: string, params: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, context: VerificationHostContext) {
			return await service.executeUnknown(params, context);
		},
	});
}

export function registerVerificationCommand(pi: ExtensionAPI, service: VerificationService): void {
	pi.registerCommand("verification", {
		description: "Begin, run, inspect, certify, or cancel native verification with user-only scope approval.",
		handler: async (args: string, context: VerificationHostContext) => {
			try {
				const request = parseVerificationCommand(args);
				const result = await service.execute(request, context);
				const text = result.content[0]?.text ?? "Verification operation completed.";
				context.ui.notify(text, result.isError ? "error" : "info");
			} catch (error) {
				context.ui.notify(errorMessage(error), "error");
			}
		},
	});
}

async function readReferencedReceipts(store: ReceiptStore, runIds: readonly string[]): Promise<CheckRunRecord[]> {
	const records: CheckRunRecord[] = [];
	for (const runId of runIds) records.push(await readRunRecord(store, runId));
	return records;
}

function success(op: VerificationOperation, workId: string, text: string, details: Record<string, string | number | boolean | readonly string[]> = {}): VerificationToolResponse {
	return { content: [{ type: "text", text }], details: { op, workId, ...details } };
}

function failure(code: string, text: string, op?: VerificationOperation, workId?: string): VerificationToolResponse {
	return { content: [{ type: "text", text: `${code}: ${text}` }], details: { code, ...(op ? { op } : {}), ...(workId ? { workId } : {}) }, isError: true };
}

function tokenizeCommand(input: string): string[] {
	const tokens: string[] = [];
	let token = "";
	let quote: "'" | "\"" | undefined;
	let escaping = false;
	let tokenStarted = false;
	for (const character of input) {
		if (escaping) {
			token += character;
			escaping = false;
			tokenStarted = true;
		} else if (character === "\\" && quote !== "'") {
			escaping = true;
			tokenStarted = true;
		} else if (quote) {
			if (character === quote) quote = undefined;
			else token += character;
			tokenStarted = true;
		} else if (character === "'" || character === "\"") {
			quote = character;
			tokenStarted = true;
		} else if (/\s/.test(character)) {
			if (tokenStarted) tokens.push(token);
			token = "";
			tokenStarted = false;
		} else {
			token += character;
			tokenStarted = true;
		}
	}
	if (escaping || quote) throw new Error("Unclosed quote or escape in /verification arguments.");
	if (tokenStarted) tokens.push(token);
	return tokens;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
