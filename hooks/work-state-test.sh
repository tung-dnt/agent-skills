#!/bin/bash
# work-state-test.sh — Tests for hooks/work-state.sh: artifact root resolution,
# claiming across sessions, worktrees, and machines, the ticked status tree,
# and the SessionStart hint. Every test builds throwaway git repositories.
#
# Run: bash hooks/work-state-test.sh

set -euo pipefail

PASS=0 FAIL=0
TMP=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$TMP"' EXIT
SCRIPT="$(cd "$(dirname "$0")" && pwd)/work-state.sh"
# Run under the system bash so bash-4-only syntax fails here (macOS ships 3.2).
BASH_BIN=/bin/bash

ok()    { PASS=$((PASS + 1)); printf '  ✓ %s\n' "$1"; }
bad()   { FAIL=$((FAIL + 1)); printf '  ✗ %s\n' "$1"; printf '%s\n' "$2" | sed 's/^/      /'; }
has()   { if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else bad "$1" "$2"; fi; }
lacks() { if printf '%s' "$2" | grep -qF -- "$3"; then bad "$1" "$2"; else ok "$1"; fi; }
ws()    { "$BASH_BIN" "$SCRIPT" "$@" 2>&1 || true; }
code()  { set +e; "$BASH_BIN" "$SCRIPT" "$@" >/dev/null 2>&1; echo $?; set -e; }

git_id() { git config user.email t@example.invalid && git config user.name Test; }
new_repo() {
  local d="$TMP/$1"
  mkdir -p "$d" && cd "$d"
  git init --quiet -b main && git_id
  git commit --quiet --allow-empty -m init
}

task_file() { # story task status deps [extra body]
  mkdir -p "docs/stories/$1/tasks"
  printf -- '---\nid: %s\nstory: %s\nstatus: %s\ndepends_on: [%s]\ndesign_refs: []\nowner:\n---\n\n## Task %s\n%b\n' \
    "$2" "$1" "$3" "${4:-}" "$2" "${5:-}" > "docs/stories/$1/tasks/$2.md"
}
set_status() { sed -i.bak "s/^status: .*/status: $3/" "docs/stories/$1/tasks/$2.md" && rm -f "docs/stories/$1/tasks/$2.md.bak"; }

echo "root and configure"
new_repo root
out=$(ws root)
has "defaults to docs/stories" "$out" "stories_dir=docs/stories"
has "reports unconfigured" "$out" "configured=false"
mkdir -p specs tasks && touch tasks/plan.md
out=$(ws root)
has "notes an existing spec directory" "$out" "existing spec directory: specs"
has "notes the legacy single-plan layout" "$out" "legacy single-plan layout: tasks/plan.md"
mkdir -p docs/stories
has "detects an existing docs/stories" "$(ws root)" "source=detected"
has "configure normalizes ./ and trailing slashes" "$(ws configure ./work/stories/ work/epics)" "storiesDir=work/stories"
out=$(ws root)
has "reads storiesDir from config" "$out" "stories_dir=work/stories"
has "reports configured" "$out" "configured=true"
has "configure rejects absolute paths" "$(ws configure /abs)" "relative path inside the repository"
has "configure rejects escaping paths" "$(ws configure ../x)" "relative path inside the repository"
has "configure rejects quotes" "$(ws configure 'a"b')" "may not contain quotes"
mkdir -p sub/dir && cd sub/dir
has "resolves from a subdirectory" "$(ws root)" "stories_dir=work/stories"

echo "next, claim, release (one checkout)"
new_repo claims
task_file pay t01-model pending
task_file pay t02-api pending t01-model
task_file pay t03-docs pending
git add -A && git commit --quiet -m plan
has "next picks the first pending task" "$(ws next)" "pay/t01-model"
has "claim takes the lock" "$(ws claim pay t01-model)" "claimed: pay/t01-model work=main id="
has "claim is a namespaced ref" "$(git for-each-ref --format='%(refname)' refs/heads/claim)" "refs/heads/claim/pay/t01-model"
has "second claim of the same task is refused (exit 3)" "$(code claim pay t01-model)" "3"
has "next skips claimed tasks and unmet dependencies" "$(ws next)" "pay/t03-docs"
has "next can be scoped to a story" "$(ws next pay)" "pay/t03-docs"
git branch pay
has "a branch named after the story does not block claims" "$(ws claim pay t03-docs)" "claimed: pay/t03-docs"
has "next exits 4 when nothing is claimable" "$(code next)" "4"
out=$(ws status pay)
has "claimed task shows its lock and work branch" "$out" "[~] t01-model claimed: claim/pay/t01-model · work main"
set_status pay t01-model done
has "done in this checkout shows as done before release" "$(ws status pay)" "[x] t01-model"
has "release drops the lock" "$(ws release pay t01-model)" "released: pay/t01-model"
lacks "released task shows no claim" "$(ws status pay)" "claim/pay/t01-model"
git add -A && git commit --quiet -m "t01 done"
has "dependency done here unlocks the next task" "$(ws next)" "pay/t02-api"
sed -i.bak 's/^status: .*/status: "done"/' docs/stories/pay/tasks/t03-docs.md && rm docs/stories/pay/tasks/t03-docs.md.bak
has "quoted status values are understood" "$(ws status pay)" "[x] t03-docs"

printf -- '---\nid: t04-block\nstory: pay\nstatus: pending\ndepends_on:\n  - t05-missing\n---\n' > docs/stories/pay/tasks/t04-block.md
lacks "block-style depends_on is honoured" "$(ws next pay)" "pay/t04-block"

echo "brief"
new_repo brief
mkdir -p docs/stories/ship/tasks
printf '# Spec\n\n- FR2: customer sees status\n- FR9: unrelated\n\n## Design\n\nComponents: api, worker.\n\nState transitions (C3):\n\n| from | to |\n|---|---|\n| a | b |\n\nIdempotency (C5): unique key.\n\nRetention (C7): 13 months.\n' > docs/stories/ship/spec.md
printf '| t02-apply | apply | t01 | C3, C5 |\n| t03-read | read | t02 | - |\n' > docs/stories/ship/plan.md
task_file ship t02-apply pending "" 'Implements FR2.'
sed -i.bak 's/^design_refs: .*/design_refs: [C3, C5]/' docs/stories/ship/tasks/t02-apply.md && rm docs/stories/ship/tasks/t02-apply.md.bak
git add -A && git commit --quiet -m plan
out=$(ws brief ship t02-apply)
has "brief includes the task file" "$out" "== task docs/stories/ship/tasks/t02-apply.md"
has "brief includes the plan row" "$out" "| t02-apply | apply |"
has "brief includes a cited contract and its table" "$out" "| a | b |"
has "brief includes every cited contract" "$out" "Idempotency (C5): unique key."
lacks "brief omits uncited contracts" "$out" "Retention (C7)"
lacks "brief omits unrelated spec text" "$out" "Components: api, worker."
has "brief includes requirements the task names" "$out" "FR2: customer sees status"
lacks "brief omits other requirements" "$out" "FR9"

echo "phase"
new_repo phase
has "no story directory is phase none" "$(ws phase cart)" "phase=none"
mkdir -p docs/stories/cart
has "no spec is phase spec" "$(ws phase cart)" "phase=spec"
printf '# Spec\n- FR1: add item\n' > docs/stories/cart/spec.md
has "spec without design is phase design" "$(ws phase cart)" "phase=design"
printf '\n## Design\nC1: cart API.\n' >> docs/stories/cart/spec.md
has "design without plan is phase plan" "$(ws phase cart)" "phase=plan"
printf '# Plan\n' > docs/stories/cart/plan.md
has "plan without task files is still phase plan" "$(ws phase cart)" "phase=plan"
task_file cart t01-add pending
task_file cart t02-remove done
out=$(ws phase cart)
has "open tasks are phase build" "$out" "phase=build"
has "phase build counts open tasks" "$out" "open_tasks=1"
set_status cart t01-add done
has "all tasks done is phase done" "$(ws phase cart)" "phase=done"
mkdir -p docs/stories/tiny && printf '# Spec\n- FR1: one change\n' > docs/stories/tiny/spec.md && printf '# Plan\n' > docs/stories/tiny/plan.md
task_file tiny t01-change pending
has "a planned story without a design section is phase build" "$(ws phase tiny)" "phase=build"

echo "design approval"
new_repo approval
task_file pay t01-refund pending "" '\n## Design\n<!-- low-level-design note, added just before implementation -->\n\n## Summary\n'
git add -A && git commit --quiet -m plan
has "approve refuses an empty design" "$(ws approve pay t01-refund)" "Design section is empty"
has "unapproved task exits 6" "$(code approved pay t01-refund)" "6"
has "status marks an unapproved design" "$(ws status pay)" "t01-refund · design ✗"
has "brief shows missing approval" "$(ws brief pay t01-refund)" "== approval: missing"
sed -i.bak 's/^<!-- low-level-design note, added just before implementation -->$/- Edge: refund(id, amount)\n- Rules: amount <= remaining/' docs/stories/pay/tasks/t01-refund.md && rm docs/stories/pay/tasks/t01-refund.md.bak
has "approve records the approval" "$(ws approve pay t01-refund)" "approved: pay/t01-refund"
has "approval is stored in the frontmatter" "$(sed -n '1,/^---$/p' docs/stories/pay/tasks/t01-refund.md; sed -n 2,9p docs/stories/pay/tasks/t01-refund.md)" "design_approved: "
has "approved task exits 0" "$(code approved pay t01-refund)" "0"
has "status marks an approved design" "$(ws status pay)" "t01-refund · design ✓"
has "brief shows the approval" "$(ws brief pay t01-refund)" "== approval: ok"
printf -- '- Note: summaries are not part of the design\n' >> docs/stories/pay/tasks/t01-refund.md
has "editing another section keeps the approval" "$(code approved pay t01-refund)" "0"
sed -i.bak 's/^- Rules: amount <= remaining$/- Rules: amount <= remaining\n- Failure: provider timeout -> PENDING/' docs/stories/pay/tasks/t01-refund.md && rm docs/stories/pay/tasks/t01-refund.md.bak
has "editing the design after approval voids it (exit 7)" "$(code approved pay t01-refund)" "7"
has "status flags a design changed since approval" "$(ws status pay)" "design ✗ (changed since approval)"
ws approve pay t01-refund >/dev/null
has "re-approving restores it" "$(code approved pay t01-refund)" "0"
has "re-approving keeps one approval line" "$(grep -c '^design_approved:' docs/stories/pay/tasks/t01-refund.md)" "1"
git add -A && git commit --quiet -m approved
# In worktree mode the approval is read from, and written to, the work branch's worktree.
task_file pay t02-report pending "" '\n## Design\n- Edge: report()\n'
git add -A && git commit --quiet -m t02
git worktree add --quiet -b feat-report "$TMP/wt-report"
(cd "$TMP/wt-report" && "$BASH_BIN" "$SCRIPT" claim pay t02-report feat-report >/dev/null && "$BASH_BIN" "$SCRIPT" approve pay t02-report >/dev/null)
has "approval made in the worktree is seen from the main checkout" "$(code approved pay t02-report)" "0"
lacks "main checkout's copy was not touched" "$(cat docs/stories/pay/tasks/t02-report.md)" "design_approved"

echo "worktrees"
new_repo wt
task_file shop t01-cart pending
task_file shop t02-pay pending
git add -A && git commit --quiet -m plan
git worktree add --quiet -b feat-cart "$TMP/wt-cart"
(cd "$TMP/wt-cart" && "$BASH_BIN" "$SCRIPT" claim shop t01-cart feat-cart >/dev/null)
# The builder edits the task file in its worktree and has not committed yet.
(cd "$TMP/wt-cart" && task_file shop t01-cart claimed "" '\n## Subtasks\n- [x] model\n- [ ] ui\n\n## Log\n- wrote model; next: ui')
out=$(ws status shop)
has "status reads uncommitted progress from the worktree" "$out" "last log: - wrote model; next: ui"
has "status shows subtasks from the worktree" "$out" "subtasks 1/2"
has "status names the worktree" "$out" "worktree $TMP/wt-cart"
has "claim is visible from every worktree" "$(code claim shop t01-cart)" "3"
(cd "$TMP/wt-cart" && set_status shop t01-cart blocked)
has "blocked task keeps its claim and is flagged" "$(ws status shop)" "[!] t01-cart claimed: claim/shop/t01-cart"
(cd "$TMP/wt-cart" && set_status shop t01-cart done && git add -A && git commit --quiet -m "t01 done")
has "done on an unmerged work branch is labelled" "$(ws status shop)" "not yet merged"
git merge --quiet --no-edit feat-cart
has "done and merged work branch asks for release" "$(ws status shop)" "merged, release the lock"

echo "two machines"
git init --quiet --bare "$TMP/remote.git"
new_repo seed
task_file api t01-a pending
task_file api t02-b pending
git add -A && git commit --quiet -m plan
git remote add origin "$TMP/remote.git" && git push --quiet origin main
git clone --quiet "$TMP/remote.git" "$TMP/machine-a" && (cd "$TMP/machine-a" && git_id)
git clone --quiet "$TMP/remote.git" "$TMP/machine-b" && (cd "$TMP/machine-b" && git_id)
cd "$TMP/machine-a"
has "machine A claims and publishes" "$(ws claim api t01-a)" "claimed: api/t01-a"
cd "$TMP/machine-b"
has "machine B sees the remote claim" "$(code claim api t01-a)" "3"
has "machine B's next skips it" "$(ws next)" "api/t02-b"
# Machine B can't fetch, so it doesn't know about A's claim; the push lease must still refuse it.
git update-ref -d refs/remotes/origin/claim/api/t01-a 2>/dev/null || true
git remote set-url origin "$TMP/nowhere.git" && git remote set-url --push origin "$TMP/remote.git"
has "an unseen remote claim loses the push race" "$(code claim api t01-a)" "3"
lacks "the losing local lock is removed" "$(git for-each-ref refs/heads/claim)" "claim/api/t01-a"
git remote set-url origin "$TMP/remote.git" && git remote set-url --push origin "$TMP/remote.git"
git fetch --quiet origin
cd "$TMP/machine-a" && ws release api t01-a >/dev/null
cd "$TMP/machine-b"
has "a released remote claim is pruned and claimable again" "$(ws next)" "api/t01-a"
# An unreachable remote is an error (exit 5), not a lost race, and leaves no lock behind.
git remote set-url origin "$TMP/nowhere.git" && git remote set-url --push origin "$TMP/nowhere.git"
has "unreachable remote is exit 5, not 3" "$(code claim api t02-b)" "5"
lacks "failed publish leaves no local lock" "$(git for-each-ref refs/heads/claim)" "claim/api/t02-b"
git remote set-url origin "$TMP/remote.git" && git remote set-url --push origin "$TMP/remote.git"
# A pre-push hook for code must not block publishing a claim.
mkdir -p .git/hooks && printf '#!/bin/sh\nexit 1\n' > .git/hooks/pre-push && chmod +x .git/hooks/pre-push
has "pre-push hook does not block a claim" "$(ws claim api t02-b)" "claimed: api/t02-b"
rm -f .git/hooks/pre-push

echo "hint"
new_repo hint
has "silent outside a story layout" "[$(ws hint)]" "[]"
task_file shop t01-cart pending
git add -A && git commit --quiet -m plan
has "silent when nothing is claimed" "[$(ws hint)]" "[]"
git checkout --quiet -b feat-x
ws claim shop t01-cart feat-other >/dev/null
out=$(ws hint)
has "lists claims when this branch isn't a work branch" "$out" "Tasks are claimed in this repository: shop/t01-cart"
has "hint uses the SessionStart envelope" "$out" '"hookEventName": "SessionStart"'
ws release shop t01-cart >/dev/null && ws claim shop t01-cart feat-x >/dev/null
out=$(ws hint)
has "on a work branch it lists the task without claiming ownership" "$out" "with this checkout (feat-x) as their work branch: shop/t01-cart"
has "hint warns another session may hold it" "$out" "Another session may still be working on them"
if command -v python3 >/dev/null 2>&1; then
  if printf '%s' "$out" | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then ok "hint output is valid JSON"; else bad "hint output is valid JSON" "$out"; fi
fi
cd "$TMP"
has "silent outside git" "[$(ws hint)]" "[]"

echo "status tree"
new_repo tree
mkdir -p docs/stories/payouts docs/stories/refunds
printf -- '---\nepic: payments\n---\n# Plan\n' > docs/stories/payouts/plan.md
printf -- '---\nepic: payments\n---\n# Plan\n' > docs/stories/refunds/plan.md
task_file payouts t01-model done
task_file payouts t02-transfer pending
task_file refunds t01-refund done
task_file misc t01-chore pending
git add -A && git commit --quiet -m plan
ws claim payouts t02-transfer >/dev/null
out=$(ws status)
has "epic groups its stories" "$out" "[~] epic payments  1/2 stories"
has "finished story is ticked" "$out" "  [x] story refunds  1/1 tasks"
has "story in progress shows counts" "$out" "  [~] story payouts  1/2 tasks"
has "stories without an epic are listed" "$out" "(no epic)"
has "unknown story is an error" "$(ws status nope)" "no story 'nope'"

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
