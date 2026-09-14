import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_ROOT = join(__dirname, '..', 'artifacts');

function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

/**
 * Saves a screenshot and the DOM (document.documentElement.outerHTML) for a
 * failed test to `e2e/artifacts/<spec>/<test>/`. Returns the directory path
 * (and prints it) so the caller can point the developer at it.
 */
export async function saveFailureArtifacts(
  app: WebdriverIO.Browser | undefined,
  spec: string,
  test: string
): Promise<string> {
  const dir = join(ARTIFACTS_ROOT, slugify(spec), slugify(test));
  // Clear any stale artifacts from a previous failing run of this same
  // spec/test before writing new ones, so a partial write from an old run
  // never survives alongside (or is mistaken for) this run's output. Retried
  // (Windows can briefly hold a handle from a just-closed app/AV scan) and
  // wrapped — a throw here runs inside `afterEach` and would abort the rest
  // of the describe block, so failure to clear stale artifacts is a warning,
  // not a fatal error.
  if (existsSync(dir)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (err) {
      console.error(`Warning: failed to clear stale artifacts at ${dir}: ${(err as Error).message ?? err}`);
    }
  }
  mkdirSync(dir, { recursive: true });

  if (app) {
    try {
      await app.saveScreenshot(join(dir, 'screenshot.png'));
    } catch (err) {
      console.error(`Failed to save screenshot: ${(err as Error).message ?? err}`);
    }
    try {
      const html = await app.getPageSource();
      writeFileSync(join(dir, 'dom.html'), html, 'utf8');
    } catch (err) {
      console.error(`Failed to save DOM: ${(err as Error).message ?? err}`);
    }
  }

  console.error(`Failure artifacts saved to: ${dir}`);
  return dir;
}
