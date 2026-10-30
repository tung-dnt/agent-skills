#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const WORKFLOW_DOCUMENT = path.resolve(import.meta.dirname, "../docs/native-task-workflow.md");
const EXPECTED_OPERATIONS = ["begin", "run", "status", "complete", "cancel"] as const;
const EXPECTED_ARTIFACT_KINDS = ["approved-scope", "design", "task-brief"] as const;
const EXPECTED_ARGUMENTS = ["workId", "item", "scopeArtifact", "profile", "additionalChecks", "checkId"] as const;
const EXPECTED_SCOPE_ARTIFACT_PATHS = ["repository-relative", "owner-session local://<relative-name>"] as const;
const REQUIRED_INPUTS: Record<(typeof EXPECTED_OPERATIONS)[number], readonly string[]> = {
  begin: ["workId", "item", "scopeArtifact"],
  run: ["workId", "checkId"],
  status: ["workId"],
  complete: ["workId"],
  cancel: ["workId"],
};
const EXPECTED_SLASH_COMMAND = "/verification";
const REQUIRED_SLASH_FLAGS: Record<(typeof EXPECTED_OPERATIONS)[number], readonly string[]> = {
  begin: ["--work-id", "--item", "--scope-artifact"],
  run: ["--work-id", "--check-id"],
  status: ["--work-id"],
  complete: ["--work-id"],
  cancel: ["--work-id"],
};
const OPTIONAL_SLASH_FLAGS: Partial<Record<(typeof EXPECTED_OPERATIONS)[number], readonly string[]>> = {
  begin: ["--profile", "--add-check"],
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: JsonObject, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function matchesExactList(value: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(value) || value.length !== expected.length) return false;
  const values: unknown[] = value;
  return expected.every((entry, index) => values[index] === entry);
}

function validateContract(value: unknown): string[] {
  const issues: string[] = [];
  if (!isObject(value)) return ["contract must be a JSON object"];

  const contractKeys = ["progressOwner", "workerExecution", "approval", "artifactHandoff", "artifacts", "verification"];
  if (!hasOnlyKeys(value, contractKeys)) issues.push("contract contains fields outside the documented static-artifact contract");
  if (value.progressOwner !== "native todo") issues.push('progressOwner must be "native todo"');
  if (value.workerExecution !== "native task") issues.push('workerExecution must be "native task"');
  if (value.approval !== "user-facing") issues.push('approval must be "user-facing"');
  if (value.artifactHandoff !== "static artifact paths") issues.push('artifactHandoff must be "static artifact paths"');

  if (!Array.isArray(value.artifacts)) {
    issues.push("artifacts must be an array of static artifact examples");
  } else {
    const kinds = new Set<string>();
    for (const [index, artifact] of value.artifacts.entries()) {
      const prefix = `artifacts[${index}]`;
      if (!isObject(artifact)) {
        issues.push(`${prefix} must be an object`);
        continue;
      }
      if (!hasOnlyKeys(artifact, ["kind", "path", "mutability"])) issues.push(`${prefix} contains unsupported fields`);
      if (typeof artifact.kind !== "string" || !EXPECTED_ARTIFACT_KINDS.includes(artifact.kind as (typeof EXPECTED_ARTIFACT_KINDS)[number])) {
        issues.push(`${prefix}.kind must be approved-scope, design, or task-brief`);
      } else if (kinds.has(artifact.kind)) {
        issues.push(`${prefix}.kind duplicates ${artifact.kind}`);
      } else {
        kinds.add(artifact.kind);
      }
      if (typeof artifact.path !== "string" || artifact.path.length === 0 || path.isAbsolute(artifact.path) || path.win32.isAbsolute(artifact.path) || artifact.path.split(/[\\/]/).includes("..")) {
        issues.push(`${prefix}.path must be a non-empty relative artifact path without traversal`);
      }
      if (artifact.mutability !== "static") issues.push(`${prefix}.mutability must be "static"`);
    }
    for (const kind of EXPECTED_ARTIFACT_KINDS) {
      if (!kinds.has(kind)) issues.push(`artifacts must include one ${kind} example`);
    }
  }

  if (!isObject(value.verification)) {
    issues.push("verification must describe the public verification boundary");
  } else {
    const verification = value.verification;
    if (!hasOnlyKeys(verification, [
      "arguments",
      "scopeArtifactPaths",
      "requiredInputs",
      "slashCommand",
      "requiredSlashFlags",
      "optionalSlashFlags",
      "runtimeGeneration",
      "operations",
      "completionRecordsEvidence",
      "nativeTaskCompletionIsTestEvidence",
      "unregisteredWorkHardVerified",
    ])) issues.push("verification contains unsupported fields");
    if (!matchesExactList(verification.arguments, EXPECTED_ARGUMENTS)) {
      issues.push(`verification.arguments must be exactly ${EXPECTED_ARGUMENTS.join(", ")}`);
    }
    if (verification.slashCommand !== EXPECTED_SLASH_COMMAND) issues.push(`verification.slashCommand must be ${EXPECTED_SLASH_COMMAND}`);
    if (!isObject(verification.scopeArtifactPaths)) {
      issues.push("verification.scopeArtifactPaths must describe supported artifact path forms");
    } else {
      const scopeArtifactPaths = verification.scopeArtifactPaths;
      if (!hasOnlyKeys(scopeArtifactPaths, ["accepted", "localRequiresPersistentOwnerSession", "customLocalRootsSupported", "fallbackSupported"])) {
        issues.push("verification.scopeArtifactPaths contains unsupported fields");
      }
      if (!matchesExactList(scopeArtifactPaths.accepted, EXPECTED_SCOPE_ARTIFACT_PATHS)) {
        issues.push(`verification.scopeArtifactPaths.accepted must be exactly ${EXPECTED_SCOPE_ARTIFACT_PATHS.join(", ")}`);
      }
      if (scopeArtifactPaths.localRequiresPersistentOwnerSession !== true) {
        issues.push("local artifact paths require a persistent owner session");
      }
      if (scopeArtifactPaths.customLocalRootsSupported !== false) {
        issues.push("custom local artifact roots must not be supported");
      }
      if (scopeArtifactPaths.fallbackSupported !== false) {
        issues.push("artifact path fallback must not be supported");
      }
    }

    if (!isObject(verification.requiredInputs)) {
      issues.push("verification.requiredInputs must map each operation to required tool inputs");
    } else {
      const requiredInputs = verification.requiredInputs;
      if (!hasOnlyKeys(requiredInputs, EXPECTED_OPERATIONS)) issues.push("verification.requiredInputs contains an unknown operation");
      for (const operation of EXPECTED_OPERATIONS) {
        const expected = REQUIRED_INPUTS[operation];
        if (!matchesExactList(requiredInputs[operation], expected)) {
          issues.push(`verification.requiredInputs.${operation} must be exactly ${expected.join(", ")}`);
        }
      }
    }

    if (!isObject(verification.requiredSlashFlags)) {
      issues.push("verification.requiredSlashFlags must map each operation to required flags");
    } else {
      const requiredSlashFlags = verification.requiredSlashFlags;
      if (!hasOnlyKeys(requiredSlashFlags, EXPECTED_OPERATIONS)) issues.push("verification.requiredSlashFlags contains an unknown operation");
      for (const operation of EXPECTED_OPERATIONS) {
        const expected = REQUIRED_SLASH_FLAGS[operation];
        if (!matchesExactList(requiredSlashFlags[operation], expected)) {
          issues.push(`verification.requiredSlashFlags.${operation} must be exactly ${expected.join(", ")}`);
        }
      }
    }

    if (!isObject(verification.optionalSlashFlags)) {
      issues.push("verification.optionalSlashFlags must map optional operation flags");
    } else {
      const optionalSlashFlags = verification.optionalSlashFlags;
      if (!hasOnlyKeys(optionalSlashFlags, Object.keys(OPTIONAL_SLASH_FLAGS))) issues.push("verification.optionalSlashFlags contains an unknown operation");
      for (const operation of EXPECTED_OPERATIONS) {
        const expected = OPTIONAL_SLASH_FLAGS[operation];
        if (expected === undefined) {
          if (operation in optionalSlashFlags) issues.push(`verification.optionalSlashFlags.${operation} must be omitted`);
        } else if (!matchesExactList(optionalSlashFlags[operation], expected)) {
          issues.push(`verification.optionalSlashFlags.${operation} must be exactly ${expected.join(", ")}`);
        }
      }
    }
    if (!isObject(verification.runtimeGeneration)) {
      issues.push("verification.runtimeGeneration must describe the resource-generation evidence contract");
    } else {
      const runtimeGeneration = verification.runtimeGeneration;
      if (!hasOnlyKeys(runtimeGeneration, [
        "resourceIdRequired",
        "resourcePolicyShape",
        "probeOutputs",
        "outputMustBe",
        "generationToken",
        "comparison",
        "receiptStores",
        "pidOrRunIdIsGeneration",
        "genericHostFallbackSupported",
      ])) issues.push("verification.runtimeGeneration contains unsupported fields");
      if (runtimeGeneration.resourceIdRequired !== true) issues.push("runtime checks must require a configured resourceId");
      if (!isObject(runtimeGeneration.resourcePolicyShape)) {
        issues.push("runtime generation must define the policy resource probe shape");
      } else {
        const resourcePolicyShape = runtimeGeneration.resourcePolicyShape;
        if (!hasOnlyKeys(resourcePolicyShape, ["map", "probeFields", "argvType", "timeoutSecondsOptional", "runtimeCheckRequiresResourceId"])) {
          issues.push("runtime resource policy shape contains unsupported fields");
        }
        if (resourcePolicyShape.map !== "resources") issues.push('runtime resources must be configured in the policy "resources" map');
        if (!matchesExactList(resourcePolicyShape.probeFields, ["argv", "timeoutSeconds"])) {
          issues.push("runtime resource probes must use argv and optional timeoutSeconds");
        }
        if (resourcePolicyShape.argvType !== "string[]") issues.push("runtime resource probe argv must be string[]");
        if (resourcePolicyShape.timeoutSecondsOptional !== true) issues.push("runtime probe timeoutSeconds must be optional");
        if (resourcePolicyShape.runtimeCheckRequiresResourceId !== true) issues.push("each runtime check must declare its configured resourceId");
      }
      if (!matchesExactList(runtimeGeneration.probeOutputs, ["before", "after", "completion"])) {
        issues.push("runtime generation must be probed before and after the check and at completion");
      }
      if (runtimeGeneration.outputMustBe !== "bounded non-empty") issues.push("resource probe output must be bounded and non-empty");
      if (runtimeGeneration.generationToken !== "resource-provided reset/restart generation token") {
        issues.push("runtime generation must come from a real resource-provided reset/restart token");
      }
      if (runtimeGeneration.comparison !== "identical SHA-256 hashes") issues.push("runtime generation probes must have identical SHA-256 hashes");
      if (runtimeGeneration.receiptStores !== "hash only") issues.push("runtime receipts must store only the generation hash");
      if (runtimeGeneration.pidOrRunIdIsGeneration !== false) issues.push("PID and runId must not count as resource generation");
      if (runtimeGeneration.genericHostFallbackSupported !== false) issues.push("runtime generation must not use a generic host/provider fallback");
    }

    if (!matchesExactList(verification.operations, EXPECTED_OPERATIONS)) {
      issues.push(`verification.operations must be exactly ${EXPECTED_OPERATIONS.join(", ")}`);
    }
    if (verification.completionRecordsEvidence !== true) issues.push("verification.complete must record evidence");
    if (verification.nativeTaskCompletionIsTestEvidence !== false) issues.push("native task completion must not count as test evidence");
    if (verification.unregisteredWorkHardVerified !== false) issues.push("unregistered work must not be described as hard-verified");
  }

  return issues;
}

/** Validates only the explicitly labeled native workflow documentation example. */
export function validateNativeWorkflowDocument(markdown: string): string[] {
  const blocks = [...markdown.matchAll(/```native-workflow-contract\s*\n([\s\S]*?)\n```/g)];
  if (blocks.length !== 1) return [`expected exactly one native-workflow-contract block, found ${blocks.length}`];

  let contract: unknown;
  try {
    contract = JSON.parse(blocks[0][1]);
  } catch (error) {
    return [`native-workflow-contract is not valid JSON: ${error instanceof Error ? error.message : String(error)}`];
  }
  return validateContract(contract);
}

function main(): void {
  let markdown: string;
  try {
    markdown = fs.readFileSync(WORKFLOW_DOCUMENT, "utf8");
  } catch (error) {
    console.error(`Cannot read ${path.relative(process.cwd(), WORKFLOW_DOCUMENT)}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  const issues = validateNativeWorkflowDocument(markdown);
  if (issues.length > 0) {
    console.error("Native workflow documentation contract failed:");
    for (const issue of issues) console.error(`- ${issue}`);
    process.exitCode = 1;
    return;
  }

  console.log("Native workflow documentation contract passed.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main();
