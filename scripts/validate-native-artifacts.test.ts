import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { validateNativeWorkflowDocument } from "./validate-native-artifacts.ts";

const workflowDocument = path.resolve(import.meta.dirname, "../docs/native-task-workflow.md");

const contract = {
  progressOwner: "native todo",
  workerExecution: "native task",
  approval: "user-facing",
  artifactHandoff: "static artifact paths",
  artifacts: [
    { kind: "approved-scope", path: "artifacts/scope.md", mutability: "static" },
    { kind: "design", path: "artifacts/design.md", mutability: "static" },
    { kind: "task-brief", path: "artifacts/task.md", mutability: "static" },
  ],
  verification: {
    arguments: ["workId", "item", "scopeArtifact", "profile", "additionalChecks", "checkId"],
    scopeArtifactPaths: {
      accepted: ["repository-relative", "owner-session local://<relative-name>"],
      localRequiresPersistentOwnerSession: true,
      customLocalRootsSupported: false,
      fallbackSupported: false,
    },
    requiredInputs: {
      begin: ["workId", "item", "scopeArtifact"],
      run: ["workId", "checkId"],
      status: ["workId"],
      complete: ["workId"],
      cancel: ["workId"],
    },
    slashCommand: "/verification",
    requiredSlashFlags: {
      begin: ["--work-id", "--item", "--scope-artifact"],
      run: ["--work-id", "--check-id"],
      status: ["--work-id"],
      complete: ["--work-id"],
      cancel: ["--work-id"],
    },
    optionalSlashFlags: {
      begin: ["--profile", "--add-check"],
    },
    runtimeGeneration: {
      resourceIdRequired: true,
      resourcePolicyShape: {
        map: "resources",
        probeFields: ["argv", "timeoutSeconds"],
        argvType: "string[]",
        timeoutSecondsOptional: true,
        runtimeCheckRequiresResourceId: true,
      },
      probeOutputs: ["before", "after", "completion"],
      outputMustBe: "bounded non-empty",
      generationToken: "resource-provided reset/restart generation token",
      comparison: "identical SHA-256 hashes",
      receiptStores: "hash only",
      pidOrRunIdIsGeneration: false,
      genericHostFallbackSupported: false,
    },
    operations: ["begin", "run", "status", "complete", "cancel"],
    completionRecordsEvidence: true,
    nativeTaskCompletionIsTestEvidence: false,
    unregisteredWorkHardVerified: false,
  },
};

function asDocumentation(value: unknown): string {
  return `# Fixture\n\n\`\`\`native-workflow-contract\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
}

test("validates the canonical native/static workflow example in documentation", () => {
  const markdown = fs.readFileSync(workflowDocument, "utf8");
  assert.deepEqual(validateNativeWorkflowDocument(markdown), []);
});

test("requires native todo progress and native task execution without extra state fields", () => {
  const invalid = structuredClone(contract);
  invalid.progressOwner = "project board";
  Object.assign(invalid, { taskStatusStore: "docs/tasks.json" });

  const issues = validateNativeWorkflowDocument(asDocumentation(invalid));
  assert.ok(issues.includes('progressOwner must be "native todo"'));
  assert.ok(issues.includes("contract contains fields outside the documented static-artifact contract"));
});

test("requires all handoff artifacts to remain static and repository-relative", () => {
  const invalid = structuredClone(contract);
  invalid.artifacts[0].path = "C:\\outside\\scope.md";
  invalid.artifacts[1].mutability = "mutable";
  invalid.artifacts[2].path = "../outside/task.md";
  const issues = validateNativeWorkflowDocument(asDocumentation(invalid));
  assert.ok(issues.includes("artifacts[0].path must be a non-empty relative artifact path without traversal"));
  assert.ok(issues.includes('artifacts[1].mutability must be "static"'));
  assert.ok(issues.includes("artifacts[2].path must be a non-empty relative artifact path without traversal"));
});

test("requires user approval and the exact evidence-only verification operations", () => {
  const invalid = structuredClone(contract);
  invalid.approval = "model-flag";
  invalid.verification.operations = ["begin", "run", "status", "complete"];
  invalid.verification.nativeTaskCompletionIsTestEvidence = true;
  invalid.verification.unregisteredWorkHardVerified = true;
  invalid.verification.requiredInputs.begin = ["item", "scopeArtifact"];
  invalid.verification.requiredSlashFlags.complete = ["--work-id", "--approved"];
  invalid.verification.arguments.push("reason");

  const issues = validateNativeWorkflowDocument(asDocumentation(invalid));
  assert.ok(issues.includes('approval must be "user-facing"'));
  assert.ok(issues.includes("verification.arguments must be exactly workId, item, scopeArtifact, profile, additionalChecks, checkId"));
  assert.ok(issues.includes("verification.requiredInputs.begin must be exactly workId, item, scopeArtifact"));
  assert.ok(issues.includes("verification.requiredSlashFlags.complete must be exactly --work-id"));
  assert.ok(issues.includes("verification.operations must be exactly begin, run, status, complete, cancel"));
  assert.ok(issues.includes("native task completion must not count as test evidence"));
  assert.ok(issues.includes("unregistered work must not be described as hard-verified"));
});

test("rejects unsupported artifact and runtime-generation fallbacks", () => {
  const invalid = structuredClone(contract);
  invalid.verification.scopeArtifactPaths.customLocalRootsSupported = true;
  invalid.verification.scopeArtifactPaths.fallbackSupported = true;
  invalid.verification.runtimeGeneration.resourceIdRequired = false;
  invalid.verification.runtimeGeneration.genericHostFallbackSupported = true;
  invalid.verification.runtimeGeneration.resourcePolicyShape.runtimeCheckRequiresResourceId = false;

  const issues = validateNativeWorkflowDocument(asDocumentation(invalid));
  assert.ok(issues.includes("custom local artifact roots must not be supported"));
  assert.ok(issues.includes("artifact path fallback must not be supported"));
  assert.ok(issues.includes("runtime checks must require a configured resourceId"));
  assert.ok(issues.includes("runtime generation must not use a generic host/provider fallback"));
  assert.ok(issues.includes("each runtime check must declare its configured resourceId"));
});

test("rejects a runtime example that omits the completion freshness probe", () => {
  const invalid = structuredClone(contract);
  invalid.verification.runtimeGeneration.probeOutputs = ["before", "after"];
  const issues = validateNativeWorkflowDocument(asDocumentation(invalid));
  assert.ok(issues.includes("runtime generation must be probed before and after the check and at completion"));
});

test("rejects missing, duplicate, and malformed documentation contract blocks", () => {
  assert.deepEqual(validateNativeWorkflowDocument("no contract"), ["expected exactly one native-workflow-contract block, found 0"]);
  assert.deepEqual(
    validateNativeWorkflowDocument(`${asDocumentation(contract)}\n${asDocumentation(contract)}`),
    ["expected exactly one native-workflow-contract block, found 2"],
  );
  assert.match(
    validateNativeWorkflowDocument("```native-workflow-contract\n{\n```")[0],
    /native-workflow-contract is not valid JSON:/,
  );
});
