---
description: Take one story from the lead's brief to a single approved plan — read the brief and system map, ask every question in one batch, write the plan summary, get one approval
---

Work at **story scope**. The lead (the user) owns the brief, high-level design, invariants and acceptance. You own low-level design and code structure. `/story <id>` needs the omp-starter lead harness: before this prompt runs it checks `lead/stories/<id>/brief.md` and `lead/system-map.md` in the knowledge base, and it adds a `# Lead story` block (brief, system map, hard gates, plan path) to your context.

If your context has no `# Lead story` block, stop and tell the user to run `/starter lead`, fill in the system map, and write the brief. Do not interview the user for requirements and do not draft the brief yourself.

## Steps

1. **Read.** Read the brief and the system map from the `# Lead story` block. Open only the repositories they name. If the map lacks something you need (an owner, a contract, a queue), stop and report the gap; do not explore other repositories to find it.
2. **Ask once.** Put every clarifying question in ONE `ask` form, ordered by risk: invariants, contracts and data first, then scope, then the rest. Preselect your best guess for each. Ask a second form only when an answer opens a new risk.
3. **Write the plan.** Write the plan file named in the `# Lead story` block:
   - frontmatter `repos:` with the absolute root of every repository you will read or change;
   - `## Summary`: at most 15 lines restating the goal, the approach, and each invariant id (`I1`, …) with how it will be proven;
   - `## Tasks`: your ordered task list with owned paths and the focused check for each. This section is yours; the lead does not approve it.
   Do not add a contract or cross-repository boundary the brief does not name; raise it as a question instead.
4. **Get the one approval.** Call the `lead` tool with `op: "approve"`. It shows the summary to the lead. This is the only planning approval: no spec, design, or per-task design approval follows. If the lead declines, revise and call it again. The harness blocks repository edits until the plan is approved, and again whenever `repos:` or `## Summary` changes.
5. **Hand off.** Put the tasks in the native todo and name the next command: `/build <id>`. Recommend a fresh session for a large story.
