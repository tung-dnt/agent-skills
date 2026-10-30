# Approval Gate

The user approves scope and design decisions before downstream work begins. The main session owns the conversation and approval; a worker, native task status, todo checkbox, artifact fingerprint, or model-provided flag cannot approve anything.

## When a gate runs

| Workflow | Gate after | Blocks |
|---|---|---|
| `/epic` | Requirements, architecture, and story map | The next planning phase or story |
| `/story` and `spec-driven-development` | Requirements, design, and plan | The next phase or implementation |
| `high-level-design` | Shared system shape and contracts | Task planning |
| `planning-and-task-breakdown` | Ordered task briefs and file ownership | Worker execution |
| `/task` | Task scope/design before code; every task from a written plan requires an LLD gate, including mechanical tasks. Ad-hoc mechanical work with no design decision may omit LLD. | That task's implementation |
| `/build` (written plan) | Each task's LLD, or one explicitly user-approved repo-sized slice showing every included design | Only task(s) named in that approval |
Approval of a written plan approves the plan only; it does not approve any task-level design. Every planned task, including mechanical tasks, needs its own approved LLD before code. A repo-sized slice gate is valid only when the user explicitly approves the named slice after every included design is shown. Only genuinely ad-hoc mechanical work with no design decisions may omit LLD.

## The gate

1. **Catch up.** Show a concise summary: business context, proposed-fit, root cause for bugs, recommendation, trade-offs, and open decisions. Omit inapplicable headings. Give the user the absolute path to the static artifact and show the relevant artifact content, including the task design itself.
2. **Grill decisions.** Invoke `grill-me` for unresolved nontrivial choices. Present real alternatives, evidence, what the choice hinges on, a recommendation, and the condition that would change it. Do not re-ask settled checkpoint decisions.
3. **Ask.** In omp use the available user-facing ask/approval interaction; on other hosts use their actual question mechanism. Ask the user to proceed or revise. A dismissed/hedged response is not approval. Never ask the model to supply an approval boolean, invoke an `approved=true` argument, or treat a todo/task status as consent. A slice gate must show every included LLD and name exactly which tasks the user's approval covers.
4. **Wait.** If the user asks for revisions, change the artifact and summary, show the revised result, and ask again. Nothing downstream starts before an explicit go-ahead.
5. **Record only through supported evidence binding.** For work registered with verification, use the supported user-facing approval callback to bind the exact owner/session, repository, approved scope/design, and policy/profile. This is minimal evidence/binding metadata, not a second progress list. Never recreate approvals in mutable Markdown or infer a new approval from historical fingerprints. If no supported UI path exists, do not claim a protected binding was approved.

## Checkpoints before a gate

For an investigation or staged design, show the facts and decisions produced at each required checkpoint and wait before continuing. Keep the user involved in the process, not just the final summary. A one-pass request may skip intermediate checkpoints only where the relevant skill permits; it never skips the final explicit user gate or changes design-quality criteria.

A subagent may investigate or draft static content, but only the main session may present the gate and receive the user's answer. A worker's own task completion cannot satisfy an approval gate.

## Verification is separate

The public entry points are the native `verification` tool and `/verification` command; accepted operations are `begin`, `run`, `status`, `complete`, and `cancel`. They apply to execution/evidence records, not planning or task progress. `begin` requires user-facing policy/scope approval; `complete` validates and records evidence; cancellation is not a pass. Use the required `workId`, arguments, and slash flags in [Native Task Workflow](../docs/native-task-workflow.md). Do not invent unsupported options or claim unsupported host routes are protected.

Evidence gates may protect registered native todo completion, but ordinary unregistered progress/questions/investigations are not full-suite-gated. Native todo completion is not universal verification. Never describe unregistered work as hard-verified. A passing receipt must be fresh and match the approved scope, candidate, mandatory checks, and known resource generation; a task or subagent report is not itself a receipt. Runtime checks require a configured resource-provided reset/restart generation token queried before and after; missing, failed, malformed, or changed probes refuse evidence. PID/runId is not generation, and no host/provider fallback is used.

## Quality and integration

Workers run focused checks while iterating. The designated main integration owner runs required full checks and project-required runtime/browser checks at the stable boundary. A gate never waives the repository's quality criteria. Report exact commands and observed outcomes; do not infer proof from text, a commit, or task completion.

## Cancellation and state recovery

Cancellation remains possible and is not successful verification. Do not reset/remove native items or session state in a way that silently erases registered unfinished work. If manual edits or rewind make the current native state uncertain, read back the native todo view before a protected transition; do not reconstruct it from a project board or arbitrary assistant prose.