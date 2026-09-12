use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

const PRESET_DIR: &str = "presets";
const MAX_FILE_BYTES: u64 = 64 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetCatalog {
    pub path: String,
    pub names: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePresetResult {
    pub saved: bool,
    pub exists: bool,
    pub names: Vec<String>,
}

fn presets_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(PRESET_DIR))
        .map_err(|error| error.to_string())
}

fn validate_name(name: &str) -> Result<&str, String> {
    let raw = name;
    let name = raw.trim();
    if raw != name {
        return Err("preset name must not start or end with whitespace".into());
    }
    if name.is_empty() || name.len() > 64 {
        return Err("preset name must contain 1-64 characters".into());
    }
    if name.ends_with('.')
        || name.ends_with(' ')
        || name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
    {
        return Err("preset name contains an invalid character".into());
    }
    if name.to_ascii_lowercase().ends_with(".json") {
        return Err("preset name must not include the .json extension".into());
    }
    if name.chars().any(char::is_control) {
        return Err("preset name contains a control character".into());
    }
    let reserved = ["CON", "PRN", "AUX", "NUL"];
    let stem = name
        .split('.')
        .next()
        .unwrap_or(name)
        .trim_end_matches([' ', '.']);
    let upper = stem.to_ascii_uppercase();
    if reserved
        .iter()
        .any(|value| value.eq_ignore_ascii_case(stem))
        || (upper.len() == 4
            && (upper.starts_with("COM") || upper.starts_with("LPT"))
            && upper.as_bytes()[3].is_ascii_digit())
    {
        return Err("preset name is reserved by Windows".into());
    }
    Ok(name)
}

fn json_path(directory: &Path, name: &str) -> PathBuf {
    directory.join(format!("{name}.json"))
}

fn find_path(directory: &Path, name: &str) -> Option<PathBuf> {
    fs::read_dir(directory).ok()?.flatten().find_map(|entry| {
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).ok()?;
        if !metadata.file_type().is_file()
            || path.extension()?.to_str()?.eq_ignore_ascii_case("json") == false
        {
            return None;
        }
        let stem = path.file_stem()?.to_str()?;
        stem.eq_ignore_ascii_case(name).then_some(path)
    })
}

fn names(directory: &Path) -> Vec<String> {
    let mut result: Vec<String> = fs::read_dir(directory)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).ok()?;
            if !metadata.file_type().is_file()
                || !path.extension()?.to_str()?.eq_ignore_ascii_case("json")
            {
                return None;
            }
            let stem = path.file_stem()?.to_str()?;
            validate_name(stem).ok()?;
            Some(stem.to_owned())
        })
        .collect();
    result.sort_by_key(|value| value.to_ascii_lowercase());
    if let Some(index) = result
        .iter()
        .position(|value| value.eq_ignore_ascii_case("default"))
    {
        let default_name = result.remove(index);
        result.insert(0, default_name);
    }
    result
}

fn catalog(directory: &Path) -> PresetCatalog {
    PresetCatalog {
        path: directory.to_string_lossy().into_owned(),
        names: names(directory),
    }
}

fn read_value(path: &Path) -> Result<Value, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.file_type().is_file() {
        return Err("preset is not a regular file".into());
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err("preset file is too large".into());
    }
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw).map_err(|error| format!("preset is invalid: {error}"))
}

fn write_value(path: &Path, value: &Value, overwrite: bool) -> Result<bool, String> {
    let parent = path.parent().ok_or("preset directory is unavailable")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let encoded = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    if encoded.len() as u64 > MAX_FILE_BYTES {
        return Err("preset is too large".into());
    }
    if path.exists() && !overwrite {
        return Ok(false);
    }
    let temp = path.with_file_name(format!(
        "{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("preset.json")
    ));
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temp)
        .map_err(|error| error.to_string())?;
    file.write_all(&encoded)
        .map_err(|error| error.to_string())?;
    file.write_all(b"\n").map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    drop(file);
    let backup = path.with_file_name(format!(
        "{}.bak",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("preset.json")
    ));
    let had_existing = path.exists();
    if had_existing {
        let _ = fs::remove_file(&backup);
        fs::copy(path, &backup).map_err(|error| error.to_string())?;
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    if let Err(error) = fs::rename(&temp, path) {
        if had_existing {
            let _ = fs::copy(&backup, path);
        }
        let _ = fs::remove_file(&temp);
        return Err(error.to_string());
    }
    Ok(true)
}

#[tauri::command]
pub fn list_presets(app: AppHandle) -> Result<PresetCatalog, String> {
    let directory = presets_path(&app)?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(catalog(&directory))
}

#[tauri::command]
pub fn load_preset(app: AppHandle, name: String) -> Result<Value, String> {
    let name = validate_name(&name)?;
    let directory = presets_path(&app)?;
    let path = find_path(&directory, name).ok_or_else(|| format!("preset not found: {name}"))?;
    read_value(&path).map_err(|error| format!("Could not load preset {}: {error}", path.display()))
}

#[tauri::command]
pub fn save_preset(
    app: AppHandle,
    name: String,
    preset: Value,
    overwrite: bool,
) -> Result<SavePresetResult, String> {
    let name = validate_name(&name)?;
    if !preset.is_object() {
        return Err("preset must be a JSON object".into());
    }
    let directory = presets_path(&app)?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let path = find_path(&directory, name).unwrap_or_else(|| json_path(&directory, name));
    let saved = write_value(&path, &preset, overwrite)?;
    Ok(SavePresetResult {
        saved,
        exists: !saved && path.exists(),
        names: names(&directory),
    })
}

#[cfg(test)]
mod tests {
    use super::{read_value, validate_name, write_value};
    use serde_json::json;
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn rejects_unsafe_names() {
        for name in ["", "..", "a/b", "a\\b", "CON", "COM1", "name.", "name "] {
            assert!(validate_name(name).is_err(), "{name}");
        }
        assert!(validate_name("retro CRT").is_ok());
    }

    #[test]
    fn writes_conflicts_and_backups_atomically() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "scanline-preset-{stamp}-{}.json",
            std::process::id()
        ));
        let first = json!({ "version": 1, "resolution": "640x480" });
        let second = json!({ "version": 1, "resolution": "1280x800" });
        assert!(write_value(&path, &first, false).unwrap());
        assert!(!write_value(&path, &second, false).unwrap());
        assert!(write_value(&path, &second, true).unwrap());
        assert_eq!(read_value(&path).unwrap(), second);
        assert_eq!(
            read_value(&PathBuf::from(format!("{}.bak", path.display()))).unwrap(),
            first
        );
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(PathBuf::from(format!("{}.bak", path.display())));
    }
}
