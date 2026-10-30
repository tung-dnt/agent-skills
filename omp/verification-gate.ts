import { createHash } from "node:crypto";
import { loadPolicy, requiredChecks } from "./verification-policy.ts";
import type { NativeVerificationBinding, NativeBindingState } from "./verification-bindings.ts";
import type { CheckRunRecord } from "./verification-receipts.ts";
import { verifyCandidateFresh, type CandidateSnapshot } from "./verification-snapshot.ts";

export type EvidenceDecision =
	| { readonly allowed: true; readonly evidenceDigest: string; readonly receiptIds: readonly string[]; readonly records: readonly CheckRunRecord[] }
	| { readonly allowed: false; readonly code: "MISSING_EVIDENCE" | "STALE_EVIDENCE" | "INVALID_EVIDENCE" | "CANCELLED"; readonly reason: string };

export async function validateEvidence(
	binding: NativeVerificationBinding,
	candidate: CandidateSnapshot,
	runIds: readonly string[],
	receipts: readonly CheckRunRecord[],
): Promise<EvidenceDecision> {
	if (candidate.id !== binding.candidateId || candidate.repoId !== binding.repoId || candidate.policyDigest !== binding.policyDigest) {
		return { allowed: false, code: "STALE_EVIDENCE", reason: "The candidate snapshot no longer matches the approved native binding." };
	}
	const policyResult = await loadPolicy(candidate.repoRoot);
	if (policyResult.status !== "protected" || policyResult.digest !== binding.policyDigest) {
		return { allowed: false, code: "STALE_EVIDENCE", reason: "The approved verification policy changed or was removed." };
	}
	let mandatory: readonly string[];
	try {
		mandatory = requiredChecks(policyResult.policy, { profile: binding.profile, additionalChecks: binding.additionalChecks }, candidate.changedPaths);
	} catch (error) {
		return { allowed: false, code: "INVALID_EVIDENCE", reason: messageOf(error) };
	}
	if (!sameStrings(mandatory, binding.requiredChecks)) return { allowed: false, code: "INVALID_EVIDENCE", reason: "The binding check set no longer matches the repository's mandatory checks." };
	try {
		await verifyCandidateFresh(candidate, policyResult.policy);
	} catch (error) {
		return { allowed: false, code: "STALE_EVIDENCE", reason: messageOf(error) };
	}

	const byId = new Map(receipts.map((receipt) => [receipt.runId, receipt]));
	const latestByCheck = new Map<string, CheckRunRecord>();
	const generationByResource = new Map<string, string>();
	for (const runId of runIds) {
		const receipt = byId.get(runId);
		if (!receipt) return { allowed: false, code: "MISSING_EVIDENCE", reason: `Receipt ${runId} is missing from the current verification attempt.` };
		if (
			receipt.runId !== runId ||
			receipt.bindingId !== binding.bindingId ||
			receipt.attemptId !== binding.attemptId ||
			receipt.candidateId !== binding.candidateId ||
			receipt.repoId !== binding.repoId ||
			receipt.policyDigest !== binding.policyDigest ||
			receipt.profile !== binding.profile
		) return { allowed: false, code: "INVALID_EVIDENCE", reason: "A receipt belongs to a different binding, candidate, or attempt." };
		const check = policyResult.policy.checks[receipt.checkId];
		if (!check || check.kind !== receipt.kind || !mandatory.includes(receipt.checkId)) return { allowed: false, code: "INVALID_EVIDENCE", reason: `Receipt names an unknown or unapproved check: ${receipt.checkId}.` };
		if (check.kind === "static" && receipt.resourceGeneration !== null) return { allowed: false, code: "INVALID_EVIDENCE", reason: `Static check ${receipt.checkId} claims an external resource generation.` };
		if (check.kind === "runtime") {
			const resourceId = check.resourceId;
			const generation = receipt.resourceGeneration;
			if (!resourceId || !generation || !/^[a-f0-9]{64}$/.test(generation)) return { allowed: false, code: "INVALID_EVIDENCE", reason: `Runtime check ${receipt.checkId} has no observed resource generation.` };
			const previousGeneration = generationByResource.get(resourceId);
			if (previousGeneration && previousGeneration !== generation) return { allowed: false, code: "STALE_EVIDENCE", reason: `Runtime resource ${resourceId} changed between receipts.` };
			generationByResource.set(resourceId, generation);
		}
		const previous = latestByCheck.get(receipt.checkId);
		if (!previous || compareRunOrder(receipt, previous) > 0) latestByCheck.set(receipt.checkId, receipt);
	}

	const selected: CheckRunRecord[] = [];
	for (const checkId of mandatory) {
		const latest = latestByCheck.get(checkId);
		if (!latest || latest.state !== "passed" || latest.exitCode !== 0 || !latest.finishedAt) {
			return { allowed: false, code: "MISSING_EVIDENCE", reason: `Required check ${checkId} has no fresh observed zero-exit receipt for this attempt.` };
		}
		selected.push(latest);
	}
	const receiptIds = selected.map((receipt) => receipt.runId).sort();
	const evidenceDigest = createHash("sha256").update(JSON.stringify({
		version: 1,
		bindingId: binding.bindingId,
		attemptId: binding.attemptId,
		candidateId: candidate.id,
		policyDigest: binding.policyDigest,
		requiredChecks: mandatory,
		records: selected.map((receipt) => ({
			runId: receipt.runId,
			checkId: receipt.checkId,
			exitCode: receipt.exitCode,
			resourceGeneration: receipt.resourceGeneration,
			startedAt: receipt.startedAt,
			finishedAt: receipt.finishedAt,
		})),
	})).digest("hex");
	return { allowed: true, evidenceDigest, receiptIds, records: selected };
}

export async function validateCertifiedCompletion(
	binding: NativeVerificationBinding,
	state: NativeBindingState,
	candidate: CandidateSnapshot,
	receipts: readonly CheckRunRecord[],
): Promise<EvidenceDecision> {
	if (state.binding.bindingId !== binding.bindingId || state.isCancelled) return { allowed: false, code: "CANCELLED", reason: "This native verification binding was cancelled or replaced." };
	const certificate = state.certification;
	if (!certificate) return { allowed: false, code: "MISSING_EVIDENCE", reason: "The verification binding has no native-branch certification event." };
	if (certificate.bindingId !== binding.bindingId || certificate.attemptId !== binding.attemptId || certificate.candidateId !== binding.candidateId) {
		return { allowed: false, code: "INVALID_EVIDENCE", reason: "The native certification event refers to a different attempt or candidate." };
	}
	const decision = await validateEvidence(binding, candidate, state.runIds, receipts);
	if (!decision.allowed) return decision;
	if (certificate.evidenceDigest !== decision.evidenceDigest || !sameStrings(certificate.requiredChecks, binding.requiredChecks) || !sameStrings(certificate.receiptIds, decision.receiptIds)) {
		return { allowed: false, code: "INVALID_EVIDENCE", reason: "The native certification event does not match the current receipt set." };
	}
	return decision;
}


function compareRunOrder(left: CheckRunRecord, right: CheckRunRecord): number {
	const start = Date.parse(left.startedAt) - Date.parse(right.startedAt);
	return start !== 0 ? start : left.runId.localeCompare(right.runId);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
