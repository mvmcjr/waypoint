use std::collections::HashMap;
use std::sync::Mutex;

use notify_debouncer_mini::{Debouncer, notify::RecommendedWatcher};

pub struct WatcherState(pub Mutex<HashMap<String, Debouncer<RecommendedWatcher>>>);

impl Default for WatcherState {
    fn default() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}
