#![cfg_attr(windows, windows_subsystem = "windows")]

use std::{
    collections::HashMap,
    ffi::{OsStr, OsString},
    io::{Read, Write},
    mem::size_of,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicI32, AtomicU64, Ordering},
        mpsc::{self, Sender},
        Mutex,
    },
    thread,
};

#[cfg(windows)]
use std::collections::BTreeSet;
#[cfg(windows)]
use std::sync::atomic::AtomicBool;
#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
    System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS},
};

use conpty_oxide::{
    blocking::{Child, Command},
    ConPtyBackend, PtyController, SessionOptions, Size,
};
use tauri::{image::Image, path::BaseDirectory, Emitter, Manager, State};
mod codex;
mod browser;
mod home;
mod presets;

struct TerminalSession {
    child: Child,
    input: Sender<Vec<u8>>,
    controller: PtyController,
    generation: u64,
}

static NEXT_SESSION_GENERATION: AtomicU64 = AtomicU64::new(1);

type SessionId = String;

#[derive(Default)]
struct TerminalState(Mutex<HashMap<SessionId, TerminalSession>>);

#[derive(Clone, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalLaunch {
    command: Option<String>,
    cwd: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellInfo {
    name: String,
    command: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum LaunchRequest { Terminal { command: Option<String>, cwd: Option<String> }, Browser { url: String } }
struct LaunchState(LaunchRequest);

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutput {
    session_id: SessionId,
    data: Vec<u8>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExit {
    session_id: SessionId,
}

impl Drop for TerminalState {
    fn drop(&mut self) {
        if let Ok(sessions) = self.0.get_mut() {
            for (_, mut session) in sessions.drain() {
                let _ = session.child.kill();
            }
        }
    }
}

fn valid_session_id(session_id: &str) -> Result<(), String> {
    let valid = session_id.len() == 36 && session_id.chars().enumerate().all(|(index, character)| {
        matches!(index, 8 | 13 | 18 | 23) && character == '-'
            || !matches!(index, 8 | 13 | 18 | 23) && character.is_ascii_hexdigit()
    });
    if valid { Ok(()) } else { Err("session id is invalid".into()) }
}

fn target_argument(args: &[String]) -> Option<&str> {
    let mut arguments = args.iter().skip(1);
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "-T" => {}
            "-P" => {
                arguments.next();
            }
            _ => return Some(argument.as_str()),
        }
    }
    None
}

fn terminal_launch(args: &[String], cwd: &str) -> (TerminalLaunch, bool) {
    let mut launch_in_tab = false;
    let mut explicit_cwd = None;
    let mut arguments = args.iter().skip(1);
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "-T" => launch_in_tab = true,
            "-P" => explicit_cwd = arguments.next().cloned(),
            _ => {}
        }
    }
    let target = target_argument(args);
    let target_path = target.map(|target| {
        let path = PathBuf::from(target);
        if path.is_absolute() { path } else { Path::new(cwd).join(path) }
    });
    let command = target_path.as_ref().filter(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
        .or_else(|| target.filter(|_| target_path.as_ref().is_none_or(|path| !path.is_dir())).map(str::to_owned));
    let cwd = explicit_cwd.or_else(|| target_path.filter(|path| path.is_dir()).map(|path| path.to_string_lossy().into_owned()));
    (TerminalLaunch { command, cwd }, launch_in_tab)
}

fn launch_request(args: &[String], cwd: &str) -> (LaunchRequest, bool) {
    if let Some(target) = target_argument(args) {
        if let Some(value) = browser::browser_target_url(target).ok().map(Into::into).or_else(|| {
            let path = Path::new(target);
            let path = if path.is_absolute() { path.to_path_buf() } else { Path::new(cwd).join(path) };
            browser::local_file_url(&path).map(Into::into)
        }) {
            return (LaunchRequest::Browser { url: value }, false);
        }
    }
    let (terminal, tab) = terminal_launch(args, cwd);
    (LaunchRequest::Terminal { command: terminal.command, cwd: terminal.cwd }, tab)
}

fn valid_working_directory(cwd: Option<&str>) -> Result<(), String> {
    if cwd.is_none_or(|cwd| Path::new(cwd).is_dir()) { Ok(()) } else { Err("terminal working directory does not exist".into()) }
}

fn pty_size(cols: u16, rows: u16) -> Result<Size, String> {
    if !(20..=300).contains(&cols) || !(8..=150).contains(&rows) {
        return Err("terminal size is out of range".into());
    }
    Size::try_new(cols, rows).map_err(|error| error.to_string())
}

fn shell_on_path(name: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?).map(|directory| directory.join(name)).find(|path| path.is_file())
}

fn powershell_name(name: &str, path: &Path) -> String {
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;
    let mut command = std::process::Command::new(path);
    command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"]);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::null());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return name.to_owned(),
    };
    let mut stdout = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut stream) = stdout.take() {
            let _ = stream.read_to_end(&mut buf);
        }
        buf
    });
    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_millis(1500);
    let mut exited = false;
    while start.elapsed() < timeout {
        match child.try_wait() {
            Ok(Some(_status)) => {
                exited = true;
                break;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(25)),
            Err(_) => break,
        }
    }
    if !exited {
        let _ = child.kill();
        let _ = child.wait();
        return name.to_owned();
    }
    let output = reader.join().unwrap_or_default();
    let version = String::from_utf8(output).ok().map(|output| output.trim().to_owned()).filter(|version| !version.is_empty());
    version.map_or_else(|| name.to_owned(), |version| format!("{name} {version}"))
}

fn powershell_core_installations() -> Vec<PathBuf> {
    let mut installations = Vec::new();
    for root in [std::env::var_os("ProgramFiles"), std::env::var_os("ProgramFiles(x86)")]
        .into_iter()
        .flatten()
        .map(PathBuf::from)
    {
        let ps_dir = root.join("PowerShell");
        if let Ok(entries) = std::fs::read_dir(&ps_dir) {
            let mut subdirs: Vec<PathBuf> = entries
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.path())
                .collect();
            subdirs.sort();
            for subdir in subdirs {
                let pwsh = subdir.join("pwsh.exe");
                if pwsh.is_file() {
                    installations.push(pwsh);
                }
            }
        }
        let direct = ps_dir.join("pwsh.exe");
        if direct.is_file() {
            installations.push(direct);
        }
    }
    installations
}

#[tauri::command]
fn list_available_shells() -> Vec<ShellInfo> {
    let mut shells = Vec::new();
    let mut add = |name: String, path: Option<PathBuf>| {
        if let Some(path) = path.filter(|path| path.is_file()) {
            if !shells.iter().any(|shell: &ShellInfo| shell.command.eq_ignore_ascii_case(&path.to_string_lossy())) {
                shells.push(ShellInfo { name, command: path.to_string_lossy().into_owned() });
            }
        }
    };
    add("Command Prompt".into(), std::env::var_os("ComSpec").map(PathBuf::from));
    let windows_powershell = std::env::var_os("SystemRoot").map(|root| PathBuf::from(root).join("System32/WindowsPowerShell/v1.0/powershell.exe")).or_else(|| shell_on_path("powershell.exe"));
    add(windows_powershell.as_ref().map_or_else(|| "Windows PowerShell".into(), |path| powershell_name("Windows PowerShell", path)), windows_powershell);
    for path in powershell_core_installations() {
        add(powershell_name("PowerShell", &path), Some(path));
    }
    let powershell = shell_on_path("pwsh.exe");
    add(powershell.as_ref().map_or_else(|| "PowerShell".into(), |path| powershell_name("PowerShell", path)), powershell);
    let git_bash = [std::env::var_os("ProgramFiles"), std::env::var_os("ProgramFiles(x86)"), std::env::var_os("LocalAppData")]
        .into_iter().flatten().map(PathBuf::from).map(|root| root.join("Git/bin/bash.exe"))
        .find(|path| path.is_file()).or_else(|| shell_on_path("bash.exe"));
    add("Git Bash".into(), git_bash);
    shells
}

fn bundled_conpty_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        return Ok(dev_conpty_dir());
    }
    app.path()
        .resolve("conpty/x64", BaseDirectory::Resource)
        .map_err(|error| error.to_string())
}

fn dev_conpty_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/conpty/x64")
}

fn spawn_terminal(app: &tauri::AppHandle, shell: &OsStr, cwd: Option<&str>, size: Size) -> Result<conpty_oxide::blocking::Session, String> {
    let mut command = Command::new(shell);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    } else if let Some(home) = std::env::var_os("USERPROFILE") {
        command.current_dir(home);
    }
    let backend = ConPtyBackend::from_dir(bundled_conpty_dir(app)?).map_err(|error| error.to_string())?;
    command.spawn_with(SessionOptions::new().size(size).backend(backend)).map_err(|error| error.to_string())
}

fn child_process_name(parent_pid: u32) -> Option<String> {
    #[cfg(windows)]
    {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut entry = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut found = None;
        let mut has_entry = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
        while has_entry {
            if entry.th32ParentProcessID == parent_pid {
                let end = entry.szExeFile.iter().position(|&unit| unit == 0).unwrap_or(entry.szExeFile.len());
                found = Some(String::from_utf16_lossy(&entry.szExeFile[..end]));
                break;
            }
            has_entry = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
        }
        unsafe { CloseHandle(snapshot) };
        found
    }
    #[cfg(not(windows))]
    {
        let _ = parent_pid;
        None
    }
}

#[cfg(windows)]
unsafe extern "system" fn collect_font(
    logfont: *const windows_sys::Win32::Graphics::Gdi::LOGFONTW,
    _metric: *const windows_sys::Win32::Graphics::Gdi::TEXTMETRICW,
    _font_type: u32,
    param: windows_sys::Win32::Foundation::LPARAM,
) -> i32 {
    let face_name = unsafe { &(*logfont).lfFaceName };
    let length = face_name.iter().position(|&unit| unit == 0).unwrap_or(face_name.len());
    let name = String::from_utf16_lossy(&face_name[..length]);
    if !name.is_empty() && !name.starts_with('@') {
        unsafe { &mut *(param as *mut BTreeSet<String>) }.insert(name);
    }
    1
}

#[tauri::command]
fn list_monospace_fonts() -> Vec<String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Graphics::Gdi::{CreateCompatibleDC, DeleteDC, EnumFontFamiliesExW, DEFAULT_CHARSET, LOGFONTW};

        let dc = unsafe { CreateCompatibleDC(std::ptr::null_mut()) };
        if dc.is_null() {
            return vec!["Consolas".into()];
        }
        let mut fonts = BTreeSet::new();
        let mut filter = LOGFONTW::default();
        filter.lfCharSet = DEFAULT_CHARSET;
        unsafe {
            EnumFontFamiliesExW(
                dc,
                &filter,
                Some(collect_font),
                &mut fonts as *mut BTreeSet<String> as isize,
                0,
            );
            DeleteDC(dc);
        }
        fonts.into_iter().collect()
    }
    #[cfg(not(windows))]
    {
        vec!["Consolas".into()]
    }
}

#[tauri::command]
fn initial_terminal_launch(state: State<LaunchState>) -> LaunchRequest {
    state.0.clone()
}

#[tauri::command]
fn operating_system() -> String {
    std::process::Command::new("cmd.exe").args(["/d", "/s", "/c", "ver"]).output()
        .ok().map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|version| !version.is_empty()).unwrap_or_else(|| std::env::consts::OS.to_owned())
}

#[cfg(windows)]
const SUMMON_HOTKEY_ID: i32 = 1;
#[cfg(windows)]
static SUMMON_HOTKEY_ENABLED: AtomicBool = AtomicBool::new(false);
#[cfg(windows)]
static SLIDE_FROM_TOP_ENABLED: AtomicBool = AtomicBool::new(true);
#[cfg(windows)]
static SUMMON_ANIMATION_GENERATION: AtomicU64 = AtomicU64::new(0);
#[cfg(windows)]
static SUMMON_HIDING: AtomicBool = AtomicBool::new(false);
#[cfg(windows)]
static SUMMON_SHOWING: AtomicBool = AtomicBool::new(false);
#[cfg(windows)]
static SUMMON_TARGET_X: AtomicI32 = AtomicI32::new(i32::MIN);
#[cfg(windows)]
static SUMMON_TARGET_Y: AtomicI32 = AtomicI32::new(i32::MIN);

#[cfg(windows)]
fn summon_hotkey() -> (u32, u32) {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{MOD_NOREPEAT, MOD_WIN, VK_OEM_3};
    (MOD_WIN | MOD_NOREPEAT, VK_OEM_3 as u32)
}

#[cfg(windows)]
fn system_font_bytes(family: &str) -> Result<Option<Vec<u8>>, String> {
    use windows_sys::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateFontW, DeleteDC, DeleteObject, GetFontData, GetTextFaceW,
        SelectObject, DEFAULT_CHARSET, GDI_ERROR,
    };

    let face_name = family.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    unsafe {
        let dc = CreateCompatibleDC(std::ptr::null_mut());
        if dc.is_null() {
            return Err("could not create a font device context".into());
        }
        let font = CreateFontW(0, 0, 0, 0, 400, 0, 0, 0, DEFAULT_CHARSET as u32, 0, 0, 0, 0, face_name.as_ptr());
        if font.is_null() {
            DeleteDC(dc);
            return Err("could not select the requested font".into());
        }
        let previous = SelectObject(dc, font as _);
        if previous.is_null() {
            DeleteObject(font as _);
            DeleteDC(dc);
            return Err("could not select the requested font".into());
        }
        let mut selected_face = [0u16; 64];
        let selected_length = GetTextFaceW(dc, selected_face.len() as i32, selected_face.as_mut_ptr());
        let selected_length = selected_face[..selected_length as usize]
            .iter().position(|&unit| unit == 0).unwrap_or(selected_length as usize);
        let matches_requested = selected_length > 0
            && String::from_utf16_lossy(&selected_face[..selected_length]).eq_ignore_ascii_case(family);
        let size = GetFontData(dc, 0, 0, std::ptr::null_mut(), 0);
        let result = if !matches_requested || size == GDI_ERROR as u32 {
            // Bitmap .fon faces are installed system fonts, but have no SFNT
            // data for FontFace. Canvas can still select them by family name.
            Ok(None)
        } else if size > 64 * 1024 * 1024 {
            Err("font data is too large".into())
        } else {
            let mut bytes = vec![0; size as usize];
            if GetFontData(dc, 0, 0, bytes.as_mut_ptr().cast(), size) == GDI_ERROR as u32 {
                Ok(None)
            } else {
                Ok(Some(bytes))
            }
        };
        SelectObject(dc, previous);
        DeleteObject(font as _);
        DeleteDC(dc);
        result
    }
}

#[tauri::command]
fn load_monospace_font(family: String) -> Result<Option<Vec<u8>>, String> {
    #[cfg(windows)]
    return system_font_bytes(&family);
    #[cfg(not(windows))]
    {
        let _ = family;
        Err("system font loading is only available on Windows".into())
    }
}

#[cfg(windows)]
fn is_window_active(window: &tauri::WebviewWindow) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetAncestor, GetForegroundWindow, GA_ROOT};
    if let Ok(hwnd) = window.hwnd() {
        unsafe { GetAncestor(GetForegroundWindow(), GA_ROOT) == hwnd.0 as _ }
    } else {
        false
    }
}

#[cfg(windows)]
fn focus_webview(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindow, IsWindowVisible, GW_CHILD, GW_HWNDNEXT};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::SetFocus;

    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let mut child = GetWindow(hwnd.0 as _, GW_CHILD);
            while !child.is_null() {
                if IsWindowVisible(child) != 0 {
                    let _ = SetFocus(child);
                    break;
                }
                child = GetWindow(child, GW_HWNDNEXT);
            }
        }
    }
}

#[cfg(windows)]
fn click_webview(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        mouse_event, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetCursorPos, GetWindow, GetWindowRect, IsWindowVisible, SetCursorPos, GW_CHILD,
        GW_HWNDNEXT,
    };

    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let mut child = GetWindow(hwnd.0 as _, GW_CHILD);
            while !child.is_null() {
                if IsWindowVisible(child) != 0 {
                    let mut rect = windows_sys::Win32::Foundation::RECT { left: 0, top: 0, right: 0, bottom: 0 };
                    let mut cursor = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
                    if GetWindowRect(child, &mut rect) != 0 && GetCursorPos(&mut cursor) != 0 {
                        // WebView2 ignores PostMessage mouse events after activation. This real middle-click
                        // is intentional: do not replace it with SetFocus, DOM focus, or PostMessage.
                        SetCursorPos((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
                        mouse_event(MOUSEEVENTF_MIDDLEDOWN, 0, 0, 0, 0);
                        mouse_event(MOUSEEVENTF_MIDDLEUP, 0, 0, 0, 0);
                        SetCursorPos(cursor.x, cursor.y);
                    }
                    break;
                }
                child = GetWindow(child, GW_HWNDNEXT);
            }
        }
    }
}

#[cfg(windows)]
fn is_focus_activation(message: u32, wparam: usize) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{WA_ACTIVE, WA_CLICKACTIVE, WM_ACTIVATE};
    message == WM_ACTIVATE && matches!(wparam as u32 & 0xffff, WA_ACTIVE | WA_CLICKACTIVE)
}

#[cfg(windows)]
fn main_webview_is_active(window: &tauri::WebviewWindow) -> bool {
    !window.app_handle().state::<browser::BrowserState>().has_active_browser()
}

#[cfg(windows)]
fn slide_summon_window(window: &tauri::WebviewWindow, showing: bool) {
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowPlacement, GetWindowRect, SetWindowPos, WINDOWPLACEMENT, SWP_NOACTIVATE,
        SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, ShowWindow, SW_HIDE, SW_RESTORE,
    };

    let Ok(hwnd) = window.hwnd() else { return; };
    let hwnd = hwnd.0 as usize;
    let mut rect = windows_sys::Win32::Foundation::RECT { left: 0, top: 0, right: 0, bottom: 0 };
    let mut placement = WINDOWPLACEMENT {
        length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
        flags: 0,
        showCmd: 0,
        ptMinPosition: windows_sys::Win32::Foundation::POINT { x: 0, y: 0 },
        ptMaxPosition: windows_sys::Win32::Foundation::POINT { x: 0, y: 0 },
        rcNormalPosition: windows_sys::Win32::Foundation::RECT { left: 0, top: 0, right: 0, bottom: 0 },
    };
    let mut monitor = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, rcMonitor: windows_sys::Win32::Foundation::RECT { left: 0, top: 0, right: 0, bottom: 0 }, rcWork: windows_sys::Win32::Foundation::RECT { left: 0, top: 0, right: 0, bottom: 0 }, dwFlags: 0 };
    unsafe {
        if GetWindowRect(hwnd as _, &mut rect) == 0 || GetWindowPlacement(hwnd as _, &mut placement) == 0 { return; }
        let monitor_handle = MonitorFromWindow(hwnd as _, MONITOR_DEFAULTTONEAREST);
        if monitor_handle.is_null() || GetMonitorInfoW(monitor_handle, &mut monitor) == 0 { return; }
    }

    let normal = placement.rcNormalPosition;
    let normal_is_visible = normal.right > monitor.rcWork.left
        && normal.left < monitor.rcWork.right
        && normal.bottom > monitor.rcWork.top
        && normal.top < monitor.rcWork.bottom;
    let default_x = if normal_is_visible { normal.left } else { monitor.rcWork.left + 32 };
    let default_y = if normal_is_visible { normal.top } else { monitor.rcWork.top + 32 };
    let preserve_saved_target = !showing && SUMMON_SHOWING.load(Ordering::SeqCst);
    let saved_x = SUMMON_TARGET_X.load(Ordering::SeqCst);
    let saved_y = SUMMON_TARGET_Y.load(Ordering::SeqCst);
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;
    let saved_is_visible = saved_x != i32::MIN && saved_y != i32::MIN
        && saved_x + width > monitor.rcWork.left && saved_x < monitor.rcWork.right
        && saved_y + height > monitor.rcWork.top && saved_y < monitor.rcWork.bottom;
    let target_x = if !showing && !preserve_saved_target {
        SUMMON_TARGET_X.store(rect.left, Ordering::SeqCst); rect.left
    } else if saved_is_visible { saved_x } else { default_x };
    let target_y = if !showing && !preserve_saved_target {
        SUMMON_TARGET_Y.store(rect.top, Ordering::SeqCst); rect.top
    } else if saved_is_visible { saved_y } else { default_y };
    let hidden_y = monitor.rcMonitor.top - height + 8;
    let from = if showing { hidden_y } else { rect.top };
    let to = if showing { target_y } else { hidden_y };
    let generation = SUMMON_ANIMATION_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    if showing {
        SUMMON_SHOWING.store(true, Ordering::SeqCst);
        SUMMON_HIDING.store(false, Ordering::SeqCst);
        unsafe {
            ShowWindow(hwnd as _, SW_RESTORE);
            SetWindowPos(hwnd as _, std::ptr::null_mut(), target_x, from, 0, 0, SWP_NOACTIVATE | SWP_NOSIZE | SWP_NOZORDER | SWP_SHOWWINDOW);
        }
        let _ = window.set_focus();
        focus_webview(window);
    } else {
        SUMMON_SHOWING.store(false, Ordering::SeqCst);
        SUMMON_HIDING.store(true, Ordering::SeqCst);
    }

    let window = window.clone();
    std::thread::spawn(move || {
        let started = std::time::Instant::now();
        let duration = std::time::Duration::from_millis(180);
        loop {
            if SUMMON_ANIMATION_GENERATION.load(Ordering::SeqCst) != generation { return; }
            let progress = (started.elapsed().as_secs_f32() / duration.as_secs_f32()).min(1.0);
            let eased = 1.0 - (1.0 - progress).powi(3);
            let y = from + ((to - from) as f32 * eased) as i32;
            unsafe { SetWindowPos(hwnd as _, std::ptr::null_mut(), target_x, y, 0, 0, SWP_NOACTIVATE | SWP_NOSIZE | SWP_NOZORDER); }
            if progress >= 1.0 { break; }
            std::thread::sleep(std::time::Duration::from_millis(16));
        }
        if SUMMON_ANIMATION_GENERATION.load(Ordering::SeqCst) != generation { return; }
        if !showing {
            unsafe {
                ShowWindow(hwnd as _, SW_HIDE);
            }
        } else {
            SUMMON_SHOWING.store(false, Ordering::SeqCst);
            focus_webview(&window);
            let _ = window.app_handle().emit("window-summoned", ());
        }
    });
}

#[cfg(not(windows))]
fn is_window_active(window: &tauri::WebviewWindow) -> bool {
    window.is_focused().unwrap_or(false)
}

#[cfg(not(windows))]
fn focus_webview(window: &tauri::WebviewWindow) {}

fn restore_and_focus_window(window: &tauri::WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    focus_webview(window);
    let _ = window.app_handle().emit("window-summoned", ());
    let window_clone = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(50));
        focus_webview(&window_clone);
    });
}

fn toggle_summon_window(window: &tauri::WebviewWindow) {
    #[cfg(windows)]
    if SLIDE_FROM_TOP_ENABLED.load(Ordering::SeqCst) {
        if window.is_visible().unwrap_or(false) && is_window_active(window) {
            slide_summon_window(window, false);
        } else {
            slide_summon_window(window, true);
        }
        return;
    }
    if window.is_visible().unwrap_or(false) && is_window_active(window) {
        let _ = window.hide();
    } else {
        restore_and_focus_window(window);
    }
}

#[cfg(windows)]
static PREV_WNDPROC: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);
#[cfg(windows)]
static MAIN_WINDOW: std::sync::OnceLock<tauri::WebviewWindow> = std::sync::OnceLock::new();

#[cfg(windows)]
unsafe extern "system" fn window_subclass_proc(
    hwnd: windows_sys::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows_sys::Win32::Foundation::WPARAM,
    lparam: windows_sys::Win32::Foundation::LPARAM,
) -> windows_sys::Win32::Foundation::LRESULT {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallWindowProcW, WM_HOTKEY, WM_SIZE, SIZE_MINIMIZED, SIZE_RESTORED,
        SIZE_MAXIMIZED, WM_SYSCOMMAND, SC_MINIMIZE,
    };

    static WAS_MINIMIZED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

    if msg == WM_HOTKEY && wparam == SUMMON_HOTKEY_ID as usize {
        if let Some(window) = MAIN_WINDOW.get() {
            toggle_summon_window(window);
        }
        return 0;
    }

    if !SUMMON_HIDING.load(std::sync::atomic::Ordering::SeqCst)
        && msg == WM_SYSCOMMAND && ((wparam & 0xFFF0) as u32) == SC_MINIMIZE {
        WAS_MINIMIZED.store(true, std::sync::atomic::Ordering::SeqCst);
    } else if !SUMMON_HIDING.load(std::sync::atomic::Ordering::SeqCst) && msg == WM_SIZE {
        if wparam == SIZE_MINIMIZED as usize {
            WAS_MINIMIZED.store(true, std::sync::atomic::Ordering::SeqCst);
        } else if (wparam == SIZE_RESTORED as usize || wparam == SIZE_MAXIMIZED as usize)
            && WAS_MINIMIZED.swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            if let Some(window) = MAIN_WINDOW.get() {
                restore_and_focus_window(window);
            }
        }
    }

    let prev = PREV_WNDPROC.load(std::sync::atomic::Ordering::SeqCst);
    let result = CallWindowProcW(std::mem::transmute(prev), hwnd, msg, wparam, lparam);

    if is_focus_activation(msg, wparam) {
        if let Some(window) = MAIN_WINDOW.get() {
            let window_clone = window.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(10));
                if is_window_active(&window_clone) && main_webview_is_active(&window_clone) {
                    focus_webview(&window_clone);
                    if !SUMMON_SHOWING.load(Ordering::SeqCst) { click_webview(&window_clone); }
                    let _ = window_clone.app_handle().emit("window-summoned", ());
                }
            });
        }
    }

    result
}

#[cfg(windows)]
fn setup_window_restore_listener(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SetWindowLongPtrW, GWLP_WNDPROC};
    let _ = MAIN_WINDOW.set(window.clone());
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let prev = SetWindowLongPtrW(hwnd.0 as _, GWLP_WNDPROC, window_subclass_proc as *const () as usize as isize);
            PREV_WNDPROC.store(prev, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let window = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(100));
        if is_window_active(&window) && main_webview_is_active(&window) {
            focus_webview(&window);
            click_webview(&window);
            let _ = window.app_handle().emit("window-summoned", ());
        }
    });
}

#[tauri::command]
fn set_global_hotkey_enabled(app: tauri::AppHandle, enabled: bool, slide_from_top: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey};

        SLIDE_FROM_TOP_ENABLED.store(slide_from_top, Ordering::SeqCst);

        let window = app.get_webview_window("main").ok_or("main window is unavailable")?;
        let hwnd = window.hwnd().map_err(|error| error.to_string())?;
        if enabled && !SUMMON_HOTKEY_ENABLED.load(Ordering::SeqCst) {
            let (modifiers, key) = summon_hotkey();
            if unsafe { RegisterHotKey(hwnd.0 as _, SUMMON_HOTKEY_ID, modifiers, key) } == 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            SUMMON_HOTKEY_ENABLED.store(true, Ordering::SeqCst);
        } else if !enabled && SUMMON_HOTKEY_ENABLED.load(Ordering::SeqCst) {
            if unsafe { UnregisterHotKey(hwnd.0 as _, SUMMON_HOTKEY_ID) } == 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            SUMMON_HOTKEY_ENABLED.store(false, Ordering::SeqCst);
        }
    }
    #[cfg(not(windows))]
    let _ = (app, enabled, slide_from_top);
    Ok(())
}

#[tauri::command]
fn start_terminal(app: tauri::AppHandle, state: State<TerminalState>, session_id: SessionId, cols: u16, rows: u16, launch: Option<TerminalLaunch>) -> Result<String, String> {
    valid_session_id(&session_id)?;
    let size = pty_size(cols, rows)?;
    if state.0.lock().map_err(|_| "terminal state is unavailable")?.contains_key(&session_id) {
        return Err("terminal session already exists".into());
    }

    let launch = launch.unwrap_or_default();
    valid_working_directory(launch.cwd.as_deref())?;
    let fallback_shell = std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into());
    let requested_shell = launch.command.map(OsString::from);
    let (conpty_session, shell) = match spawn_terminal(&app, requested_shell.as_deref().unwrap_or(&fallback_shell), launch.cwd.as_deref(), size) {
        Ok(session) => (session, requested_shell.unwrap_or(fallback_shell)),
        Err(_) if requested_shell.is_some() => (spawn_terminal(&app, &fallback_shell, launch.cwd.as_deref(), size)?, fallback_shell),
        Err(error) => return Err(error),
    };
    let shell_name = Path::new(&shell).file_name().and_then(|name| name.to_str()).unwrap_or("cmd.exe").to_owned();
    let conpty_oxide::blocking::SessionParts { mut child, output: mut reader, input: mut writer, controller, .. } = conpty_session.into_parts();
    let generation = NEXT_SESSION_GENERATION.fetch_add(1, Ordering::Relaxed);
    let (input_sender, input_receiver) = mpsc::channel::<Vec<u8>>();
    {
        let mut sessions = state.0.lock().map_err(|_| "terminal state is unavailable")?;
        if sessions.contains_key(&session_id) {
            let _ = child.kill();
            return Err("terminal session already exists".into());
        }
        sessions.insert(session_id.clone(), TerminalSession { child, input: input_sender, controller, generation });
    }
    thread::spawn(move || {
        while let Ok(input) = input_receiver.recv() {
            if writer.write_all(&input).and_then(|_| writer.flush()).is_err() {
                break;
            }
        }
    });
    let reader_session_id = session_id.clone();
    let reader_generation = generation;
    thread::spawn(move || {
        let mut buffer = [0; 4096];
        while let Ok(count) = reader.read(&mut buffer) {
            if count == 0 {
                break;
            }
            let _ = app.emit("terminal-output", TerminalOutput { session_id: reader_session_id.clone(), data: buffer[..count].to_vec() });
        }
        let mut exited = false;
        if let Ok(mut sessions) = app.state::<TerminalState>().0.lock() {
            if sessions.get(&reader_session_id).map(|session| session.generation) == Some(reader_generation) {
                sessions.remove(&reader_session_id);
                exited = true;
            }
        }
        if exited {
            let _ = app.emit("terminal-exit", TerminalExit { session_id: reader_session_id });
        }
    });
    Ok(shell_name)
}

#[tauri::command]
fn write_terminal(state: State<TerminalState>, session_id: SessionId, input: String) -> Result<(), String> {
    valid_session_id(&session_id)?;
    let sender = state.0.lock().map_err(|_| "terminal state is unavailable")?
        .get(&session_id).ok_or("terminal is not running")?.input.clone();
    sender.send(input.into_bytes()).map_err(|_| "terminal is not running".into())
}

#[tauri::command]
fn resize_terminal(state: State<TerminalState>, session_id: SessionId, cols: u16, rows: u16) -> Result<(), String> {
    valid_session_id(&session_id)?;
    let size = pty_size(cols, rows)?;
    let mut sessions = state.0.lock().map_err(|_| "terminal state is unavailable")?;
    let session = sessions.get_mut(&session_id).ok_or("terminal is not running")?;
    session.controller.resize(size).map_err(|error| error.to_string())
}

#[tauri::command]
fn active_terminal_process(state: State<TerminalState>, session_id: SessionId) -> Result<Option<String>, String> {
    valid_session_id(&session_id)?;
    let process_id = state.0.lock().map_err(|_| "terminal state is unavailable")?
        .get(&session_id).ok_or("terminal is not running")?.child.id();
    Ok(child_process_name(process_id))
}

#[tauri::command]
fn close_terminal(state: State<TerminalState>, session_id: SessionId) -> Result<(), String> {
    valid_session_id(&session_id)?;
    let session = state.0.lock().map_err(|_| "terminal state is unavailable")?.remove(&session_id);
    if let Some(mut session) = session {
        let _ = session.child.kill();
    }
    Ok(())
}

#[tauri::command]
fn confirm_close_with_sessions(app: tauri::AppHandle) -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            MessageBoxW, IDYES, MB_DEFBUTTON2, MB_ICONWARNING, MB_YESNO,
        };

        let text: Vec<u16> = "Open terminal sessions will be closed.\n\nClose Scanline Term?\0".encode_utf16().collect();
        let title: Vec<u16> = "Scanline Term\0".encode_utf16().collect();
        let hwnd = app.get_webview_window("main").and_then(|window| window.hwnd().ok()).map(|hwnd| hwnd.0 as _).unwrap_or(std::ptr::null_mut());
        unsafe { MessageBoxW(hwnd, text.as_ptr(), title.as_ptr(), MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2) == IDYES }
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        true
    }
}

fn main() {
    let cwd = std::env::current_dir().unwrap_or_default();
    let (launch, _) = launch_request(&std::env::args().collect::<Vec<_>>(), &cwd.to_string_lossy());
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(TerminalState::default())
        .manage(browser::BrowserState::default())
        .manage(codex::CodexState::default())
        .manage(LaunchState(launch))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let icon = Image::from_bytes(include_bytes!("../icons/32x32 - Copy.png"))?;
            let window = app.get_webview_window("main").ok_or("main window is unavailable")?;
            window.set_icon(icon)?;
            #[cfg(windows)]
            setup_window_restore_listener(&window);
            Ok(())
        })
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let (launch, launch_in_tab) = launch_request(&args, &cwd);
            match launch { LaunchRequest::Browser { .. } => { let _ = app.emit("browser-launch", launch); }, LaunchRequest::Terminal { command, cwd } if launch_in_tab => { let _ = app.emit("terminal-launch", TerminalLaunch { command, cwd }); }, _ => {} }
            if let Some(window) = app.get_webview_window("main") {
                restore_and_focus_window(&window);
            }
        }))
        .invoke_handler(tauri::generate_handler![start_terminal, write_terminal, resize_terminal, active_terminal_process, close_terminal, confirm_close_with_sessions, list_monospace_fonts, load_monospace_font, list_available_shells, initial_terminal_launch, operating_system, set_global_hotkey_enabled, browser::create_browser, browser::navigate_browser, browser::set_active_browser, browser::close_browser, home::load_home_config, home::save_home_config, presets::list_presets, presets::load_preset, presets::save_preset, codex::codex_start, codex::codex_send, codex::codex_stop])
        .run(tauri::generate_context!())
        .expect("error while running Scanline Term");
}

#[cfg(test)]
mod tests {
    use super::{
        child_process_name, dev_conpty_dir, launch_request, powershell_name, pty_size, summon_hotkey,
        target_argument, terminal_launch, valid_session_id,
        valid_working_directory, LaunchRequest,
    };
    #[cfg(windows)]
    use super::{is_focus_activation, system_font_bytes};

    #[test]
    fn powershell_name_resolves_or_falls_back_without_hanging() {
        let non_existent = std::path::Path::new("C:\\definitely_not_a_powershell_executable_path.exe");
        assert_eq!(powershell_name("PowerShell", non_existent), "PowerShell");
    }

    #[test]
    fn uses_win_backquote_for_global_summon() {
        assert_eq!(summon_hotkey(), (0x4008, 0xC0));
    }

    #[cfg(windows)]
    #[test]
    fn native_focus_click_runs_only_for_window_activation() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{WA_ACTIVE, WA_CLICKACTIVE, WM_ACTIVATE, WM_SETFOCUS};
        assert!(is_focus_activation(WM_ACTIVATE, WA_ACTIVE as usize));
        assert!(is_focus_activation(WM_ACTIVATE, WA_CLICKACTIVE as usize));
        assert!(!is_focus_activation(WM_SETFOCUS, 0));
        assert!(!is_focus_activation(WM_ACTIVATE, 0));
    }

    #[test]
    fn limits_terminal_dimensions() {
        assert!(pty_size(80, 30).is_ok());
        assert!(pty_size(0, 30).is_err());
        assert!(pty_size(80, 151).is_err());
    }

    #[test]
    fn validates_frontend_session_ids() {
        assert!(valid_session_id("5ed6dbb8-3ed9-459a-8aa3-3c7a9e6cb064").is_ok());
        assert!(valid_session_id("not-a-session-id").is_err());
    }

    #[test]
    fn unrelated_process_has_no_child() {
        assert_eq!(child_process_name(u32::MAX), None);
    }

    #[test]
    fn parses_target_argument_preserving_options() {
        let args = vec!["scanline-term".into(), "-T".into(), "-P".into(), "C:\\temp".into(), "pwsh".into()];
        assert_eq!(target_argument(&args), Some("pwsh"));

        let args = vec!["scanline-term".into(), "-P".into(), "C:\\temp".into(), "-T".into()];
        assert_eq!(target_argument(&args), None);

        let args = vec!["scanline-term".into(), "https://example.com".into(), "-T".into()];
        assert_eq!(target_argument(&args), Some("https://example.com"));
    }

    #[test]
    fn routes_browser_and_terminal_launch_requests() {
        let args = vec!["scanline-term".into(), "-T".into(), "-P".into(), "C:\\temp".into(), "https://example.com".into()];
        let (request, in_tab) = launch_request(&args, "C:\\work");
        assert!(!in_tab);
        match request {
            LaunchRequest::Browser { url } => assert_eq!(url, "https://example.com/"),
            _ => panic!("expected browser launch request"),
        }

        let args = vec!["scanline-term".into(), "-T".into(), "-P".into(), "C:\\temp".into(), "pwsh".into()];
        let (request, in_tab) = launch_request(&args, "C:\\work");
        assert!(in_tab);
        match request {
            LaunchRequest::Terminal { command, cwd } => {
                assert_eq!(command.as_deref(), Some("pwsh"));
                assert_eq!(cwd.as_deref(), Some("C:\\temp"));
            }
            _ => panic!("expected terminal launch request"),
        }
    }

    #[test]
    fn routes_existing_local_files_to_the_browser() {
        use std::time::{SystemTime, UNIX_EPOCH};
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let test_dir =
            std::env::temp_dir().join(format!("scanline-term-launch-test-{}", timestamp));
        std::fs::create_dir(&test_dir).unwrap();

        for extension in ["htm", "html", "PDF", "txt"] {
            let file = test_dir.join(format!("test.{extension}"));
            std::fs::write(&file, "<h1>test</h1>").unwrap();
            let args = vec!["scanline-term".into(), "-T".into(), file.to_string_lossy().into_owned()];
            let (request, in_tab) = launch_request(&args, "C:\\work");
            assert!(!in_tab);
            match request {
                LaunchRequest::Browser { url } => assert!(url.starts_with("file:///")),
                _ => panic!("expected browser launch request"),
            }

            let args = vec!["scanline-term".into(), url::Url::from_file_path(&file).unwrap().into()];
            let (request, in_tab) = launch_request(&args, "C:\\work");
            assert!(!in_tab);
            assert!(matches!(request, LaunchRequest::Browser { .. }));
        }
        std::fs::remove_dir_all(test_dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn reads_registered_monospace_font_data() {
        assert!(!system_font_bytes("Consolas").unwrap().expect("Consolas must expose SFNT data").is_empty());
    }

    #[test]
    fn parses_terminal_launch_arguments() {
        let args = vec!["scanline-term".into(), "pwsh".into(), "-P".into(), "C:\\temp".into(), "-T".into()];
        let (launch, in_tab) = terminal_launch(&args, "C:\\work");
        assert_eq!(launch.command.as_deref(), Some("pwsh"));
        assert_eq!(launch.cwd.as_deref(), Some("C:\\temp"));
        assert!(in_tab);
    }

    #[test]
    fn treats_a_directory_as_shell_working_directory() {
        let directory = std::env::temp_dir();
        let args = vec!["scanline-term".into(), directory.to_string_lossy().into_owned()];
        let (launch, in_tab) = terminal_launch(&args, "C:\\work");
        assert_eq!(launch.command, None);
        assert_eq!(launch.cwd.as_deref(), directory.to_str());
        assert!(!in_tab);
    }

    #[test]
    fn rejects_a_missing_working_directory() {
        assert!(valid_working_directory(Some("C:\\definitely-missing-scanline-term-directory")).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn bundled_conpty_streams_win32_input_request() {
        use std::{
            io::{Read, Write},
            sync::mpsc,
            thread,
            time::Duration,
        };

        use conpty_oxide::{blocking::Command, ConPtyBackend, SessionOptions};

        let backend = ConPtyBackend::from_dir(dev_conpty_dir()).unwrap();
        let mut command = Command::new("cmd.exe");
        let session = command.spawn_with(SessionOptions::new().size(pty_size(80, 30).unwrap()).backend(backend)).unwrap();
        let conpty_oxide::blocking::SessionParts { child: _child, output: mut reader, input: mut writer, .. } = session.into_parts();
        writer.write_all(b"echo scanline-conpty\r").unwrap();
        writer.flush().unwrap();
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            loop {
                let mut bytes = [0; 1024];
                match reader.read(&mut bytes) {
                    Ok(0) => break,
                    Ok(count) if sender.send(Ok(bytes[..count].to_vec())).is_err() => break,
                    Ok(_) => {}
                    Err(error) => {
                        let _ = sender.send(Err(error));
                        break;
                    }
                }
            }
        });
        let mut output = Vec::new();
        while !String::from_utf8_lossy(&output).contains("scanline-conpty") {
            output.extend(receiver.recv_timeout(Duration::from_secs(5)).unwrap().unwrap());
        }
        let output = String::from_utf8_lossy(&output);
        assert!(output.contains("\x1b[?9001h"));
    }

    #[cfg(windows)]
    #[test]
    fn win32_input_mode_delivers_function_key() {
        use std::{io::{Read, Write}, sync::mpsc, thread, time::Duration};

        use conpty_oxide::{blocking::Command, ConPtyBackend, SessionOptions};

        let backend = ConPtyBackend::from_dir(dev_conpty_dir()).unwrap();
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile", "-Command", "$key=[Console]::ReadKey($true); [Console]::WriteLine($key.Key)"]);
        let session = command.spawn_with(SessionOptions::new().size(pty_size(80, 30).unwrap()).backend(backend)).unwrap();
        let conpty_oxide::blocking::SessionParts { child: _child, output: mut reader, input: mut writer, .. } = session.into_parts();
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || loop {
            let mut bytes = [0; 1024];
            match reader.read(&mut bytes) {
                Ok(0) => break,
                Ok(count) if sender.send(Ok(bytes[..count].to_vec())).is_err() => break,
                Ok(_) => {}
                Err(error) => {
                    let _ = sender.send(Err(error));
                    break;
                }
            }
        });
        writer.write_all(b"\x1b[112;59;0;1;0;1_").unwrap();
        writer.flush().unwrap();
        let mut output = Vec::new();
        while !String::from_utf8_lossy(&output).contains("F1") {
            output.extend(receiver.recv_timeout(Duration::from_secs(5)).unwrap().unwrap());
        }
    }
}

// Force rebuild
