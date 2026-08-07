// allodic CLI — transparent, privacy-limited automatic usage reporting.
//
// Two automatic destinations, ONE shared setting:
//   1. coarse product events → Allodic, via PostHog Cloud EU behind the
//      first-party proxy https://j.allodic.dev/capture/
//   2. install/update delivery events → the relevant publisher's registry
//
// The absolute rules (see docs/telemetry.md for the user-facing contract):
// never skill content, names, slugs, descriptions, paths, URLs, emails,
// credentials, exact prices, raw errors, argv, or env. Events are drawn from
// a frozen allowlist; everything else is discarded before it can be queued.
// Telemetry failure is always swallowed: it must never fail, delay, or
// change the outcome of a command. Installed skills contain none of this.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { secureDir, writeSecretJson, hardenSecret } from '@allodic/core';

export const TELEMETRY_SCHEMA_VERSION = 1;

export const DEFAULT_TELEMETRY_ENDPOINT =
  'https://j.allodic.dev/capture/';

export const POSTHOG_PROJECT_TOKEN =
  'phc_rzTnX44sX7LeiGCvMhYhb93mwp5Svnd8ZFLDCVvkuZDi';

export const MAX_QUEUE_EVENTS = 50;

const HERE = fileURLToPath(import.meta.url);
export const CLI_VERSION = (() => {
  try { return JSON.parse(readFileSync(join(dirname(HERE), '..', 'package.json'), 'utf8')).version; }
  catch { return '0.0.0'; }
})();

const HOME = () => join(homedir(), '.allodic');
const STATE_PATH = () => join(HOME(), 'telemetry.json');
const QUEUE_PATH = () => join(HOME(), 'telemetry-queue.json');

// ---------------------------------------------------------------- endpoint

/** Production default always; ALLODIC_TELEMETRY_ENDPOINT is a test/dev hook.
 *  HTTPS required; HTTP only for loopback. Invalid values disable PostHog
 *  transmission entirely rather than break a command. Returns string|null. */
export function resolveEndpoint(env = process.env) {
  const override = env.ALLODIC_TELEMETRY_ENDPOINT;
  if (!override) return DEFAULT_TELEMETRY_ENDPOINT;
  try {
    const u = new URL(override);
    if (u.protocol === 'https:') return override;
    const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'];
    if (u.protocol === 'http:' && loopback.includes(u.hostname)) return override;
  } catch { /* fall through */ }
  return null;
}

// ------------------------------------------------------------- enablement

const CI_ENV_VARS = [
  'CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI',
  'JENKINS_URL', 'TF_BUILD', 'TEAMCITY_VERSION', 'TRAVIS',
];

export function isCI(env = process.env) {
  return CI_ENV_VARS.some((v) => {
    const x = env[v];
    return x !== undefined && x !== '' && x !== '0' && x !== 'false';
  });
}

/** Running from the allodic source checkout (contributors, maintainers, the
 *  repo's own tests) → automatic reporting defaults OFF so development never
 *  pollutes production metrics or publisher delivery counts. An installed
 *  package lives under node_modules and is not a checkout. */
export function isSourceCheckout() {
  if (HERE.split(sep).includes('node_modules')) return false;
  try {
    const rootPkg = JSON.parse(readFileSync(join(dirname(HERE), '..', '..', '..', 'package.json'), 'utf8'));
    return Array.isArray(rootPkg.workspaces) && rootPkg.workspaces.includes('packages/cli');
  } catch { return false; }
}

/**
 * The ONE shared decision for BOTH automatic destinations (PostHog product
 * events AND publisher delivery events). Precedence, highest first:
 *   1. DO_NOT_TRACK=1                         → off, cannot be overridden
 *   2. ALLODIC_TELEMETRY=0 / =1               → explicit per-process
 *   3. CI default                             → off
 *   4. source-checkout default                → off
 *   5. persisted `enabled` (telemetry.json)
 *   6. default                                → on (with first-use notice)
 */
export function reportingDecision(env = process.env) {
  if (env.DO_NOT_TRACK === '1') return { enabled: false, reason: 'DO_NOT_TRACK=1' };
  if (env.ALLODIC_TELEMETRY === '0') return { enabled: false, reason: 'ALLODIC_TELEMETRY=0' };
  if (env.ALLODIC_TELEMETRY === '1') return { enabled: true, reason: 'ALLODIC_TELEMETRY=1' };
  if (isCI(env)) return { enabled: false, reason: 'CI default' };
  if (isSourceCheckout()) return { enabled: false, reason: 'source-checkout default' };
  const st = readState();
  if (st && st.enabled === false) return { enabled: false, reason: 'allodic telemetry disable' };
  return { enabled: true, reason: st ? 'persisted setting' : 'default' };
}

export function isAutomaticReportingEnabled(env = process.env) {
  return reportingDecision(env).enabled;
}

// ------------------------------------------------------ persistent state

function quarantine(path) {
  try { renameSync(path, `${path}.bad-${Date.now()}`); } catch { /* best effort */ }
}

/** Parsed, shape-validated state or null. Malformed files are quarantined. */
export function readState() {
  const p = STATE_PATH();
  if (!existsSync(p)) return null;
  hardenSecret(p); // repair pre-existing loose modes
  try {
    const st = JSON.parse(readFileSync(p, 'utf8'));
    if (typeof st !== 'object' || st === null) throw new Error('not an object');
    if (typeof st.installationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(st.installationId)) throw new Error('bad id');
    if (typeof st.enabled !== 'boolean') throw new Error('bad enabled');
    st.schemaVersion ??= 1;
    st.noticeShown = !!st.noticeShown;
    st.successfulPublishes = Number.isInteger(st.successfulPublishes) && st.successfulPublishes >= 0 ? st.successfulPublishes : 0;
    return st;
  } catch {
    quarantine(p);
    return null;
  }
}

export function writeState(st) {
  // Atomic, 0600, inside a 0700 ~/.allodic — same discipline as credentials.
  writeSecretJson(STATE_PATH(), st);
}

/** Load state, creating it (fresh random installation id) if missing or
 *  unrecoverable. The id is a UUID from crypto randomness only — never
 *  derived from hardware, hostname, username, paths, git, or credentials —
 *  and survives disable/enable cycles. */
export function ensureState() {
  let st = readState();
  if (!st) {
    st = {
      schemaVersion: 1,
      installationId: randomUUID(),
      enabled: true,
      noticeShown: false,
      createdAt: new Date().toISOString(),
      successfulPublishes: 0,
    };
    writeState(st);
  }
  return st;
}

// -------------------------------------------------------------- the queue

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The queue file is UNTRUSTED INPUT (P0): anything — another process, a
 *  restored backup, a hand edit — may have written it. An event survives
 *  reading only if its name is on the allowlist, its id is a real UUID, its
 *  timestamp parses, and its properties re-sanitize cleanly. Everything else
 *  is dropped here so no later code path can ever transmit it. */
function validateQueuedEvent(e) {
  if (typeof e !== 'object' || e === null || Array.isArray(e)) return null;
  if (typeof e.event !== 'string' || !EVENT_DEFINITIONS[e.event]) return null;
  if (typeof e.eventId !== 'string' || !UUID_RE.test(e.eventId)) return null;
  if (typeof e.timestamp !== 'string' || Number.isNaN(Date.parse(e.timestamp))) return null;
  if (typeof e.properties !== 'object' || e.properties === null || Array.isArray(e.properties)) return null;
  const properties = sanitizeEvent(e.event, e.properties);
  if (properties === null) return null;
  return { eventId: e.eventId, event: e.event, timestamp: e.timestamp, properties };
}

export function readQueue() {
  const p = QUEUE_PATH();
  if (!existsSync(p)) return { schemaVersion: 1, events: [] };
  try {
    const q = JSON.parse(readFileSync(p, 'utf8'));
    if (!Array.isArray(q.events)) throw new Error('bad queue');
    return { schemaVersion: 1, events: q.events.map(validateQueuedEvent).filter(Boolean).slice(0, MAX_QUEUE_EVENTS) };
  } catch {
    quarantine(p);
    return { schemaVersion: 1, events: [] };
  }
}

function writeQueue(q) {
  writeSecretJson(QUEUE_PATH(), q);
}

/** Best-effort mutual exclusion for queue read-modify-write across concurrent
 *  CLI invocations. mkdir is atomic; a lock older than 2 s is stale (a
 *  crashed process) and stolen. On contention we run WITHOUT the lock —
 *  telemetry may lose an event, the user never loses time. */
function sleepSyncMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* busy paths just skip */ }
}

/** `retries` short attempts (5 ms apart, ≤50 ms total) make concurrent
 *  recordEvent effectively lossless; flush uses try-once (retries: 0) because
 *  a lost removal-rewrite only re-sends later and the top-level `uuid` makes
 *  that a dedup no-op in PostHog. Locks older than 2 s are stale (crashed
 *  process) and stolen. On final contention we run WITHOUT the lock. */
function withQueueLock(fn, { retries = 10 } = {}) {
  const lock = `${QUEUE_PATH()}.lock`;
  let held = false;
  try {
    secureDir(HOME());
    for (let attempt = 0; attempt <= retries && !held; attempt++) {
      try {
        mkdirSync(lock);
        held = true;
      } catch {
        try { if (Date.now() - statSync(lock).mtimeMs > 2000) { rmSync(lock, { recursive: true, force: true }); continue; } } catch { /* raced */ }
        if (attempt < retries) sleepSyncMs(5);
      }
    }
    return fn();
  } finally {
    if (held) { try { rmSync(lock, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
}

export function clearQueue() {
  secureDir(HOME());
  writeQueue({ schemaVersion: 1, events: [] });
}

// -------------------------------------------------- event allowlist + intake

// The allowlist is the ONLY path into the queue. Command handlers propose
// events; this module decides what survives. 'boolean' accepts literal
// true/false only; arrays are enums; [array] means a list of enum values.
export const EVENT_DEFINITIONS = Object.freeze({
  cli_init_succeeded: Object.freeze({
    mode: ['new_directory', 'in_place'],
  }),
  cli_publish_succeeded: Object.freeze({
    paid: 'boolean',
    first_publish: 'boolean',
    has_evals: 'boolean',
    eval_runner: ['claude', 'mock', 'custom', 'other'],
  }),
  cli_release_succeeded: Object.freeze({
    paid: 'boolean',
    has_evals: 'boolean',
    eval_runner: ['claude', 'mock', 'custom', 'other'],
    active_entitlements_bucket: ['0', '1-5', '6-20', '21-100', '101+', 'unknown'],
  }),
  cli_add_succeeded: Object.freeze({
    paid: 'boolean',
    license_flow: ['existing_token', 'instant_checkout', 'activation', 'unknown'],
    agents: [['claude-code', 'cursor', 'codex', 'windsurf', 'other']],
    agent_count_bucket: ['0', '1', '2', '3+'],
  }),
  cli_update_completed: Object.freeze({
    installed_bucket: ['0', '1-5', '6-20', '21-100', '101+'],
    updated_bucket: ['0', '1-5', '6-20', '21-100', '101+'],
    current_bucket: ['0', '1-5', '6-20', '21-100', '101+'],
    failed_bucket: ['0', '1-5', '6-20', '21-100', '101+'],
  }),
  cli_command_failed: Object.freeze({
    command: ['init', 'publish', 'release', 'add', 'update', 'other'],
    stage: ['arguments', 'configuration', 'filesystem', 'collection', 'compliance', 'evals', 'scan',
            'network', 'authorization', 'license', 'bundle', 'verification', 'install', 'update', 'unknown'],
    reason: ['invalid_input', 'missing_configuration', 'already_exists', 'filesystem_error',
             'compliance_failed', 'missing_evals', 'eval_runner_failed', 'eval_gate_failed', 'scan_failed',
             'network_error', 'authorization_failed', 'license_unavailable', 'activation_failed',
             'bundle_fetch_failed', 'verification_failed', 'install_failed', 'unknown'],
  }),
});

function normalizeEnum(value, allowed) {
  if (allowed.includes(value)) return value;
  if (allowed.includes('other')) return 'other';
  if (allowed.includes('unknown')) return 'unknown';
  return null;
}

/** Strip to the allowlist. Unknown fields are discarded, invalid enum values
 *  normalized (→ other/unknown) or dropped, only literal booleans accepted,
 *  nested objects rejected. Returns null for unknown event names. */
export function sanitizeEvent(name, rawProps = {}) {
  const def = EVENT_DEFINITIONS[name];
  if (!def) return null;
  const out = {};
  for (const [field, spec] of Object.entries(def)) {
    const v = rawProps[field];
    if (v === undefined) continue;
    if (spec === 'boolean') {
      if (v === true || v === false) out[field] = v;
    } else if (Array.isArray(spec) && Array.isArray(spec[0])) {
      if (Array.isArray(v)) {
        const allowed = spec[0];
        const mapped = [...new Set(v.map((x) => normalizeEnum(x, allowed)).filter(Boolean))].slice(0, 8);
        out[field] = mapped;
      }
    } else if (Array.isArray(spec)) {
      const n = normalizeEnum(v, spec);
      if (n !== null) out[field] = n;
    }
  }
  return out;
}

/** Queue one allowlisted event (no transmission here). No-op when automatic
 *  reporting is disabled. Oldest events are dropped past MAX_QUEUE_EVENTS. */
export function recordEvent(name, rawProps = {}, env = process.env) {
  try {
    if (!isAutomaticReportingEnabled(env)) return false;
    const properties = sanitizeEvent(name, rawProps);
    if (properties === null) return false;
    ensureState(); // installation id must exist before anything can flush
    withQueueLock(() => {
      const q = readQueue();
      q.events.push({ eventId: randomUUID(), event: name, timestamp: new Date().toISOString(), properties });
      while (q.events.length > MAX_QUEUE_EVENTS) q.events.shift();
      writeQueue(q);
    });
    return true;
  } catch { return false; } // telemetry must never break a command
}

// --------------------------------------------------------- common properties

const PLATFORMS = new Set(['linux', 'darwin', 'win32', 'aix', 'freebsd', 'openbsd', 'sunos', 'android']);
const ARCHES = new Set(['x64', 'arm64', 'arm', 'ia32', 'ppc64', 's390x', 'riscv64']);

export function commonProperties(env = process.env) {
  return {
    schema_version: TELEMETRY_SCHEMA_VERSION,
    cli_version: CLI_VERSION,
    node_major: Number.parseInt(process.versions.node, 10) || 0,
    platform: PLATFORMS.has(process.platform) ? process.platform : 'other',
    arch: ARCHES.has(process.arch) ? process.arch : 'other',
    ci: isCI(env),
  };
}

// ------------------------------------------------------------------ flush

/**
 * Best-effort delivery of queued events. At most `maxEvents`, concurrently,
 * within a hard `budgetMs`. Only 2xx removes an event; failures and timeouts
 * stay queued for a later invocation. No retry loop, no output, no thrown
 * errors, no handles left behind.
 */
export async function flushTelemetry({ budgetMs = 500, maxEvents = 5, env = process.env } = {}) {
  try {
    if (!isAutomaticReportingEnabled(env)) return;
    const endpoint = resolveEndpoint(env);
    if (!endpoint) return;
    const q = readQueue();
    // Hostile/invalid entries were filtered by readQueue in memory; purge them
    // from DISK too so rejected content never lingers in ~/.allodic.
    try {
      const raw = JSON.parse(readFileSync(QUEUE_PATH(), 'utf8'));
      if (Array.isArray(raw?.events) && raw.events.length !== q.events.length) {
        withQueueLock(() => writeQueue({ schemaVersion: 1, events: readQueue().events }), { retries: 0 });
      }
    } catch { /* unreadable file was already quarantined by readQueue */ }
    if (!q.events.length) return;
    const st = ensureState();
    const common = commonProperties(env);
    const batch = q.events.slice(0, maxEvents);
    const signal = AbortSignal.timeout(budgetMs);
    const results = await Promise.allSettled(batch.map((raw) => {
      // Defense in depth: even though readQueue validated, re-validate at the
      // point of transmission and REBUILD the payload — sanitized fields
      // first, protected fields last, so a queued object can never override
      // distinct_id, $process_person_profile, event_id, or the common set.
      const e = validateQueuedEvent(raw);
      if (!e) return Promise.resolve(true); // invalid: treat as delivered → purged below
      return fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': `allodic-cli/${CLI_VERSION}` },
        signal,
        body: JSON.stringify({
          api_key: POSTHOG_PROJECT_TOKEN,
          event: e.event,
          uuid: e.eventId, // PostHog idempotency: retries after a lost ack cannot duplicate
          timestamp: e.timestamp, // original event time, not send time
          properties: {
            ...e.properties,
            ...common,
            event_id: e.eventId,
            distinct_id: st.installationId,
            $process_person_profile: false, // never create a PostHog person profile
          },
        }),
      }).then((r) => r.ok); // any 2xx counts as delivered; the body is never read
    }));
    const delivered = new Set();
    batch.forEach((e, i) => {
      if (results[i].status === 'fulfilled' && results[i].value === true) delivered.add(e.eventId);
    });
    if (delivered.size) {
      withQueueLock(() => {
        const remaining = readQueue().events.filter((e) => !delivered.has(e.eventId));
        writeQueue({ schemaVersion: 1, events: remaining });
      }, { retries: 0 });
    }
  } catch { /* swallowed entirely: an unreachable endpoint has zero effect */ }
}

// -------------------------------------------------------------- disclosure

export const FIRST_USE_NOTICE = `Allodic sends privacy-limited automatic usage events to improve the product.
This includes coarse CLI command outcomes sent to Allodic and install/update
delivery events sent to the relevant publisher. It never sends skill content,
names, paths, credentials, buyer data, or exact prices.

Inspect: allodic telemetry show
Disable: allodic telemetry disable
Details: https://allodic.dev/telemetry
`;

/** Print the first-use notice once per installation, to stderr, before any
 *  automatic event can be transmitted. Never shown when reporting is
 *  disabled (which also covers the CI default unless explicitly enabled). */
export function maybeShowFirstUseNotice(env = process.env) {
  try {
    if (!isAutomaticReportingEnabled(env)) return;
    const st = ensureState();
    if (st.noticeShown) return;
    process.stderr.write(FIRST_USE_NOTICE);
    writeState({ ...st, noticeShown: true });
  } catch { /* disclosure must not break the command either */ }
}

/** Bounded JSON POST for publisher delivery events (P1): a registry that
 *  accepts the connection and then stalls must not hang `add`/`update`. The
 *  abort signal covers the entire exchange, response body included. Throws
 *  on timeout/network/non-2xx — callers treat delivery as best-effort. */
export async function boundedPost(url, { token, body, timeoutMs = 2000 } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  await res.arrayBuffer().catch(() => {}); // drain under the same signal
  if (!res.ok) throw new Error(`delivery event refused: ${res.status}`);
}

// ---------------------------------------------------------------- helpers

export function bucketCount(n) {
  if (!Number.isFinite(n) || n < 0) return 'unknown';
  if (n === 0) return '0';
  if (n <= 5) return '1-5';
  if (n <= 20) return '6-20';
  if (n <= 100) return '21-100';
  return '101+';
}

export function bucketAgents(n) {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n === 0) return '0';
  if (n === 1) return '1';
  if (n === 2) return '2';
  return '3+';
}

export function mapEvalRunner(kind, hasEvals) {
  if (!hasEvals) return undefined;
  if (kind === 'claude') return 'claude';
  if (kind === 'mock') return 'mock';
  if (typeof kind === 'string' && kind) return 'custom';
  return 'other';
}
