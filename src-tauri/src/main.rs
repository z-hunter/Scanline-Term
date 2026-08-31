#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    io::{Read, Write},
    sync::Mutex,
    thread,
};

use tauri::{Emitter, Manager, State};

struct TerminalSession {
    process: conpty::Process,
    writer: conpty::io::PipeWriter,
}

#[derive(Default)]
struct TerminalState(Mutex<Option<TerminalSession>>);

impl Drop for TerminalState {
    fn drop(&mut self) {
        if let Ok(session) = self.0.get_mut() {
            if let Some(mut session) = session.take() {
                let _ = session.process.exit(1);
            }
        }
    }
}

fn pty_size(cols: u16, rows: u16) -> Result<(i16, i16), String> {
    if !(20..=300).contains(&cols) || !(8..=150).contains(&rows) {
        return Err("terminal size is out of range".into());
    }
    Ok((cols as i16, rows as i16))
}

#[tauri::command]
fn start_terminal(app: tauri::AppHandle, state: State<TerminalState>, cols: u16, rows: u16) -> Result<(), String> {
    let size = pty_size(cols, rows)?;
    let mut session = state.0.lock().map_err(|_| "terminal state is unavailable")?;
    if session.is_some() {
        return Ok(());
    }

    let shell = std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into());
    let mut command = std::process::Command::new(shell);
    if let Some(home) = std::env::var_os("USERPROFILE") {
        command.current_dir(home);
    }
    let mut options = conpty::ProcessOptions::default();
    options.set_console_size(Some(size));
    let mut process = options.spawn(command).map_err(|error| error.to_string())?;
    let mut reader = process.output().map_err(|error| error.to_string())?;
    let mut writer = process.input().map_err(|error| error.to_string())?;
    writer.write_all(b"\r").map_err(|error| error.to_string())?;
    writer.flush().map_err(|error| error.to_string())?;
    *session = Some(TerminalSession { process, writer });
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
    let (cols, rows) = pty_size(cols, rows)?;
    let mut session = state.0.lock().map_err(|_| "terminal state is unavailable")?;
    let session = session.as_mut().ok_or("terminal is not running")?;
    session.process.resize(cols, rows).map_err(|error| error.to_string())
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
    use super::pty_size;

    #[test]
    fn limits_terminal_dimensions() {
        assert!(pty_size(80, 30).is_ok());
        assert!(pty_size(0, 30).is_err());
        assert!(pty_size(80, 151).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn conpty_streams_cmd_output() {
        use std::{
            io::{Read, Write},
            sync::mpsc,
            thread,
            time::Duration,
        };

        use conpty::ProcessOptions;

        let mut options = ProcessOptions::default();
        options.set_console_size(Some(pty_size(80, 30).unwrap()));
        let mut process = options.spawn(std::process::Command::new("cmd.exe")).unwrap();
        let mut reader = process.output().unwrap();
        let mut writer = process.input().unwrap();
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
    }
}
