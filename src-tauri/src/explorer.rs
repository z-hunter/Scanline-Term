#[cfg(windows)]
use std::mem::size_of;

#[cfg(windows)]
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegDeleteTreeW, RegDeleteValueW, RegOpenKeyExW, RegSetValueExW, HKEY_CURRENT_USER,
    KEY_SET_VALUE, REG_SZ,
};

#[cfg(windows)]
fn context_key(relative: &str) -> String {
    format!("Software\\Classes\\{relative}\\shell\\ScanlineTerm.OpenHere")
}

#[cfg(windows)]
fn set_registry_string(key: &str, name: Option<&str>, value: &str) -> Result<(), String> {
    use windows_sys::Win32::System::Registry::RegCreateKeyW;
    let key: Vec<u16> = key.encode_utf16().chain(std::iter::once(0)).collect();
    let name: Vec<u16> = name.unwrap_or("").encode_utf16().chain(std::iter::once(0)).collect();
    let value: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
    let mut handle = std::ptr::null_mut();
    let status = unsafe { RegCreateKeyW(HKEY_CURRENT_USER, key.as_ptr(), &mut handle) };
    if status != 0 { return Err(format!("could not create Explorer registry key ({status})")); }
    let status = unsafe {
        RegSetValueExW(handle, name.as_ptr(), 0, REG_SZ, value.as_ptr().cast(), (value.len() * size_of::<u16>()) as u32)
    };
    unsafe { RegCloseKey(handle); }
    if status == 0 { Ok(()) } else { Err(format!("could not write Explorer registry value ({status})")) }
}

#[cfg(windows)]
fn remove_context_key(key: &str) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND};
    let key: Vec<u16> = key.encode_utf16().chain(std::iter::once(0)).collect();
    let mut handle = std::ptr::null_mut();
    let status = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, key.as_ptr(), 0, KEY_SET_VALUE, &mut handle) };
    if status == ERROR_FILE_NOT_FOUND || status == ERROR_PATH_NOT_FOUND { return Ok(()); }
    if status != 0 { return Err(format!("could not open Explorer registry key ({status})")); }
    let default_name = [0];
    let icon_name: Vec<u16> = "Icon".encode_utf16().chain(std::iter::once(0)).collect();
    for name in [&default_name[..], &icon_name] {
        let status = unsafe { RegDeleteValueW(handle, name.as_ptr()) };
        if status != 0 && status != ERROR_FILE_NOT_FOUND {
            unsafe { RegCloseKey(handle); }
            return Err(format!("could not remove Explorer registry value ({status})"));
        }
    }
    unsafe { RegCloseKey(handle); }
    let command_key: Vec<u16> = format!("{}\\command", String::from_utf16_lossy(&key[..key.len() - 1]))
        .encode_utf16().chain(std::iter::once(0)).collect();
    let status = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, command_key.as_ptr()) };
    if status == 0 || status == ERROR_FILE_NOT_FOUND || status == ERROR_PATH_NOT_FOUND { Ok(()) }
    else { Err(format!("could not remove Explorer command registry key ({status})")) }
}

#[cfg(windows)]
fn apply_integration(enabled: bool, icon_path: Option<&std::path::Path>) -> Result<(), String> {
    let directory_key = context_key("Directory");
    let background_key = context_key("Directory\\Background");
    if !enabled {
        let directory_result = remove_context_key(&directory_key);
        let background_result = remove_context_key(&background_key);
        return directory_result.and(background_result);
    }
    let executable = std::env::current_exe().map_err(|error| format!("could not locate Scanline Term executable: {error}"))?;
    let executable = executable.to_string_lossy();
    let command = format!("\"{executable}\" -T -P \"%1\"");
    let background_command = format!("\"{executable}\" -T -P \"%V\"");
    let icon_path = icon_path.ok_or("Scanline Term window icon is unavailable")?.to_string_lossy();
    let register = || {
        set_registry_string(&directory_key, None, "Open ScanlineTerm here")?;
        set_registry_string(&directory_key, Some("Icon"), &icon_path)?;
        set_registry_string(&format!("{directory_key}\\command"), None, &command)?;
        set_registry_string(&background_key, None, "Open ScanlineTerm here")?;
        set_registry_string(&background_key, Some("Icon"), &icon_path)?;
        set_registry_string(&format!("{background_key}\\command"), None, &background_command)
    };
    if let Err(error) = register() {
        let _ = remove_context_key(&directory_key);
        let _ = remove_context_key(&background_key);
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub fn set_explorer_integration(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        use tauri::{path::BaseDirectory, Manager};
        let icon_path = if enabled {
            Some(app.path().resolve("window-icon.ico", BaseDirectory::Resource).map_err(|error| format!("could not locate Scanline Term window icon: {error}"))?)
        } else {
            None
        };
        apply_integration(enabled, icon_path.as_deref())
    }
    #[cfg(not(windows))]
    { let _ = (app, enabled); Err("Windows Explorer integration is only available on Windows".into()) }
}
