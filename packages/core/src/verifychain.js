// The ONE strict verification path for anything that will touch an agent
// directory. `add`, `update`, and `verify` all run this same chain; nothing
// installs unless every mandatory check passes.
//
// Threat this exists for: a compromised or buggy server holding the
// legitimate publisher key advertises clean capability A but delivers signed
// bundle B. Bundle-signature verification alone accepts B; this chain
// rejects it — continuity binds the bundle to the advertised capability
// digest, mechanical provenance binds every unvaried file to the published
// hashes, the derivation arity check binds varied files to the committed
// slot structure, and the local scan re-checks what actually arrived.
import { verifyManifest, sha256 } from './sign.js';
import { skillDigestFromHashes } from './evals.js';
import { verifyBundle } from './bundle.js';
import { stripFingerprint } from './fingerprint.js';
import { scanSkill, scanSkillSpector } from './scan.js';

export function verifyBundleChain({ listing, bundle, preferSpector = true }) {
  const checks = [];
  const add = (name, ok, detail = '') => { checks.push({ name, ok, detail }); return ok; };
  const done = (extra = {}) => {
    const mandatoryFailed = checks.filter((x) => !x.ok).map((x) => x.name);
    return { ok: mandatoryFailed.length === 0, mandatoryFailed, checks, ...extra };
  };

  const c = listing.capability;
  if (!c) { add('capability manifest present', false, 'listing has no capability'); return done(); }
  add('capability signature valid', verifyManifest(c, listing.capabilitySig, listing.publicKeyPem));

  // The digest is not opaque: it is defined as a function of the published
  // per-file hash map (see skillDigestFromHashes). Recomputing it here binds
  // digest ⇔ file map, so the map the provenance check trusts below is
  // exactly the map the digest (and everything bound to it — scorecards,
  // bundle continuity, version idempotency) commits to.
  add('digest binds the published per-file hash map',
      !!c.files && skillDigestFromHashes(c.files) === c.digest,
      c.files ? (c.digest?.slice(0, 12) ?? 'missing') : 'capability has no files map');

  let manifest = null;
  try {
    manifest = verifyBundle(bundle, listing.publicKeyPem);
    add('bundle signature + file hashes', true, `order ${manifest.order}`);
  } catch (e) {
    add('bundle signature + file hashes', false, e.message);
    return done();
  }

  add('continuity: bundle signed against the published capability digest',
      manifest.capabilityDigest === c.digest, manifest.capabilityDigest?.slice(0, 12) ?? 'missing');

  // Mechanical provenance: unvaried files must hash-identical to the
  // published capability (after stripping allodic's own watermark).
  const variedPaths = new Set(Object.keys(manifest.varied ?? {}));
  const strippedFiles = {};
  const mismatches = [];
  let checked = 0;
  for (const [p, b64] of Object.entries(bundle.files)) {
    const buf = Buffer.from(b64, 'base64');
    const content = p.endsWith('.md') ? Buffer.from(stripFingerprint(buf.toString('utf8'))) : buf;
    strippedFiles[p] = content;
    if (variedPaths.has(p)) continue;
    checked++;
    if (c.files?.[p] !== sha256(content)) mismatches.push(p);
  }
  add(`provenance: ${checked - mismatches.length}/${checked} unvaried files hash-identical to published capability`,
      mismatches.length === 0, mismatches.length ? `MISMATCH: ${mismatches.join(', ')}` : 'exact');

  if (variedPaths.size) {
    const d = c.derivation;
    const sel = Object.values(manifest.varied ?? {}).flat();
    const arityOk = !!d && sel.length === d.arity.length
      && sel.every((v, i) => Number.isInteger(v) && v >= 0 && v < d.arity[i]);
    add('derivation commitment: selection within the committed slot structure', arityOk,
        d ? `commit ${d.commit.slice(0, 12)}… · ${[...variedPaths].join(', ')} · seller must open in any dispute` : 'MISSING from capability');
  }

  // The scan runs on what ACTUALLY arrived, not on what was advertised.
  const scan = (preferSpector ? scanSkillSpector(strippedFiles) : null)
    ?? { ...scanSkill(strippedFiles), engine: 'allodic-builtin' };
  const engineNote = c.scan?.engine && c.scan.engine !== scan.engine ? ` [engine differs: published ${c.scan.engine}]` : '';
  add('local safety scan of the delivered files', scan.status !== 'blocked',
      `${scan.status} via ${scan.engine}${scan.findings.length ? ` (${scan.findings.length} findings)` : ''}${engineNote}`);

  return done({ manifest, strippedFiles, scan });
}
