# Model Routing and Delegation

How the spec → design → plan → build workflows split work between the main agent and subagents, and which model tier each piece runs on. The goals are lower cost and a main context window that holds decisions, not file contents.

This extends `orchestration-patterns.md`; its rules still hold. The user or a slash command orchestrates, personas never invoke personas, and subagents never spawn subagents.

## Principles

1. **The main agent orchestrates.** It keeps decisions, artifact paths, and short summaries. Reading-heavy and well-specified work goes to subagents.
2. **Artifacts on disk carry the context.** A subagent receives paths (a story id, a task id, a worktree) rather than pasted content. It reads what it needs, writes detail to files (the task's `## Log`, a review file), and returns a short summary.
3. **Scripts before models.** Deterministic work costs no tokens: `hooks/work-state.sh` resolves paths, picks and claims tasks, renders status, and packs a task's context (`brief`). Never ask a model to do what the script does.
4. **Route by judgment, escalate on failure.** Start each piece at the cheapest tier that can do it well. If it fails, move up a tier and pass a summary of the failure, never the whole transcript.

## Tiers

The main thread runs on whatever model the user selected. Routing never overrides that choice, and never silently upgrades work above it.

| Tier | Runs on | Use for |
|---|---|---|
| **Deep** | The main thread's model (`inherit`) | Dialogue with the user (interviews, approvals), high-level design, fresh-context critique of a design, security review of authentication, authorization, or sensitive data, and the retry after a balanced-tier failure |
| **Balanced** | A mid-size model (Claude Code: `sonnet`) | Building a task that has a low-level design note, writing that note, reviewing one task's diff, drafting ADRs, writing task files from an approved design |
| **Fast** | A small model (Claude Code: `haiku`) | Read-only work backed by scripts: `/resume` investigation, codebase search, running tests and triaging their output, collecting status, drafting commit and PR text |

In Claude Code the tier is the `model:` field in an agent's frontmatter, or the model passed when spawning a subagent. Hosts without per-agent models run every tier on the main model; the delegation structure still saves context.

## Who Does What, by Scope

| Scope | Stays in the main thread | Delegated |
|---|---|---|
| Epic | Interview (subagents can't ask the user), product requirements, story map | Architecture and codebase discovery (fast) · parallel option generation for `idea-refine` (balanced) · critique of the requirements (deep, fresh context) |
| Story | Requirements, the `## Design` itself, approval gates | Reading the existing architecture (fast) · `doubt-driven-development` critique (deep, fresh context) · writing task files from the approved design (balanced) |
| Task | A thin loop: pick, claim, delegate, collect | `task-builder` per claimed task (balanced), in parallel for independent tasks · `code-reviewer` per diff (balanced) · `security-auditor` when the task touches auth or sensitive data (deep) |
| Resume | Presenting the result and asking which task to continue | `state-investigator` (fast, read-only) |

## Output Contract

Every delegated job returns at most 15 lines:

```
status: done | blocked | failed
summary: <one or two sentences>
evidence: <tests run and result, commit sha>
files: <paths the main thread may want to open>
next: <the recommended next action, or "none">
```

Anything longer goes into a file, and the summary points to it. The main thread opens a file only when a decision needs it.

## Parallel Fan-out

- Fan out only over **independent** work: tasks that `work-state.sh next` returns while their dependencies are already done, or review dimensions over the same diff.
- Default to at most **3** concurrent subagents and never more than 5. Parallel runs raise peak spend and rate-limit pressure even while they lower the cost per task.
- Launch a wave's subagents back-to-back without waiting for results (in one turn where the host allows), so they run concurrently. Collect all the summaries before starting the next wave.
- Each builder works in its own worktree on its own claim (see `work-artifacts.md`), so builders never share files or a git index.

## Escalation

1. A fast-tier job that is unsure or fails is re-run at the balanced tier.
2. A balanced-tier builder that fails the same task twice (tests can't be made to pass, or the design note doesn't hold) is re-run at the deep tier with a summary of both failures.
3. A deep-tier failure stops and goes to the user. Model changes don't fix unclear requirements.

## Anti-patterns

- Pasting whole specs, diffs, or transcripts into a subagent prompt. Pass paths and let it read.
- Returning full logs or diffs to the main thread.
- Fanning out over tasks with unmet dependencies, then merging the conflicts.
- Using the deep tier by default "to be safe". Its cost belongs where judgment is the bottleneck.
- A persona or subagent that orchestrates other subagents.
