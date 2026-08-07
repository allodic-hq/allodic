// allodic core — derived usage analytics (v0.5).
//
// There is no allodic process running when a capability is used: skills are
// content loaded by the agent, and we refuse to ship a resident recorder.
// Instead, usage is DERIVED on demand from session logs the buyer's agents
// already write (Claude Code: ~/.claude/projects/**/*.jsonl, Codex:
// ~/.codex/sessions/**/*.jsonl). Nothing is recorded by allodic, nothing
// is transmitted, and the computation happens only when the buyer runs
// `allodic stats`. Privacy model: the data never exists outside files the
// buyer's own tools created.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_LOG_SOURCES = (home) => [
  { agent: 'claude-code', dir: join(home, '.claude', 'projects') },
  { agent: 'codex', dir: join(home, '.codex', 'sessions') },
];

function* jsonlFiles(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* jsonlFiles(full);
    else if (entry.endsWith('.jsonl')) yield full;
  }
}

/**
 * Scan agent session logs for evidence of a capability being used.
 * Matchers: the capability slug (skills are installed under it) and its name.
 * A "session touch" = one session file containing >=1 reference.
 * Deliberately coarse: counting sessions, not parsing prompts.
 */
export function deriveUsage({ slug, name, sources }) {
  const needles = [slug, name].filter(Boolean).map((s) => s.toLowerCase());
  const perAgent = {};
  let firstSeen = null;
  let lastSeen = null;

  for (const { agent, dir } of sources) {
    let sessions = 0;
    let references = 0;
    for (const file of jsonlFiles(dir)) {
      let text;
      try { text = readFileSync(file, 'utf8').toLowerCase(); } catch { continue; }
      const hits = needles.reduce((n, needle) => n + (text.split(needle).length - 1), 0);
      if (hits > 0) {
        sessions++;
        references += hits;
        const mtime = statSync(file).mtime.toISOString();
        if (!firstSeen || mtime < firstSeen) firstSeen = mtime;
        if (!lastSeen || mtime > lastSeen) lastSeen = mtime;
      }
    }
    if (sessions > 0) perAgent[agent] = { sessions, references };
  }

  const totals = Object.values(perAgent).reduce(
    (a, x) => ({ sessions: a.sessions + x.sessions, references: a.references + x.references }),
    { sessions: 0, references: 0 },
  );
  return { slug, perAgent, totals, firstSeen, lastSeen, derivedAt: new Date().toISOString() };
}

/**
 * Build the exact payload a buyer may choose to submit to the registry.
 * Contains counts and versions only — structurally incapable of carrying
 * prompts, file contents, or tool output. Shown verbatim before submission.
 */
export function buildUsageReport({ usage, version, cliVersion = '0.5.0' }) {
  return {
    format: 'allodic-report/1',
    slug: usage.slug,
    version,
    agents: Object.fromEntries(Object.entries(usage.perAgent).map(([a, x]) => [a, x.sessions])),
    sessions: usage.totals.sessions,
    firstSeen: usage.firstSeen,
    lastSeen: usage.lastSeen,
    cliVersion,
  };
}
