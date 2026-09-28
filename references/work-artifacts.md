# Work Artifacts and Parallel Sessions

Where specs, designs, plans, and task state live, and how several agent sessions work on one plan without overwriting each other. Skills and commands that read or write these files link here instead of restating the rules.

## The Problem This Solves

A single shared plan and checklist works for one session. With several sessions — each in its own worktree, or several in one checkout — a shared file breaks: two sessions pick the same "next pending" task, both edit the same checklist, and worktree copies of it diverge and conflict on merge.

The fix is to separate **artifacts** (decided once, then read) from **work state** (written continuously, one owner per file).

## Resolving the Artifact Root

The paths below use the defaults `docs/stories` and `docs/epics`. A project can choose other directories, and a first clone may already use its own layout, so resolve the root before reading or writing any artifact:

```
bash [plugin-root]/hooks/work-state.sh root
```

`hooks/work-state.sh` ships with the agent-skills plugin: it sits at the plugin root, next to this `references/` directory (`${CLAUDE_PLUGIN_ROOT}/hooks/work-state.sh` in Claude Code), not in your project. Run it from inside the project. Where the script isn't available, apply the same order by hand. It prints `stories_dir`, `epics_dir`, `configured`, and `source`, plus `notes` for anything it found. It resolves in this order:

1. `.agent-skills.json` at the repository root: `{"storiesDir": "…", "epicsDir": "…"}`. Every worktree reads the same committed file.
2. No config, but `docs/stories` or `docs/epics` exists: use them (`source=detected`).
3. Neither: the defaults (`source=default`). The notes list anything that looks like another convention: `specs/`, `docs/specs/`, `openspec/`, or a legacy `tasks/plan.md`.

When `configured=false`, **propose** a location to the user, using the notes (for example "this repo keeps specs in `specs/`; use `specs/stories`?"). Write the config only after they confirm, with `bash [plugin-root]/hooks/work-state.sh configure <storiesDir> [epicsDir]`, and commit it. Never write it silently. After that, every command and session uses the resolved directories wherever this document says `docs/stories` or `docs/epics`.

## Layout

```
docs/epics/[epic-id]/
  epic.md             Product requirements and the story map: ordered stories with rough acceptance criteria

docs/stories/[story-id]/
  spec.md             Requirements with FR/NFR ids, plus `## Design` from high-level-design
  plan.md             Task index: ids, titles, order, dependencies, design refs
  tasks/
    [task-id].md      One work-state file per task
```

- **`story-id`** — kebab-case, chosen once and never renamed. Use the tracker key when one exists (`pac2-8120`), otherwise a short slug (`shipment-tracking`).
- **`task-id`** — `t01`, `t02`, … in plan order, plus a slug: `t02-apply-event`. Ids are never reused or renumbered after the plan is approved; a task added later takes the next free number.
- **Epics** are optional. A story belongs to an epic when its `plan.md` frontmatter says `epic: [epic-id]`.
- A project-level spec (the whole product, or a capability map with module specs) stays at `SPEC.md` in the project root. Stories reference it; they don't copy it.
- If the project designates another spec location or an external spec tool, that location replaces `docs/stories/`; the one-file-per-task rule still applies.

## Who Writes What

| File | Written by | When | Concurrency rule |
|---|---|---|---|
| `spec.md` | `spec-driven-development`, `high-level-design` | Before approval, or when a design change is escalated | Read-only while tasks are being built |
| `plan.md` | `planning-and-task-breakdown` | Before approval, or on a re-plan | Read-only while tasks are being built. Task status is **never** recorded here. |
| `tasks/[task-id].md` | The session that claimed the task | While building | Exactly one writer: the claim owner |

No hand-maintained checklist exists. Progress is read from the task files' `status` fields.

## Task File Template

```markdown
---
id: t02-apply-event
story: shipment-tracking
status: pending          # pending | claimed | done | blocked
depends_on: [t01-webhook-route]
design_refs: [C3, C4, C5]
owner:                   # set on claim: branch or session name
---

## Task t02: Worker applies a stored event to the shipment status
<!-- body: the Step 4 task structure from planning-and-task-breakdown
     (description, acceptance criteria, verification, files, scope) -->

## Design
<!-- low-level-design note, added just before implementation -->

## Subtasks
<!-- optional checklist the owner ticks while building, e.g. - [ ] adapter  - [x] schema -->

## Log
<!-- one line per session: date, what changed, what's next -->
```

`planning-and-task-breakdown` creates every task file with `status: pending` when the plan is written, using its Step 4 task structure as the body. `low-level-design` fills the `## Design` section. The builder updates `status`, `owner`, `## Subtasks`, and `## Log`, and writes a log line before stopping for any reason, so the next session can pick up from it.

## Claim Protocol

A claim is a **lock ref**, `claim/[story-id]/[task-id]`, pointing at a unique empty commit whose message records the claimer's work branch. The lock is separate from the branch the work happens on. That keeps it valid whether sessions share one checkout or use a worktree each, and a feature branch named after the story (`pac2-8120`) can't collide with it. `work-state.sh` does the git work:

| Step | Command | What it does |
|---|---|---|
| Pick | `work-state.sh next [story-id]` | Fetches with `--prune`, then prints the first `pending` task with no claim whose `depends_on` tasks are `done` **in this checkout** (merged here, not just finished on another branch). Exit 4 means nothing is claimable. |
| Claim | `work-state.sh claim [story-id] [task-id] [work-branch]` | Creates the lock with `git update-ref <ref> <commit> ""`, which fails if it already exists. With a remote, it pushes with an empty `--force-with-lease`, so the push fails if another machine holds the lock, even one this machine couldn't see. Exit 3 means another session won; pick again. The work branch defaults to the current branch. |
| Release | `work-state.sh release [story-id] [task-id]` | Deletes the lock locally and on the remote |

Before picking, bring the base branch up to date (`git pull --ff-only`) so tasks finished and merged elsewhere show as `done`.

**Working the task:**

- *Worktree per task:* `git worktree add -b [work-branch] ../[repo]-[task-id]`, claim with that work branch, and build there.
- *Same checkout:* claim with the current branch and build in place. Other sessions share this checkout's git index, so commit only your own paths: `git commit -- <task file> <code paths>`.
- Set `status: claimed` and `owner: [work-branch]` in the task file. Tick `## Subtasks` and write a `## Log` line as you go, and always before stopping.

**Finishing:** set `status: done` and commit it with the task's code. Release the lock once `done` is visible where the next session will look for it:
- *Same checkout:* release right after the commit.
- *Worktree per task:* release after the work branch is merged into the base branch. Until then, `status` shows the task as done but "not yet merged", and `next` doesn't treat it as a finished dependency.

**Blocked:** set `status: blocked` with the reason in `## Log` and keep the lock. The task shows as `[!]` until someone unblocks it or explicitly releases it. Releasing a blocked task never deletes its work branch.

**Continuing after a crash:** a claim whose work branch is the current branch belongs to this checkout, so continue it. Otherwise use `/resume`, and adopt a claimed task only when the user confirms that its previous session is gone. Never claim a task again.

**Lock refs are real branches** (`claim/*`). CI pipelines triggered on every push and branch-naming rules see them too. Exclude them from CI triggers (for GitHub Actions: `branches-ignore: ['claim/**']`) and allow the `claim/` prefix in branch rules.

**Without the script** (another agent host, or a per-skill install), run the same git commands by hand:
```
git fetch --prune
c=$(git commit-tree "$(git rev-parse 'HEAD^{tree}')" -p HEAD -m "claim [story-id]/[task-id] work=[work-branch]")
git update-ref refs/heads/claim/[story-id]/[task-id] "$c" ""      # fails → taken
git push --force-with-lease=refs/heads/claim/[story-id]/[task-id]: origin refs/heads/claim/[story-id]/[task-id]   # fails → taken; delete the local ref
```
If the project isn't a git repository, fall back to `status` and `owner` in the task file. Re-read the file immediately before claiming and skip any task that isn't `pending`. This fallback is not race-free, so parallel sessions need git.

## Viewing Progress

```
bash [plugin-root]/hooks/work-state.sh status [story-id]
```

prints the ticked tree, grouped as epics → stories → tasks → subtasks:

```
[~] epic payments  1/2 stories
  [x] story refunds  1/1 tasks
    [x] t01-refund
  [~] story payouts  1/3 tasks
    [x] t01-model
    [~] t02-transfer claimed: claim/payouts/t02-transfer · work feat-transfer · subtasks 2/3 · worktree ../app-t02 · last log: wrote adapter, next: retries
    [ ] t03-retry
```

`[x]` done · `[~]` claimed or partly done · `[ ]` not started · `[!]` blocked. The view is generated on demand and never committed. The truth stays in the task files and claim locks, so a tree nobody edits can't conflict. For a claimed task, the script reads the task file from the freshest place: the work branch's worktree (uncommitted edits included), then the work branch, then the current checkout.

## Resuming After a Session Ends

A closed or crashed session loses its conversation, not its state. Everything needed to resume is in the task files, claim locks, work branches, and worktrees. `/resume [story-id]` recovers it:

1. Resolve the artifact root.
2. Hand the investigation to a fresh-context, **read-only** subagent (or, on hosts without subagents, do it yourself without editing anything). It:
   - runs `work-state.sh status` for the story (or all stories)
   - for each claimed or blocked task: reads its task file from where `status` found it (acceptance, `## Design`, `## Subtasks`, `## Log`), and in its worktree or work branch checks `git status` and `git log -1` for uncommitted work and the last commit, comparing ticked boxes against the code actually present
   - checks which acceptance criteria and subtasks are ticked, and whether the last log line names a next step
   - returns the ticked tree, where each in-progress task stopped, and the recommended next action
3. Show the result to the user and confirm the next action before continuing. Continuing a claimed task means working on its recorded work branch or worktree, not claiming again.

A new session in Claude Code also gets a one-line hint at startup when claims exist, naming the ones whose work branch is the current checkout (`work-state.sh hint`, local refs only so startup stays fast and offline). It suggests `/resume`; it never runs it.

## External Trackers

When the project designates an issue tracker, each task is a tracker item instead of a task file, and the claim is the tracker's assignment. Assigning the item to yourself replaces steps 2–3 and 5. `plan.md` keeps the ordered list of item ids or links.

## Legacy Layout

A repository that already has `tasks/plan.md` and `tasks/todo.md` from an earlier plan keeps working: finish or discard that plan in the old single-file layout, since it is not safe for parallel sessions. New plans use `docs/stories/`.
