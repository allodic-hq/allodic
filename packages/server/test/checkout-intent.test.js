// P0.5 regression tests: payments settle against the IMMUTABLE checkout
// intent, never the mutable current listing; refunds are cumulative and
// revoke only when the captured amount is fully returned.
//
// Same harness as webhook.test.js: real server, genuinely HMAC-signed
// payloads, real `stripe.webhooks.constructEvent` verification — no mocks.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';

const WHSEC = 'whsec_test_secret_for_intent_tests';
const SKILL = { slug: 'repriced-skill', name: 'Repriced', description: 'test skill', price: 2900, currency: 'usd', version: '1.0.0', updatedAt: new Date().toISOString() };

let dataDir, server, base, store, adminKey;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'allodic-intent-'));
  const created = createApp({ dataDir, env: { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: WHSEC } });
  store = created.store;
  store.putSkill({ ...SKILL });
  server = created.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  adminKey = JSON.parse(readFileSync(join(dataDir, 'identity.json'), 'utf8')).adminKey;
});

after(() => { server?.close(); rmSync(dataDir, { recursive: true, force: true }); });

// ---- helpers ----

function sign(body, secret = WHSEC, ts = Math.floor(Date.now() / 1000)) {
  const mac = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
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
function paidEvent({ id, pi, slug = SKILL.slug, email = 'buyer@example.com', amount, currency = 'usd' }) {
  return JSON.stringify({
    id, type: 'checkout.session.completed',
    data: { object: {
      id: 'cs_' + pi, payment_intent: pi, payment_status: 'paid',
      amount_total: amount, currency,
      customer_email: email, metadata: { slug, email },
    } },
  });
}
// refund.created — object is a single Refund with its own id and amount.
function refundCreated({ id, pi, refundId, amount, status = 'succeeded' }) {
  return JSON.stringify({
    id, type: 'refund.created',
    data: { object: { id: refundId, payment_intent: pi, charge: 'ch_' + pi, amount, status } },
  });
}
// charge.refunded — object is the Charge; amount_refunded is CUMULATIVE.
function chargeRefunded({ id, pi, amountRefunded, full = false }) {
  return JSON.stringify({
    id, type: 'charge.refunded',
    data: { object: { id: 'ch_' + pi, payment_intent: pi, amount_refunded: amountRefunded, refunded: full } },
  });
}
const orderFor = (pi) => Object.values(store.data.orders).find((o) => o.providerRef === pi) ?? null;
function intentFor(pi, overrides = {}) {
  return store.createCheckoutIntent({
    sessionId: 'cs_' + pi, slug: SKILL.slug, version: SKILL.version, capabilityDigest: 'sha256:deadbeef',
    email: 'buyer@example.com', amount: SKILL.price, currency: 'usd', ...overrides,
  });
}
async function finance() {
  const res = await fetch(`${base}/api/insights/${SKILL.slug}`, { headers: { 'x-admin-key': adminKey } });
  const j = await res.json();
  return j.registry.finance.find((f) => f.currency === 'usd');
}

// ---- the P0.5 race ----

test('RACE: buyer completes a $29 session after the seller reprices to $39 — license IS minted at $29', async () => {
  intentFor('pi_race');                                    // 1. buyer opens $29 checkout → intent frozen
  store.putSkill({ ...SKILL, price: 3900, version: '2.0.0', updatedAt: new Date().toISOString() }); // 2. seller republishes at $39
  const body = paidEvent({ id: 'evt_race', pi: 'pi_race', amount: 2900 }); // 3–4. buyer pays the valid $29 session; webhook arrives
  const { status, json } = await post(body);
  assert.equal(status, 200);
  assert.equal(json.ignored, undefined, 'a legitimate payment must not be ignored because the listing moved');
  const o = orderFor('pi_race');
  assert.ok(o, 'buyer paid → buyer gets a license');
  assert.equal(o.amount, 2900, 'order records what was actually paid, not the new listing price');
  assert.equal(o.purchasedVersion, '1.0.0', 'order pins the version that was bought');
  assert.equal(o.purchasedDigest, 'sha256:deadbeef');
  assert.equal(store.getCheckoutIntent('cs_pi_race'), null, 'settled intent is consumed');
});

test('SECURITY: signature-valid event that CONTRADICTS its intent amount does not mint', async () => {
  intentFor('pi_tamper');
  const body = paidEvent({ id: 'evt_tamper', pi: 'pi_tamper', amount: 5 }); // Stripe never settles a session below its creation amount
  const { json } = await post(body);
  assert.match(json.ignored ?? '', /intent/);
  assert.equal(orderFor('pi_tamper'), null);
});

test('intent survives restart: written through to sqlite, reloaded on boot', () => {
  intentFor('pi_persist');
  const row = store.db.prepare('SELECT v FROM checkout_intents WHERE k = ?').get('cs_pi_persist');
  assert.ok(row, 'intent row exists in sqlite, not memory only');
  assert.equal(JSON.parse(row.v).amount, 2900);
});

// ---- partial refunds ----

test('PARTIAL: a $5 goodwill refund on a $29 order keeps the license and books exactly $5', async () => {
  intentFor('pi_part');
  await post(paidEvent({ id: 'evt_part_pay', pi: 'pi_part', amount: 2900 }));
  await post(refundCreated({ id: 'evt_part_r1', pi: 'pi_part', refundId: 're_part_1', amount: 500 }));
  const o = orderFor('pi_part');
  assert.equal(o.revoked, false, 'partial refund must NOT revoke the license');
  assert.equal(o.amountRefunded, 500);
});

test('PARTIAL: refund.created + charge.refunded for the SAME refund do not double count', async () => {
  // Stripe fires both events for one refund; cumulative amount_refunded on the
  // charge already includes the refund counted by id.
  await post(chargeRefunded({ id: 'evt_part_r1_charge', pi: 'pi_part', amountRefunded: 500 }));
  assert.equal(orderFor('pi_part').amountRefunded, 500, 'still $5, not $10');
});

test('IDEMPOTENCY: replayed refund id under a NEW event id does not double count', async () => {
  await post(refundCreated({ id: 'evt_part_r1_replay', pi: 'pi_part', refundId: 're_part_1', amount: 500 }));
  assert.equal(orderFor('pi_part').amountRefunded, 500);
});

test('failed refund returns no money and changes nothing', async () => {
  await post(refundCreated({ id: 'evt_part_fail', pi: 'pi_part', refundId: 're_part_fail', amount: 2400, status: 'failed' }));
  const o = orderFor('pi_part');
  assert.equal(o.amountRefunded, 500);
  assert.equal(o.revoked, false);
});

test('refunds accumulate; the one completing the captured amount revokes', async () => {
  await post(refundCreated({ id: 'evt_part_r2', pi: 'pi_part', refundId: 're_part_2', amount: 2400 }));
  const o = orderFor('pi_part');
  assert.equal(o.amountRefunded, 2900);
  assert.equal(o.revoked, true);
  assert.equal(o.revokedReason, 'refund');
});

test('FINANCE: partial + full refunds book actual cents, never the whole order for a partial', async () => {
  intentFor('pi_fin');
  await post(paidEvent({ id: 'evt_fin_pay', pi: 'pi_fin', amount: 2900 }));
  await post(refundCreated({ id: 'evt_fin_r1', pi: 'pi_fin', refundId: 're_fin_1', amount: 100 })); // $1 goodwill on a live order
  const f = await finance();
  // Orders so far in usd: pi_race 2900 live, pi_part 2900 fully refunded, pi_fin 2900 with $1 refunded.
  assert.equal(f.grossCents, 8700);
  assert.equal(f.refundedCents, 2900 + 100, 'the $1 refund books $1, not $29');
  assert.equal(f.refundedCount, 2, 'orders with any refund money');
  assert.equal(f.netCents, 8700 - 3000);
  assert.equal(f.activeLicenses, 2, 'partially refunded order is still an active license');
});

// ---- out-of-order refunds with amounts ----

test('OUT-OF-ORDER: partial refund before its paid event → order born partially refunded, NOT revoked', async () => {
  await post(refundCreated({ id: 'evt_ooo_r', pi: 'pi_ooo', refundId: 're_ooo_1', amount: 500 }));
  assert.equal(orderFor('pi_ooo'), null, 'refund alone creates nothing');
  intentFor('pi_ooo');
  await post(paidEvent({ id: 'evt_ooo_pay', pi: 'pi_ooo', amount: 2900 }));
  const o = orderFor('pi_ooo');
  assert.ok(o);
  assert.equal(o.amountRefunded, 500);
  assert.equal(o.revoked, false, 'a $5 early refund must not kill a $29 license');
});

test('OUT-OF-ORDER: FULL refund before its paid event → order born revoked (unchanged)', async () => {
  await post(chargeRefunded({ id: 'evt_ooo2_r', pi: 'pi_ooo2', amountRefunded: 2900, full: true }));
  intentFor('pi_ooo2');
  await post(paidEvent({ id: 'evt_ooo2_pay', pi: 'pi_ooo2', amount: 2900 }));
  const o = orderFor('pi_ooo2');
  assert.equal(o.revoked, true);
  assert.equal(o.amountRefunded, 2900);
});
