//! Text that git stores as raw bytes (commit messages, author names).

use crate::error::Result;

/// Decode git text lossily. git2's `&str` accessors (`Commit::summary`,
/// `Signature::name`, …) fail on non-UTF-8 — e.g. commits made with
/// `i18n.commitEncoding=ISO-8859-1` — which would blank the text entirely.
/// Pair this with the `*_bytes()` accessors instead, so such text stays
/// readable (invalid bytes become U+FFFD). Takes `&[u8]` or `Option<&[u8]>`;
/// `None` (no summary/body) is "".
pub(crate) fn lossy<'a>(bytes: impl Into<Option<&'a [u8]>>) -> String {
    bytes.into().map(|b| String::from_utf8_lossy(b).into_owned()).unwrap_or_default()
}

/// Decodes text belonging to one commit (summary, body, message, signature
/// name/email). Git stores these bytes in the encoding named by the commit's
/// `encoding` header and assumes UTF-8 when there is none. The header is
/// resolved once in [`CommitDecoder::new`] so per-commit work over a whole
/// history stays a single label lookup. Anything that isn't a usable
/// non-UTF-8 declaration (no header, UTF-8, unknown label, the REPLACEMENT
/// encodings, UTF-16 — which git text never is) falls back to [`lossy`].
#[derive(Clone, Copy)]
pub(crate) struct CommitDecoder(Option<&'static encoding_rs::Encoding>);

impl CommitDecoder {
    pub(crate) fn new(commit: &git2::Commit) -> Self {
        let declared = commit
            .message_encoding()
            .ok()
            .flatten()
            .and_then(|label| encoding_rs::Encoding::for_label_no_replacement(label.trim().as_bytes()))
            .filter(|enc| {
                *enc != encoding_rs::UTF_8
                    && *enc != encoding_rs::UTF_16LE
                    && *enc != encoding_rs::UTF_16BE
            });
        Self(declared)
    }

    /// Decode `bytes` (`None` is "").
    pub(crate) fn text<'a>(&self, bytes: impl Into<Option<&'a [u8]>>) -> String {
        let Some(bytes) = bytes.into() else { return String::new() };
        match self.0 {
            Some(enc) => enc.decode_without_bom_handling(bytes).0.into_owned(),
            None => lossy(bytes),
        }
    }

    /// Re-encode `sig` (taken from this decoder's commit) as a UTF-8
    /// signature, for use in a commit written without the original's
    /// `encoding` header.
    pub(crate) fn signature(&self, sig: &git2::Signature) -> Result<git2::Signature<'static>> {
        let name = self.text(sig.name_bytes());
        let email = self.text(sig.email_bytes());
        Ok(git2::Signature::new(&name, &email, &sig.when())?)
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

    fn dec(c: &git2::Commit) -> CommitDecoder {
        CommitDecoder::new(c)
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
    fn decoder_decodes_latin1_header() {
        let (dir, repo) = make_repo();
        let c = repo.find_commit(latin1_commit(&repo)).unwrap();
        assert_eq!(dec(&c).text(c.summary_bytes()), "Corrigé le bug");
        assert_eq!(dec(&c).text(c.body_bytes()), "Détails ici");
        assert!(dec(&c).text(c.message_bytes()).starts_with("Corrigé le bug\n\nDétails ici"));
        assert_eq!(dec(&c).text(c.author().name_bytes()), "André");
        assert_eq!(dec(&c).text(c.author().email_bytes()), "a@example.com");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn decoder_decodes_shift_jis_header() {
        let (dir, repo) = make_repo();
        let (name, _, _) = encoding_rs::SHIFT_JIS.encode("山田");
        let (msg, _, _) = encoding_rs::SHIFT_JIS.encode("日本語の件名\n\n本文です\n");
        let oid = raw_commit(&repo, b"encoding Shift_JIS\n", &name, &msg);
        let c = repo.find_commit(oid).unwrap();
        assert_eq!(dec(&c).text(c.summary_bytes()), "日本語の件名");
        assert_eq!(dec(&c).text(c.body_bytes()), "本文です");
        assert_eq!(dec(&c).text(c.author().name_bytes()), "山田");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn decoder_without_header_stays_lossy() {
        let (dir, repo) = make_repo();
        let oid = raw_commit(&repo, b"", b"Andr\xe9", b"Corrig\xe9 le bug\n");
        let c = repo.find_commit(oid).unwrap();
        assert_eq!(dec(&c).text(c.summary_bytes()), "Corrig\u{FFFD} le bug");
        assert_eq!(dec(&c).text(c.author().name_bytes()), "Andr\u{FFFD}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn decoder_unknown_label_falls_back_to_lossy() {
        let (dir, repo) = make_repo();
        let oid = raw_commit(&repo, b"encoding x-made-up\n", b"Andr\xe9", b"Corrig\xe9 le bug\n");
        let c = repo.find_commit(oid).unwrap();
        assert_eq!(dec(&c).text(c.summary_bytes()), "Corrig\u{FFFD} le bug");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn decoder_utf8_commit_is_unchanged() {
        let (dir, repo) = make_repo();
        let oid = raw_commit(&repo, b"", "André".as_bytes(), "Corrigé le bug\n\nDétails\n".as_bytes());
        let c = repo.find_commit(oid).unwrap();
        assert_eq!(dec(&c).text(c.summary_bytes()), "Corrigé le bug");
        assert_eq!(dec(&c).text(c.body_bytes()), "Détails");
        assert_eq!(dec(&c).text(c.author().name_bytes()), "André");
        assert_eq!(dec(&c).text(None::<&[u8]>), "");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn decoder_replacement_label_falls_back_to_lossy() {
        let (dir, repo) = make_repo();
        for label in ["ISO-2022-KR", "hz-gb-2312", "iso-2022-cn"] {
            let header = format!("encoding {label}
");
            let oid = raw_commit(&repo, header.as_bytes(), b"Andre", b"Fix the bug

Details
");
            let c = repo.find_commit(oid).unwrap();
            assert_eq!(dec(&c).text(c.summary_bytes()), "Fix the bug", "{label}");
            assert_eq!(dec(&c).text(c.author().name_bytes()), "Andre", "{label}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn decoder_utf16_label_falls_back_to_lossy() {
        let (dir, repo) = make_repo();
        for label in ["utf-16", "UTF-16LE", "UTF-16BE"] {
            let header = format!("encoding {label}
");
            let oid = raw_commit(&repo, header.as_bytes(), b"Andre", b"Fix the bug
");
            let c = repo.find_commit(oid).unwrap();
            assert_eq!(dec(&c).text(c.summary_bytes()), "Fix the bug", "{label}");
            assert_eq!(dec(&c).text(c.author().name_bytes()), "Andre", "{label}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn decoder_signature_is_utf8_and_keeps_time() {
        let (dir, repo) = make_repo();
        let c = repo.find_commit(latin1_commit(&repo)).unwrap();
        let sig = dec(&c).signature(&c.author()).unwrap();
        assert_eq!(sig.name(), Ok("André"));
        assert_eq!(sig.email(), Ok("a@example.com"));
        assert_eq!(sig.when(), c.author().when());
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
