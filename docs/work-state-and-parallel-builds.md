# Work State, Parallel Sessions, and `/build auto`

How this fork stores stories and tasks, keeps parallel sessions from colliding, and runs `/build auto` across subagents. The workflow itself is in the [README](../README.md#what-this-fork-adds).

## Artifacts that are safe for parallel sessions

```
[stories-dir]/[story-id]/
  [story-id].md         Obsidian project note, made by `work-state.sh init-story`
  spec.md               requirements + ## Design          read-only after approval
  plan.md               task index, order, design refs     read-only after approval
  _tasks/[task-id].md   task note: status, design note, checklist, log   one writer: the claimer
```

Task and project notes use the note format of the Obsidian **project-manager** plugin ("dotpm"), so they show up in its boards when the store is a vault. Agents create and change them only through `work-state.sh` (`new-task`, `field`, `set`, `log`, `claim`, `approve`, `approve-phase`), and edit just the note body: the task description, `## Design`, `## Summary`, and the `## Checklist` ticks. Epics get a project note of their own (`[epics-dir]/[epic-id]/[epic-id].md`, made by `init-epic`); a story's project note links to its epic and records its phase approvals. An epic's architecture lives in its `epic.md` under `## Architecture`, with contract ids `E1…` that tasks can cite next to a story's `C1…`.

- **Where the notes live.** `work-state.sh root` resolves a store: `vault` or `repo`. When your Obsidian vault is configured, the vault is the store: `~/.config/agent-skills/config.json` (or `$AGENT_SKILLS_CONFIG`) holds `{"vault": "/abs/path"}` and, optionally, `projectsFolder`, and the omp-starter knowledge-base step writes it. Notes then go to `<vault>/<projectsFolder>/<vaultFolder>/stories` and `…/epics`; `projectsFolder` defaults to the project-manager plugin's setting, then `Projects`. Without a vault, the store is the repo: `docs/stories` and `docs/epics`. `.agent-skills.json` can force the choice with `"store": "vault" | "repo"` and name the vault folder with `"vaultFolder": "group/name"` (default: the repo name, so every worktree of a repo shares one folder). Its `storiesDir` and `epicsDir` keys still set the repo-store directories.
- **Claims are git locks.** `/build` claims a task with the ref `claim/[story-id]/[task-id]`. It is created atomically, and published with an "only if it doesn't exist yet" push when there's a remote. Two sessions, worktrees, or machines never take the same task or edit the same file. `claim` then sets the task to `in-progress` and records its work branch. A vault has a single copy of each note and no git history for it, so there `next` also waits for a dependency's claim to be released, which happens once its work is merged.
- **`/resume` after a closed session.** A read-only investigator rebuilds the ticked tree (epics → stories → tasks → checklist items), finds where each claimed task stopped (including uncommitted work in worktrees), and recommends the next step.
- **The repo-store location is resolved per project.** With no vault, `/spec`, `/plan`, and `/build` detect an existing layout and propose a location in `.agent-skills.json`. They write it only after you confirm. A repository that still has the old `tasks/` layout converts it with `work-state.sh migrate`.
- **`hooks/work-state.sh` does the git work and keeps the notes valid**, so the model doesn't have to: `root`, `configure`, `init-epic`, `init-story`, `new-task`, `path`, `field`, `set`, `log`, `phase`, `approve`, `approved`, `approve-phase`, `approved-phase`, `adopt-approvals`, `cites`, `next`, `claim`, `release`, `status`, `brief`, `migrate`, `hint`. It is covered by `hooks/work-state-test.sh`.
- **One startup hook.** The Claude Code plugin registers a SessionStart hook (`work-state.sh hint`) that prints a one-line `/resume` suggestion when claimed tasks exist, and nothing otherwise.
- **Claim locks are real branches.** Exclude `claim/**` from CI push triggers.

Full layout and protocol: [references/work-artifacts.md](../references/work-artifacts.md).

## Multi-agent `/build auto` with model routing

`/build auto` runs as a coordinator. It picks and claims independent tasks, then gives each one to a `task-builder` subagent in its own worktree, running in parallel (default 3, max 5). A `code-reviewer` checks each diff, and `security-auditor` joins when a task touches auth or sensitive data. Reviewed tasks are merged, and their claims are released. The main thread keeps only short summaries.

| Tier | Model (Claude Code) | Runs |
|---|---|---|
| Deep | The model you selected for the main thread (`inherit`) | Dialogue with you, high-level design, design critique, security review, the retry after two failures |
| Balanced | `sonnet` | Task builders, low-level design notes, code review of a task diff |
| Fast | `haiku` | `/resume` investigation and other read-only work backed by scripts |

In an end-to-end run on 4 tasks, three builders ran concurrently and all 26 tests passed. The run cost **$3.37**: $1.31 for the coordinator and $2.06 for the Sonnet builders and reviewers. The main context peaked at 90k tokens. Routing rules: [references/model-routing.md](../references/model-routing.md).
