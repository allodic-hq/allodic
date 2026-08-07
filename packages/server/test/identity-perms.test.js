// P1 regression: server identity (private key, fingerprint secret, admin key)
// and the data dir (store.db with bearer tokens + buyer PII, WAL, backups)
// must be owner-only — on fresh boot AND repaired on reboot for deployments
// that booted before secure writing existed.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, statSync, chmodSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';

const posix = process.platform !== 'win32';
const mode = (p) => statSync(p).mode & 0o777;

test('fresh boot writes identity.json 0600 in a 0700 data dir', { skip: !posix }, () => {
  const old = process.umask(0o022);
  try {
    const dataDir = mkdtempSync(join(tmpdir(), 'allodic-perm-'));
    const { store } = createApp({ dataDir, env: {} });
    store.close();
    assert.equal(mode(join(dataDir, 'identity.json')), 0o600, 'identity holds the private signing key');
    assert.equal(mode(dataDir), 0o700, 'dir shields store.db, WAL, and backups');
    rmSync(dataDir, { recursive: true, force: true });
  } finally { process.umask(old); }
});

test('reboot repairs a pre-fix world-readable identity and data dir', { skip: !posix }, () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'allodic-perm-'));
  const first = createApp({ dataDir, env: {} });
  first.store.close();
  const idPath = join(dataDir, 'identity.json');
  const before = readFileSync(idPath, 'utf8');
  chmodSync(idPath, 0o644); chmodSync(dataDir, 0o755); // simulate a pre-fix deployment
  const second = createApp({ dataDir, env: {} });
  second.store.close();
  assert.equal(mode(idPath), 0o600, 'existing identity is explicitly chmodded on boot');
  assert.equal(mode(dataDir), 0o700);
  assert.equal(readFileSync(idPath, 'utf8'), before, 'repair never rewrites or rotates the identity');
  rmSync(dataDir, { recursive: true, force: true });
});

test('identity write leaves no temp residue', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'allodic-perm-'));
  const { store } = createApp({ dataDir, env: {} });
  store.close();
  assert.ok(existsSync(join(dataDir, 'identity.json')));
  const residue = readdirSync(dataDir).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(residue, [], 'atomic write must not leave .tmp-* files');
  rmSync(dataDir, { recursive: true, force: true });
});
