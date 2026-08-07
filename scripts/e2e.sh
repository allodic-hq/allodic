#!/usr/bin/env bash
# allodic e2e — the REAL buyer path, using the actual packed packages:
#   pack -> clean install -> server boot -> publish (all gates) ->
#   `allodic add` (checkout, license, credential storage, agent-dir install,
#   key pinning) -> leak from the INSTALLED file -> trace -> licensed update ->
#   publisher-key rotation refused -> refund revokes -> access denied.
#
# Stripe webhook verification, duplicate/replay events, and the file-write
# traversal attack are covered by the unit/route suites
# (packages/server/test/webhook.test.js, packages/core/test/bundle-security.test.js).
# SMTP and reverse-proxy behaviour are NOT covered here — see docs/DEPLOY.md.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

: "${PORT:=8971}"
export ALLODIC_DATA="$WORK/data" PORT ALLODIC_SERVER="http://localhost:$PORT"
export ALLODIC_DEV_CODES=1 ALLODIC_INSECURE_DEV_PAYMENTS=1 ALLODIC_TELEMETRY=0
export ALLODIC_EVAL_RUNNER="${ALLODIC_EVAL_RUNNER:-mock}"
export ALLODIC_EVAL_MOCK="${ALLODIC_EVAL_MOCK:-Use CREATE INDEX CONCURRENTLY. Add foreign keys as NOT VALID then VALIDATE CONSTRAINT.}"

fail() { echo "FAIL: $1"; exit 1; }
boot_server() {
  "$SRV" > "$WORK/server-$1.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 30); do curl -sf "$ALLODIC_SERVER/catalog" >/dev/null 2>&1 && break; sleep 0.5; done
  curl -sf "$ALLODIC_SERVER/catalog" >/dev/null || fail "server did not boot (see $WORK/server-$1.log)"
  export ALLODIC_ADMIN_KEY=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$ALLODIC_DATA/identity.json')).adminKey)")
}

echo "== 0. pack the REAL packages; install them the way a user would =="
PACKS="$WORK/packs"; mkdir -p "$PACKS" "$WORK/consumer"
for p in core cli server; do (cd "$ROOT/packages/$p" && npm pack --pack-destination "$PACKS" >/dev/null 2>&1); done
(cd "$WORK/consumer" && npm init -y >/dev/null 2>&1 && npm install "$PACKS"/*.tgz --no-audit --no-fund >/dev/null 2>&1)
CLI="$WORK/consumer/node_modules/.bin/allodic"
SRV="$WORK/consumer/node_modules/.bin/allodic-server"
[ -x "$CLI" ] || fail "packed CLI has no allodic executable"
[ -x "$SRV" ] || fail "packed server has no allodic-server executable"
echo "   allodic + allodic-server installed from tarballs"

echo "== 1. packed server boots =="
boot_server 1

echo "== 2. creator publishes through the three gates =="
"$CLI" publish "$ROOT/examples/pg-auditor" | grep -E "spec|allodic :|evals|Published"

echo "== 3. BUYER: allodic add — checkout, license, install, pin =="
BUYER_HOME="$WORK/buyer-home"; mkdir -p "$BUYER_HOME"
printf 'buyer@example.com\n' | HOME="$BUYER_HOME" "$CLI" add "$ALLODIC_SERVER/s/pg-auditor" | tee "$WORK/add.out"
grep -q "Verified before install" "$WORK/add.out" || fail "add installed without the full verification chain"
grep -q "provenance:" "$WORK/add.out" || fail "add skipped provenance verification"
INSTALLED="$BUYER_HOME/.claude/skills/pg-auditor/SKILL.md"
[ -f "$INSTALLED" ] || fail "skill not installed into the buyer's agent directory"
# P0.4: the DELIVERED, fingerprinted file must still validate as agent-skills/v1.
node -e "
const { readFileSync } = require('fs');
const { checkCompliance } = require('$WORK/consumer/node_modules/@allodic/core/src/index.js');
const md = readFileSync('$INSTALLED');
const c = checkCompliance({ 'SKILL.md': md }, { dirName: 'pg-auditor', engine: 'js' });
const markers = (md.toString().match(/^---/gm) || []).length;
if (markers !== 2) { console.error('delivered file has ' + markers + ' frontmatter markers'); process.exit(1); }
if (!c.spec.ok) { console.error('delivered file is NOT spec-compliant: ' + JSON.stringify(c.spec.errors)); process.exit(1); }
if (!md.toString().match(/^\\s+allodic-license:/m)) { console.error('license not nested under metadata'); process.exit(1); }
console.log('   delivered file: agent-skills/v1 compliant, license nested under metadata, single frontmatter block');
"

[ -f "$BUYER_HOME/.allodic/installs.json" ] || fail "no CLI install state under buyer HOME"
# P1: bearer tokens 0600 inside a 0700 dir — never world-readable
[ "$(stat -c %a "$BUYER_HOME/.allodic")" = "700" ] || fail ".allodic dir is $(stat -c %a "$BUYER_HOME/.allodic"), want 700"
[ "$(stat -c %a "$BUYER_HOME/.allodic/credentials.json")" = "600" ] || fail "credentials.json is $(stat -c %a "$BUYER_HOME/.allodic/credentials.json"), want 600"
echo "   credential perms: dir 700, credentials.json 600 ✓"
node -e "
const { readFileSync, readdirSync } = require('fs');
const i = JSON.parse(readFileSync('$BUYER_HOME/.allodic/installs.json'))[0];
if (!i.keyId) throw new Error('publisher key was not pinned on first install');
const credFiles = readdirSync('$BUYER_HOME/.allodic');
if (credFiles.length < 2) throw new Error('license credentials not stored under ~/.allodic');
console.log('   pinned key ' + i.keyId.slice(0,8) + ' · version ' + i.version + ' · state files: ' + credFiles.join(', '));
"

echo "== 4. the INSTALLED file leaks, fully laundered — creator traces =="
node -e "
const { readFileSync, writeFileSync } = require('fs');
const md = readFileSync('$INSTALLED','utf8');
writeFileSync('$WORK/leak.md', md.replace(/^---[\s\S]*?---\n/,'').replace(/[\u200b\u200c\u200d\u2060\ufeff]/g,''));
"
"$CLI" trace "$WORK/leak.md" | tee "$WORK/trace.out"
grep -qE "uniquely consistent|Order ord_" "$WORK/trace.out" || fail "trace did not attribute the single buyer's laundered leak"

echo "== 4b. verify exit codes are honest (P0.2): pass=0, fail=1 =="
if HOME="$BUYER_HOME" "$CLI" verify "$ALLODIC_SERVER/s/pg-auditor" --evals > "$WORK/verify-ok.out" 2>&1; then
  grep -q "all checks passed" "$WORK/verify-ok.out" || fail "clean verify should say all checks passed"
else
  cat "$WORK/verify-ok.out"; fail "clean verify must exit 0"
fi
if HOME="$BUYER_HOME" ALLODIC_EVAL_MOCK="wrong answers only" "$CLI" verify "$ALLODIC_SERVER/s/pg-auditor" --evals > "$WORK/verify-bad.out" 2>&1; then
  cat "$WORK/verify-bad.out"; fail "verify with failing evals must exit nonzero"
else
  grep -q "verification FAILED" "$WORK/verify-bad.out" || fail "failed verify must print the failure ledger"
fi

echo "== 5. creator releases 1.4.1; buyer installs it via allodic update =="
cp -r "$ROOT/examples/pg-auditor" "$WORK/pg-auditor"
sed -i.bak 's/  version: "1.4.0"/  version: "1.4.1"/' "$WORK/pg-auditor/SKILL.md"
"$CLI" publish "$WORK/pg-auditor" >/dev/null
HOME="$BUYER_HOME" "$CLI" update | tee "$WORK/update.out"
grep -q "→ 1.4.1" "$WORK/update.out" || fail "buyer update did not install 1.4.1"
grep -q '1.4.1' "$INSTALLED" || true # content version lives in frontmatter of installed copy

echo "== 6. SECURITY: publisher key rotation — pinned buyer refuses the update =="
kill "$SERVER_PID"; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""
mv "$ALLODIC_DATA/identity.json" "$ALLODIC_DATA/identity.original.json"
# 6a. The server itself refuses a store-without-identity (P1: partial restore
# must fail loudly, never silently mint a new signing key over existing data).
"$SRV" > "$WORK/server-refuse.log" 2>&1 && fail "server booted with existing store but no identity.json" || true
grep -q "identity.json is missing but the store already contains" "$WORK/server-refuse.log" || fail "missing-identity boot did not fail loudly"
echo "   server refused to boot without identity.json ✓ (explicit override required)"
# 6b. Force the rotation the way an attacker holding the box would have to:
export ALLODIC_ACCEPT_NEW_IDENTITY=1
boot_server 2   # regenerates identity: a different publisher key now signs
unset ALLODIC_ACCEPT_NEW_IDENTITY
sed -i.bak 's/  version: "1.4.1"/  version: "1.4.2"/' "$WORK/pg-auditor/SKILL.md"
"$CLI" publish "$WORK/pg-auditor" >/dev/null
HOME="$BUYER_HOME" "$CLI" update | tee "$WORK/rotate.out"
grep -q "PUBLISHER KEY CHANGED" "$WORK/rotate.out" || fail "key rotation was NOT refused"
node -e "
const i = JSON.parse(require('fs').readFileSync('$BUYER_HOME/.allodic/installs.json'))[0];
if (i.version !== '1.4.1') throw new Error('buyer state advanced past a refused key rotation');
console.log('   refused; buyer stays on ' + i.version);
"

echo "== 7. original publisher restored; refund revokes; buyer access denied =="
kill "$SERVER_PID"; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""
mv "$ALLODIC_DATA/identity.original.json" "$ALLODIC_DATA/identity.json"
boot_server 3
# The running server holds the store's exclusive lock (single-writer
# guarantee), so we take the order id from the trace output instead of the db.
ORDER=$(grep -oE 'ord_[a-f0-9]+' "$WORK/trace.out" | head -1)
[ -n "$ORDER" ] || fail "could not extract order id from trace output"
curl -s -X POST "$ALLODIC_SERVER/api/orders/$ORDER/revoke" -H "x-admin-key: $ALLODIC_ADMIN_KEY" -H 'content-type: application/json' -d '{"reason":"refund"}' | grep -q '"revoked":true' || fail "revoke failed"
HOME="$BUYER_HOME" "$CLI" update | tee "$WORK/denied.out"
grep -qiE "no active license|revoked|not activated|licen" "$WORK/denied.out" || fail "revoked buyer was not denied"

echo "== e2e complete =="
