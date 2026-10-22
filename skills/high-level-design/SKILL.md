---
name: high-level-design
description: Produces the high-level design for a user story, feature, or epic after its requirements are written — the system architecture (which services, modules, and data stores are involved and what each owns, data flow, sync versus async calls, how each non-functional requirement is met) plus the shared contracts that several implementation tasks will depend on (status lifecycles, schema changes, cross-service failure policy). Use when a user story or spec needs a system design or architecture before planning the tasks. Use when a change adds or reshapes services, data stores, queues, or integrations and nobody has decided how they fit together yet.
---

# High-Level Design

## Overview

Requirements say *what* the system must do. High-level design decides *what shape of system* will do it, and fixes the contracts that more than one task will build against. Skipping it doesn't remove those decisions; it scatters them across tasks, where each implementation makes its own silent, inconsistent choice. The test for a finished design: "If we build this shape, will it realistically meet the requirements, and can each task be built without re-deciding anything shared?"

The design has two layers:

- **Shape** — what you could draw on a whiteboard in ten minutes: components, flows, data ownership, and how each non-functional requirement is met.
- **Shared contracts** — the spec-sheet details that several tasks depend on: API contracts, schema changes, status lifecycles, cross-component failure policy. Decide these here, once, before tasks are planned.

Everything local to a single task — internal functions, local edge cases — is left to the `low-level-design` skill.

## When to Use

- A spec or user story has approved functional and non-functional requirements, and tasks have not been planned yet
- The change adds or reshapes a service, module, data store, queue, or third-party integration
- Several tasks will share an API, a table, a status field, or an event stream
- An epic needs its architecture settled before stories are cut

**When NOT to use:**

- Requirements are still unclear. Use `spec-driven-development` (or `interview-me`) first; designing against guessed requirements produces a confident wrong design.
- The change lives inside one existing module and changes no shared contract. Go straight to `planning-and-task-breakdown`, then `low-level-design` per task. Once the user agrees to skip the design, record it with `work-state.sh approve-phase [story-id] design` (no `## Design` written), so the story's phase moves on.
- You only need one interface's surface (fields, errors, versioning). Use `api-and-interface-design`.

## The Process

Work top-down. Finish the shape layer before the contracts layer; contracts written before the shape is agreed get rewritten.

**Stop after each of steps 1–11 at a step checkpoint** (`../../references/approval-gate.md`): show what the step produced (the section, or for step 1 the FR and NFR ids and the existing components you'll build on), ask about any decision it raised as a decision brief, otherwise ask "Continue to step N+1?", and wait. Write each confirmed section into `## Design` before starting the next, so a later step never rests on an unconfirmed one. Skip the checkpoints only when the user asked for one pass ("don't stop", "draft it in one go"); then step 12's gate is the only stop.

### Step 1: Load inputs and read what exists

- Read the spec. Give every functional requirement and non-functional requirement a stable id (`FR1`, `NFR1`) if it lacks one; the design traces back to these.
- Read `CONSTRAINTS.md` if the project has one (see `constraint-driven-development`); its thresholds are non-functional requirements too.
- Read the existing architecture: current services, data stores, integration points, and existing ADRs. Extend what exists before inventing something new. In a large codebase, delegate this reading to a fast-tier, read-only subagent that returns a short component summary, so the design context stays small. Give it the subagent command rules from `../../references/model-routing.md`, so it never stops the user with permission prompts.
- When the story belongs to an epic, read the epic's `## Architecture` in `[epics-dir]/[epic-id]/epic.md` too. Its `E` contracts already bind the story: cite them by id instead of restating them.

### Step 2: Scope

Write what the design covers and, explicitly, what it does **not**. The out-of-scope list is what stops the design, and later the tasks, from quietly growing. Add a small context diagram: the system as one box, with the users and external systems around it.

### Step 3: Components and responsibilities

List each component the change touches — new or modified — with one line on what it owns. One owner per responsibility. If a new component's job could be done by modifying an existing one, prefer the modification and say why it isn't enough if you still add one.

### Step 4: Flows

Draw the main flows as sequence diagrams. Label every hop **sync** or **async**, and mark each flow **critical path** (a user waits on it) or **background**. Draw the happy path plus only the failure paths that change the design (for example, "the carrier is down, so ingestion must be async"). Exhaustive edge cases belong in `low-level-design`.

```mermaid
sequenceDiagram
    participant C as Carrier
    participant W as Webhook route
    participant Q as Queue
    participant K as Worker
    C->>W: POST event (sync, background)
    W->>Q: publish (async)
    W-->>C: 202 Accepted
    Q->>K: consume (async)
```

### Step 5: Data ownership

For each entity the change touches: which component owns (writes) it, who else reads it and how, and the retention or regulatory rule that applies (retention period, deletion, personal-data handling). Name the entities and the migration strategy here. Column-level detail goes in Step 10 only if more than one task depends on it.

### Step 6: Non-functional requirements → mechanisms

Never restate a target without a mechanism. For each NFR:

| NFR | Target | Mechanism | How it's verified |
|---|---|---|---|
| NFR1 | p95 status read < 200 ms | Read from a cache keyed by order id, invalidated by the worker | Load test on the read endpoint |
| NFR3 | No cross-account reads | Ownership check in the read handler, comparing the caller's account with the order's owner | Negative test: account A reads account B's order → 404 |

An NFR with no mechanism is an unmet requirement.

### Step 7: Integrations and consistency

For each external or cross-component call: timeout, retry and backoff, circuit breaker if the dependency can degrade, and whether the result is **strongly** or **eventually** consistent. If eventual, state how stale the data can be and what the user sees meanwhile.

### Step 8: Security and compliance

A separate pass, not a line inside Step 6: how callers authenticate, where authorization and tenant or ownership scoping are enforced, trust boundaries (which inputs are untrusted), encryption, and which sensitive fields must never be logged. Pull in `security-and-hardening` when the change handles untrusted input or sensitive data.

### Step 9: Rollout shape

One or two lines: feature flag or not, migration order (expand → deploy → contract), and a canary or staged rollout if the blast radius warrants it. `shipping-and-launch` owns the full checklist.

### Step 10: Shared contracts

For each item below, write it down only if **more than one task** depends on it. A contract used by a single task belongs in that task's low-level design.

- **API contracts** — method, path, request and response with concrete JSON examples for success and each error. Follow `api-and-interface-design` for the rules; this step only records the decisions.
- **Schema changes** — tables and columns with types and nullability, constraints, *why* each index exists, soft or hard delete.
- **Status lifecycles** — any field with statuses gets a transition table: allowed transitions, terminal states, and a decided outcome for every invalid transition (reject, ignore and log, or alert). Don't let an implementer improvise it.
- **Failure policy at shared boundaries** — idempotency key, retry count and backoff, dead-letter handling, and what a partial write leaves behind.

### Step 11: Alternatives and decision

Put each decision that is expensive to reverse (sync versus async, new store versus existing, build versus buy) to the user as a decision brief (`../../references/approval-gate.md`): at least two viable designs, their pros and cons measured against the NFRs, effort, reversibility, what the choice hinges on, and when you'd choose differently. Record each chosen decision as an ADR using `documentation-and-adrs`, including the rejected options and why they lost.

### Step 12: Doubt, then human approval

Run the design through `doubt-driven-development` with the spec as the contract, on the deep tier (the main thread's model), in a fresh context: a fresh-context reviewer looks for requirements with no design element, NFRs with no mechanism, and failure paths nobody owns. Fold the findings back in, then pass the approval gate (`../../references/approval-gate.md`): a catch-up summary, `grill-me` rounds over the decisions still open (never re-ask what a checkpoint settled), and the user's explicit go-ahead. Record the go-ahead with `work-state.sh approve-phase [story-id] design`: the story's phase doesn't advance without it, and editing the design afterwards voids it. Tasks are planned only against an approved design.

## Output

Write the design into the story spec, `[stories-dir]/[story-id]/spec.md` (`docs/stories/[story-id]/spec.md` in the repo store; directory from `work-state.sh root`), as a `## Design` section (or a sibling `design.md` if the spec is already long), so it lives next to the story's plan and task notes:

```markdown
## Design

### Scope
In: … | Out: … | Context diagram

### Components
| Component | New/changed | Owns | Serves |

### Flows
Sequence diagrams, each hop labelled sync/async, each flow critical/background

### Data
| Entity | Owner | Readers | Retention/regulatory | Migration |

### NFR mechanisms
| NFR | Target | Mechanism | Verification |

### Integrations
| Dependency | Timeout | Retry/backoff | Consistency |

### Security
AuthN, AuthZ/tenant scoping point, trust boundaries, never-logged fields

### Rollout
Flag, migration order, staged rollout

### Shared contracts
#### C1 API
… method, path, request and response examples
#### C2 Schema
#### C3 Status transitions
#### C4 Failure policy

### Decisions
ADR links, alternatives considered
```

Give each shared contract a stable id (`C1`, `C2`) so tasks can cite exactly what they depend on, and write it under its own heading (`#### C1 API`) with its examples and tables beneath. That heading's whole section is the contract: `work-state.sh brief` hands a task the section for each id it cites, and the task's approval covers that text, so an edit to any part of it voids the approval. A contract without a heading is read as the paragraphs that mention its id. Every component, flow, and contract should trace to at least one `FR`/`NFR` id; an element that traces to nothing is scope creep.

**At epic level**, write the architecture into the epic's `[epics-dir]/[epic-id]/epic.md` (`docs/epics/[epic-id]/epic.md` in the repo store) under `## Architecture`, with the same sub-sections, and give each contract that several stories share an id with an `E` (`E1`, `E2`). Stories keep `C1…` for their own contracts. A task cites either kind in its `design_refs` (`work-state.sh field [story-id] [task-id] design_refs "C1, E2"`), and `work-state.sh brief` and the task's approval read an `E` id from the story's parent epic.

**Keep the design alive.** When implementation reveals the design was wrong, update the `## Design` section in the same pull request as the code. A design that disagrees with the code is worse than no design. Tasks were approved against the old text of a contract, so changing one has a fixed follow-up: once the user approves the change, record it (`work-state.sh approve-phase [story-id] design`), run `work-state.sh cites [story-id] [contract-id]` to list the tasks that cite the contract with their status (for an epic's `E` id, run it for each story of the epic), and re-gate each of them that isn't done: their approvals are void until they pass the gate again (`low-level-design`, step 7). A task already built against the old contract needs a new task to change it.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The design is obvious, I'll just plan the tasks" | Then writing it down takes ten minutes. If it isn't obvious, the tasks will each decide it differently. |
| "We'll figure out retries and duplicates during implementation" | Then every task makes a different call. Idempotency and failure policy are contracts, not details. |
| "The NFRs are listed in the spec, that covers them" | A target without a mechanism is a wish. Name the cache, index, queue, or check that meets it. |
| "Only one sensible option exists" | Then comparing two takes one paragraph. Usually a cheaper option was never considered. |
| "Full schema and class diagrams make the design complete" | They make it unreadable and stale by next week. Record only what more than one task depends on. |
| "The design doc is done, the code is the truth now" | When they disagree, the next person trusts the wrong one. Update the design in the same PR. |

## Red Flags

- An NFR restated as a target with no mechanism beside it
- No out-of-scope list
- A flow with no sync/async label, or a user waiting on something marked async
- A status field that more than one task writes, with no transition table
- A shared boundary with no stated idempotency or retry rule
- The shape layer reads like code: class names, full DDL, every edge case
- A new component where extending an existing one would do, with no reason given
- A design element that traces to no requirement id
- Tasks planned before the design was approved

## Verification

- [ ] Every FR and NFR id maps to at least one design element, and every element traces back to one
- [ ] Out-of-scope is written down
- [ ] Every flow hop is labelled sync/async and every flow critical/background
- [ ] Every NFR has a mechanism and a verification method
- [ ] Data ownership and retention are stated for every entity touched
- [ ] Every contract shared by two or more tasks has a stable id and concrete examples
- [ ] Every status field has a transition table with decided invalid-transition behaviour
- [ ] At least two alternatives were compared for hard-to-reverse decisions, and ADRs are recorded
- [ ] A fresh-context doubt pass ran and its findings were resolved
- [ ] The human approved the design before task planning started
