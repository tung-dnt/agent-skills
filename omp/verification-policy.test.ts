import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { classifyChangedPaths, loadPolicy, parsePolicy, requiredChecks, type VerificationPolicy } from "./verification-policy.ts";
import { testPolicy } from "./verification-test-helpers.ts";

function policyData(): unknown {
	return {
		version: 1,
		minimumProfile: "full",
		profiles: [
			{ id: "focused", checks: ["unit"] },
			{ id: "full", checks: ["unit", "lint"] },
		],
		checks: {
			unit: { argv: ["node", "--test"], kind: "static", timeoutSeconds: 60, preparations: ["deps"] },
			lint: { argv: ["node", "lint.js"], kind: "static", timeoutSeconds: 60, preparations: [] },
			types: { argv: ["node", "types.js"], kind: "static", timeoutSeconds: 60, preparations: [] },
		},
		classifications: [
			{ pattern: "src/**", kind: "source" },
			{ pattern: "test/**", kind: "test" },
			{ pattern: "*.json", kind: "configuration" },
			{ pattern: "generated/**", kind: "generated" },
			{ pattern: "ignored/**", kind: "excluded" },
		],
		pathRules: [{ pattern: "src/**", checks: ["types"] }],
		preparations: { deps: { argv: ["node", "install.js"], timeoutSeconds: 60, outputs: ["node_modules/**"] } },
		resources: {},
	};
}

async function repoWithPolicy(policy: unknown = policyData()): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "verification-policy-"));
	await mkdir(path.join(root, ".omp"));
	await writeFile(path.join(root, ".omp", "verification.json"), JSON.stringify(policy));
	return root;
}

async function cleanup(root: string): Promise<void> {
	await rm(root, { recursive: true, force: true });
}

test("an absent policy is explicitly unprotected, while a valid policy is protected and digested", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "verification-unprotected-"));
	try {
		assert.equal((await loadPolicy(root)).status, "unprotected");
		await mkdir(path.join(root, ".omp"));
		await writeFile(path.join(root, ".omp", "verification.json"), JSON.stringify(policyData()));
		const result = await loadPolicy(root);
		assert.equal(result.status, "protected");
		if (result.status === "protected") assert.match(result.digest, /^[a-f0-9]{64}$/);
	} finally {
		await cleanup(root);
	}
});

test("malformed, unknown, and deleted policy contents fail closed instead of becoming unprotected", async () => {
	const root = await repoWithPolicy({ version: 2 });
	try {
		const malformed = await loadPolicy(root);
		assert.equal(malformed.status, "refused");
		if (malformed.status === "refused") assert.equal(malformed.code, "POLICY_INVALID");
		await writeFile(path.join(root, ".omp", "verification.json"), "{");
		assert.equal((await loadPolicy(root)).status, "refused");
		await rm(path.join(root, ".omp", "verification.json"));
		assert.equal((await loadPolicy(root)).status, "unprotected");
	} finally {
		await cleanup(root);
	}
});

test("policy validation rejects unsafe argv, weakly ordered profiles, and unknown checks", () => {
	const unsafe = policyData() as { checks: Record<string, Record<string, unknown>> };
	unsafe.checks.unit.argv = "node --test";
	assert.throws(() => parsePolicy(unsafe), /argument array/);
	const weak = policyData() as { profiles: Array<{ id: string; checks: string[] }> };
	weak.profiles[1] = { id: "full", checks: ["lint"] };
	assert.throws(() => parsePolicy(weak), /weakens an earlier profile/);
	const unknown = policyData() as { pathRules: Array<{ pattern: string; checks: string[] }> };
	unknown.pathRules[0]?.checks.push("missing");
	assert.throws(() => parsePolicy(unknown), /unknown check/);
});

test("weak profiles are refused and callers can only add known checks", () => {
	const policy = parsePolicy(policyData());
	assert.throws(() => requiredChecks(policy, { profile: "focused", additionalChecks: [] }, ["src/main.ts"]), /weaker than required/);
	assert.deepEqual(requiredChecks(policy, { profile: "full", additionalChecks: ["types"] }, ["src/main.ts"]), ["lint", "types", "unit"]);
	assert.throws(() => requiredChecks(policy, { profile: "full", additionalChecks: ["missing"] }, []), /Unknown additional/);
});

test("unknown, ambiguous, excluded, and unsafe paths are rejected; changed source gets mandatory path checks", () => {
	const policy = parsePolicy(policyData());
	assert.deepEqual(classifyChangedPaths(policy, ["src/new.ts"]), [{ path: "src/new.ts", kind: "source" }]);
	assert.throws(() => classifyChangedPaths(policy, ["README.md"]), /unclassified/);
	assert.throws(() => classifyChangedPaths(policy, ["ignored/private.ts"]), /excluded/);
	const ambiguous = parsePolicy({ ...(policyData() as object), classifications: [
		{ pattern: "src/**", kind: "source" }, { pattern: "src/*.ts", kind: "test" },
	] });
	assert.throws(() => classifyChangedPaths(ambiguous, ["src/new.ts"]), /ambiguous/);
	assert.throws(() => parsePolicy({ ...(policyData() as object), classifications: [{ pattern: "../outside/**", kind: "source" }] }), /safe repository-relative glob/);
});
test("runtime checks require a named generation resource rather than a PID or attempt fallback", () => {
	const policy = policyData() as Record<string, unknown>;
	const checks = policy.checks as Record<string, Record<string, unknown>>;
	checks.runtime = { argv: ["node", "-e", "process.exit(0)"], kind: "runtime", timeoutSeconds: 10, preparations: [], resourceId: "missing" };
	assert.throws(() => parsePolicy(policy), /configured resourceId/);
	const configured = testPolicy();
	assert.equal(parsePolicy(configured).checks.integration?.resourceId, "test-runtime");
});

test("profile and policy objects contain only validated named command data", () => {
	const policy: VerificationPolicy = parsePolicy(policyData());
	assert.deepEqual(policy.profiles.map((profile) => profile.id), ["focused", "full"]);
	assert.deepEqual(policy.checks.unit?.argv, ["node", "--test"]);
});
