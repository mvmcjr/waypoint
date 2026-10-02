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

/// Write `index` to disk, retrying while the index is locked. If the write still
/// fails, the in-memory index (which libgit2 shares with every handle of the cached
/// `Repository`) is reloaded from disk so a later write cannot persist half-applied
/// changes. The original write error is returned.
pub(crate) fn write_index(index: &mut git2::Index) -> Result<()> {
    write_index_for(MAX_WAIT, index)
}

pub(crate) fn write_index_for(max_wait: Duration, index: &mut git2::Index) -> Result<()> {
    let r = retry_on_locked_for(max_wait, || Ok(index.write()?));
    if r.is_err() {
        let _ = index.read(true);
    }
    r
}

/// `git reset --hard <target>`, retrying while the index is locked. A hard reset is
/// idempotent so re-running it is safe. On final failure the index is reloaded from
/// disk (see [`write_index`]).
pub(crate) fn reset_hard_for(
    max_wait: Duration,
    repo: &git2::Repository,
    target: &git2::Object<'_>,
) -> Result<()> {
    let r = retry_on_locked_for(max_wait, || {
        Ok(repo.reset(target, git2::ResetType::Hard, None)?)
    });
    if r.is_err() {
        if let Ok(mut index) = repo.index() {
            let _ = index.read(true);
        }
    }
    r
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
