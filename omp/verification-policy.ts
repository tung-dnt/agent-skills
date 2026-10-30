import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import * as path from "node:path";

export const POLICY_RELATIVE_PATH = ".omp/verification.json";

export type InputKind = "source" | "test" | "configuration" | "generated" | "excluded";

export interface VerificationCheck {
	readonly argv: readonly string[];
	readonly kind: "static" | "runtime";
	readonly timeoutSeconds: number;
	readonly preparations: readonly string[];
	readonly resourceId?: string;
}

export interface VerificationResource {
	readonly argv: readonly string[];
	readonly timeoutSeconds: number;
}

export interface VerificationPreparation {
	readonly argv: readonly string[];
	readonly timeoutSeconds: number;
	readonly outputs: readonly string[];
}
	

export interface VerificationProfile {
	readonly id: string;
	readonly checks: readonly string[];
}

export interface VerificationPathRule {
	readonly pattern: string;
	readonly checks: readonly string[];
}

export interface VerificationClassification {
	readonly pattern: string;
	readonly kind: InputKind;
}

export interface VerificationPolicy {
	readonly version: 1;
	readonly minimumProfile: string;
	readonly profiles: readonly VerificationProfile[];
	readonly checks: Readonly<Record<string, VerificationCheck>>;
	readonly classifications: readonly VerificationClassification[];
	readonly pathRules: readonly VerificationPathRule[];
	readonly preparations: Readonly<Record<string, VerificationPreparation>>;
	readonly resources: Readonly<Record<string, VerificationResource>>;
}

export type PolicyResult =
	| { readonly status: "unprotected"; readonly root: string }
	| { readonly status: "protected"; readonly root: string; readonly policy: VerificationPolicy; readonly digest: string }
	| { readonly status: "refused"; readonly root: string; readonly code: string; readonly reason: string };

export interface ApprovedScope {
	readonly profile: string;
	readonly additionalChecks: readonly string[];
}

export interface ClassifiedPath {
	readonly path: string;
	readonly kind: Exclude<InputKind, "excluded">;
}

const POLICY_KEYS = ["version", "minimumProfile", "profiles", "checks", "classifications", "pathRules", "preparations", "resources"];
const MAX_POLICY_BYTES = 1_048_576;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/;

export async function loadPolicy(root: string): Promise<PolicyResult> {
	let canonicalRoot: string;
	try {
		canonicalRoot = await realpath(root);
	} catch (error) {
		return { status: "refused", root: path.resolve(root), code: "REPOSITORY_UNAVAILABLE", reason: messageOf(error) };
	}
	const file = path.join(canonicalRoot, POLICY_RELATIVE_PATH);
	try {
		await lstat(file);
	} catch (error) {
		if (isMissing(error)) return { status: "unprotected", root: canonicalRoot };
		return { status: "refused", root: canonicalRoot, code: "POLICY_UNREADABLE", reason: messageOf(error) };
	}
	let realPolicy: string;
	try {
		realPolicy = await realpath(file);
	} catch (error) {
		return { status: "refused", root: canonicalRoot, code: "POLICY_INVALID", reason: messageOf(error) };
	}
	if (!isWithin(canonicalRoot, realPolicy)) {
		return { status: "refused", root: canonicalRoot, code: "POLICY_OUTSIDE_REPOSITORY", reason: "The verification policy resolves outside the repository." };
	}
	try {
		const metadata = await stat(realPolicy);
		if (!metadata.isFile()) return { status: "refused", root: canonicalRoot, code: "POLICY_INVALID", reason: "The verification policy must be a regular file." };
		if (metadata.size > MAX_POLICY_BYTES) return { status: "refused", root: canonicalRoot, code: "POLICY_TOO_LARGE", reason: `The verification policy exceeds ${MAX_POLICY_BYTES} bytes.` };
		const bytes: Uint8Array = await readFile(realPolicy);
		const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		const policy = parsePolicy(parsed);
		return { status: "protected", root: canonicalRoot, policy, digest: createHash("sha256").update(bytes).digest("hex") };
	} catch (error) {
		return { status: "refused", root: canonicalRoot, code: "POLICY_INVALID", reason: messageOf(error) };
	}
}

export function parsePolicy(value: unknown): VerificationPolicy {
	if (!isRecord(value)) throw new Error("Policy must be a JSON object.");
	for (const key of Object.keys(value)) {
		if (!POLICY_KEYS.includes(key)) throw new Error(`Unknown policy field: ${key}`);
	}
	if (value.version !== 1) throw new Error("Policy version must be 1.");
	if (typeof value.minimumProfile !== "string" || !ID.test(value.minimumProfile)) throw new Error("minimumProfile must name a valid profile.");
	if (!Array.isArray(value.profiles) || value.profiles.length === 0) throw new Error("profiles must be a non-empty ordered array.");
	if (!isRecord(value.checks) || !isRecord(value.preparations) || !isRecord(value.resources) || !Array.isArray(value.classifications) || !Array.isArray(value.pathRules)) {
		throw new Error("checks, preparations, resources, classifications, and pathRules have invalid shapes.");
	}

	const resources: Record<string, VerificationResource> = Object.create(null) as Record<string, VerificationResource>;
	for (const [id, raw] of Object.entries(value.resources)) {
		assertId(id, "resource id");
		if (!isRecord(raw)) throw new Error(`Resource ${id} must be an object.`);
		assertKeys(raw, ["argv", "timeoutSeconds"], `resource ${id}`);
		resources[id] = { argv: parseArgv(raw.argv, `resource ${id}`), timeoutSeconds: parseTimeout(raw.timeoutSeconds, `resource ${id}`) };
	}

	const checks: Record<string, VerificationCheck> = Object.create(null) as Record<string, VerificationCheck>;
	for (const [id, raw] of Object.entries(value.checks)) {
		assertId(id, "check id");
		if (!isRecord(raw)) throw new Error(`Check ${id} must be an object.`);
		assertKeys(raw, ["argv", "kind", "timeoutSeconds", "preparations", "resourceId"], `check ${id}`);
		const kind = parseCheckKind(raw.kind, `check ${id}`);
		const resourceId = raw.resourceId;
		if (kind === "runtime" && (typeof resourceId !== "string" || !ID.test(resourceId) || !resources[resourceId])) throw new Error(`Runtime check ${id} must name a configured resourceId.`);
		if (kind === "static" && resourceId !== undefined) throw new Error(`Static check ${id} cannot declare a runtime resourceId.`);
		checks[id] = {
			argv: parseArgv(raw.argv, `check ${id}`),
			kind,
			timeoutSeconds: parseTimeout(raw.timeoutSeconds, `check ${id}`),
			preparations: parseIds(raw.preparations, `check ${id} preparations`),
			...(typeof resourceId === "string" ? { resourceId } : {}),
		};
	}
	if (Object.keys(checks).length === 0) throw new Error("At least one named check is required.");


	const preparations: Record<string, VerificationPreparation> = Object.create(null) as Record<string, VerificationPreparation>;
	for (const [id, raw] of Object.entries(value.preparations)) {
		assertId(id, "preparation id");
		if (!isRecord(raw)) throw new Error(`Preparation ${id} must be an object.`);
		assertKeys(raw, ["argv", "timeoutSeconds", "outputs"], `preparation ${id}`);
		preparations[id] = {
			argv: parseArgv(raw.argv, `preparation ${id}`),
			timeoutSeconds: parseTimeout(raw.timeoutSeconds, `preparation ${id}`),
			outputs: parsePatterns(raw.outputs, `preparation ${id} outputs`),
		};
	}

	const profiles: VerificationProfile[] = [];
	const profileIds = new Set<string>();
	for (const raw of value.profiles) {
		if (!isRecord(raw)) throw new Error("Each profile must be an object.");
		assertKeys(raw, ["id", "checks"], "profile");
		if (typeof raw.id !== "string") throw new Error("Profile id must be a string.");
		assertId(raw.id, "profile id");
		if (profileIds.has(raw.id)) throw new Error(`Duplicate profile id ${raw.id}.`);
		profileIds.add(raw.id);
		profiles.push({ id: raw.id, checks: parseIds(raw.checks, `profile ${raw.id} checks`) });
	}
	const minimumIndex = profiles.findIndex((profile) => profile.id === value.minimumProfile);
	if (minimumIndex < 0) throw new Error(`minimumProfile ${value.minimumProfile} is not declared.`);
	let inherited = new Set<string>();
	for (const profile of profiles) {
		for (const id of profile.checks) {
			if (!checks[id]) throw new Error(`Profile ${profile.id} names unknown check ${id}.`);
		}
		for (const id of inherited) {
			if (!profile.checks.includes(id)) throw new Error(`Profile ${profile.id} weakens an earlier profile by omitting ${id}.`);
		}
		inherited = new Set(profile.checks);
	}
	for (const [id, check] of Object.entries(checks)) {
		for (const preparation of check.preparations) {
			if (!preparations[preparation]) throw new Error(`Check ${id} names unknown preparation ${preparation}.`);
		}
	}

	const classifications: VerificationClassification[] = value.classifications.map((raw: unknown) => {
		if (!isRecord(raw)) throw new Error("Each classification must be an object.");
		assertKeys(raw, ["pattern", "kind"], "classification");
		return { pattern: parsePattern(raw.pattern, "classification pattern"), kind: parseKind(raw.kind, "classification") };
	});
	const pathRules: VerificationPathRule[] = value.pathRules.map((raw: unknown) => {
		if (!isRecord(raw)) throw new Error("Each path rule must be an object.");
		assertKeys(raw, ["pattern", "checks"], "path rule");
		const rule = { pattern: parsePattern(raw.pattern, "path rule pattern"), checks: parseIds(raw.checks, "path rule checks") };
		for (const id of rule.checks) if (!checks[id]) throw new Error(`Path rule names unknown check ${id}.`);
		return rule;
	});

	return {
		version: 1,
		minimumProfile: value.minimumProfile,
		profiles,
		checks,
		resources,
		classifications,
		pathRules,
		preparations,
	};
}

export function classifyChangedPaths(policy: VerificationPolicy, changedPaths: readonly string[]): readonly ClassifiedPath[] {
	const result: ClassifiedPath[] = [];
	for (const file of changedPaths) {
		const matches = policy.classifications.filter((rule) => matchesGlob(rule.pattern, file));
		const kinds = new Set(matches.map((rule) => rule.kind));
		if (kinds.size !== 1) throw new Error(kinds.size === 0 ? `Changed input is unclassified: ${file}` : `Changed input has ambiguous classifications: ${file}`);
		const kind = matches[0]?.kind;
		if (!kind || kind === "excluded") throw new Error(`Changed input is excluded by policy: ${file}`);
		result.push({ path: file, kind });
	}
	return result;
}
export function validateCandidateInputs(
	policy: VerificationPolicy,
	candidatePaths: readonly string[],
	changedPaths: readonly string[],
): void {
	const changed = new Set(changedPaths);
	for (const file of candidatePaths) {
		const matches = policy.classifications.filter((rule) => matchesGlob(rule.pattern, file));
		const kinds = new Set(matches.map((rule) => rule.kind));
		if (kinds.size === 0) throw new Error(`Candidate input is unclassified: ${file}`);
		if (kinds.size > 1) throw new Error(`Candidate input has ambiguous classifications: ${file}`);
		if (kinds.has("excluded") && changed.has(file)) throw new Error(`Changed input is excluded by policy: ${file}`);
	}
	classifyChangedPaths(policy, changedPaths);
}

export function requiredChecks(
	policy: VerificationPolicy,
	scope: ApprovedScope,
	changedPaths: readonly string[],
): readonly string[] {
	const minimumIndex = policy.profiles.findIndex((profile) => profile.id === policy.minimumProfile);
	const selectedIndex = policy.profiles.findIndex((profile) => profile.id === scope.profile);
	if (selectedIndex < minimumIndex) throw new Error(`Profile ${scope.profile} is weaker than required profile ${policy.minimumProfile}.`);
	const selected = policy.profiles[selectedIndex];
	if (!selected) throw new Error(`Unknown verification profile: ${scope.profile}`);
	const required = new Set<string>();
	for (const profile of policy.profiles.slice(0, selectedIndex + 1)) {
		for (const id of profile.checks) required.add(id);
	}
	for (const id of scope.additionalChecks) {
		if (!policy.checks[id]) throw new Error(`Unknown additional verification check: ${id}`);
		required.add(id);
	}
	classifyChangedPaths(policy, changedPaths);
	for (const file of changedPaths) {
		for (const rule of policy.pathRules) {
			if (!matchesGlob(rule.pattern, file)) continue;
			for (const id of rule.checks) required.add(id);
		}
	}
	return [...required].sort();
}

export function matchesGlob(pattern: string, file: string): boolean {
	let source = "^";
	for (let index = 0; index < pattern.length; index += 1) {
		const character = pattern[index];
		if (character === "*" && pattern[index + 1] === "*") {
			index += 1;
			if (pattern[index + 1] === "/") {
				index += 1;
				source += "(?:.*/)?";
			} else {
				source += ".*";
			}
		} else if (character === "*") source += "[^/]*";
		else if (character === "?") source += "[^/]";
		else source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
	}
	return new RegExp(`${source}$`).test(file);
}

function parseKind(value: unknown, label: string): InputKind {
	if (value === "source" || value === "test" || value === "configuration" || value === "generated" || value === "excluded") return value;
	throw new Error(`${label} kind is invalid.`);
}

function parseArgv(value: unknown, label: string): readonly string[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > 128) throw new Error(`${label} argv must be a non-empty argument array.`);
	const argv: string[] = [];
	for (const argument of value) {
		if (typeof argument !== "string" || argument.length === 0 || argument.length > 4096 || argument.includes("\0")) {
			throw new Error(`${label} argv contains an invalid argument.`);
		}
		argv.push(argument);
	}
	return argv;
}

function parseTimeout(value: unknown, label: string): number {
	if (value === undefined) return 300;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 3600) throw new Error(`${label} timeoutSeconds must be an integer from 1 to 3600.`);
	return value;
}

function parseIds(value: unknown, label: string): readonly string[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string") throw new Error(`${label} contains a non-string id.`);
		assertId(item, label);
		if (seen.has(item)) throw new Error(`${label} contains duplicate id ${item}.`);
		seen.add(item);
		ids.push(item);
	}
	return ids;
}

function parsePatterns(value: unknown, label: string): readonly string[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
	return value.map((pattern: unknown) => parsePattern(pattern, label));
}

function parsePattern(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => part === ".." || part === ".")) {
		throw new Error(`${label} must be a safe repository-relative glob.`);
	}
	if (value.includes("\0")) throw new Error(`${label} contains a NUL byte.`);
	return value;
}

function parseCheckKind(value: unknown, label: string): "static" | "runtime" {
	if (value === "static" || value === "runtime") return value;
	throw new Error(`${label} kind must be static or runtime.`);
}

function assertId(value: string, label: string): void {
	if (!ID.test(value)) throw new Error(`${label} is invalid.`);
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
	for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown ${label} field: ${key}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
