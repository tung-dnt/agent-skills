import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";

export type VerificationRunState = "running" | "passed" | "failed" | "cancelled" | "interrupted";
export type VerificationRunKind = "static" | "runtime";

export interface CheckRunRecord {
	readonly version: 1;
	readonly runId: string;
	readonly bindingId: string;
	readonly attemptId: string;
	readonly candidateId: string;
	readonly repoId: string;
	readonly policyDigest: string;
	readonly profile: string;
	readonly checkId: string;
	readonly kind: VerificationRunKind;
	readonly resourceGeneration: string | null;
	readonly state: VerificationRunState;
	readonly startedAt: string;
	readonly finishedAt?: string;
	readonly exitCode?: number | null;
	readonly terminationSignal?: string;
	readonly failureCode?: string;
	readonly logPath?: string;
}

export interface ReceiptStore {
	readonly stateDirectory: string;
	readonly receiptDirectory: string;
	readonly logDirectory: string;
}

const RUN_ID = /^[a-f0-9-]{36}$/;
const MAX_LOG_BYTES = 256 * 1024;
const RECORD_KEYS = [
	"version", "runId", "bindingId", "attemptId", "candidateId", "repoId", "policyDigest", "profile", "checkId", "kind", "resourceGeneration", "state", "startedAt", "finishedAt", "exitCode", "terminationSignal", "failureCode", "logPath",
];

export async function createReceiptStore(stateDirectory: string): Promise<ReceiptStore> {
	const root = path.resolve(stateDirectory);
	await mkdir(root, { recursive: true, mode: 0o700 });
	await chmod(root, 0o700);
	const receiptDirectory = path.join(root, "receipts");
	const logDirectory = path.join(root, "logs");
	await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
	await mkdir(logDirectory, { recursive: true, mode: 0o700 });
	await chmod(receiptDirectory, 0o700);
	await chmod(logDirectory, 0o700);
	return { stateDirectory: root, receiptDirectory, logDirectory };
}

export async function saveRunRecord(store: ReceiptStore, record: CheckRunRecord): Promise<void> {
	validateRecord(record);
	const destination = path.join(store.receiptDirectory, `${record.runId}.json`);
	const temporary = `${destination}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify(record), { encoding: "utf8", mode: 0o600, flag: "wx" });
		await rename(temporary, destination);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

export async function readRunRecord(store: ReceiptStore, runId: string): Promise<CheckRunRecord> {
	assertRunId(runId);
	const value: unknown = JSON.parse(await readFile(path.join(store.receiptDirectory, `${runId}.json`), "utf8"));
	return parseRecord(value, runId);
}

export async function listRunRecords(store: ReceiptStore, bindingId?: string): Promise<readonly CheckRunRecord[]> {
	const names = (await readdir(store.receiptDirectory)).filter((name: string) => name.endsWith(".json") && RUN_ID.test(name.slice(0, -5))).sort();
	const records: CheckRunRecord[] = [];
	for (const name of names) {
		const runId = name.slice(0, -5);
		const record = await readRunRecord(store, runId);
		if (!bindingId || record.bindingId === bindingId) records.push(record);
	}
	return records;
}

export async function saveRunLog(store: ReceiptStore, runId: string, content: string): Promise<string> {
	assertRunId(runId);
	const logPath = path.join(store.logDirectory, `${runId}.log`);
	const encoded = Buffer.from(content.slice(-MAX_LOG_BYTES), "utf8");
	let start = Math.max(0, encoded.byteLength - MAX_LOG_BYTES);
	while (((encoded[start] ?? 0) & 0xc0) === 0x80) start += 1;
	await writeFile(logPath, encoded.subarray(start), { mode: 0o600 });
	return path.relative(store.stateDirectory, logPath).split(path.sep).join("/");
}

export async function readRunLog(store: ReceiptStore, runId: string): Promise<string> {
	assertRunId(runId);
	return await readFile(path.join(store.logDirectory, `${runId}.log`), "utf8");
}

export async function removeRunArtifacts(store: ReceiptStore, runId: string): Promise<void> {
	assertRunId(runId);
	await rm(path.join(store.receiptDirectory, `${runId}.json`), { force: true });
	await rm(path.join(store.logDirectory, `${runId}.log`), { force: true });
}

function validateRecord(record: CheckRunRecord): void {
	if (record.version !== 1 || !RUN_ID.test(record.runId) || !RUN_ID.test(record.bindingId) || !RUN_ID.test(record.attemptId)) {
		throw new Error("Verification receipt has an invalid identity.");
	}
	if (record.kind === "static" && record.resourceGeneration !== null) throw new Error("Static checks must not claim an external resource generation.");
	if (record.kind === "runtime" && record.resourceGeneration !== null && !/^[a-f0-9]{64}$/.test(record.resourceGeneration)) throw new Error("Runtime resource generation must be a SHA-256 digest.");
	if (record.state === "passed" && record.kind === "runtime" && record.resourceGeneration === null) throw new Error("A passing runtime receipt requires an observed external resource generation.");
	if (!/^[a-f0-9]{64}$/.test(record.candidateId) || !/^[a-f0-9]{64}$/.test(record.repoId) || !/^[a-f0-9]{64}$/.test(record.policyDigest)) {
		throw new Error("Verification receipt has an invalid snapshot digest.");
	}
	if (!record.profile || !record.checkId || !isRunKind(record.kind) || !isRunState(record.state)) throw new Error("Verification receipt has an invalid check result.");
	if (!Number.isFinite(Date.parse(record.startedAt))) throw new Error("Verification receipt has an invalid start time.");
	if (record.finishedAt !== undefined && !Number.isFinite(Date.parse(record.finishedAt))) throw new Error("Verification receipt has an invalid finish time.");
	if (record.exitCode !== undefined && record.exitCode !== null && !Number.isInteger(record.exitCode)) throw new Error("Verification receipt has an invalid exit code.");
	if (record.state === "passed" && (record.exitCode !== 0 || record.finishedAt === undefined)) throw new Error("A passing receipt requires a zero exit code and observed finish time.");
	if ((record.state === "failed" || record.state === "cancelled" || record.state === "interrupted") && record.finishedAt === undefined) throw new Error("A terminal non-passing receipt requires an observed finish time.");
	if (record.logPath !== undefined && (!record.logPath.startsWith("logs/") || record.logPath.includes(".."))) throw new Error("Verification receipt has an unsafe log reference.");
}

function parseRecord(value: unknown, expectedRunId: string): CheckRunRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Verification receipt is not an object.");
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) if (!RECORD_KEYS.includes(key)) throw new Error(`Unknown verification receipt field: ${key}`);
	if (record.runId !== expectedRunId) throw new Error("Verification receipt filename does not match its run identity.");
	const parsed = record as unknown as CheckRunRecord;
	validateRecord(parsed);
	return parsed;
}

function assertRunId(value: string): void {
	if (!RUN_ID.test(value)) throw new Error("Invalid verification run identifier.");
}

function isRunState(value: unknown): value is VerificationRunState {
	return value === "running" || value === "passed" || value === "failed" || value === "cancelled" || value === "interrupted";
}

function isRunKind(value: unknown): value is VerificationRunKind {
	return value === "static" || value === "runtime";
}
