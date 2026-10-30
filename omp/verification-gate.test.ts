import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { appendBindingEvent, appendCertificationEvent, appendRunEvent, createBindingEvent, restoreBindingState, type NativeBindingEvent, type NativeVerificationBinding } from "./verification-bindings.ts";
import { validateCertifiedCompletion, validateEvidence } from "./verification-gate.ts";
import { parsePolicy } from "./verification-policy.ts";
import { createReceiptStore, readRunRecord, type CheckRunRecord } from "./verification-receipts.ts";
import { captureCandidate, removeCandidate, type CandidateSnapshot } from "./verification-snapshot.ts";
import { VerificationRunner } from "./verification-runner.ts";
import { createGitRepo, dispose, testPolicy, writeRepoFile } from "./verification-test-helpers.ts";

interface GateFixture {
	readonly root: string;
	readonly stateDirectory: string;
	readonly candidate: CandidateSnapshot;
	readonly binding: NativeVerificationBinding;
	readonly record: CheckRunRecord;
	readonly runner: VerificationRunner;
}

async function fixture(kind: "static" | "runtime" = "static"): Promise<GateFixture> {
	const root = await createGitRepo();
	const stateDirectory = path.join(path.dirname(root), `verification-gate-state-${path.basename(root)}`);
	const data = testPolicy();
	const checks = data.checks as Record<string, Record<string, unknown>>;
	const unit = checks.unit;
	if (!unit) throw new Error("Test policy is missing the unit check.");
	unit.kind = kind;
	if (kind === "runtime") unit.resourceId = "test-runtime";
	await writeRepoFile(root, ".omp/verification.json", JSON.stringify(data, null, 2));
	const policy = parsePolicy(data);
	const candidate = await captureCandidate(root, policy, { stateDirectory });
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
	const runner = new VerificationRunner({ stateDirectory });
	const started = await runner.startCheck({ binding, candidate, checkId: "unit" });
	let record = await runner.status(started.runId);
	// This real-process integration test waits for the child's observed close, not a fake clock.
	for (let attempt = 0; attempt < 500 && record.state === "running"; attempt += 1) {
		await delay(10);
		record = await runner.status(started.runId);
	}
	if (record.state === "running") throw new Error("Verification child did not finish for the evidence gate test.");
	return { root, stateDirectory, candidate, binding, record, runner };
}

async function cleanup(value: GateFixture): Promise<void> {
	await value.runner.interruptAll();
	await removeCandidate(value.candidate);
	await rm(value.stateDirectory, { recursive: true, force: true });
	await dispose(value.root);
}

test("fresh zero-exit receipt from an actual child satisfies exact mandatory check coverage", async () => {
	const value = await fixture();
	try {
		assert.equal(value.record.state, "passed");
		const store = await createReceiptStore(value.stateDirectory);
		const receipt = await readRunRecord(store, value.record.runId);
		const decision = await validateEvidence(value.binding, value.candidate, [receipt.runId], [receipt]);
		assert.equal(decision.allowed, true);
		if (decision.allowed) {
			assert.deepEqual(decision.receiptIds, [receipt.runId]);
			assert.match(decision.evidenceDigest, /^[a-f0-9]{64}$/);
		}
	} finally {
		await cleanup(value);
	}
});

test("missing, stale, weak-profile, wrong-attempt, and wrong-resource receipts are refused", async () => {
	const value = await fixture("runtime");
	try {
		const store = await createReceiptStore(value.stateDirectory);
		const receipt = await readRunRecord(store, value.record.runId);
		const missing = await validateEvidence(value.binding, value.candidate, [], []);
		assert.equal(missing.allowed, false);
		const wrongAttempt = await validateEvidence(value.binding, value.candidate, [receipt.runId], [{ ...receipt, attemptId: randomUUID() }]);
		assert.equal(wrongAttempt.allowed, false);
		const wrongResource = await validateEvidence(value.binding, value.candidate, [receipt.runId], [{ ...receipt, resourceGeneration: randomUUID() }]);
		assert.equal(wrongResource.allowed, false);
		const weak = await validateEvidence({ ...value.binding, profile: "not-a-profile" }, value.candidate, [receipt.runId], [receipt]);
		assert.equal(weak.allowed, false);
		await writeRepoFile(value.root, "README.md", "candidate changed after approval\n");
		const stale = await validateEvidence(value.binding, value.candidate, [receipt.runId], [receipt]);
		assert.equal(stale.allowed, false);
		if (!stale.allowed) assert.equal(stale.code, "STALE_EVIDENCE");
	} finally {
		await cleanup(value);
	}
});

test("native branch certification is evidence-only and must match the current receipt digest", async () => {
	const value = await fixture();
	try {
		const decision = await validateEvidence(value.binding, value.candidate, [value.record.runId], [value.record]);
		assert.equal(decision.allowed, true);
		if (!decision.allowed) return;
		const events: NativeBindingEvent[] = [];
		const writer = { appendEntry(_type: string, data: NativeBindingEvent) { events.push(data); } };
		await appendBindingEvent(writer, createBindingEvent(value.binding));
		await appendRunEvent(writer, value.binding, value.record.runId, value.record.checkId);
		await appendCertificationEvent(writer, value.binding, decision.receiptIds, decision.evidenceDigest);
		const branch = [
			{ id: value.binding.branchAnchorId, type: "custom" },
			...events.map((data, index) => ({ id: `evidence_${index}`, type: "custom", customType: "com.agent-skills.native-verification.v1", data })),
		];
		const state = restoreBindingState(branch, value.binding.ownerSessionHash, value.binding.workId);
		assert.ok(state);
		if (!state) return;
		const store = await createReceiptStore(value.stateDirectory);
		const receipt = await readRunRecord(store, value.record.runId);
		assert.equal((await validateCertifiedCompletion(value.binding, state, value.candidate, [receipt])).allowed, true);
		const certificate = state.certification;
		assert.ok(certificate);
		if (!certificate) return;
		const forged = { ...state, certification: { ...certificate, evidenceDigest: "0".repeat(64) } };
		assert.equal((await validateCertifiedCompletion(value.binding, forged, value.candidate, [receipt])).allowed, false);
	} finally {
		await cleanup(value);
	}
});
