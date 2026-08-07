// Minimal, dependency-free semver ordering (spec-faithful where it matters):
// numeric major.minor.patch; prereleases sort BELOW the release
// (1.0.0-alpha < 1.0.0); prerelease identifiers compare numerically when
// numeric, lexically otherwise, shorter-prefix loses; build metadata ignored.
const RE = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(s) {
  const m = RE.exec(String(s ?? '').trim());
  if (!m) return null;
  return {
    major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] ?? 0),
    prerelease: m[4] ? m[4].split('.') : [],
  };
}

export const validSemver = (s) => parseSemver(s) !== null;

/** -1, 0, 1 — throws on unparseable input so callers must decide fallbacks. */
export function cmpSemver(a, b) {
  const pa = parseSemver(a), pb = parseSemver(b);
  if (!pa || !pb) throw new Error(`not semver: ${!pa ? a : b}`);
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  const A = pa.prerelease, B = pb.prerelease;
  if (!A.length && !B.length) return 0;
  if (!A.length) return 1;  // release > its prereleases
  if (!B.length) return -1;
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    if (A[i] === undefined) return -1; // fewer identifiers sorts first
    if (B[i] === undefined) return 1;
    const na = /^\d+$/.test(A[i]) ? Number(A[i]) : null;
    const nb = /^\d+$/.test(B[i]) ? Number(B[i]) : null;
    if (na !== null && nb !== null) { if (na !== nb) return na < nb ? -1 : 1; }
    else if (na !== null) return -1; // numeric < alphanumeric
    else if (nb !== null) return 1;
    else if (A[i] !== B[i]) return A[i] < B[i] ? -1 : 1;
  }
  return 0;
}

export const gtSemver = (a, b) => cmpSemver(a, b) > 0;
