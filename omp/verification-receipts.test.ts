import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createReceiptStore, listRunRecords, readRunLog, readRunRecord, removeRunArtifacts, saveRunLog, saveRunRecord, type CheckRunRecord } from "./verification-receipts.ts";

function record(overrides: Partial<CheckRunRecord> = {}): CheckRunRecord {
	return {
		version: 1,
		runId: randomUUID(),
		bindingId: randomUUID(),
		attemptId: randomUUID(),
		candidateId: "a".repeat(64),
		repoId: "b".repeat(64),
		policyDigest: "c".repeat(64),
		profile: "full",
		checkId: "unit",
		kind: "static",
		resourceGeneration: null,
		state: "running",
		startedAt: new Date().toISOString(),
		...overrides,
	};
}

test("receipt and bounded log paths stay outside the repository and round-trip exact run identity", async () => {
	const stateDirectory = await mkdtemp(path.join(tmpdir(), "verification-receipts-"));
	try {
		const store = await createReceiptStore(stateDirectory);
		const initial = record();
		await saveRunRecord(store, initial);
		const logPath = await saveRunLog(store, initial.runId, "check output\n");
		const completed = { ...initial, state: "passed" as const, exitCode: 0, finishedAt: new Date().toISOString(), logPath };
		await saveRunRecord(store, completed);
		assert.deepEqual(await readRunRecord(store, initial.runId), completed);
		assert.deepEqual(await listRunRecords(store, initial.bindingId), [completed]);
		assert.equal(await readRunLog(store, initial.runId), "check output\n");
		assert.equal(logPath, `logs/${initial.runId}.log`);
		assert.equal((await readFile(path.join(stateDirectory, logPath), "utf8")), "check output\n");
		assert.ok(!path.relative(path.dirname(stateDirectory), store.receiptDirectory).startsWith("../.."));
	} finally {
		await rm(stateDirectory, { recursive: true, force: true });
	}
});

test("private receipt storage keeps Unicode logs within the byte limit without broken characters", async () => {
	const stateDirectory = await mkdtemp(path.join(tmpdir(), "verification-private-logs-"));
	try {
		const store = await createReceiptStore(stateDirectory);
		const run = record();
		await saveRunRecord(store, run);
		const logPath = await saveRunLog(store, run.runId, "é".repeat(300 * 1024) + "x");
		const bytes = await readFile(path.join(stateDirectory, logPath));
		assert.ok(bytes.byteLength <= 256 * 1024);
		const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		assert.equal(decoded.endsWith("x"), true);
		assert.equal(decoded.includes("\uFFFD"), false);
		if (process.platform !== "win32") {
			for (const directory of [store.stateDirectory, store.receiptDirectory, store.logDirectory]) {
				assert.equal((await stat(directory)).mode & 0o777, 0o700);
			}
			for (const file of [path.join(store.receiptDirectory, `${run.runId}.json`), path.join(stateDirectory, logPath)]) {
				assert.equal((await stat(file)).mode & 0o777, 0o600);
			}
		}
	} finally {
		await rm(stateDirectory, { recursive: true, force: true });
	}
});

test("corrupt, forged, or path-injected receipt records fail closed", async () => {
	const stateDirectory = await mkdtemp(path.join(tmpdir(), "verification-corrupt-receipts-"));
	try {
		const store = await createReceiptStore(stateDirectory);
		const valid = record();
		await saveRunRecord(store, valid);
		await writeFile(path.join(store.receiptDirectory, `${valid.runId}.json`), JSON.stringify({ ...valid, exitCode: 0, state: "passed", command: "evil" }));
		await assert.rejects(readRunRecord(store, valid.runId), /Unknown verification receipt field/);
		await assert.rejects(saveRunRecord(store, { ...valid, logPath: "../../outside" }), /unsafe log reference/);
		await assert.rejects(readRunRecord(store, "../../escape"), /Invalid verification run identifier/);
	} finally {
		await rm(stateDirectory, { recursive: true, force: true });
	}
});

test("receipt cleanup removes only the selected run artifacts", async () => {
	const stateDirectory = await mkdtemp(path.join(tmpdir(), "verification-cleanup-receipts-"));
	try {
		const store = await createReceiptStore(stateDirectory);
		const first = record();
		const second = record({ bindingId: first.bindingId });
		await saveRunRecord(store, first);
		await saveRunRecord(store, second);
		await saveRunLog(store, first.runId, "first\n");
		await saveRunLog(store, second.runId, "second\n");
		await removeRunArtifacts(store, first.runId);
		assert.deepEqual(await listRunRecords(store, first.bindingId), [second]);
		await assert.rejects(readRunLog(store, first.runId));
		assert.equal(await readRunLog(store, second.runId), "second\n");
	} finally {
		await rm(stateDirectory, { recursive: true, force: true });
	}
});
