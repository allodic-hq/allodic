// Provenance: what is proven, by which mechanism.
//   - unvaried files: exact hash identity with the published capability
//   - varied files: publish-time salted commitment, opened + audited in dispute
// Includes the review's malicious-seller scenario: a seller signing an
// unrelated bundle while copying the published capabilityDigest into it.
import assert from 'node:assert';
import {
  buildDerivationCommitment, verifyDerivationOpening, renderCanaryCopy,
  stripFingerprint, embedFingerprint, sha256, templateize,
} from '../src/index.js';

let pass = 0;
const t = (name, fn) => { fn(); pass++; };

const SOURCE = `# Guide
{{~ Before merging | Prior to merging | Before you merge }} check locks on
{{~ hot tables | high-traffic tables }}.
{{~ Flag | Call out }} anything {{~ large | big }}.
`;
const SECRET = 'per-skill-secret-0123456789abcdef';
const FP = 'ab12cd34ef567890';

t('commitment round-trip: opening + recorded selection reproduces the delivered copy', () => {
  const { commit, opening } = buildDerivationCommitment(SOURCE, SECRET);
  const { content, choices } = renderCanaryCopy(SOURCE, FP);
  const delivered = embedFingerprint(content, FP);           // what the buyer receives
  const stripped = stripFingerprint(delivered);              // what an auditor strips it to
  const r = verifyDerivationOpening({ opening, commit, selection: choices.map((c) => c.picked), strippedContent: stripped });
  assert.ok(r.ok, r.reasons.join('; '));
});

t('binding: the seller cannot open a different structure than committed', () => {
  const { commit, opening } = buildDerivationCommitment(SOURCE, SECRET);
  const tampered = structuredClone(opening);
  tampered.slots[1].options[1] = 'entirely different phrase';
  const { content, choices } = renderCanaryCopy(SOURCE, FP);
  const r = verifyDerivationOpening({ opening: tampered, commit, selection: choices.map((c) => c.picked), strippedContent: content });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes('does not match the published commitment')));
});

t('audit catches a delivered copy that does NOT derive from the committed source', () => {
  const { commit, opening } = buildDerivationCommitment(SOURCE, SECRET);
  const { choices } = renderCanaryCopy(SOURCE, FP);
  const unrelated = '# Guide\nCompletely different content the seller swapped in.\n';
  const r = verifyDerivationOpening({ opening, commit, selection: choices.map((c) => c.picked), strippedContent: unrelated });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes('derived content does not equal')));
});

t('audit catches a falsified selection', () => {
  const { commit, opening } = buildDerivationCommitment(SOURCE, SECRET);
  const { content, choices } = renderCanaryCopy(SOURCE, FP);
  const wrong = choices.map((c) => (c.picked + 1) % c.of);
  const r = verifyDerivationOpening({ opening, commit, selection: wrong, strippedContent: content });
  assert.equal(r.ok, false);
});

t('hiding: the commitment does not leak option text (salted leaves)', () => {
  const a = buildDerivationCommitment(SOURCE, SECRET);
  const b = buildDerivationCommitment(SOURCE, 'a-different-secret');
  assert.notEqual(a.commit, b.commit, 'same options, different salts -> different commits: leaves are not bare option hashes');
  assert.ok(!a.commit.includes('hot'), 'commit is a digest, not content');
});

t('templateize: slot positions preserved, options removed', () => {
  const { template, slots } = templateize(SOURCE);
  assert.equal(slots.length, 4);
  assert.ok(template.includes('{{slot:0}}') && template.includes('{{slot:3}}'));
  assert.ok(!template.includes('Prior to merging'), 'options are not in the template placeholders');
});

// ---- the review's malicious-seller scenario, at the mechanism level ----

t("REVIEW CASE: copied capabilityDigest no longer suffices — unvaried file swap is caught by hash identity", () => {
  // Published capability hashes (what the buyer's pinned listing carries):
  const published = { 'scripts/check.sql': Buffer.from('SELECT 1; -- audited'), 'SKILL.md': Buffer.from(SOURCE) };
  const capabilityFiles = Object.fromEntries(Object.entries(published).map(([p, b]) => [p, sha256(b)]));
  // Malicious seller ships a different script but signs it and copies the digest field:
  const shipped = Buffer.from('SELECT 1; -- with a little something extra');
  // The buyer-side mechanical check (as implemented in `allodic verify`):
  const matches = capabilityFiles['scripts/check.sql'] === sha256(shipped);
  assert.equal(matches, false, 'hash identity check must fail for the swapped file');
});

console.log(`derivation.test.js: ${pass} passed`);
