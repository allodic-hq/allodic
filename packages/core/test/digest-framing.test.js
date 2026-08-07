// P0.6 regression: the content digest must use collision-proof framing.
//
// The old digest hashed the unframed concatenation path‖content‖path‖content,
// so the file sets {"a":"bc"} and {"ab":"c"} both hashed the byte string
// "abc" — one digest, two different skills. The digest is the capability
// identity, the scorecard binding, the version-idempotency comparison, and
// the bundle-continuity value, so a collision forges all four at once.
//
// v1 framing hashes a domain-separated canonical JSON array of
// {path, sha256(content)} entries — and is therefore also recomputable from
// the capability's published per-file hash map, which the verify chain checks.
import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import {
  skillContentHash, skillDigestFromHashes, buildCapabilityManifest, sha256,
} from '../src/index.js';

test('REGRESSION: the reviewer\u2019s structural collision pair no longer collides', () => {
  const a = skillContentHash({ a: 'bc' });
  const b = skillContentHash({ ab: 'c' });
  assert.notEqual(a, b, '{"a":"bc"} and {"ab":"c"} must not share a digest');
  // Prove the OLD framing really did collide (documents why this test exists).
  const old = (files) => createHash('sha256')
    .update(Buffer.concat(Object.keys(files).sort().map((p) => Buffer.concat([Buffer.from(p), Buffer.from(files[p])]))))
    .digest('hex');
  assert.equal(old({ a: 'bc' }), old({ ab: 'c' }), 'sanity: the pre-fix framing collided');
});

test('boundary-shifting variants all produce distinct digests', () => {
  const variants = [
    { 'SKILL.md': 'xyz', extra: '' },
    { 'SKILL.mdx': 'yz', extra: '' },
    { 'SKILL.mdxyz': '', extra: '' },
    { 'SKILL.md': 'xyzextra' },
    { 'SKILL.md': 'xyz', 'ex': 'tra' },
  ];
  const digests = variants.map(skillContentHash);
  assert.equal(new Set(digests).size, variants.length, 'every framing boundary shift must change the digest');
});

test('digest is stable across key insertion order and Buffer/string content', () => {
  const d1 = skillContentHash({ 'SKILL.md': 'hello', 'ref.md': 'world' });
  const d2 = skillContentHash({ 'ref.md': Buffer.from('world'), 'SKILL.md': Buffer.from('hello') });
  assert.equal(d1, d2);
});

test('content changes and path renames each change the digest', () => {
  const base = skillContentHash({ 'SKILL.md': 'hello' });
  assert.notEqual(skillContentHash({ 'SKILL.md': 'hello!' }), base);
  assert.notEqual(skillContentHash({ 'SKILL2.md': 'hello' }), base);
});

test('digest is recomputable from the per-file hash map alone', () => {
  const files = { 'SKILL.md': 'hello', 'evals/tasks.json': '[]' };
  const hashes = Object.fromEntries(Object.entries(files).map(([p, c]) => [p, sha256(Buffer.from(c))]));
  assert.equal(skillDigestFromHashes(hashes), skillContentHash(files),
    'verifiers must be able to derive the digest from capability.files without raw content');
});

test('capability invariant: digest === skillDigestFromHashes(capability.files)', () => {
  const files = { 'SKILL.md': '---\nname: t\ndescription: d\n---\nbody', 'ref.md': 'r' };
  const c = buildCapabilityManifest({
    meta: { name: 't', description: 'd', metadata: { version: '1.0.0' } },
    files, creator: 'test',
  });
  assert.equal(c.digest, skillDigestFromHashes(c.files));
  assert.equal(c.digest, skillContentHash(files));
});

test('a tampered per-file hash map no longer matches the digest', () => {
  const files = { 'SKILL.md': 'hello', 'ref.md': 'world' };
  const c = buildCapabilityManifest({
    meta: { name: 't', description: 'd', metadata: { version: '1.0.0' } },
    files, creator: 'test',
  });
  const tampered = { ...c.files, 'ref.md': sha256(Buffer.from('evil')) };
  assert.notEqual(skillDigestFromHashes(tampered), c.digest);
});
