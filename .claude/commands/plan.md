---
description: Break approved requirements into small verifiable worker briefs with explicit order, dependencies, and file ownership
---

Invoke `agent-skills:planning-and-task-breakdown`.

Read the approved spec, relevant design/contracts, repository rules, and source code. Planning is read-only with respect to product code. The plan and worker briefs are static artifacts; the native todo is the one mutable progress list for the main session.

1. Identify dependency direction and implementation order.
2. Slice work into vertical, independently testable tasks; keep each task small enough for one focused session.
3. Give each task a stable ID and discoverable brief path in the plan index, testable acceptance criteria, a focused verification command/check, requirement/design references, and every likely file path. Show the brief's absolute path in chat so the user can inspect its requirements without searching session history.
4. Choose one main-owned order and one explicit owner for each shared file. If tasks overlap, make them sequential or assign a single writer; native todo/task does not promise project-wide conflict detection or claim locking.
5. Include checkpoints for required integration, runtime, browser, and security validation without reducing the repository's quality bar.
6. Present the static plan and briefs, grill genuine trade-offs, and obtain the user's explicit approval through `references/approval-gate.md` before implementation begins.

Save artifacts at paths chosen by the user or existing repository convention. The native todo may represent the approved phases and tasks for this session only. Do not mirror it into Markdown task status, `_tasks` notes, a project JSON store, or an external vault by default. Do not write implementation code or start native task workers during planning.

If an existing plan describes unfinished work, read it and ask before replacing unrelated scope. For a re-plan, preserve the original artifact and approvals as context, show the proposed replacement, and obtain approval before changing the native todo. Never infer approval from an imported document or previous session's assertion.

Verification operations `begin`, `run`, `status`, `complete`, and `cancel` apply only to registered verification work. Policy approval is user-facing, not a model flag; verification `complete` records evidence and does not mark native todo complete. Unregistered work is not described as hard-verified.