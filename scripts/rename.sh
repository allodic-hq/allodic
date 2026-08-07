#!/usr/bin/env bash
# Parameterized brand rename. Usage: bash scripts/rename.sh <newname> <OldName?>
set -euo pipefail
NEW=${1:?new name (lowercase)}; NEWCAP=$(python3 -c "print('$NEW'.capitalize())")
OLD=${2:-allodic}; OLDCAP=$(python3 -c "print('$OLD'.capitalize())")
OLDUP=$(echo $OLD | tr a-z A-Z); NEWUP=$(echo $NEW | tr a-z A-Z)
grep -rl --exclude-dir=node_modules --exclude-dir=.git -e "$OLD" -e "$OLDCAP" -e "$OLDUP" . | while read f; do
  sed -i "s/$OLD/$NEW/g; s/$OLDCAP/$NEWCAP/g; s/$OLDUP/$NEWUP/g" "$f"
done
[ -f packages/cli/bin/$OLD.js ] && git mv packages/cli/bin/$OLD.js packages/cli/bin/$NEW.js || true
[ -f packages/server/bin/$OLD-server.js ] && git mv packages/server/bin/$OLD-server.js packages/server/bin/$NEW-server.js || true
echo "renamed $OLD -> $NEW"
