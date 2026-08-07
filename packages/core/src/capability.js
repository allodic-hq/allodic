// allodic core — the capability manifest (v0.3).
//
// The unit of commerce is not a file; it is a verifiable capability.
// Like an OCI image manifest, this document is what gets signed, displayed,
// and trusted — the files are just its content-addressed payload.
//
// Creators declare in SKILL.md frontmatter (all optional):
//   requires-mcp: postgres, filesystem
//   permissions: read, write
//   compatibility: claude-code, cursor, codex
//
// Everything else is derived: digest, eval evidence, scan results, provenance.
import { sha256 } from './sign.js';
import { skillDigestFromHashes } from './evals.js';
import { buildTerms } from './price.js';

const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);

/**
 * Assemble the capability manifest for a skill at publish time.
 * `scorecards` is an array of (unsigned) eval scorecards, one per agent runner.
 * `scan` is the output of scanSkill().
 */
export function buildCapabilityManifest({ meta, files, scorecards = [], scan = null, creator, derivation = null }) {
  // One per-file hash map serves both roles: it is published as `files` and
  // the digest is derived FROM it — the invariant digest ===
  // skillDigestFromHashes(files) holds by construction, and verifiers
  // recompute it (see verifyBundleChain) so the two can never drift.
  const fileHashes = Object.fromEntries(Object.entries(files).map(([p, b]) => [p, sha256(Buffer.from(b))]));
  const digest = skillDigestFromHashes(fileHashes);
  const evals = scorecards.map((c) => ({
    agent: c.agent,
    passed: c.passed,
    total: c.total,
    ranAt: c.ranAt,
  }));
  const ext = meta.metadata ?? {};
  // Agent support (allodic concept) = metadata.agents declared ∪ agents with
  // passing eval evidence. Distinct from the spec's `compatibility`, which is
  // a free-form environment-requirements string passed through verbatim.
  const declared = list(ext.agents);
  const evidenced = evals.filter((e) => e.total > 0 && e.passed === e.total).map((e) => e.agent);
  const agentSupport = [...new Set([...declared, ...evidenced])].map((agent) => ({
    agent,
    evidence: evidenced.includes(agent) ? 'evals-passing' : 'declared',
  }));

  return {
    kind: 'capability',
    format: 'allodic-capability/1',
    terms: buildTerms(meta),
    spec: 'agent-skills/v1', // payload conforms to the open Agent Skills format (agentskills.io)
    name: meta.name,
    version: meta.metadata?.version,
    description: meta.description ?? '',
    creator,
    digest,
    requires: { mcp: list(ext['requires-mcp']), tools: list(ext['requires-tools']) },
    permissions: list(ext.permissions),
    compatibility: meta.compatibility ?? null, // spec field: free-form environment requirements
    agentSupport,
    evals,
    scan: scan ? { status: scan.status, findings: scan.findings.length, criticals: scan.criticals, engine: scan.engine ?? 'allodic-builtin', external: scan.external ?? null } : null,
    // Provenance for canary-varied files: publish-time salted commitment to
    // the slot structure. Openable in a dispute; binds the seller pre-sale.
    derivation: derivation ? { commit: derivation.commit, varied: derivation.varied, arity: derivation.arity } : null,
    files: fileHashes,
    createdAt: new Date().toISOString(),
  };
}

/** Human-readable one-line badge, used by CLI and listings. */
export function badge(manifest) {
  const ev = manifest.evals.length
    ? manifest.evals.map((e) => `${e.agent} ${e.passed}/${e.total}`).join(' · ')
    : 'no evals';
  const scan = manifest.scan
    ? manifest.scan.criticals > 0 ? `scan: ${manifest.scan.criticals} CRITICAL` : 'scan: clean'
    : 'unscanned';
  return `verified capability · ${ev} · ${scan} · ${manifest.digest.slice(0, 12)}`;
}
