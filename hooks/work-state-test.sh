#!/bin/bash
# work-state-test.sh — Tests for the work_state tool (omp/work-state.ts, run through omp/cli.ts): store resolution (vault
# or repository), dotpm notes, claiming across sessions, worktrees, and
# machines, the ticked status tree, recorded approvals (a task's, and a story's
# spec, design, and plan) with the story phase they drive, migration from the
# old layout, and the SessionStart hint. Every test builds throwaway git
# repositories and vaults.
#
# Run: bash hooks/work-state-test.sh

set -euo pipefail

PASS=0 FAIL=0
TMP=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$TMP"' EXIT
# The CLI under test: the TypeScript port by default; WORK_STATE_CMD overrides it (words split on
# spaces), e.g. WORK_STATE_CMD="bun /abs/path/omp/cli.ts".
if [ -n "${WORK_STATE_CMD:-}" ]; then read -r -a WS_CMD <<< "$WORK_STATE_CMD"; else WS_CMD=(bun "$(cd "$(dirname "$0")/.." && pwd)/omp/cli.ts"); fi
# No user config unless a test writes one: the repository store.
export AGENT_SKILLS_CONFIG="$TMP/user-config.json"

ok()    { PASS=$((PASS + 1)); printf '  ✓ %s\n' "$1"; }
bad()   { FAIL=$((FAIL + 1)); printf '  ✗ %s\n' "$1"; printf '%s\n' "$2" | sed 's/^/      /'; }
has()   { if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else bad "$1" "$2"; fi; }
lacks() { if printf '%s' "$2" | grep -qF -- "$3"; then bad "$1" "$2"; else ok "$1"; fi; }
is()    { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "got:  $2
want: $3"; fi; }
ws()    { "${WS_CMD[@]}" "$@" 2>&1 || true; }
code()  { set +e; "${WS_CMD[@]}" "$@" >/dev/null 2>&1; echo $?; set -e; }

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
has "notes the old task layout" "$(ws root)" "old task layout under docs/stories: run work_state migrate"
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
has "new-task needs the story's project note" "$(ws new-task pay 'T01 model')" "run work_state init-story first"
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
has "titles slug to link-safe ids" "$(ws new-task pay 'T04 Fix: a/b, "x"=y +z')" 'task=t04-fix-a-b-x-y-z'
# dotpm names a task note from its title and, when that isn't the file's name,
# saves a second note and trashes ours, so the task id would change. dotpm_name is
# its rule (YamlSerializer.taskSlug): the stored title must give the id back.
dotpm_name() { printf '%s' "$1" | sed 's/[\\/:*?"<>|]/-/g' | tr '[:upper:]' '[:lower:]' | sed -E 's/[[:space:]]+/-/g' | cut -c1-60; }
stored_title() { sed -n 's/^title: "\(.*\)"$/\1/p' "$(note pay "$1")"; }
check_title() { # title [expected id]
  local id stored
  id=$(ws new-task pay "$1" | sed -n 's/^task=//p')
  stored=$(stored_title "$id")
  if [ -z "${2:-}" ]; then ok "'$1' is stored as '$stored'"; else is "id of '$1'" "$id" "$2"; fi
  is "dotpm names '$stored' like its file" "$(dotpm_name "$stored")" "$id"
  if printf '%s' "$id" | grep -Eq '^[a-z0-9]+(-[a-z0-9]+)*$'; then ok "'$id' is link-safe"; else bad "'$id' is link-safe" "$id"; fi
}
check_title 'T05 Add: status endpoint' t05-add-status-endpoint
check_title 'T06 Retry 5xx (backoff)' t06-retry-5xx-backoff
check_title "T07 Fix user's cart" t07-fix-user-s-cart
check_title 'T08 Upgrade to v1.2' t08-upgrade-to-v1-2
check_title 'T09 aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd eeeeeeeeeee tail' t09-aaaaaaaaaa-bbbbbbbbbb-cccccccccc-dddddddddd-eeeeeeeeeee
viet=""
if [ "$(printf 'ế' | iconv -f utf-8 -t ascii//TRANSLIT 2>/dev/null)" = e ]; then viet=t10-them-diem-cuoi-trang-thai; fi
check_title 'T10 Thêm điểm cuối trạng thái' "$viet"
has "a title with no letters or digits gives no id" "$(ws new-task pay '?!')" "gives no usable task id"
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
# What /epic leaves behind as a story stub is a spec nobody has approved.
printf '# Spec\n- FR1: add item\n' > docs/stories/cart/spec.md
has "a story stub with an unapproved spec is phase spec" "$(ws phase cart)" "phase=spec"
ws approve-phase cart spec >/dev/null
has "an approved spec without a design is phase design" "$(ws phase cart)" "phase=design"
printf '\n## Design\nC1: cart API.\n' >> docs/stories/cart/spec.md
has "a design that is still being written is phase design" "$(ws phase cart)" "phase=design"
ws approve-phase cart design >/dev/null
has "an approved design without a plan is phase plan" "$(ws phase cart)" "phase=plan"
printf '# Plan\n' > docs/stories/cart/plan.md
has "a plan without task notes is still phase plan" "$(ws phase cart)" "phase=plan"
task cart 'T01 add'
task cart 'T02 remove'
set_status cart t02-remove done
has "a plan and tasks nobody approved are phase plan" "$(ws phase cart)" "phase=plan"
ws approve-phase cart plan >/dev/null
out=$(ws phase cart)
has "an approved plan with open tasks is phase build" "$out" "phase=build"
has "phase build counts open tasks" "$out" "open_tasks=1"
lacks "a story with recorded approvals gets no migration note" "$out" "approvals=missing"
set_status cart t01-add cancelled
has "done and cancelled tasks make phase done" "$(ws phase cart)" "phase=done"
story tiny 'Tiny'
printf '# Spec\n- FR1: one change\n' > docs/stories/tiny/spec.md && printf '# Plan\n' > docs/stories/tiny/plan.md
task tiny 'T01 change'
ws approve-phase tiny spec >/dev/null
has "an unapproved design stops a story whose plan is not approved either" "$(ws phase tiny)" "phase=design"
ws approve-phase tiny plan >/dev/null
has "an approved plan carries a story past an unapproved design" "$(ws phase tiny)" "phase=build"

echo "design size limit"
new_repo approval-size
story pay 'Payments'
task pay 'T01 refund'
f=$(note pay t01-refund)
after_heading "$f" Design "$(for i in $(seq 1 16); do printf -- '- line %s\\n' "$i"; done)"
has "approve refuses a design over 15 lines" "$(ws approve pay t01-refund)" "has 16 lines (limit 15)"
has "a refused long design stays unapproved" "$(code approved pay t01-refund)" "6"
has "--allow-long records a kept long design" "$(ws approve pay t01-refund --allow-long)" "approved: pay/t01-refund"

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
(cd "$TMP/wt-report" && "${WS_CMD[@]}" claim pay t02-report feat-report >/dev/null && "${WS_CMD[@]}" approve pay t02-report >/dev/null)
has "approval made in the worktree is seen from the main checkout" "$(code approved pay t02-report)" "0"
lacks "main checkout's copy was not touched" "$(cat "$(note pay t02-report)")" "design_approved"

echo "phase approvals"
new_repo gates
story pay 'Payments'
has "approve-phase needs the story's project note" "$(ws approve-phase nope spec)" "no project note for story 'nope'"
has "approve-phase needs a known phase" "$(ws approve-phase pay build)" "usage: work_state approve-phase STORY spec|design|plan"
has "approved-phase needs a known phase" "$(ws approved-phase pay nope)" "usage: work_state approved-phase STORY spec|design|plan"
has "approving a spec needs a spec" "$(ws approve-phase pay spec)" "no spec.md for story pay"
has "approving a plan needs a plan" "$(ws approve-phase pay plan)" "no plan.md for story pay"
printf '# Spec\n- FR1: refund\n\n## Design\nC1: refund API.\n\n## Open questions\nNone.\n' > docs/stories/pay/spec.md
printf '# Plan\n- t01-refund: refund\n' > docs/stories/pay/plan.md
has "approving a plan needs task notes" "$(ws approve-phase pay plan)" "has no task notes"
has "an unrecorded phase is not approved (exit 6)" "$(code approved-phase pay spec)" "6"
has "approved-phase says what is missing" "$(ws approved-phase pay spec)" "not approved: pay has no approved spec"
has "approve-phase records the spec" "$(ws approve-phase pay spec)" "approved: pay spec ("
has "a recorded spec is approved (exit 0)" "$(code approved-phase pay spec)" "0"
has "the approval is a frontmatter key of the story's project note" "$(sed -n '2,/^---$/p' docs/stories/pay/pay.md)" 'spec_approved: "'
lacks "customFields keeps only dotpm's field definitions" "$(cat docs/stories/pay/pay.md)" "  spec_approved"
sed -i.bak 's/FR1: refund/FR1: refund in full/' docs/stories/pay/spec.md && rm docs/stories/pay/spec.md.bak
has "editing the spec voids its approval (exit 7)" "$(code approved-phase pay spec)" "7"
has "approved-phase says the spec changed" "$(ws approved-phase pay spec)" "pay's spec changed after approval"
has "and phase returns to spec" "$(ws phase pay)" "phase=spec"
ws approve-phase pay spec >/dev/null
has "re-approving restores it" "$(code approved-phase pay spec)" "0"
has "re-approving keeps one approval line" "$(grep -c '^spec_approved:' docs/stories/pay/pay.md)" "1"
printf '\n\n<!-- reviewed -->   \n' >> docs/stories/pay/spec.md
has "blank lines and comments are not edits" "$(code approved-phase pay spec)" "0"
sed -i.bak 's/C1: refund API\./C1: refund API v2./' docs/stories/pay/spec.md && rm docs/stories/pay/spec.md.bak
has "editing the design keeps the spec approved" "$(code approved-phase pay spec)" "0"
has "an unrecorded design is not approved (exit 6)" "$(code approved-phase pay design)" "6"
out=$(ws approve-phase pay design)
has "approve-phase records the design" "$out" "approved: pay design ("
lacks "a written design is not recorded as skipped" "$out" "skipped"
has "a recorded design is approved (exit 0)" "$(code approved-phase pay design)" "0"
sed -i.bak 's/C1: refund API v2\./C1: refund API v3./' docs/stories/pay/spec.md && rm docs/stories/pay/spec.md.bak
has "editing the design voids its approval (exit 7)" "$(code approved-phase pay design)" "7"
has "with no approved plan, phase returns to design" "$(ws phase pay)" "phase=design"
ws approve-phase pay design >/dev/null
task pay 'T01 refund'
has "an unrecorded plan is not approved (exit 6)" "$(code approved-phase pay plan)" "6"
ws approve-phase pay plan >/dev/null
has "a recorded plan is approved (exit 0)" "$(code approved-phase pay plan)" "0"
has "with the spec, design, and plan recorded the story is in build" "$(ws phase pay)" "phase=build"
task pay 'T02 report'
has "adding a task note voids the plan approval (exit 7)" "$(code approved-phase pay plan)" "7"
has "and phase returns to plan" "$(ws phase pay)" "phase=plan"
ws approve-phase pay plan >/dev/null
set_status pay t02-report cancelled
has "cancelling a task keeps the plan approval" "$(code approved-phase pay plan)" "0"
printf -- '- t02-report: report\n' >> docs/stories/pay/plan.md
has "editing the plan voids its approval (exit 7)" "$(code approved-phase pay plan)" "7"
ws approve-phase pay plan >/dev/null
sed -i.bak 's/C1: refund API v3\./C1: refund API v4./' docs/stories/pay/spec.md && rm docs/stories/pay/spec.md.bak
has "a design edited during build leaves the story in build" "$(ws phase pay)" "phase=build"
sed -i.bak 's/FR1: refund in full/FR1: refund in full or in part/' docs/stories/pay/spec.md && rm docs/stories/pay/spec.md.bak
has "a spec edited during build sends the story back to spec" "$(ws phase pay)" "phase=spec"

echo "design skipped, and a design kept in design.md"
story small 'Small'
printf '# Spec\n- FR1: tweak\n' > docs/stories/small/spec.md
ws approve-phase small spec >/dev/null
has "a story with no design records its skip" "$(ws approve-phase small design)" "approved: small design as skipped, none written"
has "a recorded skip is approved (exit 0)" "$(code approved-phase small design)" "0"
has "approved-phase says it was skipped" "$(ws approved-phase small design)" "(skipped, "
printf '# Plan\n' > docs/stories/small/plan.md
task small 'T01 tweak'
has "a recorded skip carries the story to plan" "$(ws phase small)" "phase=plan"
printf '\n## Design\nC1: a contract nobody planned for.\n' >> docs/stories/small/spec.md
has "a design written after the skip voids it (exit 7)" "$(code approved-phase small design)" "7"
has "and the story returns to design" "$(ws phase small)" "phase=design"
story long 'Long'
printf '# Spec\n- FR1: big\n' > docs/stories/long/spec.md
printf '# Design\nC1: kept in a sibling file.\n' > docs/stories/long/design.md
ws approve-phase long spec >/dev/null
lacks "a sibling design.md counts as the design" "$(ws approve-phase long design)" "skipped"
printf 'C2: another.\n' >> docs/stories/long/design.md
has "editing design.md voids the design approval (exit 7)" "$(code approved-phase long design)" "7"
task long 'T01 use it'
after_heading "$(note long t01-use-it)" Design '- Edge: use()'
ws field long t01-use-it design_refs "C1" >/dev/null
ws approve long t01-use-it >/dev/null
has "brief reads a cited contract from design.md" "$(ws brief long t01-use-it)" "C1: kept in a sibling file."
sed -i.bak 's/kept in a sibling file/kept elsewhere/' docs/stories/long/design.md && rm docs/stories/long/design.md.bak
has "editing a contract in design.md voids a task approval (exit 7)" "$(code approved long t01-use-it)" "7"

echo "task approval covers the description and the cited contracts"
new_repo contracts
ws init-epic payments 'Payments' >/dev/null
story pay 'Payments' payments
printf '# Epic: Payments\n\n## Architecture\n\nE1 event bus: at-least-once, ordered per account.\n\nE2 auth: bearer tokens.\n\n## Story map\n\nThe pay story publishes on E1.\n' > docs/epics/payments/epic.md
printf '# Spec\n- FR1: refund\n\n## Design\n\n### Shared contracts\n\nC1 refund API: POST /refunds.\n\nC2 status lifecycle: NEW to DONE.\n' > docs/stories/pay/spec.md
task pay 'T01 refund'
task pay 'T02 report'
task pay 'T03 docs'
f=$(note pay t01-refund)
describe "$f" "$(printf 'Refunds a payment.\n\n**Acceptance criteria:**\n- [ ] refund stored\n  - [ ] nested detail')"
after_heading "$f" Design '- Edge: refund(paymentId)'
ws field pay t01-refund design_refs "C1, E1" >/dev/null
ws approve pay t01-refund >/dev/null
has "a design approval covers its task" "$(code approved pay t01-refund)" "0"
out=$(ws brief pay t01-refund)
has "brief shows a cited story contract" "$out" "C1 refund API: POST /refunds."
has "brief resolves an E-id from the parent epic" "$out" "== design E1 (from epic.md)"
has "and shows its text" "$out" "E1 event bus: at-least-once"
lacks "brief omits an epic contract the task does not cite" "$out" "E2 auth"
sed -i.bak 's/Refunds a payment\./Refunds a payment in full./' "$f" && rm "$f.bak"
has "editing the description voids the approval (exit 7)" "$(code approved pay t01-refund)" "7"
has "status flags it" "$(ws status pay)" "t01-refund · design ✗ (changed since approval)"
ws approve pay t01-refund >/dev/null
sed -i.bak 's/- \[ \] refund stored/- [x] refund stored/' "$f" && rm "$f.bak"
has "ticking an acceptance criterion keeps the approval" "$(code approved pay t01-refund)" "0"
sed -i.bak 's/  - \[ \] nested detail/  - [x] nested detail/' "$f" && rm "$f.bak"
has "ticking an indented criterion keeps the approval" "$(code approved pay t01-refund)" "0"
sed -i.bak 's#POST /refunds#POST /v2/refunds#' docs/stories/pay/spec.md && rm docs/stories/pay/spec.md.bak
has "editing a cited story contract voids the approval (exit 7)" "$(code approved pay t01-refund)" "7"
ws approve pay t01-refund >/dev/null
sed -i.bak 's/NEW to DONE/NEW to PAID/' docs/stories/pay/spec.md && rm docs/stories/pay/spec.md.bak
has "editing a contract the task does not cite keeps it" "$(code approved pay t01-refund)" "0"
sed -i.bak 's/ordered per account/ordered globally/' docs/epics/payments/epic.md && rm docs/epics/payments/epic.md.bak
has "editing a cited epic contract voids the approval (exit 7)" "$(code approved pay t01-refund)" "7"
ws approve pay t01-refund >/dev/null
sed -i.bak 's/bearer tokens/mutual TLS/; s/publishes on E1/publishes events/' docs/epics/payments/epic.md && rm docs/epics/payments/epic.md.bak
has "editing an uncited epic contract, or the epic outside its architecture, keeps it" "$(code approved pay t01-refund)" "0"
ws field pay t01-refund design_refs "C1" >/dev/null
has "changing the cited ids voids the approval (exit 7)" "$(code approved pay t01-refund)" "7"

echo "cites"
ws field pay t01-refund design_refs "C1, E1" >/dev/null
ws field pay t02-report design_refs "C1, C2" >/dev/null
is "cites lists every task that cites a contract, with its status" "$(ws cites pay C1)" "t01-refund todo
t02-report todo"
is "cites lists one task for a contract it alone cites" "$(ws cites pay C2)" "t02-report todo"
set_status pay t02-report done
is "cites shows which citing tasks are already done" "$(ws cites pay C2)" "t02-report done"
is "cites finds an epic contract" "$(ws cites pay E1)" "t01-refund todo"
is "cites matches whole ids only" "$(ws cites pay C)" ""
is "cites says nothing for an id nobody cites" "$(ws cites pay C9)" ""
has "cites needs a known story" "$(ws cites nope C1)" "no story 'nope'"
has "cites needs an id" "$(ws cites pay)" "usage: work_state cites STORY ID"

echo "contracts written under headings"
new_repo headings
story pay 'Payments'
printf '# Spec\n- FR1: refund\n\n## Design\n\n### Shared contracts\n\n#### C1 refund API\n\nPOST /refunds with a body.\n\n```json\n{ "amount": 5 }\n\n{ "note": "x" }\n```\n\n#### C2 status lifecycle\n\nNEW to DONE.\n' > docs/stories/pay/spec.md
task pay 'T01 refund'
f=$(note pay t01-refund)
after_heading "$f" Design '- Edge: refund()'
ws field pay t01-refund design_refs "C1" >/dev/null
ws approve pay t01-refund >/dev/null
out=$(ws brief pay t01-refund)
has "brief shows the whole section under the heading that names a contract" "$out" "POST /refunds with a body."
has "including a fenced example split by a blank line" "$out" '{ "note": "x" }'
lacks "but not the next contract's section" "$out" "NEW to DONE"
sed -i.bak 's#POST /refunds with a body#DELETE /refunds with a body#' docs/stories/pay/spec.md && rm docs/stories/pay/spec.md.bak
has "editing a contract's body voids the approval (exit 7)" "$(code approved pay t01-refund)" "7"
ws approve pay t01-refund >/dev/null
sed -i.bak 's/"note": "x"/"note": "y"/' docs/stories/pay/spec.md && rm docs/stories/pay/spec.md.bak
has "editing its fenced example voids the approval (exit 7)" "$(code approved pay t01-refund)" "7"
ws approve pay t01-refund >/dev/null
sed -i.bak 's/NEW to DONE/NEW to PAID/' docs/stories/pay/spec.md && rm docs/stories/pay/spec.md.bak
has "editing the next contract's section keeps it" "$(code approved pay t01-refund)" "0"

echo "approvals do not depend on the locale"
new_repo locale
story s 'S'
printf '# Spec\n- FR1: x\n\n## Design\n\nC2 beta: b.\n\nc1 alpha: a.\n' > docs/stories/s/spec.md
printf '# Plan\n' > docs/stories/s/plan.md
task s 'T1 b'
task s 'T10 a'
after_heading "$(note s t1-b)" Design '- Edge: b()'
ws field s t1-b design_refs "c1, C2" >/dev/null
(export LC_ALL=C; ws approve-phase s plan >/dev/null; ws approve s t1-b >/dev/null)
for loc in en_US.UTF-8 en_GB.UTF-8; do
  has "a plan approved under the C locale holds under $loc" "$(export LC_ALL=$loc; code approved-phase s plan)" "0"
  has "so does a task approval over mixed-case contract ids ($loc)" "$(export LC_ALL=$loc; code approved s t1-b)" "0"
done

echo "review status"
new_repo review
story pay 'Payments'
printf '# Spec\n- FR1: x\n' > docs/stories/pay/spec.md
printf '# Plan\n' > docs/stories/pay/plan.md
task pay 'T01 first'
task pay 'T02 second' t01-first
ws approve-phase pay spec >/dev/null
ws approve-phase pay design >/dev/null
ws approve-phase pay plan >/dev/null
set_status pay t01-first review
lacks "review records no completion date" "$(cat "$(note pay t01-first)")" "completed:"
lacks "review is not full progress" "$(cat "$(note pay t01-first)")" "progress: 100"
has "a task in review keeps the story in build" "$(ws phase pay)" "open_tasks=2"
lacks "a task waiting on one in review is not offered" "$(ws next pay)" "pay/t02-second"
set_status pay t01-first in-progress
has "findings send a task back to in progress" "$(cat "$(note pay t01-first)")" "status: in-progress"
set_status pay t01-first review
set_status pay t01-first done
has "done after review completes the task" "$(cat "$(note pay t01-first)")" "completed: $(date +%Y-%m-%d)"
has "and unlocks its dependent" "$(ws next pay)" "pay/t02-second"
has "phase counts it as complete" "$(ws phase pay)" "open_tasks=1"

echo "ready: the tasks a wave can start"
# A task ready for its gate: a description with a Files line, a design, no approval yet.
# ready_task STORY TITLE FILES [DEP-ID...]; the design is $DESIGN, the scope line $SCOPE.
ready_task() {
  local story="$1" title="$2" files="$3" id file
  shift 3
  id=$(ws new-task "$story" "$title" "$@" | sed -n 's/^task=//p')
  file=$(ws path "$story" "$id")
  describe "$file" "$(printf '**Description:** %s.\n\n**Files likely touched:** %s\n\n**Estimated scope:** %s' "$title" "$files" "${SCOPE:-S}")"
  after_heading "$file" Design "${DESIGN:-- Edge: x()}"
}
approve_all() { local s="$1" t; shift; for t in "$@"; do ws approve "$s" "$t" >/dev/null; done; }
rdy() { "${WS_CMD[@]}" ready "$@" 2>/dev/null || true; }          # the listed tasks
skips() { "${WS_CMD[@]}" ready "$@" 2>&1 >/dev/null || true; }    # why some were held back
new_repo ready
story shop 'Shop'
ready_task shop 'T01 schema' '`src/db/schema.ts`, `migrations/001_init.sql`'
ready_task shop 'T02 cart api' '`src/api/cart.ts`' t01-schema
ready_task shop 'T03 cart ui' '`src/ui/cart.tsx`'
ready_task shop 'T04 seed data' '`src/db/schema.ts`'
f=$(note shop t01-schema)
git add -A && git commit --quiet -m plan
is "ready changes nothing" "$(rdy shop; git status --porcelain)" ""
is "no approved design means nothing is ready (exit 4)" "$(code ready shop)" "4"
has "ready needs a story id" "$(ws ready)" "usage: work_state ready STORY"
has "ready needs a known story" "$(ws ready nope)" "no story 'nope'"
ws approve shop t01-schema >/dev/null
is "an approved task is listed as story/task" "$(rdy shop)" "shop/t01-schema"
describe "$f" 'Edited after the approval.'
is "a task whose approval went stale is not ready (approved says 7)" "$(code approved shop t01-schema)$(code ready shop)" "74"
ws approve shop t01-schema >/dev/null
approve_all shop t02-cart-api t03-cart-ui t04-seed-data
out=$(rdy shop)
is "ready lists what can start together, in plan order" "$out" "shop/t01-schema
shop/t03-cart-ui"
lacks "a task whose dependency is not complete is not ready" "$out" "t02-cart-api"
has "a candidate sharing a file with an earlier one is skipped, and stderr says why" "$(skips shop)" "skipped: shop/t04-seed-data overlaps shop/t01-schema (ready) on src/db/schema.ts"
ws claim shop t01-schema >/dev/null
is "a claimed task is not offered again" "$(rdy shop)" "shop/t03-cart-ui"
has "a candidate sharing a file with a running task is skipped" "$(skips shop)" "skipped: shop/t04-seed-data overlaps shop/t01-schema (running) on src/db/schema.ts"
set_status shop t01-schema review
is "a task in review still holds its files" "$(rdy shop)" "shop/t03-cart-ui"
set_status shop t01-schema done
is "a finished dependency opens its dependent" "$(rdy shop)" "shop/t02-cart-api
shop/t03-cart-ui"
has "while the unreleased lock still holds its files" "$(skips shop)" "overlaps shop/t01-schema (running)"
ws release shop t01-schema >/dev/null
is "releasing the lock frees them" "$(rdy shop)" "shop/t02-cart-api
shop/t03-cart-ui
shop/t04-seed-data"
ws claim shop t03-cart-ui >/dev/null
set_status shop t03-cart-ui blocked
ws release shop t03-cart-ui >/dev/null
ready_task shop 'T05 cart polish' '`src/ui/cart.tsx`'
ws approve shop t05-cart-polish >/dev/null
has "a blocked task holds its files even with no lock" "$(skips shop)" "skipped: shop/t05-cart-polish overlaps shop/t03-cart-ui (running) on src/ui/cart.tsx"

new_repo chain
story chain 'Chain'
ready_task chain 'T01 one' '`src/a.ts`'
ready_task chain 'T02 two' '`src/a.ts`, `src/b.ts`'
ready_task chain 'T03 three' '`src/b.ts`'
approve_all chain t01-one t02-two t03-three
is "a skipped candidate holds nothing back: only listed and running tasks do" "$(rdy chain)" "chain/t01-one
chain/t03-three"

echo "ready follows a task through its worktree, merge, and release"
new_repo flow
story api 'API'
ready_task api 'T01 model' '`src/model.ts`'
ready_task api 'T02 handler' '`src/handler.ts`' t01-model
ready_task api 'T03 model tests' '`src/model.ts`'
approve_all api t01-model t02-handler t03-model-tests
git add -A && git commit --quiet -m "plan, designs, approvals"
is "the first task starts; its dependent waits and the third shares its file" "$(rdy api)" "api/t01-model"
ws claim api t01-model task/api/t01-model >/dev/null
git worktree add --quiet -b task/api/t01-model "$TMP/flow-t01"
(cd "$TMP/flow-t01" && "${WS_CMD[@]}" set api t01-model in-progress >/dev/null)
is "a task running in a worktree holds its files, though this checkout's note says todo" "$(code ready api)" "4"
has "and the reason names it" "$(skips api)" "skipped: api/t03-model-tests overlaps api/t01-model (running) on src/model.ts"
(cd "$TMP/flow-t01" && "${WS_CMD[@]}" set api t01-model review >/dev/null && "${WS_CMD[@]}" set api t01-model done >/dev/null && git add -A && git commit --quiet -m "t01 done")
is "done on an unmerged work branch opens nothing in the repository store" "$(code ready api)" "4"
git merge --quiet --no-ff --no-edit task/api/t01-model
is "merged, the dependent opens while the lock still holds the file" "$(rdy api)" "api/t02-handler"
ws release api t01-model >/dev/null
is "released, the file is free" "$(rdy api)" "api/t02-handler
api/t03-model-tests"

echo "ready: plan order, and what counts as a file"
new_repo order
story ord 'Order'
ready_task ord 'T10 ten' '`src/ten.ts`'
ready_task ord 'T2 two' '`src/two.ts`'
approve_all ord t10-ten t2-two
for loc in C en_US.UTF-8 en_GB.UTF-8; do
  is "plan order is numeric, whatever the locale ($loc)" "$(export LC_ALL=$loc; rdy ord)" "ord/t2-two
ord/t10-ten"
done
new_repo files
pairs=0
# overlap_case LABEL FILES-A FILES-B overlap|apart [DESIGN-B]: two approved tasks in a story of
# their own; the first is listed, and the second only when the two share nothing.
overlap_case() {
  local label="$1" s
  pairs=$((pairs + 1)); s="pair$pairs"
  story "$s" "Pair $pairs"
  ready_task "$s" 'T01 first' "$2"
  DESIGN="${5:-}" ready_task "$s" 'T02 second' "$3"
  approve_all "$s" t01-first t02-second
  if [ "$4" = overlap ]; then is "$label" "$(rdy "$s")" "$s/t01-first"
  else is "$label" "$(rdy "$s")" "$s/t01-first
$s/t02-second"; fi
}
overlap_case "the same file overlaps" '`src/a.ts`' '`src/a.ts`' overlap
overlap_case "different files do not" '`src/a.ts`' '`src/b.ts`' apart
overlap_case "a path and its shortened form overlap" '`graphql/types/user.gql`' '`user.gql`' overlap
overlap_case "one name in two directories does not" '`src/a/index.ts`' '`src/b/index.ts`' apart
overlap_case "a directory overlaps a file in it" '`src/auth/`' '`src/auth/login.ts`' overlap
overlap_case "a path with no extension may be a directory" '`src/auth`' '`src/auth/login.ts`' overlap
overlap_case "but only a whole directory name" '`src/auth`' '`src/author/login.ts`' apart
overlap_case "a glob overlaps a file it matches" '`e2e/*`' '`e2e/fixtures/a.ts`' overlap
overlap_case "two globs that could match one file overlap" '`docs/x.md`, `e2e/*.spec.ts`' '`e2e/fixtures/*`' overlap
overlap_case "two globs that cannot match one file do not" '`src/*.ts`' '`src/*.css`' apart
overlap_case "a line number is not part of the path" '`src/a.ts:10-20`' '`src/a.ts`' overlap
overlap_case "the template's list form: every item counts" "$(printf '\n- `src/x.ts`\n- `src/shared.ts`')" '`src/shared.ts`' overlap
overlap_case "a list after a blank line still belongs to the label" "$(printf '\n\n- `src/shared.ts`')" '`src/shared.ts`' overlap
overlap_case "prose around inline paths is ignored" '`src/x.ts`, new `src/shared.ts` (+ test), deleted `src/old.ts`' '`src/shared.ts`' overlap
overlap_case "paths without backticks count" 'src/x.ts, src/shared.ts (new)' '`src/shared.ts`' overlap
overlap_case "so do unbackticked list items" "$(printf '\n- src/x.ts\n- src/shared.ts - the handler')" '`src/shared.ts`' overlap
SCOPE='M. Repo: `shared-repo`' overlap_case "backticks after the Files block are not files" '`src/x.ts`' '`src/y.ts`' apart
overlap_case "lockfiles of one kind overlap in any directory" '`web/package.json`, `web/package-lock.json`' '`api/package.json`, `api/package-lock.json`' overlap
overlap_case "lockfiles of different kinds do not" '`web/package-lock.json`' '`svc/go.sum`' apart
overlap_case "any two *.lock files overlap" '`Cargo.lock`' '`web/yarn.lock`' overlap
overlap_case "generated querier files overlap" '`db/orders/querier.go`' '`db/users/querier.go`' overlap
overlap_case "schema dumps overlap" '`db/a/schema.sql`' '`db/b/schema.sql`' overlap
overlap_case "a path in backticks in the design counts" '`src/a.ts`' '`src/b.ts`' overlap '- Edge: `src/a.ts` gains a field'
overlap_case "code in the design is not a file" '`src/a.ts`' '`src/b.ts`' apart '- Rules: reads `router.query`, calls `useCart` and `Array.from`, a/b or c/d'
overlap_case "a lockfile named only in the design counts" '`web/package-lock.json`' '`api/x.ts`' overlap '- Edge: regenerates `api/package-lock.json`'
new_repo nofiles
story nf 'No files'
ready_task nf 'T01 bare' ''
ws approve nf t01-bare >/dev/null
is "a task that lists no files is still listed" "$(rdy nf)" "nf/t01-bare"
has "and the note says its overlap is unchecked" "$(skips nf)" "note: nf/t01-bare lists no files"

echo "ready sees claims made on another machine"
git init --quiet --bare -b main "$TMP/remote-ready.git"
new_repo seedr
story api 'API'
ready_task api 'T01 a' '`src/a.ts`'
ready_task api 'T02 b' '`src/a.ts`'
ready_task api 'T03 c' '`src/c.ts`'
approve_all api t01-a t02-b t03-c
git add -A && git commit --quiet -m plan
git remote add origin "$TMP/remote-ready.git" && git push --quiet origin main
git clone --quiet "$TMP/remote-ready.git" "$TMP/ready-a" && (cd "$TMP/ready-a" && git_id)
git clone --quiet "$TMP/remote-ready.git" "$TMP/ready-b" && (cd "$TMP/ready-b" && git_id)
cd "$TMP/ready-a"
is "machine A starts with both of the tasks that don't share a file" "$(rdy api)" "api/t01-a
api/t03-c"
ws claim api t01-a >/dev/null
cd "$TMP/ready-b"
is "machine B does not offer the task machine A claimed" "$(rdy api)" "api/t03-c"
has "and holds back a task sharing its file" "$(skips api)" "skipped: api/t02-b overlaps api/t01-a (running) on src/a.ts"

echo "adopting approvals for planned stories that predate them"
new_repo adopt
story old 'Old'
printf '# Spec\n- FR1: x\n\n## Design\n\nC1: api.\n' > docs/stories/old/spec.md
printf '# Plan\n' > docs/stories/old/plan.md
task old 'T01 first'
task old 'T02 second'
task old 'T03 third'
describe "$(note old t01-first)" 'Does the first thing.'
after_heading "$(note old t01-first)" Design '- Edge: first()'
after_heading "$(note old t02-second)" Design '- Edge: second()'
# Approvals recorded before descriptions and contracts were covered fingerprint the design alone.
old_hash() { printf -- '%s\n' "$1" | git hash-object --stdin | cut -c1-12; }
ws field old t01-first design_approved "2026-10-01T10:00Z $(old_hash '- Edge: first()')" >/dev/null
ws field old t02-second design_approved "2026-10-01T10:00Z $(old_hash '- Edge: second()')" >/dev/null
after_heading "$(note old t02-second)" Design '- Edge: edited after its approval'
set_status old t01-first in-progress
out=$(ws phase old)
has "a planned story with no recorded approvals is not past spec" "$out" "phase=spec"
has "phase points at adopt-approvals" "$out" "approvals=missing run: work_state adopt-approvals old"
has "the hint says to ask the user first" "$out" "only if the user confirms its earlier gates passed"
has "a task approved under the earlier fingerprint reads as changed (exit 7)" "$(code approved old t01-first)" "7"
out=$(ws adopt-approvals old)
has "adopt records the spec" "$out" "approved: old spec ("
has "adopt records the design" "$out" "approved: old design ("
has "adopt records the plan" "$out" "approved: old plan ("
has "adopt re-records a task approval whose design is unchanged" "$out" "approved: old/t01-first (re-recorded"
lacks "adopt leaves a task whose design changed since its approval alone" "$out" "old/t02-second"
has "the re-recorded approval holds (exit 0)" "$(code approved old t01-first)" "0"
has "the edited design stays changed (exit 7)" "$(code approved old t02-second)" "7"
out=$(ws phase old)
has "the adopted story is in build" "$out" "phase=build"
lacks "and no longer gets the note" "$out" "approvals=missing"
has "adopt is one-shot" "$(ws adopt-approvals old)" "with no recorded approvals"
story calm 'Calm'
printf '# Spec\n- FR1: y\n' > docs/stories/calm/spec.md
printf '# Plan\n' > docs/stories/calm/plan.md
task calm 'T01 only'
has "a planned story whose tasks haven't started gets the note too" "$(ws phase calm)" "approvals=missing run: work_state adopt-approvals calm"
has "adopt records a story with no design as skipped" "$(ws adopt-approvals calm)" "approved: calm design as skipped, none written"
has "and that story is in build" "$(ws phase calm)" "phase=build"
story young 'Young'
printf '# Spec\n- FR1: z\n' > docs/stories/young/spec.md
has "adopt refuses a story that isn't planned" "$(ws adopt-approvals young)" "is for a planned story"
lacks "phase gives an unplanned story no note" "$(ws phase young)" "approvals=missing"

echo "worktrees"
new_repo wt
story shop 'Shop'
task shop 'T01 cart'
task shop 'T02 pay'
git add -A && git commit --quiet -m plan
git worktree add --quiet -b feat-cart "$TMP/wt-cart"
(cd "$TMP/wt-cart" && "${WS_CMD[@]}" claim shop t01-cart feat-cart >/dev/null)
has "claim from a worktree marks the worktree's copy" "$(cat "$TMP/wt-cart/$(note shop t01-cart)")" "status: in-progress"
lacks "claim leaves the main checkout's copy alone" "$(cat "$(note shop t01-cart)")" "in-progress"
has "path points at the worktree copy" "$(ws path shop t01-cart)" "$TMP/wt-cart/docs/stories/shop/_tasks/t01-cart.md"
out=$(ws claim shop t02-pay feat-pay)
has "claiming for a branch with no checkout yet says how to mark it" "$out" "run there: work_state set shop t02-pay in-progress"
lacks "and leaves this checkout's note alone" "$(cat "$(note shop t02-pay)")" "in-progress"
git worktree add --quiet -b feat-pay "$TMP/wt-pay"
(cd "$TMP/wt-pay" && "${WS_CMD[@]}" set shop t02-pay in-progress >/dev/null)
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
git init --quiet --bare -b main "$TMP/remote.git"
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
# A claim is a lock, not a push of this branch: local commits stay local.
ws release api t02-b >/dev/null
git commit --quiet --allow-empty -m "local WIP, never pushed"
wip=$(git rev-parse HEAD)
has "a claim is published on top of unpushed commits" "$(ws claim api t02-b)" "claimed: api/t02-b"
has "the claim reached the remote" "$(git -C "$TMP/remote.git" for-each-ref --format='%(refname)' refs/heads/claim)" "refs/heads/claim/api/t02-b"
if git -C "$TMP/remote.git" cat-file -e "$wip^{commit}" 2>/dev/null; then bad "a claim uploads no unpushed local commit" "the remote has $wip"; else ok "a claim uploads no unpushed local commit"; fi
is "the published claim has no parent" "$(git -C "$TMP/remote.git" rev-list --parents -n 1 refs/heads/claim/api/t02-b | wc -w | tr -d ' ')" "1"

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
has "a worktree maps to the same vault folder" "$(cd "$TMP/app-feat-a" && "${WS_CMD[@]}" root)" "stories_dir=$V/PM/app/stories"
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
printf '# Spec\n- FR1: cart\n' > "$V/PM/app/stories/shop/spec.md"
ws approve-phase shop spec >/dev/null
has "phase approvals are recorded in the vault's project note" "$(cat "$V/PM/app/stories/shop/shop.md")" 'spec_approved: "'
has "phase reads them from the vault" "$(ws phase shop)" "phase=design"
ws init-epic payments 'Payments' >/dev/null
story ride 'Ride' payments
printf '# Spec\n- FR1: ride\n' > "$V/PM/app/stories/ride/spec.md"
printf '# Epic\n\n## Architecture\n\nE1 event bus: ordered.\n' > "$V/PM/app/epics/payments/epic.md"
task ride 'T01 go'
after_heading "$V/PM/app/stories/ride/_tasks/t01-go.md" Design '- Edge: go()'
ws field ride t01-go design_refs "E1" >/dev/null
ws approve ride t01-go >/dev/null
has "an epic contract is read through the vault's parent link" "$(ws brief ride t01-go)" "E1 event bus: ordered."
sed -i.bak 's/ordered/unordered/' "$V/PM/app/epics/payments/epic.md" && rm "$V/PM/app/epics/payments/epic.md.bak"
has "editing it voids the task approval in the vault store (exit 7)" "$(code approved ride t01-go)" "7"

echo "ready (vault store)"
new_vault "$V" PM
new_repo readyv
story ship 'Ship'
ready_task ship 'T01 core' '`src/core.ts`'
ready_task ship 'T02 api' '`src/api.ts`' t01-core
ready_task ship 'T03 core docs' '`src/core.ts`'
approve_all ship t01-core t02-api t03-core-docs
is "the vault store lists a ready task" "$(rdy ship)" "ship/t01-core"
has "and holds back one that shares its file" "$(skips ship)" "skipped: ship/t03-core-docs overlaps ship/t01-core (ready) on src/core.ts"
ws claim ship t01-core feat-core >/dev/null
is "a claimed task holds its files there too" "$(code ready ship)" "4"
set_status ship t01-core done
is "a done dependency whose lock is still held is not finished" "$(code ready ship)" "4"
ws release ship t01-core >/dev/null
is "released, it opens its dependent and frees its file" "$(rdy ship)" "ship/t02-api
ship/t03-core-docs"
lacks "ready leaves the repository alone" "$(git status --porcelain)" "docs/"

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
c=$(git commit-tree "$(git mktree </dev/null)" -m "claim live/t01-x work=feat-x id=1")
git update-ref refs/heads/claim/live/t01-x "$c"
has "a story with live claims is skipped" "$(ws migrate)" "skipped: live has live claims"
# A claim another machine holds shows up as a remote-tracking ref.
mkdir -p docs/stories/away/tasks
printf -- '---\nid: t01-y\nstatus: pending\n---\n' > docs/stories/away/tasks/t01-y.md
git update-ref refs/remotes/origin/claim/away/t01-y "$c"
has "a claim held on the remote also skips a story" "$(ws migrate)" "skipped: away has live claims (origin/claim/away/t01-y)"
# A task id with quotes or backslashes must not break the project note's YAML.
mkdir -p docs/stories/odd/tasks
printf -- '---\nid: odd\nstatus: pending\n---\n' > 'docs/stories/odd/tasks/t01-say-"hi"-a\b.md'
ws migrate >/dev/null
has "links in the project note's taskIds are YAML-escaped" "$(cat docs/stories/odd/odd.md)" 'taskIds: ["[[t01-say-\"hi\"-a\\b|t01-say-\"hi\"-a\\b]]"]'

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

echo "migrate (vault store, repository notes already in dotpm format)"
no_vault
new_repo mdot
ws init-epic payments 'Payments epic' >/dev/null
story pay 'Payments' payments
task pay 'T01 model'
task pay 'T02 api' t01-model
set_status pay t01-model done
git add -A && git commit --quiet -m plan
git worktree add --quiet -b feat-api "$TMP/mdot-api"
ws claim pay t02-api feat-api >/dev/null
ws log pay t02-api "handler written" >/dev/null
V3="$TMP/vault-three"
new_vault "$V3"
has "root flags a story left in the repository" "$(ws root)" "old task layout"
has "vault migrate skips a story with live claims" "$(ws migrate)" "skipped: pay has live claims"
has "its notes stay in the repository" "$(ls docs/stories/pay/_tasks)" "t02-api.md"
has "and nothing is copied to the vault" "[$(ls "$V3/Projects/mdot/stories" 2>/dev/null || true)]" "[]"
# The work is finished: merged into the base branch, then the claim is released.
(cd "$TMP/mdot-api" && git add -A && git commit --quiet -m "t02 progress")
git merge --quiet --no-edit feat-api
ws release pay t02-api >/dev/null
has "a released story moves to the vault" "$(ws migrate)" "migrated: story pay → $V3/Projects/mdot/stories/pay"
t=$(cat "$V3/Projects/mdot/stories/pay/_tasks/t02-api.md")
has "the merged progress comes along" "$t" "handler written"
has "the task links its project by vault path" "$t" 'projectId: "[[Projects/mdot/stories/pay/pay|Payments]]"'
has "its dependencies carry vault paths" "$t" '  - "[[Projects/mdot/stories/pay/_tasks/t01-model|T01 model]]"'
has "its footer carries the vault path" "$(tail -n 1 "$V3/Projects/mdot/stories/pay/_tasks/t02-api.md")" "Project: [[Projects/mdot/stories/pay/pay|Payments]]"
p=$(cat "$V3/Projects/mdot/stories/pay/pay.md")
has "taskIds carry vault paths" "$p" 'taskIds: ["[[Projects/mdot/stories/pay/_tasks/t01-model|T01 model]]", "[[Projects/mdot/stories/pay/_tasks/t02-api|T02 api]]"]'
has "finished tasks are ticked in the project note" "$p" "- [x] [[Projects/mdot/stories/pay/_tasks/t01-model|T01 model]]"
has "open tasks stay open" "$p" "- [ ] [[Projects/mdot/stories/pay/_tasks/t02-api|T02 api]]"
has "the story links its epic by vault path" "$p" 'parent: "[[Projects/mdot/epics/payments/payments]]"'
set_status pay t02-api done
has "done ticks a moved task" "$(cat "$V3/Projects/mdot/stories/pay/pay.md")" "- [x] [[Projects/mdot/stories/pay/_tasks/t02-api|T02 api]]"
has "the repository copy is gone" "$(ws migrate)" "nothing to migrate"

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
