import assert from "node:assert/strict";
import test from "node:test";
import { requestUserApproval, type ApprovalRequest, type ApprovalUI } from "./verification-approval.ts";

const request: ApprovalRequest = {
	title: "Approve verification scope",
	workId: "w1",
	item: "[w1] Verify final candidate",
	repository: "/work/repo",
	policyDigest: "a".repeat(64),
	scopeArtifact: "artifacts/w1-design.md",
	scopeDigest: "b".repeat(64),
	scopeText: "# Approved design\nExact user-visible scope.\n",
	profile: "full",
	commands: [{ id: "unit", kind: "static", argv: ["npm", "test"], preparations: [] }],
	checks: ["lint", "unit"],
	changedPaths: ["src/main.ts", "test/main.test.ts"],
};

test("approval without a real UI is refused", async () => {
	let prompted = false;
	const ui: ApprovalUI = { hasUI: false, async confirm() { prompted = true; return true; } };
	assert.deepEqual(await requestUserApproval(ui, request), {
		allowed: false,
		code: "APPROVAL_UNAVAILABLE",
		reason: "Verification scope approval requires an interactive user-facing UI.",
	});
	assert.equal(prompted, false);
});

test("the actual user-facing prompt shows the exact scope and policy identities", async () => {
	let seenTitle = "";
	let seenMessage = "";
	const ui: ApprovalUI = {
		hasUI: true,
		async confirm(title, message) {
			seenTitle = title;
			seenMessage = message;
			return true;
		},
	};
	assert.deepEqual(await requestUserApproval(ui, request), { allowed: true });
	assert.equal(seenTitle, request.title);
	assert.match(seenMessage, /Policy SHA-256: a{64}/);
	assert.match(seenMessage, /Scope SHA-256: b{64}/);
	assert.match(seenMessage, /Exact user-visible scope/);
	assert.match(seenMessage, /src\/main\.ts/);
	assert.match(seenMessage, /Required checks: lint, unit/);
	assert.match(seenMessage, /unit \(static\): \["npm","test"\]/);
});

test("a user decline and an unavailable UI failure are not approvals", async () => {
	const declined = await requestUserApproval({ hasUI: true, async confirm() { return false; } }, request);
	assert.equal(declined.allowed, false);
	if (!declined.allowed) assert.equal(declined.code, "APPROVAL_DECLINED");
	const failed = await requestUserApproval({ hasUI: true, async confirm() { throw new Error("dialog closed"); } }, request);
	assert.equal(failed.allowed, false);
	if (!failed.allowed) assert.equal(failed.code, "APPROVAL_UNAVAILABLE");
});
