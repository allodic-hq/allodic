// Update semantics: semver ordering end to end.
//   - a published downgrade is refused at publish (root fix)
//   - if one exists anyway (rollback escape), it is never OFFERED as an update
//   - prereleases order correctly; unparseable versions fall back safely
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { cmpSemver, gtSemver } from '@allodic/core';

test('core: ordering table', () => {
  const ordered = ['0.9.9', '1.0.0-alpha.1', '1.0.0-alpha.10', '1.0.0-beta', '1.0.0', '1.0.1', '1.4.1', '1.5.0-alpha.1', '1.5.0', '2.0.0'];
  for (let i = 0; i < ordered.length - 1; i++) {
    assert.ok(gtSemver(ordered[i + 1], ordered[i]), `${ordered[i + 1]} > ${ordered[i]}`);
    assert.ok(!gtSemver(ordered[i], ordered[i + 1]), `${ordered[i]} !> ${ordered[i + 1]}`);
  }
  assert.equal(cmpSemver('1.2.3+build.5', '1.2.3'), 0, 'build metadata ignored');
  assert.throws(() => cmpSemver('banana', '1.0.0'));
});

let dataDir, server, base, store, adminKey;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'allodic-upd-'));
  const created = createApp({ dataDir, env: { ALLODIC_RATE_LIMITS: 'off' } });
  store = created.store;
  server = created.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  adminKey = JSON.parse(readFileSync(join(dataDir, 'identity.json'), 'utf8')).adminKey;
  store.putSkill({ slug: 'upd-skill', name: 'upd-skill', description: 'x', version: '1.4.1', price: 0, updatedAt: new Date().toISOString(), capability: {}, files: {} });
});

after(() => { server?.close(); store?.close?.(); rmSync(dataDir, { recursive: true, force: true }); });

async function updates(version) {
  const order = store.createOrder({ slug: 'upd-skill', email: `u${version}@x.com`, amount: 0, provider: 'free' });
  const token = store.issueToken(order.email);
  const res = await fetch(`${base}/api/updates/upd-skill?version=${version}`, { headers: { authorization: `Bearer ${token}` } });
  return res.json();
}

test('same version: no update', async () => {
  assert.equal((await updates('1.4.1')).updateAvailable, false);
});

test('DOWNGRADE published (rollback escape): buyer on a newer version is NOT offered it', async () => {
  // simulate a rollback that bypassed the publish guard
  store.putSkill({ slug: 'upd-skill', name: 'upd-skill', description: 'x', version: '1.4.0', price: 0, updatedAt: new Date().toISOString(), capability: {}, files: {} });
  const r = await updates('1.4.1');
  assert.equal(r.updateAvailable, false, 'string inequality would have said true here');
  assert.equal(r.latest, '1.4.0');
  store.putSkill({ slug: 'upd-skill', name: 'upd-skill', description: 'x', version: '1.5.0-alpha.1', price: 0, updatedAt: new Date().toISOString(), capability: {}, files: {} });
});

test('prerelease above the buyer version IS an update; below is not', async () => {
  assert.equal((await updates('1.4.1')).updateAvailable, true, '1.5.0-alpha.1 > 1.4.1');
  assert.equal((await updates('1.5.0')).updateAvailable, false, '1.5.0-alpha.1 < 1.5.0');
});

test('unparseable versions fall back to inequality (old installs not stranded)', async () => {
  assert.equal((await updates('not-a-version')).updateAvailable, true);
});

test('publish guard: downgrade and equal-version-different-content are 422', async () => {
  const publish = async (version, body = 'body-A') => {
    const files = { 'SKILL.md': Buffer.from(`---\nname: guard-skill\ndescription: Checks things carefully. Use when checking.\nmetadata:\n  version: "${version}"\n---\n\n${body}`).toString('base64') };
    const res = await fetch(`${base}/api/skills`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': adminKey },
      body: JSON.stringify({ slug: 'guard-skill', files, scorecard: null }),
    });
    return { status: res.status, json: await res.json() };
  };
  assert.equal((await publish('2.0.0')).status, 200);
  const down = await publish('1.9.0');
  assert.equal(down.status, 422);
  assert.match(down.json.error, /version must increase/);
  const sameDifferent = await publish('2.0.0', 'body-B');
  assert.equal(sameDifferent.status, 422, 'silent content swap under one version is refused');
  const up = await publish('2.0.1');
  assert.equal(up.status, 200);
});
