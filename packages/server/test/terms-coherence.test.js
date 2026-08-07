// P0.3: one source of commercial truth. The signed capability terms, the
// stored listing, the charge amount, and the gates must all derive from the
// SAME SKILL.md parse — divergent request fields are refused.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';

let dataDir, server, base, adminKey, store;

const md = ({ price = '$29', version = '1.0.0', name = 'coherent-skill' } = {}) =>
  `---\nname: ${name}\ndescription: Audits carefully. Use when auditing migrations.\nmetadata:\n  version: "${version}"\n  author: honest-author\n${price ? `  price: "${price}"\n` : ''}---\n\nAlways use CREATE INDEX CONCURRENTLY.\n`;

const filesB64 = (m) => ({
  'SKILL.md': Buffer.from(m).toString('base64'),
  'evals/tasks.json': Buffer.from(JSON.stringify([{ id: 't1', prompt: 'p', mustMention: ['concurrently'] }])).toString('base64'),
});

async function publish(body) {
  const res = await fetch(`${base}/api/skills`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': adminKey },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

function scorecardFor(m) {
  // built the way the CLI builds it, minimal fields the gate checks
  return null; // free-skill tests avoid the benchmark gate; paid test builds real one below
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'allodic-terms-'));
  const created = createApp({ dataDir, env: { ALLODIC_RATE_LIMITS: 'off', ALLODIC_INSECURE_DEV_PAYMENTS: '1' } });
  store = created.store;
  server = created.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  adminKey = JSON.parse(readFileSync(join(dataDir, 'identity.json'), 'utf8')).adminKey;
});

after(() => { server?.close(); store?.close?.(); rmSync(dataDir, { recursive: true, force: true }); });

test('P0.3 ATTACK: request price $1 while SKILL.md signs $29 — refused with both named', async () => {
  const m = md(); // $29 in SKILL.md
  const { status, json } = await publish({ slug: 'coherent-skill', name: 'coherent-skill', description: 'Audits carefully. Use when auditing migrations.', version: '1.0.0', price: 100, creator: 'honest-author', files: filesB64(m), scorecard: null });
  assert.equal(status, 422);
  assert.ok(json.diverges.some((d) => d.includes('price') && d.includes('100') && d.includes('2900')), JSON.stringify(json));
});

test('version and name divergence likewise refused', async () => {
  const m = md({ price: '' }); // free: no benchmark gate in the way
  let r = await publish({ slug: 'coherent-skill', version: '9.9.9', files: filesB64(m) });
  assert.equal(r.status, 422);
  assert.ok(r.json.diverges.some((d) => d.startsWith('version')));
  r = await publish({ slug: 'coherent-skill', name: 'shinier-name', files: filesB64(m) });
  assert.equal(r.status, 422);
  assert.ok(r.json.diverges.some((d) => d.startsWith('name')));
});

test('derive-only client: omitted request fields publish fine, stored values come from SKILL.md', async () => {
  const m = md({ price: '' });
  const { status } = await publish({ slug: 'coherent-skill', files: filesB64(m) });
  assert.equal(status, 200);
  const skill = store.getSkill('coherent-skill');
  assert.equal(skill.name, 'coherent-skill');
  assert.equal(skill.version, '1.0.0');
  assert.equal(skill.price, 0);
  assert.equal(skill.creator, 'honest-author', 'creator from metadata.author');
});

test('charge coherence: what checkout charges equals the signed terms, always', async () => {
  // paid publish with an honest client (fields derived from the same SKILL.md)
  const m = md({ name: 'paid-skill', version: '1.0.0' });
  const { makeRunner, runEvals, skillContentHash } = await import('@allodic/core');
  const raw = Object.fromEntries(Object.entries(filesB64(m)).map(([p, b]) => [p, Buffer.from(b, 'base64')]));
  const runner = makeRunner('mock', { respond: () => 'use concurrently' });
  const card = runEvals({ tasks: JSON.parse(raw['evals/tasks.json'].toString()), runner, agentLabel: 'mock', skillName: 'paid-skill', skillFiles: raw, skillContentHash: skillContentHash(raw) });
  const pub = await publish({ slug: 'paid-skill', files: filesB64(m), scorecard: card });
  assert.equal(pub.status, 200, JSON.stringify(pub.json));
  const skill = store.getSkill('paid-skill');
  assert.equal(skill.price, 2900);
  assert.equal(skill.capability.terms.priceCents, skill.price, 'listing price IS the signed terms price');
  // and the actual order amount matches both
  const res = await fetch(`${base}/api/checkout/paid-skill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'b@x.com' }) });
  const co = await res.json();
  const order = store.getOrder(co.order);
  assert.equal(order.amount, skill.capability.terms.priceCents, 'buyer is charged exactly the signed terms');
});
