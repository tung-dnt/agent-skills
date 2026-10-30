---
description: In grill and approval-gate conversations, cite static artifact paths that let the user inspect the actual design or worker brief.
alwaysApply: true
agents: main
---

# Cite static work artifacts while grilling

Whenever you mention a planned task or design in a `grill-me` session or approval gate, give the absolute path to its static artifact the first time it appears in each round. A path is a useful handoff only when it points to the actual requirements, design, plan, or worker brief supplied by the main session.

- Use the path already chosen for the approved static artifact. Do not create an `_tasks` path, ask `work_state path`, or infer a path from a task ID.
- Format: `T02 Apply event` (`/absolute/path/to/artifacts/t02-apply-event.md`). Put the path in the question body or explanatory table cell, never inside a fenced block.
- In an `ask` dialog, cite the path in the message immediately before the call, in the same turn; some clients do not make paths inside the dialog clickable.
- When several tasks appear in one question, cite each actual artifact path. For a story/plan, cite its real spec/design/plan path.
- If a task brief has not been created, say “no brief yet” instead of inventing a link.

Static paths are context, not mutable task status or a project-wide progress record. Approval remains an explicit user decision; a path, native todo item, or native task result is not approval or test evidence.