#!/usr/bin/env node
/**
 * setup.mjs
 *
 * Windows-only e2e driver setup:
 *   - Detects the installed WebView2 runtime version from the registry.
 *   - Ensures `tauri-driver` is installed (via cargo install --locked).
 *   - Downloads the matching `msedgedriver.exe` from Microsoft's official
 *     host and records it in `.e2e-bin/current.json`, skipping the download
 *     when the recorded version already matches.
 *
 * Usage:
 *   node scripts/e2e/setup.mjs
 */

import { execSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(__dirname, '../..');
const BIN_DIR = join(REPO_ROOT, '.e2e-bin');
const CURRENT_JSON = join(BIN_DIR, 'current.json');

// WebView2 Runtime's product GUID, as registered by the Edge/WebView2 updater.
const WEBVIEW2_GUID = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
const HKLM_KEY = `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_GUID}`;
const HKCU_KEY = `HKCU\\Software\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_GUID}`;

// ── WebView2 version detection ──────────────────────────────────────────────

function regQueryVersion(key) {
  let out;
  try {
    out = execSync(`reg query "${key}" /v pv`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch {
    return null;
  }
  const match = out.match(/REG_SZ\s+(\S+)/);
  return match ? match[1] : null;
}

// A WebView2/Edge version is always 4 dot-separated integers (e.g.
// "120.0.2210.91") — validated before it's ever interpolated into a
// filesystem path or a download URL, so a corrupt/unexpected registry value
// fails fast with a clear message instead of silently building a bogus path.
const VERSION_RE = /^\d+(\.\d+){3}$/;

/** Reads the installed WebView2 runtime version from the registry (HKLM, falling back to HKCU). */
export function webview2Version() {
  const version = regQueryVersion(HKLM_KEY) ?? regQueryVersion(HKCU_KEY);
  if (!version) {
    throw new Error(
      'Could not detect the WebView2 runtime version from the registry ' +
        `(checked "${HKLM_KEY}" and "${HKCU_KEY}"). Is WebView2 Runtime installed?`
    );
  }
  if (!VERSION_RE.test(version)) {
    throw new Error(
      `WebView2 registry value "pv" has an unexpected format: "${version}" ` +
        '(expected 4 dot-separated numbers, e.g. "120.0.2210.91") — refusing to use it in a path or URL.'
    );
  }
  return version;
}

// ── tauri-driver ─────────────────────────────────────────────────────────────

function hasTauriDriver() {
  try {
    execSync('where tauri-driver', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function ensureTauriDriver() {
  if (hasTauriDriver()) return;
  console.log('tauri-driver not found on PATH — installing (cargo install tauri-driver --locked)...');
  execSync('cargo install tauri-driver --locked', { stdio: 'inherit' });
}

// ── msedgedriver ─────────────────────────────────────────────────────────────

function readCurrent() {
  if (!existsSync(CURRENT_JSON)) return null;
  try {
    return JSON.parse(readFileSync(CURRENT_JSON, 'utf8'));
  } catch {
    return null;
  }
}

async function downloadMsedgedriver(version) {
  const versionDir = join(BIN_DIR, version);
  mkdirSync(versionDir, { recursive: true });
  const zipPath = join(versionDir, 'edgedriver.zip');
  const url = `https://msedgedriver.microsoft.com/${version}/edgedriver_win64.zip`;

  console.log(`Downloading ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download msedgedriver for version ${version}: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(zipPath, buf);

  console.log(`Extracting ${zipPath} ...`);
  // Use execFileSync (no shell) with a single -Command string built from
  // single-quoted, apostrophe-escaped PowerShell literals. Passing -Path/
  // -DestinationPath as separate execSync-shell tokens breaks for any path
  // containing a space, because PowerShell re-joins -Command's tokens and
  // loses the double-quote boundaries the outer shell added.
  const psLiteral = (p) => `'${p.replace(/'/g, "''")}'`;
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -Force -LiteralPath ${psLiteral(zipPath)} -DestinationPath ${psLiteral(versionDir)}`,
    ],
    { stdio: 'inherit' }
  );

  const driverPath = join(versionDir, 'msedgedriver.exe');
  if (!existsSync(driverPath)) {
    throw new Error(`msedgedriver.exe not found after extraction at ${driverPath}`);
  }
  return driverPath;
}

async function main() {
  const version = webview2Version();
  console.log(`Detected WebView2 runtime version: ${version}`);

  ensureTauriDriver();

  const current = readCurrent();
  if (current && current.webview2 === version && existsSync(current.msedgedriver)) {
    console.log(`msedgedriver ${version} already installed`);
    return;
  }

  const driverPath = await downloadMsedgedriver(version);
  mkdirSync(BIN_DIR, { recursive: true });
  writeFileSync(
    CURRENT_JSON,
    JSON.stringify({ webview2: version, msedgedriver: driverPath }, null, 2) + '\n'
  );
  console.log(`msedgedriver ${version} installed at ${driverPath}`);
  console.log('Next: pnpm e2e');
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
