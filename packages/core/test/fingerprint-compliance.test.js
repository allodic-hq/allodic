// P0.4: a fingerprinted SKILL.md must stay agent-skills/v1 compliant, and
// embed/strip must round-trip for LF and CRLF without duplicating frontmatter.
import assert from 'node:assert';
import { embedFingerprint, stripFingerprint, extractFingerprint, checkCompliance } from '../src/index.js';

let pass = 0;
const t = (name, fn) => { fn(); pass++; };

const FP = 'ab12cd34ef567890';
const LF = `---
name: pg-auditor
description: Audits migrations carefully. Use when auditing.
metadata:
  version: "1.0.0"
  price: "$29"
---

# Postgres Auditor
Always use CREATE INDEX CONCURRENTLY.
`;
const CRLF = LF.replace(/\n/g, '\r\n');
const INLINE_META = `---
name: pg-auditor
description: Audits migrations carefully. Use when auditing.
metadata: { version: "1.0.0" }
---

# Body
Text.
`;

t('exactly two --- markers after fingerprinting (no duplicate frontmatter) — LF and CRLF', () => {
  for (const src of [LF, CRLF]) {
    const emb = embedFingerprint(src, FP);
    assert.equal((emb.match(/^---/gm) || []).length, 2, 'a fingerprinted file has one frontmatter block');
  }
});

t('the visible license lives UNDER metadata (spec-legal), not at top level', () => {
  const emb = embedFingerprint(LF, FP);
  assert.match(emb, /^\s+allodic-license: ab12cd34ef567890$/m, 'nested field present');
  assert.doesNotMatch(emb, /^x-allodic-license:/m, 'no top-level field');
});

t('a fingerprinted SKILL.md still validates as agent-skills/v1', () => {
  const emb = embedFingerprint(LF, FP);
  const c = checkCompliance({ 'SKILL.md': Buffer.from(emb) }, { dirName: 'pg-auditor', engine: 'js' });
  assert.equal(c.spec.ok, true, JSON.stringify(c.spec.errors));
});

t('CRLF file: fingerprinted copy stays compliant (normalized) and keeps CRLF', () => {
  const emb = embedFingerprint(CRLF, FP);
  assert.ok(emb.includes('\r\n'), 'CRLF preserved in delivered file');
  const c = checkCompliance({ 'SKILL.md': Buffer.from(emb.replace(/\r\n/g, '\n')) }, { dirName: 'pg-auditor', engine: 'js' });
  assert.equal(c.spec.ok, true, JSON.stringify(c.spec.errors));
});

t('round-trip: strip∘embed is EXACT for LF, CRLF, and no-frontmatter', () => {
  const NOFM = '# Body only\nContent.\n';
  for (const [label, src] of [['LF', LF], ['CRLF', CRLF], ['nofm', NOFM]]) {
    const round = stripFingerprint(embedFingerprint(src, FP));
    assert.equal(round, src, `strip∘embed must be identity for ${label}`);
  }
});

t('inline metadata mapping: normalized to block form, license nested, stays compliant, strips clean', () => {
  const emb = embedFingerprint(INLINE_META, FP);
  assert.match(emb, /^\s+allodic-license: ab12cd34ef567890$/m);
  assert.match(emb, /^\s+version: "1\.0\.0"$/m, 'pre-existing inline key preserved as block key');
  const c = checkCompliance({ 'SKILL.md': Buffer.from(emb) }, { dirName: 'pg-auditor', engine: 'js' });
  assert.equal(c.spec.ok, true, JSON.stringify(c.spec.errors));
  // Strip removes the license; the (normalized) rest carries no allodic marks.
  assert.doesNotMatch(stripFingerprint(emb), /allodic-license/);
});

t('extract reads current nested field and legacy top-level field', () => {
  assert.equal(extractFingerprint(embedFingerprint(LF, FP)).frontmatter, FP);
  const legacy = `---\nname: x\nx-allodic-license: ${FP}\n---\n# b\n`;
  assert.equal(extractFingerprint(legacy).frontmatter, FP, 'old leaked copies still trace');
});

t('covert channel survives frontmatter removal (CRLF too)', () => {
  const emb = embedFingerprint(CRLF, FP);
  const noFm = emb.replace(/^---[\s\S]*?---\r\n/, ''); // strip whole frontmatter
  assert.equal(extractFingerprint(noFm).covert, FP);
});

console.log(`fingerprint-compliance.test.js: ${pass} passed`);
