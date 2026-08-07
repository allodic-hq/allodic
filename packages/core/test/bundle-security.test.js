import { test } from 'node:test';
import assert from 'node:assert';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, rmSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signManifest, verifyBundle, installBundle, sha256 } from '@allodic/core';

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ type: 'spki', format: 'pem' }), priv: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
// Build a bundle whose manifest signs exactly `signedFiles`, but delivers `deliveredFiles`.
function craft(priv, signedFiles, deliveredFiles = signedFiles) {
  const manifest = { kind: 'bundle', version: '1.0.0', files: {} };
  for (const [p, buf] of Object.entries(signedFiles)) manifest.files[p] = sha256(buf);
  const sig = signManifest(manifest, priv);
  const files = {};
  for (const [p, buf] of Object.entries(deliveredFiles)) files[p] = buf.toString('base64');
  return { manifest, sig, files };
}

test('SECURITY: unsigned extra file is rejected (the reported exploit)', () => {
  const { pub, priv } = keypair();
  const legit = { 'SKILL.md': Buffer.from('ok') };
  const b = craft(priv, legit, { ...legit, '../../pwned.txt': Buffer.from('x') });
  assert.throws(() => verifyBundle(b, pub), /unsigned file|file set mismatch/);
});

test('SECURITY: traversal path rejected even if signed', () => {
  const { pub, priv } = keypair();
  const b = craft(priv, { '../../escape.txt': Buffer.from('x') });
  assert.throws(() => verifyBundle(b, pub), /traversal|unsafe/);
});

test('SECURITY: absolute path rejected', () => {
  const { pub, priv } = keypair();
  const b = craft(priv, { '/etc/cron.d/evil': Buffer.from('x') });
  assert.throws(() => verifyBundle(b, pub), /absolute/);
});

test('SECURITY: windows drive + UNC + backslash rejected', () => {
  const { pub, priv } = keypair();
  for (const p of ['C:\\evil.txt', '\\\\host\\share\\x', 'sub\\..\\..\\x']) {
    assert.throws(() => verifyBundle(craft(priv, { [p]: Buffer.from('x') }), pub), /drive|UNC|backslash|traversal|unsafe/);
  }
});

test('SECURITY: dot and empty paths rejected', () => {
  const { pub, priv } = keypair();
  for (const p of ['.', '..', '']) {
    assert.throws(() => verifyBundle(craft(priv, { [p]: Buffer.from('x') }), pub), /unsafe|empty|traversal/);
  }
});

test('SECURITY: embedded traversal (a/../../b) rejected', () => {
  const { pub, priv } = keypair();
  assert.throws(() => verifyBundle(craft(priv, { 'a/../../../b.txt': Buffer.from('x') }), pub), /traversal|unsafe/);
});

test('SECURITY: missing signed file rejected (set must be exact)', () => {
  const { pub, priv } = keypair();
  const b = craft(priv, { 'SKILL.md': Buffer.from('ok'), 'extra.md': Buffer.from('y') });
  delete b.files['extra.md'];
  assert.throws(() => verifyBundle(b, pub), /file set mismatch|unsigned/);
});

test('SECURITY: installBundle refuses a raw (unverified) bundle', () => {
  const { priv } = keypair();
  const b = craft(priv, { 'SKILL.md': Buffer.from('ok') });
  const dir = mkdtempSync(join(tmpdir(), 'inst-'));
  assert.throws(() => installBundle(b, dir), /requires a verified bundle/);
});

test('SECURITY: no file escapes the target directory on install', () => {
  const { pub, priv } = keypair();
  const legit = { 'SKILL.md': Buffer.from('ok'), 'scripts/run.sh': Buffer.from('echo hi') };
  const verified = verifyBundle(craft(priv, legit), pub);
  const base = mkdtempSync(join(tmpdir(), 'base-'));
  const target = join(base, 'skill');
  const escape = join(base, 'escaped.txt');
  installBundle(verified, target);
  assert.ok(existsSync(join(target, 'SKILL.md')));
  assert.ok(existsSync(join(target, 'scripts', 'run.sh')));
  assert.ok(!existsSync(escape));
  rmSync(base, { recursive: true, force: true });
});

test('SECURITY: valid bundle still installs correctly (no regression)', () => {
  const { pub, priv } = keypair();
  const legit = { 'SKILL.md': Buffer.from('---\nname: ok\n---\nbody') };
  const verified = verifyBundle(craft(priv, legit), pub);
  const dir = mkdtempSync(join(tmpdir(), 'ok-'));
  installBundle(verified, join(dir, 'skill'));
  assert.ok(existsSync(join(dir, 'skill', 'SKILL.md')));
  rmSync(dir, { recursive: true, force: true });
});
