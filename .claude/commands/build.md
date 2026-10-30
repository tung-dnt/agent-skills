---
description: Build approved work using native task workers, main-owned ordering, explicit file ownership, focused checks, and one full integration boundary
---

Invoke `agent-skills:incremental-implementation` with `agent-skills:test-driven-development`.

`/build [work-id]` builds the approved work named by the user or static plan. The main session owns the native todo, execution order, task selection, and explicit file ownership. Static specs/designs/plans/task briefs are the handoff; they never store mutable task status. Native task execution manages worker execution and output, not project-wide claims or verification.

## Before starting

1. Read the approved spec, design, plan, worker briefs, repository instructions, and current source. If no clear approved scope/design is available, stop at the appropriate user gate; don't invent requirements.
2. Read the native todo view. Preserve existing and registered unfinished items; never reset/reinitialize the list or guess after rewind/manual edits. If state is uncertain, request a fresh native todo readback and reconcile with the user.
3. Main reviews the proposed order, dependencies, and file paths. Assign one writer per shared file. Parallelize only tasks whose explicit allowed paths and dependencies are independent; there is no cross-session lock, global DAG readiness, or automatic collision guarantee. Prefer sequential execution when ownership is unclear.
4. Before starting **each task from a written plan**, ensure its low-level design is written into the static brief and explicitly user-approved, including mechanical tasks. A concise note is sufficient. Obtain approval per task or through an explicitly user-approved repo-sized slice gate that shows every included design; the plan gate alone is not task-design approval. Do not skip because work looks trivial. Only an ad-hoc mechanical change with no design decisions may omit LLD.

## Execute

For each approved task:
- For each task from a written plan, confirm its approved low-level design is present in the static brief and covers the assigned paths; this applies even to mechanical tasks. Only an ad-hoc mechanical change with no design decisions may omit LLD. Stop and return to the user gate if implementation would depart from the approved design.
- Give a native task worker one static artifact brief by absolute path, the accepted change boundary, exact allowed paths, relevant design contracts, acceptance criteria, and focused checks. Workers must not update a second board or claim more work.
- Require test-first implementation for behavior changes, focused checks, exact evidence, and an honest report. A worker's `completed` state is an execution outcome only, not proof that tests passed or code is reviewed.
- The main session inspects the actual diff and reported output, handles decisions through the user gate, and keeps shared files/main ownership in the coordinator.

For registered verification work, use the documented verification interface operations `begin`, `run`, `status`, `complete`, and `cancel`. `begin` is not a model approval flag; binding requires user-facing approval. `run` is actual execution, `status` reports observed state, `complete` records valid evidence, and `cancel` stops work without a passing receipt. Never call `complete` based on a worker's assertion alone. The native todo progress remains separate from verification receipts. Unregistered work is not described as hard-verified.

## Integration boundary

Workers run only focused checks during iteration. At a stable integration boundary, the main session runs the repository's required full suite, integration checks, and required runtime/browser checks once, then records exact results and the candidate identity in the supported evidence mechanism. Do not reduce or waive quality criteria. If any required check fails, keep the native item open, report the real failure, and fix or ask the user; don't suppress it or relabel task completion as proof.

After full checks and review, the main session decides whether to complete the native todo item. If evidence-gated work is registered, the verification gate controls protected native completion; `complete` records evidence and does not itself change todo state. Cancellation is not verified completion. Report completed work, focused and integration evidence separately, anything unregistered/unverified, remaining work, and the next command.