import { expect } from 'expect-webdriverio';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { makeFixture, disposeFixture, type Fixture } from '../support/fixtures.js';
import { launch, quit } from '../support/app.js';
import { saveFailureArtifacts } from '../support/artifacts.js';
import { byName, rightClick, menuItem, dialog, button } from '../support/ui.js';
import { git, waitForGit, cachedNames, log1, parents, currentBranch, statusLines, stashList } from '../support/git.js';

describe('core-git', function () {
  let fx: Fixture | undefined;
  let app: WebdriverIO.Browser | undefined;

  async function open(scenario: string, title: string) {
    fx = makeFixture(scenario, title);
    app = await launch(fx.openPath);
  }

  afterEach(async function () {
    const passed = this.currentTest?.state === 'passed';
    if (!passed) await saveFailureArtifacts(app, 'core-git', this.currentTest!.title);
    await quit(app);
    app = undefined;
    disposeFixture(fx, passed);
    fx = undefined;
  });

  /**
   * StagingPanel (and the staging file-diff view) only render once `wipSelected`
   * is true (src/routes/repo.tsx) — the brief's tests assumed it was already
   * open. It never is on a fresh launch, even with a dirty working tree, so
   * every test that touches the staging panel clicks the WIP row first.
   * `WipRow` (src/components/timeline/WipRow.tsx) is a plain clickable `<div>`
   * with no button/aria role — same pattern as worktrees test 10 — selected by
   * its distinctive "// WIP" text.
   */
  async function openWip() {
    const wipRow = app!.$('//span[normalize-space()="// WIP"]');
    await wipRow.waitForDisplayed({ timeout: 15000 });
    await wipRow.click();
  }

  it('11 stage and unstage files', async () => {
    await open('staged', '11');
    await openWip();
    // StagingPanel's stage/unstage buttons carry a real aria-label of the shape
    // `${"Stage"|"Unstage"} file ${file.path}` (src/components/staging/StagingPanel.tsx
    // FileRow) — the brief's names omitted "file"; confirmed via getPageSource.
    await (await byName(app!, 'Unstage file config.json')).click();
    await (await byName(app!, 'Stage file app.js')).click();
    await waitForGit(
      () => cachedNames(fx!.openPath).sort(),
      (v) => JSON.stringify(v) === JSON.stringify(['app.js', 'src/feature.js']),
      'staged set'
    );
    // UI: the staged section lists exactly these two files, and config.json
    // has moved to the unstaged section — scoped to each section (FileRow's
    // `title` attribute carries the full path) so this can only pass once
    // the panel itself reflects the new split, not just git.
    const stagedSection = app!.$('section[aria-label="Staged files"]');
    await stagedSection.waitForDisplayed({ timeout: 15000 });
    const stagedSectionEl = await stagedSection.getElement();
    await app!.waitUntil(
      async () => {
        const rows = await stagedSectionEl.$$('[data-nav-row]');
        const titles = (await rows.map((r) => r.getAttribute('title'))).sort();
        return JSON.stringify(titles) === JSON.stringify(['app.js', 'src/feature.js']);
      },
      { timeout: 10000, timeoutMsg: 'staged section never listed exactly app.js and src/feature.js' }
    );
    const unstagedSection = app!.$('section[aria-label="Unstaged files"]');
    await expect(unstagedSection.$('[data-nav-row][title="config.json"]')).toBeExisting();
  });

  it('12 stage a single hunk', async () => {
    await open('hunks', '12');
    await openWip();
    // WDIO's bare `*=text` shorthand is unreliable here (see worktrees specs) —
    // use an XPath contains() scoped to the file row button instead. calc.py
    // is the only unstaged file in this fixture, so no further scoping needed.
    const calcRow = app!.$('//button[contains(., "calc.py")]');
    await calcRow.waitForDisplayed({ timeout: 15000 });
    await calcRow.click();
    // "Stage hunk" buttons (src/components/detail/FileDiffPanel.tsx HunkActionButton)
    // have no aria-label — their accessible name comes from their text content,
    // so `aria/Stage hunk` still resolves correctly. The diff panel loads
    // asynchronously (StagingFileDiffPanel fetches the workdir diff), so wait
    // for all 3 hunk buttons to mount before indexing into them — an
    // unawaited `$$` query raced the fetch and returned too few elements.
    await app!.waitUntil(
      async () => {
        const els = await app!.$$('aria/Stage hunk');
        return (await els.length) === 3;
      },
      { timeout: 15000, timeoutMsg: 'calc.py diff never rendered its 3 hunks' }
    );
    const stageHunk = await app!.$$('aria/Stage hunk');
    await stageHunk[1].click(); // second hunk only ("now clamps to zero")
    await waitForGit(
      () => git(fx!.openPath, 'diff', '--cached', 'calc.py'),
      (d) => d.includes('now clamps to zero') && !d.includes('fixed rounding'),
      'only hunk 2 staged'
    );
    const unstagedDiff = git(fx!.openPath, 'diff', 'calc.py');
    expect(unstagedDiff).toContain('fixed rounding');
    expect(unstagedDiff).toContain('guards divisor'); // third hunk also still unstaged
    // UI: staging the hunk moved calc.py into the staged section (it still
    // also appears under unstaged, since two of its three hunks remain
    // there) — scoped to the staged section specifically.
    const stagedSection = app!.$('section[aria-label="Staged files"]');
    await expect(stagedSection.$('[data-nav-row][title="calc.py"]')).toBeExisting();
  });

  it('13 commit staged work', async () => {
    await open('staged', '13');
    await openWip();
    // The commit summary field (src/components/staging/StagingPanel.tsx) is a
    // plain <input placeholder="Summary (required)"> with no aria-label or
    // <label> — `aria/Commit message` from the brief doesn't exist. Chromium
    // computes a text input's accessible name from its placeholder when no
    // other name source is present, so `aria/Summary (required)` resolves to
    // the same field.
    const msg = await app!.$('aria/Summary (required)');
    await msg.setValue('e2e: commit staged work');
    // The Commit button's accessible name includes the live staged count
    // (`Commit${n} file(s)`) rather than a bare "Commit" — this fixture has 2
    // staged files (src/feature.js, config.json), so the label is "Commit 2 files".
    await (await button(app!, 'Commit 2 files')).click();
    await waitForGit(() => log1(fx!.openPath), (s) => s === 'e2e: commit staged work', 'commit subject');
    expect(cachedNames(fx!.openPath)).toEqual([]);
    // UI: the WIP row is still displayed — this fixture's unstaged app.js and
    // untracked scratch.txt were never staged, so the working tree is still
    // dirty after the commit.
    await app!.$('//span[normalize-space()="// WIP"]').waitForDisplayed({ timeout: 15000 });
  });

  it('14 amend the last commit message', async () => {
    await open('clean', '14');
    const parentBefore = parents(fx!.openPath)[0];
    // No standalone "amend" control was reachable without a dirty working tree
    // to open the staging panel (this fixture is clean) — the real, reachable
    // control is the commit row's "Edit message…" item (CommitMenuItems.tsx),
    // which opens RewordDialog (src/components/actions/Dialogs.tsx, title
    // "Edit commit message"). This rewrites HEAD's message via `git commit
    // --amend` under the hood while leaving the parent untouched — same intent
    // as the brief's "amend" test.
    const commitRow = app!.$(
      '//div[@data-testid="commit-row"][.//*[contains(text(),"Add version config")]]'
    );
    await commitRow.waitForDisplayed({ timeout: 15000 });
    await rightClick(commitRow);
    await (await menuItem(app!, /Edit message/)).click();
    const d = await dialog(app!, 'Edit commit message');
    // RewordDialog pre-fills the Summary <Input> (not the body <Textarea>,
    // which the brief mistakenly targeted via `d.$('textarea')`) from the
    // commit's current message via an async ipc.getCommit() call — wait for
    // that fill to land before overwriting it, so the edit isn't clobbered by
    // a late resolve. There's exactly one <input> in this dialog.
    const field = await d.$('input');
    await app!.waitUntil(async () => (await field.getValue()) === 'Add version config', {
      timeout: 5000,
      timeoutMsg: 'RewordDialog summary field never pre-filled from the commit',
    });
    await field.setValue('Add version config (amended)');
    await (await button(d, 'Save')).click();
    await waitForGit(() => log1(fx!.openPath), (s) => s === 'Add version config (amended)', 'amended subject');
    expect(parents(fx!.openPath)[0]).toBe(parentBefore);
    // UI: the timeline's top commit row now shows the amended message.
    // Scoped to the message cell (3rd direct child — refs column, graph
    // spacer, then the message span; src/components/timeline/CommitRow.tsx),
    // not the whole row.
    const topRowMessage = app!.$('(//div[@data-testid="commit-row"])[1]/*[3]');
    await app!.waitUntil(
      async () => (await topRowMessage.getText()).trim() === 'Add version config (amended)',
      { timeout: 15000, timeoutMsg: 'top commit row never showed the amended message' }
    );
  });

  it('15 checkout a branch', async () => {
    await open('clean', '15');
    // The sidebar's Branches section always lists every local branch
    // (including "feature/dark-mode"), so `waitForText` against the whole
    // page body would pass even if the toolbar never updated — it isn't
    // scoped to the one place that reflects the *current* branch. Scope to
    // the app's single <header> (src/routes/repo.tsx, `⎇ {head.branch}`)
    // instead, and check it both before and after the checkout so a no-op
    // checkout can't slip through.
    await expect(app!.$('header')).toHaveText(/⎇ main/);
    const row = app!.$('//button[.//*[normalize-space()="feature/dark-mode"]]');
    await row.waitForDisplayed({ timeout: 15000 });
    await row.doubleClick();
    const d = await dialog(app!, 'Checkout'); // dialog title is "Checkout branch"; substring match
    await (await button(d, 'Checkout')).click();
    await waitForGit(() => currentBranch(fx!.openPath), (b) => b === 'feature/dark-mode', 'HEAD branch');
    await expect(app!.$('header')).toHaveText(/feature\/dark-mode/);
  });

  it('16 create a branch at a commit', async () => {
    await open('clean', '16');
    const first = git(fx!.openPath, 'rev-list', '--max-parents=0', 'HEAD');
    // Same text-shorthand-unreliable issue as tests 12/14 — use the
    // data-testid="commit-row" XPath pattern instead of `*=Initial commit`.
    const commitRow = app!.$('//div[@data-testid="commit-row"][.//*[contains(text(),"Initial commit")]]');
    await commitRow.waitForDisplayed({ timeout: 15000 });
    await rightClick(commitRow);
    await (await menuItem(app!, /New branch here/)).click();
    const d = await dialog(app!, 'Create branch');
    await (await d.$('input')).setValue('e2e/new-branch');
    // CreateBranchDialog's button label is "Create branch", not the brief's
    // bare "Create" — confirmed in src/components/actions/Dialogs.tsx.
    await (await button(d, 'Create branch')).click();
    await waitForGit(
      () => git(fx!.openPath, 'rev-parse', '--verify', '-q', 'e2e/new-branch'),
      (o) => o === first,
      'new branch at first commit'
    );
    // UI: the new branch now has its own row in the sidebar's Branches
    // section. "e2e/new-branch" doesn't exist anywhere in the UI before this
    // action, so this can only pass because the branch was actually created —
    // scoped to the Branches group's own <ul> (src/components/sidebar/RefTree.tsx),
    // not a whole-page text search.
    const branchesList = app!.$('//div[button[contains(., "Branches")]]/ul');
    const newBranchRow = branchesList.$('.//button[.//*[normalize-space()="e2e/new-branch"]]');
    await newBranchRow.waitForDisplayed({ timeout: 15000 });
  });

  it('17 merge a branch cleanly', async () => {
    await open('clean', '17');
    const row = app!.$('//button[.//*[normalize-space()="feature/dark-mode"]]');
    await row.waitForDisplayed({ timeout: 15000 });
    await rightClick(row);
    await (await menuItem(app!, 'Merge into current')).click();
    await (await button(await dialog(app!, 'Merge'), 'Merge')).click();
    await waitForGit(() => parents(fx!.openPath).length, (n) => n === 2, 'merge parents');
    expect(git(fx!.openPath, 'cat-file', '-e', 'HEAD:src/theme.js')).toBe('');
    // UI: the timeline's top row now shows the merge commit. Wording-agnostic
    // on purpose: merge.rs labels local branches containing '/' as
    // "remote-tracking" — tracked separately as a product bug (see report),
    // don't pin the wording here or the suite would lock the bug in and
    // break once it's fixed. Scoped to the message span (the commit row's
    // 3rd direct child — refs column, graph spacer, then the message span;
    // src/components/timeline/CommitRow.tsx), not the whole row, since the
    // refs column renders before the message and could itself start with
    // other text (e.g. a branch badge).
    const topRowMessage = app!.$('(//div[@data-testid="commit-row"])[1]/*[3]');
    await app!.waitUntil(
      async () => {
        const text = (await topRowMessage.getText()).trim();
        return text.startsWith('Merge') && text.includes("'feature/dark-mode'");
      },
      { timeout: 15000, timeoutMsg: 'top commit row never showed a merge of feature/dark-mode' }
    );
    // UI: current branch is still main (merging INTO main, not switching away).
    await expect(app!.$('header')).toHaveText(/⎇ main/);
  });

  it('18 resolve a merge conflict with Ours and finish', async () => {
    await open('merge-conflict', '18');
    // ConflictPanel (src/components/staging/ConflictPanel.tsx) renders a
    // whole-file "Ours"/"Theirs" quick-resolve pair per conflicted file in its
    // left file list, calling ipc.resolveOurs/Theirs directly. Its right-hand
    // ConflictHunkPicker ALSO renders a per-hunk "Ours" ChoiceButton with the
    // same plain text — that one only stages a line selection and needs a
    // separate "Accept" before it applies. Both exist simultaneously once
    // shared.js (the only conflicted file) is auto-selected on load.
    // `aria/Ours` resolves to the first in DOM order, which is the file
    // list's whole-file button (confirmed via getPageSource) — the one that
    // matches this test's intent ("resolve with Ours" in one click).
    const ours = await byName(app!, 'Ours');
    await ours.waitForDisplayed({ timeout: 15000 });
    await ours.click();
    // MergeCommitPanel's finish button is actually labelled "Commit Merge" —
    // the brief's "Finish Merge" text doesn't exist anywhere in the app.
    const commitMergeBtn = await button(app!, 'Commit Merge');
    // Wait for the resolved-file status to propagate (React Query
    // invalidation) so the button is actually enabled before clicking —
    // canFinish requires !hasConflicts, which lags one tick behind the click.
    await app!.waitUntil(
      async () => (await commitMergeBtn.getAttribute('disabled')) === null,
      { timeout: 15000, timeoutMsg: '"Commit Merge" stayed disabled' }
    );
    await commitMergeBtn.click();
    // "Commit Merge" commits directly (MergeCommitPanel.handleFinish calls
    // ipc.finishMerge straight away) — it never opens a confirmation dialog
    // (see ConflictPanel.tsx / MergeCommitPanel.tsx), so there is nothing to
    // dismiss here.
    await waitForGit(() => statusLines(fx!.openPath), (l: string[]) => l.length === 0, 'clean after finishing merge');
    expect(parents(fx!.openPath)).toHaveLength(2);
    expect(git(fx!.openPath, 'show', 'HEAD:shared.js')).toContain('VALUE = 42');
    // UI: the conflict UI is gone now that the merge is committed — both
    // ConflictPanel and MergeCommitPanel unmount once merge_in_progress
    // flips false (src/routes/repo.tsx), so "Commit Merge" no longer exists.
    await app!.$('aria/Commit Merge').waitForExist({ reverse: true, timeout: 15000 });
    // UI: the timeline's top row is now the merge commit. This fixture's
    // MERGE_MSG (written by the real `git merge --no-ff feature --no-edit`
    // that built the fixture) starts with "Merge branch 'feature'" — that's
    // the subject MergeCommitPanel pre-fills and commits verbatim.
    const topRow = app!.$('(//div[@data-testid="commit-row"])[1]');
    await app!.waitUntil(
      async () => (await topRow.getText()).includes("Merge branch 'feature'"),
      { timeout: 15000, timeoutMsg: 'top commit row never showed the merge commit' }
    );
  });

  it('19 pop a stash then push a named one', async () => {
    await open('stash', '19');
    // Pop through the sidebar's Stashes list (StashList.tsx), not the
    // timeline's per-commit StashContextMenu — that one (used by the
    // timeline stash row) never renders a cross-branch confirm dialog at all
    // (StashContextMenu.tsx just calls ipc.popStash directly), which would
    // make the "no dialog" check below pass vacuously regardless of what the
    // app actually does. Routed through StashList instead, the check is
    // meaningful: this fixture's stash was made AND applied on main, so
    // `isCrossBranch` really does decide not to show the dialog here.
    const stashesList = app!.$('//div[button[contains(., "Stashes")]]/ul');
    const stashRow = stashesList.$('.//button[contains(., "keyword argument for hello")]');
    await stashRow.waitForDisplayed({ timeout: 15000 });
    await rightClick(stashRow);
    await (await menuItem(app!, /^Pop/)).click();
    // Same-branch stash (made and applied on main) → no cross-branch confirm
    // dialog (src/components/sidebar/StashList.tsx `isCrossBranch`). Checked
    // AFTER the pop actually completes (not right after the click) so a
    // dialog has had the full real-git round trip to mount if it were going
    // to — a check taken immediately after the click has no wait window and
    // could pass by sheer timing even if a dialog were about to appear.
    await waitForGit(() => stashList(fx!.openPath).length, (n) => n === 0, 'stash popped');
    expect(await app!.$('[role=dialog]').isExisting()).toBe(false);
    // Git: the stash's changes are actually applied to the working tree —
    // main.py's keyword-argument edit and the untracked wip.py it stashed
    // alongside (see make-fixtures.mjs `makeStash`).
    const mainPy = join(fx!.openPath, 'main.py');
    const wipPy = join(fx!.openPath, 'wip.py');
    await waitForGit(
      () => (existsSync(wipPy) ? readFileSync(mainPy, 'utf8') : ''),
      (v) => v.includes('hello(name="world")'),
      'main.py and wip.py restored after pop'
    );
    expect(readFileSync(mainPy, 'utf8')).toContain('hello(name="world")');
    expect(existsSync(wipPy)).toBe(true);
    expect(statusLines(fx!.openPath).some((l) => l.includes('main.py'))).toBe(true);
    expect(statusLines(fx!.openPath).some((l) => l.includes('wip.py'))).toBe(true);
    // Push a named stash via the app's stash control. It only exists once the
    // staging panel is open (see openWip()) — popping left the tree dirty
    // again (main.py modified, wip.py untracked), so a WIP row exists now.
    // The control's real aria-label is "Stash all changes" (an icon-only
    // button in StagingPanel.tsx) — the brief's "Stash changes" is actually
    // the dialog's title, not the trigger button's name.
    await openWip();
    await (await byName(app!, 'Stash all changes')).click();
    const d = await dialog(app!, 'Stash');
    await (await d.$('input')).setValue('e2e stash');
    await (await button(d, 'Stash')).click();
    await waitForGit(() => stashList(fx!.openPath).join('\n'), (s) => s.includes('e2e stash'), 'named stash pushed');
  });

  it('20 discard a file, then discard all', async () => {
    await open('staged', '20');
    // StagingPanel isn't open by default (see openWip() above) — required to
    // reach both the per-file discard context menu and the discard-all button.
    await openWip();
    const scratchRow = app!.$('//button[contains(., "scratch.txt")]');
    await scratchRow.waitForDisplayed({ timeout: 15000 });
    await rightClick(scratchRow);
    await (await menuItem(app!, /^Discard/)).click();
    // Per-file "Discard changes" calls ipc.discardFile directly (see
    // StagingPanel.tsx's FileRow onDiscard) — it never opens a confirmation
    // dialog, so there is nothing to dismiss here.
    await waitForGit(
      () => statusLines(fx!.openPath).some((l: string) => l.includes('scratch.txt')),
      (v) => v === false,
      'scratch.txt discarded'
    );
    // UI: scratch.txt's own row is gone from the staging file list.
    await app!.$('//button[contains(., "scratch.txt")]').waitForExist({ reverse: true, timeout: 15000 });
    // "Discard all" is an in-place two-click arm/confirm button, not a
    // dialog (src/components/staging/StagingPanel.tsx `handleDiscard`) — its
    // aria-label changes between the two clicks, not its own text/name.
    await (await byName(app!, 'Discard all changes, including untracked files')).click();
    await (await byName(app!, 'Confirm: discard all changes')).click();
    await waitForGit(() => statusLines(fx!.openPath), (l) => l.length === 0, 'status clean');
    // UI: the tree is fully clean now, so the timeline's WIP row (rendered
    // only while the working directory is dirty — WipRow.tsx) is gone too.
    await app!.$('//span[normalize-space()="// WIP"]').waitForExist({ reverse: true, timeout: 15000 });
  });
});
