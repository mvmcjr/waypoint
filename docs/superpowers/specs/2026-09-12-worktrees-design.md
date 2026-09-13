# Worktrees — first-class worktree support

**Date:** 2026-09-12
**Status:** design approved in conversation; spec pending user review. Not committed: a `/code-review high` subagent reviews the whole change before any commit.

## Why

Agents now do their work in linked git worktrees. Waypoint treated a worktree only as "a repo you can open", which broke in practice: checking out `sinalizacao` in `E:\alugar` while the branch was checked out in `E:\alugar-sinalizacao` rewrote the working tree before `set_head` refused, leaving the branch's commits as phantom pending changes. More broadly, the user cannot see which worktrees exist, where each branch is checked out, or where uncommitted work was left.

**The model:** a branch is a ref; a worktree is a folder with its own HEAD, index and in-progress state. **One tab = one folder = one HEAD.** A worktree opens in its own tab, so it is always clear which directory you are in and where commits go.

## Already done (uncommitted, verified: `cargo test` 64 passed)

1. **Watcher** watches `repo.commondir()` (plus `repo.path()` if outside it) instead of `<path>/.git`, so linked worktrees get `repo-changed` (`watch_roots` in `commands/repo.rs`).
2. **Checkout guard:** `do_checkout` refuses a local branch checked out in another worktree *before* touching the tree, including from a detached HEAD, where libgit2 does not check.
3. **Ref-move guards:** `checkout_remote_branch` fast-forward, `reset_branch_to_remote` and `delete_branch` refuse branches held by another worktree before moving or deleting the ref. `rename_branch` keeps libgit2's behavior of updating the other worktree's HEAD (regression test).
4. **Autostash** records the stash OID and pops that stash, not `stash@{0}`, since stashes are shared across worktrees.
5. **`RefInfo.worktree_path`**: set for local branches checked out in another worktree. Helpers `other_worktree_heads` / `checked_out_elsewhere` live in `src-tauri/src/repo/mod.rs`.

In progress (frontend agent): a badge on worktree-held branches; Checkout, Delete and reset-to-remote disabled with the reason shown; "Open worktree" (new tab, or activate the existing tab) on the menu and on double-click. Merge, rebase-onto, cherry-pick, rename, push and plugin items stay enabled.

## Decisions

| Question | Decision |
|---|---|
| Worktrees vs branches | Separate **Worktrees** sidebar section, directly below Branches; branches keep the badge. |
| Double-click a worktree | **Open in a new tab**, or activate it if already open. No in-place tab switch, no "preview in main folder" (both rejected: they hide which folder you are committing in). |
| Single click | Jump the timeline to that worktree's HEAD commit (same as ref rows). |
| Cleanup | **Remove worktree** and **Prune missing** are in scope. |
| Change counts | **Live:** poll like repo status, plus refresh on focus, tab switch, section expand and git events. |
| Shared stashes | Label each stash with its origin branch; dim other-branch stashes; confirm before Pop/Apply across branches. |
| Recent repos | Opening a linked worktree records its **main** repo only. |
| Data shape | Split: cheap `list_worktrees` + per-worktree `worktree_status`. |
| Merge | Unchanged (normal merge). Merge dialog warns when the source branch's worktree has uncommitted changes. |

## Backend

### Canonical paths
One helper, `canonical_path(p)`: `std::fs::canonicalize`, strip the Windows `\\?\` prefix, no trailing separator. Used by:
- `open_repo`: the returned id **is** the canonical path, so tab ids and `RepoState` keys never duplicate one folder;
- `list_worktrees` paths;
- `RefInfo.worktree_path`.

git2 reports worktree paths as `E:/x/` while the folder picker yields `E:\x`. Without this, "activate if already open" silently fails and opens a duplicate tab with a second repo handle.

### New commands (register in `lib.rs`, wrappers in `lib/ipc.ts`)

**`list_worktrees(repo_id) -> Vec<WorktreeInfo>`**
```
WorktreeInfo {
  path: String,            // canonical
  name: String,            // folder name
  is_main: bool,
  is_current: bool,        // the worktree this tab has open
  branch: Option<String>,  // shorthand (also for an unborn branch); None when detached
  head_oid: Option<String>,
  is_detached: bool,
  is_locked: bool,
  lock_reason: Option<String>,
  is_missing: bool,        // folder gone / prunable
  branch_merged: bool,     // branch tip reachable from this tab's HEAD (safe to delete)
}
```
Main worktree first (omitted when the main repo is bare), then the rest by name. Cheap: no status scans. Refreshes with refs (query key `["worktrees", repoId]`, added to `useRefreshRepo`).

**`worktree_status(path) -> WorktreeStatus { changed: usize, conflicted: bool }`**
Opens its own `Repository::open(path)` inside `spawn_blocking` and **never takes the `RepoState` mutex**, so a slow scan cannot stall other commands. Counts staged + unstaged + untracked (ignored excluded). Returns an error for a missing path; the UI shows "–".

**`remove_worktree(repo_id, path, force: bool, delete_branch: bool) -> RemoveResult { branch_deleted: bool, branch_kept_reason: Option<String> }`**
Shells out to `git worktree remove [--force] <path>` (same `run_git` pattern as `remote.rs`), so git's own safety checks apply. It refuses when:
- the target is the main worktree or this tab's current worktree;
- the worktree is dirty and `force` is false;
- the worktree is locked (error carries the reason).

When `delete_branch` is true, it deletes the branch only if merged into this tab's HEAD (`git branch -d` semantics); otherwise it keeps the branch and reports why.

**`prune_worktrees(repo_id)`**: `git worktree prune`.

### Changed commands
- **`discard_all`** never deletes an untracked directory that contains a `.git` entry (a file or a directory). Agents create worktrees inside the repo (`.worktrees/x`, `.claude/worktrees/x`); if that folder isn't gitignored, today's `remove_dir_all` on untracked dirs (`staging.rs` ~385–396) would delete the agent's worktree and its uncommitted work. **Test first:** a real nested worktree must survive Discard all.
- **`list_stashes`**: add `branch: Option<String>`, parsed from git's `On <branch>:` / `WIP on <branch>:` prefix (`None` if unparseable).
- **`open_repo`** returns `OpenedRepo { id: String, main_worktree_path: Option<String> }`; `main_worktree_path` is set when the opened folder is a linked worktree whose main worktree is not bare.
- **Repo status** (`get_repo_status`, already polled every 3s) returns a typed `repo_gone` error when this tab's working directory or git dir no longer exists. This is the one detection point for "worktree removed while its tab is open".

### Unchanged
Merge, rebase, cherry-pick, push and pull need no worktree logic: they only move the current worktree's own branch, which git guarantees no other worktree holds.

## Frontend

### Worktrees section (`src/components/sidebar/`)
- Directly below Branches, same header anatomy as the other groups (10px `FolderGit2`, `WORKTREES`, count, chevron). **Hidden when the repo has only its main worktree.**
- **Row:** folder name (12px sans, full path in the tooltip) on the left. On the right, the branch in mono dimmed like non-HEAD refs; when detached, a 7-char short hash in Marker Amber.
  - Current worktree: teal text and the glowing teal dot, the same as the HEAD branch row (One Position Rule; nothing else here is teal).
  - Change count: WIP-orange tabular number when > 0; "–" when unknown.
  - Missing: 35% opacity, italic, `missing` label; open disabled.
  - Locked: 8px lock glyph at 40%; lock reason in the tooltip.
- **Live counts:** `useWorktreeStatus(path)` per row, `refetchInterval` 3000 ms, enabled only while the section is expanded and the document is visible, with adaptive back-off `max(3000, 5 × lastScanMs)`; refetch on window focus and on `repo-changed`.
- **Click:** select `head_oid` in the timeline. **Double-click / hover open icon:** open the worktree in a new tab via the existing open-repo flow, or `switchTab` if a tab with that canonical id exists. No open action on the current row.
- **Context menu:** Open in new tab · Reveal in Explorer/Finder (`revealItemInDir`) · Copy path · separator · Remove worktree…. The section header shows "Prune missing" only when a row is missing.
- **Filter:** the sidebar filter matches folder name and branch.

### Remove dialog
- **Clean worktree:** normal confirm with the primary button. Nothing is lost; commits live on the branch.
- **Dirty worktree:** red danger banner "N uncommitted changes will be permanently lost" and the destructive button "Remove and discard changes" (calls with `force: true`).
- **Branch checkbox:** "Also delete branch `x`" enabled only when `branch_merged`; otherwise disabled with "not merged into <current>".
- **Success:** closes that worktree's tab if one is open; refreshes the list.

### Tabs (`src/components/tabs/`)
- Linked-worktree tabs carry a worktree glyph; the tooltip shows the full path.
- When two open tabs share a folder name, both show `name · <main repo name>`.
- **Removed state:** when repo status returns `repo_gone`, the tab body becomes "This worktree was removed · `<path>`" with a Close tab button, and its queries stop polling.

### Stashes (`StashList.tsx`)
- Each row shows its origin branch in dim mono.
- Rows from a branch other than this tab's HEAD are dimmed.
- Pop or Apply on them first asks "This stash was made on `master`. Apply it to `sinalizacao`?".

### Merge dialog
When the source is a branch with `worktree_path` and that worktree's `worktree_status.changed > 0`, show an amber caution banner: "`<worktree>` has N uncommitted changes that won't be merged."

### Recents
When `openRepo` returns `main_worktree_path`, record that path in recents instead of the worktree's.

### Branch badge and menus: fixes from the first critique
The first impeccable critique scored the shipped badge and menus 23/40 (`.impeccable/critique/2026-09-13T00-20-29Z__src-components-sidebar-reftree-tsx.md`). The user chose to fold every fix into this build:

- **Visible location.** A held branch's sidebar row shows a mono worktree-name chip instead of the lone icon: `FolderGit2` plus the worktree's folder name, 10px mono, middle-truncated, at least 60% opacity and brighter on row hover. Timeline badges keep a glyph, raised to about 60%. The glyph's width (about 10px) is subtracted from the badge truncation budget (`RefBadge.tsx` ~249), so the name's tail is no longer clipped.
- **Menus name the target.** Remove the disabled "Checked out elsewhere" line and every `title` on disabled items: menu items set `data-disabled:pointer-events-none` (`ui/context-menu.tsx:102`), so those tooltips never show. The action reads `Open worktree`, with the worktree's folder name in muted mono, right-aligned, following the existing `Checkout <name>` pattern. Move it high in the badge menu, directly after where Checkout would be, with a separator after it. Hide Delete for held branches: cleanup goes through Remove worktree, which can also delete the branch. Use one phrase everywhere: "Checked out in worktree `<name>`".
- **Accessibility.** Held rows and badges get an accessible description ("checked out in worktree `<name>`") via sr-only text or `aria-describedby`. Add a command-palette entry, "Open worktree…", listing each worktree with its branch.
- **Every entry point guarded.** The Remotes group's "Checkout origin/x" is replaced by "Open worktree" when local `x` is held by another worktree. The icon use in menu items is the same in the sidebar and timeline menus.
- **Double-click means "go to this branch", everywhere.** On a normal branch it opens the existing checkout dialog; on a held branch it opens the worktree's tab. This applies to sidebar rows and timeline badges alike.
- **Deleted worktree on open.** If the folder is gone, show the toast "Worktree folder no longer exists", with a Prune missing action, instead of the init-repo prompt (`useOpenRepo.ts` ~22–25).

## Errors
- Every worktree error names the path and the next step, e.g. "`fix` is locked (agent running) — unlock it in a terminal".
- `git worktree remove` failures surface git's message verbatim, as push errors already do.
- A failed `worktree_status` shows "–" and never blocks the list or other rows.
- Races are expected: a worktree removed mid-scan becomes `missing` or `repo_gone`, never a crash or an unhandled rejection.

## Testing (test-first)

**Rust** (real linked worktrees via `repo::test_support`):
- `canonical_path` strips `\\?\` and the trailing separator; an `open_repo` on `E:/x/` and on `E:\x` yields one id.
- `list_worktrees`: main + linked; detached; locked with a reason; missing folder; bare main omitted; `is_current` from both sides; `branch_merged`.
- `worktree_status`: counts staged/unstaged/untracked; errors on a missing path; does not lock `RepoState` (callable while the mutex is held).
- `remove_worktree`: refuses main, current, locked, and dirty without force; force removes dirty; `delete_branch` deletes merged branches and keeps unmerged ones with a reason.
- `discard_all`: a nested worktree survives (must fail before the fix).
- `list_stashes` branch parsing for both message formats and garbage.
- `get_repo_status` returns `repo_gone` after the worktree folder is deleted.

**Frontend** (Vitest + Testing Library):
- The section is hidden with one worktree and shown with two or more.
- Row states render: current, detached, missing, locked, dirty count, unknown.
- Double-click opens a new tab; an already-open canonical path activates it without a duplicate.
- The remove dialog switches between clean confirm and dirty danger; the branch checkbox follows `branch_merged`; success closes the worktree's tab.
- Stash cross-branch confirm appears only for other-branch stashes.
- The merge caution banner appears only for dirty worktree-held branches.
- The tab name collision suffix appears.
- Recents records the main path.
- The removed-worktree tab state renders on `repo_gone`.
- Critique fixes:
  - The worktree-name chip renders on held rows.
  - The menu shows `Open worktree` with the name, and no disabled reason line or Delete.
  - The accessible description is present.
  - Remotes checkout is replaced for held upstreams.
  - Double-click opens the checkout dialog on a normal branch and the worktree tab on a held one, on both rows and badges.
  - The badge truncation budget accounts for the glyph.
  - A deleted worktree shows the toast, not the init prompt.
  - The palette lists worktrees.

**Finish:**
1. Re-run `/impeccable critique` on the section and the badge UI; the target is to beat 23/40.
2. A `/code-review high` subagent over the whole change.
3. The user decides on the commit.

## Out of scope
- Creating worktrees from the UI ("Checkout in new worktree…"), and lock/unlock.
- Previewing a worktree's code in the main folder, and switching a tab in place (rejected above).
- Showing other worktrees' HEADs as markers on the timeline.
- An "Open terminal here" palette command (possible cheap follow-up for running a second dev server in a worktree).
