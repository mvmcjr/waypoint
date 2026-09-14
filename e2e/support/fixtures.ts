import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
// Plain JS module (allowJs, no declarations) — resolves to an implicit `any`.
import { buildScenario } from '../../scripts/fixtures/make-fixtures.mjs';

export interface Fixture {
  root: string;
  openPath: string;
}

function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// Test titles must be unique across every spec in a run: two tests sharing a
// slug would build fixtures into the same temp folder and could delete each
// other's data out from under a still-running test.
const usedSlugs = new Set<string>();

/**
 * Builds `scenario` into a fresh temp folder unique to this run and test,
 * and returns `{ root, openPath }` — `root` is the folder to clean up,
 * `openPath` is the folder Waypoint should open (they differ for scenarios
 * like `ahead-of-remote` and `worktrees` which nest the folder to open).
 */
export function makeFixture(scenario: string, testTitle: string): Fixture {
  const runId = process.env.E2E_RUN_ID ?? String(Date.now());
  const slug = slugify(testTitle);
  if (usedSlugs.has(slug)) {
    throw new Error(
      `Duplicate fixture slug "${slug}" (from test title "${testTitle}") within this run — ` +
        'test titles passed to makeFixture must be unique across all e2e specs.'
    );
  }
  usedSlugs.add(slug);
  const root = join(tmpdir(), 'waypoint-e2e', runId, slug);
  const openPath = buildScenario(scenario, root) as string;
  return { root, openPath };
}

/**
 * Deletes the fixture on a pass; keeps it (and prints its path) on a
 * failure. Removal tolerates the brief window where Windows still holds a
 * file handle open (e.g. a just-closed app process, an AV scan) by retrying;
 * if it still can't be removed, that's a warning, not a thrown error — a
 * throw here runs inside `afterEach` and would abort the rest of the suite.
 */
export function disposeFixture(f: Fixture | undefined, passed: boolean): void {
  if (!f) return;
  if (passed) {
    try {
      rmSync(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (err) {
      console.error(`Warning: failed to remove fixture ${f.root}: ${(err as Error).message ?? err}`);
    }
  } else {
    console.error(`Kept fixture for failed test: ${f.root}`);
  }
}
