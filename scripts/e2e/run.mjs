#!/usr/bin/env node
/**
 * run.mjs
 *
 * Harness entry point for `pnpm e2e`:
 *   1. Preflight checks (git, tauri-driver, msedgedriver/WebView2 match, port free).
 *   2. Builds the e2e binary if stale (scripts/e2e/build.mjs).
 *   3. Spawns `tauri-driver` and waits for it to be ready.
 *   4. Spawns Mocha (via tsx) against the e2e specs, with the fixture/run
 *      environment it needs.
 *   5. Always tears down tauri-driver (and forwards Mocha's exit code),
 *      including on Ctrl-C.
 *
 * Usage:
 *   node scripts/e2e/run.mjs                                  # all specs
 *   node scripts/e2e/run.mjs -- e2e/specs/smoke.e2e.ts         # one spec
 *   node scripts/e2e/run.mjs -- e2e/specs/worktrees.e2e.ts -g "remove"
 *   node scripts/e2e/run.mjs -- -g "launches"                 # grep only, all specs
 */

import { spawn, execSync, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import net from 'node:net';

import { webview2Version } from './setup.mjs';
import { buildIfStale, e2eBinaryPath } from './build.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const CURRENT_JSON = join(REPO_ROOT, '.e2e-bin', 'current.json');

const TAURI_DRIVER_PORT = 4444;
const TAURI_DRIVER_READY_TIMEOUT_MS = 20_000;
const TAURI_DRIVER_POLL_INTERVAL_MS = 250;

function fail(message) {
  console.error(message);
  process.exit(1);
}

// ── Preflight ────────────────────────────────────────────────────────────────

function checkPortFree(port, host = '127.0.0.1') {
  return new Promise((resolvePromise, rejectPromise) => {
    const srv = net.createServer();
    srv.once('error', (err) => rejectPromise(err));
    srv.once('listening', () => srv.close(() => resolvePromise()));
    srv.listen(port, host);
  });
}

async function preflight() {
  // A previous run that was killed externally (Ctrl-C on the harness itself,
  // a crashed shell, etc.) can leave the e2e app running, holding onto its
  // WebView2 profile/lock — clean that up before anything else so it can't
  // interfere with this run.
  killStrayAppProcesses(e2eBinaryPath());

  try {
    execSync('git --version', { stdio: 'ignore' });
  } catch {
    fail('git not on PATH');
  }

  try {
    execSync('where tauri-driver', { stdio: 'ignore' });
  } catch {
    fail('tauri-driver missing — run pnpm e2e:setup');
  }

  if (!existsSync(CURRENT_JSON)) {
    fail('msedgedriver missing — run pnpm e2e:setup');
  }
  const current = JSON.parse(readFileSync(CURRENT_JSON, 'utf8'));
  if (!existsSync(current.msedgedriver)) {
    fail(`msedgedriver missing at ${current.msedgedriver} — run pnpm e2e:setup`);
  }
  const installedWebview2 = webview2Version();
  if (current.webview2 !== installedWebview2) {
    fail(`msedgedriver ${current.webview2} ≠ WebView2 ${installedWebview2} — run pnpm e2e:setup`);
  }

  try {
    await checkPortFree(TAURI_DRIVER_PORT);
  } catch {
    fail(`port ${TAURI_DRIVER_PORT} in use — is another tauri-driver running? (taskkill /IM tauri-driver.exe /F)`);
  }

  return current;
}

// ── tauri-driver lifecycle ───────────────────────────────────────────────────

async function waitForTauriDriverReady(proc) {
  const deadline = Date.now() + TAURI_DRIVER_READY_TIMEOUT_MS;
  for (;;) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(
        `tauri-driver exited before becoming ready (code ${proc.exitCode}, signal ${proc.signalCode})`
      );
    }
    try {
      const res = await fetch(`http://127.0.0.1:${TAURI_DRIVER_PORT}/status`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() >= deadline) {
      throw new Error(`tauri-driver did not become ready within ${TAURI_DRIVER_READY_TIMEOUT_MS}ms`);
    }
    await new Promise((r) => setTimeout(r, TAURI_DRIVER_POLL_INTERVAL_MS));
  }
}

function spawnTauriDriver(msedgedriverPath) {
  const proc = spawn(
    'tauri-driver',
    ['--port', String(TAURI_DRIVER_PORT), '--native-driver', msedgedriverPath],
    { stdio: 'inherit' }
  );
  proc.on('error', (err) => {
    console.error(`tauri-driver process error: ${err.message ?? err}`);
  });
  return proc;
}

function killProcess(proc) {
  if (!proc || proc.killed || proc.exitCode !== null) return;
  try {
    // Windows: taskkill /T also kills the msedgedriver child tauri-driver spawns,
    // and (if still alive) the app it launched.
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
    } else {
      proc.kill('SIGTERM');
    }
  } catch {
    // already gone
  }
}

/**
 * Safety net: each test's own `quit()` (app.deleteSession()) normally closes
 * the app, and killing tauri-driver's process tree above catches an app still
 * attached to it. This catches the remaining case — a crashed/killed harness
 * mid-test — by force-killing any leftover e2e-binary process by its exact
 * executable path, so a stray waypoint.exe never survives a run.
 *
 * Uses `execFileSync` (no shell) so the binary path is never interpolated
 * into a PowerShell command string — it's passed through `$env:E2E_APP`
 * instead, sidestepping quoting entirely regardless of what characters the
 * path contains.
 */
function killStrayAppProcesses(binaryPath) {
  if (process.platform !== 'win32') return;
  try {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process -Filter "Name=\'waypoint.exe\'" | ' +
          'Where-Object { $_.ExecutablePath -eq $env:E2E_APP } | ' +
          'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
      ],
      { stdio: 'ignore', env: { ...process.env, E2E_APP: binaryPath } }
    );
  } catch {
    // none left, or powershell unavailable — nothing more we can do
  }
}

// ── Fixture run-directory cleanup ────────────────────────────────────────────

/** Removes `%TEMP%\waypoint-e2e\<runId>` if it's empty (every fixture passed and was disposed). Leaves it in place — untouched — if anything (a kept, failed-test fixture) remains. */
function cleanupRunDirIfEmpty(runId) {
  const dir = join(tmpdir(), 'waypoint-e2e', runId);
  try {
    rmdirSync(dir);
  } catch {
    // ENOTEMPTY (fixtures were kept after a failure) or ENOENT (never created) — leave it
  }
}

// ── Mocha ─────────────────────────────────────────────────────────────────────

// Mocha flags that consume the following argv entry as their own value —
// that value must never be mistaken for a spec path (e.g. `-g "agent/dirty"`
// would otherwise see "agent/dirty" contains a "/" and treat it as one).
const MOCHA_VALUE_FLAGS = new Set(['-g', '--grep', '-f', '--fgrep']);

/** True if any entry in `args` plausibly names a spec file/glob, ignoring flag values. */
function hasSpecPathArg(args) {
  const looksLikeSpecPath = (a) => !a.startsWith('-') && (a.endsWith('.ts') || a.includes('*') || a.includes('/'));
  let skipNext = false;
  for (const a of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (MOCHA_VALUE_FLAGS.has(a)) {
      skipNext = true;
      continue;
    }
    if (looksLikeSpecPath(a)) return true;
  }
  return false;
}

function runMocha(extraArgs, env) {
  const mochaBin = join(REPO_ROOT, 'node_modules', 'mocha', 'bin', 'mocha.js');
  const specDefault = 'e2e/specs/**/*.e2e.ts';
  // Only treat an arg as a spec path if it plausibly is one, and never the
  // value that follows a -g/--grep/-f/--fgrep flag — this lets
  // `pnpm e2e -- -g "remove"` (options only, no spec) still fall through to
  // the default glob instead of Mocha finding zero files.
  const specArgs = hasSpecPathArg(extraArgs) ? extraArgs : [specDefault, ...extraArgs];

  // NOTE: `node --import tsx mocha.js` (as originally specced) crashes before
  // any spec runs: tsx's global CJS resolver hook mishandles mocha's own
  // `require('find-up')` (an exports-only ESM package pulling in
  // `unicorn-magic`), throwing ERR_PACKAGE_PATH_NOT_EXPORTED — reproducible
  // even with `mocha --version`, no spec files involved. Registering tsx as
  // a *mocha* `--require` hook instead works: mocha resolves its own config
  // (find-up and all) before that hook installs tsx's resolver, and our
  // .e2e.ts spec files still get transformed on load.
  //
  // `e2e/support/setup.ts` is required right after tsx (so tsx's resolver is
  // already active to transform it) and before any spec file — it sets
  // expect-webdriverio's default wait/interval once for the whole run.
  const args = [
    mochaBin,
    '--require', 'tsx',
    '--require', join(REPO_ROOT, 'e2e', 'support', 'setup.ts'),
    '--timeout', '180000',
    '--reporter', 'spec',
    ...specArgs,
  ];
  return new Promise((resolvePromise) => {
    const proc = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env,
    });
    proc.on('exit', (code) => resolvePromise(code ?? 1));
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const current = await preflight();
  buildIfStale();

  const tauriDriver = spawnTauriDriver(current.msedgedriver);

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    killProcess(tauriDriver);
    killStrayAppProcesses(e2eBinaryPath());
  };
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('exit', cleanup);

  try {
    await waitForTauriDriverReady(tauriDriver);
  } catch (err) {
    cleanup();
    fail(err.message ?? String(err));
  }

  // `pnpm e2e -- foo` forwards the literal `--` separator into this
  // script's own argv (Node does not strip it) — drop a leading one so it
  // doesn't end up in the middle of Mocha's args and disable flag parsing
  // for everything after it (turning e.g. `-g` into a literal glob pattern).
  const rawArgs = process.argv.slice(2);
  const extraArgs = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
  const runId = String(Date.now());
  const env = {
    ...process.env,
    E2E_RUN_ID: runId,
    E2E_APP: e2eBinaryPath(),
  };

  const mochaCode = await runMocha(extraArgs, env);
  cleanup();
  cleanupRunDirIfEmpty(runId);
  process.exit(mochaCode);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
