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
#   work-state.sh new-task STORY TITLE [DEP...]  create a task note; the title keeps letters and
#                                             digits only, and its slug is the id
#   work-state.sh path STORY [TASK]           story directory, or the freshest writable task note
#   work-state.sh field STORY TASK KEY VALUE  set customFields.KEY on a task
#   work-state.sh set STORY TASK STATUS       todo | in-progress | blocked | review | done | cancelled
#   work-state.sh log STORY TASK TEXT         append a dated line to the task's ## Log
#   work-state.sh next [STORY-ID]             first claimable task: "story/task" (exit 4 if none)
#   work-state.sh ready STORY                 every task that can start now, "story/task" per line in plan
#                                             order: todo, unclaimed, design approved, dependencies complete,
#                                             and no file shared with a running task or an earlier line;
#                                             "skipped:" lines on stderr say which task held one back (exit 4 if none)
#   work-state.sh claim STORY TASK [WORK]     take the lock, then mark the task in-progress;
#                                             exit 3 if another session holds it,
#                                             exit 5 if the claim couldn't be published
#   work-state.sh release STORY TASK          drop the lock (local and remote)
#   work-state.sh status [STORY-ID]           ticked tree: epics → stories → tasks → checklist
#   work-state.sh brief STORY TASK            task note + plan row + only the spec sections it cites
#   work-state.sh phase STORY                 none | spec | design | plan | build | done
#   work-state.sh approve STORY TASK          record the gate's approval of the task's design
#   work-state.sh approved STORY TASK         exit 0 approved, 6 not approved, 7 changed since
#   work-state.sh approve-phase STORY PHASE   record the gate's approval of the spec, design, or plan
#   work-state.sh approved-phase STORY PHASE  exit 0 approved, 6 not approved, 7 changed since
#   work-state.sh adopt-approvals STORY       record approvals for a planned story that
#                                             predates them (the user's call)
#   work-state.sh cites STORY ID              tasks whose design_refs include ID (C1, E2, ...)
#   work-state.sh migrate [STORY-ID]          convert the old tasks/*.md layout into the store
#   work-state.sh hint                        SessionStart JSON when claims exist; silent otherwise
#
# A claim is the ref refs/heads/claim/STORY/TASK pointing at a unique commit with
# no parent and no files, whose message records the work branch and a claim id.
# Creating it with `git update-ref REF NEW ""` is atomic in one repository;
# pushing it with an empty --force-with-lease is atomic on the remote. The lock
# never carries work: it has no history, so publishing it uploads nothing else.
#
# Portable to bash 3.2 (macOS) and needs only git, sed, and awk. iconv, when
# present, transliterates accents in task titles.

set -e

DEFAULT_STORIES="docs/stories"
DEFAULT_EPICS="docs/epics"
CONFIG=".agent-skills.json"
USER_CONFIG="${AGENT_SKILLS_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/agent-skills/config.json}"
DOTPM_SETTINGS=".obsidian/plugins/project-manager/data.json"
NS="claim"
STATUSES="todo in-progress blocked review done cancelled"
# Files that building a task regenerates as a side effect: a lockfile, a schema
# dump, generated queriers. Two tasks that both touch a file matching the same
# pattern share it even when their paths differ. `ready` applies this.
SHARED_OUTPUTS="*.lock package-lock.json npm-shrinkwrap.json pnpm-lock.yaml bun.lockb go.sum schema.sql structure.sql schema.rb *querier.go"

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

# A task id from its title: lowercase, every run of characters other than
# a-z0-9 becomes one "-", no leading or trailing "-", at most 60 characters.
# Ids stay link-safe: herdr web stops linking a path at "," or "=".
slug() {
  printf '%s' "$1" | LC_ALL=C tr 'A-Z' 'a-z' | LC_ALL=C sed -E 's/[^a-z0-9]+/-/g; s/^-+//' \
    | cut -c1-60 | sed -E 's/-+$//'
}

# The title a task is stored under. dotpm names a task note from its title
# (lowercase; \ / : * ? " < > | and whitespace become "-"; 60 characters at
# most), and when that isn't the file's name it saves a second note under its own
# and trashes ours, which changes the task id. So the stored title is letters,
# digits, and single spaces: accents are transliterated first where iconv can,
# every other run of characters becomes one space, and it is cut at 60 characters.
# Its dotpm name is then its slug, which is the id.
task_title() {
  local t="$1" a
  if a="$(printf '%s' "$t" | iconv -f utf-8 -t ascii//TRANSLIT 2>/dev/null)"; then t="$a"; fi
  printf '%s' "$t" | LC_ALL=C tr -c 'A-Za-z0-9' ' ' | tr -s ' ' | sed 's/^ //' | cut -c1-60 | sed 's/ $//'
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

# Markdown on stdin without section "## NAME": its heading and its lines.
without_section() {
  awk -v h="## $1" '
    /^## / { l = $0; sub(/[[:space:]]+$/, "", l); on = (l == h) }
    !on { print }'
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
  LINK="$2" QL="$(q "$2")" awk '
    BEGIN { link = ENVIRON["LINK"]; ql = ENVIRON["QL"] }
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

need_story() {
  valid_id "$1" || die "usage: work-state.sh $2 STORY${3:+ $3}"
  resolve
  [ -f "$STORIES/$1/$1.md" ] || die "no project note for story '$1'; run work-state.sh init-story first"
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
  c="$(git commit-tree "$(git mktree </dev/null)" \
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

# ── ready: every task a wave can start now ───────────────────────────────────
#
# `next` offers the first task that can start; `ready` offers all that can start
# together. A task is listed when it is todo and unclaimed, its design approval
# holds (`approved` exits 0), every dependency is complete as `next` counts it,
# and it shares no file with a task that is claimed, in progress, in review, or
# blocked, or with a task listed before it. A task's files come from its note:
# the "Files" block of its description (the Step 4 structure of
# planning-and-task-breakdown, above `## Design`) and the paths written in
# backticks in `## Design`.

# Task ids on stdin in plan order: by the number after the leading "t" (so t2
# comes before t10, which a plain sort gets wrong), then by the rest of the id.
# An id without one sorts last. The order doesn't depend on the locale.
plan_order() {
  awk '{
    n = 999999999; r = $0
    if (match($0, /^[tT][0-9]+/)) { n = substr($0, 2, RLENGTH - 1) + 0; r = substr($0, RLENGTH + 1) }
    printf "%09d\t%s\t%s\n", n, r, $0 }' | LC_ALL=C sort | cut -f3
}

# The files the task note on stdin says it touches, as "TAG<TAB>OWNER<TAB>PATH"
# lines: every path in the "Files" block of its description, and every path
# written in backticks in its `## Design`.
#  - The block opens at a line that starts with "Files" and runs to a colon
#    (`**Files likely touched:**`, `Files: …`, in a list or not), and ends at the
#    next blank line (blank lines right after the label don't end it), heading,
#    or bold label (`**Estimated scope:**`).
#  - In the block, everything in backticks counts. A line without backticks gives
#    the first word of each comma-separated piece, or of its list item, that
#    reads as a path.
#  - In the design, only a backticked token that reads as a file counts: a path
#    with an extension, a directory ending in "/", a glob, or a bare file name
#    with a known extension. Code such as `router.query` is not a file.
# A path loses its "./" and a trailing ":12" or "#L12".
task_files() {
  TAG="$1" OWNER="$2" awk '
    BEGIN {
      tag = ENVIRON["TAG"]; owner = ENVIRON["OWNER"]
      ne = split("ts tsx js jsx mjs cjs json jsonc md mdx sql go py rb rs java kt kts swift sh bash zsh yml yaml toml css scss sass less html htm vue svelte gql graphql proto lock sum mod txt xml csv tf tfvars hcl env ini cfg conf gradle properties php cs c h cpp hpp lua ex exs erl hs scala dart svg png jpg jpeg gif ico snap", e, " ")
      for (i = 1; i <= ne; i++) ext[e[i]] = 1
      ne = split("Makefile Dockerfile Gemfile Rakefile Procfile Jenkinsfile Vagrantfile .env .gitignore .npmrc .nvmrc .dockerignore .editorconfig", e, " ")
      for (i = 1; i <= ne; i++) special[e[i]] = 1
    }
    function trim(s) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", s); return s }
    function first(s,   i) { s = trim(s); i = match(s, /[[:space:]]/); return i ? substr(s, 1, i - 1) : s }
    function clean(t) {
      t = trim(t)
      while (substr(t, 1, 2) == "./") t = substr(t, 3)
      sub(/:[0-9]+([-:][0-9]+)*$/, "", t)
      sub(/#L[0-9]+(-L?[0-9]+)?$/, "", t)
      return t
    }
    function add(t) {
      t = clean(t)
      if (t == "" || length(t) > 200 || t ~ /[[:space:]]/ || index(t, "://")) return
      if (!(t in seen)) { seen[t] = 1; paths[++np] = t }
    }
    function pathlike(t,   base, x) {
      t = clean(t)
      if (t == "" || length(t) > 200 || t ~ /[[:space:]]/ || index(t, "://")) return 0
      if (t ~ /[=,;\047"$|&!#%^\\(){}]/) return 0
      base = t; sub(/^.*\//, "", base)
      if (index(t, "/")) return (substr(t, length(t)) == "/" || index(t, "*") > 0 || base ~ /\.[A-Za-z0-9]+$/)
      if (base in special) return 1
      if (base !~ /^[A-Za-z0-9_@~<>*-][A-Za-z0-9_@.~<>*-]*\.[A-Za-z0-9]+$/) return 0
      x = tolower(base); sub(/^.*\./, "", x)
      return (x in ext)
    }
    function ticks(s, strict,   i, j, t, c) {
      c = 0
      while ((i = index(s, "`")) > 0) {
        s = substr(s, i + 1)
        j = index(s, "`")
        if (j == 0) break
        t = substr(s, 1, j - 1); s = substr(s, j + 1)
        c++
        if (!strict || pathlike(t)) add(t)
      }
      return c
    }
    function bare(w) {
      w = trim(w)
      if (length(w) > 4 && substr(w, 1, 2) == "**" && substr(w, length(w) - 1) == "**") w = substr(w, 3, length(w) - 4)
      while (w != "" && index("([<\"\047", substr(w, 1, 1))) w = substr(w, 2)
      while (w != "" && index(")]>\"\047,;:.", substr(w, length(w), 1))) w = substr(w, 1, length(w) - 1)
      return w
    }
    function fileword(w) {
      w = bare(w)
      if (index(w, "/")) return (w !~ /[=;\047"$|&!#%^\\(){}]/ && !index(w, "://"))
      return pathlike(w)
    }
    function line_paths(s,   item, parts, k, m, w) {
      if (ticks(s, 0) > 0) return
      item = s
      if (sub(/^[[:space:]]*([-*+]|[0-9]+[.)])[[:space:]]+/, "", item)) {
        w = first(item); if (fileword(w)) add(bare(w))
        return
      }
      m = split(s, parts, ",")
      for (k = 1; k <= m; k++) { w = first(parts[k]); if (fileword(w)) add(bare(w)) }
    }
    function is_files(l) { return l ~ /^[[:space:]]*([-*+][[:space:]]+)?(\*\*|__)?[Ff]iles?([^A-Za-z:*_`][^:*_`]*)?(\*\*|__)?:/ }
    function is_label(l,   t) {
      if (l !~ /^[[:space:]]*([-*+][[:space:]]+)?(\*\*|__)[^*_`]+(\*\*|__)?:/) return 0
      t = l; sub(/^[[:space:]]*([-*+][[:space:]]+)?(\*\*|__)/, "", t); t = substr(t, 1, index(t, ":") - 1)
      return (index(t, "/") == 0 && index(t, ".") == 0)
    }
    NR == 1 && $0 == "---" { infm = 1; next }
    infm { if ($0 == "---") infm = 0; next }
    { l = $0; sub(/[[:space:]]+$/, "", l) }
    l == "## Design" { sect = 1; inf = 0; next }
    sect && (l ~ /^## / || l ~ /^(Project|Parent): \[\[/) { sect = 2 }
    sect == 2 { next }
    sect == 1 { ticks($0, 1); next }
    is_files(l) {
      inf = 1; got = 0
      r = l; sub(/^[^:]*:/, "", r); sub(/^(\*\*|__)/, "", r)
      if (r ~ /[^[:space:]]/) { got = 1; line_paths(r) }
      next
    }
    !inf { next }
    l ~ /^[[:space:]]*$/ { if (got) inf = 0; next }
    l ~ /^#+[[:space:]]/ || is_label(l) { inf = 0; next }
    { got = 1; line_paths(l) }
    END { for (i = 1; i <= np; i++) print tag "\t" owner "\t" paths[i] }'
}

# The first file a candidate (the C lines on stdin) shares with a task that holds
# files (the B lines), as "overlaps OWNER on FILE"; nothing when there is none.
# Paths are compared as written, once "./" is dropped. Two overlap when:
#  - they are equal, or one is the tail of the other at a "/" (notes shorten
#    paths: `auth.ts` meets `src/auth.ts`);
#  - one is a directory (ends in "/", or has no extension) that holds the other;
#  - one is a glob (`*`) that matches the other, or both are globs that could
#    match one file (the same text before the first "*" and after the last);
#  - both are files matching one pattern of SHARED_OUTPUTS, whatever their paths.
file_conflict() {
  SHARED="$SHARED_OUTPUTS" awk '
    BEGIN { FS = "\t"; ns = split(ENVIRON["SHARED"], sp, " ") }
    function re(g,   r, i, c) {
      r = ""
      for (i = 1; i <= length(g); i++) {
        c = substr(g, i, 1)
        if (c == "*") r = r ".*"
        else if (index("\\.^$+?(){}|[]", c)) r = r "\\" c
        else r = r c
      }
      return r
    }
    function wild(k) { return index(k, "*") > 0 }
    function head(k) { return substr(k, 1, index(k, "*") - 1) }
    function foot(k,   i) { for (i = length(k); i >= 1; i--) if (substr(k, i, 1) == "*") return substr(k, i + 1); return k }
    function rel(x, y) { return x == "" || y == "" || index(x, y) == 1 || index(y, x) == 1 }
    function relend(x, y,   lx, ly) {
      lx = length(x); ly = length(y)
      if (lx >= ly) return substr(x, lx - ly + 1) == y
      return substr(y, ly - lx + 1) == x
    }
    function dir(k) { return substr(k, length(k)) == "/" }
    function inside(p, d) { return index("/" p, "/" d) > 0 }
    function tail(a, b) { return length(b) > length(a) && substr(b, length(b) - length(a)) == "/" a }
    function hit(g, p) {
      if (dir(p)) return rel(head(g), p)
      return p ~ ("(^|/)" re(g) "$")
    }
    function overlap(a, b) {
      if (a == b) return 1
      if (wild(a) && wild(b)) return rel(head(a), head(b)) && relend(foot(a), foot(b))
      if (wild(a)) return hit(a, b)
      if (wild(b)) return hit(b, a)
      if (dir(a) && dir(b)) return inside(a, b) || inside(b, a)
      if (dir(a)) return inside(b, a)
      if (dir(b)) return inside(a, b)
      return tail(a, b) || tail(b, a) || (noext(a) && inside(b, a "/")) || (noext(b) && inside(a, b "/"))
    }
    function base(k) { sub(/^.*\//, "", k); return k }
    function noext(k) { return index(base(k), ".") == 0 }
    function common(a, b,   s, x, y) {
      x = base(a); y = base(b)
      for (s = 1; s <= ns; s++)
        if (x ~ ("^" re(sp[s]) "$") && y ~ ("^" re(sp[s]) "$")) return sp[s]
      return ""
    }
    $1 == "B" { nb++; bo[nb] = $2; bk[nb] = $3; next }
    $1 == "C" { nc++; ck[nc] = $3; next }
    END {
      for (i = 1; i <= nb; i++)
        for (j = 1; j <= nc; j++) {
          if (overlap(ck[j], bk[i])) { print "overlaps " bo[i] " on " ck[j] (ck[j] == bk[i] ? "" : " ~ " bk[i]); exit }
          p = common(ck[j], bk[i])
          if (p != "") { print "overlaps " bo[i] " on shared output " p " (" ck[j] ", " bk[i] ")"; exit }
        }
    }'
}

cmd_ready() {
  local story="${1:-}" f id ref content status dep ok held ids cands="" busy="" cand hit n=0
  valid_id "$story" || die "usage: work-state.sh ready STORY"
  resolve
  [ -d "$STORIES/$story" ] || die "no story '$story' under $STORIES"
  refresh
  ids="$(for f in "$STORIES/$story"/_tasks/*.md; do if [ -f "$f" ]; then basename "$f" .md; fi; done | plan_order)"
  # A task under way holds its files; a todo task nobody holds is a candidate.
  for id in $ids; do
    ref="$(claim_ref "$story" "$id")"
    content="$(task_content "$story" "$id" "$ref")"
    status="$(printf '%s\n' "$content" | fm status)"
    held=0
    if [ -n "$ref" ]; then held=1; fi
    case "$status" in in-progress|review|blocked) held=1 ;; esac
    if [ "$held" = 1 ]; then
      busy="$busy$(printf '%s\n' "$content" | task_files B "$story/$id (running)")
"
    elif [ "$status" = todo ]; then
      cands="$cands $id"
    fi
  done
  for id in $cands; do
    f="$STORIES/$story/_tasks/$id.md"
    approval_state "$story" "$id" > /dev/null || continue
    ok=1
    for dep in $(deps_of < "$f"); do
      if ! dep_finished "$story" "$dep"; then ok=0; break; fi
    done
    [ "$ok" = 1 ] || continue
    cand="$(task_files C - < "$f")"
    hit="$(printf '%s\n%s\n' "$busy" "$cand" | file_conflict)"
    if [ -n "$hit" ]; then echo "skipped: $story/$id $hit" >&2; continue; fi
    if [ -z "$cand" ]; then echo "note: $story/$id lists no files, so its overlap with other tasks is unchecked" >&2; fi
    echo "$story/$id"
    n=$((n + 1))
    busy="$busy$(task_files B "$story/$id (ready)" < "$f")
"
  done
  [ "$n" -gt 0 ] || exit 4
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
  local story="$1" given="$2" title id file dep deps=""
  [ -n "$given" ] || die "usage: work-state.sh new-task STORY TITLE [DEP-ID...]"
  need_story "$story" new-task "TITLE [DEP-ID...]"
  shift 2
  title="$(task_title "$given")"
  id="$(slug "$title")"
  valid_id "$id" || die "title '$given' gives no usable task id"
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

# ── task approval ────────────────────────────────────────────────────────────
#
# The approval gate records `design_approved: <date> <hash>` in the task's
# customFields. <hash> fingerprints what the builder works from: the task
# description above `## Design`, the `## Design` section, the ids in
# `design_refs`, and the blocks that define those ids (in the story's spec.md,
# or design.md; for E-ids, in its epic's `## Architecture`). Editing any of them
# afterwards changes the hash, so the approval no longer holds.

# Markdown on stdin without HTML comments, blank lines, or trailing spaces: the
# text a fingerprint reads, so reformatting never voids an approval.
fingerprint_lines() {
  awk '
    /^[[:space:]]*<!--.*-->[[:space:]]*$/ { next }
    /[^[:space:]]/ { sub(/[[:space:]]+$/, ""); print }'
}

# The `## Design` section of markdown on stdin, normalized.
design_section() { section Design | fingerprint_lines; }

# The description in the task note on stdin: its body above `## Design`. Ticked
# boxes read as unticked, so ticking an acceptance criterion keeps the approval.
task_description() {
  awk '
    NR == 1 && $0 == "---" { infm = 1; next }
    infm { if ($0 == "---") infm = 0; next }
    { l = $0; sub(/[[:space:]]+$/, "", l) }
    l == "## Design" { exit }
    { if (match($0, /^[[:space:]]*[-*+] \[[xX]\]/)) $0 = substr($0, 1, RLENGTH - 2) " " substr($0, RLENGTH)
      print }' | fingerprint_lines
}

# Fingerprint of the task note on stdin, for the story given.
task_hash() {
  local story="$1" content id
  content="$(cat)"
  {
    printf '%s\n' "$content" | task_description
    echo "## Design"
    printf '%s\n' "$content" | design_section
    for id in $(printf '%s\n' "$content" | refs_of); do
      echo "## $id"
      ref_blocks "$story" "$id" | fingerprint_lines
    done
  } | git hash-object --stdin | cut -c1-12
}

# What approvals fingerprinted before descriptions and contracts were covered:
# the `## Design` section alone.
design_hash() { design_section | git hash-object --stdin | cut -c1-12; }

# Prints "ok <date>", "missing", or "stale" for a task; exit 0, 6, or 7.
approval_state() {
  local story="$1" id="$2" content value want
  content="$(task_content "$story" "$id" "$(claim_ref "$story" "$id")")"
  value="$(printf '%s\n' "$content" | cf design_approved)"
  if [ -z "$value" ]; then echo missing; return 6; fi
  want="$(printf '%s\n' "$content" | task_hash "$story")"
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
  stamp="$(date -u +%Y-%m-%dT%H:%MZ) $(task_hash "$story" < "$file")"
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
    stale) echo "not approved: $story/$task changed after approval (its description, design, or a cited contract); run the gate again" ;;
  esac
  exit "$rc"
}

# Re-record the approval of the task note FILE, made under the earlier
# fingerprint, under the current one, but only when its `## Design` is unchanged
# since. Returns 1 when there is no such approval.
restamp_approval() {
  local story="$1" file="$2" value
  value="$(cf design_approved < "$file")"
  [ -n "$value" ] && [ "${value##* }" = "$(design_hash < "$file")" ] || return 1
  cf_put "$file" design_approved "$(q "${value%% *} $(task_hash "$story" < "$file")")"
}

# ── phase approvals ──────────────────────────────────────────────────────────
#
# A story's gates record `spec_approved`, `design_approved`, and `plan_approved`
# as `<date> <hash>` in the story project note's frontmatter, where <hash>
# fingerprints the artifact the gate approved. Editing it afterwards changes the
# hash, so the approval no longer holds. The values are top-level keys: the
# note's `customFields` is dotpm's list of field definitions, not a map.

valid_phase() { case "$1" in spec|design|plan) return 0 ;; esac; return 1; }

# The file a story's phase approval covers.
phase_file() { case "$2" in plan) echo "$STORIES/$1/plan.md" ;; *) echo "$STORIES/$1/spec.md" ;; esac; }

# The text a phase approval fingerprints: the spec without its `## Design`; the
# design (the spec's `## Design`, then design.md when the design lives there);
# the plan with the sorted ids of the story's task notes.
phase_text() {
  local dir="$STORIES/$1" f
  case "$2" in
    spec) without_section Design < "$dir/spec.md" | fingerprint_lines ;;
    design)
      design_section < "$dir/spec.md"
      if [ -f "$dir/design.md" ]; then fingerprint_lines < "$dir/design.md"; fi ;;
    plan)
      fingerprint_lines < "$dir/plan.md"
      for f in "$dir"/_tasks/*.md; do if [ -f "$f" ]; then basename "$f" .md; fi; done | LC_ALL=C sort ;;
  esac
}

phase_hash() { phase_text "$1" "$2" | git hash-object --stdin | cut -c1-12; }

# Whether the story has no design: its approval then records a skipped phase.
design_skipped() { [ -z "$(phase_text "$1" design)" ]; }

# Prints "ok <date>", "missing", or "stale" for a story's PHASE approval; exit 0, 6, or 7.
phase_state() {
  local story="$1" phase="$2" note="$STORIES/$1/$1.md" value=""
  if [ -f "$note" ]; then value="$(fm "${phase}_approved" < "$note")"; fi
  if [ -z "$value" ] || [ ! -f "$(phase_file "$story" "$phase")" ]; then echo missing; return 6; fi
  if [ "${value##* }" != "$(phase_hash "$story" "$phase")" ]; then echo stale; return 7; fi
  echo "ok ${value%% *}"
}

phase_ok() { phase_state "$1" "$2" > /dev/null; }

# Record the approval of a story's PHASE for its files as they are now.
record_phase() {
  local story="$1" phase="$2" stamp skipped=""
  stamp="$(date -u +%Y-%m-%dT%H:%MZ) $(phase_hash "$story" "$phase")"
  fm_put "$STORIES/$story/$story.md" "${phase}_approved" "$(q "$stamp")"
  if [ "$phase" = design ] && design_skipped "$story"; then skipped=" as skipped, none written"; fi
  echo "approved: $story $phase$skipped ($stamp)"
}

cmd_approve_phase() {
  local story="$1" phase="${2:-}" file
  need_story "$story" approve-phase "spec|design|plan"
  valid_phase "$phase" || die "usage: work-state.sh approve-phase STORY spec|design|plan"
  file="$(phase_file "$story" "$phase")"
  [ -f "$file" ] || die "no ${file##*/} for story $story; write it before approving the $phase"
  if [ "$phase" = plan ]; then
    set -- "$STORIES/$story"/_tasks/*.md
    [ -f "$1" ] || die "story $story has no task notes; create them with new-task before approving the plan"
  fi
  record_phase "$story" "$phase"
}

cmd_approved_phase() {
  local story="$1" phase="${2:-}" state rc skipped=""
  need_story "$story" approved-phase "spec|design|plan"
  valid_phase "$phase" || die "usage: work-state.sh approved-phase STORY spec|design|plan"
  set +e; state="$(phase_state "$story" "$phase")"; rc=$?; set -e
  case "$state" in
    ok*)
      if [ "$phase" = design ] && design_skipped "$story"; then skipped="skipped, "; fi
      echo "approved: $story $phase ($skipped${state#ok })" ;;
    missing) echo "not approved: $story has no approved $phase; run the $phase gate" ;;
    stale) echo "not approved: $story's $phase changed after approval; run the gate again" ;;
  esac
  exit "$rc"
}

# A planned story that predates recorded approvals: it has a spec, a plan, and
# task notes, and none of its three approvals is recorded.
legacy_story() {
  local dir="$STORIES/$1" note="$STORIES/$1/$1.md" k
  [ -f "$note" ] && [ -f "$dir/spec.md" ] && [ -f "$dir/plan.md" ] || return 1
  for k in spec design plan; do
    [ -z "$(fm "${k}_approved" < "$note")" ] || return 1
  done
  set -- "$dir"/_tasks/*.md
  [ -f "$1" ]
}

# One-shot, run on the user's say-so: record the spec, design, and plan of a
# planned story that predates approvals as approved, and re-record its task
# approvals.
cmd_adopt_approvals() {
  local story="$1" dir f id
  need_story "$story" adopt-approvals
  dir="$STORIES/$story"
  legacy_story "$story" || die "adopt-approvals is for a planned story (spec, plan, and task notes) with no recorded approvals; run its gates and approve-phase instead"
  record_phase "$story" spec
  record_phase "$story" design
  record_phase "$story" plan
  for f in "$dir"/_tasks/*.md; do
    [ -f "$f" ] || continue
    id="$(basename "$f" .md)"
    if restamp_approval "$story" "$(task_path "$story" "$id")"; then
      echo "approved: $story/$id (re-recorded: the fingerprint now covers its description and cited contracts)"
    fi
  done
}

# ── brief: the minimum context one task needs ────────────────────────────────

# The parts of the markdown on stdin that define ID, which must appear as a
# whole word: the whole section under a heading that names it (up to the next
# heading of the same or a higher level), else each blank-line-separated block
# that mentions it, followed by the table right after it when the block
# introduces one. A fenced code block never splits a block or ends a section.
blocks_mentioning() {
  awk -v id="$1" '
    function flush() {
      if (b != "") {
        if (want || (prev && b ~ /^\|/)) { printf "%s\n\n", b; prev = !(b ~ /^\|/) && want } else prev = 0
      }
      b = ""; want = 0
    }
    function names(s,  t) { t = " " s " "; gsub(/[^A-Za-z0-9_-]/, " ", t); return index(t, " " id " ") > 0 }
    /^[[:space:]]*(```|~~~)/ { fence = !fence }
    { h = 0; if (!fence && match($0, /^#+ /) && RLENGTH <= 7) h = RLENGTH - 1 }
    sec && h && h <= sec { sec = 0; print "" }
    !sec && h && names($0) { flush(); sec = h; prev = 0 }
    sec { print; next }
    /^[[:space:]]*$/ && !fence { flush(); next }
    { b = (b == "" ? $0 : b "\n" $0); if (names($0)) want = 1 }
    END { if (sec) print ""; else flush() }'
}

# Design refs of the task note on stdin, one id per line.
refs_of() { cf design_refs | tr -d '[]"' | tr ', ' '\n\n' | { grep -v '^$' || true; } | LC_ALL=C sort -u; }

# Where design ref ID is defined: an E-id (a contract of the story's epic) in the
# epic's epic.md, anything else (C1, ...) in the story's spec.md, or in design.md
# when the design lives there.
ref_origin() { case "$1" in E[0-9]*) echo epic.md ;; *) echo spec.md ;; esac; }

# The blocks that define design ref ID: what `brief` shows, and what an approval
# fingerprints. An E-id's are searched in the epic's `## Architecture` only.
ref_blocks() {
  local story="$1" id="$2" epic file
  if [ "$(ref_origin "$id")" = epic.md ]; then
    epic="$(story_epic "$story")"
    file="$EPICS/$epic/epic.md"
    if [ -n "$epic" ] && [ -f "$file" ]; then section Architecture < "$file" | blocks_mentioning "$id"; fi
  else
    for file in "$STORIES/$story/spec.md" "$STORIES/$story/design.md"; do
      if [ -f "$file" ]; then blocks_mentioning "$id" < "$file"; fi
    done
  fi
}

cmd_brief() {
  local story="$1" task="$2" ref content spec plan req r
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
  for r in $(printf '%s\n' "$content" | refs_of); do
    echo ; echo "== design $r (from $(ref_origin "$r"))"
    ref_blocks "$story" "$r"
  done
  # Requirement ids the task names in its own text (FR1, NFR3, ...).
  req="$(printf '%s\n' "$content" | grep -oE '\bN?FR[0-9]+\b' | sort -u | tr '\n' ' ' || true)"
  for r in $req; do
    echo ; echo "== requirement $r (from spec.md)"
    grep -E -- "(^|[^A-Za-z0-9])$r([^0-9]|$)" "$spec" | head -n 5 || true
  done
  return 0
}

# The tasks of STORY whose design_refs include ID, one per line as "TASK STATUS":
# the ones to re-gate (those not done) after the contract ID changed.
cmd_cites() {
  local story="$1" ref="${2:-}" f id content
  valid_id "$story" && [ -n "$ref" ] || die "usage: work-state.sh cites STORY ID"
  resolve
  [ -d "$STORIES/$story" ] || die "no story '$story' under $STORIES"
  for f in "$STORIES/$story"/_tasks/*.md; do
    [ -f "$f" ] || continue
    id="$(basename "$f" .md)"
    content="$(task_content "$story" "$id" "$(claim_ref "$story" "$id")")"
    if printf '%s\n' "$content" | refs_of | grep -Fxq -- "$ref"; then echo "$id $(printf '%s\n' "$content" | fm status)"; fi
  done
}

# ── phase: where a story stands ──────────────────────────────────────────────

# none    no story directory yet
# spec    no spec.md, or its approval is missing or stale     → write or re-gate the spec
# design  spec approved; neither design nor plan is approved  → high-level design (approving it empty skips it)
# plan    plan not approved: no plan.md or task notes yet, or either changed since → plan the tasks
# build   plan approved, some task is not complete (one in review is not)         → build the tasks
# done    plan approved, every task is done or cancelled
# Each phase ends when its gate records `approve-phase`, and holds while the
# approved artifact stays unchanged. An approved plan keeps a story past a design
# edited since: its tasks re-gate on the contracts they cite.
cmd_phase() {
  local story="$1" phase f id open=0
  valid_id "$story" || die "usage: work-state.sh phase STORY"
  resolve
  if [ ! -d "$STORIES/$story" ]; then echo "phase=none"; return 0; fi
  if ! phase_ok "$story" spec; then phase=spec
  elif ! phase_ok "$story" design && ! phase_ok "$story" plan; then phase=design
  elif ! phase_ok "$story" plan; then phase=plan
  else
    for f in "$STORIES/$story"/_tasks/*.md; do
      [ -f "$f" ] || continue
      id="$(basename "$f" .md)"
      complete "$(task_content "$story" "$id" "$(claim_ref "$story" "$id")" | fm status)" || open=$((open + 1))
    done
    if [ "$open" -gt 0 ]; then phase=build; else phase=done; fi
  fi
  echo "phase=$phase"
  if [ "$phase" = build ]; then echo "open_tasks=$open"; fi
  if legacy_story "$story"; then echo "approvals=missing run: work-state.sh adopt-approvals $story (only if the user confirms its earlier gates passed)"; fi
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
  if [ -n "$approved" ]; then
    cf_put "$file" design_approved "$(q "$approved")"
    # Approvals made before descriptions and contracts were covered still hold when the design is unchanged.
    restamp_approval "$story" "$file" || true
  fi
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

# A story copied from the repo store still has bare wikilinks. Rewrite the ones
# that name its project note, its tasks, or its epic to the vault-path links
# `link` writes, and tick its finished tasks in the project note.
vault_relink() {
  local story="$1" dir="$STORIES/$1" tab map="" f epic
  [ -f "$dir/$story.md" ] || return 0
  tab="$(printf '\t')"
  epic="$(story_epic "$story")"
  if [ -n "$epic" ] && [ -f "$EPICS/$epic/$epic.md" ]; then
    map="$epic$tab$(link_target "$EPICS/$epic/$epic.md")
"
  fi
  for f in "$dir/$story.md" "$dir"/_tasks/*.md; do
    [ -f "$f" ] || continue
    map="$map$(basename "$f" .md)$tab$(link_target "$f")
"
  done
  for f in "$dir/$story.md" "$dir"/_tasks/*.md; do
    [ -f "$f" ] || continue
    MAP="$map" awk '
      BEGIN {
        n = split(ENVIRON["MAP"], rows, "\n")
        for (i = 1; i <= n; i++) if ((t = index(rows[i], "\t")) > 0) path[substr(rows[i], 1, t - 1)] = substr(rows[i], t + 1)
      }
      {
        out = ""; rest = $0
        while ((i = index(rest, "[[")) > 0) {
          out = out substr(rest, 1, i + 1); rest = substr(rest, i + 2)
          if ((j = index(rest, "]]")) == 0) break
          inner = substr(rest, 1, j - 1); rest = substr(rest, j)
          bar = index(inner, "|")
          name = bar ? substr(inner, 1, bar - 1) : inner
          if (name in path) inner = path[name] (bar ? substr(inner, bar) : "")
          out = out inner
        }
        print out rest
      }' "$f" | replace "$f"
  done
  for f in "$dir"/_tasks/*.md; do
    [ -f "$f" ] || continue
    if complete "$(fm status < "$f")"; then project_tick "$dir/$story.md" "$(link_target "$f")" x; fi
  done
}

migrate_story() {
  local story="$1" src="$OLD_STORIES/$1" dest="$STORIES/$1" epic title f claims
  if [ "$STORE" = repo ]; then
    [ -d "$src/tasks" ] || return 0
  else
    [ ! -e "$dest" ] || die "$dest already exists; move it aside before migrating $story"
  fi
  # A claimed task's freshest note is in its work branch's worktree, not in this
  # checkout, so a story with live claims waits until they are released.
  claims="$(git for-each-ref --format='%(refname:short)' "refs/heads/$NS/$story/*" "refs/remotes/*/$NS/$story/*" || true)"
  if [ -n "$claims" ]; then
    echo "skipped: $story has live claims ($(printf '%s' "$claims" | tr '\n' ' ')); finish or release them, then migrate"
    return 0
  fi
  if [ "$STORE" = vault ]; then
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
    vault_relink "$story"
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
  ready) shift; cmd_ready "${1:-}" ;;
  claim) shift; cmd_claim "${1:-}" "${2:-}" "${3:-}" ;;
  release) shift; cmd_release "${1:-}" "${2:-}" ;;
  status) shift; cmd_status "${1:-}" ;;
  brief) shift; cmd_brief "${1:-}" "${2:-}" ;;
  phase) shift; cmd_phase "${1:-}" ;;
  approve) shift; cmd_approve "${1:-}" "${2:-}" ;;
  approved) shift; cmd_approved "${1:-}" "${2:-}" ;;
  approve-phase) shift; cmd_approve_phase "${1:-}" "${2:-}" ;;
  approved-phase) shift; cmd_approved_phase "${1:-}" "${2:-}" ;;
  adopt-approvals) shift; cmd_adopt_approvals "${1:-}" ;;
  cites) shift; cmd_cites "${1:-}" "${2:-}" ;;
  migrate) shift; cmd_migrate "${1:-}" ;;
  hint) cmd_hint ;;
  *) die "usage: work-state.sh {root|configure DIR [EPICS_DIR]|init-epic EPIC TITLE|init-story STORY TITLE [EPIC]|new-task STORY TITLE [DEP...]|path STORY [TASK]|field STORY TASK KEY VALUE|set STORY TASK STATUS|log STORY TASK TEXT|next [STORY]|ready STORY|claim STORY TASK [WORK]|release STORY TASK|status [STORY]|brief STORY TASK|phase STORY|approve STORY TASK|approved STORY TASK|approve-phase STORY PHASE|approved-phase STORY PHASE|adopt-approvals STORY|cites STORY ID|migrate [STORY]|hint}" ;;
esac
