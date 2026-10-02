use serde::Serialize;
use crate::git_text::lossy;
use tauri::State;

use crate::error::{Error, Result};
use crate::repo::RepoState;

#[derive(Debug, Serialize)]
pub struct StashEntry {
    pub index: usize,
    pub message: String,
    pub oid: String,
    pub branch: Option<String>,
}

/// Branch a stash was made on, from git's message: "WIP on <b>: …" or "On <b>: …".
/// A detached-HEAD stash has no branch — git spells that "(no branch)", which maps to `None`.
pub(crate) fn parse_stash_branch(message: &str) -> Option<String> {
    let rest = message.strip_prefix("WIP on ").or_else(|| message.strip_prefix("On "))?;
    let branch = rest.split_once(':')?.0.trim();
    (!branch.is_empty() && branch != "(no branch)").then(|| branch.to_owned())
}

/// Mirror the git CLI's automatic stash message: "WIP on <branch>: <short-oid> <summary>".
fn default_stash_message(repo: &git2::Repository) -> Result<String> {
    let head = repo.head()?;
    // Detached HEAD's shorthand is literally "HEAD"; git says "(no branch)",
    // which is also what parse_stash_branch recognises as branchless.
    let branch = if head.is_branch() {
        lossy(Some(head.shorthand_bytes()))
    } else {
        "(no branch)".to_owned()
    };
    let commit = head.peel_to_commit()?;
    let short = &commit.id().to_string()[..7];
    let summary = lossy(commit.summary_bytes()).chars().take(50).collect::<String>();
    Ok(format!("WIP on {}: {} {}", branch, short, summary))
}

/// Save staged + unstaged changes as a new stash entry.
/// If `message` is blank an automatic message is generated from the branch and HEAD commit.
#[tauri::command]
pub fn stash_push(repo_id: String, message: String, state: State<RepoState>) -> Result<()> {
    let mut repos = state.0.lock().unwrap();
    let repo = repos.get_mut(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let sig = repo.signature()?;

    let msg = if message.trim().is_empty() {
        default_stash_message(repo)?
    } else {
        message
    };

    repo.stash_save(&sig, &msg, Some(git2::StashFlags::DEFAULT))?;
    Ok(())
}

/// Return all stash entries, newest first (index 0 = most recent).
#[tauri::command]
pub fn list_stashes(repo_id: String, state: State<RepoState>) -> Result<Vec<StashEntry>> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
    stash_entries(repo)
}

/// All stash entries, newest first (index 0 = stash@{0}). Reads the
/// `refs/stash` reflog directly — the same data `git2::Repository::stash_foreach`
/// walks — because stash_foreach unwraps each message as UTF-8 and panics on
/// stashes `git stash` made on non-UTF-8 (e.g. Latin-1) commits.
fn stash_entries(repo: &git2::Repository) -> Result<Vec<StashEntry>> {
    if repo.find_reference("refs/stash").is_err() {
        return Ok(Vec::new());
    }
    let stashes = repo
        .reflog("refs/stash")?
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let message = lossy(entry.message_bytes());
            StashEntry {
                index,
                branch: parse_stash_branch(&message),
                message,
                oid: entry.id_new().to_string(),
            }
        })
        .collect();
    Ok(stashes)
}

/// Find the current stash-list index of the stash with the given OID, if it's
/// still there. Indices are newest-first, same as `pop_stash`/`list_stashes`.
pub(crate) fn find_stash_index_by_oid(repo: &git2::Repository, oid: git2::Oid) -> Option<usize> {
    let oid = oid.to_string();
    stash_entries(repo).ok()?.into_iter().find(|s| s.oid == oid).map(|s| s.index)
}

/// Resolve the stash list index to act on. `oid` (when given) is authoritative:
/// stashes are addressed by identity, not position, because a stash pushed by
/// another agent/worktree while a confirm dialog is open shifts every later
/// index — acting on a stale index would silently hit the wrong stash. `index`
/// is accepted only as a fallback for callers that don't have an OID.
fn resolve_stash_index(repo: &mut git2::Repository, oid: Option<String>, index: Option<usize>) -> Result<usize> {
    if let Some(oid_str) = oid {
        let git_oid = git2::Oid::from_str(&oid_str)
            .map_err(|_| Error::InvalidArg("That stash no longer exists.".into()))?;
        return find_stash_index_by_oid(repo, git_oid)
            .ok_or_else(|| Error::InvalidArg("That stash no longer exists.".into()));
    }
    index.ok_or_else(|| Error::InvalidArg("No stash specified.".into()))
}

/// Apply a stash and remove it from the stash list. Addressed by `oid` (preferred)
/// or `index` (fallback for callers without an OID).
#[tauri::command]
pub fn pop_stash(repo_id: String, oid: Option<String>, index: Option<usize>, state: State<RepoState>) -> Result<()> {
    let mut repos = state.0.lock().unwrap();
    let repo = repos.get_mut(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
    let idx = resolve_stash_index(repo, oid, index)?;
    repo.stash_apply(idx, None)?;
    repo.stash_drop(idx)?;
    Ok(())
}

/// Apply a stash but keep it in the stash list. Addressed by `oid` (preferred)
/// or `index` (fallback for callers without an OID).
#[tauri::command]
pub fn apply_stash(repo_id: String, oid: Option<String>, index: Option<usize>, state: State<RepoState>) -> Result<()> {
    let mut repos = state.0.lock().unwrap();
    let repo = repos.get_mut(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
    let idx = resolve_stash_index(repo, oid, index)?;
    repo.stash_apply(idx, None)?;
    Ok(())
}

/// Remove a stash without applying it. Addressed by `oid` (preferred) or
/// `index` (fallback for callers without an OID).
#[tauri::command]
pub fn drop_stash(repo_id: String, oid: Option<String>, index: Option<usize>, state: State<RepoState>) -> Result<()> {
    let mut repos = state.0.lock().unwrap();
    let repo = repos.get_mut(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
    let idx = resolve_stash_index(repo, oid, index)?;
    repo.stash_drop(idx)?;
    Ok(())
}

/// Rename the stash at `index` by rewriting its message in the refs/stash reflog.
/// Git has no native stash-rename, so we edit the reflog entry's message in place
/// (preserving the stash's oids, order, and index).
#[tauri::command]
pub fn rename_stash(repo_id: String, index: usize, message: String, state: State<RepoState>) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let new_message = message.trim();
    if new_message.is_empty() {
        return Err(Error::InvalidArg("Stash name cannot be empty.".into()));
    }
    if new_message.contains('\n') {
        return Err(Error::InvalidArg("Stash name cannot contain newlines.".into()));
    }

    // The reflog file is chronological (oldest first); stash@{0} is the last line.
    // Use the common dir (not repo.path()) so this also works in linked worktrees,
    // where refs/stash lives in the shared git directory.
    let path = repo.commondir().join("logs").join("refs").join("stash");
    let content = std::fs::read_to_string(&path)
        .map_err(|e| Error::InvalidArg(format!("Cannot read stash reflog: {}", e)))?;

    let mut lines: Vec<String> = content.lines().map(|l| l.to_owned()).collect();
    let target = lines
        .len()
        .checked_sub(index + 1)
        .ok_or_else(|| Error::InvalidArg(format!("No stash at index {}", index)))?;

    // Each line is "<old> <new> <name> <email> <time> <tz>\t<message>".
    let tab = lines[target]
        .find('\t')
        .ok_or_else(|| Error::InvalidArg("Malformed stash reflog entry.".into()))?;
    lines[target] = format!("{}\t{}", &lines[target][..tab], new_message);

    let mut out = lines.join("\n");
    out.push('\n');
    std::fs::write(&path, out)
        .map_err(|e| Error::InvalidArg(format!("Cannot write stash reflog: {}", e)))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Repository;
    use std::path::{Path, PathBuf};

    #[test]
    fn parses_both_git_stash_message_formats() {
        assert_eq!(parse_stash_branch("WIP on main: abc1234 msg").as_deref(), Some("main"));
        assert_eq!(parse_stash_branch("On feat/x: my stash").as_deref(), Some("feat/x"));
        assert_eq!(parse_stash_branch("On master: WIP on master: 436fca2 docs").as_deref(), Some("master"));
        assert_eq!(parse_stash_branch("random text"), None);
        assert_eq!(parse_stash_branch("On : empty"), None);
    }

    #[test]
    fn detached_head_stash_has_no_branch() {
        assert_eq!(parse_stash_branch("WIP on (no branch): abc1234 msg"), None);
        assert_eq!(parse_stash_branch("On (no branch): msg"), None);
    }

    fn make_temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wpt_stash_{}", uuid::Uuid::new_v4()));
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
        std::fs::write(dir.join("a.txt"), "line0\n").unwrap();
        {
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("a.txt")).unwrap();
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            let sig = repo.signature().unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "initial", &tree, &[]).unwrap();
        }
        (dir, repo)
    }

    #[test]
    fn default_stash_message_names_the_branch() {
        let (dir, repo) = make_repo();
        let branch = repo.head().unwrap().shorthand().unwrap().to_owned();
        let msg = default_stash_message(&repo).unwrap();
        assert!(msg.starts_with(&format!("WIP on {branch}: ")), "{msg}");
        assert!(msg.ends_with(" initial"), "{msg}");
        assert_eq!(parse_stash_branch(&msg).as_deref(), Some(branch.as_str()));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Detached HEAD: git writes "WIP on (no branch): …". Using the ref
    /// shorthand instead produced "WIP on HEAD: …", which parse_stash_branch
    /// then reported as a branch literally named "HEAD".
    #[test]
    fn default_stash_message_on_detached_head_has_no_branch() {
        let (dir, repo) = make_repo();
        let head_oid = repo.head().unwrap().target().unwrap();
        repo.set_head_detached(head_oid).unwrap();
        let msg = default_stash_message(&repo).unwrap();
        assert!(msg.starts_with("WIP on (no branch): "), "{msg}");
        assert_eq!(parse_stash_branch(&msg), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// `git stash` on a Latin-1 commit writes a non-UTF-8 reflog message.
    /// git2's `stash_foreach` unwraps `to_str()` on it and panics — inside a
    /// command holding the RepoState lock, poisoning it for every repo.
    #[test]
    fn lists_stashes_with_non_utf8_messages() {
        let (dir, mut repo) = make_repo();
        std::fs::write(dir.join("a.txt"), "changed\n").unwrap();
        let sig = repo.signature().unwrap();
        let oid = repo.stash_save(&sig, "PLACEHOLDER", None).unwrap();
        let log = repo.path().join("logs").join("refs").join("stash");
        let raw = std::fs::read(&log).unwrap();
        let at = raw.windows(11).position(|w| w == b"PLACEHOLDER").unwrap();
        let mut patched = raw[..at].to_vec();
        patched.extend_from_slice(b"Corrig\xe9");
        patched.extend_from_slice(&raw[at + 11..]);
        std::fs::write(&log, patched).unwrap();

        let stashes = stash_entries(&repo).unwrap();
        assert_eq!(stashes.len(), 1);
        assert_eq!(stashes[0].index, 0);
        assert_eq!(stashes[0].oid, oid.to_string());
        assert!(stashes[0].message.ends_with(": Corrig\u{FFFD}"), "{}", stashes[0].message);
        assert_eq!(find_stash_index_by_oid(&repo, oid), Some(0));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn no_stashes_lists_empty() {
        let (dir, repo) = make_repo();
        assert!(stash_entries(&repo).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Popping by OID must hit the right stash even after the stash list has
    /// shifted underneath it (another push landed at index 0), the exact
    /// scenario a stash-while-confirm-dialog-is-open race produces. Exercises
    /// `resolve_stash_index` + apply/drop the same way `pop_stash` does
    /// internally (the `#[tauri::command]` wrapper itself needs a live
    /// `State<RepoState>`, so the underlying logic is tested directly).
    #[test]
    fn pop_by_oid_targets_the_right_stash_even_after_the_list_shifts() {
        let (dir, mut repo) = make_repo();

        std::fs::write(dir.join("a.txt"), "stash A\n").unwrap();
        let sig = repo.signature().unwrap();
        let oid_a = repo.stash_save(&sig, "stash A", None).unwrap();

        std::fs::write(dir.join("a.txt"), "stash B\n").unwrap();
        let _oid_b = repo.stash_save(&sig, "stash B", None).unwrap();
        // B is now index 0, A is index 1 — the reverse of when A was created.

        let idx = resolve_stash_index(&mut repo, Some(oid_a.to_string()), None).unwrap();
        repo.stash_apply(idx, None).unwrap();
        repo.stash_drop(idx).unwrap();

        assert_eq!(
            std::fs::read_to_string(dir.join("a.txt")).unwrap().trim_end(),
            "stash A",
            "A's changes must be applied"
        );

        let mut remaining = Vec::new();
        repo.stash_foreach(|index, message, _oid| {
            remaining.push((index, message.to_string()));
            true
        }).unwrap();
        assert_eq!(remaining.len(), 1, "B must still be in the list: {:?}", remaining);
        assert!(remaining[0].1.contains("stash B"), "unexpected message: {}", remaining[0].1);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn resolve_stash_index_errors_on_unknown_oid() {
        let (dir, mut repo) = make_repo();
        std::fs::write(dir.join("a.txt"), "stash A\n").unwrap();
        let sig = repo.signature().unwrap();
        repo.stash_save(&sig, "stash A", None).unwrap();

        let unknown = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef".to_string();
        let err = resolve_stash_index(&mut repo, Some(unknown), None).unwrap_err();
        match err {
            Error::InvalidArg(msg) => assert_eq!(msg, "That stash no longer exists."),
            other => panic!("expected InvalidArg, got {:?}", other),
        }

        let _ = std::fs::remove_dir_all(dir);
    }
}
