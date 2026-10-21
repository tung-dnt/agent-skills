---
description: In grill sessions and approval-gate grill rounds, every planned task you mention carries its absolute task-note path, so the user's file viewer can open it.
alwaysApply: true
agents: main
---

# Cite task notes by absolute path while grilling

Whenever you mention a planned task (one with a task note from a breakdown) during a `grill-me` session or the grill rounds of an approval gate, give the task note's **absolute path in backticks** the first time that task appears in each round. The user reads the session in herdr web, which links only absolute file paths. Wikilinks (`[[t02-apply-event]]`), bare ids (`T02`), and bare file names don't become links. A repo-relative path links only when the pane happens to be in the repo root.

- Get the path from `work-state.sh path <story-id> <task-id>`; it prints the absolute path in both the repo store and the vault store. Never type the path from memory.
- Format: T02 Apply event (`/abs/path/to/_tasks/t02-apply-event.md`). Put it in the question body or the options-table cell that names the task, as an inline code span, not inside a fenced block.
- With the `ask` tool: put each task path in the `question` text, which herdr web links, and also in the chat message just before the call. Never put a path only in an option label or description: there it is plain text, and a tap on it answers the question.
- Several tasks in one question: cite each one. A story or plan as a whole: cite `spec.md` / `plan.md` by absolute path in the same way.
- A task that has no note yet (proposed, not created): say so ("no note yet") instead of making up a path.
