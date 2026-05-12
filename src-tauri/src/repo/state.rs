use std::collections::HashMap;
use std::sync::Mutex;

use git2::Repository;

#[derive(Default)]
pub struct RepoState(pub Mutex<HashMap<String, Repository>>);
