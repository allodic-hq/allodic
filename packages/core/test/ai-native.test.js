import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSlots, slotCapacityBits, renderCanaryCopy, renderNeutralCopy, traceCanary,
  gradeTranscript, makeRunner, runEvals, signScorecard, verifyScorecard, skillContentHash,
  generateKeypair, deriveFingerprint,
} from '@allodic/core';

const SOURCE = `# Postgres Migration Auditor

{{~ Before merging | Prior to merging | Before you merge }} any migration touching
{{~ hot tables | high-traffic tables }}, run the checks below.

1. {{~ Flag | Call out }} CREATE INDEX without CONCURRENTLY on {{~ large | big }} tables.
2. {{~ Foreign key additions | New foreign keys }} need NOT VALID + VALIDATE.
3. Type changes take {{~ ACCESS EXCLUSIVE locks | an ACCESS EXCLUSIVE lock }}.
`;

test('canary: slots parse and carry capacity', () => {
  const slots = parseSlots(SOURCE);
  assert.equal(slots.length, 6);
  assert.ok(slotCapacityBits(slots) >= 6);
});

test('canary: different buyers get semantically-equal but distinguishable copies', () => {
  const a = renderCanaryCopy(SOURCE, deriveFingerprint('ord_A', 's'));
  const b = renderCanaryCopy(SOURCE, deriveFingerprint('ord_B', 's'));
  assert.notEqual(a.content, b.content);
  assert.ok(!a.content.includes('{{~'));
  assert.ok(!b.content.includes('{{~'));
});

test('canary: trace identifies the leaking buyer with full confidence', () => {
  const candidates = ['ord_A', 'ord_B', 'ord_C', 'ord_D'].map((orderId) => ({
    orderId, fingerprintHex: deriveFingerprint(orderId, 's'),
  }));
  const leaked = renderCanaryCopy(SOURCE, candidates[2].fingerprintHex).content;
  const { ranked } = traceCanary(leaked, SOURCE, candidates);
  assert.equal(ranked[0].orderId, 'ord_C');
  assert.equal(ranked[0].confidence, 1);
});

test('canary: survives reformatting and partial laundering', () => {
  const candidates = ['ord_A', 'ord_B', 'ord_C', 'ord_D'].map((orderId) => ({
    orderId, fingerprintHex: deriveFingerprint(orderId, 's'),
  }));
  let leaked = renderCanaryCopy(SOURCE, candidates[1].fingerprintHex).content;
  // pirate reflows whitespace, changes case, rewrites entire sentences (kills 2 slots)
  leaked = leaked.replace(/\s+/g, ' ').toUpperCase();
  leaked = leaked.replace(/1\..*?TABLES\./, '1. INDEXES SHOULD BE CREATED CAREFULLY.');
  const { ranked } = traceCanary(leaked, SOURCE, candidates);
  assert.equal(ranked[0].orderId, 'ord_B');
  assert.ok(ranked[0].confidence > 0.7);
});

test('evals: grading, signing, and version binding', () => {
  const tasks = [
    { id: 'unsafe-index', prompt: 'Review: CREATE INDEX i ON orders(email);', mustMention: ['CONCURRENTLY'] },
    { id: 'fk-two-step', prompt: 'Review: ALTER TABLE a ADD FOREIGN KEY...', mustMention: ['NOT VALID'], mustNotMention: ['looks safe'] },
  ];
  const runner = makeRunner('mock', {
    respond: (p) => p.includes('INDEX')
      ? 'Hazard: use CREATE INDEX CONCURRENTLY to avoid blocking writes.'
      : 'Add the constraint as NOT VALID, then VALIDATE CONSTRAINT separately.',
  });
  const files = { 'SKILL.md': 'content-v1' };
  const card = runEvals({ tasks, runner, agentLabel: 'mock-agent', skillName: 'test-skill', skillFiles: files, skillContentHash: skillContentHash(files) });
  assert.equal(card.passed, 2);

  const { publicKeyPem, privateKeyPem } = generateKeypair();
  const signed = signScorecard(card, privateKeyPem);
  assert.equal(verifyScorecard(signed, publicKeyPem, skillContentHash(files)).passed, 2);

  // recycled scorecard on a new version must be rejected
  assert.throws(
    () => verifyScorecard(signed, publicKeyPem, skillContentHash({ 'SKILL.md': 'content-v2' })),
    /different version/,
  );
});

test('evals: failing criteria are reported, not hidden', () => {
  const grade = gradeTranscript(
    { mustMention: ['CONCURRENTLY'], mustNotMention: ['looks safe'] },
    'This migration looks safe to me.',
  );
  assert.equal(grade.pass, false);
  assert.deepEqual(grade.missing, ['CONCURRENTLY']);
  assert.deepEqual(grade.forbidden, ['looks safe']);
});

test('neutral copy renders option zero everywhere (free preview)', () => {
  const neutral = renderNeutralCopy(SOURCE);
  assert.ok(neutral.includes('Before merging'));
  assert.ok(!neutral.includes('{{~'));
});
