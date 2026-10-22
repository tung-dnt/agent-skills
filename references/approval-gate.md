# Approval Gate

The one checkpoint every planning, design, and build workflow passes before work starts. Skills and commands link here instead of restating it. **Nothing downstream begins until the user confirms.** No code, task notes, or claims beyond what the gate itself needs.

## When a Gate Runs

| Workflow | Gate after | Blocks |
|---|---|---|
| `/epic` | Epic requirements; architecture; story map | Story stubs, then `/story` |
| `/story`, `spec-driven-development` | The spec; the `## Design`; the plan | The next phase |
| `high-level-design` | The design (after its fresh-context critique) | Task planning |
| `planning-and-task-breakdown` | The task list | Any build |
| `/task`, `/build [story-id]/[task-id]`, `low-level-design` | The task's design note | Building the task |
| `/build [story-id]` (pipeline) | Each task's design note, in plan order, one gate per task | That task's builder only: tasks already approved build while the next design is reviewed |
| `/build auto` | The whole plan **and** every task's design note, once | The first wave |

## Step Checkpoints

Before the gate, smaller stops keep the user with the work as it's produced, instead of meeting it all at once in a final plan. Stop at a checkpoint:

- after an investigation (in `/task`, for bugs and unknown causes)
- after each step of `high-level-design` (steps 1–11) and `low-level-design` (steps 1–6)

At each checkpoint:

1. **Show what the step produced:** the section just written, verbatim, or for an investigation the root cause and its evidence. Keep it to 15 lines or fewer, and lead with a one-line header: `Step N/M — <step name>`.
2. **Ask.** Put any decision the step raised to the user as a decision brief (see Grill below). If nothing is open, ask one question, "Continue to step N+1 (<name>)?", with your recommended answer. For an investigation, ask "Is this the right cause to design against?"
3. **Wait** for the reply. When it changes the step, revise that step and show it again. Never write the next step on an unconfirmed one.
4. **Keep the progress in the artifact.** The text written so far is the progress, so a resumed session continues at the first step not yet written. At task scope, add a `## Log` line per confirmed step.

A checkpoint is lighter than the gate: no catch-up summary and no record. The gate still runs at the end of the design over the whole result. Its grill asks only what is still open, plus "Proceed?". Never re-ask what a checkpoint already settled.

**Jev shadow check** (`../hooks/JEV-SHADOW.md`). Once per session, run `bash [plugin-root]/hooks/jev.sh status`; if it prints `enabled=false`, skip this for the rest of the session. Otherwise, at a design-step checkpoint (not an investigation), before asking, pipe the step's text to `bash [plugin-root]/hooks/jev.sh checkpoint - --step "N/M <name>" --story [story-id]` (add `--task [task-id]` at task scope). If it printed `jev=<id>`, then after the reply run `jev.sh outcome <id> decision` when the checkpoint asked a decision brief or the reply changed the step, otherwise `jev.sh outcome <id> none`. `jev=skipped` means do nothing more. Never let the answer change the checkpoint: ask exactly what this section says.

A checkpoint holds the user's attention, so it needs the main thread. Subagents can read, investigate, and critique between checkpoints, but the main thread writes each design step. The one exception is the `/build` pipeline: subagents draft every task's `## Design` ahead of time, and each checkpoint then shows the drafted step instead of a freshly written one. The user confirms or edits it, and the main thread writes any edit. A draft is only a proposal; nothing in it is approved until the gate records it.

## The Three Steps

### 1. Catch-up summary

Write the summary so the user can catch up in one screen without reading the artifacts. Show it in the conversation exactly as saved, with the same headings, **and** save it:
- Story or epic gates: `[stories-dir]/[story-id]/summary.md` or `[epics-dir]/[epic-id]/summary.md`, overwritten at each gate (directories from `work-state.sh root`).
- Task gates: the task note's `## Summary` section, at the path `work-state.sh path [story-id] [task-id]` prints. Only the claiming session writes it, so parallel sessions never collide.

Use this template, in plain language. No call stacks or code dumps; link `file:line` at most, and only where it earns its place. Fold the evidence into each line, so every decision appears together with its reason. Omit any section that doesn't apply.

```
## <id> — <Spec | Design | Plan | Task> Summary

**Business context:** Who's affected, what they can't do, and why it matters. 1–2 sentences.

**Proposed fix fit:** If the ticket or request proposes a technical solution: whether it actually solves the business problem, and any gaps. Omit if it proposes none.

**Root cause:** Bugs only. The one credible mechanism, in plain language ("X because Y, at `file:line`"). Omit if not a bug.

**Recommendation:** The course of action this gate approves (the design, plan, or approach) and why. 1–2 lines.

**Trade-offs:** What the recommendation gives up (cost, risk, flexibility), and the strongest alternative with the reason it lost. 1–2 lines.

**Open decisions:** What still needs a human call. Omit if none.
```

This follows the report format of the `investigate-first` workflow, so investigations and plans read the same way.

**Task gates also show the design itself.** Right after the summary, print the task's `## Design` note verbatim (5–15 lines). The user approves the actual design, not a description of it.

### 2. Grill

Run the `grill-me` skill over the open decisions: rounds of numbered questions with recommended answers, working the design tree until the frontier is empty. Look up facts yourself (or with a read-only subagent); put only decisions to the user.

**Every decision question is a decision brief** in the format `grill-me` defines (options table, **Hinges on**, recommendation with a "choose … instead if" flip condition), so the user can weigh it rather than just accept a recommendation. A round is one `ask` call with several questions (see `grill-me`). On top of that format:

- At least two real options. Include "do nothing" or "defer" when that's genuinely viable.
- Tie **Hinges on** to a requirement, constraint, or NFR.
- Fill the cells with evidence: measured, looked up, or quoted from the code or spec. Mark guesses `(est.)`.
- The "choose … instead if" line is required. It tells the user which assumption the recommendation rests on.
- Only the closing "Proceed?" question skips the table.
- Name a planned task by its absolute note path in backticks (`work-state.sh path <story-id> <task-id>`), as `rules/task-paths-in-grill.md` describes, so the user's viewer can open it.

**Ask the approach, not just the details.** For a bug, or any change where more than one approach is plausible, the first round includes the approach as a decision brief. For example: "copy the vendor files into the repo" vs "install and bundle them", compared on effort, risk, and reversibility. Never pick the approach silently.

**Every gate asks at least one question.** When nothing is open, the round is a single question, "Proceed with this <spec | design | plan | task>?", with your recommended answer. In omp that closing question is the plan-mode review (see Confirmation), not an `ask`. A gate never passes silently.

### 3. Confirmation

Continue only on an explicit go-ahead. A hedged reply ("looks fine I guess") is not a go-ahead: ask what's holding them back. When an answer changes the artifact, update it and the summary, then run the gate again.

**In omp, the go-ahead is given in plan mode.** At the end of every planning phase (an epic's requirements, architecture, or story map; a story's spec, design, or plan; a task's design note), once the grill's frontier is empty:

1. Stop and ask the user to turn plan mode on (Alt+Shift+P), naming the phase whose review follows. The agent can't switch it on itself. Wait until the session reports plan mode is active; don't edit anything in the meantime.
2. Write the plan file `local://[story-id]-[phase]-plan.md` (task gates: `[story-id]-[task-id]-design-plan.md`; epic gates: `[epic-id]-[step]-plan.md`): the catch-up summary, the decisions the grill settled, the artifact's absolute path, and for a task gate its `## Design` verbatim.
3. Submit it with a write of the slug to `xd://propose`. omp opens its Plan Review: an approval (`keep` is the one that keeps this conversation's context) is the explicit go-ahead. `refine` carries the user's feedback: revise the artifact and the summary, and run the gate again. A dismissed review is not a go-ahead.
4. After an approval, plan mode is off again: record the go-ahead (below), then continue with the next step.

Batch mode (`/build auto`, "don't stop") passes one plan-mode review over all of its notes. The `/build` pipeline is not batch mode: each task keeps its checkpoints and its own plan-mode review, and only the builds overlap the reviews. Hosts without plan mode (Claude Code without it, Gemini, Codex) take the go-ahead as an answer to the closing "Proceed?" question.

**Record it.** Every gate records its go-ahead where a script can check it, so a later step reads the record instead of trusting the conversation. Record only after the explicit go-ahead, never to make a phase advance:

| Gate | Record | Check |
|---|---|---|
| A task's design | `work-state.sh approve [story-id] [task-id]` | `approved [story-id] [task-id]` |
| A story's spec, design, or plan | `work-state.sh approve-phase [story-id] spec\|design\|plan` | `approved-phase [story-id] <phase>`, and `phase` |
| An epic | Nothing to run: the `summary.md` saved at the gate. Its story stubs stay unapproved, at phase `spec`, until `/story` gates each spec. | — |

Each record is `<date> <fingerprint>`: a task's is `design_approved` in its note's `customFields`; a story phase's is `spec_approved`, `design_approved`, or `plan_approved` in the story project note's frontmatter. The fingerprint covers what was approved:

- **A task:** the description above `## Design` (ticking a checkbox doesn't count as an edit), the `## Design` section, `design_refs`, and each cited contract as its spec defines it: the whole section under the heading that names its id (`#### C1 Refund API`), else the paragraphs that mention it; for an `E` id, the same in the epic's `## Architecture`. Changing a contract voids the approval of every task that cites it: `work-state.sh cites [story-id] [contract-id]` lists them, and each one runs its gate again.
- **A story's spec:** the spec without its `## Design` section. **Its design:** that section, or `design.md` when the design lives there. **Its plan:** the plan plus the sorted ids of the task notes, so adding a task voids it.

`approved` and `approved-phase` exit 0 only while the stored fingerprint still matches; they exit 6 when nothing is recorded and 7 when the artifact changed since. Editing an approved artifact voids its approval, and the gate runs again. `phase` advances only on a recorded approval that still matches. A story that needs no design records the skip: after the user agrees (a decision brief), `approve-phase [story-id] design` with no `## Design` written.

Tasks kept in an external tracker have no task note, so `approve` and `approved` don't apply to them: see External Trackers in `work-artifacts.md`.

## Rules That Can't Be Skipped

- **Nothing is built on an unapproved design.** Before any build, the orchestrator checks that `work-state.sh phase` reports `build` and that `work-state.sh approved` exits 0 for the task (`work-state.sh ready` lists only such tasks). The `task-builder` checks `approved` again, and reports `blocked` on a non-zero exit.
- **Existing work gets a gate too.** If code or commits already exist for a task that isn't approved (built in an earlier session, by hand, or before these rules), don't continue straight to review, push, PR, merge, or a tracker comment. First write the design note describing what was built and what should change, then run the gate on it, with the approach question if another approach was possible.
- **"Don't stop" means batch, not skip.** When the user says "just build it", "don't stop", or "no questions", don't drop the design. Switch to batch mode instead: skip the step checkpoints, draft every missing note in one pass (subagents may draft), run one gate over all of them (a combined summary plus every note), record `approve-phase [story-id] plan` and `approve` each task, then build without further stops. `/build auto` works this way.
- **Stories from before approvals were recorded.** For a planned story (a spec, a plan, and task notes) with no recorded approval, `phase` prints `approvals=missing run: work-state.sh adopt-approvals [story-id]` and reports `spec`. It means the earlier gates ran without leaving a record. Ask the user whether those gates passed. Only on a yes, run the command once: it records the spec, design, and plan as they are now, and re-records every task approval whose design is unchanged. Never run it to get past a gate that didn't happen.

## Subagents Can't Hold a Gate

Only the main thread can talk to the user. So:

- Subagents that draft (designs, notes, investigations) return their draft; the main thread runs the gate on it.
- Subagents that build get an **approved** design note. A new decision that comes up mid-build is reported as `blocked`, and the main thread puts it to the user through the gate.
