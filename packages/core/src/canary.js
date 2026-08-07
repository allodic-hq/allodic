// allodic core — canary-variant fingerprinting (v0.2).
//
// Zero-width fingerprints die the moment a pirate pipes the skill through an
// LLM ("rewrite this"). Canary variants encode the buyer at the MEANING level:
// the creator marks slots offering semantically equivalent phrasings, and each
// buyer's copy commits to one option per slot, chosen by the bits of their
// fingerprint. Laundering that preserves the skill's semantics tends to
// preserve which alternative was chosen — the choice IS the watermark.
//
// Syntax in SKILL.md (creator writes, buyers never see):
//   {{~ hot tables | high-traffic tables }}
//   {{~ Before merging | Prior to merging | Before you merge }}
//
// With S slots of >=2 options each, capacity is sum(log2(options)) bits.
// 16 slots of 2 options = 16 bits = 65k distinguishable buyers per version;
// matching is probabilistic and reported with a confidence score.

const SLOT_RE = /\{\{~\s*([^}]+?)\s*\}\}/g;

/** Parse variant slots out of source content. Returns [{options:[...]}, ...]. */
export function parseSlots(source) {
  const slots = [];
  for (const m of source.matchAll(SLOT_RE)) {
    const options = m[1].split('|').map((s) => s.trim()).filter(Boolean);
    if (options.length >= 2) slots.push({ options });
  }
  return slots;
}

/** Total encodable bits given the slots present. */
export function slotCapacityBits(slots) {
  return slots.reduce((n, s) => n + Math.floor(Math.log2(s.options.length)), 0);
}

function fingerprintBits(fingerprintHex, nBits) {
  let bits = '';
  for (const ch of fingerprintHex) bits += parseInt(ch, 16).toString(2).padStart(4, '0');
  while (bits.length < nBits) bits += bits; // repeat if fingerprint shorter than capacity
  return bits.slice(0, nBits);
}

/**
 * Render a buyer copy: every slot collapses to the option selected by the
 * buyer's fingerprint bits. Returns { content, choices } where choices records
 * the selection for the manifest.
 */
export function renderCanaryCopy(source, fingerprintHex) {
  const slots = parseSlots(source);
  const bits = fingerprintBits(fingerprintHex, slotCapacityBits(slots));
  let cursor = 0;
  const choices = [];
  let slotIdx = 0;
  const content = source.replace(SLOT_RE, (_m, body) => {
    const options = body.split('|').map((s) => s.trim()).filter(Boolean);
    const useBits = Math.floor(Math.log2(options.length));
    let pick = 0;
    if (useBits > 0) {
      pick = parseInt(bits.slice(cursor, cursor + useBits) || '0', 2) % options.length;
      cursor += useBits;
    }
    choices.push({ slot: slotIdx++, picked: pick, of: options.length });
    return options[pick];
  });
  return { content, choices };
}

/** Render the neutral/preview copy (always option 0) for free samples and diffing. */
export function renderNeutralCopy(source) {
  return source.replace(SLOT_RE, (_m, body) => body.split('|')[0].trim());
}

/**
 * Trace a suspect document against the creator's slot definitions.
 *
 * Returns EVIDENCE, not a winner. The semantic channel has finite capacity
 * (sum of floor(log2(options)) bits): with 7 binary slots there are only 128
 * possible choice vectors, so beyond ~a hundred buyers collisions are
 * mathematically guaranteed — and material well before that. Attribution is
 * therefore only claimed when exactly ONE order is consistent with every
 * observed slot; ties are reported as ties.
 *
 * Verdicts:
 *   'identified'            exactly one order matches all observed slots
 *   'inconclusive'          several orders match (collision), or only
 *                           partial matches exist — candidates listed
 *   'insufficient-evidence' too few slots survived to say anything
 *   'no-match'              nothing resembling a buyer copy
 *
 * Tolerant matching: case-insensitive, whitespace-collapsed — survives
 * reformatting; partial slot recovery still narrows the candidate set.
 */
export const MIN_OBSERVED_SLOTS = 3;

export function traceCanary(suspect, source, candidates /* [{orderId, fingerprintHex}] */) {
  const slots = parseSlots(source);
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ');
  const doc = norm(suspect);

  const observed = slots.map(({ options }) => {
    const found = options
      .map((opt, i) => ({ i, hit: doc.includes(norm(opt)) }))
      .filter((x) => x.hit);
    return found.length === 1 ? found[0].i : null; // ambiguous/absent -> unknown
  });

  const observedIdx = observed.map((o, i) => (o === null ? null : i)).filter((i) => i !== null);
  const capacityBits = slotCapacityBits(slots);
  const observedBits = observedIdx.reduce((n, i) => n + Math.floor(Math.log2(slots[i].options.length)), 0);

  const scored = candidates.map((c) => {
    const { choices } = renderCanaryCopy(source, c.fingerprintHex);
    let comparable = 0;
    let matches = 0;
    choices.forEach((ch, i) => {
      if (observed[i] === null) return;
      comparable++;
      if (observed[i] === ch.picked) matches++;
    });
    return { orderId: c.orderId, matches, comparable, confidence: comparable ? matches / comparable : 0 };
  }).sort((a, b) => b.confidence - a.confidence || b.comparable - a.comparable);

  // Orders whose copies are FULLY consistent with every surviving slot.
  const consistent = scored.filter((s) => s.comparable === observedIdx.length && s.comparable > 0 && s.matches === s.comparable);

  const stats = {
    slotsTotal: slots.length,
    slotsObserved: observedIdx.length,
    capacityBits,
    observedBits,
    orders: candidates.length,
    // How many orders a RANDOM document would be expected to fully match on
    // the observed bits — the honest ambiguity floor for this evidence.
    expectedRandomMatches: observedBits > 0 ? candidates.length / 2 ** observedBits : candidates.length,
  };

  let verdict;
  if (observedIdx.length === 0) verdict = 'no-match'; // nothing resembling this skill's slot phrasings
  else if (observedIdx.length < MIN_OBSERVED_SLOTS || observedBits === 0) verdict = 'insufficient-evidence';
  else if (consistent.length === 1) verdict = 'identified';
  else if (consistent.length > 1) verdict = 'inconclusive';
  else if (scored[0]?.confidence >= 0.8) verdict = 'inconclusive'; // strong partial: laundered copy or lookalike — never an accusation
  else verdict = 'no-match';

  return {
    verdict,
    match: verdict === 'identified' ? consistent[0] : null,
    consistent,
    ranked: scored,
    observedSlots: observed,
    stats,
  };
}

// ---------------------------------------------------------------------------
// Derivation commitment — provenance for canary-varied files.
//
// A buyer-side mechanical proof of the slot collapse would reveal slot
// POSITIONS to the buyer, and every buyer is a potential pirate: knowing
// which spans are watermark slots makes clean laundering trivial. So varied
// files get the strongest property compatible with tracing: at publish time
// the seller commits (salted, hiding) to the full slot structure inside the
// signed capability the buyer pins. The seller cannot later invent a
// different published→delivered mapping; in a dispute the commitment is
// opened and either reproduces the buyer's stripped copy exactly via the
// recorded selection, or convicts the seller. Unvaried files need none of
// this — they are hash-verified directly.
import { createHash, createHmac } from 'node:crypto';

const dsha = (s) => createHash('sha256').update(s).digest('hex');

/** Replace each slot with an indexed placeholder. */
export function templateize(source) {
  let i = 0;
  const slots = parseSlots(source);
  const template = source.replace(SLOT_RE, () => `{{slot:${i++}}}`);
  return { template, slots };
}

/**
 * Build the publish-time commitment. `secret` is a per-skill random value the
 * seller stores privately; per-option salts derive from it so options cannot
 * be dictionary-tested from the commitment alone.
 * Returns { commit, opening } — `commit` goes into the signed capability,
 * `opening` stays private until a dispute.
 */
export function buildDerivationCommitment(source, secret) {
  const { template, slots } = templateize(source);
  const salted = slots.map((s, i) => ({
    options: s.options,
    salts: s.options.map((_, j) => createHmac('sha256', secret).update(`${i}:${j}`).digest('hex')),
  }));
  const leaves = salted.map((s) => s.options.map((opt, j) => dsha(`${s.salts[j]}\x00${opt}`)));
  const commit = dsha(JSON.stringify({ v: 1, template: dsha(template), leaves }));
  return {
    commit,
    arity: slots.map((s) => s.options.length),
    opening: { template, slots: salted },
  };
}

/**
 * Audit a delivered copy against an opened commitment: recompute the commit
 * from the opening, then re-derive the buyer's content from template +
 * selection and compare with the (watermark-stripped) delivered file.
 * Returns { ok, reasons }.
 */
export function verifyDerivationOpening({ opening, commit, selection, strippedContent }) {
  const reasons = [];
  const leaves = opening.slots.map((s) => s.options.map((opt, j) => dsha(`${s.salts[j]}\x00${opt}`)));
  const recomputed = dsha(JSON.stringify({ v: 1, template: dsha(opening.template), leaves }));
  if (recomputed !== commit) reasons.push('opening does not match the published commitment');
  if (selection.length !== opening.slots.length) reasons.push(`selection has ${selection.length} entries for ${opening.slots.length} slots`);
  let derived = opening.template;
  opening.slots.forEach((s, i) => {
    const pick = s.options[selection[i]];
    if (pick === undefined) reasons.push(`selection[${i}]=${selection[i]} out of range`);
    derived = derived.replace(`{{slot:${i}}}`, pick ?? '');
  });
  if (derived !== strippedContent) reasons.push('derived content does not equal the delivered (stripped) copy');
  return { ok: reasons.length === 0, reasons };
}
