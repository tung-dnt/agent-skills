---
name: planning-and-task-breakdown
description: Breaks work into ordered worker briefs with acceptance criteria, dependencies, verification, and file ownership. Use when an approved spec needs implementable tasks, work has independent slices or shared contracts, or a change is too large for one focused implementation.
---

# Planning and Task Breakdown

## Overview

Decompose approved requirements into small, verifiable tasks. A good plan makes the intended user value, order, acceptance criteria, checks, and changed files explicit before implementation.

The main session is the sole owner of the current native todo, task selection/order, and file ownership. Plans and worker briefs are static context passed by path; they are not mutable status stores. Native task completion is an execution outcome, not proof that code was tested or reviewed.

## When to Use

- A clear spec needs to be broken into implementable tasks.
- The request has several independent slices, unclear order, or shared contracts.
- A change is too large for one focused implementation.

For a single obvious change with no shared contract, use `/task` without adding ceremony.

## Planning process

### 1. Read-only planning

Before changing product code:
- Read the approved requirements, design/contracts, repository instructions, and relevant source.
- Reuse the repository's established patterns and note risks or unknowns.
- If tasks share APIs, schemas, data, or lifecycle rules and no high-level design exists, run `high-level-design` first.
- Planning produces static artifacts and a native todo proposal only; it does not implement code or launch workers.

### 2. Identify dependencies and order

Make prerequisites explicit and order providers before consumers. Use a small dependency table/diagram where it clarifies the work. Avoid cycles; if two slices cannot be separated without redesign, combine them or ask for a design decision.

Dependencies are part of the approved plan and the main session uses them to choose an order. Do not claim that native todo or task provides automatic project-wide DAG readiness, cross-session status discovery, or claim/lock protection.

### 3. Slice vertically

Prefer complete user-visible or otherwise independently verifiable paths over horizontal layers.

**Bad:** database, then all API routes, then all UI.

**Good:** a complete registration path, then a complete login path, with explicit shared contracts and dependencies.

Each slice should leave the system in a coherent state and should be small enough to implement and check in one focused session. Put high-risk work early enough to learn from it before dependent work proceeds.

### 4. Write one static worker brief per task

Use the approved artifact path chosen by the user/main session. Include:

```markdown
# <Task ID> — <Short title>

## Description
<What this task delivers and why>

## Acceptance criteria
- <Specific, testable condition>

## Verification
- <Focused test/build/manual command and expected result>

## Dependencies and design references
<Prerequisite task IDs and FR/NFR/C/E contract IDs>

## Owned paths
- `src/path/to/file.ts`
- `tests/path/to/file.test.ts`

## Scope
<In scope, explicitly out of scope, and any known risks>
```

Keep every likely changed/generated file in the owned-path list, including lockfiles if relevant. The main session assigns one owner to shared paths and schedules overlapping tasks sequentially. Static briefs do not contain mutable status, checkboxes used as progress, claim metadata, or worker logs.

Each task should have concrete acceptance criteria and a verification step. Preserve requirements and security constraints; do not reduce the project quality bar to fit a task.

**Every planned task has a task-level design gate before code.** Invoke `low-level-design` for every task from a written breakdown, including mechanical tasks; a concise LLD is enough. The main session obtains explicit approval per task or through a user-approved repo-sized slice gate showing every included design. Do not skip solely because a task looks trivial. Only an ad-hoc mechanical change with no design decisions may omit LLD.

### 5. Size tasks

| Size | Typical scope | Example |
|---|---|---|
| XS | One config or function | Add a validation rule |
| S | One component or endpoint | Add a focused API endpoint |
| M | One vertical feature path | Registration flow across a few modules |
| L | Several components | Search with filtering/pagination; review whether it can split |
| XL | More than one focused session or independent subsystem | Split before implementation |

Split a task when it would need multiple focused sessions, has more independent acceptance criteria than can be reviewed together, crosses unrelated subsystems, or the title repeatedly uses “and.” Do not split shared-contract work without first revisiting the design.

### 6. Order, ownership, and checkpoints

The plan states an explicit order, dependencies, and an owner for every file shared by tasks. Add focused checkpoints after substantial slices and reserve required full-suite, integration, and runtime/browser validation for the main integration owner at stable boundaries. Do not ask every worker to run a duplicate full suite, and do not omit a required gate.

Parallel workers are appropriate only when dependencies and exact file ownership show no overlap. There is no project-wide claim service or automatic shared-file conflict detector; if ownership is unclear, run sequentially. Main makes the coordination decision.

### 7. User approval

When ordering, scope, or architecture has meaningful alternatives, present a decision brief with evidence, trade-offs, what the choice hinges on, and the condition that would change the recommendation. Show the static plan and task briefs at the gate in `../../references/approval-gate.md`, ask the user, and wait for explicit approval before implementation. A generated native todo or imported artifact is not approval.

## Output artifacts

Use paths supplied by the main session/user or the repository's actual convention. Common artifacts are a requirements spec, high-level design, plan, and individual static worker briefs. They may live in repository docs or another user-selected location. Do not impose a vault path, `_tasks` layout, project task JSON database, mutable status file, or duplicate project board.

A compact plan index can look like this:

```markdown
# Implementation Plan: <Feature>

## Overview
<What is being built>

## Decisions and risks
<Approved choices and unresolved questions>

## Ordered tasks
| ID | Deliverable | Brief artifact | Depends on | Owner/paths | Verification |
|---|---|---|---|---|---|
| T01 | ... | `artifacts/t01.md` | — | ... | ... |
| T02 | ... | `artifacts/t02.md` | T01 | ... | ... |

## Integration checkpoints
<Full checks and runtime checks the main integration owner must run>
```

This index is a static planning artifact, not the progress view. The main session keeps actual progress only in native todo and worker execution state.

Keep each task ID mapped to its brief path in this index, and show the absolute path in the handoff/chat so the user can open the requirement without searching session history. A request to view a task's requirements reads that brief and its cited spec sections, not the entire transcript. Session-local artifacts support the owning session; cross-session or cross-machine context belongs at the user-approved durable location, commonly Git-tracked repository documents. Neither location stores mutable progress.

## Re-planning

When work reveals that scope, design, dependencies, or file ownership must change:
1. Stop affected work and compare the observed issue with approved scope/design.
2. Explain the change and any consequences; ask the user when approval boundaries or requirements change.
3. Update the static plan/brief only after approval. Preserve prior context when needed; do not destroy a user's unfinished work or infer approval from historical notes.
4. Reconcile the current native todo by readback, keeping it as the only mutable progress list. Do not create a migration board or mirror statuses.
5. Reassign file ownership and order explicitly before workers resume.

## Verification

Before implementation, confirm:
- [ ] Every task traces to approved requirements and applicable design contracts.
- [ ] Each task has testable acceptance criteria and a focused verification step.
- [ ] Dependencies, execution order, and shared-file ownership are explicit.
- [ ] Every worker has a static brief at a real absolute path and an allowed-path boundary.
- [ ] Work is sized for one focused session and vertical where practical.
- [ ] User approval is explicit and not inferred from native task/todo state.
- [ ] Every task from a written breakdown has a user-approved static LLD before code; concise notes and explicitly approved slice gates are allowed, silent skips are not.
- [ ] Required full integration/runtime checks and their main owner are identified.
- [ ] No second mutable task-status tracker has been introduced.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| “The worker will work out the requirements.” | The brief needs testable acceptance criteria and exact scope before handoff. |
| “Native task handles dependencies and ownership.” | Main must explicitly order dependencies and prevent shared-file overlap. |
| “Focused tests passed, so integration is optional.” | The required full gates still belong to the integration owner. |
| “A small planned task needs no design.” | Every task in a written breakdown needs an approved LLD; it may be concise. |

## Red Flags

- A task has no requirement reference, acceptance criteria, or discoverable brief path.
- The plan is used as a second mutable status list.
- Parallel tasks own the same file or generated output.
- Task execution is mistaken for verified completion.
- Planning omits required integration checks or silently lowers their thresholds.

## See also

Acceptance criteria answer whether this task delivered the right result. The project-wide quality bar and Definition of Done still apply to every task; see `../../references/definition-of-done.md`.