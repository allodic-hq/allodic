// The benchmark gate: evals must execute the explicit candidate, and no
// publish path exists "without benchmark evidence".
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRunner, runEvals } from '../src/index.js';

let pass = 0;
const t = (name, fn) => { fn(); pass++; };

const TASKS = [{ id: 't1', prompt: 'Review the migration.', mustMention: ['concurrently'] }];
const FILES = { 'SKILL.md': '# Skill\nAlways recommend CREATE INDEX CONCURRENTLY.\n', 'scripts/x.sql': 'SELECT 1;' };

t('runEvals REFUSES to run without the candidate skill', () => {
  const runner = makeRunner('mock', { respond: () => 'concurrently' });
  assert.throws(() => runEvals({ tasks: TASKS, runner, agentLabel: 'mock', skillContentHash: 'x' }),
    /requires the candidate skill/);
  assert.throws(() => runEvals({ tasks: TASKS, runner, agentLabel: 'mock', skillName: 's', skillFiles: {}, skillContentHash: 'x' }),
    /requires the candidate skill/, 'files without SKILL.md are not a candidate');
});

t('mock runner receives the candidate — grading can depend on the actual skill content', () => {
  const runner = makeRunner('mock', {
    respond: (_prompt, skill) => skill.instructions.includes('CONCURRENTLY') ? 'use concurrently' : 'looks fine',
  });
  const card = runEvals({ tasks: TASKS, runner, agentLabel: 'mock', skillName: 'idx-skill', skillFiles: FILES, skillContentHash: 'h' });
  assert.equal(card.passed, 1, 'the candidate content drove the pass');
  const bad = runEvals({ tasks: TASKS, runner, agentLabel: 'mock', skillName: 'idx-skill', skillFiles: { 'SKILL.md': '# Different skill entirely' }, skillContentHash: 'h2' });
  assert.equal(bad.passed, 0, 'a different candidate fails the same tasks');
});

t('workspace runner: candidate materialized as the ONLY skill (fresh HOME + cwd), cleaned up after', () => {
  let seen = null;
  const runner = (prompt, _skill, session) => {
    seen = { ...session };
    const p = join(session.cwd, '.claude', 'skills', 'idx-skill', 'SKILL.md');
    assert.ok(existsSync(p), 'candidate SKILL.md must be in the workspace');
    assert.ok(existsSync(join(session.cwd, '.claude', 'skills', 'idx-skill', 'scripts', 'x.sql')), 'all candidate files materialized');
    assert.notEqual(session.home, process.env.HOME, 'HOME must be isolated from the user account');
    assert.ok(!existsSync(join(session.home, '.claude')), 'fresh HOME: no other skills can shadow the candidate');
    return readFileSync(p, 'utf8'); // "the agent read the candidate"
  };
  runner.kind = 'workspace-probe';
  runner.needsWorkspace = true;
  runner.isolation = 'test probe';
  const card = runEvals({ tasks: TASKS, runner, agentLabel: 'probe', skillName: 'idx-skill', skillFiles: FILES, skillContentHash: 'h' });
  assert.equal(card.passed, 1, 'transcript came from the materialized candidate');
  assert.ok(!existsSync(seen.base), 'ephemeral workspace removed after the run');
});

t('scorecard attests HOW it ran: runner kind, isolation, explicit candidate, grading honesty', () => {
  const runner = makeRunner('mock', { respond: () => 'concurrently' });
  const card = runEvals({ tasks: TASKS, runner, agentLabel: 'mock', skillName: 's', skillFiles: FILES, skillContentHash: 'h' });
  assert.equal(card.format, 'allodic-evals/2');
  assert.equal(card.runner.candidateExplicit, true);
  assert.equal(card.runner.kind, 'mock');
  assert.match(card.grading, /reproducible floor, not a general quality judgment/);
});

console.log(`eval-gate.test.js: ${pass} passed`);
