// Sales/royalty math: aggregated from actual orders, never count × current
// price. One ledger exercises every failure mode from the review: a price
// change between releases, a refund, a manual (non-refund) revocation, and a
// free order — then checks gross / refunds / net / active / royalty basis.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';

let dataDir, server, base, adminKey, store;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'allodic-finance-'));
  const created = createApp({ dataDir, env: {} });
  store = created.store;
  server = created.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  adminKey = JSON.parse(readFileSync(join(dataDir, 'identity.json'), 'utf8')).adminKey;

  store.putSkill({
    slug: 'ledger-skill', name: 'ledger-skill', description: 'x', version: '2.0.0',
    price: 4900, currency: 'usd', updatedAt: new Date().toISOString(),
    capability: { terms: { payoutSplits: [{ pct: 10, to: 'https://upstream.example/s/base' }] } },
  });

  // The ledger. Current listing price is $49; history says otherwise:
  store.createOrder({ slug: 'ledger-skill', email: 'a@x.com', amount: 2900, provider: 'stripe', providerRef: 'pi_a', currency: 'usd' }); // bought at old $29 price
  store.createOrder({ slug: 'ledger-skill', email: 'b@x.com', amount: 4900, provider: 'stripe', providerRef: 'pi_b', currency: 'usd' }); // current price
  const refunded = store.createOrder({ slug: 'ledger-skill', email: 'c@x.com', amount: 4900, provider: 'stripe', providerRef: 'pi_c', currency: 'usd' });
  store.revokeOrder(refunded.id, 'refund');   // money returned
  const pulled = store.createOrder({ slug: 'ledger-skill', email: 'd@x.com', amount: 2900, provider: 'stripe', providerRef: 'pi_d', currency: 'usd' });
  store.revokeOrder(pulled.id, 'manual');     // license pulled, money kept
  store.createOrder({ slug: 'ledger-skill', email: 'e@x.com', amount: 0, provider: 'free', currency: 'usd' }); // free order
});

after(() => { server?.close(); rmSync(dataDir, { recursive: true, force: true }); });

test('finance: gross / refunds / net / active / royalty basis from actual orders', async () => {
  const res = await fetch(`${base}/api/insights/ledger-skill`, { headers: { 'x-admin-key': adminKey } });
  const { registry } = await res.json();
  assert.equal(registry.sales, 5);

  const [f] = registry.finance;
  assert.equal(f.currency, 'usd');
  assert.equal(f.grossCents, 2900 + 4900 + 4900 + 2900 + 0, 'gross = sum of recorded amounts, price changes respected');
  assert.equal(f.refundedCents, 4900, 'only the REFUNDED order subtracts');
  assert.equal(f.refundedCount, 1);
  assert.equal(f.netCents, 15600 - 4900);
  assert.equal(f.manuallyRevoked, 1, 'manual revocation tracked, money kept');
  assert.equal(f.activeLicenses, 3, 'two revocations of five orders');
  assert.equal(f.royaltyBasisCents, f.netCents, 'royalties accrue on net, not on count × price');
  assert.deepEqual(f.royalties, [{ pct: 10, to: 'https://upstream.example/s/base', accruedCents: 1070 }]);

  // The old formula would have claimed 5 × $49 = $245.00 gross and $24.50
  // royalty; reality is $156.00 gross, $107.00 net basis, $10.70 royalty.
  assert.notEqual(f.grossCents, 5 * 4900);
});

test('finance: revocation records reason and timestamp', () => {
  const revoked = Object.values(store.data.orders).filter((o) => o.revoked);
  assert.equal(revoked.length, 2);
  for (const o of revoked) {
    assert.ok(['refund', 'manual'].includes(o.revokedReason));
    assert.ok(o.revokedAt);
  }
});

test('finance: legacy revoked orders without a reason count as refunds (conservative)', async () => {
  const legacy = store.createOrder({ slug: 'ledger-skill', email: 'f@x.com', amount: 1000, provider: 'stripe', providerRef: 'pi_f', currency: 'usd' });
  store.data.orders[legacy.id].revoked = true; // simulate pre-migration record: no reason
  store.save();
  const res = await fetch(`${base}/api/insights/ledger-skill`, { headers: { 'x-admin-key': adminKey } });
  const { registry } = await res.json();
  const [f] = registry.finance;
  assert.equal(f.refundedCents, 4900 + 1000, 'unknown-reason revocation never inflates net or royalties owed');
});
