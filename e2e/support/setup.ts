import { setOptions } from 'expect-webdriverio';

/**
 * `expect-webdriverio` waits only 2s by default in standalone mode (see
 * `node_modules/expect-webdriverio/lib/constants.js`). That's too short for
 * UI assertions that wait on a real git round trip (e.g. per-worktree status
 * after a merge/pop) — set a longer shared default once, before any spec
 * runs, instead of passing `{ wait: ... }` to every `expect(...).toHave*()`
 * call individually.
 *
 * Loaded via Mocha's `--require` (see scripts/e2e/run.mjs), after `tsx` so
 * this `.ts` file itself gets transformed, and before any spec file imports
 * `expect-webdriverio` — `setOptions` mutates that module's shared defaults
 * object, so as long as this runs first in the same process, every spec
 * picks up the new default.
 */
setOptions({ wait: 10_000, interval: 100 });
