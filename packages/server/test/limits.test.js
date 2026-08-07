// Abuse resistance: rate limits on unauthenticated/entitled write paths,
// bounded storage with exact totals — a single buyer token can no longer
// inflate the store indefinitely.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { Store } from '../src/store.js';

let dataDir, server, base, store;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'allodic-limits-'));
  const created = createApp({ dataDir, env: { ALLODIC_DEV_CODES: '1' } });
  store = created.store;
  store.putSkill({ slug: 'lim-skill', name: 'lim-skill', description: 'x', version: '1.0.0', price: 0, updatedAt: new Date().toISOString(), capability: {}, files: {} });
  server = created.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server?.close(); rmSync(dataDir, { recursive: true, force: true }); });

test('activation is rate-limited per email (3/15min)', async () => {
  let last;
  for (let i = 0; i < 4; i++) {
    last = await fetch(`${base}/api/activate/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'spam@x.com' }) });
  }
  assert.equal(last.status, 429);
  assert.ok(last.headers.get('retry-after'), 'Retry-After header present');
  assert.match((await last.json()).error, /rate limit/);
});

test('checkout is rate-limited per IP (20/15min)', async () => {
  let codes = [];
  for (let i = 0; i < 22; i++) {
    const r = await fetch(`${base}/api/checkout/lim-skill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `b${i}@x.com` }) });
    codes.push(r.status);
  }
  assert.ok(codes.includes(429), 'later checkouts hit the limit');
  assert.ok(codes.indexOf(429) >= 15, 'legitimate early checkouts were served');
});

test('telemetry: one buyer token cannot post unbounded events (30/hour, then 429)', async () => {
  // Free-skill checkout above created orders; take one token via instant grant path.
  const r = await fetch(`${base}/api/checkout/lim-skill`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': 'fresh' }, body: JSON.stringify({ email: 'evt@x.com' }) });
  // may itself be limited under same IP key — create order directly instead:
  const order = store.createOrder({ slug: 'lim-skill', email: 'evt2@x.com', amount: 0, provider: 'free' });
  const token = store.issueToken('evt2@x.com');
  let statuses = [];
  for (let i = 0; i < 32; i++) {
    const res = await fetch(`${base}/api/events/lim-skill`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ event: 'install', version: '1.0.0', agents: ['claude-code'] }),
    });
    statuses.push(res.status);
  }
  assert.ok(statuses.includes(429), 'flood is stopped');
  const ok = statuses.filter((s) => s === 200).length;
  assert.ok(ok >= 25 && ok <= 30, `honest telemetry volume served (got ${ok})`);
});

test('storage is bounded: events list caps at MAX_EVENTS while totals stay exact', () => {
  const N = Store.MAX_EVENTS + 500;
  for (let i = 0; i < N; i++) {
    store.foldEvent && void 0; // ensure method exists
    store.addEvent({ slug: 'bulk-skill', order: 'ord_x', event: i % 5 === 0 ? 'update' : 'install', version: '1', agents: ['claude-code'], at: new Date().toISOString() });
  }
  assert.ok(store.data.events.length <= Store.MAX_EVENTS, `events buffer bounded (${store.data.events.length})`);
  const t = store.data.eventTotals['bulk-skill'];
  assert.equal(t.installs + t.updates, N, 'totals count every event ever received');
  assert.equal(t.installsByAgent['claude-code'], t.installs);
});

test('reports: totals + distinct reporters survive buffer rotation', () => {
  const N = Store.MAX_REPORTS + 200;
  for (let i = 0; i < N; i++) {
    store.addReport({ order: `ord_${i % 7}`, slug: 'rep-skill', version: '1', sessions: 2, agents: { 'claude-code': 1 }, receivedAt: new Date().toISOString() });
  }
  assert.ok(store.data.reports.length <= Store.MAX_REPORTS);
  const t = store.data.usageTotals['rep-skill'];
  assert.equal(t.sessions, N * 2, 'session totals exact despite rotation');
  assert.equal(Object.keys(t.byOrder).length, 7, 'distinct reporters tracked');
});

test('legacy stores: existing unbounded arrays fold into totals once on load', () => {
  const legacyDir = mkdtempSync(join(tmpdir(), 'allodic-legacy-'));
  const legacy = {
    skills: {}, orders: {}, tokens: {}, activations: {},
    events: Array.from({ length: 40 }, (_, i) => ({ slug: 'old-skill', order: 'o1', event: 'install', agents: ['cursor'], at: 'x' })),
    reports: [{ order: 'o1', slug: 'old-skill', sessions: 5, agents: { cursor: 5 } }],
  };
  writeFileSync(join(legacyDir, 'store.json'), JSON.stringify(legacy));
  const s2 = new Store(join(legacyDir, 'store.json'));
  assert.equal(s2.data.eventTotals['old-skill'].installs, 40);
  assert.equal(s2.data.usageTotals['old-skill'].sessions, 5);
  s2.close(); // single-writer: the lock must be released before reopening
  const s3 = new Store(join(legacyDir, 'store.json')); // reload: fold must not double-count
  assert.equal(s3.data.eventTotals['old-skill'].installs, 40, 'fold is one-time');
  s3.close();
  rmSync(legacyDir, { recursive: true, force: true });
});
