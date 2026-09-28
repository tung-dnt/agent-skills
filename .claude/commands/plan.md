---
description: Break work into small verifiable tasks with acceptance criteria and dependency ordering
---

Invoke the agent-skills:planning-and-task-breakdown skill.

**Resolve the artifact root first.** From the project, run `bash "${CLAUDE_PLUGIN_ROOT}/hooks/work-state.sh" root`. If it reports `configured=false`, propose a location using its notes and write the config (`work-state.sh configure <storiesDir>`) only after the user confirms. Wherever this command says `docs/stories`, use the resolved `stories_dir`.

Read the existing spec (docs/stories/[story-id]/spec.md, SPEC.md, or equivalent) and the relevant codebase sections. Then:

1. Enter plan mode — read only, no code changes
2. Identify the dependency graph between components
3. Slice work vertically (one complete path per task, not horizontal layers)
4. Write tasks with acceptance criteria and verification steps
5. Add checkpoints between phases
6. Present the plan for human review

Save the plan to docs/stories/[story-id]/plan.md and write one file per task under docs/stories/[story-id]/tasks/, each starting with status: pending, as the skill describes. Task status lives only in the task files, never in the plan, so several sessions can build the plan at once. After approval, commit the plan and task files so every worktree and machine sees them before anyone claims a task.

If that story already has task files that aren't done and belong to different work, stop and ask before writing — never silently overwrite an incomplete plan. Leave any legacy tasks/plan.md or tasks/todo.md untouched.
