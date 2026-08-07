// Agent Skills spec compliance — the reviewer's exact failing cases, the
// spec/allodic separation, and a parity harness that runs every case through
// BOTH the JS port and the official reference validator (when installed),
// comparing error strings verbatim. Proof over assertion.
import assert from 'node:assert';
import { parseFrontmatter, validateSpec, validateSpecOfficial, checkCompliance } from '../src/index.js';

const md = (fm, body = 'Do the thing.') => `---\n${fm}\n---\n\n${body}\n`;
const files = (fm, body) => ({ 'SKILL.md': md(fm, body) });
let pass = 0;
const t = (name, fn) => { fn(); pass++; };

// ---- reviewer's cases: previously reported "compliant" ----

t('SPEC: consecutive hyphens (bad--name) rejected', () => {
  const errs = validateSpec(parseFrontmatter(md('name: bad--name\ndescription: x')).meta, 'bad--name');
  assert.ok(errs.some((e) => e.includes('consecutive hyphens')), errs.join('; '));
});

t('SPEC: trailing hyphen (bad-) rejected', () => {
  const errs = validateSpec(parseFrontmatter(md('name: bad-\ndescription: x')).meta, 'bad-');
  assert.ok(errs.some((e) => e.includes('start or end with a hyphen')), errs.join('; '));
});

t('SPEC: directory mismatch rejected', () => {
  const errs = validateSpec(parseFrontmatter(md('name: my-skill\ndescription: x')).meta, 'other-dir');
  assert.ok(errs.some((e) => e.includes("must match skill name")), errs.join('; '));
});

t('SPEC: top-level version/price are unexpected fields (spec violation, not spec requirement)', () => {
  const errs = validateSpec(parseFrontmatter(md('name: a\ndescription: x\nversion: "1.0"\nprice: "$9"')).meta, 'a');
  assert.ok(errs.some((e) => e.startsWith('Unexpected fields in frontmatter: price, version')), errs.join('; '));
});

t('SPEC: version is NOT required by the spec', () => {
  const errs = validateSpec(parseFrontmatter(md('name: a\ndescription: x')).meta, 'a');
  assert.deepEqual(errs, []);
});

t('SPEC: compatibility is a free-form string (≤500), not an agent list', () => {
  const ok = validateSpec(parseFrontmatter(md('name: a\ndescription: x\ncompatibility: Needs network access and git ≥2.30')).meta, 'a');
  assert.deepEqual(ok, []);
  const long = validateSpec(parseFrontmatter(md(`name: a\ndescription: x\ncompatibility: ${'y'.repeat(501)}`)).meta, 'a');
  assert.ok(long.some((e) => e.includes('500 character limit')), long.join('; '));
});

t('SPEC: real YAML parsing — flow/nested metadata, quoted strings, not a line matcher', () => {
  const { meta } = parseFrontmatter(md('name: a\ndescription: "colon: inside quotes"\nmetadata:\n  version: "2.0"\n  author: razvan'));
  assert.equal(meta.description, 'colon: inside quotes');
  assert.equal(meta.metadata.version, '2.0');
});

t('SPEC: uppercase, >64 chars, invalid chars, missing description all rejected', () => {
  assert.ok(validateSpec(parseFrontmatter(md('name: BadName\ndescription: x')).meta, null).some((e) => e.includes('lowercase')));
  assert.ok(validateSpec(parseFrontmatter(md(`name: ${'a'.repeat(65)}\ndescription: x`)).meta, null).some((e) => e.includes('64 character limit')));
  assert.ok(validateSpec(parseFrontmatter(md('name: "bad name!"\ndescription: x')).meta, null).some((e) => e.includes('invalid characters')));
  assert.ok(validateSpec(parseFrontmatter(md('name: a')).meta, null).some((e) => e.includes('Missing required field in frontmatter: description')));
});

t('SPEC: unclosed frontmatter and non-mapping rejected at parse', () => {
  assert.throws(() => parseFrontmatter('---\nname: a\n'), /not properly closed/);
  assert.throws(() => parseFrontmatter('no frontmatter'), /must start with YAML frontmatter/);
});

// ---- separation of concepts ----

t('GATE: spec-valid skill without metadata.version fails ALLODIC requirements, not the spec', () => {
  const r = checkCompliance(files('name: a\ndescription: A useful skill for testing gates.'), { dirName: 'a', engine: 'js' });
  assert.equal(r.spec.ok, true, 'spec section must pass');
  assert.equal(r.allodic.ok, false, 'allodic section must fail');
  assert.ok(r.allodic.errors.some((e) => e.id === 'metadata-version'));
  assert.match(r.allodic.errors.find((e) => e.id === 'metadata-version').msg, /not part of the open standard/);
  assert.equal(r.status, 'non-compliant');
});

t('GATE: top-level price gets a targeted migration message', () => {
  const r = checkCompliance(files('name: a\ndescription: A useful skill for testing gates.\nprice: "$29"'), { dirName: 'a', engine: 'js' });
  assert.equal(r.spec.ok, false, 'unexpected field is a spec error');
  assert.ok(r.allodic.errors.some((e) => e.id === 'migrate-price' && /metadata:/.test(e.msg)));
});

t('GATE: fully valid skill with metadata extensions passes both sections (canary warning only)', () => {
  const r = checkCompliance(files('name: a\ndescription: Audits things carefully. Use when auditing.\nmetadata:\n  version: "1.0.0"\n  price: "$29"'), { dirName: 'a', engine: 'js' });
  assert.equal(r.spec.ok, true, JSON.stringify(r.spec.errors));
  assert.equal(r.allodic.ok, true, JSON.stringify(r.allodic.errors));
  // Paid + no canary slots -> warned (not blocked): leaks would be untraceable after laundering.
  assert.equal(r.status, 'compliant-with-warnings');
  assert.deepEqual(r.warnings.map((w) => w.id), ['canary-none']);
});

// ---- parity: JS port vs the official reference validator ----

const parityCases = [
  ['bad--name', 'name: bad--name\ndescription: x'],
  ['bad-', 'name: bad-\ndescription: x'],
  ['-bad', 'name: -bad\ndescription: x'],
  ['dirmatch', 'name: other-name\ndescription: x'],
  ['upper', 'name: BadName\ndescription: x'],
  ['longname', `name: ${'a'.repeat(65)}\ndescription: x`],
  ['badchars', 'name: "bad name!"\ndescription: x'],
  ['noname', 'description: x'],
  ['nodesc', 'name: nodesc'],
  ['extras', 'name: extras\ndescription: x\nversion: "1.0"\nprice: "$9"\ncustom: y'],
  ['longdesc', `name: longdesc\ndescription: ${'d'.repeat(1025)}`],
  ['longcompat', `name: longcompat\ndescription: x\ncompatibility: ${'c'.repeat(501)}`],
  ['good', 'name: good\ndescription: A perfectly good skill. Use for tests.\nlicense: MIT\ncompatibility: Needs git\nmetadata:\n  version: "1.0"\n  price: "$29"'],
  ['unicode', 'name: café-skill\ndescription: x'],
];

const official = validateSpecOfficial({ 'SKILL.md': md('name: probe\ndescription: x') }, 'probe');
if (!official) {
  console.log('~ parity: official skills-ref not installed — JS-port-only run (parity enforced in CI/Docker)');
} else {
  for (const [dir, fm] of parityCases) {
    t(`PARITY[${dir}]: JS port matches official validator verbatim`, () => {
      const ours = validateSpec(parseFrontmatter(md(fm)).meta, dir).sort();
      const theirs = validateSpecOfficial({ 'SKILL.md': md(fm) }, dir).errors.sort();
      assert.deepEqual(ours, theirs, `divergence on ${dir}`);
    });
  }
}

console.log(`spec.test.js: ${pass} passed`);
