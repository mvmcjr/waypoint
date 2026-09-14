import { remote } from 'webdriverio';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

import { saveFailureArtifacts } from './artifacts.js';
import { xpathLiteral } from './ui.js';

/** Resolves `%APPDATA%\com.waypoint.e2e`, throwing rather than silently seeding a relative-to-cwd path if APPDATA is unset. */
function appDataDir(): string {
  const appData = process.env.APPDATA;
  if (!appData) {
    throw new Error('APPDATA is not set — cannot locate the e2e app\'s store file (waypoint.json)');
  }
  return join(appData, 'com.waypoint.e2e');
}

function storePath(): string {
  return join(appDataDir(), 'waypoint.json');
}

/** Merges `extra` into the e2e app's persisted store file, creating it if needed. */
function seedStore(extra: Record<string, unknown>): void {
  const dir = appDataDir();
  const path = storePath();
  mkdirSync(dir, { recursive: true });
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      current = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      // corrupt/partial file from a previous run — overwrite it
    }
  }
  writeFileSync(path, JSON.stringify({ ...current, ...extra }), 'utf8');
}

/**
 * Launches the e2e app on `openPath` and waits for the repo view (a
 * `[role=tab]`) to appear.
 *
 * `tauri:options.args` is NOT honoured by the app — tauri-driver forwards it
 * to the underlying WebView2/msedgedriver as *browser* args, not as argv to
 * the Tauri app process (confirmed empirically: launching with
 * `args: [openPath]` leaves the app on the welcome screen with an empty
 * startup path). So it's dropped from capabilities entirely, and instead the
 * store is always seeded with `recent_repos: [openPath]`; if the welcome
 * screen is showing once the session is up, the harness clicks that entry.
 */
export async function launch(openPath: string): Promise<WebdriverIO.Browser> {
  seedStore({ context_menu_asked: true, recent_repos: [openPath] });

  const app = await remote({
    hostname: '127.0.0.1',
    port: 4444,
    logLevel: 'warn',
    capabilities: {
      'tauri:options': { application: process.env.E2E_APP },
    } as any,
  });

  try {
    // WebView2 persists its profile (including localStorage) per app
    // identifier across separate process launches, so a previous test's
    // view preferences (collapsed panels, panel widths, etc.) would
    // otherwise leak into this one. Clear it and reload before doing
    // anything else.
    await app.$('body').waitForExist({ timeout: 15_000 });
    await app.execute(() => {
      try {
        localStorage.clear();
      } catch {
        // ignore — nothing to clear, or storage inaccessible
      }
    });
    await app.refresh();
    await app.$('body').waitForExist({ timeout: 15_000 });

    const label = basename(openPath);
    // Scoped to the recents list (`<li><button>...`) so this can never match
    // "Open Repository" or trigger the native folder picker.
    const recentsEntry = `//li/button[contains(., ${xpathLiteral(label)})]`;
    const hasTab = async () => (await app.$('[role=tab]')).isExisting();
    const hasRecentsEntry = async () => (await app.$(recentsEntry)).isExisting();

    await app.waitUntil(async () => (await hasTab()) || (await hasRecentsEntry()), {
      timeout: 30_000,
      timeoutMsg: `Neither a repo tab nor a recents entry for "${label}" ever appeared`,
    });

    if (!(await hasTab())) {
      await app.$(recentsEntry).click();
      await app.waitUntil(hasTab, { timeout: 30_000, timeoutMsg: 'repo view ([role=tab]) never appeared after clicking the recents entry' });
    }

    return app;
  } catch (err) {
    // The session started but never reached a usable state — capture what
    // the screen looked like before tearing it down, so the failure isn't a
    // bare timeout with nothing to look at. Each failure gets its own
    // timestamped folder so a second launch failure in the same run never
    // overwrites the first one's artifacts.
    let artifactsDir: string | undefined;
    try {
      artifactsDir = await saveFailureArtifacts(app, 'launch', `launch-${Date.now()}`);
    } catch {
      // best-effort; don't let a failed screenshot mask the real error
    }
    try {
      await app.deleteSession();
    } catch {
      // already gone
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      artifactsDir ? `${message} (launch failure artifacts: ${artifactsDir})` : message
    );
  }
}

/** Ends the WebDriver session (and the app with it), swallowing any error. */
export async function quit(app: WebdriverIO.Browser | undefined): Promise<void> {
  if (!app) return;
  try {
    await app.deleteSession();
  } catch {
    // session may already be gone (crashed app, etc.)
  }
}
