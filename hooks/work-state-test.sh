#!/bin/bash
# work-state-test.sh — Tests for hooks/work-state.sh: store resolution (vault
# or repository), dotpm notes, claiming across sessions, worktrees, and
# machines, the ticked status tree, migration from the old layout, and the
# SessionStart hint. Every test builds throwaway git repositories and vaults.
#
# Run: bash hooks/work-state-test.sh

set -euo pipefail

PASS=0 FAIL=0
TMP=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$TMP"' EXIT
SCRIPT="$(cd "$(dirname "$0")" && pwd)/work-state.sh"
# Run under the system bash so bash-4-only syntax fails here (macOS ships 3.2).
BASH_BIN=/bin/bash
# No user config unless a test writes one: the repository store.
export AGENT_SKILLS_CONFIG="$TMP/user-config.json"

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

story() { ws init-story "$@" >/dev/null; }                 # story title [epic]
task() { ws new-task "$@" >/dev/null; }                    # story title [dep...]
set_status() { ws set "$1" "$2" "$3" >/dev/null; }
note() { echo "docs/stories/$1/_tasks/$2.md"; }
# Insert TEXT (printf %b) as the line after "## NAME" in FILE.
after_heading() {
  local file="$1" text
  text="$(printf '%b' "$3")"
  TEXT="$text" awk -v h="## $2" '{ print } $0 == h { print ENVIRON["TEXT"] }' "$file" > "$file.t" && mv "$file.t" "$file"
}
# Insert TEXT as the task description, above "## Design".
describe() {
  local file="$1"
  TEXT="$2" awk '$0 == "## Design" && !d { print ENVIRON["TEXT"]; print ""; d = 1 } { print }' "$file" > "$file.t" && mv "$file.t" "$file"
}
new_vault() { # dir [projectsFolder]
  mkdir -p "$1/.obsidian/plugins/project-manager"
  if [ -n "${2:-}" ]; then printf '{\n  "projectsFolder": "%s",\n  "peopleFolder": "People"\n}\n' "$2" > "$1/.obsidian/plugins/project-manager/data.json"; fi
  printf '{\n  "vault": "%s"\n}\n' "$1" > "$AGENT_SKILLS_CONFIG"
}
no_vault() { rm -f "$AGENT_SKILLS_CONFIG"; }

echo "root and configure (repository store)"
new_repo root
out=$(ws root)
has "no vault means the repository store" "$out" "store=repo"
has "defaults to docs/stories, as an absolute path" "$out" "stories_dir=$TMP/root/docs/stories"
has "reports unconfigured" "$out" "configured=false"
mkdir -p specs tasks && touch tasks/plan.md
out=$(ws root)
has "notes an existing spec directory" "$out" "existing spec directory: specs"
has "notes the legacy single-plan layout" "$out" "legacy single-plan layout: tasks/plan.md"
mkdir -p docs/stories
has "detects an existing docs/stories" "$(ws root)" "source=detected"
mkdir -p docs/stories/old/tasks && touch docs/stories/old/tasks/t01-a.md
has "notes the old task layout" "$(ws root)" "old task layout under docs/stories: run work-state.sh migrate"
rm -rf docs/stories/old
has "configure normalizes ./ and trailing slashes" "$(ws configure ./work/stories/ work/epics)" "storiesDir=work/stories"
out=$(ws root)
has "reads storiesDir from config" "$out" "stories_dir=$TMP/root/work/stories"
has "reports configured" "$out" "configured=true"
has "configure rejects absolute paths" "$(ws configure /abs)" "relative path inside the repository"
has "configure rejects escaping paths" "$(ws configure ../x)" "relative path inside the repository"
has "configure rejects quotes" "$(ws configure 'a"b')" "may not contain quotes"
printf '{\n  "storiesDir": "work/stories",\n  "store": "repo",\n  "vaultFolder": "grp/app"\n}\n' > .agent-skills.json
ws configure s2 >/dev/null
has "configure keeps the store key" "$(cat .agent-skills.json)" '"store": "repo"'
has "configure keeps the vaultFolder key" "$(cat .agent-skills.json)" '"vaultFolder": "grp/app"'
mkdir -p sub/dir && cd sub/dir
has "resolves from a subdirectory" "$(ws root)" "stories_dir=$TMP/root/s2"

echo "dotpm notes"
new_repo notes
has "new-task needs the story's project note" "$(ws new-task pay 'T01 model')" "run work-state.sh init-story first"
has "init-story creates the project note" "$(ws init-story pay 'Payments')" "created: $TMP/notes/docs/stories/pay/pay.md"
has "init-story is idempotent" "$(ws init-story pay 'Payments')" "exists: "
proj=$(cat docs/stories/pay/pay.md)
has "project note is a dotpm project" "$proj" "pm-project: true"
has "project note declares the agent's custom fields" "$proj" '  - id: "design_approved"'
out=$(ws new-task pay 'T01 model')
has "new-task derives the id from the title" "$out" "task=t01-model"
has "new-task prints the note path" "$out" "path=$TMP/notes/docs/stories/pay/_tasks/t01-model.md"
task pay 'T02 api' t01-model
t=$(cat "$(note pay t02-api)")
has "task note is a dotpm task" "$t" "pm-task: true"
has "task links its project" "$t" 'projectId: "[[pay|Payments]]"'
has "task title is quoted" "$t" 'title: "T02 api"'
has "new tasks start as todo" "$t" "status: todo"
has "tasks are tagged with their story" "$t" "  - story/pay"
has "dependencies are wikilinks with titles" "$t" '  - "[[t01-model|T01 model]]"'
has "task note has the agent sections" "$t" "## Checklist"
lacks "task note never has a ## Subtasks heading" "$t" "## Subtasks"
has "task note ends with the dotpm footer" "$(tail -n 1 "$(note pay t02-api)")" "Project: [[pay|Payments]]"
proj=$(cat docs/stories/pay/pay.md)
has "project note lists task ids" "$proj" 'taskIds: ["[[t01-model|T01 model]]", "[[t02-api|T02 api]]"]'
has "project note lists tasks in order" "$(sed -n '/^## Tasks/,$p' docs/stories/pay/pay.md)" "- [ ] [[t01-model|T01 model]]
- [ ] [[t02-api|T02 api]]"
has "a duplicate task is refused" "$(ws new-task pay 'T01 model')" "already exists"
has "an unknown dependency is refused" "$(ws new-task pay 'T03 docs' t09-nope)" "unknown dependency pay/t09-nope"
has "titles slug like dotpm" "$(ws new-task pay 'T04 Fix: a/b  "x"')" 'task=t04-fix--a-b--x-'
has "path prints the task note" "$(ws path pay t01-model)" "$TMP/notes/docs/stories/pay/_tasks/t01-model.md"
has "path prints the story directory" "$(ws path pay)" "$TMP/notes/docs/stories/pay"

echo "set, log, field"
new_repo setlog
story shop 'Shop'
task shop 'T01 cart'
f=$(note shop t01-cart)
has "set validates the status" "$(ws set shop t01-cart claimed)" "status must be one of"
set_status shop t01-cart done
has "done sets progress to 100" "$(cat "$f")" "progress: 100"
has "done records the completion date" "$(cat "$f")" "completed: $(date +%Y-%m-%d)"
set_status shop t01-cart todo
lacks "reopening drops the completion date" "$(cat "$f")" "completed:"
after_heading "$f" Checklist '- [x] model\n- [ ] ui'
ws log shop t01-cart "wrote model; next: ui" >/dev/null
has "log appends a dated line" "$(sed -n '/^## Log/,$p' "$f")" "- $(date +%Y-%m-%d) wrote model; next: ui"
has "log line stays above the footer" "$(tail -n 3 "$f" | head -n 1)" "wrote model"
has "progress follows the checklist" "$(cat "$f")" "progress: 50"
ws log shop t01-cart "second" >/dev/null
has "log lines keep their order" "$(sed -n '/^## Log/,/^Project/p' "$f" | grep -c "$(date +%Y-%m-%d)")" "2"
ws field shop t01-cart design_refs "C3, C5" >/dev/null
has "field writes customFields" "$(sed -n '/^customFields:/,/^---/p' "$f")" '  design_refs: "C3, C5"'
ws field shop t01-cart design_refs "C4" >/dev/null
has "field replaces a value" "$(grep -c 'design_refs:' "$f")" "1"
has "field rejects odd names" "$(ws field shop t01-cart 'a b' x)" "field names are"

echo "next, claim, release (one checkout)"
new_repo claims
story pay 'Payments'
task pay 'T01 model'
task pay 'T02 api' t01-model
task pay 'T03 docs'
git add -A && git commit --quiet -m plan
has "next picks the first todo task" "$(ws next)" "pay/t01-model"
has "claim takes the lock" "$(ws claim pay t01-model)" "claimed: pay/t01-model work=main id="
has "claim is a namespaced ref" "$(git for-each-ref --format='%(refname)' refs/heads/claim)" "refs/heads/claim/pay/t01-model"
has "claim marks the task in progress" "$(cat "$(note pay t01-model)")" "status: in-progress"
has "claim records the work branch" "$(cat "$(note pay t01-model)")" '  branch: "main"'
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
sed -i.bak 's/^status: .*/status: "cancelled"/' "$(note pay t03-docs)" && rm "$(note pay t03-docs).bak"
has "quoted status values are understood" "$(ws status pay)" "[x] t03-docs cancelled"
task pay 'T04 block' t02-api
set_status pay t02-api review
lacks "a dependency in review is not finished" "$(ws next pay)" "pay/t04-block"
has "review shows as in progress" "$(ws status pay)" "[~] t02-api review"

echo "brief"
new_repo brief
story ship 'Shipping'
printf '# Spec\n\n- FR2: customer sees status\n- FR9: unrelated\n\n## Design\n\nComponents: api, worker.\n\nState transitions (C3):\n\n| from | to |\n|---|---|\n| a | b |\n\nIdempotency (C5): unique key.\n\nRetention (C7): 13 months.\n' > docs/stories/ship/spec.md
printf '| t02-apply | apply | t01 | C3, C5 |\n| t03-read | read | t02 | - |\n' > docs/stories/ship/plan.md
task ship 'T02 apply'
describe "$(note ship t02-apply)" 'Implements FR2.'
ws field ship t02-apply design_refs "C3, C5" >/dev/null
git add -A && git commit --quiet -m plan
out=$(ws brief ship t02-apply)
has "brief includes the task note" "$out" "== task $TMP/brief/docs/stories/ship/_tasks/t02-apply.md"
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
story cart 'Cart'
has "no spec is phase spec" "$(ws phase cart)" "phase=spec"
printf '# Spec\n- FR1: add item\n' > docs/stories/cart/spec.md
has "spec without design is phase design" "$(ws phase cart)" "phase=design"
printf '\n## Design\nC1: cart API.\n' >> docs/stories/cart/spec.md
has "design without plan is phase plan" "$(ws phase cart)" "phase=plan"
printf '# Plan\n' > docs/stories/cart/plan.md
has "plan without task notes is still phase plan" "$(ws phase cart)" "phase=plan"
task cart 'T01 add'
task cart 'T02 remove'
set_status cart t02-remove done
out=$(ws phase cart)
has "open tasks are phase build" "$out" "phase=build"
has "phase build counts open tasks" "$out" "open_tasks=1"
set_status cart t01-add cancelled
has "done and cancelled tasks make phase done" "$(ws phase cart)" "phase=done"
story tiny 'Tiny'
printf '# Spec\n- FR1: one change\n' > docs/stories/tiny/spec.md && printf '# Plan\n' > docs/stories/tiny/plan.md
task tiny 'T01 change'
has "a planned story without a design section is phase build" "$(ws phase tiny)" "phase=build"

echo "design approval"
new_repo approval
story pay 'Payments'
task pay 'T01 refund'
f=$(note pay t01-refund)
after_heading "$f" Design '<!-- low-level-design note, added just before implementation -->'
git add -A && git commit --quiet -m plan
has "approve refuses an empty design" "$(ws approve pay t01-refund)" "Design section is empty"
has "unapproved task exits 6" "$(code approved pay t01-refund)" "6"
has "status marks an unapproved design" "$(ws status pay)" "t01-refund · design ✗"
has "brief shows missing approval" "$(ws brief pay t01-refund)" "== approval: missing"
after_heading "$f" Design '- Edge: refund(id, amount)\n- Rules: amount <= remaining'
has "approve records the approval" "$(ws approve pay t01-refund)" "approved: pay/t01-refund"
has "approval is stored in customFields" "$(sed -n '/^customFields:/,/^---/p' "$f")" "  design_approved: "
has "approved task exits 0" "$(code approved pay t01-refund)" "0"
has "status marks an approved design" "$(ws status pay)" "t01-refund · design ✓"
has "brief shows the approval" "$(ws brief pay t01-refund)" "== approval: ok"
after_heading "$f" Summary '- Note: summaries are not part of the design'
ws log pay t01-refund "logging is not part of the design" >/dev/null
has "editing other sections keeps the approval" "$(code approved pay t01-refund)" "0"
after_heading "$f" Design '- Failure: provider timeout -> PENDING'
has "editing the design after approval voids it (exit 7)" "$(code approved pay t01-refund)" "7"
has "status flags a design changed since approval" "$(ws status pay)" "design ✗ (changed since approval)"
ws approve pay t01-refund >/dev/null
has "re-approving restores it" "$(code approved pay t01-refund)" "0"
has "re-approving keeps one approval line" "$(grep -c 'design_approved:' "$f")" "1"
git add -A && git commit --quiet -m approved
# In worktree mode the approval is read from, and written to, the work branch's worktree.
task pay 'T02 report'
after_heading "$(note pay t02-report)" Design '- Edge: report()'
git add -A && git commit --quiet -m t02
git worktree add --quiet -b feat-report "$TMP/wt-report"
(cd "$TMP/wt-report" && "$BASH_BIN" "$SCRIPT" claim pay t02-report feat-report >/dev/null && "$BASH_BIN" "$SCRIPT" approve pay t02-report >/dev/null)
has "approval made in the worktree is seen from the main checkout" "$(code approved pay t02-report)" "0"
lacks "main checkout's copy was not touched" "$(cat "$(note pay t02-report)")" "design_approved"

echo "worktrees"
new_repo wt
story shop 'Shop'
task shop 'T01 cart'
task shop 'T02 pay'
git add -A && git commit --quiet -m plan
git worktree add --quiet -b feat-cart "$TMP/wt-cart"
(cd "$TMP/wt-cart" && "$BASH_BIN" "$SCRIPT" claim shop t01-cart feat-cart >/dev/null)
has "claim from a worktree marks the worktree's copy" "$(cat "$TMP/wt-cart/$(note shop t01-cart)")" "status: in-progress"
lacks "claim leaves the main checkout's copy alone" "$(cat "$(note shop t01-cart)")" "in-progress"
has "path points at the worktree copy" "$(ws path shop t01-cart)" "$TMP/wt-cart/docs/stories/shop/_tasks/t01-cart.md"
out=$(ws claim shop t02-pay feat-pay)
has "claiming for a branch with no checkout yet says how to mark it" "$out" "run there: work-state.sh set shop t02-pay in-progress"
lacks "and leaves this checkout's note alone" "$(cat "$(note shop t02-pay)")" "in-progress"
git worktree add --quiet -b feat-pay "$TMP/wt-pay"
(cd "$TMP/wt-pay" && "$BASH_BIN" "$SCRIPT" set shop t02-pay in-progress >/dev/null)
has "set in-progress from the worktree records the claim's branch" "$(cat "$TMP/wt-pay/$(note shop t02-pay)")" '  branch: "feat-pay"'
# The builder edits the task note in its worktree and has not committed yet.
after_heading "$TMP/wt-cart/$(note shop t01-cart)" Checklist '- [x] model\n- [ ] ui'
ws log shop t01-cart "wrote model; next: ui" >/dev/null
out=$(ws status shop)
has "status reads uncommitted progress from the worktree" "$out" "last log: - $(date +%Y-%m-%d) wrote model; next: ui"
has "status shows the checklist from the worktree" "$out" "checklist 1/2"
has "status names the worktree" "$out" "worktree $TMP/wt-cart"
has "claim is visible from every worktree" "$(code claim shop t01-cart)" "3"
set_status shop t01-cart blocked
has "blocked task keeps its claim and is flagged" "$(ws status shop)" "[!] t01-cart claimed: claim/shop/t01-cart"
set_status shop t01-cart done
(cd "$TMP/wt-cart" && git add -A && git commit --quiet -m "t01 done")
has "done on an unmerged work branch is labelled" "$(ws status shop)" "not yet merged"
git merge --quiet --no-edit feat-cart
has "done and merged work branch asks for release" "$(ws status shop)" "merged, release the lock"

echo "two machines"
git init --quiet --bare "$TMP/remote.git"
new_repo seed
story api 'API'
task api 'T01 a'
task api 'T02 b'
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
lacks "a lost race leaves the task note alone" "$(cat "$(note api t01-a)")" "in-progress"
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
story shop 'Shop'
task shop 'T01 cart'
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
printf '{"store": "vault"}\n' > .agent-skills.json
has "silent when the store can't be resolved" "[$(ws hint)]" "[]"
cd "$TMP"
has "silent outside git" "[$(ws hint)]" "[]"

echo "status tree"
new_repo tree
ws init-epic payments 'Payments' >/dev/null
has "init-epic creates the epic's project note" "$(cat docs/epics/payments/payments.md)" "pm-project: true"
story payouts 'Payouts' payments
story refunds 'Refunds' payments
story misc 'Misc'
has "a story in an epic links it as its parent" "$(cat docs/stories/payouts/payouts.md)" 'parent: "[[payments]]"'
task payouts 'T01 model'
task payouts 'T02 transfer'
task refunds 'T01 refund'
task misc 'T01 chore'
set_status payouts t01-model done
set_status refunds t01-refund done
git add -A && git commit --quiet -m plan
ws claim payouts t02-transfer >/dev/null
out=$(ws status)
has "epic groups its stories" "$out" "[~] epic payments  1/2 stories"
has "finished story is ticked" "$out" "  [x] story refunds  1/1 tasks"
has "story in progress shows counts" "$out" "  [~] story payouts  1/2 tasks"
has "stories without an epic are listed" "$out" "(no epic)"
has "unknown story is an error" "$(ws status nope)" "no story 'nope'"
lacks "the repository store never ticks the shared project note" "$(cat docs/stories/refunds/refunds.md)" "- [x]"

echo "vault store"
V="$TMP/vault one"
new_vault "$V" PM
new_repo app
out=$(ws root)
has "a configured vault is the store" "$out" "store=vault"
has "stories live under the vault's projects folder, per repository" "$out" "stories_dir=$V/PM/app/stories"
has "epics sit next to them" "$out" "epics_dir=$V/PM/app/epics"
has "root names the vault" "$out" "vault=$V"
has "source says the vault decided" "$out" "source=vault"
git worktree add --quiet -b feat-a "$TMP/app-feat-a"
has "a worktree maps to the same vault folder" "$(cd "$TMP/app-feat-a" && "$BASH_BIN" "$SCRIPT" root)" "stories_dir=$V/PM/app/stories"
rm "$V/.obsidian/plugins/project-manager/data.json"
has "projects folder defaults to Projects" "$(ws root)" "stories_dir=$V/Projects/app/stories"
printf '{\n  "vault": "%s",\n  "projectsFolder": "Work"\n}\n' "$V" > "$AGENT_SKILLS_CONFIG"
has "the user config can name the projects folder" "$(ws root)" "stories_dir=$V/Work/app/stories"
new_vault "$V" PM
printf '{\n  "vaultFolder": "grp/app"\n}\n' > .agent-skills.json
has "vaultFolder overrides the repository name" "$(ws root)" "stories_dir=$V/PM/grp/app/stories"
printf '{\n  "store": "repo"\n}\n' > .agent-skills.json
has "a repository can keep its tasks in git" "$(ws root)" "store=repo"
printf '{\n  "store": "vault"\n}\n' > .agent-skills.json
no_vault
has "store vault without a vault is an error" "$(ws root)" "no vault is configured"
printf '{\n  "store": "tape"\n}\n' > .agent-skills.json
has "an unknown store is an error" "$(ws root)" "unknown store 'tape'"
rm .agent-skills.json
printf '{\n  "vault": "%s"\n}\n' "$TMP/missing" > "$AGENT_SKILLS_CONFIG"
out=$(ws root)
has "a missing vault falls back to the repository" "$out" "store=repo"
has "a missing vault is noted" "$out" "configured vault not found"
new_vault "$V" PM
story shop 'Shop'
has "notes are created in the vault" "$(ls "$V/PM/app/stories/shop")" "shop.md"
task shop 'T01 cart'
task shop 'T02 pay' t01-cart
has "task notes go to the vault's _tasks folder" "$(ws path shop t01-cart)" "$V/PM/app/stories/shop/_tasks/t01-cart.md"
lacks "nothing is written to the repository" "$(git status --porcelain)" "docs/"
t=$(cat "$V/PM/app/stories/shop/_tasks/t02-pay.md")
has "vault links carry the note's vault path" "$t" 'projectId: "[[PM/app/stories/shop/shop|Shop]]"'
has "vault dependency links carry the path" "$t" '  - "[[PM/app/stories/shop/_tasks/t01-cart|T01 cart]]"'
has "next still reads path-qualified dependencies" "$(ws next shop)" "shop/t01-cart"
ws claim shop t01-cart feat-a >/dev/null
has "claim marks the vault note" "$(cat "$V/PM/app/stories/shop/_tasks/t01-cart.md")" "status: in-progress"
set_status shop t01-cart done
has "done ticks the task in the project note" "$(cat "$V/PM/app/stories/shop/shop.md")" "- [x] [[PM/app/stories/shop/_tasks/t01-cart|T01 cart]]"
has "a done dependency still claimed is not finished" "$(code next shop)" "4"
ws release shop t01-cart >/dev/null
has "a released done dependency unlocks the next task" "$(ws next shop)" "shop/t02-pay"
set_status shop t01-cart in-progress
has "reopening unticks it" "$(cat "$V/PM/app/stories/shop/shop.md")" "- [ ] [[PM/app/stories/shop/_tasks/t01-cart|T01 cart]]"
git checkout --quiet -b feat-b && ws claim shop t02-pay feat-b >/dev/null
has "hint works with the vault store" "$(ws hint)" "with this checkout (feat-b) as their work branch: shop/t02-pay"
has "status reads the vault" "$(ws status shop)" "[~] t02-pay claimed: claim/shop/t02-pay"

echo "migrate (repository store)"
no_vault
new_repo mig
mkdir -p docs/stories/ship/tasks docs/epics/logistics
printf '# Epic: Logistics\n' > docs/epics/logistics/epic.md
printf '# Spec: Shipment tracking\n\n## Design\nC3: states.\n' > docs/stories/ship/spec.md
printf -- '---\nepic: logistics\n---\n# Plan\n| t01-route | route |\n' > docs/stories/ship/plan.md
printf -- '---\nid: t01-route\nstory: ship\nstatus: done\ndepends_on: []\ndesign_refs: [C5]\nowner:\n---\n\n## Task t01: Route\nBody one.\n\n## Design\n\n## Log\n- done\n' > docs/stories/ship/tasks/t01-route.md
printf -- '---\nid: t02-apply-event\nstory: ship\nstatus: pending\ndepends_on: [t01-route]\ndesign_refs: [C3, C4]\nowner: feat-apply\n---\n\n## Task t02: Apply\n\n## Design\n- Edge: apply()\n\n## Subtasks\n- [x] a\n- [ ] b\n' > docs/stories/ship/tasks/t02-apply-event.md
hash=$(printf -- '- Edge: apply()\n' | git hash-object --stdin | cut -c1-12)
sed -i.bak "s/^owner: feat-apply$/owner: feat-apply\ndesign_approved: 2026-10-01T10:00Z $hash/" docs/stories/ship/tasks/t02-apply-event.md && rm docs/stories/ship/tasks/t02-apply-event.md.bak
git add -A && git commit --quiet -m old
out=$(ws migrate)
has "migrate converts a story in place" "$out" "migrated: story ship → $TMP/mig/docs/stories/ship/_tasks"
has "migrate creates the epic's project note" "$(cat docs/epics/logistics/logistics.md)" 'title: "Logistics"'
has "the old tasks folder is replaced by _tasks" "$(cd docs/stories/ship && for d in tasks _tasks; do [ -d "$d" ] && echo "dir $d"; done; true)" "dir _tasks"
lacks "no tasks folder remains" "$(cd docs/stories/ship && for d in tasks _tasks; do [ -d "$d" ] && echo "dir $d"; done; true)" "dir tasks"
p=$(cat docs/stories/ship/ship.md)
has "the story project note takes the spec's title" "$p" 'title: "Shipment tracking"'
has "the plan's epic becomes the project's parent" "$p" 'parent: "[[logistics]]"'
lacks "plan.md loses its epic frontmatter" "$(cat docs/stories/ship/plan.md)" "epic:"
has "plan.md keeps its content" "$(head -n 1 docs/stories/ship/plan.md)" "# Plan"
t=$(cat "$(note ship t02-apply-event)")
has "ids are kept, with a title that slugs back to them" "$t" 'title: "T02 apply event"'
has "pending becomes todo" "$t" "status: todo"
has "depends_on becomes wikilinks" "$t" '  - "[[t01-route|T01 route]]"'
has "design_refs move to customFields" "$t" '  design_refs: "C3, C4"'
has "owner becomes the branch field" "$t" '  branch: "feat-apply"'
has "## Subtasks becomes ## Checklist" "$t" "## Checklist
- [x] a"
lacks "no ## Subtasks heading remains" "$t" "## Subtasks"
has "missing sections are added" "$t" "## Log"
has "the approval survives migration" "$(code approved ship t02-apply-event)" "0"
has "done keeps its completion" "$(cat "$(note ship t01-route)")" "status: done"
has "migrated story reports its state" "$(ws status ship)" "[x] t01-route"
has "a second migrate finds nothing" "$(ws migrate)" "nothing to migrate"
mkdir -p docs/stories/live/tasks
printf -- '---\nid: t01-x\nstatus: claimed\n---\n' > docs/stories/live/tasks/t01-x.md
git add -A && git commit --quiet -m live
c=$(git commit-tree "$(git rev-parse 'HEAD^{tree}')" -p HEAD -m "claim live/t01-x work=feat-x id=1")
git update-ref refs/heads/claim/live/t01-x "$c"
has "a story with live claims is skipped" "$(ws migrate)" "skipped: live has live claims"

echo "migrate (vault store)"
V2="$TMP/vault-two"
new_vault "$V2"
new_repo migv
mkdir -p docs/stories/ship/tasks docs/stories/idea docs/epics/logistics
printf '# Epic: Logistics\n' > docs/epics/logistics/epic.md
printf '# Spec: Ship\n' > docs/stories/ship/spec.md
printf -- '---\nepic: logistics\n---\n# Plan\n' > docs/stories/ship/plan.md
printf -- '---\nid: t01-route\nstatus: done\ndepends_on: []\n---\n\n## Task t01\n' > docs/stories/ship/tasks/t01-route.md
printf '# Spec: Idea\n' > docs/stories/idea/spec.md
git add -A && git commit --quiet -m old
out=$(ws migrate)
has "vault migrate moves the story" "$out" "migrated: story ship → $V2/Projects/migv/stories/ship"
has "vault migrate asks to commit the deletion" "$out" "commit the deletion"
has "spec-only stories move too" "$(ls "$V2/Projects/migv/stories/idea")" "spec.md"
has "epics move with their content" "$(ls "$V2/Projects/migv/epics/logistics")" "epic.md"
has "the moved epic gets a project note" "$(ls "$V2/Projects/migv/epics/logistics")" "logistics.md"
has "done tasks are ticked in the vault project note" "$(cat "$V2/Projects/migv/stories/ship/ship.md")" "- [x] [[Projects/migv/stories/ship/_tasks/t01-route|T01 route]]"
has "the vault story links its epic by path" "$(cat "$V2/Projects/migv/stories/ship/ship.md")" 'parent: "[[Projects/migv/epics/logistics/logistics]]"'
has "the vault status tree groups stories by epic" "$(ws status)" "[x] epic logistics  1/1 stories"
has "the repository copies are removed" "[$(ls docs 2>/dev/null || true)]" "[]"
lacks "root no longer flags the old layout" "$(ws root)" "old task layout"
new_repo nested
printf '{\n  "storiesDir": ".stories",\n  "epicsDir": ".stories/epics"\n}\n' > .agent-skills.json
mkdir -p .stories/s1/tasks .stories/epics/e1
printf '# Epic: E1\n' > .stories/epics/e1/epic.md
printf -- '---\nid: t01-a\nstatus: done\n---\n' > .stories/s1/tasks/t01-a.md
out=$(ws migrate)
lacks "an epics dir inside the stories dir is not a story" "$out" "story epics"
has "it migrates as the epics dir" "$out" "migrated: epic e1"
has "the nested layout is fully moved" "[$(ls -A .stories 2>/dev/null || true)]" "[]"

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
