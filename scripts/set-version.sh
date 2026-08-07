#!/usr/bin/env bash
# Bump the ONE project version everywhere: root, all workspaces, cross-pins.
# Usage: bash scripts/set-version.sh 0.1.0-alpha.2
# Then:  git commit -am "v$V" && git tag "v$V"   (the tag drives the ghcr image)
set -euo pipefail
V=${1:?usage: set-version.sh <semver>}
node - "$V" << 'EOF'
const { readFileSync, writeFileSync } = require('node:fs');
const v = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v)) { console.error(`not a semver: ${v}`); process.exit(1); }
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const write = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2) + '\n');
const root = read('package.json');
const names = new Set(root.workspaces.map((w) => read(`${w}/package.json`).name));
const prerelease = v.includes('-');
root.version = v; write('package.json', root);
for (const w of root.workspaces) {
  const p = `${w}/package.json`, pkg = read(p);
  pkg.version = v;
  // Channel discipline: prereleases publish to the `alpha` dist-tag so bare
  // `npx allodic` resolves nothing until the first stable/default release.
  if (prerelease) pkg.publishConfig = { ...(pkg.publishConfig ?? {}), tag: 'alpha' };
  else if (pkg.publishConfig) { delete pkg.publishConfig.tag; if (!Object.keys(pkg.publishConfig).length) delete pkg.publishConfig; }
  for (const deps of [pkg.dependencies, pkg.devDependencies])
    for (const name of Object.keys(deps ?? {})) if (names.has(name)) deps[name] = v;
  write(p, pkg);
}
console.log(`set ${v} across root + ${root.workspaces.length} workspaces (npm dist-tag: ${prerelease ? 'alpha' : 'latest'})`);
EOF
# The lockfile mirrors every workspace's version in its own metadata; without
# this step a bump leaves package-lock.json describing the OLD version while
# check-versions declares everything coherent. --package-lock-only rewrites
# the metadata without touching node_modules.
npm install --package-lock-only --no-audit --no-fund >/dev/null
node scripts/check-versions.js
