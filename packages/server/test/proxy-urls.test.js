// Reverse-proxy URL generation. Three configurations, pinned:
//   1. BASE_URL set        -> canonical links always, headers irrelevant
//   2. TRUST_PROXY=1 only  -> X-Forwarded-Proto honored for the fallback
//   3. neither             -> http:// fallback (the failure mode the boot
//                             warning exists for — asserted so it's intent)
import { test, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';

const SKILL = { slug: 'proxy-skill', name: 'proxy-skill', description: 'x', version: '1.0.0', price: 0, updatedAt: new Date().toISOString(), capability: {}, files: { 'SKILL.md': Buffer.from('---\nname: proxy-skill\ndescription: x\n---\nbody').toString('base64') } };

const dirs = [];
async function boot(env) {
  const dataDir = mkdtempSync(join(tmpdir(), 'allodic-proxy-'));
  dirs.push(dataDir);
  const { app, store } = createApp({ dataDir, env });
  store.putSkill({ ...SKILL });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  dirs.push({ close: () => server.close() });
  return `http://127.0.0.1:${server.address().port}`;
}

after(() => { for (const d of dirs) typeof d === 'string' ? rmSync(d, { recursive: true, force: true }) : d.close(); });

async function listingHtml(base, headers = {}) {
  const res = await fetch(`${base}/s/proxy-skill`, { headers: { accept: 'text/html', ...headers } });
  return res.text();
}

test('BASE_URL wins: links are canonical https regardless of request headers', async () => {
  const base = await boot({ BASE_URL: 'https://skills.example.dev/' }); // trailing slash normalized
  const html = await listingHtml(base); // plain http request, no forwarded headers
  assert.ok(html.includes('https://skills.example.dev/s/proxy-skill'), 'selfUrl must use BASE_URL');
  assert.ok(!html.includes(`http://127.0.0.1`), 'internal origin must not leak into links');
});

test('TRUST_PROXY=1 fallback: X-Forwarded-Proto https produces https links', async () => {
  const base = await boot({ TRUST_PROXY: '1' });
  const html = await listingHtml(base, { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9' });
  assert.match(html, /https:\/\/127\.0\.0\.1:\d+\/s\/proxy-skill/, 'forwarded proto must be honored');
});

test('neither configured: proxied request degrades to http:// (the documented failure the boot warning covers)', async () => {
  const base = await boot({});
  const html = await listingHtml(base, { 'x-forwarded-proto': 'https' });
  assert.match(html, /http:\/\/127\.0\.0\.1:\d+\/s\/proxy-skill/, 'without trust proxy, forwarded headers are correctly ignored');
});

test('install hint in checkout response uses the canonical origin', async () => {
  const base = await boot({ BASE_URL: 'https://skills.example.dev', ALLODIC_INSECURE_DEV_PAYMENTS: '1' });
  const res = await fetch(`${base}/api/checkout/proxy-skill`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'b@x.com' }),
  });
  const json = await res.json();
  assert.equal(json.install, 'npx allodic add https://skills.example.dev/s/proxy-skill');
});
