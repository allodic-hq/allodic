#!/usr/bin/env node
// allodic — sell your agent skills direct. Own your buyers. Keep ~97%.
//
//   creator:  allodic init | publish <dir> | release <dir> | trace <file>
//   buyer:    allodic add <listing-url> | update
//
// Zero config files required; state lives in ~/.allodic/.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  reportingDecision, isAutomaticReportingEnabled, maybeShowFirstUseNotice, recordEvent,
  flushTelemetry, ensureState, readState, writeState, readQueue, clearQueue,
  bucketCount, bucketAgents, mapEvalRunner, resolveEndpoint, boundedPost,
  DEFAULT_TELEMETRY_ENDPOINT, POSTHOG_PROJECT_TOKEN, EVENT_DEFINITIONS, FIRST_USE_NOTICE,
} from '../lib/telemetry.js';
import { c as clr, codes, paintMark, rule } from '../lib/colors.js';
import {
  collectFiles, parseSkillMeta, verifyBundle, installBundle, extractFingerprint,
  makeRunner, runEvals, skillContentHash, gradeTranscript, parsePrice, sha256, checkCompliance, scanSkillSpector, verifyScorecard, renderNeutralCopy, verifyBundleChain,
  secureDir, writeSecretJson, hardenSecret,
  verifyManifest, stripFingerprint, scanSkill, validateSkillName,
  deriveUsage, buildUsageReport, DEFAULT_LOG_SOURCES,
} from '@allodic/core';

const HOME = join(homedir(), '.allodic');
const CREDS = join(HOME, 'credentials.json');
const INSTALLS = join(HOME, 'installs.json');

// Agent skill directories we know how to install into (extend freely).
const AGENT_DIRS = [
  { agent: 'claude-code', dir: join(homedir(), '.claude', 'skills') },
  { agent: 'cursor',      dir: join(homedir(), '.cursor', 'skills') },
  { agent: 'codex',       dir: join(homedir(), '.codex', 'skills') },
  { agent: 'windsurf',    dir: join(homedir(), '.windsurf', 'skills') },
];

const [cmd, ...args] = process.argv.slice(2);
const say = (s = '') => console.log(paintMark(s));

/** Typed command failure. `die()` throws instead of exiting so async
 *  telemetry can flush; main() prints once and sets process.exitCode. */
class CliError extends Error {
  constructor(message, { stage = 'unknown', reason = 'unknown', alreadyPrinted = false } = {}) {
    super(message);
    this.name = 'CliError';
    this.stage = stage;
    this.reason = reason;
    this.alreadyPrinted = alreadyPrinted;
  }
}
const die = (message, metadata = {}) => { throw new CliError(message, metadata); };

// Product-funnel commands that emit telemetry events (see docs/telemetry.md).
const TRACKED = new Set(['init', 'publish', 'release', 'add', 'update']);
// NETWORK-INERT commands: no first-use notice AND no end-of-run flush.
// `telemetry status`/`show` must be able to display the queue without
// transmitting it — inspecting telemetry can never BE telemetry — and
// help/version touch the network for nothing. Unknown commands print usage
// and are inert too.
const NETWORK_INERT = new Set(['--version', '-v', 'version', '--help', 'help', 'telemetry', undefined]);
const KNOWN = new Set(['init', 'publish', 'release', 'add', 'inspect', 'stats', 'sales', 'report', 'verify', 'update', 'telemetry', 'trace']);
const networkInert = NETWORK_INERT.has(cmd) || !KNOWN.has(cmd);

async function main() {
  // Disclosure precedes any possible transmission; exempt commands (help,
  // version, telemetry management) never trigger it.
  if (!networkInert) maybeShowFirstUseNotice();
  switch (cmd) {
    case '--version': case '-v': case 'version':
      say(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version); return;
    case 'init':      return cmdInit(args);
    case 'publish':   return cmdPublish(args);
    case 'release':   return cmdPublish(args, { isRelease: true });
    case 'add':       return cmdAdd(args);
    case 'inspect':   return cmdInspect(args);
    case 'stats':     return cmdStats(args);
    case 'sales':     return cmdSales(args);
    case 'report':    return cmdReport(args);
    case 'verify':    return cmdVerify(args);
    case 'update':    return cmdUpdate();
    case 'telemetry': return cmdTelemetry(args);
    case 'trace':     return cmdTrace(args);
    default:          return usage();
  }
}

try {
  // Commands return their success event ({ event, props }) or nothing; the
  // event is queued only AFTER the command resolves, so no success event can
  // exist for a command that failed.
  const success = await main();
  if (success?.event) recordEvent(success.event, success.props);
} catch (e) {
  if (!(e instanceof CliError) || !e.alreadyPrinted) console.error(`${process.stderr.isTTY && !process.env.NO_COLOR ? '\x1b[31m✗\x1b[0m' : '✗'} ${e.message}`);
  if (TRACKED.has(cmd)) {
    recordEvent('cli_command_failed', {
      command: TRACKED.has(cmd) ? cmd : 'other',
      stage: e instanceof CliError ? e.stage : 'unknown',
      reason: e instanceof CliError ? e.reason : 'unknown',
    });
  }
  process.exitCode = 1;
}
// One best-effort flush per invocation (≤5 events, ≤500 ms, failures
// retained) — but NEVER after network-inert commands: `telemetry show` must
// not transmit the very queue it just displayed.
if (!networkInert) await flushTelemetry();

async function cmdInspect(args) {
  const url = args[0] ?? die('Usage: allodic inspect <listing-url>');
  const l = await api(toApiListing(url));
  const c = l.capability ?? die('No capability manifest published for this listing');
  const sigOk = l.capabilitySig ? verifyManifest(c, l.capabilitySig, l.publicKeyPem) : false;
  const mark = (ok) => ok ? '✓' : '✗';
  say(`Capability   ${c.name}@${c.version}   ${mark(sigOk)} ${sigOk ? 'signature valid' : 'SIGNATURE INVALID'}`);
  say(`Creator      ${c.creator}`);
  say(`Digest       ${c.digest.slice(0, 24)}`);
  say(`Price        ${l.price === 0 ? 'free' : '$' + (l.price / 100).toFixed(2)}`);
  say('Compatibility');
  for (const x of c.agentSupport ?? []) say(`  ${x.agent.padEnd(14)} ${x.evidence === 'evals-passing' ? '✓ evals passing' : '— declared'}`);
  if (!(c.agentSupport ?? []).length) say('  (none declared)');
  if (c.compatibility) say(`Environment  ${c.compatibility}`);
  say(`Permissions  ${c.permissions.join(', ') || '—'}`);
  say(`Requires     ${[...c.requires.mcp.map((m) => m + ' (mcp)'), ...c.requires.tools].join(', ') || '—'}`);
  say(`Security     ${c.scan ? (c.scan.criticals ? '✗ findings' : c.scan.findings ? `✓ clean (${c.scan.findings} notes)` : '✓ scan clean') : '— unscanned'}`);
  for (const e of c.evals) say(`Benchmarks   ${e.agent}  ${e.passed}/${e.total}  signed  (${e.ranAt.slice(0, 10)})`);
  if (!c.evals.length) say('Benchmarks   — none published');
}

async function cmdVerify(args) {
  const url = args[0] ?? die('Usage: allodic verify <listing-url> [--evals]');
  const withEvals = args.includes('--evals');
  const l = await api(toApiListing(url));
  const c = l.capability ?? die('No capability manifest to verify');
  const failures = [];
  const check = (label, ok, extra = '') => {
    say(`${ok ? '✓' : '✗'} ${label}${extra ? '  ' + clr.dim(extra) : ''}`);
    if (!ok) failures.push(label);
    return ok;
  };

  // 1. capability signature
  const sigOk = verifyManifest(c, l.capabilitySig, l.publicKeyPem);
  check('capability signature valid', sigOk);
  if (c.terms) {
    const t = c.terms;
    const splits = (t.payoutSplits ?? []).map((x) => `${x.pct}% -> ${x.to}`).join(', ');
    say(clr.dim(`  signed terms: $${(t.priceCents / 100).toFixed(2)} · updates ${t.updates} · refunds ${t.refunds}${splits ? ` · royalties: ${splits}` : ''}`));
  }
  if (!sigOk) { process.exitCode = 1; return; } // exit honestly without bypassing telemetry flush

  // 2. entitled reproduction: pull my bundle and verify the chain
  const server = url.replace(/\/s\/[^/]+\/?$/, '');
  const token = loadCreds()[server];
  const bundle = token ? await tryBundle(server, l.slug, token) : null;
  if (!bundle) {
    say('~ no license on this device — public checks only (buy or activate to reproduce fully)');
    return;
  }
  // 2-3. the SAME strict chain `add` and `update` gate installs on.
  const chain = verifyBundleChain({ listing: l, bundle, preferSpector: process.env.ALLODIC_SCANNER !== 'builtin' });
  for (const ch of chain.checks.slice(1)) check(ch.name, ch.ok, ch.detail); // capability sig already rendered above with terms
  const myFiles = chain.strippedFiles ?? {};

  // 4. optionally re-run published evals against MY agent with MY copy —
  //    after verifying the SIGNED scorecard is authentic and bound to the
  //    exact published content, then comparing task by task.
  if (withEvals && myFiles['evals/tasks.json']) {
    const published = Array.isArray(l.evals) ? l.evals[0] : l.evals;
    let signedCard = null;
    if (published?.signed) {
      try {
        signedCard = verifyScorecard(published.signed, l.publicKeyPem, c.digest);
        check('published scorecard: signature valid + bound to this exact published content',
              true, `${signedCard.passed}/${signedCard.total} on ${signedCard.agent} at ${signedCard.ranAt}`);
      } catch (e) {
        check('published scorecard: signature valid + bound to this exact published content', false, e.message);
      }
    } else {
      check('published scorecard: signature valid + bound to this exact published content', false, 'no signed scorecard published');
    }
    const tasks = JSON.parse(myFiles['evals/tasks.json'].toString('utf8'));
    const runnerKind = process.env.ALLODIC_EVAL_RUNNER ?? 'claude';
    const runner = runnerKind === 'mock'
      ? makeRunner('mock', { respond: () => process.env.ALLODIC_EVAL_MOCK ?? '' })
      : makeRunner(runnerKind, {});
    const card = runEvals({ tasks, runner, agentLabel: runnerKind, skillName: c.name ?? l.slug, skillFiles: myFiles, skillContentHash: 'local-reproduction' });
    check(`evals reproduce locally (${runnerKind}, candidate materialized: ${runner.isolation})`, card.passed === card.total,
          `${card.passed}/${card.total}` + (signedCard ? ` vs published ${signedCard.passed}/${signedCard.total}` : ''));
    if (signedCard?.results) {
      const drift = card.results.filter((r) => signedCard.results.find((p2) => p2.id === r.id)?.pass !== r.pass);
      check('per-task agreement with the signed scorecard', drift.length === 0,
            drift.length ? `differs on: ${drift.map((d) => d.id).join(', ')}` : `all ${card.total} tasks agree`);
    }
  } else if (withEvals) {
    say('~ no eval tasks ship with this capability');
  }
  if (failures.length) {
    process.exitCode = 1;
    say(clr.red(clr.bold(`verification FAILED — ${failures.length} check${failures.length > 1 ? 's' : ''} did not pass:`)));
    for (const f of failures) say(`  ✗ ${f}`);
  } else {
    say(clr.green(clr.bold('verification complete — all checks passed')));
  }
}

function installedEntry(slug) {
  const list = existsSync(INSTALLS) ? JSON.parse(readFileSync(INSTALLS, 'utf8')) : [];
  return list.find((x) => x.slug === slug) ?? die(`'${slug}' is not installed via allodic`);
}

async function cmdStats(args) {
  const slug = args[0] ?? die('Usage: allodic stats <slug>');
  const inst = installedEntry(slug);
  const sources = process.env.ALLODIC_LOG_DIR
    ? [{ agent: 'custom', dir: process.env.ALLODIC_LOG_DIR }]
    : DEFAULT_LOG_SOURCES(homedir());
  const u = deriveUsage({ slug, name: slug, sources });
  say(`${slug} — local usage (derived from your agents' session logs; nothing recorded, nothing sent)`);
  if (!u.totals.sessions) return say('  no sessions reference this capability yet');
  for (const [agent, x] of Object.entries(u.perAgent)) say(`  ${agent.padEnd(14)} ${x.sessions} sessions · ${x.references} references`);
  say(`  first seen     ${u.firstSeen?.slice(0, 10)}`);
  say(`  last seen      ${u.lastSeen?.slice(0, 10)}`);
  say(`  version        ${inst.version}`);
}

async function cmdReport(args) {
  const slug = args[0] ?? die('Usage: allodic report <slug> [--yes]');
  const inst = installedEntry(slug);
  const sources = process.env.ALLODIC_LOG_DIR
    ? [{ agent: 'custom', dir: process.env.ALLODIC_LOG_DIR }]
    : DEFAULT_LOG_SOURCES(homedir());
  const u = deriveUsage({ slug, name: slug, sources });
  const report = buildUsageReport({ usage: u, version: inst.version });
  say('This exact payload — counts and versions only — would be sent to the registry:');
  say(JSON.stringify(report, null, 2));
  say('Never included: prompts, file contents, tool output, source code.');
  if (!args.includes('--yes')) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const a = (await rl.question('Submit to creator via registry? [y/N] ')).trim().toLowerCase();
    rl.close();
    if (a !== 'y') return say('Not sent.');
  }
  const token = loadCreds()[inst.server] ?? die('activate on this device first');
  const r = await api(`${inst.server}/api/reports/${slug}`, { method: 'POST', token, body: report });
  say(`✓ Sent. Registry stored: ${r.stored.sessions} sessions across ${Object.keys(r.stored.agents).length} agent(s).`);
}

async function cmdSales(args) {
  const slug = args[0] ?? die('Usage: allodic sales <slug>');
  const server = serverUrl();
  const adminKey = process.env.ALLODIC_ADMIN_KEY ?? die('Set ALLODIC_ADMIN_KEY');
  const i = await api(`${server}/api/insights/${slug}`, { headers: { 'x-admin-key': adminKey } });
  const listing = await api(`${server}/s/${slug}`);
  const { g, d, b, R } = codes;
  const W = 46;
  const vis = (t) => String(t).replace(/\x1b\[[0-9;]*m/g, '').length;
  const line = (l, r_) => `│ ${l}${' '.repeat(Math.max(1, W - vis(l) - vis(r_) - 3))}${r_} │`;
  const rule = `├${'─'.repeat(W - 1)}┤`;
  const money = (cents, cur) => `${cur === 'usd' ? '$' : cur.toUpperCase() + ' '}${(cents / 100).toFixed(2)}`;
  say(`┌${'─'.repeat(W - 1)}┐`);
  say(line(`${b}${listing.name}${R}`, `v${listing.version}`));
  say(rule);
  say(line('sales', String(i.registry.sales)));
  // Money comes from actual recorded orders, per currency — never from
  // count × current price. Refunds are subtracted; manual revocations
  // (license pulled, money kept) are not.
  for (const f of i.registry.finance ?? []) {
    const tag = (i.registry.finance.length > 1) ? ` (${f.currency.toUpperCase()})` : '';
    say(line(`gross sales${tag}`, money(f.grossCents, f.currency)));
    if (f.refundedCount) say(line(`refunds${tag}`, `−${money(f.refundedCents, f.currency)} (${f.refundedCount})`));
    say(line(`net sales${tag}`, money(f.netCents, f.currency)));
    for (const sp of f.royalties ?? []) {
      say(line(`royalty ${sp.pct}% → ${sp.to.length > 22 ? sp.to.slice(0, 19) + '…' : sp.to}`, `${money(sp.accruedCents, f.currency)} on net`));
    }
    if (f.manuallyRevoked) say(line(`${d}revoked (non-refund)${R}`, String(f.manuallyRevoked)));
  }
  say(line('active licenses', String(i.registry.active)));
  say(line('updates delivered', String(i.registry.updatesDelivered ?? 0)));
  const agents = Object.entries(i.registry.installsByAgent ?? {}).map(([a, n]) => `${a}:${n}`).join(' ') || '—';
  say(line('installed on', agents));
  say(rule);
  if (i.registry.sales === 1) {
    say(line(`${g}${b}★ FIRST SALE ★${R}`, ''));
  } else if ([10, 50, 100, 500, 1000].includes(i.registry.sales)) {
    say(line(`${g}${b}★ ${i.registry.sales} SALES ★${R}`, ''));
  } else {
    say(line(`${g}PAID · direct · yours${R}`, ''));
  }
  say(rule);
  say(line(`${d}sold from my own site with allodic${R}`, ''));
  say(`└${'─'.repeat(W - 1)}┘`);
}

// ---------------- telemetry management ----------------
// One shared setting controls BOTH automatic destinations: Allodic product
// analytics (PostHog via the first-party proxy) and publisher install/update
// delivery events. These commands never transmit anything themselves.
async function cmdTelemetry(args) {
  const sub = args[0];
  const env = process.env;
  const decision = reportingDecision(env);
  const envOverrideNote = () => {
    if (env.DO_NOT_TRACK === '1') return 'Reporting disabled by DO_NOT_TRACK=1';
    if (env.ALLODIC_TELEMETRY === '0') return 'Reporting disabled by ALLODIC_TELEMETRY=0';
    if (env.ALLODIC_TELEMETRY === '1') return 'Reporting explicitly enabled by ALLODIC_TELEMETRY=1';
    if (decision.reason === 'CI default') return 'Reporting disabled by CI default';
    if (decision.reason === 'source-checkout default') return 'Reporting disabled by source-checkout default';
    return null;
  };

  if (sub === 'status' || sub === undefined) {
    const st = ensureState();
    const q = readQueue();
    say(`Automatic usage reporting: ${decision.enabled ? 'enabled' : 'disabled'}`);
    say('');
    if (decision.enabled) {
      say('Destinations:');
      say(`  Allodic product analytics via ${DEFAULT_TELEMETRY_ENDPOINT}`);
      say('  Publisher install/update delivery events');
    } else {
      say('No Allodic product analytics or publisher delivery events will be sent.');
    }
    const note = envOverrideNote();
    if (note) say(note);
    say(`Installation ID: ${st.installationId}`);
    say(`Queued Allodic events: ${q.events.length}`);
    return;
  }

  // enable/disable persist a PREFERENCE; environment/CI/source-checkout
  // overrides can still determine the EFFECTIVE state. A telemetry control
  // that reports the opposite of reality is trust-eroding, so mutation
  // commands state both when they differ.
  const effectiveAfterMutation = () => {
    const now = reportingDecision(env); // re-read: includes the just-persisted value
    say(`Effective state right now: ${now.enabled ? 'ENABLED' : 'DISABLED'} (${now.reason}).`);
    if (now.reason === 'ALLODIC_TELEMETRY=1') say('  Clear ALLODIC_TELEMETRY to let the saved preference apply.');
    if (now.reason === 'ALLODIC_TELEMETRY=0') say('  Clear ALLODIC_TELEMETRY to let the saved preference apply.');
    if (now.reason === 'DO_NOT_TRACK=1') say('  DO_NOT_TRACK=1 always wins; unset it to let the saved preference apply.');
    if (now.reason === 'CI default') say('  CI defaults reporting off; set ALLODIC_TELEMETRY=1 to enable in CI.');
    if (now.reason === 'source-checkout default') say('  Source checkouts default reporting off; set ALLODIC_TELEMETRY=1 to enable here.');
  };

  if (sub === 'disable') {
    const st = ensureState();
    writeState({ ...st, enabled: false }); // installation ID preserved
    clearQueue();                          // queued events cleared immediately
    // No opt-out event, no delivery event — disabling is silent to the wire.
    say('Saved: automatic usage reporting disabled (persistent preference).');
    const now = reportingDecision(env);
    if (!now.enabled) {
      say('No Allodic product analytics or publisher install/update delivery events will be sent.');
    } else {
      effectiveAfterMutation(); // e.g. ALLODIC_TELEMETRY=1 currently overrides the saved preference
    }
    return;
  }

  if (sub === 'enable') {
    const st = ensureState();
    writeState({ ...st, enabled: true }); // installation ID preserved; no event emitted
    say('Saved: automatic usage reporting enabled (persistent preference).');
    const now = reportingDecision(env);
    if (now.enabled) {
      say('This includes privacy-limited Allodic product analytics and publisher install/update delivery events.');
    } else {
      effectiveAfterMutation(); // e.g. CI or source-checkout default still disables this process
    }
    return;
  }

  if (sub === 'show') {
    const st = ensureState();
    const q = readQueue();
    say(`Automatic usage reporting: ${decision.enabled ? 'enabled' : 'disabled'} (${decision.reason})`);
    const note = envOverrideNote();
    if (note) say(note);
    say('');
    say('One shared setting controls both automatic destinations:');
    say(`  1. Allodic product analytics — PostHog Cloud EU via the first-party`);
    say(`     proxy ${DEFAULT_TELEMETRY_ENDPOINT}`);
    say(`     public project token: ${POSTHOG_PROJECT_TOKEN}`);
    say('  2. Publisher install/update delivery events — sent to the registry');
    say('     of the skill being installed/updated (event kind, version, agent list)');
    say('');
    say(`Installation ID (random UUID, never derived from you or your machine): ${st.installationId}`);
    say(`Queued Allodic events: ${q.events.length}`);
    for (const e of q.events) say(`  - ${e.event} @ ${e.timestamp}`);
    say('');
    say('Common fields on every Allodic event:');
    say('  distinct_id, $process_person_profile:false, schema_version, event_id,');
    say('  cli_version, node_major, platform, arch, ci');
    say('');
    say('Complete event/property allowlist:');
    for (const [name, def] of Object.entries(EVENT_DEFINITIONS)) {
      say(`  ${name}:`);
      for (const [field, spec] of Object.entries(def)) {
        const shape = spec === 'boolean' ? 'boolean'
          : Array.isArray(spec[0]) ? `list of [${spec[0].join(', ')}]`
          : spec.join(' | ');
        say(`    ${field}: ${shape}`);
      }
    }
    say('');
    say('Never sent, to either destination beyond its documented payload:');
    say('  skill content · skill names/slugs/descriptions · filenames/paths ·');
    say('  registry/listing/checkout/repo URLs (to PostHog) · emails/usernames ·');
    say('  credentials/tokens/keys · exact prices/amounts · raw errors/stack');
    say('  traces/response bodies · argv · environment variables');
    say('');
    say('Manage: allodic telemetry enable | disable · ALLODIC_TELEMETRY=0|1 · DO_NOT_TRACK=1');
    say('Docs:   docs/telemetry.md · https://allodic.dev/telemetry');
    return;
  }

  die(`Unknown telemetry subcommand '${sub}'. Use: status | enable | disable | show`);
}

function usage() {
  say(`allodic — sell your agent skills direct

  creator
    allodic sales <slug>                your sales, as a receipt worth sharing
    allodic init [name]              scaffold a sellable skill (creates ./name/, or in-place)
    allodic publish <dir>            publish/replace a skill on your server
    allodic release <dir>            publish a new version (buyers get it via update)
    allodic trace <file.md>          find which buyer a leaked copy belongs to

  buyer / anyone
    allodic inspect <url>            show the signed capability manifest
    allodic verify <url> [--evals]   reproduce verification: signature, digest,
                                        scan, provenance — and re-run evals locally
    allodic add <url>                buy/activate + install a capability
    allodic update                   fetch entitled updates
    allodic stats <slug>             local usage, derived from your agents' own
                                        session logs — computed on demand, never sent
    allodic report <slug>            build a counts-only usage report, show it
                                        verbatim, and submit only on your explicit yes
    allodic telemetry <status|enable|disable|show>
                                     one switch for ALL automatic reporting:
                                        Allodic product analytics + publisher
                                        install/update delivery events

  env: ALLODIC_SERVER (default http://localhost:8787), ALLODIC_ADMIN_KEY (creator),
       ALLODIC_TELEMETRY=0|1, DO_NOT_TRACK=1 (see docs/telemetry.md)`);
}

// ---------------- creator ----------------
/** Best-effort spec-legal suggestion for an invalid name. */
function suggestSkillName(raw) {
  const s = String(raw).normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return s || 'my-skill';
}

async function cmdInit(args = []) {
  // Two modes, both validated BEFORE anything is written (the spec requires
  // the skill name to equal the directory name, so silently "fixing" only the
  // frontmatter would just move the failure to publish):
  //   allodic init my-skill   → creates ./my-skill/ (preferred)
  //   allodic init            → scaffolds in-place, only if cwd is a valid name
  const target = args[0] ?? null;
  const name = target ? basename(target) : basename(process.cwd());
  const problems = validateSkillName(name);
  if (problems.length) {
    const hint = suggestSkillName(name);
    die(`'${name}' is not a valid skill name (agent-skills/v1 requires the directory and skill name to match):\n` +
        problems.map((e) => `  - ${e}`).join('\n') +
        `\n  Try:  allodic init ${hint}`, { stage: 'arguments', reason: 'invalid_input' });
  }
  const dir = target ? resolve(target) : process.cwd();
  if (target) mkdirSync(dir, { recursive: true });
  if (existsSync(join(dir, 'SKILL.md'))) die(`SKILL.md already exists in ${target ? dir : 'this directory'}`, { stage: 'filesystem', reason: 'already_exists' });
  const at = (p) => join(dir, p);
  writeFileSync(at('SKILL.md'), `---
name: ${name}
description: One sentence on what this skill does and when an agent should use it.
metadata:
  version: "0.1.0"
  price: "$29"
---

# ${name}

Instructions for the agent go here. This is the asset buyers pay for:
encode the expertise, edge cases, and checklists that took you years to learn.
`);
  mkdirSync(at('evals'), { recursive: true });
  writeFileSync(at('evals/tasks.json'), JSON.stringify([
    {
      id: 'example-task',
      prompt: 'Describe when this skill should activate and apply its first checklist item.',
      mustMention: ['REPLACE-with-a-phrase-a-correct-answer-must-contain'],
      mustNotMention: [],
    },
  ], null, 2) + '\n');
  say('✓ Scaffolded SKILL.md (metadata.price like "$29"; omit for free skills)');
  say('✓ Scaffolded evals/tasks.json — benchmarks are a publish gate for paid skills; edit the example task');
  say(`  Next: ${clr.cyan(`allodic publish ${target ? './' + name : '.'}`)}`);
  // Success event only after every scaffold file has been written.
  return { event: 'cli_init_succeeded', props: { mode: target ? 'new_directory' : 'in_place' } };
}

async function cmdPublish(args, { isRelease = false } = {}) {
  const dir = resolve(args[0] ?? '.');
  const server = serverUrl();
  const adminKey = process.env.ALLODIC_ADMIN_KEY
    ?? die('Set ALLODIC_ADMIN_KEY (printed on server first boot)', { stage: 'configuration', reason: 'missing_configuration' });

  let filesRaw;
  try { filesRaw = collectFiles(dir); }
  catch (e) { die(e.message, { stage: 'collection', reason: 'filesystem_error' }); }
  const meta = parseSkillMeta(filesRaw['SKILL.md'].toString('utf8'));
  const compliance = checkCompliance(filesRaw, { dirName: basename(dir) });
  if (compliance.status === 'non-compliant') {
    if (!compliance.spec.ok) {
      say(`✗ agent-skills/v1 spec compliance failed (engine: ${compliance.spec.engine}):`);
      for (const e of compliance.spec.errors) say(`    - ${e}`);
    }
    if (!compliance.allodic.ok) {
      say(`✗ allodic release requirements failed (our extensions, not the standard):`);
      for (const e of compliance.allodic.errors) say(`    - ${e.id}: ${e.msg}`);
    }
    die('fix the above and publish again', { stage: 'compliance', reason: 'compliance_failed' });
  }
  say(rule('gates'));
  say(`  ✓ spec       agent-skills/v1  ${clr.dim(compliance.spec.engine)}`);
  say(`  ✓ allodic :  release requirements ${compliance.allodic.passed}/${compliance.allodic.total}  ${clr.dim('extensions via metadata, not part of the standard')}`);
  for (const w of compliance.warnings) say(`    ~ ${w.id}: ${w.msg}`);
  if (!meta.name || !meta.metadata.version) die('SKILL.md needs `name` and `metadata.version`', { stage: 'compliance', reason: 'compliance_failed' });
  const slug = (meta.slug ?? meta.name).toLowerCase().replace(/[^a-z0-9-]+/g, '-');

  // Benchmark gate. Paid skills REQUIRE evals; if evals ship (paid or free),
  // they must run against the explicit candidate and must pass. No path
  // publishes "without benchmark evidence".
  const priceCents = parsePrice(meta);
  let scorecard = null;
  if (!filesRaw['evals/tasks.json']) {
    if (priceCents > 0) {
      die('benchmarks are a publish gate for paid skills: add evals/tasks.json (`allodic init` scaffolds one)', { stage: 'evals', reason: 'missing_evals' });
    }
    say('  ~ no evals/tasks.json — free skill publishes without the benchmark badge');
  } else {
    const tasks = JSON.parse(filesRaw['evals/tasks.json'].toString('utf8'));
    const runnerKind = process.env.ALLODIC_EVAL_RUNNER ?? 'claude';
    const runner = runnerKind === 'mock'
      ? makeRunner('mock', { respond: (pr, skill) => process.env.ALLODIC_EVAL_MOCK ?? '' })
      : makeRunner(runnerKind, {});
    // Evals run on the NEUTRAL render — what a buyer's copy is semantically
    // equivalent to — never on raw {{~ }} slot syntax.
    const neutralFiles = Object.fromEntries(Object.entries(filesRaw).map(([p2, b]) =>
      [p2, p2.endsWith('.md') ? Buffer.from(renderNeutralCopy(b.toString('utf8'))) : b]));
    say(clr.dim(`  … running ${tasks.length} evals via ${runnerKind}`));
    try {
      scorecard = runEvals({ tasks, runner, agentLabel: runnerKind, skillName: meta.name, skillFiles: neutralFiles, skillContentHash: skillContentHash(filesRaw) });
    } catch (e) {
      die(`eval runner '${runnerKind}' failed (${e.code ?? e.message}). Benchmarks are a gate — nothing publishes without them. Install the agent CLI, or set ALLODIC_EVAL_RUNNER=mock in CI.`, { stage: 'evals', reason: 'eval_runner_failed' });
    }
    say(`  ✓ evals      ${scorecard.passed}/${scorecard.total} passing  ${clr.dim(runner.isolation)}`);
    if (scorecard.passed !== scorecard.total) {
      for (const r of scorecard.results.filter((x) => !x.pass)) {
        say(`    ✗ ${r.id}${r.missing.length ? ` — missing: ${r.missing.join(', ')}` : ''}${r.forbidden.length ? ` — forbidden present: ${r.forbidden.join(', ')}` : ''}`);
      }
      die('benchmark gate failed — fix the skill or the tasks, then publish again', { stage: 'evals', reason: 'eval_gate_failed' });
    }
  }

  const files = Object.fromEntries(Object.entries(filesRaw).map(([p, b]) => [p, b.toString('base64')]));
  const body = {
    slug,
    name: meta.name,
    description: meta.description ?? '',
    version: meta.metadata.version,
    price: parsePrice(meta),
    creator: meta.metadata.author ?? process.env.USER ?? 'creator',
    files,
    scorecard,
  };
  const r = await api(`${server}/api/skills`, { method: 'POST', headers: { 'x-admin-key': adminKey }, body });
  say('');
  say(`✓ ${clr.bold(`${isRelease ? 'Released' : 'Published'} ${meta.name}@${meta.metadata.version}`)}`);
  const cents = parsePrice(meta);
  if (cents > 0 && !isRelease) {
    say(`  ${clr.gold(`$${(cents / 100).toFixed(2)} product created`)}`);
    say(`  ${clr.dim('Delivery')}   licensed, per-buyer fingerprinted`);
    say(`  ${clr.dim('Updates')}    entitlement-controlled`);
    say(`  ${clr.dim('Refunds')}    full refund revokes access`);
  }
  if (isRelease && r.entitled > 0) say(`  ${r.entitled} licensed buyer${r.entitled === 1 ? '' : 's'} will receive this on next update`);
  say('');
  say(`  ${clr.dim('Listing')}    ${clr.cyan(`${server}${r.listing}`)}`);
  say(`  ${clr.dim('Checkout')}   ${clr.cyan(`${server}${r.buy}`)}`);
  say(`  ${clr.dim('Buyers')}     ${clr.cyan(`npx allodic add ${server}${r.listing}`)}`);

  // Telemetry (coarse, allowlisted — never the name, slug, version, price,
  // or registry URL). first_publish comes from the local counter, which
  // increments only after the registry has accepted.
  const hasEvals = !!filesRaw['evals/tasks.json'];
  const runnerLabel = mapEvalRunner(process.env.ALLODIC_EVAL_RUNNER ?? 'claude', hasEvals);
  if (isRelease) {
    return { event: 'cli_release_succeeded', props: {
      paid: cents > 0, has_evals: hasEvals, eval_runner: runnerLabel,
      // Existing entitled audience at release time — never the exact count.
      active_entitlements_bucket: Number.isInteger(r.entitled) ? bucketCount(r.entitled) : 'unknown',
    } };
  }
  let firstPublish = false;
  if (isAutomaticReportingEnabled()) {
    const st = ensureState();
    firstPublish = st.successfulPublishes === 0;
    writeState({ ...st, successfulPublishes: st.successfulPublishes + 1 });
  }
  return { event: 'cli_publish_succeeded', props: {
    paid: cents > 0, first_publish: firstPublish, has_evals: hasEvals, eval_runner: runnerLabel,
  } };
}

async function cmdTrace(args) {
  const file = args[0] ?? die('Usage: allodic trace <file.md>');
  const server = serverUrl();
  const adminKey = process.env.ALLODIC_ADMIN_KEY ?? die('Set ALLODIC_ADMIN_KEY');
  const content = readFileSync(file, 'utf8');

  const local = extractFingerprint(content);
  if (!local.frontmatter && !local.covert) say('~ no intact zero-width/frontmatter marks — trying semantic canary recovery...');

  const explain = args.includes('--explain');
  const r = await api(`${server}/api/trace`, { method: 'POST', headers: { 'x-admin-key': adminKey }, body: { content, explain } });
  if (r.fingerprint) say(`Fingerprint: ${r.fingerprint}  (frontmatter: ${r.channels.frontmatter ? 'present' : 'stripped'}, covert: ${r.channels.covert ? 'intact' : 'absent'})`);
  else say('zero-width channel: DESTROYED · frontmatter: stripped');
  if (r.match) {
    say(`→ Order ${r.match.order} · ${r.match.email} · purchased ${r.match.purchasedAt}${r.match.revoked ? ' · REVOKED' : ''}`);
  } else if (r.canary) {
    const st = r.canary.stats;
    const evidence = `${st.slotsObserved}/${st.slotsTotal} slots survived · ${st.observedBits} of ${st.capacityBits} bits observed · ${st.orders} orders on record`;
    if (r.canary.verdict === 'identified') {
      const m = r.canary.match;
      say(`→ canary: order ${m.orderId} · ${m.email} · uniquely consistent with all surviving slots`);
      say(`  ${evidence}`);
      say(`  chance a random rewrite matches this well: ~${st.expectedRandomMatches < 0.01 ? '<1%' : (st.expectedRandomMatches * 100 / st.orders).toFixed(0) + '% per order'} — semantic evidence, corroborate before acting`);
    } else if (r.canary.verdict === 'inconclusive') {
      if (r.canary.consistent.length > 1) {
        say(`→ canary: ${r.canary.consistent.length} buyer copies are consistent with the surviving ${st.slotsObserved} slots. Attribution is inconclusive.`);
        for (const c of r.canary.consistent) say(`    ${c.orderId} · ${c.email} · purchased ${c.purchasedAt}`);
        say(`  ${evidence} — ${st.capacityBits} bits can only distinguish ${2 ** st.capacityBits} copies; add canary slots to raise capacity`);
      } else {
        const p = r.canary.topPartial;
        say(`→ canary: no order fully consistent; closest is ${p.orderId} (${p.matches}/${p.comparable} slots). Attribution is inconclusive.`);
        say(`  ${evidence}`);
      }
    } else {
      say(`→ canary: too few slots survived to say anything (${st.slotsObserved} observed, minimum 3). No attribution.`);
    }
  } else {
    say('→ No matching order on this server.');
  }
  if (r.detail) {
    say('');
    say('slot  expected (this buyer)        found in leak                  ');
    say('────  ───────────────────────────  ───────────────────────────────');
    for (const d of r.detail) {
      const exp = d.options[d.expected] ?? '?';
      const obs = d.observed === null ? '\x1b[2m(rewritten away)\x1b[0m' : d.options[d.observed];
      const mark = d.observed === null ? '?' : d.observed === d.expected ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
      say(`${String(d.slot).padEnd(4)}  ${exp.slice(0, 27).padEnd(27)}  ${String(obs).slice(0, 40).padEnd(31)} ${mark}`);
    }
  }
}

// The ONE verification path before anything touches an agent directory.
// Renders every check; returns the chain result or dies/skips on failure.
function runInstallVerification(listing, bundle, { die: fatal }) {
  const chain = verifyBundleChain({ listing, bundle, preferSpector: process.env.ALLODIC_SCANNER !== 'builtin' });
  for (const ch of chain.checks) say(`${ch.ok ? '✓' : '✗'} ${ch.name}${ch.detail ? '  ' + ch.detail : ''}`);
  if (!chain.ok) {
    const msg = `verification failed (${chain.mandatoryFailed.length}): ${chain.mandatoryFailed.join('; ')} — refusing to install. Nothing was written. Run \`allodic verify\` and contact the creator.`;
    if (typeof fatal === 'function') fatal(msg);
    if (fatal) die(msg, { stage: 'verification', reason: 'verification_failed' });
    say(`✗ ${msg}`);
    return null;
  }
  return chain;
}

// ---------------- buyer ----------------
async function cmdAdd(args) {
  const url = args[0] ?? die('Usage: allodic add <listing-url>', { stage: 'arguments', reason: 'invalid_input' });
  const listing = await api(toApiListing(url));
  const server = url.replace(/\/s\/[^/]+\/?$/, '');
  say(`${clr.bold(listing.name)} ${clr.dim(`v${listing.version}`)} — ${clr.gold(listing.price === 0 ? 'free' : '$' + (listing.price / 100).toFixed(2))} ${clr.dim(`— by ${listing.creator}`)}`);

  let token = loadCreds()[server];
  let licenseFlow = token ? 'existing_token' : 'unknown';
  let bundleRes = token && (await tryBundle(server, listing.slug, token));

  if (!bundleRes) {
    // Already authenticated on this server? Then the problem is a missing
    // purchase, not identity — say so instead of re-prompting for email.
    if (token && listing.price > 0) {
      die(`No license for ${listing.slug} on this account.\n  Buy it: ${server}/buy/${listing.slug}\n  (Licenses are per-skill; your existing license covers other purchases only.)`,
          { stage: 'license', reason: 'license_unavailable' });
    }
    ({ token, flow: licenseFlow } = await acquireLicense(server, listing));
    bundleRes = await tryBundle(server, listing.slug, token);
    if (!bundleRes) die('License valid but bundle fetch failed — contact the creator.', { stage: 'bundle', reason: 'bundle_fetch_failed' });
    saveCreds(server, token);
  }

  const chain = runInstallVerification(listing, bundleRes, {
    die: (m) => die(m, { stage: 'verification', reason: 'verification_failed' }),
  });
  const manifest = chain.manifest;
  const keyId = sha256(listing.publicKeyPem).slice(0, 16);
  say(`✓ Verified before install (creator: ${manifest.creator}, key ${keyId.slice(0, 8)}) · fingerprint ${manifest.fingerprint}`);

  const targets = AGENT_DIRS.filter((a) => existsSync(join(a.dir, '..')));
  const chosen = targets.length ? targets : [AGENT_DIRS[0]];
  for (const t of chosen) {
    const dest = join(t.dir, listing.slug);
    installBundle(manifest, dest);
    say(`✓ Installed to ${t.agent} → ${clr.cyan(dest)}`);
  }
  recordInstall({ server, slug: listing.slug, version: manifest.version, keyId });
  await deliveryEvent(server, token, listing.slug, 'install', manifest.version, chosen.map((t) => t.agent));
  const first = join(chosen[0].dir, listing.slug);
  say(`\nDone. Updates: ${clr.cyan('npx allodic update')}`);
  say(`Other agents: npx skills add ${first}`);
  // Success only after verified installation + persisted install state. Agent
  // names come from the fixed AGENT_DIRS list, already allowlist-shaped.
  return { event: 'cli_add_succeeded', props: {
    paid: listing.price > 0,
    license_flow: licenseFlow,
    agents: chosen.map((t) => t.agent),
    agent_count_bucket: bucketAgents(chosen.length),
  } };
}

/** Returns { token, flow } where flow ∈ existing_token | instant_checkout |
 *  activation | unknown — an allowlisted classification for telemetry, never
 *  the token, email, or URL. */
async function acquireLicense(server, listing) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const email = (await rl.question('Email for your license: ')).trim();

  // Try instant checkout (free skills / manual provider); fall back to activation.
  const co = await api(`${server}/api/checkout/${listing.slug}`, { method: 'POST', body: { email } }).catch(() => null);
  if (co?.status === 'paid') { rl.close(); say(`✓ License issued (order ${co.order})`); return { token: co.token, flow: 'instant_checkout' }; }
  if (co?.status === 'redirect') {
    say(`\nComplete payment in your browser:\n  ${co.url}\n`);
    say('When done, activate this device:');
  }
  let fin;
  try {
    const start = await api(`${server}/api/activate/start`, { method: 'POST', body: { email } });
    const hint = start.code ? ` (dev server says: ${start.code})` : '';
    const code = (await rl.question(`Enter the activation code sent to ${email}${hint}: `)).trim();
    rl.close();
    fin = await api(`${server}/api/activate/finish`, { method: 'POST', body: { code } });
  } catch (e) {
    rl.close();
    die(e.message, { stage: 'license', reason: 'activation_failed' });
  }
  say('✓ Device activated');
  return { token: fin.token, flow: 'activation' };
}

async function cmdUpdate() {
  const installs = existsSync(INSTALLS) ? JSON.parse(readFileSync(INSTALLS, 'utf8')) : [];
  if (!installs.length) return say('Nothing installed via allodic yet.');
  const creds = loadCreds();
  // One aggregate telemetry event per update run — coarse bucketed counts
  // only, never per-skill events, names, versions, or error text.
  const tally = { updated: 0, current: 0, failed: 0 };
  for (const inst of installs) {
    const token = creds[inst.server];
    if (!token) { say(`~ ${inst.slug}: not activated on this device`); tally.failed++; continue; }
    const u = await api(`${inst.server}/api/updates/${inst.slug}?version=${inst.version}`, { token }).catch((e) => ({ error: e.message }));
    if (u.error) { say(`~ ${inst.slug}: ${u.error}`); tally.failed++; continue; }
    if (!u.updateAvailable) { say(`= ${inst.slug} ${inst.version} is current`); tally.current++; continue; }
    const bundleRes = await tryBundle(inst.server, inst.slug, token);
    const listing = await api(`${inst.server}/api/s/${inst.slug}`);
    if (inst.keyId && sha256(listing.publicKeyPem).slice(0, 16) !== inst.keyId) {
      say(`✗ ${inst.slug}: PUBLISHER KEY CHANGED (pinned ${inst.keyId.slice(0, 8)}, server now ${sha256(listing.publicKeyPem).slice(0, 8)}) — update refused. Investigate before trusting.`);
      tally.failed++;
      continue;
    }
    const chain = runInstallVerification(listing, bundleRes, { die: false });
    if (!chain) { tally.failed++; continue; } // verification failed: this skill is skipped, agent dirs untouched
    const manifest = chain.manifest;
    for (const t of AGENT_DIRS.filter((a) => existsSync(join(a.dir, inst.slug)))) {
      installBundle(manifest, join(t.dir, inst.slug));
    }
    inst.version = manifest.version;
    await deliveryEvent(inst.server, token, inst.slug, 'update', manifest.version,
      AGENT_DIRS.filter((a) => existsSync(join(a.dir, inst.slug))).map((a) => a.agent));
    say(`✓ ${inst.slug} → ${manifest.version} (licensed update)`);
    tally.updated++;
  }
  writeFileSync(INSTALLS, JSON.stringify(installs, null, 2));
  // "completed", not "succeeded": update runs may partially succeed.
  return { event: 'cli_update_completed', props: {
    installed_bucket: bucketCount(installs.length),
    updated_bucket: bucketCount(tally.updated),
    current_bucket: bucketCount(tally.current),
    failed_bucket: bucketCount(tally.failed),
  } };
}

// ---------------- plumbing ----------------
function toApiListing(url) {
  return url.includes('/api/s/') ? url : url.replace(/\/s\//, '/api/s/');
}
function serverUrl() { return (process.env.ALLODIC_SERVER ?? 'http://localhost:8787').replace(/\/$/, ''); }
async function tryBundle(server, slug, token) {
  try { return await api(`${server}/api/bundle/${slug}`, { token }); } catch { return null; }
}
async function api(url, { method = 'GET', headers = {}, body, token } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data;
}
async function deliveryEvent(server, token, slug, event, version, agents) {
  // Publisher delivery events obey the SAME shared setting as Allodic product
  // telemetry — one switch controls both automatic destinations.
  if (!isAutomaticReportingEnabled()) return;
  try {
    // Hard 2 s bound on the WHOLE exchange: a registry that accepts the
    // connection and then stalls cannot hang `add` or `update`.
    await boundedPost(`${server}/api/events/${slug}`, { token, body: { event, version, agents }, timeoutMs: 2000 });
    say(`  (delivery event shared with creator: ${event}, agents — opt out: allodic telemetry disable)`);
  } catch { /* best-effort: never block an install on telemetry */ }
}

function loadCreds() {
  hardenSecret(CREDS); // repair 0644 files written before secure storage
  return existsSync(CREDS) ? JSON.parse(readFileSync(CREDS, 'utf8')) : {};
}
function saveCreds(server, token) {
  // Bearer tokens: 0600, atomically replaced, inside a 0700 ~/.allodic.
  writeSecretJson(CREDS, { ...loadCreds(), [server]: token });
}
function recordInstall(entry) {
  secureDir(HOME); // installs.json isn't secret, but the dir protects credentials.json beside it
  const list = existsSync(INSTALLS) ? JSON.parse(readFileSync(INSTALLS, 'utf8')) : [];
  const i = list.findIndex((x) => x.server === entry.server && x.slug === entry.slug);
  if (i >= 0) list[i] = entry; else list.push(entry);
  writeFileSync(INSTALLS, JSON.stringify(list, null, 2));
}
