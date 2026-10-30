---
name: low-level-design
description: Produces a concise static design before coding a task or subtask with function signatures and types, business rules, edge cases, error handling and failure branches, concurrency, authorization, observability, and derived tests. Use when designing any task from a written breakdown before code, or an ad-hoc change needs behavioral decisions.
---

# Low-Level Design

## Overview

Before implementation, write down the decisions a worker would otherwise make silently: interfaces, business rules, failure outcomes, retries, concurrency, authorization, observability, and the tests those choices imply. The note is task-local and static. Shared contracts belong in the approved high-level design.

## When to Use

- Required before code for **every task in a written breakdown**, including mechanical, configuration, and documentation tasks; the note may be concise.
- Also use for ad-hoc tasks when business rules, edge cases, failure behavior, concurrency, authorization, or observability need decisions.
- Use it when you notice yourself deciding behavior while coding.

A truly ad-hoc mechanical change with no design decisions may omit LLD. A task selected from a written plan may not skip its LLD solely because it looks trivial. If the task changes a shared contract, creates an interface used by another task, or alters shared data, escalate to high-level design. If requirements/design do not exist, start with `spec-driven-development` and `high-level-design`.

## Process

Pause after step 1 at the checkpoint in `../../references/approval-gate.md`; show the relevant contract IDs, source paths, and existing patterns. For a bug or multiple plausible approaches, ask the user to choose via a decision brief. Otherwise ask whether to continue. Then write steps 2–6 in one pass, pausing when an actual user decision is needed. The whole static design is gated before building. One-pass requests may skip the intermediate checkpoint only; never skip final approval.

### 1. Load only what the task needs

Read the static task brief supplied by the main session, approved contracts it cites, and relevant code. Follow `context-engineering`: load the relevant slices, not the entire spec. Identify real code conventions and exact paths. A design that invents a second way to handle an existing concern has failed.

### 2. Contracts at this task's edges

Write the changed/exposed function, handler, or command signature, input/output types, and error shape. Include one concrete example. Cite shared `C`/`E` contracts instead of restating them. Fully specify an endpoint/table/rule only when it is genuinely task-local.

### 3. Invariants and business rules

List rules with the outcome on violation: reject, ignore/log, retry, or alert. Cite shared transition contracts. Task-owned statuses need allowed/terminal transitions and behavior for invalid input.

### 4. Flow with failure branches

Use numbered pseudocode. Every step that can fail states its failure outcome on the same step. Include retries, idempotency, rollback, and partial-write behavior where relevant.

### 5. Cross-cutting lines

State each item explicitly; use `n/a` only when appropriate:
- **Failure policy:** timeout, retry/backoff, duplicates, partial writes.
- **Concurrency:** transaction, locking, ordering, stale-write guard.
- **Security:** exact authorization/ownership check or upstream trust boundary; sensitive fields never logged.
- **Observability:** log/metric/trace and alert condition for new actionable failures.

### 6. Derive tests

Every invariant, failure branch, and cross-cutting rule maps to at least one test case. This list is the RED-step input for `test-driven-development`. An edge case without a test is unresolved.

### 7. Check size and shared scope

If the design exceeds roughly 15 lines or spans independent subsystems, propose a split as a user decision; do not silently rewrite the approved plan. If it touches an API, schema, status, event, or other contract another task uses, stop and request high-level design approval. Never patch a shared contract from inside a task.

Write the note into the static design/worker artifact at the absolute path supplied by the main session. It is the code-review baseline, not a mutable task-status note. The main session obtains explicit user approval before implementation: per task, or through a user-approved repo-sized slice gate that shows every included task design. A plan gate alone does not approve task-level design. The main session owns approval evidence; a worker cannot approve itself.

## Note template

```markdown
## Design
- Edge: `refundPayment(tx, input, caller) -> Refund`; example `{paymentId: "pay_9", amountCents: 500}` -> `{refundId: "rf_3", status: "PENDING"}`
- Rules: amount <= remaining, else 422; transitions follow C2
- Flow: 1 lock payment -> 2 validate -> 3 provider request -> 4 write result
- Failure: timeout -> pending/reconcile (C4); DB error -> rollback and safe retry
- Concurrency: row lock serializes same-payment refunds
- Security: caller merchant must own payment; never log card/bank data
- Observability: counter `refund_result{outcome}`; alert on repeated provider errors
- Tests: over-refund 422 · other merchant 404 · duplicate request · timeout · retry after DB error
```

## At review

Review the diff against the approved note: every invariant/failure branch is implemented, no unapproved behavior was added, and the note matches code. A divergence requires stopping and getting the static design changed through the user gate.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| “I'll decide edge cases in code.” | That silently chooses business behavior and leaves tests incomplete. |
| “The HLD covers this.” | HLD fixes shared contracts; task-local flow/failures still need decisions. |
| “The route is authenticated.” | Authentication does not prove caller ownership of the resource. |
| “It's a small change to the shared API.” | Another task can break; escalate the shared contract. |
| “The note is long but useful.” | Long notes indicate a task that needs splitting or a shared design. |

## Red Flags

- Implementation starts before the user approves the task design.
- A rule has no decided violation outcome or corresponding test.
- Authentication is treated as proof of resource ownership.
- A worker changes a shared contract or silently chooses missing behavior.
- Native task completion is presented as evidence that verification passed.

## Verification

- [ ] The note is a short static artifact at the supplied path; no progress status is stored in it.
- [ ] Signatures, types, and a concrete example are present.
- [ ] Every invariant has a decided violation outcome.
- [ ] Every failure-prone flow step has a failure branch.
- [ ] Failure, concurrency, security, and observability were considered.
- [ ] Every rule maps to a test case.
- [ ] Shared contracts are cited/escalated, never changed unilaterally.
- [ ] The user approved before implementation, and the final code matches the note.