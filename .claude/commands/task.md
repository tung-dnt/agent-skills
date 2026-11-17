---
description: Build one focused change in pairing mode — no design approval, test-first, with the harness's hard gates and PR check still enforced
---

Work at **task scope**: one focused change that does not alter a shared contract, done with the lead in the conversation. If the work spans several independent slices or changes a contract between services, recommend `/story <id>` (it needs a lead brief) and wait.

1. Read the request, repository instructions and the source you will change. Read the native todo view and preserve registered items.
2. You own the design: do not write a design note for approval. Ask the lead only when the request leaves an invariant, a contract, or the scope undecided.
3. For behavior changes follow `test-driven-development`: a failing focused test, the minimum change, focused checks. For a bug, write the test that reproduces it first.
4. Hard gates apply here too. When a write stops at a gate, the harness asks the lead; do not route around it with a shell write.
5. When the change touches shared state, retries, queues, transactions, caches or external side effects, include the concurrency note (`Idempotency:`, `Ordering:`, `Failure:`, `Transactions:`) in the PR body.
6. If this task fixes a bug that escaped an earlier review, do not stop at the fix: name the root artifact that let it through (brief template, invariant list, system map, hard gates, or a rule), tell the lead what to change there, and call the `lead` tool with `op: "retro"`, `story`, `summary` and `artifact`, so the lead classifies the cause.

When a worker is useful, delegate exactly one task through the native task mechanism with the repository root, allowed files, acceptance criteria and focused checks. Review the diff and the worker's evidence, run the required full checks at the stable boundary, and update the native todo from observed results. For registered verification work use `begin`, `run`, `status`, `complete` and `cancel` only as documented. Report what changed, what was actually checked, and the next command.
