#!/usr/bin/env bash
# The 90-second demo. Record with: asciinema rec -c "bash scripts/demo.sh"
set -euo pipefail
cd "$(dirname "$0")/.."
export ALLODIC_DATA=$(mktemp -d) PORT=8799 ALLODIC_SERVER="http://localhost:8799"
export ALLODIC_DEV_CODES=1
export ALLODIC_EVAL_RUNNER=mock ALLODIC_EVAL_MOCK="Use CREATE INDEX CONCURRENTLY. Add foreign keys as NOT VALID then VALIDATE CONSTRAINT."
node packages/server/bin/allodic-server.js > /dev/null 2>&1 & SPID=$!; trap "kill $SPID" EXIT; sleep 1
export ALLODIC_ADMIN_KEY=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.ALLODIC_DATA+'/identity.json')).adminKey)")
step(){ echo; echo "\$ $1"; sleep 0.4; }

step "allodic publish ."
node packages/cli/bin/allodic.js publish examples/pg-auditor

step "# a buyer, anywhere:"
step "allodic inspect \$STORE/s/pg-auditor"
node packages/cli/bin/allodic.js inspect $ALLODIC_SERVER/s/pg-auditor

T=$(curl -s -X POST $ALLODIC_SERVER/api/checkout/pg-auditor -H 'content-type: application/json' -d '{"email":"buyer@example.com"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).token))")
mkdir -p ~/.allodic && echo "{\"$ALLODIC_SERVER\": \"$T\"}" > ~/.allodic/credentials.json

step "allodic verify \$STORE/s/pg-auditor --evals"
node packages/cli/bin/allodic.js verify $ALLODIC_SERVER/s/pg-auditor --evals

step "# creator ships v1.4.1:"
sed -i.bak 's/  version: "1.4.0"/  version: "1.4.1"/' examples/pg-auditor/SKILL.md
step "allodic release ."
node packages/cli/bin/allodic.js release examples/pg-auditor
mv examples/pg-auditor/SKILL.md.bak examples/pg-auditor/SKILL.md

step "# and this is the page your buyers see:"
step "open \$STORE/s/pg-auditor"
curl -s $ALLODIC_SERVER/s/pg-auditor -H "Accept: text/html" | grep -oE "allodic registry|<h1>[^<]+</h1>|[0-9]+ installs|✓ verified publisher|Buy — \$[0-9.]+|npx allodic add [^<]+" | sed 's/<[^>]*>//g' | head -6
echo
echo "  → your storefront, live, from one 'publish'. No website built."
