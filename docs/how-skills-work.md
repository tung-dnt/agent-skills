# How Skills Work

Every skill follows a consistent anatomy:

```
┌─────────────────────────────────────────────────┐
│  SKILL.md                                       │
│                                                 │
│  ┌─ Frontmatter ─────────────────────────────┐  │
│  │ name: lowercase-hyphen-name               │  │
│  │ description: Guides agents through [task].│  │
│  │              Use when…                    │  │
│  └───────────────────────────────────────────┘  │                                                                                                
│  Overview         → What this skill does        │
│  When to Use      → Triggering conditions       │
│  Process          → Step-by-step workflow       │
│  Rationalizations → Excuses + rebuttals         │
│  Red Flags        → Signs something's wrong     │
│  Verification     → Evidence requirements       │
└─────────────────────────────────────────────────┘
```

**Key design choices:**

- **Process, not prose.** Skills are workflows agents follow, not reference docs they read. Each has steps, checkpoints, and exit criteria.
- **Anti-rationalization.** Every skill includes a table of common excuses agents use to skip steps (e.g., "I'll add tests later") with documented counter-arguments.
- **Verification is non-negotiable.** Every skill ends with evidence requirements - tests passing, build output, runtime data. "Seems right" is never sufficient.
- **Progressive disclosure.** The `SKILL.md` is the entry point. Supporting references load only when needed, keeping token usage minimal.

---

## Project Structure

The portable core stays in shared directories. Host-specific paths are native discovery conventions, not branding aliases; renaming or merging them would break the tools that scan those exact locations.

| Layer / consumer | Repository paths | Purpose |
|---|---|---|
| Shared workflow core | `skills/` (28 skills) | Portable `SKILL.md` workflows used by every integration |
| Shared review material | `agents/` (6 agents), `references/` (10 references) | Specialist reviewers, delegated workers, and pack-level references carried by whole-repo installs |
| omp adapter | `.claude/commands/` (14 commands), `.claude-plugin/`, `package.json` + `omp/`, `hooks/` | Slash-command wrappers (the only command format in this fork, used by omp), marketplace metadata, the verification tool/command and native todo completion hook, and lifecycle hooks; native todo/task remain host built-ins |
| Gemini CLI / Antigravity CLI | `plugin.json` | No command wrappers in this fork; skills are invoked by name (see [Antigravity setup](antigravity-setup.md#lifecycle-workflows-and-command-compatibility)) |
| Codex adapter | `.codex-plugin/`, `.agents/plugins/` | Codex plugin metadata and marketplace registration; Codex consumes `skills/` directly |
| GitHub Copilot CLI adapter | `plugin.json` | Root plugin metadata; Copilot CLI discovers `skills/` by convention and does not register the lifecycle wrappers |
| Contributor tooling | `scripts/` (13 scripts), `evals/` (28 case files), `.github/workflows/` | Validation, routing evals, and CI |
| Documentation | `docs/` | Universal guidance and per-tool setup guides |

Tools without a checked-in adapter directory install or copy the shared `skills/` core into their own native location. The [Quick Start](#quick-start) links the setup guide for each supported host.

---

## Why Agent Skills?

AI coding agents default to the shortest path - which often means skipping specs, tests, security reviews, and the practices that make software reliable. Agent Skills gives agents structured workflows that enforce the same discipline senior engineers bring to production code.

Each skill encodes hard-won engineering judgment: *when* to write a spec, *what* to test, *how* to review, and *when* to ship. These aren't generic prompts - they're the kind of opinionated, process-driven workflows that separate production-quality work from prototype-quality work.

Skills bake in best practices from Google's engineering culture — including concepts from [Software Engineering at Google](https://abseil.io/resources/swe-book) and Google's [engineering practices guide](https://google.github.io/eng-practices/). You'll find Hyrum's Law in API design, the Beyonce Rule and test pyramid in testing, change sizing and review speed norms in code review, Chesterton's Fence in simplification, trunk-based development in git workflow, Shift Left and feature flags in CI/CD, and a dedicated deprecation skill treating code as a liability. These aren't abstract principles — they're embedded directly into the step-by-step workflows agents follow.
