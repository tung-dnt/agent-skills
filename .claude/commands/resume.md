---
description: Restore where a previous session left off — ticked progress tree, where each in-progress task stopped, and the next step
---

Recover the state of in-progress work after a session ended or crashed. `$ARGUMENTS` may name a story id; empty means every story. The state lives in task files, claim branches, and worktrees, as described in the agent-skills work-artifacts reference (`references/work-artifacts.md` in the plugin).

1. **Resolve the artifact root.** From the project, run `bash "${CLAUDE_PLUGIN_ROOT}/hooks/work-state.sh" root`. If it reports `configured=false`, propose a location using its notes and write the config (`work-state.sh configure <storiesDir>`) only after the user confirms.
2. **Investigate read-only, in a fresh context.** Spawn the `agent-skills:state-investigator` subagent (read-only, fast tier). If subagents aren't available, do this yourself without editing, committing, or deleting anything. Give it the story id and resolved root, and have it:
   - run `bash "${CLAUDE_PLUGIN_ROOT}/hooks/work-state.sh" status [story-id]` for the ticked tree
   - for every claimed (`[~]`) or blocked (`[!]`) task, read its task file from the freshest copy: the worktree shown in the tree if there is one (uncommitted edits included), otherwise `git show [work-branch]:[stories-dir]/[story-id]/tasks/[task-id].md`: acceptance criteria, `## Design`, `## Subtasks`, `## Log`
   - where the tree shows a worktree, run `git -C [worktree] status --short` and `git -C [worktree] log -1 --oneline` to find uncommitted work and the last commit
   - report the ticked tree, then for each in-progress task: what is done (ticked criteria and subtasks, checked against the code actually present, last commit), what is uncommitted, the next step from the last log line, and a recommended next action
3. **Present the report** and ask the user which task to continue. Continuing a claimed task means working on its recorded work branch or worktree; never claim it again. Adopt a task whose work branch isn't this checkout only when the user confirms its previous session is gone. Then continue with /build.

Nothing is edited, committed, or deleted during steps 1 and 2.
