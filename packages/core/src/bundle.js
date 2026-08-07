// allodic core — the .stand bundle.
//
// A bundle is a single JSON document: { manifest, sig, files } where files maps
// relative paths to base64 content. Agent skills are small (markdown + a few
// scripts), so a JSON container keeps v1 dependency-free — no tar, no zip.
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, rmSync, renameSync, lstatSync, existsSync, realpathSync } from 'node:fs';
import { join, relative, dirname, normalize, isAbsolute, sep } from 'node:path';
import { sha256, signManifest, verifyManifest } from './sign.js';
import { deriveFingerprint, embedFingerprint } from './fingerprint.js';

const IGNORE = new Set(['.git', 'node_modules', '.DS_Store', '.stand']);

export function collectFiles(dir) {
  // P0: symlinks are REJECTED outright, not followed. statSync follows links,
  // so `innocent.txt -> ~/.ssh/id_ed25519` (or a linked directory) would be
  // read as if it belonged to the skill, published, and delivered to buyers.
  // A content scanner is not a secret-leak detector — many sensitive files
  // carry no recognizable signature — so the only safe policy for 0.1.0 is:
  // no symlinks in skill packages, and every collected path must physically
  // live under the package root.
  const root = realpathSync(dir);
  const files = {};
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      if (IGNORE.has(entry)) continue;
      const full = join(d, entry);
      const st = lstatSync(full); // lstat: examine the entry ITSELF, never its target
      if (st.isSymbolicLink()) {
        throw new Error(`symlinks are not allowed in skill packages: ${relative(dir, full)}`);
      }
      // Defense in depth: the entry's real path must remain inside the root.
      const real = realpathSync(full);
      if (real !== root && !real.startsWith(root + sep)) {
        throw new Error(`path escapes the skill directory: ${relative(dir, full)}`);
      }
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) files[relative(dir, full)] = readFileSync(full);
      else throw new Error(`unsupported file type in skill package: ${relative(dir, full)}`); // fifo, socket, device
    }
  };
  walk(dir);
  if (!files['SKILL.md']) throw new Error(`No SKILL.md found in ${dir}`);
  return files;
}

import { parseFrontmatter } from './spec.js';

/**
 * Lenient frontmatter read (parsing, not validation — mirror of the reference
 * implementation's read_properties/validate split). Returns a normalized
 * shape; allodic-specific values (version, price, author, …) live under
 * `metadata`, the spec's documented extension mechanism.
 * Never throws: unparseable input yields { metadata: {} }.
 */
export function parseSkillMeta(skillMd) {
  try {
    const { meta } = parseFrontmatter(String(skillMd));
    return { ...meta, metadata: meta.metadata ?? {} };
  } catch {
    return { metadata: {} };
  }
}

/**
 * Build a per-buyer bundle from a master skill directory (or file map).
 * Fingerprints every .md file; hashes everything; signs the manifest.
 */
export function buildBuyerBundle({ masterFiles, skillName, version, orderId, fingerprintSecret, privateKeyPem, creator, capabilityDigest = null, varied = null }) {
  const fingerprint = deriveFingerprint(orderId, fingerprintSecret);
  const outFiles = {};
  const hashes = {};

  for (const [path, buf] of Object.entries(masterFiles)) {
    let content = buf;
    if (path.endsWith('.md')) {
      content = Buffer.from(embedFingerprint(buf.toString('utf8'), fingerprint));
    }
    outFiles[path] = content.toString('base64');
    hashes[path] = sha256(content);
  }

  const manifest = {
    format: 'allodic/1',
    skill: skillName,
    version,
    creator,
    order: orderId,
    capabilityDigest,
    varied, // {path: [selected option indices]} for canary-varied files
    fingerprint,
    files: hashes,
    issuedAt: new Date().toISOString(),
  };
  const sig = signManifest(manifest, privateKeyPem);
  return { manifest, sig, files: outFiles };
}

/** Verify a bundle's signature and file hashes. Throws on any mismatch. */
/** Reject any path that could escape the install directory or is otherwise unsafe.
 *  Returns a safe relative path, or throws. */
function assertSafeRelPath(path) {
  if (typeof path !== 'string' || path.length === 0) throw new Error('bundle contains an empty file path');
  if (path === '.' || path === '..') throw new Error(`unsafe path: "${path}"`);
  if (isAbsolute(path)) throw new Error(`absolute path not allowed: "${path}"`);
  // Windows drive letters (C:\) and UNC/backslash paths
  if (/^[a-zA-Z]:/.test(path) || path.includes('\\')) throw new Error(`unsafe path (drive/UNC/backslash): "${path}"`);
  if (path.startsWith('/')) throw new Error(`absolute path not allowed: "${path}"`);
  const norm = normalize(path);
  // after normalization, any leading .. or embedded ../ means traversal
  if (norm === '..' || norm.startsWith('..' + sep) || norm.startsWith('../') || norm.includes(sep + '..' + sep) || norm.split(/[\\/]/).includes('..')) {
    throw new Error(`path traversal rejected: "${path}"`);
  }
  if (isAbsolute(norm)) throw new Error(`path resolves to absolute: "${path}"`);
  return norm;
}

export function verifyBundle(bundle, publicKeyPem) {
  const { manifest, sig, files } = bundle;
  if (!manifest || !sig || typeof files !== 'object' || files === null) {
    throw new Error('malformed bundle');
  }
  if (!verifyManifest(manifest, sig, publicKeyPem)) {
    throw new Error('Signature verification failed — bundle is not from this creator.');
  }
  const signed = Object.keys(manifest.files);
  const delivered = Object.keys(files);
  // (1) EXACT equality: no unsigned extras, no missing signed files.
  if (signed.length !== delivered.length) {
    throw new Error(`bundle file set mismatch: ${delivered.length} delivered vs ${signed.length} signed`);
  }
  const signedSet = new Set(signed);
  for (const p of delivered) {
    if (!signedSet.has(p)) throw new Error(`unsigned file in bundle: "${p}"`);
  }
  // (2-4) path safety + (verify hashes) → build a normalized, verified map.
  const verified = new Map();
  for (const [path, hash] of Object.entries(manifest.files)) {
    const safe = assertSafeRelPath(path);
    const actual = sha256(Buffer.from(files[path] ?? '', 'base64'));
    if (actual !== hash) throw new Error(`Hash mismatch on ${path} — bundle was modified.`);
    verified.set(safe, files[path]);
  }
  // Attach the verified map so installBundle cannot consume the raw object.
  return { ...manifest, verifiedFiles: verified };
}

/** Write a verified bundle to targetDir. Consumes ONLY verifyBundle's output. */
export function installBundle(verifiedOrBundle, targetDir, publicKeyPem) {
  // Accept a verifyBundle() result, or re-verify a raw bundle if a key is given.
  let verified = verifiedOrBundle?.verifiedFiles;
  if (!verified) {
    if (!publicKeyPem) throw new Error('installBundle requires a verified bundle (call verifyBundle first)');
    verified = verifyBundle(verifiedOrBundle, publicKeyPem).verifiedFiles;
  }
  const root = normalize(targetDir);
  // (7) install into a temp dir, atomically swap in after all writes succeed.
  const staging = root + '.allodic-tmp-' + Math.random().toString(36).slice(2, 10);
  try {
    for (const [safeRel, b64] of verified) {
      const dest = join(staging, safeRel);
      // (3/5) defense in depth: confirm the resolved dest stays under staging.
      const rel = relative(staging, dest);
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`refusing to write outside target: "${safeRel}"`);
      const parent = dirname(dest);
      mkdirSync(parent, { recursive: true });
      // (5) reject symlinks in the destination chain
      if (existsSync(dest) && lstatSync(dest).isSymbolicLink()) throw new Error(`refusing to overwrite symlink: "${safeRel}"`);
      writeFileSync(dest, Buffer.from(b64, 'base64'), { flag: 'wx' });
    }
    // swap: remove any prior install, move staging into place
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    renameSync(staging, root);
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}
