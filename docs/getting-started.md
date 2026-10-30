# Getting Started with agent-skills

agent-skills works with any AI coding agent that accepts Markdown instructions. This guide covers the universal approach. For tool-specific setup, see the dedicated guides.

Want a worked example before setting up your own project? The
[interactive tutorials](https://skills.addy.ie/tutorials/) walk through a
greenfield build, a brownfield feature, and a safe automation loop with
copyable prompts for Claude Code, Codex, or any other agent.

## How Skills Work

Each skill is a Markdown file (`SKILL.md`) that describes a specific engineering workflow. When loaded into an agent's context, the agent follows the workflow — including verification steps, anti-patterns to avoid, and exit criteria.

**Skills are not reference docs.** They're step-by-step processes the agent follows.

## Quick Start (Any Agent)

### 1. Clone the repository

```bash
git clone https://github.com/addyosmani/agent-skills.git
```

### 2. Choose a skill

Browse the `skills/` directory. Each subdirectory contains a `SKILL.md` with:
- **When to use** — triggers that indicate this skill applies
- **Process** — step-by-step workflow
- **Verification** — how to confirm the work is done
- **Common rationalizations** — excuses the agent might use to skip steps
- **Red flags** — signs the skill is being violated

### 3. Load the skill into your agent

Copy the relevant `SKILL.md` content into your agent's system prompt, rules file, or conversation. The most common approaches:

**System prompt:** Paste the skill content at the start of the session.

**Rules file:** Add skill content to your project's rules file (CLAUDE.md, .cursorrules, etc.).

**Conversation:** Reference the skill when giving instructions: "Follow the test-driven-development process for this change."

### 4. Use the meta-skill for discovery when needed

If your agent does not route skills natively, start with the `using-agent-skills` skill loaded. It contains a flowchart that maps task types to the appropriate skill.

If your host already discovers and activates skills from their descriptions, do not also paste `using-agent-skills` into an always-on system prompt or rules file. That creates two routers for the same task. Install the individual skills and let the host activate them on demand instead.

### Existing projects need no migration

Install the pack from the existing project's root using the normal setup path
for your agent, then keep working in that project. Skills activate for matching
tasks; they do not require a new repository layout or a one-time conversion of
existing code.

Do not copy this repository's root `AGENTS.md` or `CLAUDE.md` into the project.
Those files configure contributors to agent-skills itself. Add only the skills
and any project-specific instructions your agent normally reads. For a gradual
rollout in an established codebase, follow the [Adoption Guide](adoption-guide.md).

## Recommended Setup

Rolling out to a real project? The **[Adoption Guide](adoption-guide.md)** covers two end-to-end paths: the full lifecycle from day one for a greenfield project, and an incremental, verification-first rollout for an established codebase. The setup below is the quick version.

### Minimal (Start here)

Load three essential skills into your rules file:

1. **spec-driven-development** — For defining what to build
2. **test-driven-development** — For proving it works
3. **code-review-and-quality** — For verifying quality before merge

These three cover the most critical quality gaps in AI-assisted development.

### Full Lifecycle

For comprehensive coverage, load skills by phase:

```
Starting a project:  spec-driven-development → planning-and-task-breakdown
During development:  incremental-implementation + test-driven-development
Before merge:        code-review-and-quality + security-and-hardening
Before deploy:       shipping-and-launch
```

### Context-Aware Loading

Don't load all skills at once — it wastes context. Load skills relevant to the current task:

- Working on UI? Load `frontend-ui-engineering`
- Debugging? Load `debugging-and-error-recovery`
- Setting up CI? Load `ci-cd-and-automation`

## Skill Anatomy

Every skill follows the same structure:

```
YAML frontmatter (name, description)
├── Overview — What this skill does
├── When to Use — Triggers and conditions
├── Core Process — Step-by-step workflow
├── Examples — Code samples and patterns
├── Common Rationalizations — Excuses and rebuttals
├── Red Flags — Signs the skill is being violated
└── Verification — Exit criteria checklist
```

See [skill-anatomy.md](skill-anatomy.md) for the full specification.

## Using Agents

The `agents/` directory contains pre-configured agent personas:

| Agent | Purpose |
|-------|---------|
| `code-reviewer.md` | Five-axis code review |
| `test-engineer.md` | Test strategy and writing |
| `security-auditor.md` | Vulnerability detection |
| `web-performance-auditor.md` | Core Web Vitals & performance audit (via `/webperf`) |

Load an agent definition when you need specialized review. For example, ask your coding agent to "review this change using the code-reviewer agent persona" and provide the agent definition.

## Using Commands

The `.claude/commands/` directory contains slash commands for Claude Code:

| Command | Skill Invoked |
|---------|---------------|
| `/spec` | spec-driven-development |
| `/constraints` | constraint-driven-development |
| `/plan` | planning-and-task-breakdown |
| `/build` | incremental-implementation + test-driven-development |
| `/test` | test-driven-development |
| `/review` | code-review-and-quality |
| `/code-simplify` | code-simplification |
| `/ship` | shipping-and-launch |
| `/webperf` | web-performance-auditor (specialist agent, web apps only) |

> **Note:** When installed as a Claude Code plugin you may see a warning like
> _"Default commands/ folder is ignored because the manifest sets 'commands'"_.
> This is expected. The root `commands/` directory belongs to the Antigravity CLI
> and is intentionally separate from `.claude/commands/`. All Claude Code slash
> commands load correctly from `.claude/commands/`; the warning is cosmetic.

## Using References

The `references/` directory contains supplementary checklists:

| Reference | Use With |
|-----------|----------|
| `testing-patterns.md` | test-driven-development |
| `performance-checklist.md` | performance-optimization |
| `security-checklist.md` | security-and-hardening |
| `accessibility-checklist.md` | frontend-ui-engineering |
| `definition-of-done.md` | all skills / every change |
| `observability-checklist.md` | observability-and-instrumentation |
| `orchestration-patterns.md` | doubt-driven-development |

Load a reference when you need detailed patterns beyond what the skill covers.

If you install one skill with `npx skills add ... --skill <name>`, only the
selected `skills/<name>/` directory is copied. The skill still works, but paths
to supplementary checklists in the repo-level `references/` directory are
unavailable. Use a whole-repo integration, clone the repository, or copy the
needed checklist into a `references/` directory inside the installed skill.
This portability gap is tracked in
[addyosmani/agent-skills#361](https://github.com/addyosmani/agent-skills/issues/361).

## Specs, plans, and task artifacts

`/spec` and `/plan` produce static requirements, designs, plans, and worker briefs at paths chosen by the user or established by the repository. These artifacts carry acceptance criteria, decisions, dependencies, exact file ownership, and verification expectations. They do not store mutable task status. The main session uses native todo as its only progress list and native task for worker execution; it does not require an Obsidian vault, `_tasks` directory, work-state tool, or replacement project JSON store. See [Work Artifacts and Native Progress](../references/work-artifacts.md) and the [Native Task Workflow](native-task-workflow.md).

- Keep static artifacts where they can be reviewed and handed to a worker by absolute path.
- Update them only when scope/design changes; use the user gate before proceeding on a changed decision.
- Never add task status, claim data, or worker logs to a second Markdown/JSON board.

### Working by scope

- `/epic [id or idea]`: clarify intent → requirements → architecture when needed → ordered story map.
- `/story [work-id]`: approved requirements → high-level design/contracts when needed → static task plan and briefs.
- `/task [work-id]`: one focused task → approved low-level design for every planned task (concise even when mechanical) → test-first implementation and review; only ad-hoc mechanical changes with no decisions may omit LLD.
- `/build [work-id]`: every planned task's approved LLD gate → main-owned order/file ownership → native task workers as useful.

Every nontrivial requirements, design, and plan phase uses the approval gate ([references/approval-gate.md](../references/approval-gate.md)): show the artifact and a concise catch-up summary, grill unresolved decisions, and wait for an explicit user go-ahead. In addition, every task in a written breakdown has an approved low-level design before code, including mechanical tasks; the note may be concise and a user-approved slice may cover several designs. A native todo, native task completion, imported note, or model argument is not approval. A genuinely ad-hoc mechanical change with no design decisions may omit LLD. The user-facing approval interaction cannot be replaced by `approved=true`.

### Working across sessions

Static specs, designs, plans, and worker briefs can be handed between sessions by path, but native todo/task state is session-scoped. Do not assume another session can see the same native checklist, worker output, ordering, or ownership. The main session coordinates directly with any other owner before shared-file edits.

At a boundary, record the next decision/context in the relevant static artifact if it is part of the approved design, then tell the user the exact next command and which checks remain. Keep verification evidence separate from progress: report the exact check command, candidate, and observed result. Re-run checks when the candidate moved or evidence is missing/stale.

In a new session, `/resume` reads back the native todo state available to that session, supplied artifact paths, accessible worker output, and repository state. It cannot restore another session's native todo, claim, project-wide readiness, or unprovided worker logs. If the previous state is unavailable, say what is unknown and ask the user before taking over or changing ownership. After manual todo edits or rewind, use a fresh native view readback before protected completion rather than guessing.

#### Task-boundary restarts and external loops

A host may restart at a boundary only when its native session state and approved artifacts remain accessible. A process exit or native task completion is not evidence that tests passed. A restart must not bypass a user approval gate or invent the next task from a project-wide board. The main integration owner still runs required full, integration, and runtime/browser checks at a stable boundary.

Plain requests work in any agent with the skills installed. For example:

> Read the approved requirements and relevant code, then break the work into small vertical tasks. Write a static ordered plan and one static brief per task with acceptance criteria, dependencies, allowed paths, and focused verification. Do not edit product code or create a task-status board. Show the plan and ask for approval.

> Read the current native todo view, supplied static briefs, and repository state. Compare worker output with actual code and report exactly which checks ran and which did not. Do not infer another session's task ownership or start additional work; recommend one safe next action.

See the [Native Task Workflow](native-task-workflow.md) for the public workflow and verification boundary.

## Tips

1. **Start with spec-driven-development** for any non-trivial work
2. **Always load test-driven-development** when writing code
3. **Don't skip verification steps** — they're the whole point
4. **Load skills selectively** — more context isn't always better
5. **Use the agents for review** — different perspectives catch different issues
