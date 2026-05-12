use std::cell::RefCell;

use serde::Serialize;
use tauri::State;

use crate::error::{Error, Result};
use crate::repo::RepoState;

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

    let diff = repo.diff_tree_to_tree(
        parent_tree.as_ref(),
        Some(&commit_tree),
        None,
    )?;

    // RefCell lets three separate closures share mutable access.
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

            let old_path = delta.old_file().path()
                .and_then(|p| p.to_str())
                .filter(|p| *p != path)
                .map(|p| p.to_owned());

            let status = match delta.status() {
                git2::Delta::Added => DiffStatus::Added,
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
