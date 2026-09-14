import { expect } from 'expect-webdriverio';
import { join } from 'node:path';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { makeFixture, disposeFixture, type Fixture } from '../support/fixtures.js';
import { launch, quit } from '../support/app.js';
import { saveFailureArtifacts } from '../support/artifacts.js';
import { byName, rightClick, menuItem, dialog, button, waitForText } from '../support/ui.js';
import { currentBranch, statusLines, worktreeList, git, waitForGit, parents, stashList } from '../support/git.js';

describe('worktrees', function () {
  let fx: Fixture | undefined;
  let app: WebdriverIO.Browser | undefined;
  const wt = (name: string) => join(fx!.root, 'worktrees', name);

  // Launch inside each test (not in a hook) — a failing beforeEach would
  // silently skip every remaining test in this describe block. Each test
  // calls this itself, the same way core-git.e2e.ts's `open()` does.
  async function open(title: string) {
    fx = makeFixture('worktrees', title);
    app = await launch(fx.openPath);
  }

  afterEach(async function () {
    const passed = this.currentTest?.state === 'passed';
    if (!passed) await saveFailureArtifacts(app, 'worktrees', this.currentTest!.title);
    await quit(app);
    app = undefined;
    disposeFixture(fx, passed);
    fx = undefined;
  });

  it('1 lists every worktree state in the sidebar section', async () => {
    await open('1');
    await expect(byName(app!, 'Worktrees')).toBeDisplayed();
    await expect(app!.$('aria/agent-dirty, agent/dirty, 3 uncommitted')).toBeDisplayed();
    // Conflict tag: scoped to the agent-conflict row itself (its aria-label
    // includes ", conflicted" — see WorktreeRow's ariaLabel builder) so this
    // can only pass because that specific row renders the tag, not because
    // some other "conflict" text exists elsewhere in the sidebar.
    await expect(app!.$('[aria-label^="agent-conflict"][aria-label*="conflicted"]')).toBeDisplayed();
    await expect(app!.$('aria/agent-missing, missing')).toBeDisplayed();
    await expect(app!.$('[aria-label^="agent-clean"][aria-label*="merged"]')).toBeDisplayed();
    await expect(app!.$('[aria-label^="agent-detached, detached"]')).toBeDisplayed();
    // Lock glyph: scoped to the actual <Lock> icon inside the agent-locked
    // row (title = the lock reason, "agent running" — WorktreeList.tsx), not
    // just the row's aria-label prefix, which would still match even if the
    // glyph itself never rendered.
    await expect(app!.$('[aria-label^="agent-locked"] [title="agent running"]')).toBeDisplayed();
    const long1 = await app!.$('[aria-label^="waypoint-agent-1-longer-suffix"]').getText();
    const long2 = await app!.$('[aria-label^="waypoint-agent-2-longer-suffix"]').getText();
    expect(long1).not.toBe(long2);
    expect(worktreeList(fx!.openPath)).toContain('agent-dirty');        // git agrees on the worktree set
  });

  it('2 held branch offers Open worktree, not Checkout/Delete, and double-click opens its tab', async () => {
    await open('2');
    // "agent/dirty" as exact text also appears in the Worktrees section row and
    // in the shared stash list row ("agent WIP on agent/dirty") — scope to the
    // Branches row specifically via its sibling worktree-name indicator chip
    // (only Branches rows for a held branch render one), and wait for it so a
    // right-click doesn't land while the sidebar is still reflowing from the
    // initial refs/worktree-status fetch.
    const row = app!.$('//button[.//*[normalize-space()="agent/dirty"] and .//*[@data-testid="worktree-indicator"]]');
    await row.waitForDisplayed({ timeout: 15000 });
    await rightClick(row);
    await expect(await menuItem(app!, /^Open worktree/)).toBeDisplayed();
    await expect(app!.$('//*[@role="menuitem" and contains(.,"Checkout")]')).not.toBeExisting();
    await expect(app!.$('//*[@role="menuitem" and contains(.,"Delete")]')).not.toBeExisting();
    await app!.keys('Escape');
    await row.doubleClick();
    await expect(app!.$('//*[@role="tab" and contains(., "agent-dirty")]')).toBeDisplayed();
    await expect(app!.$('header')).toHaveText(/agent\/dirty/); // R1: toolbar shows the branch
    expect(currentBranch(wt('agent-dirty'))).toBe('agent/dirty');
    expect(currentBranch(fx!.openPath)).toBe('main');                   // main untouched
  });

  it('3 commit-row menu on a held branch offers Open worktree instead of Checkout', async () => {
    await open('3');
    const before = statusLines(fx!.openPath);
    // WDIO's bare `*=text` shorthand (no real tag before `*=`) never matched
    // via the WebDriver protocol here even though the text is genuinely
    // rendered (confirmed via an in-page `document.evaluate` probe) — use an
    // explicit XPath scoped to the commit row instead. The timeline's commit
    // list is also still loading when the test starts (fresh launch, ~2s to
    // populate in practice), so wait for the row rather than right-clicking a
    // not-yet-rendered one.
    const commitRow = app!.$(
      '//div[@data-testid="commit-row"][.//*[contains(text(),"agent: dirty branch work")]]'
    );
    await commitRow.waitForDisplayed({ timeout: 15000 });
    await rightClick(commitRow);
    await expect(await menuItem(app!, /^Open worktree/)).toBeDisplayed();
    await expect(app!.$('//*[@role="menuitem" and contains(.,"Checkout agent/dirty")]')).not.toBeExisting();
    await app!.keys('Escape');
    expect(currentBranch(fx!.openPath)).toBe('main');
    expect(statusLines(fx!.openPath)).toEqual(before);
  });

  it('4 missing worktree: no checkout; Prune missing removes it', async () => {
    await open('4');
    const row = app!.$('//button[.//*[normalize-space()="agent/missing"]]');
    // Wait for the row to mount, and confirm the context menu actually opened
    // (via a positive match first) before trusting the negative Checkout
    // check below — otherwise a menu that never opened at all would also
    // make `not.toBeExisting()` pass vacuously. agent/missing is still a
    // registered (held) worktree, so it offers "Open worktree" like any
    // other held branch (RefTree.tsx `buildMenu`).
    await row.waitForDisplayed({ timeout: 15000 });
    await rightClick(row);
    await expect(await menuItem(app!, /^Open worktree/)).toBeDisplayed();
    await expect(app!.$('//*[@role="menuitem" and contains(.,"Checkout")]')).not.toBeExisting();
    await app!.keys('Escape');
    await (await byName(app!, 'Prune missing')).click();
    await app!.$('aria/agent-missing, missing').waitForExist({ reverse: true, timeout: 10000 });
    await waitForGit(() => worktreeList(fx!.openPath), (v) => !v.includes('agent-missing'), 'worktree list after prune');
  });

  it('5 remove a clean merged worktree and its branch', async () => {
    await open('5');
    await rightClick(await app!.$('[aria-label^="agent-clean"]'));
    await (await menuItem(app!, 'Remove worktree…')).click();
    const d = await dialog(app!, 'Remove worktree');
    // `aria/Also delete branch agent/clean` resolves to the visually-hidden
    // native <input> (labelled via <label for>), not the actual interactive
    // Base UI checkbox (a `role="checkbox"` span labelled via
    // aria-labelledby) that sits at the visible control's position — clicking
    // the hidden input's computed point lands on the dialog overlay instead.
    // It's the only checkbox in this dialog, so target it by role.
    await (await d.$('[role="checkbox"]')).click();
    await (await button(d, 'Remove')).click();
    await waitForGit(() => existsSync(wt('agent-clean')), (v) => v === false, 'agent-clean folder removed');
    expect(git(fx!.openPath, 'branch', '--list', 'agent/clean')).toBe('');
    expect(worktreeList(fx!.openPath)).not.toContain('agent-clean');
    // UI: the agent-clean row itself is gone from the Worktrees section —
    // scoped to its own aria-label prefix, so this can only pass because
    // that specific row was actually removed from the sidebar.
    await app!.$('[aria-label^="agent-clean"]').waitForExist({ reverse: true, timeout: 15000 });
  });

  it('6 remove a dirty worktree shows the danger tier and discards', async () => {
    await open('6');
    await rightClick(await app!.$('[aria-label^="agent-dirty"]'));
    await (await menuItem(app!, 'Remove worktree…')).click();
    const d = await dialog(app!, 'Remove worktree');
    await expect(d).toHaveText(
      expect.stringContaining('3 uncommitted change(s) in agent-dirty will be permanently lost')
    );
    await (await button(d, 'Remove and discard changes')).click();
    await waitForGit(() => existsSync(wt('agent-dirty')), (v) => v === false, 'agent-dirty folder removed');
    expect(worktreeList(fx!.openPath)).not.toContain('agent-dirty');
  });

  it('7 remove a locked worktree is refused with the reason', async () => {
    await open('7');
    await rightClick(await app!.$('[aria-label^="agent-locked"]'));
    await (await menuItem(app!, 'Remove worktree…')).click();
    const d = await dialog(app!, 'Remove worktree');
    await (await button(d, 'Remove')).click();
    await expect(d).toHaveText(expect.stringContaining('locked (agent running)'));
    expect(existsSync(wt('agent-locked'))).toBe(true);
    expect(worktreeList(fx!.openPath)).toContain('agent-locked');
  });

  it('8 merging a dirty worktree branch warns about uncommitted work', async () => {
    await open('8');
    // Same ambiguity as test 2: "agent/dirty" as exact text also appears in
    // the Worktrees section row and the shared stash row — scope to the
    // Branches row via its worktree-name indicator chip, and wait for it so
    // the right-click doesn't race the initial refs/worktree-status fetch.
    const row = app!.$(
      '//button[.//*[normalize-space()="agent/dirty"] and .//*[@data-testid="worktree-indicator"]]'
    );
    await row.waitForDisplayed({ timeout: 15000 });
    await rightClick(row);
    await (await menuItem(app!, 'Merge into current')).click();
    // `dialog()` matches on the dialog's full text, so the "Merge" DialogTitle
    // is enough to find it; `button()` below is scoped to real <button>
    // elements, so it can't accidentally match that same "Merge" heading.
    const d = await dialog(app!, 'Merge');
    await expect(d).toHaveText(
      expect.stringContaining("agent-dirty has 3 uncommitted change(s) that won't be merged")
    );
    await (await button(d, 'Merge')).click();
    await waitForGit(() => parents(fx!.openPath).length, (n) => n === 2, 'merge commit parents');
    expect(git(fx!.openPath, 'cat-file', '-e', 'HEAD:src/agent-dirty-work.js')).toBe('');
  });

  it('9 stash made on another branch asks before popping', async () => {
    await open('9');
    // WDIO's `*=text` shorthand is unreliable here (see tests 2/3) — this
    // text is unique in the DOM (the stash's own label + branch chip), so a
    // plain XPath contains() is enough without further scoping to the
    // Stashes section.
    const stash = app!.$('//button[contains(., "agent WIP on agent/dirty")]');
    await stash.waitForDisplayed({ timeout: 15000 });
    await rightClick(stash);
    await (await menuItem(app!, /^Pop/)).click();
    let d = await dialog(app!, 'Apply stash from another branch?');
    await (await button(d, 'Cancel')).click();
    expect(stashList(fx!.openPath)).toHaveLength(1);
    await rightClick(stash);
    await (await menuItem(app!, /^Pop/)).click();
    d = await dialog(app!, 'Apply stash from another branch?');
    await (await button(d, 'Pop')).click();
    await waitForGit(() => stashList(fx!.openPath).length, (n) => n === 0, 'stash popped');
    // Git: the stash's change (agent-dirty-work.js = "step-2-wip", from the
    // WIP stash made in the agent-dirty worktree) is now present in main's
    // own working tree, not just discarded along with the popped stash.
    const workFile = join(fx!.openPath, 'src', 'agent-dirty-work.js');
    await waitForGit(
      () => (existsSync(workFile) ? readFileSync(workFile, 'utf8') : ''),
      (v) => v.includes('step-2-wip'),
      'agent-dirty-work.js updated on main after pop'
    );
    // Normalize line endings before the exact match — this file round-trips
    // through git's checkout filter (unlike the nested worktree's untracked
    // file below), and Windows checkouts commonly convert LF to CRLF
    // (core.autocrlf=true), which would otherwise fail this assertion for a
    // reason unrelated to what it's actually checking.
    expect(readFileSync(workFile, 'utf8').replace(/\r\n/g, '\n')).toBe('export const AGENT_DIRTY = "step-2-wip";\n');
    expect(statusLines(fx!.openPath).some((l) => l.includes('agent-dirty-work.js'))).toBe(true);
  });

  it('10 discard all keeps the nested worktree and removes untracked junk', async () => {
    await open('10');
    // Main starts clean apart from the `.worktrees/` entry (the nested
    // worktree's own directory, reported as a single untracked path since it
    // has its own `.git` file) — write an untracked file so Discard all has
    // real work to do beyond that protected path.
    writeFileSync(join(fx!.openPath, 'junk.txt'), 'discard me\n');

    // `WipRow` (src/components/timeline/WipRow.tsx) is a plain clickable
    // `<div>`, not a button/aria-labelled control — select it by its
    // distinctive "// WIP" text; a real click bubbles to the row's onClick
    // the same as it would for a user.
    const wipRow = app!.$('//span[normalize-space()="// WIP"]');
    await wipRow.waitForDisplayed({ timeout: 15000 });
    await wipRow.click();

    // The brief assumed a confirm dialog for "Discard all"; the actual
    // control (StagingPanel.tsx) is a single button that arms on the first
    // click (aria-label changes to "Confirm: discard all changes") and
    // confirms on the second — no `[role=dialog]` involved.
    await (await button(app!, 'Discard all changes, including untracked files')).click();
    await (await button(app!, 'Confirm: discard all changes')).click();

    await waitForGit(
      () => statusLines(fx!.openPath),
      (l) => l.every((x) => x.includes('.worktrees/')),
      'main clean except .worktrees/'
    );
    expect(existsSync(join(fx!.openPath, 'junk.txt'))).toBe(false);
    // UI: junk.txt's own row is gone from the staging file list (the panel
    // is still open from the WIP-row click above).
    await app!.$('[data-nav-row][title="junk.txt"]').waitForExist({ reverse: true, timeout: 15000 });
    const nestedFile = join(fx!.openPath, '.worktrees', 'nested-agent', 'nested-wip.txt');
    expect(existsSync(nestedFile)).toBe(true);
    expect(readFileSync(nestedFile, 'utf8')).toBe(
      'Uncommitted file inside a worktree nested under main/.\nProves "Discard all" in main must not delete this.\n'
    );
  });
});
