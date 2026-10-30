import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import agentSkills from "./index.ts";
import { BINDING_CUSTOM_TYPE, type NativeBranchEntry } from "./verification-bindings.ts";
import { parseVerificationCommand, parseVerificationRequest, type VerificationHostContext, type VerificationToolResponse } from "./verification-tool.ts";
import { latestTodoSnapshot } from "./native-todo-gate.ts";
import { createGitRepo, dispose } from "./verification-test-helpers.ts";

interface ToolRegistration {
	readonly name: string;
	readonly strict?: boolean;
	readonly parameters: unknown;
	execute(id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, context: VerificationHostContext): Promise<VerificationToolResponse>;
}

interface CommandRegistration {
	handler(args: string, context: VerificationHostContext): Promise<void> | void;
}

interface ExtensionHarness {
	readonly api: ExtensionAPI;
	readonly entries: NativeBranchEntry[];
	readonly tools: Map<string, ToolRegistration>;
	readonly commands: Map<string, CommandRegistration>;
	readonly hooks: Map<string, (event: unknown, context: VerificationHostContext) => Promise<unknown> | unknown>;
	readonly notifications: string[];
	readonly prompts: string[];
	readonly context: VerificationHostContext;
}

function schemaField(): { optional(): unknown } {
	return { optional() { return this; } };
}

async function extensionHarness(
	root: string,
	stateDirectory: string,
	options: { readonly hasUI?: boolean; readonly approval?: boolean } = {},
): Promise<ExtensionHarness> {
	const sessionDirectory = path.join(stateDirectory, "sessions");
	const sessionFile = path.join(sessionDirectory, "100_session.jsonl");
	const artifactDirectory = path.join(path.dirname(sessionFile), "100_session", "local");
	await mkdir(artifactDirectory, { recursive: true });
	await writeFile(sessionFile, JSON.stringify({ type: "session", id: randomUUID() }) + "\n");
	await writeFile(path.join(artifactDirectory, "design.md"), "Approved implementation scope\nChanged files: source and tests.\n");
	const item = "[w1] Verify final candidate";
	const entries: NativeBranchEntry[] = [{
		id: "todo_state",
		type: "message",
		message: {
			role: "toolResult",
			toolName: "todo",
			isError: false,
			details: { op: "view", phases: [{ name: "Build", tasks: [{ content: item, status: "pending" }] }] },
		},
	}];
	const tools = new Map<string, ToolRegistration>();
	const commands = new Map<string, CommandRegistration>();
	const hooks = new Map<string, (event: unknown, context: VerificationHostContext) => Promise<unknown> | unknown>();
	const notifications: string[] = [];
	const prompts: string[] = [];
	const context: VerificationHostContext = {
		cwd: root,
		hasUI: options.hasUI ?? true,
		agent: { kind: "main" },
		ui: {
			async confirm(title, message) {
				prompts.push(`${title}\n${message}`);
				return options.approval ?? true;
			},
			notify(message) { notifications.push(message); },
		},
		sessionManager: {
			getBranch: () => entries,
			getSessionFile: () => sessionFile,
		},
	};
	const api = {
		zod: {
			object(shape: unknown) { return { shape }; },
			enum(values: readonly string[]) { return { values }; },
			string: schemaField,
			array: schemaField,
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ id: randomUUID(), type: "custom", customType, data });
		},
		registerTool(definition: unknown) {
			const tool = definition as ToolRegistration;
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, definition: unknown) {
			commands.set(name, definition as CommandRegistration);
		},
		on(event: string, handler: unknown) {
			hooks.set(event, handler as (event: unknown, context: VerificationHostContext) => Promise<unknown> | unknown);
		},
	};
	return { api: api as unknown as ExtensionAPI, entries, tools, commands, hooks, notifications, prompts, context };
}

async function runTool(harness: ExtensionHarness, params: unknown, context: VerificationHostContext = harness.context): Promise<VerificationToolResponse> {
	const tool = harness.tools.get("verification");
	if (!tool) throw new Error("The verification tool was not registered.");
	return await tool.execute("call", params, undefined, undefined, context);
}

async function waitForCompletedStatus(harness: ExtensionHarness, workId: string, checkId = "unit"): Promise<VerificationToolResponse> {
	// This smoke harness runs a real OS child; poll the public status operation until its exit is observed.
	for (let attempt = 0; attempt < 500; attempt += 1) {
		const result = await runTool(harness, { op: "status", workId });
		if (result.content[0]?.text.includes(`${checkId}: passed`)) return result;
		if (result.content[0]?.text.includes(`${checkId}: failed`) || result.content[0]?.text.includes(`${checkId}: interrupted`)) return result;
		await delay(10);
	}
	throw new Error("The registered verification tool never observed the child exit.");
}

async function cleanupHarness(root: string, stateDirectory: string, harness: ExtensionHarness): Promise<void> {
	await harness.hooks.get("session_shutdown")?.(undefined, harness.context);
	await rm(stateDirectory, { recursive: true, force: true });
	await dispose(root);
}

test("extension registers only verification tool and slash command, then drives approval, run, status, and evidence-only completion", async () => {
	const root = await createGitRepo();
	const stateDirectory = path.join(path.dirname(root), `verification-extension-state-${path.basename(root)}`);
	const previousStateHome = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = stateDirectory;
	const harness = await extensionHarness(root, stateDirectory);
	try {
		agentSkills(harness.api);
		assert.ok(harness.tools.has("verification"));
		assert.ok(!harness.tools.has("work_state"));
		assert.ok(harness.commands.has("verification"));
		assert.ok(!harness.hooks.has("before_agent_start"));
		const registered = harness.tools.get("verification");
		assert.equal(registered?.strict, true);
		const schema = registered?.parameters as { shape?: Record<string, unknown> };
		assert.deepEqual(Object.keys(schema.shape ?? {}).sort(), ["additionalChecks", "checkId", "item", "op", "profile", "scopeArtifact", "workId"].sort());
		const item = "[w1] Verify final candidate";
		const started = await runTool(harness, { op: "begin", workId: "w1", item, scopeArtifact: "local://design.md" });
		assert.equal(started.isError, undefined);
		assert.match(started.content[0]?.text ?? "", /Required checks: unit/);
		assert.ok(harness.prompts.some((prompt) => prompt.includes("Approved implementation scope")));
		assert.equal(harness.entries.filter((entry) => entry.type === "custom" && entry.customType === BINDING_CUSTOM_TYPE).length, 1);
		const todoHook = harness.hooks.get("tool_call");
		if (!todoHook) throw new Error("Native todo interception hook was not registered.");

		const blockedBeforeEvidence = await todoHook({ toolName: "todo", input: { op: "done", task: item } }, harness.context);
		assert.equal(typeof blockedBeforeEvidence, "object");
		assert.match(String((blockedBeforeEvidence as { reason?: unknown }).reason), /fresh verification evidence/);
		assert.equal(await todoHook({ toolName: "task", input: { task: "worker finished" } }, harness.context), undefined);

		const run = await runTool(harness, { op: "run", workId: "w1", checkId: "unit" });
		assert.equal(run.isError, undefined);
		await waitForCompletedStatus(harness, "w1");
		const complete = await runTool(harness, { op: "complete", workId: "w1" });
		assert.equal(complete.isError, undefined);
		assert.match(complete.content[0]?.text ?? "", /certified on the active native branch/);
		assert.equal(latestTodoSnapshot(harness.entries)?.phases[0]?.tasks[0]?.status, "pending");
		assert.equal(await todoHook({ toolName: "todo", input: { op: "done", task: item } }, harness.context), undefined);
		const command = harness.commands.get("verification");
		if (!command) throw new Error("The /verification command was not registered.");
		await command.handler("status --work-id w1", harness.context);
		assert.ok(harness.notifications.at(-1)?.includes("unit: passed"));
	} finally {
		await cleanupHarness(root, stateDirectory, harness);
		if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
		else process.env.XDG_STATE_HOME = previousStateHome;
	}
});

test("scope approval fails closed without UI or after decline, and no model payload can approve or inject execution", async () => {
	for (const options of [{ hasUI: false }, { hasUI: true, approval: false }]) {
		const root = await createGitRepo();
		const stateDirectory = path.join(path.dirname(root), `verification-denial-state-${path.basename(root)}`);
		const previousStateHome = process.env.XDG_STATE_HOME;
		process.env.XDG_STATE_HOME = stateDirectory;
		const harness = await extensionHarness(root, stateDirectory, options);
		try {
			agentSkills(harness.api);
			const result = await runTool(harness, { op: "begin", workId: "w1", item: "[w1] Verify final candidate", scopeArtifact: "local://design.md" });
			assert.equal(result.isError, true);
			assert.equal(harness.entries.filter((entry) => entry.type === "custom" && entry.customType === BINDING_CUSTOM_TYPE).length, 0);
		} finally {
			await cleanupHarness(root, stateDirectory, harness);
			if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
			else process.env.XDG_STATE_HOME = previousStateHome;
		}
	}
	assert.throws(() => parseVerificationRequest({ op: "begin", workId: "w1", item: "x", scopeArtifact: "x", approve: true }), /Unknown verification argument/);
	assert.throws(() => parseVerificationRequest({ op: "run", workId: "w1", checkId: "unit", command: ["sh"] }), /Unknown verification argument/);
	assert.throws(() => parseVerificationRequest({ op: "complete", workId: "w1", receipt: { state: "passed" } }), /Unknown verification argument/);
	assert.throws(() => parseVerificationCommand("begin --work-id w1 --item task --scope-artifact local://design.md --approve true"), /Unknown verification command option/);
	assert.deepEqual(parseVerificationCommand("run --work-id w1 --check-id unit"), { op: "run", workId: "w1", checkId: "unit" });
});

test("native session and repository mismatches prevent reusing a binding", async () => {
	const root = await createGitRepo();
	const otherRoot = await createGitRepo();
	const stateDirectory = path.join(path.dirname(root), `verification-mismatch-state-${path.basename(root)}`);
	const previousStateHome = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = stateDirectory;
	const harness = await extensionHarness(root, stateDirectory);
	try {
		agentSkills(harness.api);
		await runTool(harness, { op: "begin", workId: "w1", item: "[w1] Verify final candidate", scopeArtifact: "local://design.md" });
		const sessionFile = harness.context.sessionManager.getSessionFile();
		const otherSessionFile = path.join(stateDirectory, "other-session.jsonl");
		await writeFile(otherSessionFile, "{}\n");
		const wrongSession: VerificationHostContext = {
			...harness.context,
			sessionManager: { ...harness.context.sessionManager, getSessionFile: () => otherSessionFile },
		};
		const sessionMismatch = await runTool(harness, { op: "status", workId: "w1" }, wrongSession);
		assert.equal(sessionMismatch.isError, true);
		assert.ok(sessionFile);
		const wrongRepository: VerificationHostContext = { ...harness.context, cwd: otherRoot };
		const repositoryMismatch = await runTool(harness, { op: "run", workId: "w1", checkId: "unit" }, wrongRepository);
		assert.equal(repositoryMismatch.isError, true);
		assert.match(repositoryMismatch.content[0]?.text ?? "", /different repository or Git worktree/);
	} finally {
		await cleanupHarness(root, stateDirectory, harness);
		await dispose(otherRoot);
		if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
		else process.env.XDG_STATE_HOME = previousStateHome;
	}
});

test("changed or deleted owner-local scope invalidates public run, certification, and native completion", async () => {
	for (const change of ["modify", "delete"] as const) {
		const root = await createGitRepo();
		const stateDirectory = path.join(path.dirname(root), `verification-scope-${path.basename(root)}`);
		const previousStateHome = process.env.XDG_STATE_HOME;
		process.env.XDG_STATE_HOME = stateDirectory;
		const harness = await extensionHarness(root, stateDirectory);
		try {
			agentSkills(harness.api);
			const item = "[w1] Verify final candidate";
			assert.equal((await runTool(harness, { op: "begin", workId: "w1", item, scopeArtifact: "local://design.md" })).isError, undefined);
			assert.equal((await runTool(harness, { op: "run", workId: "w1", checkId: "unit" })).isError, undefined);
			await waitForCompletedStatus(harness, "w1");
			assert.equal((await runTool(harness, { op: "complete", workId: "w1" })).isError, undefined);
			const sessionFile = harness.context.sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Fixture owner session is missing.");
			const scopeFile = path.join(sessionFile.slice(0, -".jsonl".length), "local", "design.md");
			if (change === "modify") await writeFile(scopeFile, "Changed scope, not approved.\n");
			else await rm(scopeFile);
			assert.equal((await runTool(harness, { op: "run", workId: "w1", checkId: "unit" })).isError, true);
			assert.equal((await runTool(harness, { op: "complete", workId: "w1" })).isError, true);
			const hook = harness.hooks.get("tool_call");
			if (!hook) throw new Error("Native completion hook is missing.");
			for (const input of [{ op: "done", task: item }, { op: "done", phase: "Build" }, { op: "done" }]) {
				const decision = await hook({ toolName: "todo", input }, harness.context) as { block?: boolean } | undefined;
				assert.equal(decision?.block, true);
			}
		} finally {
			await cleanupHarness(root, stateDirectory, harness);
			if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
			else process.env.XDG_STATE_HOME = previousStateHome;
		}
	}
});

test("cancel then approve a new work label for the same item without historical binding deadlock", async () => {
	const root = await createGitRepo();
	const stateDirectory = path.join(path.dirname(root), `verification-rebind-${path.basename(root)}`);
	const previousStateHome = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = stateDirectory;
	const harness = await extensionHarness(root, stateDirectory);
	try {
		agentSkills(harness.api);
		const item = "[w1] Verify final candidate";
		assert.equal((await runTool(harness, { op: "begin", workId: "w1", item, scopeArtifact: "local://design.md" })).isError, undefined);
		assert.equal((await runTool(harness, { op: "cancel", workId: "w1" })).isError, undefined);
		assert.equal((await runTool(harness, { op: "begin", workId: "w2", item, scopeArtifact: "local://design.md" })).isError, undefined);
		assert.equal((await runTool(harness, { op: "begin", workId: "w3", item, scopeArtifact: "local://design.md" })).isError, true);
		assert.equal((await runTool(harness, { op: "run", workId: "w2", checkId: "unit" })).isError, undefined);
		await waitForCompletedStatus(harness, "w2");
		assert.equal((await runTool(harness, { op: "complete", workId: "w2" })).isError, undefined);
		const hook = harness.hooks.get("tool_call");
		if (!hook) throw new Error("Native completion hook is missing.");
		assert.equal(await hook({ toolName: "todo", input: { op: "done", task: item } }, harness.context), undefined);
		assert.equal((await runTool(harness, { op: "cancel", workId: "w2" })).isError, undefined);
		assert.equal(await hook({ toolName: "todo", input: { op: "rm", task: item } }, harness.context), undefined);
		const decision = await hook({ toolName: "todo", input: { op: "done", task: item } }, harness.context) as { block?: boolean } | undefined;
		assert.equal(decision?.block, true);
	} finally {
		await cleanupHarness(root, stateDirectory, harness);
		if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
		else process.env.XDG_STATE_HOME = previousStateHome;
	}
});

test("public certification and native completion reject a resource reset after successful runtime checks", async () => {
	const root = await createGitRepo();
	const stateDirectory = path.join(path.dirname(root), `verification-resource-${path.basename(root)}`);
	await mkdir(stateDirectory, { recursive: true });
	const generationFile = path.join(stateDirectory, "resource-generation");
	await writeFile(generationFile, "generation-one\n");
	await writeFile(path.join(root, ".omp", "verification.json"), JSON.stringify({
		version: 1, minimumProfile: "full", profiles: [{ id: "full", checks: ["unit"] }],
		checks: { unit: { argv: [process.execPath, "-e", "process.exit(0)"], kind: "runtime", preparations: [], resourceId: "app" } },
		classifications: [{ pattern: "README.md", kind: "source" }, { pattern: "src/**", kind: "source" }, { pattern: ".omp/**", kind: "configuration" }],
		pathRules: [], preparations: {},
		resources: { app: { argv: [process.execPath, "-e", "process.stdout.write(require('node:fs').readFileSync(process.argv[1]))", generationFile] } },
	}));
	const previousStateHome = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = stateDirectory;
	const harness = await extensionHarness(root, stateDirectory);
	try {
		agentSkills(harness.api);
		const item = "[w1] Verify final candidate";
		assert.equal((await runTool(harness, { op: "begin", workId: "w1", item, scopeArtifact: "local://design.md" })).isError, undefined);
		assert.equal((await runTool(harness, { op: "run", workId: "w1", checkId: "unit" })).isError, undefined);
		await waitForCompletedStatus(harness, "w1");
		assert.equal((await runTool(harness, { op: "complete", workId: "w1" })).isError, undefined);
		await writeFile(generationFile, "generation-two\n");
		assert.equal((await runTool(harness, { op: "complete", workId: "w1" })).isError, true);
		const hook = harness.hooks.get("tool_call");
		if (!hook) throw new Error("Native completion hook is missing.");
		for (const input of [{ op: "done", task: item }, { op: "done", phase: "Build" }, { op: "done" }]) {
			const decision = await hook({ toolName: "todo", input }, harness.context) as { block?: boolean } | undefined;
			assert.equal(decision?.block, true);
		}
	} finally {
		await cleanupHarness(root, stateDirectory, harness);
		if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
		else process.env.XDG_STATE_HOME = previousStateHome;
	}
});

test("public flow requires profile minima, changed-path checks and added checks before certification", async () => {
	const root = await createGitRepo();
	const stateDirectory = path.join(path.dirname(root), `verification-minima-${path.basename(root)}`);
	const check = { argv: [process.execPath, "-e", "process.exit(0)"], kind: "static", preparations: [] };
	await writeFile(path.join(root, ".omp", "verification.json"), JSON.stringify({
		version: 1, minimumProfile: "full",
		profiles: [{ id: "quick", checks: ["unit"] }, { id: "full", checks: ["unit", "profile"] }],
		checks: { unit: check, profile: check, path: check, extra: check },
		classifications: [{ pattern: "README.md", kind: "source" }, { pattern: "src/**", kind: "source" }, { pattern: ".omp/**", kind: "configuration" }],
		pathRules: [{ pattern: "src/**", checks: ["path"] }], preparations: {}, resources: {},
	}));
	await writeFile(path.join(root, "src", "main.ts"), "export const value = 2;\n");
	const previousStateHome = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = stateDirectory;
	const harness = await extensionHarness(root, stateDirectory);
	try {
		agentSkills(harness.api);
		const item = "[w1] Verify final candidate";
		assert.equal((await runTool(harness, { op: "begin", workId: "w1", item, scopeArtifact: "local://design.md", profile: "quick" })).isError, true);
		assert.equal((await runTool(harness, { op: "begin", workId: "w1", item, scopeArtifact: "local://design.md", additionalChecks: ["extra"] })).isError, undefined);
		for (const checkId of ["unit", "profile", "path", "extra"]) {
			assert.equal((await runTool(harness, { op: "complete", workId: "w1" })).isError, true);
			assert.equal((await runTool(harness, { op: "run", workId: "w1", checkId })).isError, undefined);
			await waitForCompletedStatus(harness, "w1", checkId);
		}
		assert.equal((await runTool(harness, { op: "complete", workId: "w1" })).isError, undefined);
	} finally {
		await cleanupHarness(root, stateDirectory, harness);
		if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
		else process.env.XDG_STATE_HOME = previousStateHome;
	}
});
