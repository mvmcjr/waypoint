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
            // '=' / '>' / '<' are libgit2's "no newline at end of file" marker
            // lines (EOFNL) — synthetic annotations, not real file content.
            // Including them would shift every later line_index in this hunk
            // and, if the marker itself ever became a stage/unstage target or
            // got carried into build_single_line_patch as context, corrupt
            // the constructed patch (its "\ No newline..." text isn't valid
            // unified-diff syntax on its own). The real line immediately
            // before it already reflects the missing trailing newline in its
            // own content, so this marker carries nothing we need.
            if matches!(line.origin(), '=' | '>' | '<') {
                return true;
            }
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

// Context lines large enough to swallow any realistic file in one hunk —
// libgit2's own "-U<n>" trick for a full-file diff (no distinct u32::MAX
// semantics on the C side, just a generous line count).
const FULL_FILE_CONTEXT_LINES: u32 = 1_000_000;

#[tauri::command]
pub fn get_commit_diff(
    repo_id: String,
    oid: String,
    state: State<RepoState>,
) -> Result<Vec<FileDiff>> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let (commit_tree, parent_tree) = commit_and_parent_tree(repo, &oid)?;
    let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&commit_tree), None)?;
    collect_diff(diff)
}

/// Same as `get_commit_diff` but scoped to one file and rendered with enough
/// context to cover the whole file in a single hunk — backs the diff panel's
/// "Full file" view for a historical commit.
#[tauri::command]
pub fn get_commit_file_diff(
    repo_id: String,
    oid: String,
    path: String,
    state: State<RepoState>,
) -> Result<FileDiff> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let (commit_tree, parent_tree) = commit_and_parent_tree(repo, &oid)?;
    let mut opts = git2::DiffOptions::new();
    // Exact match, not fnmatch: pathspec() glob-matches by default, so a
    // filename containing `[`, `]`, `*`, or `?` (legal, and common via
    // framework route conventions like `[id].tsx`) could otherwise match
    // unintended sibling files.
    opts.pathspec(&path).disable_pathspec_match(true).context_lines(FULL_FILE_CONTEXT_LINES);
    let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&commit_tree), Some(&mut opts))?;

    let files = collect_diff(diff)?;
    files.into_iter().next().ok_or_else(|| Error::InvalidArg(format!("no diff for {path}")))
}

fn commit_and_parent_tree<'a>(
    repo: &'a git2::Repository,
    oid: &str,
) -> Result<(git2::Tree<'a>, Option<git2::Tree<'a>>)> {
    let git_oid = git2::Oid::from_str(oid).map_err(|_| Error::CommitNotFound(oid.to_owned()))?;
    let commit = repo.find_commit(git_oid).map_err(|_| Error::CommitNotFound(oid.to_owned()))?;

    let commit_tree = commit.tree()?;
    let parent_tree = if commit.parent_count() > 0 {
        Some(commit.parent(0)?.tree()?)
    } else {
        None
    };
    Ok((commit_tree, parent_tree))
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
    workdir_file_diff(repo, &path, staged, false)
}

/// Same as `get_workdir_diff` but rendered with enough context to cover the
/// whole file in a single hunk — backs the diff panel's "Full file" view.
#[tauri::command]
pub fn get_workdir_file_full(
    repo_id: String,
    path: String,
    staged: bool,
    state: State<RepoState>,
) -> Result<FileDiff> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
    workdir_file_diff(repo, &path, staged, true)
}

fn workdir_file_diff(
    repo: &git2::Repository,
    path: &str,
    staged: bool,
    full_file: bool,
) -> Result<FileDiff> {
    let mut opts = git2::DiffOptions::new();
    // include_untracked lists untracked files as deltas, but their line content is
    // only emitted with show_untracked_content — without it the diff view for an
    // untracked file comes back with no hunks. recurse_untracked_dirs is needed too:
    // without it, a new file inside a brand-new (wholly untracked) directory is
    // collapsed into a single delta for the directory itself, which never matches
    // the file's own pathspec, so the diff for that file comes back empty.
    opts.pathspec(path)
        .disable_pathspec_match(true)
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true);
    if full_file {
        opts.context_lines(FULL_FILE_CONTEXT_LINES);
    }

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

/// Stage a single hunk (by its index within the file's unstaged diff) —
/// applies just that hunk from workdir-vs-index onto the index. `full_file`
/// must match whatever scope the frontend fetched the displayed hunk with —
/// the "Full file" view collapses everything into one full-context hunk,
/// which doesn't line up with the default-context hunk numbering otherwise.
#[tauri::command]
pub fn stage_hunk(
    repo_id: String,
    path: String,
    hunk_index: usize,
    full_file: bool,
    state: State<RepoState>,
) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
    stage_hunk_impl(repo, &path, hunk_index, full_file)
}

/// Unstage a single hunk (by its index within the file's staged diff) —
/// reverse-applies just that hunk from HEAD-vs-index onto the index. See
/// `stage_hunk` on `full_file`.
#[tauri::command]
pub fn unstage_hunk(
    repo_id: String,
    path: String,
    hunk_index: usize,
    full_file: bool,
    state: State<RepoState>,
) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
    unstage_hunk_impl(repo, &path, hunk_index, full_file)
}

fn stage_hunk_impl(repo: &git2::Repository, path: &str, hunk_index: usize, full_file: bool) -> Result<()> {
    let mut opts = git2::DiffOptions::new();
    opts.pathspec(path)
        .disable_pathspec_match(true)
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true);
    if full_file {
        opts.context_lines(FULL_FILE_CONTEXT_LINES);
    }

    let index = repo.index()?;
    let diff = repo.diff_index_to_workdir(Some(&index), Some(&mut opts))?;
    apply_single_hunk(repo, diff, hunk_index, path)
}

fn unstage_hunk_impl(repo: &git2::Repository, path: &str, hunk_index: usize, full_file: bool) -> Result<()> {
    let mut opts = git2::DiffOptions::new();
    // reverse(true) flips the polarity of every hunk so applying the result to
    // the index moves it back toward HEAD for just that hunk, instead of
    // needing a separate "unapply" path.
    opts.pathspec(path).disable_pathspec_match(true).reverse(true);
    if full_file {
        opts.context_lines(FULL_FILE_CONTEXT_LINES);
    }

    let head_tree: Option<git2::Tree> = match repo.head() {
        Ok(head) => Some(head.peel_to_tree()?),
        Err(_) => None,
    };
    let index = repo.index()?;
    let diff = repo.diff_tree_to_index(head_tree.as_ref(), Some(&index), Some(&mut opts))?;
    apply_single_hunk(repo, diff, hunk_index, path)
}

/// Apply only the hunk at `hunk_index` (in file order) from `diff` to the index.
fn apply_single_hunk(
    repo: &git2::Repository,
    diff: git2::Diff,
    hunk_index: usize,
    path: &str,
) -> Result<()> {
    let mut seen = 0usize;
    let mut applied = false;
    let mut apply_opts = git2::ApplyOptions::new();
    apply_opts.hunk_callback(|_hunk| {
        let is_target = seen == hunk_index;
        seen += 1;
        if is_target {
            applied = true;
        }
        is_target
    });
    repo.apply(&diff, git2::ApplyLocation::Index, Some(&mut apply_opts))?;
    drop(apply_opts);

    if !applied {
        return Err(Error::InvalidArg(format!("hunk {hunk_index} not found for {path}")));
    }
    Ok(())
}

/// Stage a single line (by its index within one hunk of the file's unstaged
/// diff). `full_file` must match the scope the frontend fetched the
/// displayed hunk with — see `stage_hunk`.
#[tauri::command]
pub fn stage_line(
    repo_id: String,
    path: String,
    hunk_index: usize,
    line_index: usize,
    full_file: bool,
    state: State<RepoState>,
) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
    stage_line_impl(repo, &path, hunk_index, line_index, full_file)
}

/// Unstage a single line (by its index within one hunk of the file's staged
/// diff). See `stage_hunk` on `full_file`.
#[tauri::command]
pub fn unstage_line(
    repo_id: String,
    path: String,
    hunk_index: usize,
    line_index: usize,
    full_file: bool,
    state: State<RepoState>,
) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
    unstage_line_impl(repo, &path, hunk_index, line_index, full_file)
}

fn stage_line_impl(
    repo: &git2::Repository,
    path: &str,
    hunk_index: usize,
    line_index: usize,
    full_file: bool,
) -> Result<()> {
    let mut opts = git2::DiffOptions::new();
    opts.pathspec(path)
        .disable_pathspec_match(true)
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true);
    if full_file {
        opts.context_lines(FULL_FILE_CONTEXT_LINES);
    }
    let index = repo.index()?;
    let diff = repo.diff_index_to_workdir(Some(&index), Some(&mut opts))?;
    apply_single_line(repo, diff, path, hunk_index, line_index, false)
}

fn unstage_line_impl(
    repo: &git2::Repository,
    path: &str,
    hunk_index: usize,
    line_index: usize,
    full_file: bool,
) -> Result<()> {
    // Deliberately NOT reverse(true): this is the exact same (HEAD vs index)
    // diff the frontend already displays as the staged view, so hunk_index/
    // line_index line up with what the user clicked. Reversing here would
    // renumber lines (deletions/additions swap slots), silently unstaging
    // the wrong line. Instead `apply_single_line`'s `reverse_target` flag
    // flips just the *target* line's role and leaves everything else as
    // context matching the *current* index content — see its doc comment.
    let mut opts = git2::DiffOptions::new();
    opts.pathspec(path).disable_pathspec_match(true);
    if full_file {
        opts.context_lines(FULL_FILE_CONTEXT_LINES);
    }
    let head_tree: Option<git2::Tree> = match repo.head() {
        Ok(head) => Some(head.peel_to_tree()?),
        Err(_) => None,
    };
    let index = repo.index()?;
    let diff = repo.diff_tree_to_index(head_tree.as_ref(), Some(&index), Some(&mut opts))?;
    apply_single_line(repo, diff, path, hunk_index, line_index, true)
}

/// Locate the hunk/line requested, build a minimal single-line patch from it
/// (see `build_single_line_patch`), and apply just that to the index. Unlike
/// `apply_single_hunk`, this can't use `ApplyOptions::hunk_callback` — that
/// only selects whole hunks — so instead we hand-build a one-hunk patch
/// buffer and parse it back into a `Diff` via `Diff::from_buffer`.
fn apply_single_line(
    repo: &git2::Repository,
    diff: git2::Diff,
    path: &str,
    hunk_index: usize,
    line_index: usize,
    reverse_target: bool,
) -> Result<()> {
    let (file, hunk) = collect_single_hunk(diff, hunk_index)?
        .ok_or_else(|| Error::InvalidArg(format!("hunk {hunk_index} not found for {path}")))?;
    let line = hunk
        .lines
        .get(line_index)
        .ok_or_else(|| Error::InvalidArg(format!("line {line_index} not found in hunk {hunk_index} for {path}")))?;
    if matches!(line.kind, LineKind::Context) {
        return Err(Error::InvalidArg("cannot stage/unstage a context line".to_string()));
    }

    let patch_text = build_single_line_patch(&file, &hunk, line_index, reverse_target);
    let patch_diff = git2::Diff::from_buffer(patch_text.as_bytes())?;
    repo.apply(&patch_diff, git2::ApplyLocation::Index, None)?;
    Ok(())
}

/// Like `collect_diff`, but only materializes the file's path/status and the
/// single hunk at `target_hunk_index` — `apply_single_line` only ever needs
/// one hunk's lines, and `collect_diff` would otherwise copy every line of
/// every hunk into an owned `String` just to throw away everything but one.
/// With `pathspec`+`disable_pathspec_match` guaranteeing at most one delta,
/// this always operates on the single matched file.
fn collect_single_hunk(diff: git2::Diff, target_hunk_index: usize) -> Result<Option<(FileDiff, Hunk)>> {
    let file: RefCell<Option<FileDiff>> = RefCell::new(None);
    let seen_hunks = RefCell::new(0usize);
    let in_target = RefCell::new(false);
    let target_hunk: RefCell<Option<Hunk>> = RefCell::new(None);

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
            *file.borrow_mut() = Some(FileDiff { path, old_path, status, hunks: Vec::new() });
            true
        },
        None,
        Some(&mut |_delta, hunk| {
            let idx = *seen_hunks.borrow();
            *in_target.borrow_mut() = idx == target_hunk_index;
            if *in_target.borrow() {
                let header = String::from_utf8_lossy(hunk.header()).to_string();
                *target_hunk.borrow_mut() = Some(Hunk { header, lines: Vec::new() });
            }
            *seen_hunks.borrow_mut() += 1;
            true
        }),
        Some(&mut |_delta, _hunk, line| {
            if !*in_target.borrow() {
                return true; // skip allocation entirely for lines outside the target hunk
            }
            if matches!(line.origin(), '=' | '>' | '<') {
                return true; // EOFNL marker — see collect_diff's line callback
            }
            let content = String::from_utf8_lossy(line.content()).to_string();
            let kind = match line.origin() {
                '+' => LineKind::Addition,
                '-' => LineKind::Deletion,
                _ => LineKind::Context,
            };
            if let Some(hunk) = target_hunk.borrow_mut().as_mut() {
                hunk.lines.push(DiffLine { kind, content });
            }
            true
        }),
    )?;

    match (file.into_inner(), target_hunk.into_inner()) {
        (Some(f), Some(h)) => Ok(Some((f, h))),
        _ => Ok(None),
    }
}

/// Parse the `@@ -old_start,old_count +new_start,new_count @@` header. Counts
/// are ignored — we recompute those ourselves for the trimmed-down patch.
fn parse_hunk_start(header: &str) -> (u32, u32) {
    let parts: Vec<&str> = header.split_whitespace().collect();
    let old = parts
        .get(1)
        .and_then(|s| s.strip_prefix('-'))
        .and_then(|s| s.split(',').next())
        .and_then(|s| s.parse().ok())
        .unwrap_or(1);
    let new = parts
        .get(2)
        .and_then(|s| s.strip_prefix('+'))
        .and_then(|s| s.split(',').next())
        .and_then(|s| s.parse().ok())
        .unwrap_or(1);
    (old, new)
}

/// Build a minimal unified-diff patch touching only the line at
/// `target_line_index` within `hunk`, applied to the *current index* as the
/// patch's old side.
///
/// `reverse_target = false` (stage): `hunk` is workdir-vs-index — old side is
/// the current index. The target line keeps its role (addition/deletion);
/// other additions are dropped (not staged yet, stay absent), other
/// deletions become context (not removed yet, stay present).
///
/// `reverse_target = true` (unstage): `hunk` is HEAD-vs-index — old side is
/// *not* the current index, the new side is. So the target line's role is
/// flipped (undoing it): an addition becomes a deletion-from-index, a
/// deletion becomes an addition-to-index. Other additions become context
/// (already staged, stay present); other deletions are dropped (already
/// staged-removed, stay absent).
///
/// old_missing/new_missing (the `--- /dev/null` / `+++ /dev/null` markers)
/// are decided from the *trimmed* old_count/new_count computed below, not
/// from `file.status` — `file.status` reflects the whole file relative to
/// HEAD, which is only right when the whole hunk is staged/unstaged in one
/// shot. Staging/unstaging a single line out of a multi-line new-or-deleted
/// file leaves other lines behind as context, so old_count/new_count end up
/// nonzero even though the file's overall status is Added/Deleted — using
/// status directly would assert `/dev/null` while the body still carries
/// real content, producing a patch libgit2 rejects as invalid.
fn build_single_line_patch(file: &FileDiff, hunk: &Hunk, target_line_index: usize, reverse_target: bool) -> String {
    let (old_start, new_start) = parse_hunk_start(&hunk.header);
    let a_path = file.old_path.as_deref().unwrap_or(&file.path);
    let b_path = &file.path;

    let mut old_count = 0u32;
    let mut new_count = 0u32;
    let mut body = String::new();

    // Emit one patch line, then — if this is the real last line of a file
    // lacking a trailing newline (git2 gives us its content without one) —
    // append the unified-diff "no newline at end of file" marker so the
    // patch stays well-formed instead of running straight into whatever
    // follows (or ending the patch text mid-line).
    fn push_patch_line(body: &mut String, prefix: char, content: &str) {
        body.push(prefix);
        body.push_str(content);
        if !content.ends_with('\n') {
            body.push_str("\n\\ No newline at end of file\n");
        }
    }

    for (i, line) in hunk.lines.iter().enumerate() {
        let is_target = i == target_line_index;
        match line.kind {
            LineKind::Context => {
                old_count += 1;
                new_count += 1;
                push_patch_line(&mut body, ' ', &line.content);
            }
            LineKind::Addition => {
                if is_target {
                    if reverse_target {
                        old_count += 1;
                        push_patch_line(&mut body, '-', &line.content);
                    } else {
                        new_count += 1;
                        push_patch_line(&mut body, '+', &line.content);
                    }
                } else if reverse_target {
                    old_count += 1;
                    new_count += 1;
                    push_patch_line(&mut body, ' ', &line.content);
                }
                // else (stage mode, non-target addition): omit — not staged yet.
            }
            LineKind::Deletion => {
                if is_target {
                    if reverse_target {
                        new_count += 1;
                        push_patch_line(&mut body, '+', &line.content);
                    } else {
                        old_count += 1;
                        push_patch_line(&mut body, '-', &line.content);
                    }
                } else if !reverse_target {
                    old_count += 1;
                    new_count += 1;
                    push_patch_line(&mut body, ' ', &line.content);
                }
                // else (unstage mode, non-target deletion): omit — already staged-removed.
            }
        }
    }

    // Zero on a side means literally nothing survived there in the trimmed
    // patch — the only condition that legitimately justifies /dev/null.
    let old_missing = old_count == 0;
    let new_missing = new_count == 0;

    let mut patch = String::new();
    patch.push_str(&format!("diff --git a/{a_path} b/{b_path}\n"));
    if old_missing {
        patch.push_str("new file mode 100644\n");
        patch.push_str("--- /dev/null\n");
    } else {
        patch.push_str(&format!("--- a/{a_path}\n"));
    }
    if new_missing {
        patch.push_str("deleted file mode 100644\n");
        patch.push_str("+++ /dev/null\n");
    } else {
        patch.push_str(&format!("+++ b/{b_path}\n"));
    }
    patch.push_str(&format!("@@ -{old_start},{old_count} +{new_start},{new_count} @@\n"));
    patch.push_str(&body);
    patch
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Repository;
    use std::path::{Path, PathBuf};

    fn make_temp_dir() -> PathBuf {
        let id = uuid::Uuid::new_v4();
        let dir = std::env::temp_dir().join(format!("wpt_diff_test_{}", id));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn make_repo() -> (PathBuf, Repository) {
        let dir = make_temp_dir();
        let repo = Repository::init(&dir).unwrap();
        {
            let mut cfg = repo.config().unwrap();
            cfg.set_str("user.name", "Test User").unwrap();
            cfg.set_str("user.email", "test@example.com").unwrap();
        }
        (dir, repo)
    }

    fn write_commit(repo: &Repository, filename: &str, content: &str, msg: &str) -> git2::Oid {
        let workdir = repo.workdir().unwrap().to_path_buf();
        std::fs::write(workdir.join(filename), content).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(filename)).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let sig = repo.signature().unwrap();
        let parents: Vec<git2::Commit> = match repo.head() {
            Ok(head) => vec![head.peel_to_commit().unwrap()],
            Err(_) => vec![],
        };
        let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parent_refs).unwrap()
    }

    fn read_index_content(repo: &Repository, filename: &str) -> String {
        let index = repo.index().unwrap();
        let entry = index.get_path(Path::new(filename), 0).unwrap();
        let blob = repo.find_blob(entry.id).unwrap();
        String::from_utf8_lossy(blob.content()).to_string()
    }

    #[test]
    fn stage_hunk_applies_only_target_hunk_to_index() {
        let (_dir, repo) = make_repo();
        write_commit(&repo, "file.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven\nEIGHT\nnine\nten\n", "initial");

        // Two separate, non-adjacent edits — two hunks.
        let workdir = repo.workdir().unwrap().to_path_buf();
        std::fs::write(
            &workdir.join("file.txt"),
            "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\nEIGHT\nnine\nTEN\n",
        )
        .unwrap();

        let mut opts = git2::DiffOptions::new();
        opts.pathspec("file.txt");
        let index = repo.index().unwrap();
        let diff = repo.diff_index_to_workdir(Some(&index), Some(&mut opts)).unwrap();
        let files = collect_diff(diff).unwrap();
        assert_eq!(files[0].hunks.len(), 2, "expected two separate hunks from two non-adjacent edits");

        // Stage only the first hunk (the "ONE" edit).
        stage_hunk_impl(&repo, "file.txt", 0, false).unwrap();

        let staged = read_index_content(&repo, "file.txt");
        assert!(staged.starts_with("ONE\n"), "first hunk should be staged: {staged}");
        assert!(staged.ends_with("nine\nten\n"), "second hunk should NOT be staged: {staged}");
    }

    #[test]
    fn unstage_hunk_reverses_only_target_hunk_in_index() {
        let (_dir, repo) = make_repo();
        write_commit(&repo, "file.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven\nEIGHT\nnine\nten\n", "initial");

        // Stage both edits fully (simulate "stage all").
        let workdir = repo.workdir().unwrap().to_path_buf();
        std::fs::write(
            &workdir.join("file.txt"),
            "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\nEIGHT\nnine\nTEN\n",
        )
        .unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("file.txt")).unwrap();
        index.write().unwrap();

        unstage_hunk_impl(&repo, "file.txt", 0, false).unwrap();

        let content = read_index_content(&repo, "file.txt");
        assert!(content.starts_with("one\n"), "first hunk should be unstaged back to HEAD: {content}");
        assert!(content.ends_with("nine\nTEN\n"), "second hunk should remain staged: {content}");
    }

    #[test]
    fn stage_hunk_out_of_range_errors() {
        let (_dir, repo) = make_repo();
        write_commit(&repo, "file.txt", "one\n", "initial");
        std::fs::write(repo.workdir().unwrap().join("file.txt"), "one\ntwo\n").unwrap();

        let result = stage_hunk_impl(&repo, "file.txt", 5, false);
        assert!(result.is_err());
    }

    #[test]
    fn full_file_context_merges_separate_edits_into_one_hunk() {
        let (_dir, repo) = make_repo();
        write_commit(
            &repo,
            "file.txt",
            "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
            "initial",
        );
        std::fs::write(
            repo.workdir().unwrap().join("file.txt"),
            "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n",
        )
        .unwrap();

        // Default context: the two edits are far enough apart to stay separate hunks.
        let default_diff = workdir_file_diff(&repo, "file.txt", false, false).unwrap();
        assert_eq!(default_diff.hunks.len(), 2);

        // Full-file context: same edits, one hunk spanning the whole file.
        let full_diff = workdir_file_diff(&repo, "file.txt", false, true).unwrap();
        assert_eq!(full_diff.hunks.len(), 1);
        assert_eq!(full_diff.hunks[0].lines.len(), 12); // 10 context/changed + 2 extra deletion/addition lines
    }

    #[test]
    fn get_commit_file_diff_full_file_merges_into_one_hunk() {
        let (_dir, repo) = make_repo();
        write_commit(
            &repo,
            "file.txt",
            "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
            "initial",
        );
        let oid = write_commit(
            &repo,
            "file.txt",
            "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n",
            "edit both ends",
        );

        let (commit_tree, parent_tree) = commit_and_parent_tree(&repo, &oid.to_string()).unwrap();
        let mut opts = git2::DiffOptions::new();
        opts.pathspec("file.txt");
        let default_diff = collect_diff(
            repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&commit_tree), Some(&mut opts)).unwrap(),
        )
        .unwrap();
        assert_eq!(default_diff[0].hunks.len(), 2);

        let mut full_opts = git2::DiffOptions::new();
        full_opts.pathspec("file.txt").context_lines(FULL_FILE_CONTEXT_LINES);
        let full_diff = collect_diff(
            repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&commit_tree), Some(&mut full_opts)).unwrap(),
        )
        .unwrap();
        assert_eq!(full_diff[0].hunks.len(), 1);
    }

    #[test]
    fn stage_line_stages_only_the_target_addition() {
        let (_dir, repo) = make_repo();
        write_commit(&repo, "file.txt", "a\nb\nc\nd\ne\n", "initial");
        std::fs::write(repo.workdir().unwrap().join("file.txt"), "a\nB\nC\nd\ne\n").unwrap();

        let default_diff = workdir_file_diff(&repo, "file.txt", false, false).unwrap();
        assert_eq!(default_diff.hunks.len(), 1);
        // context a, deletion b, deletion c, addition B, addition C, context d, context e
        assert_eq!(default_diff.hunks[0].lines.len(), 7);

        stage_line_impl(&repo, "file.txt", 0, 3, false).unwrap(); // addition "B"

        let staged = read_index_content(&repo, "file.txt");
        // b and c are untouched (their deletions weren't targeted), B is
        // inserted alongside them, C (the other addition) stays unstaged.
        assert_eq!(staged, "a\nb\nc\nB\nd\ne\n");
    }

    #[test]
    fn stage_line_stages_only_the_target_deletion() {
        let (_dir, repo) = make_repo();
        write_commit(&repo, "file.txt", "a\nb\nc\nd\ne\n", "initial");
        std::fs::write(repo.workdir().unwrap().join("file.txt"), "a\nB\nC\nd\ne\n").unwrap();

        stage_line_impl(&repo, "file.txt", 0, 1, false).unwrap(); // deletion "b"

        let staged = read_index_content(&repo, "file.txt");
        // Only "b" is removed; "c" and the two additions stay unstaged.
        assert_eq!(staged, "a\nc\nd\ne\n");
    }

    #[test]
    fn unstage_line_reverses_only_the_target_line() {
        let (_dir, repo) = make_repo();
        write_commit(&repo, "file.txt", "a\nb\nc\nd\ne\n", "initial");

        // Stage the full edit (simulate "stage all").
        std::fs::write(repo.workdir().unwrap().join("file.txt"), "a\nB\nC\nd\ne\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("file.txt")).unwrap();
        index.write().unwrap();

        unstage_line_impl(&repo, "file.txt", 0, 3, false).unwrap(); // the staged addition "B"

        let staged = read_index_content(&repo, "file.txt");
        // "B" is pulled back out; "C" (and the original "b"/"c" removal) stay staged.
        assert_eq!(staged, "a\nC\nd\ne\n");
    }

    #[test]
    fn unstage_line_restores_only_the_target_removed_line() {
        let (_dir, repo) = make_repo();
        write_commit(&repo, "file.txt", "a\nb\nc\nd\ne\n", "initial");

        // Stage the full edit (simulate "stage all").
        std::fs::write(repo.workdir().unwrap().join("file.txt"), "a\nB\nC\nd\ne\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("file.txt")).unwrap();
        index.write().unwrap();

        unstage_line_impl(&repo, "file.txt", 0, 1, false).unwrap(); // the staged removal of "b"

        let staged = read_index_content(&repo, "file.txt");
        // "b" reappears; the "B"/"C" additions and the "c" removal stay staged.
        assert_eq!(staged, "a\nb\nB\nC\nd\ne\n");
    }

    #[test]
    fn stage_line_on_context_line_errors() {
        let (_dir, repo) = make_repo();
        write_commit(&repo, "file.txt", "a\nb\nc\n", "initial");
        std::fs::write(repo.workdir().unwrap().join("file.txt"), "a\nB\nc\n").unwrap();

        let result = stage_line_impl(&repo, "file.txt", 0, 0, false); // "a" is context
        assert!(result.is_err());
    }

    #[test]
    fn stage_line_in_full_file_scope_uses_matching_line_numbering() {
        let (_dir, repo) = make_repo();
        write_commit(
            &repo,
            "file.txt",
            "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
            "initial",
        );
        std::fs::write(
            repo.workdir().unwrap().join("file.txt"),
            "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n",
        )
        .unwrap();

        // Sanity check this test's premise: default context keeps the two
        // edits as separate hunks, but full-file context merges them into
        // one — exactly the mismatch that made line_index=1 mean different
        // things in each scope before stage_line/unstage_line took full_file.
        let default_diff = workdir_file_diff(&repo, "file.txt", false, false).unwrap();
        assert_eq!(default_diff.hunks.len(), 2);
        let full_diff = workdir_file_diff(&repo, "file.txt", false, true).unwrap();
        assert_eq!(full_diff.hunks.len(), 1);
        // deletion "one", addition "ONE", 8 context lines, deletion "ten", addition "TEN"
        assert_eq!(full_diff.hunks[0].lines.len(), 12);

        // Stage only the "ONE" addition (line 1 of the single full-context hunk).
        stage_line_impl(&repo, "file.txt", 0, 1, true).unwrap();

        let staged = read_index_content(&repo, "file.txt");
        // "one" is untouched (its deletion wasn't targeted), "ONE" is inserted
        // right after it, and the "ten"/"TEN" edit stays fully unstaged.
        assert_eq!(staged, "one\nONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n");
    }

    #[test]
    fn unstage_line_on_new_multiline_file_does_not_produce_contradictory_patch() {
        let (_dir, repo) = make_repo();
        // A brand-new 3-line file, fully staged — whole-file DiffStatus::Added.
        std::fs::write(repo.workdir().unwrap().join("new.txt"), "line1\nline2\nline3\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("new.txt")).unwrap();
        index.write().unwrap();

        // Unstage only the middle line. Regression test: old_missing used to
        // be derived from file.status (Added -> true), asserting "--- /dev/null"
        // in the header while the body still had context lines from the other
        // two (non-target) lines — a self-contradictory patch that git2
        // rejected with "hunk did not apply".
        unstage_line_impl(&repo, "new.txt", 0, 1, false).unwrap();

        let staged = read_index_content(&repo, "new.txt");
        assert_eq!(staged, "line1\nline3\n");
    }

    #[test]
    fn stage_line_on_deleted_multiline_file_does_not_produce_contradictory_patch() {
        let (_dir, repo) = make_repo();
        write_commit(&repo, "gone.txt", "line1\nline2\nline3\n", "initial");
        std::fs::remove_file(repo.workdir().unwrap().join("gone.txt")).unwrap();

        // Staging only the middle line's removal. Regression test: new_missing
        // used to be derived from file.status (Deleted -> true), asserting
        // "+++ /dev/null" while the body still had context lines surviving on
        // the new side — a self-contradictory patch.
        stage_line_impl(&repo, "gone.txt", 0, 1, false).unwrap();

        let staged = read_index_content(&repo, "gone.txt");
        assert_eq!(staged, "line1\nline3\n");
    }

    #[test]
    fn stage_line_handles_file_without_trailing_newline() {
        let (_dir, repo) = make_repo();
        // No trailing newline on the last line — triggers libgit2's EOFNL
        // marker lines ('=' / '>' / '<' origins). Regression test: these used
        // to be misclassified as ordinary Context lines, corrupting
        // line_index numbering and getting embedded in the constructed patch
        // as invalid "\ No newline..." text, which git2 rejected.
        write_commit(&repo, "file.txt", "a\nb\nc", "initial");
        std::fs::write(repo.workdir().unwrap().join("file.txt"), "a\nB\nc").unwrap();

        let diff = workdir_file_diff(&repo, "file.txt", false, false).unwrap();
        // context a, deletion b, addition B, context c — no phantom EOFNL entries.
        assert_eq!(diff.hunks[0].lines.len(), 4);

        stage_line_impl(&repo, "file.txt", 0, 2, false).unwrap(); // addition "B"

        let staged = read_index_content(&repo, "file.txt");
        assert_eq!(staged, "a\nb\nB\nc");
    }

    #[test]
    fn pathspec_does_not_glob_match_filenames_with_bracket_characters() {
        let (_dir, repo) = make_repo();
        // `[id]` would be interpreted as an fnmatch character class without
        // disable_pathspec_match, causing this exact-name file to not match
        // its own literal pathspec (or, with a differently-shaped sibling
        // filename, to match the wrong file).
        write_commit(&repo, "[id].txt", "one\n", "initial");
        std::fs::write(repo.workdir().unwrap().join("[id].txt"), "one\ntwo\n").unwrap();

        let diff = workdir_file_diff(&repo, "[id].txt", false, false).unwrap();
        assert_eq!(diff.path, "[id].txt");
        assert_eq!(diff.hunks[0].lines.len(), 2);
    }
}
