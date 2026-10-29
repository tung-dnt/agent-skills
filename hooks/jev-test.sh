#!/usr/bin/env bash
# Tests for hooks/jev.sh against a local stub of the TypeSafe API.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JEV="$here/jev.sh"
pass=0 fail=0
check() { # name expected actual
  if [ "$3" = "$2" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL $1: expected [$2] got [$3]"; fi
}
has() { # name needle haystack
  case "$3" in *"$2"*) pass=$((pass + 1)) ;; *) fail=$((fail + 1)); echo "FAIL $1: [$2] not in [$3]" ;; esac
}

tmp="$(mktemp -d)"
trap 'kill "$stub" 2>/dev/null; rm -rf "$tmp"' EXIT
export AGENT_SKILLS_CONFIG="$tmp/config.json" AGENT_SKILLS_JEV_LOG="$tmp/log.jsonl"

# Stub API: answers by question type, counts requests, and returns 500 for a state containing FAIL.
cat >"$tmp/stub.mjs" <<'EOF'
import * as fs from "node:fs";
import * as http from "node:http";
const [port, counter] = [Number(process.argv[2]), process.argv[3]];
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    fs.appendFileSync(counter, `${req.headers.authorization} ${body}\n`);
    const r = JSON.parse(body);
    if (JSON.stringify(r.state).includes("FAIL")) { res.writeHead(500); return res.end(); }
    const q = r.questions.q;
    const answer = q.type === "noul"
      ? { type: "noul", noul: JSON.stringify(r.state).includes("OPEN") ? 0.9 : 0.04 }
      : { type: "choice", choice: "story", confidence: 0.8, probabilities: { epic: 0.05, story: 0.85, task: 0.1 } };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ model: r.model, answers: { q: answer }, usage: { input_tokens: 1, output_tokens: 1 } }));
  });
}).listen(port, "127.0.0.1");
EOF
port=$((20000 + RANDOM % 20000))
runtime="$(command -v node || command -v bun)"
"$runtime" "$tmp/stub.mjs" "$port" "$tmp/requests" & stub=$!
for _ in $(seq 50); do (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null && break; sleep 0.1; done
export TYPESAFE_BASE_URL="http://127.0.0.1:$port"
sent() { [ -f "$tmp/requests" ] && wc -l <"$tmp/requests" | tr -d ' ' || echo 0; }

mkdir "$tmp/app" "$tmp/client-portal"
for r in app client-portal; do git -C "$tmp/$r" init -q -b main; done
git -C "$tmp/app" remote add origin git@github.com:acme/clinic-records.git
cd "$tmp/client-portal"

# Off unless enabled, even with a key: nothing is sent.
export TYPESAFE_API_KEY=k-test
check "no config" "jev=skipped reason=disabled" "$(echo x | bash "$JEV" checkpoint - --step 1/6)"
echo '{"vault": "/v", "jev": {"enabled": false}}' >"$AGENT_SKILLS_CONFIG"
check "enabled false" "jev=skipped reason=disabled" "$(echo x | bash "$JEV" scope -)"

# The deny list matches the worktree folder, case-insensitively.
echo '{"jev": {"enabled": true, "deny": ["CLIENT*"]}}' >"$AGENT_SKILLS_CONFIG"
check "denied by folder" "jev=skipped reason=denied:client-portal" "$(echo x | bash "$JEV" checkpoint - --step 1/6)"
# ...and the origin remote's repo name, even when the folder is allowed.
cd "$tmp/app"
echo '{"jev": {"enabled": true, "deny": ["clinic*"]}}' >"$AGENT_SKILLS_CONFIG"
check "denied by origin" "jev=skipped reason=denied:clinic-records" "$(echo x | bash "$JEV" scope -)"
# Outside a repository it fails closed.
cd "$tmp"
echo '{"jev": {"enabled": true, "deny": []}}' >"$AGENT_SKILLS_CONFIG"
check "no repo" "jev=skipped reason=no-repo" "$(echo x | bash "$JEV" scope -)"
cd "$tmp/app"
unset TYPESAFE_API_KEY
check "no key" "jev=skipped reason=no-key" "$(echo x | bash "$JEV" scope -)"
check "nothing sent while blocked" "0" "$(sent)"

# Allowed: predictions are sent with the key and pinned model, and logged without the text.
export TYPESAFE_API_KEY=k-test
cp1="$(printf 'OPEN: sync or async ingestion?\n' | bash "$JEV" checkpoint - --step "4/11 Flows" --story refunds)"
has "checkpoint answer" "p_open=0.900 model=jev-1.13.0" "$cp1"
has "bearer key and pinned model sent" 'Bearer k-test {"model":"jev-1.13.0"' "$(cat "$tmp/requests")"
id1="${cp1#jev=}"; id1="${id1%% *}"
cp2="$(printf 'Components: webhook route, worker\n' | bash "$JEV" checkpoint - --step "3/11 Components" --story refunds --task t01-api)"
id2="${cp2#jev=}"; id2="${id2%% *}"
cp3="$(printf 'Scope: refunds only\n' | bash "$JEV" checkpoint - --step "2/11 Scope" --story refunds)"
id3="${cp3#jev=}"; id3="${id3%% *}"
sc="$(echo "Add partial refunds" | bash "$JEV" scope -)"
has "scope answer" "scope=story p_epic=0.050 p_story=0.850 p_task=0.100 confidence=0.800" "$sc"
ids="${sc#jev=}"; ids="${ids%% *}"
check "text not logged" "" "$(grep -o 'sync or async\|partial refunds' "$AGENT_SKILLS_JEV_LOG")"

# Failures never block: they print skipped and log nothing.
before="$(wc -l <"$AGENT_SKILLS_JEV_LOG")"
check "http error" "jev=skipped reason=http-500" "$(echo FAIL | bash "$JEV" scope -)"
check "failure not logged" "$before" "$(wc -l <"$AGENT_SKILLS_JEV_LOG")"
check "unreachable" "jev=skipped reason=network" "$(echo x | TYPESAFE_BASE_URL=http://127.0.0.1:1 bash "$JEV" scope -)"

# Outcomes are validated against the prediction's kind.
bash "$JEV" outcome "$id1" story 2>/dev/null; check "wrong outcome kind exits 2" "2" "$?"
bash "$JEV" outcome nope none 2>/dev/null; check "unknown id exits 2" "2" "$?"
bash "$JEV" outcome "$id1" decision >/dev/null
bash "$JEV" outcome "$id2" none >/dev/null
bash "$JEV" outcome "$id3" none >/dev/null
bash "$JEV" outcome "$id3" decision >/dev/null # a later outcome replaces the earlier one
bash "$JEV" outcome "$ids" task >/dev/null

rep="$(bash "$JEV" report)"
has "pending count" "predictions without an outcome: 0" "$rep"
has "checkpoint totals" "checkpoint: 3 paired (2 with a decision, 1 without)" "$rep"
# Only cp2 (p_open 0.04, outcome none) and cp3 (0.04, latest outcome decision) fall under 0.05.
has "threshold row" "p_open<0.05      2/3          1/2" "$rep"
has "scope agreement" "Jev agreed with the settled scope 0/1" "$rep"

check "usage error exits 2" "2" "$(bash "$JEV" checkpoint - </dev/null >/dev/null 2>&1; echo $?)"

echo "Results: $pass passed, $fail failed"
[ "$fail" = 0 ]
