// allodic core — secure file I/O for secret-bearing state.
//
// Server identity (private signing key, fingerprint secret, admin key) and
// CLI credentials (bearer tokens) must never be world-readable. Under a
// default 022 umask, a plain writeFileSync lands at 0644 — any local user
// can read the registry's signing key. These helpers make the safe thing
// the only thing:
//
//   secureDir        0700 on create AND on every touch (repairs pre-fix dirs)
//   writeSecretJson  0600, written to a temp file then atomically renamed —
//                    a crash mid-write never leaves a torn or 0644 secret
//   hardenSecret     explicit chmod 0600 for files created before this fix
//
// chmod failures are swallowed: on non-POSIX filesystems (Windows, some
// network mounts) the mode bits are advisory at best; refusing to run there
// would protect nothing.
import { mkdirSync, writeFileSync, renameSync, chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export function secureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 }); // mode only applies to newly created dirs…
  try { chmodSync(dir, 0o700); } catch { /* non-POSIX fs */ } // …so repair existing ones explicitly
  return dir;
}

export function writeSecretJson(path, obj) {
  secureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  // 0600 at open time: the file is never observable with wider permissions,
  // even between write and chmod. umask can only clear bits 0600 doesn't have.
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path); // atomic on the same filesystem; replaces in place
}

/** Explicitly tighten a secret file that may predate secure writing. */
export function hardenSecret(path) {
  if (!existsSync(path)) return;
  try { chmodSync(path, 0o600); } catch { /* non-POSIX fs */ }
}
