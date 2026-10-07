use std::{
    collections::HashMap,
    io::{self, BufRead, BufReader, BufWriter, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

use interprocess::local_socket::{GenericNamespaced, ListenerOptions, Stream, prelude::*};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

const SOCKET_NAME: &str = "scanline-term-mcp";
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(65);

#[derive(Clone, Default)]
pub struct McpState {
    inner: Arc<McpInner>,
}

#[derive(Default)]
struct McpInner {
    stop: Mutex<Option<Arc<AtomicBool>>>,
    connections: Mutex<HashMap<String, Arc<AtomicBool>>>,
    pending: Mutex<HashMap<String, mpsc::Sender<McpResponse>>>,
    owner_counter: AtomicU64,
    handle_counter: AtomicU64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpRequest {
    request_id: String,
    owner_id: String,
    method: String,
    params: Value,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpOwnerDisconnected {
    owner_id: String,
}

#[derive(Clone)]
struct McpResponse {
    result: Value,
    error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireRequest {
    request_id: String,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireResponse {
    request_id: String,
    result: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn socket_name() -> io::Result<interprocess::local_socket::Name<'static>> {
    SOCKET_NAME.to_ns_name::<GenericNamespaced>()
}

impl McpState {
    pub fn set_enabled(&self, app: AppHandle, enabled: bool) -> Result<(), String> {
        if enabled {
            let mut stop_guard = self
                .inner
                .stop
                .lock()
                .map_err(|_| "MCP state lock poisoned")?;
            if stop_guard.is_some() {
                return Ok(());
            }
            let stop = Arc::new(AtomicBool::new(false));
            *stop_guard = Some(stop.clone());
            let state = self.clone();
            thread::Builder::new()
                .name("scanline-term-mcp".into())
                .spawn(move || run_listener(app, state, stop))
                .map_err(|error| format!("could not start MCP listener: {error}"))?;
        } else {
            let stop = self
                .inner
                .stop
                .lock()
                .map_err(|_| "MCP state lock poisoned")?
                .take();
            if let Some(stop) = stop {
                stop.store(true, Ordering::Release);
                for owner_id in self.stop_connections() {
                    let _ = app.emit("mcp-owner-disconnected", McpOwnerDisconnected { owner_id });
                }
                if let Ok(name) = socket_name() {
                    if let Ok(mut wake) = Stream::connect(name) {
                        let _ = wake.write_all(b"\n");
                    }
                }
            }
        }
        Ok(())
    }

    fn respond(&self, request_id: String, result: Value, error: Option<String>) {
        let sender = self
            .inner
            .pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(&request_id));
        if let Some(sender) = sender {
            let _ = sender.send(McpResponse { result, error });
        }
    }

    fn cancel_owner(&self, owner_id: &str) {
        let prefix = format!("{owner_id}:");
        if let Ok(mut pending) = self.inner.pending.lock() {
            pending.retain(|request_id, sender| {
                if request_id.starts_with(&prefix) {
                    let _ = sender.send(McpResponse {
                        result: Value::Null,
                        error: Some("MCP connection closed".into()),
                    });
                    false
                } else {
                    true
                }
            });
        }
    }

    fn register_connection(&self, owner_id: String) -> Arc<AtomicBool> {
        let active = Arc::new(AtomicBool::new(true));
        if let Ok(mut connections) = self.inner.connections.lock() {
            connections.insert(owner_id, active.clone());
        }
        active
    }

    fn stop_connections(&self) -> Vec<String> {
        let connections = self
            .inner
            .connections
            .lock()
            .map(|mut connections| connections.drain().collect::<Vec<_>>())
            .unwrap_or_default();
        let mut owners = Vec::with_capacity(connections.len());
        for (owner_id, active) in connections {
            active.store(false, Ordering::Release);
            self.cancel_owner(&owner_id);
            owners.push(owner_id);
        }
        owners
    }

    fn disconnect_owner(&self, owner_id: &str) -> bool {
        let active = self
            .inner
            .connections
            .lock()
            .ok()
            .and_then(|mut connections| connections.remove(owner_id));
        if let Some(active) = &active {
            active.store(false, Ordering::Release);
        }
        self.cancel_owner(owner_id);
        active.is_some()
    }

    fn listener_finished(&self, stop: &Arc<AtomicBool>) {
        if let Ok(mut current) = self.inner.stop.lock() {
            if current
                .as_ref()
                .is_some_and(|active| Arc::ptr_eq(active, stop))
            {
                *current = None;
            }
        }
    }
}

fn run_listener(app: AppHandle, state: McpState, stop: Arc<AtomicBool>) {
    let name = match socket_name() {
        Ok(name) => name,
        Err(error) => {
            eprintln!("MCP socket name failed: {error}");
            state.listener_finished(&stop);
            return;
        }
    };
    let listener = match ListenerOptions::new().name(name).create_sync() {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("MCP listener failed: {error}");
            state.listener_finished(&stop);
            return;
        }
    };
    for incoming in listener.incoming() {
        if stop.load(Ordering::Acquire) {
            break;
        }
        let stream = match incoming {
            Ok(stream) => stream,
            Err(error) => {
                eprintln!("MCP connection failed: {error}");
                continue;
            }
        };
        let owner_id = format!(
            "owner-{}",
            state.inner.owner_counter.fetch_add(1, Ordering::Relaxed)
        );
        let active = state.register_connection(owner_id.clone());
        if stop.load(Ordering::Acquire) {
            active.store(false, Ordering::Release);
            state.disconnect_owner(&owner_id);
            continue;
        }
        let connection_state = state.clone();
        let connection_app = app.clone();
        thread::spawn(move || {
            handle_connection(connection_app, connection_state, owner_id, active, stream)
        });
    }
    state.listener_finished(&stop);
}

fn handle_connection(
    app: AppHandle,
    state: McpState,
    owner_id: String,
    active: Arc<AtomicBool>,
    stream: Stream,
) {
    let _ = stream.set_nonblocking(true);
    let (receiver, sender) = stream.split();
    let mut reader = BufReader::new(receiver);
    let sender = Arc::new(Mutex::new(sender));
    let handles = Arc::new(Mutex::new(HashMap::<String, String>::new()));
    let mut line = String::new();
    loop {
        if !active.load(Ordering::Acquire) {
            break;
        }
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                // ponytail: fixed polling keeps synchronous named-pipe reads interruptible; use overlapped I/O if connection count grows.
                thread::sleep(Duration::from_millis(10));
                continue;
            }
            Err(_) => break,
        }
        let request: WireRequest = match serde_json::from_str(line.trim()) {
            Ok(request) => request,
            Err(error) => {
                line.clear();
                let _ = write_response(
                    &mut *sender.lock().expect("MCP response stream lock poisoned"),
                    WireResponse {
                        request_id: "".into(),
                        result: Value::Null,
                        error: Some(format!("invalid MCP bridge request: {error}")),
                    },
                );
                continue;
            }
        };
        line.clear();
        let request_app = app.clone();
        let request_state = state.clone();
        let request_owner = owner_id.clone();
        let request_handles = handles.clone();
        let request_sender = sender.clone();
        let request_active = active.clone();
        thread::spawn(move || {
            let response = route_request(
                &request_app,
                &request_state,
                &request_owner,
                &request_handles,
                &request_active,
                request,
            );
            if let Ok(mut writer) = request_sender.lock() {
                let _ = write_response(&mut *writer, response);
            }
        });
    }
    if state.disconnect_owner(&owner_id) {
        let _ = app.emit("mcp-owner-disconnected", McpOwnerDisconnected { owner_id });
    }
}

fn write_response<W: Write>(stream: &mut W, response: WireResponse) -> io::Result<()> {
    let mut writer = BufWriter::new(stream);
    serde_json::to_writer(&mut writer, &response)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn route_request(
    app: &AppHandle,
    state: &McpState,
    owner_id: &str,
    handles: &Mutex<HashMap<String, String>>,
    active: &AtomicBool,
    request: WireRequest,
) -> WireResponse {
    let original_id = request.request_id.clone();
    if !active.load(Ordering::Acquire) {
        return error_response(original_id, "MCP connection is closed");
    }
    let mut params = request.params;
    let mut close_handle = None;
    if request.method != "create_terminal" && request.method != "list_terminals" {
        let Some(object) = params.as_object_mut() else {
            return error_response(original_id, "MCP tool arguments must be an object");
        };
        let Some(handle) = object
            .get("handle")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            return error_response(original_id, "terminal handle is required");
        };
        let Some(session_id) = handles
            .lock()
            .ok()
            .and_then(|handles| handles.get(&handle).cloned())
        else {
            return error_response(original_id, "terminal session is unavailable");
        };
        object.remove("handle");
        object.insert("sessionId".into(), Value::String(session_id));
        if request.method == "close_terminal" {
            close_handle = Some(handle);
        }
    }
    let correlation_id = format!("{owner_id}:{}", request.request_id);
    let (sender, receiver) = mpsc::channel();
    if let Ok(mut pending) = state.inner.pending.lock() {
        pending.insert(correlation_id.clone(), sender);
    } else {
        return error_response(original_id, "MCP state lock poisoned");
    }
    if !active.load(Ordering::Acquire) {
        state
            .inner
            .pending
            .lock()
            .ok()
            .map(|mut pending| pending.remove(&correlation_id));
        return error_response(original_id, "MCP connection is closed");
    }
    if app
        .emit(
            "mcp-request",
            McpRequest {
                request_id: correlation_id.clone(),
                owner_id: owner_id.to_owned(),
                method: request.method.clone(),
                params,
            },
        )
        .is_err()
    {
        state
            .inner
            .pending
            .lock()
            .ok()
            .map(|mut pending| pending.remove(&correlation_id));
        return error_response(original_id, "Scanline Term WebView is unavailable");
    }
    let response = match receiver.recv_timeout(RESPONSE_TIMEOUT) {
        Ok(response) => response,
        Err(_) => {
            state
                .inner
                .pending
                .lock()
                .ok()
                .map(|mut pending| pending.remove(&correlation_id));
            return error_response(original_id, "MCP request timed out");
        }
    };
    if let Some(error) = response.error {
        return error_response(original_id, &error);
    }
    let mut result = response.result;
    if !active.load(Ordering::Acquire) {
        return error_response(original_id, "MCP connection is closed");
    }
    if request.method == "create_terminal" {
        if let Some(object) = result.as_object_mut() {
            if let Some(session_id) = object
                .remove("sessionId")
                .and_then(|value| value.as_str().map(str::to_owned))
            {
                let handle = format!(
                    "terminal-{}",
                    state.inner.handle_counter.fetch_add(1, Ordering::Relaxed)
                );
                if let Ok(mut handles) = handles.lock() {
                    handles.insert(handle.clone(), session_id);
                } else {
                    return error_response(original_id, "MCP handle state is unavailable");
                }
                object.insert("handle".into(), Value::String(handle));
            }
        }
    } else if request.method == "list_terminals" {
        if let Some(entries) = result.as_array_mut() {
            for entry in entries.iter_mut() {
                if let Some(object) = entry.as_object_mut() {
                    if let Some(session_id) = object
                        .remove("sessionId")
                        .and_then(|value| value.as_str().map(str::to_owned))
                    {
                        if let Some(handle) = handles.lock().ok().and_then(|handles| {
                            handles.iter().find_map(|(handle, id)| {
                                (id == &session_id).then_some(handle.clone())
                            })
                        }) {
                            object.insert("handle".into(), Value::String(handle));
                        }
                    }
                }
            }
        }
    }
    if let Some(handle) = close_handle {
        if let Ok(mut handles) = handles.lock() {
            handles.remove(&handle);
        }
    }
    WireResponse {
        request_id: original_id,
        result,
        error: None,
    }
}

fn error_response(request_id: String, message: &str) -> WireResponse {
    WireResponse {
        request_id,
        result: Value::Null,
        error: Some(message.to_owned()),
    }
}

#[tauri::command]
pub fn mcp_set_enabled(
    app: AppHandle,
    state: State<'_, McpState>,
    enabled: bool,
) -> Result<(), String> {
    state.set_enabled(app, enabled)
}

#[tauri::command]
pub fn mcp_respond(
    state: State<'_, McpState>,
    request_id: String,
    result: Value,
    error: Option<String>,
) -> Result<(), String> {
    state.respond(request_id, result, error);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn socket_name_is_stable() {
        assert!(socket_name().is_ok());
    }

    #[test]
    fn error_response_preserves_request_id() {
        let response = error_response("abc".into(), "failed");
        assert_eq!(response.request_id, "abc");
        assert_eq!(response.error.as_deref(), Some("failed"));
    }

    #[test]
    fn bridge_request_params_are_json_objects() {
        let params = json!({ "handle": "terminal-1" });
        assert_eq!(
            params.get("handle").and_then(Value::as_str),
            Some("terminal-1")
        );
    }

    #[test]
    fn stopping_connections_marks_owner_inactive() {
        let state = McpState::default();
        let active = state.register_connection("owner-1".into());
        assert!(active.load(Ordering::Acquire));
        assert_eq!(state.stop_connections(), vec!["owner-1"]);
        assert!(!active.load(Ordering::Acquire));
        assert!(!state.disconnect_owner("owner-1"));
    }
}
