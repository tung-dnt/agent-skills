---
description: Implement tasks incrementally — build, test, verify, commit. Add "auto" to run the whole plan in one approved pass.
---

Invoke the agent-skills:incremental-implementation skill alongside agent-skills:test-driven-development.

**Resolve the artifact root first.** From the project, run `bash "${CLAUDE_PLUGIN_ROOT}/hooks/work-state.sh" root`. If it reports `configured=false`, propose a location using its notes and write the config (`work-state.sh configure <storiesDir>`) only after the user confirms. Wherever this command says `docs/stories`, use the resolved `stories_dir`.

## Modes

- **`/build`** — claim and implement the *next* unclaimed task, then stop (careful, one slice at a time).
- **`/build auto`** — generate the plan if needed, get a single approval, then implement *every* task without stopping between them.

`$ARGUMENTS` selects the mode. Treat `auto` (canonical) or `all` as autonomous mode; anything else (or empty) is the default single-task mode. Note: autonomous mode is not faster *per task* — it runs the same test-driven loop — it only removes the human stepping *between* tasks.

## Default: one task

Pick and claim a task. Other sessions may be building the same plan, so claim before you start (`references/work-artifacts.md` in the plugin describes the protocol):

- **Continue your own claim first:** if you claimed a task earlier in this conversation and it isn't done, or the user just adopted one through /resume, continue it and skip picking and claiming. Never take over another claim on your own: a claim you didn't make here may belong to a live session, even when its work branch is this checkout.
- **Find the plan:** `docs/stories/[story-id]/plan.md`. If several stories have unfinished tasks, ask which one. If only a legacy `tasks/plan.md` exists, build from it in this session alone; it is not safe for parallel sessions.
- **Pick:** bring the base branch up to date (`git pull --ff-only`), then run `bash "${CLAUDE_PLUGIN_ROOT}/hooks/work-state.sh" next [story-id]`. It prints the first unclaimed pending task whose dependencies are done here; exit 4 means nothing is claimable, so stop and say so.
- **Claim:** run `bash "${CLAUDE_PLUGIN_ROOT}/hooks/work-state.sh" claim [story-id] [task-id] [work-branch]`. The work branch defaults to the current branch; for a worktree per task, name a new one. Exit 3 means another session won the race, so pick again. Exit 5 means the claim couldn't be published, so stop and report. Only after the claim succeeds, for a worktree per task, run `git worktree add -b [work-branch] ../[repo]-[task-id]` and work there. Then set `status: claimed` and `owner: [work-branch]` in the task file. A claim is yours only if you made it in this conversation; treat any other claim, even one whose work branch is this checkout, as belonging to another session.

Then:

1. Read the task file: acceptance criteria, `design_refs`, and its `## Design` note. If the note is missing and the task has business rules, external calls, or concurrency, write it first with agent-skills:low-level-design
2. Load relevant context (existing code, patterns, types)
3. Write a failing test for the expected behavior (RED)
4. Implement the minimum code to pass the test (GREEN)
5. Run the full test suite to check for regressions
6. Run the build to verify compilation
7. Set `status: done` in the task file and add one line under its `## Log`. If you stop early for any reason, still add a log line saying what's done and what's next, so /resume can pick it up
8. Commit only this task's paths, `git commit -- <task file> <code paths>`, because other sessions may share this checkout's index. Then release the lock with `bash "${CLAUDE_PLUGIN_ROOT}/hooks/work-state.sh" release [story-id] [task-id]` once `done` is on the base branch: right away if you committed on the base branch, otherwise after your work branch is merged. Stop

## Autonomous: the whole plan (`/build auto`)

Use this once a spec exists and you want to collapse plan + build into one run. It removes the manual stepping between tasks — **not** the verification. Every task still earns a passing test and its own commit.

1. **Require a spec.** Look only for a spec at a known path: `docs/stories/[story-id]/spec.md`, `SPEC.md` at the repo root, `docs/SPEC.md`, or a file under `spec/`. A README or arbitrary doc does **not** count. If none exists, stop and tell the user to run `/spec` first — do not invent requirements.
2. **Establish a clean baseline.** Run `git status --porcelain`. If there are uncommitted changes outside the expected planning artifacts (the story's files under `docs/stories/[story-id]/`, `SPEC.md`, `docs/SPEC.md`, `spec/*`, or a legacy `tasks/plan.md` / `tasks/todo.md`), stop and ask the user to commit, stash, or confirm how to handle them. Autonomous per-task commits must not absorb unrelated local work, or the clean-rollback guarantee breaks.
3. **Plan if needed.** If the story has no `docs/stories/[story-id]/plan.md`, invoke agent-skills:planning-and-task-breakdown to generate it and its task files.
4. **Single checkpoint.** Present the full plan and wait for an unambiguous affirmative (e.g. "approve", "go", "yes"). Treat hedged responses ("looks reasonable", "I guess") as **not** approved. This is the only human gate — after approval, run autonomously. If you generated the plan, commit `docs/stories/[story-id]/plan.md` and its task files as a single preparatory commit now so it doesn't bleed into the first task's commit.
5. **Execute in waves, as the orchestrator.** Delegate building to subagents and keep only their short reports in this context (`references/model-routing.md` in the plugin). Repeat until `bash "${CLAUDE_PLUGIN_ROOT}/hooks/work-state.sh" next` exits 4 and no builder is running:
   - **Fill the wave:** up to 3 tasks at a time, or the number the user asked for (never more than 5). For each one, run `next`, then `claim [story-id] [task-id] task/[story-id]/[task-id]`, and only after the claim succeeds run `git worktree add -b task/[story-id]/[task-id] ../[repo]-[task-id]`. Exit 3 means another session won, so pick again. Exit 5 means the claim couldn't be published, so stop and report.
   - **Delegate:** spawn one `agent-skills:task-builder` subagent per claimed task, and launch them back-to-back, in one turn where possible, without waiting for results, so they run concurrently. Pass paths, not content: the story id, the task id, the worktree path, the `work-state.sh` path, and the test command.
   - **Review:** for each `done` report, spawn `agent-skills:code-reviewer` on that worktree's diff against the base branch. Also spawn `agent-skills:security-auditor` when the task touches authentication, permissions, payments, secrets, or personal data. Launch a wave's reviews the same way. Send Critical findings back to a builder as a retry.
   - **Escalate:** a task that fails twice is re-run once with a builder on the main thread's model, given a summary of both failures. If it still fails, or a builder reports `blocked`, stop and ask (step 6).
   - **Integrate:** merge each reviewed work branch into the base branch in this checkout (`git merge --no-ff task/[story-id]/[task-id]`), then `release` its claim, remove its worktree, and delete the merged work branch. A merge conflict means stop and ask. Merging is what lets `next` see a finished dependency.

   Each task still ends as its own test-driven commit on its work branch, so any point is a clean rollback. Without subagents, run the same loop one task at a time in this session.
6. **Stop and ask the user** (do not push through) when:
   - a test can't be made to pass or the build breaks without an obvious fix → follow agent-skills:debugging-and-error-recovery
   - the spec is ambiguous, or a task needs a decision the spec doesn't cover
   - a task is high-risk or irreversible — auth/permission changes, destructive data migrations, payments, deletions, deploys, anything touching secrets, **or anything you can't undo with `git revert`** → follow agent-skills:doubt-driven-development and get explicit sign-off before continuing

   After the user resolves a blocker, they re-invoke `/build auto` — it resumes from the next unclaimed pending task.
7. **Summarize at the end:** tasks completed, tests added, commits made, and anything skipped, flagged, or left for the user.

If any step fails, follow the agent-skills:debugging-and-error-recovery skill.
