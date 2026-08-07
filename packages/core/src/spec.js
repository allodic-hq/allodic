// allodic core — Agent Skills specification compliance.
//
// Two engines, one contract:
//   1. `validateSpecOfficial` shells out to the official reference validator
//      (`agentskills` / `skills-ref`, pip install skills-ref) when installed.
//      This is the authoritative check, preferred whenever available.
//   2. `parseFrontmatter` + `validateSpec` are a line-by-line port of
//      skills-ref 0.1.1 (agentskills/agentskills, skills_ref/{parser,validator}.py)
//      for environments without Python. Error strings are kept IDENTICAL to
//      the reference implementation so the parity test can compare verbatim.
//
// This module checks the OPEN STANDARD only. Allodic's own release
// requirements (metadata.version, metadata.price, …) live in compliance.js
// and are reported separately — they are extensions, not part of the spec.
import { parse as parseYaml } from 'yaml';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

export const MAX_SKILL_NAME_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 1024;
export const MAX_COMPATIBILITY_LENGTH = 500;

// Allowed frontmatter fields per Agent Skills Spec (skills-ref ALLOWED_FIELDS)
export const SPEC_ALLOWED_FIELDS = new Set([
  'name', 'description', 'license', 'allowed-tools', 'metadata', 'compatibility',
]);

/**
 * Parse YAML frontmatter from SKILL.md content. Port of skills_ref.parser.
 * Returns { meta, body }. Throws Error on parse failure (message matches
 * the reference implementation's ParseError text).
 */
export function parseFrontmatter(content) {
  if (!content.startsWith('---')) {
    throw new Error('SKILL.md must start with YAML frontmatter (---)');
  }
  // Python: content.split("---", 2) — at most 2 splits, remainder intact.
  const parts = splitN(content, '---', 2);
  if (parts.length < 3) {
    throw new Error('SKILL.md frontmatter not properly closed with ---');
  }
  const body = parts[2].trim();
  let meta;
  try {
    // failsafe schema: every scalar is a string — matching strictyaml's
    // string-typed model used by the reference implementation.
    meta = parseYaml(parts[1], { schema: 'failsafe', uniqueKeys: true }) ?? {};
  } catch (e) {
    throw new Error(`Invalid YAML in frontmatter: ${e.message}`);
  }
  if (typeof meta !== 'object' || Array.isArray(meta)) {
    throw new Error('SKILL.md frontmatter must be a YAML mapping');
  }
  // Reference impl coerces the metadata mapping to str -> str.
  if (meta.metadata && typeof meta.metadata === 'object' && !Array.isArray(meta.metadata)) {
    meta.metadata = Object.fromEntries(Object.entries(meta.metadata)
      .map(([k, v]) => [String(k), typeof v === 'object' ? JSON.stringify(v) : String(v)]));
  }
  return { meta, body };
}

function splitN(s, sep, n) {
  const parts = [];
  let rest = s;
  for (let i = 0; i < n; i++) {
    const at = rest.indexOf(sep);
    if (at === -1) break;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at + sep.length);
  }
  parts.push(rest);
  return parts;
}

/** Validate parsed frontmatter against the spec. Port of skills_ref.validator.
 *  Returns a list of error strings (empty = spec-compliant). */
export function validateSpec(meta, dirName = null) {
  const errors = [];

  const extra = Object.keys(meta).filter((k) => !SPEC_ALLOWED_FIELDS.has(k)).sort();
  if (extra.length) {
    // Message shape matches the reference implementation's Python list repr.
    const allowed = [...SPEC_ALLOWED_FIELDS].sort().map((f) => `'${f}'`).join(', ');
    errors.push(`Unexpected fields in frontmatter: ${extra.join(', ')}. Only [${allowed}] are allowed.`);
  }

  if (!('name' in meta)) errors.push('Missing required field in frontmatter: name');
  else errors.push(...validateName(meta.name, dirName));

  if (!('description' in meta)) errors.push('Missing required field in frontmatter: description');
  else errors.push(...validateDescription(meta.description));

  if ('compatibility' in meta) errors.push(...validateCompatibility(meta.compatibility));

  return errors;
}

/** The spec's skill-name rules, reusable at scaffold time (`allodic init`)
 *  so a name that would fail publish is refused BEFORE anything is written. */
export function validateSkillName(name, dirName = null) { return validateName(name, dirName); }

function validateName(name, dirName) {
  const errors = [];
  if (!name || typeof name !== 'string' || !name.trim()) {
    errors.push("Field 'name' must be a non-empty string");
    return errors;
  }
  name = name.trim().normalize('NFKC');
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    errors.push(`Skill name '${name}' exceeds ${MAX_SKILL_NAME_LENGTH} character limit (${name.length} chars)`);
  }
  if (name !== name.toLowerCase()) errors.push(`Skill name '${name}' must be lowercase`);
  if (name.startsWith('-') || name.endsWith('-')) errors.push('Skill name cannot start or end with a hyphen');
  if (name.includes('--')) errors.push('Skill name cannot contain consecutive hyphens');
  if (!/^[\p{L}\p{N}-]*$/u.test(name)) {
    errors.push(`Skill name '${name}' contains invalid characters. Only letters, digits, and hyphens are allowed.`);
  }
  if (dirName) {
    const normalizedDir = dirName.normalize('NFKC');
    if (normalizedDir !== name) {
      errors.push(`Directory name '${dirName}' must match skill name '${name}'`);
    }
  }
  return errors;
}

function validateDescription(description) {
  const errors = [];
  if (!description || typeof description !== 'string' || !description.trim()) {
    errors.push("Field 'description' must be a non-empty string");
    return errors;
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`Description exceeds ${MAX_DESCRIPTION_LENGTH} character limit (${description.length} chars)`);
  }
  return errors;
}

function validateCompatibility(compatibility) {
  const errors = [];
  if (typeof compatibility !== 'string') {
    errors.push("Field 'compatibility' must be a string");
    return errors;
  }
  if (compatibility.length > MAX_COMPATIBILITY_LENGTH) {
    errors.push(`Compatibility exceeds ${MAX_COMPATIBILITY_LENGTH} character limit (${compatibility.length} chars)`);
  }
  return errors;
}

/**
 * Run the OFFICIAL reference validator, if installed (pip install skills-ref).
 * Writes the files to a temp dir named `dirName` so the directory-match rule
 * is exercised. Returns { engine, errors } or null when the binary is absent.
 */
export function validateSpecOfficial(files, dirName) {
  const bin = findOfficialBinary();
  if (!bin) return null;
  const base = mkdtempSync(join(tmpdir(), 'allodic-spec-'));
  try {
    const skillDir = join(base, dirName || 'skill');
    for (const [rel, content] of Object.entries(files)) {
      const dest = join(skillDir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content);
    }
    const r = spawnSync(bin.cmd, [...bin.args, 'validate', skillDir], { encoding: 'utf8', timeout: 20000 });
    if (r.error || r.status === null) return null; // treat runtime failure as unavailable
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    const errors = [...out.matchAll(/^\s+-\s+(.+)$/gm)].map((m) => m[1].trim());
    if (r.status !== 0 && errors.length === 0) errors.push(out.trim() || 'official validator reported failure');
    return { engine: `skills-ref (official reference validator, via ${bin.name})`, errors };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

let _officialBinary; // memoized per process
function findOfficialBinary() {
  if (_officialBinary !== undefined) return _officialBinary;
  const candidates = [
    { name: 'agentskills', cmd: 'agentskills', args: [] },
    { name: 'skills-ref', cmd: 'skills-ref', args: [] },
    { name: 'python3 -m skills_ref.cli', cmd: 'python3', args: ['-m', 'skills_ref.cli'] },
  ];
  for (const c of candidates) {
    const r = spawnSync(c.cmd, [...c.args, '--help'], { encoding: 'utf8', timeout: 10000 });
    if (!r.error && r.status === 0 && /validate/i.test(r.stdout ?? '')) { _officialBinary = c; return c; }
  }
  _officialBinary = null;
  return null;
}
