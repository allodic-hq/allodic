// node:sqlite store: durability, migration, single-writer, backups.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

const dir = () => mkdtempSync(join(tmpdir(), 'allodic-sqlite-'));

test('one-time migration: store.json imported, renamed, survives reload', () => {
  const d = dir();
  const legacy = {
    skills: { s1: { slug: 's1', name: 's1', version: '1.0.0' } },
    orders: { ord_1: { id: 'ord_1', slug: 's1', email: 'a@x.com', amount: 2900, revoked: false } },
    tokens: {}, activations: {},
  };
  writeFileSync(join(d, 'store.json'), JSON.stringify(legacy));
  const s = new Store(join(d, 'store.json'));
  assert.equal(s.getSkill('s1').version, '1.0.0');
  assert.equal(s.getOrder('ord_1').amount, 2900);
  assert.ok(!existsSync(join(d, 'store.json')), 'json renamed after import');
  assert.ok(readdirSync(d).some((f) => f.startsWith('store.json.migrated-')), 'kept as fallback');
  s.close();
  const s2 = new Store(join(d, 'store.json'));
  assert.equal(s2.getOrder('ord_1').amount, 2900, 'data served from sqlite after reopen');
  s2.close(); rmSync(d, { recursive: true, force: true });
});

test('write-through: method mutations persist without save()', () => {
  const d = dir();
  const s = new Store(join(d, 'store.json'));
  s.putSkill({ slug: 'wt', name: 'wt', version: '1.0.0', updatedAt: 'now' });
  const o = s.createOrder({ slug: 'wt', email: 'b@x.com', amount: 1900, provider: 'stripe', providerRef: 'pi_wt' });
  s.revokeOrder(o.id, 'refund');
  s.markEventProcessed('evt_1');
  s.addEvent({ slug: 'wt', order: o.id, event: 'install', agents: ['claude-code'], at: 'now' });
  s.close();
  const s2 = new Store(join(d, 'store.json'));
  assert.equal(s2.getOrder(o.id).revokedReason, 'refund');
  assert.equal(s2.hasProcessedEvent('evt_1'), true);
  assert.equal(s2.data.eventTotals.wt.installs, 1);
  assert.equal(s2.createOrder({ slug: 'wt', email: 'c@x.com', amount: 1900, provider: 'stripe', providerRef: 'pi_wt' }).id, o.id, 'providerRef idempotency survives restart');
  s2.close(); rmSync(d, { recursive: true, force: true });
});

test('save(): direct data pokes persist via full resync (legacy call sites)', () => {
  const d = dir();
  const s = new Store(join(d, 'store.json'));
  const o = s.createOrder({ slug: 'x', email: 'd@x.com', amount: 500, provider: 'free' });
  s.data.orders[o.id].revoked = true; // the finance-test pattern
  s.save();
  s.close();
  const s2 = new Store(join(d, 'store.json'));
  assert.equal(s2.getOrder(o.id).revoked, true);
  s2.close(); rmSync(d, { recursive: true, force: true });
});

test('single writer: a second store on the same data dir fails fast', () => {
  const d = dir();
  const s = new Store(join(d, 'store.json'));
  s.createOrder({ slug: 'y', email: 'e@x.com', amount: 0, provider: 'free' }); // hold the exclusive lock
  assert.throws(() => new Store(join(d, 'store.json')), /another allodic-server appears to be running/);
  s.close();
  const s3 = new Store(join(d, 'store.json')); // released lock -> fine
  s3.close(); rmSync(d, { recursive: true, force: true });
});

test('boot backups rotate and are themselves openable stores', async () => {
  const d = dir();
  let s = new Store(join(d, 'store.json'));
  s.putSkill({ slug: 'bk', name: 'bk', version: '1.0.0', updatedAt: 'now' });
  s.close();
  for (let i = 0; i < 3; i++) { s = new Store(join(d, 'store.json')); s.close(); }
  await new Promise((r) => setTimeout(r, 300)); // backups are fire-and-forget
  assert.ok(existsSync(join(d, 'store.db.bak.1')), 'bak.1 exists');
  assert.ok(existsSync(join(d, 'store.db.bak.2')), 'rotation happened');
  const restored = new Store(join(d, 'store.db.bak.1').replace(/\.db\.bak\.1$/, '.recover.json'));
  restored.close(); // proves a fresh path boots; full restore = copy bak over store.db
  rmSync(d, { recursive: true, force: true });
});

test('schema version stamped; future versions refuse politely', () => {
  const d = dir();
  const s = new Store(join(d, 'store.json'));
  assert.equal(s.db.prepare('PRAGMA user_version').get().user_version, 2); // v2: checkout_intents
  s.db.exec('PRAGMA user_version = 99');
  s.close();
  assert.throws(() => new Store(join(d, 'store.json')), /upgrade allodic-server/);
  rmSync(d, { recursive: true, force: true });
});
