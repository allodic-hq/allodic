import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateKeypair, signManifest, verifyManifest,
  deriveFingerprint, embedFingerprint, extractFingerprint, stripFingerprint,
  buildBuyerBundle, verifyBundle,
} from '@allodic/core';

const SKILL = `---
name: pg-auditor
description: Audits Postgres migrations for locking hazards.
metadata:
  version: "1.3.2"
---

# Postgres Migration Auditor

Reviews migration files for ACCESS EXCLUSIVE lock hazards.

## When to use
Before merging any migration touching hot tables.
`;

test('fingerprint round-trips through both channels', () => {
  const fp = deriveFingerprint('ord_1042', 'secret');
  const marked = embedFingerprint(SKILL, fp);
  const { frontmatter, covert } = extractFingerprint(marked);
  assert.equal(frontmatter, fp);
  assert.equal(covert, fp);
});

test('covert channel survives frontmatter stripping', () => {
  const fp = deriveFingerprint('ord_1042', 'secret');
  const marked = embedFingerprint(SKILL, fp);
  const noFrontmatter = marked.replace(/^---\n[\s\S]*?\n---\n/, '');
  const { frontmatter, covert } = extractFingerprint(noFrontmatter);
  assert.equal(frontmatter, null);
  assert.equal(covert, fp);
});

test('fingerprint is invisible to skill semantics', () => {
  const fp = deriveFingerprint('ord_7', 'secret');
  const marked = embedFingerprint(SKILL, fp);
  assert.equal(stripFingerprint(marked).trim(), SKILL.trim());
});

test('different orders produce different fingerprints; same order is stable', () => {
  assert.notEqual(deriveFingerprint('a', 's'), deriveFingerprint('b', 's'));
  assert.equal(deriveFingerprint('a', 's'), deriveFingerprint('a', 's'));
});

test('manifest signatures verify and reject tampering', () => {
  const { publicKeyPem, privateKeyPem } = generateKeypair();
  const manifest = { skill: 'pg-auditor', version: '1.3.2', order: 'ord_1' };
  const sig = signManifest(manifest, privateKeyPem);
  assert.ok(verifyManifest(manifest, sig, publicKeyPem));
  assert.ok(!verifyManifest({ ...manifest, version: '9.9.9' }, sig, publicKeyPem));
});

test('end-to-end: build buyer bundle, verify, detect tamper', () => {
  const { publicKeyPem, privateKeyPem } = generateKeypair();
  const bundle = buildBuyerBundle({
    masterFiles: { 'SKILL.md': Buffer.from(SKILL) },
    skillName: 'pg-auditor',
    version: '1.3.2',
    orderId: 'ord_1042',
    fingerprintSecret: 'server-secret',
    privateKeyPem,
    creator: 'razvan',
  });
  const manifest = verifyBundle(bundle, publicKeyPem);
  assert.equal(manifest.fingerprint, deriveFingerprint('ord_1042', 'server-secret'));

  // Tampered file must fail hash check
  const tampered = structuredClone(bundle);
  tampered.files['SKILL.md'] = Buffer.from('evil').toString('base64');
  assert.throws(() => verifyBundle(tampered, publicKeyPem), /Hash mismatch/);

  // Tampered manifest must fail signature
  const resigned = structuredClone(bundle);
  resigned.manifest.order = 'ord_9999';
  assert.throws(() => verifyBundle(resigned, publicKeyPem), /Signature/);
});
