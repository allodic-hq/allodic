// Color must be invisible to machines: piped output (every script, grep, CI
// assertion, and e2e check) stays byte-clean; NO_COLOR is honored and beats
// even a force-enable; ALLODIC_COLOR=1 lets tests exercise the colored path.
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = resolve(fileURLToPath(import.meta.url), '..', '..', 'bin', 'allodic.js');
const ESC = '\x1b[';

function runInit(env) {
  const d = mkdtempSync(join(tmpdir(), 'color-'));
  const out = execFileSync('node', [CLI, 'init', 'c-skill'], {
    cwd: d, encoding: 'utf8',
    env: { ...process.env, ALLODIC_TELEMETRY: '0', NO_COLOR: undefined, ALLODIC_COLOR: undefined, ...env },
  });
  rmSync(d, { recursive: true, force: true });
  return out;
}

test('piped output is byte-clean — no ANSI codes reach scripts, greps, or CI', () => {
  assert.ok(!runInit({}).includes(ESC), 'non-TTY output must carry zero escape codes');
});

test('ALLODIC_COLOR=1 forces the colored path (how tests and unusual setups opt in)', () => {
  const out = runInit({ ALLODIC_COLOR: '1' });
  assert.ok(out.includes('\x1b[32m✓\x1b[0m'), 'status marks are green when color is on');
});

test('NO_COLOR wins over everything (no-color.org)', () => {
  assert.ok(!runInit({ NO_COLOR: '1', ALLODIC_COLOR: '1' }).includes(ESC));
});

test('ALLODIC_COLOR=0 disables explicitly', () => {
  assert.ok(!runInit({ ALLODIC_COLOR: '0' }).includes(ESC));
});
