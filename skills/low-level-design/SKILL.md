---
name: low-level-design
description: Produces a short low-level design note for one implementation task or subtask before its code is written — the signatures and types at the task's edges, the invariants and business rules it must enforce, a step-by-step flow with a failure branch at each step, retry and concurrency handling, where the authorization check sits, and the test cases all of that implies. Use when a planned task is about to be implemented and its internal design, edge cases, and error handling have not been decided. Use when you catch yourself about to decide a business rule or failure behaviour silently in the middle of writing code.
---

# Low-Level Design

## Overview

Code generation is fast; deciding intent is not. Without a written low-level design, the implementation makes the hard calls silently — what happens on a duplicate, which check runs first, what a partial failure leaves behind — and makes them differently each time. This skill makes those calls explicit, in writing, before the first test, in a note short enough to read in a minute.

The note is 5 to 15 lines and lives in the `## Design` section of the task's own note, `[stories-dir]/[story-id]/_tasks/[task-id].md` (the path `work-state.sh path [story-id] [task-id]` prints; or in the task's tracker item, when the plan uses an external tracker). Only the session that claimed the task writes that note, so parallel sessions never collide (see `../../references/work-artifacts.md`); the plan itself is never edited. It designs the **inside** of one task. The shared contracts it builds on — the APIs, schemas, status lifecycles, and failure policy that more than one task depends on — were fixed by the `high-level-design` skill and carry ids like `C3`; this skill cites them and never changes them. Anything that belongs to this task alone — a new endpoint or table no other task reads or writes — is designed here.

## When to Use

- A task from `planning-and-task-breakdown` is next, and its internal design is not written down
- The task involves business rules, status changes, external calls, concurrency, or authorization
- You notice yourself choosing failure behaviour, a validation rule, or an ordering rule while coding

**When NOT to use:**

- Mechanical changes with no decisions in them: renames, copy changes, dependency bumps, config values
- The task needs to change a shared contract, or to create something another task will call or read. That's a design change — escalate (Step 7).
- No plan or design exists yet. Start with `spec-driven-development` and `high-level-design`.

## The Process

**Stop after each of steps 1–6 at a step checkpoint** (`../../references/approval-gate.md`): show what the step produced, ask about any decision it raised, otherwise ask "Continue to step N+1?", and wait. Write each confirmed step into `## Design` straight away, so the note grows one approved piece at a time. For step 1, show the facts you'll design against: the contract ids, the code paths, and the patterns to match. For a bug, or when more than one approach is plausible, the step 1 checkpoint also asks the **approach** as a decision brief, so steps 2–6 build on the chosen one. Skip the checkpoints only when the user asked for one pass ("just build it", "don't stop", batch mode); then step 7's gate is the only stop.

### Step 1: Load only what the task needs

Read the task note (`work-state.sh brief [story-id] [task-id]` packs it with the plan row and the cited sections), the design sections its `design_refs` cite (shared contract ids like `C3`), and the code it will touch. Follow `context-engineering`: load the relevant slices, not the whole spec. Note the patterns the existing code already uses — error style, data-access layer, transaction handling — and match them. A note that invents a second way to do what the codebase already does has failed.

### Step 2: Contracts at this task's edges

Write the signature of what the task exposes or changes: function or handler name, input and output types, the error shape. Give one concrete example value instead of prose ("returns order details" says nothing; a literal example says everything). If the task calls a shared contract, cite its id rather than restating it. An endpoint or table that belongs to this task alone is specified here in full.

### Step 3: Invariants and business rules

List the rules this task enforces as explicit decisions, each with its outcome on violation: reject, ignore and log, or alert. Examples: "refund amount must not exceed what is left to refund → reject with 422", "an archived project accepts no new members → reject with 409". If the high-level design has a transition table, cite it by id; don't copy or re-derive it.

### Step 4: Flow with a failure branch at every step

Write the task's logic as numbered pseudocode. Every step that can fail gets its failure branch on the same line:

```
1. Load payment FOR UPDATE, scoped to the caller's merchant → missing or other merchant: 404
2. Check amount <= captured - already refunded             → otherwise: 422, nothing written
3. Call provider refund with idempotency key = requestId (C4)
                                                           → timeout: record refund PENDING, 202; reconciler finishes it (C4)
4. Insert refund + set payment status per C2, in one transaction
                                                           → db error: rollback, 503; client retry is safe (same requestId)
```

Prose is fine when the flow is three steps or fewer.

### Step 5: The cross-cutting lines

One line each. Write "n/a" rather than skipping a line, so a reviewer can see it was considered:

- **Failure policy** — for each boundary this task owns: timeout, retry and backoff, duplicate handling, what a partial write leaves behind
- **Concurrency** — transaction boundary, locking, ordering or staleness guard ("apply only if the incoming event is newer")
- **Security** — where the authorization or tenant/ownership check sits and exactly what it compares (a valid token is not enough; the token's account must own the resource). For a task with no caller — a worker or scheduled job — name the upstream trust boundary it relies on instead. Plus which fields must never appear in logs. Never a bare "n/a" when the task touches user data
- **Observability** — which log line, metric, or trace span this task emits, if any

### Step 6: Derive the test list

Every invariant, failure branch, and cross-cutting line becomes at least one test case. This list is the input to the RED step of `test-driven-development`:

```
- refund more than remaining → 422, no refund row
- payment of another merchant → 404
- same requestId sent twice → one refund, one provider call
- provider timeout → refund PENDING, response 202
- db error after provider success → nothing written, retry with same requestId succeeds
```

An edge case with no test is an undecided edge case.

### Step 7: Check the size, then escalate or proceed

- **Over 15 lines?** The task is too big. Stop and ask for it to be split into new tasks; don't edit the plan from inside a task.
- **Touches anything shared?** Stop if the task changes something cited by a `C` id, adds a component, creates an endpoint, status, or event another task will use, or alters a table, endpoint, or message that any other task also reads or writes. Adding a column to a shared table counts, even if only this task will use the column. Other tasks and their tests depend on that shape. Raise it against the `## Design` section (`high-level-design`) and get it approved before continuing. Never patch a shared contract from inside a task.
- **Adds an endpoint, table, or rule that belongs to this task alone?** That's in scope: design it in the note.
- **Otherwise** make sure the whole note is in the task note's `## Design` section (in one-pass mode, write it now), then pass the approval gate (`../../references/approval-gate.md`). The summary goes in the task note's `## Summary`, and it always asks at least "Proceed with this design?". Show the note itself at the gate, not just the summary. For a bug, or when more than one approach is plausible, the approach must have been asked as a decision brief (options, pros, cons, effort, reversibility, and the condition that would change your pick): at the step 1 checkpoint, or here in one-pass mode. Never re-ask what a checkpoint settled. After the user's go-ahead, record it with `work-state.sh approve [story-id] [task-id]`. Editing the note afterwards voids the approval. Only then hand off to `test-driven-development` and `incremental-implementation`.

## Note Template

Fill the `## Design` section of the task note (the task's `design_refs` custom field, here `C2, C4`, says which contracts it cites; `work-state.sh field [story-id] [task-id] design_refs "C2, C4"` sets it):

```markdown
## Design
- Edge: `refundPayment(tx, {paymentId, amountCents, requestId}, caller) → {refundId, status}`,
  e.g. `{paymentId: "pay_9", amountCents: 500, requestId: "rq_1"}` → `{refundId: "rf_3", status: "PENDING"}`
- Rules: amount ≤ captured − already refunded, else 422; status changes per C2
- Flow: 1 lock payment (merchant-scoped) → 2 remaining-amount check → 3 provider refund (C4) → 4 refund row + status in one tx
- Failure: provider timeout → PENDING, reconciler finishes it (C4); db error → rollback, 503, retry safe via requestId
- Concurrency: row lock serialises refunds on the same payment
- Security: caller's merchant id must equal payment.merchant_id, checked in step 1; never log card or bank fields
- Observability: counter `refund_result{outcome}`
- Tests: over-refund 422 · other merchant 404 · duplicate requestId · provider timeout · db error then retry · full refund → REFUNDED
```

## At Review

The note is the review baseline. `code-review-and-quality` checks the diff against it: every rule and failure branch implemented, nothing implemented that the note didn't decide. When the code had to diverge, the note is updated in the same change — an out-of-date note misleads the next task.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll figure out the edge cases while coding" | Then they get decided silently, and the tests only cover what you remembered. Writing them first takes minutes. |
| "The high-level design already covers this" | It covers the shared contracts, not this task's internal flow, failure branches, or tests. |
| "Security doesn't apply, the route is authenticated" | Authentication says who is calling. The note must say where the check proves they own *this* resource. |
| "It's a small change to the API, I'll just make it here" | If another task calls it, that task breaks silently. Escalate shared contracts; design task-only ones here. |
| "The note is getting long but it's all useful" | Past 15 lines, the task is too big. Split it; don't grow the note into a spec. |
| "Writing 'n/a' is pointless" | It shows a reviewer the concern was considered, not forgotten. |

## Red Flags

- Code written before any note exists for a task with business rules or external calls
- A note that restates the high-level design instead of citing contract ids
- A failure branch or invariant with no matching test case
- A security line left as a bare "n/a" on a task that touches user data
- A note that changes a shared contract, or adds something another task will depend on
- A "task-only" column added to a table other tasks also write
- A note longer than 15 lines, or implementation code inside the note
- Review comments arguing preference because nothing was written down to compare against

## Verification

- [ ] The note sits in the task note's `## Design` section and is 15 lines or fewer; the plan is unchanged
- [ ] Edge signatures and types are written with one concrete example
- [ ] Every invariant has a decided outcome on violation
- [ ] Every flow step that can fail has a failure branch
- [ ] Failure policy, concurrency, security, and observability lines are present (security names a check or a trust boundary whenever user data is involved)
- [ ] Every invariant and failure branch maps to at least one listed test case
- [ ] No shared contract was changed and nothing other tasks depend on was created; anything that needed one was escalated
- [ ] After implementation, the note still matches the code
