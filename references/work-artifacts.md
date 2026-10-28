# Work Artifacts and Parallel Sessions

Where specs, designs, plans, and task state live, and how several agent sessions work on one plan without overwriting each other. Skills and commands that read or write these files link here instead of restating the rules.

## The Problem This Solves

A single shared plan and checklist works for one session. With several sessions — each in its own worktree, or several in one checkout — a shared file breaks: two sessions pick the same "next todo" task, both edit the same checklist, and worktree copies of it diverge and conflict on merge.

The fix is to separate **artifacts** (decided once, then read) from **work state** (written continuously, one owner per file).

## Resolving the Store

Work state lives in one of two stores, and both use the same note format (see Task Note below):

- **Vault store:** the user's Obsidian vault, when one is configured. The vault is where the Obsidian project-manager plugin ("dotpm") shows stories and tasks as projects and tasks.
- **Repo store:** the repository itself, under `docs/stories` and `docs/epics` by default.

Resolve the store before reading or writing any artifact:

```
work_state root
```

`work_state` is a tool that the agent-skills plugin registers in omp (its extension `omp/index.ts`). Throughout these docs, `work_state <op> [args…]` means calling that tool with `op` set to the first word and `args` set to the rest, in order. Pass `cwd` to run it in another checkout, such as a task's worktree; it defaults to the session's directory, so run it from inside the project. When an op exits non-zero, the result ends with `exit: <code>`, and the exit codes named below (3, 4, 5, 6, 7) mean what they say. `root` prints `store` (`vault` or `repo`), `repo_root`, `stories_dir` and `epics_dir` (both absolute), `configured`, and `source`, plus `vault` (vault store only) and `notes` for anything it found. Everything below writes `[stories-dir]` and `[epics-dir]` for the printed directories; in the repo store with no config those are `docs/stories` and `docs/epics`.

The store resolves in this order:

1. `.agent-skills.json` at the repository root (committed, so every worktree reads the same file) with `"store": "vault" | "repo"` forces a store. `vault` without a configured vault is an error.
2. Otherwise the vault store, when the user-level config `${AGENT_SKILLS_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/agent-skills/config.json}` has a `vault` that exists: `{"vault": "/abs/vault/root"}`, optionally with `"projectsFolder"`. That file is per machine and never committed; the omp-starter knowledge-base step writes it.
3. Otherwise the repo store.

In the vault store, `[stories-dir]` is `<vault>/<projectsFolder>/<vaultFolder>/stories` and `[epics-dir]` is `…/epics`. `projectsFolder` comes from the user config, then the vault's project-manager plugin settings, then `Projects`. `vaultFolder` comes from `.agent-skills.json` (`"vaultFolder": "group/name"`) and defaults to the repo name (the basename of the main worktree, so every worktree of a repo maps to the same folder).

In the repo store, `.agent-skills.json` can also set `{"storiesDir": "…", "epicsDir": "…"}`. Without it, `docs/stories` or `docs/epics` is used when it exists (`source=detected`), otherwise the defaults (`source=default`). The notes list anything that looks like another convention: `specs/`, `docs/specs/`, `openspec/`, a legacy `tasks/plan.md`, or the older `tasks/` layout (run `work_state migrate` to convert it into the resolved store).

When `store=repo` and `configured=false`, **propose** a location to the user, using the notes (for example "this repo keeps specs in `specs/`; use `specs/stories`?"). Write the config only after they confirm, with `work_state configure <storiesDir> [epicsDir]`, and commit it. Never write it silently. With `store=vault` there is nothing to propose: the vault path comes from the user config.

Where the tool isn't available (a host other than omp, or a per-skill install), apply the same order by hand.

## Scopes and Commands

Every piece of work belongs to one scope, and each scope has one entry command. Every gate in these commands is the approval gate in `approval-gate.md`: a catch-up summary, `grill-me` rounds, and an explicit go-ahead before anything downstream starts. The command checks that the request fits its scope before it writes anything. Wrong-scope work is the most expensive mistake in the pipeline: an epic treated as a task skips design, and a task treated as an epic buries a one-line fix in process.

| Scope | Command | Owns | Hands off to |
|---|---|---|---|
| Epic / project | `/epic` | `[epics-dir]/[epic-id]/epic.md` (requirements, story map, and `## Architecture` with contract ids `E1…`; or `SPEC.md` for a whole product), `CONSTRAINTS.md`, architecture ADRs, story stubs | `/story` |
| Story | `/story` | `[stories-dir]/[story-id]/spec.md` with `## Design`, `plan.md`, task notes | `/task`, `/build`, or `/build auto` |
| Task / subtask | `/task` | One task note's `## Design`, `## Checklist`, `## Log`, and that task's code | The next task |

### Scope check

Decide the scope from these signals, in this order. A tracker's issue type, when one exists, is a hint, never the decider:

| Signal | Epic | Story | Task |
|---|---|---|---|
| Repo state | No `SPEC.md` or epic for this area yet | No story folder yet, or its phase is `spec`, `design`, or `plan` | A story with a plan exists, or the change needs no plan |
| Request shape | A product, a new system, several capabilities | One user-facing capability or feature | One change: a function, an endpoint, a fix, a config |
| Size | Capabilities that could ship separately | Several tasks, or tasks that share a contract (API, table, status field, event) | One focused session, changes no shared contract |
| Unknowns | Users, goals, or scope are unclear | Requirements are clear, design isn't | Requirements and design are clear |

If the signals point to a different scope from the command that was run, say so in one or two sentences with the evidence, recommend the right command, and continue only when the user confirms. A bug report belongs at task scope unless the fix changes a shared contract.

**Jev shadow check** (`../hooks/JEV-SHADOW.md`). Unless `bash [plugin-root]/hooks/jev.sh status` printed `enabled=false` earlier in this session, pipe the request text and the signals you gathered to `bash [plugin-root]/hooks/jev.sh scope -` before deciding. If it printed `jev=<id>`, run `jev.sh outcome <id> epic|story|task` once the scope is settled (the command the work continues under). Decide the scope from the signals above as if it hadn't run.

### Phase

`work_state phase [story-id]` reports where a story stands, so rerunning a command resumes instead of redoing work. A phase ends when its gate records `approve-phase` (`approval-gate.md`, "Record it"), and it holds only while the approved artifact is unchanged:

| Phase | Meaning | Next step |
|---|---|---|
| `none` | No story folder | Write the spec |
| `spec` | No `spec.md`, or its approval is missing or stale (the spec, outside `## Design`, changed since) | Write or revise the spec, pass its gate, `approve-phase [story-id] spec` |
| `design` | Spec approved; neither the design nor the plan is approved (missing or stale) | High-level design, its gate, `approve-phase [story-id] design`. A story that needs no design records the skip with the same command and no `## Design` written. |
| `plan` | Plan not approved: no `plan.md` or task notes yet, or either changed since approval | Plan the tasks, pass the gate, `approve-phase [story-id] plan` |
| `build` | Plan approved, some task isn't complete (`open_tasks=N`; a task in `review` is still open) | `/build`, `/task`, or `/build auto` |
| `done` | Plan approved, every task is complete (`done` or `cancelled`) | Review the story as a whole, then ship |

An approved plan keeps a story in `build` when the design is edited later: its tasks re-gate on the contracts they cite instead. Editing the spec or the plan, or adding a task note, voids that approval and returns the story to `spec` or `plan` until its gate runs again (see Re-planning and Splitting).

For a planned story (a spec, a plan, and task notes) that predates recorded approvals, `phase` reports `spec` and also prints `approvals=missing run: work_state adopt-approvals [story-id]`. It never approves by itself: run that command once, after the user confirms the story's earlier gates passed (`approval-gate.md`).

## Layout

The layout is the same in both stores:

```
[epics-dir]/[epic-id]/
  [epic-id].md        Project note, created by `init-epic` (dotpm shows it as a project)
  epic.md             Product requirements, the story map (ordered stories with rough acceptance criteria), and `## Architecture` (contract ids `E1…`)
  summary.md

[stories-dir]/[story-id]/
  [story-id].md       Project note, created by `init-story`; its `parent` links the epic; its frontmatter holds the phase approvals
  spec.md             Requirements with FR/NFR ids, plus `## Design` from high-level-design (contract ids `C1…`)
  plan.md             Task index: ids, titles, order, dependencies, design refs. Never status.
  summary.md
  _tasks/
    [task-id].md      One task note per task, created by `new-task`
```

- **`story-id`** — kebab-case, chosen once and never renamed. Use the tracker key when one exists (`pac2-8120`), otherwise a short slug (`shipment-tracking`).
- **`task-id`** — the file name of the task note: the slug of its title. Titles start with the plan number (`T02 Apply event`), so ids read `t01`, `t02`, … in plan order plus a slug: `t02-apply-event`. `new-task` derives the id from the title, which it stores without punctuation so that dotpm keeps the id (see Obsidian (dotpm) Compatibility). Ids are never reused or renumbered after the plan is approved; a task added later takes the next free number.
- **Project notes** (`[story-id].md`, `[epic-id].md`) hold no content. The Obsidian plugin rewrites their body whenever it saves them, so requirements, designs and plans stay in `epic.md`, `spec.md` and `plan.md`. A story's project note keeps its phase approvals (`spec_approved`, `design_approved`, `plan_approved`) in its frontmatter.
- **Contract ids** — a story's shared contracts carry ids `C1…` in its `## Design`. An epic's architecture lives in `epic.md` under `## Architecture`, with ids `E1…` for what several stories share. A task cites either in `design_refs` (`C1, E2`); `brief` and the task's approval read an `E` id from the epic that the story project note's `parent` links.
- **Epics** are optional. A story belongs to an epic when its project note's `parent` links it, set by `init-story [story-id] "[title]" [epic-id]`.
- A project-level spec (the whole product, or a capability map with module specs) stays at `SPEC.md` in the project root. Stories reference it; they don't copy it.
- If the project designates another spec location or an external spec tool, that location replaces `[stories-dir]`; the one-note-per-task rule still applies.

## Who Writes What

| File | Written by | When | Concurrency rule |
|---|---|---|---|
| `spec.md` | `spec-driven-development`, `high-level-design` | Before approval, or when a design change is escalated | Read-only while tasks are being built |
| `plan.md` | `planning-and-task-breakdown` | Before approval, or on a re-plan | Read-only while tasks are being built. Task status is **never** recorded here. |
| `[story-id].md`, `[epic-id].md` | `work_state` (`init-story`, `init-epic`, `new-task`, `set`, `approve-phase`, `adopt-approvals`) | Planning, gates, then status changes | Scripted only. Never edited by hand. |
| `_tasks/[task-id].md` | The session that claimed the task | While building | Exactly one writer: the claim owner |

No hand-maintained checklist exists. Progress is read from the task notes' `status` fields.

Within a task note, two kinds of writes never mix:

- **Frontmatter** (status, progress, dependencies, `design_refs`, `branch`, `design_approved`) changes only through `work_state`: `new-task`, `field`, `set`, `claim`, `approve`. Never edit it by hand, because these commands keep progress, timestamps, and the project note's task list consistent.
- **Body sections** (the task description above `## Design`, `## Design`, `## Summary`, and the `## Checklist` ticks) are written with ordinary file-edit tools, at the path `work_state path [story-id] [task-id]` prints. `## Log` lines are added with `work_state log`.

## Task Note

The task note is created only by `work_state new-task [story-id] "[title]" [dep-id…]`, which prints `task=[task-id]` and `path=<absolute path>`. It fails when the story's project note doesn't exist (run `init-story` first) or the id is taken. It stores the title as letters and digits separated by single spaces (`T04 Fix: a/b` becomes `T04 Fix a b`), so the title and the id name the same file.

```markdown
---
pm-task: true
projectId: "[[shipment-tracking|Shipment tracking]]"
parentId:
id: <generated>
title: "T02 Apply event"
type: task
status: todo             # todo | in-progress | blocked | review | done | cancelled
priority: medium
start: ""
due: ""
progress: 0              # 100 when done, else % of ## Checklist ticked
assignees: []
tags:
  - story/shipment-tracking
subtaskIds: []
dependencies:
  - "[[t01-webhook-route|T01 Webhook route]]"
createdAt: 2026-10-04T10:00:00.000Z
updatedAt: 2026-10-04T10:00:00.000Z
customFields:
  design_refs: C3, C4
  branch: feat-x         # set by claim: the claimer's work branch
  design_approved: 2026-10-04T10:00Z 1a2b3c4d5e6f
---

<task description: the Step 4 structure from planning-and-task-breakdown
 (description, acceptance criteria, verification, files, scope), above ## Design>

## Design

## Summary

## Checklist

## Log

Project: [[shipment-tracking|Shipment tracking]]
```

- **Status:** `todo | in-progress | blocked | review | done | cancelled`. A task is **complete** when it is `done` or `cancelled`. `review` means built and waiting for review; it is not complete, so `next` and `phase` treat the task as open and its dependents keep waiting. The builder sets `review` when the acceptance criteria pass, and the orchestrator sets `done` after the review passes (see Finishing). `completed: YYYY-MM-DD` appears only on complete tasks.
- **`dependencies`** lists the task ids this task waits for; `next` starts a task only when all of them are complete.
- **`customFields`** holds the agent-only data: `design_refs` (the shared contract ids the task cites: `C3, C4` from the story's design, `E1` from its epic's `## Architecture`), `branch` (the claim's work branch), and `design_approved` (written by `approve`; the fingerprint covers the description above `## Design`, the `## Design` section, `design_refs`, and the blocks that define each cited contract, so editing any of them voids the approval; `work_state cites [story-id] [contract-id]` lists the tasks that cite a contract).
- **`title`** is the single source of the file name, so never edit it by hand.
- **`## Checklist`** is an optional list the owner ticks while building (`- [ ] adapter`, `- [x] schema`); `progress` follows the ticked share. **`## Log`** holds one line per meaningful step or decision, the user's answers at an `ask` included: `- YYYY-MM-DD what changed or was decided, what's next`. Add lines with `work_state log`, and always one before stopping for any reason, so the next session can pick up from it. This is the one logging rule; commands and agents follow it.
- The trailing `Project: [[…]]` line belongs to the Obsidian plugin; keep it.

`planning-and-task-breakdown` creates every task note with `new-task` when the plan is written, and inserts the Step 4 structure as the body above `## Design`. `low-level-design` fills `## Design`. The builder moves state with `claim`, `log`, and `set` (up to `review`), ticks `## Checklist`, and logs as above.

## Re-planning and Splitting

A plan changes after approval: a task turns out too big, or work appears that nobody planned. Task ids are never reused and the plan is never changed behind the user's back, so the change goes through the plan gate again:

1. **Retire the old task.** For a task that has to be split or dropped (never one another session has claimed: its owner, or `/resume`, closes the claim first), run `work_state set [story-id] [task-id] cancelled`, then `work_state log [story-id] [task-id] "split into t07-…, t08-…: [reason]"`. The note stays, so the id is never reused, and a cancelled task is complete, so it blocks nothing.
2. **Add the new tasks.** `work_state new-task [story-id] "T07 [title]" [dependency-task-id…]`, with the next free T number (one past the highest in the story, cancelled tasks included), then `work_state field … design_refs` and the description above `## Design`, as when the plan was written. A task that depended on the retired one now counts it complete and could start early. If it must wait for the replacements, retire it the same way and recreate it with the replacements as its dependencies.
3. **Update the plan.** Edit `plan.md` in place: the new rows in order, and `split into t07, t08` (or nothing, when dropped) on the old row.
4. **Run the plan gate again.** A new task note changes the plan's fingerprint, so `phase` is `plan` until the gate passes: catch-up summary (what was split and why), `grill-me` rounds over what is still open, the user's go-ahead, then `work_state approve-phase [story-id] plan`. Each new task still passes its own design gate before it is built. In the repo store, commit `plan.md`, the new task notes, and the story's project note so every worktree sees them before anyone claims a new task.

## Claim Protocol

A claim is a **lock ref**, `claim/[story-id]/[task-id]`, pointing at a unique commit with no parent and no files, whose message records the claimer's work branch. It carries no history, so publishing it never uploads local commits. The lock is separate from the branch the work happens on. That keeps it valid whether sessions share one checkout or use a worktree each, and a feature branch named after the story (`pac2-8120`) can't collide with it. `work_state` does the git work:

| Step | Command | What it does |
|---|---|---|
| Pick | `work_state next [story-id]` | Fetches with `--prune`, then prints the first `todo` task with no claim whose dependencies are complete. In the repo store, "complete" is checked **in this checkout** (merged here, not just finished on another branch). In the vault store, a dependency counts once it is complete and its claim is gone: a released lock means merged. Exit 4 means nothing is claimable. |
| Pick for a wave | `work_state ready [story-id]` | Fetches, then prints one `story/task` per line, in plan order, for every task that can start now: `todo` with no claim, `approved` exits 0, every dependency complete (as `next` counts it), and no file shared with a running task or with a task printed above it. Exit 4 means none. The rules are below. |
| Claim | `work_state claim [story-id] [task-id] [work-branch]` | Creates the lock with `git update-ref <ref> <commit> ""`, which fails if it already exists. With a remote, it pushes with an empty `--force-with-lease`, so the push fails if another machine holds the lock, even one this machine couldn't see. Exit 3 means another session won; pick again. Exit 5 means the lock couldn't be published. Once the lock is held, it sets `status: in-progress` and `branch` to the work branch, which defaults to the current branch. In the repo store, when the work branch has no checkout yet, it leaves the note alone (the edit would sit in this checkout, in the way of the merge) and prints the `work_state set [story-id] [task-id] in-progress` command to run from the new worktree; that also records the branch. |
| Release | `work_state release [story-id] [task-id]` | Deletes the lock locally and on the remote. The status is unchanged. |

Before picking, bring the base branch up to date (`git pull --ff-only`) so tasks finished and merged elsewhere show as complete.

**Starting several tasks at once.** A wave is claimed from the output of `work_state ready`, not by eyeballing which tasks look independent:

- A task is *running* when it has a claim (held here or on another machine) or its status is `in-progress`, `review`, or `blocked`. A `done` task still holds its files while its lock is held, because releasing the lock means its work is merged.
- Take tasks from the top of the list, up to the wave cap: 3 running builders by default, never more than 5 (`model-routing.md`). Every listed task is clear of every other, so any prefix of the list is safe. Claim each with the Claim step above, and create its worktree only after the claim succeeds.
- A task `ready` holds back is reported on stderr, not stdout: `skipped: [story-id]/[task-id] overlaps [story-id]/[other-task] (running|ready) on <file>`, or `on shared output <pattern> (<file>, <file>)`. It isn't lost: `ready` lists it again once the other task is merged and its lock released. A listed task whose note names no files gets `note: [story-id]/[task-id] lists no files, so its overlap with other tasks is unchecked`.
- A task's files are the paths in the `Files likely touched` list of its description (the Step 4 structure, above `## Design`) and the backticked paths in `## Design` that read as files (`src/a.ts`, `src/dir/`, `e2e/*`; not `router.query`). So write every file the task creates or changes, one backticked path per item, generated files and lockfiles included.
- Paths are compared as written, after a leading `./` is dropped. Two overlap when they are equal, when one is the tail of the other at a `/` (`user.gql` and `graphql/types/user.gql`), when one is a directory (`src/auth/`, or any path with no extension) that holds the other, or when one is a glob (`e2e/*`) that matches the other or both are globs that could match one file.
- Shared outputs overlap whatever their paths: two tasks that each touch a file matching one of `*.lock`, `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `bun.lockb`, `go.sum`, `schema.sql`, `structure.sql`, `schema.rb`, or `*querier.go` can't run together, because either one rewrites it. The list is `SHARED_OUTPUTS` in `omp/work-state.ts`.
- The check reads only what the notes say. A file a task changes without naming it surfaces at the merge, and a merge conflict stops the run for the user.

**Working the task:**

- *Worktree per task:* `git worktree add -b [work-branch] ../[repo]-[task-id]`, claim with that work branch, and build there.
- *Same checkout:* claim with the current branch and build in place. Other sessions share this checkout's git index, so commit only your own paths: `git commit -- <code paths>`, plus the task note in the repo store (`git commit -- <task note> <code paths>`). Get the note's path from `work_state path [story-id] [task-id]`.
- `claim` has already set `in-progress` and the branch, unless it printed a `set … in-progress` command for a worktree that didn't exist yet: run that from the worktree. Don't set them again. Tick `## Checklist` and log by the `## Log` rule above.
- Where the store is the repo, a claimed task's note is read and written in the work branch's worktree first (it's the freshest copy). The vault store has a single copy, shared by every worktree.

**Finishing:** the builder runs `work_state set [story-id] [task-id] review` when the acceptance criteria pass, then commits the task's code (repo store: with the task note; vault store: the note isn't in git, so there's nothing more to commit for it). `review` is not completion: `next` and `phase` still count the task as open and its dependents keep waiting. The orchestrator (or you, without subagents) reviews the diff against the approved design note. Critical or Important findings go back to a builder and the task returns to `in-progress` (`work_state set … in-progress`) until it is in `review` again. When the review passes, run `work_state set [story-id] [task-id] done`; in the repo store, commit the task note (`git commit -- <task note>`) so `done` travels with the work branch. Release the lock once the work is on the base branch, which is where `next` looks:
- *Committed on the base branch* (same checkout, no separate branch): release right after the commit.
- *Committed on a work branch* (a worktree, or a branch in the same checkout): release after that branch is merged into the base branch. A lock released earlier lets another session take the task again. Until then, `status` shows the task as done but "not yet merged", and `next` doesn't treat it as a finished dependency.

The vault store has no git history for task notes, so `done` is visible there the moment it's set, from every branch. That is why `next` there also requires the lock to be released before it counts a dependency as finished.

**Blocked:** run `work_state set [story-id] [task-id] blocked` and `work_state log [story-id] [task-id] "[reason]"`, and keep the lock. The task shows as `[!]` until someone unblocks it or explicitly releases it. Releasing a blocked task never deletes its work branch.

**Continuing after a crash:** a claim whose work branch is the current branch belongs to this checkout, so continue it. Otherwise use `/resume`, and adopt a claimed task only when the user confirms that its previous session is gone. Never claim a task again.

**Lock refs are real branches** (`claim/*`). CI pipelines triggered on every push and branch-naming rules see them too. Exclude them from CI triggers (for GitHub Actions: `branches-ignore: ['claim/**']`) and allow the `claim/` prefix in branch rules.

**Without the tool** (a host other than omp, or a per-skill install), run the same git commands by hand:
```
git fetch --prune
c=$(git commit-tree "$(git mktree </dev/null)" -m "claim [story-id]/[task-id] work=[work-branch]")
git update-ref refs/heads/claim/[story-id]/[task-id] "$c" ""      # fails → taken
git push --force-with-lease=refs/heads/claim/[story-id]/[task-id]: origin refs/heads/claim/[story-id]/[task-id]   # fails → taken; delete the local ref
```
If the project isn't a git repository, there is no lock: re-read the task note immediately before claiming, skip any task whose `status` isn't `todo`, then run `work_state set [story-id] [task-id] in-progress` and `work_state field [story-id] [task-id] branch [session-name]`. This fallback is not race-free, so parallel sessions need git.

## Viewing Progress

```
work_state status [story-id]
```

prints the ticked tree, grouped as epics → stories → tasks:

```
[~] epic payments  1/2 stories
  [x] story refunds  1/1 tasks
    [x] t01-refund
  [~] story payouts  1/3 tasks
    [x] t01-model
    [~] t02-transfer claimed: claim/payouts/t02-transfer · work feat-transfer · checklist 2/3 · worktree ../app-t02 · last log: wrote adapter, next: retries
    [ ] t03-retry
```

`[x]` done or cancelled · `[~]` in progress, in review, or claimed · `[ ]` todo · `[!]` blocked. The view is generated on demand and never committed. The truth stays in the task notes and claim locks, so a tree nobody edits can't conflict. For a claimed task in the repo store, the script reads the task note from the freshest place: the work branch's worktree (uncommitted edits included), then the work branch, then the current checkout. The vault store has one copy.

## Resuming After a Session Ends

A closed or crashed session loses its conversation, not its state. Everything needed to resume is in the task notes, claim locks, work branches, and worktrees. `/resume [story-id]` recovers it:

1. Resolve the store.
2. Hand the investigation to a fresh-context, **read-only** subagent (or, on hosts without subagents, do it yourself without editing anything). It:
   - runs `work_state status` for the story (or all stories)
   - for each in-progress or blocked task: reads its task note (acceptance, `## Design`, `## Checklist`, `## Log`) at the path `work_state path` prints, or in the worktree `status` shows (repo store only: otherwise `git show <work-branch>:<path>`). In its worktree or work branch it checks `git status` and `git log -1` for uncommitted work and the last commit, comparing ticked boxes against the code actually present
   - checks which acceptance criteria and checklist items are ticked, and whether the last log line names a next step
   - returns the ticked tree, where each in-progress task stopped, and the recommended next action
3. Show the result to the user and confirm the next action before continuing. Continuing a claimed task means working on its recorded work branch or worktree, not claiming again.

A new omp session also gets a one-line hint at startup when claims exist, naming the ones whose work branch is the current checkout (the plugin extension runs `work_state hint` on session start, local refs only so startup stays fast and offline). It suggests `/resume`; it never runs it.

A session can also be ended on purpose. At a story gate or after a build wave, the orchestrator logs what is next and recommends a fresh session; `/resume`, `/story`, or `/build` picks up from the files above (`model-routing.md`, "Fresh Orchestrator at Boundaries").

## Obsidian (dotpm) Compatibility

The notes follow the format of the Obsidian project-manager plugin ("dotpm"), so a vault shows stories as projects and tasks as tasks. A few of its behaviors shape the rules above:

- **Regenerated bodies.** On save, dotpm rewrites a project note's body (heading, description, `## Tasks`) and deletes everything in a task note from a `## Subtasks` heading to the end, regenerating it from child notes. So project notes carry no content, and task notes use `## Checklist`, never `## Subtasks`.
- **Title ↔ file name.** dotpm names a task note from its title (lowercase; `\ / : * ? " < > |` and whitespace become `-`; at most 60 characters). When a saved task's title no longer gives its file's name, dotpm creates a note under its own name and trashes the old one, which silently changes the task id. So `new-task` stores the title as letters and digits separated by single spaces (accents are transliterated first when `iconv` is available) and cuts it at 60 characters: `T04 Fix: a/b, (x)` is stored as `T04 Fix a b x`, which dotpm names `t04-fix-a-b-x`, the task id. Ids use only `a-z`, `0-9`, and single dashes, so herdr web links their paths. Never edit a `title` by hand.
- **Statuses.** `todo`, `in-progress`, `blocked`, `review`, `done`, `cancelled`; complete means `done` or `cancelled`.
- **No git history in a vault.** A vault store's task notes aren't in the repository, so there is no merged-branch signal for them. `next` relies on released locks instead: a dependency counts only when it is complete and its claim is gone.
- **Custom fields.** `design_refs`, `branch`, and `design_approved` live in a task's `customFields`; the story's project note declares them so dotpm displays them. A story's phase approvals are plain top-level keys of its project note instead: there `customFields` is dotpm's list of field definitions, not a map, and dotpm keeps frontmatter keys it doesn't know.
- **Links.** In the vault store every wikilink (`projectId`, `dependencies`, `parent`, `taskIds`, `## Tasks`, the footer) uses the note's vault path, such as `[[Projects/app/stories/shipment-tracking/_tasks/t01-webhook-route|T01 webhook route]]`, because ids like `t01-*` repeat across stories and repositories in one vault. The repo store uses bare names, as in the template above. `work_state` writes every link; the task id is always the last path segment.

## External Trackers

When the project designates an issue tracker, each task is a tracker item instead of a task note, and the claim is the tracker's assignment. Assigning the item to yourself replaces the claim steps, and the tracker's own status replaces `set` and `log`. `plan.md` keeps the ordered list of item ids or links.

Approvals live in the tracker item too. `approve`, `approved`, and `approve-phase … plan` read task notes, so they can't be used for tracked tasks (and `phase` stays at `plan`, because it counts task notes). The gate still runs for every task. Record the user's go-ahead as a comment on the tracker item only when the user asked for tracker comments; otherwise record it in `plan.md`, as a line beside the task's row (`approved YYYY-MM-DD: [task-id] design`). Build only an item whose design is recorded that way, and run the gate again when the design changes. The story's spec and design gates are unaffected: its project note still holds `approve-phase [story-id] spec` and `design`.

## Legacy Layout

A repository that already has `tasks/plan.md` and `tasks/todo.md` from an earlier plan keeps working: finish or discard that plan in the old single-file layout, since it is not safe for parallel sessions. New plans use `[stories-dir]` (`docs/stories/` in the repo store by default). A repository whose stories use `[stories-dir]/[story-id]/tasks/*.md` is converted with `work_state migrate [story-id]`. With the vault store, `migrate` also moves stories and epics still in the repository into the vault, rewriting their links to vault paths. In either store it skips a story with live claims: finish or release them first.
