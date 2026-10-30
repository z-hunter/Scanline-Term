use std::{
    collections::HashMap,
    io::{self, BufRead, BufReader, BufWriter, Read, Write},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use interprocess::local_socket::{prelude::*, GenericNamespaced, ListenerOptions, Stream};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

// Keep the development broker separate from an installed release build. Both
// processes can otherwise run under the same Windows user and contend for one
// named pipe.
const SOCKET_NAME: &str = if cfg!(debug_assertions) {
    "scanline-term-mcp-dev"
} else {
    "scanline-term-mcp"
};
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(65);
const MAX_REQUEST_LINE_BYTES: usize = 1024 * 1024;
const MAX_CONNECTIONS: usize = 16;
const MAX_INFLIGHT_REQUESTS: usize = 64;

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
    connection_workers: AtomicUsize,
    request_workers: AtomicUsize,
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
            drop(stop_guard);
            let state = self.clone();
            let (ready_tx, ready_rx) = mpsc::sync_channel(1);
            let listener_stop = stop.clone();
            if let Err(error) = thread::Builder::new()
                .name("scanline-term-mcp".into())
                .spawn(move || run_listener(app, state, listener_stop, ready_tx))
            {
                self.listener_finished(&stop);
                return Err(format!("could not start MCP listener: {error}"));
            }
            return match ready_rx.recv() {
                Ok(result) => result,
                Err(_) => {
                    self.listener_finished(&stop);
                    Err("MCP listener stopped before it was ready".into())
                }
            };
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

    fn register_connection(&self, owner_id: String) -> Option<Arc<AtomicBool>> {
        let active = Arc::new(AtomicBool::new(true));
        let mut connections = self.inner.connections.lock().ok()?;
        if connections.len() >= MAX_CONNECTIONS {
            return None;
        }
        connections.insert(owner_id, active.clone());
        Some(active)
    }

    fn acquire_request_worker(&self) -> Option<RequestWorker> {
        self.inner
            .request_workers
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < MAX_INFLIGHT_REQUESTS).then_some(count + 1)
            })
            .ok()
            .map(|_| RequestWorker(self.inner.clone()))
    }

    fn acquire_connection_worker(&self) -> Option<ConnectionWorker> {
        self.inner
            .connection_workers
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < MAX_CONNECTIONS).then_some(count + 1)
            })
            .ok()
            .map(|_| ConnectionWorker(self.inner.clone()))
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

struct RequestWorker(Arc<McpInner>);

impl Drop for RequestWorker {
    fn drop(&mut self) {
        self.0.request_workers.fetch_sub(1, Ordering::Release);
    }
}

struct ConnectionWorker(Arc<McpInner>);

impl Drop for ConnectionWorker {
    fn drop(&mut self) {
        self.0.connection_workers.fetch_sub(1, Ordering::Release);
    }
}

fn run_listener(
    app: AppHandle,
    state: McpState,
    stop: Arc<AtomicBool>,
    ready: mpsc::SyncSender<Result<(), String>>,
) {
    let name = match socket_name() {
        Ok(name) => name,
        Err(error) => {
            eprintln!("MCP socket name failed: {error}");
            state.listener_finished(&stop);
            let _ = ready.send(Err(format!("MCP socket name failed: {error}")));
            return;
        }
    };
    let listener = match ListenerOptions::new().name(name).create_sync() {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("MCP listener failed: {error}");
            state.listener_finished(&stop);
            let _ = ready.send(Err(format!("MCP listener failed: {error}")));
            return;
        }
    };
    if stop.load(Ordering::Acquire) {
        drop(listener);
        state.listener_finished(&stop);
        return;
    }
    let _ = ready.send(Ok(()));
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
        let Some(connection_worker) = state.acquire_connection_worker() else {
            // Don't let a slow peer block the accept loop while it is over capacity.
            if stream.set_nonblocking(true).is_ok() {
                let mut stream = stream;
                let _ = write_response(
                    &mut stream,
                    error_response(String::new(), "MCP connection limit reached"),
                );
            }
            continue;
        };
        let Some(active) = state.register_connection(owner_id.clone()) else {
            if stream.set_nonblocking(true).is_ok() {
                let mut stream = stream;
                let _ = write_response(
                    &mut stream,
                    error_response(String::new(), "MCP connection limit reached"),
                );
            }
            continue;
        };
        if stop.load(Ordering::Acquire) {
            active.store(false, Ordering::Release);
            state.disconnect_owner(&owner_id);
            continue;
        }
        let connection_state = state.clone();
        let connection_app = app.clone();
        let connection_owner = owner_id.clone();
        if let Err(error) = thread::Builder::new()
            .name("scanline-term-mcp-connection".into())
            .spawn(move || {
                let _worker = connection_worker;
                handle_connection(
                    connection_app,
                    connection_state,
                    connection_owner,
                    active,
                    stream,
                )
            })
        {
            eprintln!("MCP connection worker failed: {error}");
            state.disconnect_owner(&owner_id);
        }
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
    if let Err(error) = stream.set_nonblocking(true) {
        eprintln!("MCP connection nonblocking mode failed: {error}");
        if state.disconnect_owner(&owner_id) {
            let _ = app.emit("mcp-owner-disconnected", McpOwnerDisconnected { owner_id });
        }
        return;
    }
    let (receiver, sender) = stream.split();
    let mut reader = BufReader::new(McpPipeReader { receiver });
    let sender = Arc::new(Mutex::new(sender));
    let handles = Arc::new(Mutex::new(HashMap::<String, String>::new()));
    let mut line = Vec::new();
    loop {
        if !active.load(Ordering::Acquire) {
            break;
        }
        match read_bounded_line(&mut reader, &mut line) {
            Ok(false) => break,
            Ok(true) => {}
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                // ponytail: fixed polling keeps synchronous named-pipe reads interruptible; use overlapped I/O if connection count grows.
                thread::sleep(Duration::from_millis(10));
                continue;
            }
            Err(error) if error.kind() == io::ErrorKind::InvalidData => {
                let _ = write_response_interruptible(
                    &mut *sender.lock().expect("MCP response stream lock poisoned"),
                    error_response(String::new(), "MCP request exceeds the 1 MiB limit"),
                    &active,
                );
                break;
            }
            Err(_) => break,
        }
        let request: WireRequest = match serde_json::from_slice(line.trim_ascii()) {
            Ok(request) => request,
            Err(error) => {
                line.clear();
                if write_response_interruptible(
                    &mut *sender.lock().expect("MCP response stream lock poisoned"),
                    WireResponse {
                        request_id: "".into(),
                        result: Value::Null,
                        error: Some(format!("invalid MCP bridge request: {error}")),
                    },
                    &active,
                )
                .is_err()
                {
                    active.store(false, Ordering::Release);
                    break;
                }
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
        let request_id = request.request_id.clone();
        let Some(worker) = state.acquire_request_worker() else {
            if write_response_interruptible(
                &mut *sender.lock().expect("MCP response stream lock poisoned"),
                error_response(request_id, "MCP request limit reached; retry later"),
                &active,
            )
            .is_err()
            {
                active.store(false, Ordering::Release);
                break;
            }
            continue;
        };
        if let Err(error) = thread::Builder::new()
            .name("scanline-term-mcp-request".into())
            .spawn(move || {
                let _worker = worker;
                let response = route_request(
                    &request_app,
                    &request_state,
                    &request_owner,
                    &request_handles,
                    &request_active,
                    request,
                );
                if let Ok(mut writer) = request_sender.lock() {
                    if write_response_interruptible(&mut *writer, response, &request_active)
                        .is_err()
                    {
                        request_active.store(false, Ordering::Release);
                    }
                }
            })
        {
            if write_response_interruptible(
                &mut *sender.lock().expect("MCP response stream lock poisoned"),
                error_response(
                    request_id,
                    &format!("could not start MCP request worker: {error}"),
                ),
                &active,
            )
            .is_err()
            {
                active.store(false, Ordering::Release);
                break;
            }
        }
    }
    if state.disconnect_owner(&owner_id) {
        let _ = app.emit("mcp-owner-disconnected", McpOwnerDisconnected { owner_id });
    }
}

fn read_bounded_line(reader: &mut impl BufRead, line: &mut Vec<u8>) -> io::Result<bool> {
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(!line.is_empty());
        }
        let remaining = MAX_REQUEST_LINE_BYTES.saturating_sub(line.len());
        let inspected = &available[..available.len().min(remaining.saturating_add(1))];
        let consumed = inspected
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(inspected.len(), |index| index + 1);
        line.extend_from_slice(&inspected[..consumed]);
        reader.consume(consumed);
        if line.len() > MAX_REQUEST_LINE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "request line too long",
            ));
        }
        if line.last() == Some(&b'\n') {
            return Ok(true);
        }
    }
}

struct McpPipeReader {
    receiver: interprocess::local_socket::RecvHalf,
}

impl Read for McpPipeReader {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        let result = self.receiver.read(bytes);
        #[cfg(windows)]
        match result {
            Ok(0) => {
                let connected = pipe_is_connected(&self.receiver);
                if connected {
                    Err(io::ErrorKind::WouldBlock.into())
                } else {
                    Ok(0)
                }
            }
            Err(error)
                if error.raw_os_error()
                    == Some(windows_sys::Win32::Foundation::ERROR_NO_DATA as i32) =>
            {
                let connected = pipe_is_connected(&self.receiver);
                if retryable_pipe_read(&error, connected) {
                    Err(io::ErrorKind::WouldBlock.into())
                } else {
                    Err(error)
                }
            }
            result => result,
        }
        #[cfg(not(windows))]
        result
    }
}

#[cfg(windows)]
fn pipe_is_connected(receiver: &interprocess::local_socket::RecvHalf) -> bool {
    use std::os::windows::io::{AsHandle, AsRawHandle};

    match receiver {
        interprocess::local_socket::RecvHalf::NamedPipe(pipe) => unsafe {
            windows_sys::Win32::System::Pipes::PeekNamedPipe(
                pipe.as_handle().as_raw_handle(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            ) != 0
        },
    }
}

#[cfg(windows)]
fn retryable_pipe_read(error: &io::Error, peek_succeeded: bool) -> bool {
    error.kind() == io::ErrorKind::WouldBlock
        || (error.raw_os_error() == Some(windows_sys::Win32::Foundation::ERROR_NO_DATA as i32)
            && peek_succeeded)
}

fn write_response<W: Write>(stream: &mut W, response: WireResponse) -> io::Result<()> {
    let mut writer = BufWriter::new(stream);
    serde_json::to_writer(&mut writer, &response)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn write_response_interruptible<W: Write>(
    stream: &mut W,
    response: WireResponse,
    active: &AtomicBool,
) -> io::Result<()> {
    let deadline = Instant::now() + RESPONSE_TIMEOUT;
    let mut writer = BufWriter::new(InterruptibleWriter {
        stream,
        active,
        deadline,
    });
    serde_json::to_writer(&mut writer, &response)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

struct InterruptibleWriter<'a, W> {
    stream: &'a mut W,
    active: &'a AtomicBool,
    deadline: Instant,
}

impl<W: Write> Write for InterruptibleWriter<'_, W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        loop {
            if !self.active.load(Ordering::Acquire) {
                return Err(io::ErrorKind::ConnectionAborted.into());
            }
            if Instant::now() >= self.deadline {
                return Err(io::ErrorKind::TimedOut.into());
            }
            match self.stream.write(bytes) {
                Ok(0) if !bytes.is_empty() => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                result => return result,
            }
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        loop {
            if !self.active.load(Ordering::Acquire) {
                return Err(io::ErrorKind::ConnectionAborted.into());
            }
            if Instant::now() >= self.deadline {
                return Err(io::ErrorKind::TimedOut.into());
            }
            match self.stream.flush() {
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                result => return result,
            }
        }
    }
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
        let active = state.register_connection("owner-1".into()).unwrap();
        assert!(active.load(Ordering::Acquire));
        assert_eq!(state.stop_connections(), vec!["owner-1"]);
        assert!(!active.load(Ordering::Acquire));
        assert!(!state.disconnect_owner("owner-1"));
    }

    #[test]
    fn connection_and_request_worker_limits_are_enforced_and_released() {
        let state = McpState::default();
        let workers: Vec<_> = (0..MAX_CONNECTIONS)
            .map(|_| state.acquire_connection_worker().unwrap())
            .collect();
        assert!(state.acquire_connection_worker().is_none());
        drop(workers);
        assert!(state.acquire_connection_worker().is_some());

        for index in 0..MAX_CONNECTIONS {
            let owner = format!("owner-{index}");
            assert!(state.register_connection(owner).is_some());
        }
        assert!(state.register_connection("one-too-many".into()).is_none());
        state.stop_connections();
        assert!(state.register_connection("again".into()).is_some());

        let workers: Vec<_> = (0..MAX_INFLIGHT_REQUESTS)
            .map(|_| state.acquire_request_worker().unwrap())
            .collect();
        assert!(state.acquire_request_worker().is_none());
        drop(workers);
        assert!(state.acquire_request_worker().is_some());
    }

    #[test]
    fn request_line_reader_enforces_byte_limit_and_keeps_partial_data() {
        struct IntermittentReader(u8);
        impl Read for IntermittentReader {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                let bytes = match self.0 {
                    0 => b"{\"x\":".as_slice(),
                    1 => {
                        self.0 += 1;
                        return Err(io::ErrorKind::WouldBlock.into());
                    }
                    2 => b"1}\n".as_slice(),
                    _ => return Ok(0),
                };
                self.0 += 1;
                buffer[..bytes.len()].copy_from_slice(bytes);
                Ok(bytes.len())
            }
        }

        let mut partial = BufReader::new(IntermittentReader(0));
        let mut line = Vec::new();
        assert_eq!(
            read_bounded_line(&mut partial, &mut line)
                .unwrap_err()
                .kind(),
            io::ErrorKind::WouldBlock
        );
        assert_eq!(line, b"{\"x\":");
        assert!(read_bounded_line(&mut partial, &mut line).unwrap());
        assert_eq!(line, b"{\"x\":1}\n");

        let mut exact = vec![b'a'; MAX_REQUEST_LINE_BYTES - 1];
        exact.push(b'\n');
        assert!(read_bounded_line(&mut std::io::Cursor::new(exact), &mut Vec::new()).unwrap());

        let mut oversized = std::io::Cursor::new(vec![b'a'; MAX_REQUEST_LINE_BYTES + 1]);
        assert_eq!(
            read_bounded_line(&mut oversized, &mut Vec::new())
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
        let multibyte = "é".repeat(MAX_REQUEST_LINE_BYTES / 2 + 1).into_bytes();
        assert_eq!(
            read_bounded_line(&mut std::io::Cursor::new(multibyte), &mut Vec::new())
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn response_writer_retries_would_block_without_losing_bytes() {
        struct IntermittentWriter {
            calls: usize,
            bytes: Vec<u8>,
        }
        impl Write for IntermittentWriter {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                match self.calls {
                    0 => {
                        self.calls += 1;
                        self.bytes.extend_from_slice(&bytes[..3]);
                        Ok(3)
                    }
                    1 => {
                        self.calls += 1;
                        Err(io::ErrorKind::WouldBlock.into())
                    }
                    2 => {
                        self.calls += 1;
                        Ok(0)
                    }
                    _ => {
                        let count = bytes.len().min(5);
                        self.bytes.extend_from_slice(&bytes[..count]);
                        Ok(count)
                    }
                }
            }

            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        let active = AtomicBool::new(true);
        let response = WireResponse {
            request_id: "1".into(),
            result: Value::Null,
            error: None,
        };
        let mut expected = serde_json::to_vec(&response).unwrap();
        expected.push(b'\n');
        let mut writer = IntermittentWriter {
            calls: 0,
            bytes: Vec::new(),
        };
        write_response_interruptible(&mut writer, response, &active).unwrap();
        assert_eq!(writer.bytes, expected);

        let mut writer = IntermittentWriter {
            calls: 0,
            bytes: Vec::new(),
        };
        let cancelled = AtomicBool::new(false);
        assert_eq!(
            write_response_interruptible(
                &mut writer,
                WireResponse {
                    request_id: "cancelled".into(),
                    result: Value::Null,
                    error: None,
                },
                &cancelled,
            )
            .unwrap_err()
            .kind(),
            io::ErrorKind::ConnectionAborted
        );
        let mut expired = InterruptibleWriter {
            stream: &mut writer,
            active: &AtomicBool::new(true),
            deadline: Instant::now() - Duration::from_millis(1),
        };
        assert_eq!(
            expired.write(b"response").unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_pipe_no_data_retries_only_when_peek_confirms_connection() {
        let no_data =
            io::Error::from_raw_os_error(windows_sys::Win32::Foundation::ERROR_NO_DATA as i32);
        assert!(retryable_pipe_read(&no_data, true));
        assert!(!retryable_pipe_read(&no_data, false));
        let broken_pipe =
            io::Error::from_raw_os_error(windows_sys::Win32::Foundation::ERROR_BROKEN_PIPE as i32);
        assert!(!retryable_pipe_read(&broken_pipe, true));

        struct NoDataWriter;
        impl Write for NoDataWriter {
            fn write(&mut self, _bytes: &[u8]) -> io::Result<usize> {
                Err(io::Error::from_raw_os_error(
                    windows_sys::Win32::Foundation::ERROR_NO_DATA as i32,
                ))
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let error = write_response_interruptible(
            &mut NoDataWriter,
            WireResponse {
                request_id: "closed".into(),
                result: Value::Null,
                error: None,
            },
            &AtomicBool::new(true),
        )
        .unwrap_err();
        assert_eq!(
            error.raw_os_error(),
            Some(windows_sys::Win32::Foundation::ERROR_NO_DATA as i32)
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_nonblocking_reader_distinguishes_idle_from_closed_pipe() {
        let pipe_name = format!("scanline-term-mcp-test-{}", std::process::id());
        let listener_name = pipe_name.clone().to_ns_name::<GenericNamespaced>().unwrap();
        let listener = ListenerOptions::new()
            .name(listener_name)
            .create_sync()
            .unwrap();
        let client_pipe_name = pipe_name.clone();
        let client = thread::spawn(move || {
            let name = client_pipe_name.to_ns_name::<GenericNamespaced>().unwrap();
            Stream::connect(name).unwrap()
        });
        let server = listener.incoming().next().unwrap().unwrap();
        server.set_nonblocking(true).unwrap();
        let (receiver, _sender) = server.split();
        let mut reader = McpPipeReader {
            receiver,
        };
        let mut buffer = [0; 1];
        assert_eq!(
            reader.read(&mut buffer).unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );

        let client = client.join().unwrap();
        drop(client);
        let closed = (0..100).any(|_| match reader.read(&mut buffer) {
            Ok(0) => true,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(10));
                false
            }
            Err(_) => true,
            Ok(_) => false,
        });
        assert!(closed, "disconnected pipe did not report EOF/error");
    }
}
