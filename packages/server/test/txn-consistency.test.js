// P1 regression: persistence failure must never leave the process serving
// state that was never written. The reviewer's scenario: order enters memory,
// SQLite write fails, retries resolve against the phantom in-memory order,
// the Stripe event gets marked processed, the process restarts — the order is
// gone but Stripe considers the event consumed. Money taken, no license, no
// retry.
//
// Failure injection: `PRAGMA query_only = ON` on the live connection makes
// every write fail with SQLITE_READONLY — a deterministic stand-in for
// disk-full/EIO. Reads (and the memory resync) still work.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';

const WHSEC = 'whsec_test_secret_for_txn_tests';
const SKILL = { slug: 'txn-skill', name: 'Txn', description: 'test skill', price: 2900, currency: 'usd', version: '1.0.0', updatedAt: new Date().toISOString() };

let dataDir, server, base, store;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'allodic-txn-'));
  const created = createApp({ dataDir, env: { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: WHSEC } });
  store = created.store;
  store.putSkill({ ...SKILL });
  server = created.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server?.close(); rmSync(dataDir, { recursive: true, force: true }); });

const failWrites = () => store.db.exec('PRAGMA query_only = ON');
const healWrites = () => store.db.exec('PRAGMA query_only = OFF');

function sign(body, ts = Math.floor(Date.now() / 1000)) {
  const mac = createHmac('sha256', WHSEC).update(`${ts}.${body}`).digest('hex');
  return `t=${ts},v1=${mac}`;
}
async function post(body) {
  const res = await fetch(`${base}/api/webhook/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': sign(body) },
    body,
  });
  return { status: res.status, json: await res.json() };
}
const paidEvent = (id, pi) => JSON.stringify({
  id, type: 'checkout.session.completed',
  data: { object: { id: 'cs_' + pi, payment_intent: pi, payment_status: 'paid', amount_total: SKILL.price, currency: 'usd', customer_email: 'b@x.com', metadata: { slug: SKILL.slug, email: 'b@x.com' } } },
});
const refundEvent = (id, pi, refundId, amount) => JSON.stringify({
  id, type: 'refund.created',
  data: { object: { id: refundId, payment_intent: pi, charge: 'ch_' + pi, amount, status: 'succeeded' } },
});
const orderFor = (pi) => Object.values(store.data.orders).find((o) => o.providerRef === pi) ?? null;

// ---- the reviewer's scenario, end to end ----

test('REGRESSION: paid webhook under write failure → 500, NO phantom order, event NOT consumed; redelivery succeeds', async () => {
  failWrites();
  const { status } = await post(paidEvent('evt_dfull', 'pi_dfull'));
  assert.equal(status, 500, 'Stripe must be told to retry — never 200 on unpersisted work');
  assert.equal(orderFor('pi_dfull'), null, 'no order may exist only in memory');
  assert.equal(store.hasProcessedEvent('evt_dfull'), false, 'event must not be consumed');
  healWrites();
  const retry = await post(paidEvent('evt_dfull', 'pi_dfull')); // same event id: Stripe's redelivery
  assert.equal(retry.status, 200);
  const o = orderFor('pi_dfull');
  assert.ok(o, 'redelivery after recovery mints the license');
  assert.equal(o.amount, SKILL.price);
});

test('REGRESSION: refund application is all-or-nothing under write failure', async () => {
  await post(paidEvent('evt_ref_pay', 'pi_ref'));
  failWrites();
  const { status } = await post(refundEvent('evt_ref_r1', 'pi_ref', 're_r1', 2900));
  assert.equal(status, 500);
  const o = orderFor('pi_ref');
  assert.equal(o.revoked, false, 'license must not be revoked in memory only');
  assert.equal(o.amountRefunded ?? 0, 0, 'no refund cents may exist in memory only');
  assert.equal(store.hasProcessedEvent('evt_ref_r1'), false);
  healWrites();
  const retry = await post(refundEvent('evt_ref_r1', 'pi_ref', 're_r1', 2900));
  assert.equal(retry.status, 200);
  assert.equal(orderFor('pi_ref').revoked, true, 'redelivery completes the revocation exactly once');
  assert.equal(orderFor('pi_ref').amountRefunded, 2900);
});

test('memory === disk after failure: a restart-equivalent reload sees the same state', async () => {
  failWrites();
  await post(paidEvent('evt_mem', 'pi_mem')).catch(() => {});
  healWrites();
  // What a restarted process would load:
  const row = store.db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  assert.equal(Object.keys(store.data.orders).length, row, 'in-memory order count matches SQLite exactly');
});

// ---- store-level: single mutations also never leave memory ahead of disk ----

test('createOrder under write failure throws and leaves no in-memory order', () => {
  failWrites();
  assert.throws(() => store.createOrder({ slug: SKILL.slug, email: 'x@x.com', amount: 100, provider: 'stripe', providerRef: 'pi_solo', currency: 'usd' }));
  healWrites();
  assert.equal(orderFor('pi_solo'), null, 'the phantom order the reviewer described');
});

test('takePendingRefund + revoke path cannot half-apply: pending survives a failed transaction', async () => {
  // Refund arrives before its order; then the paid event hits a write failure.
  await post(refundEvent('evt_ooo_r', 'pi_ooo', 're_ooo', 2900));
  assert.ok(store.data.pendingRefunds['pi_ooo'], 'pending refund recorded');
  failWrites();
  const { status } = await post(paidEvent('evt_ooo_pay', 'pi_ooo'));
  assert.equal(status, 500);
  assert.ok(store.data.pendingRefunds['pi_ooo'], 'pending refund must NOT be consumed by a failed fulfillment');
  assert.equal(orderFor('pi_ooo'), null);
  healWrites();
  await post(paidEvent('evt_ooo_pay', 'pi_ooo'));
  const o = orderFor('pi_ooo');
  assert.ok(o && o.revoked, 'after recovery: order born revoked, exactly as if no failure happened');
  assert.equal(store.data.pendingRefunds['pi_ooo'], undefined, 'pending refund consumed with the commit');
});

test('instant checkout (free skill) is atomic: no token without its order', async () => {
  store.putSkill({ ...SKILL, slug: 'free-skill', name: 'free', price: 0 });
  failWrites();
  const res = await fetch(`${base}/api/checkout/free-skill`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'f@x.com' }),
  });
  assert.equal(res.status, 503);
  assert.equal(Object.values(store.data.orders).filter((o) => o.slug === 'free-skill').length, 0);
  assert.equal(Object.values(store.data.tokens).filter((t) => t.email === 'f@x.com').length, 0, 'no orphan token');
  healWrites();
  const ok = await fetch(`${base}/api/checkout/free-skill`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'f@x.com' }),
  });
  assert.equal(ok.status, 200);
});
