// P1 regression: a restored store.db without its identity.json must fail
// LOUDLY at boot, never silently mint a new identity — that would break
// capability signatures, buyer key pins, fingerprint traceability, and the
// admin key all at once, and the operator would learn it from angry buyers.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';

const SKILL = { slug: 's', name: 's', description: 'x', price: 0, currency: 'usd', version: '1.0.0', updatedAt: new Date().toISOString() };

function bootWithStateThenLoseIdentity() {
  const dataDir = mkdtempSync(join(tmpdir(), 'allodic-id-'));
  const first = createApp({ dataDir, env: {} });
  first.store.putSkill({ ...SKILL });
  first.store.createOrder({ slug: 's', email: 'a@x.com', amount: 0, provider: 'free', currency: 'usd' });
  first.store.close();
  rmSync(join(dataDir, 'identity.json')); // the partial-restore failure mode
  return dataDir;
}

test('REGRESSION: store with skills/orders but no identity.json refuses to boot', () => {
  const dataDir = bootWithStateThenLoseIdentity();
  assert.throws(
    () => createApp({ dataDir, env: {} }),
    /identity\.json is missing but the store already contains .* Restore identity\.json from backup/s,
    'must fail loudly, with the restore path in the message',
  );
  assert.ok(!existsSync(join(dataDir, 'identity.json')), 'refusal must not have generated a new identity');
  rmSync(dataDir, { recursive: true, force: true });
});

test('refusal releases the db lock — a proper restore can boot afterwards', () => {
  const dataDir = bootWithStateThenLoseIdentity();
  assert.throws(() => createApp({ dataDir, env: {} }));
  // Operator restores identity.json (here: a fresh one via the explicit override,
  // standing in for copying the real file back) and boots again.
  const recovered = createApp({ dataDir, env: { ALLODIC_ACCEPT_NEW_IDENTITY: '1' } });
  assert.equal(recovered.store.listSkills().length, 1, 'store data intact through refusal and recovery');
  recovered.store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('ALLODIC_ACCEPT_NEW_IDENTITY=1 is an explicit, working escape hatch', () => {
  const dataDir = bootWithStateThenLoseIdentity();
  const { store } = createApp({ dataDir, env: { ALLODIC_ACCEPT_NEW_IDENTITY: '1' } });
  assert.ok(existsSync(join(dataDir, 'identity.json')), 'override generates a new identity');
  assert.ok(JSON.parse(readFileSync(join(dataDir, 'identity.json'), 'utf8')).privateKeyPem);
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('true first boot (empty store, no identity) still just works', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'allodic-id-'));
  const { store } = createApp({ dataDir, env: {} });
  assert.ok(existsSync(join(dataDir, 'identity.json')));
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});
