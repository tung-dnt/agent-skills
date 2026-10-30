import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	BINDING_CUSTOM_TYPE,
	appendBindingEvent,
	appendCancellationEvent,
	appendCertificationEvent,
	appendRunEvent,
	createBindingEvent,
	nativeSessionIdentity,
	resolveScopeArtifact,
	restoreBindingState,
	type NativeBindingEvent,
	type NativeVerificationBinding,
} from "./verification-bindings.ts";

function binding(overrides: Partial<NativeVerificationBinding> = {}): NativeVerificationBinding {
	const createdAt = new Date().toISOString();
	return {
		version: 1,
		bindingId: randomUUID(),
		workId: "w1",
		item: "[w1] Verify final candidate",
		ownerSessionHash: "a".repeat(64),
		branchAnchorId: "deadbeef",
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
		createdAt,
		...overrides,
	};
}

async function sessionFixture(): Promise<{ readonly root: string; readonly sessionFile: string; readonly localRoot: string }> {
	const root = await mkdtemp(path.join(tmpdir(), "verification-native-session-"));
	const sessionFile = path.join(root, "20261030_session.jsonl");
	await writeFile(sessionFile, JSON.stringify({ type: "session", id: randomUUID() }) + "\n");
	const localRoot = path.join(root, "20261030_session", "local");
	await mkdir(localRoot, { recursive: true });
	return { root, sessionFile, localRoot };
}

test("owner-session local:// artifacts resolve through the session stem's local directory", async () => {
	const session = await sessionFixture();
	try {
		await writeFile(path.join(session.localRoot, "design.md"), "Approved design scope\n");
		await mkdir(path.join(session.localRoot, "nested"));
		await writeFile(path.join(session.localRoot, "nested", "criteria.md"), "Acceptance criteria\n");
		const design = await resolveScopeArtifact("local://design.md", { repositoryRoot: session.root, sessionFile: session.sessionFile });
		const criteria = await resolveScopeArtifact("local://nested/criteria.md", { repositoryRoot: session.root, sessionFile: session.sessionFile });
		assert.equal(design.resolvedPath, path.join(session.localRoot, "design.md"));
		assert.equal(design.text, "Approved design scope\n");
		assert.match(design.digest, /^[a-f0-9]{64}$/);
		assert.equal(criteria.resolvedPath, path.join(session.localRoot, "nested", "criteria.md"));
		assert.equal(criteria.text, "Acceptance criteria\n");
	} finally {
		await rm(session.root, { recursive: true, force: true });
	}
});

test("repository scope paths work, while missing sessions, path traversal, and escaping symlinks refuse", async () => {
	const session = await sessionFixture();
	const outside = path.join(session.root, "outside.md");
	try {
		await mkdir(path.join(session.root, "repo", "docs"), { recursive: true });
		await writeFile(path.join(session.root, "repo", "docs", "scope.md"), "Repository scope\n");
		const repositoryPath = await resolveScopeArtifact("docs/scope.md", { repositoryRoot: path.join(session.root, "repo"), sessionFile: session.sessionFile });
		assert.equal(repositoryPath.text, "Repository scope\n");
		await writeFile(outside, "outside\n");
		await assert.rejects(resolveScopeArtifact("local://../outside.md", { repositoryRoot: session.root, sessionFile: session.sessionFile }), /safe relative path/);
		await assert.rejects(resolveScopeArtifact("local://%2e%2e/outside.md", { repositoryRoot: session.root, sessionFile: session.sessionFile }), /safe relative path/);
		await symlink(outside, path.join(session.localRoot, "escape.md"));
		await assert.rejects(resolveScopeArtifact("local://escape.md", { repositoryRoot: session.root, sessionFile: session.sessionFile }), /symlink resolves outside/);
		await assert.rejects(resolveScopeArtifact("local://design.md", { repositoryRoot: session.root, sessionFile: path.join(session.root, "missing.jsonl") }));
		await assert.rejects(resolveScopeArtifact("../outside.md", { repositoryRoot: path.join(session.root, "repo"), sessionFile: session.sessionFile }), /inside the repository/);
	} finally {
		await rm(session.root, { recursive: true, force: true });
	}
});

test("native session identity uses the persistent session file and rejects missing owner sessions", async () => {
	const session = await sessionFixture();
	try {
		const identity = await nativeSessionIdentity(session.sessionFile);
		assert.match(identity, /^[a-f0-9]{64}$/);
		assert.equal(await nativeSessionIdentity(session.sessionFile), identity);
		await assert.rejects(nativeSessionIdentity(undefined), /persistent owner native session/);
		await assert.rejects(nativeSessionIdentity(path.join(session.root, "missing.jsonl")));
	} finally {
		await rm(session.root, { recursive: true, force: true });
	}
});

test("binding, run, certification, and cancellation events restore only on their owning branch", async () => {
	const item = binding();
	const events: NativeBindingEvent[] = [];
	const writer = { appendEntry(_customType: string, data: NativeBindingEvent) { events.push(data); } };
	const bound = createBindingEvent(item);
	await appendBindingEvent(writer, bound);
	const runId = randomUUID();
	await appendRunEvent(writer, item, runId, "unit");
	await appendCertificationEvent(writer, item, [runId], "f".repeat(64));
	const base = { id: "deadbeef", type: "custom" };
	const branch = [base, ...events.map((data, index) => ({ id: `entry_${index}`, type: "custom", customType: BINDING_CUSTOM_TYPE, data }))];
	const restored = restoreBindingState(branch, item.ownerSessionHash, item.workId);
	assert.equal(restored?.binding.bindingId, item.bindingId);
	assert.deepEqual(restored?.runIds, [runId]);
	assert.equal(restored?.certification?.candidateId, item.candidateId);
	assert.equal(restored?.isCancelled, false);
	assert.equal(restoreBindingState([base], item.ownerSessionHash, item.workId), undefined);
	assert.throws(() => restoreBindingState(branch, "f".repeat(64), item.workId), /different owner session/);
	assert.throws(() => restoreBindingState(branch.slice(1), item.ownerSessionHash, item.workId), /branch anchor is absent/);
	await appendCancellationEvent(writer, item);
	const cancelledBranch = [base, ...events.map((data, index) => ({ id: `cancel_${index}`, type: "custom", customType: BINDING_CUSTOM_TYPE, data }))];
	assert.equal(restoreBindingState(cancelledBranch, item.ownerSessionHash, item.workId)?.isCancelled, true);
});

test("binding events reject extra data and branch anchors accept native entry IDs rather than assuming UUIDs", async () => {
	const item = binding();
	const event = createBindingEvent(item);
	assert.equal(event.branchAnchorId, "deadbeef");
	const forged: unknown = { ...event, approve: true };
	const branch = [
		{ id: item.branchAnchorId },
		{ id: "bound-1", type: "custom", customType: BINDING_CUSTOM_TYPE, data: forged },
	];
	assert.throws(() => restoreBindingState(branch, item.ownerSessionHash, item.workId), /Unknown native verification field/);
});
