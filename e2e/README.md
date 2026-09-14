# End-to-end tests

Drives the real Waypoint desktop binary (Tauri + WebView2) against generated
git fixture repos, using WebdriverIO's standalone `remote()` API plus
`tauri-driver`. There is no `wdio.conf.ts` — the harness is a plain script,
`scripts/e2e/run.mjs`, that spawns `tauri-driver` and runs Mocha directly.
This is a deliberate deviation from the original design doc (which named a
WDIO test runner config). `tauri:options.args` never reaches the Tauri app
process — tauri-driver/msedgedriver don't forward it as argv — so each
test's fixture path goes in through the app's seeded recents list instead
(see `launch()` in `e2e/support/app.ts`). Mocha plus WebdriverIO's standalone
`remote()` was kept over the WDIO test runner because it gives each test an
explicit, independent session — and full control over failure artifacts —
without a `wdio.conf.ts` runner config; each test calls `launch()`/`quit()`
itself rather than sharing a session via `reloadSession`.

21 tests: 1 smoke + 10 worktree flows + 10 core git flows.

## Setup

```bash
pnpm e2e:setup
```

Windows-only. This:
- installs `tauri-driver` (via `cargo install tauri-driver --locked`) if it's not on PATH;
- reads the installed WebView2 Runtime version from the registry;
- downloads the matching `msedgedriver.exe` into `.e2e-bin/<version>/` and records it in `.e2e-bin/current.json`.

It's idempotent — re-running only downloads a new driver when the recorded
version differs from what's installed. **Re-run it after every Edge/WebView2
update**; `pnpm e2e` refuses to start with a stale driver (see
Troubleshooting).

## Running

```bash
pnpm e2e                                          # full suite
pnpm e2e -- e2e/specs/worktrees.e2e.ts            # one spec file
pnpm e2e -- -g "remove a locked worktree"         # filter by title (all specs)
pnpm e2e -- e2e/specs/core-git.e2e.ts -g "amend"  # combine both
pnpm e2e:typecheck                                # tsc -p e2e/tsconfig.json --noEmit
```

`pnpm e2e` runs, in order:
1. **Preflight** — kills any stray e2e `waypoint.exe` left by a previous run,
   then checks `git` on PATH, `tauri-driver` on PATH, `.e2e-bin/current.json`
   exists and its recorded msedgedriver file still exists on disk, and that
   its recorded version matches the installed WebView2 runtime, and that
   port 4444 is free. Fails fast with one actionable message.
2. **Build-if-stale** — builds the e2e binary
   (`tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json`,
   `CARGO_TARGET_DIR=src-tauri/target/e2e`) only if it's missing or older
   than `src/`, `src-tauri/src/`, `src-tauri/capabilities/`,
   `src-tauri/build.rs`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`,
   `package.json`, `pnpm-lock.yaml`, `index.html`, `vite.config.ts`,
   `public/`, or either tauri config. Equivalent to running `pnpm e2e:build`
   directly.
3. Spawns `tauri-driver` on port 4444 with the matching `msedgedriver`.
4. Runs Mocha (`--require tsx`, `--require e2e/support/setup.ts` — sets
   expect-webdriverio's default wait to 10s, see below — 180s per-test
   timeout) against `e2e/specs/**/*.e2e.ts`, or whatever spec/grep args were
   passed after `--`.
5. Always tears down `tauri-driver` and force-kills any stray e2e
   `waypoint.exe` process, including on Ctrl-C.

Tests run **serially** — one app instance at a time.

## Isolation

- **Separate app identity**: the e2e build uses identifier `com.waypoint.e2e`
  (`src-tauri/tauri.e2e.conf.json`), so its app-data folder
  (`%APPDATA%\com.waypoint.e2e\`), settings store, recents, plugins and
  WebView2 profile are entirely separate from a real dev/prod install.
- **No native folder picker**: `tauri:options.args` is *not* honored by
  tauri-driver/msedgedriver as app argv (it becomes a WebView2 browser
  argument instead — confirmed empirically). So `launch()` in
  `e2e/support/app.ts` seeds `%APPDATA%\com.waypoint.e2e\waypoint.json` with
  `context_menu_asked: true` (suppresses the Explorer-integration prompt;
  the key comes from `src/App.tsx`) and `recent_repos: [<fixture path>]`
  before starting the session, clears `localStorage` on first load (WebView2
  persists it across launches under the same identifier — otherwise a
  previous test's panel widths/collapsed state would leak in), then clicks
  the recents entry on the welcome screen if a repo tab isn't already open.
- **Fresh fixture per test**: `e2e/support/fixtures.ts`'s `makeFixture(scenario, testTitle)`
  builds a scenario (via `scripts/fixtures/make-fixtures.mjs`'s exported
  `buildScenario`) into `%TEMP%\waypoint-e2e\<runId>\<slug-of-test-title>\`.
  Test titles must be unique across the whole run (the fixture dir is keyed
  by slug). The folder is deleted when the test passes; **kept, with its
  path printed to the console, when the test fails** — inspect it after the
  fact for what state the repo was left in.
- **Fresh app per test**: every test calls `launch()`/`quit()` itself (no
  shared session), so a crash or leftover dialog in one test can't affect
  the next.

## Failure artifacts

On a test failure, `e2e/support/artifacts.ts` saves a screenshot and the
full DOM to `e2e/artifacts/<spec>/<test>/`:
- `screenshot.png`
- `dom.html` (`document.documentElement.outerHTML` via `getPageSource()`)

Both `.e2e-bin/` and `e2e/artifacts/` are gitignored.

## Writing a test

Pattern (see any spec under `e2e/specs/` for the full shape):

```ts
let app: WebdriverIO.Browser | undefined;
let fixture: Fixture | undefined;

afterEach(async function () {
  const passed = this.currentTest?.state === 'passed';
  if (!passed && app) await saveFailureArtifacts(app, 'spec-name', this.currentTest!.title);
  await quit(app);
  disposeFixture(fixture, passed);
  app = fixture = undefined;
});

it('does the thing', async () => {
  fixture = makeFixture('clean', 'does the thing');
  app = await launch(fixture.openPath);

  // ... UI steps ...

  // Every test asserts BOTH the UI and the real git state. Read git state
  // from `openPath` (the folder Waypoint has open), not `root` — they differ
  // for scenarios like `worktrees` and `ahead-of-remote`, where `root` is a
  // parent folder that isn't itself a git repo.
  await waitForGit(() => head(fixture!.openPath), (h) => h !== oldHead, 'HEAD moved');
});
```

- **Never `browser.pause()` or `sleep`.** Use `waitForDisplayed`,
  `app.waitUntil(...)`, or the `waitForGit(read, ok, what, timeoutMs = 10_000)`
  helper (`e2e/support/git.ts`) for git-side effects — it polls every 200ms
  and reports the last-seen value (or error) on timeout.
- **`expect(...).toHave*()`/`toBe*()` default to a 10s wait, not
  expect-webdriverio's own 2s default** — `e2e/support/setup.ts` raises it
  once for the whole run (see `scripts/e2e/run.mjs`'s Mocha `--require`
  list). No per-assertion `{ wait: ... }` needed for the common case.
- **Selector priority** (from the plan, strictest first):
  1. Accessible name — `aria/<name>` (`byName()` in `e2e/support/ui.ts`).
  2. Visible text inside a known container.
  3. `data-testid`, only when 1 and 2 are unstable, and only if listed below.
  4. Never Tailwind classes.
- **WebdriverIO's `*=text` shorthand is unreliable in this app** — prefer
  XPath with `contains(normalize-space(.), "...")` instead.
- **Scope selectors to the section that changes.** Branch names repeat
  across Branches, Worktrees, Stashes, and the timeline — an unscoped text
  match can hit the wrong copy. E.g. `<header>` for the current branch;
  `(//div[@data-testid="commit-row"])[1]/*[3]` for the top commit's message
  cell.
- **Every UI assertion must be able to fail** — assert against the specific
  element that changes, not a broad container that would still "pass" if
  the update never happened.
- `button(scope, name)` (`e2e/support/ui.ts`) matches only real `<button>`/
  `role="button"` elements by accessible name — unlike `aria/<name>`, it
  can't accidentally match a same-named non-button (e.g. a dialog title
  that repeats the button's own label).
- `menuItem(app, name)` and `dialog(app, title)` each wait up to 10s for
  their target to mount before matching.
- Open the staging panel by **clicking the WIP row**, not a menu item.
- "Discard all" is an **in-place two-click arm/confirm button** (click once
  to arm, again to confirm) — not a separate confirmation dialog.
- **Every test asserts the UI and the git state** — never one alone.

### `data-testid`s the suite relies on

Only add a new one when accessible name and visible-text selectors are both
unstable, and list it here.

| testid | element | file |
|---|---|---|
| `worktree-indicator` | glyph marking a branch row backed by a worktree | `src/components/sidebar/RefTree.tsx` |
| `commit-row` | one row in the timeline | `src/components/timeline/CommitRow.tsx` |

## Troubleshooting

- **`msedgedriver <old> != WebView2 <new>` / preflight fails after an Edge
  update** — Edge auto-updates WebView2 independently of the recorded
  driver. Run `pnpm e2e:setup` again.
- **"port 4444 in use"** — a previous `tauri-driver` didn't get cleaned up
  (e.g. the process was killed externally). Run
  `taskkill /IM tauri-driver.exe /F` and retry.
- **The first `pnpm e2e:build` (or first `pnpm e2e`) is slow — around 6
  minutes** — it's a clean Cargo build into `src-tauri/target/e2e`, a
  separate target dir from the dev build. Subsequent runs only rebuild what
  changed and are fast.
- **The first e2e build fails under Git Bash** with an OpenSSL build error
  (`openssl-src` needs `Locale::Maketext::Simple`) — Git for Windows ships
  an MSYS `perl` that can't build the vendored OpenSSL. Run the *first*
  `pnpm e2e:build` from PowerShell or cmd.exe with Strawberry Perl on PATH.
  Incremental builds afterward work fine from any shell, Git Bash included.
- **Real app windows appear during a run** — this is expected (the harness
  drives the actual WebView2 app window); don't close them mid-run.
- **A test failed** — check `e2e/artifacts/<spec>/<test>/` for the
  screenshot and DOM dump, and the console output for the kept fixture path
  under `%TEMP%\waypoint-e2e\<runId>\<slug>\`.

## Known issues surfaced by the suite

- `src-tauri/src/commands/merge.rs` (~line 176) labels a merge of a local
  branch whose name contains `/` (e.g. `agent/dirty`, `feature/dark-mode`)
  as `Merge remote-tracking branch '<name>'` — the `/`-check meant to detect
  remote-tracking refs also matches ordinary local branches with slashes in
  their name. Test 17 (`core-git.e2e.ts`, "merge a branch cleanly") is
  deliberately wording-agnostic about the merge commit message for this
  reason; it doesn't fix the bug.
