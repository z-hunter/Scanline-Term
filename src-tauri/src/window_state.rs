use std::{
    fs, io,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

const MIN_SIZE: u32 = 320;
const MAX_SIZE: u32 = 8192;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
struct Geometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    #[serde(default)]
    inner_size: bool,
}

pub struct WindowState {
    path: PathBuf,
    saved: Mutex<Option<Geometry>>,
    lua_override: AtomicBool,
    initialized: AtomicBool,
}

impl WindowState {
    fn new(path: PathBuf) -> Self {
        let saved = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .filter(valid_geometry);
        Self {
            path,
            saved: Mutex::new(saved),
            lua_override: AtomicBool::new(false),
            initialized: AtomicBool::new(false),
        }
    }

    pub fn setup(app: &tauri::AppHandle) -> Result<(), String> {
        let path = app
            .path()
            .app_config_dir()
            .map_err(|error| error.to_string())?
            .join("window-state.json");
        let state = Arc::new(Self::new(path));
        app.manage(state.clone());
        let app = app.clone();
        thread::spawn(move || loop {
            thread::sleep(Duration::from_secs(2));
            let Some(window) = app.get_webview_window("main") else {
                return;
            };
            state.save_current(&window);
        });
        Ok(())
    }

    pub fn initialize(&self, window: &WebviewWindow, restore: bool) -> Result<bool, String> {
        let restored = if restore {
            self.restore(window)?
        } else {
            false
        };
        self.initialized.store(true, Ordering::SeqCst);
        Ok(restored)
    }

    pub fn restore(&self, window: &WebviewWindow) -> Result<bool, String> {
        let Some(geometry) = *self
            .saved
            .lock()
            .map_err(|_| "window state is unavailable")?
        else {
            return Ok(false);
        };
        let mut geometry = geometry;
        if !geometry.inner_size {
            normalize_legacy_size(
                &mut geometry,
                window.outer_size().map_err(|error| error.to_string())?,
                window.inner_size().map_err(|error| error.to_string())?,
            );
        }
        let monitors = window
            .available_monitors()
            .map_err(|error| error.to_string())?;
        if let Some(monitor) = monitors
            .iter()
            .find(|monitor| intersects(geometry, *monitor.position(), *monitor.size()))
        {
            let position = monitor.position();
            let size = monitor.size();
            let visible_x = geometry.width.min(120).min(size.width / 2) as i32;
            let visible_y = geometry.height.min(64).min(size.height / 2) as i32;
            geometry.x = geometry.x.clamp(
                position
                    .x
                    .saturating_add(visible_x)
                    .saturating_sub(geometry.width as i32),
                position
                    .x
                    .saturating_add(size.width as i32)
                    .saturating_sub(visible_x),
            );
            geometry.y = geometry.y.clamp(
                position
                    .y
                    .saturating_add(visible_y)
                    .saturating_sub(geometry.height as i32),
                position
                    .y
                    .saturating_add(size.height as i32)
                    .saturating_sub(visible_y),
            );
        } else if let Some(monitor) = window
            .primary_monitor()
            .map_err(|error| error.to_string())?
        {
            geometry.x = monitor.position().x.saturating_add(32);
            geometry.y = monitor.position().y.saturating_add(32);
        }
        window
            .set_size(PhysicalSize::new(geometry.width, geometry.height))
            .map_err(|error| error.to_string())?;
        window
            .set_position(PhysicalPosition::new(geometry.x, geometry.y))
            .map_err(|error| error.to_string())?;
        Ok(true)
    }

    pub fn set_position(&self, window: &WebviewWindow, x: i32, y: i32) -> Result<(), String> {
        let was_overridden = self.lua_override.swap(true, Ordering::SeqCst);
        if let Err(error) = window.set_position(tauri::LogicalPosition::new(x, y)) {
            self.lua_override.store(was_overridden, Ordering::SeqCst);
            return Err(error.to_string());
        }
        Ok(())
    }

    pub fn set_size(&self, window: &WebviewWindow, width: u32, height: u32) -> Result<(), String> {
        if !(MIN_SIZE..=MAX_SIZE).contains(&width) || !(MIN_SIZE..=MAX_SIZE).contains(&height) {
            return Err(format!(
                "window dimensions must be between {MIN_SIZE} and {MAX_SIZE} logical pixels"
            ));
        }
        let was_overridden = self.lua_override.swap(true, Ordering::SeqCst);
        if let Err(error) = window.set_size(tauri::LogicalSize::new(width, height)) {
            self.lua_override.store(was_overridden, Ordering::SeqCst);
            return Err(error.to_string());
        }
        Ok(())
    }

    pub fn user_move_started(&self) {
        self.lua_override.store(false, Ordering::SeqCst);
    }

    pub fn save_current(&self, window: &WebviewWindow) {
        if !self.initialized.load(Ordering::SeqCst)
            || self.lua_override.load(Ordering::SeqCst)
            || window.is_minimized().unwrap_or(true)
            || window.is_maximized().unwrap_or(true)
            || window.is_fullscreen().unwrap_or(true)
        {
            return;
        }
        let Ok(position) = window.outer_position() else {
            return;
        };
        let Ok(size) = window.inner_size() else {
            return;
        };
        let geometry = Geometry {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
            inner_size: true,
        };
        if !valid_geometry(&geometry) {
            return;
        }
        let Ok(mut saved) = self.saved.lock() else {
            return;
        };
        if *saved == Some(geometry) {
            return;
        }
        let Ok(bytes) = serde_json::to_vec(&geometry) else {
            return;
        };
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let temporary = self.path.with_extension("json.tmp");
        if fs::write(&temporary, bytes).is_ok()
            && replace_state_file(&temporary, &self.path).is_ok()
        {
            *saved = Some(geometry);
        } else {
            let _ = fs::remove_file(temporary);
        }
    }
}

fn normalize_legacy_size(
    geometry: &mut Geometry,
    outer: PhysicalSize<u32>,
    inner: PhysicalSize<u32>,
) {
    if geometry.inner_size {
        return;
    }
    geometry.width = geometry
        .width
        .saturating_sub(outer.width.saturating_sub(inner.width))
        .max(MIN_SIZE);
    geometry.height = geometry
        .height
        .saturating_sub(outer.height.saturating_sub(inner.height))
        .max(MIN_SIZE);
    geometry.inner_size = true;
}

fn replace_state_file(
    temporary: &std::path::Path,
    destination: &std::path::Path,
) -> io::Result<()> {
    #[cfg(windows)]
    if destination.exists() {
        use std::{os::windows::ffi::OsStrExt, ptr};
        use windows_sys::Win32::Storage::FileSystem::{ReplaceFileW, REPLACEFILE_WRITE_THROUGH};

        let destination: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        let temporary: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
        let replaced = unsafe {
            ReplaceFileW(
                destination.as_ptr(),
                temporary.as_ptr(),
                ptr::null(),
                REPLACEFILE_WRITE_THROUGH,
                ptr::null(),
                ptr::null(),
            )
        };
        return if replaced == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        };
    }

    fs::rename(temporary, destination)
}

fn valid_geometry(geometry: &Geometry) -> bool {
    (MIN_SIZE..=MAX_SIZE).contains(&geometry.width)
        && (MIN_SIZE..=MAX_SIZE).contains(&geometry.height)
}

fn intersects(
    geometry: Geometry,
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
) -> bool {
    let right = geometry.x.saturating_add(geometry.width as i32);
    let bottom = geometry.y.saturating_add(geometry.height as i32);
    let monitor_right = position.x.saturating_add(size.width as i32);
    let monitor_bottom = position.y.saturating_add(size.height as i32);
    geometry.x < monitor_right
        && right > position.x
        && geometry.y < monitor_bottom
        && bottom > position.y
}

#[tauri::command]
pub fn restore_window_state(
    window: WebviewWindow,
    restore: bool,
    state: tauri::State<'_, Arc<WindowState>>,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("window state is only available to the main window".into());
    }
    state.initialize(&window, restore)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_dimensions_and_accepts_visible_geometry() {
        assert!(!valid_geometry(&Geometry {
            x: 0,
            y: 0,
            width: 100,
            height: 600,
            inner_size: true,
        }));
        let geometry = Geometry {
            x: -1000,
            y: 100,
            width: 900,
            height: 700,
            inner_size: true,
        };
        assert!(valid_geometry(&geometry));
        assert!(intersects(
            geometry,
            PhysicalPosition::new(-1200, 0),
            PhysicalSize::new(1920, 1080)
        ));
        assert!(!intersects(
            geometry,
            PhysicalPosition::new(1920, 0),
            PhysicalSize::new(1920, 1080)
        ));
    }

    #[test]
    fn converts_legacy_outer_sizes_to_inner_sizes_once() {
        let mut geometry: Geometry =
            serde_json::from_str(r#"{"x":0,"y":0,"width":1200,"height":900}"#).unwrap();
        assert!(!geometry.inner_size);
        normalize_legacy_size(
            &mut geometry,
            PhysicalSize::new(1200, 900),
            PhysicalSize::new(1184, 861),
        );
        assert_eq!(geometry.width, 1184);
        assert_eq!(geometry.height, 861);
        assert!(geometry.inner_size);

        normalize_legacy_size(
            &mut geometry,
            PhysicalSize::new(1200, 900),
            PhysicalSize::new(1184, 861),
        );
        assert_eq!(geometry.width, 1184);
        assert_eq!(geometry.height, 861);
    }

    #[test]
    fn replaces_saved_geometry_atomically() {
        let root = std::env::temp_dir().join(format!(
            "scanline-window-state-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let destination = root.join("window-state.json");
        let temporary = root.join("window-state.json.tmp");

        fs::write(&temporary, b"first").unwrap();
        replace_state_file(&temporary, &destination).unwrap();
        fs::write(&temporary, b"second").unwrap();
        replace_state_file(&temporary, &destination).unwrap();

        assert_eq!(fs::read(&destination).unwrap(), b"second");
        fs::remove_dir_all(root).unwrap();
    }
}
