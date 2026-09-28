---
description: Plan an epic or a new project — interview, requirements, architecture, and a story map, with a scope check first
---

Work at **epic scope**: a product, a new system, or a set of capabilities that could ship separately. Every step ends at a human gate; don't start the next step until the user approves the current one.

## Before anything else

1. **Resolve the artifact root.** From the project, run `bash "${CLAUDE_PLUGIN_ROOT}/hooks/work-state.sh" root`. If it reports `configured=false`, propose a location using its notes, and write the config (`work-state.sh configure <storiesDir>`) only after the user confirms. Wherever this command says `docs/stories` or `docs/epics`, use the resolved directories.
2. **Read the input.** `$ARGUMENTS` may be free text, a slug, or a tracker key or URL. If it's a tracker item and a tracker tool is available, fetch its summary, description, type, parent, and children as input. The item's type is a hint, never the decider. Without a tracker, the repository's files are the tracker.
3. **Check the scope** against the signals in the "Scopes and Commands" section of the agent-skills work-artifacts reference (`references/work-artifacts.md` in the plugin). If the request belongs to a different scope, say so in one or two sentences with the evidence, recommend the right command, and continue only if the user confirms.

Pick the epic id: a tracker key in lowercase, or a short kebab-case slug.

## Steps

1. **Intent.** Invoke agent-skills:interview-me until you're about 95% confident about who it's for, what problem it solves, why now, and what success looks like. If several directions are plausible, also run agent-skills:idea-refine. Skip questions that `docs/epics/[epic-id]/epic.md` or `SPEC.md` already answer.
2. **Requirements.** Invoke agent-skills:spec-driven-development and write `docs/epics/[epic-id]/epic.md`: goals, users, scope and **out of scope**, success metrics, risks, and numbered requirements. When this is the whole product rather than one epic of it, write `SPEC.md` at the project root instead.
3. **Quality bar.** If the project has no `CONSTRAINTS.md`, invoke agent-skills:constraint-driven-development.
4. **Architecture.** When the epic adds or reshapes services, data stores, or integrations, invoke agent-skills:high-level-design at architecture level: components, data ownership, integrations, security boundaries, and ADRs for the decisions that are expensive to reverse. Delegate reading a large codebase to a fast-tier read-only subagent (`references/model-routing.md`).
5. **Story map.** Invoke agent-skills:planning-and-task-breakdown at story size. Aim for vertical slices that each deliver user-visible value, ordered by dependency and risk. Add the ordered story list to `epic.md`. For each story, create `docs/stories/[story-id]/spec.md` holding the story statement, rough acceptance criteria, and `epic: [epic-id]` in its frontmatter. Leave the design and plan to `/story`.
6. **Commit** the epic and story stubs, then end with the story map and the exact next command: `/story [first-story-id]`.
