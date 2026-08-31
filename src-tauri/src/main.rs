#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    io::{Read, Write},
    path::PathBuf,
    sync::Mutex,
    thread,
};

use conpty_oxide::{
    blocking::{Child, Command, OwnedWriteHalf},
    ConPtyBackend, PtyController, SessionOptions, Size,
};
use tauri::{path::BaseDirectory, Emitter, Manager, State};

struct TerminalSession {
    child: Child,
    writer: OwnedWriteHalf,
    controller: PtyController,
}

#[derive(Default)]
struct TerminalState(Mutex<Option<TerminalSession>>);

impl Drop for TerminalState {
    fn drop(&mut self) {
        if let Ok(session) = self.0.get_mut() {
            if let Some(mut session) = session.take() {
                let _ = session.child.kill();
            }
        }
    }
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

#[tauri::command]
fn start_terminal(app: tauri::AppHandle, state: State<TerminalState>, cols: u16, rows: u16) -> Result<(), String> {
    let size = pty_size(cols, rows)?;
    let mut session = state.0.lock().map_err(|_| "terminal state is unavailable")?;
    if session.is_some() {
        return Ok(());
    }

    let shell = std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into());
    let mut command = Command::new(shell);
    if let Some(home) = std::env::var_os("USERPROFILE") {
        command.current_dir(home);
    }
    let backend = ConPtyBackend::from_dir(bundled_conpty_dir(&app)?).map_err(|error| error.to_string())?;
    let options = SessionOptions::new().size(size).backend(backend);
    let conpty_session = command.spawn_with(options).map_err(|error| error.to_string())?;
    let conpty_oxide::blocking::SessionParts { child, output: mut reader, input: mut writer, controller, .. } = conpty_session.into_parts();
    writer.write_all(b"\r").map_err(|error| error.to_string())?;
    writer.flush().map_err(|error| error.to_string())?;
    *session = Some(TerminalSession { child, writer, controller });
    drop(session);

    thread::spawn(move || {
        let mut buffer = [0; 4096];
        while let Ok(count) = reader.read(&mut buffer) {
            if count == 0 {
                break;
            }
            let _ = app.emit("terminal-output", buffer[..count].to_vec());
        }
        if let Ok(mut session) = app.state::<TerminalState>().0.lock() {
            session.take();
        }
        let _ = app.emit("terminal-exit", ());
    });
    Ok(())
}

#[tauri::command]
fn write_terminal(state: State<TerminalState>, input: String) -> Result<(), String> {
    let mut session = state.0.lock().map_err(|_| "terminal state is unavailable")?;
    let session = session.as_mut().ok_or("terminal is not running")?;
    session.writer.write_all(input.as_bytes()).map_err(|error| error.to_string())?;
    session.writer.flush().map_err(|error| error.to_string())
}

#[tauri::command]
fn resize_terminal(state: State<TerminalState>, cols: u16, rows: u16) -> Result<(), String> {
    let size = pty_size(cols, rows)?;
    let mut session = state.0.lock().map_err(|_| "terminal state is unavailable")?;
    let session = session.as_mut().ok_or("terminal is not running")?;
    session.controller.resize(size).map_err(|error| error.to_string())
}

fn main() {
    tauri::Builder::default()
        .manage(TerminalState::default())
        .invoke_handler(tauri::generate_handler![start_terminal, write_terminal, resize_terminal])
        .run(tauri::generate_context!())
        .expect("error while running Scanline Term");
}

#[cfg(test)]
mod tests {
    use super::{dev_conpty_dir, pty_size};

    #[test]
    fn limits_terminal_dimensions() {
        assert!(pty_size(80, 30).is_ok());
        assert!(pty_size(0, 30).is_err());
        assert!(pty_size(80, 151).is_err());
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
        assert!(String::from_utf8_lossy(&output).contains("\x1b[?9001h"));
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
