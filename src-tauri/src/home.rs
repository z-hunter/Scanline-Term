use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use url::Url;

const HOME_FILE: &str = "home.json";
const BACKUP_FILE: &str = "home.json.bak";
const TEMP_FILE: &str = "home.json.tmp";
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_CATEGORIES: usize = 64;
const MAX_LINKS: usize = 512;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HomeLink {
    pub title: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shortcut: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct HomeCategory {
    pub title: String,
    pub links: Vec<HomeLink>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct HomeConfig {
    pub version: u8,
    pub title: String,
    pub categories: Vec<HomeCategory>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeConfigPayload {
    pub path: String,
    pub config: HomeConfig,
}

pub fn default_config() -> HomeConfig {
    HomeConfig {
        version: 1,
        title: "Scanline Home".into(),
        categories: vec![HomeCategory {
            title: "Development".into(),
            links: vec![
                HomeLink {
                    title: "GitHub".into(),
                    url: "https://github.com/".into(),
                    shortcut: Some("g".into()),
                },
                HomeLink {
                    title: "Tauri Docs".into(),
                    url: "https://v2.tauri.app/".into(),
                    shortcut: Some("t".into()),
                },
                HomeLink {
                    title: "Scanline Term".into(),
                    url: "https://github.com/z-hunter/Scanline-Term".into(),
                    shortcut: Some("s".into()),
                },
                HomeLink {
                    title: "Quest".into(),
                    url: "https://github.com/z-hunter/Quest".into(),
                    shortcut: Some("q".into()),
                },
            ],
        }],
    }
}

fn string_length(value: &str) -> usize {
    value.chars().count()
}

fn validate_text(value: &str, field: &str, max: usize) -> Result<(), String> {
    let length = string_length(value);
    if value.trim().is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    if length > max {
        return Err(format!("{field} is too long"));
    }
    Ok(())
}

pub fn validate_config(config: &HomeConfig) -> Result<(), String> {
    if config.version != 1 {
        return Err("home config version is unsupported".into());
    }
    validate_text(&config.title, "home title", 80)?;
    if config.categories.len() > MAX_CATEGORIES {
        return Err("too many home categories".into());
    }
    let mut shortcuts = HashSet::new();
    let mut link_count = 0;
    for category in &config.categories {
        validate_text(&category.title, "category title", 80)?;
        link_count += category.links.len();
        if link_count > MAX_LINKS {
            return Err("too many home links".into());
        }
        for link in &category.links {
            validate_text(&link.title, "link title", 120)?;
            validate_text(&link.url, "link URL", 2048)?;
            let parsed =
                Url::parse(&link.url).map_err(|_| format!("invalid link URL: {}", link.url))?;
            if !matches!(parsed.scheme(), "http" | "https") {
                return Err("home links must use http or https".into());
            }
            if let Some(shortcut) = &link.shortcut {
                if shortcut.chars().count() != 1
                    || !shortcut
                        .chars()
                        .all(|character| character.is_ascii_alphanumeric())
                {
                    return Err("home shortcuts must be one ASCII letter or digit".into());
                }
                if !shortcuts.insert(shortcut.to_ascii_lowercase()) {
                    return Err("home shortcuts must be unique".into());
                }
            }
        }
    }
    Ok(())
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(HOME_FILE))
        .map_err(|error| error.to_string())
}

fn backup_path(path: &Path) -> PathBuf {
    path.with_file_name(BACKUP_FILE)
}
fn temp_path(path: &Path) -> PathBuf {
    path.with_file_name(TEMP_FILE)
}

fn read_config(path: &Path) -> Result<HomeConfig, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_FILE_BYTES {
        return Err("home config is too large".into());
    }
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let config: HomeConfig =
        serde_json::from_str(&raw).map_err(|error| format!("home config is invalid: {error}"))?;
    validate_config(&config)?;
    Ok(config)
}

fn write_config(path: &Path, config: &HomeConfig) -> Result<(), String> {
    validate_config(config)?;
    let parent = path
        .parent()
        .ok_or("home config directory is unavailable")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temp = temp_path(path);
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temp)
        .map_err(|error| error.to_string())?;
    let encoded = serde_json::to_vec_pretty(config).map_err(|error| error.to_string())?;
    file.write_all(&encoded)
        .map_err(|error| error.to_string())?;
    file.write_all(b"\n").map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    drop(file);

    let backup = backup_path(path);
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
    Ok(())
}

#[tauri::command]
pub fn load_home_config(app: AppHandle) -> Result<HomeConfigPayload, String> {
    let path = config_path(&app)?;
    let config = match read_config(&path) {
        Ok(config) => config,
        Err(_error) if !path.exists() => {
            let backup = backup_path(&path);
            if backup.exists() {
                let recovered = read_config(&backup)?;
                fs::copy(&backup, &path).map_err(|copy_error| copy_error.to_string())?;
                recovered
            } else {
                let config = default_config();
                write_config(&path, &config)?;
                config
            }
        }
        Err(error) => return Err(format!("Could not load {}: {error}", path.display())),
    };
    Ok(HomeConfigPayload {
        path: path.to_string_lossy().into_owned(),
        config,
    })
}

#[tauri::command]
pub fn save_home_config(app: AppHandle, config: HomeConfig) -> Result<HomeConfigPayload, String> {
    let path = config_path(&app)?;
    write_config(&path, &config)?;
    Ok(HomeConfigPayload {
        path: path.to_string_lossy().into_owned(),
        config,
    })
}

#[cfg(test)]
mod tests {
    use super::{default_config, read_config, validate_config, write_config, HomeConfig, HomeLink};
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn temp_file() -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("scanline-home-{stamp}-{}.json", std::process::id()))
    }

    #[test]
    fn default_config_round_trips_and_keeps_backup() {
        let path = temp_file();
        let config = default_config();
        assert!(config.categories[0].links.iter().any(|link| link.url == "https://github.com/z-hunter/Scanline-Term"));
        assert!(config.categories[0].links.iter().any(|link| link.url == "https://github.com/z-hunter/Quest"));
        write_config(&path, &config).unwrap();
        assert_eq!(read_config(&path).unwrap(), config);
        let changed = HomeConfig {
            title: "Changed".into(),
            ..config.clone()
        };
        write_config(&path, &changed).unwrap();
        assert_eq!(read_config(&path).unwrap(), changed);
        assert_eq!(
            read_config(&path.with_file_name("home.json.bak")).unwrap(),
            config
        );
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(path.with_file_name("home.json.bak"));
    }

    #[test]
    fn rejects_unsafe_links_and_duplicate_shortcuts() {
        let mut config = default_config();
        config.categories[0].links[0].url = "file:///secret".into();
        assert!(validate_config(&config).is_err());
        config.categories[0].links[0] = HomeLink {
            title: "One".into(),
            url: "https://one.example".into(),
            shortcut: Some("x".into()),
        };
        config.categories[0].links[1].shortcut = Some("X".into());
        assert!(validate_config(&config).is_err());
    }
}
