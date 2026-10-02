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

/// Decode text belonging to `commit` (summary, body, message, signature
/// name/email). Git stores these bytes in the encoding named by the commit's
/// `encoding` header and assumes UTF-8 when there is none, so decode per the
/// header when it names a known non-UTF-8 encoding; otherwise (no header,
/// UTF-8, unknown label) fall back to [`lossy`]. `None` is "".
pub(crate) fn commit_text<'a>(
    commit: &git2::Commit,
    bytes: impl Into<Option<&'a [u8]>>,
) -> String {
    let Some(bytes) = bytes.into() else { return String::new() };
    let declared = commit
        .message_encoding()
        .ok()
        .flatten()
        .and_then(|label| encoding_rs::Encoding::for_label(label.trim().as_bytes()))
        .filter(|enc| *enc != encoding_rs::UTF_8);
    match declared {
        Some(enc) => enc.decode_without_bom_handling(bytes).0.into_owned(),
        None => lossy(bytes),
    }
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

    fn raw_commit(repo: &Repository, header: &[u8], name: &[u8], msg: &[u8]) -> git2::Oid {
        let tree = repo.treebuilder(None).unwrap().write().unwrap();
        let mut raw = format!("tree {tree}\n").into_bytes();
        for who in ["author", "committer"] {
            raw.extend_from_slice(who.as_bytes());
            raw.extend_from_slice(b" ");
            raw.extend_from_slice(name);
            raw.extend_from_slice(b" <a@example.com> 0 +0000\n");
        }
        raw.extend_from_slice(header);
        raw.extend_from_slice(b"\n");
        raw.extend_from_slice(msg);
        repo.odb().unwrap().write(ObjectType::Commit, &raw).unwrap()
    }

    #[test]
    fn commit_text_decodes_latin1_header() {
        let (dir, repo) = make_repo();
        let c = repo.find_commit(latin1_commit(&repo)).unwrap();
        assert_eq!(commit_text(&c, c.summary_bytes()), "Corrigé le bug");
        assert_eq!(commit_text(&c, c.body_bytes()), "Détails ici");
        assert!(commit_text(&c, c.message_bytes()).starts_with("Corrigé le bug\n\nDétails ici"));
        assert_eq!(commit_text(&c, c.author().name_bytes()), "André");
        assert_eq!(commit_text(&c, c.author().email_bytes()), "a@example.com");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn commit_text_decodes_shift_jis_header() {
        let (dir, repo) = make_repo();
        let (name, _, _) = encoding_rs::SHIFT_JIS.encode("山田");
        let (msg, _, _) = encoding_rs::SHIFT_JIS.encode("日本語の件名\n\n本文です\n");
        let oid = raw_commit(&repo, b"encoding Shift_JIS\n", &name, &msg);
        let c = repo.find_commit(oid).unwrap();
        assert_eq!(commit_text(&c, c.summary_bytes()), "日本語の件名");
        assert_eq!(commit_text(&c, c.body_bytes()), "本文です");
        assert_eq!(commit_text(&c, c.author().name_bytes()), "山田");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn commit_text_without_header_stays_lossy() {
        let (dir, repo) = make_repo();
        let oid = raw_commit(&repo, b"", b"Andr\xe9", b"Corrig\xe9 le bug\n");
        let c = repo.find_commit(oid).unwrap();
        assert_eq!(commit_text(&c, c.summary_bytes()), "Corrig\u{FFFD} le bug");
        assert_eq!(commit_text(&c, c.author().name_bytes()), "Andr\u{FFFD}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn commit_text_unknown_label_falls_back_to_lossy() {
        let (dir, repo) = make_repo();
        let oid = raw_commit(&repo, b"encoding x-made-up\n", b"Andr\xe9", b"Corrig\xe9 le bug\n");
        let c = repo.find_commit(oid).unwrap();
        assert_eq!(commit_text(&c, c.summary_bytes()), "Corrig\u{FFFD} le bug");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn commit_text_utf8_commit_is_unchanged() {
        let (dir, repo) = make_repo();
        let oid = raw_commit(&repo, b"", "André".as_bytes(), "Corrigé le bug\n\nDétails\n".as_bytes());
        let c = repo.find_commit(oid).unwrap();
        assert_eq!(commit_text(&c, c.summary_bytes()), "Corrigé le bug");
        assert_eq!(commit_text(&c, c.body_bytes()), "Détails");
        assert_eq!(commit_text(&c, c.author().name_bytes()), "André");
        assert_eq!(commit_text(&c, None::<&[u8]>), "");
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
