---
name: grill-me
description: Grill the user relentlessly about a plan, decision, or idea they already have, working it as a design tree in rounds until every branch is settled. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases ("grill me", "grill this plan", "stress-test my thinking").
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.

Format a round like so:

```
❓ **Q1** - **<question title>**: <question body: what's being decided and why it matters now>

| Option | How it works | Pros | Cons / risks | Effort | Reversible |
|---|---|---|---|---|---|
| A <name> | … | … | … | S / M / L | easy / hard, and why |
| B <name> | … | … | … | … | … |

**Hinges on:** <the one or two facts or priorities that decide it>

➡️ <your recommended answer, and why it wins on what it hinges on>. **Choose <other> instead if** <the condition that would flip it>.

---

❓ **Q2** - **<question title>**: <question body>

<options table, hinges on, recommendation, as above>
```

Every question gets the trade-off table, with at least two real options, cells backed by evidence (guesses marked "(est.)"), and the condition that would flip your recommendation. The user should be able to disagree with you from the table alone. A plain yes/no confirmation ("Proceed?") is the only exception. **Hinges on** names facts or priorities, never another open question. If a question hinges on an answer you haven't heard yet, it belongs to a later round.

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it; don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.
