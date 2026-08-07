import { test } from 'node:test';
import assert from 'node:assert';
import { makeProvider } from '../src/payments.js';

const free = { price: 0, slug: 'f' };
const paid = { price: 2900, slug: 'p' };

test('SECURITY: paid skill with no provider fails closed (503), not free', async () => {
  const p = makeProvider({});
  const r = await p.createCheckout({ skill: paid, email: 'a@x.com' });
  assert.equal(r.instant, undefined);
  assert.equal(r.status, 503);
  assert.match(r.error, /not configured/i);
  assert.equal(p.canChargePaid, false);
});

test('free skill instant-grants even with no provider', async () => {
  const r = await makeProvider({}).createCheckout({ skill: free, email: 'a@x.com' });
  assert.equal(r.instant, true);
  assert.equal(r.provider, 'free');
});

test('paid skill instant-grants ONLY with explicit insecure dev flag, and is tagged', async () => {
  const p = makeProvider({ ALLODIC_INSECURE_DEV_PAYMENTS: '1' });
  const r = await p.createCheckout({ skill: paid, email: 'a@x.com' });
  assert.equal(r.instant, true);
  assert.equal(r.provider, 'dev-insecure');
  assert.equal(p.isDevPaidMode, true);
});

test('dev flag any value other than "1" does not enable free paid grants', async () => {
  for (const v of ['0', 'true', 'yes', '']) {
    const r = await makeProvider({ ALLODIC_INSECURE_DEV_PAYMENTS: v }).createCheckout({ skill: paid, email: 'a@x.com' });
    assert.equal(r.status, 503, `value ${JSON.stringify(v)} must not enable dev payments`);
  }
});

test('with Stripe fully configured, paid skill uses real provider (not instant)', () => {
  const p = makeProvider({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' });
  assert.equal(p.canChargePaid, true);
  assert.equal(p.isDevPaidMode, false);
  assert.equal(p.name, 'stripe');
  assert.equal(p.webhookVerification, true);
});

test('SECURITY: Stripe key without webhook secret refuses to boot', () => {
  assert.throws(
    () => makeProvider({ STRIPE_SECRET_KEY: 'sk_live_x' }),
    /STRIPE_WEBHOOK_SECRET/,
    'a Stripe deployment without webhook verification must not start'
  );
});

test('SECURITY: missing webhook secret allowed ONLY under explicit insecure dev flag, and unsigned webhooks are still rejected', async () => {
  const p = makeProvider({ STRIPE_SECRET_KEY: 'sk_test_x', ALLODIC_INSECURE_DEV_PAYMENTS: '1' });
  assert.equal(p.webhookVerification, false);
  // Even in dev mode there is no unsigned-parse fallback: forged bodies never become events.
  const forged = Buffer.from(JSON.stringify({ type: 'checkout.session.completed', data: { object: { payment_status: 'paid' } } }));
  await assert.rejects(() => p.parseWebhook(forged, undefined), /STRIPE_WEBHOOK_SECRET/);
});
