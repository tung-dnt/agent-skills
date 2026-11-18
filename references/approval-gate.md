# Approval Gate

The user approves scope and design decisions before downstream work begins. The main session owns the conversation and approval; a worker, native task status, todo checkbox, artifact fingerprint, or model-provided flag cannot approve anything.

## What the lead approves

| Where | What | How |
|---|---|---|
| `/story` | The plan's `repos:`, against the brief's invariants and boundaries; the dialog shows the plan's `## Summary` | The `lead` tool with `op: "approve"`: a dialog only the user can answer, recorded by the harness |
| Any write, commit, push or PR touching a path in `hard-gates.md` | That path, for the story | `mode: sync`: a harness dialog in the main session. `mode: async`, or after a worker is blocked: the gate is queued and the lead decides it through the `lead` tool with `op: "gate"` |
| `/ship` | Go or no-go | The ship decision |

There is no spec gate, design gate, or per-task design gate. The agent owns low-level design and records its choices in the decision log. After approval the lead is out of the loop: the agent replaces the plan's summary and tasks as the approach changes, without asking, and the plan file states the current plan only. A new repository in `repos:`, or the lead's edit to the brief's invariants or boundaries, needs the plan approved again.

## The plan approval

1. Ask every open question in one `ask` form before writing the plan (`/story`).
2. Write the plan file; keep `## Summary` to 15 lines.
3. Call the `lead` tool with `op: "approve"`. A dismissed dialog is not approval. Never pass an approval flag to a tool, and never treat a todo or task status as consent.
4. If the lead declines, revise and call it again. Nothing in a repository changes before approval; the harness blocks it.

## Checkpoints before a gate

There are no intermediate checkpoints. For an investigation, report the findings when they are complete. A subagent may investigate or draft, but only the main session calls the `lead` tool.

## Verification is separate

The public entry points are the native `verification` tool and `/verification` command; accepted operations are `begin`, `run`, `status`, `complete`, and `cancel`. They apply to execution/evidence records, not planning or task progress. `begin` requires user-facing policy/scope approval; `complete` validates and records evidence; cancellation is not a pass. Use the required `workId`, arguments, and slash flags in [Native Task Workflow](../docs/native-task-workflow.md). Do not invent unsupported options or claim unsupported host routes are protected.

Evidence gates may protect registered native todo completion, but ordinary unregistered progress/questions/investigations are not full-suite-gated. Native todo completion is not universal verification. Never describe unregistered work as hard-verified. A passing receipt must be fresh and match the approved scope, candidate, mandatory checks, and known resource generation; a task or subagent report is not itself a receipt. Runtime checks require a configured resource-provided reset/restart generation token queried before and after; missing, failed, malformed, or changed probes refuse evidence. PID/runId is not generation, and no host/provider fallback is used.

## Quality and integration

Workers run focused checks while iterating. The designated main integration owner runs required full checks and project-required runtime/browser checks at the stable boundary. A gate never waives the repository's quality criteria. Report exact commands and observed outcomes; do not infer proof from text, a commit, or task completion.

## Cancellation and state recovery

Cancellation remains possible and is not successful verification. Do not reset/remove native items or session state in a way that silently erases registered unfinished work. If manual edits or rewind make the current native state uncertain, read back the native todo view before a protected transition; do not reconstruct it from a project board or arbitrary assistant prose.