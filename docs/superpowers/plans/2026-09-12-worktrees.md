# Worktrees Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make git worktrees first-class in Waypoint: a Worktrees sidebar section (list, live change counts, open in a new tab, remove, prune), safe handling of branches held by other worktrees, and the hazards found in the stress test fixed.

**Architecture:**
- **Backend:** a new `commands/worktrees.rs` module adds `list_worktrees` (cheap metadata), `worktree_status` (per-worktree change count on its own repo handle, never under the shared `RepoState` lock), `remove_worktree` and `prune_worktrees` (both shell out to the system `git`, like `remote.rs`).
- **Canonical paths:** every path the backend hands the frontend is canonical, so tab ids never duplicate one folder.
- **Frontend:** a new `WorktreeList` component sits under Branches. Tabs learn whether they hold a linked worktree. The critique fixes land in `RefTree`/`RefBadge`.

**Tech Stack:** Rust (git2 0.20 / libgit2 1.9.4, tauri 2, tokio), React 19 + TypeScript, TanStack Query, Zustand, Tailwind v4, Base UI / shadcn, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-12-worktrees-design.md`. Read it before starting any task.

## Global Constraints

- **Do NOT commit, stage, or create branches.** Leave every change in the working tree. The user requires a `/code-review high` pass before any commit. Wherever a TDD template says "Commit", skip that step.
- **Test-first:** write the test, run it, and see it fail for the expected reason before implementing. Report the observed failure.
- **Backend tests:** `cd E:\waypoint\src-tauri && cargo test <name>`. **Frontend tests:** `cd E:\waypoint && pnpm test run <file>`, plus `pnpm exec tsc --noEmit`.
- **Real linked worktrees in Rust tests**, via `crate::repo::test_support::{make_repo_with_commit, add_worktree, make_temp_dir}`. No mocks.
- **Windows `core.autocrlf`** may rewrite `\n` to `\r\n` on checkout. Compare file contents with `.trim_end()`.
- **Backend lane** owns everything under `src-tauri/`. **Frontend lane** owns everything under `src/`. The lanes run in parallel and never edit each other's files. Frontend tests mock `@/lib/ipc`, so they do not need the backend.
- **Design rules** (`DESIGN.md`, "Night Chart"):
  - Teal only for the current position (HEAD, current worktree).
  - Marker Amber for detached HEADs and caution.
  - WIP Orange (`text-orange-300`) for uncommitted work.
  - Hazard Red only for no-undo loss.
  - Mono for every git identifier (branch, hash, worktree folder name).
  - Hover and selection are white-alpha overlays.
  - Operating-view type stays within 8–14px.
- **New base UI components** are generated with `pnpm dlx shadcn@latest add <component>`, never hand-written.
- **One phrase** for a held branch everywhere: "Checked out in worktree `<name>`", where `<name>` is the worktree folder's name.
- **Canonical path** means `std::fs::canonicalize`, with the `\\?\` prefix stripped and no trailing separator (the root keeps its separator). The frontend never compares raw paths it did not receive from the backend.

---

# Backend lane (`src-tauri/`), tasks B1–B5, run in order

### Task B1: Canonical paths and the `open_repo` return shape

**Files:**
- Modify: `src-tauri/src/repo/mod.rs` (add `canonical_path`, `canonical_string`, `main_worktree_path`, `ensure_present`; canonicalize values in `other_worktree_heads`)
- Modify: `src-tauri/src/commands/repo.rs` (`open_repo` returns `OpenedRepo`)
- Modify: `src-tauri/src/error.rs` (add `RepoGone`)

**Interfaces:**
- Produces:
  - `crate::repo::canonical_path(p: &std::path::Path) -> std::path::PathBuf`
  - `crate::repo::canonical_string(p: &std::path::Path) -> String`
  - `crate::repo::main_worktree_path(repo: &git2::Repository) -> Option<String>`: the main worktree's canonical workdir when `repo` is a linked worktree and the main repo is not bare; otherwise `None`.
  - `crate::repo::ensure_present(repo: &git2::Repository) -> Result<()>`: `Err(Error::RepoGone(path))` if the git dir or workdir no longer exists.
  - `Error::RepoGone(String)`, displayed as `"repo gone: {0}"`.
  - `open_repo(path) -> Result<OpenedRepo>`, where `OpenedRepo { id: String, main_worktree_path: Option<String> }` and `id` is the canonical path string.
  - `RefInfo.worktree_path` values are now canonical strings.

- [ ] **Step 1: Write the failing tests** (append to the `tests` module in `src-tauri/src/repo/mod.rs`; create `#[cfg(test)] mod tests` there if absent):

```rust
#[cfg(test)]
mod canonical_tests {
    use super::*;
    use super::test_support::{add_worktree, make_repo_with_commit, make_temp_dir};

    #[test]
    fn canonical_path_strips_verbatim_prefix_and_trailing_separator() {
        let dir = make_temp_dir("canon");
        let with_slash = format!("{}/", dir.display());
        let a = canonical_path(std::path::Path::new(&with_slash));
        let b = canonical_path(&dir);
        assert_eq!(a, b, "trailing separator must not change identity");
        let s = a.to_string_lossy();
        assert!(!s.starts_with(r"\\?\"), "verbatim prefix must be stripped: {s}");
        assert!(!s.ends_with('/') && !s.ends_with('\\'), "no trailing separator: {s}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn canonical_path_matches_forward_slash_spelling() {
        let dir = make_temp_dir("canon_fwd");
        let fwd = dir.display().to_string().replace('\\', "/");
        assert_eq!(canonical_path(std::path::Path::new(&fwd)), canonical_path(&dir));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn main_worktree_path_is_set_only_for_linked_worktrees() {
        let (main_dir, main) = make_repo_with_commit();
        let (wt_dir, wt) = add_worktree(&main, "mwp", "feat");
        assert_eq!(main_worktree_path(&main), None);
        assert_eq!(main_worktree_path(&wt), Some(canonical_string(&main_dir)));
        let _ = std::fs::remove_dir_all(wt_dir);
        let _ = std::fs::remove_dir_all(main_dir);
    }

    #[test]
    fn ensure_present_reports_repo_gone_after_worktree_folder_deleted() {
        let (main_dir, main) = make_repo_with_commit();
        let (wt_dir, wt) = add_worktree(&main, "gone", "feat");
        assert!(ensure_present(&wt).is_ok());
        std::fs::remove_dir_all(&wt_dir).unwrap();
        let err = ensure_present(&wt).unwrap_err();
        assert!(err.to_string().starts_with("repo gone:"), "got: {err}");
        let _ = std::fs::remove_dir_all(main_dir);
    }

    #[test]
    fn other_worktree_heads_values_are_canonical() {
        let (main_dir, main) = make_repo_with_commit();
        let (wt_dir, _wt) = add_worktree(&main, "canonval", "feat");
        let heads = other_worktree_heads(&main);
        assert_eq!(heads.get("refs/heads/feat"), Some(&canonical_path(&wt_dir)));
        let _ = std::fs::remove_dir_all(wt_dir);
        let _ = std::fs::remove_dir_all(main_dir);
    }
}
```

- [ ] **Step 2: Run them and verify they fail**
Run: `cd E:\waypoint\src-tauri && cargo test canonical_tests`
Expected: compile errors: `canonical_path`, `main_worktree_path`, `ensure_present` and `Error::RepoGone` are not defined.

- [ ] **Step 3: Implement.** In `error.rs`, add a variant:

```rust
    #[error("repo gone: {0}")]
    RepoGone(String),
```

In `repo/mod.rs`:

```rust
use std::path::Path;

/// Stable identity for a folder: canonicalized, Windows verbatim prefix stripped,
/// no trailing separator (a bare root keeps its separator). git2 reports worktree
/// paths as `E:/x/` while the folder picker yields `E:\x` — both map to one value.
pub(crate) fn canonical_path(p: &Path) -> PathBuf {
    let c = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let s = c.to_string_lossy().into_owned();
    let s = if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_owned()
    } else {
        s
    };
    let trimmed = s.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() || trimmed.ends_with(':') {
        PathBuf::from(s) // "/" or "C:\" — keep the root separator
    } else {
        PathBuf::from(trimmed)
    }
}

pub(crate) fn canonical_string(p: &Path) -> String {
    canonical_path(p).to_string_lossy().into_owned()
}

/// For a linked worktree, the main worktree's canonical workdir (None when the
/// main repo is bare, or when `repo` is itself the main worktree).
pub(crate) fn main_worktree_path(repo: &git2::Repository) -> Option<String> {
    if !repo.is_worktree() {
        return None;
    }
    let main = git2::Repository::open(repo.commondir()).ok()?;
    if main.is_bare() {
        return None;
    }
    main.workdir().map(canonical_string)
}

/// `Err(RepoGone)` when this repo's git dir or working directory has been deleted
/// (e.g. an agent removed the worktree while its tab was open).
pub(crate) fn ensure_present(repo: &git2::Repository) -> Result<()> {
    let workdir_gone = repo.workdir().is_some_and(|w| !w.exists());
    if !repo.path().exists() || workdir_gone {
        let shown = repo.workdir().unwrap_or_else(|| repo.path());
        return Err(Error::RepoGone(shown.display().to_string()));
    }
    Ok(())
}
```

In `other_worktree_heads`, change the insert to `result.insert(target.to_owned(), canonical_path(wd));`.

In `commands/repo.rs`, add:

```rust
#[derive(Debug, Serialize)]
pub struct OpenedRepo {
    /// Canonical working-directory path; also the tab id and RepoState key.
    pub id: String,
    /// Set when the opened folder is a linked worktree (non-bare main repo).
    pub main_worktree_path: Option<String>,
}
```

Then change `open_repo` to return `Result<OpenedRepo>`:
- keep the `is_dir` check on the raw `path`;
- then `let canon = crate::repo::canonical_string(Path::new(&path));` and open with `git2::Repository::open(&canon)` (keep `NotARepo(path.clone())` on failure);
- `let main_worktree_path = crate::repo::main_worktree_path(&repo);` before the move;
- `let id = canon.clone();` everything else unchanged;
- return `Ok(OpenedRepo { id, main_worktree_path })`.

Keep `list_refs_impl` as it is: it already calls `.display().to_string()` on the now-canonical path.

- [ ] **Step 4: Run all tests and verify they pass**
Run: `cd E:\waypoint\src-tauri && cargo test`
Expected: every test passes, including the 5 new ones (69+ total), with no warnings.

- [ ] **Step 5: Do NOT commit.**

---

### Task B2: `list_worktrees` and `worktree_status`

**Files:**
- Create: `src-tauri/src/commands/worktrees.rs`
- Modify: `src-tauri/src/commands/mod.rs` (add `pub mod worktrees;`)
- Modify: `src-tauri/src/lib.rs` (register `commands::worktrees::list_worktrees` and `commands::worktrees::worktree_status` in `generate_handler!`)

**Interfaces:**
- Consumes: `canonical_path`, `canonical_string`, `Error::RepoGone` from B1.
- Produces:

```rust
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct WorktreeInfo {
    pub path: String, pub name: String, pub is_main: bool, pub is_current: bool,
    pub branch: Option<String>, pub head_oid: Option<String>, pub is_detached: bool,
    pub is_locked: bool, pub lock_reason: Option<String>, pub is_missing: bool,
    pub branch_merged: bool,
}
pub(crate) fn list_worktrees_impl(repo: &git2::Repository) -> Result<Vec<WorktreeInfo>>
#[tauri::command] pub fn list_worktrees(repo_id: String, state: State<RepoState>) -> Result<Vec<WorktreeInfo>>

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct WorktreeStatus { pub changed: usize, pub conflicted: bool }
pub(crate) fn worktree_status_impl(path: &std::path::Path) -> Result<WorktreeStatus>
#[tauri::command] pub async fn worktree_status(path: String) -> Result<WorktreeStatus>
```

- [ ] **Step 1: Write the failing tests** (a `#[cfg(test)] mod tests` at the bottom of `worktrees.rs`):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::test_support::{add_worktree, make_repo_with_commit};
    use crate::repo::canonical_string;

    fn by_name<'a>(v: &'a [WorktreeInfo], name_contains: &str) -> &'a WorktreeInfo {
        v.iter().find(|w| w.path.contains(name_contains)).expect("worktree listed")
    }

    #[test]
    fn lists_main_first_then_linked_with_current_flag() {
        let (main_dir, main) = make_repo_with_commit();
        let (wt_dir, wt) = add_worktree(&main, "lw1", "feat");
        let from_main = list_worktrees_impl(&main).unwrap();
        assert_eq!(from_main.len(), 2);
        assert!(from_main[0].is_main && from_main[0].is_current);
        assert_eq!(from_main[0].path, canonical_string(&main_dir));
        let linked = &from_main[1];
        assert!(!linked.is_main && !linked.is_current);
        assert_eq!(linked.path, canonical_string(&wt_dir));
        assert_eq!(linked.branch.as_deref(), Some("feat"));
        assert!(!linked.is_detached && !linked.is_missing && !linked.is_locked);

        let from_wt = list_worktrees_impl(&wt).unwrap();
        assert!(from_wt[0].is_main && !from_wt[0].is_current);
        assert!(by_name(&from_wt, "lw1").is_current);
        let _ = std::fs::remove_dir_all(wt_dir);
        let _ = std::fs::remove_dir_all(main_dir);
    }

    #[test]
    fn detached_worktree_reports_short_state() {
        let (main_dir, main) = make_repo_with_commit();
        let (wt_dir, wt) = add_worktree(&main, "det", "feat");
        let oid = wt.head().unwrap().target().unwrap();
        wt.set_head_detached(oid).unwrap();
        let list = list_worktrees_impl(&main).unwrap();
        let w = by_name(&list, "det");
        assert!(w.is_detached);
        assert_eq!(w.branch, None);
        assert_eq!(w.head_oid.as_deref(), Some(oid.to_string().as_str()));
        let _ = std::fs::remove_dir_all(wt_dir);
        let _ = std::fs::remove_dir_all(main_dir);
    }

    #[test]
    fn locked_worktree_reports_reason() {
        let (main_dir, main) = make_repo_with_commit();
        let (wt_dir, _wt) = add_worktree(&main, "lck", "feat");
        let name = main.worktrees().unwrap().iter().flatten().next().unwrap().to_owned();
        main.find_worktree(&name).unwrap().lock(Some("agent running")).unwrap();
        let list = list_worktrees_impl(&main).unwrap();
        let w = by_name(&list, "lck");
        assert!(w.is_locked);
        assert_eq!(w.lock_reason.as_deref(), Some("agent running"));
        let _ = std::fs::remove_dir_all(wt_dir);
        let _ = std::fs::remove_dir_all(main_dir);
    }

    #[test]
    fn missing_worktree_folder_is_flagged_not_fatal() {
        let (main_dir, main) = make_repo_with_commit();
        let (wt_dir, _wt) = add_worktree(&main, "miss", "feat");
        let expected_path = canonical_string(&wt_dir);
        std::fs::remove_dir_all(&wt_dir).unwrap();
        let list = list_worktrees_impl(&main).unwrap();
        let w = list.iter().find(|w| !w.is_main).unwrap();
        assert!(w.is_missing);
        assert!(w.path.ends_with(expected_path.rsplit(['/', '\\']).next().unwrap()));
        let _ = std::fs::remove_dir_all(main_dir);
    }

    #[test]
    fn bare_main_repo_is_omitted() {
        let (src_dir, _src) = make_repo_with_commit();
        let bare_dir = crate::repo::test_support::make_temp_dir("bare");
        let bare = git2::build::RepoBuilder::new()
            .bare(true)
            .clone(&src_dir.to_string_lossy(), &bare_dir.join("b.git"))
            .unwrap();
        let (wt_dir, wt) = add_worktree(&bare, "frombare", "feat");
        let list = list_worktrees_impl(&wt).unwrap();
        assert!(list.iter().all(|w| !w.is_main), "bare main must not be listed");
        assert_eq!(list.len(), 1);
        let _ = std::fs::remove_dir_all(wt_dir);
        let _ = std::fs::remove_dir_all(bare_dir);
        let _ = std::fs::remove_dir_all(src_dir);
    }

    #[test]
    fn branch_merged_true_only_when_tip_reachable_from_current_head() {
        let (main_dir, main) = make_repo_with_commit();
        let (wt_dir, wt) = add_worktree(&main, "mrg", "feat");
        // feat == main HEAD → merged
        assert!(by_name(&list_worktrees_impl(&main).unwrap(), "mrg").branch_merged);
        // commit on feat in the worktree → not merged into main
        std::fs::write(wt_dir.join("n.txt"), "x").unwrap();
        let mut idx = wt.index().unwrap();
        idx.add_path(std::path::Path::new("n.txt")).unwrap();
        idx.write().unwrap();
        let tree = wt.find_tree(idx.write_tree().unwrap()).unwrap();
        let sig = wt.signature().unwrap();
        let parent = wt.head().unwrap().peel_to_commit().unwrap();
        wt.commit(Some("HEAD"), &sig, &sig, "feat work", &tree, &[&parent]).unwrap();
        assert!(!by_name(&list_worktrees_impl(&main).unwrap(), "mrg").branch_merged);
        let _ = std::fs::remove_dir_all(wt_dir);
        let _ = std::fs::remove_dir_all(main_dir);
    }

    #[test]
    fn worktree_status_counts_staged_unstaged_untracked() {
        let (main_dir, main) = make_repo_with_commit();
        let (wt_dir, wt) = add_worktree(&main, "st", "feat");
        assert_eq!(worktree_status_impl(&wt_dir).unwrap(), WorktreeStatus { changed: 0, conflicted: false });
        std::fs::write(wt_dir.join("a.txt"), "changed").unwrap(); // unstaged
        std::fs::write(wt_dir.join("new.txt"), "new").unwrap();   // untracked
        std::fs::write(wt_dir.join("staged.txt"), "s").unwrap();
        let mut idx = wt.index().unwrap();
        idx.add_path(std::path::Path::new("staged.txt")).unwrap();
        idx.write().unwrap();
        assert_eq!(worktree_status_impl(&wt_dir).unwrap().changed, 3);
        let _ = std::fs::remove_dir_all(wt_dir);
        let _ = std::fs::remove_dir_all(main_dir);
    }

    #[test]
    fn worktree_status_on_missing_folder_is_repo_gone() {
        let (main_dir, main) = make_repo_with_commit();
        let (wt_dir, _wt) = add_worktree(&main, "stgone", "feat");
        std::fs::remove_dir_all(&wt_dir).unwrap();
        let err = worktree_status_impl(&wt_dir).unwrap_err();
        assert!(err.to_string().starts_with("repo gone:"), "got {err}");
        let _ = std::fs::remove_dir_all(main_dir);
    }
}
```

If `add_worktree` cannot take a bare repo (it uses `main.workdir().unwrap()` to pick a parent folder), make the parent fall back to `main.path().parent()` when `workdir()` is `None`. That is a test-support change only.

- [ ] **Step 2: Run them and verify they fail**
Run: `cargo test commands::worktrees`
Expected: compile error, because the module and functions don't exist yet.

- [ ] **Step 3: Implement** `src-tauri/src/commands/worktrees.rs`:

```rust
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::error::{Error, Result};
use crate::repo::{canonical_path, canonical_string, RepoState};

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct WorktreeInfo {
    pub path: String,
    pub name: String,
    pub is_main: bool,
    pub is_current: bool,
    pub branch: Option<String>,
    pub head_oid: Option<String>,
    pub is_detached: bool,
    pub is_locked: bool,
    pub lock_reason: Option<String>,
    pub is_missing: bool,
    pub branch_merged: bool,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct WorktreeStatus {
    pub changed: usize,
    pub conflicted: bool,
}

struct HeadState {
    branch: Option<String>,
    oid: Option<git2::Oid>,
    detached: bool,
}

fn head_state(r: &git2::Repository) -> HeadState {
    let oid = r.head().ok().and_then(|h| h.target());
    match r.find_reference("HEAD") {
        Ok(h) => match h.symbolic_target() {
            Some(t) => HeadState {
                branch: Some(t.strip_prefix("refs/heads/").unwrap_or(t).to_owned()),
                oid,
                detached: false,
            },
            None => HeadState { branch: None, oid, detached: true },
        },
        Err(_) => HeadState { branch: None, oid: None, detached: false },
    }
}

fn folder_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.display().to_string())
}

/// Branch tip reachable from `current_head` (equal counts): safe to delete after removal.
fn is_merged(repo: &git2::Repository, current_head: Option<git2::Oid>, tip: Option<git2::Oid>) -> bool {
    match (current_head, tip) {
        (Some(h), Some(t)) => h == t || repo.graph_descendant_of(h, t).unwrap_or(false),
        _ => false,
    }
}

pub(crate) fn list_worktrees_impl(repo: &git2::Repository) -> Result<Vec<WorktreeInfo>> {
    let current_workdir = repo.workdir().map(canonical_path);
    let current_head = repo.head().ok().and_then(|h| h.target());
    let mut out: Vec<WorktreeInfo> = Vec::new();

    // Main worktree: `repo` itself, or the repo at commondir when `repo` is linked.
    let main_owned;
    let main: Option<&git2::Repository> = if repo.is_worktree() {
        main_owned = git2::Repository::open(repo.commondir()).ok();
        main_owned.as_ref()
    } else {
        Some(repo)
    };
    if let Some(m) = main.filter(|m| !m.is_bare()) {
        if let Some(wd) = m.workdir() {
            let path = canonical_path(wd);
            let h = head_state(m);
            let is_current = current_workdir.as_ref() == Some(&path);
            out.push(WorktreeInfo {
                name: folder_name(&path),
                path: path.to_string_lossy().into_owned(),
                is_main: true,
                is_current,
                branch_merged: !is_current && h.branch.is_some() && is_merged(repo, current_head, h.oid),
                branch: h.branch,
                head_oid: h.oid.map(|o| o.to_string()),
                is_detached: h.detached,
                is_locked: false,
                lock_reason: None,
                is_missing: false,
            });
        }
    }

    let mut linked: Vec<WorktreeInfo> = Vec::new();
    for name in repo.worktrees()?.iter().flatten() {
        let Ok(wt) = repo.find_worktree(name) else { continue };
        let path = canonical_path(wt.path());
        let (is_locked, lock_reason) = match wt.is_locked() {
            Ok(git2::WorktreeLockStatus::Locked(reason)) => (true, reason),
            _ => (false, None),
        };
        let is_missing = wt.validate().is_err();
        let h = if is_missing {
            HeadState { branch: None, oid: None, detached: false }
        } else {
            git2::Repository::open_from_worktree(&wt)
                .map(|r| head_state(&r))
                .unwrap_or(HeadState { branch: None, oid: None, detached: false })
        };
        let is_current = current_workdir.as_ref() == Some(&path);
        linked.push(WorktreeInfo {
            name: folder_name(&path),
            path: path.to_string_lossy().into_owned(),
            is_main: false,
            is_current,
            branch_merged: !is_current && h.branch.is_some() && is_merged(repo, current_head, h.oid),
            branch: h.branch,
            head_oid: h.oid.map(|o| o.to_string()),
            is_detached: h.detached,
            is_locked,
            lock_reason,
            is_missing,
        });
    }
    linked.sort_by_key(|w| w.name.to_lowercase());
    out.extend(linked);
    Ok(out)
}

#[tauri::command]
pub fn list_worktrees(repo_id: String, state: State<RepoState>) -> Result<Vec<WorktreeInfo>> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
    list_worktrees_impl(repo)
}

/// Opens its OWN handle: never touches RepoState, so a slow scan can't stall other commands.
pub(crate) fn worktree_status_impl(path: &Path) -> Result<WorktreeStatus> {
    if !path.exists() {
        return Err(Error::RepoGone(path.display().to_string()));
    }
    let repo = git2::Repository::open(path)?;
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(false)
        .include_ignored(false)
        .exclude_submodules(true);
    let statuses = repo.statuses(Some(&mut opts))?;
    let changed = statuses.iter().filter(|e| e.status() != git2::Status::CURRENT).count();
    let conflicted = statuses.iter().any(|e| e.status().contains(git2::Status::CONFLICTED));
    Ok(WorktreeStatus { changed, conflicted })
}

#[tauri::command]
pub async fn worktree_status(path: String) -> Result<WorktreeStatus> {
    tauri::async_runtime::spawn_blocking(move || worktree_status_impl(&PathBuf::from(path)))
        .await
        .map_err(|e| Error::InvalidArg(e.to_string()))?
}
```

Add `pub mod worktrees;` to `commands/mod.rs`, and register both commands in `lib.rs` next to `commands::repo::list_refs`. If the compiler reports `canonical_string` as unused in this file, drop it from the `use` line.

- [ ] **Step 4: Run all tests and verify they pass**
Run: `cargo test`
Expected: all pass, with no warnings.

- [ ] **Step 5: Do NOT commit.**

---

### Task B3: `remove_worktree` and `prune_worktrees`

**Files:**
- Modify: `src-tauri/src/commands/worktrees.rs`
- Modify: `src-tauri/src/lib.rs` (register both commands)

**Interfaces:**
- Consumes: `list_worktrees_impl`, `worktree_status_impl` from B2; `crate::repo::workdir` (existing); `canonical_path` from B1.
- Produces:

```rust
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct RemoveResult { pub branch_deleted: bool, pub branch_kept_reason: Option<String> }
pub(crate) fn run_git_blocking(dir: &Path, args: &[&str]) -> Result<()>
pub(crate) fn remove_worktree_blocking(
    repos: &std::sync::Mutex<std::collections::HashMap<String, git2::Repository>>,
    repo_id: &str, path: &str, force: bool, delete_branch: bool,
) -> Result<RemoveResult>
#[tauri::command] pub async fn remove_worktree(app: tauri::AppHandle, repo_id: String, path: String, force: bool, delete_branch: bool) -> Result<RemoveResult>
#[tauri::command] pub async fn prune_worktrees(app: tauri::AppHandle, repo_id: String) -> Result<()>
```

Error strings (the frontend shows them verbatim):
- main worktree: `"The main worktree can't be removed."`
- current worktree: `"This tab has '<name>' open. Remove it from another worktree's tab."`
- locked: `"'<name>' is locked (<reason>). Unlock it in a terminal: git worktree unlock <path>"`; when there is no reason, drop the parenthesis.
- missing: `"'<name>' no longer exists on disk. Use Prune missing instead."`
- dirty without force: `"'<name>' has <n> uncommitted change(s). Remove anyway to discard them."`
- unknown path: `"Not a worktree of this repository: <path>"`
- kept branch reason: `"Kept '<branch>': not merged into the current branch."`

- [ ] **Step 1: Write the failing tests** (add to `worktrees.rs` tests; they need the `git` binary on PATH, which the app already requires):

```rust
    fn state_with(repo_id: &str, repo: git2::Repository)
        -> std::sync::Mutex<std::collections::HashMap<String, git2::Repository>> {
        let mut m = std::collections::HashMap::new();
        m.insert(repo_id.to_owned(), repo);
        std::sync::Mutex::new(m)
    }

    #[test]
    fn remove_refuses_main_and_current() {
        let (main_dir, main) = make_repo_with_commit();
        let main_path = canonical_string(&main_dir);
        let st = state_with("m", main);
        let err = remove_worktree_blocking(&st, "m", &main_path, false, false).unwrap_err();
        assert!(err.to_string().contains("main worktree"), "{err}");
        let _ = std::fs::remove_dir_all(main_dir);
    }

    #[test]
    fn remove_refuses_dirty_without_force_then_force_removes() {
        let (main_dir, main) = make_repo_with_commit();
        let (wt_dir, _wt) = add_worktree(&main, "rmdirty", "feat");
        std::fs::write(wt_dir.join("wip.txt"), "wip").unwrap();
        let st = state_with("m", main);
        let p = canonical_string(&wt_dir);
        let err = remove_worktree_blocking(&st, "m", &p, false, false).unwrap_err();
        assert!(err.to_string().contains("uncommitted"), "{err}");
        assert!(wt_dir.exists());
        remove_worktree_blocking(&st, "m", &p, true, false).unwrap();
        assert!(!wt_dir.exists());
        let _ = std::fs::remove_dir_all(main_dir);
    }

    #[test]
    fn remove_refuses_locked_with_reason() {
        let (main_dir, main) = make_repo_with_commit();
        let (wt_dir, _wt) = add_worktree(&main, "rmlock", "feat");
        let name = main.worktrees().unwrap().iter().flatten().next().unwrap().to_owned();
        main.find_worktree(&name).unwrap().lock(Some("agent running")).unwrap();
        let st = state_with("m", main);
        let err = remove_worktree_blocking(&st, "m", &canonical_string(&wt_dir), true, false).unwrap_err();
        assert!(err.to_string().contains("locked (agent running)"), "{err}");
        assert!(wt_dir.exists());
        let _ = std::fs::remove_dir_all(wt_dir);
        let _ = std::fs::remove_dir_all(main_dir);
    }

    #[test]
    fn remove_with_delete_branch_deletes_only_merged() {
        // merged: feat == main HEAD
        let (main_dir, main) = make_repo_with_commit();
        let (wt_dir, _wt) = add_worktree(&main, "rmmerged", "feat");
        let st = state_with("m", main);
        let r = remove_worktree_blocking(&st, "m", &canonical_string(&wt_dir), false, true).unwrap();
        assert!(r.branch_deleted);
        assert!(st.lock().unwrap()["m"].find_branch("feat", git2::BranchType::Local).is_err());
        let _ = std::fs::remove_dir_all(main_dir);

        // unmerged: commit on feat2 first
        let (main_dir, main) = make_repo_with_commit();
        let (wt_dir, wt) = add_worktree(&main, "rmunmerged", "feat2");
        std::fs::write(wt_dir.join("n.txt"), "x").unwrap();
        let mut idx = wt.index().unwrap();
        idx.add_path(std::path::Path::new("n.txt")).unwrap();
        idx.write().unwrap();
        let tree = wt.find_tree(idx.write_tree().unwrap()).unwrap();
        let sig = wt.signature().unwrap();
        let parent = wt.head().unwrap().peel_to_commit().unwrap();
        wt.commit(Some("HEAD"), &sig, &sig, "w", &tree, &[&parent]).unwrap();
        drop(wt);
        let st = state_with("m", main);
        let r = remove_worktree_blocking(&st, "m", &canonical_string(&wt_dir), false, true).unwrap();
        assert!(!r.branch_deleted);
        assert!(r.branch_kept_reason.unwrap().contains("not merged"));
        assert!(st.lock().unwrap()["m"].find_branch("feat2", git2::BranchType::Local).is_ok());
        let _ = std::fs::remove_dir_all(main_dir);
    }

    #[test]
    fn remove_refuses_missing_folder() {
        let (main_dir, main) = make_repo_with_commit();
        let (wt_dir, _wt) = add_worktree(&main, "rmmiss", "feat");
        let p = canonical_string(&wt_dir);
        std::fs::remove_dir_all(&wt_dir).unwrap();
        let st = state_with("m", main);
        let err = remove_worktree_blocking(&st, "m", &p, false, false).unwrap_err();
        assert!(err.to_string().contains("Prune missing"), "{err}");
        let _ = std::fs::remove_dir_all(main_dir);
    }
```

Note on `canonical_string` for a missing folder: `canonicalize` fails, so `canonical_path` falls back to the raw path. Compare missing worktrees on both sides via `canonical_path` of the path string the caller passes, and accept a match on either the exact string or the file name within this repo's worktree list.

- [ ] **Step 2: Run them and verify they fail**
Run: `cargo test remove_`
Expected: compile error, because `remove_worktree_blocking` is not defined.

- [ ] **Step 3: Implement** (append to `worktrees.rs`):

```rust
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct RemoveResult {
    pub branch_deleted: bool,
    pub branch_kept_reason: Option<String>,
}

/// Blocking git CLI call (same credential/safety behaviour as the terminal).
pub(crate) fn run_git_blocking(dir: &Path, args: &[&str]) -> Result<()> {
    let mut cmd = std::process::Command::new("git");
    cmd.current_dir(dir).args(args);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().map_err(|e| Error::InvalidArg(format!("failed to run git: {e}")))?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let msg = if stderr.trim().is_empty() { String::from_utf8_lossy(&out.stdout) } else { stderr };
    Err(Error::InvalidArg(msg.trim().to_string()))
}

struct RemovalPlan {
    run_dir: PathBuf,
    target: String,
    branch: Option<String>,
}

fn plan_removal(repo: &git2::Repository, path: &str, force: bool) -> Result<RemovalPlan> {
    let wanted = canonical_path(Path::new(path));
    let list = list_worktrees_impl(repo)?;
    let entry = list
        .iter()
        .find(|w| Path::new(&w.path) == wanted.as_path())
        .or_else(|| {
            // A missing folder can't be canonicalized; fall back to the folder name.
            let name = wanted.file_name()?.to_string_lossy().into_owned();
            list.iter().find(|w| w.is_missing && w.name == name)
        })
        .ok_or_else(|| Error::InvalidArg(format!("Not a worktree of this repository: {path}")))?;

    if entry.is_main {
        return Err(Error::InvalidArg("The main worktree can't be removed.".into()));
    }
    if entry.is_current {
        return Err(Error::InvalidArg(format!(
            "This tab has '{}' open. Remove it from another worktree's tab.", entry.name
        )));
    }
    if entry.is_missing {
        return Err(Error::InvalidArg(format!(
            "'{}' no longer exists on disk. Use Prune missing instead.", entry.name
        )));
    }
    if entry.is_locked {
        let why = entry.lock_reason.as_deref().map(|r| format!(" ({r})")).unwrap_or_default();
        return Err(Error::InvalidArg(format!(
            "'{}' is locked{why}. Unlock it in a terminal: git worktree unlock {}", entry.name, entry.path
        )));
    }
    if !force {
        let st = worktree_status_impl(Path::new(&entry.path))?;
        if st.changed > 0 {
            return Err(Error::InvalidArg(format!(
                "'{}' has {} uncommitted change(s). Remove anyway to discard them.", entry.name, st.changed
            )));
        }
    }
    Ok(RemovalPlan {
        run_dir: crate::repo::workdir(repo)?,
        target: entry.path.clone(),
        branch: entry.branch.clone(),
    })
}

fn delete_branch_if_merged(repo: &git2::Repository, branch: &str) -> Result<RemoveResult> {
    let mut b = repo.find_branch(branch, git2::BranchType::Local)?;
    let tip = b.get().target();
    let head = repo.head().ok().and_then(|h| h.target());
    if is_merged(repo, head, tip) {
        b.delete()?;
        Ok(RemoveResult { branch_deleted: true, branch_kept_reason: None })
    } else {
        Ok(RemoveResult {
            branch_deleted: false,
            branch_kept_reason: Some(format!("Kept '{branch}': not merged into the current branch.")),
        })
    }
}

/// Lock → plan → UNLOCK → `git worktree remove` → lock → optional branch delete.
/// The shared lock is never held while git deletes files (can take seconds).
pub(crate) fn remove_worktree_blocking(
    repos: &std::sync::Mutex<std::collections::HashMap<String, git2::Repository>>,
    repo_id: &str,
    path: &str,
    force: bool,
    delete_branch: bool,
) -> Result<RemoveResult> {
    let plan = {
        let guard = repos.lock().unwrap();
        let repo = guard.get(repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.to_owned()))?;
        plan_removal(repo, path, force)?
    };
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&plan.target);
    run_git_blocking(&plan.run_dir, &args)?;

    if let (true, Some(branch)) = (delete_branch, plan.branch.as_deref()) {
        let guard = repos.lock().unwrap();
        let repo = guard.get(repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.to_owned()))?;
        return delete_branch_if_merged(repo, branch);
    }
    Ok(RemoveResult { branch_deleted: false, branch_kept_reason: None })
}

#[tauri::command]
pub async fn remove_worktree(
    app: tauri::AppHandle,
    repo_id: String,
    path: String,
    force: bool,
    delete_branch: bool,
) -> Result<RemoveResult> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<RepoState>();
        remove_worktree_blocking(&state.0, &repo_id, &path, force, delete_branch)
    })
    .await
    .map_err(|e| Error::InvalidArg(e.to_string()))?
}

#[tauri::command]
pub async fn prune_worktrees(app: tauri::AppHandle, repo_id: String) -> Result<()> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<RepoState>();
        let dir = {
            let guard = state.0.lock().unwrap();
            let repo = guard.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
            crate::repo::workdir(repo)?
        };
        run_git_blocking(&dir, &["worktree", "prune"])
    })
    .await
    .map_err(|e| Error::InvalidArg(e.to_string()))?
}
```

Register `commands::worktrees::remove_worktree` and `commands::worktrees::prune_worktrees` in `lib.rs`.

Add one more test, `prune_drops_missing_worktree`: remove a worktree folder from disk, then call `run_git_blocking(&main_dir, &["worktree", "prune"])`. `list_worktrees_impl` must then list only the main worktree.

- [ ] **Step 4: Run all tests and verify they pass**
Run: `cargo test`
Expected: all pass, with no warnings.

- [ ] **Step 5: Do NOT commit.**

---

### Task B4: `discard_all` never deletes nested repos or worktrees

**Files:**
- Modify: `src-tauri/src/commands/staging.rs` (`discard_all_in`, the WT_NEW loop at ~385–396, plus tests)

**Interfaces:** none new. The behaviour change is internal to `discard_all_in(repo: &git2::Repository) -> Result<()>`.

- [ ] **Step 1: Write the failing test** (in `staging.rs` tests):

```rust
    #[test]
    fn discard_all_never_deletes_a_nested_worktree() {
        let (main_dir, main) = crate::repo::test_support::make_repo_with_commit();
        // Agent-style nested worktree that is NOT gitignored.
        std::fs::create_dir_all(main_dir.join(".worktrees")).unwrap();
        let nested = main_dir.join(".worktrees").join("agent");
        let head = main.head().unwrap().peel_to_commit().unwrap();
        let branch = main.branch("agent", &head, false).unwrap();
        let mut opts = git2::WorktreeAddOptions::new();
        opts.reference(Some(branch.get()));
        main.worktree("agent", &nested, Some(&opts)).unwrap();
        std::fs::write(nested.join("agent-wip.txt"), "uncommitted agent work").unwrap();
        // Also a plain untracked dir that SHOULD still be cleaned.
        std::fs::create_dir_all(main_dir.join("junk")).unwrap();
        std::fs::write(main_dir.join("junk").join("x.txt"), "x").unwrap();

        discard_all_in(&main).unwrap();

        assert!(nested.join("agent-wip.txt").exists(), "nested worktree must survive");
        assert!(!main_dir.join("junk").exists(), "ordinary untracked dirs are still removed");
        let _ = std::fs::remove_dir_all(main_dir);
    }
```

- [ ] **Step 2: Run it and verify it fails**
Run: `cargo test discard_all_never_deletes_a_nested_worktree`
Expected: FAIL on `nested worktree must survive`. If it PASSES instead, libgit2 doesn't report the nested worktree as untracked. Record that finding, keep the test and the guard below anyway (it's defense in depth), and say so in your report.

- [ ] **Step 3: Implement.** In the WT_NEW loop, before deleting:

```rust
                    let full = workdir.join(path);
                    // Never delete a nested repository or worktree (agents create
                    // them inside the repo, e.g. .worktrees/x): its `.git` entry
                    // (dir or file) marks someone else's working tree.
                    if full.join(".git").exists() || contains_git_entry(&full) {
                        continue;
                    }
```

Add this helper. `.worktrees/` itself is reported as a single untracked directory whose *children* hold `.git` files:

```rust
/// True if `dir` or any directory up to 3 levels below it contains a `.git` entry.
fn contains_git_entry(dir: &std::path::Path) -> bool {
    fn walk(d: &std::path::Path, depth: usize) -> bool {
        if d.join(".git").exists() { return true; }
        if depth == 0 { return false; }
        let Ok(rd) = std::fs::read_dir(d) else { return false };
        rd.flatten().any(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false) && walk(&e.path(), depth - 1))
    }
    dir.is_dir() && walk(dir, 3)
}
```

- [ ] **Step 4: Run all tests and verify they pass**
Run: `cargo test`
Expected: all pass. The existing `discard_all_*` tests stay green.

- [ ] **Step 5: Do NOT commit.**

---

### Task B5: Stash origin branch and `repo_gone` from repo status

**Files:**
- Modify: `src-tauri/src/commands/stash.rs` (`StashEntry.branch`, `parse_stash_branch`)
- Modify: `src-tauri/src/commands/actions.rs` (`get_repo_status` calls `ensure_present` first)

**Interfaces:**
- Consumes: `crate::repo::ensure_present` from B1.
- Produces: `StashEntry { index, message, oid, branch: Option<String> }` and `pub(crate) fn parse_stash_branch(message: &str) -> Option<String>`. `get_repo_status` returns `Err("repo gone: <path>")` when the folder is gone.

- [ ] **Step 1: Write the failing tests** (`stash.rs` tests; create the module if absent):

```rust
#[cfg(test)]
mod tests {
    use super::parse_stash_branch;

    #[test]
    fn parses_both_git_stash_message_formats() {
        assert_eq!(parse_stash_branch("WIP on main: abc1234 msg").as_deref(), Some("main"));
        assert_eq!(parse_stash_branch("On feat/x: my stash").as_deref(), Some("feat/x"));
        assert_eq!(parse_stash_branch("On master: WIP on master: 436fca2 docs").as_deref(), Some("master"));
        assert_eq!(parse_stash_branch("random text"), None);
        assert_eq!(parse_stash_branch("On : empty"), None);
    }
}
```

In `actions.rs` tests:

```rust
    #[test]
    fn repo_status_reports_repo_gone_when_worktree_deleted() {
        let (main_dir, main) = crate::repo::test_support::make_repo_with_commit();
        let (wt_dir, wt) = crate::repo::test_support::add_worktree(&main, "stgone2", "feat");
        std::fs::remove_dir_all(&wt_dir).unwrap();
        let err = repo_status_impl(&wt).unwrap_err();
        assert!(err.to_string().starts_with("repo gone:"), "{err}");
        let _ = std::fs::remove_dir_all(main_dir);
    }
```

For this test, extract the body of `get_repo_status` into `fn repo_status_impl(repo: &git2::Repository) -> Result<StatusInfo>`, following the file's existing `*_impl` pattern.

- [ ] **Step 2: Run them and verify they fail**
Run: `cargo test parses_both_git_stash_message_formats repo_status_reports_repo_gone`
Expected: compile errors, because `parse_stash_branch` and `repo_status_impl` don't exist.

- [ ] **Step 3: Implement**

```rust
/// Branch a stash was made on, from git's message: "WIP on <b>: …" or "On <b>: …".
pub(crate) fn parse_stash_branch(message: &str) -> Option<String> {
    let rest = message.strip_prefix("WIP on ").or_else(|| message.strip_prefix("On "))?;
    let branch = rest.split_once(':')?.0.trim();
    (!branch.is_empty()).then(|| branch.to_owned())
}
```

- Add `pub branch: Option<String>` to `StashEntry` and fill it in `list_stashes` with `branch: parse_stash_branch(message)`.
- In `actions.rs`, `repo_status_impl` starts with `crate::repo::ensure_present(repo)?;`, and `get_repo_status` delegates to it.

- [ ] **Step 4: Run all tests and verify they pass**
Run: `cargo test`, then `cargo build`.
Expected: all pass, and the build is clean with no warnings.

- [ ] **Step 5: Do NOT commit.** Report: tests added per task, observed red failures, final counts, and the B4 finding (whether libgit2 reported the nested worktree as untracked).

---

# Frontend lane (`src/`), tasks F1–F8, run in order

All frontend tests mock `@/lib/ipc`. The backend contract is exactly the Rust types above, serialized in snake_case.

### Task F1: IPC and query layer, `useOpenRepo`, recents, worktree open helper

**Files:**
- Modify: `src/lib/ipc.ts` (types and wrappers)
- Modify: `src/lib/queries.ts` (`useWorktrees`, `useWorktreeStatus`, `worktreeStatusInterval`, refresh keys)
- Modify: `src/lib/useOpenRepo.ts` (`OpenedRepo`, recents rule, `useOpenWorktree`, `isRepoGoneError`)
- Modify: `src/lib/store.ts` (`Tab.mainPath`; `openTab(id, path, mainPath?)`)
- Test: `src/lib/useOpenRepo.test.ts`, `src/lib/queries.test.ts` (create if absent), `src/lib/store.test.ts`

**Interfaces (produced, and used by F2–F8):**

```ts
// ipc.ts
export interface OpenedRepo { id: string; main_worktree_path: string | null }
export interface WorktreeInfo {
  path: string; name: string; is_main: boolean; is_current: boolean;
  branch: string | null; head_oid: string | null; is_detached: boolean;
  is_locked: boolean; lock_reason: string | null; is_missing: boolean; branch_merged: boolean;
}
export interface WorktreeStatus { changed: number; conflicted: boolean }
export interface RemoveResult { branch_deleted: boolean; branch_kept_reason: string | null }
// StashEntry gains: branch: string | null
ipc.openRepo(path): Promise<OpenedRepo>
ipc.listWorktrees(repoId): Promise<WorktreeInfo[]>          // invoke("list_worktrees", { repoId })
ipc.worktreeStatus(path): Promise<WorktreeStatus>           // invoke("worktree_status", { path })
ipc.removeWorktree(repoId, path, force, deleteBranch): Promise<RemoveResult>
                                                            // invoke("remove_worktree", { repoId, path, force, deleteBranch })
ipc.pruneWorktrees(repoId): Promise<void>                   // invoke("prune_worktrees", { repoId })

// queries.ts
useWorktrees(repoId: string | null)                         // key ["worktrees", repoId], staleTime Infinity
useWorktreeStatus(path: string | null, opts: { enabled: boolean })
                                                            // key ["worktree-status", path]
worktreeStatusInterval(lastScanMs: number): number          // Math.max(3000, 5 * lastScanMs)
// useRefreshRepo also invalidates ["worktrees", repoId] and ["worktree-status"]

// useOpenRepo.ts
isRepoGoneError(e: unknown): boolean                        // /^repo gone:/i or /folder does not exist/i
useOpenRepo(): (path: string) => Promise<string[]>          // unchanged signature
useOpenWorktree(repoId: string | null): (path: string) => Promise<void>

// store.ts
interface Tab { id: string; path: string; label: string; mainPath: string | null }
openTab(id: string, path: string, mainPath?: string | null): void
```

- [ ] **Step 1: Write the failing tests.** In `src/lib/useOpenRepo.test.ts` (extend the existing mocks of `@/lib/ipc`, `@/lib/recentRepos` and `sonner` as needed):

```ts
it("uses the canonical id from the backend as tab id and path", async () => {
  vi.mocked(ipc.openRepo).mockResolvedValue({ id: "E:\\repo", main_worktree_path: null });
  const { result } = renderHook(() => useOpenRepo());
  await act(() => result.current("E:/repo/"));
  const tab = useStore.getState().tabs.at(-1)!;
  expect(tab).toMatchObject({ id: "E:\\repo", path: "E:\\repo", mainPath: null });
  expect(addToRecentRepos).toHaveBeenCalledWith("E:\\repo");
});

it("records the MAIN repo in recents when opening a linked worktree", async () => {
  vi.mocked(ipc.openRepo).mockResolvedValue({ id: "E:\\repo-wt", main_worktree_path: "E:\\repo" });
  const { result } = renderHook(() => useOpenRepo());
  await act(() => result.current("E:\\repo-wt"));
  expect(addToRecentRepos).toHaveBeenCalledWith("E:\\repo");
  expect(useStore.getState().tabs.at(-1)!.mainPath).toBe("E:\\repo");
});

it("useOpenWorktree shows a prune toast when the folder is gone, never the init prompt", async () => {
  vi.mocked(ipc.openRepo).mockRejectedValue("invalid argument: folder does not exist: E:\\gone");
  const { result } = renderHook(() => useOpenWorktree("E:\\repo"));
  await act(() => result.current("E:\\gone"));
  expect(useStore.getState().initPromptPath).toBeNull();
  expect(toast.error).toHaveBeenCalledWith(
    "Worktree folder no longer exists",
    expect.objectContaining({ action: expect.objectContaining({ label: "Prune missing" }) }),
  );
});
```

In `src/lib/queries.test.ts`:

```ts
import { worktreeStatusInterval } from "./queries";
it("backs off to 5x the last scan, never below 3s", () => {
  expect(worktreeStatusInterval(0)).toBe(3000);
  expect(worktreeStatusInterval(400)).toBe(3000);
  expect(worktreeStatusInterval(1200)).toBe(6000);
});
```

In `src/lib/store.test.ts`: `openTab("a","a","m")` stores `mainPath: "m"`, and calling `openTab("a","a")` without a main path defaults it to `null`.

- [ ] **Step 2: Run them and verify they fail**
Run: `pnpm test run src/lib`
Expected: FAIL. `openRepo` returns a string, and `useOpenWorktree`, `worktreeStatusInterval` and `mainPath` are missing.

- [ ] **Step 3: Implement**
- `ipc.ts`: add the types; `openRepo: (path) => invoke<OpenedRepo>("open_repo", { path })`; the four new wrappers; `branch: string | null` on `StashEntry`.
- `store.ts`: `Tab.mainPath: string | null`. `openTab: (id, path, mainPath = null)` stores it on new tabs and leaves existing tabs untouched.
- `queries.ts`:

```ts
export function worktreeStatusInterval(lastScanMs: number): number {
  return Math.max(3000, 5 * lastScanMs);
}

export function useWorktrees(repoId: string | null) {
  return useQuery({
    queryKey: ["worktrees", repoId],
    queryFn: () => ipc.listWorktrees(repoId!),
    enabled: !!repoId,
    staleTime: Infinity,
  });
}

/** Live change count for one worktree; polls only while `enabled` (section open). */
export function useWorktreeStatus(path: string | null, opts: { enabled: boolean }) {
  const lastMs = useRef(0);
  return useQuery({
    queryKey: ["worktree-status", path],
    queryFn: async () => {
      const t0 = performance.now();
      try { return await ipc.worktreeStatus(path!); }
      finally { lastMs.current = performance.now() - t0; }
    },
    enabled: !!path && opts.enabled,
    refetchInterval: () => worktreeStatusInterval(lastMs.current),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  });
}
```

  Add `qc.invalidateQueries({ queryKey: ["worktrees", repoId] }); qc.invalidateQueries({ queryKey: ["worktree-status"] });` to `useRefreshRepo`. Import `useRef` from `react`.
- `useOpenRepo.ts`:

```ts
export function isRepoGoneError(e: unknown): boolean {
  return /repo gone:|folder does not exist/i.test(String(e));
}

// inside useOpenRepo's callback:
const { id, main_worktree_path } = await ipc.openRepo(path);
const updated = await addToRecentRepos(main_worktree_path ?? id);
openTab(id, id, main_worktree_path);
return updated;

/** Open a worktree in its own tab (activates it if open). Never shows the init prompt. */
export function useOpenWorktree(repoId: string | null) {
  const openTab = useStore((s) => s.openTab);
  return useCallback(async (path: string) => {
    try {
      const { id, main_worktree_path } = await ipc.openRepo(path);
      openTab(id, id, main_worktree_path);
    } catch (e) {
      if (isRepoGoneError(e) || isNotARepoError(e)) {
        toast.error("Worktree folder no longer exists", {
          description: path,
          action: repoId
            ? { label: "Prune missing", onClick: () => { ipc.pruneWorktrees(repoId).catch((err) => toast.error(String(err))); } }
            : undefined,
        });
        return;
      }
      toast.error(`Failed to open worktree: ${String(e)}`);
    }
  }, [openTab, repoId]);
}
```

  Import `toast` from `sonner`, which is what `repo.tsx` uses. Opening a worktree does not touch recents: the main repo is already there.
- Fix every existing test or mock that builds `openRepo` return values or `Tab` objects so `tsc` passes.

- [ ] **Step 4: Run all tests and verify they pass**
Run: `pnpm test run` and `pnpm exec tsc --noEmit`.
Expected: all green.

- [ ] **Step 5: Do NOT commit.**

---

### Task F2: `WorktreeList` sidebar section

**Files:**
- Create: `src/components/sidebar/WorktreeList.tsx`
- Create: `src/components/sidebar/WorktreeList.test.tsx`
- Modify: `src/components/sidebar/RefTree.tsx` (add an `afterBranches?: React.ReactNode` prop, rendered between the Branches and Remotes groups)
- Modify: `src/components/sidebar/Sidebar.tsx` (render `<WorktreeList>` through `afterBranches`; pass `filter`, `repoId`, `onSelectOid`, `onRemove`)
- Modify: `src/routes/repo.tsx` (give `Sidebar` an `onSelectOid` that reuses `handleGoToCommit`, and an `onRemoveWorktree` that opens the F3 dialog)

**Interfaces:**
- Consumes: `useWorktrees`, `useWorktreeStatus`, `useOpenWorktree`, `WorktreeInfo`, `ipc.pruneWorktrees` (F1).
- Produces: `export function WorktreeList(props: { repoId: string; filter?: string; onSelectOid?: (oid: string) => void; onRemove?: (wt: WorktreeInfo) => void })`.

Behaviour (copy is exact):
- **Hidden** (renders `null`) when `worktrees.length <= 1`, or when the filter matches no row.
- **Header:** same anatomy as `RefGroup` (see `RefTree.tsx:68-81`): `FolderGit2` at size 10, label `Worktrees`, count, chevron. When any row `is_missing`, the right side of the header also shows a text button `Prune missing` (10px, muted, hover brighter) that calls `ipc.pruneWorktrees(repoId)`, then invalidates `["worktrees", repoId]`.
- **Row** is a `<button>` with the same classes as ref rows (`RefTree.tsx:87-93`):
  - **Left:** the dot (teal glow when `is_current`, as HEAD), then `name` truncated. `title={path}`.
  - **Right**, in this order:
    - change count: `text-[10px] tabular-nums text-orange-300/80` when `changed > 0`; `–` (muted) when the status query errored; nothing when 0;
    - lock glyph: `Lock` size 8, `opacity-40`, `title={lock_reason ?? "Locked"}`;
    - branch: `font-mono text-[10px] text-foreground/45`, middle-truncated to 18 chars; when detached, `head_oid.slice(0,7)` in `text-amber-300/80`.
  - **Current row:** `text-teal-300/90 font-medium`, same as the HEAD ref row.
  - **Missing row:** `opacity-35 italic`, and the right side shows `missing` in place of the branch.
  - **Hover open button** (not on current or missing rows): an `ExternalLink` icon, size 10, `opacity-0 group-hover:opacity-60`, `aria-label={"Open worktree " + name}`. It calls `openWorktree(path)` and stops propagation.
- **Click:** `onSelectOid(head_oid)` when `head_oid`. **Double-click:** `openWorktree(path)` (not on current or missing rows).
- **Context menu** (`ContextMenu*` from `@/components/ui/context-menu`, text items like the sidebar ref menus):
  - `Open in new tab` (hidden for current; disabled for missing);
  - `Reveal in {explorerName()}` via `revealItemInDir(path)` (hidden for missing);
  - `Copy path`;
  - separator;
  - `Remove worktree…` → `onRemove(wt)` (hidden for main and current; disabled for missing).
  - Move `explorerName()` from `CommandPalette.tsx` to `src/lib/utils.ts` and import it in both places.
- **Live status:** each non-missing row calls `useWorktreeStatus(path, { enabled: sectionOpen && document.visibilityState === "visible" })`. Re-render on `visibilitychange` with a small `useSyncExternalStore` or state listener inside `WorktreeList`.
- **Filter:** a row matches when `name` or `branch` contains the filter (case-insensitive). While the filter is non-empty, the section is forced open (same as `RefGroup`).
- **Accessibility:** the row's accessible name includes the state, e.g. `aria-label={`${name}, ${branch ?? "detached " + short}${is_current ? ", current" : ""}${changed ? `, ${changed} uncommitted` : ""}`}`.

- [ ] **Step 1: Write the failing tests** (`WorktreeList.test.tsx`; mock `@/lib/queries`, `@/lib/useOpenRepo`, `@/lib/ipc` and `@tauri-apps/plugin-opener`):

```tsx
const WT = (o: Partial<WorktreeInfo>): WorktreeInfo => ({
  path: "E:\\r", name: "r", is_main: false, is_current: false, branch: "feat",
  head_oid: "abcdef1234", is_detached: false, is_locked: false, lock_reason: null,
  is_missing: false, branch_merged: false, ...o,
});
const MAIN = WT({ path: "E:\\repo", name: "repo", is_main: true, is_current: true, branch: "master" });
const AGENT = WT({ path: "E:\\repo-agent", name: "repo-agent", branch: "sinalizacao" });

it("renders nothing with only the main worktree", () => {
  vi.mocked(useWorktrees).mockReturnValue({ data: [MAIN] } as any);
  const { container } = render(<WorktreeList repoId="E:\\repo" />);
  expect(container).toBeEmptyDOMElement();
});

it("lists worktrees with branch, current marker and live change count", () => {
  vi.mocked(useWorktrees).mockReturnValue({ data: [MAIN, AGENT] } as any);
  vi.mocked(useWorktreeStatus).mockImplementation((p) =>
    ({ data: p === "E:\\repo-agent" ? { changed: 3, conflicted: false } : { changed: 0, conflicted: false } }) as any);
  render(<WorktreeList repoId="E:\\repo" />);
  expect(screen.getByText("Worktrees")).toBeInTheDocument();
  expect(screen.getByText("sinalizacao")).toHaveClass("font-mono");
  expect(screen.getByText("3")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /repo, master, current/ })).toBeInTheDocument();
});

it("shows short hash for a detached worktree", () => {
  vi.mocked(useWorktrees).mockReturnValue({ data: [MAIN, WT({ name: "det", branch: null, is_detached: true, head_oid: "1234567abc" })] } as any);
  render(<WorktreeList repoId="E:\\repo" />);
  expect(screen.getByText("1234567")).toBeInTheDocument();
});

it("double-click opens the worktree in a tab; never on the current row", () => {
  const open = vi.fn();
  vi.mocked(useOpenWorktree).mockReturnValue(open);
  vi.mocked(useWorktrees).mockReturnValue({ data: [MAIN, AGENT] } as any);
  render(<WorktreeList repoId="E:\\repo" />);
  fireEvent.doubleClick(screen.getByRole("button", { name: /repo-agent/ }));
  expect(open).toHaveBeenCalledWith("E:\\repo-agent");
  fireEvent.doubleClick(screen.getByRole("button", { name: /repo, master, current/ }));
  expect(open).toHaveBeenCalledTimes(1);
});

it("click selects the worktree's HEAD commit", () => {
  const onSelectOid = vi.fn();
  vi.mocked(useWorktrees).mockReturnValue({ data: [MAIN, AGENT] } as any);
  render(<WorktreeList repoId="E:\\repo" onSelectOid={onSelectOid} />);
  fireEvent.click(screen.getByRole("button", { name: /repo-agent/ }));
  expect(onSelectOid).toHaveBeenCalledWith("abcdef1234");
});

it("missing worktree is dimmed and the header offers Prune missing", async () => {
  vi.mocked(useWorktrees).mockReturnValue({ data: [MAIN, WT({ name: "gone", is_missing: true, branch: null, head_oid: null })] } as any);
  render(<WorktreeList repoId="E:\\repo" />);
  expect(screen.getByText("missing")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Prune missing"));
  await waitFor(() => expect(ipc.pruneWorktrees).toHaveBeenCalledWith("E:\\repo"));
});

it("filter matches folder name or branch", () => {
  vi.mocked(useWorktrees).mockReturnValue({ data: [MAIN, AGENT] } as any);
  const { rerender } = render(<WorktreeList repoId="E:\\repo" filter="sinal" />);
  expect(screen.getByText("repo-agent")).toBeInTheDocument();
  rerender(<WorktreeList repoId="E:\\repo" filter="zzz" />);
  expect(screen.queryByText("Worktrees")).toBeNull();
});
```

- [ ] **Step 2: Run them and verify they fail**
Run: `pnpm test run src/components/sidebar/WorktreeList.test.tsx`
Expected: FAIL, because the module does not exist.

- [ ] **Step 3: Implement `WorktreeList.tsx`** to the behaviour list above. Put each row in a `WorktreeRow` sub-component so that `useWorktreeStatus` is called once per row. Wire it into `RefTree` through `afterBranches`, then into `Sidebar` and `repo.tsx`.

- [ ] **Step 4: Run all tests and verify they pass**
Run: `pnpm test run` and `pnpm exec tsc --noEmit`.

- [ ] **Step 5: Do NOT commit.**

---

### Task F3: Remove worktree dialog

**Files:**
- Create: `src/components/actions/RemoveWorktreeDialog.tsx`
- Create: `src/components/actions/RemoveWorktreeDialog.test.tsx`
- Modify: `src/components/actions/Dialogs.tsx` (export `RiskBanner` so it can be reused; no behaviour change)
- Modify: `src/routes/repo.tsx` (add the `{ kind: "remove-worktree"; worktree: WorktreeInfo }` dialog state and render the dialog)

**Interfaces:**
- Consumes: `ipc.removeWorktree`, `useWorktreeStatus`, `WorktreeInfo`, `RemoveResult` (F1); `useStore().closeTab`.
- Produces: `export function RemoveWorktreeDialog(props: { repoId: string; worktree: WorktreeInfo; currentBranch: string | null; onClose: () => void; onSuccess: () => void })`.

Behaviour:
- **Title:** `Remove worktree`. **Description:** `Remove <mono>{name}</mono> ({path}). Its folder is deleted; commits on {branch} stay in the repository.` When detached, the last clause reads `…; its commit stays reachable only if another ref points to it.`
- **Dirty worktree** (`useWorktreeStatus(path, { enabled: true }).data.changed > 0`): `<RiskBanner level="danger">{n} uncommitted change(s) in {name} will be permanently lost.</RiskBanner>`. The confirm button is `variant="destructive"` with the label `Remove and discard changes`, and it calls with `force: true`.
- **Clean worktree:** no banner. The primary button reads `Remove`, and it calls with `force: false`.
- **Branch checkbox** (only when `branch`): `Also delete branch <mono>{branch}</mono>`.
  - Enabled only when `branch_merged`.
  - When disabled, a secondary line reads `Not merged into {currentBranch ?? "the current branch"}. Kept.`
  - When enabled, it is unchecked by default.
- **On success:**
  - `closeTab(worktree.path)` when a tab with that id exists;
  - if `result.branch_kept_reason`, show `toast.message(result.branch_kept_reason)`;
  - then `onSuccess()`.
- **On error:** show the backend message verbatim with the dialog's existing `ErrorNote` pattern. Keep the dialog open.

- [ ] **Step 1: Write the failing tests** (mock `@/lib/ipc`, `@/lib/queries` and `sonner`):

```tsx
const AGENT = { path: "E:\\repo-agent", name: "repo-agent", is_main: false, is_current: false, branch: "feat",
  head_oid: "abc", is_detached: false, is_locked: false, lock_reason: null, is_missing: false, branch_merged: true };

it("clean worktree: plain Remove, no danger banner", async () => {
  vi.mocked(useWorktreeStatus).mockReturnValue({ data: { changed: 0, conflicted: false } } as any);
  vi.mocked(ipc.removeWorktree).mockResolvedValue({ branch_deleted: false, branch_kept_reason: null });
  render(<RemoveWorktreeDialog repoId="E:\\repo" worktree={AGENT} currentBranch="master" onClose={vi.fn()} onSuccess={vi.fn()} />);
  expect(screen.queryByText(/permanently lost/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(ipc.removeWorktree).toHaveBeenCalledWith("E:\\repo", "E:\\repo-agent", false, false));
});

it("dirty worktree: danger banner and destructive force removal", async () => {
  vi.mocked(useWorktreeStatus).mockReturnValue({ data: { changed: 3, conflicted: false } } as any);
  vi.mocked(ipc.removeWorktree).mockResolvedValue({ branch_deleted: false, branch_kept_reason: null });
  render(<RemoveWorktreeDialog repoId="E:\\repo" worktree={AGENT} currentBranch="master" onClose={vi.fn()} onSuccess={vi.fn()} />);
  expect(screen.getByText(/3 uncommitted change\(s\) in repo-agent will be permanently lost/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Remove and discard changes" }));
  await waitFor(() => expect(ipc.removeWorktree).toHaveBeenCalledWith("E:\\repo", "E:\\repo-agent", true, false));
});

it("branch checkbox follows branch_merged", () => {
  vi.mocked(useWorktreeStatus).mockReturnValue({ data: { changed: 0, conflicted: false } } as any);
  const { rerender } = render(<RemoveWorktreeDialog repoId="r" worktree={AGENT} currentBranch="master" onClose={vi.fn()} onSuccess={vi.fn()} />);
  expect(screen.getByRole("checkbox")).toBeEnabled();
  rerender(<RemoveWorktreeDialog repoId="r" worktree={{ ...AGENT, branch_merged: false }} currentBranch="master" onClose={vi.fn()} onSuccess={vi.fn()} />);
  expect(screen.getByRole("checkbox")).toBeDisabled();
  expect(screen.getByText("Not merged into master. Kept.")).toBeInTheDocument();
});

it("success closes the worktree's open tab", async () => {
  useStore.setState({ tabs: [{ id: "E:\\repo-agent", path: "E:\\repo-agent", label: "repo-agent", mainPath: "E:\\repo" }] } as any);
  vi.mocked(useWorktreeStatus).mockReturnValue({ data: { changed: 0, conflicted: false } } as any);
  vi.mocked(ipc.removeWorktree).mockResolvedValue({ branch_deleted: true, branch_kept_reason: null });
  const onSuccess = vi.fn();
  render(<RemoveWorktreeDialog repoId="E:\\repo" worktree={AGENT} currentBranch="master" onClose={vi.fn()} onSuccess={onSuccess} />);
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(onSuccess).toHaveBeenCalled());
  expect(useStore.getState().tabs.find((t) => t.id === "E:\\repo-agent")).toBeUndefined();
});
```

If `src/components/ui/checkbox.tsx` does not exist, run `pnpm dlx shadcn@latest add checkbox` first.

- [ ] **Step 2: Run them and verify they fail.** Run `pnpm test run src/components/actions/RemoveWorktreeDialog.test.tsx`. Expected: module not found.
- [ ] **Step 3: Implement** with the existing `Dialog*` and `Button` components, following `MergeDialog` (`Dialogs.tsx:494-539`) for structure and `ErrorNote`.
- [ ] **Step 4: Run all tests and verify they pass.** Run `pnpm test run` and `pnpm exec tsc --noEmit`.
- [ ] **Step 5: Do NOT commit.**

---

### Task F4: Tabs (worktree glyph, name collisions) and the removed-worktree state

**Files:**
- Modify: `src/lib/store.ts` (export `tabLabels(tabs: Tab[]): Map<string, string>`)
- Modify: `src/components/tabs/TabBar.tsx`
- Modify: `src/routes/repo.tsx` (removed state when `useRepoStatus` errors with `isRepoGoneError`)
- Test: `src/lib/store.test.ts`, `src/components/tabs/TabBar.test.tsx` (create), `src/routes/repo.test.tsx`

**Interfaces:**
- Consumes: `Tab.mainPath` (F1), `isRepoGoneError` (F1).
- Produces: `tabLabels`.

Behaviour:
- **`tabLabels`:** the label is `tab.label`. When two or more open tabs share a label, each colliding tab whose `mainPath` is set gets `${label} · ${basename(mainPath)}`. Colliding tabs without `mainPath` get `${label} · ${basename(parent folder of path)}`.
- **TabBar:**
  - Tabs with `mainPath` show `FolderGit2` (size 11, `opacity-60`) before the label, plus `aria-label={`${label}, worktree of ${basename(mainPath)}`}` on the tab.
  - Every tab gets `title={tab.path}`.
  - Use `tabLabels(tabs)` for the text.
- **Removed state:** `useRepoStatus` returns `error`. When `isRepoGoneError(error)`, `RepoView` renders, instead of the normal layout, a centered panel with:
  - `This worktree was removed`
  - the path in mono (`text-xs text-muted-foreground`);
  - a `Button` labelled `Close tab` that calls `closeTab(repoId)`.

  In that state, pass `enabled: false` to `useFileStatus`/`useRepoStatus` by adding an optional `enabled` param (default `true`), so polling stops.

- [ ] **Step 1: Write the failing tests:**

```ts
// store.test.ts
it("tabLabels disambiguates colliding worktree names by their main repo", () => {
  const labels = tabLabels([
    { id: "E:\\a\\.worktrees\\fix", path: "E:\\a\\.worktrees\\fix", label: "fix", mainPath: "E:\\alugar" },
    { id: "E:\\w\\.worktrees\\fix", path: "E:\\w\\.worktrees\\fix", label: "fix", mainPath: "E:\\waypoint" },
    { id: "E:\\other", path: "E:\\other", label: "other", mainPath: null },
  ]);
  expect(labels.get("E:\\a\\.worktrees\\fix")).toBe("fix · alugar");
  expect(labels.get("E:\\w\\.worktrees\\fix")).toBe("fix · waypoint");
  expect(labels.get("E:\\other")).toBe("other");
});
```

```tsx
// TabBar.test.tsx
it("marks linked-worktree tabs and exposes the full path", () => {
  useStore.setState({ tabs: [{ id: "E:\\repo-agent", path: "E:\\repo-agent", label: "repo-agent", mainPath: "E:\\repo" }], activeTabId: "E:\\repo-agent" } as any);
  render(<TabBar />);
  const tab = screen.getByRole("tab", { name: /repo-agent, worktree of repo/ });
  expect(tab).toHaveAttribute("title", "E:\\repo-agent");
});
```

```tsx
// repo.test.tsx: follow the file's existing mocking pattern
it("shows the removed-worktree state when status reports repo gone", () => {
  vi.mocked(useRepoStatus).mockReturnValue({ data: undefined, error: "repo gone: E:\\repo-agent" } as any);
  render(<RepoView />);
  expect(screen.getByText("This worktree was removed")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Close tab" })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all tests and verify they pass.** Run `pnpm test run` and `pnpm exec tsc --noEmit`.
- [ ] **Step 5: Do NOT commit.**

---

### Task F5: Branch badge and menu fixes (critique run 23/40)

**Files:**
- Modify: `src/components/sidebar/RefTree.tsx`
- Modify: `src/components/timeline/RefBadge.tsx`
- Modify: `src/components/timeline/CommitRow.tsx` (pass `worktreePath` for every non-tag group, including remote-only groups, keyed by the local branch name)
- Modify: `src/routes/repo.tsx` (`open-worktree` uses `useOpenWorktree(repoId)` from F1 instead of `useOpenRepo`)
- Test: `src/components/sidebar/RefTree.test.tsx`, `src/components/timeline/RefBadge.test.tsx`

**Interfaces:**
- Consumes: `RefInfo.worktree_path` (existing); `RefAction` `open-worktree` (existing).
- Produces: `export function worktreeName(path: string): string` in `src/lib/utils.ts`, returning the last path segment (reuse `repoLabel`'s logic).

Required changes (spec § "Branch badge and menus: fixes from the first critique"):

1. **Sidebar chip.** On a held branch row, replace the lone `FolderGit2` icon with a chip:

```tsx
<span data-testid="worktree-indicator" className="shrink-0 inline-flex items-center gap-1 max-w-[45%] font-mono text-[10px] text-foreground/60 group-hover:text-foreground/80">
  <FolderGit2 size={10} aria-hidden />
  <span className="truncate">{truncateMiddle(worktreeName(ref.worktree_path), 16)}</span>
</span>
<span className="sr-only">, checked out in worktree {worktreeName(ref.worktree_path)}</span>
```

   Add `group` to the row button's classes. Remove every `title` from disabled menu items.
2. **Sidebar menu** for held branches, top to bottom:
   - `Open worktree` (text item, no icon, like the rest of this menu), with `<span className="ml-auto font-mono text-xs text-muted-foreground">{worktreeName}</span>`;
   - separator;
   - Merge / Rebase;
   - Copy;
   - Create tag / Push;
   - Rename.

   **No** disabled reason line and **no** Delete item.
3. **Sidebar Remotes group.** When a remote ref's local counterpart (`shorthand` after the first `/`) is a local branch with `worktree_path`, replace `Checkout {ref.shorthand}` with the same `Open worktree` item. Build the lookup once in `RefTree` from `local` refs: `Map<localName, worktree_path>`.
4. **Double-click means "go to this branch" on sidebar rows:**
   - Branches, not HEAD: held → `open-worktree`, else `checkout-branch`.
   - Remotes: held upstream → `open-worktree`, else `checkout-remote-branch`.
   - HEAD rows and Tags: no double-click.
5. **Badge menu** (`RefBadge.tsx`) for held branches:
   - render `<ContextMenuItem onClick=…><FolderGit2 />Open worktree<span className="ml-auto font-mono text-xs text-muted-foreground">{worktreeName}</span></ContextMenuItem><ContextMenuSeparator />` as the **first** items in `ContextMenuContent`, before `CommitMenuItems`;
   - pass `checkoutSlot={null}`;
   - remove the disabled "Checked out elsewhere" line;
   - **hide** the Delete item;
   - use the same mapping for remote-only groups whose local name is held (`worktreePath` passed by `CommitRow`).
6. **Badge double-click:** add `onDoubleClick` to the badge `<span>`:
   - held → `onAction({kind:"open-worktree", path})`;
   - local non-HEAD → `onCommitAction({kind:"checkout-branch", branchName: name})`;
   - remote-only → `onCommitAction({kind:"checkout-remote-branch", remoteBranch: trackingName})`;
   - HEAD or tag → nothing.

   Call `e.stopPropagation()` so the row doesn't also react.
7. **Badge glyph and budget:** the glyph becomes `opacity-60`. The truncation budget subtracts 10px when `worktreePath` is set:

   ```ts
   Math.floor((width - 28 - (worktreePath ? 10 : 0)) / 6.2)
   ```

   Add `<span className="sr-only">, checked out in worktree {worktreeName}</span>` inside the badge.
8. **Single phrase:** any remaining user-visible mention reads `Checked out in worktree {name}`.

- [ ] **Step 1: Write the failing tests** (extend the existing `RefTree.test.tsx` and `RefBadge.test.tsx`, reusing their render helpers and fixtures; `HELD` is a local branch with `worktree_path: "E:\\repo-agent"`):

```tsx
it("held branch row shows the worktree name chip and an accessible description", () => {
  renderTree([HELD]);
  expect(screen.getByTestId("worktree-indicator")).toHaveTextContent("repo-agent");
  expect(screen.getByText(/checked out in worktree repo-agent/)).toHaveClass("sr-only");
});

it("held branch menu names the worktree and has no Delete or disabled reason", () => {
  renderTree([HELD]);
  fireEvent.contextMenu(screen.getByText(HELD.shorthand));
  const item = screen.getByRole("menuitem", { name: /Open worktree/ });
  expect(item).toHaveTextContent("repo-agent");
  expect(screen.queryByText(/Checked out elsewhere/)).toBeNull();
  expect(screen.queryByRole("menuitem", { name: /^Delete/ })).toBeNull();
  expect(screen.getByRole("menuitem", { name: /Merge into current/ })).not.toHaveAttribute("aria-disabled", "true");
});

it("remote checkout is replaced by Open worktree when the local branch is held", () => {
  renderTree([HELD, { ...REMOTE, shorthand: `origin/${HELD.shorthand}` }]);
  fireEvent.contextMenu(screen.getByText(`origin/${HELD.shorthand}`));
  expect(screen.getByRole("menuitem", { name: /Open worktree/ })).toBeInTheDocument();
  expect(screen.queryByRole("menuitem", { name: /^Checkout origin/ })).toBeNull();
});

it("double-click: normal branch → checkout dialog; held branch → open worktree", () => {
  const onRefAction = vi.fn();
  renderTree([HELD, NORMAL], { onRefAction });
  fireEvent.doubleClick(screen.getByText(NORMAL.shorthand));
  expect(onRefAction).toHaveBeenCalledWith({ kind: "checkout-branch", branchName: NORMAL.shorthand });
  fireEvent.doubleClick(screen.getByText(HELD.shorthand));
  expect(onRefAction).toHaveBeenCalledWith({ kind: "open-worktree", path: "E:\\repo-agent" });
});
```

```tsx
// RefBadge.test.tsx
it("badge menu puts Open worktree first and hides Delete for held branches", () => {
  renderBadge({ name: "feat", hasLocal: true, worktreePath: "E:\\repo-agent", oid: "abc", onAction: vi.fn(), onCommitAction: vi.fn() });
  fireEvent.contextMenu(screen.getByTitle("feat"));
  const items = screen.getAllByRole("menuitem");
  expect(items[0]).toHaveTextContent(/Open worktree.*repo-agent/);
  expect(screen.queryByRole("menuitem", { name: /^Delete/ })).toBeNull();
});

it("badge double-click checks out a normal branch and opens a held one", () => {
  const onAction = vi.fn(); const onCommitAction = vi.fn();
  const { rerender } = renderBadge({ name: "feat", hasLocal: true, onAction, onCommitAction, oid: "abc" });
  fireEvent.doubleClick(screen.getByTitle("feat"));
  expect(onCommitAction).toHaveBeenCalledWith({ kind: "checkout-branch", branchName: "feat" });
  rerenderBadge(rerender, { name: "feat", hasLocal: true, worktreePath: "E:\\repo-agent", onAction, onCommitAction, oid: "abc" });
  fireEvent.doubleClick(screen.getByTitle("feat"));
  expect(onAction).toHaveBeenCalledWith({ kind: "open-worktree", path: "E:\\repo-agent" });
});

it("truncation budget reserves room for the worktree glyph", () => {
  const long = "feature/very-long-branch-name-ABC-1234";
  const { rerender } = renderBadge({ name: long, hasLocal: true, maxWidth: 124 });
  const plain = screen.getByTitle(long).textContent!;
  rerenderBadge(rerender, { name: long, hasLocal: true, maxWidth: 124, worktreePath: "E:\\wt" });
  const held = screen.getByTitle(long).textContent!;
  expect(held.replace(/, checked out in worktree wt$/, "").length).toBeLessThan(plain.length);
});
```

`renderTree`, `renderBadge` and `rerenderBadge` stand for the existing helpers in those test files. If a helper doesn't exist, write a local one that renders the component with the needed props.

- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement** items 1–8. Update or remove the earlier tests that asserted the old disabled "Checked out elsewhere" and disabled-Delete behaviour.
- [ ] **Step 4: Run all tests and verify they pass.** Run `pnpm test run` and `pnpm exec tsc --noEmit`.
- [ ] **Step 5: Do NOT commit.**

---

### Task F6: Stash origin labels and cross-branch confirm

**Files:**
- Modify: `src/components/sidebar/StashList.tsx`
- Test: `src/components/sidebar/StashList.test.tsx`

**Interfaces:**
- Consumes: `StashEntry.branch` (F1); `useHeadInfo(repoId)` (existing) for the current branch.

Behaviour:
- **Row:** after the label, `s.branch` in `font-mono text-[9px] text-muted-foreground/40 shrink-0` (omitted when null).
- **Stash from another branch** (`s.branch && head.branch && s.branch !== head.branch`): the row text gets `opacity-60`.
- **Pop or Apply on such a stash** opens a small confirm `Dialog`:
  - title `Apply stash from another branch?`;
  - body `This stash was made on <mono>{s.branch}</mono>. Apply it to <mono>{head.branch}</mono>?`;
  - buttons `Cancel` and `Apply` / `Pop` (the label matches the action).

  Only confirming calls the IPC. When the stash is from the same branch, or either branch is unknown, the IPC is called directly, as today.

- [ ] **Step 1: Write the failing tests** (mock `useHeadInfo` with `{ data: { branch: "sinalizacao", oid: "x" } }`):

```tsx
const STASHES = [
  { index: 0, message: "On master: WIP on master: 436fca2 docs", oid: "a", branch: "master" },
  { index: 1, message: "WIP on sinalizacao: abc1234 mine", oid: "b", branch: "sinalizacao" },
];

it("labels each stash with its origin branch", () => {
  vi.mocked(useStashes).mockReturnValue({ data: STASHES } as any);
  render(<StashList repoId="r" />);
  expect(screen.getByText("master")).toHaveClass("font-mono");
});

it("asks before popping a stash made on another branch", async () => {
  vi.mocked(useStashes).mockReturnValue({ data: STASHES } as any);
  render(<StashList repoId="r" />);
  fireEvent.contextMenu(screen.getByTitle(STASHES[0].message));
  fireEvent.click(screen.getByText("Pop"));
  expect(ipc.popStash).not.toHaveBeenCalled();
  expect(screen.getByText("Apply stash from another branch?")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Pop" }));
  await waitFor(() => expect(ipc.popStash).toHaveBeenCalledWith("r", 0));
});

it("pops a same-branch stash without asking", async () => {
  vi.mocked(useStashes).mockReturnValue({ data: STASHES } as any);
  render(<StashList repoId="r" />);
  fireEvent.contextMenu(screen.getByTitle(STASHES[1].message));
  fireEvent.click(screen.getByText("Pop"));
  await waitFor(() => expect(ipc.popStash).toHaveBeenCalledWith("r", 1));
});
```

Add `useHeadInfo: vi.fn()` to the file's `@/lib/queries` mock, with a default return value in `beforeEach`.

- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all tests and verify they pass.** Run `pnpm test run` and `pnpm exec tsc --noEmit`.
- [ ] **Step 5: Do NOT commit.**

---

### Task F7: Merge dialog caution for dirty worktree branches

**Files:**
- Modify: `src/components/actions/Dialogs.tsx` (`MergeDialog` gains an optional `worktree?: { name: string; path: string } | null` prop)
- Modify: `src/routes/repo.tsx` (pass `worktree` when `dialog.label` is a local branch with `worktree_path`; look it up in `refs`)
- Test: `src/components/actions/Dialogs.test.tsx`

Behaviour: when `worktree` is set and `useWorktreeStatus(worktree.path, { enabled: true }).data?.changed > 0`, render `<RiskBanner level="caution">{worktree.name} has {n} uncommitted change(s) that won't be merged. Only committed work on {label} is merged.</RiskBanner>` above the error note. Otherwise nothing changes.

- [ ] **Step 1: Write the failing tests:**

```tsx
it("warns when the merged branch's worktree has uncommitted changes", () => {
  vi.mocked(useWorktreeStatus).mockReturnValue({ data: { changed: 2, conflicted: false } } as any);
  render(<MergeDialog repoId="r" oid="abc" label="sinalizacao" currentBranch="master"
    worktree={{ name: "alugar-sinalizacao", path: "E:\\alugar-sinalizacao" }}
    onClose={vi.fn()} onSuccess={vi.fn()} onConflicts={vi.fn()} />);
  expect(screen.getByText(/alugar-sinalizacao has 2 uncommitted change\(s\) that won't be merged/)).toBeInTheDocument();
});

it("no banner for a clean worktree or a plain branch", () => {
  vi.mocked(useWorktreeStatus).mockReturnValue({ data: { changed: 0, conflicted: false } } as any);
  render(<MergeDialog repoId="r" oid="abc" label="feat" currentBranch="master" worktree={null}
    onClose={vi.fn()} onSuccess={vi.fn()} onConflicts={vi.fn()} />);
  expect(screen.queryByText(/won't be merged/)).toBeNull();
});
```

Mock `useWorktreeStatus` in `@/lib/queries` for this test file. When `worktree` is null, the hook is called with `enabled: false`.

- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all tests and verify they pass.** Run `pnpm test run` and `pnpm exec tsc --noEmit`.
- [ ] **Step 5: Do NOT commit.**

---

### Task F8: Command palette "Open worktree…"

**Files:**
- Modify: `src/components/CommandPalette.tsx` (new mode `"worktree-picker"`)
- Test: `src/components/CommandPalette.test.tsx` (create if absent)

**Interfaces:**
- Consumes: `ipc.listWorktrees`, `useOpenWorktree` (F1); `explorerName` from `src/lib/utils.ts` (moved in F2).

Behaviour:
- **New command** `{ id: "open-worktree", label: "Open Worktree…", icon: FolderGit2, disabled: !activeTab }`. It switches to `mode: "worktree-picker"` and loads `ipc.listWorktrees(activeTab.id)`.
- **Picker rows** exclude the current and missing worktrees. Each shows the name, then the branch in mono (or the short hash if detached), with the path muted. The list is filterable by query, which matches name or branch.
- **Enter or click** calls `openWorktree(path)` and then `onClose()`.
- **Empty state:** `No other worktrees.`
- Mirror the existing `"repo-picker"` mode's rendering, keyboard handling and back navigation.

- [ ] **Step 1: Write the failing test:**

```tsx
it("Open Worktree… lists other worktrees and opens the chosen one", async () => {
  useStore.setState({ tabs: [{ id: "E:\\repo", path: "E:\\repo", label: "repo", mainPath: null }], activeTabId: "E:\\repo" } as any);
  vi.mocked(ipc.listWorktrees).mockResolvedValue([
    { path: "E:\\repo", name: "repo", is_main: true, is_current: true, branch: "master", head_oid: "a", is_detached: false, is_locked: false, lock_reason: null, is_missing: false, branch_merged: false },
    { path: "E:\\repo-agent", name: "repo-agent", is_main: false, is_current: false, branch: "sinalizacao", head_oid: "b", is_detached: false, is_locked: false, lock_reason: null, is_missing: false, branch_merged: false },
  ]);
  const open = vi.fn().mockResolvedValue(undefined);
  vi.mocked(useOpenWorktree).mockReturnValue(open);
  render(<CommandPalette open onClose={vi.fn()} />);
  fireEvent.click(await screen.findByText("Open Worktree…"));
  expect(await screen.findByText("repo-agent")).toBeInTheDocument();
  expect(screen.queryByText("master")).toBeNull(); // current excluded
  fireEvent.click(screen.getByText("repo-agent"));
  await waitFor(() => expect(open).toHaveBeenCalledWith("E:\\repo-agent"));
});
```

Mock `@/lib/ipc`, `@/lib/useOpenRepo` (both `useOpenRepo` and `useOpenWorktree`), `@/lib/recentRepos`, `@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-opener`, `@/lib/plugins/registry` and `@/components/plugins/PluginRunnerProvider`, as the component needs.

- [ ] **Step 2: Run it and verify it fails.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all tests and verify they pass.** Run `pnpm test run` and `pnpm exec tsc --noEmit`.
- [ ] **Step 5: Do NOT commit.** Report: tasks done, tests added, observed red failures, final counts, and anything guessed.

---

# Coordinator checklist (main session, after both lanes finish)

1. Run `cargo test` and `cargo build` in `src-tauri`, then `pnpm test run` and `pnpm exec tsc --noEmit` at the root. Everything must be green.
2. Re-run `/impeccable critique` on the sidebar and badge UI (dual-agent) and compare against 23/40.
3. Spawn a subagent to run `/code-review high` over the full uncommitted diff, and relay its findings.
4. Ask the user before any commit.
