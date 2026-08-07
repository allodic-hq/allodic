#!/usr/bin/env node
// One version, everywhere. Fails the test suite if the root, any workspace,
// or any cross-workspace dependency pin disagrees. This exists because the
// v0.9 review tarball was labelled "v1.0.0-launch" while every package said
// 0.1.0 — three contradictory notions of "version" heading for git tags,
// docker image tags, and npm at once. Bump with: scripts/set-version.sh <ver>
import { readFileSync } from 'node:fs';

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const root = read('package.json');
const workspaces = root.workspaces.map((w) => ({ path: `${w}/package.json`, pkg: read(`${w}/package.json`) }));
const localNames = new Set(workspaces.map((w) => w.pkg.name));

const problems = [];
const prerelease = root.version.includes('-');
for (const { path, pkg } of workspaces) {
  if (pkg.version !== root.version) {
    problems.push(`${path}: version ${pkg.version} != root ${root.version}`);
  }
  // Channel discipline: prereleases must publish to the `alpha` dist-tag
  // (never `latest`); stable versions must not carry a prerelease tag.
  const tag = pkg.publishConfig?.tag;
  if (prerelease && tag !== 'alpha') {
    problems.push(`${path}: prerelease ${root.version} needs publishConfig.tag "alpha" (has ${JSON.stringify(tag ?? null)}) — bare \`npm publish\` would ship it as latest`);
  }
  if (!prerelease && tag && tag !== 'latest') {
    problems.push(`${path}: stable ${root.version} still carries publishConfig.tag ${JSON.stringify(tag)}`);
  }
  for (const deps of [pkg.dependencies, pkg.devDependencies]) {
    for (const [name, spec] of Object.entries(deps ?? {})) {
      if (localNames.has(name) && spec !== root.version) {
        problems.push(`${path}: pins ${name}@${spec}, expected ${root.version}`);
      }
    }
  }
}

// The LOCKFILE is part of "one version, everywhere": npm ci installs from
// it, and its per-workspace metadata records each package's version. A bump
// that edits manifests but not the lock leaves the two disagreeing — releases
// would build from a lockfile describing the previous version.
{
  const lock = read('package-lock.json');
  const lockRoot = lock.packages?.['']?.version ?? lock.version;
  if (lockRoot !== root.version) {
    problems.push(`package-lock.json: root version ${lockRoot} != ${root.version} — run scripts/set-version.sh (it regenerates lock metadata)`);
  }
  for (const w of root.workspaces) {
    const entry = lock.packages?.[w];
    if (!entry) { problems.push(`package-lock.json: missing workspace entry for ${w}`); continue; }
    if (entry.version !== root.version) {
      problems.push(`package-lock.json [${w}]: version ${entry.version} != ${root.version} — run scripts/set-version.sh`);
    }
  }
}

// Packaging hygiene: every publishable workspace ships LICENSE + README,
// carries repository metadata, and scoped packages are publicly publishable.
import { existsSync } from 'node:fs';
for (const { path, pkg } of workspaces) {
  const dir = path.replace(/\/package\.json$/, '');
  for (const f of ['LICENSE', 'README.md']) {
    if (!existsSync(`${dir}/${f}`)) problems.push(`${dir}: missing ${f} (npm ships it; "MIT" in package.json is not the licence text)`);
  }
  if (!pkg.repository?.url) problems.push(`${path}: missing repository.url`);
  if (!pkg.bugs?.url) problems.push(`${path}: missing bugs.url`);
  if (pkg.name.startsWith('@') && pkg.publishConfig?.access !== 'public') {
    problems.push(`${path}: scoped package without publishConfig.access "public" — first publish will fail as restricted`);
  }
}
if (!existsSync('LICENSE')) problems.push('repo root: missing LICENSE');
if (!existsSync('SECURITY.md')) problems.push('repo root: missing SECURITY.md');
if (!existsSync('package-lock.json')) problems.push('repo root: missing package-lock.json — reproducible installs require the lockfile committed');

if (problems.length) {
  console.error('✗ version drift:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log(`✓ versions coherent: ${root.version} (root + ${workspaces.length} workspaces + cross-pins, npm channel: ${prerelease ? 'alpha' : 'latest'})`);
