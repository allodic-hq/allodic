// Canary trace: attribution honesty. Reproduces the review finding —
// duplicate choice vectors in a low-capacity slot space — and asserts the
// trace refuses to fabricate a single answer from non-unique evidence.
import assert from 'node:assert';
import { parseSlots, slotCapacityBits, renderCanaryCopy, traceCanary, checkCompliance } from '../src/index.js';

let pass = 0;
const t = (name, fn) => { fn(); pass++; };

// A 7-bit source, same shape as the example skill the review used.
const SOURCE = `# Guide
{{~ Before merging | Prior to merging | Before you merge }} check locks.
Watch {{~ hot tables | high-traffic tables }} closely.
{{~ Flag | Call out }} any {{~ large | big }} scans on {{~ large | sizable }} sets.
{{~ Foreign key additions | New foreign keys }} take {{~ ACCESS EXCLUSIVE locks | an ACCESS EXCLUSIVE lock }}.
`;

t('capacity math: 7 slots, 7 bits, 128 vectors', () => {
  const slots = parseSlots(SOURCE);
  assert.equal(slots.length, 7);
  assert.equal(slotCapacityBits(slots), 7);
});

// Fingerprints are consumed as leading bits; same first hex chars -> same
// 7-bit choice vector. 'ff...' vs 'fe...' differ only past bit 7.
const A = 'ff00000000000000';       // vector X
const B = 'fe11111111111111';       // vector X (first 7 bits identical to A)
const C = '0000000000000000';       // vector Y

t('setup: A and B genuinely collide; C differs', () => {
  const va = renderCanaryCopy(SOURCE, A).choices.map((c) => c.picked).join('');
  const vb = renderCanaryCopy(SOURCE, B).choices.map((c) => c.picked).join('');
  const vc = renderCanaryCopy(SOURCE, C).choices.map((c) => c.picked).join('');
  assert.equal(va, vb, 'A and B must share a choice vector for this test');
  assert.notEqual(va, vc);
});

const leakOf = (hex) => renderCanaryCopy(SOURCE, hex).content;

t("REVIEW CASE: colliding buyers -> 'inconclusive', both candidates reported, no single answer", () => {
  const r = traceCanary(leakOf(A), SOURCE, [
    { orderId: 'ord_A', fingerprintHex: A },
    { orderId: 'ord_B', fingerprintHex: B },
    { orderId: 'ord_C', fingerprintHex: C },
  ]);
  assert.equal(r.verdict, 'inconclusive');
  assert.equal(r.match, null, 'must NOT name one buyer when several are perfect matches');
  assert.deepEqual(r.consistent.map((c) => c.orderId).sort(), ['ord_A', 'ord_B']);
  assert.equal(r.stats.capacityBits, 7);
  assert.equal(r.stats.orders, 3);
});

t('unique full consistency -> identified, with ambiguity stats attached', () => {
  const r = traceCanary(leakOf(C), SOURCE, [
    { orderId: 'ord_A', fingerprintHex: A },
    { orderId: 'ord_B', fingerprintHex: B },
    { orderId: 'ord_C', fingerprintHex: C },
  ]);
  assert.equal(r.verdict, 'identified');
  assert.equal(r.match.orderId, 'ord_C');
  assert.ok(r.stats.expectedRandomMatches > 0, 'ambiguity floor is always reported');
});

t('partial match (one slot flipped) -> inconclusive, never an accusation', () => {
  // Take C's copy and flip one surviving slot to the other option.
  const flipped = leakOf(C).replace('hot tables', 'high-traffic tables');
  const r = traceCanary(flipped, SOURCE, [
    { orderId: 'ord_A', fingerprintHex: A },
    { orderId: 'ord_C', fingerprintHex: C },
  ]);
  assert.notEqual(r.verdict, 'identified');
  assert.equal(r.match, null);
});

t('too few surviving slots -> insufficient-evidence, no attribution', () => {
  // A rewrite that only preserves two slot phrasings.
  const heavy = 'Totally rewritten guide. Flag issues on hot tables.';
  const r = traceCanary(heavy, SOURCE, [{ orderId: 'ord_C', fingerprintHex: C }]);
  assert.equal(r.verdict, 'insufficient-evidence');
  assert.equal(r.match, null);
});

t('unrelated document -> no-match', () => {
  const r = traceCanary('A pasta recipe with garlic and olive oil.', SOURCE,
    [{ orderId: 'ord_C', fingerprintHex: C }]);
  assert.equal(r.verdict, 'no-match');
});

t('publish gate: paid skill with 7-bit canary capacity gets the capacity warning', () => {
  const files = { 'SKILL.md': `---\nname: guide\ndescription: A guide for checking locks before merging. Use when merging.\nmetadata:\n  version: "1.0.0"\n  price: "$29"\n---\n\n${SOURCE}` };
  const r = checkCompliance(files, { dirName: 'guide', engine: 'js' });
  const w = r.warnings.find((x) => x.id === 'canary-capacity');
  assert.ok(w, 'expected canary-capacity warning');
  assert.match(w.msg, /7 bits/);
  assert.match(w.msg, /128 distinguishable/);
});

t('publish gate: free skill is not nagged about canary capacity', () => {
  const files = { 'SKILL.md': `---\nname: guide\ndescription: A guide for checking locks before merging. Use when merging.\nmetadata:\n  version: "1.0.0"\n---\n\n${SOURCE}` };
  const r = checkCompliance(files, { dirName: 'guide', engine: 'js' });
  assert.ok(!r.warnings.some((x) => x.id.startsWith('canary')));
});

console.log(`canary-trace.test.js: ${pass} passed`);
