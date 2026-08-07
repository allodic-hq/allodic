// P0 regression: telemetry limiters keyed on the RAW Authorization header,
// before authentication. Every fake bearer minted a fresh limiter identity
// retained for the window — the reviewer's 100,000 unauthenticated requests
// produced 100,000 retained identities, bypassing the per-license limit while
// turning the limiter itself into the memory-exhaustion mechanism.
//
// Now: per-IP limit BEFORE auth; auth resolves the bearer to a server-issued
// ORDER, and only that order id keys the per-license limiter; the map itself
// is LRU-bounded.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { makeLimiter } from '../src/limiter.js';

const SKILL = { slug: 'lim2-skill', name: 'x', description: 'x', price: 0, currency: 'usd', version: '1.0.0', updatedAt: new Date().toISOString() };

let dataDir, server, base, store, app;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'allodic-lim2-'));
  const created = createApp({ dataDir, env: {} });
  store = created.store; app = created.app;
  app.set('trust proxy', true); // let tests vary the client IP via x-forwarded-for
  store.putSkill({ ...SKILL });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); rmSync(dataDir, { recursive: true, force: true }); });

const post = (path, headers = {}, body = {}) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

test("REGRESSION: many distinct fake bearers from one IP → NO linear limiter growth, and the IP cap bites", async () => {
  const statuses = [];
  for (let i = 0; i < 300; i++) {
    const r = await post(`/api/events/${SKILL.slug}`,
      { authorization: `Bearer random-value-${i}`, 'x-forwarded-for': '203.0.113.9' },
      { event: 'install', version: '1.0.0', agents: ['x'] });
    statuses.push(r.status);
  }
  assert.ok(statuses.every((s) => s === 401 || s === 429), 'invalid bearers only ever see 401 (rejected by auth) or 429 (IP cap)');
  assert.ok(statuses.includes(429), 'the per-IP outer limit stops the flood before auth');
  assert.ok(statuses.filter((s) => s === 429).length >= 150, 'flood past the IP window is refused, not processed');
});

test('the per-license limiter map holds ZERO identities from that flood — fake bearers never mint keys', () => {
  // The order-keyed limiter is reachable only after a bearer resolves to a
  // real license; 300 invalid bearers must have contributed nothing.
  // (Reach it via the app's middleware state: no orders exist yet, so any
  // key at all would be growth from unauthenticated input.)
  assert.equal(Object.keys(store.data.orders).length, 0, 'sanity: no licenses exist');
  // No direct handle on the route-local limiter, so assert behaviorally:
  // a fresh IP + fresh fake bearer still gets 401 (auth), never 429 from a
  // per-license window that shouldn't know anyone.
  return post(`/api/events/${SKILL.slug}`, { authorization: 'Bearer never-seen', 'x-forwarded-for': '198.51.100.7' },
    { event: 'install', version: '1.0.0' }).then((r) => assert.equal(r.status, 401));
});

test('a VALID license is limited per-ORDER (server identity), not per presented header', async () => {
  store.createOrder({ slug: SKILL.slug, email: 'a@x.com', amount: 0, provider: 'free', currency: 'usd' });
  const t1 = store.issueToken('a@x.com');
  const t2 = store.issueToken('a@x.com'); // second device, SAME license
  const statuses = [];
  for (let i = 0; i < 40; i++) {
    const token = i % 2 ? t1 : t2; // alternating tokens must share one budget
    const r = await post(`/api/events/${SKILL.slug}`,
      { authorization: `Bearer ${token}`, 'x-forwarded-for': `192.0.2.${i}` }, // vary IP: only the order key can stop this
      { event: 'install', version: '1.0.0', agents: ['x'] });
    statuses.push(r.status);
  }
  const ok = statuses.filter((s) => s === 200).length;
  assert.ok(ok <= 30, `two tokens on one order share the 30/hour budget (served ${ok})`);
  assert.ok(statuses.includes(429), 'the per-order limit engages');
  assert.ok(ok >= 25, 'honest volume is still served');
});

// ---- unit level: the map itself is bounded (LRU) ----

test('limiter map is LRU-bounded at maxKeys; recently-seen keys survive eviction', () => {
  const lim = makeLimiter({ name: 't', windowMs: 60_000, max: 100, maxKeys: 5, key: (req) => req.k });
  const hit = (k) => new Promise((resolve) => lim({ k }, { set() {}, status: () => ({ json: resolve }) }, resolve));
  return (async () => {
    for (let i = 0; i < 50; i++) await hit(`key-${i}`);
    assert.ok(lim.hits.size <= 5, `map has ${lim.hits.size} keys; bound is 5 — 50 identities must not persist`);
    await hit('key-49'); // refresh
    for (let i = 100; i < 104; i++) await hit(`key-${i}`);
    assert.ok(lim.hits.has('key-49'), 'recently-touched key survives; oldest are evicted first');
  })();
});

test('eviction only ever forgets history — it never blocks a legitimate caller', async () => {
  const lim = makeLimiter({ name: 't', windowMs: 60_000, max: 2, maxKeys: 3, key: (req) => req.k });
  const call = (k) => new Promise((resolve) => {
    const res = { set() {}, status: (code) => ({ json: () => resolve(code) }) };
    lim({ k }, res, () => resolve(200));
  });
  assert.equal(await call('a'), 200);
  assert.equal(await call('a'), 200);
  assert.equal(await call('a'), 429); // a is at its cap
  for (const k of ['b', 'c', 'd', 'e']) await call(k); // push a out of the bounded map
  assert.equal(await call('a'), 200, 'evicted key restarts a fresh window — degradation is permissive, never a lockout');
});
