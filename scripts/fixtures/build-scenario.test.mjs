import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildScenario, SCENARIO_NAMES } from './make-fixtures.mjs';

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

test('builds a scenario into an arbitrary directory and returns the folder to open', () => {
  const root = mkdtempSync(join(tmpdir(), 'wpfx-'));
  try {
    const dir = buildScenario('clean', root);
    assert.equal(dir, join(root, 'clean'));
    assert.ok(existsSync(join(dir, '.git')));
    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'Add version config');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('worktrees returns main/ and ahead-of-remote returns local/', () => {
  const root = mkdtempSync(join(tmpdir(), 'wpfx-'));
  try {
    assert.equal(buildScenario('worktrees', root), join(root, 'worktrees', 'main'));
    assert.equal(buildScenario('ahead-of-remote', root), join(root, 'ahead-of-remote', 'local'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rejects unknown scenarios and lists known ones', () => {
  assert.throws(() => buildScenario('nope', tmpdir()), /Unknown scenario: nope/);
  assert.ok(SCENARIO_NAMES.includes('worktrees'));
});
