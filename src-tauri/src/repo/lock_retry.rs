//! Brief retry for git operations that collide with a held lockfile.
//!
//! `git status` (run by editors, terminals, file managers) refreshes the index and
//! holds `.git/index.lock` for a few milliseconds. libgit2 does not wait for the
//! lock: it fails immediately with `GIT_ELOCKED` (code -14, class Index, "the index
//! is locked; ..."). Real git would simply have lost the race too, but a GUI should
//! not surface a transient collision as a failed user action.

use std::time::{Duration, Instant};

use crate::error::{Error, Result};

pub(crate) const MAX_WAIT: Duration = Duration::from_millis(1000);
const FIRST_BACKOFF: Duration = Duration::from_millis(10);
const MAX_BACKOFF: Duration = Duration::from_millis(100);

/// True for a transient lockfile collision:
/// - `ErrorCode::Locked` (GIT_ELOCKED): another process holds `<file>.lock`
///   (libgit2 `lock_file` in `src/util/filebuf.c`, and the index's own check).
/// - class `Os` with "rename lockfile" in the message: on Windows the final
///   `rename(<file>.lock, <file>)` fails while another process has the target open.
///   libgit2 1.9.7 `git_filebuf_commit` (`src/util/filebuf.c`) reports it as
///   `git_error_set(GIT_ERROR_OS, "failed to rename lockfile to '%s'", ...)`,
///   with a generic error code rather than Locked.
fn is_locked(e: &Error) -> bool {
    matches!(e, Error::Git(g)
        if g.code() == git2::ErrorCode::Locked
            || (g.class() == git2::ErrorClass::Os && g.message().contains("rename lockfile")))
}

/// Run `op`, retrying with short backoff for up to `max_wait` (callers pass
/// [`MAX_WAIT`]; tests use short budgets) while it fails with a git lock error.
/// Other errors, and the last lock error, are returned unchanged. `op` must be
/// safe to run again after a failed attempt.
pub(crate) fn retry_on_locked_for<T>(
    max_wait: Duration,
    mut op: impl FnMut() -> Result<T>,
) -> Result<T> {
    let start = Instant::now();
    let mut backoff = FIRST_BACKOFF;
    loop {
        match op() {
            Err(e) if is_locked(&e) && start.elapsed() + backoff <= max_wait => {
                std::thread::sleep(backoff);
                backoff = (backoff * 2).min(MAX_BACKOFF);
            }
            other => return other,
        }
    }
}

/// The repo's index, freshly re-read from disk.
///
/// libgit2 shares one in-memory index between every handle of a cached
/// `Repository`. A command that mutates it and then fails part-way (a path that
/// does not exist, a held lock, ...) leaves that half-applied state behind, and
/// the next command would write it to disk. Every command that reads-then-writes
/// the index therefore starts here, so stale state can never leak between commands.
pub(crate) fn fresh_index(repo: &git2::Repository) -> Result<git2::Index> {
    let mut index = repo.index()?;
    index.read(true)?;
    Ok(index)
}

/// Write `index` to disk, retrying while the index is locked.
pub(crate) fn write_index(index: &mut git2::Index) -> Result<()> {
    write_index_for(MAX_WAIT, index)
}

pub(crate) fn write_index_for(max_wait: Duration, index: &mut git2::Index) -> Result<()> {
    retry_on_locked_for(max_wait, || Ok(index.write()?))
}

/// `git reset <target>` of any kind, retrying while the index is locked. Resets
/// are idempotent, so re-running one is safe.
pub(crate) fn reset_for(
    max_wait: Duration,
    repo: &git2::Repository,
    target: &git2::Object<'_>,
    kind: git2::ResetType,
) -> Result<()> {
    retry_on_locked_for(max_wait, || Ok(repo.reset(target, kind, None)?))
}

pub(crate) fn reset_hard_for(
    max_wait: Duration,
    repo: &git2::Repository,
    target: &git2::Object<'_>,
) -> Result<()> {
    reset_for(max_wait, repo, target, git2::ResetType::Hard)
}

/// `checkout_tree`, retrying while the index is locked (checkout rewrites the
/// index). Re-running skips files the first attempt already brought up to date.
pub(crate) fn checkout_tree_for(
    max_wait: Duration,
    repo: &git2::Repository,
    target: &git2::Object<'_>,
    opts: &mut git2::build::CheckoutBuilder<'_>,
) -> Result<()> {
    retry_on_locked_for(max_wait, || Ok(repo.checkout_tree(target, Some(&mut *opts))?))
}

/// `checkout_head`, retrying while the index is locked.
pub(crate) fn checkout_head_for(
    max_wait: Duration,
    repo: &git2::Repository,
    opts: &mut git2::build::CheckoutBuilder<'_>,
) -> Result<()> {
    retry_on_locked_for(max_wait, || Ok(repo.checkout_head(Some(&mut *opts))?))
}

/// `checkout_index` (restoring working-tree files from `index`), retrying while locked.
pub(crate) fn checkout_index_for(
    max_wait: Duration,
    repo: &git2::Repository,
    index: &mut git2::Index,
    opts: &mut git2::build::CheckoutBuilder<'_>,
) -> Result<()> {
    retry_on_locked_for(max_wait, || Ok(repo.checkout_index(Some(&mut *index), Some(&mut *opts))?))
}

/// Create a commit, retrying while a ref or reflog lock (`refs/heads/<b>.lock`,
/// `HEAD.lock`, the reflog's `.lock`) is held. A retry writes the identical
/// object (same tree, parents, signature) and the ref update is atomic, so it is
/// safe; if HEAD moved meanwhile the failure is not a lock error and is not retried.
pub(crate) fn commit_for(
    max_wait: Duration,
    repo: &git2::Repository,
    update_ref: Option<&str>,
    sig: &git2::Signature<'_>,
    message: &str,
    tree: &git2::Tree<'_>,
    parents: &[&git2::Commit<'_>],
) -> Result<git2::Oid> {
    retry_on_locked_for(max_wait, || Ok(repo.commit(update_ref, sig, sig, message, tree, parents)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn locked() -> Error {
        Error::Git(git2::Error::new(
            git2::ErrorCode::Locked,
            git2::ErrorClass::Index,
            "locked",
        ))
    }

    #[test]
    fn retries_lock_errors_then_succeeds() {
        let mut n = 0;
        let r = retry_on_locked_for(MAX_WAIT, || {
            n += 1;
            if n < 3 { Err(locked()) } else { Ok(n) }
        });
        assert_eq!(r.unwrap(), 3);
    }

    #[test]
    fn does_not_retry_other_errors() {
        let mut n = 0;
        let r: Result<()> = retry_on_locked_for(MAX_WAIT, || {
            n += 1;
            Err(Error::InvalidArg("nope".into()))
        });
        assert!(r.is_err());
        assert_eq!(n, 1);
    }

    #[test]
    fn gives_up_with_the_lock_error() {
        let r: Result<()> = retry_on_locked_for(Duration::from_millis(30), || Err(locked()));
        assert!(is_locked(&r.unwrap_err()));
    }

    fn git_err(code: git2::ErrorCode, class: git2::ErrorClass, msg: &str) -> Error {
        Error::Git(git2::Error::new(code, class, msg))
    }

    #[test]
    fn predicate_matches_locked_and_lockfile_rename_only() {
        use git2::{ErrorClass as C, ErrorCode as K};
        assert!(is_locked(&git_err(K::Locked, C::Index, "the index is locked")));
        assert!(is_locked(&git_err(
            K::GenericError,
            C::Os,
            "failed to rename lockfile to 'C:/r/.git/index': Access is denied."
        )));
        // Os errors unrelated to the lockfile rename are not retried.
        assert!(!is_locked(&git_err(K::GenericError, C::Os, "failed to write file 'x.lock'")));
        assert!(!is_locked(&git_err(K::GenericError, C::Os, "failed to open file")));
        // The rename message in another class is not retried.
        assert!(!is_locked(&git_err(K::GenericError, C::Index, "failed to rename lockfile")));
        assert!(!is_locked(&Error::InvalidArg("failed to rename lockfile".into())));
    }
}
