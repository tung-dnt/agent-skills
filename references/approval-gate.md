# Approval Gate

The one checkpoint every planning, design, and build workflow passes before work starts. Skills and commands link here instead of restating it. **Nothing downstream begins until the user confirms.** No code, task files, or claims beyond what the gate itself needs.

## When a Gate Runs

| Workflow | Gate after | Blocks |
|---|---|---|
| `/epic` | Epic requirements; architecture; story map | Story stubs, then `/story` |
| `/story`, `spec-driven-development` | The spec; the `## Design`; the plan | The next phase |
| `high-level-design` | The design (after its fresh-context critique) | Task planning |
| `planning-and-task-breakdown` | The task list | Any build |
| `/task`, `/build`, `low-level-design` | The task's design note | Building the task |
| `/build auto` | The whole plan **and** every task's design note, once | The first wave |

## The Three Steps

### 1. Catch-up summary

Write the summary so the user can catch up in one screen without reading the artifacts. Show it in the conversation exactly as saved, with the same headings, **and** save it:
- Story or epic gates: `docs/stories/[story-id]/summary.md` or `docs/epics/[epic-id]/summary.md`, overwritten at each gate.
- Task gates: the task file's `## Summary` section. Only the claiming session writes it, so parallel sessions never collide.

Use this template, in plain language. No call stacks or code dumps; link `file:line` at most, and only where it earns its place. Fold the evidence into each line, so every decision appears together with its reason. Omit any section that doesn't apply.

```
## <id> — <Spec | Design | Plan | Task> Summary

**Business context:** Who's affected, what they can't do, and why it matters. 1–2 sentences.

**Proposed fix fit:** If the ticket or request proposes a technical solution: whether it actually solves the business problem, and any gaps. Omit if it proposes none.

**Root cause:** Bugs only. The one credible mechanism, in plain language ("X because Y, at `file:line`"). Omit if not a bug.

**Recommendation:** The course of action this gate approves (the design, plan, or approach) and why. 1–2 lines.

**Open decisions:** What still needs a human call. Omit if none.
```

This follows the report format of the `investigate-first` workflow, so investigations and plans read the same way.

**Task gates also show the design itself.** Right after the summary, print the task's `## Design` note verbatim (5–15 lines). The user approves the actual design, not a description of it.

### 2. Grill

Run the `grill-me` skill over the open decisions: rounds of numbered questions with recommended answers, working the design tree until the frontier is empty. Use its round format exactly (`❓ **Q1** - **<title>**: <question>`, then `➡️ <recommended answer>`, with `---` between questions) so every gate reads the same. Look up facts yourself (or with a read-only subagent); put only decisions to the user.

**Ask the approach, not just the details.** For a bug, or any change where more than one approach is plausible, the first round includes an approach question. List at least two alternatives with a one-line tradeoff each, plus your recommendation. For example: "copy the vendor files into the repo" vs "install and bundle them". Never pick the approach silently.

**Every gate asks at least one question.** When nothing is open, the round is a single question, "Proceed with this <spec | design | plan | task>?", with your recommended answer. A gate never passes silently.

### 3. Confirmation

Continue only on an explicit go-ahead. A hedged reply ("looks fine I guess") is not a go-ahead: ask what's holding them back. When an answer changes the artifact, update it and the summary, then run the gate again.

**Record it.** At a task gate, record the go-ahead with `work-state.sh approve [story-id] [task-id]`. It stores `design_approved: <date> <fingerprint>` in the task's frontmatter. `work-state.sh approved [story-id] [task-id]` exits 0 only while that approval exists and the `## Design` section is unchanged. Editing the note after approval voids it, and the gate runs again.

## Rules That Can't Be Skipped

- **Nothing is built on an unapproved design.** Before any build, the orchestrator runs `work-state.sh approved`. The `task-builder` checks it again, and reports `blocked` on a non-zero exit.
- **Existing work gets a gate too.** If code or commits already exist for a task that isn't approved (built in an earlier session, by hand, or before these rules), don't continue straight to review, push, PR, merge, or a tracker comment. First write the design note describing what was built and what should change, then run the gate on it, with the approach question if another approach was possible.
- **"Don't stop" means batch, not skip.** When the user says "just build it", "don't stop", or "no questions", don't drop the design. Switch to batch mode instead: draft every missing note, run one gate over all of them (a combined summary plus every note), `approve` each task, then build without further stops. `/build auto` works this way.

## Subagents Can't Hold a Gate

Only the main thread can talk to the user. So:

- Subagents that draft (designs, notes, investigations) return their draft; the main thread runs the gate on it.
- Subagents that build get an **approved** design note. A new decision that comes up mid-build is reported as `blocked`, and the main thread puts it to the user through the gate.
