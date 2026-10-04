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
bash [plugin-root]/hooks/work-state.sh root
```

`hooks/work-state.sh` ships with the agent-skills plugin: it sits at the plugin root, next to this `references/` directory (`${CLAUDE_PLUGIN_ROOT}/hooks/work-state.sh` in Claude Code), not in your project. Run it from inside the project. It prints `store` (`vault` or `repo`), `repo_root`, `stories_dir` and `epics_dir` (both absolute), `configured`, and `source`, plus `vault` (vault store only) and `notes` for anything it found. Everything below writes `[stories-dir]` and `[epics-dir]` for the printed directories; in the repo store with no config those are `docs/stories` and `docs/epics`.

The store resolves in this order:

1. `.agent-skills.json` at the repository root (committed, so every worktree reads the same file) with `"store": "vault" | "repo"` forces a store. `vault` without a configured vault is an error.
2. Otherwise the vault store, when the user-level config `${AGENT_SKILLS_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/agent-skills/config.json}` has a `vault` that exists: `{"vault": "/abs/vault/root"}`, optionally with `"projectsFolder"`. That file is per machine and never committed; the omp-starter knowledge-base step writes it.
3. Otherwise the repo store.

In the vault store, `[stories-dir]` is `<vault>/<projectsFolder>/<vaultFolder>/stories` and `[epics-dir]` is `…/epics`. `projectsFolder` comes from the user config, then the vault's project-manager plugin settings, then `Projects`. `vaultFolder` comes from `.agent-skills.json` (`"vaultFolder": "group/name"`) and defaults to the repo name (the basename of the main worktree, so every worktree of a repo maps to the same folder).

In the repo store, `.agent-skills.json` can also set `{"storiesDir": "…", "epicsDir": "…"}`. Without it, `docs/stories` or `docs/epics` is used when it exists (`source=detected`), otherwise the defaults (`source=default`). The notes list anything that looks like another convention: `specs/`, `docs/specs/`, `openspec/`, a legacy `tasks/plan.md`, or the older `tasks/` layout (run `work-state.sh migrate` to convert it into the resolved store).

When `store=repo` and `configured=false`, **propose** a location to the user, using the notes (for example "this repo keeps specs in `specs/`; use `specs/stories`?"). Write the config only after they confirm, with `bash [plugin-root]/hooks/work-state.sh configure <storiesDir> [epicsDir]`, and commit it. Never write it silently. With `store=vault` there is nothing to propose: the vault path comes from the user config.

Where the script isn't available (another agent host, or a per-skill install), apply the same order by hand.

## Scopes and Commands

Every piece of work belongs to one scope, and each scope has one entry command. Every gate in these commands is the approval gate in `approval-gate.md`: a catch-up summary, `grill-me` rounds, and an explicit go-ahead before anything downstream starts. The command checks that the request fits its scope before it writes anything. Wrong-scope work is the most expensive mistake in the pipeline: an epic treated as a task skips design, and a task treated as an epic buries a one-line fix in process.

| Scope | Command | Owns | Hands off to |
|---|---|---|---|
| Epic / project | `/epic` | `[epics-dir]/[epic-id]/epic.md` (or `SPEC.md` for a whole product), `CONSTRAINTS.md`, architecture ADRs, story stubs | `/story` |
| Story | `/story` | `[stories-dir]/[story-id]/spec.md` with `## Design`, `plan.md`, task notes | `/task` or `/build auto` |
| Task / subtask | `/task` | One task note's `## Design`, `## Checklist`, `## Log`, and that task's code | The next task |

### Scope check

Decide the scope from these signals, in this order. A tracker's issue type, when one exists, is a hint, never the decider:

| Signal | Epic | Story | Task |
|---|---|---|---|
| Repo state | No `SPEC.md` or epic for this area yet | No story folder yet, or its phase is `spec`, `design`, or `plan` | A story with a plan exists, or the change needs no plan |
| Request shape | A product, a new system, several capabilities | One user-facing capability or feature | One change: a function, an endpoint, a fix, a config |
| Size | Capabilities that could ship separately | Several tasks, or tasks that share a contract (API, table, status field, event) | One focused session, touches no shared contract |
| Unknowns | Users, goals, or scope are unclear | Requirements are clear, design isn't | Requirements and design are clear |

If the signals point to a different scope from the command that was run, say so in one or two sentences with the evidence, recommend the right command, and continue only when the user confirms. A bug report belongs at task scope unless the fix changes a shared contract.

### Phase

`work-state.sh phase [story-id]` reports where a story stands, so rerunning a command resumes instead of redoing work:

| Phase | Meaning | Next step |
|---|---|---|
| `none` | No story folder | Write the spec |
| `spec` | Folder without `spec.md` | Write the spec |
| `design` | Spec without a `## Design` section, and no plan yet | High-level design. A story that already has a plan is past this phase: small stories may skip it. |
| `plan` | No `plan.md`, or no task notes | Plan the tasks |
| `build` | Some task isn't complete (`open_tasks=N`) | `/task` or `/build auto` |
| `done` | Every task is complete (`done` or `cancelled`) | Review the story as a whole, then ship |

## Layout

The layout is the same in both stores:

```
[epics-dir]/[epic-id]/
  [epic-id].md        Project note, created by `init-epic` (dotpm shows it as a project)
  epic.md             Product requirements and the story map: ordered stories with rough acceptance criteria
  summary.md

[stories-dir]/[story-id]/
  [story-id].md       Project note, created by `init-story`; its `parent` links the epic
  spec.md             Requirements with FR/NFR ids, plus `## Design` from high-level-design
  plan.md             Task index: ids, titles, order, dependencies, design refs. Never status.
  summary.md
  _tasks/
    [task-id].md      One task note per task, created by `new-task`
```

- **`story-id`** — kebab-case, chosen once and never renamed. Use the tracker key when one exists (`pac2-8120`), otherwise a short slug (`shipment-tracking`).
- **`task-id`** — the file name of the task note: the slug of its title. Titles start with the plan number (`T02 Apply event`), so ids read `t01`, `t02`, … in plan order plus a slug: `t02-apply-event`. `new-task` derives the id from the title. Ids are never reused or renumbered after the plan is approved; a task added later takes the next free number.
- **Project notes** (`[story-id].md`, `[epic-id].md`) hold no content. The Obsidian plugin rewrites their body whenever it saves them, so requirements, designs and plans stay in `epic.md`, `spec.md` and `plan.md`.
- **Epics** are optional. A story belongs to an epic when its project note's `parent` links it, set by `init-story [story-id] "[title]" [epic-id]`.
- A project-level spec (the whole product, or a capability map with module specs) stays at `SPEC.md` in the project root. Stories reference it; they don't copy it.
- If the project designates another spec location or an external spec tool, that location replaces `[stories-dir]`; the one-note-per-task rule still applies.

## Who Writes What

| File | Written by | When | Concurrency rule |
|---|---|---|---|
| `spec.md` | `spec-driven-development`, `high-level-design` | Before approval, or when a design change is escalated | Read-only while tasks are being built |
| `plan.md` | `planning-and-task-breakdown` | Before approval, or on a re-plan | Read-only while tasks are being built. Task status is **never** recorded here. |
| `[story-id].md`, `[epic-id].md` | `work-state.sh` (`init-story`, `init-epic`, `new-task`, `set`) | Planning, then status changes | Scripted only. Never edited by hand. |
| `_tasks/[task-id].md` | The session that claimed the task | While building | Exactly one writer: the claim owner |

No hand-maintained checklist exists. Progress is read from the task notes' `status` fields.

Within a task note, two kinds of writes never mix:

- **Frontmatter** (status, progress, dependencies, `design_refs`, `branch`, `design_approved`) changes only through `work-state.sh`: `new-task`, `field`, `set`, `claim`, `approve`. Never edit it by hand, because these commands keep progress, timestamps, and the project note's task list consistent.
- **Body sections** (the task description above `## Design`, `## Design`, `## Summary`, and the `## Checklist` ticks) are written with ordinary file-edit tools, at the path `work-state.sh path [story-id] [task-id]` prints. `## Log` lines are added with `work-state.sh log`.

## Task Note

The task note is created only by `work-state.sh new-task [story-id] "[title]" [dep-id…]`, which prints `task=[task-id]` and `path=<absolute path>`. It fails when the story's project note doesn't exist (run `init-story` first) or the id is taken.

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

- **Status:** `todo | in-progress | blocked | review | done | cancelled`. A task is **complete** when it is `done` or `cancelled`. `review` means finished and waiting for review; it is not complete. `completed: YYYY-MM-DD` appears only on complete tasks.
- **`dependencies`** lists the task ids this task waits for; `next` starts a task only when all of them are complete.
- **`customFields`** holds the agent-only data: `design_refs` (shared contract ids from the design, e.g. `C3, C4`), `branch` (the claim's work branch), and `design_approved` (written by `approve`; the fingerprint covers `## Design` only).
- **`title`** is the single source of the file name, so never edit it by hand.
- **`## Checklist`** is an optional list the owner ticks while building (`- [ ] adapter`, `- [x] schema`); `progress` follows the ticked share. **`## Log`** holds one line per session: `- YYYY-MM-DD what changed, what's next`. Add lines with `work-state.sh log`.
- The trailing `Project: [[…]]` line belongs to the Obsidian plugin; keep it.

`planning-and-task-breakdown` creates every task note with `new-task` when the plan is written, and inserts the Step 4 structure as the body above `## Design`. `low-level-design` fills `## Design`. The builder moves state with `claim`, `log`, and `set`, ticks `## Checklist`, and writes a log line before stopping for any reason, so the next session can pick up from it.

## Claim Protocol

A claim is a **lock ref**, `claim/[story-id]/[task-id]`, pointing at a unique empty commit whose message records the claimer's work branch. The lock is separate from the branch the work happens on. That keeps it valid whether sessions share one checkout or use a worktree each, and a feature branch named after the story (`pac2-8120`) can't collide with it. `work-state.sh` does the git work:

| Step | Command | What it does |
|---|---|---|
| Pick | `work-state.sh next [story-id]` | Fetches with `--prune`, then prints the first `todo` task with no claim whose dependencies are complete. In the repo store, "complete" is checked **in this checkout** (merged here, not just finished on another branch). In the vault store, a dependency counts once it is complete and its claim is gone: a released lock means merged. Exit 4 means nothing is claimable. |
| Claim | `work-state.sh claim [story-id] [task-id] [work-branch]` | Creates the lock with `git update-ref <ref> <commit> ""`, which fails if it already exists. With a remote, it pushes with an empty `--force-with-lease`, so the push fails if another machine holds the lock, even one this machine couldn't see. Exit 3 means another session won; pick again. Exit 5 means the lock couldn't be published. Once the lock is held, it sets `status: in-progress` and `branch` to the work branch, which defaults to the current branch. In the repo store, when the work branch has no checkout yet, it leaves the note alone (the edit would sit in this checkout, in the way of the merge) and prints the `work-state.sh set [story-id] [task-id] in-progress` command to run from the new worktree; that also records the branch. |
| Release | `work-state.sh release [story-id] [task-id]` | Deletes the lock locally and on the remote. The status is unchanged. |

Before picking, bring the base branch up to date (`git pull --ff-only`) so tasks finished and merged elsewhere show as complete.

**Working the task:**

- *Worktree per task:* `git worktree add -b [work-branch] ../[repo]-[task-id]`, claim with that work branch, and build there.
- *Same checkout:* claim with the current branch and build in place. Other sessions share this checkout's git index, so commit only your own paths: `git commit -- <code paths>`, plus the task note in the repo store (`git commit -- <task note> <code paths>`). Get the note's path from `work-state.sh path [story-id] [task-id]`.
- `claim` has already set `in-progress` and the branch, unless it printed a `set … in-progress` command for a worktree that didn't exist yet: run that from the worktree. Don't set them again. Tick `## Checklist` and add `work-state.sh log` lines as you go, and always before stopping.
- Where the store is the repo, a claimed task's note is read and written in the work branch's worktree first (it's the freshest copy). The vault store has a single copy, shared by every worktree.

**Finishing:** run `work-state.sh set [story-id] [task-id] done`, then commit the task's code (repo store: with the task note; vault store: the note isn't in git, so there's nothing more to commit for it). Release the lock once the work is on the base branch, which is where `next` looks:
- *Committed on the base branch* (same checkout, no separate branch): release right after the commit.
- *Committed on a work branch* (a worktree, or a branch in the same checkout): release after that branch is merged into the base branch. A lock released earlier lets another session take the task again. Until then, `status` shows the task as done but "not yet merged", and `next` doesn't treat it as a finished dependency.

The vault store has no git history for task notes, so `done` is visible there the moment it's set, from every branch. That is why `next` there also requires the lock to be released before it counts a dependency as finished.

**Blocked:** run `work-state.sh set [story-id] [task-id] blocked` and `work-state.sh log [story-id] [task-id] "[reason]"`, and keep the lock. The task shows as `[!]` until someone unblocks it or explicitly releases it. Releasing a blocked task never deletes its work branch.

**Continuing after a crash:** a claim whose work branch is the current branch belongs to this checkout, so continue it. Otherwise use `/resume`, and adopt a claimed task only when the user confirms that its previous session is gone. Never claim a task again.

**Lock refs are real branches** (`claim/*`). CI pipelines triggered on every push and branch-naming rules see them too. Exclude them from CI triggers (for GitHub Actions: `branches-ignore: ['claim/**']`) and allow the `claim/` prefix in branch rules.

**Without the script** (another agent host, or a per-skill install), run the same git commands by hand:
```
git fetch --prune
c=$(git commit-tree "$(git rev-parse 'HEAD^{tree}')" -p HEAD -m "claim [story-id]/[task-id] work=[work-branch]")
git update-ref refs/heads/claim/[story-id]/[task-id] "$c" ""      # fails → taken
git push --force-with-lease=refs/heads/claim/[story-id]/[task-id]: origin refs/heads/claim/[story-id]/[task-id]   # fails → taken; delete the local ref
```
If the project isn't a git repository, there is no lock: re-read the task note immediately before claiming, skip any task whose `status` isn't `todo`, then run `work-state.sh set [story-id] [task-id] in-progress` and `work-state.sh field [story-id] [task-id] branch [session-name]`. This fallback is not race-free, so parallel sessions need git.

## Viewing Progress

```
bash [plugin-root]/hooks/work-state.sh status [story-id]
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
   - runs `work-state.sh status` for the story (or all stories)
   - for each in-progress or blocked task: reads its task note (acceptance, `## Design`, `## Checklist`, `## Log`) at the path `work-state.sh path` prints, or in the worktree `status` shows (repo store only: otherwise `git show <work-branch>:<path>`). In its worktree or work branch it checks `git status` and `git log -1` for uncommitted work and the last commit, comparing ticked boxes against the code actually present
   - checks which acceptance criteria and checklist items are ticked, and whether the last log line names a next step
   - returns the ticked tree, where each in-progress task stopped, and the recommended next action
3. Show the result to the user and confirm the next action before continuing. Continuing a claimed task means working on its recorded work branch or worktree, not claiming again.

A new session in Claude Code also gets a one-line hint at startup when claims exist, naming the ones whose work branch is the current checkout (`work-state.sh hint`, local refs only so startup stays fast and offline). It suggests `/resume`; it never runs it.

## Obsidian (dotpm) Compatibility

The notes follow the format of the Obsidian project-manager plugin ("dotpm"), so a vault shows stories as projects and tasks as tasks. A few of its behaviors shape the rules above:

- **Regenerated bodies.** On save, dotpm rewrites a project note's body (heading, description, `## Tasks`) and deletes everything in a task note from a `## Subtasks` heading to the end, regenerating it from child notes. So project notes carry no content, and task notes use `## Checklist`, never `## Subtasks`.
- **Title ↔ file name.** dotpm names a task note from its title: lowercase, `\ / : * ? " < > |` and whitespace become `-`, at most 60 characters. `T02 Apply event` is `t02-apply-event`, and `new-task` derives the task id this way. Renaming a title by hand makes dotpm rename the file and breaks the id.
- **Statuses.** `todo`, `in-progress`, `blocked`, `review`, `done`, `cancelled`; complete means `done` or `cancelled`.
- **No git history in a vault.** A vault store's task notes aren't in the repository, so there is no merged-branch signal for them. `next` relies on released locks instead: a dependency counts only when it is complete and its claim is gone.
- **Custom fields.** `design_refs`, `branch`, and `design_approved` live in `customFields`; the story's project note declares them so dotpm displays them.
- **Links.** In the vault store every wikilink (`projectId`, `dependencies`, `parent`, `taskIds`, `## Tasks`, the footer) uses the note's vault path, such as `[[Projects/app/stories/shipment-tracking/_tasks/t01-webhook-route|T01 webhook route]]`, because ids like `t01-*` repeat across stories and repositories in one vault. The repo store uses bare names, as in the template above. `work-state.sh` writes every link; the task id is always the last path segment.

## External Trackers

When the project designates an issue tracker, each task is a tracker item instead of a task note, and the claim is the tracker's assignment. Assigning the item to yourself replaces the claim steps, and the tracker's own status replaces `set` and `log`. `plan.md` keeps the ordered list of item ids or links.

## Legacy Layout

A repository that already has `tasks/plan.md` and `tasks/todo.md` from an earlier plan keeps working: finish or discard that plan in the old single-file layout, since it is not safe for parallel sessions. New plans use `[stories-dir]` (`docs/stories/` in the repo store by default). A repository whose stories use `[stories-dir]/[story-id]/tasks/*.md` is converted with `work-state.sh migrate [story-id]`.
