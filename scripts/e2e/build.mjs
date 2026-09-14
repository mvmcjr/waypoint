#!/usr/bin/env node
/**
 * build.mjs
 *
 * Builds (or reuses) a separate, test-only build of Waypoint for e2e runs:
 *   - Identifier `com.waypoint.e2e` (src-tauri/tauri.e2e.conf.json), so it
 *     never collides with the dev build's app data.
 *   - Built into `src-tauri/target/e2e` (via CARGO_TARGET_DIR), so it never
 *     overwrites the dev build's `target/` output.
 *
 * Usage:
 *   node scripts/e2e/build.mjs
 */

import { execSync } from 'node:child_process';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(__dirname, '../..');

const E2E_TARGET_DIR = join(REPO_ROOT, 'src-tauri', 'target', 'e2e');

/** Absolute path to the built e2e test binary. */
export function e2eBinaryPath() {
  return join(E2E_TARGET_DIR, 'debug', 'waypoint.exe');
}

// Inputs that affect the built binary. Directories are walked recursively.
const WATCHED_PATHS = [
  'src',
  'src-tauri/src',
  'src-tauri/capabilities',
  'src-tauri/build.rs',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/tauri.conf.json',
  'src-tauri/tauri.e2e.conf.json',
  'package.json',
  'pnpm-lock.yaml',
  'index.html',
  'vite.config.ts',
  'public',
].map((p) => join(REPO_ROOT, p));

/** Recursively finds the newest mtime (ms) among a file or directory tree, skipping node_modules. */
function newestMtime(path) {
  if (!existsSync(path)) return -Infinity;
  const stat = statSync(path);
  if (stat.isFile()) return stat.mtimeMs;
  if (!stat.isDirectory()) return -Infinity;

  let newest = stat.mtimeMs;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const childPath = join(path, entry.name);
    const childNewest = newestMtime(childPath);
    if (childNewest > newest) newest = childNewest;
  }
  return newest;
}

function newestSourceMtime() {
  let newest = -Infinity;
  for (const p of WATCHED_PATHS) {
    const m = newestMtime(p);
    if (m > newest) newest = m;
  }
  return newest;
}

/** Builds the e2e test binary if it's missing or older than the watched sources. */
export function buildIfStale() {
  const binaryPath = e2eBinaryPath();
  const binaryExists = existsSync(binaryPath);
  const binaryMtime = binaryExists ? statSync(binaryPath).mtimeMs : -Infinity;
  const sourceMtime = newestSourceMtime();

  if (binaryExists && binaryMtime >= sourceMtime) {
    console.log(`e2e binary is up to date: ${binaryPath}`);
    return;
  }

  console.log(
    binaryExists
      ? `e2e binary is stale (${binaryPath}) — rebuilding...`
      : `e2e binary not found — building...`
  );

  try {
    execSync('pnpm tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json', {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: { ...process.env, CARGO_TARGET_DIR: E2E_TARGET_DIR },
    });
  } catch (err) {
    throw new Error(`e2e build failed: ${err.message ?? err}`);
  }

  if (!existsSync(binaryPath)) {
    throw new Error(`e2e build finished but binary not found at ${binaryPath}`);
  }
  console.log(`e2e binary built: ${binaryPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  try {
    buildIfStale();
  } catch (err) {
    console.error(err.message ?? err);
    process.exit(1);
  }
}
