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

/// Decodes text belonging to one commit (summary, body, message, signature
/// name/email). Git stores these bytes in the encoding named by the commit's
/// `encoding` header and assumes UTF-8 when there is none. The header is
/// resolved once in [`CommitDecoder::new`] so per-commit work over a whole
/// history stays a single label lookup. Anything that isn't a usable
/// non-UTF-8 declaration (no header, UTF-8, unknown label, the REPLACEMENT
/// encodings, UTF-16 — which git text never is) falls back to [`lossy`].
#[derive(Clone, Copy)]
pub(crate) struct CommitDecoder(Declared);

impl CommitDecoder {
    pub(crate) fn new(commit: &git2::Commit) -> Self {
        Self(Declared::of(commit))
    }

    /// Decode `bytes` (`None` is "").
    pub(crate) fn text<'a>(&self, bytes: impl Into<Option<&'a [u8]>>) -> String {
        match bytes.into() {
            Some(bytes) => self.0.decode(bytes),
            None => String::new(),
        }
    }
}

/// The text encoding a commit declares in its `encoding` header.
#[derive(Clone, Copy)]
enum Declared {
    /// No header, UTF-8, US-ASCII, or anything unusable: bytes are taken as-is.
    /// (For US-ASCII that is also what git ends up with: valid ASCII is already
    /// UTF-8 and iconv rejects anything else, leaving the raw bytes.)
    None,
    /// An `ISO-8859-N` family label that the WHATWG standard (encoding_rs)
    /// maps to a `windows-125x`/`874` superset: ISO-8859-1 -> windows-1252,
    /// ISO-8859-9 -> windows-1254, ISO-8859-11 -> windows-874. The supersets
    /// only differ from the ISO charsets in 0x80-0x9F, where the ISO charset
    /// (and so iconv, which git uses) has the C1 controls U+0080-U+009F. Those
    /// bytes are decoded byte-for-byte; the rest goes through the mapped codec.
    IsoOverWindows(&'static encoding_rs::Encoding),
    Other(&'static encoding_rs::Encoding),
}

/// Labels iconv resolves to ISO-8859-1 that WHATWG doesn't know.
const LATIN1_EXTRA_LABELS: &[&str] = &["latin-1", "iso_8859-1:1987"];

/// Labels iconv resolves to US-ASCII.
const ASCII_LABELS: &[&str] = &[
    "us-ascii", "ascii", "ansi_x3.4-1968", "ansi_x3.4-1986", "iso646-us", "iso_646.irv:1991",
    "iso-ir-6", "us", "cp367", "ibm367", "csascii", "646",
];

/// iconv aliases encoding_rs (WHATWG) lacks, with the encoding they denote.
fn iconv_alias(label: &str) -> Option<&'static encoding_rs::Encoding> {
    Some(match label {
        "cp932" => encoding_rs::SHIFT_JIS,
        "cp936" | "ms936" => encoding_rs::GBK,
        "cp949" | "uhc" => encoding_rs::EUC_KR,
        "cp950" => encoding_rs::BIG5,
        "cp874" => encoding_rs::WINDOWS_874,
        "eucjp" | "ujis" => encoding_rs::EUC_JP,
        "euckr" => encoding_rs::EUC_KR,
        _ => return None,
    })
}

impl Declared {
    fn of(commit: &git2::Commit) -> Self {
        let Some(label) = commit.message_encoding().ok().flatten() else { return Self::None };
        Self::from_label(label.trim())
    }

    fn from_label(label: &str) -> Self {
        let lower = label.to_ascii_lowercase();
        if ASCII_LABELS.contains(&lower.as_str()) {
            return Self::None;
        }
        if LATIN1_EXTRA_LABELS.contains(&lower.as_str()) {
            return Self::IsoOverWindows(encoding_rs::WINDOWS_1252);
        }
        let enc = iconv_alias(&lower)
            .or_else(|| encoding_rs::Encoding::for_label_no_replacement(lower.as_bytes()));
        let Some(enc) = enc else { return Self::None };
        if enc == encoding_rs::UTF_8 || enc == encoding_rs::UTF_16LE || enc == encoding_rs::UTF_16BE {
            return Self::None;
        }
        let windows_superset = enc == encoding_rs::WINDOWS_1252
            || enc == encoding_rs::WINDOWS_1254
            || enc == encoding_rs::WINDOWS_874;
        // Only the ISO spellings are remapped; `windows-1252` & co. really do
        // mean the windows charset (cp1252 glyphs in 0x80-0x9F).
        let genuinely_windows = ["windows-", "x-cp", "cp12", "cp874", "dos-874"]
            .iter()
            .any(|p| lower.starts_with(p));
        if windows_superset && !genuinely_windows {
            Self::IsoOverWindows(enc)
        } else {
            Self::Other(enc)
        }
    }

    /// Lossy decoding for display.
    fn decode(self, bytes: &[u8]) -> String {
        match self {
            Self::None => lossy(bytes),
            Self::IsoOverWindows(enc) => decode_iso_over_windows(enc, bytes, false).unwrap_or_default(),
            Self::Other(enc) => enc.decode_without_bom_handling(bytes).0.into_owned(),
        }
    }

    /// Strict conversion to UTF-8 the way git's iconv does: `None` when there
    /// is nothing to convert or the bytes aren't valid in the declared
    /// encoding (git then keeps them raw).
    fn to_utf8(self, bytes: &[u8]) -> Option<Vec<u8>> {
        match self {
            Self::None => None,
            Self::IsoOverWindows(enc) => decode_iso_over_windows(enc, bytes, true).map(String::into_bytes),
            Self::Other(enc) => enc
                .decode_without_bom_handling_and_without_replacement(bytes)
                .map(|s| s.into_owned().into_bytes()),
        }
    }
}

/// Decode single-byte `bytes` with `enc` except 0x80-0x9F, which become the C1
/// controls U+0080-U+009F. `strict` fails on bytes `enc` can't map; otherwise
/// they become U+FFFD.
fn decode_iso_over_windows(enc: &'static encoding_rs::Encoding, bytes: &[u8], strict: bool) -> Option<String> {
    let mut out = String::with_capacity(bytes.len());
    let mut rest = bytes;
    while !rest.is_empty() {
        let c1 = rest.iter().position(|b| (0x80..=0x9F).contains(b));
        let (run, tail) = rest.split_at(c1.unwrap_or(rest.len()));
        if strict {
            out.push_str(&enc.decode_without_bom_handling_and_without_replacement(run)?);
        } else {
            out.push_str(&enc.decode_without_bom_handling(run).0);
        }
        match tail.split_first() {
            Some((&b, after)) => {
                out.push(b as char);
                rest = after;
            }
            None => break,
        }
    }
    Some(out)
}

/// The author line value and message of a commit, as UTF-8 bytes ready to go
/// into a rewritten commit.
pub(crate) struct Transcoded {
    /// `name <email> seconds ±hhmm`, without the leading `author `.
    pub author: Vec<u8>,
    pub message: Vec<u8>,
}

/// What git does when it rewrites a commit (`commit --amend`, rebase, reword,
/// cherry-pick): it reads the original through `logmsg_reencode`, which
/// converts the WHOLE raw buffer (author line + message) from the commit's
/// declared `encoding` to UTF-8 with iconv — no validation of names, so empty
/// names and emails survive — and writes the result with no `encoding`
/// header. Commits without a usable declaration are copied byte for byte.
pub(crate) fn transcode_for_rewrite(commit: &git2::Commit) -> Transcoded {
    let author = raw_author_line(commit);
    let message = commit.message_bytes().to_vec();
    let declared = Declared::of(commit);
    // iconv converts one buffer: if any of it is invalid, all of it stays raw.
    match (declared.to_utf8(&author), declared.to_utf8(&message)) {
        (Some(author), Some(message)) => Transcoded { author, message },
        _ => Transcoded { author, message },
    }
}

/// The value of the commit's `author` header, byte for byte.
fn raw_author_line(commit: &git2::Commit) -> Vec<u8> {
    commit
        .raw_header_bytes()
        .split(|&b| b == b'\n')
        .find_map(|line| line.strip_prefix(b"author "))
        .map(<[u8]>::to_vec)
        .unwrap_or_default()
}

/// Write a commit object by hand: `tree`, `parent`s, the given raw `author`
/// line value, `committer` from `committer`, a blank line and `message`
/// verbatim. No `encoding` header and no other headers (gpgsig, mergetag …),
/// as git writes on rewrite. Building the buffer ourselves sidesteps
/// `git2::Signature`, which rejects empty names/emails and re-encodes bytes.
pub(crate) fn write_commit(
    repo: &git2::Repository,
    tree: git2::Oid,
    parents: &[git2::Oid],
    author_line: &[u8],
    committer: &git2::Signature,
    message: &[u8],
) -> std::result::Result<git2::Oid, git2::Error> {
    let mut buf = format!("tree {tree}\n").into_bytes();
    for p in parents {
        buf.extend_from_slice(format!("parent {p}\n").as_bytes());
    }
    buf.extend_from_slice(b"author ");
    buf.extend_from_slice(author_line);
    buf.extend_from_slice(b"\ncommitter ");
    buf.extend_from_slice(committer.name_bytes());
    buf.extend_from_slice(b" <");
    buf.extend_from_slice(committer.email_bytes());
    buf.extend_from_slice(b"> ");
    let when = committer.when();
    let offset = when.offset_minutes();
    let sign = if offset < 0 { '-' } else { '+' };
    let abs = offset.abs();
    buf.extend_from_slice(format!("{} {sign}{:02}{:02}\n\n", when.seconds(), abs / 60, abs % 60).as_bytes());
    buf.extend_from_slice(message);
    repo.odb()?.write(git2::ObjectType::Commit, &buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{ObjectType, Repository};
    use std::path::PathBuf;

    fn make_repo() -> (PathBuf, Repository) {
        crate::repo::test_support::make_repo_with_commit()
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

    /// A commit on top of HEAD whose author and committer are `name` and whose
    /// extra header block and message are the given raw bytes.
    fn raw_commit(repo: &Repository, header: &[u8], name: &[u8], msg: &[u8]) -> git2::Oid {
        let mut who = name.to_vec();
        who.extend_from_slice(b" <a@example.com> 0 +0000");
        crate::repo::test_support::push_raw_commit(repo, "b.txt", &who, &who, header, msg)
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
    fn latin1_labels_decode_byte_for_byte_like_iconv() {
        let (dir, repo) = make_repo();
        for label in ["ISO-8859-1", "iso8859-1", "latin1", "L1", "ISO_8859-1"] {
            let header = format!("encoding {label}\n");
            let oid = raw_commit(&repo, header.as_bytes(), b"A\x80\x9f", b"x\x80\n");
            let c = repo.find_commit(oid).unwrap();
            // 0x80..0x9F are C1 controls in Latin-1, not cp1252 glyphs.
            assert_eq!(dec(&c).text(c.author().name_bytes()), "A\u{80}\u{9f}", "{label}");
            assert_eq!(dec(&c).text(c.summary_bytes()), "x\u{80}", "{label}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn iso_8859_n_labels_mapped_to_windows_by_whatwg_keep_c1_controls() {
        let (dir, repo) = make_repo();
        // (label, byte, expected for 0x80, expected for the high byte)
        for (label, hi, want_hi) in [
            ("ISO-8859-9", 0xD0u8, 'Ğ'),
            ("latin5", 0xD0, 'Ğ'),
            ("iso_8859-9", 0xFD, 'ı'),
            ("ISO-8859-11", 0xA1, 'ก'),
            ("tis-620", 0xA1, 'ก'),
        ] {
            let header = format!("encoding {label}\n");
            let oid = raw_commit(&repo, header.as_bytes(), b"A\x80\x9e", &[b'x', 0x80, hi, b'\n']);
            let c = repo.find_commit(oid).unwrap();
            assert_eq!(dec(&c).text(c.author().name_bytes()), "A\u{80}\u{9e}", "{label}");
            assert_eq!(dec(&c).text(c.summary_bytes()), format!("x\u{80}{want_hi}"), "{label}");
            let t = transcode_for_rewrite(&c);
            assert_eq!(t.message, format!("x\u{80}{want_hi}\n").into_bytes(), "{label}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn real_windows_labels_still_use_their_glyphs() {
        let (dir, repo) = make_repo();
        for (label, want) in [("windows-1252", '€'), ("cp1252", '€')] {
            let header = format!("encoding {label}\n");
            let c = repo.find_commit(raw_commit(&repo, header.as_bytes(), b"A", b"\x80\n")).unwrap();
            assert_eq!(dec(&c).text(c.summary_bytes()), want.to_string(), "{label}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn us_ascii_is_not_windows_1252() {
        let (dir, repo) = make_repo();
        for label in ["US-ASCII", "ascii", "ANSI_X3.4-1968"] {
            let header = format!("encoding {label}\n");
            // A byte >= 0x80 is invalid ASCII: iconv fails, git keeps the raw
            // bytes; display falls back to the lossy decoding, not cp1252.
            let c = repo.find_commit(raw_commit(&repo, header.as_bytes(), b"A\xe9", b"\x80ok\n")).unwrap();
            assert_eq!(dec(&c).text(c.summary_bytes()), "\u{FFFD}ok", "{label}");
            assert_eq!(dec(&c).text(c.author().name_bytes()), "A\u{FFFD}", "{label}");
            let t = transcode_for_rewrite(&c);
            assert_eq!(t.message, b"\x80ok\n", "{label}");
            assert_eq!(t.author, b"A\xe9 <a@example.com> 0 +0000", "{label}");
            // Pure ASCII is unaffected.
            let ok = repo.find_commit(raw_commit(&repo, header.as_bytes(), b"A", b"plain\n")).unwrap();
            assert_eq!(dec(&ok).text(ok.summary_bytes()), "plain", "{label}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn iconv_codepage_aliases_decode_like_their_encodings() {
        let (dir, repo) = make_repo();
        let sjis = |t: &str| encoding_rs::SHIFT_JIS.encode(t).0.into_owned();
        let gbk = |t: &str| encoding_rs::GBK.encode(t).0.into_owned();
        let euckr = |t: &str| encoding_rs::EUC_KR.encode(t).0.into_owned();
        let big5 = |t: &str| encoding_rs::BIG5.encode(t).0.into_owned();
        let cases: [(&str, Vec<u8>, &str); 8] = [
            ("CP932", sjis("日本語"), "日本語"),
            ("MS932", sjis("日本語"), "日本語"),
            ("Windows-31J", sjis("日本語"), "日本語"),
            ("CP936", gbk("中文"), "中文"),
            ("CP949", euckr("한국어"), "한국어"),
            ("CP950", big5("中文"), "中文"),
            ("eucJP", encoding_rs::EUC_JP.encode("日本語").0.into_owned(), "日本語"),
            ("CP874", vec![0xA1], "ก"),
        ];
        for (label, bytes, want) in cases {
            let header = format!("encoding {label}\n");
            let mut msg = bytes.clone();
            msg.push(b'\n');
            let c = repo.find_commit(raw_commit(&repo, header.as_bytes(), b"A", &msg)).unwrap();
            assert_eq!(dec(&c).text(c.summary_bytes()), want, "{label}");
            assert_eq!(transcode_for_rewrite(&c).message, format!("{want}\n").into_bytes(), "{label}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn transcode_for_rewrite_converts_declared_encodings_to_utf8() {
        let (dir, repo) = make_repo();
        let c = repo.find_commit(latin1_commit(&repo)).unwrap();
        let t = transcode_for_rewrite(&c);
        assert_eq!(t.author, "André <a@example.com> 0 +0000".as_bytes());
        assert_eq!(t.message, "Corrigé le bug\n\nDétails ici\n".as_bytes());

        let (name, _, _) = encoding_rs::SHIFT_JIS.encode("山田");
        let (msg, _, _) = encoding_rs::SHIFT_JIS.encode("日本語\n");
        let c = repo.find_commit(raw_commit(&repo, b"encoding Shift_JIS\n", &name, &msg)).unwrap();
        let t = transcode_for_rewrite(&c);
        assert_eq!(t.author, "山田 <a@example.com> 0 +0000".as_bytes());
        assert_eq!(t.message, "日本語\n".as_bytes());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn transcode_for_rewrite_copies_undeclared_bytes_raw() {
        let (dir, repo) = make_repo();
        let c = repo.find_commit(raw_commit(&repo, b"", b"Andr\xe9", b"Corrig\xe9\n")).unwrap();
        let t = transcode_for_rewrite(&c);
        assert_eq!(t.author, b"Andr\xe9 <a@example.com> 0 +0000");
        assert_eq!(t.message, b"Corrig\xe9\n");
        // Unknown label and UTF-8 label: taken as-is too.
        for label in ["x-made-up", "UTF-8", "utf-16"] {
            let header = format!("encoding {label}\n");
            let c = repo.find_commit(raw_commit(&repo, header.as_bytes(), b"Andr\xe9", b"m\xe9\n")).unwrap();
            assert_eq!(transcode_for_rewrite(&c).message, b"m\xe9\n", "{label}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn transcode_for_rewrite_keeps_empty_identity() {
        let (dir, repo) = make_repo();
        let tree = repo.treebuilder(None).unwrap().write().unwrap();
        let raw = format!("tree {tree}\nauthor  <> 1600000000 +0000\ncommitter  <> 1600000000 +0000\nencoding ISO-8859-1\n\nm\n");
        let oid = repo.odb().unwrap().write(ObjectType::Commit, raw.as_bytes()).unwrap();
        let t = transcode_for_rewrite(&repo.find_commit(oid).unwrap());
        assert_eq!(t.author, b" <> 1600000000 +0000");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn write_commit_formats_committer_offsets_like_git() {
        let (dir, repo) = make_repo();
        let tree = repo.treebuilder(None).unwrap().write().unwrap();
        for (minutes, want) in [(-210, "-0330"), (330, "+0530"), (0, "+0000"), (-60, "-0100"), (840, "+1400")] {
            let sig = git2::Signature::new("C", "c@x", &git2::Time::new(1_600_000_000, minutes)).unwrap();
            let oid = write_commit(&repo, tree, &[], b"A <a@x> 1 +0000", &sig, b"msg\n").unwrap();
            let raw = String::from_utf8(crate::repo::test_support::raw_object(&repo, oid)).unwrap();
            assert!(raw.contains(&format!("\ncommitter C <c@x> 1600000000 {want}\n")), "{raw}");
            let c = repo.find_commit(oid).unwrap();
            assert_eq!(c.committer().when().offset_minutes(), minutes);
            assert!(!raw.contains("encoding"));
        }
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
