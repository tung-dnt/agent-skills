#!/bin/bash
# work-state.sh — resolve where work artifacts live, claim tasks safely across
# parallel sessions, and report task state.
#
# Implements references/work-artifacts.md. Read-only except `configure`,
# `claim`, and `release`, which the agent runs on the user's behalf.
#
#   work-state.sh root                        resolved artifact roots, as key=value lines
#   work-state.sh configure DIR [EPICS_DIR]   write .agent-skills.json
#   work-state.sh next [STORY-ID]             first claimable task: "story/task" (exit 4 if none)
#   work-state.sh claim STORY TASK [WORK]     take the lock; exit 3 if another session holds it,
#                                             exit 5 if the claim couldn't be published
#   work-state.sh release STORY TASK          drop the lock (local and remote)
#   work-state.sh status [STORY-ID]           ticked tree: epics → stories → tasks → subtasks
#   work-state.sh brief STORY TASK            task file + plan row + only the spec sections it cites
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
NS="claim"

die() { echo "work-state: $*" >&2; exit 1; }

repo_root() { git rev-parse --show-toplevel 2>/dev/null; }

config_get() {
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

# Sets ROOT, STORIES, EPICS, CONFIGURED, SOURCE, NOTES.
resolve() {
  ROOT="$(repo_root)" || true
  [ -n "$ROOT" ] || die "not inside a git repository"
  STORIES="" ; EPICS="" ; NOTES=""
  if [ -f "$ROOT/$CONFIG" ]; then
    STORIES="$(normalize_dir "$(config_get storiesDir "$ROOT/$CONFIG")" || true)"
    EPICS="$(normalize_dir "$(config_get epicsDir "$ROOT/$CONFIG")" || true)"
    CONFIGURED=true ; SOURCE=config
  else
    CONFIGURED=false ; SOURCE=default
    if [ -d "$ROOT/$DEFAULT_STORIES" ] || [ -d "$ROOT/$DEFAULT_EPICS" ]; then SOURCE=detected; fi
    for d in specs docs/specs openspec; do
      if [ -d "$ROOT/$d" ]; then NOTES="${NOTES}existing spec directory: $d; "; fi
    done
    if [ -f "$ROOT/tasks/plan.md" ]; then NOTES="${NOTES}legacy single-plan layout: tasks/plan.md; "; fi
  fi
  [ -n "$STORIES" ] || STORIES="$DEFAULT_STORIES"
  [ -n "$EPICS" ] || EPICS="$DEFAULT_EPICS"
  return 0
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

# ── frontmatter and sections of markdown on stdin ────────────────────────────

fm() {
  awk -v k="$1" '
    NR == 1 && $0 != "---" { exit }
    NR > 1 && $0 == "---" { exit }
    NR > 1 {
      i = index($0, ":")
      if (i && substr($0, 1, i - 1) == k) {
        v = substr($0, i + 1)
        sub(/[[:space:]]+#.*/, "", v); gsub(/^[[:space:]]+|[[:space:]]+$/, "", v)
        gsub(/^["\047]|["\047]$/, "", v)
        print v; exit
      }
    }'
}

subtasks() {
  awk '
    /^## / { on = ($0 ~ /^## Subtasks[[:space:]]*$/); next }
    on && /^[[:space:]]*- \[[ xX]\]/ { t++; if ($0 ~ /- \[[xX]\]/) d++ }
    END { if (t) printf "%d/%d", d, t }'
}

last_log() {
  awk '
    /^## / { on = ($0 ~ /^## Log[[:space:]]*$/); next }
    on && /[^[:space:]]/ && $0 !~ /^<!--/ { l = $0 }
    END { print l }'
}

# Dependencies as space-separated ids, from "depends_on: [a, b]" or a block list:
#   depends_on:
#     - a
deps_of() {
  awk '
    NR == 1 && $0 != "---" { exit }
    NR > 1 && $0 == "---" { exit }
    on && /^[[:space:]]+-/ { v = $0; sub(/^[[:space:]]+-[[:space:]]*/, "", v); print v; next }
    on { exit }
    /^depends_on:/ {
      v = substr($0, 12); sub(/[[:space:]]+#.*/, "", v); gsub(/[][,]/, " ", v)
      if (v ~ /[^[:space:]]/) { print v; exit }
      on = 1
    }' | tr -d "\"'" | tr '\n' ' '
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

# Freshest copy of a task file: the work branch's worktree (uncommitted edits
# included), then the work branch, then this checkout.
task_content() {
  local story="$1" id="$2" ref="$3" rel work wt
  rel="$STORIES/$story/tasks/$id.md"
  if [ -n "$ref" ]; then
    work="$(claim_work "$ref")"
    if [ -n "$work" ]; then
      wt="$(worktree_of "$work")"
      if [ -n "$wt" ] && [ -f "$wt/$rel" ]; then cat "$wt/$rel"; return 0; fi
      if git show "$work:$rel" 2>/dev/null; then return 0; fi
    fi
  fi
  cat "$ROOT/$rel"
}

cmd_claim() {
  local story="$1" task="$2" work="${3:-}" ref c r id
  [ -n "$story" ] && [ -n "$task" ] || die "usage: work-state.sh claim STORY TASK [WORK_BRANCH]"
  resolve
  [ -f "$ROOT/$STORIES/$story/tasks/$task.md" ] || die "no task file $STORIES/$story/tasks/$task.md"
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

cmd_next() {
  local only="${1:-}" s f id status dep ok
  resolve
  refresh
  for s in "$ROOT/$STORIES"/*/; do
    [ -d "$s" ] || continue
    s="$(basename "$s")"
    if [ -n "$only" ] && [ "$s" != "$only" ]; then continue; fi
    for f in "$ROOT/$STORIES/$s"/tasks/*.md; do
      [ -f "$f" ] || continue
      id="$(basename "$f" .md)"
      status="$(fm status < "$f")"
      [ "$status" = pending ] || continue
      [ -z "$(claim_ref "$s" "$id")" ] || continue
      ok=1
      # A dependency counts only once it is done in this checkout, i.e. merged here.
      for dep in $(deps_of < "$f"); do
        if [ "$(fm status < "$ROOT/$STORIES/$s/tasks/$dep.md" 2>/dev/null || true)" != done ]; then ok=0; break; fi
      done
      if [ "$ok" = 1 ]; then echo "$s/$id"; return 0; fi
    done
  done
  exit 4
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
  [ -n "$story" ] && [ -n "$task" ] || die "usage: work-state.sh brief STORY TASK"
  resolve
  [ -f "$ROOT/$STORIES/$story/tasks/$task.md" ] || die "no task file $STORIES/$story/tasks/$task.md"
  ref="$(claim_ref "$story" "$task")"
  content="$(task_content "$story" "$task" "$ref")"
  spec="$ROOT/$STORIES/$story/spec.md"
  plan="$ROOT/$STORIES/$story/plan.md"
  echo "== task $STORIES/$story/tasks/$task.md"
  printf '%s\n' "$content"
  if [ -f "$plan" ]; then
    echo ; echo "== plan row"
    grep -F -- "$task" "$plan" || echo "(not listed in plan.md)"
  fi
  [ -f "$spec" ] || { echo; echo "== no spec at $STORIES/$story/spec.md"; return 0; }
  refs="$(printf '%s\n' "$content" | fm design_refs | tr -d '[]"' | tr ',' ' ')"
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

# ── status tree ──────────────────────────────────────────────────────────────

task_line() {
  local story="$1" file="$2" id ref content status mark extra sub work wt log
  id="$(basename "$file" .md)"
  ref="$(claim_ref "$story" "$id")"
  content="$(task_content "$story" "$id" "$ref")"
  status="$(printf '%s\n' "$content" | fm status)"
  case "$status" in
    done) mark="[x]" ;;
    blocked) mark="[!]" ;;
    *) if [ -n "$ref" ] || [ "$status" = claimed ]; then mark="[~]"; else mark="[ ]"; fi ;;
  esac
  extra=""
  if [ -n "$ref" ]; then
    work="$(claim_work "$ref")"
    extra=" claimed: $ref"
    [ -n "$work" ] && extra="$extra · work $work"
    if [ "$status" = done ]; then
      if [ -n "$work" ] && git merge-base --is-ancestor "$work" HEAD 2>/dev/null; then
        extra="$extra · merged, release the lock"
      else
        extra="$extra · not yet merged"
      fi
    fi
  fi
  sub="$(printf '%s\n' "$content" | subtasks)"
  [ -n "$sub" ] && extra="$extra · subtasks $sub"
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
  for f in "$ROOT/$STORIES/$story"/tasks/*.md; do
    [ -f "$f" ] || continue
    lines="$lines$(task_line "$story" "$f")
"
  done
  total="$(printf '%s' "$lines" | grep -c '^    \[' || true)"
  done="$(printf '%s' "$lines" | grep -c '^    \[x\]' || true)"
  echo "  $(group_mark "$total" "$done" "$lines") story $story  $done/$total tasks"
  printf '%s' "$lines"
}

story_epic() {
  if [ -f "$ROOT/$STORIES/$1/plan.md" ]; then fm epic < "$ROOT/$STORIES/$1/plan.md"; fi
  return 0
}

cmd_status() {
  resolve
  local only="$1" s e epics_seen="" out n d
  [ -d "$ROOT/$STORIES" ] || { echo "no stories under $STORIES"; return 0; }
  if [ -n "$only" ]; then
    [ -d "$ROOT/$STORIES/$only" ] || die "no story '$only' under $STORIES"
    story_block "$only"
    return 0
  fi
  for s in "$ROOT/$STORIES"/*/; do
    [ -d "$s" ] || continue
    e="$(story_epic "$(basename "$s")")"
    case " $epics_seen " in *" ${e:-_none} "*) ;; *) epics_seen="$epics_seen ${e:-_none}" ;; esac
  done
  for e in $epics_seen; do
    out=""
    for s in "$ROOT/$STORIES"/*/; do
      [ -d "$s" ] || continue
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

# ── configure / root / hint ──────────────────────────────────────────────────

cmd_root() {
  resolve
  echo "repo_root=$ROOT"
  echo "stories_dir=$STORIES"
  echo "epics_dir=$EPICS"
  echo "configured=$CONFIGURED"
  echo "source=$SOURCE"
  if [ -n "$NOTES" ]; then echo "notes=${NOTES%; }"; fi
}

cmd_configure() {
  local s e
  [ -n "${1:-}" ] || die "usage: work-state.sh configure STORIES_DIR [EPICS_DIR]"
  case "$1${2:-}" in *\"*|*\\*) die "directory names may not contain quotes or backslashes" ;; esac
  s="$(normalize_dir "$1")" || die "use a relative path inside the repository: $1"
  e="$(normalize_dir "${2:-$DEFAULT_EPICS}")" || die "use a relative path inside the repository: $2"
  ROOT="$(repo_root)" || true
  [ -n "$ROOT" ] || die "not inside a git repository"
  printf '{\n  "storiesDir": "%s",\n  "epicsDir": "%s"\n}\n' "$s" "$e" > "$ROOT/$CONFIG"
  echo "wrote $CONFIG: storiesDir=$s epicsDir=$e"
}

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk 'BEGIN{ORS="\\n"} {print}' | sed 's/\\n$//'; }

cmd_hint() {
  ROOT="$(repo_root)" || true
  [ -n "$ROOT" ] || return 0
  resolve 2>/dev/null || return 0
  [ -d "$ROOT/$STORIES" ] || return 0
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
  next) shift; cmd_next "${1:-}" ;;
  claim) shift; cmd_claim "${1:-}" "${2:-}" "${3:-}" ;;
  release) shift; cmd_release "${1:-}" "${2:-}" ;;
  status) shift; cmd_status "${1:-}" ;;
  brief) shift; cmd_brief "${1:-}" "${2:-}" ;;
  hint) cmd_hint ;;
  *) die "usage: work-state.sh {root|configure DIR [EPICS_DIR]|next [STORY]|claim STORY TASK [WORK]|release STORY TASK|status [STORY]|brief STORY TASK|hint}" ;;
esac
