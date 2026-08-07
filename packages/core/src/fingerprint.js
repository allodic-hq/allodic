// allodic core — per-buyer fingerprinting of SKILL.md content.
//
// Two layers, mirroring what marketplace-grade fingerprinting does:
//   1. VISIBLE : a `metadata.allodic-license` field (nested under the spec's extension point, so it stays agent-skills/v1 compliant).
//   2. COVERT  : the same ID encoded in zero-width characters woven into the body,
//                so stripping the frontmatter does not strip the trace.
//
// The ID itself is an HMAC of (orderId, secret), so possession of a leaked file
// never reveals buyer identity — only the creator's server can map ID -> order.
import { createHmac } from 'node:crypto';

const ZW0 = '\u200b'; // zero-width space  -> bit 0
const ZW1 = '\u200c'; // zero-width non-joiner -> bit 1
const MARK = '\u2060'; // word-joiner: start/end sentinel

/** Derive the public fingerprint ID from an order. 16 hex chars is plenty. */
export function deriveFingerprint(orderId, secret) {
  return createHmac('sha256', secret).update(String(orderId)).digest('hex').slice(0, 16);
}

function toZeroWidth(hex) {
  let bits = '';
  for (const ch of hex) bits += parseInt(ch, 16).toString(2).padStart(4, '0');
  let out = MARK;
  for (const b of bits) out += b === '1' ? ZW1 : ZW0;
  return out + MARK;
}

function fromZeroWidth(payload) {
  let bits = '';
  for (const ch of payload) {
    if (ch === ZW1) bits += '1';
    else if (ch === ZW0) bits += '0';
  }
  if (bits.length % 4 !== 0) return null;
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

const LICENSE_KEY = 'allodic-license'; // lives UNDER `metadata:` — spec-legal (P0.4)

/**
 * Embed a fingerprint into SKILL.md content.
 * - VISIBLE: `metadata.allodic-license` — nested under the spec's own
 *   extension field, so a fingerprinted copy still validates as
 *   agent-skills/v1 (a top-level field would not).
 * - COVERT: zero-width payload woven into the first body line.
 * Newlines (LF or CRLF) are detected and preserved, so a Windows SKILL.md
 * is not mistaken for having no frontmatter (which previously prepended a
 * second frontmatter block — the four-`---` bug).
 */
export function embedFingerprint(markdown, fingerprintId) {
  const covert = toZeroWidth(fingerprintId);
  const nl = detectNewline(markdown);
  // Normalize to LF for structural editing; restore the original newline at the end.
  const lf = markdown.replace(/\r\n/g, '\n');
  let out;

  const fm = matchFrontmatter(lf);
  if (fm) {
    const body = lf.slice(fm.end);
    const inner = upsertMetadataLicense(fm.inner, fingerprintId);
    out = `---\n${inner}\n---${body}`;
  } else {
    // No frontmatter: synthesize a minimal, spec-shaped block.
    out = `---\nmetadata:\n  ${LICENSE_KEY}: ${fingerprintId}\n---\n${lf}`;
  }

  // Covert payload after the first non-empty body line.
  const fm2 = matchFrontmatter(out);
  const bodyStart = fm2 ? fm2.end : 0;
  const head = out.slice(0, bodyStart);
  const lines = out.slice(bodyStart).split('\n');
  const idx = lines.findIndex((l) => l.trim().length > 0);
  if (idx !== -1) lines[idx] = lines[idx] + covert;
  out = head + lines.join('\n');

  return nl === '\r\n' ? out.replace(/\n/g, '\r\n') : out;
}

function detectNewline(s) { return /\r\n/.test(s) ? '\r\n' : '\n'; }

/** Locate the leading YAML frontmatter block (LF-normalized input). */
function matchFrontmatter(lf) {
  const m = /^---\n([\s\S]*?)\n---/.exec(lf);
  if (!m) return null;
  return { inner: m[1], end: m[0].length }; // end points at the char after closing ---
}

/** Insert or replace `metadata.allodic-license` inside a frontmatter body,
 *  creating the `metadata:` block if absent. String-level but YAML-shaped:
 *  keeps other keys and their formatting untouched. */
function upsertMetadataLicense(inner, id) {
  // Drop any legacy top-level field and any prior nested license line.
  let lines = inner.split('\n').filter((l) =>
    !/^x-allodic-license:/.test(l) && !new RegExp(`^\\s+${LICENSE_KEY}:`).test(l));
  const metaIdx = lines.findIndex((l) => /^metadata:\s*$/.test(l) || /^metadata:\s*\{/.test(l));
  if (metaIdx === -1) {
    lines.push('metadata:', `  ${LICENSE_KEY}: ${id}`);
  } else if (/^metadata:\s*\{/.test(lines[metaIdx])) {
    // Expand an inline mapping to block form, then append the license as a
    // normal nested line. One representation means one strip path — and
    // block form is what stripFingerprint's line-anchored removal expects.
    const inlineBody = lines[metaIdx].replace(/^metadata:\s*\{/, '').replace(/\}\s*$/, '');
    const pairs = inlineBody.split(',').map((s) => s.trim()).filter(Boolean);
    const block = ['metadata:', ...pairs.map((p) => `  ${p}`), `  ${LICENSE_KEY}: ${id}`];
    lines.splice(metaIdx, 1, ...block);
  } else {
    lines.splice(metaIdx + 1, 0, `  ${LICENSE_KEY}: ${id}`);
  }
  return lines.join('\n');
}

/** Extract fingerprint(s) from possibly-redistributed content. Returns {frontmatter, covert}.
 *  Reads the current nested `metadata.allodic-license` and the legacy
 *  top-level `x-allodic-license` (so copies fingerprinted by older servers
 *  still trace). Newline-agnostic. */
export function extractFingerprint(markdown) {
  const nested = markdown.match(/^\s+allodic-license:\s*([0-9a-f]{8,64})\s*\r?$/m);
  const legacy = markdown.match(/^x-allodic-license:\s*([0-9a-f]{8,64})\s*\r?$/m);
  const frontmatter = (nested ?? legacy) ? (nested ?? legacy)[1] : null;

  let covert = null;
  const sentinel = markdown.split(MARK);
  if (sentinel.length >= 3) {
    covert = fromZeroWidth(sentinel[1]);
  }
  return { frontmatter, covert };
}

/** Strip all allodic marks (used in tests and for creators inspecting bundles).
 *  Inverse of embedFingerprint for both LF and CRLF, nested and legacy. */
export function stripFingerprint(markdown) {
  const nl = detectNewline(markdown);
  let lf = markdown.replace(/\r\n/g, '\n')
    .replace(/^\s+allodic-license:.*\n/m, '')  // nested (current)
    .replace(/^x-allodic-license:.*\n/m, '')   // legacy top-level
    .replaceAll(ZW0, '')
    .replaceAll(ZW1, '')
    .replaceAll(MARK, '');
  // If we synthesized a metadata block solely to hold the license, it is now
  // an empty `metadata:` line inside otherwise-empty frontmatter; remove the
  // shell so strip∘embed is an exact inverse for frontmatter-less files.
  lf = lf.replace(/^---\nmetadata:\n---\n/, '').replace(/^---\n---\n/, '');
  return nl === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf;
}
