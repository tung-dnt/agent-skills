import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import * as path from "node:path";

export const BINDING_CUSTOM_TYPE = "com.agent-skills.native-verification.v1";
export const MAX_SCOPE_ARTIFACT_BYTES = 1_048_576;
const BASE_EVENT_KEYS = ["version", "event", "ownerSessionHash", "branchAnchorId", "workId", "recordedAt"];
const BINDING_KEYS = ["version", "bindingId", "workId", "item", "ownerSessionHash", "branchAnchorId", "repoId", "policyDigest", "scopeArtifact", "scopeDigest", "profile", "additionalChecks", "requiredChecks", "candidateId", "snapshotRef", "attemptId", "createdAt"];

export interface NativeBranchEntry {
	readonly id?: string;
	readonly type?: string;
	readonly customType?: string;
	readonly message?: unknown;
	readonly data?: unknown;
}

export interface NativeVerificationBinding {
	readonly version: 1;
	readonly bindingId: string;
	readonly workId: string;
	readonly item: string;
	readonly ownerSessionHash: string;
	readonly branchAnchorId: string;
	readonly repoId: string;
	readonly policyDigest: string;
	readonly scopeArtifact: string;
	readonly scopeDigest: string;
	readonly profile: string;
	readonly additionalChecks: readonly string[];
	readonly requiredChecks: readonly string[];
	readonly candidateId: string;
	readonly snapshotRef: string;
	readonly attemptId: string;
	readonly createdAt: string;
}

interface BindingEventBase {
	readonly version: 1;
	readonly ownerSessionHash: string;
	readonly branchAnchorId: string;
	readonly workId: string;
	readonly recordedAt: string;
}

export type NativeBindingEvent =
	| (BindingEventBase & { readonly event: "bound"; readonly binding: NativeVerificationBinding })
	| (BindingEventBase & { readonly event: "run"; readonly bindingId: string; readonly attemptId: string; readonly runId: string; readonly checkId: string })
	| (BindingEventBase & { readonly event: "certified"; readonly bindingId: string; readonly attemptId: string; readonly candidateId: string; readonly requiredChecks: readonly string[]; readonly receiptIds: readonly string[]; readonly evidenceDigest: string })
	| (BindingEventBase & { readonly event: "cancelled"; readonly bindingId: string; readonly attemptId: string });

export interface NativeBindingState {
	readonly binding: NativeVerificationBinding;
	readonly runIds: readonly string[];
	readonly certification?: Extract<NativeBindingEvent, { event: "certified" }>;
	readonly isCancelled: boolean;
}

export interface ResolvedScopeArtifact {
	readonly reference: string;
	readonly resolvedPath: string;
	readonly digest: string;
	readonly text: string;
}

export interface AppendEntryWriter {
	appendEntry(customType: string, data: NativeBindingEvent): Promise<void> | void;
}

export interface ScopeArtifactOptions {
	readonly repositoryRoot: string;
	readonly sessionFile?: string;
}

export async function resolveScopeArtifact(reference: string, options: ScopeArtifactOptions): Promise<ResolvedScopeArtifact> {
	if (reference.startsWith("local://")) return await resolveOwnerLocalArtifact(reference, options.sessionFile);
	const repositoryRoot = await realpath(options.repositoryRoot);
	const target = path.resolve(repositoryRoot, reference);
	if (!isWithin(repositoryRoot, target)) throw new Error("Scope artifact path must remain inside the repository.");
	return await readBoundedRegularFile(reference, target, repositoryRoot);
}

export async function nativeSessionIdentity(sessionFile: string | undefined): Promise<string> {
	if (!sessionFile) throw new Error("Verification requires a persistent owner native session file.");
	const actual = await realpath(sessionFile);
	const metadata = await stat(actual);
	if (!metadata.isFile() || !actual.endsWith(".jsonl")) throw new Error("Owner native session file is missing or invalid.");
	return digestText(actual);
}

export function activeBranchAnchor(branch: readonly NativeBranchEntry[]): string {
	const last = branch.at(-1)?.id;
	if (!last) throw new Error("The active native session branch has no stable entry anchor.");
	return last;
}

export function createBindingEvent(binding: NativeVerificationBinding): NativeBindingEvent {
	return {
		version: 1,
		event: "bound",
		ownerSessionHash: binding.ownerSessionHash,
		branchAnchorId: binding.branchAnchorId,
		workId: binding.workId,
		recordedAt: binding.createdAt,
		binding,
	};
}

export async function appendBindingEvent(writer: AppendEntryWriter, event: NativeBindingEvent): Promise<void> {
	validateBindingEvent(event);
	await writer.appendEntry(BINDING_CUSTOM_TYPE, event);
}

export function restoreBindingState(
	branch: readonly NativeBranchEntry[],
	expectedSessionHash: string,
	workId: string,
): NativeBindingState | undefined {
	const branchIds = new Set(branch.map((entry) => entry.id).filter((id): id is string => typeof id === "string"));
	const events: NativeBindingEvent[] = [];
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== BINDING_CUSTOM_TYPE) continue;
		const event = parseBindingEvent(entry.data);
		if (event.ownerSessionHash !== expectedSessionHash) throw new Error("Native verification binding belongs to a different owner session.");
		if (!branchIds.has(event.branchAnchorId)) throw new Error("Native verification binding branch anchor is absent; read the current todo view and rebind.");
		events.push(event);
	}
	let binding: NativeVerificationBinding | undefined;
	const runIds: string[] = [];
	let certification: Extract<NativeBindingEvent, { event: "certified" }> | undefined;
	let isCancelled = false;
	for (const event of events) {
		if (event.workId !== workId) continue;
		if (event.event === "bound") {
			binding = event.binding;
			runIds.length = 0;
			certification = undefined;
			isCancelled = false;
			continue;
		}
		if (!binding || event.bindingId !== binding.bindingId || event.attemptId !== binding.attemptId) continue;
		if (event.event === "run") runIds.push(event.runId);
		else if (event.event === "certified") certification = event;
		else if (event.event === "cancelled") isCancelled = true;
	}
	return binding ? { binding, runIds, ...(certification ? { certification } : {}), isCancelled } : undefined;
}
export function restoreBindingStates(branch: readonly NativeBranchEntry[], expectedSessionHash: string): readonly NativeBindingState[] {
	const workIds = new Set<string>();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== BINDING_CUSTOM_TYPE) continue;
		const event = parseBindingEvent(entry.data);
		if (event.ownerSessionHash !== expectedSessionHash) throw new Error("Native verification binding belongs to a different owner session.");
		workIds.add(event.workId);
	}
	const bindings: NativeBindingState[] = [];
	for (const workId of workIds) {
		const state = restoreBindingState(branch, expectedSessionHash, workId);
		if (state) bindings.push(state);
	}
	return bindings;
}

export async function appendRunEvent(
	writer: AppendEntryWriter,
	binding: NativeVerificationBinding,
	runId: string,
	checkId: string,
): Promise<void> {
	await appendBindingEvent(writer, {
		version: 1,
		event: "run",
		ownerSessionHash: binding.ownerSessionHash,
		branchAnchorId: binding.branchAnchorId,
		workId: binding.workId,
		recordedAt: new Date().toISOString(),
		bindingId: binding.bindingId,
		attemptId: binding.attemptId,
		runId,
		checkId,
	});
}

export async function appendCertificationEvent(
	writer: AppendEntryWriter,
	binding: NativeVerificationBinding,
	receiptIds: readonly string[],
	evidenceDigest: string,
): Promise<void> {
	await appendBindingEvent(writer, {
		version: 1,
		event: "certified",
		ownerSessionHash: binding.ownerSessionHash,
		branchAnchorId: binding.branchAnchorId,
		workId: binding.workId,
		recordedAt: new Date().toISOString(),
		bindingId: binding.bindingId,
		attemptId: binding.attemptId,
		candidateId: binding.candidateId,
		requiredChecks: binding.requiredChecks,
		receiptIds,
		evidenceDigest,
	});
}

export async function appendCancellationEvent(writer: AppendEntryWriter, binding: NativeVerificationBinding): Promise<void> {
	await appendBindingEvent(writer, {
		version: 1,
		event: "cancelled",
		ownerSessionHash: binding.ownerSessionHash,
		branchAnchorId: binding.branchAnchorId,
		workId: binding.workId,
		recordedAt: new Date().toISOString(),
		bindingId: binding.bindingId,
		attemptId: binding.attemptId,
	});
}

export function validateBindingEvent(event: NativeBindingEvent): void {
	parseBindingEvent(event);
}

function parseBindingEvent(value: unknown): NativeBindingEvent {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Native verification event is not an object.");
	const record = value as Record<string, unknown>;
	if (record.version !== 1 || typeof record.event !== "string" || typeof record.ownerSessionHash !== "string" || typeof record.branchAnchorId !== "string" || typeof record.workId !== "string" || typeof record.recordedAt !== "string") {
		throw new Error("Native verification event has invalid base fields.");
	}
	if (record.event === "bound") assertKeys(record, [...BASE_EVENT_KEYS, "binding"]);
	else if (record.event === "run") assertKeys(record, [...BASE_EVENT_KEYS, "bindingId", "attemptId", "runId", "checkId"]);
	else if (record.event === "certified") assertKeys(record, [...BASE_EVENT_KEYS, "bindingId", "attemptId", "candidateId", "requiredChecks", "receiptIds", "evidenceDigest"]);
	else if (record.event === "cancelled") assertKeys(record, [...BASE_EVENT_KEYS, "bindingId", "attemptId"]);
	else throw new Error(`Unknown native verification event: ${record.event}`);
	if (!/^[a-f0-9]{64}$/.test(record.ownerSessionHash) || !isEntryId(record.branchAnchorId) || !record.workId || !Number.isFinite(Date.parse(record.recordedAt))) {
		throw new Error("Native verification event has invalid owner or branch identity.");
	}
	if (record.event === "bound") {
		if (typeof record.binding !== "object" || record.binding === null || Array.isArray(record.binding)) throw new Error("Native binding event has no binding payload.");
		const bindingRecord = record.binding as Record<string, unknown>;
		assertKeys(bindingRecord, BINDING_KEYS);
		const binding = record.binding as NativeVerificationBinding;
		validateBinding(binding);
		if (binding.ownerSessionHash !== record.ownerSessionHash || binding.branchAnchorId !== record.branchAnchorId || binding.workId !== record.workId) throw new Error("Native binding payload does not match its branch event.");
		return { ...record, event: "bound", binding } as NativeBindingEvent;
	}
	if (record.event === "run") {
		if (!isUuid(record.bindingId) || !isUuid(record.attemptId) || !isUuid(record.runId) || typeof record.checkId !== "string" || !record.checkId) throw new Error("Native run event has invalid identifiers.");
		return record as unknown as NativeBindingEvent;
	}
	if (record.event === "certified") {
		if (!isUuid(record.bindingId) || !isUuid(record.attemptId) || typeof record.candidateId !== "string" || !/^[a-f0-9]{64}$/.test(record.candidateId) || !Array.isArray(record.requiredChecks) || !record.requiredChecks.every((id: unknown) => typeof id === "string") || !Array.isArray(record.receiptIds) || !record.receiptIds.every(isUuid) || typeof record.evidenceDigest !== "string" || !/^[a-f0-9]{64}$/.test(record.evidenceDigest)) throw new Error("Native certification event has invalid evidence references.");
		return record as unknown as NativeBindingEvent;
	}
	if (!isUuid(record.bindingId) || !isUuid(record.attemptId)) throw new Error("Native cancellation event has invalid identifiers.");
	return record as unknown as NativeBindingEvent;
}

function validateBinding(binding: NativeVerificationBinding): void {
	if (binding.version !== 1 || !isUuid(binding.bindingId) || !isUuid(binding.attemptId)) throw new Error("Native verification binding has invalid identifiers.");
	if (!binding.workId || !binding.item || !isEntryId(binding.branchAnchorId) || !/^[a-f0-9]{64}$/.test(binding.ownerSessionHash) || !/^[a-f0-9]{64}$/.test(binding.repoId) || !/^[a-f0-9]{64}$/.test(binding.policyDigest) || !/^[a-f0-9]{64}$/.test(binding.scopeDigest) || !/^[a-f0-9]{64}$/.test(binding.candidateId)) throw new Error("Native verification binding has invalid scope identities.");
	if (!/^[A-Za-z0-9-]{1,128}$/.test(binding.snapshotRef) || !binding.profile || !Array.isArray(binding.additionalChecks) || !binding.additionalChecks.every((id) => typeof id === "string") || !Array.isArray(binding.requiredChecks) || !binding.requiredChecks.every((id) => typeof id === "string") || !Number.isFinite(Date.parse(binding.createdAt))) throw new Error("Native verification binding has invalid check or snapshot references.");
	if (!binding.scopeArtifact || binding.scopeArtifact.includes("\0")) throw new Error("Native verification binding has an invalid scope artifact reference.");
}

async function resolveOwnerLocalArtifact(reference: string, sessionFile: string | undefined): Promise<ResolvedScopeArtifact> {
	if (!sessionFile) throw new Error("Owner-session local artifacts require a persistent native session file.");
	const relative = parseLocalRelativePath(reference);
	const canonicalSessionFile = await realpath(sessionFile);
	const sessionMetadata = await stat(canonicalSessionFile);
	if (!sessionMetadata.isFile() || !canonicalSessionFile.endsWith(".jsonl")) throw new Error("Owner native session file is missing or invalid.");
	const sessionStem = canonicalSessionFile.slice(0, -".jsonl".length);
	const localRoot = await realpath(path.join(sessionStem, "local"));
	if (!isWithin(sessionStem, localRoot)) throw new Error("Owner local artifact root resolves outside the session directory.");
	const target = path.resolve(localRoot, relative);
	if (!isWithin(localRoot, target)) throw new Error("Local scope artifact path escapes the owner-session local directory.");
	return await readBoundedRegularFile(reference, target, localRoot);
}

async function readBoundedRegularFile(reference: string, target: string, allowedRoot: string): Promise<ResolvedScopeArtifact> {
	const metadata = await lstat(target);
	if (!metadata.isFile() && !metadata.isSymbolicLink()) throw new Error("Scope artifact must be a regular file.");
	const actual = await realpath(target);
	if (!isWithin(allowedRoot, actual)) throw new Error("Scope artifact symlink resolves outside its allowed root.");
	const actualMetadata = await stat(actual);
	if (!actualMetadata.isFile()) throw new Error("Scope artifact must be a regular file.");
	if (actualMetadata.size > MAX_SCOPE_ARTIFACT_BYTES) throw new Error(`Scope artifact exceeds ${MAX_SCOPE_ARTIFACT_BYTES} bytes.`);
	const bytes: Uint8Array = await readFile(actual);
	const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	return { reference, resolvedPath: actual, digest: digestBytes(bytes), text };
}

function parseLocalRelativePath(reference: string): string {
	const raw = reference.slice("local://".length);
	if (!raw || raw.includes("?") || raw.includes("#") || raw.includes("\\")) throw new Error("Owner-session scope artifacts must use local://<relative-name> without query or fragment.");
	let decoded: string;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		throw new Error("Scope artifact URL has invalid percent encoding.");
	}
	if (decoded.startsWith("/") && !raw.startsWith("/")) throw new Error("Local scope artifact path cannot encode an absolute path.");
	if (raw.startsWith("/")) decoded = decoded.slice(1);
	const segments = decoded.split("/");
	if (!decoded || decoded.includes("\0") || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) throw new Error("Local scope artifact path must be a safe relative path.");
	return decoded;
}
function assertKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
	for (const key of Object.keys(record)) if (!allowed.includes(key)) throw new Error(`Unknown native verification field: ${key}`);
}

function isEntryId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function isUuid(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function digestText(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function digestBytes(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}
