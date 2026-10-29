# Jev shadow pilot

Records what TypeSafe's [Jev](https://docs.typesafe.ai/models) decision model would answer at two workflow hand-offs, next to what actually happened. It never changes the workflow: no checkpoint is skipped and no scope is chosen because of it. The log tells you later whether Jev's probabilities are good enough to act on, and at which threshold.

| Hand-off | Jev question | Outcome recorded after |
|---|---|---|
| Step checkpoint (`references/approval-gate.md`) | Yes/no: does this step leave a decision open? (`p_open`) | The user's reply: `decision` when the checkpoint asked a decision or the reply changed the step, otherwise `none` |
| Scope check (`references/work-artifacts.md`) | Choice: `epic`, `story`, or `task` | The scope is settled: the command the work continues under |

## Setup

Off by default. Turn it on in the per-machine agent-skills config (`~/.config/agent-skills/config.json`, or `$AGENT_SKILLS_CONFIG`), next to `vault`:

```json
{
  "vault": "/abs/vault",
  "jev": {
    "enabled": true,
    "deny": ["client-*", "*-records"],
    "model": "jev-1.13.0"
  }
}
```

and export `TYPESAFE_API_KEY` (from `console.typesafe.ai`). Only `api.typesafe.ai` is TypeSafe; lookalike sites (jevmodel.net, thejevai.com, jevai.org, jev-agent.org, jevtypesafeai.com) are third parties.

- **`deny`:** case-insensitive globs matched against the repository's main worktree folder and its `origin` repo name. A match sends nothing. Keep every repository that can hold personal or patient data on this list until your data-protection review has approved TypeSafe as a processor (requests are processed in the US; zero data retention is an enterprise option).
- **`model`:** pinned by default, because the `jev-latest` alias moves and would shift recorded probabilities.
- Outside a git repository nothing is sent.

## Commands

Run from inside the project. Needs `node` or `bun`.

```
bash [plugin-root]/hooks/jev.sh status
bash [plugin-root]/hooks/jev.sh checkpoint - --step "3/11 Components" --story [story-id] [--task [task-id]]   # step text on stdin
bash [plugin-root]/hooks/jev.sh scope -                                                                   # request text on stdin
bash [plugin-root]/hooks/jev.sh outcome [id] decision|none|epic|story|task
bash [plugin-root]/hooks/jev.sh report
```

A prediction prints `jev=<id> …` and logs it; save the id for `outcome`. When it can't or mustn't run it prints `jev=skipped reason=<disabled|no-repo|denied:<name>|no-key|timeout|network|http-NNN|bad-response|no-runtime>`, exits 0, and there is nothing more to do. Requests time out after 10 seconds.

`report` pairs each prediction with its latest outcome. For checkpoints it shows, per `p_open` threshold, how many stops would have been skipped and how many of those had a decision. For scope it shows agreement with the settled scope, overall and by confidence.

## Log

`~/.local/state/agent-skills/jev-shadow.jsonl` (or `$AGENT_SKILLS_JEV_LOG`), one JSON object per line. Predictions store the step, story, task, repository, model, and Jev's answer; the text sent is stored only as a SHA-256 and a length.
