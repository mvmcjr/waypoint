use std::cell::RefCell;

use serde::Serialize;
use tauri::State;

use crate::error::{Error, Result};
use crate::repo::RepoState;

// Shared helper: walk a git2::Diff and collect FileDiff structs.
fn collect_diff(diff: git2::Diff) -> Result<Vec<FileDiff>> {
    let files: RefCell<Vec<FileDiff>> = RefCell::new(Vec::new());

    diff.foreach(
        &mut |delta, _| {
            let path = delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .and_then(|p| p.to_str())
                .unwrap_or("")
                .to_owned();

            let old_path = delta
                .old_file()
                .path()
                .and_then(|p| p.to_str())
                .filter(|p| *p != path)
                .map(|p| p.to_owned());

            let status = match delta.status() {
                git2::Delta::Added | git2::Delta::Untracked => DiffStatus::Added,
                git2::Delta::Deleted => DiffStatus::Deleted,
                git2::Delta::Modified => DiffStatus::Modified,
                git2::Delta::Renamed => DiffStatus::Renamed,
                git2::Delta::Copied => DiffStatus::Copied,
                _ => DiffStatus::Other,
            };

            files.borrow_mut().push(FileDiff { path, old_path, status, hunks: Vec::new() });
            true
        },
        None,
        Some(&mut |_delta, hunk| {
            let header = String::from_utf8_lossy(hunk.header()).to_string();
            if let Some(file) = files.borrow_mut().last_mut() {
                file.hunks.push(Hunk { header, lines: Vec::new() });
            }
            true
        }),
        Some(&mut |_delta, _hunk, line| {
            let content = String::from_utf8_lossy(line.content()).to_string();
            let kind = match line.origin() {
                '+' => LineKind::Addition,
                '-' => LineKind::Deletion,
                _ => LineKind::Context,
            };
            let mut files_mut = files.borrow_mut();
            if let Some(file) = files_mut.last_mut() {
                if let Some(hunk) = file.hunks.last_mut() {
                    hunk.lines.push(DiffLine { kind, content });
                }
            }
            true
        }),
    )?;

    Ok(files.into_inner())
}

#[derive(Debug, Serialize)]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub status: DiffStatus,
    pub hunks: Vec<Hunk>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffStatus {
    Added,
    Deleted,
    Modified,
    Renamed,
    Copied,
    Other,
}

#[derive(Debug, Serialize)]
pub struct Hunk {
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Serialize)]
pub struct DiffLine {
    pub kind: LineKind,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LineKind {
    Context,
    Addition,
    Deletion,
}

#[tauri::command]
pub fn get_commit_diff(
    repo_id: String,
    oid: String,
    state: State<RepoState>,
) -> Result<Vec<FileDiff>> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let git_oid = git2::Oid::from_str(&oid).map_err(|_| Error::CommitNotFound(oid.clone()))?;
    let commit = repo.find_commit(git_oid).map_err(|_| Error::CommitNotFound(oid.clone()))?;

    let commit_tree = commit.tree()?;
    let parent_tree = if commit.parent_count() > 0 {
        Some(commit.parent(0)?.tree()?)
    } else {
        None
    };

    let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&commit_tree), None)?;
    collect_diff(diff)
}

/// Return the diff for a single file in the working directory.
/// `staged = true`  → index vs HEAD  (what's been staged)
/// `staged = false` → workdir vs index (what's unstaged / not yet staged)
#[tauri::command]
pub fn get_workdir_diff(
    repo_id: String,
    path: String,
    staged: bool,
    state: State<RepoState>,
) -> Result<FileDiff> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let mut opts = git2::DiffOptions::new();
    // include_untracked lists untracked files as deltas, but their line content is
    // only emitted with show_untracked_content — without it the diff view for an
    // untracked file comes back with no hunks. recurse_untracked_dirs is needed too:
    // without it, a new file inside a brand-new (wholly untracked) directory is
    // collapsed into a single delta for the directory itself, which never matches
    // the file's own pathspec, so the diff for that file comes back empty.
    opts.pathspec(&path)
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true);

    let index = repo.index()?;

    let diff = if staged {
        let head_tree: Option<git2::Tree> = match repo.head() {
            Ok(head) => Some(head.peel_to_tree()?),
            Err(_) => None,
        };
        repo.diff_tree_to_index(head_tree.as_ref(), Some(&index), Some(&mut opts))?
    } else {
        repo.diff_index_to_workdir(Some(&index), Some(&mut opts))?
    };

    let files = collect_diff(diff)?;
    files.into_iter().next().ok_or_else(|| Error::InvalidArg(format!("no diff for {path}")))
}
