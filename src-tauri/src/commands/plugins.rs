use std::path::Path;

use serde::Serialize;

use crate::error::{Error, Result};

const MANIFEST_NAME: &str = "waypoint.plugin.json";
const DEFAULT_ENTRY: &str = "plugin.js";

#[derive(Debug, Serialize)]
pub struct LocalPlugin {
    /// Raw manifest JSON text (parsed/validated on the frontend).
    pub manifest: String,
    /// Entry module source code (ESM).
    pub code: String,
}

/// Read a plugin from a local folder: its `waypoint.plugin.json` manifest plus
/// the entry module it points at (defaults to `plugin.js`). The manifest is
/// returned as raw text; the frontend validates it.
#[tauri::command]
pub fn read_local_plugin(path: String) -> Result<LocalPlugin> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(Error::InvalidArg(format!("Not a directory: {}", path)));
    }

    let manifest_path = dir.join(MANIFEST_NAME);
    let manifest = std::fs::read_to_string(&manifest_path).map_err(|e| {
        Error::InvalidArg(format!("Cannot read {}: {}", manifest_path.display(), e))
    })?;

    // Pull the entry filename out of the manifest so we read the right module.
    let entry = serde_json::from_str::<serde_json::Value>(&manifest)
        .ok()
        .and_then(|v| v.get("entry").and_then(|e| e.as_str()).map(|s| s.to_owned()))
        .unwrap_or_else(|| DEFAULT_ENTRY.to_owned());

    let entry_path = dir.join(&entry);
    let code = std::fs::read_to_string(&entry_path).map_err(|e| {
        Error::InvalidArg(format!("Cannot read entry {}: {}", entry_path.display(), e))
    })?;

    Ok(LocalPlugin { manifest, code })
}
