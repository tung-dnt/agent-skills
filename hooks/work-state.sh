#!/bin/bash
# work-state.sh — resolve where work artifacts live, claim tasks safely across
# parallel sessions, and read and write task state.
#
# Implements references/work-artifacts.md. Epics, stories, and tasks are notes in
# the format of the Obsidian project-manager plugin (dotpm): a project note per
# epic and story, one task note per task under the story's `_tasks/` folder.
# They live in the user's Obsidian vault when one is configured, else in the repo.
#
#   work-state.sh root                        resolved store and roots, as key=value lines
#   work-state.sh configure DIR [EPICS_DIR]   write the repo-store dirs to .agent-skills.json
#   work-state.sh init-epic EPIC TITLE        create the epic's project note
#   work-state.sh init-story STORY TITLE [EPIC]  create the story's project note
#   work-state.sh new-task STORY TITLE [DEP...]  create a task note; its id is the title's slug
#   work-state.sh path STORY [TASK]           story directory, or the freshest writable task note
#   work-state.sh field STORY TASK KEY VALUE  set customFields.KEY on a task
#   work-state.sh set STORY TASK STATUS       todo | in-progress | blocked | review | done | cancelled
#   work-state.sh log STORY TASK TEXT         append a dated line to the task's ## Log
#   work-state.sh next [STORY-ID]             first claimable task: "story/task" (exit 4 if none)
#   work-state.sh claim STORY TASK [WORK]     take the lock, then mark the task in-progress;
#                                             exit 3 if another session holds it,
#                                             exit 5 if the claim couldn't be published
#   work-state.sh release STORY TASK          drop the lock (local and remote)
#   work-state.sh status [STORY-ID]           ticked tree: epics → stories → tasks → checklist
#   work-state.sh brief STORY TASK            task note + plan row + only the spec sections it cites
#   work-state.sh phase STORY                 none | spec | design | plan | build | done
#   work-state.sh approve STORY TASK          record the gate's approval of the task's design
#   work-state.sh approved STORY TASK         exit 0 approved, 6 not approved, 7 changed since
#   work-state.sh migrate [STORY-ID]          convert the old tasks/*.md layout into the store
#   work-state.sh hint                        SessionStart JSON when claims exist; silent otherwise
#
# A claim is the ref refs/heads/claim/STORY/TASK pointing at a unique empty
# commit whose message records the work branch and a claim id. Creating it with
# `git update-ref REF NEW ""` is atomic in one repository; pushing it with an
# empty --force-with-lease is atomic on the remote. The lock never carries work.
#
# Portable to bash 3.2 (macOS) and needs only git, sed, and awk.

set -e

DEFAULT_STORIES="docs/stories"
DEFAULT_EPICS="docs/epics"
CONFIG=".agent-skills.json"
USER_CONFIG="${AGENT_SKILLS_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/agent-skills/config.json}"
DOTPM_SETTINGS=".obsidian/plugins/project-manager/data.json"
NS="claim"
STATUSES="todo in-progress blocked review done cancelled"

die() { echo "work-state: $*" >&2; exit 1; }

repo_root() { git rev-parse --show-toplevel 2>/dev/null; }

config_get() {
  [ -f "$2" ] || return 0
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$2" | head -n 1
}

# Strip "./" prefixes and trailing slashes; reject absolute or escaping paths.
normalize_dir() {
  local d="$1"
  while [ "${d#./}" != "$d" ]; do d="${d#./}"; done
  while [ "${d%/}" != "$d" ]; do d="${d%/}"; done
  case "$d" in ""|/*|..|../*|*/../*|*/..) return 1 ;; esac
  printf '%s' "$d"
}

# The repository's name: the main worktree's directory, so every worktree of a
# repository maps to the same vault folder.
repo_name() {
  local common name
  common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  if [ -z "$common" ]; then basename "$ROOT"; return 0; fi
  name="$(basename "$common")"
  if [ "$name" = .git ]; then name="$(basename "$(dirname "$common")")"; else name="${name%.git}"; fi
  printf '%s' "$name"
}

# Sets ROOT, STORE, VAULT, STORIES, EPICS (absolute), OLD_STORIES, OLD_EPICS
# (the repo-store dirs), CONFIGURED, SOURCE, NOTES.
resolve() {
  local s="" e="" want="" folder="" projects=""
  ROOT="$(repo_root)" || true
  [ -n "$ROOT" ] || die "not inside a git repository"
  NOTES="" ; VAULT=""
  if [ -f "$ROOT/$CONFIG" ]; then
    s="$(normalize_dir "$(config_get storiesDir "$ROOT/$CONFIG")" || true)"
    e="$(normalize_dir "$(config_get epicsDir "$ROOT/$CONFIG")" || true)"
    want="$(config_get store "$ROOT/$CONFIG")"
    folder="$(config_get vaultFolder "$ROOT/$CONFIG")"
    CONFIGURED=true
  else
    CONFIGURED=false
  fi
  OLD_STORIES="$ROOT/${s:-$DEFAULT_STORIES}"
  OLD_EPICS="$ROOT/${e:-$DEFAULT_EPICS}"
  VAULT="$(config_get vault "$USER_CONFIG")"
  if [ -n "$VAULT" ] && [ ! -d "$VAULT" ]; then
    NOTES="${NOTES}configured vault not found: $VAULT; "
    VAULT=""
  fi
  case "$want" in
    repo) STORE=repo ;;
    vault) [ -n "$VAULT" ] || die "$CONFIG asks for the vault store, but no vault is configured in $USER_CONFIG"; STORE=vault ;;
    "") if [ -n "$VAULT" ]; then STORE=vault; else STORE=repo; fi ;;
    *) die "unknown store '$want' in $CONFIG (use vault or repo)" ;;
  esac
  if [ "$STORE" = vault ]; then
    projects="$(config_get projectsFolder "$USER_CONFIG")"
    [ -n "$projects" ] || projects="$(config_get projectsFolder "$VAULT/$DOTPM_SETTINGS")"
    projects="$(normalize_dir "${projects:-Projects}")" || die "projectsFolder must be a relative folder inside the vault"
    if [ -n "$folder" ]; then
      folder="$(normalize_dir "$folder")" || die "vaultFolder in $CONFIG must be a relative folder"
    else
      folder="$(repo_name)"
    fi
    STORIES="$VAULT/$projects/$folder/stories"
    EPICS="$VAULT/$projects/$folder/epics"
    if [ "$want" = vault ]; then SOURCE=config; else SOURCE=vault; fi
  else
    STORIES="$OLD_STORIES"
    EPICS="$OLD_EPICS"
    if [ "$CONFIGURED" = true ]; then SOURCE=config
    elif [ -d "$STORIES" ] || [ -d "$EPICS" ]; then SOURCE=detected
    else SOURCE=default; fi
    if [ "$CONFIGURED" = false ]; then
      for d in specs docs/specs openspec; do
        if [ -d "$ROOT/$d" ]; then NOTES="${NOTES}existing spec directory: $d; "; fi
      done
    fi
  fi
  if [ -f "$ROOT/tasks/plan.md" ]; then NOTES="${NOTES}legacy single-plan layout: tasks/plan.md; "; fi
  if old_layout_present; then NOTES="${NOTES}old task layout under ${OLD_STORIES#"$ROOT"/}: run work-state.sh migrate; "; fi
  return 0
}

# Stories still in the pre-dotpm layout: <stories>/<id>/tasks/*.md, or, with the
# vault store, any story or epic left in the repository.
old_layout_present() {
  local d
  for d in "$OLD_STORIES"/*/tasks; do [ -d "$d" ] && return 0; done
  if [ "$STORE" = vault ]; then
    for d in "$OLD_STORIES"/*/ "$OLD_EPICS"/*/; do [ -d "$d" ] && return 0; done
  fi
  return 1
}

# A story directory: any directory under the stories dir except the epics dir,
# which some repositories keep inside it.
is_story_dir() {
  local d="${1%/}"
  [ -d "$d" ] && [ "$d" != "$EPICS" ] && [ "$d" != "$OLD_EPICS" ]
}

# The remote claims are published to: origin if present, else the first remote.
remote_name() {
  local r
  r="$(git remote 2>/dev/null | grep -x origin || true)"
  [ -n "$r" ] || r="$(git remote 2>/dev/null | head -n 1 || true)"
  printf '%s' "$r"
}

# Refresh remote claims; stale ones are pruned. Offline is not an error.
refresh() {
  local r ; r="$(remote_name)"
  if [ -n "$r" ]; then git fetch --prune --quiet "$r" 2>/dev/null || true; fi
  return 0
}

current_branch() { git symbolic-ref --quiet --short HEAD 2>/dev/null || echo HEAD; }

now_iso() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }
today() { date +%Y-%m-%d; }

# A dotpm id: 8 random base-36 characters, then the time in ms as base 36.
pm_id() {
  local r
  r="$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom 2>/dev/null | head -c 8 || true)"
  awk -v r="$r" -v n="$(date +%s)000" 'BEGIN {
    d = "0123456789abcdefghijklmnopqrstuvwxyz"; s = ""
    while (n > 0) { s = substr(d, n % 36 + 1, 1) s; n = int(n / 36) }
    print r s }'
}

# dotpm's file name for a title: \ / : * ? " < > | become "-", lowercase,
# whitespace runs become "-", at most 60 characters.
slug() {
  printf '%s' "$1" | sed 's/[\\/:*?"<>|]/-/g' | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[[:space:]]+/-/g' | cut -c1-60
}

# A title whose slug is ID ("t02-apply-event" → "T02 apply event"), else ID.
title_for_id() {
  local t
  t="$(printf '%s' "$1" | awk -F- '{ s = toupper($1); for (i = 2; i <= NF; i++) s = s " " $i; print s }')"
  if [ "$(slug "$t")" = "$1" ]; then printf '%s' "$t"; else printf '%s' "$1"; fi
}

# A YAML double-quoted string.
q() { printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"; }

valid_id() {
  case "$1" in ""|*/*|.*) return 1 ;; esac
  return 0
}

# ── reading notes (markdown on stdin) ────────────────────────────────────────

# Top-level frontmatter value. Quoted values are unquoted; plain ones lose comments.
fm_value_awk='
  function val(v) {
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", v)
    if (v ~ /^"/) { v = substr(v, 2); sub(/"[^"]*$/, "", v); gsub(/\\"/, "\"", v); gsub(/\\\\/, "\\", v); return v }
    if (v ~ /^\047/) { v = substr(v, 2); sub(/\047[^\047]*$/, "", v); return v }
    sub(/[[:space:]]+#.*/, "", v); return v
  }'

fm() {
  awk -v k="$1" "$fm_value_awk"'
    NR == 1 && $0 != "---" { exit }
    NR > 1 && $0 == "---" { exit }
    NR > 1 {
      i = index($0, ":")
      if (i && substr($0, 1, i - 1) == k) { print val(substr($0, i + 1)); exit }
    }'
}

# customFields.KEY of a task note.
cf() {
  awk -v k="$1" "$fm_value_awk"'
    NR == 1 && $0 != "---" { exit }
    NR > 1 && $0 == "---" { exit }
    NR > 1 && /^[^[:space:]]/ { on = ($0 ~ /^customFields:[[:space:]]*$/); next }
    on {
      l = $0; sub(/^[[:space:]]+/, "", l); i = index(l, ":")
      if (i && substr(l, 1, i - 1) == k) { print val(substr(l, i + 1)); exit }
    }'
}

# Lines of section "## NAME", up to the next heading or the dotpm footer.
section() {
  awk -v h="## $1" '
    /^## / { l = $0; sub(/[[:space:]]+$/, "", l); on = (l == h); next }
    /^(Project|Parent): \[\[/ { on = 0 }
    on { print }'
}

checklist() {
  section Checklist | awk '
    /^[[:space:]]*- \[[ xX]\]/ { t++; if ($0 ~ /- \[[xX]\]/) d++ }
    END { if (t) printf "%d/%d", d, t }'
}

last_log() {
  section Log | awk '/[^[:space:]]/ && $0 !~ /^<!--/ { l = $0 } END { print l }'
}

# Dependency ids from the dotpm "dependencies:" list of wikilinks.
deps_of() {
  awk '
    NR == 1 && $0 != "---" { exit }
    NR > 1 && $0 == "---" { exit }
    on && /^[[:space:]]+-/ { print; next }
    on { exit }
    /^dependencies:/ { v = substr($0, 14); if (v ~ /[^[:space:]]/) { print v; exit } on = 1 }' \
    | { grep -oE '\[\[[^]|]+' || true; } | sed -e 's/^\[\[//' -e 's#.*/##' -e 's/\.md$//' | tr '\n' ' '
}

# Whether a status counts as complete (dotpm: done and cancelled).
complete() { [ "$1" = done ] || [ "$1" = cancelled ]; }

# ── writing notes ────────────────────────────────────────────────────────────

# Replace FILE atomically with stdin.
replace() { local tmp="$1.tmp.$$"; cat > "$tmp" && mv "$tmp" "$1"; }

# Set (or, with DEL=1, delete) top-level frontmatter KEY to the raw YAML VAL.
fm_put() {
  KEY="$2" VAL="$3" DEL="${4:-0}" awk '
    BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VAL"]; del = ENVIRON["DEL"] == "1" }
    NR == 1 && $0 == "---" { infm = 1; print; next }
    function out() { print k ":" (substr(v, 1, 1) == "\n" ? v : " " v) }
    infm && $0 == "---" { if (!done && !del) out(); infm = 0; print; next }
    infm && skip && /^[[:space:]]/ { next }
    infm { skip = 0 }
    infm && index($0, k ":") == 1 { done = 1; skip = 1; if (!del) out(); next }
    { print }' "$1" | replace "$1"
}

# Drop a frontmatter block left empty ("---" twice at the top).
strip_empty_fm() {
  awk 'NR == 1 && $0 == "---" { first = 1; next }
       NR == 2 && first && $0 == "---" { first = 0; skip = 1; next }
       NR == 2 && first { print "---" }
       skip && NR == 3 && $0 == "" { next }
       { print }' "$1" | replace "$1"
}

# Set customFields.KEY to the raw YAML VAL, creating the block when needed.
cf_put() {
  KEY="$2" VAL="$3" awk '
    BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VAL"] }
    function add() { if (!done) { if (!seen) print "customFields:"; print "  " k ": " v; done = 1 } }
    NR == 1 && $0 == "---" { infm = 1; print; next }
    infm && $0 == "---" { add(); infm = 0; print; next }
    infm && /^[^[:space:]]/ {
      if (incf) add()
      incf = ($0 ~ /^customFields:/)
      if (incf) { seen = 1; print "customFields:"; next }
      print; next
    }
    infm && incf { l = $0; sub(/^[[:space:]]+/, "", l); if (index(l, k ":") == 1) { print "  " k ": " v; done = 1; next } }
    { print }' "$1" | replace "$1"
}

touch_updated() { fm_put "$1" updatedAt "$(now_iso)"; }

# Append LINE as the last line of section "## NAME", creating the section
# before the dotpm footer when it is missing.
section_append() {
  NAME="## $2" LINE="$3" awk '
    BEGIN { h = ENVIRON["NAME"]; line = ENVIRON["LINE"] }
    { a[NR] = $0 }
    END {
      s = 0
      for (i = 1; i <= NR; i++) { l = a[i]; sub(/[[:space:]]+$/, "", l); if (l == h) { s = i; break } }
      if (!s) {
        f = NR + 1
        for (i = NR; i >= 1; i--) if (a[i] ~ /^(Project|Parent): \[\[/) { f = i; break }
        for (i = 1; i < f; i++) print a[i]
        print h; print line; print ""
        for (i = f; i <= NR; i++) print a[i]
        exit
      }
      e = NR + 1
      for (i = s + 1; i <= NR; i++) if (a[i] ~ /^## / || a[i] ~ /^(Project|Parent): \[\[/) { e = i; break }
      last = s
      for (i = s + 1; i < e; i++) if (a[i] ~ /[^[:space:]]/) last = i
      for (i = 1; i <= last; i++) print a[i]
      print line
      for (i = last + 1; i <= NR; i++) print a[i]
    }' "$1" | replace "$1"
}

# Recompute a task's progress: 100 when done, else the share of ticked
# checklist boxes (left alone when there is no checklist).
update_progress() {
  local file="$1" status c d t
  status="$(fm status < "$file")"
  if [ "$status" = done ]; then fm_put "$file" progress 100; return 0; fi
  c="$(checklist < "$file")"
  if [ -n "$c" ]; then
    d="${c%/*}" ; t="${c#*/}"
    fm_put "$file" progress "$((d * 100 / t))"
  fi
  return 0
}

# Wikilink target for a note: its path in the vault store, where task ids like
# t01-* repeat across stories and repositories, else its name.
link_target() {
  local p
  if [ "$STORE" = vault ]; then p="${1#"$VAULT"/}"; else p="$(basename "$1")"; fi
  printf '%s' "${p%.md}"
}

# [[target|title]]; the title defaults to the note's own.
link() { printf '[[%s|%s]]' "$(link_target "$1")" "${2:-$(fm title < "$1")}"; }

# A dotpm project note. FIELDS=1 declares the agent's custom task fields.
write_project() {
  local file="$1" title="$2" parent="$3" fields="$4" now
  now="$(now_iso)"
  mkdir -p "$(dirname "$file")"
  {
    echo "---"
    echo "pm-project: true"
    echo "id: $(q "$(pm_id)")"
    echo "title: $(q "$title")"
    echo 'description: ""'
    echo 'color: "#8b72be"'
    echo 'icon: "📋"'
    echo "taskIds: []"
    if [ -n "$parent" ]; then echo "parent: $(q "[[$parent]]")"; fi
    if [ "$fields" = 1 ]; then
      echo "customFields:"
      echo '  - id: "design_refs"'
      echo '    name: "Design refs"'
      echo '    type: "text"'
      echo '  - id: "branch"'
      echo '    name: "Branch"'
      echo '    type: "text"'
      echo '  - id: "design_approved"'
      echo '    name: "Design approved"'
      echo '    type: "text"'
    else
      echo "customFields: []"
    fi
    echo "teamMembers: []"
    echo "savedViews: []"
    echo "createdAt: $(q "$now")"
    echo "updatedAt: $(q "$now")"
    echo "---"
    echo
    echo "# 📋 $title"
    echo
  } > "$file"
}

# Add LINK to a project note's taskIds and to its "## Tasks" list.
project_add_task() {
  LINK="$2" awk '
    BEGIN { link = ENVIRON["LINK"]; ql = "\"" link "\"" }
    { a[NR] = $0 }
    END {
      t = 0; e = 0
      for (i = 1; i <= NR; i++) if (a[i] == "## Tasks") { t = i; break }
      if (t) { e = t; for (i = t + 1; i <= NR && a[i] !~ /^## /; i++) if (a[i] ~ /^- \[/) e = i }
      infm = 0; blk = 0
      for (i = 1; i <= NR; i++) {
        l = a[i]
        if (i == 1 && l == "---") { infm = 1; print l; continue }
        if (infm && blk && l !~ /^[[:space:]]+-/) { print "  - " ql; blk = 0 }
        if (infm && l == "---") { infm = 0 }
        else if (infm && l ~ /^taskIds:[[:space:]]*\[\][[:space:]]*$/) { l = "taskIds: [" ql "]" }
        else if (infm && l ~ /^taskIds:[[:space:]]*\[.*\][[:space:]]*$/) { sub(/\][[:space:]]*$/, ", " ql "]", l) }
        else if (infm && l ~ /^taskIds:[[:space:]]*$/) { blk = 1 }
        print l
        if (t && i == e) print "- [ ] " link
      }
      if (!t) { if (a[NR] != "") print ""; print "## Tasks"; print "- [ ] " link }
    }' "$1" | replace "$1"
}

# Tick or untick a task's line in its project note's "## Tasks" list.
project_tick() {
  ID="$2" MARK="$3" awk '
    BEGIN { p = "- [ ] [[" ENVIRON["ID"] "|"; x = "- [x] [[" ENVIRON["ID"] "|"; m = ENVIRON["MARK"] }
    index($0, p) == 1 || index($0, x) == 1 { $0 = "- [" m "]" substr($0, 6) }
    { print }' "$1" | replace "$1"
}

# ── claims ───────────────────────────────────────────────────────────────────

# Claim ref for STORY/TASK: the local ref, else a remote one ("" if unclaimed).
claim_ref() {
  local want="$NS/$1/$2" ref
  if git show-ref --verify --quiet "refs/heads/$want"; then echo "$want"; return 0; fi
  ref="$(git for-each-ref --format='%(refname:short)' "refs/remotes/*/$want" | head -n 1)"
  printf '%s' "$ref"
}

# Work branch recorded in a claim's commit message.
claim_work() { git log -1 --format=%s "$1" 2>/dev/null | sed -n 's/.* work=\([^ ]*\).*/\1/p'; }

worktree_of() {
  git worktree list --porcelain 2>/dev/null | awk -v b="refs/heads/$1" '
    /^worktree / { p = substr($0, 10) }
    $0 == "branch " b { print p; exit }'
}

# Freshest copy of a task note. The vault store has one copy. The repo store
# reads the work branch's worktree (uncommitted edits included), then the work
# branch, then this checkout.
task_content() {
  local story="$1" id="$2" ref="$3" rel work wt
  if [ "$STORE" = repo ] && [ -n "$ref" ]; then
    rel="${STORIES#"$ROOT"/}/$story/_tasks/$id.md"
    work="$(claim_work "$ref")"
    if [ -n "$work" ]; then
      wt="$(worktree_of "$work")"
      if [ -n "$wt" ] && [ -f "$wt/$rel" ]; then cat "$wt/$rel"; return 0; fi
      if git show "$work:$rel" 2>/dev/null; then return 0; fi
    fi
  fi
  cat "$STORIES/$story/_tasks/$id.md"
}

# Path of the freshest writable copy of a task note (see task_content).
task_path() {
  local story="$1" id="$2" ref rel work wt
  if [ "$STORE" = repo ]; then
    ref="$(claim_ref "$story" "$id")"
    if [ -n "$ref" ]; then
      rel="${STORIES#"$ROOT"/}/$story/_tasks/$id.md"
      work="$(claim_work "$ref")"
      if [ -n "$work" ]; then
        wt="$(worktree_of "$work")"
        if [ -n "$wt" ] && [ -f "$wt/$rel" ]; then echo "$wt/$rel"; return 0; fi
      fi
    fi
  fi
  echo "$STORIES/$story/_tasks/$id.md"
}

need_task() {
  [ -n "$1" ] && [ -n "$2" ] || die "usage: work-state.sh $3 STORY TASK${4:+ $4}"
  resolve
  [ -f "$STORIES/$1/_tasks/$2.md" ] || die "no task note $STORIES/$1/_tasks/$2.md"
}

# Status, progress, completed date, and updatedAt in one go. In progress under
# a claim also records the claim's work branch. The vault store also ticks the
# task in its project note.
apply_status() {
  local story="$1" task="$2" status="$3" file proj ref
  file="$(task_path "$story" "$task")"
  fm_put "$file" status "$status"
  if complete "$status"; then fm_put "$file" completed "$(today)"; else fm_put "$file" completed "" 1; fi
  ref="$(claim_ref "$story" "$task")"
  if [ "$status" = in-progress ] && [ -n "$ref" ]; then cf_put "$file" branch "$(q "$(claim_work "$ref")")"; fi
  update_progress "$file"
  touch_updated "$file"
  proj="$STORIES/$story/$story.md"
  if [ "$STORE" = vault ] && [ -f "$proj" ]; then
    if complete "$status"; then project_tick "$proj" "$(link_target "$file")" x; else project_tick "$proj" "$(link_target "$file")" " "; fi
  fi
}

cmd_claim() {
  local story="$1" task="$2" work="${3:-}" ref c r id
  need_task "$story" "$task" claim "[WORK_BRANCH]"
  [ -n "$work" ] || work="$(current_branch)"
  ref="refs/heads/$NS/$story/$task"
  refresh
  if [ -n "$(claim_ref "$story" "$task")" ]; then echo "taken: $story/$task"; exit 3; fi
  # A unique id per claim: the session that made it holds the id; nobody else can.
  id="$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM:-0}${RANDOM:-0}"
  c="$(git commit-tree "$(git rev-parse 'HEAD^{tree}')" -p HEAD \
        -m "claim $story/$task work=$work id=$id host=$(hostname 2>/dev/null || echo unknown)")"
  if ! git update-ref "$ref" "$c" "" 2>/dev/null; then echo "taken: $story/$task"; exit 3; fi
  r="$(remote_name)"
  if [ -n "$r" ]; then
    # Empty lease: the push succeeds only if no other machine holds the claim.
    # --no-verify: a pre-push hook for code must not decide who owns a lock.
    if ! git push --quiet --no-verify --force-with-lease="$ref:" "$r" "$ref:$ref" 2>/dev/null; then
      git update-ref -d "$ref" "$c" 2>/dev/null || true
      # Ask the push destination itself: fetch and push URLs can differ.
      if git ls-remote --exit-code "$(git remote get-url --push "$r" 2>/dev/null || echo "$r")" "$ref" >/dev/null 2>&1; then
        echo "taken: $story/$task"; exit 3
      fi
      echo "error: could not publish the claim to remote '$r' (offline or rejected); nothing was claimed" >&2
      exit 5
    fi
  fi
  echo "claimed: $story/$task work=$work id=$id"
  # Mark the note where the work happens. In the repo store a work branch with
  # no checkout yet would leave the change in this checkout, in the way of the
  # merge, so the note is marked from the new worktree instead.
  if [ "$STORE" = vault ] || [ "$work" = "$(current_branch)" ] || [ -n "$(worktree_of "$work")" ]; then
    apply_status "$story" "$task" in-progress
  else
    echo "next: once the worktree for $work exists, run there: work-state.sh set $story $task in-progress"
  fi
}

cmd_release() {
  local story="$1" task="$2" ref r
  [ -n "$story" ] && [ -n "$task" ] || die "usage: work-state.sh release STORY TASK"
  resolve
  ref="refs/heads/$NS/$story/$task"
  git update-ref -d "$ref" 2>/dev/null || true
  r="$(remote_name)"
  if [ -n "$r" ]; then git push --quiet --no-verify "$r" --delete "$ref" 2>/dev/null || true; fi
  echo "released: $story/$task"
}

# A dependency is finished when it is complete where `next` looks: in the repo
# store, in this checkout (merged here); in the vault store, complete with its
# lock released (a lock is released once the work is merged).
dep_finished() {
  local story="$1" dep="$2" f="$STORIES/$1/_tasks/$2.md"
  [ -f "$f" ] || return 1
  complete "$(fm status < "$f")" || return 1
  if [ "$STORE" = vault ] && [ -n "$(claim_ref "$story" "$dep")" ]; then return 1; fi
  return 0
}

cmd_next() {
  local only="${1:-}" s f id dep ok
  resolve
  refresh
  for s in "$STORIES"/*/; do
    is_story_dir "$s" || continue
    s="$(basename "$s")"
    if [ -n "$only" ] && [ "$s" != "$only" ]; then continue; fi
    for f in "$STORIES/$s"/_tasks/*.md; do
      [ -f "$f" ] || continue
      id="$(basename "$f" .md)"
      [ "$(fm status < "$f")" = todo ] || continue
      [ -z "$(claim_ref "$s" "$id")" ] || continue
      ok=1
      for dep in $(deps_of < "$f"); do
        if ! dep_finished "$s" "$dep"; then ok=0; break; fi
      done
      if [ "$ok" = 1 ]; then echo "$s/$id"; return 0; fi
    done
  done
  exit 4
}

# ── creating epics, stories, and tasks ───────────────────────────────────────

cmd_init_epic() {
  local epic="$1" title="$2" file
  valid_id "$epic" && [ -n "$title" ] || die "usage: work-state.sh init-epic EPIC TITLE"
  resolve
  file="$EPICS/$epic/$epic.md"
  if [ -f "$file" ]; then echo "exists: $file"; return 0; fi
  write_project "$file" "$title" "" 0
  echo "created: $file"
}

cmd_init_story() {
  local story="$1" title="$2" epic="${3:-}" file
  valid_id "$story" && [ -n "$title" ] || die "usage: work-state.sh init-story STORY TITLE [EPIC]"
  if [ -n "$epic" ]; then valid_id "$epic" || die "bad epic id: $epic"; fi
  resolve
  file="$STORIES/$story/$story.md"
  if [ -f "$file" ]; then echo "exists: $file"; return 0; fi
  if [ -n "$epic" ]; then epic="$(link_target "$EPICS/$epic/$epic.md")"; fi
  write_project "$file" "$title" "$epic" 1
  echo "created: $file"
}

# Write a dotpm task note. Body on stdin; empty stdin gets the section skeleton.
write_task() {
  local file="$1" story="$2" title="$3" status="$4" deps="$5" body plink now dep df
  plink="$(link "$STORIES/$story/$story.md")"
  now="$(now_iso)"
  body="$(cat)"
  mkdir -p "$(dirname "$file")"
  {
    echo "---"
    echo "pm-task: true"
    echo "projectId: $(q "$plink")"
    echo "parentId:"
    echo "id: $(pm_id)"
    echo "title: $(q "$title")"
    echo "type: task"
    echo "status: $status"
    echo "priority: medium"
    echo 'start: ""'
    echo 'due: ""'
    if [ "$status" = done ]; then echo "progress: 100"; else echo "progress: 0"; fi
    echo "assignees: []"
    echo "tags:"
    echo "  - story/$story"
    echo "subtaskIds: []"
    if [ -z "$deps" ]; then echo "dependencies: []"; else
      echo "dependencies:"
      for dep in $deps; do
        df="$STORIES/$story/_tasks/$dep.md"
        echo "  - $(q "$(link "$df")")"
      done
    fi
    echo "createdAt: $now"
    echo "updatedAt: $now"
    if complete "$status"; then echo "completed: $(today)"; fi
    echo "---"
    echo
    if [ -n "$body" ]; then printf '%s\n' "$body"; else printf '## Design\n\n## Summary\n\n## Checklist\n\n## Log\n'; fi
    echo
    echo "Project: $plink"
  } > "$file"
}

cmd_new_task() {
  local story="$1" title="$2" id file dep deps=""
  valid_id "$story" && [ -n "$title" ] || die "usage: work-state.sh new-task STORY TITLE [DEP-ID...]"
  shift 2
  resolve
  [ -f "$STORIES/$story/$story.md" ] || die "no project note for story '$story'; run work-state.sh init-story first"
  id="$(slug "$title")"
  valid_id "$id" || die "title '$title' gives no usable task id"
  file="$STORIES/$story/_tasks/$id.md"
  [ ! -f "$file" ] || die "task $story/$id already exists"
  for dep in "$@"; do
    [ -f "$STORIES/$story/_tasks/$dep.md" ] || die "unknown dependency $story/$dep"
    deps="$deps $dep"
  done
  write_task "$file" "$story" "$title" todo "$deps" < /dev/null
  project_add_task "$STORIES/$story/$story.md" "$(link "$file" "$title")"
  echo "task=$id"
  echo "path=$file"
}

cmd_path() {
  local story="$1" task="${2:-}"
  valid_id "$story" || die "usage: work-state.sh path STORY [TASK]"
  resolve
  if [ -z "$task" ]; then echo "$STORIES/$story"; return 0; fi
  [ -f "$STORIES/$story/_tasks/$task.md" ] || die "no task note $STORIES/$story/_tasks/$task.md"
  task_path "$story" "$task"
}

cmd_field() {
  local story="$1" task="$2" key="$3" value="${4:-}" file
  need_task "$story" "$task" field "KEY VALUE"
  case "$key" in ""|*[!A-Za-z0-9_-]*) die "field names are letters, digits, _ and -" ;; esac
  file="$(task_path "$story" "$task")"
  cf_put "$file" "$key" "$(q "$value")"
  touch_updated "$file"
  echo "field: $story/$task $key=$value"
}

cmd_set() {
  local story="$1" task="$2" status="${3:-}"
  need_task "$story" "$task" set STATUS
  case " $STATUSES " in *" $status "*) ;; *) die "status must be one of: $STATUSES" ;; esac
  apply_status "$story" "$task" "$status"
  echo "set: $story/$task status=$status"
}

cmd_log() {
  local story="$1" task="$2" text="${3:-}" file
  need_task "$story" "$task" log TEXT
  [ -n "$text" ] || die "usage: work-state.sh log STORY TASK TEXT"
  file="$(task_path "$story" "$task")"
  section_append "$file" Log "- $(today) $text"
  update_progress "$file"
  touch_updated "$file"
  echo "logged: $story/$task"
}

# ── design approval ──────────────────────────────────────────────────────────
#
# The approval gate records `design_approved: <date> <hash>` in the task's
# customFields, where <hash> fingerprints the `## Design` section. Editing the
# note afterwards changes the hash, so the approval no longer holds.

# The `## Design` section of markdown on stdin, without HTML comments or blank lines.
design_section() {
  section Design | awk '
    /^[[:space:]]*<!--.*-->[[:space:]]*$/ { next }
    /[^[:space:]]/ { sub(/[[:space:]]+$/, ""); print }'
}

design_hash() { design_section | git hash-object --stdin | cut -c1-12; }

# Prints "ok <date>", "missing", or "stale" for a task; exit 0, 6, or 7.
approval_state() {
  local story="$1" id="$2" content value want
  content="$(task_content "$story" "$id" "$(claim_ref "$story" "$id")")"
  value="$(printf '%s\n' "$content" | cf design_approved)"
  if [ -z "$value" ]; then echo missing; return 6; fi
  want="$(printf '%s\n' "$content" | design_hash)"
  if [ "${value##* }" != "$want" ]; then echo stale; return 7; fi
  echo "ok ${value%% *}"
}

cmd_approve() {
  local story="$1" task="$2" file stamp
  need_task "$story" "$task" approve
  file="$(task_path "$story" "$task")"
  if [ -z "$(design_section < "$file")" ]; then
    die "the task's ## Design section is empty; write the design note before approving"
  fi
  stamp="$(date -u +%Y-%m-%dT%H:%MZ) $(design_hash < "$file")"
  cf_put "$file" design_approved "$(q "$stamp")"
  touch_updated "$file"
  echo "approved: $story/$task ($stamp)"
}

cmd_approved() {
  local story="$1" task="$2" state rc
  need_task "$story" "$task" approved
  set +e; state="$(approval_state "$story" "$task")"; rc=$?; set -e
  case "$state" in
    ok*) echo "approved: $story/$task (${state#ok })" ;;
    missing) echo "not approved: $story/$task has no approved design; run the approval gate" ;;
    stale) echo "not approved: $story/$task's design changed after approval; run the gate again" ;;
  esac
  exit "$rc"
}

# ── brief: the minimum context one task needs ────────────────────────────────

# Blank-line-separated blocks of FILE that mention ID as a whole word, each
# followed by the table right after it when the block introduces one.
blocks_mentioning() {
  awk -v id="$1" '
    function flush() {
      if (b != "") {
        if (want || (prev && b ~ /^\|/)) { printf "%s\n\n", b; prev = !(b ~ /^\|/) && want } else prev = 0
      }
      b = ""; want = 0
    }
    /^[[:space:]]*$/ { flush(); next }
    { b = (b == "" ? $0 : b "\n" $0)
      line = " " $0 " "; gsub(/[^A-Za-z0-9_-]/, " ", line)
      if (index(line, " " id " ")) want = 1 }
    END { flush() }' "$2"
}

cmd_brief() {
  local story="$1" task="$2" ref content spec plan refs req r
  need_task "$story" "$task" brief
  ref="$(claim_ref "$story" "$task")"
  content="$(task_content "$story" "$task" "$ref")"
  spec="$STORIES/$story/spec.md"
  plan="$STORIES/$story/plan.md"
  echo "== approval: $(approval_state "$story" "$task" || true)"
  echo "== task $(task_path "$story" "$task")"
  printf '%s\n' "$content"
  if [ -f "$plan" ]; then
    echo ; echo "== plan row"
    grep -F -- "$task" "$plan" || echo "(not listed in plan.md)"
  fi
  [ -f "$spec" ] || { echo; echo "== no spec at $spec"; return 0; }
  refs="$(printf '%s\n' "$content" | cf design_refs | tr -d '[]"' | tr ',' ' ')"
  for r in $refs; do
    echo ; echo "== design $r (from spec.md)"
    blocks_mentioning "$r" "$spec"
  done
  # Requirement ids the task names in its own text (FR1, NFR3, ...).
  req="$(printf '%s\n' "$content" | grep -oE '\bN?FR[0-9]+\b' | sort -u | tr '\n' ' ' || true)"
  for r in $req; do
    echo ; echo "== requirement $r (from spec.md)"
    grep -E -- "(^|[^A-Za-z0-9])$r([^0-9]|$)" "$spec" | head -n 5 || true
  done
  return 0
}

# ── phase: where a story stands ──────────────────────────────────────────────

# none   no story directory yet                     → start with the spec
# spec   no spec.md                                 → write the spec
# design no plan yet and spec.md has no "## Design" → high-level design
# plan   no plan.md, or no task notes               → plan the tasks
# build  some task is not complete                  → build the tasks
# done   every task is done or cancelled
# A planned story is past design even without "## Design": small stories skip it.
cmd_phase() {
  local story="$1" dir f any=0 open=0 id
  valid_id "$story" || die "usage: work-state.sh phase STORY"
  resolve
  dir="$STORIES/$story"
  if [ ! -d "$dir" ]; then echo "phase=none"; return 0; fi
  if [ ! -f "$dir/spec.md" ]; then echo "phase=spec"; return 0; fi
  for f in "$dir"/_tasks/*.md; do
    [ -f "$f" ] || continue
    any=1
    id="$(basename "$f" .md)"
    complete "$(task_content "$story" "$id" "$(claim_ref "$story" "$id")" | fm status)" || open=$((open + 1))
  done
  if [ ! -f "$dir/plan.md" ] || [ "$any" = 0 ]; then
    if ! grep -q '^## Design[[:space:]]*$' "$dir/spec.md"; then echo "phase=design"; return 0; fi
    echo "phase=plan"; return 0
  fi
  if [ "$open" -gt 0 ]; then echo "phase=build"; echo "open_tasks=$open"; return 0; fi
  echo "phase=done"
}

# ── status tree ──────────────────────────────────────────────────────────────

task_line() {
  local story="$1" file="$2" id ref content status mark extra chk work wt log
  id="$(basename "$file" .md)"
  ref="$(claim_ref "$story" "$id")"
  content="$(task_content "$story" "$id" "$ref")"
  status="$(printf '%s\n' "$content" | fm status)"
  case "$status" in
    done|cancelled) mark="[x]" ;;
    blocked) mark="[!]" ;;
    in-progress|review) mark="[~]" ;;
    *) if [ -n "$ref" ]; then mark="[~]"; else mark="[ ]"; fi ;;
  esac
  extra=""
  [ "$status" = cancelled ] && extra=" cancelled"
  [ "$status" = review ] && extra=" review"
  if [ -n "$ref" ]; then
    work="$(claim_work "$ref")"
    extra="$extra claimed: $ref"
    [ -n "$work" ] && extra="$extra · work $work"
    if complete "$status"; then
      if [ -n "$work" ] && git merge-base --is-ancestor "$work" HEAD 2>/dev/null; then
        extra="$extra · merged, release the lock"
      else
        extra="$extra · not yet merged"
      fi
    fi
  fi
  chk="$(printf '%s\n' "$content" | checklist)"
  [ -n "$chk" ] && extra="$extra · checklist $chk"
  if ! complete "$status"; then
    case "$(approval_state "$story" "$id" || true)" in
      ok*) extra="$extra · design ✓" ;;
      stale) extra="$extra · design ✗ (changed since approval)" ;;
      *) extra="$extra · design ✗" ;;
    esac
  fi
  if [ "$mark" = "[~]" ] || [ "$mark" = "[!]" ]; then
    wt=""
    [ -n "${work:-}" ] && wt="$(worktree_of "$work")"
    if [ -n "$wt" ] && [ "$wt" != "$ROOT" ]; then extra="$extra · worktree $wt"; fi
    log="$(printf '%s\n' "$content" | last_log)"
    [ -n "$log" ] && extra="$extra · last log: $log"
  fi
  echo "    $mark $id$extra"
}

group_mark() {
  local total="$1" done="$2" lines="$3"
  if [ "$total" -gt 0 ] && [ "$done" -eq "$total" ]; then echo "[x]"
  elif printf '%s' "$lines" | grep -q '\[[x~!]\]'; then echo "[~]"
  else echo "[ ]"; fi
}

story_block() {
  local story="$1" f lines total done
  lines=""
  for f in "$STORIES/$story"/_tasks/*.md; do
    [ -f "$f" ] || continue
    lines="$lines$(task_line "$story" "$f")
"
  done
  total="$(printf '%s' "$lines" | grep -c '^    \[' || true)"
  done="$(printf '%s' "$lines" | grep -c '^    \[x\]' || true)"
  echo "  $(group_mark "$total" "$done" "$lines") story $story  $done/$total tasks"
  printf '%s' "$lines"
}

# The story's epic: the project note's parent link.
story_epic() {
  local p="$STORIES/$1/$1.md"
  if [ -f "$p" ]; then fm parent < "$p" | sed -e 's/^\[\[//' -e 's/\]\]$//' -e 's/|.*//' -e 's#.*/##'; fi
  return 0
}

cmd_status() {
  resolve
  local only="$1" s e epics_seen="" out n d
  [ -d "$STORIES" ] || { echo "no stories under $STORIES"; return 0; }
  if [ -n "$only" ]; then
    [ -d "$STORIES/$only" ] || die "no story '$only' under $STORIES"
    story_block "$only"
    return 0
  fi
  for s in "$STORIES"/*/; do
    is_story_dir "$s" || continue
    e="$(story_epic "$(basename "$s")")"
    case " $epics_seen " in *" ${e:-_none} "*) ;; *) epics_seen="$epics_seen ${e:-_none}" ;; esac
  done
  for e in $epics_seen; do
    out=""
    for s in "$STORIES"/*/; do
      is_story_dir "$s" || continue
      s="$(basename "$s")"
      [ "$(story_epic "$s")" = "$( [ "$e" = _none ] || echo "$e")" ] || continue
      out="$out$(story_block "$s")
"
    done
    n="$(printf '%s' "$out" | grep -c '^  \[.\] story ' || true)"
    d="$(printf '%s' "$out" | grep -c '^  \[x\] story ' || true)"
    if [ "$e" = _none ]; then echo "(no epic)"
    else echo "$(group_mark "$n" "$d" "$out") epic $e  $d/$n stories"; fi
    printf '%s' "$out"
  done
}

# ── migrate: the pre-dotpm layout into the store ─────────────────────────────

# First "# " heading of FILE without a leading "Spec:"/"Epic:" label, else FALLBACK.
heading_of() {
  local h=""
  if [ -f "$1" ]; then h="$(sed -n 's/^# //p' "$1" | head -n 1 | sed -E 's/^(Spec|Epic|Story)[[:space:]]*[:-][[:space:]]*//')"; fi
  printf '%s' "${h:-$2}"
}

# Body of an old task file: frontmatter dropped, "## Subtasks" renamed, and the
# four sections present.
old_task_body() {
  awk '
    NR == 1 && $0 == "---" { infm = 1; next }
    infm { if ($0 == "---") infm = 0; next }
    /^## Subtasks[[:space:]]*$/ { $0 = "## Checklist" }
    /^## (Design|Summary|Checklist|Log)[[:space:]]*$/ { seen[$2] = 1 }
    { b[++n] = $0 }
    END {
      while (n > 0 && b[n] ~ /^[[:space:]]*$/) n--
      s = 1; while (s <= n && b[s] ~ /^[[:space:]]*$/) s++
      for (i = s; i <= n; i++) print b[i]
      split("Design Summary Checklist Log", want, " ")
      for (j = 1; j <= 4; j++) if (!seen[want[j]]) { print ""; print "## " want[j] }
    }'
}

old_status() {
  case "$1" in
    pending|"") echo todo ;;
    claimed) echo in-progress ;;
    *) echo "$1" ;;
  esac
}

# Old frontmatter list ("[a, b]" or a block list) as space-separated values.
old_list() {
  awk -v k="$1" '
    NR == 1 && $0 != "---" { exit }
    NR > 1 && $0 == "---" { exit }
    on && /^[[:space:]]+-/ { v = $0; sub(/^[[:space:]]+-[[:space:]]*/, "", v); print v; next }
    on { exit }
    index($0, k ":") == 1 {
      v = substr($0, length(k) + 2); sub(/[[:space:]]+#.*/, "", v); gsub(/[][,]/, " ", v)
      if (v ~ /[^[:space:]]/) { print v; exit }
      on = 1
    }' | tr -d "\"'" | tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//'
}

# Old task content: with a live claim, the work branch's worktree copy.
old_task_content() {
  local story="$1" id="$2" rel ref work wt
  rel="${OLD_STORIES#"$ROOT"/}/$story/tasks/$id.md"
  ref="$(claim_ref "$story" "$id")"
  if [ -n "$ref" ]; then
    work="$(claim_work "$ref")"
    wt="$(worktree_of "$work")"
    if [ -n "$wt" ] && [ -f "$wt/$rel" ]; then cat "$wt/$rel"; return 0; fi
  fi
  cat "$ROOT/$rel"
}

migrate_task() {
  local story="$1" old="$2" id content status deps refs owner approved file
  id="$(basename "$old" .md)"
  content="$(old_task_content "$story" "$id")"
  status="$(old_status "$(printf '%s\n' "$content" | fm status)")"
  deps="$(printf '%s\n' "$content" | old_list depends_on)"
  refs="$(printf '%s\n' "$content" | old_list design_refs | sed 's/ /, /g')"
  owner="$(printf '%s\n' "$content" | fm owner)"
  approved="$(printf '%s\n' "$content" | fm design_approved)"
  file="$STORIES/$story/_tasks/$id.md"
  printf '%s\n' "$content" | old_task_body | write_task "$file" "$story" "$(title_for_id "$id")" "$status" ""
  if [ -n "$deps" ]; then
    # Dependencies point at task notes written in the same pass; add them after.
    MIGRATE_DEPS="$MIGRATE_DEPS
$id $deps"
  fi
  if [ -n "$refs" ]; then cf_put "$file" design_refs "$(q "$refs")"; fi
  if [ -n "$owner" ]; then cf_put "$file" branch "$(q "$owner")"; fi
  if [ -n "$approved" ]; then cf_put "$file" design_approved "$(q "$approved")"; fi
  project_add_task "$STORIES/$story/$story.md" "$(link "$file")"
  if [ "$STORE" = vault ] && complete "$status"; then project_tick "$STORIES/$story/$story.md" "$(link_target "$file")" x; fi
}

# Rewrite the dependencies of migrated tasks as wikilinks.
migrate_deps() {
  local story="$1" id deps dep file list
  printf '%s\n' "$MIGRATE_DEPS" | while read -r id deps; do
    [ -n "$id" ] || continue
    file="$STORIES/$story/_tasks/$id.md"
    list=""
    for dep in $deps; do
      if [ -f "$STORIES/$story/_tasks/$dep.md" ]; then
        list="$list
  - $(q "$(link "$STORIES/$story/_tasks/$dep.md")")"
      else
        list="$list
  - $(q "[[$dep]]")"
      fi
    done
    fm_put "$file" dependencies "$list"
  done
}

migrate_story() {
  local story="$1" src="$OLD_STORIES/$1" dest="$STORIES/$1" epic title f claims
  if [ "$STORE" = repo ]; then
    [ -d "$src/tasks" ] || return 0
    claims="$(git for-each-ref --format='%(refname:short)' "refs/heads/$NS/$story" "refs/remotes/*/$NS/$story" || true)"
    if [ -n "$claims" ]; then
      echo "skipped: $story has live claims ($(printf '%s' "$claims" | tr '\n' ' ')); finish or release them, then migrate"
      return 0
    fi
  else
    [ ! -e "$dest" ] || die "$dest already exists; move it aside before migrating $story"
    mkdir -p "$dest"
    (cd "$src" && find . -path ./tasks -prune -o -type f -print) | while read -r f; do
      mkdir -p "$dest/$(dirname "$f")"
      cp -p "$src/$f" "$dest/$f"
    done
  fi
  epic=""
  if [ -f "$dest/plan.md" ]; then
    epic="$(fm epic < "$dest/plan.md")"
    if [ -n "$epic" ]; then fm_put "$dest/plan.md" epic "" 1; strip_empty_fm "$dest/plan.md"; fi
  fi
  if [ -z "$epic" ] && [ -f "$dest/spec.md" ]; then epic="$(fm epic < "$dest/spec.md")"; fi
  epic="$(printf '%s' "$epic" | tr -d '[]"' | sed 's/,.*//; s/^ *//; s/ *$//')"
  if [ -d "$src/tasks" ] || [ -f "$dest/plan.md" ]; then
    title="$(heading_of "$dest/spec.md" "$story")"
    if [ -n "$epic" ]; then epic="$(link_target "$EPICS/$epic/$epic.md")"; fi
    [ -f "$dest/$story.md" ] || write_project "$dest/$story.md" "$title" "$epic" 1
    MIGRATE_DEPS=""
    for f in "$src"/tasks/*.md; do
      [ -f "$f" ] || continue
      migrate_task "$story" "$f"
    done
    migrate_deps "$story"
  fi
  if [ "$STORE" = vault ]; then
    rm -rf "$src"
    echo "migrated: story $story → $dest (removed ${src#"$ROOT"/} from the repository; commit the deletion)"
  else
    rm -rf "$src/tasks"
    echo "migrated: story $story → $dest/_tasks"
  fi
}

migrate_epic() {
  local epic="$1" src="$OLD_EPICS/$1" dest="$EPICS/$1" f
  if [ "$STORE" = vault ]; then
    [ ! -e "$dest" ] || die "$dest already exists; move it aside before migrating epic $epic"
    mkdir -p "$dest"
    (cd "$src" && find . -type f -print) | while read -r f; do
      mkdir -p "$dest/$(dirname "$f")"
      cp -p "$src/$f" "$dest/$f"
    done
  fi
  if [ ! -f "$dest/$epic.md" ]; then write_project "$dest/$epic.md" "$(heading_of "$dest/epic.md" "$epic")" "" 0; fi
  if [ "$STORE" = vault ]; then
    rm -rf "$src"
    echo "migrated: epic $epic → $dest (removed ${src#"$ROOT"/} from the repository; commit the deletion)"
  else
    echo "migrated: epic $epic"
  fi
}

cmd_migrate() {
  local only="${1:-}" s e any=0
  resolve
  if [ -z "$only" ]; then
    for e in "$OLD_EPICS"/*/; do
      [ -d "$e" ] || continue
      e="$(basename "$e")"
      if [ "$STORE" = repo ] && [ -f "$EPICS/$e/$e.md" ]; then continue; fi
      migrate_epic "$e"; any=1
    done
  fi
  for s in "$OLD_STORIES"/*/; do
    is_story_dir "$s" || continue
    s="$(basename "$s")"
    if [ -n "$only" ] && [ "$s" != "$only" ]; then continue; fi
    if [ "$STORE" = repo ] && [ ! -d "$OLD_STORIES/$s/tasks" ]; then continue; fi
    migrate_story "$s"; any=1
  done
  if [ "$STORE" = vault ] && [ -d "$OLD_STORIES" ] && [ -z "$(ls -A "$OLD_STORIES" 2>/dev/null)" ]; then rmdir "$OLD_STORIES"; fi
  if [ "$STORE" = vault ] && [ -d "$OLD_EPICS" ] && [ -z "$(ls -A "$OLD_EPICS" 2>/dev/null)" ]; then rmdir "$OLD_EPICS"; fi
  [ "$any" = 1 ] || echo "nothing to migrate"
}

# ── configure / root / hint ──────────────────────────────────────────────────

cmd_root() {
  resolve
  echo "store=$STORE"
  echo "repo_root=$ROOT"
  echo "stories_dir=$STORIES"
  echo "epics_dir=$EPICS"
  echo "configured=$CONFIGURED"
  echo "source=$SOURCE"
  if [ "$STORE" = vault ]; then echo "vault=$VAULT"; fi
  if [ -n "$NOTES" ]; then echo "notes=${NOTES%; }"; fi
}

cmd_configure() {
  local s e store="" folder=""
  [ -n "${1:-}" ] || die "usage: work-state.sh configure STORIES_DIR [EPICS_DIR]"
  case "$1${2:-}" in *\"*|*\\*) die "directory names may not contain quotes or backslashes" ;; esac
  s="$(normalize_dir "$1")" || die "use a relative path inside the repository: $1"
  e="$(normalize_dir "${2:-$DEFAULT_EPICS}")" || die "use a relative path inside the repository: $2"
  ROOT="$(repo_root)" || true
  [ -n "$ROOT" ] || die "not inside a git repository"
  store="$(config_get store "$ROOT/$CONFIG")"
  folder="$(config_get vaultFolder "$ROOT/$CONFIG")"
  {
    printf '{\n  "storiesDir": "%s",\n  "epicsDir": "%s"' "$s" "$e"
    if [ -n "$store" ]; then printf ',\n  "store": "%s"' "$store"; fi
    if [ -n "$folder" ]; then printf ',\n  "vaultFolder": "%s"' "$folder"; fi
    printf '\n}\n'
  } > "$ROOT/$CONFIG"
  echo "wrote $CONFIG: storiesDir=$s epicsDir=$e"
}

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk 'BEGIN{ORS="\\n"} {print}' | sed 's/\\n$//'; }

cmd_hint() {
  ROOT="$(repo_root)" || true
  [ -n "$ROOT" ] || return 0
  ( resolve ) >/dev/null 2>&1 || return 0
  resolve 2>/dev/null
  [ -d "$STORIES" ] || return 0
  local branch claims mine="" msg=""
  branch="$(current_branch)"
  # Local claims only: SessionStart must stay fast and offline.
  claims="$(git for-each-ref --format='%(refname:short)' "refs/heads/$NS" || true)"
  [ -n "$claims" ] || return 0
  for c in $claims; do
    if [ "$(claim_work "$c")" = "$branch" ]; then mine="$mine ${c#"$NS"/}"; fi
  done
  if [ -n "$mine" ]; then
    msg="Claimed task(s) with this checkout ($branch) as their work branch:$mine. Another session may still be working on them. If one is yours from a closed session, run /resume to restore its state; never continue it without that."
  else
    msg="Tasks are claimed in this repository: $(printf '%s' "$claims" | sed "s#^$NS/##" | tr '\n' ' ' | sed 's/ $//'). Run /resume to see the state of each story."
  fi
  printf '{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "agent-skills: %s"}}\n' "$(json_escape "$msg")"
}

case "${1:-}" in
  root) cmd_root ;;
  configure) shift; cmd_configure "$@" ;;
  init-epic) shift; cmd_init_epic "${1:-}" "${2:-}" ;;
  init-story) shift; cmd_init_story "${1:-}" "${2:-}" "${3:-}" ;;
  new-task) shift; cmd_new_task "$@" ;;
  path) shift; cmd_path "${1:-}" "${2:-}" ;;
  field) shift; cmd_field "${1:-}" "${2:-}" "${3:-}" "${4:-}" ;;
  set) shift; cmd_set "${1:-}" "${2:-}" "${3:-}" ;;
  log) shift; cmd_log "${1:-}" "${2:-}" "${3:-}" ;;
  next) shift; cmd_next "${1:-}" ;;
  claim) shift; cmd_claim "${1:-}" "${2:-}" "${3:-}" ;;
  release) shift; cmd_release "${1:-}" "${2:-}" ;;
  status) shift; cmd_status "${1:-}" ;;
  brief) shift; cmd_brief "${1:-}" "${2:-}" ;;
  phase) shift; cmd_phase "${1:-}" ;;
  approve) shift; cmd_approve "${1:-}" "${2:-}" ;;
  approved) shift; cmd_approved "${1:-}" "${2:-}" ;;
  migrate) shift; cmd_migrate "${1:-}" ;;
  hint) cmd_hint ;;
  *) die "usage: work-state.sh {root|configure DIR [EPICS_DIR]|init-epic EPIC TITLE|init-story STORY TITLE [EPIC]|new-task STORY TITLE [DEP...]|path STORY [TASK]|field STORY TASK KEY VALUE|set STORY TASK STATUS|log STORY TASK TEXT|next [STORY]|claim STORY TASK [WORK]|release STORY TASK|status [STORY]|brief STORY TASK|phase STORY|approve STORY TASK|approved STORY TASK|migrate [STORY]|hint}" ;;
esac
