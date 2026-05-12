use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("git error: {0}")]
    Git(#[from] git2::Error),
    #[error("repo not found: {0}")]
    RepoNotFound(String),
    #[error("not a git repository: {0}")]
    NotARepo(String),
    #[error("commit not found: {0}")]
    CommitNotFound(String),
}

impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
