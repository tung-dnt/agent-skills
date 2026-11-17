---
name: low-level-design
description: Produces a concise static design before coding a task or subtask with function signatures and types, business rules, edge cases, error handling and failure branches, concurrency, authorization, observability, and derived tests. Use when designing any task from a written breakdown before code, or an ad-hoc change needs behavioral decisions.
---

# Low-Level Design

## Overview

Before implementation, write down the decisions a worker would otherwise make silently: interfaces, business rules, failure outcomes, retries, concurrency, authorization, observability, and the tests those choices imply. The note is task-local and static. Shared contracts belong in the approved high-level design.

## When to Use

- Use for a task with real decisions: business rules, edge cases, failure behavior, concurrency, authorization, or observability. A mechanical change needs no note.
- Use it when you notice yourself deciding behavior while coding.

The note is the agent's own working design; nobody approves it. If the task changes a shared contract, creates an interface used by another task, or alters shared data, stop and raise it with the lead, who owns contracts.

## Process

Write steps 1–6 in one pass. Ask the lead only when a decision is theirs: an invariant, a shared contract, or scope.

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

If the design exceeds roughly 15 lines or spans independent subsystems, split the task. If it touches an API, schema, status, event, or other contract another task uses, stop and raise it with the lead. Never patch a shared contract from inside a task.

Write the note where the main session keeps its working design (for a lead story, the plan file's `## Tasks` or `## Decision log`). It is the code-review baseline, not a mutable task-status note, and it needs no approval.

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

Review the diff against the note: every invariant and failure branch is implemented, and the note matches the code. When they diverge, fix whichever is wrong and record the change in the decision log.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| “I'll decide edge cases in code.” | That silently chooses business behavior and leaves tests incomplete. |
| “The HLD covers this.” | HLD fixes shared contracts; task-local flow/failures still need decisions. |
| “The route is authenticated.” | Authentication does not prove caller ownership of the resource. |
| “It's a small change to the shared API.” | Another task can break; escalate the shared contract. |
| “The note is long but useful.” | Long notes indicate a task that needs splitting or a shared design. |

## Red Flags

- The task changes a shared contract without the lead.
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
- [ ] The final code matches the note.