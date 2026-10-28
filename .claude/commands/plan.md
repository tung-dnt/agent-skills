---
description: Break work into small verifiable tasks with acceptance criteria and dependency ordering
---

Invoke the agent-skills:planning-and-task-breakdown skill.

**Resolve the artifact root first.** From the project, run `work_state root`. If it reports `store=repo` and `configured=false`, propose a location using its notes and write the config (`work_state configure <storiesDir>`) only after the user confirms; with `store=vault` there is nothing to propose. `[stories-dir]` below means the resolved `stories_dir` (an absolute path, possibly inside an Obsidian vault); its default in the repo store is `docs/stories`. Change task state only through `work_state` commands, never by editing frontmatter by hand.

Read the existing spec (`[stories-dir]/[story-id]/spec.md`, SPEC.md, or equivalent) and the relevant codebase sections. Then:

1. Stay in the current chat without entering plan mode — investigate read-only and write planning artifacts only, no implementation changes
2. Identify the dependency graph between components
3. Slice work vertically (one complete path per task, not horizontal layers)
4. Write tasks with acceptance criteria and verification steps
5. Add checkpoints between phases
6. Pass the approval gate (`references/approval-gate.md` in the plugin) once the plan and its task notes exist: write and show the catch-up summary, run agent-skills:grill-me rounds over the open decisions (always at least one question), and wait for the user's explicit go-ahead. Save the summary to `[stories-dir]/[story-id]/summary.md`, then record the go-ahead with `work_state approve-phase [story-id] plan`

Save the plan to `[stories-dir]/[story-id]/plan.md`. If the story has no project note yet, create it with `work_state init-story [story-id] "[title]"`. Then create one task note per task with `work_state new-task [story-id] "T01 [title]" [dependency-task-id…]` and `work_state field [story-id] [task-id] design_refs "C1, C2"` (`C` ids from the story's design, `E` ids from its epic's), as the skill describes, and write each task's description above `## Design` in its note (the path `work_state path [story-id] [task-id]` prints). Never hand-write task frontmatter. Task status lives only in the task notes, never in the plan, so several sessions can build the plan at once. The approval records the plan and the task ids, so run the gate after the notes exist. After approval, in the repo store, commit the plan, the task notes, and the story's project note (it holds the approval) so every worktree and machine sees them before anyone claims a task; the vault store isn't in git.

If that story already has task notes that aren't done and belong to different work, stop and ask before writing — never silently overwrite an incomplete plan. If it is the same work being re-planned (a task split, or new tasks), follow the skill's re-plan procedure: cancel and log the old task, add the new tasks with the next free number, update the plan, and run this gate again. Leave any legacy tasks/plan.md or tasks/todo.md untouched.
