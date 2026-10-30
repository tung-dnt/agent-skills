---
description: Plan an epic or new project — clarify intent, requirements, architecture, and an ordered story map with explicit user gates
---

Work at **epic scope**: a product, a new system, or a set of capabilities that could ship separately. The main session owns the native todo for this session, the order of work, and explicit file ownership. Specs, designs, decisions, plans, and worker briefs are static artifacts; their paths are the handoff, not a second progress tracker.

Every phase ends at the user approval gate in `references/approval-gate.md`: summarize the result, grill the open decisions, show the artifact path, and wait for an explicit user go-ahead before proceeding. A native todo item is not approval, and a native task finishing is not verification.

## Before anything else

1. **Read the input.** `$ARGUMENTS` may be free text, an id, or a tracker key or URL. If it identifies a tracker item and a tracker tool is available, fetch its summary, description, type, parent, and children as input. The item's type is a hint, never the decider. Without a tracker, use the repository and the user's stated context.
2. **Check the scope** against the signals in `references/work-artifacts.md`. If the request belongs to another scope, explain the evidence, recommend the right command, and continue only after the user confirms.
3. **Choose the artifact paths and work label** with the user. Reuse the repository's real conventions; do not require an Obsidian vault, `_tasks` directory, generated task-note path, project JSON store, or global tracker.

## Steps

1. **Intent.** Invoke `agent-skills:interview-me` until the users, problem, reason now, and success criteria are clear. If several directions remain plausible, also use `agent-skills:idea-refine`. Reuse existing approved context instead of asking for it again.
2. **Requirements.** Invoke `agent-skills:spec-driven-development`. Write a static epic artifact with goals, users, in-scope and out-of-scope boundaries, measurable success, risks, numbered requirements, and open questions. For a whole product, write `SPEC.md` at the repository root unless the repository already has an approved spec convention.
3. **Quality bar.** If the repository has no `CONSTRAINTS.md`, invoke `agent-skills:constraint-driven-development` and preserve the repository's existing quality criteria.
4. **Architecture.** When the epic adds or reshapes services, data stores, or integrations, invoke `agent-skills:high-level-design`. Record components, data ownership, integrations, security boundaries, rollout, and ADRs for expensive-to-reverse decisions. Give cross-story contracts stable `E1`, `E2`, … identifiers. Preserve the method and quality bar in that skill.
5. **Story map.** Invoke `agent-skills:planning-and-task-breakdown` at story size. Order vertical slices by dependencies and risk, and specify dependencies and likely owned files explicitly. Write the map and each story's static requirements/context artifact at the paths chosen above. These story artifacts are proposals until their user gates pass; do not start workers or imply a story is approved by inclusion in the map.
6. **Native progress and handoff.** Keep only this session's agreed phases and items in the native todo. The main session chooses order and file ownership; there is no project-wide claim, lock, automatic DAG readiness, or shared status service. After the story-map gate, report the exact next command, normally `/story [first-story-id]`.

When a worker is useful, use the host's native task mechanism with a static artifact brief and explicit allowed paths. Do not encode user approval in a model-supplied flag. Only registered work uses verification evidence operations; `begin`, `run`, `status`, `complete`, and `cancel` describe verification-run operations, not task-store commands. `complete` records evidence; it does not advance native todo progress. Unregistered work is not advertised as hard-verified.