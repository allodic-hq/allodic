import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})]);

// Collect every bare-specifier import/await import() across the server source.
function usedModules() {
  const mods = new Set();
  for (const f of readdirSync(srcDir).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(join(srcDir, f), 'utf8');
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'".][^'"]*)['"]/g)) {
      const spec = m[1];
      if (spec.startsWith('node:') || spec.startsWith('.') || spec.startsWith('/')) continue;
      // package root: '@scope/name' or 'name' (strip subpaths)
      const root = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      mods.add(root);
    }
  }
  return mods;
}

test('every module imported by the server is a declared dependency', () => {
  const missing = [...usedModules()].filter((m) => !declared.has(m));
  assert.deepEqual(missing, [], `undeclared dependencies (would throw MODULE_NOT_FOUND in --omit=dev image): ${missing.join(', ')}`);
});

test('dynamically imported prod deps (stripe, nodemailer) are declared', () => {
  for (const dep of ['stripe', 'nodemailer']) {
    assert.ok(declared.has(dep), `${dep} must be declared — it is dynamically imported in a production path`);
  }
});

test('internal dependency uses a pinned version, not "*"', () => {
  const core = pkg.dependencies['@allodic/core'];
  assert.ok(core && core !== '*', '@allodic/core must be pinned, not "*"');
  assert.match(core, /^\^?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, '@allodic/core version should be a concrete semver (prerelease ok)');
});

test('the declared dependencies actually resolve (installed in the tree)', async () => {
  for (const dep of ['express', 'stripe', 'nodemailer']) {
    await assert.doesNotReject(() => import(dep), `${dep} declared but does not resolve`);
  }
});
