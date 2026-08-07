// allodic core — publish-time safety scan (v0.3).
//
// The skill-supply-chain threat model is not CVEs; it is instructions.
// Public scans of community skill hubs have surfaced enough malicious and
// suspicious patterns that publish-time scanning is table stakes.
// (Roadmap: publish our rule corpus + labeled samples as an open benchmark.)
// This scanner covers the known-bad shapes so every listing can say
// "scan: clean" — or be blocked before a buyer ever sees it.
//
// Severities: critical (block publish), warn (disclose on listing).
const RULES = [
  // exfiltration & droppers
  { id: 'net-exfil', sev: 'critical', re: /\b(curl|wget|fetch|Invoke-WebRequest)\b[^\n]{0,120}\bhttps?:\/\//i,
    why: 'network call with a hardcoded URL — exfiltration/dropper shape' },
  { id: 'pipe-to-shell', sev: 'critical', re: /\b(curl|wget)\b[^\n]{0,160}\|\s*(ba)?sh\b/i,
    why: 'pipe-to-shell install pattern' },
  { id: 'env-harvest', sev: 'critical', re: /\b(env|printenv|process\.env|os\.environ)\b[^\n]{0,120}\b(curl|fetch|wget|http)/i,
    why: 'reads environment variables near a network call — credential harvesting shape' },
  { id: 'cred-paths', sev: 'critical', re: /(\.aws\/credentials|\.ssh\/id_|\.netrc|\.claude\/credentials|api[_-]?key\s*=)/i,
    why: 'references credential storage paths' },
  // prompt-level attacks
  { id: 'override', sev: 'critical', re: /\b(ignore|disregard|override)\b[^\n]{0,60}\b(previous|prior|above|system)\b[^\n]{0,40}\b(instructions?|prompt|rules)\b/i,
    why: 'instruction-override phrasing (prompt injection)' },
  { id: 'concealment', sev: 'critical', re: /\b(do not|don'?t|never)\b[^\n]{0,60}\b(tell|inform|mention|reveal|show)\b[^\n]{0,60}\b(user|human|owner)\b/i,
    why: 'instructs the agent to conceal activity from the user' },
  // obfuscation
  { id: 'b64-blob', sev: 'warn', re: /[A-Za-z0-9+/]{200,}={0,2}/,
    why: 'large base64 blob — unreviewable payload' },
  { id: 'zero-width', sev: 'warn', re: /[\u200b\u200c\u200d\u2060\ufeff]/,
    why: 'zero-width characters in source (hidden text)' },
  { id: 'homoglyph', sev: 'warn', re: /[\u0430-\u044f]/, // cyrillic lookalikes in otherwise-latin files
    why: 'possible homoglyph obfuscation' },
];

/**
 * Scan a file map. Creator-authored canary slots are rendered to neutral first
 * by the caller, so the scan sees what buyers' agents will see.
 * Returns { status: 'clean'|'warnings'|'blocked', criticals, findings: [...] }.
 */
export function scanSkill(files /* {path: Buffer|string} */) {
  const findings = [];
  for (const [path, raw] of Object.entries(files)) {
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    for (const rule of RULES) {
      const m = text.match(rule.re);
      if (m) {
        findings.push({
          rule: rule.id, severity: rule.sev, path, why: rule.why,
          excerpt: m[0].slice(0, 80),
        });
      }
    }
  }
  const criticals = findings.filter((f) => f.severity === 'critical').length;
  return {
    status: criticals ? 'blocked' : findings.length ? 'warnings' : 'clean',
    criticals,
    findings,
  };
}

// ---------------------------------------------------------------------------
// SkillSpector (NVIDIA) — preferred scan engine when installed.
// Purpose-built skill scanner: 64 patterns / 16 categories incl. AST, taint
// tracking, and YARA — far beyond the regex ruleset above, which remains the
// zero-config fallback. Run STATIC-ONLY (--no-llm): the LLM stage is
// nondeterministic and the gate's promise is a reproducible scan.
// Force the builtin engine with ALLODIC_SCANNER=builtin.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

/** Normalize a SkillSpector JSON report into the allodic scan shape.
 *  Exported separately so it is testable without the binary. */
export function normalizeSpectorReport(report) {
  const findings = (report.issues ?? []).map((i) => ({
    rule: i.id ?? i.finding_id ?? 'finding',
    severity: String(i.severity ?? '').toLowerCase(),
    path: i.location?.file ?? 'SKILL.md',
    line: i.location?.start_line ?? null,
    why: [i.pattern, i.explanation].filter(Boolean).join(' — ').slice(0, 240),
    excerpt: String(i.code_snippet ?? i.finding ?? '').slice(0, 80),
    confidence: i.confidence ?? null,
  }));
  const criticals = findings.filter((f) => f.severity === 'critical').length;
  const blocked = report.risk_assessment?.recommendation === 'DO_NOT_INSTALL';
  return {
    status: blocked ? 'blocked' : findings.length ? 'warnings' : 'clean',
    blocked,
    criticals,
    findings,
    engine: `skillspector@${report.metadata?.skillspector_version ?? '?'} (static)`,
    score: report.risk_assessment?.score ?? null,
    recommendation: report.risk_assessment?.recommendation ?? null,
  };
}

/** Run SkillSpector on a file map. Returns the normalized scan, or null when
 *  the binary is not installed (caller falls back to scanSkill). */
export function scanSkillSpector(files /* {path: Buffer|string} */) {
  if (!spectorAvailable()) return null;
  const base = mkdtempSync(join(tmpdir(), 'allodic-scan-'));
  try {
    const dir = join(base, 'skill');
    for (const [rel, content] of Object.entries(files)) {
      const dest = join(dir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content);
    }
    const out = join(base, 'report.json');
    const r = spawnSync('skillspector', ['scan', dir, '--no-llm', '--format', 'json', '--output', out],
      { encoding: 'utf8', timeout: 120000 });
    if (r.error || r.status === null) return null;
    const report = JSON.parse(readFileSync(out, 'utf8'));
    if (report.execution_successful === false) return null; // engine failed: fall back, don't fake a clean scan
    return normalizeSpectorReport(report);
  } catch {
    return null;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

let _spector;
function spectorAvailable() {
  if (_spector !== undefined) return _spector;
  const r = spawnSync('skillspector', ['--version'], { encoding: 'utf8', timeout: 10000 });
  _spector = !r.error && r.status === 0;
  return _spector;
}
