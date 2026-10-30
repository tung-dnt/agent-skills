---
description: Resume from the current native todo/task view and static artifacts without claiming cross-session project state
---

Recover only what is available to this session. Native todo is the sole mutable progress list for the active main session; native task owns worker execution and output. Static artifacts and current repository/Git state provide context, not a second status store.

1. Read the current native todo view first. If its state may have changed through a manual edit or rewind, use the host's native todo readback and reconcile before making protected changes; never infer an unknown phase or completion.
2. Invoke `agent-skills:state-investigator` for a read-only check, or investigate yourself if the host cannot provide a worker. Supply the repository root and absolute paths of known static artifacts. The investigator compares the native view (if accessible), artifact scope/design/acceptance, actual code, and `git status`/relevant commits. It must not edit, stage, commit, checkout, reset, claim, or delete.
3. Ask the investigator to distinguish observed facts from inference: which native items are present; which worker outputs/reports are accessible; artifact paths and decisions; changed/uncommitted files; what focused or integration checks are actually evidenced; and the next safe action.
4. Present the read-only report. The main session chooses order and file ownership and asks the user before continuing when scope, approval, or ownership is uncertain.

`/resume` can use only the current session's native state, supplied artifacts, accessible worker outputs, and repository state. It does not reconstruct a project-wide board, another session's todo, task ownership, claims, or automatic DAG readiness. If those native items or outputs are not accessible, say exactly what is missing; do not synthesize them from prose, a task file, a branch name, or a worker's status.

Design and policy approval must be visible in the current conversation or supported session binding before continuing registered work. A task's native completion is not test proof. For registered verification work, `begin`, `run`, `status`, `complete`, and `cancel` refer to evidence-run operations only; user-facing approval is required, and unregistered work is not advertised as hard-verified.