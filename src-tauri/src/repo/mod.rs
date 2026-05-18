pub mod state;

pub use state::RepoState;

use crate::error::{Error, Result};

pub(crate) fn workdir(repo: &git2::Repository) -> Result<std::path::PathBuf> {
    repo.workdir()
        .ok_or_else(|| Error::InvalidArg("bare repositories are not supported".into()))
        .map(|p| p.to_path_buf())
}
