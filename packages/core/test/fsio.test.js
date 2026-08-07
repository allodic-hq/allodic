// P1 regression: secret-bearing files must never be world-readable.
// Before the fix, identity.json (private signing key, fingerprint secret,
// admin key) and ~/.allodic/credentials.json (bearer tokens) were written
// with no explicit mode — 0644 under the default 022 umask.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secureDir, writeSecretJson, hardenSecret } from '../src/index.js';

const posix = process.platform !== 'win32';
const mode = (p) => statSync(p).mode & 0o777;

test('writeSecretJson creates 0600 files inside 0700 dirs, regardless of umask', { skip: !posix }, () => {
  const old = process.umask(0o022); // the exact environment the reviewer reproduced under
  try {
    const d = mkdtempSync(join(tmpdir(), 'fsio-'));
    const p = join(d, 'nested', 'identity.json');
    writeSecretJson(p, { secret: 'k' });
    assert.equal(mode(p), 0o600, 'secret file must be owner-only');
    assert.equal(mode(join(d, 'nested')), 0o700, 'containing dir must be owner-only');
    assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { secret: 'k' });
    rmSync(d, { recursive: true, force: true });
  } finally { process.umask(old); }
});

test('writeSecretJson replaces atomically: no temp file left, content swapped whole', () => {
  const d = mkdtempSync(join(tmpdir(), 'fsio-'));
  const p = join(d, 'creds.json');
  writeSecretJson(p, { a: 1 });
  writeSecretJson(p, { a: 2 });
  assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { a: 2 });
  assert.deepEqual(readdirSync(d), ['creds.json'], 'no .tmp-* residue');
  rmSync(d, { recursive: true, force: true });
});

test('overwriting an existing 0644 secret leaves it 0600 (atomic replace carries the mode)', { skip: !posix }, () => {
  const d = mkdtempSync(join(tmpdir(), 'fsio-'));
  const p = join(d, 'identity.json');
  writeFileSync(p, '{}'); chmodSync(p, 0o644); // pre-fix state
  writeSecretJson(p, { rotated: true });
  assert.equal(mode(p), 0o600);
  rmSync(d, { recursive: true, force: true });
});

test('hardenSecret repairs a pre-fix 0644 file in place; missing file is a no-op', { skip: !posix }, () => {
  const d = mkdtempSync(join(tmpdir(), 'fsio-'));
  const p = join(d, 'credentials.json');
  writeFileSync(p, '{}'); chmodSync(p, 0o644);
  hardenSecret(p);
  assert.equal(mode(p), 0o600);
  hardenSecret(join(d, 'does-not-exist.json')); // must not throw
  rmSync(d, { recursive: true, force: true });
});

test('secureDir tightens an existing loose directory', { skip: !posix }, () => {
  const d = mkdtempSync(join(tmpdir(), 'fsio-'));
  chmodSync(d, 0o755); // pre-fix state
  secureDir(d);
  assert.equal(mode(d), 0o700);
  rmSync(d, { recursive: true, force: true });
});
