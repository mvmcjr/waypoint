# End-to-end UI tests — design

**Date:** 2026-09-14
**Status:** approved in conversation; spec pending user review. Not committed (user rule: big work gets a `/code-review high` pass before any commit).
**Branch:** `feat/worktrees`

## Why

Waypoint has only unit tests: Vitest with a mocked IPC, and `cargo test`. None of them drives the real app, so a bug living between the UI, the Rust backend, and real git can ship unnoticed. The "phantom pending changes" checkout was exactly that kind of bug. The worktree feature adds several such seams (tabs per worktree, guards, removal, shared stashes). The goal is tests that drive the real app against the generated fixture repos and assert both what the UI shows and what git actually did.

## Decisions

| Question | Decision |
|---|---|
| Where it runs | Local Windows first, via one command. It is built so a `windows-latest` GitHub Actions job can be added later; that job is out of scope now. |
| Driver | WebdriverIO plus `tauri-driver`, Tauri's official WebDriver route. `msedgedriver` must match the installed WebView2 version. |
| Coverage | Worktree flows plus core git flows: 20 tests, listed below. |
| Isolation | A fresh fixture repo in a unique temp folder for every test, and a fresh app session for every test (`reloadSession`). |
| Assertions | Every test asserts the UI and the real repository state through the git CLI. |

## Harness

### Tooling (`pnpm e2e:setup`)
- **`tauri-driver`:** `pnpm e2e:setup` checks for it on PATH. If it is missing, the script runs `cargo install tauri-driver --locked`.
- **`msedgedriver`:**
  - The script reads the installed WebView2 Runtime version from the registry: the EdgeUpdate client `{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`, value `pv`, under `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\`, with a fallback to HKCU.
  - It downloads the matching `edgedriver_win64.zip` from Microsoft's msedgedriver download host into `.e2e-bin/<version>/`, which is gitignored.
  - It records the version in `.e2e-bin/current.json`.
- Re-running the script is idempotent. It only downloads when the versions differ.

### App under test
- **Build:** `tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json`. That config is a small merge file setting `identifier: "com.waypoint.e2e"`, so the store, recents, settings, plugins and WebView2 profile all live in a separate app-data folder, and the tests never touch the user's real data.
- **When `pnpm e2e` rebuilds:** only when `src/`, `src-tauri/src/`, `src-tauri/Cargo.toml`, `package.json`, `index.html`, `vite.config.ts`, or either tauri config is newer than the built binary.
- **First-launch prompt:** before each session the harness writes the e2e store file (`waypoint.json` in the e2e app-data folder) with the flag that marks the Windows Explorer integration prompt as already asked. Find the exact key in `App.tsx`. This keeps the harness free of product code changes.
- **Opening the repo:** the harness launches the binary with the fixture's main folder as its first argument. The app already reads this startup path (`get_startup_path`), so no native folder picker appears. It passes the argument through `tauri:options.args`. If `tauri-driver` does not support `args`, the fallback is to seed the e2e store's recents with the fixture path and click it on the welcome screen.

### Fixtures
- `scripts/fixtures/make-fixtures.mjs` gains an exported API, `buildScenario(name, reposDir)`, which builds one scenario into `reposDir` and returns the folder to open. Scenario functions take their base directory as a parameter instead of the module constant. The command-line behaviour is unchanged: `pnpm fixtures [name]` still writes to `scripts/fixtures/repos/`.
- Each test builds its scenario into `%TEMP%/waypoint-e2e/<run-id>/<spec>-<test>/`. The folder is deleted when the test passes and kept when it fails; the failure report prints its path.
- The `ahead-of-remote` scenario returns its `local/` subfolder, and `worktrees` returns `main/`.

### Layout
```
e2e/
  wdio.conf.ts          # capabilities, before/after hooks, preflight, artifacts
  tsconfig.json         # separate from the app's tsconfig
  README.md             # setup, running, writing a test, selector conventions
  support/
    app.ts              # launch/relaunch the app on a fixture folder (reloadSession + args)
    fixtures.ts         # buildScenario wrapper, temp dirs, keep-on-failure
    git.ts              # git(dir, ...args) → trimmed stdout; helpers: head(), status(), log1(), worktreeList(), stashList()
    ui.ts               # thin helpers: byName(accessibleName), menu(itemName), waitForToast(text), dialog(title)
  specs/
    smoke.e2e.ts
    worktrees.e2e.ts
    core-git.e2e.ts
scripts/e2e/setup.mjs   # the e2e:setup script
src-tauri/tauri.e2e.conf.json
```
- `vitest.config.ts` excludes `e2e/**`.
- `.gitignore` gains `.e2e-bin/` and `e2e/artifacts/`.
- Dependencies: `@wdio/cli`, `@wdio/local-runner`, `@wdio/mocha-framework`, `@wdio/spec-reporter`, `webdriverio`, `tsx` or `ts-node` as WDIO needs, and `unzipper` or PowerShell `Expand-Archive` for the setup script. Use the fewest dependencies that work.

### Selectors
- Prefer accessible names: WebdriverIO's `aria/…` selector, for example `aria/Open worktree agent-dirty` or the worktree row labels such as `agent-dirty, agent/dirty, 3 uncommitted`.
- Then visible text within a known container.
- Add `data-testid` only where neither is stable, and list every one in `e2e/README.md`.
- Never select by Tailwind class names.

### Waiting
- Never use `browser.pause`.
- Use `waitForDisplayed` / `waitUntil` on UI state. For git side effects, poll a condition with a timeout of 10 s by default, for example `waitUntil(() => git.log1(dir) === 'msg')`.

### Preflight (the WDIO `onPrepare` hook)
Before any session starts, the harness checks the following and aborts on the first failure with one actionable message:
- `git` is on PATH;
- `tauri-driver` is on PATH;
- `.e2e-bin/current.json` matches the installed WebView2 version (otherwise: "run `pnpm e2e:setup`");
- the e2e binary exists, or builds successfully.

### Failure artifacts
In `afterTest`, when a test fails, the harness saves a screenshot and `document.documentElement.outerHTML` to `e2e/artifacts/<spec>/<test>/`, and prints the kept fixture path.

### Commands (package.json)
- `e2e:setup` → `node scripts/e2e/setup.mjs`
- `e2e` → build the e2e binary if stale, then `wdio run e2e/wdio.conf.ts`. Extra arguments pass through, e.g. `pnpm e2e -- --spec e2e/specs/worktrees.e2e.ts`.
- `maxInstances: 1`: tests run one at a time.

## The suite

Every test gets a fresh fixture and a fresh app, performs its UI steps, then asserts the UI state and the git state.

**smoke.e2e.ts**
0. The app launches on the `clean` fixture, the repo tab label reads `clean`, and the timeline shows the "Add version config" commit.

**worktrees.e2e.ts** (fixture `worktrees`, opened at `main/`)
1. **Section states:**
   - The Worktrees section is listed, with the `agent-dirty` count at 3, the `conflict` tag on `agent-conflict`, the amber short hash on `agent-detached`, a lock glyph (lock-reason label) on `agent-locked`, `missing` on `agent-missing`, and a merged check on `agent-clean`.
   - The two long names are both distinguishable.
2. **Held branch `agent/dirty` in Branches:**
   - The context menu has "Open worktree agent-dirty" and no Checkout or Delete.
   - Double-clicking it opens a new tab labelled `agent-dirty` with the worktree glyph; the tab's toolbar shows branch `agent/dirty`.
3. **Commit-row menu** on `agent/dirty`'s tip commit: it offers "Open worktree", not "Checkout agent/dirty". Git: main's HEAD is still `main` and its status is unchanged.
4. **Missing worktree:**
   - `agent/missing` offers no checkout.
   - "Prune missing" removes the row.
   - Git: `git worktree list` no longer contains `agent-missing`.
5. **Remove `agent-clean`** with "Also delete branch" checked. Git: the folder is gone, `agent/clean` is gone, and the worktree is unregistered.
6. **Remove `agent-dirty`:**
   - The danger banner reads "3 uncommitted change(s) in agent-dirty will be permanently lost".
   - Confirming "Remove and discard changes" deletes the folder. Git: it is unregistered.
7. **Remove `agent-locked`:** the dialog shows the backend error containing "locked (agent running)". Git: the folder and registration remain.
8. **Merge `agent/dirty` into main:**
   - The caution banner reads "agent-dirty has 3 uncommitted change(s) that won't be merged".
   - Confirming the merge gives, in git: `git log -1` has two parents, and `src/agent-dirty-work.js` exists at main HEAD.
9. **Stash from `agent/dirty` in the main tab:**
   - Pop opens "Apply stash from another branch?". Cancel: git still shows the stash.
   - Pop again and confirm: git shows the stash list empty and the stash's change present in main's working tree.
10. **Discard all in main:** confirm the in-app dialog. Git: main is clean except `.worktrees/`, and `.worktrees/nested-agent/nested-wip.txt` still exists with its content.

**core-git.e2e.ts**

| # | Fixture | Steps | Git assertion |
|---|---|---|---|
| 11 | `staged` | Unstage `config.json`, stage `app.js` | `git diff --cached --name-only` = expected set |
| 12 | `hunks` | Stage the second hunk of `calc.py` only | `git diff --cached` contains that hunk only; the other two remain unstaged |
| 13 | `staged` | Type "e2e: commit staged work", commit | `git log -1 --format=%s` matches; staged set empty; WIP row shows the remaining unstaged changes |
| 14 | `clean` | Amend the last commit's message to "Add version config (amended)" | subject changed; parent OID unchanged |
| 15 | `clean` | Check out `feature/dark-mode` | `git symbolic-ref --short HEAD` = `feature/dark-mode`; toolbar shows it |
| 16 | `clean` | Create branch `e2e/new-branch` at the first commit | `git rev-parse e2e/new-branch` = that commit |
| 17 | `clean` | Merge `feature/dark-mode` into main | merge commit with two parents; `src/theme.js` present |
| 18 | `merge-conflict` | Conflict panel: resolve `shared.js` with Ours, finish merge | status clean; HEAD has two parents; `shared.js` has main's values |
| 19 | `stash` | Pop the stash; push a new one named "e2e stash" | first the stash list is empty and the changes are applied; then the list contains "e2e stash" |
| 20 | `staged` | Discard `scratch.txt`; then Discard all | file gone; then `git status --porcelain` is empty |

Where the UI requires a text input (commit message, branch name), tests type into the real field and submit with the app's real button.

## Error handling
- Every preflight failure prints one line naming the fix.
- Every test's git assertion shows the actual git output on failure, not just a boolean.
- A crashed app session fails only its own test. The next test's `reloadSession` starts a fresh app.

## Out of scope
- A CI job, macOS, and Linux. The harness keeps OS-specific code inside `scripts/e2e/setup.mjs` and the capabilities so they can be added later.
- Visual regression and performance tests.
- Push and pull tests.
- Plugins.

## Done when
- `pnpm e2e:setup` then `pnpm e2e` passes all 21 tests (smoke plus 20) on the user's Windows machine, twice in a row.
- A deliberately broken assertion produces a screenshot, a DOM dump, and a kept fixture path.
- `pnpm test run`, `cargo test`, and `tsc` still pass.
- `e2e/README.md` and the `CLAUDE.md` commands section are updated.
