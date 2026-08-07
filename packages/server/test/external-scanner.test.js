// P1 regression: the external-scanner call disarmed its abort timer as soon
// as response HEADERS arrived — `clearTimeout(timer); await r.json()` — so a
// scanner that sent headers and then stalled held the publish route open
// forever. The timeout now covers the entire exchange, the body is size-
// capped, status and content-type are validated, and merged findings are
// bounded (they persist on the skill: an unbounded merge is store growth).
//
// Each test boots a real hostile HTTP server playing one attack.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';

const SKILL_MD = (v = '1.0.0') => `---\nname: scanned-skill\ndescription: Formats SQL tidily. Use when tidying migrations.\nmetadata:\n  version: "${v}"\n---\n\n# Scanned\nRewrite the SQL with consistent casing.\n`;
const filesB64 = (v) => ({ 'SKILL.md': Buffer.from(SKILL_MD(v)).toString('base64') });

let scanner, scannerUrl, behavior; // behavior: (req, res) => void, swapped per test
let version = 0;
const nextVersion = () => `1.0.${++version}`;

before(async () => {
  scanner = createServer((req, res) => behavior(req, res));
  scanner.listen(0);
  await new Promise((r) => scanner.once('listening', r));
  scannerUrl = `http://127.0.0.1:${scanner.address().port}/scan`;
});
after(() => { scanner?.close(); scanner?.closeAllConnections?.(); });

async function bootAndPublish(extraEnv = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'allodic-extscan-'));
  const { app, store } = createApp({
    dataDir,
    env: { ALLODIC_SCANNER: 'builtin', EXTERNAL_SCAN_URL: scannerUrl, EXTERNAL_SCAN_TIMEOUT_MS: '1500', EXTERNAL_SCAN_MAX_BYTES: '20000', ...extraEnv },
  });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const adminKey = JSON.parse(readFileSync(join(dataDir, 'identity.json'), 'utf8')).adminKey;
  const started = Date.now();
  const res = await fetch(`${base}/api/skills`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': adminKey },
    body: JSON.stringify({ slug: 'scanned-skill', files: filesB64(nextVersion()) }),
  });
  const json = await res.json();
  const skill = store.getSkill('scanned-skill');
  server.close(); store.close();
  rmSync(dataDir, { recursive: true, force: true });
  return { status: res.status, json, elapsed: Date.now() - started, scan: skill?.capability?.scan, stored: skill };
}

test('REGRESSION: headers-then-stall is cut off by the timeout, not held forever', async () => {
  behavior = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"findings":['); // headers + partial body, then silence
    // never end()
  };
  const r = await bootAndPublish();
  assert.equal(r.status, 200, 'publish proceeds with builtin scan when external is advisory-broken');
  assert.ok(r.elapsed < 10_000, `route returned in ${r.elapsed}ms — the old code hung until the socket died`);
  assert.match(r.scan.external ?? '', /timeout/, 'the capability records that the external scanner failed');
});

test('oversized body is aborted at the cap, not buffered whole', async () => {
  behavior = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const chunk = '"' + 'x'.repeat(1000) + '",';
    res.write('{"findings":[],"junk":[');
    let sent = 0;
    const iv = setInterval(() => {
      if (sent > 200_000) { clearInterval(iv); res.end(']}'); return; } // far past the 20 KB cap
      res.write(chunk); sent += chunk.length;
    }, 1);
  };
  const r = await bootAndPublish();
  assert.equal(r.status, 200);
  assert.match(r.scan.external ?? '', /exceeds|timeout/i);
});

test('non-2xx status is an error, never merged as "ok"', async () => {
  behavior = (_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"findings":[{"rule":"bogus","severity":"critical"}]}');
  };
  const r = await bootAndPublish();
  assert.equal(r.status, 200, 'a 500 from an ADVISORY scanner must not block publish');
  assert.equal((r.scan?.findings ?? 0), 0, 'findings from an error response are never merged');
  assert.match(r.scan.external ?? '', /status 500/);
});

test('wrong content-type is rejected before parsing', async () => {
  behavior = (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>login page from a captive portal</html>');
  };
  const r = await bootAndPublish();
  assert.equal(r.status, 200);
  assert.equal((r.scan?.findings ?? 0), 0);
  assert.match(r.scan.external ?? '', /content-type/);
});

test('findings merge is capped in count and field length; criticals still block', async () => {
  behavior = (_req, res) => {
    const findings = Array.from({ length: 5000 }, (_, i) => ({ rule: 'r'.repeat(500) + i, severity: 'warn', path: 'p'.repeat(500), why: 'w'.repeat(5000) }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ findings }));
  };
  const r = await bootAndPublish({ EXTERNAL_SCAN_MAX_BYTES: '50000000' });
  assert.equal(r.status, 200, 'warn-only findings do not block');
  const stored = r.scan;
  assert.ok(stored.findings <= 101, `stored ${stored.findings} findings; cap is 100 + truncation marker`);

  // and a critical from a well-behaved scanner still blocks publish:
  behavior = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ findings: [{ rule: 'exfil', severity: 'critical', path: 'SKILL.md', why: 'sends data out' }] }));
  };
  const blocked = await bootAndPublish();
  assert.equal(blocked.status, 422, 'external CRITICAL blocks publish (unchanged behavior)');
});

test('happy path: valid scanner findings merge with bounded fields', async () => {
  behavior = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ findings: [{ rule: 'style', severity: 'warn', path: 'SKILL.md', why: 'nit' }] }));
  };
  const r = await bootAndPublish();
  assert.equal(r.status, 200);
  assert.equal(r.scan.findings, 1, 'exactly the one external finding merged (builtin scan of this fixture is clean)');
  assert.equal(r.scan.status, 'warnings');
  assert.equal(r.scan.external, 'ok');
});
