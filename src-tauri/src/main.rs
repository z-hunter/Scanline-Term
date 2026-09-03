#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{mpsc::{self, Sender}, Mutex},
    thread,
};

#[cfg(windows)]
use std::collections::BTreeSet;

use conpty_oxide::{
    blocking::{Child, Command},
    ConPtyBackend, PtyController, SessionOptions, Size,
};
use tauri::{path::BaseDirectory, Emitter, Manager, State};

struct TerminalSession {
    child: Child,
    input: Sender<Vec<u8>>,
    controller: PtyController,
}

type SessionId = String;

#[derive(Default)]
struct TerminalState(Mutex<HashMap<SessionId, TerminalSession>>);

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
fn start_terminal(app: tauri::AppHandle, state: State<TerminalState>, session_id: SessionId, cols: u16, rows: u16) -> Result<String, String> {
    valid_session_id(&session_id)?;
    let size = pty_size(cols, rows)?;
    if state.0.lock().map_err(|_| "terminal state is unavailable")?.contains_key(&session_id) {
        return Err("terminal session already exists".into());
    }

    let shell = std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into());
    let shell_name = Path::new(&shell).file_name().and_then(|name| name.to_str()).unwrap_or("cmd.exe").to_owned();
    let mut command = Command::new(&shell);
    if let Some(home) = std::env::var_os("USERPROFILE") {
        command.current_dir(home);
    }
    let backend = ConPtyBackend::from_dir(bundled_conpty_dir(&app)?).map_err(|error| error.to_string())?;
    let options = SessionOptions::new().size(size).backend(backend);
    let conpty_session = command.spawn_with(options).map_err(|error| error.to_string())?;
    let conpty_oxide::blocking::SessionParts { mut child, output: mut reader, input: mut writer, controller, .. } = conpty_session.into_parts();
    writer.write_all(b"\r").map_err(|error| error.to_string())?;
    writer.flush().map_err(|error| error.to_string())?;
    let (input_sender, input_receiver) = mpsc::channel::<Vec<u8>>();
    {
        let mut sessions = state.0.lock().map_err(|_| "terminal state is unavailable")?;
        if sessions.contains_key(&session_id) {
            let _ = child.kill();
            return Err("terminal session already exists".into());
        }
        sessions.insert(session_id.clone(), TerminalSession { child, input: input_sender, controller });
    }
    thread::spawn(move || {
        while let Ok(input) = input_receiver.recv() {
            if writer.write_all(&input).and_then(|_| writer.flush()).is_err() {
                break;
            }
        }
    });
    let reader_session_id = session_id.clone();
    thread::spawn(move || {
        let mut buffer = [0; 4096];
        while let Ok(count) = reader.read(&mut buffer) {
            if count == 0 {
                break;
            }
            let _ = app.emit("terminal-output", TerminalOutput { session_id: reader_session_id.clone(), data: buffer[..count].to_vec() });
        }
        if let Ok(mut sessions) = app.state::<TerminalState>().0.lock() {
            sessions.remove(&reader_session_id);
        }
        let _ = app.emit("terminal-exit", TerminalExit { session_id: reader_session_id });
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
fn close_terminal(state: State<TerminalState>, session_id: SessionId) -> Result<(), String> {
    valid_session_id(&session_id)?;
    let session = state.0.lock().map_err(|_| "terminal state is unavailable")?.remove(&session_id);
    if let Some(mut session) = session {
        let _ = session.child.kill();
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(TerminalState::default())
        .invoke_handler(tauri::generate_handler![start_terminal, write_terminal, resize_terminal, close_terminal, list_monospace_fonts])
        .run(tauri::generate_context!())
        .expect("error while running Scanline Term");
}

#[cfg(test)]
mod tests {
    use super::{dev_conpty_dir, pty_size, valid_session_id};

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
