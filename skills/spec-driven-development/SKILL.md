---
name: spec-driven-development
description: Creates requirements specifications with measurable acceptance criteria and capability decomposition. Use when starting a project, feature, or significant change without an approved specification, or unclear requirements must be settled before design and implementation.
---

# Spec-Driven Development

## Overview

Write clear, testable requirements before substantial implementation. A spec aligns the user and engineering team on what to build, why, constraints, and how success will be measured. Static specs/designs are durable context; the native todo remains the only mutable progress list for the active main session.

## When to Use

- Starting a project or feature with unclear requirements.
- A change spans multiple files or modules, or includes an architectural decision.
- A request contains several independently testable capabilities.

Single-line fixes and self-contained changes may use a brief in the user request instead of a long spec, while retaining clear acceptance criteria and required approval.

## Gated workflow

Clarify requirements, approve the specification, design shared contracts when needed, plan tasks, then implement. Each phase uses the user gate in `../../references/approval-gate.md`. A current native todo entry, native task status, artifact presence, or historical approval record is not user approval.

### Phase 0: capability map when necessary

Most requests describe one capability; skip this phase for a single capability. Decompose before writing detailed specs when the requirement groups into independently testable capabilities with different consumers/data, separate acceptance clusters, or parts that could ship independently.

Propose a small module table and dependency direction first:

```markdown
# Capability Map: <Initiative>

| Module ID | Responsibility | Depends on |
|---|---|---|
| identity | Accounts and sessions | — |
| billing | Plans and invoices | identity |

Order: identity → billing
```

Keep stable module IDs and one-way dependencies; cycles indicate the boundaries need review. Gate the map with the user before writing module specs. Then specify each approved module in dependency order and link its spec from the map. Do not turn the map into a project-wide status or claim system.

### Phase 1: specify

Start with clarifying questions. Surface assumptions before writing; never silently fill ambiguous requirements. Cover:

1. **Objective:** user, problem, reason, and measurable success.
2. **Commands:** actual build, test, lint, and development commands when known; do not invent flags.
3. **Project structure:** source, tests, docs, and ownership boundaries.
4. **Code style:** repository conventions and a representative example where useful.
5. **Testing strategy:** framework, test locations, test levels, and required coverage bar.
6. **Boundaries:** what to always do, ask first about, and never do.

A story/feature spec also numbers requirements: functional `FR1`, `FR2`, … with testable acceptance criteria; non-functional `NFR1`, `NFR2`, … with measurable targets. Use `CONSTRAINTS.md` when present, avoid restating parent requirements, and leave unresolved questions visible.

Save the spec at a path the user approves or the repository already uses (a project-wide `SPEC.md` is common). Do not require a work-state root lookup, vault setup, project task store, or fixed story/task directory. If the repository already uses an external spec tool, preserve its established format rather than creating a duplicate.

After writing the spec, summarize it, show the artifact path, grill open decisions, and ask the user to approve or revise. **Stop after the spec gate.** Planning and code start only after explicit approval in a subsequent step.

### Phase 2: plan

If the change adds/reshapes components or several tasks share an API, table, lifecycle, or event, produce a high-level design first. Then follow `planning-and-task-breakdown` for implementation order, dependency direction, vertical slicing, task sizing, exact files, and verification. Write the plan and worker briefs as static artifacts. The main session chooses order and file ownership and represents its current progress only in native todo. Do not write statuses to a project board or promise global claim/DAG safety.

Show the plan, grill trade-offs, and obtain user approval before worker execution. The plan remains a static record of intended work; native task completion does not edit it or prove tests.

### Phase 3: tasks

Each planned task includes a deliverable, testable acceptance criteria, focused verification, allowed files, dependencies, and design/requirement references. Tasks should fit a focused session and avoid unrelated subsystems. Native task workers receive the static brief by path; native todo is not mirrored to task notes or a replacement JSON store. Before code, every task from a written breakdown must also receive an approved low-level design, even if mechanical; concise notes and explicitly approved slice gates are allowed, silent skips are not.

### Phase 4: implement

Use `incremental-implementation` and `test-driven-development`. Work in small verified slices. The main session handles user decisions, ordering, and shared-file ownership. Workers run focused checks; one main integration owner runs required full-suite, integration, and runtime/browser checks at stable boundaries. A task's completion is not evidence that those checks passed.

## Keep the spec useful

- Update static requirements when user-approved scope or decisions change.
- Keep requirements, designs, and task briefs aligned with the code.
- Keep artifacts in the repository or another user-approved location according to existing conventions; don't add a mutable status tracker.
- Link the relevant requirement/design in PRs when useful.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| “This is simple; I need no acceptance criteria.” | A concise, testable requirement prevents a silent scope mismatch. |
| “I'll write the spec after coding.” | That records a result, not the agreed intent. |
| “We'll decide architecture during implementation.” | Shared boundaries then diverge across tasks; design them before planning. |
| “The feature is one big thing; splitting is overhead.” | Independent acceptance clusters need stable boundaries before detailed specs. |
| “The plan or todo status proves approval.” | Planning state and user approval are different; only explicit user consent passes the gate. |
| “The worker says done, so it is verified.” | Worker status is execution output; checks and integration proof must be observed. |

## Red Flags

- Code begins before requirements/acceptance criteria are clear.
- Ambiguous assumptions are not surfaced.
- A capability map is skipped when independently shippable modules are bundled.
- Design or implementation starts before its user gate.
- A task status/approval is inferred from a native todo, worker result, or imported note.
- The plan is stored as a second mutable checklist.
- A required full integration/runtime check is waived because focused tests passed.

## Verification

Before implementation, confirm:
- [ ] Requirements are clear, scoped, and testable.
- [ ] The spec includes the six core areas and defines boundaries.
- [ ] Story functional/non-functional requirements have stable IDs and measurable acceptance.
- [ ] A bundled capability map was approved before module specs.
- [ ] The human approved the spec explicitly.
- [ ] A high-level design exists where shared contracts or architectural decisions require it.
- [ ] A static plan/brief names order, dependencies, owned files, focused checks, and integration checks.
- [ ] Native todo is the only mutable progress list for the current main session.