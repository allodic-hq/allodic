// P1 regression: the reviewer submitted 1,500 unique agent keys — the raw
// report buffer stopped at 1,000 entries but the byAgent aggregate retained
// all 1,500 keys forever, contradicting the "no token can grow the store
// without limit" claim. The aggregates now have hard bounds: key count
// (overflow folds into '(other)', totals stay exact), key length, and
// finite non-negative integer counters.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { Store } from '../src/store.js';

const SKILL = { slug: 'tele-skill', name: 'Tele', description: 'x', price: 0, currency: 'usd', version: '1.0.0', updatedAt: new Date().toISOString() };

let dataDir, server, base, store, token;

before(async () => {
  process.env.ALLODIC_RATE_LIMITS = 'off'; // limiter reads process.env directly
  dataDir = mkdtempSync(join(tmpdir(), 'allodic-tele-'));
  const created = createApp({ dataDir, env: {} });
  store = created.store;
  store.putSkill({ ...SKILL });
  store.createOrder({ slug: SKILL.slug, email: 'b@x.com', amount: 0, provider: 'free', currency: 'usd' });
  token = store.issueToken('b@x.com');
  server = created.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { delete process.env.ALLODIC_RATE_LIMITS; server?.close(); rmSync(dataDir, { recursive: true, force: true }); });

async function report(body) {
  const res = await fetch(`${base}/api/reports/${SKILL.slug}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ format: 'allodic-report/1', ...body }),
  });
  return { status: res.status, json: await res.json() };
}
const totals = () => store.data.usageTotals[SKILL.slug];

test("REGRESSION: the reviewer's probe — thousands of unique agent keys stay bounded at the cap", async () => {
  // 100 reports × 20 unique keys each = 2,000 distinct client-named keys.
  for (let i = 0; i < 100; i++) {
    const agents = {};
    for (let j = 0; j < 20; j++) agents[`agent-${i}-${j}`] = 1;
    await report({ sessions: 1, agents });
  }
  const t = totals();
  const keys = Object.keys(t.byAgent);
  assert.ok(keys.length <= Store.MAX_AGENT_KEYS + 1, `byAgent has ${keys.length} keys; cap is ${Store.MAX_AGENT_KEYS} + '(other)'`);
  assert.ok(keys.includes(Store.OTHER_KEY), 'overflow folds into the reserved bucket');
  const sum = Object.values(t.byAgent).reduce((a, b) => a + b, 0);
  assert.equal(sum, 2000, 'totals stay EXACT in aggregate — bounding keys must not lose counts');
  assert.equal(t.sessions, 100);
});

test('a known key keeps accumulating under its own name even after the cap', async () => {
  const before = totals().byAgent['agent-0-0'];
  await report({ agents: { 'agent-0-0': 5 } });
  assert.equal(totals().byAgent['agent-0-0'], before + 5, 'existing keys are never diverted to (other)');
});

test('counter hostile values: negatives, NaN, Infinity, floats, huge magnitudes', async () => {
  const sessionsBefore = totals().sessions;
  const sumBefore = Object.values(totals().byAgent).reduce((a, b) => a + b, 0);
  await report({
    sessions: -50,
    agents: { 'agent-0-0': -10, 'agent-0-1': Infinity, 'agent-0-2': 'NaN-string', 'agent-0-3': 2.9, 'agent-0-4': 1e300 },
  });
  const t = totals();
  assert.equal(t.sessions, sessionsBefore, 'negative sessions add nothing');
  assert.ok(Number.isFinite(t.sessions), 'running total can never become NaN/Infinity');
  const sumAfter = Object.values(t.byAgent).reduce((a, b) => a + b, 0);
  // -10 → 0, Infinity → 0, 'NaN-string' → 0, 2.9 → 2, 1e300 → MAX_COUNT cap
  assert.equal(sumAfter - sumBefore, 2 + Store.MAX_COUNT);
  assert.ok(Object.values(t.byAgent).every(Number.isFinite));
});

test('oversized agent keys are truncated at intake AND in the fold', async () => {
  const huge = 'x'.repeat(100_000);
  await report({ agents: { [huge]: 1 } });
  for (const k of Object.keys(totals().byAgent)) {
    assert.ok(k.length <= Store.MAX_TELEMETRY_STR, `key of length ${k.length} exceeds ${Store.MAX_TELEMETRY_STR}`);
  }
  const raw = store.data.reports.at(-1);
  for (const k of Object.keys(raw.agents)) assert.ok(k.length <= Store.MAX_TELEMETRY_STR, 'raw buffer entries are length-capped too');
});

test('version / lastSeen strings are length-capped everywhere they land', async () => {
  const huge = 'v'.repeat(50_000);
  await report({ version: huge, lastSeen: '9999-' + 'z'.repeat(10_000) });
  const raw = store.data.reports.at(-1);
  assert.ok(raw.version.length <= Store.MAX_TELEMETRY_STR);
  assert.ok((totals().lastSeen ?? '').length <= Store.MAX_TELEMETRY_STR);
  // and the updates route: client-supplied version lands on the ORDER row capped
  const r = await fetch(`${base}/api/updates/${SKILL.slug}?version=${'8'.repeat(2000)}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200);
  const o = Object.values(store.data.orders)[0];
  assert.ok(o.lastSeenVersion.length <= Store.MAX_TELEMETRY_STR);
});

test('install events: agent names bounded in count, length, and aggregate keys', async () => {
  for (let i = 0; i < 40; i++) {
    await fetch(`${base}/api/events/${SKILL.slug}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ event: 'install', version: '1.0.0', agents: [`installer-${i}`, 'y'.repeat(5000)] }),
    });
  }
  const et = store.data.eventTotals[SKILL.slug];
  const keys = Object.keys(et.installsByAgent);
  assert.ok(keys.length <= Store.MAX_AGENT_KEYS + 1);
  assert.ok(keys.every((k) => k.length <= Store.MAX_TELEMETRY_STR));
  assert.equal(et.installs, 40, 'event counting itself stays exact');
});
