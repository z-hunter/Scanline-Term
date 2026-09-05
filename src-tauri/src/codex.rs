use std::{fs, io::{BufRead, BufReader, Write}, path::PathBuf, process::{Child, ChildStdin, Command, Stdio}, sync::{atomic::{AtomicU64, Ordering}, Mutex}, thread};
#[cfg(windows)]
use std::os::windows::process::CommandExt;

use serde::Serialize;
use serde_json::Value;
use tauri::{Emitter, Manager, State};

static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

struct CodexProcess { child: Child, stdin: Mutex<ChildStdin>, generation: u64 }
#[derive(Default)] pub struct CodexState(Mutex<Option<CodexProcess>>);

#[derive(Clone, Serialize)] #[serde(rename_all = "camelCase")]
struct Payload { generation: u64, message: Value }
#[derive(Clone, Serialize)] #[serde(rename_all = "camelCase")]
struct TextPayload { generation: u64, text: String }
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct Started { pub generation: u64, pub version: String, pub workspace: String }

fn codex_command(command: &str) -> Command {
    let mut process = Command::new("cmd.exe");
    process.args(["/d", "/s", "/c", command]);
    #[cfg(windows)]
    process.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    process
}

fn version() -> Result<String, String> {
    let output = codex_command("codex --version").output().map_err(|_| "Codex CLI was not found on PATH".to_owned())?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let version = text.strip_prefix("codex-cli ").ok_or("Could not parse Codex CLI version")?;
    let parsed: Vec<u32> = version.split('.').map(str::parse).collect::<Result<_, _>>().map_err(|_| "Could not parse Codex CLI version")?;
    if parsed.len() != 3 || parsed.as_slice() < &[0, 152, 1] { return Err("Codex CLI 0.152.1 or newer is required".into()); }
    Ok(version.into())
}

fn kill(child: &mut Child) { let _ = Command::new("taskkill.exe").args(["/PID", &child.id().to_string(), "/T", "/F"]).output(); }

fn isolated_paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let home = app.path().app_local_data_dir().map_err(|error| error.to_string())?.join("codex");
    let workspace = home.join("workspace");
    fs::create_dir_all(&workspace).map_err(|error| format!("Could not create Codex workspace: {error}"))?;
    Ok((home, workspace))
}

#[tauri::command]
pub fn codex_start(app: tauri::AppHandle, state: State<CodexState>) -> Result<Started, String> {
    let (home, workspace) = isolated_paths(&app)?;
    let mut state = state.0.lock().map_err(|_| "Codex state is unavailable")?;
    if let Some(process) = state.as_mut() {
        if process.child.try_wait().map_err(|error| error.to_string())?.is_none() { return Ok(Started { generation: process.generation, version: version()?, workspace: workspace.to_string_lossy().into_owned() }); }
        *state = None;
    }
    let version = version()?;
    let mut child = codex_command("codex app-server --stdio").env("CODEX_HOME", home).current_dir(&workspace).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|error| format!("Could not start Codex: {error}"))?;
    let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);
    let stdin = child.stdin.take().ok_or("Codex stdin is unavailable")?;
    let stdout = child.stdout.take().ok_or("Codex stdout is unavailable")?;
    let stderr = child.stderr.take().ok_or("Codex stderr is unavailable")?;
    let app_out = app.clone(); thread::spawn(move || { for line in BufReader::new(stdout).lines().map_while(Result::ok) { match serde_json::from_str::<Value>(&line) { Ok(message) => { let _ = app_out.emit("codex-message", Payload { generation, message }); }, Err(_) => { let _ = app_out.emit("codex-stderr", TextPayload { generation, text: "Invalid JSONL from Codex app-server".into() }); } } } let _ = app_out.emit("codex-exit", TextPayload { generation, text: "Codex app-server exited".into() }); });
    thread::spawn(move || { for line in BufReader::new(stderr).lines().map_while(Result::ok) { let _ = app.emit("codex-stderr", TextPayload { generation, text: line }); } });
    *state = Some(CodexProcess { child, stdin: Mutex::new(stdin), generation });
    Ok(Started { generation, version, workspace: workspace.to_string_lossy().into_owned() })
}

#[tauri::command]
pub fn codex_send(state: State<CodexState>, message: Value) -> Result<(), String> {
    if !message.is_object() { return Err("Codex JSON-RPC message must be an object".into()); }
    let line = serde_json::to_string(&message).map_err(|error| error.to_string())?;
    let process = state.0.lock().map_err(|_| "Codex state is unavailable")?;
    let process = process.as_ref().ok_or("Codex app-server is not running")?;
    let mut stdin = process.stdin.lock().map_err(|_| "Codex stdin is unavailable")?;
    stdin.write_all(line.as_bytes()).and_then(|_| stdin.write_all(b"\n")).and_then(|_| stdin.flush()).map_err(|_| "Codex app-server is not running".into())
}

#[tauri::command]
pub fn codex_stop(state: State<CodexState>) -> Result<(), String> {
    let mut state = state.0.lock().map_err(|_| "Codex state is unavailable")?;
    if let Some(mut process) = state.take() { // ponytail: taskkill tree is sufficient for the sandbox experiment; use a Job Object for production lifecycle guarantees.
        kill(&mut process.child);
    }
    Ok(())
}

impl Drop for CodexState { fn drop(&mut self) { if let Ok(slot) = self.0.get_mut() { if let Some(process) = slot.as_mut() { kill(&mut process.child); } } } }
