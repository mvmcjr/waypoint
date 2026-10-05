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

/// True only when the lock was never acquired (`ErrorCode::Locked`), so the failed
/// operation wrote nothing and re-running it cannot duplicate side effects.
/// [`is_locked`] also accepts the Windows rename failure, which happens at the very
/// end of a write, after other files may already have been appended to.
fn is_lock_held(e: &Error) -> bool {
    matches!(e, Error::Git(g) if g.code() == git2::ErrorCode::Locked)
}

/// The retry budget for the current call: [`MAX_WAIT`], except in tests, which can
/// shorten it for the running thread with [`with_budget`].
fn budget() -> Duration {
    #[cfg(test)]
    if let Some(b) = test_budget::get() {
        return b;
    }
    MAX_WAIT
}

#[cfg(test)]
mod test_budget {
    use std::cell::Cell;
    use std::time::Duration;

    thread_local!(static BUDGET: Cell<Option<Duration>> = const { Cell::new(None) });

    pub(super) fn get() -> Option<Duration> {
        BUDGET.with(Cell::get)
    }

    /// Run `f` with every lock retry on this thread limited to `budget`.
    pub(crate) fn with_budget<R>(budget: Duration, f: impl FnOnce() -> R) -> R {
        struct Restore(Option<Duration>);
        impl Drop for Restore {
            fn drop(&mut self) {
                BUDGET.with(|b| b.set(self.0));
            }
        }
        let _restore = Restore(BUDGET.with(|b| b.replace(Some(budget))));
        f()
    }
}

#[cfg(test)]
pub(crate) use test_budget::with_budget;

/// Run `op`, retrying with short backoff for up to the budget ([`MAX_WAIT`]) while
/// it fails with a git lock error. Other errors, and the last lock error, are
/// returned unchanged. `op` must be safe to run again after a failed attempt.
pub(crate) fn retry_on_locked<T>(op: impl FnMut() -> Result<T>) -> Result<T> {
    retry_while(is_locked, op)
}

fn retry_while<T>(retryable: fn(&Error) -> bool, mut op: impl FnMut() -> Result<T>) -> Result<T> {
    let max_wait = budget();
    let start = Instant::now();
    let mut backoff = FIRST_BACKOFF;
    loop {
        match op() {
            Err(e) if retryable(&e) && start.elapsed() + backoff <= max_wait => {
                std::thread::sleep(backoff);
                backoff = (backoff * 2).min(MAX_BACKOFF);
            }
            other => return other,
        }
    }
}

/// Write `index` to disk, retrying while the index is locked.
pub(crate) fn write_index(index: &mut git2::Index) -> Result<()> {
    retry_on_locked(|| Ok(index.write()?))
}

/// `git reset <target>` of any kind, retrying while the index is locked. Resets
/// are idempotent, so re-running one is safe.
pub(crate) fn reset(repo: &git2::Repository, target: &git2::Object<'_>, kind: git2::ResetType) -> Result<()> {
    retry_on_locked(|| Ok(repo.reset(target, kind, None)?))
}

pub(crate) fn reset_hard(repo: &git2::Repository, target: &git2::Object<'_>) -> Result<()> {
    reset(repo, target, git2::ResetType::Hard)
}

/// `checkout_tree`, retrying while the index is locked (checkout rewrites the
/// index). Re-running skips files the first attempt already brought up to date.
pub(crate) fn checkout_tree(
    repo: &git2::Repository,
    target: &git2::Object<'_>,
    opts: &mut git2::build::CheckoutBuilder<'_>,
) -> Result<()> {
    retry_on_locked(|| Ok(repo.checkout_tree(target, Some(&mut *opts))?))
}

/// Create a commit, retrying while a ref or reflog lock (`refs/heads/<b>.lock`,
/// `HEAD.lock`, the reflog's `.lock`) is held. Only `ErrorCode::Locked` is retried:
/// the lock was not acquired, so nothing was written. libgit2 appends the branch and
/// HEAD reflog entries before renaming the ref lockfile, so retrying a failed rename
/// would append them twice. If HEAD moved meanwhile the failure is not a lock error
/// and is not retried.
pub(crate) fn commit(
    repo: &git2::Repository,
    update_ref: Option<&str>,
    sig: &git2::Signature<'_>,
    message: &str,
    tree: &git2::Tree<'_>,
    parents: &[&git2::Commit<'_>],
) -> Result<git2::Oid> {
    retry_while(is_lock_held, || Ok(repo.commit(update_ref, sig, sig, message, tree, parents)?))
}

/// Move `refname` from `old` to `new`, failing if it no longer points at `old`
/// (someone else moved it). Retries like [`commit`], and for the same reason: the
/// reflog entries are appended before the ref lockfile is renamed into place.
pub(crate) fn move_ref(repo: &git2::Repository, refname: &str, new: git2::Oid, old: git2::Oid, msg: &str) -> Result<()> {
    retry_while(is_lock_held, || Ok(repo.reference_matching(refname, new, true, old, msg).map(|_| ())?))
}

/// `set_head`, retrying like [`move_ref`].
pub(crate) fn set_head(repo: &git2::Repository, refname: &str) -> Result<()> {
    retry_while(is_lock_held, || Ok(repo.set_head(refname)?))
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
        let r = retry_on_locked(|| {
            n += 1;
            if n < 3 { Err(locked()) } else { Ok(n) }
        });
        assert_eq!(r.unwrap(), 3);
    }

    #[test]
    fn does_not_retry_other_errors() {
        let mut n = 0;
        let r: Result<()> = retry_on_locked(|| {
            n += 1;
            Err(Error::InvalidArg("nope".into()))
        });
        assert!(r.is_err());
        assert_eq!(n, 1);
    }

    #[test]
    fn gives_up_with_the_lock_error() {
        let r: Result<()> = with_budget(Duration::from_millis(30), || retry_on_locked(|| Err(locked())));
        assert!(is_locked(&r.unwrap_err()));
    }

    fn git_err(code: git2::ErrorCode, class: git2::ErrorClass, msg: &str) -> Error {
        Error::Git(git2::Error::new(code, class, msg))
    }

    #[test]
    fn commit_predicate_retries_only_a_lock_that_was_never_acquired() {
        use git2::{ErrorClass as C, ErrorCode as K};
        let rename = || git_err(K::GenericError, C::Os, "failed to rename lockfile to 'x': Access is denied.");
        assert!(is_locked(&rename()), "index writes still retry the rename failure");
        assert!(!is_lock_held(&rename()), "commit must not retry after the reflog was appended");
        assert!(is_lock_held(&git_err(K::Locked, C::Reference, "locked")));
        assert!(!is_lock_held(&Error::InvalidArg("x".into())));

        let mut n = 0;
        let r: Result<()> = retry_while(is_lock_held, || {
            n += 1;
            Err(rename())
        });
        assert!(r.is_err());
        assert_eq!(n, 1);
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
