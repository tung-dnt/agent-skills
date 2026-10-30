---
description: Start spec-driven development — clarify the request and write a structured, reviewable specification before code
---

Invoke `agent-skills:spec-driven-development`.

Begin by understanding what the user wants to build. Ask clarifying questions about:
1. The objective and target users
2. Core features and testable acceptance criteria
3. The real tech stack and constraints
4. Boundaries: what to do, ask first about, and never do

Write a specification covering objective, commands, project structure, code style, testing strategy, and boundaries. For a story or feature, number functional requirements (`FR1`…) with testable acceptance criteria and non-functional requirements (`NFR1`…) with measurable targets. Preserve the skill's scope, capability-map, design, and quality requirements.

Choose a static artifact path with the user or follow the repository's established spec convention. A project-wide spec commonly lives in `SPEC.md`; a story spec may live beside its other approved design artifacts. Do not require a `work_state` root, vault configuration, project task store, or generated task-note location. If several independently testable capabilities are bundled, propose and gate a capability map before writing module specifications.

Pass the approval gate in `references/approval-gate.md`: show the result and its absolute path, grill open decisions, and ask the user to approve or revise it. Stop after the spec gate. Do not start planning or code until the user explicitly approves the spec in a later step. An artifact being present or a native todo being checked is not approval.

When work is registered for verification, user approval is obtained through the user-facing approval interaction, never a model-supplied approval flag. The operations `begin`, `run`, `status`, `complete`, and `cancel` apply to verification evidence; `complete` records evidence, not planning progress. Unregistered work is not advertised as hard-verified.