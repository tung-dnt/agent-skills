---
description: Take one story from approved requirements through design and a static, ordered implementation plan with explicit user gates
---

Work at **story scope**: one user-facing capability that needs several tasks, or tasks that share a contract. The main session owns the native todo, phase/order decisions, worker assignment, and file ownership. Static artifacts hold requirements, design, plan, and task briefs; they do not carry mutable task status.

Each phase ends at the user approval gate in `references/approval-gate.md`. Show the catch-up summary and the actual artifact, grill unresolved decisions, and wait for the user's explicit go-ahead. Do not treat a native todo mark, worker completion, or imported artifact as approval. After a gate, give the exact next command and recommend a fresh session when that would help; resume only from state and artifacts that are actually available in the current native session.

## Before anything else

1. Read `$ARGUMENTS`, the relevant repository sources, and any referenced issue as input; do not treat tracker type as the scope decider.
2. Check the scope using `references/work-artifacts.md`. If the request is a different scope, explain why, recommend the right command, and continue only after the user confirms.
3. Identify the approved artifact paths and stable work label. Read existing requirements/design/context before writing. Never configure a vault or create a project task store.
4. Read the current native todo view before changing it. Preserve existing items; do not reset or reinitialize a list that could discard registered unfinished work. If state after rewind/manual edits is ambiguous, request and reconcile a fresh native todo readback rather than guessing.

## Phases

1. **Spec.** Invoke `agent-skills:spec-driven-development`. Write numbered, testable functional requirements (`FR1`…) and measurable non-functional requirements (`NFR1`…), drawing on `CONSTRAINTS.md` when it exists. Avoid restating epic requirements; cite their stable `E` contract ids. Pass the user gate before design work.
2. **Design.** When components, integrations, data ownership, or shared contracts need a decision, invoke `agent-skills:high-level-design`. Preserve its scope, flows, NFR mechanisms, security, alternatives, review, and shared-contract method. Use `C1`, `C2`, … for story contracts and cite any relevant epic `E` contract. Pass the user gate before planning. If the design is genuinely unnecessary, state why and obtain explicit user agreement; do not represent a skipped design as an approved design artifact.
3. **Plan.** Invoke `agent-skills:planning-and-task-breakdown`. Write a static plan with ordered worker briefs, dependencies, acceptance criteria, focused verification, exact likely file paths, and an explicit owner for every shared path. Keep dependencies and execution ordering explicit and main-owned; do not claim automatic project-wide DAG readiness, path-conflict detection, or cross-session locks. Run the plan gate before starting implementation.
4. **Handoff.** Represent only the current session's execution progress in native todo. The main session selects a task and, when useful, delegates it through the host's native task mechanism by artifact path. Do not create or edit a mutable task-status document. A worker report is an execution result, not test proof or approval. Name the next command (`/build [work-id]`, `/task [work-id]`, or the relevant next phase) and distinguish work that has and has not been verified.

For verification-registered work, use the user-facing approval interaction before binding scope or policy. Never accept a model argument as approval. The public verification intent is `begin`, `run`, `status`, `complete`, and `cancel`: `complete` records valid evidence and does not update native todo; cancellation is not a passing result. Unregistered work is not described as hard-verified.