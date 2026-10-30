import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
	appendBindingEvent,
	appendCancellationEvent,
	appendCertificationEvent,
	appendRunEvent,
	createBindingEvent,
	restoreBindingStates,
	type NativeBindingEvent,
	type NativeBranchEntry,
	type NativeVerificationBinding,
} from "./verification-bindings.ts";
import { interceptNativeTodoCall, type NativeTodoGateContext, type NativeTodoGateServices } from "./native-todo-gate.ts";
import type { EvidenceDecision } from "./verification-gate.ts";

const item = "[w1] Build candidate";
const ownerSessionHash = "a".repeat(64);

function makeBinding(): NativeVerificationBinding {
	return {
		version: 1,
		bindingId: randomUUID(),
		workId: "w1",
		item,
		ownerSessionHash,
		branchAnchorId: "todo_state",
		repoId: "b".repeat(64),
		policyDigest: "c".repeat(64),
		scopeArtifact: "local://design.md",
		scopeDigest: "d".repeat(64),
		profile: "full",
		additionalChecks: [],
		requiredChecks: ["unit"],
		candidateId: "e".repeat(64),
		snapshotRef: "snapshot-abc123",
		attemptId: randomUUID(),
		createdAt: new Date().toISOString(),
	};
}

function todoResult(phases: readonly { name: string; tasks: readonly { content: string; status: string }[] }[], op = "view"): NativeBranchEntry {
	return {
		id: "todo_state",
		type: "message",
		message: {
			role: "toolResult",
			toolName: "todo",
			isError: false,
			details: { op, phases },
		},
	} as NativeBranchEntry;
}

async function branchWithEvents(
	binding: NativeVerificationBinding,
	phases: readonly { name: string; tasks: readonly { content: string; status: string }[] }[],
	options: { readonly certified?: boolean; readonly cancelled?: boolean } = {},
): Promise<readonly NativeBranchEntry[]> {
	const events: NativeBindingEvent[] = [];
	const writer = { appendEntry(_type: string, data: NativeBindingEvent) { events.push(data); } };
	await appendBindingEvent(writer, createBindingEvent(binding));
	const receiptId = randomUUID();
	await appendRunEvent(writer, binding, receiptId, "unit");
	if (options.certified) await appendCertificationEvent(writer, binding, [receiptId], "f".repeat(64));
	if (options.cancelled) await appendCancellationEvent(writer, binding);
	return [
		todoResult(phases),
		...events.map((data, index) => ({ id: `binding_entry_${index}`, type: "custom", customType: "com.agent-skills.native-verification.v1", data })),
	];
}

function contextFor(branch: readonly NativeBranchEntry[]): NativeTodoGateContext {
	return { sessionManager: { getBranch: () => branch, getSessionFile: () => "/session.jsonl" }, agent: { kind: "main" } };
}

function servicesFor(branch: readonly NativeBranchEntry[], decision: EvidenceDecision = { allowed: false, code: "MISSING_EVIDENCE", reason: "No fresh receipt." }): NativeTodoGateServices {
	return {
		async bindingStates() { return restoreBindingStates(branch, ownerSessionHash); },
		async validate() { return decision; },
	};
}

async function gate(
	branch: readonly NativeBranchEntry[],
	input: Record<string, unknown>,
	decision?: EvidenceDecision,
) {
	return await interceptNativeTodoCall({ toolName: "todo", input }, contextFor(branch), servicesFor(branch, decision));
}

test("registered single-task, phase, and bulk done routes require fresh evidence", async () => {
	const binding = makeBinding();
	const phases = [{ name: "Build", tasks: [{ content: item, status: "pending" }, { content: "Unbound follow-up", status: "pending" }] }];
	const branch = await branchWithEvents(binding, phases);
	assert.equal((await gate(branch, { op: "done", task: item }))?.block, true);
	assert.equal((await gate(branch, { op: "done", phase: "Build" }))?.block, true);
	assert.equal((await gate(branch, { op: "done" }))?.block, true);
	assert.equal(await gate(branch, { op: "done", task: "Unbound follow-up" }), undefined);
});

test("a valid current certification permits single, phase, and bulk completion without changing todo itself", async () => {
	const binding = makeBinding();
	const phases = [{ name: "Build", tasks: [{ content: item, status: "in_progress" }, { content: "Unbound follow-up", status: "pending" }] }];
	const branch = await branchWithEvents(binding, phases, { certified: true });
	const valid: EvidenceDecision = { allowed: true, evidenceDigest: "f".repeat(64), receiptIds: ["unused"], records: [] };
	assert.equal(await gate(branch, { op: "done", task: item }, valid), undefined);
	assert.equal(await gate(branch, { op: "done", phase: "Build" }, valid), undefined);
	assert.equal(await gate(branch, { op: "done" }, valid), undefined);
});

test("init, rm task/phase/bulk, and drop cannot discard registered unfinished work before user cancellation", async () => {
	const binding = makeBinding();
	const phases = [{ name: "Build", tasks: [{ content: item, status: "pending" }, { content: "Unbound follow-up", status: "pending" }] }];
	const branch = await branchWithEvents(binding, phases);
	const operations = [
		{ op: "init", items: ["Unbound follow-up"] },
		{ op: "rm", task: item },
		{ op: "rm", phase: "Build" },
		{ op: "rm" },
		{ op: "drop", task: item },
		{ op: "drop", phase: "Build" },
		{ op: "drop" },
	];
	for (const input of operations) assert.equal((await gate(branch, input))?.block, true);
	const cancelled = await branchWithEvents(binding, phases, { cancelled: true });
	for (const input of operations) assert.equal(await gate(cancelled, input), undefined);
});

test("a renamed or missing registered item is refused and requires todo readback plus rebind or cancel", async () => {
	const binding = makeBinding();
	const branch = await branchWithEvents(binding, [{ name: "Build", tasks: [{ content: "Renamed work", status: "pending" }] }]);
	assert.equal((await gate(branch, { op: "done", task: "Renamed work" }))?.block, true);
	const boundEntry = branch.find((entry) => entry.customType === "com.agent-skills.native-verification.v1");
	const noReadback = [{ id: "todo_state", type: "custom" }, ...(boundEntry ? [boundEntry] : [])];
	assert.equal((await gate(noReadback, { op: "done" }))?.block, true);
});

test("manual and unbound progress remains available, while ambiguous duplicate todo content fails closed", async () => {
	const phases = [{ name: "Tasks", tasks: [{ content: "Unbound", status: "pending" }] }];
	const ordinaryBranch = [todoResult(phases)];
	assert.equal(await gate(ordinaryBranch, { op: "done", task: "Unbound" }), undefined);
	const binding = makeBinding();
	const duplicateBranch = await branchWithEvents(binding, [{ name: "Build", tasks: [{ content: item, status: "pending" }, { content: item, status: "pending" }] }]);
	assert.equal((await gate(duplicateBranch, { op: "done", task: item }))?.block, true);
});

test("todo view is always available for a readback, and unknown operations are not wrapped", async () => {
	const binding = makeBinding();
	const branch = await branchWithEvents(binding, [{ name: "Build", tasks: [{ content: item, status: "pending" }] }]);
	assert.equal(await gate(branch, { op: "view" }), undefined);
	assert.equal(await interceptNativeTodoCall({ toolName: "task", input: { id: "x" } }, contextFor(branch), servicesFor(branch)), undefined);
});

test("abandoned registered items cannot become completed without fresh evidence, including after cancellation", async () => {
	for (const cancelled of [false, true]) {
		const branch = await branchWithEvents(makeBinding(), [{ name: "Build", tasks: [{ content: item, status: "abandoned" }] }], { cancelled });
		for (const input of [{ op: "done", task: item }, { op: "done", phase: "Build" }, { op: "done" }]) {
			assert.equal((await gate(branch, input))?.block, true);
		}
	}
});

test("cancelled history does not shadow a newly certified binding for the same native item", async () => {
	const phases = [{ name: "Build", tasks: [{ content: item, status: "pending" }] }];
	const history = await branchWithEvents(makeBinding(), phases, { cancelled: true });
	const replacement = { ...makeBinding(), workId: "w2" };
	const replacementBranch = await branchWithEvents(replacement, phases, { certified: true });
	const branch = [...history, ...replacementBranch.filter((entry) => entry.type === "custom")];
	const valid: EvidenceDecision = { allowed: true, evidenceDigest: "f".repeat(64), receiptIds: [], records: [] };
	assert.equal(await gate(branch, { op: "done", task: item }, valid), undefined);
	const cancelledReplacement = await branchWithEvents(replacement, phases, { cancelled: true });
	const cancelledBranch = [...history, ...cancelledReplacement.filter((entry) => entry.type === "custom")];
	assert.equal(await gate(cancelledBranch, { op: "rm", task: item }), undefined);
	assert.equal((await gate(cancelledBranch, { op: "done", task: item }))?.block, true);
});

test("an unreadable manual edit invalidates old todo state until canonical readback", async () => {
	const phases = [{ name: "Build", tasks: [{ content: item, status: "pending" }] }];
	const original = await branchWithEvents(makeBinding(), phases, { certified: true });
	const edited = [...original, { id: "manual-edit", type: "custom", customType: "user_todo_edit", data: { phases: "unknown-version" } }];
	const valid: EvidenceDecision = { allowed: true, evidenceDigest: "f".repeat(64), receiptIds: [], records: [] };
	assert.equal((await gate(edited, { op: "done", task: item }, valid))?.block, true);
	const readback = [...edited, { ...todoResult(phases), id: "fresh-view" }];
	assert.equal(await gate(readback, { op: "done", task: item }, valid), undefined);
});
