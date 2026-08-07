// P0 regression: `allodic publish` collected files with statSync, which
// FOLLOWS symlinks — `innocent.txt -> ../outside-secret.txt` was read as if
// it belonged to the skill and would have been published and delivered to
// buyers (SSH keys, .npmrc, .env: none of which a content scanner reliably
// flags). Policy for 0.1.0: symlinks are rejected outright, and every
// collected path must physically live under the package root.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectFiles } from '../src/index.js';

const SKILL_MD = '---\nname: s\ndescription: d\n---\nbody\n';

function makeSkillDir() {
  const base = mkdtempSync(join(tmpdir(), 'collect-'));
  const skill = join(base, 'skill');
  mkdirSync(skill);
  writeFileSync(join(skill, 'SKILL.md'), SKILL_MD);
  return { base, skill };
}

test("REGRESSION: the reviewer's repro — file symlink to OUTSIDE the root is rejected, target never read", () => {
  const { base, skill } = makeSkillDir();
  writeFileSync(join(base, 'outside-secret.txt'), 'TOP_SECRET');
  symlinkSync(join(base, 'outside-secret.txt'), join(skill, 'innocent.txt'));
  assert.throws(() => collectFiles(skill), /symlinks are not allowed.*innocent\.txt/);
  rmSync(base, { recursive: true, force: true });
});

test('directory symlink to outside the root is rejected (would have walked the whole target)', () => {
  const { base, skill } = makeSkillDir();
  mkdirSync(join(base, 'outside-dir'));
  writeFileSync(join(base, 'outside-dir', 'id_ed25519'), 'PRIVATE KEY');
  symlinkSync(join(base, 'outside-dir'), join(skill, 'docs'));
  assert.throws(() => collectFiles(skill), /symlinks are not allowed.*docs/);
  rmSync(base, { recursive: true, force: true });
});

test('symlink to another location INSIDE the root is rejected too — no symlinks, period', () => {
  const { base, skill } = makeSkillDir();
  writeFileSync(join(skill, 'real.md'), 'fine');
  symlinkSync(join(skill, 'real.md'), join(skill, 'alias.md'));
  assert.throws(() => collectFiles(skill), /symlinks are not allowed.*alias\.md/);
  rmSync(base, { recursive: true, force: true });
});

test('broken symlink is rejected the same way (lstat sees the link itself)', () => {
  const { base, skill } = makeSkillDir();
  symlinkSync(join(base, 'does-not-exist'), join(skill, 'dangling'));
  assert.throws(() => collectFiles(skill), /symlinks are not allowed.*dangling/);
  rmSync(base, { recursive: true, force: true });
});

test('nested symlink deep in a subdirectory is caught', () => {
  const { base, skill } = makeSkillDir();
  mkdirSync(join(skill, 'scripts', 'lib'), { recursive: true });
  writeFileSync(join(base, 'aws-credentials'), 'AKIA...');
  symlinkSync(join(base, 'aws-credentials'), join(skill, 'scripts', 'lib', 'helper.txt'));
  assert.throws(() => collectFiles(skill), /symlinks are not allowed/);
  rmSync(base, { recursive: true, force: true });
});

test('NO PARTIAL RESULT: rejection throws — nothing is returned even when valid files precede the symlink', () => {
  const { base, skill } = makeSkillDir();
  writeFileSync(join(skill, 'aaa-valid.md'), 'collected first in directory order');
  writeFileSync(join(base, 'secret'), 'x');
  symlinkSync(join(base, 'secret'), join(skill, 'zzz-link'));
  let result = null;
  try { result = collectFiles(skill); } catch { /* expected */ }
  assert.equal(result, null, 'a throw means the caller (publish) gets NOTHING — no partial upload is possible');
  rmSync(base, { recursive: true, force: true });
});

test('clean directory with subdirectories still collects normally (no regression)', () => {
  const { base, skill } = makeSkillDir();
  mkdirSync(join(skill, 'scripts'));
  writeFileSync(join(skill, 'scripts', 'run.sh'), 'echo hi');
  const files = collectFiles(skill);
  assert.deepEqual(Object.keys(files).sort(), ['SKILL.md', 'scripts/run.sh']);
  rmSync(base, { recursive: true, force: true });
});
