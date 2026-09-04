#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::HashMap,
    io::{Read, Write},
    mem::size_of,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Sender},
        Mutex,
    },
    thread,
};

#[cfg(windows)]
use std::collections::BTreeSet;
#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
    System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS},
};

use conpty_oxide::{
    blocking::{Child, Command},
    ConPtyBackend, PtyController, SessionOptions, Size,
};
use tauri::{path::BaseDirectory, Emitter, Manager, State};
mod codex;

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

struct LaunchState(TerminalLaunch);

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

fn terminal_launch(args: &[String], cwd: &str) -> (TerminalLaunch, bool) {
    let mut target = None;
    let mut launch_in_tab = false;
    let mut explicit_cwd = None;
    let mut arguments = args.iter().skip(1);
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "-T" => launch_in_tab = true,
            "-P" => explicit_cwd = arguments.next().cloned(),
            _ if target.is_none() => target = Some(argument.clone()),
            _ => {}
        }
    }
    let target_path = target.as_deref().map(|target| {
        let path = PathBuf::from(target);
        if path.is_absolute() { path } else { Path::new(cwd).join(path) }
    });
    let command = target_path.as_ref().filter(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
        .or_else(|| target.filter(|_| target_path.as_ref().is_none_or(|path| !path.is_dir())));
    let cwd = explicit_cwd.or_else(|| target_path.filter(|path| path.is_dir()).map(|path| path.to_string_lossy().into_owned()));
    (TerminalLaunch { command, cwd }, launch_in_tab)
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
unsafe extern "system" fn collect_monospace_font(
    logfont: *const windows_sys::Win32::Graphics::Gdi::LOGFONTW,
    metric: *const windows_sys::Win32::Graphics::Gdi::TEXTMETRICW,
    _: u32,
    param: windows_sys::Win32::Foundation::LPARAM,
) -> i32 {
    use windows_sys::Win32::Graphics::Gdi::TMPF_FIXED_PITCH;

    let metric = unsafe { &*metric };
    // GDI already reports the family pitch here.  Comparing the rounded
    // average and maximum widths rejects valid OpenType monospace fonts.
    if metric.tmPitchAndFamily & TMPF_FIXED_PITCH != 0 {
        return 1;
    }
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
                Some(collect_monospace_font),
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
fn initial_terminal_launch(state: State<LaunchState>) -> TerminalLaunch {
    state.0.clone()
}

#[tauri::command]
fn operating_system() -> String {
    std::process::Command::new("cmd.exe").args(["/d", "/s", "/c", "ver"]).output()
        .ok().map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|version| !version.is_empty()).unwrap_or_else(|| std::env::consts::OS.to_owned())
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
    let shell = launch.command.map(Into::into).unwrap_or_else(|| std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into()));
    let shell_name = Path::new(&shell).file_name().and_then(|name| name.to_str()).unwrap_or("cmd.exe").to_owned();
    let mut command = Command::new(&shell);
    if let Some(cwd) = launch.cwd {
        command.current_dir(cwd);
    } else if let Some(home) = std::env::var_os("USERPROFILE") {
        command.current_dir(home);
    }
    let backend = ConPtyBackend::from_dir(bundled_conpty_dir(&app)?).map_err(|error| error.to_string())?;
    let options = SessionOptions::new().size(size).backend(backend);
    let conpty_session = command.spawn_with(options).map_err(|error| error.to_string())?;
    let conpty_oxide::blocking::SessionParts { mut child, output: mut reader, input: mut writer, controller, .. } = conpty_session.into_parts();
    writer.write_all(b"\r").map_err(|error| error.to_string())?;
    writer.flush().map_err(|error| error.to_string())?;
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

fn main() {
    let cwd = std::env::current_dir().unwrap_or_default();
    let (launch, _) = terminal_launch(&std::env::args().collect::<Vec<_>>(), &cwd.to_string_lossy());
    tauri::Builder::default()
        .manage(TerminalState::default())
        .manage(codex::CodexState::default())
        .manage(LaunchState(launch))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let (launch, launch_in_tab) = terminal_launch(&args, &cwd);
            if launch_in_tab {
                let _ = app.emit("terminal-launch", launch);
            }
            let _ = app.get_webview_window("main").map(|window| window.set_focus());
        }))
        .invoke_handler(tauri::generate_handler![start_terminal, write_terminal, resize_terminal, active_terminal_process, close_terminal, list_monospace_fonts, initial_terminal_launch, operating_system, codex::codex_start, codex::codex_send, codex::codex_stop])
        .run(tauri::generate_context!())
        .expect("error while running Scanline Term");
}

#[cfg(test)]
mod tests {
    use super::{child_process_name, dev_conpty_dir, pty_size, terminal_launch, valid_session_id, valid_working_directory};

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
