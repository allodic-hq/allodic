// P1 (default-release blocker): `allodic init` scaffolded from the cwd name
// verbatim — `My Skill`, `foo.bar`, `_private` all "succeeded" and then
// failed the compliance gate at publish, breaking the literal quickstart.
// Now: `allodic init my-skill` creates a valid directory; in-place init
// validates the cwd name BEFORE writing anything.
//
// Also here: the shared release gate (scripts/check-release-tag.sh) that both
// publish workflows run — a version tag that disagrees with package.json must
// fail, killing the npm-refuses-but-ghcr-ships split-brain.
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'bin', 'allodic.js');
const GATE = join(ROOT, 'scripts', 'check-release-tag.sh');

function runInit(cwd, args = []) {
  try {
    // Unrelated CLI tests always pin telemetry off explicitly (docs/telemetry.md).
    const out = execFileSync('node', [CLI, 'init', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ALLODIC_TELEMETRY: '0' } });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

test('init <name> creates a directory whose SKILL.md name matches it', () => {
  const d = mkdtempSync(join(tmpdir(), 'init-'));
  const r = runInit(d, ['my-skill']);
  assert.equal(r.code, 0, r.out);
  const md = readFileSync(join(d, 'my-skill', 'SKILL.md'), 'utf8');
  assert.match(md, /^name: my-skill$/m, 'frontmatter name equals directory name — the spec requires it');
  assert.ok(existsSync(join(d, 'my-skill', 'evals', 'tasks.json')));
  assert.match(r.out, /allodic publish \.\/my-skill/);
  rmSync(d, { recursive: true, force: true });
});

test("REGRESSION: the reviewer's table — invalid names are refused with an actionable suggestion, nothing written", () => {
  const cases = [
    ['My Skill', 'my-skill'],
    ['foo.bar', 'foo-bar'],
    ['_private', 'private'],
    ['skill--name', 'skill-name'],
  ];
  for (const [bad, suggestion] of cases) {
    const d = mkdtempSync(join(tmpdir(), 'init-'));
    const r = runInit(d, [bad]);
    assert.equal(r.code, 1, `'${bad}' must be refused`);
    assert.match(r.out, /not a valid skill name/);
    assert.match(r.out, new RegExp(`allodic init ${suggestion}`), `'${bad}' should suggest '${suggestion}'`);
    assert.deepEqual(readdirSync(d), [], `refusing '${bad}' must write NOTHING`);
    rmSync(d, { recursive: true, force: true });
  }
});

test('in-place init works when the cwd name is already valid', () => {
  const base = mkdtempSync(join(tmpdir(), 'init-'));
  const d = join(base, 'valid-skill');
  mkdirSync(d);
  const r = runInit(d);
  assert.equal(r.code, 0, r.out);
  assert.match(readFileSync(join(d, 'SKILL.md'), 'utf8'), /^name: valid-skill$/m);
  rmSync(base, { recursive: true, force: true });
});

test('in-place init in an invalidly-named cwd refuses BEFORE writing anything', () => {
  const base = mkdtempSync(join(tmpdir(), 'init-'));
  const d = join(base, 'foo.bar');
  mkdirSync(d);
  const r = runInit(d);
  assert.equal(r.code, 1);
  assert.match(r.out, /not a valid skill name/);
  assert.deepEqual(readdirSync(d), [], 'no SKILL.md, no evals — the directory is untouched');
  rmSync(base, { recursive: true, force: true });
});

// ---- release gate ----

function runGate(env) {
  try {
    const out = execFileSync('bash', [GATE], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}
const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

test("RELEASE GATE: the split-brain tag (v-something ≠ package version) FAILS — nothing may build or push", () => {
  const r = runGate({ GITHUB_REF: 'refs/tags/v0.0.0-not-this', GITHUB_REF_NAME: 'v0.0.0-not-this' });
  assert.equal(r.code, 1);
  assert.match(r.out, /does not match package version/);
});

test('RELEASE GATE: a tag matching package.json passes', () => {
  const r = runGate({ GITHUB_REF: `refs/tags/v${pkgVersion}`, GITHUB_REF_NAME: `v${pkgVersion}` });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /release gate: tag/);
});

test('RELEASE GATE: non-tag refs pass through (nothing version-tagged is being published)', () => {
  const r = runGate({ GITHUB_REF: 'refs/heads/main', GITHUB_REF_NAME: 'main' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /not a tag ref/);
});
