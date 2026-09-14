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
 * UNTRACKED
 * A clean committed baseline plus several untracked files (a single file, a
 * multi-line file, and files inside a brand-new untracked directory). Nothing
 * is staged. Tests that untracked files show the green "A" badge and that
 * clicking one renders its full content in the diff view.
 */
function makeUntracked() {
  const dir = fresh('untracked');
  initRepo(dir);

  write(dir, 'README.md', '# Untracked\n\nAll the files below are untracked — none staged. Click any to see its diff.\n');
  run('git add .', dir);
  run('git commit -m "Initial commit"', dir);

  // Untracked: simple single-line file
  write(dir, 'notes.txt', 'Just a scratch note.\n');

  // Untracked: multi-line source file (exercises hunk/line rendering in the diff view)
  write(dir, 'src/new-feature.js', [
    'export function newFeature(input) {',
    '  const trimmed = input.trim();',
    '  if (!trimmed) return null;',
    '  return trimmed.toUpperCase();',
    '}',
    '',
  ].join('\n'));

  // Untracked: files inside a brand-new directory (recurse_untracked_dirs path)
  write(dir, 'assets/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"></svg>\n');
  write(dir, 'assets/data/config.yml', 'enabled: true\nlevel: 3\n');

  log('untracked', dir, '(all files untracked → green "A" badge, diffs show full content)');
}

/**
 * HUNKS
 * A file with several well-separated edits (non-adjacent, so each becomes its
 * own hunk) left entirely unstaged — open it in Waypoint and try "Stage hunk"
 * on each one individually. A second file gets the same treatment but is then
 * staged and committed whole, so its multi-hunk diff is also viewable
 * read-only from the commit history (no hunk-action buttons there).
 */
function makeHunks() {
  const dir = fresh('hunks');
  initRepo(dir);

  const calcLines = (a, b, c, d, e, f) => [
    'def add(x, y):',
    `    return x + y  # ${a}`,
    '',
    '',
    '',
    'def subtract(x, y):',
    `    return x - y  # ${b}`,
    '',
    '',
    '',
    'def multiply(x, y):',
    `    return x * y  # ${c}`,
    '',
    '',
    '',
    'def divide(x, y):',
    `    return x / y  # ${d}`,
    '',
    '',
    '',
    'def power(x, y):',
    `    return x ** y  # ${e}`,
    '',
    '',
    '',
    'def modulo(x, y):',
    `    return x % y  # ${f}`,
    '',
  ].join('\n');

  write(dir, 'README.md', '# Hunks\n\nOpen `calc.py` under Unstaged — it has three non-adjacent edits, so\nthe diff view shows three separate hunks, each with its own "Stage hunk"\nbutton. `strings.py` shows the read-only side: its multi-hunk change was\nalready staged and committed, so its diff appears in the commit history\nwith no hunk-action buttons.\n');
  write(dir, 'calc.py', calcLines('v1', 'v1', 'v1', 'v1', 'v1', 'v1'));

  const stringsBefore = [
    'def shout(s):',
    '    return s.upper()',
    '',
    '',
    '',
    'def whisper(s):',
    '    return s.lower()',
    '',
    '',
    '',
    'def reverse(s):',
    '    return s[::-1]',
    '',
  ].join('\n');
  write(dir, 'strings.py', stringsBefore);

  run('git add .', dir);
  run('git commit -m "Initial commit"', dir);

  // calc.py: three non-adjacent edits → three separate hunks, left unstaged.
  write(dir, 'calc.py', calcLines('fixed rounding', 'v1', 'now clamps to zero', 'v1', 'v1', 'guards divisor'));

  // strings.py: two non-adjacent edits, staged and committed whole — a
  // multi-hunk diff you can browse read-only from the commit history.
  const stringsAfter = [
    'def shout(s):',
    '    return s.upper() + "!"',
    '',
    '',
    '',
    'def whisper(s):',
    '    return s.lower()',
    '',
    '',
    '',
    'def reverse(s):',
    '    return "".join(reversed(s))',
    '',
  ].join('\n');
  write(dir, 'strings.py', stringsAfter);
  run('git add strings.py', dir);
  run('git commit -m "Tweak shout punctuation and reverse implementation"', dir);

  log('hunks', dir, '(calc.py: 3 unstaged hunks to try "Stage hunk" on; strings.py: committed multi-hunk diff)');
}

/**
 * NOT-A-REPO
 * A plain folder with files and no .git at all. Opening it should raise the
 * "Not a Git repository — initialize one here?" dialog rather than an error.
 *
 * ⚠ This folder lives inside the Waypoint checkout, so the dialog will also show
 * the amber "already inside the repository at …" warning and the button reads
 * "Initialize Anyway" — that nested-repo warning is itself part of what to check.
 * To see the plain, warning-free version, copy the folder somewhere outside any
 * repo (e.g. your Desktop) and open that instead.
 */
function makeNotARepo() {
  const dir = fresh('not-a-repo');

  write(dir, 'README.md', '# Not A Repo\n\nThere is no .git here. Opening this folder in Waypoint should offer to create one.\n');
  write(dir, 'index.js', 'console.log("no version control yet");\n');
  write(dir, 'src/main.js', 'export function main() {\n  return "hello";\n}\n');

  log('not-a-repo', dir, '(no .git → init prompt; nested-repo warning expected in-tree)');
}

/**
 * EMPTY-REPO
 * `git init` with files on disk but no commits — HEAD is unborn. Used to blank
 * the whole window; should now show the branch name, the WIP row, and the staging
 * panel so the first commit can be made.
 */
function makeEmptyRepo() {
  const dir = fresh('empty-repo');
  initRepo(dir);

  write(dir, 'README.md', '# Empty Repo\n\nNo commits yet. The staging panel should open automatically so you can make the first one.\n');
  write(dir, 'src/app.js', 'export function app() {\n  return "first commit pending";\n}\n');
  write(dir, 'notes/todo.txt', 'write the first commit\n');

  log('empty-repo', dir, '(unborn HEAD, all untracked → WIP row + staging panel)');
}

/**
 * EMPTY-REPO-STAGED
 * Same unborn HEAD, but everything is already staged. Checks the initial-commit
 * path (no parent commit) and that Push/Pull stay disabled until a commit exists.
 * "Discard all" here should unstage without deleting the staged files.
 */
function makeEmptyRepoStaged() {
  const dir = fresh('empty-repo-staged');
  initRepo(dir);

  write(dir, 'README.md', '# Empty Repo (staged)\n\nEverything below is staged, but there is still no commit.\n');
  write(dir, 'src/index.js', 'console.log("staged, never committed");\n');
  run('git add .', dir);

  // One untracked file alongside the staged ones — "Discard all" should delete
  // only this file and leave the staged ones on disk.
  write(dir, 'scratch.txt', 'untracked — safe to delete\n');

  log('empty-repo-staged', dir, '(unborn HEAD, staged files + 1 untracked → commit / discard-all)');
}

/**
 * ORPHAN-BRANCH
 * Real commits exist, but HEAD points at a branch that does not exist yet
 * (`git checkout --orphan`): unborn HEAD with a fully populated index and working
 * tree. "Discard all" must delete only the untracked file and keep every indexed
 * file — clearing the index without that distinction wiped the working tree.
 */
function makeOrphanBranch() {
  const dir = fresh('orphan-branch');
  initRepo(dir);

  write(dir, 'keep-me.js', 'export const IMPORTANT = "do not delete";\n');
  write(dir, 'src/lib.js', 'export function lib() {\n  return 1;\n}\n');
  run('git add .', dir);
  run('git commit -m "Initial commit"', dir);

  // Orphan branch: index + working tree stay populated, HEAD becomes unborn.
  run('git checkout --orphan fresh-start', dir);
  write(dir, 'delete-me.txt', 'untracked — this is the only file discard-all should remove\n');

  log('orphan-branch', dir, '(unborn HEAD + populated index → discard-all must keep tracked files)');
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
 * CHERRY-PICK READY
 * Clean repo (no pending operations) with a `donor` branch whose tip commit
 * conflicts with main when cherry-picked. Open in Waypoint, right-click the
 * donor commit, choose "Cherry-pick", and the conflict panel should appear.
 *
 * The conflict is spread across multiple lines so the full-file context view
 * in the hunk picker has enough surrounding code to be meaningful.
 */
function makeCherryPickReady() {
  const dir = fresh('cherry-pick-ready');
  initRepo(dir);

  // ── Shared baseline ──────────────────────────────────────────────────────
  write(dir, 'README.md', '# Cherry-pick Ready\n\nOpen in Waypoint, right-click the "feat: use staging config" commit on the donor branch, and cherry-pick it onto main to trigger a conflict.\n');

  write(dir, 'src/config.js', [
    '// Application configuration',
    'export const API_URL  = "https://api.example.com";',
    'export const TIMEOUT  = 5000;',
    'export const RETRIES  = 3;',
    'export const VERSION  = "1.0.0";',
    'export const DEBUG    = false;',
    '',
  ].join('\n'));

  write(dir, 'src/utils.js', [
    'export function sleep(ms) {',
    '  return new Promise((resolve) => setTimeout(resolve, ms));',
    '}',
    '',
    'export function clamp(n, min, max) {',
    '  return Math.min(Math.max(n, min), max);',
    '}',
    '',
  ].join('\n'));

  write(dir, 'src/api.js', [
    'import { API_URL, TIMEOUT } from "./config.js";',
    '',
    'export async function fetchData(path) {',
    '  const controller = new AbortController();',
    '  const timer = setTimeout(() => controller.abort(), TIMEOUT);',
    '  try {',
    '    const res = await fetch(`${API_URL}${path}`, { signal: controller.signal });',
    '    return res.json();',
    '  } finally {',
    '    clearTimeout(timer);',
    '  }',
    '}',
    '',
  ].join('\n'));

  run('git add .', dir);
  run('git commit -m "Initial commit: add config, utils, and api"', dir);

  // ── Donor branch ─────────────────────────────────────────────────────────
  // This commit modifies config.js in a way that will conflict with main.
  run('git checkout -b donor', dir);

  write(dir, 'src/config.js', [
    '// Application configuration',
    'export const API_URL  = "https://api.staging.example.com";',
    'export const TIMEOUT  = 3000;',
    'export const RETRIES  = 5;',
    'export const VERSION  = "1.0.0";',
    'export const DEBUG    = true;',
    '',
  ].join('\n'));

  // Also add a file that won't conflict — applies cleanly during cherry-pick.
  write(dir, 'src/logger.js', [
    'export function log(level, msg) {',
    '  console[level](`[${level.toUpperCase()}] ${msg}`);',
    '}',
    '',
  ].join('\n'));

  run('git add .', dir);
  run('git commit -m "feat: use staging config and add logger"', dir);

  // ── Main branch: diverging changes on the same lines ─────────────────────
  run('git checkout main', dir);

  write(dir, 'src/config.js', [
    '// Application configuration',
    'export const API_URL  = "https://api.production.example.com";',
    'export const TIMEOUT  = 10000;',
    'export const RETRIES  = 3;',
    'export const VERSION  = "1.1.0";',
    'export const DEBUG    = false;',
    '',
  ].join('\n'));

  run('git add .', dir);
  run('git commit -m "release: point to production API, raise timeout, bump version"', dir);

  // A second commit on main so the timeline has more to show.
  write(dir, 'src/utils.js', [
    'export function sleep(ms) {',
    '  return new Promise((resolve) => setTimeout(resolve, ms));',
    '}',
    '',
    'export function clamp(n, min, max) {',
    '  return Math.min(Math.max(n, min), max);',
    '}',
    '',
    'export function formatDuration(ms) {',
    '  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;',
    '}',
    '',
  ].join('\n'));

  run('git add .', dir);
  run('git commit -m "feat: add formatDuration util"', dir);

  log('cherry-pick-ready', dir,
    '(right-click "feat: use staging config" on donor → cherry-pick → conflict)');
}

/**
 * CHERRY-PICK CLEAN
 * A `donor` branch has an isolated commit that touches only a new file
 * (src/analytics.js) — main never touches that file, so cherry-picking it
 * onto main applies with zero conflicts.
 *
 * Open in Waypoint, right-click "feat: add analytics module" on the donor
 * branch, and cherry-pick it.  The dialog should offer "Commit Cherry-pick"
 * or "Leave staged" — no conflict panel should appear.
 */
function makeCherryPickClean() {
  const dir = fresh('cherry-pick-clean');
  initRepo(dir);

  write(dir, 'README.md',
    '# Cherry-pick Clean\n\n' +
    'Right-click the **"feat: add analytics module"** commit on the `donor` branch\n' +
    'and cherry-pick it onto `main`.\n\n' +
    'There are no conflicts — the dialog should ask whether to commit now or leave staged.\n');

  write(dir, 'src/app.js', [
    'import { render } from "./render.js";',
    '',
    'render(document.getElementById("root"));',
    '',
  ].join('\n'));

  write(dir, 'src/render.js', [
    'export function render(el) {',
    '  el.textContent = "Hello, Waypoint!";',
    '}',
    '',
  ].join('\n'));

  run('git add .', dir);
  run('git commit -m "Initial commit: app skeleton"', dir);

  // ── Main: adds a feature on its own file ────────────────────────────────
  write(dir, 'src/router.js', [
    'export function navigate(path) {',
    '  window.history.pushState({}, "", path);',
    '}',
    '',
  ].join('\n'));

  run('git add .', dir);
  run('git commit -m "feat: add client-side router"', dir);

  // ── Donor: adds analytics — completely separate file from router.js ─────
  run('git checkout -b donor', dir);

  write(dir, 'src/analytics.js', [
    'let _enabled = false;',
    '',
    'export function enableAnalytics() {',
    '  _enabled = true;',
    '}',
    '',
    'export function track(event, props = {}) {',
    '  if (!_enabled) return;',
    '  console.log("[analytics]", event, props);',
    '}',
    '',
  ].join('\n'));

  run('git add .', dir);
  run('git commit -m "feat: add analytics module"', dir);

  // ── Back to main ────────────────────────────────────────────────────────
  run('git checkout main', dir);

  log('cherry-pick-clean', dir,
    '(right-click "feat: add analytics module" on donor → cherry-pick → no conflicts)');
}

/**
 * SQUASHABLE
 * A `feature` branch with a linear chain of small WIP commits on top of a
 * shared base. Right-click the first feature commit ("wip: scaffold parser")
 * and choose "Squash up to HEAD…" — the four feature commits collapse into one.
 *
 * Stays purely linear (no merges) so the squash range is unambiguous, and the
 * base commit has a single parent so it can become the squashed commit's parent.
 */
function makeSquashable() {
  const dir = fresh('squashable');
  initRepo(dir);

  // ── Shared baseline on main ───────────────────────────────────────────────
  write(dir, 'README.md', '# Squashable\n\nRight-click "wip: scaffold parser" on the `feature` branch and choose "Squash up to HEAD…".\n');
  write(dir, 'src/index.js', 'console.log("app start");\n');
  run('git add .', dir);
  run('git commit -m "Initial commit"', dir);

  write(dir, 'src/index.js', 'import "./parser.js";\nconsole.log("app start");\n');
  run('git add .', dir);
  run('git commit -m "Wire parser entrypoint"', dir);

  // ── Feature branch: a chain of small commits begging to be squashed ───────
  run('git checkout -b feature', dir);

  write(dir, 'src/parser.js', 'export function parse() {\n  // TODO\n}\n');
  run('git add .', dir);
  run('git commit -m "wip: scaffold parser"', dir);

  write(dir, 'src/parser.js', 'export function parse(input) {\n  return input.split(" ");\n}\n');
  run('git add .', dir);
  run('git commit -m "wip: tokenize on spaces"', dir);

  write(dir, 'src/parser.js', 'export function parse(input) {\n  return input.trim().split(/\\s+/);\n}\n');
  run('git add .', dir);
  run('git commit -m "fix: handle extra whitespace"', dir);

  write(dir, 'src/parser.test.js', 'import { parse } from "./parser.js";\nconsole.assert(parse(" a  b ").length === 2);\n');
  run('git add .', dir);
  run('git commit -m "test: add parser smoke test"', dir);

  log('squashable', dir,
    '(right-click "wip: scaffold parser" on feature → Squash up to HEAD → 4 commits become 1)');
}

/**
 * MANY-REFS
 * A single commit carrying many branches and tags — more than the timeline
 * shows inline (MAX_REFS = 3). Tests the "+N" overflow badge: hovering it
 * should reveal every ref in a wrapped, scrollable hover card.
 */
function makeManyRefs() {
  const dir = fresh('many-refs');
  initRepo(dir);

  write(dir, 'README.md', '# Many Refs\n\nOne commit, lots of branches and tags. Hover the "+N" badge in the timeline.\n');
  run('git add .', dir);
  run('git commit -m "Initial commit"', dir);

  write(dir, 'src/index.js', 'export const APP = "many-refs";\n');
  run('git add .', dir);
  run('git commit -m "Add app entrypoint"', dir);

  // Pile a dozen branches onto the current HEAD without moving it.
  const branches = [
    'feature/login', 'feature/signup', 'feature/dashboard', 'feature/settings',
    'bugfix/header', 'bugfix/footer', 'release/v2', 'release/v3',
    'experiment/dark-mode', 'experiment/new-nav', 'hotfix/crash', 'chore/deps',
  ];
  for (const b of branches) {
    run(`git branch ${b}`, dir);
  }

  // A few tags on the same commit for good measure.
  run('git tag v2.0.0', dir);
  run('git tag -a v2.0.0-rc1 -m "release candidate"', dir);
  run('git tag latest', dir);

  // Stay on main so HEAD shares the commit with all the above.
  log('many-refs', dir, `(${branches.length} branches + 3 tags on one commit → hover "+N")`);
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
 * WORKTREES
 * A parent folder holding the main repo (`main/`) plus a full set of linked
 * git worktrees as siblings, covering every worktree state Waypoint's UI
 * handles: clean + already-merged, dirty with a live change count and a
 * cross-branch stash, a conflicted merge-in-progress, detached HEAD, locked,
 * missing (deleted but unpruned), long near-identical names, and a worktree
 * nested inside main's own working tree.
 *
 * Open `main/` in Waypoint — main itself stays clean except for the
 * untracked `.worktrees/` folder. Worktree paths are absolute, so if this
 * checkout is ever moved, re-run `pnpm fixtures worktrees` to regenerate
 * them pointing at the new location.
 */
function makeWorktrees() {
  // Clean the whole parent folder wholesale — all worktree admin data lives
  // in main/.git, so removing it removes every linked worktree's
  // registration too. Nothing stale can survive a rebuild.
  const baseDir = join(REPOS_DIR, 'worktrees');
  if (existsSync(baseDir)) rmSync(baseDir, { recursive: true, force: true });
  mkdirSync(baseDir, { recursive: true });

  const mainDir = join(baseDir, 'main');
  mkdirSync(mainDir, { recursive: true });
  initRepo(mainDir);

  // ── Main repo: a few commits ──────────────────────────────────────────
  write(mainDir, 'README.md', [
    '# Worktrees Demo',
    '',
    'Open THIS folder (`main/`) in Waypoint. Every other folder next to it is',
    "a linked git worktree sharing this repo's history — together they cover",
    "every worktree state Waypoint's UI handles.",
    '',
    '## What to look at',
    '',
    '- **Worktrees sidebar section** — check off each state as you find it:',
    '  - `agent-clean` (agent/clean): merged check — its branch is already an',
    '    ancestor of main, no commits of its own.',
    '  - `agent-dirty` (agent/dirty): live change count badge shows 3',
    '    (staged + unstaged + untracked).',
    '  - `agent-conflict` (agent/conflict): conflict tag — a merge of main is',
    '    stopped mid-way with a real conflict in `src/utils.js`.',
    '  - `agent-detached`: amber detached-HEAD hash instead of a branch name.',
    '  - `agent-locked` (agent/locked): lock glyph — locked with reason',
    '    "agent running".',
    '  - `agent-missing` (agent/missing): missing row — its folder was',
    '    deleted without pruning; use "Prune missing" to clear it.',
    '  - `waypoint-agent-1-longer-suffix` / `waypoint-agent-2-longer-suffix`:',
    '    long, nearly-identical names — check path/name truncation.',
    '',
    '- **Branches panel**: right-click `agent/dirty` — it should offer',
    '  "Open worktree" instead of "Checkout" (it is already checked out',
    '  elsewhere).',
    '',
    '- **Merge**: merging `agent/dirty` into `main` should show a caution',
    '  banner about uncommitted changes in that worktree before proceeding.',
    '',
    '- **Stashes**: the stash list shows "agent WIP on agent/dirty" — it was',
    '  created inside the `agent-dirty` worktree. Applying/popping it from',
    '  `main` should prompt a cross-branch confirmation.',
    '',
    '- **Remove worktree**: removing `agent-clean` should offer an',
    '  "Also delete branch" option (safe — it is fully merged).',
    '',
    '- **Discard all** (in `main`): must NOT touch `.worktrees/nested-agent`',
    "  — that's a real linked worktree living inside main's own working",
    '  tree, not throwaway working-directory clutter.',
    '',
    '## Notes',
    '',
    '- `main` itself is clean except for one untracked entry: `.worktrees/`',
    '  (the nested worktree living inside it).',
    '- Worktree paths are recorded as absolute paths inside `main/.git`. If',
    '  you move this checkout, regenerate with `pnpm fixtures worktrees` so',
    '  the paths point at the new location again.',
    '',
  ].join('\n'));
  write(mainDir, 'src/app.js', 'export const APP = "worktrees-demo";\n');
  run('git add .', mainDir);
  run('git commit -m "Initial commit"', mainDir);

  write(mainDir, 'src/utils.js', [
    'export function noop() {}',
    '',
    'export function identity(x) {',
    '  return x;',
    '}',
    '',
  ].join('\n'));
  run('git add .', mainDir);
  run('git commit -m "Add utils module"', mainDir);

  // Earlier commit (before the config module and the conflict setup below)
  // to detach the agent-detached worktree at.
  const earlyOid = execSync('git rev-parse HEAD', { cwd: mainDir, env: { ...process.env, ...GIT_ENV } })
    .toString().trim();

  write(mainDir, 'src/config.js', 'export const VERSION = "1.0.0";\n');
  run('git add .', mainDir);
  run('git commit -m "Add config module"', mainDir);

  // ── Sibling worktree paths (absolute, as `git worktree add` requires) ───
  const cleanPath    = join(baseDir, 'agent-clean');
  const dirtyPath    = join(baseDir, 'agent-dirty');
  const conflictPath = join(baseDir, 'agent-conflict');
  const detachedPath = join(baseDir, 'agent-detached');
  const lockedPath   = join(baseDir, 'agent-locked');
  const missingPath  = join(baseDir, 'agent-missing');
  const long1Path    = join(baseDir, 'waypoint-agent-1-longer-suffix');
  const long2Path    = join(baseDir, 'waypoint-agent-2-longer-suffix');

  // 1. agent-clean — branched at main's current tip with no new commits, so
  //    it is already merged into main (clean + merged state).
  run(`git worktree add -b agent/clean "${cleanPath}"`, mainDir);

  // 2. agent-dirty — one commit of its own, a stash made from a separate
  //    edit *before* the final uncommitted changes (so the stash doesn't
  //    capture them), then exactly 3 uncommitted changes: staged, unstaged
  //    modification, untracked.
  run(`git worktree add -b agent/dirty "${dirtyPath}"`, mainDir);

  write(dirtyPath, 'src/agent-dirty-work.js', 'export const AGENT_DIRTY = "step-1";\n');
  run('git add .', dirtyPath);
  run('git commit -m "agent: dirty branch work"', dirtyPath);

  // A separate edit, made and stashed before the final 3 changes below.
  write(dirtyPath, 'src/agent-dirty-work.js', 'export const AGENT_DIRTY = "step-2-wip";\n');
  run('git stash push -m "agent WIP on agent/dirty"', dirtyPath);

  // The 3 uncommitted changes that must remain live after stashing.
  write(dirtyPath, 'src/agent-dirty-staged.js', 'export const STAGED = true;\n');
  run('git add src/agent-dirty-staged.js', dirtyPath);                                             // staged
  write(dirtyPath, 'src/agent-dirty-work.js', 'export const AGENT_DIRTY = "step-1-modified";\n');  // unstaged modification
  write(dirtyPath, 'src/agent-dirty-untracked.txt', 'untracked scratch file\n');                    // untracked

  // 3. agent-conflict — diverges from main on the same lines of utils.js,
  //    then merges main into itself to produce a real, stopped conflict.
  run(`git worktree add -b agent/conflict "${conflictPath}"`, mainDir);
  write(conflictPath, 'src/utils.js', [
    'export function noop() {}',
    '',
    'export function identity(x) {',
    '  return x; // agent/conflict tweak',
    '}',
    '',
  ].join('\n'));
  run('git add .', conflictPath);
  run('git commit -m "agent: tweak identity on conflict branch"', conflictPath);

  // Main changes the same lines a different way, so the merge below conflicts.
  write(mainDir, 'src/utils.js', [
    'export function noop() {}',
    '',
    'export function identity(x) {',
    '  return x; // main tweak',
    '}',
    '',
  ].join('\n'));
  run('git add .', mainDir);
  run('git commit -m "Tweak identity on main"', mainDir);

  tryRun('git merge main', conflictPath);   // stops mid-merge with a conflict (MERGE_HEAD + UU file)

  // 4. agent-detached — detached HEAD at an earlier main commit.
  run(`git worktree add --detach "${detachedPath}" ${earlyOid}`, mainDir);

  // 5. agent-locked — branch, then locked with a reason.
  run(`git worktree add -b agent/locked "${lockedPath}"`, mainDir);
  run(`git worktree lock --reason "agent running" "${lockedPath}"`, mainDir);

  // 6. agent-missing — registered worktree whose folder is gone, unpruned.
  run(`git worktree add -b agent/missing "${missingPath}"`, mainDir);
  rmSync(missingPath, { recursive: true, force: true });   // no `worktree prune` — stays registered, shows as prunable

  // 7. Long, nearly-identical names — exercise sidebar/path truncation.
  run(`git worktree add -b agent/long-1 "${long1Path}"`, mainDir);
  run(`git worktree add -b agent/long-2 "${long2Path}"`, mainDir);

  // ── Nested worktree, living INSIDE main's own working tree ─────────────
  const worktreesParent = join(mainDir, '.worktrees');
  mkdirSync(worktreesParent, { recursive: true });
  const nestedPath = join(worktreesParent, 'nested-agent');
  run(`git worktree add -b agent/nested "${nestedPath}"`, mainDir);
  write(nestedPath, 'nested-wip.txt', 'Uncommitted file inside a worktree nested under main/.\nProves "Discard all" in main must not delete this.\n');

  log('worktrees', join(baseDir, 'main'), '(open the main/ subfolder — see README.md for the full tour; paths are absolute, re-run `pnpm fixtures worktrees` after moving this checkout)');
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

/**
 * LONG-BRANCH-NAMES
 * A small repo whose branches have very long names, forked at different
 * commits. Exercises the timeline ref-badge truncation (middle ellipsis +
 * full-name hover tooltip) and the sidebar ref tree on names that don't fit.
 */
function makeLongBranchNames() {
  const dir = fresh('long-branch-names');
  initRepo(dir);

  write(dir, 'README.md', '# Long Branch Names\n\nBranches with names that overflow the badge.\n');
  run('git add .', dir);
  run('git commit -m "Initial commit"', dir);

  write(dir, 'src/app.js', 'export const APP = "demo";\n');
  run('git add .', dir);
  run('git commit -m "Add app entry point"', dir);

  // Long branch names forked off the *first* commit (HEAD~1).
  const earlyBranches = [
    'feature/very-long-feature-name-for-the-new-onboarding-flow-SA-100',
    'bugfix/customer-reported-crash-on-startup-when-cache-is-empty-SA-241',
  ];
  for (const branch of earlyBranches) {
    run('git checkout -b ' + JSON.stringify(branch) + ' HEAD~1', dir);
    const safe = branch.replace(/[/]/g, '-');
    write(dir, `src/${safe}.js`, `// work for ${branch}\nexport const READY = false;\n`);
    run('git add .', dir);
    run(`git commit -m ${JSON.stringify('wip: ' + branch)}`, dir);
    run('git checkout main', dir);
  }

  // Long branch names forked off the latest commit (HEAD).
  const tipBranches = [
    'release/2026.06-quarterly-platform-stability-and-performance-RELEASE-2026Q2',
    'chore/dependency-bump-and-toolchain-migration-to-the-new-build-system-INFRA-77',
    'feat/experimental-graph-layout-engine-rewrite-with-webgl-acceleration-GFX-9',
  ];
  for (const branch of tipBranches) {
    run('git checkout -b ' + JSON.stringify(branch), dir);
    const safe = branch.replace(/[/]/g, '-');
    write(dir, `src/${safe}.js`, `// work for ${branch}\nexport const STEP = 1;\n`);
    run('git add .', dir);
    run(`git commit -m ${JSON.stringify('feat: ' + branch)}`, dir);
    run('git checkout main', dir);
  }

  log('long-branch-names', dir, `(${earlyBranches.length + tipBranches.length} long branches)`);
}

/**
 * LARGE-LINEAR
 * 50 000 sequential commits on one branch — no lanes, no merges.
 * Uses git-fast-import for speed (~1-2 s vs minutes with shell loops).
 * Stress-tests load-all (no commit cap), timeline virtualization, and the
 * windowed GraphLayer scan — scroll to the bottom should stay smooth.
 */
function makeLargeLinear() {
  const dir = fresh('large-linear');
  initRepo(dir);

  const N = 50000;
  const parts = [];

  for (let i = 1; i <= N; i++) {
    const content    = `// auto-generated revision ${i}\nexport const REV = ${i};\n`;
    const msg        = `chore: revision ${i}`;
    const ts         = 1700000000 + i * 60;
    const blobMark   = i * 2 - 1;
    const commitMark = i * 2;

    parts.push(
      `blob`,
      `mark :${blobMark}`,
      `data ${Buffer.byteLength(content)}`,
      content,
      `commit refs/heads/main`,
      `mark :${commitMark}`,
      `committer Fixture User <fixture@example.com> ${ts} +0000`,
      `data ${Buffer.byteLength(msg)}`,
      msg,
      ...(i > 1 ? [`from :${(i - 1) * 2}`] : []),
      `M 100644 :${blobMark} src/module.js`,
      ``,  // blank line terminates commit
    );
  }

  execSync('git fast-import --quiet', {
    cwd: dir,
    input: parts.join('\n'),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...GIT_ENV },
  });
  run('git checkout -f main', dir);

  log('large-linear', dir, `(${N} commits, 1 lane)`);
}

/**
 * LARGE-BRANCHY
 * ~250 commits across a main branch and 10 long-running feature branches that
 * are all active simultaneously before merging back.  Forces 10+ concurrent
 * graph lanes — stress-tests lane-assignment and GraphLayer rendering.
 * Takes ~15-25 s to generate on first run.
 */
function makeLargeBranchy() {
  const dir = fresh('large-branchy');
  initRepo(dir);

  const BRANCH_COUNT   = 10;
  const BRANCH_COMMITS = 20;
  const MAIN_BETWEEN   = 2;

  write(dir, 'app.js', 'export const VERSION = "0.1.0";\n');
  run('git add .', dir);
  run('git commit -m "feat: initial release"', dir);

  for (let i = 1; i <= 10; i++) {
    write(dir, 'app.js', `export const VERSION = "0.1.${i}";\n`);
    run('git add .', dir);
    run(`git commit -m "fix: patch ${i}"`, dir);
  }

  // Create all branches at current HEAD so they are simultaneously active.
  const branches = Array.from({ length: BRANCH_COUNT }, (_, i) => `feature/item-${i + 1}`);

  for (const branch of branches) {
    const safeName = branch.replace('/', '-');
    run(`git checkout -b ${branch}`, dir);
    for (let j = 1; j <= BRANCH_COMMITS; j++) {
      write(dir, `src/${safeName}.js`, `// ${branch} step ${j}\nexport const STEP = ${j};\n`);
      run('git add .', dir);
      run(`git commit -m "feat(${branch.split('/')[1]}): step ${j}"`, dir);
    }
    run('git checkout main', dir);
  }

  // Advance main between merges so branches remain visible in the graph.
  for (let i = 0; i < branches.length; i++) {
    for (let k = 1; k <= MAIN_BETWEEN; k++) {
      const ver = `1.${i * MAIN_BETWEEN + k}.0`;
      write(dir, 'app.js', `export const VERSION = "${ver}";\n`);
      run('git add .', dir);
      run(`git commit -m "feat: release ${ver}"`, dir);
    }
    run(`git merge --no-ff ${branches[i]} -m "Merge ${branches[i]} into main"`, dir);
  }

  for (let i = 1; i <= 5; i++) {
    write(dir, 'app.js', `export const VERSION = "2.${i}.0";\n`);
    run('git add .', dir);
    run(`git commit -m "feat: release 2.${i}.0"`, dir);
  }

  log('large-branchy', dir, `(${BRANCH_COUNT} simultaneous lanes)`);
}

/**
 * STRESS
 * A deliberately heavy, complex DAG for performance testing:
 *   - a long trunk (default 1200 commits) on main
 *   - hundreds of feature branches (default 300) forked at *varied* points
 *     along the trunk, each a few commits long
 *   - ~40% of those branches merged back into main (merge commits)
 *   - a sprinkle of cross-branch merges for extra lane crossings
 * Yields several thousand commits and hundreds of simultaneous branch refs.
 *
 * Built with git-fast-import so the whole thing materialises in ~1-2 s instead
 * of the minutes a shell loop would take. Deterministic (seeded PRNG) so reruns
 * produce an identical repo. Override sizes via env vars:
 *   WAYPOINT_STRESS_TRUNK, WAYPOINT_STRESS_BRANCHES, WAYPOINT_STRESS_SEED
 *
 * This is the fixture to open when profiling walk_commits / assign_lanes and the
 * sidebar ref tree on a worst-case repo.
 */
function makeStress() {
  const dir = fresh('stress');
  initRepo(dir);

  const TRUNK        = Number(process.env.WAYPOINT_STRESS_TRUNK)    || 1200;
  const BRANCHES     = Number(process.env.WAYPOINT_STRESS_BRANCHES) || 300;
  const MERGE_RATIO  = 0.4;          // fraction of branches merged back to main
  const CROSS_MERGES = Math.floor(BRANCHES * 0.1);

  // mulberry32 — small deterministic PRNG so the fixture is reproducible.
  let seed = (Number(process.env.WAYPOINT_STRESS_SEED) || 0x9e3779b9) >>> 0;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const randInt = (n) => Math.floor(rand() * n);

  let mark = 0;
  let ts = 1700000000;
  const parts = [];

  /** Emit one fast-import commit (with an inline file change) and return its mark. */
  function commit(ref, msg, fromMark, mergeMarks, file, content) {
    const m = ++mark;
    ts += 60;
    parts.push(
      `commit ${ref}`,
      `mark :${m}`,
      `committer Fixture User <fixture@example.com> ${ts} +0000`,
      `data ${Buffer.byteLength(msg)}`,
      msg,
      ...(fromMark ? [`from :${fromMark}`] : []),
      ...mergeMarks.map((mm) => `merge :${mm}`),
      `M 100644 inline ${file}`,
      `data ${Buffer.byteLength(content)}`,
      content,
      ``, // blank line terminates the commit
    );
    return m;
  }

  // ── Trunk ───────────────────────────────────────────────────────────────
  const trunkMarks = [];
  let prev = null;
  for (let i = 1; i <= TRUNK; i++) {
    prev = commit('refs/heads/main', `chore: trunk commit ${i}`, prev, [], 'trunk.txt', `trunk ${i}\n`);
    trunkMarks.push(prev);
  }
  let mainTip = prev;

  // ── Feature branches forked at varied points; merge ~40% back to main ────
  const branchTips = [];   // { name, tip } for later cross-branch merges
  for (let b = 1; b <= BRANCHES; b++) {
    const name = `feature/topic-${String(b).padStart(3, '0')}`;
    const ref = `refs/heads/${name}`;
    const file = `feat/topic-${String(b).padStart(3, '0')}.txt`;

    let tip = trunkMarks[randInt(TRUNK)];     // varied fork point along the trunk
    const len = 2 + randInt(7);               // 2..8 commits
    for (let j = 1; j <= len; j++) {
      tip = commit(ref, `feat(${name}): step ${j}`, tip, [], file, `${name} step ${j}\n`);
    }
    branchTips.push({ name, tip });

    if (rand() < MERGE_RATIO) {
      mainTip = commit('refs/heads/main', `Merge ${name} into main`, mainTip, [tip], 'trunk.txt', `merge ${name}\n`);
    }
  }

  // ── A few cross-branch merges for extra lane crossings ───────────────────
  for (let i = 0; i < CROSS_MERGES; i++) {
    const into = branchTips[randInt(branchTips.length)];
    const from = branchTips[randInt(branchTips.length)];
    if (into === from) continue;
    const ref = `refs/heads/${into.name}`;
    const file = `feat/${into.name.replace('/', '-')}.txt`;
    into.tip = commit(ref, `Merge ${from.name} into ${into.name}`, into.tip, [from.tip], file, `merge ${from.name}\n`);
  }

  execSync('git fast-import --quiet', {
    cwd: dir,
    input: parts.join('\n'),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...GIT_ENV },
  });
  run('git checkout -f main', dir);

  log('stress', dir, `(${TRUNK} trunk + ${BRANCHES} branches, ${mark} commits)`);
}

// ── Runner ────────────────────────────────────────────────────────────────────

function log(name, dir, note = '') {
  const rel = dir.replace(REPOS_DIR + '\\', '').replace(REPOS_DIR + '/', '');
  console.log(`  ✓  ${name.padEnd(24)} → scripts/fixtures/repos/${rel}  ${note}`);
}

const SCENARIOS = [
  ['clean',                makeClean],
  ['staged',               makeStaged],
  ['untracked',            makeUntracked],
  ['hunks',                makeHunks],
  ['not-a-repo',           makeNotARepo],
  ['empty-repo',           makeEmptyRepo],
  ['empty-repo-staged',    makeEmptyRepoStaged],
  ['orphan-branch',        makeOrphanBranch],
  ['merge-conflict',       makeMergeConflict],
  ['cherry-pick-conflict', makeCherryPickConflict],
  ['cherry-pick-ready',    makeCherryPickReady],
  ['cherry-pick-clean',    makeCherryPickClean],
  ['squashable',           makeSquashable],
  ['many-refs',            makeManyRefs],
  ['detached-head',        makeDetachedHead],
  ['ahead-of-remote',      makeAheadOfRemote],
  ['stash',                makeStash],
  ['worktrees',            makeWorktrees],
  ['tags',                 makeTags],
  ['long-branch-names',    makeLongBranchNames],
  ['large-linear',         makeLargeLinear],
  ['large-branchy',        makeLargeBranchy],
  ['stress',               makeStress],
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
