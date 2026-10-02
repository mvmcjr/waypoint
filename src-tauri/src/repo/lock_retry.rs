//! Brief retry for git operations that collide with a held lockfile.
//!
//! `git status` (run by editors, terminals, file managers) refreshes the index and
//! holds `.git/index.lock` for a few milliseconds. libgit2 does not wait for the
//! lock: it fails immediately with `GIT_ELOCKED` (code -14, class Index, "the index
//! is locked; ..."). Real git would simply have lost the race too, but a GUI should
//! not surface a transient collision as a failed user action.

use std::time::{Duration, Instant};

use crate::error::{Error, Result};

const MAX_WAIT: Duration = Duration::from_millis(1000);
const FIRST_BACKOFF: Duration = Duration::from_millis(10);
const MAX_BACKOFF: Duration = Duration::from_millis(100);

fn is_locked(e: &Error) -> bool {
    matches!(e, Error::Git(g) if g.code() == git2::ErrorCode::Locked)
}

/// Run `op`, retrying with short backoff (up to ~1 s total) while it fails with a
/// git lock error. Other errors, and the last lock error, are returned unchanged.
/// `op` must be safe to run again after a failed attempt.
pub(crate) fn retry_on_locked<T>(mut op: impl FnMut() -> Result<T>) -> Result<T> {
    let start = Instant::now();
    let mut backoff = FIRST_BACKOFF;
    loop {
        match op() {
            Err(e) if is_locked(&e) && start.elapsed() + backoff <= MAX_WAIT => {
                std::thread::sleep(backoff);
                backoff = (backoff * 2).min(MAX_BACKOFF);
            }
            other => return other,
        }
    }
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
        let r: Result<()> = retry_on_locked(|| Err(locked()));
        assert!(is_locked(&r.unwrap_err()));
    }
}
