---
description: Build an approved story plan with native task workers inside the harness fences — no per-task design approval; hard gates and the plan's repository list are enforced in code
---

`/build [id]` builds the story whose plan the lead approved in `/story`. The harness refuses `/build` when the story has no approved plan. The main session owns the native todo, order, and file ownership. The plan file's `## Tasks` is your working breakdown, not an approval artifact.

## Before starting

1. Read the `# Lead story` block (brief, system map, hard gates) and the plan file. Read the native todo view and preserve registered unfinished items.
2. Order the tasks and assign one writer per shared file. Run tasks in parallel only when their paths and dependencies are independent. The harness caps concurrent builders (`limits.builders` in `hard-gates.md`).
3. You own low-level design. Do not ask the lead to approve task designs. Record each non-trivial choice and the alternative you rejected under `## Decision log` in the plan file as you go; it becomes the PR's decision log.

## Execute

For each task:
- Give a native task worker the repository root, the plan file path, its owned paths, acceptance criteria and focused check. Workers receive the brief and system map from the harness.
- Every brief invariant gets at least one proving test before its task is done. Go: run with `-race`, plus duplicate-request and concurrent-execution tests. TypeScript/Node: duplicate-delivery and concurrent-call tests against a real database or queue in a container, not mocks. Do not change or delete tests the lead owns; the harness gates them.
- When a task touches shared state, retries, queues, transactions, caches or external side effects, write the concurrency note (`Idempotency:`, `Ordering:`, `Failure:`, `Transactions:`) under `## Concurrency note` in the plan file.
- **Hard gates.** A write to a gated path stops for the lead. In the main session the harness asks the lead directly. A worker is blocked and reports `blocked: hard gate <id> <repo>/<path>`; then call the `lead` tool with `op: "gate"` and re-run the worker if the lead approves. Never route around a gate with a shell write.
- **Fence.** Reads and writes outside the plan's `repos:` are blocked. If the work needs another repository, stop and report the gap; adding a repository to `repos:` needs the lead's approval again.
- If the work would change the approved summary (goal, approach, or an invariant), stop, update the plan, and call the `lead` tool with `op: "approve"` again.

For registered verification work, use the `verification` operations `begin`, `run`, `status`, `complete` and `cancel` as documented; `complete` records evidence and does not change the native todo.

## Integration boundary

Workers run focused checks. At a stable boundary the main session runs the repository's required full suite and runtime checks once and records exact results. If a required check fails, keep the native item open and report the real failure.

In async mode (`mode: async` in the brief) keep going without check-ins: the harness notifies the lead only at a hard-gate stop or when you stop. Report completed work, focused and integration evidence separately, what is unverified, and the next command: `/ship`.
