---
description: Design and build one focused task with an explicit user gate, a static brief, test-first implementation, and review
---

Work at **task scope**: one focused change that does not alter a shared contract. The main session owns selection, ordering, and file ownership. A task's scope, acceptance criteria, design, and decisions live in a static artifact at the path supplied to any worker; progress lives only in the current session's native todo and task execution state.

## Before building

1. Read the request, repository instructions, source, and any existing approved design/brief. Use a tracker only as input, never as the authority for code approval.
2. Confirm task scope with `references/work-artifacts.md`. If work needs a shared contract or several independent slices, recommend `/story` or `/plan` and wait for confirmation before changing scope.
3. Read the native todo view and preserve registered items. Do not claim or pick a task via a project board, Git ref, status note, or implicit global readiness. The main session chooses the task and names exact allowed paths.
4. **Write an LLD for every planned task.** Invoke `agent-skills:low-level-design` for any task selected from a written breakdown, even when it appears mechanical; a concise note is fine. Only a genuinely ad-hoc mechanical change with no design decision may omit it. Use the approved brief and contracts, write the note to the static artifact, and retain its test list.

## User gate and execution

Before code, show the catch-up summary and the static brief path; for any planned task, show its LLD artifact path and content, grill open decisions, and wait for explicit user approval through `references/approval-gate.md`. This applies to every task from a written plan, however small or mechanical; the note may be concise. An explicitly user-approved repo-sized slice gate may cover several tasks only when every included LLD is shown and named. A plan gate, native task completion, a preexisting note, or a checked todo item does not approve task design. A genuinely ad-hoc mechanical change with no design decisions may omit LLD, but it still follows the applicable user gate. Do not pass an approval boolean/flag to a model-facing tool; policy/scope approval uses the user-facing interaction.

For registered verification work, use the public verification operations `begin`, `run`, `status`, `complete`, and `cancel` only through their documented interface. Begin only after user approval. `complete` records evidence but does not set native todo progress; cancellation and failure never produce passing receipts. If work is unregistered, do not describe it as hard-verified.

When a worker is useful, delegate exactly one task through the host's native task mechanism. Give it the repository root, absolute static brief/design paths, allowed files, acceptance criteria, and focused checks. The worker must:
- follow the approved design and `test-driven-development` for behavior changes;
- run focused checks needed for its acceptance criteria, and report exact commands/results and changed paths;
- stop and report a blocker rather than changing scope, shared contracts, or unsupported host behavior;
- never call `work_state`, write status into a separate task board, or infer completion from its own native task status.

The main session reviews the diff and worker evidence, then runs the full integration and required runtime/browser checks at the stable boundary. Keep the existing quality bar: worker-focused checks do not substitute for required full checks. The main session updates the native todo only when the work genuinely advances, based on observed results. Report what changed, what was actually checked, remaining integration checks, and the next command.