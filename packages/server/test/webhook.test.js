// Stripe webhook security + idempotency tests.
//
// These run a real server instance and send genuinely HMAC-signed payloads
// (same scheme Stripe uses: `t=<ts>,v1=hmac_sha256(secret, "<ts>.<body>")`),
// so `stripe.webhooks.constructEvent` performs real verification — no mocks.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';

const WHSEC = 'whsec_test_secret_for_webhook_tests';
const SKILL = { slug: 'pg-auditor', name: 'PG Auditor', description: 'test skill', price: 2900, currency: 'usd', version: '1.0.0', updatedAt: new Date().toISOString() };

let dataDir, server, base, store;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'allodic-webhook-'));
  const created = createApp({ dataDir, env: { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: WHSEC } });
  store = created.store;
  store.putSkill({ ...SKILL });
  server = created.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ---- helpers ----

function sign(body, secret = WHSEC, ts = Math.floor(Date.now() / 1000)) {
  const mac = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return `t=${ts},v1=${mac}`;
}

async function post(body, signature) {
  const res = await fetch(`${base}/api/webhook/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(signature ? { 'stripe-signature': signature } : {}) },
    body,
  });
  return { status: res.status, json: await res.json() };
}

function paidEvent({ id, pi, slug = SKILL.slug, email = 'buyer@example.com', amount = SKILL.price, currency = SKILL.currency, paymentStatus = 'paid' }) {
  return JSON.stringify({
    id, type: 'checkout.session.completed',
    data: { object: {
      id: 'cs_' + pi, payment_intent: pi, payment_status: paymentStatus,
      amount_total: amount, currency,
      customer_email: email, metadata: { slug, email },
    } },
  });
}

function refundEvent({ id, pi }) {
  return JSON.stringify({
    id, type: 'charge.refunded',
    data: { object: { id: 'ch_' + pi, payment_intent: pi, refunded: true } },
  });
}

const orders = () => Object.values(store.data.orders);
const ordersFor = (pi) => orders().filter((o) => o.providerRef === pi);

// ---- forgery ----

test('SECURITY: unsigned webhook body is rejected, creates nothing', async () => {
  const { status } = await post(paidEvent({ id: 'evt_forged_1', pi: 'pi_forged' }));
  assert.equal(status, 400);
  assert.equal(ordersFor('pi_forged').length, 0);
});

test('SECURITY: wrong-secret signature is rejected, creates nothing', async () => {
  const body = paidEvent({ id: 'evt_forged_2', pi: 'pi_forged2' });
  const { status } = await post(body, sign(body, 'whsec_attacker_guess'));
  assert.equal(status, 400);
  assert.equal(ordersFor('pi_forged2').length, 0);
});

test('SECURITY: stale-timestamp signature (replay of captured request) is rejected', async () => {
  const body = paidEvent({ id: 'evt_stale', pi: 'pi_stale' });
  const staleTs = Math.floor(Date.now() / 1000) - 3600; // beyond Stripe's 300s tolerance
  const { status } = await post(body, sign(body, WHSEC, staleTs));
  assert.equal(status, 400);
  assert.equal(ordersFor('pi_stale').length, 0);
});

// ---- happy path + idempotency ----

test('valid signed paid event creates exactly one order with verified fields', async () => {
  const body = paidEvent({ id: 'evt_ok_1', pi: 'pi_ok_1' });
  const { status, json } = await post(body, sign(body));
  assert.equal(status, 200);
  assert.equal(json.received, true);
  const os = ordersFor('pi_ok_1');
  assert.equal(os.length, 1);
  assert.equal(os[0].slug, SKILL.slug);
  assert.equal(os[0].email, 'buyer@example.com');
  assert.equal(os[0].amount, SKILL.price);
  assert.equal(os[0].status, 'paid');
  assert.equal(os[0].revoked, false);
});

test('IDEMPOTENCY: duplicate delivery of the same event id creates no second order', async () => {
  const body = paidEvent({ id: 'evt_dup', pi: 'pi_dup' });
  await post(body, sign(body));
  const second = await post(body, sign(body)); // Stripe retry: same event, fresh signature
  assert.equal(second.status, 200);
  assert.equal(second.json.duplicate, true);
  assert.equal(ordersFor('pi_dup').length, 1);
});

test('IDEMPOTENCY: replay with a NEW event id but same payment_intent still yields one order', async () => {
  const a = paidEvent({ id: 'evt_replay_a', pi: 'pi_replay' });
  const b = paidEvent({ id: 'evt_replay_b', pi: 'pi_replay' });
  await post(a, sign(a));
  await post(b, sign(b));
  assert.equal(ordersFor('pi_replay').length, 1, 'providerRef must be unique across orders');
});

// ---- payment verification ----

test('SECURITY: signature-valid event with wrong amount does not mint a license', async () => {
  const body = paidEvent({ id: 'evt_cheap', pi: 'pi_cheap', amount: 100 }); // paid $1 for a $29 skill
  const { status, json } = await post(body, sign(body));
  assert.equal(status, 200); // 200 so Stripe stops retrying; it can't fix the amount
  assert.match(json.ignored ?? '', /mismatch/);
  assert.equal(ordersFor('pi_cheap').length, 0);
});

test('SECURITY: wrong currency does not mint a license', async () => {
  const body = paidEvent({ id: 'evt_curr', pi: 'pi_curr', currency: 'idr' }); // 2900 IDR ≈ $0.18
  const { json } = await post(body, sign(body));
  assert.match(json.ignored ?? '', /mismatch/);
  assert.equal(ordersFor('pi_curr').length, 0);
});

test('payment_status !== paid (async payment not yet settled) creates no order', async () => {
  const body = paidEvent({ id: 'evt_unpaid', pi: 'pi_unpaid', paymentStatus: 'unpaid' });
  const { status } = await post(body, sign(body));
  assert.equal(status, 200);
  assert.equal(ordersFor('pi_unpaid').length, 0);
});

test('unknown skill slug creates no order', async () => {
  const body = paidEvent({ id: 'evt_ghost', pi: 'pi_ghost', slug: 'does-not-exist' });
  const { json } = await post(body, sign(body));
  assert.match(json.ignored ?? '', /unknown skill/);
  assert.equal(ordersFor('pi_ghost').length, 0);
});

// ---- refunds ----

test('refund after payment revokes the matching order', async () => {
  const pay = paidEvent({ id: 'evt_r1_pay', pi: 'pi_r1' });
  await post(pay, sign(pay));
  const refund = refundEvent({ id: 'evt_r1_ref', pi: 'pi_r1' });
  await post(refund, sign(refund));
  const [o] = ordersFor('pi_r1');
  assert.equal(o.revoked, true);
});

test('OUT-OF-ORDER: refund delivered BEFORE its paid event → order is born revoked', async () => {
  const refund = refundEvent({ id: 'evt_r2_ref', pi: 'pi_r2' });
  await post(refund, sign(refund));
  assert.equal(ordersFor('pi_r2').length, 0, 'refund alone creates nothing');
  const pay = paidEvent({ id: 'evt_r2_pay', pi: 'pi_r2' });
  await post(pay, sign(pay));
  const os = ordersFor('pi_r2');
  assert.equal(os.length, 1);
  assert.equal(os[0].revoked, true, 'late-arriving paid event must not resurrect a refunded license');
});

test('IDEMPOTENCY: replayed refund event is a no-op duplicate', async () => {
  const pay = paidEvent({ id: 'evt_r3_pay', pi: 'pi_r3' });
  await post(pay, sign(pay));
  const refund = refundEvent({ id: 'evt_r3_ref', pi: 'pi_r3' });
  await post(refund, sign(refund));
  const again = await post(refund, sign(refund));
  assert.equal(again.json.duplicate, true);
  assert.equal(ordersFor('pi_r3').length, 1);
});

// ---- persistence of idempotency state ----

test('processed event ids survive in the store (restart-safe)', () => {
  assert.ok(store.data.webhookEvents['evt_ok_1'], 'event ids are persisted, not held in memory only');
});
