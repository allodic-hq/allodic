// allodic core — the publish gate, in two clearly separated parts:
//
//   1. SPEC   : Agent Skills specification compliance (agent-skills/v1).
//               Checked by the official reference validator (skills-ref) when
//               installed, else by our exact JS port (spec.js). We claim
//               nothing here the spec authors' own validator wouldn't.
//   2. ALLODIC: allodic release requirements — metadata.version (entitled
//               updates need it) and a parseable metadata.price. These are
//               OUR requirements layered via the spec's `metadata` extension
//               mechanism. They are never described as part of the standard.
//
// Errors in either part block publish; warnings surface on the listing.
import { parseFrontmatter, validateSpec, validateSpecOfficial } from './spec.js';
import { parsePrice } from './price.js';
import { parseSlots, slotCapacityBits } from './canary.js';
import { validSemver } from './semver.js';

// Fields allodic used to accept at top level (pre-0.1.0-alpha) that the spec
// rejects. Detected to give authors a precise migration message.
const MIGRATE_TO_METADATA = ['version', 'price', 'price_cents', 'author', 'payout_splits', 'royalties', 'requires-mcp', 'permissions', 'slug'];

export function checkCompliance(files /* {path: Buffer|string} */, { dirName = null, engine = 'auto' } = {}) {
  const allodic = [];
  const add = (id, level, ok, msg) => allodic.push({ id, level, ok, msg });

  const raw = files['SKILL.md'];
  if (!raw) {
    return summarize({ engine: 'n/a', errors: ['Missing required file: SKILL.md'] }, allodic);
  }
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);

  // ---- part 1: the open standard ----
  let spec;
  let meta = { metadata: {} };
  let body = '';
  let parsed = null;
  try {
    parsed = parseFrontmatter(text);
    meta = { ...parsed.meta, metadata: parsed.meta.metadata ?? {} };
    body = parsed.body;
  } catch (e) {
    spec = { engine: 'allodic-js (port of skills-ref 0.1.1)', errors: [e.message] };
  }
  if (!spec) {
    const official = engine !== 'js' ? validateSpecOfficial(files, dirName ?? meta.name ?? 'skill') : null;
    spec = official ?? { engine: 'allodic-js (port of skills-ref 0.1.1)', errors: validateSpec(parsed.meta, dirName) };
  }

  // ---- part 2: allodic release requirements (extensions, not the standard) ----
  for (const f of MIGRATE_TO_METADATA) {
    if (f in meta && f !== 'metadata') {
      add(`migrate-${f}`, 'error', false,
        `top-level \`${f}\` is not part of agent-skills/v1 — move it under \`metadata:\`, the spec's extension mechanism`);
    }
  }
  const version = meta.metadata.version;
  add('metadata-version', 'error', !!version,
    '`metadata.version` is required to sell on allodic — entitled updates need it (allodic requirement, not part of the open standard)');
  if (version) {
    add('version-format', 'error', validSemver(version),
      'semantic versioning (e.g. 1.4.0) recommended for `metadata.version`');
  }
  try { parsePrice(meta); add('price-valid', 'error', true, ''); }
  catch (e) { add('price-valid', 'error', false, e.message); }

  // Semantic canary capacity: with B bits, only 2^B copies are
  // distinguishable — beyond that, trace collisions are guaranteed and
  // attribution degrades to "inconclusive". 24+ bits recommended for sale.
  let priceCents = 0;
  try { priceCents = parsePrice(meta); } catch { /* reported above */ }
  if (priceCents > 0) {
    const slots = parseSlots(text);
    const bits = slotCapacityBits(slots);
    if (slots.length === 0) {
      add('canary-none', 'warn', false,
        'no {{~ … | … }} canary slots — leaked copies cannot be traced once zero-width marks are laundered away (allodic feature, optional)');
    } else {
      add('canary-capacity', 'warn', bits >= 24,
        `canary capacity is ${bits} bits (${2 ** bits} distinguishable copies) — below ~24 bits, trace collisions become likely as sales grow; add slots or options`);
    }
  }

  add('body-present', 'error', body.length > 0, 'SKILL.md needs instruction content after the frontmatter');
  add('body-size', 'warn', Buffer.byteLength(text) <= 64 * 1024,
    "skills over 64KB may exceed some runtimes' context budgets — consider splitting");
  if (meta.description) {
    add('description-substantive', 'warn', String(meta.description).trim().length >= 20,
      'a one-clause description helps agents trigger correctly');
  }
  for (const m of body.matchAll(/(?:^|\s)((?:scripts|assets|evals|templates|references)\/[\w./-]+)/g)) {
    add(`ref-${m[1]}`, 'warn', !!files[m[1]], `referenced file not in bundle: ${m[1]}`);
  }

  return summarize(spec, allodic);
}

function summarize(spec, allodicChecks) {
  const specOk = spec.errors.length === 0;
  const allodicErrors = allodicChecks.filter((c) => c.level === 'error' && !c.ok);
  const allodicWarnings = allodicChecks.filter((c) => c.level === 'warn' && !c.ok);
  // Aggregate view for renderers: spec errors carry the 'spec' id.
  const errors = [
    ...spec.errors.map((msg) => ({ id: 'spec', msg })),
    ...allodicErrors,
  ];
  return {
    standard: 'agent-skills/v1',
    status: errors.length ? 'non-compliant' : allodicWarnings.length ? 'compliant-with-warnings' : 'compliant',
    spec: { engine: spec.engine, ok: specOk, errors: spec.errors },
    allodic: {
      label: 'allodic release requirements (extensions via `metadata`, not part of the open standard)',
      ok: allodicErrors.length === 0,
      passed: allodicChecks.filter((c) => c.ok).length,
      total: allodicChecks.length,
      errors: allodicErrors,
      warnings: allodicWarnings,
    },
    passed: (specOk ? 1 : 0) + allodicChecks.filter((c) => c.ok).length,
    total: 1 + allodicChecks.length,
    errors,
    warnings: allodicWarnings,
  };
}
