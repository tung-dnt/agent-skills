---
description: Take one story from requirements to an approved design and task plan, resuming at its current phase
---

Work at **story scope**: one user-facing capability that needs several tasks, or tasks that share a contract. Every step ends at a human gate.

## Before anything else

1. **Resolve the artifact root.** From the project, run `bash "${CLAUDE_PLUGIN_ROOT}/hooks/work-state.sh" root`. If it reports `configured=false`, propose a location using its notes, and write the config (`work-state.sh configure <storiesDir>`) only after the user confirms. Wherever this command says `docs/stories` or `docs/epics`, use the resolved directories.
2. **Read the input.** `$ARGUMENTS` may be free text, a slug, or a tracker key or URL. If it's a tracker item and a tracker tool is available, fetch its summary, description, type, parent, and children as input. The item's type is a hint, never the decider. Without a tracker, the repository's files are the tracker.
3. **Check the scope** against the signals in the "Scopes and Commands" section of the agent-skills work-artifacts reference (`references/work-artifacts.md` in the plugin). If the request belongs to a different scope, say so in one or two sentences with the evidence, recommend the right command, and continue only if the user confirms.

Pick the story id (a tracker key in lowercase, or a kebab-case slug), then run `bash "${CLAUDE_PLUGIN_ROOT}/hooks/work-state.sh" phase [story-id]` and **start at the step that phase names**. Never redo an approved step unless the user asks.

## Steps

1. **Spec** (phase `none` or `spec`). Invoke agent-skills:spec-driven-development and write `docs/stories/[story-id]/spec.md` with numbered functional requirements (`FR1`…) whose acceptance criteria can be tested, and non-functional requirements (`NFR1`…) as targets, drawing on `CONSTRAINTS.md` when it exists. When the story belongs to an epic, put `epic: [epic-id]` in its frontmatter and don't restate the epic.
2. **Design** (phase `design`). Invoke agent-skills:high-level-design and add a `## Design` section to the spec: scope and out of scope, components, flows labelled sync/async, data ownership, how each NFR is met and verified, security, rollout, and shared contracts with ids (`C1`…) and concrete examples. Compare at least two options for decisions that are hard to reverse and record ADRs. Run the fresh-context critique it calls for, then get the user's approval.
3. **Plan** (phase `plan`). Invoke agent-skills:planning-and-task-breakdown: write `docs/stories/[story-id]/plan.md` (a task index with dependencies and design refs, carrying the same `epic:` in its frontmatter), and one task file per task under `tasks/`, each with `status: pending`. After approval, commit the spec, plan, and task files so every worktree and machine can see them.
4. **Hand off** (phase `build` or `done`). Show `bash "${CLAUDE_PLUGIN_ROOT}/hooks/work-state.sh" status [story-id]` and end with the exact next command: `/task [story-id]` to build one task, or `/build auto` to build all of them in parallel. At phase `done`, recommend a whole-story review with agent-skills:code-review-and-quality, then agent-skills:shipping-and-launch.
