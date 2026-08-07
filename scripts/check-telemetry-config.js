// Telemetry release-configuration gate — runs in `npm test`, CI, and the
// publish-npm workflow. Validates the ACTUAL exported constants (not just
// text), the frozen event allowlist, packaging, and the absence of private
// credentials or forbidden per-destination controls. A release must fail
// before publishing if any of this drifts.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const problems = [];
const t = await import('../packages/cli/lib/telemetry.js').catch((e) => {
  problems.push(`telemetry module failed to import: ${e.message}`);
  return null;
});

// ---- exact production constants, validated from the exports ----
const EXPECTED_TOKEN = 'phc_rzTnX44sX7LeiGCvMhYhb93mwp5Svnd8ZFLDCVvkuZDi';
const EXPECTED_ENDPOINT = 'https://j.allodic.dev/capture/';

if (t) {
  if (!t.POSTHOG_PROJECT_TOKEN) problems.push('POSTHOG_PROJECT_TOKEN missing');
  else {
    if (!t.POSTHOG_PROJECT_TOKEN.startsWith('phc_')) problems.push('PostHog token must be a public phc_ project token');
    if (t.POSTHOG_PROJECT_TOKEN !== EXPECTED_TOKEN) problems.push('PostHog token differs from the configured production token');
  }
  if (t.DEFAULT_TELEMETRY_ENDPOINT !== EXPECTED_ENDPOINT) problems.push(`endpoint must be exactly ${EXPECTED_ENDPOINT} (got ${t.DEFAULT_TELEMETRY_ENDPOINT})`);
  if (!String(t.DEFAULT_TELEMETRY_ENDPOINT).startsWith('https://')) problems.push('production endpoint must use HTTPS');
  if (t.TELEMETRY_SCHEMA_VERSION !== 1) problems.push(`schema version must be 1 (got ${t.TELEMETRY_SCHEMA_VERSION})`);

  // ---- the event allowlist must contain exactly the documented set ----
  const EXPECTED_EVENTS = {
    cli_init_succeeded: ['mode'],
    cli_publish_succeeded: ['paid', 'first_publish', 'has_evals', 'eval_runner'],
    cli_release_succeeded: ['paid', 'has_evals', 'eval_runner', 'active_entitlements_bucket'],
    cli_add_succeeded: ['paid', 'license_flow', 'agents', 'agent_count_bucket'],
    cli_update_completed: ['installed_bucket', 'updated_bucket', 'current_bucket', 'failed_bucket'],
    cli_command_failed: ['command', 'stage', 'reason'],
  };
  const actual = t.EVENT_DEFINITIONS ?? {};
  for (const [name, fields] of Object.entries(EXPECTED_EVENTS)) {
    if (!actual[name]) { problems.push(`missing event definition: ${name}`); continue; }
    const got = Object.keys(actual[name]).sort().join(',');
    const want = [...fields].sort().join(',');
    if (got !== want) problems.push(`${name}: fields drifted (have [${got}], expect [${want}])`);
  }
  for (const name of Object.keys(actual)) {
    if (!EXPECTED_EVENTS[name]) problems.push(`undocumented event in allowlist: ${name} — no hidden events`);
  }
}

// ---- repository scan: private credentials, forbidden separate controls ----
const SCAN_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.sh', '.yml', '.yaml', '.html']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.stand']);
const SELF = 'check-telemetry-config.js';
function* walk(dir) {
  for (const e of readdirSync(dir)) {
    if (SKIP_DIRS.has(e)) continue;
    const full = join(dir, e);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (st.isFile() && SCAN_EXT.has(extname(e))) yield full;
  }
}
for (const file of walk('.')) {
  if (file.endsWith(SELF)) continue;
  const text = readFileSync(file, 'utf8');
  // phx_ personal keys / private credentials must never appear.
  const priv = text.match(/phx_[A-Za-z0-9]{8,}/);
  if (priv) problems.push(`${file}: private-key-looking PostHog credential (${priv[0].slice(0, 12)}…)`);
  // One shared setting: no separate automatic-reporting controls anywhere,
  // including docs — a documented-but-unimplemented control is still a lie.
  for (const banned of ['ALLODIC_NO_DELIVERY_EVENTS', 'ALLODIC_NO_TELEMETRY']) {
    if (text.includes(banned)) problems.push(`${file}: forbidden separate reporting control ${banned}`);
  }
}

// ---- packaging: the module must ship in the packed CLI ----
// npm prints the pack listing as "npm notice" on stderr — capture both.
import { spawnSync } from 'node:child_process';
{
  const r = spawnSync('npm', ['pack', '--dry-run', '--workspace', 'packages/cli'], { encoding: 'utf8' });
  const listing = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (!/lib\/telemetry\.js/.test(listing)) problems.push('packed CLI does not include lib/telemetry.js — check packages/cli "files"');
}

if (problems.length) {
  console.error('✗ telemetry configuration:');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log('✓ telemetry configuration valid: endpoint, public token, schema v1, allowlist, packaging, no private keys, one shared control');
