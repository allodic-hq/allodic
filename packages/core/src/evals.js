// allodic core — verified evals (v0.2).
//
// A skill directory may contain evals/tasks.json:
//   [{ "id": "detects-unsafe-index",
//      "prompt": "Review this migration: CREATE INDEX idx ON orders(email);",
//      "mustMention": ["CONCURRENTLY"],
//      "mustNotMention": ["looks safe"] }]
//
// Every runner executes THE CANDIDATE, explicitly:
//   - `claude` : materializes the candidate into an ephemeral workspace
//                (fresh HOME + cwd, .claude/skills/<name>/) so it is the ONLY
//                skill visible — no stale installed copy can answer instead —
//                then shells out to `claude -p` (creator's subscription pays)
//   - `exec`   : any command template with {prompt}; the candidate's
//                instructions are injected inline into the prompt
//   - `mock`   : deterministic, for CI and this repo's tests
// runEvals refuses to run without the candidate files: a benchmark that might
// grade a general model answer is not evidence about the skill being sold.
//
// Grading is deterministic transcript checking (required/prohibited content).
// That is a reproducible FLOOR — any holder can re-run it bit-for-bit — not a
// general quality judgment, and it is labelled as such everywhere it appears.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { signManifest, verifyManifest, sha256 } from './sign.js';

export function gradeTranscript(task, transcript) {
  const t = transcript.toLowerCase();
  const missing = (task.mustMention ?? []).filter((m) => !t.includes(m.toLowerCase()));
  const forbidden = (task.mustNotMention ?? []).filter((m) => t.includes(m.toLowerCase()));
  return { pass: missing.length === 0 && forbidden.length === 0, missing, forbidden };
}

export function makeRunner(kind, opts = {}) {
  const timeout = opts.timeoutMs ?? 180000;
  if (kind === 'mock') {
    const fn = (prompt, skill) => opts.respond?.(prompt, skill) ?? '';
    fn.kind = 'mock';
    fn.isolation = 'mock (deterministic, no agent)';
    return fn;
  }
  if (kind === 'claude') {
    const fn = (prompt, _skill, session) => execFileSync('claude', ['-p', prompt], {
      encoding: 'utf8', timeout, cwd: session.cwd,
      // Fresh HOME: user-level ~/.claude/skills cannot shadow the candidate.
      env: { ...process.env, HOME: session.home },
    });
    fn.kind = 'claude';
    fn.needsWorkspace = true;
    fn.isolation = 'ephemeral workspace (fresh HOME + cwd); candidate is the only skill present';
    return fn;
  }
  if (kind === 'exec') {
    const fn = (prompt, skill) => {
      const injected = `You have the following skill installed. Follow its instructions when they apply.\n\n<skill name="${skill.name}">\n${skill.instructions}\n</skill>\n\nTask: ${prompt}`;
      return execFileSync(opts.cmd, opts.args.map((a) => a.replace('{prompt}', injected)), { encoding: 'utf8', timeout });
    };
    fn.kind = 'exec';
    fn.isolation = 'candidate instructions injected inline into the prompt';
    return fn;
  }
  throw new Error(`unknown runner: ${kind}`);
}

/** Materialize the candidate as the only skill in a throwaway workspace. */
function makeWorkspace(skillName, skillFiles) {
  const base = mkdtempSync(join(tmpdir(), 'allodic-eval-'));
  const home = join(base, 'home');
  const cwd = join(base, 'ws');
  const skillDir = join(cwd, '.claude', 'skills', skillName);
  mkdirSync(home, { recursive: true });
  for (const [rel, content] of Object.entries(skillFiles)) {
    const dest = join(skillDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
  return { base, home, cwd, skillDir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/**
 * Run all tasks; return a scorecard bound to the exact skill content hash,
 * so evals can't be recycled across versions.
 */
export function runEvals({ tasks, runner, agentLabel, skillName, skillFiles, skillContentHash }) {
  if (!skillName || !skillFiles || !skillFiles['SKILL.md']) {
    throw new Error('runEvals requires the candidate skill (skillName + skillFiles incl. SKILL.md) — a benchmark that does not execute the capability being sold is not evidence about it');
  }
  const skill = { name: skillName, files: skillFiles, instructions: String(skillFiles['SKILL.md']) };
  const session = runner.needsWorkspace ? makeWorkspace(skillName, skillFiles) : null;
  let results;
  try {
    results = tasks.map((task) => {
      const transcript = runner(task.prompt, skill, session);
      const grade = gradeTranscript(task, transcript);
      return { id: task.id, pass: grade.pass, missing: grade.missing, forbidden: grade.forbidden };
    });
  } finally {
    session?.cleanup();
  }
  return {
    format: 'allodic-evals/2',
    agent: agentLabel,
    runner: { kind: runner.kind ?? 'unknown', isolation: runner.isolation ?? 'unspecified', candidateExplicit: true },
    grading: 'deterministic transcript checks (required/prohibited content) — a reproducible floor, not a general quality judgment',
    skillContentHash,
    ranAt: new Date().toISOString(),
    passed: results.filter((r) => r.pass).length,
    total: results.length,
    results,
  };
}

export function signScorecard(scorecard, privateKeyPem) {
  return { scorecard, sig: signManifest(scorecard, privateKeyPem) };
}

/** Verify a signed scorecard AND that it matches this exact skill content. */
export function verifyScorecard(signed, publicKeyPem, expectedContentHash) {
  if (!verifyManifest(signed.scorecard, signed.sig, publicKeyPem)) {
    throw new Error('Eval scorecard signature invalid.');
  }
  if (expectedContentHash && signed.scorecard.skillContentHash !== expectedContentHash) {
    throw new Error('Eval scorecard is for a different version of this skill.');
  }
  return signed.scorecard;
}

/**
 * Content digest of a skill's file set.
 *
 * v1 framing (collision-proof): the digest is SHA-256 over a domain-separated,
 * canonical JSON array of {path, sha256(content)} entries, paths sorted.
 * JSON quoting/escaping frames every path unambiguously and the per-file hash
 * frames every content (a hash binds its input, length included), so no
 * concatenation of (path, content) pairs can collide structurally — unlike
 * the previous unframed `path‖content‖path‖content` byte string, where
 * {"a":"bc"} and {"ab":"c"} both hashed "abc".
 *
 * Deliberate property: the digest is derivable from the per-file hash MAP
 * alone (no raw content needed). The capability publishes that same map in
 * `files`, so verifiers can — and the verify chain does — recompute the
 * digest from it, binding digest ⇔ file map ⇔ delivered bytes even when
 * canary-varied files make full content reconstruction impossible.
 */
export function skillContentHash(files /* {path: Buffer|string} */) {
  const hashes = {};
  for (const p of Object.keys(files)) hashes[p] = sha256(Buffer.from(files[p]));
  return skillDigestFromHashes(hashes);
}

/** Recompute the digest from a per-file hash map (capability `files` shape). */
export function skillDigestFromHashes(hashes /* {path: sha256hex} */) {
  const entries = Object.keys(hashes).sort().map((path) => ({ path, sha256: hashes[path] }));
  return sha256(Buffer.from('allodic-digest/1\n' + JSON.stringify(entries)));
}
