# Native Task Workflow

This repository's omp workflow uses native todo for the current main session's progress and native task for worker execution, output, cancellation, and revival. One main session owns ordering, task selection, user approval, and explicit file ownership. Static requirements, designs, plans, decisions, and worker briefs are handed to workers by absolute path; they do not mirror mutable status.

## Do / Don't

| Do | Don't |
|---|---|
| Use native todo as the one mutable progress list for the active main session. | Create an `_tasks` status board, task-state JSON store, Obsidian task store, or second progress checklist. |
| Write a static spec/design/plan/worker brief at a user-approved path. | Store `todo`/`done`, active status, or worker logs in static artifacts. |
| Have the main session choose task order and one owner per shared file. | Claim global DAG readiness, automatic path-conflict detection, or cross-session locks. |
| Delegate one bounded task through the native task mechanism with a brief path, acceptance criteria, and allowed files. | Treat task completion or a worker report as proof that tests passed or code was reviewed. |
| Require an approved low-level design for every task from a written plan, including mechanical tasks; use a concise note or explicit user-approved slice gate. | Skip the LLD gate because the planned task “looks trivial.” |
| Keep approvals in the user-facing gate; keep registered evidence in the supported verification binding/receipt metadata. | Pass a model approval flag or infer approval from a native todo item, worker status, or imported note. |
| Run focused checks while implementing; let one integration owner run required full checks at a stable boundary. | Run duplicate full suites in every worker or lower the repository quality bar. |
| Read back native todo after manual edits/rewind when a protected transition is uncertain. | Reconstruct unavailable state from unrelated Markdown, branches, or another session's claims. |

## Planning and handoff

Use `/epic` for a product/capability map, `/story` for one feature's requirements/design/plan, `/plan` for a task breakdown, `/task` for one focused change, and `/build` for approved implementation. See [Work Artifacts and Native Progress](../references/work-artifacts.md) for the shared contract and [Approval Gate](../references/approval-gate.md) for user-only approval rules.

The plan is a static index. Each worker brief names:

- stable work ID and approved scope/design references;
- concrete acceptance criteria and non-goals;
- explicit prerequisite/order information;
- exact allowed file paths and the main-assigned owner for shared paths;
- focused checks and any required integration/runtime checks.

The main session copies the agreed phase/task outline into the current native todo and assigns workers. Native todo/task state is session-scoped; it is not a repository-wide backlog or a distributed ownership mechanism. If another session is working on the same project, coordinate with its owner directly before overlapping edits.

Before a native task worker starts a task from a written breakdown, the main session ensures its static brief contains an approved low-level design. This applies to every planned task, including mechanical work; keep the note concise when appropriate. Obtain approval per task or by an explicitly approved repo-sized slice showing every included design. Only a genuinely ad-hoc mechanical change with no design decisions may omit LLD.

## Viewing a task's requirements

Keep a stable task ID mapped to its brief path in the static plan. The brief contains the task's objective, scope, acceptance criteria, requirement/contract references, approved LLD, and verification criteria. Native todo keeps only the current progress; it is not a rich task-details viewer.

- To inspect a task, ask for its ID, such as “show requirements for T02.” Read its brief and the cited spec sections rather than searching the whole transcript.
- Show the brief's absolute path in chat and the worker handoff so the user can open the file directly. Do not assume a native todo client renders a clickable attachment.
- Owner-session `local://` artifacts can be used during that session and its resume. Context that must remain discoverable across sessions or machines belongs at a user-approved durable location, commonly Git-tracked repository documents.
- “Static” means the artifact does not mirror progress. Requirements/design may be revised through the user gate; changed approved scope invalidates old verification evidence and must be rebound before completion.

## Approval and verification

Before implementation, the main session shows the design/plan, asks about open decisions, and waits for explicit user approval. The gate is a user-facing interaction. Never use a model-supplied `approved` flag or treat task completion as consent.

The extension exposes the public `verification` tool and `/verification` command with `op` values `begin`, `run`, `status`, `complete`, and `cancel`. Tool arguments are one-level (`verification({op, workId, item?, scopeArtifact?, profile?, additionalChecks?, checkId?})`); `workId` is required for every operation. Do not pass arbitrary commands, receipts, nested argument objects, or model approval flags.

| Operation | Required slash form | Behavior |
|---|---|---|
| `begin` | `/verification begin --work-id ID --item "EXACT NATIVE TODO CONTENT" --scope-artifact PATH` | Requires a scope/design artifact using an accepted path form and the user-facing approval callback. Optional `--profile ID` cannot weaken repo minimum; `--add-check ID` only adds known checks. |
| `run` | `/verification run --work-id ID --check-id ID` | Executes an approved named check and captures its observed result. |
| `status` | `/verification status --work-id ID` | Reports observed run state. |
| `complete` | `/verification complete --work-id ID` | Validates and records applicable evidence; does not update native todo. |
| `cancel` | `/verification cancel --work-id ID` | Cancels through user-facing confirmation without a passing receipt; accepts no free-text reason. |

A worker's completion/result is not a receipt. Unregistered work stays outside the hard evidence gate and must not be described as hard-verified.

`scopeArtifact` accepts only a repository-relative path (resolved under the repository root) or an owner-session `local://<relative-name>` artifact path. The local form requires a persistent owner session; custom local roots and fallback resolution are not supported.

Evidence is candidate-specific and freshness matters. Each runtime check declares a configured `resourceId` in `.omp/verification.json`; its named probe must read a real resource-provided reset/restart generation token. Probe before and after the check, then re-probe at `complete` and protected native completion; all generation hashes must match within the same completion attempt. Bound and validate non-empty output, storing only SHA-256 in receipts. Missing, failed, malformed, or changed probes refuse evidence. PID/runId, constant tokens, and generic host fallbacks are not generation authority. Probe-only freshness checks do not rerun the full suite. Without a real resource token, runtime evidence is unavailable.

### Repository policy

Opt in with a user-reviewed `.omp/verification.json`; the extension does not create one automatically. This dependency-free example assumes the repository's actual full gate is `node --test tests/feature.test.ts`; replace it with the real mandatory gates, not an easier subset:

```json
{
  "version": 1,
  "minimumProfile": "full",
  "profiles": [{ "id": "full", "checks": ["suite"] }],
  "checks": {
    "suite": {
      "argv": ["node", "--test", "tests/feature.test.ts"],
      "kind": "static",
      "preparations": []
    }
  },
  "classifications": [
    { "pattern": ".omp/verification.json", "kind": "configuration" },
    { "pattern": "package.json", "kind": "configuration" },
    { "pattern": "src/**", "kind": "source" },
    { "pattern": "tests/**", "kind": "test" }
  ],
  "pathRules": [],
  "preparations": {},
  "resources": {}
}
```

Classify the real repository inputs explicitly; unknown or ambiguous inputs refuse capture. Ordered profiles must only add checks, and `pathRules` adds checks for changed paths. Required dependencies are installed by named, approved preparations in the private execution checkout, never by linking a worker's mutable dependencies.

Preparation output exemptions support exact literal paths and literal directory `/**` patterns only. The whole exemption must be exclusively classified `excluded`, without overlapping source/test/configuration/generated classifications. Declaring an output does not authorize generating new inputs outside the approved candidate. Unsupported/ambiguous globs, unknown inputs, and uncertain directory events refuse proof conservatively.

Continuous input observation requires a working filesystem watcher. Startup errors, exhausted inotify capacity, or observer errors cannot produce a passing receipt; restore the environment capacity instead of disabling the guard. POSIX cancellation escalates across the owned process group; Windows direct-child termination does not promise the same descendant guarantee.

To add runtime checks, declare `resources: { "<id>": { "argv": ["<real-probe>", "<args>"], "timeoutSeconds": 10 } }` and reference that ID from the runtime check's `resourceId`. The optional timeout bounds the probe. The probe must read the resource's actual generation, not echo a configured constant; code and policy changes invalidate old approval/evidence. At stable boundaries the integration owner still runs every required full, integration, and runtime/browser gate.

Probe output must be bounded valid UTF-8 containing one non-empty generation line; overflow, malformed output, and stderr refuse evidence rather than truncating into a token. Completion uses a fresh isolated checkout and reruns any approved probe prerequisites, but not the check/full-suite argv. Prefer a self-contained read-only probe when dependency preparation would be expensive.

## Resume honestly

Start with the current native todo view and supplied static artifact paths. A read-only investigator compares what is accessible with actual repository changes and reports exact checks/results. It can resume only from current native session state, accessible worker output, user-approved artifacts, and repository state. It cannot recover another session's native todo, project-wide task claims, or a shared dependency queue. If state is missing, say so; if manual edits or rewind make a protected transition ambiguous, take a fresh native todo readback rather than guessing.

## Documentation contract example

This labeled JSON block is the structured example checked by `scripts/validate-native-artifacts.ts`. It validates this public documentation contract only; it does not inspect runtime source or incidental prose.

```native-workflow-contract
{
  "progressOwner": "native todo",
  "workerExecution": "native task",
  "approval": "user-facing",
  "artifactHandoff": "static artifact paths",
  "artifacts": [
    { "kind": "approved-scope", "path": "artifacts/approved-scope.md", "mutability": "static" },
    { "kind": "design", "path": "artifacts/design.md", "mutability": "static" },
    { "kind": "task-brief", "path": "artifacts/task-brief.md", "mutability": "static" }
  ],
  "verification": {
    "arguments": ["workId", "item", "scopeArtifact", "profile", "additionalChecks", "checkId"],
    "scopeArtifactPaths": {
      "accepted": ["repository-relative", "owner-session local://<relative-name>"],
      "localRequiresPersistentOwnerSession": true,
      "customLocalRootsSupported": false,
      "fallbackSupported": false
    },
    "requiredInputs": {
      "begin": ["workId", "item", "scopeArtifact"],
      "run": ["workId", "checkId"],
      "status": ["workId"],
      "complete": ["workId"],
      "cancel": ["workId"]
    },
    "slashCommand": "/verification",
    "requiredSlashFlags": {
      "begin": ["--work-id", "--item", "--scope-artifact"],
      "run": ["--work-id", "--check-id"],
      "status": ["--work-id"],
      "complete": ["--work-id"],
      "cancel": ["--work-id"]
    },
    "optionalSlashFlags": {
      "begin": ["--profile", "--add-check"]
    },
    "runtimeGeneration": {
      "resourceIdRequired": true,
      "resourcePolicyShape": {
        "map": "resources",
        "probeFields": ["argv", "timeoutSeconds"],
        "argvType": "string[]",
        "timeoutSecondsOptional": true,
        "runtimeCheckRequiresResourceId": true
      },
      "probeOutputs": ["before", "after", "completion"],
      "outputMustBe": "bounded non-empty",
      "generationToken": "resource-provided reset/restart generation token",
      "comparison": "identical SHA-256 hashes",
      "receiptStores": "hash only",
      "pidOrRunIdIsGeneration": false,
      "genericHostFallbackSupported": false
    },
    "operations": ["begin", "run", "status", "complete", "cancel"],
    "completionRecordsEvidence": true,
    "nativeTaskCompletionIsTestEvidence": false,
    "unregisteredWorkHardVerified": false
  }
}
```

This block is a documentation contract, not a required project task layout, policy instance, or persisted task record. The verification interface/evidence fields are public contract; check, profile, and resource IDs and actual argv are configured per repository.