---
description: Start spec-driven development — write a structured specification before writing code
---

Invoke the agent-skills:spec-driven-development skill.

**Resolve the artifact root first.** From the project, run `bash "${CLAUDE_PLUGIN_ROOT}/hooks/work-state.sh" root`. If it reports `store=repo` and `configured=false`, propose a location using its notes and write the config (`work-state.sh configure <storiesDir>`) only after the user confirms; with `store=vault` there is nothing to propose. `[stories-dir]` below means the resolved `stories_dir` (an absolute path, possibly inside an Obsidian vault); its default in the repo store is `docs/stories`.

Begin by understanding what the user wants to build. Ask clarifying questions about:
1. The objective and target users
2. Core features and acceptance criteria
3. Tech stack preferences and constraints
4. Known boundaries (what to always do, ask first about, and never do)

Then generate a structured spec covering all six core areas: objective, commands, project structure, code style, testing strategy, and boundaries.

If the request bundles several independently testable capabilities, first propose a capability map (module ids, dependency direction, build order) per the skill's Phase 0 and get it approved, then spec each module in dependency order.

Save a spec for the whole project as SPEC.md in the project root. Save a spec for one story or feature as `[stories-dir]/[story-id]/spec.md`, where the story id is a tracker key or a short kebab-case slug (ask if unclear); create the story's project note first with `work-state.sh init-story [story-id] "[title]"` if it doesn't exist. Then pass the approval gate (`references/approval-gate.md` in the plugin): write and show the catch-up summary, run agent-skills:grill-me rounds over the open decisions (always at least one question), and wait for the user's explicit go-ahead before anything else happens. For a story, save the summary to `[stories-dir]/[story-id]/summary.md`.
