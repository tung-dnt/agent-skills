---
name: planning-and-task-breakdown
description: Breaks work into ordered tasks. Use when you have a spec or clear requirements and need to break work into implementable tasks. Use when a task feels too large to start, when you need to estimate scope, or when parallel work is possible.
---

# Planning and Task Breakdown

## Overview

Decompose work into small, verifiable tasks with explicit acceptance criteria. Good task breakdown is the difference between an agent that completes work reliably and one that produces a tangled mess. Every task should be small enough to implement, test, and verify in a single focused session.

## When to Use

- You have a spec and need to break it into implementable units
- A task feels too large or vague to start
- Work needs to be parallelized across multiple agents or sessions
- You need to communicate scope to a human
- The implementation order isn't obvious

**When NOT to use:** Single-file changes with obvious scope, or when the spec already contains well-defined tasks.

## The Planning Process

### Step 1: Enter Plan Mode

Before writing any code, operate in read-only mode:

- Read the spec and relevant codebase sections
- Read the approved design if one exists; if the work shares contracts across tasks and no design exists, produce it first with the `high-level-design` skill
- Identify existing patterns and conventions
- Map dependencies between components
- Note risks and unknowns

**Do NOT write code during planning.** The output is a plan document and one file per task, recorded in the task list target (see Output Files; default `docs/stories/[story-id]/plan.md` plus a `tasks/` file per task), not implementation.

### Step 2: Identify the Dependency Graph

Map what depends on what:

```
Database schema
    │
    ├── API models/types
    │       │
    │       ├── API endpoints
    │       │       │
    │       │       └── Frontend API client
    │       │               │
    │       │               └── UI components
    │       │
    │       └── Validation logic
    │
    └── Seed data / migrations
```

Implementation order follows the dependency graph bottom-up: build foundations first.

### Step 3: Slice Vertically

Instead of building all the database, then all the API, then all the UI — build one complete feature path at a time:

**Bad (horizontal slicing):**
```
Task 1: Build entire database schema
Task 2: Build all API endpoints
Task 3: Build all UI components
Task 4: Connect everything
```

**Good (vertical slicing):**
```
Task 1: User can create an account (schema + API + UI for registration)
Task 2: User can log in (auth schema + API + UI for login)
Task 3: User can create a task (task schema + API + UI for creation)
Task 4: User can view task list (query + API + UI for list view)
```

Each vertical slice delivers working, testable functionality.

### Step 4: Write Tasks

Each task follows this structure, whether it lands in its own task file or as an item in an external tracker (see Output Files):

```markdown
## Task [task-id]: [Short descriptive title]

**Description:** One paragraph explaining what this task accomplishes.

**Acceptance criteria:**
- [ ] [Specific, testable condition]
- [ ] [Specific, testable condition]

**Verification:**
- [ ] Tests pass: [the repository's focused-test command]
- [ ] Build succeeds: [the repository's build command]
- [ ] Manual check: [description of what to verify]

**Dependencies and design refs:** recorded in the task file's frontmatter as `depends_on` (task ids, or `[]`) and `design_refs` (shared contract ids from the design, e.g. `[C1, C3]`), so `/build` can read them.

**Files likely touched:**
- `src/path/to/file.ts`
- `tests/path/to/test.ts`

**Estimated scope:** [Small: 1-2 files | Medium: 3-5 files | Large: 5+ files]
```

Don't write the task's internal design here. Just before a task is implemented, its low-level design note is added to the task file with the `low-level-design` skill.

### Step 5: Order and Checkpoint

Arrange tasks so that:

1. Dependencies are satisfied (build foundation first)
2. Each task leaves the system in a working state
3. Verification checkpoints occur after every 2-3 tasks
4. High-risk tasks are early (fail fast)

Add each checkpoint to the task list target as a task of its own, depending on the tasks it gates, so it is claimed and completed like any other task:

```markdown
## Task t04-checkpoint-foundation: Checkpoint after t01–t03
- [ ] All tests pass
- [ ] Application builds without errors
- [ ] Core user flow works end-to-end
- [ ] Review with human before proceeding
```

Before any task is built, the plan passes the approval gate (`../../references/approval-gate.md`): a catch-up summary, `grill-me` rounds over the open decisions, and the user's explicit go-ahead.

## Task Sizing Guidelines

| Size | Files | Scope | Example |
|------|-------|-------|---------|
| **XS** | 1 | Single function or config change | Add a validation rule |
| **S** | 1-2 | One component or endpoint | Add a new API endpoint |
| **M** | 3-5 | One feature slice | User registration flow |
| **L** | 5-8 | Multi-component feature | Search with filtering and pagination |
| **XL** | 8+ | **Too large — break it down further** | — |

If a task is L or larger, it should be broken into smaller tasks. An agent performs best on S and M tasks.

**When to break a task down further:**
- It would take more than one focused session (roughly 2+ hours of agent work)
- You cannot describe the acceptance criteria in 3 or fewer bullet points
- It touches two or more independent subsystems (e.g., auth and billing)
- You find yourself writing "and" in the task title (a sign it is two tasks)

## Output Files

Plans follow the per-story layout in `../../references/work-artifacts.md`, which is built so several sessions can work one plan at once. Resolve the artifact root first as that reference describes; `docs/stories` below is the default:

- **Plan document:** Save the plan to `docs/stories/[story-id]/plan.md`. It holds the overview, decisions, risks, and an ordered task index. It never records task status, so it stays read-only while tasks are built.
- **Task list:** Record each task in the **task list target** (defined below).

Each story gets its own directory, so planning a new story never touches another story's plan.

**Never overwrite an incomplete plan.** Before writing into an existing `docs/stories/[story-id]/` directory, check whether any of its task files are not yet `done`:

- Same work being replanned (the user asked to revise or extend this plan) → update the plan in place. Keep existing task ids; add new tasks with the next free id; never edit a task file another session has claimed.
- Different work → **stop and ask.** Choose a different story id rather than reusing one. Do not delete, overwrite, or rename existing task files on your own.
- A legacy `tasks/plan.md` or `tasks/todo.md` from an earlier plan is left untouched; new plans go in `docs/stories/`.

The same rule applies to an external task list target: never bulk-close or delete another plan's open tracker items to make room for new ones.

### Task List Target

The task list target is where tasks and checkpoints are recorded. It is defined once, here; every other reference in this skill defers to it.

- **Default: one file per task** at `docs/stories/[story-id]/tasks/[task-id].md`, created with `status: pending`: the frontmatter below, then the Step 4 structure, then empty `## Design`, `## Summary`, `## Subtasks`, and `## Log` sections. One file per task means parallel sessions never write the same file. This is the convention the `/build` command expects; `../../references/work-artifacts.md` has the full lifecycle and claim protocol.
  ```
  ---
  id: t02-apply-event
  story: shipment-tracking
  status: pending        # pending | claimed | done | blocked
  depends_on: [t01-webhook-route]
  design_refs: [C3, C4]
  owner:
  ---
  ```
- **External tracker:** if the project's agent rules (`CLAUDE.md`, `AGENTS.md`, etc.) or the user designate an issue tracker (e.g. GitHub Issues, Jira, Linear, `bd`/beads), create one tracker item per task instead of writing task files. Map the Step 4 structure onto the tracker's fields: acceptance criteria and verification steps in the item body, dependencies via the tracker's linking mechanism (`bd dep add`, "blocked by", etc.). Record Step 5 checkpoints as tracker items too, or as a checklist in the plan document if the tracker has no natural equivalent.

When using an external tracker, note it in `docs/stories/[story-id]/plan.md` (e.g. "Tasks tracked in Linear project FOO") so downstream steps and future sessions know where to look, and keep the plan document's Task List section as an ordered index of tracker item IDs or links rather than a duplicate checklist.

## Plan Document Template

```markdown
# Implementation Plan: [Feature/Project Name]

## Overview
[One paragraph summary of what we're building]

## Architecture Decisions
- [Key decision 1 and rationale]
- [Key decision 2 and rationale]

## Task Index
Status lives in each task file, never here.

| Id | Task | Depends on | Design refs |
|----|------|------------|-------------|
| t01-... | ... | — | C1 |
| t02-... | ... | t01 | C1, C3 |
| t03-checkpoint-foundation | Checkpoint: tests pass, builds clean | t01, t02 | — |
| t04-... | ... | t03 | C2 |

## Risks and Mitigations
| Risk | Impact | Mitigation |
|------|--------|------------|
| [Risk] | [High/Med/Low] | [Strategy] |

## Open Questions
- [Question needing human input]
```

When tasks live in an external tracker, the Task Index lists tracker item IDs or links instead of task ids.

## Parallelization Opportunities

When multiple agents or sessions are available:

- **How:** each session claims a task using the protocol in `../../references/work-artifacts.md`, so two sessions never take the same task or write the same file. Within one session, `/build auto` fans independent tasks out to parallel builder subagents, following `../../references/model-routing.md`.
- **Safe to parallelize:** Independent feature slices, tests for already-implemented features, documentation
- **Must be sequential:** Database migrations, shared state changes, dependency chains
- **Needs coordination:** Features that share an API contract (define the contract first, then parallelize)

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll figure it out as I go" | That's how you end up with a tangled mess and rework. 10 minutes of planning saves hours. |
| "The tasks are obvious" | Write them down anyway. Explicit tasks surface hidden dependencies and forgotten edge cases. |
| "Planning is overhead" | Planning is the task. Implementation without a plan is just typing. |
| "I can hold it all in my head" | Context windows are finite. Written plans survive session boundaries and compaction. |
| "That story's plan is stale, I'll just replace it" | Its unfinished tasks may be mid-build in another session. Overwriting them destroys work state that exists nowhere else. Stop and ask. |
| "A single checklist is simpler than a file per task" | Until two sessions edit it at once. One file per task is what makes parallel work safe. |

## Red Flags

- Starting implementation without a written task list
- Overwriting a story's plan or task files that still have unfinished tasks for different work, without asking
- Recording task status in `docs/stories/[story-id]/plan.md` instead of the task files
- Writing task files when the project has designated an external tracker (or scattering tasks across both)
- Tasks that say "implement the feature" without acceptance criteria
- No verification steps in the plan
- All tasks are XL-sized
- No checkpoints between tasks
- Dependency order isn't considered

## Verification

Before starting implementation, confirm:

- [ ] Every task has acceptance criteria
- [ ] Every task has a verification step
- [ ] Task dependencies are identified and ordered correctly
- [ ] Tasks are recorded in the task list target (default: one `pending` file per task under `docs/stories/[story-id]/tasks/`)
- [ ] No pre-existing incomplete plan was overwritten without explicit user confirmation
- [ ] No task touches more than ~5 files
- [ ] Checkpoints exist between major phases
- [ ] The plan passed the approval gate: summary shown, `grill-me` frontier empty, explicit go-ahead

## See Also

Acceptance criteria are per-task and answer "did we build the right thing?". They sit on top of the project-wide Definition of Done, the standing bar every task clears before it counts as done. See `../../references/definition-of-done.md`.
