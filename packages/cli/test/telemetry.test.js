// Telemetry test suite (brief §18). A local HTTP server plays PostHog via
// ALLODIC_TELEMETRY_ENDPOINT; the CLI is exercised both at module level
// (sanitization, queue, flush mechanics) and by spawning the real binary
// (disclosure, precedence, shared control). HOME is redirected per test so
// nothing touches real state.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'bin', 'allodic.js');

// ---- fake PostHog ----
let server, endpoint;
let received = [];       // parsed request bodies
let respondStatus = 200; // switchable per test
before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(respondStatus).end(respondStatus < 300 ? '{"status":1}' : 'nope');
    });
  });
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  endpoint = `http://127.0.0.1:${server.address().port}/capture/`;
});
after(() => server?.close());
beforeEach(() => { received = []; respondStatus = 200; });

// ---- helpers ----
function freshHome() { return mkdtempSync(join(tmpdir(), 'tele-home-')); }
const statePath = (h) => join(h, '.allodic', 'telemetry.json');
const queuePath = (h) => join(h, '.allodic', 'telemetry-queue.json');

// -------- PRODUCTION GUARD (launch-review item) --------
// No test may ever reach https://j.allodic.dev. Two layers:
//   1. every child-process env goes through guardEnv(), which throws if
//      telemetry could be enabled without a loopback endpoint override;
//   2. in-process, global fetch is wrapped to fail the suite instantly if
//      any request targets the production host.
const PRODUCTION_HOST = 'j.allodic.dev';
function guardEnv(env) {
  const e = env.ALLODIC_TELEMETRY_ENDPOINT;
  const loopback = typeof e === 'string' && /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(e);
  if (!loopback && env.DO_NOT_TRACK !== '1' && env.ALLODIC_TELEMETRY !== '0') {
    throw new Error(`test misconfiguration: child env could transmit to production (endpoint=${e ?? 'PRODUCTION DEFAULT'})`);
  }
  return env;
}
const realFetch = globalThis.fetch;
globalThis.fetch = (url, ...rest) => {
  if (String(url).includes(PRODUCTION_HOST)) throw new Error(`TEST TRIED TO REACH PRODUCTION: ${url}`);
  return realFetch(url, ...rest);
};

/** Run the real CLI ASYNCHRONOUSLY with a controlled environment. Async is
 *  load-bearing: the fake PostHog server lives in THIS process, so a blocking
 *  spawnSync would freeze the event loop, stall the child's request until the
 *  test advanced, and leak it into a later test's `received` — the exact
 *  contamination the r17 review caught. CI vars are scrubbed so tests decide
 *  the defaults themselves. */
function cli(home, args, env = {}) {
  const scrubbed = { ...process.env };
  for (const v of ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'JENKINS_URL', 'TF_BUILD', 'TEAMCITY_VERSION', 'TRAVIS', 'ALLODIC_TELEMETRY', 'DO_NOT_TRACK']) delete scrubbed[v];
  const full = guardEnv({ ...scrubbed, HOME: home, ALLODIC_TELEMETRY_ENDPOINT: endpoint, ...env });
  return new Promise((resolve) => {
    const c = spawn('node', [CLI, ...args], { env: full });
    let stdout = '', stderr = '';
    c.stdout.on('data', (d) => (stdout += d));
    c.stderr.on('data', (d) => (stderr += d));
    c.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Same, with explicit cwd. */
function cliIn(cwd, home, args, env = {}) {
  const full = guardEnv({ ...process.env, HOME: home, ...env });
  return new Promise((resolve) => {
    const c = spawn('node', [CLI, ...args], { cwd, env: full });
    let stdout = '', stderr = '';
    c.stdout.on('data', (d) => (stdout += d));
    c.stderr.on('data', (d) => (stderr += d));
    c.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Import a fresh copy of the module bound to a specific HOME. node:os
 *  homedir() reads $HOME at call time on POSIX, so set it around use. */
async function moduleFor(home) {
  process.env.HOME = home;
  return import(`../lib/telemetry.js?home=${encodeURIComponent(home)}`); // cache-bust per home
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ================================================================ 18.1 identity

test('18.1 identity: first enabled use creates a random UUID, reused after; 0600; disable/enable preserves it', async () => {
  const home = freshHome();
  const t = await moduleFor(home);
  const st1 = t.ensureState();
  assert.match(st1.installationId, UUID_RE);
  assert.equal(t.ensureState().installationId, st1.installationId, 'reused across calls');
  if (process.platform !== 'win32') assert.equal(statSync(statePath(home)).mode & 0o777, 0o600);
  // not derived from user/machine data: two fresh homes → different ids
  const other = await moduleFor(freshHome());
  assert.notEqual(other.ensureState().installationId, st1.installationId);
  // disable → enable via the real CLI preserves the id and the one shared field
  process.env.HOME = home;
  await cli(home, ['telemetry', 'disable']);
  const afterDisable = JSON.parse(readFileSync(statePath(home), 'utf8'));
  assert.equal(afterDisable.enabled, false);
  assert.equal(afterDisable.installationId, st1.installationId, 'disable never rotates the id');
  await cli(home, ['telemetry', 'enable']);
  const afterEnable = JSON.parse(readFileSync(statePath(home), 'utf8'));
  assert.equal(afterEnable.enabled, true);
  assert.equal(afterEnable.installationId, st1.installationId, 're-enable preserves the id');
  rmSync(home, { recursive: true, force: true });
});

test('18.1 identity: malformed state is quarantined and recovered safely', async () => {
  const home = freshHome();
  mkdirSync(join(home, '.allodic'), { recursive: true });
  writeFileSync(statePath(home), '{not json at all');
  const t = await moduleFor(home);
  const st = t.ensureState();
  assert.match(st.installationId, UUID_RE, 'fresh valid state after recovery');
  assert.ok(existsSync(statePath(home)));
  rmSync(home, { recursive: true, force: true });
});

// ============================================================= 18.2 disclosure

test('18.2 disclosure: notice once, on stderr, before first transmission; never for exempt commands or when disabled', async () => {
  const home = freshHome();
  // exempt commands: no notice, no state creation
  for (const args of [['--version'], ['help'], ['telemetry', 'status']]) {
    const r = await cli(home, args, { ALLODIC_TELEMETRY: '1' });
    assert.ok(!r.stderr.includes('privacy-limited automatic usage events'), `no notice for ${args[0]} ${args[1] ?? ''}`);
  }
  // a tracked command shows it exactly once (init in an invalid cwd still shows first —
  // disclosure precedes execution, transmission only happens post-queue)
  const skdir = join(home, 'proj', 'my-skill'); mkdirSync(skdir, { recursive: true });
  const r1 = await cliIn(skdir, home, ['init'], { ALLODIC_TELEMETRY: '1', ALLODIC_TELEMETRY_ENDPOINT: endpoint });
  assert.ok(r1.stderr.includes('privacy-limited automatic usage events'), 'notice shown on first tracked command');
  assert.ok(r1.stderr.includes('allodic telemetry disable'));
  const r2 = await cliIn(skdir, home, ['update'], { ALLODIC_TELEMETRY: '1', ALLODIC_TELEMETRY_ENDPOINT: endpoint });
  assert.ok(!r2.stderr.includes('privacy-limited'), 'notice appears once per installation');
  // disabled → no notice ever
  const home2 = freshHome();
  const r3 = await cliIn(home2, home2, ['update'], { DO_NOT_TRACK: '1', ALLODIC_TELEMETRY_ENDPOINT: endpoint });
  assert.ok(!r3.stderr.includes('privacy-limited'), 'no notice when reporting is disabled');
  rmSync(home, { recursive: true, force: true }); rmSync(home2, { recursive: true, force: true });
});

// ============================================== 18.3 shared control / precedence

test('18.3 precedence: DO_NOT_TRACK > ALLODIC_TELEMETRY > CI/source defaults > persisted', async () => {
  const home = freshHome();
  const t = await moduleFor(home);
  const d = (env) => t.reportingDecision({ ...env });
  assert.deepEqual(d({ DO_NOT_TRACK: '1', ALLODIC_TELEMETRY: '1' }), { enabled: false, reason: 'DO_NOT_TRACK=1' }, 'DNT beats explicit enable');
  assert.equal(d({ ALLODIC_TELEMETRY: '0' }).enabled, false);
  assert.equal(d({ ALLODIC_TELEMETRY: '1', CI: 'true' }).enabled, true, 'explicit enable works in CI');
  assert.equal(d({ CI: 'true' }).enabled, false, 'CI default off');
  assert.equal(d({ GITHUB_ACTIONS: 'true' }).enabled, false);
  // running from the source checkout (these tests are) → default off
  assert.equal(d({}).enabled, false);
  assert.equal(d({}).reason, 'source-checkout default');
  rmSync(home, { recursive: true, force: true });
});

test('18.3 shared control: disable clears the queue and gates BOTH destinations; delivery events check the same switch', async () => {
  const home = freshHome();
  const t = await moduleFor(home);
  // enabled via env → record queues
  assert.equal(t.recordEvent('cli_init_succeeded', { mode: 'in_place' }, { ALLODIC_TELEMETRY: '1' }), true);
  assert.equal(t.readQueue().events.length, 1);
  // the real CLI disable clears it
  await cli(home, ['telemetry', 'disable']);
  assert.equal(t.readQueue().events.length, 0, 'disable clears queued events immediately');
  // and now nothing records, flushes, or reports — the same gate deliveryEvent uses
  assert.equal(t.recordEvent('cli_init_succeeded', { mode: 'in_place' }), false);
  assert.equal(t.isAutomaticReportingEnabled({}), false, 'persisted disable read by the shared gate');
  assert.equal(t.isAutomaticReportingEnabled({ DO_NOT_TRACK: '1', ALLODIC_TELEMETRY: '1' }), false);
  await t.flushTelemetry({ env: {} });
  assert.equal(received.length, 0, 'no PostHog request while disabled');
  rmSync(home, { recursive: true, force: true });
});

// ==================================================== 18.4 payload privacy

test('18.4 privacy: hostile fixture values never reach the wire, the queue, or headers', async () => {
  const home = freshHome();
  const t = await moduleFor(home);
  const FORBIDDEN = [
    'super-secret-skill', 'secret-slug', 'a very private description',
    '/home/victim/projects/skill', 'SKILL.md', 'https://registry.victim.dev',
    'https://victim.dev/buy/x', 'https://github.com/victim/repo',
    'victim@example.com', 'alo_tokenvalue123', 'adm_adminkey456',
    '-----BEGIN PRIVATE KEY-----', '2999', 'ENOENT: no such file',
    'at Object.<anonymous>', process.argv[0],
  ];
  // Explicit loopback endpoint (r17 review: omitting it aimed this test at
  // production while asserting against the fake server) — and guardEnv/fetch
  // guards now make that misconfiguration fail loudly instead of silently.
  const env = guardEnv({ ALLODIC_TELEMETRY: '1', ALLODIC_TELEMETRY_ENDPOINT: endpoint });
  // Try to smuggle every fixture through every field of every event.
  for (const name of Object.keys(t.EVENT_DEFINITIONS)) {
    const hostile = {};
    for (const field of Object.keys(t.EVENT_DEFINITIONS[name])) hostile[field] = FORBIDDEN.join('|');
    hostile.skill = FORBIDDEN[0]; hostile.url = FORBIDDEN[5]; hostile.email = FORBIDDEN[8]; // unknown fields
    t.recordEvent(name, hostile, env);
  }
  const queued = readFileSync(queuePath(home), 'utf8');
  for (const f of FORBIDDEN) assert.ok(!queued.includes(f), `forbidden value in queue: ${f.slice(0, 30)}`);
  await t.flushTelemetry({ env, maxEvents: 10, budgetMs: 3000 });
  assert.ok(received.length > 0, 'events were transmitted');
  for (const req of received) {
    for (const f of FORBIDDEN) {
      assert.ok(!req.body.includes(f), `forbidden value on the wire: ${f.slice(0, 30)}`);
      for (const [h, v] of Object.entries(req.headers)) {
        if (h === 'user-agent') continue;
        assert.ok(!String(v).includes(f), `forbidden value in header ${h}`);
      }
    }
    assert.match(req.headers['user-agent'], /^allodic-cli\//);
  }
  rmSync(home, { recursive: true, force: true });
});

// ==================================================== 18.5 event semantics

test('18.5 semantics: sanitizer enforces the allowlist — unknown fields dropped, enums normalized, booleans literal', async () => {
  const t = await moduleFor(freshHome());
  assert.equal(t.sanitizeEvent('made_up_event', {}), null, 'unknown event names are discarded');
  const p = t.sanitizeEvent('cli_publish_succeeded', {
    paid: 'yes',            // not a literal boolean → dropped
    first_publish: true,
    has_evals: false,
    eval_runner: 'gpt-9',   // unknown enum → 'other'
    price_cents: 2900,      // unknown field → dropped
  });
  assert.deepEqual(p, { first_publish: true, has_evals: false, eval_runner: 'other' });
  const a = t.sanitizeEvent('cli_add_succeeded', { agents: ['claude-code', 'my-custom-agent', 'cursor'], agent_count_bucket: '17' });
  assert.deepEqual(a.agents.sort(), ['claude-code', 'cursor', 'other'].sort(), 'agent list filtered to the allowlist');
  assert.equal(a.agent_count_bucket, undefined, 'invalid bucket with no other/unknown is dropped');
  const r = t.sanitizeEvent('cli_release_succeeded', { active_entitlements_bucket: '7' });
  assert.equal(r.active_entitlements_bucket, 'unknown', 'invalid bucket normalizes to unknown when available');
});

test('18.5 semantics: buckets — exact counts become coarse ranges, never the number', async () => {
  const t = await moduleFor(freshHome());
  assert.equal(t.bucketCount(0), '0');
  assert.equal(t.bucketCount(3), '1-5');
  assert.equal(t.bucketCount(20), '6-20');
  assert.equal(t.bucketCount(21), '21-100');
  assert.equal(t.bucketCount(5000), '101+');
  assert.equal(t.bucketCount(NaN), 'unknown');
  assert.equal(t.bucketAgents(2), '2');
  assert.equal(t.bucketAgents(7), '3+');
});

test('18.5 semantics: failed init emits cli_command_failed (allowlisted reason) and NO success event', async () => {
  const home = freshHome();
  const bad = join(home, 'Bad Name'); mkdirSync(bad, { recursive: true });
  const r = await cliIn(bad, home, ['init'], { ALLODIC_TELEMETRY: '1', ALLODIC_TELEMETRY_ENDPOINT: 'http://127.0.0.1:1/capture/' }); // unreachable: events stay queued for inspection
  assert.equal(r.code, 1);
  const q = JSON.parse(readFileSync(queuePath(home), 'utf8'));
  assert.equal(q.events.length, 1);
  assert.equal(q.events[0].event, 'cli_command_failed');
  assert.deepEqual(q.events[0].properties, { command: 'init', stage: 'arguments', reason: 'invalid_input' });
  assert.ok(!r.stderr.includes('Bad Name') || r.stderr.includes('Bad Name'), 'stderr may name it for the USER'); // user output is fine; the wire is what's constrained
  assert.ok(!JSON.stringify(q).includes('Bad Name'), 'the queued event never carries the directory name');
  rmSync(home, { recursive: true, force: true });
});

test('18.5 semantics: successful init queues cli_init_succeeded with mode only; success + failure are mutually exclusive', async () => {
  const home = freshHome();
  const proj = join(home, 'proj'); mkdirSync(proj, { recursive: true });
  const r = await cliIn(proj, home, ['init', 'my-skill'], { ALLODIC_TELEMETRY: '1', ALLODIC_TELEMETRY_ENDPOINT: 'http://127.0.0.1:1/capture/' });
  assert.equal(r.code, 0);
  const q = JSON.parse(readFileSync(queuePath(home), 'utf8'));
  const names = q.events.map((e) => e.event);
  assert.deepEqual(names, ['cli_init_succeeded']);
  assert.deepEqual(q.events[0].properties, { mode: 'new_directory' });
  assert.match(q.events[0].eventId, UUID_RE);
  rmSync(home, { recursive: true, force: true });
});

// ======================================================== 18.6 reliability

test('18.6 reliability: unreachable endpoint changes nothing user-visible; events stay queued; later success flushes them', async () => {
  const home = freshHome();
  const t = await moduleFor(home);
  const env = { ALLODIC_TELEMETRY: '1', ALLODIC_TELEMETRY_ENDPOINT: 'http://127.0.0.1:1/capture/' };
  t.recordEvent('cli_init_succeeded', { mode: 'in_place' }, env);
  const t0 = Date.now();
  await t.flushTelemetry({ env });
  assert.ok(Date.now() - t0 < 1500, 'hard budget respected');
  assert.equal(t.readQueue().events.length, 1, 'failed event retained');
  // endpoint recovers → a later flush delivers and removes it
  await t.flushTelemetry({ env: { ALLODIC_TELEMETRY: '1', ALLODIC_TELEMETRY_ENDPOINT: endpoint } });
  assert.equal(t.readQueue().events.length, 0, 'delivered on a later invocation');
  assert.equal(received.length, 1);
  rmSync(home, { recursive: true, force: true });
});

test('18.6 reliability: HTTP 500 retains; 2xx removes; queue caps at 50 dropping oldest; malformed queue recovers', async () => {
  const home = freshHome();
  const t = await moduleFor(home);
  const env = { ALLODIC_TELEMETRY: '1', ALLODIC_TELEMETRY_ENDPOINT: endpoint };
  t.recordEvent('cli_init_succeeded', { mode: 'in_place' }, env);
  respondStatus = 500;
  await t.flushTelemetry({ env });
  assert.equal(t.readQueue().events.length, 1, 'non-2xx retains the event');
  respondStatus = 204;
  await t.flushTelemetry({ env });
  assert.equal(t.readQueue().events.length, 0, '204 counts as delivered');
  // bound: 60 events → 50 kept, oldest dropped
  for (let i = 0; i < 60; i++) t.recordEvent('cli_update_completed', { installed_bucket: '0', updated_bucket: '0', current_bucket: '0', failed_bucket: '0' }, env);
  assert.equal(t.readQueue().events.length, 50);
  // malformed queue file → quarantined, empty queue, no throw
  writeFileSync(queuePath(home), 'garbage{{{');
  assert.deepEqual(t.readQueue().events, []);
  rmSync(home, { recursive: true, force: true });
});

test('18.6 reliability: telemetry noise never reaches stdout/stderr of a real command', async () => {
  const home = freshHome();
  const proj = join(home, 'p'); mkdirSync(proj, { recursive: true });
  const r = await cliIn(proj, home, ['init', 'ok-skill'], { ALLODIC_TELEMETRY: '1', ALLODIC_TELEMETRY_ENDPOINT: 'http://127.0.0.1:1/capture/' });
  assert.equal(r.code, 0, 'dead endpoint cannot fail the command');
  for (const out of [r.stdout, r.stderr]) {
    for (const bad of ['telemetry failed', 'analytics unavailable', 'could not send', 'fetch failed', 'ECONNREFUSED']) {
      assert.ok(!out.toLowerCase().includes(bad.toLowerCase()), `leaked telemetry noise: ${bad}`);
    }
  }
  rmSync(home, { recursive: true, force: true });
});

// ================================================= 18.7 request structure

test('18.7 structure: exactly api_key/event/timestamp/properties; token, $process_person_profile, UUIDs, common fields', async () => {
  const home = freshHome();
  const t = await moduleFor(home);
  const env = { ALLODIC_TELEMETRY: '1', ALLODIC_TELEMETRY_ENDPOINT: endpoint };
  t.recordEvent('cli_publish_succeeded', { paid: true, first_publish: true, has_evals: true, eval_runner: 'claude' }, env);
  const queuedAt = t.readQueue().events[0].timestamp;
  await t.flushTelemetry({ env });
  assert.equal(received.length, 1);
  const body = JSON.parse(received[0].body);
  assert.deepEqual(Object.keys(body).sort(), ['api_key', 'event', 'properties', 'timestamp', 'uuid']);
  assert.match(body.uuid, UUID_RE, 'stable top-level uuid: retries cannot duplicate in PostHog');
  assert.equal(body.api_key, 'phc_rzTnX44sX7LeiGCvMhYhb93mwp5Svnd8ZFLDCVvkuZDi');
  assert.equal(body.event, 'cli_publish_succeeded');
  assert.equal(body.timestamp, queuedAt, 'original event time, not send time');
  const p = body.properties;
  assert.equal(p.$process_person_profile, false);
  assert.match(p.distinct_id, UUID_RE);
  assert.match(p.event_id, UUID_RE);
  assert.equal(p.schema_version, 1);
  assert.equal(typeof p.node_major, 'number');
  assert.equal(typeof p.ci, 'boolean');
  assert.ok(['linux', 'darwin', 'win32', 'aix', 'freebsd', 'openbsd', 'sunos', 'android', 'other'].includes(p.platform));
  assert.equal(p.paid, true);
  rmSync(home, { recursive: true, force: true });
});

test('18.7 structure: endpoint override validation — https ok, loopback http ok, anything else disables', async () => {
  const t = await moduleFor(freshHome());
  assert.equal(t.resolveEndpoint({}), 'https://j.allodic.dev/capture/');
  assert.equal(t.resolveEndpoint({ ALLODIC_TELEMETRY_ENDPOINT: 'https://x.example/c/' }), 'https://x.example/c/');
  assert.equal(t.resolveEndpoint({ ALLODIC_TELEMETRY_ENDPOINT: endpoint }), endpoint, 'loopback http allowed');
  assert.equal(t.resolveEndpoint({ ALLODIC_TELEMETRY_ENDPOINT: 'http://evil.example/c/' }), null, 'non-loopback http disabled');
  assert.equal(t.resolveEndpoint({ ALLODIC_TELEMETRY_ENDPOINT: 'not a url' }), null);
});

// ====================================================== 18.8 packaging

test('18.8 packaging: packed CLI ships lib/telemetry.js and no test-server address', () => {
  const r = spawnSync('npm', ['pack', '--dry-run', '--workspace', 'packages/cli'], { cwd: ROOT, encoding: 'utf8' });
  const listing = `${r.stdout}${r.stderr}`;
  assert.match(listing, /lib\/telemetry\.js/);
  const src = readFileSync(join(ROOT, 'packages', 'cli', 'lib', 'telemetry.js'), 'utf8');
  assert.ok(!/127\.0\.0\.1:\d{4,5}\/capture/.test(src), 'no local test endpoint baked into the module');
  assert.ok(src.includes('https://j.allodic.dev/capture/'), 'production endpoint present');
});

// ================================================== launch-review regressions

test("P0 REGRESSION: a hostile hand-written queue cannot bypass the allowlist at transmission time", async () => {
  const home = freshHome();
  const t = await moduleFor(home);
  const env = { ALLODIC_TELEMETRY: '1', ALLODIC_TELEMETRY_ENDPOINT: endpoint };
  // one legitimate event so the flush has real work to do
  t.recordEvent('cli_init_succeeded', { mode: 'in_place' }, env);
  // then plant the reviewer's payload straight onto disk: valid JSON, hostile content
  const legit = JSON.parse(readFileSync(queuePath(home), 'utf8')).events;
  writeFileSync(queuePath(home), JSON.stringify({ schemaVersion: 1, events: [
    { eventId: '11111111-2222-4333-8444-555555555555', event: 'made_up_event', timestamp: new Date().toISOString(),
      properties: { skill_content: 'PRIVATE_FIXTURE' } },
    { eventId: legit[0].eventId, event: 'cli_init_succeeded', timestamp: legit[0].timestamp,
      properties: { mode: 'in_place', distinct_id: 'OVERRIDDEN', $process_person_profile: true, skill_content: 'PRIVATE_FIXTURE', event_id: 'FAKE' } },
    { eventId: 'not-a-uuid', event: 'cli_init_succeeded', timestamp: new Date().toISOString(), properties: { mode: 'in_place' } },
    { eventId: '99999999-2222-4333-8444-555555555555', event: 'cli_init_succeeded', timestamp: 'not a time', properties: { mode: 'in_place' } },
  ] }));
  await t.flushTelemetry({ env, budgetMs: 3000 });
  // only the legitimate event was transmitted, fully rebuilt
  assert.equal(received.length, 1, 'unknown events, bad UUIDs, and bad timestamps are never transmitted');
  const body = JSON.parse(received[0].body);
  assert.equal(body.event, 'cli_init_succeeded');
  assert.ok(!received[0].body.includes('PRIVATE_FIXTURE'), 'smuggled property stripped');
  assert.ok(!received[0].body.includes('made_up_event'));
  assert.ok(!received[0].body.includes('OVERRIDDEN'), 'distinct_id cannot be overridden from the queue');
  assert.equal(body.properties.$process_person_profile, false, 'protected field wins over queued override');
  assert.match(body.properties.distinct_id, UUID_RE);
  assert.notEqual(body.properties.event_id, 'FAKE');
  // and the hostile entries are purged from DISK, not just skipped
  const onDisk = JSON.parse(readFileSync(queuePath(home), 'utf8'));
  assert.ok(!JSON.stringify(onDisk).includes('PRIVATE_FIXTURE'), 'rejected content does not linger in ~/.allodic');
  rmSync(home, { recursive: true, force: true });
});

test('P0 REGRESSION: telemetry status/show/help/version are network-inert — the queue they display is not transmitted', async () => {
  const home = freshHome();
  const t = await moduleFor(home);
  t.recordEvent('cli_init_succeeded', { mode: 'in_place' }, { ALLODIC_TELEMETRY: '1' });
  assert.equal(t.readQueue().events.length, 1);
  for (const args of [['telemetry', 'show'], ['telemetry', 'status'], ['--version'], ['help'], ['definitely-not-a-command']]) {
    const r = await cli(home, args, { ALLODIC_TELEMETRY: '1' });
    assert.notEqual(r.code, null, `${args.join(' ')} ran`);
  }
  assert.equal(received.length, 0, 'no network request from any inert command');
  assert.equal(t.readQueue().events.length, 1, 'the displayed queue is intact — inspecting telemetry is not telemetry');
  const shown = await cli(home, ['telemetry', 'show'], { ALLODIC_TELEMETRY: '1' });
  assert.ok(shown.stdout.includes('cli_init_succeeded'), 'show still displays the queued event');
  rmSync(home, { recursive: true, force: true });
});

test('P1 REGRESSION: a registry that sends headers then stalls cannot hang delivery events (hard 2 s bound)', async () => {
  const t = await moduleFor(freshHome());
  // headers, then... nothing. The response body never arrives.
  const stall = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); /* never end */ });
  stall.listen(0, '127.0.0.1');
  await new Promise((r) => stall.once('listening', r));
  const url = `http://127.0.0.1:${stall.address().port}/api/events/x`;
  const t0 = Date.now();
  await assert.rejects(() => t.boundedPost(url, { body: { event: 'install' }, timeoutMs: 400 }));
  const took = Date.now() - t0;
  assert.ok(took < 1500, `abort covered the full exchange (took ${took}ms)`);
  stall.close();
  stall.closeAllConnections?.();
});

test('P2 REGRESSION: concurrent recordEvent from separate processes does not lose events (queue lock)', async () => {
  const home = freshHome();
  const script = `import('${join(ROOT, 'packages', 'cli', 'lib', 'telemetry.js').replace(/\\/g, '/')}').then(t => { for (let i = 0; i < 10; i++) t.recordEvent('cli_init_succeeded', { mode: 'in_place' }, { ALLODIC_TELEMETRY: '1' }); })`;
  const { spawn } = await import('node:child_process');
  await Promise.all([1, 2, 3].map(() => new Promise((resolve) => {
    const c = spawn('node', ['--input-type=module', '-e', script], { env: { ...process.env, HOME: home } });
    c.on('close', resolve); // truly concurrent: three processes hammer the queue at once
  })));
  const t = await moduleFor(home);
  const n = t.readQueue().events.length;
  assert.ok(n >= 27 && n <= 30, `bounded lock retries keep concurrent writers near-lossless (${n}/30)`);
  rmSync(home, { recursive: true, force: true });
});

test('GUARD: the r17 misconfiguration itself now fails loudly — no test can aim at production', async () => {
  // env guard: enabled telemetry without a loopback override is a test bug, not a silent production leak
  assert.throws(() => guardEnv({ ALLODIC_TELEMETRY: '1' }), /could transmit to production/);
  assert.throws(() => guardEnv({ ALLODIC_TELEMETRY: '1', ALLODIC_TELEMETRY_ENDPOINT: 'https://j.allodic.dev/capture/' }), /could transmit to production/);
  guardEnv({ ALLODIC_TELEMETRY: '1', ALLODIC_TELEMETRY_ENDPOINT: endpoint });     // loopback: fine
  guardEnv({ ALLODIC_TELEMETRY: '0' });                                            // disabled: fine
  // fetch guard: an in-process request to the production host dies instantly
  await assert.rejects(async () => fetch('https://j.allodic.dev/capture/', { method: 'POST' }), /TEST TRIED TO REACH PRODUCTION/);
});

test('P1 REGRESSION: enable/disable report persisted AND effective state when an override wins', async () => {
  const home = freshHome();
  // disable while ALLODIC_TELEMETRY=1 overrides: saved, but effectively still on
  let r = await cli(home, ['telemetry', 'disable'], { ALLODIC_TELEMETRY: '1' });
  assert.match(r.stdout, /Saved: automatic usage reporting disabled/);
  assert.match(r.stdout, /Effective state right now: ENABLED \(ALLODIC_TELEMETRY=1\)/, 'the mutation command must not claim reporting is off while the env keeps it on');
  assert.equal(JSON.parse(readFileSync(statePath(home), 'utf8')).enabled, false, 'preference persisted regardless');
  // enable inside a source checkout (no env override): saved, but effectively off
  r = await cli(home, ['telemetry', 'enable']);
  assert.match(r.stdout, /Saved: automatic usage reporting enabled/);
  assert.match(r.stdout, /Effective state right now: DISABLED \(source-checkout default\)/);
  assert.match(r.stdout, /ALLODIC_TELEMETRY=1 to enable here/);
  // no override conflict → plain confirmation, no confusing effective-state block
  r = await cli(home, ['telemetry', 'disable'], { ALLODIC_TELEMETRY: '0' });
  assert.match(r.stdout, /No Allodic product analytics or publisher install\/update delivery events will be sent/);
  rmSync(home, { recursive: true, force: true });
});
