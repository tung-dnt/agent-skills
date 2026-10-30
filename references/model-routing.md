# Model Routing and Delegation

How the spec → design → plan → build workflows split work between the main agent and subagents, and which model tier each piece runs on. The goals are lower cost and a main context window that holds decisions, not file contents.

This extends `orchestration-patterns.md`; its rules still hold. The user or a slash command orchestrates, personas never invoke personas, and subagents never spawn subagents.

## Principles

1. **The main agent orchestrates.** It keeps decisions, artifact paths, and short summaries. Reading-heavy and well-specified work goes to subagents.
2. **Static artifacts carry design context.** A worker receives the repository root, absolute scope/design/brief paths, exact allowed files, acceptance criteria, and checks rather than a pasted transcript. Static artifacts hold requirements and decisions, never mutable status.
3. **Gates stay in the main thread.** Only the main thread can ask the user. Workers may investigate, draft, or build; approval happens through the user-facing gate (`approval-gate.md`).
4. **Native task tools own execution.** The main session owns native todo progress, order, and file assignment; native task owns worker execution/output. Do not invent a project board, claim service, or automatic readiness layer.
5. **Route by judgment, escalate on failure.** Start each piece at the cheapest tier that can do it well. If it fails, move up a tier and pass a summary of the failure, never the whole transcript.

## Tiers

The main thread runs on whatever model the user selected. Routing never overrides that choice, and never silently upgrades work above it.

| Tier | Runs on | Use for |
|---|---|---|
| **Deep** | The main thread's model (`inherit`) | Dialogue with the user (interviews, approvals), high-level design, fresh-context critique of a design, security review of authentication, authorization, or sensitive data, and the retry after a balanced-tier failure |
| **Balanced** | A mid-size model (Claude Code: `sonnet`) | Building one bounded task from its approved static brief, writing a low-level design, reviewing one diff, drafting ADRs |
| **Fast** | A small model (Claude Code: `haiku`) | Read-only codebase research, `/resume` investigation of accessible native state/artifacts, running focused checks and triaging observed output |

In Claude Code the tier is the `model:` field in an agent's frontmatter, or the model passed when spawning a subagent. Hosts without per-agent models run every tier on the main model; the delegation structure still saves context.

## Who Does What, by Scope

| Scope | Stays in the main thread | Delegated |
|---|---|---|
| Epic | Interview (subagents can't ask the user), product requirements, story map | Architecture and codebase discovery (fast) · parallel option generation for `idea-refine` (balanced) · critique of the requirements (deep, fresh context) |
| Story | Requirements, the `## Design` itself, approval gates, static plan and owner assignment | Reading existing architecture (fast) · `doubt-driven-development` critique (deep, fresh context) |
| Task | Select/order one task, assign paths, approve a low-level design for every written-plan task (including mechanical), and own user gates | `task-builder` for one bounded, approved static brief (balanced) · `code-reviewer` per diff (balanced) · `security-auditor` when auth/sensitive data apply (deep) |
| Resume | Presenting observations and asking which safe action to take | `state-investigator` (fast, read-only), limited to accessible native session state, worker output, artifacts, and repository |

## Output Contract

Every delegated job returns at most 15 lines:

```
status: completed | blocked | failed | needs-command
summary: <one or two sentences>
evidence: <exact commands/results actually observed, or none>
files: <changed paths and useful artifact paths>
unrun: <required checks not run, or none>
next: <the recommended main-session action>
```

The main session checks the actual diff and output. A native task completion is an execution outcome, not test evidence. Long reports go into a static artifact only when needed; never write a mutable task log/status file.

## Parallel Fan-out

- Fan out only over **independent** work whose dependencies, exact allowed paths, and main-assigned ownership are clear. There is no automatic project-wide readiness or shared-file conflict detection; when unclear, run sequentially.
- Preserve the existing routing floor: default to at most **3** concurrent workers and never more than 5 where the host supports it. Parallel runs raise peak spend and rate-limit pressure.
- Launch genuinely independent workers back-to-back when the host permits; the main session still owns each user gate, order, file assignment, and integration. Collect evidence before moving to required integration checks.
- Give each worker one static brief by absolute path, the allowed paths, and focused verification instructions. Workers do not claim a task through Git or another status board.

## Subagent Command Rules

Subagents run unattended. Every permission prompt they trigger stops the user mid-task, whatever the session's permission mode. Permission checks can only approve commands they can read, and a plugin can't give its agents a looser mode. So every subagent follows these rules, and every subagent prompt the orchestrator writes repeats them:

1. **One plain command per shell call.** No multi-line scripts, `set -e`, shell variables, `$(…)`, `&&` or `;` chains, or `cd dir && …`. Use absolute literal paths.
2. **File tools for file work.** Read, Write, Edit, Glob, and Grep instead of `cat`, `cp`, `mkdir`, `sed`, `find`, or `echo >`.
3. **No recursive deletes** (`rm -r`, `rm -rf`, `rmdir`). Put scratch work in a new, uniquely named directory. The orchestrator cleans up.
4. **No always-ask commands:** `git push`, `ssh`, `docker run`, `docker exec`, `psql`, `kubectl`, `terraform`, or any `publish`. When the work needs one, report `needs-command` with the exact command, its working directory, and why. The orchestrator runs it once in the main session and passes back the output.

The agents in `agents/` carry a copy of these rules. When they change, update every copy.

## Escalation

1. A fast-tier job that is unsure or fails is re-run at the balanced tier.
2. A balanced-tier builder that fails the same task twice (tests can't be made to pass, or the design note doesn't hold) is re-run at the deep tier with a summary of both failures.
3. A deep-tier failure stops and goes to the user. Model changes don't fix unclear requirements.

## Fresh Orchestrator at Boundaries

The native todo and task output are session-scoped. Static scope/design/plan/brief artifacts can be handed off by path, but they are not a substitute for native progress and cannot restore another session's todo, task ownership, or worker output. Resume only when the current native state and the required artifacts are actually accessible.

A useful boundary is a user-approved planning phase or a stable implementation point where workers have reported and the main integration owner has observed required checks. It is not proof by itself: task completion, an artifact, or a successful-looking log line does not establish verification.

At a boundary:

1. Read back the current native todo before making protected changes; reconcile after manual edits or rewind rather than guessing.
2. Keep the approved scope/design/plan at its real static artifact path. Do not add a task status/log/approval mirror.
3. Tell the user the exact next command and distinguish checks actually run from required checks still outstanding.
4. Recommend a fresh session only when the host can restore the necessary native session state and artifact paths. If state is unavailable, say what cannot be recovered and ask before taking over or changing ownership.

This is a recommendation at a boundary, never an interruption in a gate or checkpoint. The main session owns the user conversation, approval, ordering, and integration.

## Anti-patterns

- Pasting whole specs, diffs, or transcripts into a subagent prompt. Pass paths and let it read.
- Returning full logs or diffs to the main thread.
- Fanning out over tasks with unmet dependencies, then merging the conflicts.
- Using the deep tier by default "to be safe". Its cost belongs where judgment is the bottleneck.
- A persona or subagent that orchestrates other subagents.
- Subagents writing compound shell scripts (variables, `$(…)`, chained `cd … &&`, `rm -rf`). Permission checks can't read them, so each one stops the user with a prompt. Give subagents one plain command per call and the file tools, and hand anything permission-gated back to the main thread (`needs-command`).
