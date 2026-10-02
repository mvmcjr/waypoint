//! Text that git stores as raw bytes (commit messages, author names).

/// Decode git text lossily. git2's `&str` accessors (`Commit::summary`,
/// `Signature::name`, …) fail on non-UTF-8 — e.g. commits made with
/// `i18n.commitEncoding=ISO-8859-1` — which would blank the text entirely.
/// Pair this with the `*_bytes()` accessors instead, so such text stays
/// readable (invalid bytes become U+FFFD). Takes `&[u8]` or `Option<&[u8]>`;
/// `None` (no summary/body) is "".
pub(crate) fn lossy<'a>(bytes: impl Into<Option<&'a [u8]>>) -> String {
    bytes.into().map(|b| String::from_utf8_lossy(b).into_owned()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::test_support::make_temp_dir;
    use git2::{ObjectType, Repository};
    use std::path::PathBuf;

    fn make_repo() -> (PathBuf, Repository) {
        let dir = make_temp_dir("git_text");
        let repo = Repository::init(&dir).unwrap();
        (dir, repo)
    }

    /// A commit written by a legacy tool with `i18n.commitEncoding=ISO-8859-1`:
    /// the message and author name are Latin-1 bytes, not UTF-8.
    fn latin1_commit(repo: &Repository) -> git2::Oid {
        let tree = repo.treebuilder(None).unwrap().write().unwrap();
        let mut raw = format!("tree {tree}\n").into_bytes();
        raw.extend_from_slice(b"author Andr\xe9 <a@example.com> 0 +0000\n");
        raw.extend_from_slice(b"committer Andr\xe9 <a@example.com> 0 +0000\n");
        raw.extend_from_slice(b"encoding ISO-8859-1\n\n");
        raw.extend_from_slice(b"Corrig\xe9 le bug\n\nD\xe9tails ici\n");
        repo.odb().unwrap().write(ObjectType::Commit, &raw).unwrap()
    }

    #[test]
    fn keeps_non_utf8_commit_text_instead_of_blanking_it() {
        let (dir, repo) = make_repo();
        let commit = repo.find_commit(latin1_commit(&repo)).unwrap();

        // git2's &str accessors refuse non-UTF-8 — the bug this module exists for.
        assert!(commit.summary().is_err());

        assert_eq!(lossy(commit.summary_bytes()), "Corrig\u{FFFD} le bug");
        assert_eq!(lossy(commit.body_bytes()), "D\u{FFFD}tails ici");
        assert!(lossy(commit.message_bytes()).starts_with("Corrig\u{FFFD} le bug"));
        assert_eq!(lossy(commit.author().name_bytes()), "Andr\u{FFFD}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_text_is_empty() {
        assert_eq!(lossy(None::<&[u8]>), "");
    }

    #[test]
    fn utf8_text_is_unchanged() {
        assert_eq!(lossy("Corrigé".as_bytes()), "Corrigé");
    }
}
