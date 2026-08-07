#!/usr/bin/env node
// Repo hygiene: fail the suite if credential material is present anywhere in
// the tree that ships (source archive / Docker build context). This exists
// because a stale `.gryning-data/identity.json` — Ed25519 private key,
// fingerprint secret, admin key — shipped in a review archive and would have
// been copied into the Docker image (.dockerignore only excluded the
// current-branding data dir).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git']);
const NEEDLES = [
  ['BEGIN PRIVATE KEY', 'PEM private key'],
  ['BEGIN EC PRIVATE KEY', 'PEM private key'],
  ['BEGIN OPENSSH PRIVATE KEY', 'SSH private key'],
  ['"adminKey"', 'server admin credential'],
  ['"fingerprintSecret"', 'fingerprint secret'],
  ['sk_live_', 'live Stripe secret key'],
  ['whsec_', 'Stripe webhook secret'],
];
// Files that legitimately mention the FIELD NAMES (code and tests):
const ALLOW = /\.(js|md|yml|sh)$|Dockerfile$/;

const hits = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { walk(p); continue; }
    if (st.size > 2 * 1024 * 1024) continue;
    if (ALLOW.test(p)) continue; // source/docs may name the fields; never contain PEM blocks either way for .json etc.
    let text;
    try { text = readFileSync(p, 'utf8'); } catch { continue; }
    for (const [needle, what] of NEEDLES) {
      if (text.includes(needle)) hits.push(`${p}: contains ${what} ("${needle}")`);
    }
  }
})('.');

if (hits.length) {
  console.error('✗ credential material in the shipping tree:\n  ' + hits.join('\n  '));
  process.exit(1);
}
console.log('✓ no credential material in the shipping tree');
