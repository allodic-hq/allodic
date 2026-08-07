// Server-side benchmark gate: a modified client cannot publish a paid skill
// without a passing, candidate-explicit scorecard.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { makeRunner, runEvals, skillContentHash } from '@allodic/core';

let dataDir, server, base, adminKey;

const SKILL_MD = `---\nname: gated-skill\ndescription: Recommends safe index creation. Use when reviewing migrations.\nmetadata:\n  version: "1.0.0"\n  price: "$19"\n---\n\n# Gated\nAlways recommend CREATE INDEX CONCURRENTLY.\n`;
const TASKS = [{ id: 't1', prompt: 'Review the migration.', mustMention: ['concurrently'] }];

function filesB64(extra = {}) {
  const raw = { 'SKILL.md': Buffer.from(SKILL_MD), 'evals/tasks.json': Buffer.from(JSON.stringify(TASKS)), ...extra };
  return Object.fromEntries(Object.entries(raw).map(([p, b]) => [p, b.toString('base64')]));
}
const rawFiles = () => ({ 'SKILL.MD_unused': null });

async function publish(body) {
  const res = await fetch(`${base}/api/skills`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': adminKey },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'allodic-evalgate-'));
  const { app } = createApp({ dataDir, env: {} });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  adminKey = JSON.parse(readFileSync(join(dataDir, 'identity.json'), 'utf8')).adminKey;
});

after(() => { server?.close(); rmSync(dataDir, { recursive: true, force: true }); });

const common = { slug: 'gated-skill' }; // commercial fields derive from SKILL.md (P0.3)

test('GATE: paid skill without a scorecard is refused (422)', async () => {
  const { status, json } = await publish({ ...common, files: filesB64(), scorecard: null });
  assert.equal(status, 422);
  assert.match(json.error, /require a benchmark scorecard/);
});

test('GATE: failing scorecard is refused', async () => {
  const raw = { 'SKILL.md': Buffer.from(SKILL_MD), 'evals/tasks.json': Buffer.from(JSON.stringify(TASKS)) };
  const runner = makeRunner('mock', { respond: () => 'no relevant advice' }); // fails mustMention
  const card = runEvals({ tasks: TASKS, runner, agentLabel: 'mock', skillName: 'gated-skill', skillFiles: raw, skillContentHash: skillContentHash(raw) });
  const { status, json } = await publish({ ...common, files: filesB64(), scorecard: card });
  assert.equal(status, 422);
  assert.match(json.error, /benchmark gate failed/);
});

test('GATE: scorecard without candidate-explicit attestation is refused', async () => {
  const raw = { 'SKILL.md': Buffer.from(SKILL_MD), 'evals/tasks.json': Buffer.from(JSON.stringify(TASKS)) };
  const runner = makeRunner('mock', { respond: () => 'use concurrently' });
  const card = runEvals({ tasks: TASKS, runner, agentLabel: 'mock', skillName: 'gated-skill', skillFiles: raw, skillContentHash: skillContentHash(raw) });
  delete card.runner; // simulate a legacy/forged scorecard
  const { status, json } = await publish({ ...common, files: filesB64(), scorecard: card });
  assert.equal(status, 422);
  assert.match(json.error, /explicit candidate execution/);
});

test('GATE: passing candidate-explicit scorecard publishes', async () => {
  const raw = { 'SKILL.md': Buffer.from(SKILL_MD), 'evals/tasks.json': Buffer.from(JSON.stringify(TASKS)) };
  const runner = makeRunner('mock', { respond: () => 'use concurrently' });
  const card = runEvals({ tasks: TASKS, runner, agentLabel: 'mock', skillName: 'gated-skill', skillFiles: raw, skillContentHash: skillContentHash(raw) });
  const { status, json } = await publish({ ...common, files: filesB64(), scorecard: card });
  assert.equal(status, 200, JSON.stringify(json));
});

test('free skill may publish without evals (no badge, no gate)', async () => {
  const freeMd = SKILL_MD.replace('  price: "$19"\n', '').replace('name: gated-skill', 'name: free-skill');
  const files = { 'SKILL.md': Buffer.from(freeMd).toString('base64') };
  const { status, json } = await publish({ slug: 'free-skill', files, scorecard: null });
  assert.equal(status, 200, JSON.stringify(json));
});
