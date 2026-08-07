// allodic core — ed25519 signing over canonical JSON manifests.
// Zero dependencies: node:crypto ships ed25519.
import { generateKeyPairSync, sign as edSign, verify as edVerify, createHash } from 'node:crypto';

/** Generate a creator keypair (PEM). Private key stays with the creator/server. */
export function generateKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** Deterministic JSON: stable key order so signatures survive re-serialization. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Sign an object (manifest) -> base64 signature. */
export function signManifest(manifest, privateKeyPem) {
  const data = Buffer.from(canonicalJson(manifest));
  return edSign(null, data, privateKeyPem).toString('base64');
}

/** Verify an object against a base64 signature and PEM public key. */
export function verifyManifest(manifest, signatureB64, publicKeyPem) {
  const data = Buffer.from(canonicalJson(manifest));
  return edVerify(null, data, publicKeyPem, Buffer.from(signatureB64, 'base64'));
}
