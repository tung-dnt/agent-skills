# Work State, Parallel Sessions, and the `/build` Pipeline

How this fork stores stories and tasks, keeps parallel sessions from colliding, and runs `/build` and `/build auto` across subagents. The workflow itself is in the [README](../README.md#what-this-fork-adds).

## Artifacts that are safe for parallel sessions

```
[stories-dir]/[story-id]/
  [story-id].md         Obsidian project note, made by `work_state init-story`
  spec.md               requirements + ## Design          read-only after approval
  plan.md               task index, order, design refs     read-only after approval
  _tasks/[task-id].md   task note: status, design note, checklist, log   one writer: the claimer
```

Task and project notes use the note format of the Obsidian **project-manager** plugin ("dotpm"), so they show up in its boards when the store is a vault. Agents create and change them only through `work_state` (`new-task`, `field`, `set`, `log`, `claim`, `approve`, `approve-phase`), and edit just the note body: the task description, `## Design`, `## Summary`, and the `## Checklist` ticks. Epics get a project note of their own (`[epics-dir]/[epic-id]/[epic-id].md`, made by `init-epic`); a story's project note links to its epic and records its phase approvals. An epic's architecture lives in its `epic.md` under `## Architecture`, with contract ids `E1…` that tasks can cite next to a story's `C1…`.

- **Where the notes live.** `work_state root` resolves a store: `vault` or `repo`. When your Obsidian vault is configured, the vault is the store: `~/.config/agent-skills/config.json` (or `$AGENT_SKILLS_CONFIG`) holds `{"vault": "/abs/path"}` and, optionally, `projectsFolder`, and the omp-starter knowledge-base step writes it. Notes then go to `<vault>/<projectsFolder>/<vaultFolder>/stories` and `…/epics`; `projectsFolder` defaults to the project-manager plugin's setting, then `Projects`. Without a vault, the store is the repo: `docs/stories` and `docs/epics`. `.agent-skills.json` can force the choice with `"store": "vault" | "repo"` and name the vault folder with `"vaultFolder": "group/name"` (default: the repo name, so every worktree of a repo shares one folder). Its `storiesDir` and `epicsDir` keys still set the repo-store directories.
- **Claims are git locks.** `/build` claims a task with the ref `claim/[story-id]/[task-id]`. It is created atomically, and published with an "only if it doesn't exist yet" push when there's a remote. Two sessions, worktrees, or machines never take the same task or edit the same file. `claim` then sets the task to `in-progress` and records its work branch. A vault has a single copy of each note and no git history for it, so there `next` also waits for a dependency's claim to be released, which happens once its work is merged.
- **`/resume` after a closed session.** A read-only investigator rebuilds the ticked tree (epics → stories → tasks → checklist items), finds where each claimed task stopped (including uncommitted work in worktrees), and recommends the next step.
- **The repo-store location is resolved per project.** With no vault, `/spec`, `/plan`, and `/build` detect an existing layout and propose a location in `.agent-skills.json`. They write it only after you confirm. A repository that still has the old `tasks/` layout converts it with `work_state migrate`.
- **The `work_state` tool does the git work and keeps the notes valid**, so the model doesn't have to: `root`, `configure`, `init-epic`, `init-story`, `new-task`, `path`, `field`, `set`, `log`, `phase`, `approve`, `approved`, `approve-phase`, `approved-phase`, `adopt-approvals`, `cites`, `next`, `ready`, `claim`, `release`, `status`, `brief`, `migrate`, `hint`. It is covered by `omp/work-state.test.ts` (`node --test`, needs Bun for the CLI).
- **One startup hint.** The plugin's omp extension (`omp/index.ts`) runs `work_state hint` on session start and prints a one-line `/resume` suggestion when claimed tasks exist, and nothing otherwise.
- **Claim locks are real branches.** Exclude `claim/**` from CI push triggers.

Full layout and protocol: [references/work-artifacts.md](../references/work-artifacts.md).

## The `/build` pipeline

A story with several tasks used to alternate: review a design, wait for its build, review the next design. In the measured orchestrator sessions, 52–72% of active time went on waiting for subagents that ran almost serially (1.0–1.4× parallelism). `/build [story-id]` removes the waiting without removing a single review, so design reviews and builds overlap:

1. **Draft.** After the plan gate, one balanced-tier subagent per `todo` task drafts its empty `## Design`, all at once.
2. **Walk.** The main session takes the designs in plan order. Each gets its one `low-level-design` step checkpoint (the draft's step 1 facts and approach are shown, you confirm or edit them, and Jev's shadow check runs), then the approval gate: show the result in chat and ask for approval (omp's `ask` dialog, no plan-mode toggle), then `approve`.
3. **Start.** After each approval, and whenever a builder finishes, `work_state ready [story-id]` lists the tasks that can start together. Each is claimed, gets its own worktree, and a `task-builder` starts in the background (3 at a time, 5 at most). The walk goes on with the next design.
4. **Finish.** A builder's report goes through code review (plus security review where it applies), `done`, merge, release, and worktree removal, then `ready` runs again. A merge conflict stops the run and asks you.

`ready` prints one `story/task` per line, in plan order, for every task that is `todo` and unclaimed, whose design approval still holds (`approved` exits 0), whose dependencies are complete (as `next` counts them in each store), and that shares no file with a task that is claimed, in progress, in review, or blocked, or with a task printed above it. A task's files come from its note: the `Files likely touched` list of its description and the backticked paths in `## Design`. A lockfile, schema dump, or generated querier (the `SHARED_OUTPUTS` list in `omp/work-state.ts`) counts as shared by any two tasks that touch one. A task it holds back is named on stderr (`skipped: pay/t04-seed overlaps pay/t01-schema (running) on src/db/schema.ts`) and is listed again once the other task is merged and released. Exit 4 means nothing can start. The full rules are in [references/work-artifacts.md](../references/work-artifacts.md).

**Fresh orchestrator at boundaries.** State is on disk, so a long orchestrator session isn't needed, and it costs context: the median in the measured sessions was 364–395k tokens. After each `/story` gate and each completed build wave, the session logs what is next, names the exact next command, and recommends continuing in a new session (`/resume [story-id]`, `/story`, or `/build`). In omp, the experimental `new_context` tool, where enabled, can stand in for the new session. It is a recommendation, never made in the middle of a gate. The rule is in [references/model-routing.md](../references/model-routing.md).

## Multi-agent `/build auto` with model routing

`/build auto` runs as a coordinator. It claims the independent tasks `work_state ready` lists, then gives each one to a `task-builder` subagent in its own worktree, running in parallel (default 3, max 5). A `code-reviewer` checks each diff, and `security-auditor` joins when a task touches auth or sensitive data. Reviewed tasks are merged, and their claims are released. The main thread keeps only short summaries.

| Tier | Model (Claude Code) | Runs |
|---|---|---|
| Deep | The model you selected for the main thread (`inherit`) | Dialogue with you, high-level design, design critique, security review, the retry after two failures |
| Balanced | `sonnet` | Task builders, low-level design notes, code review of a task diff |
| Fast | `haiku` | `/resume` investigation and other read-only work backed by scripts |

In an end-to-end run on 4 tasks, three builders ran concurrently and all 26 tests passed. The run cost **$3.37**: $1.31 for the coordinator and $2.06 for the Sonnet builders and reviewers. The main context peaked at 90k tokens. Routing rules: [references/model-routing.md](../references/model-routing.md).
