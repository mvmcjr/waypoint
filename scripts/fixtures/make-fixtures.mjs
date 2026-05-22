#!/usr/bin/env node
/**
 * make-fixtures.mjs
 *
 * Generates a family of real git repos under scripts/fixtures/repos/, each
 * frozen in a specific state useful for manually testing Waypoint's UI.
 *
 * Usage:
 *   node scripts/fixtures/make-fixtures.mjs          # build all scenarios
 *   node scripts/fixtures/make-fixtures.mjs clean    # rebuild one scenario
 *
 * Then open any of the generated folders in Waypoint.
 */

import { execSync }                                    from 'node:child_process';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve }                      from 'node:path';
import { fileURLToPath }                               from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPOS_DIR = resolve(__dirname, 'repos');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Git identity injected into every command so commits always have an author. */
const GIT_ENV = {
  GIT_AUTHOR_NAME:     'Fixture User',
  GIT_AUTHOR_EMAIL:    'fixture@example.com',
  GIT_COMMITTER_NAME:  'Fixture User',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
};

function run(cmd, cwd) {
  execSync(cmd, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } });
}

/** Run a command that is intentionally expected to fail (e.g. a conflicting merge). */
function tryRun(cmd, cwd) {
  try { run(cmd, cwd); } catch { /* conflict / expected non-zero exit */ }
}

/** Write a file, creating any missing parent directories automatically. */
function write(dir, relPath, content) {
  const full = join(dir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

/** Delete and recreate a directory under REPOS_DIR, return its absolute path. */
function fresh(relPath) {
  const dir = join(REPOS_DIR, relPath);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Initialise a new git repo with a predictable default branch and local identity. */
function initRepo(dir) {
  run('git init -b main', dir);
  run('git config user.name "Fixture User"', dir);
  run('git config user.email "fixture@example.com"', dir);
}

// ── Scenarios ─────────────────────────────────────────────────────────────────

/**
 * CLEAN
 * A healthy repo: three commits on main, a feature branch, nothing pending.
 * Good for checking the timeline, graph lanes, and branch labels.
 */
function makeClean() {
  const dir = fresh('clean');
  initRepo(dir);

  write(dir, 'README.md',      '# Clean Repo\n\nA simple repo with a few commits.\n');
  write(dir, 'src/index.js',   'console.log("hello");\n');
  write(dir, 'src/utils.js',   'export function greet(name) {\n  return `Hello, ${name}!`;\n}\n');
  run('git add .', dir);
  run('git commit -m "Initial commit"', dir);

  write(dir, 'src/index.js', 'import { greet } from "./utils.js";\nconsole.log(greet("world"));\n');
  run('git add .', dir);
  run('git commit -m "Use greet helper in index"', dir);

  // Feature branch with its own commit (creates two-lane graph)
  run('git checkout -b feature/dark-mode', dir);
  write(dir, 'src/theme.js', 'export const THEME = "dark";\n');
  run('git add .', dir);
  run('git commit -m "Add dark mode theme constant"', dir);

  run('git checkout main', dir);
  write(dir, 'src/config.js', 'export const VERSION = "1.0.0";\n');
  run('git add .', dir);
  run('git commit -m "Add version config"', dir);

  log('clean', dir);
}

/**
 * STAGED
 * Mix of staged and unstaged changes — no conflicts.
 * Tests the staging panel: stage/unstage, file diff viewer.
 */
function makeStaged() {
  const dir = fresh('staged');
  initRepo(dir);

  write(dir, 'README.md',    '# Staged Repo\n');
  write(dir, 'app.js',       'function main() {\n  console.log("start");\n}\nmain();\n');
  write(dir, 'config.json',  '{ "debug": false }\n');
  write(dir, 'src/api.js',   'export async function fetchData(url) {\n  return fetch(url);\n}\n');
  run('git add .', dir);
  run('git commit -m "Initial commit"', dir);

  // Staged: new file added to index
  write(dir, 'src/feature.js', 'export function feature() {\n  return 42;\n}\n');
  run('git add src/feature.js', dir);

  // Staged: modified existing file
  write(dir, 'config.json', '{ "debug": true, "verbose": true, "logLevel": "info" }\n');
  run('git add config.json', dir);

  // Unstaged: modified file (not added)
  write(dir, 'app.js', 'function main() {\n  console.log("start");\n  console.log("running...");\n}\nmain();\n');

  // Unstaged: untracked file
  write(dir, 'scratch.txt', 'TODO: remove before committing\n');

  log('staged', dir);
}

/**
 * MERGE-CONFLICT
 * A `git merge` that stopped mid-way due to conflicts in shared.js.
 * MERGE_HEAD is set; the conflict panel should open automatically.
 */
function makeMergeConflict() {
  const dir = fresh('merge-conflict');
  initRepo(dir);

  write(dir, 'README.md', '# Merge Conflict Repo\n');
  write(dir, 'shared.js', [
    'export const VALUE = 1;',
    'export const NAME  = "original";',
    'export const EXTRA = "untouched";',
    '',
  ].join('\n'));
  write(dir, 'other.js', 'export const HELPER = true;\n');
  run('git add .', dir);
  run('git commit -m "Initial commit"', dir);

  // Feature branch: change VALUE and NAME
  run('git checkout -b feature', dir);
  write(dir, 'shared.js', [
    'export const VALUE = 99;',
    'export const NAME  = "feature";',
    'export const EXTRA = "untouched";',
    '',
  ].join('\n'));
  write(dir, 'feature-only.js', '// Only on feature branch\nexport const FEATURE_FLAG = true;\n');
  run('git add .', dir);
  run('git commit -m "Set VALUE=99 and NAME=feature on feature branch"', dir);

  // Main branch: change the same lines differently → conflict
  run('git checkout main', dir);
  write(dir, 'shared.js', [
    'export const VALUE = 42;',
    'export const NAME  = "main";',
    'export const EXTRA = "untouched";',
    '',
  ].join('\n'));
  write(dir, 'other.js', 'export const HELPER = true;\nexport const ADDED_ON_MAIN = "yes";\n');
  run('git add .', dir);
  run('git commit -m "Set VALUE=42 and NAME=main on main branch"', dir);

  // Merge → leaves repo in conflicted state (tryRun swallows the non-zero exit)
  tryRun('git merge --no-ff feature --no-edit', dir);

  log('merge-conflict', dir);
}

/**
 * CHERRY-PICK CONFLICT
 * A cherry-pick that stopped mid-way due to a conflict.
 * Tests the cherry-pick variant of the conflict panel.
 */
function makeCherryPickConflict() {
  const dir = fresh('cherry-pick-conflict');
  initRepo(dir);

  write(dir, 'app.js', [
    'const greeting = "Hello";',
    'const farewell = "Goodbye";',
    'console.log(greeting, farewell);',
    '',
  ].join('\n'));
  run('git add .', dir);
  run('git commit -m "Initial commit"', dir);

  // A commit on a side branch whose change we will cherry-pick
  run('git checkout -b donor', dir);
  write(dir, 'app.js', [
    'const greeting = "Hi there";',
    'const farewell = "Goodbye";',
    'console.log(greeting, farewell);',
    '',
  ].join('\n'));
  run('git add .', dir);
  run('git commit -m "Change greeting to Hi there"', dir);
  const donorOid = execSync('git rev-parse HEAD', { cwd: dir, env: { ...process.env, ...GIT_ENV } })
    .toString().trim();

  // Back to main: conflicting change on the same line
  run('git checkout main', dir);
  write(dir, 'app.js', [
    'const greeting = "Howdy";',
    'const farewell = "See ya";',
    'console.log(greeting, farewell);',
    '',
  ].join('\n'));
  run('git add .', dir);
  run('git commit -m "Change greeting to Howdy"', dir);

  // Cherry-pick the donor commit → conflict
  tryRun(`git cherry-pick ${donorOid}`, dir);

  log('cherry-pick-conflict', dir);
}

/**
 * DETACHED HEAD
 * HEAD is checked out at a specific commit (not a branch).
 * Tests the amber "detached" indicator in the toolbar.
 */
function makeDetachedHead() {
  const dir = fresh('detached-head');
  initRepo(dir);

  write(dir, 'README.md', '# Detached HEAD Repo\n');
  run('git add .', dir);
  run('git commit -m "v1.0 — initial release"', dir);

  write(dir, 'CHANGELOG.md', '## v1.1\n- Added feature X\n');
  run('git add .', dir);
  run('git commit -m "v1.1 — add feature X"', dir);

  // Save this OID; we will detach here
  const targetOid = execSync('git rev-parse HEAD', { cwd: dir, env: { ...process.env, ...GIT_ENV } })
    .toString().trim();

  write(dir, 'CHANGELOG.md', '## v1.2\n- Added feature Y\n\n## v1.1\n- Added feature X\n');
  run('git add .', dir);
  run('git commit -m "v1.2 — add feature Y"', dir);

  // Detach HEAD at v1.1
  run(`git checkout ${targetOid}`, dir);

  log('detached-head', dir);
}

/**
 * AHEAD OF REMOTE
 * A cloned repo whose local branch is 2 commits ahead of origin/main.
 * Tests push indicators and the Push button.
 * ⚠ Open the `local/` subdirectory in Waypoint, not the parent folder.
 */
function makeAheadOfRemote() {
  // Clean the whole parent folder so both remote and local are rebuilt together
  const baseDir = join(REPOS_DIR, 'ahead-of-remote');
  if (existsSync(baseDir)) rmSync(baseDir, { recursive: true, force: true });

  const remoteDir = join(baseDir, 'remote.git');
  const localDir  = join(baseDir, 'local');
  mkdirSync(remoteDir, { recursive: true });
  mkdirSync(localDir,  { recursive: true });

  // Bare remote
  run('git init --bare -b main', remoteDir);

  // Clone it locally and push an initial commit
  run(`git clone "${remoteDir}" "${localDir}"`, baseDir);
  run('git config user.name "Fixture User"', localDir);
  run('git config user.email "fixture@example.com"', localDir);

  write(localDir, 'README.md', '# Ahead of Remote\n');
  run('git add .', localDir);
  run('git commit -m "Initial commit"', localDir);
  run('git push origin main', localDir);

  // Two local commits that have NOT been pushed → 2 ahead of origin/main
  write(localDir, 'src/feature-a.js', 'export function featureA() { return "a"; }\n');
  run('git add .', localDir);
  run('git commit -m "Add feature A"', localDir);

  write(localDir, 'src/feature-b.js', 'export function featureB() { return "b"; }\n');
  run('git add .', localDir);
  run('git commit -m "Add feature B"', localDir);

  log('ahead-of-remote', join(baseDir, 'local'), '(open the local/ subfolder in Waypoint)');
}

/**
 * STASH
 * One stash entry; partially staged working tree.
 * Tests the stash list panel.
 */
function makeStash() {
  const dir = fresh('stash');
  initRepo(dir);

  write(dir, 'main.py', 'def hello():\n    print("hello")\n\nhello()\n');
  write(dir, 'utils.py', 'def noop():\n    pass\n');
  run('git add .', dir);
  run('git commit -m "Initial commit"', dir);

  // Modify a tracked file and add an untracked file, then stash both
  write(dir, 'main.py', 'def hello(name="world"):\n    print(f"hello {name}")\n\nhello()\n');
  write(dir, 'wip.py',  '# work in progress — not yet committed\n');
  run('git stash push --include-untracked -m "WIP: keyword argument for hello"', dir);

  // A commit on top so the stash is actually behind HEAD
  write(dir, 'utils.py', 'def noop():\n    pass\n\ndef identity(x):\n    return x\n');
  run('git add .', dir);
  run('git commit -m "Add identity helper"', dir);

  log('stash', dir);
}

/**
 * TAGS
 * Lightweight and annotated tags across multiple commits and branches.
 * Tests the tag display in the sidebar and timeline.
 */
function makeTags() {
  const dir = fresh('tags');
  initRepo(dir);

  write(dir, 'CHANGELOG.md', '# Changelog\n\n## v1.0.0\n- Initial release\n');
  run('git add .', dir);
  run('git commit -m "Release v1.0.0"', dir);
  run('git tag v1.0.0', dir);                                        // lightweight

  write(dir, 'CHANGELOG.md', '# Changelog\n\n## v1.1.0\n- New feature\n\n## v1.0.0\n- Initial release\n');
  run('git add .', dir);
  run('git commit -m "Release v1.1.0"', dir);
  run('git tag -a v1.1.0 -m "v1.1.0 — new feature added"', dir);    // annotated

  // Hotfix branch off v1.1.0
  run('git checkout -b hotfix/v1.1.1', dir);
  write(dir, 'HOTFIX.md', '# Hotfix v1.1.1\nFixes a critical regression.\n');
  run('git add .', dir);
  run('git commit -m "Hotfix: patch critical regression"', dir);
  run('git tag -a v1.1.1 -m "v1.1.1 — hotfix release"', dir);

  // Back to main for v2.0.0
  run('git checkout main', dir);
  write(dir, 'CHANGELOG.md', '# Changelog\n\n## v2.0.0\n- Breaking changes\n\n## v1.1.0\n- New feature\n');
  run('git add .', dir);
  run('git commit -m "Release v2.0.0"', dir);
  run('git tag -a v2.0.0 -m "v2.0.0 — major release with breaking changes"', dir);

  log('tags', dir);
}

// ── Runner ────────────────────────────────────────────────────────────────────

function log(name, dir, note = '') {
  const rel = dir.replace(REPOS_DIR + '\\', '').replace(REPOS_DIR + '/', '');
  console.log(`  ✓  ${name.padEnd(24)} → scripts/fixtures/repos/${rel}  ${note}`);
}

const SCENARIOS = [
  ['clean',                makeClean],
  ['staged',               makeStaged],
  ['merge-conflict',       makeMergeConflict],
  ['cherry-pick-conflict', makeCherryPickConflict],
  ['detached-head',        makeDetachedHead],
  ['ahead-of-remote',      makeAheadOfRemote],
  ['stash',                makeStash],
  ['tags',                 makeTags],
];

mkdirSync(REPOS_DIR, { recursive: true });

const filter = process.argv[2];  // optional: rebuild a single scenario by name

console.log('Building fixture repos…\n');

let built = 0, failed = 0;
for (const [name, fn] of SCENARIOS) {
  if (filter && name !== filter) continue;
  try {
    fn();
    built++;
  } catch (e) {
    console.error(`  ✗  ${name}: ${e.message}`);
    failed++;
  }
}

console.log(`\n${built} repo(s) written to: ${REPOS_DIR}`);
if (failed) console.error(`${failed} scenario(s) failed — see errors above.`);
