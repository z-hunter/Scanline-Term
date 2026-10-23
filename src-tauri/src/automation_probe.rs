use std::{
    mem::size_of,
    ptr::{null, null_mut},
    sync::{
        atomic::{AtomicBool, AtomicIsize, AtomicU32, AtomicU64, Ordering},
        mpsc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Listener, Manager};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WAIT_FAILED, WPARAM},
    System::{LibraryLoader::GetModuleHandleW, Threading::GetCurrentThreadId},
    UI::{
        Input::KeyboardAndMouse::{
            GetKeyboardLayout, GetKeyboardLayoutList, GetKeyboardLayoutNameW, SendInput, HKL,
            INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_CAPITAL, VK_NONAME,
        },
        WindowsAndMessaging::{
            CallNextHookEx, DispatchMessageW, GetAncestor, GetClassNameW, GetForegroundWindow,
            GetGUIThreadInfo, GetWindowThreadProcessId, IsChild, MsgWaitForMultipleObjects,
            PeekMessageW, PostMessageW, PostThreadMessageW, SetWindowsHookExW, TranslateMessage,
            UnhookWindowsHookEx, GA_ROOT, GUITHREADINFO, HC_ACTION, KBDLLHOOKSTRUCT,
            LLKHF_INJECTED, MSG, PM_NOREMOVE, PM_REMOVE, QS_ALLINPUT, WH_KEYBOARD_LL,
            WM_INPUTLANGCHANGEREQUEST, WM_KEYDOWN, WM_KEYUP, WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP,
        },
    },
};

const ENABLE_ENV: &str = "SCANLINE_TERM_AUTOMATION_PROBE";
const TOKEN_MARKER: usize = 0x5354_4552_4D4E_4F4E_u64 as usize;
const TRACE_CAPACITY: usize = 128;
const TRACE_TICK_SHIFT: u32 = 13;
const LAYOUT_POLL_INTERVAL_MS: u32 = 20;
const VK_H: u32 = 0x48;
const WM_RELEASE_PENDING_TOKEN: u32 = 0x8001;

static TARGET_HWND: AtomicIsize = AtomicIsize::new(0);
static TARGET_WEBVIEW_HWND: AtomicIsize = AtomicIsize::new(0);
static TARGET_WEBVIEW_RESOLVED: AtomicBool = AtomicBool::new(false);
static STATUS_REQUESTED: AtomicBool = AtomicBool::new(false);
static TARGET_PID: AtomicU32 = AtomicU32::new(0);
static CONTEXT_FOCUSED: AtomicBool = AtomicBool::new(false);
static CONTEXT_GENERATION: AtomicU64 = AtomicU64::new(0);
// Keep the physical-down latch until the matching up or hook teardown, even
// after the logical frontend context has been canceled.
static CAPS_SUPPRESSED_DOWN: AtomicBool = AtomicBool::new(false);
static CAPS_LOGICAL_DOWN: AtomicBool = AtomicBool::new(false);
// A token up remains owed until it is delivered to this app while it owns focus.
static TOKEN_UP_PENDING: AtomicBool = AtomicBool::new(false);
static HOOK_ACTIVE: AtomicBool = AtomicBool::new(false);
static HOOK_THREAD_ID: AtomicU32 = AtomicU32::new(0);
static HOOK_STARTED_TICK: AtomicU64 = AtomicU64::new(0);
static HOOK_LOOP_HEARTBEAT_TICK: AtomicU64 = AtomicU64::new(0);
static HOOK_CALLBACK_COUNT: AtomicU64 = AtomicU64::new(0);
static LAYOUT_POLL_STOP: AtomicBool = AtomicBool::new(false);
static TRACE_CURSOR: AtomicU64 = AtomicU64::new(0);
static TRACE: [AtomicU64; TRACE_CAPACITY] = [const { AtomicU64::new(0) }; TRACE_CAPACITY];

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProbeContext {
    frontend_id: String,
    tab_id: Option<String>,
    generation: u64,
    focused: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrontendReady {
    frontend_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LayoutInfo {
    hkl: String,
    klid: Option<String>,
    lang_id_hint: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LayoutTargets {
    normal_hkl: Option<String>,
    insert_hkl: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LayoutRequest {
    frontend_id: String,
    tab_id: String,
    generation: u64,
    hkl: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LayoutChange {
    frontend_id: String,
    tab_id: Option<String>,
    generation: u64,
    hkl: String,
    source: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeError {
    frontend_id: String,
    tab_id: Option<String>,
    generation: u64,
    hkl: Option<String>,
    reason: String,
}

struct PendingLayout {
    frontend_id: String,
    tab_id: String,
    generation: u64,
    hkl: String,
    deadline: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeStatus {
    enabled: bool,
    reason: Option<String>,
    frontend_id: String,
    hook_installed: bool,
    callback_observed: bool,
    hook_callback_count: u64,
    hook_started_tick_ms: u64,
    hook_loop_heartbeat_tick_ms: u64,
    snapshot_tick_ms: u64,
    target_pid: u32,
    target_hwnd: String,
    target_webview_hwnd: String,
    layouts: Vec<LayoutInfo>,
    targets: LayoutTargets,
    current_hkl: Option<String>,
    layout_error: Option<String>,
    layout_observation_mode: &'static str,
    layout_poll_interval_ms: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TraceEntry {
    sequence: u64,
    tick_ms: u32,
    vk: u16,
    edge: &'static str,
    injected: bool,
    probe_token: bool,
    send_input_result: Option<bool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeTrace {
    hook_installed: bool,
    callback_observed: bool,
    hook_callback_count: u64,
    hook_started_tick_ms: u64,
    hook_loop_heartbeat_tick_ms: u64,
    snapshot_tick_ms: u64,
    armed: bool,
    failed: bool,
    target_pid: u32,
    target_hwnd: String,
    target_webview_hwnd: String,
    frontend_id: String,
    tab_id: Option<String>,
    generation: u64,
    entries: Vec<TraceEntry>,
}

pub struct Probe {
    enabled: bool,
    reason: Mutex<Option<String>>,
    context: Mutex<ProbeContext>,
    thread: Mutex<Option<JoinHandle<()>>>,
    layout_thread: Mutex<Option<JoinHandle<()>>>,
    pending_layout: Mutex<Option<PendingLayout>>,
    last_layout: Mutex<Option<(String, String, u64, String)>>,
}

impl Probe {
    fn start(hwnd: HWND, pid: u32) -> Self {
        TARGET_HWND.store(hwnd as isize, Ordering::Release);
        TARGET_PID.store(pid, Ordering::Release);
        let requested = std::env::var(ENABLE_ENV).is_ok_and(|value| value == "1");
        let mut reason = if requested {
            None
        } else {
            Some(format!("set {ENABLE_ENV}=1 to enable the debug probe"))
        };
        let thread = if requested {
            match start_hook_thread() {
                Ok(thread) => Some(thread),
                Err(error) => {
                    reason = Some(error);
                    None
                }
            }
        } else {
            None
        };
        Self {
            enabled: requested && thread.is_some(),
            reason: Mutex::new(reason),
            context: Mutex::new(ProbeContext::default()),
            thread: Mutex::new(thread),
            layout_thread: Mutex::new(None),
            pending_layout: Mutex::new(None),
            last_layout: Mutex::new(None),
        }
    }

    fn start_layout_poller(&self, app: AppHandle) {
        if !self.enabled {
            return;
        }
        LAYOUT_POLL_STOP.store(false, Ordering::Release);
        let thread = thread::Builder::new()
            .name("scanline-automation-probe-layout".into())
            .spawn(move || layout_poll_loop(app))
            .ok();
        if let Ok(mut slot) = self.layout_thread.lock() {
            *slot = thread;
        }
    }

    fn status(&self) -> ProbeStatus {
        let host = TARGET_WEBVIEW_HWND.load(Ordering::Acquire);
        let enabled = self.enabled && HOOK_ACTIVE.load(Ordering::Acquire) && host != 0;
        let reason = self
            .reason
            .lock()
            .ok()
            .and_then(|reason| reason.clone())
            .or_else(|| {
                if host != 0 {
                    None
                } else if TARGET_WEBVIEW_RESOLVED.load(Ordering::Acquire) {
                    Some("labeled main WebView host could not be resolved".into())
                } else {
                    Some("resolving labeled main WebView host".into())
                }
            });
        let context = self.context.lock().ok();
        let current_hkl = context
            .as_ref()
            .filter(|context| context.focused && self.enabled)
            .and_then(|_| current_focus_layout().map(|(_, _, hkl)| format_hkl(hkl)));
        let (layouts, targets, layout_error) = layout_inventory();
        ProbeStatus {
            enabled,
            reason,
            frontend_id: context
                .as_ref()
                .map(|context| context.frontend_id.clone())
                .unwrap_or_default(),
            hook_installed: HOOK_ACTIVE.load(Ordering::Acquire),
            callback_observed: HOOK_CALLBACK_COUNT.load(Ordering::Acquire) != 0,
            hook_callback_count: HOOK_CALLBACK_COUNT.load(Ordering::Acquire),
            hook_started_tick_ms: HOOK_STARTED_TICK.load(Ordering::Acquire),
            hook_loop_heartbeat_tick_ms: HOOK_LOOP_HEARTBEAT_TICK.load(Ordering::Acquire),
            snapshot_tick_ms: tick_ms(),
            target_pid: TARGET_PID.load(Ordering::Acquire),
            target_hwnd: format!("0x{:X}", TARGET_HWND.load(Ordering::Acquire)),
            target_webview_hwnd: format!("0x{:X}", TARGET_WEBVIEW_HWND.load(Ordering::Acquire)),
            layouts,
            targets,
            current_hkl,
            layout_error,
            layout_observation_mode: "probe-poll",
            layout_poll_interval_ms: LAYOUT_POLL_INTERVAL_MS,
        }
    }

    fn begin_frontend(&self, frontend_id: String) -> bool {
        let Ok(mut current) = self.context.lock() else {
            return false;
        };
        let Some(next) = reset_context_for_frontend(&current, &frontend_id) else {
            return false;
        };
        *current = next;
        CONTEXT_FOCUSED.store(false, Ordering::Release);
        CONTEXT_GENERATION.store(0, Ordering::Release);
        CAPS_LOGICAL_DOWN.store(false, Ordering::Release);
        if let Ok(mut pending) = self.pending_layout.lock() {
            *pending = None;
        }
        if let Ok(mut last) = self.last_layout.lock() {
            *last = None;
        }
        true
    }

    fn set_context(&self, context: ProbeContext) -> bool {
        let Ok(mut current) = self.context.lock() else {
            return false;
        };
        if !context_matches_frontend(&current, &context)
            || context.generation < current.generation
            || context.tab_id.is_none() && context.focused
        {
            return false;
        }
        if context.generation == current.generation
            && context.frontend_id == current.frontend_id
            && context.tab_id == current.tab_id
            && context.focused == current.focused
        {
            return false;
        }
        if !context.focused
            || context.generation != current.generation
            || context.tab_id != current.tab_id
        {
            CONTEXT_FOCUSED.store(false, Ordering::Release);
            CAPS_LOGICAL_DOWN.store(false, Ordering::Release);
        }
        current.frontend_id = context.frontend_id;
        current.tab_id = context.tab_id;
        current.generation = context.generation;
        current.focused = context.focused && native_terminal_focus_is_valid();
        CONTEXT_GENERATION.store(current.generation, Ordering::Release);
        CONTEXT_FOCUSED.store(current.focused && self.enabled, Ordering::Release);
        if let Ok(mut pending) = self.pending_layout.lock() {
            *pending = None;
        }
        if let Ok(mut last) = self.last_layout.lock() {
            *last = None;
        }
        true
    }

    fn request_layout(&self, app: &AppHandle, request: LayoutRequest) {
        let context = self.context.lock().ok();
        let valid_context = context.as_ref().is_some_and(|context| {
            context.frontend_id == request.frontend_id
                && context.tab_id.as_deref() == Some(request.tab_id.as_str())
                && context.generation == request.generation
                && context.focused
        });
        if !self.enabled || !valid_context || !native_terminal_focus_is_valid() {
            emit_probe_error(
                app,
                request.frontend_id.clone(),
                Some(request.tab_id.clone()),
                request.generation,
                Some(request.hkl.clone()),
                "layout request rejected: focused probe context is stale or not foreground".into(),
            );
            return;
        }
        let Some(hkl) = parse_hkl(&request.hkl) else {
            emit_probe_error(
                app,
                request.frontend_id.clone(),
                Some(request.tab_id.clone()),
                request.generation,
                Some(request.hkl.clone()),
                "layout request rejected: malformed HKL".into(),
            );
            return;
        };
        if !installed_layouts()
            .iter()
            .any(|installed| *installed == hkl)
        {
            emit_probe_error(
                app,
                request.frontend_id.clone(),
                Some(request.tab_id.clone()),
                request.generation,
                Some(request.hkl.clone()),
                "layout request rejected: HKL is not in GetKeyboardLayoutList".into(),
            );
            return;
        }
        let Some((focus, _, _)) = current_focus_layout() else {
            emit_probe_error(
                app,
                request.frontend_id.clone(),
                Some(request.tab_id.clone()),
                request.generation,
                Some(request.hkl.clone()),
                "layout request rejected: no focused HWND in the pinned main WebView".into(),
            );
            return;
        };
        let mut pending = match self.pending_layout.lock() {
            Ok(pending) => pending,
            Err(_) => return,
        };
        if pending.is_some() {
            emit_probe_error(
                app,
                request.frontend_id.clone(),
                Some(request.tab_id.clone()),
                request.generation,
                Some(request.hkl.clone()),
                "layout request rejected: another request is pending".into(),
            );
            return;
        }
        let posted = unsafe { PostMessageW(focus, WM_INPUTLANGCHANGEREQUEST, 0, hkl as isize) };
        if posted == 0 {
            emit_probe_error(
                app,
                request.frontend_id.clone(),
                Some(request.tab_id),
                request.generation,
                Some(request.hkl),
                format!(
                    "WM_INPUTLANGCHANGEREQUEST post failed: {}",
                    std::io::Error::last_os_error()
                ),
            );
            return;
        }
        *pending = Some(PendingLayout {
            frontend_id: request.frontend_id,
            tab_id: request.tab_id,
            generation: request.generation,
            hkl: format_hkl(hkl),
            deadline: tick_ms().saturating_add(2_000),
        });
    }

    fn trace(&self) -> ProbeTrace {
        let context = self.context.lock().ok();
        let mut entries = Vec::new();
        let end = TRACE_CURSOR.load(Ordering::Acquire);
        let start = end.saturating_sub(TRACE_CAPACITY as u64);
        for sequence in start..end {
            let packed = TRACE[sequence as usize % TRACE_CAPACITY].load(Ordering::Acquire);
            if (packed >> 32) != sequence + 1 {
                continue;
            }
            let edge_down = packed & (1 << 8) != 0;
            let injected = packed & (1 << 9) != 0;
            let probe_token = packed & (1 << 10) != 0;
            let (tick_ms, send_result) = decode_trace_tick_and_result(packed);
            entries.push(TraceEntry {
                sequence,
                tick_ms,
                vk: (packed & 0xFF) as u16,
                edge: if edge_down { "down" } else { "up" },
                injected,
                probe_token,
                send_input_result: match send_result {
                    1 => Some(true),
                    2 => Some(false),
                    _ => None,
                },
            });
        }
        let failed = entries
            .iter()
            .any(|entry| entry.send_input_result == Some(false));
        ProbeTrace {
            hook_installed: HOOK_ACTIVE.load(Ordering::Acquire),
            callback_observed: HOOK_CALLBACK_COUNT.load(Ordering::Acquire) != 0,
            hook_callback_count: HOOK_CALLBACK_COUNT.load(Ordering::Acquire),
            hook_started_tick_ms: HOOK_STARTED_TICK.load(Ordering::Acquire),
            hook_loop_heartbeat_tick_ms: HOOK_LOOP_HEARTBEAT_TICK.load(Ordering::Acquire),
            snapshot_tick_ms: tick_ms(),
            armed: CONTEXT_FOCUSED.load(Ordering::Acquire),
            failed,
            target_pid: TARGET_PID.load(Ordering::Acquire),
            target_hwnd: format!("0x{:X}", TARGET_HWND.load(Ordering::Acquire)),
            target_webview_hwnd: format!("0x{:X}", TARGET_WEBVIEW_HWND.load(Ordering::Acquire)),
            frontend_id: context
                .as_ref()
                .map(|context| context.frontend_id.clone())
                .unwrap_or_default(),
            tab_id: context.and_then(|context| context.tab_id.clone()),
            generation: CONTEXT_GENERATION.load(Ordering::Acquire),
            entries,
        }
    }

    pub fn shutdown(&self) {
        LAYOUT_POLL_STOP.store(true, Ordering::Release);
        CONTEXT_FOCUSED.store(false, Ordering::Release);
        CAPS_LOGICAL_DOWN.store(false, Ordering::Release);
        CAPS_SUPPRESSED_DOWN.store(false, Ordering::Release);
        HOOK_ACTIVE.store(false, Ordering::Release);
        let id = HOOK_THREAD_ID.load(Ordering::Acquire);
        if id != 0 {
            unsafe {
                PostThreadMessageW(id, WM_QUIT, 0, 0);
            }
        }
        if let Ok(mut thread) = self.thread.lock() {
            if let Some(thread) = thread.take() {
                let _ = thread.join();
            }
        }
        if let Ok(mut thread) = self.layout_thread.lock() {
            if let Some(thread) = thread.take() {
                let _ = thread.join();
            }
        }
    }
}

impl Drop for Probe {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub fn setup(app: &AppHandle, window: &tauri::WebviewWindow) {
    let hwnd = window
        .hwnd()
        .map(|hwnd| hwnd.0 as HWND)
        .unwrap_or(null_mut());
    let mut pid = 0;
    if !hwnd.is_null() {
        unsafe {
            GetWindowThreadProcessId(hwnd, &mut pid);
        }
    }
    app.manage(Probe::start(hwnd, pid));
    if let Some(probe) = app.try_state::<Probe>() {
        probe.start_layout_poller(app.clone());
    }

    let handle = app.clone();
    app.listen("automation-probe-ready", move |event| {
        STATUS_REQUESTED.store(true, Ordering::Release);
        if let Some(probe) = handle.try_state::<Probe>() {
            if let Ok(ready) = serde_json::from_str::<FrontendReady>(event.payload()) {
                probe.begin_frontend(ready.frontend_id);
            }
            let _ = handle.emit("automation-probe-status", probe.status());
        }
    });
    let handle = app.clone();
    app.listen("automation-probe-context", move |event| {
        if let (Some(probe), Ok(context)) = (
            handle.try_state::<Probe>(),
            serde_json::from_str::<ProbeContext>(event.payload()),
        ) {
            if probe.set_context(context) {
                emit_current_layout(&handle);
            }
        }
    });
    let handle = app.clone();
    app.listen("automation-probe-layout-request", move |event| {
        if let (Some(probe), Ok(request)) = (
            handle.try_state::<Probe>(),
            serde_json::from_str::<LayoutRequest>(event.payload()),
        ) {
            probe.request_layout(&handle, request);
        }
    });
    let handle = app.clone();
    app.listen("automation-probe-trace-request", move |_| {
        if let Some(probe) = handle.try_state::<Probe>() {
            let _ = handle.emit("automation-probe-trace", probe.trace());
        }
    });
    if let Some(webview) = app.get_webview("main") {
        let handle = app.clone();
        let root = hwnd as isize;
        let _ = webview.with_webview(move |platform| {
            let controller = platform.controller();
            let mut host = unsafe { std::mem::zeroed() };
            let result = unsafe { controller.ParentWindow(&mut host) };
            let host_hwnd = if result.is_ok() {
                host.0 as HWND
            } else {
                null_mut()
            };
            let mut class_name = [0u16; 32];
            let class_len = if host_hwnd.is_null() {
                0
            } else {
                unsafe {
                    GetClassNameW(host_hwnd, class_name.as_mut_ptr(), class_name.len() as i32)
                }
            };
            let is_main_host = !host_hwnd.is_null()
                && root != 0
                && unsafe { IsChild(root as HWND, host_hwnd) } != 0
                && class_len > 0
                && String::from_utf16_lossy(&class_name[..class_len as usize]) == "WRY_WEBVIEW";
            TARGET_WEBVIEW_HWND.store(
                if is_main_host { host_hwnd as isize } else { 0 },
                Ordering::Release,
            );
            TARGET_WEBVIEW_RESOLVED.store(true, Ordering::Release);
            if STATUS_REQUESTED.load(Ordering::Acquire) {
                if let Some(probe) = handle.try_state::<Probe>() {
                    let _ = handle.emit("automation-probe-status", probe.status());
                }
            }
        });
    } else {
        TARGET_WEBVIEW_RESOLVED.store(true, Ordering::Release);
    }
}

fn start_hook_thread() -> Result<JoinHandle<()>, String> {
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let thread = thread::Builder::new()
        .name("scanline-automation-probe-hook".into())
        .spawn(move || hook_thread(ready_tx))
        .map_err(|error| error.to_string())?;
    match ready_rx.recv_timeout(Duration::from_secs(2)) {
        Ok(Ok(())) => Ok(thread),
        Ok(Err(error)) => {
            let _ = thread.join();
            Err(error)
        }
        Err(error) => {
            let id = HOOK_THREAD_ID.load(Ordering::Acquire);
            if id != 0 {
                unsafe {
                    PostThreadMessageW(id, WM_QUIT, 0, 0);
                }
            }
            let _ = thread.join();
            Err(format!("keyboard hook did not start: {error}"))
        }
    }
}

fn hook_thread(ready: mpsc::SyncSender<Result<(), String>>) {
    unsafe {
        let thread_id = GetCurrentThreadId();
        HOOK_THREAD_ID.store(thread_id, Ordering::Release);
        let mut message = std::mem::zeroed::<MSG>();
        PeekMessageW(&mut message, null_mut(), 0, 0, PM_NOREMOVE);
        let module = GetModuleHandleW(null_mut());
        let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), module, 0);
        if hook.is_null() {
            let _ = ready.send(Err(std::io::Error::last_os_error().to_string()));
            HOOK_THREAD_ID.store(0, Ordering::Release);
            return;
        }
        HOOK_ACTIVE.store(true, Ordering::Release);
        HOOK_STARTED_TICK.store(tick_ms(), Ordering::Release);
        HOOK_LOOP_HEARTBEAT_TICK.store(tick_ms(), Ordering::Release);
        let _ = ready.send(Ok(()));
        loop {
            let result = MsgWaitForMultipleObjects(0, null(), 0, 100, QS_ALLINPUT);
            HOOK_LOOP_HEARTBEAT_TICK.store(tick_ms(), Ordering::Release);
            if result == WAIT_FAILED {
                break;
            }
            let mut quit = false;
            while PeekMessageW(&mut message, null_mut(), 0, 0, PM_REMOVE) != 0 {
                if message.message == WM_QUIT {
                    quit = true;
                    break;
                }
                if message.message == WM_RELEASE_PENDING_TOKEN {
                    release_pending_token_up();
                    continue;
                }
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            if quit {
                break;
            }
        }
        // shortcut: shutdown outside owned focus cannot flush a pending token up; revisit before production use.
        release_pending_token_up();
        HOOK_ACTIVE.store(false, Ordering::Release);
        UnhookWindowsHookEx(hook);
        HOOK_THREAD_ID.store(0, Ordering::Release);
    }
}

unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    HOOK_CALLBACK_COUNT.fetch_add(1, Ordering::Relaxed);
    if code != HC_ACTION as i32 {
        return unsafe { CallNextHookEx(null_mut(), code, wparam, lparam) };
    }
    let key = unsafe { &*(lparam as *const KBDLLHOOKSTRUCT) };
    let message = wparam as u32;
    let down = matches!(message, WM_KEYDOWN | WM_SYSKEYDOWN);
    let up = matches!(message, WM_KEYUP | WM_SYSKEYUP);
    let injected = key.flags & LLKHF_INJECTED != 0;
    let own_token = key.vkCode == VK_NONAME as u32 && injected && key.dwExtraInfo == TOKEN_MARKER;
    let vk = key.vkCode;

    if !own_token && vk != VK_CAPITAL as u32 && vk != VK_NONAME as u32 && vk != VK_H {
        return unsafe { CallNextHookEx(null_mut(), code, wparam, lparam) };
    }
    let target_foreground = target_is_foreground();

    if own_token {
        // Keep marked injections visible even if focus changed between the
        // SendInput call and callback delivery; ordinary keys stay target-only.
        record(vk, down, injected, true, 0);
        return unsafe { CallNextHookEx(null_mut(), code, wparam, lparam) };
    }

    let slot = if target_foreground {
        Some(record(vk, down, injected, false, 0))
    } else {
        None
    };
    if vk == VK_NONAME as u32 && target_foreground && CONTEXT_FOCUSED.load(Ordering::Acquire) {
        return 1;
    }
    if vk == VK_CAPITAL as u32 && down && CAPS_SUPPRESSED_DOWN.load(Ordering::Acquire) {
        return 1;
    }
    if vk == VK_CAPITAL as u32
        && down
        && target_foreground
        && CONTEXT_FOCUSED.load(Ordering::Acquire)
    {
        if TOKEN_UP_PENDING.load(Ordering::Acquire) {
            release_pending_token_up();
            if TOKEN_UP_PENDING.load(Ordering::Acquire) {
                return unsafe { CallNextHookEx(null_mut(), code, wparam, lparam) };
            }
        }
        if CAPS_SUPPRESSED_DOWN
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return 1;
        }
        let generation = CONTEXT_GENERATION.load(Ordering::Acquire);
        CAPS_LOGICAL_DOWN.store(true, Ordering::Release);
        let result = send_token(true);
        if let Some(slot) = slot {
            set_send_result(slot, if result == 1 { 1 } else { 2 });
        }
        if result == 1 {
            TOKEN_UP_PENDING.store(true, Ordering::Release);
            if generation != CONTEXT_GENERATION.load(Ordering::Acquire)
                || !CONTEXT_FOCUSED.load(Ordering::Acquire)
            {
                CAPS_LOGICAL_DOWN.store(false, Ordering::Release);
            }
            release_pending_token_up();
            return 1;
        }
        CAPS_SUPPRESSED_DOWN.store(false, Ordering::Release);
        CAPS_LOGICAL_DOWN.store(false, Ordering::Release);
    }
    if vk == VK_CAPITAL as u32 && up && CAPS_SUPPRESSED_DOWN.swap(false, Ordering::AcqRel) {
        CAPS_LOGICAL_DOWN.store(false, Ordering::Release);
        if let (Some(slot), Some(result)) = (slot, release_pending_token_up()) {
            set_send_result(slot, if result == 1 { 1 } else { 2 });
        }
        return 1;
    }
    unsafe { CallNextHookEx(null_mut(), code, wparam, lparam) }
}

fn release_pending_token_up() -> Option<u32> {
    if !token_up_ready(
        TOKEN_UP_PENDING.load(Ordering::Acquire),
        CAPS_LOGICAL_DOWN.load(Ordering::Acquire),
        CAPS_SUPPRESSED_DOWN.load(Ordering::Acquire),
        target_is_foreground(),
    )
    {
        return None;
    }
    let result = send_token(false);
    if result == 1 {
        TOKEN_UP_PENDING.store(false, Ordering::Release);
    }
    Some(result)
}

fn post_pending_token_up() {
    if !token_up_ready(
        TOKEN_UP_PENDING.load(Ordering::Acquire),
        CAPS_LOGICAL_DOWN.load(Ordering::Acquire),
        CAPS_SUPPRESSED_DOWN.load(Ordering::Acquire),
        target_is_foreground(),
    )
    {
        return;
    }
    let thread_id = HOOK_THREAD_ID.load(Ordering::Acquire);
    if thread_id != 0 {
        unsafe { PostThreadMessageW(thread_id, WM_RELEASE_PENDING_TOKEN, 0, 0) };
    }
}

fn token_up_ready(
    pending: bool,
    logical_down: bool,
    physical_down: bool,
    target_foreground: bool,
) -> bool {
    pending && target_foreground && (!logical_down || !physical_down)
}

fn tick_ms() -> u64 {
    unsafe { windows_sys::Win32::System::SystemInformation::GetTickCount64() }
}

fn send_token(down: bool) -> u32 {
    let mut input = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VK_NONAME,
                wScan: 0,
                dwFlags: if down { 0 } else { KEYEVENTF_KEYUP },
                time: 0,
                dwExtraInfo: TOKEN_MARKER,
            },
        },
    };
    unsafe { SendInput(1, &mut input, size_of::<INPUT>() as i32) }
}

fn target_is_foreground() -> bool {
    let root = TARGET_HWND.load(Ordering::Acquire) as HWND;
    let target = TARGET_WEBVIEW_HWND.load(Ordering::Acquire) as HWND;
    if root.is_null() || target.is_null() {
        return false;
    }
    let foreground = unsafe { GetForegroundWindow() };
    if foreground.is_null()
        || unsafe { GetAncestor(foreground, GA_ROOT) } != root
        || unsafe { IsChild(root, target) } == 0
    {
        return false;
    }
    let mut pid = 0;
    let thread_id = unsafe { GetWindowThreadProcessId(target, &mut pid) };
    if pid != TARGET_PID.load(Ordering::Acquire) || thread_id == 0 {
        return false;
    }
    let mut info = GUITHREADINFO {
        cbSize: size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    if unsafe { GetGUIThreadInfo(thread_id, &mut info) } == 0 {
        return false;
    }
    info.hwndFocus == target || unsafe { IsChild(target, info.hwndFocus) } != 0
}

fn installed_layouts() -> Vec<HKL> {
    unsafe {
        let count = GetKeyboardLayoutList(0, null_mut());
        if count <= 0 {
            return Vec::new();
        }
        let mut layouts = vec![null_mut(); count as usize];
        let written = GetKeyboardLayoutList(layouts.len() as i32, layouts.as_mut_ptr());
        if written <= 0 {
            return Vec::new();
        }
        layouts.truncate(written as usize);
        layouts
    }
}

fn format_hkl(hkl: HKL) -> String {
    format!("0x{:X}", hkl as usize)
}

fn parse_hkl(value: &str) -> Option<HKL> {
    let digits = value
        .trim()
        .strip_prefix("0x")
        .or_else(|| value.trim().strip_prefix("0X"))?;
    usize::from_str_radix(digits, 16)
        .ok()
        .map(|value| value as HKL)
}

fn validate_hkl(value: &str, installed: &[HKL]) -> Option<HKL> {
    let hkl = parse_hkl(value)?;
    installed
        .iter()
        .any(|candidate| *candidate == hkl)
        .then_some(hkl)
}

fn active_klid_for(hkl: HKL) -> Option<String> {
    if unsafe { GetKeyboardLayout(0) } != hkl {
        return None;
    }
    let mut name = [0u16; 9];
    if unsafe { GetKeyboardLayoutNameW(name.as_mut_ptr()) } == 0 {
        return None;
    }
    let value = String::from_utf16_lossy(&name[..8]);
    (!value.trim_matches('\0').is_empty()).then_some(value)
}

fn layout_inventory() -> (Vec<LayoutInfo>, LayoutTargets, Option<String>) {
    let installed = installed_layouts();
    let current = current_focus_layout().map(|(_, _, hkl)| hkl);
    let layouts = installed
        .iter()
        .map(|hkl| LayoutInfo {
            hkl: format_hkl(*hkl),
            klid: current
                .filter(|active| active == hkl)
                .and_then(|active| active_klid_for(active)),
            lang_id_hint: format!("0x{:04X}", (*hkl as usize) & 0xFFFF),
        })
        .collect::<Vec<_>>();
    let normal = target_hkl_env("SCANLINE_TERM_AUTOMATION_PROBE_NORMAL_HKL", &installed);
    let insert = target_hkl_env("SCANLINE_TERM_AUTOMATION_PROBE_INSERT_HKL", &installed);
    let mut errors = Vec::new();
    for (name, value, parsed) in [
        (
            "normal",
            std::env::var("SCANLINE_TERM_AUTOMATION_PROBE_NORMAL_HKL").ok(),
            normal,
        ),
        (
            "insert",
            std::env::var("SCANLINE_TERM_AUTOMATION_PROBE_INSERT_HKL").ok(),
            insert,
        ),
    ] {
        if value.is_some() && parsed.is_none() {
            errors.push(format!(
                "configured {name} HKL is malformed or not installed"
            ));
        }
    }
    (
        layouts,
        LayoutTargets {
            normal_hkl: normal.map(format_hkl),
            insert_hkl: insert.map(format_hkl),
        },
        (!errors.is_empty()).then(|| errors.join("; ")),
    )
}

fn target_hkl_env(name: &str, installed: &[HKL]) -> Option<HKL> {
    let value = std::env::var(name).ok()?;
    validate_hkl(&value, installed)
}

fn current_focus_layout() -> Option<(HWND, u32, HKL)> {
    if !target_is_foreground() {
        return None;
    }
    let target = TARGET_WEBVIEW_HWND.load(Ordering::Acquire) as HWND;
    let host_thread = unsafe { GetWindowThreadProcessId(target, null_mut()) };
    if host_thread == 0 {
        return None;
    }
    let mut info = GUITHREADINFO {
        cbSize: size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    if unsafe { GetGUIThreadInfo(host_thread, &mut info) } == 0 {
        return None;
    }
    let focus = info.hwndFocus;
    if focus.is_null() || (focus != target && unsafe { IsChild(target, focus) } == 0) {
        return None;
    }
    let focus_thread = unsafe { GetWindowThreadProcessId(focus, null_mut()) };
    if focus_thread == 0 {
        return None;
    }
    let hkl = unsafe { GetKeyboardLayout(focus_thread) };
    (!hkl.is_null()).then_some((focus, focus_thread, hkl))
}

fn emit_current_layout(app: &AppHandle) {
    let Some(probe) = app.try_state::<Probe>() else {
        return;
    };
    let context = probe.context.lock().ok().map(|context| context.clone());
    let Some(context) = context.filter(|context| context.focused && context.tab_id.is_some())
    else {
        return;
    };
    let Some((_, _, hkl)) = current_focus_layout() else {
        return;
    };
    emit_layout_change(
        app,
        context.frontend_id,
        context.tab_id,
        context.generation,
        format_hkl(hkl),
        "observed",
    );
}

fn emit_layout_change(
    app: &AppHandle,
    frontend_id: String,
    tab_id: Option<String>,
    generation: u64,
    hkl: String,
    source: &'static str,
) {
    let _ = app.emit(
        "automation-probe-layout-changed",
        LayoutChange {
            frontend_id,
            tab_id,
            generation,
            hkl,
            source,
        },
    );
}

fn emit_probe_error(
    app: &AppHandle,
    frontend_id: String,
    tab_id: Option<String>,
    generation: u64,
    hkl: Option<String>,
    reason: String,
) {
    let _ = app.emit(
        "automation-probe-layout-error",
        ProbeError {
            frontend_id,
            tab_id,
            generation,
            hkl,
            reason,
        },
    );
}

fn layout_poll_loop(app: AppHandle) {
    while !LAYOUT_POLL_STOP.load(Ordering::Acquire) {
        post_pending_token_up();
        if let Some(probe) = app.try_state::<Probe>() {
            let context = probe.context.lock().ok().map(|context| context.clone());
            if let Some(context) = context
                .filter(|context| context.focused && context.tab_id.is_some() && probe.enabled)
            {
                if let Some((_, _, hkl)) = current_focus_layout() {
                    let hkl = format_hkl(hkl);
                    let mut request_observation = None;
                    let mut timeout_error = None;
                    if let Ok(mut pending) = probe.pending_layout.lock() {
                        if let Some(request) = pending.as_ref() {
                            if request.frontend_id != context.frontend_id
                                || request.tab_id != context.tab_id.as_deref().unwrap_or_default()
                                || request.generation != context.generation
                            {
                                *pending = None;
                            } else if request.hkl.eq_ignore_ascii_case(&hkl) {
                                request_observation = pending.take();
                            } else if tick_ms() >= request.deadline {
                                timeout_error = pending.take();
                            }
                        }
                    }
                    if let Some(request) = request_observation {
                        if let Ok(mut last) = probe.last_layout.lock() {
                            *last = Some((
                                request.frontend_id.clone(),
                                request.tab_id.clone(),
                                request.generation,
                                hkl.clone(),
                            ));
                        }
                        emit_layout_change(
                            &app,
                            request.frontend_id.clone(),
                            Some(request.tab_id.clone()),
                            request.generation,
                            hkl.clone(),
                            "request",
                        );
                    } else if let Some(request) = timeout_error {
                        emit_probe_error(
                            &app,
                            request.frontend_id,
                            Some(request.tab_id),
                            request.generation,
                            Some(request.hkl),
                            "timed out waiting for focused-thread HKL readback after WM_INPUTLANGCHANGEREQUEST".into(),
                        );
                    } else if let Ok(mut last) = probe.last_layout.lock() {
                        let key = (
                            context.frontend_id.clone(),
                            context.tab_id.clone().unwrap_or_default(),
                            context.generation,
                            hkl.clone(),
                        );
                        if last.as_ref() != Some(&key) {
                            *last = Some(key);
                            emit_layout_change(
                                &app,
                                context.frontend_id.clone(),
                                context.tab_id.clone(),
                                context.generation,
                                hkl,
                                "observed",
                            );
                        }
                    }
                } else if let Ok(mut pending) = probe.pending_layout.lock() {
                    // Focus left the pinned WebView; cancel rather than applying later.
                    *pending = None;
                }
            } else if let Ok(mut pending) = probe.pending_layout.lock() {
                *pending = None;
            }
        }
        thread::sleep(Duration::from_millis(LAYOUT_POLL_INTERVAL_MS as u64));
    }
}

fn native_terminal_focus_is_valid() -> bool {
    target_is_foreground()
}

fn reset_context_for_frontend(current: &ProbeContext, frontend_id: &str) -> Option<ProbeContext> {
    if frontend_id.is_empty() || current.frontend_id == frontend_id {
        return None;
    }
    Some(ProbeContext {
        frontend_id: frontend_id.to_owned(),
        ..ProbeContext::default()
    })
}

fn context_matches_frontend(current: &ProbeContext, incoming: &ProbeContext) -> bool {
    !incoming.frontend_id.is_empty() && incoming.frontend_id == current.frontend_id
}

fn record(vk: u32, down: bool, injected: bool, own_token: bool, send_result: u64) -> usize {
    let sequence = TRACE_CURSOR.fetch_add(1, Ordering::AcqRel);
    let slot = sequence as usize % TRACE_CAPACITY;
    let tick_ms = unsafe { windows_sys::Win32::System::SystemInformation::GetTickCount64() };
    let packed = ((sequence + 1) << 32)
        | pack_trace_fields(vk, down, injected, own_token, send_result, tick_ms);
    TRACE[slot].store(packed, Ordering::Release);
    slot
}

fn pack_trace_fields(
    vk: u32,
    down: bool,
    injected: bool,
    own_token: bool,
    send_result: u64,
    tick_ms: u64,
) -> u64 {
    ((tick_ms & 0x7_FFFF) << TRACE_TICK_SHIFT)
        | ((send_result & 0x3) << 11)
        | (u64::from(own_token) << 10)
        | (u64::from(injected) << 9)
        | (u64::from(down) << 8)
        | u64::from(vk & 0xFF)
}

fn decode_trace_tick_and_result(packed: u64) -> (u32, u8) {
    (
        ((packed >> TRACE_TICK_SHIFT) & 0x7_FFFF) as u32,
        ((packed >> 11) & 0x3) as u8,
    )
}

fn set_send_result(slot: usize, send_result: u64) {
    let current = TRACE[slot].load(Ordering::Acquire);
    TRACE[slot].store(
        (current & !(0x3 << 11)) | ((send_result & 0x3) << 11),
        Ordering::Release,
    );
}

#[cfg(test)]
mod tests {
    use super::{
        context_matches_frontend, decode_trace_tick_and_result, pack_trace_fields, parse_hkl,
        reset_context_for_frontend, token_up_ready, validate_hkl, ProbeContext,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::HKL;

    #[test]
    fn trace_tick_and_send_result_round_trip_without_overlap() {
        let tick = 0x5_4321;
        for result in 0..=2 {
            let packed = pack_trace_fields(0xFC, true, true, false, result, tick);
            assert_eq!(
                decode_trace_tick_and_result(packed),
                (tick as u32, result as u8)
            );
        }
    }

    #[test]
    fn hkl_validation_requires_exact_installed_value() {
        let installed = [0x0409_0409usize as HKL, 0x0419_0419usize as HKL];
        assert_eq!(parse_hkl("0x4090409"), Some(installed[0]));
        assert_eq!(parse_hkl("4090409"), None);
        assert_eq!(parse_hkl("0xnot-hex"), None);
        assert_eq!(validate_hkl("0x4090409", &installed), Some(installed[0]));
        assert_eq!(validate_hkl("0x409040A", &installed), None);
        assert_eq!(validate_hkl("0x4090409", &[]), None);
    }

    #[test]
    fn frontend_reload_resets_logical_context_and_rejects_old_instance() {
        let old_context = ProbeContext {
            frontend_id: "frontend-old".into(),
            tab_id: Some("tab-1".into()),
            generation: 87,
            focused: true,
        };
        let reset = reset_context_for_frontend(&old_context, "frontend-new")
            .expect("a new frontend instance resets the native context");
        assert_eq!(reset.frontend_id, "frontend-new");
        assert_eq!(reset.tab_id, None);
        assert_eq!(reset.generation, 0);
        assert!(!reset.focused);
        assert!(!context_matches_frontend(&reset, &old_context));
        assert!(reset_context_for_frontend(&reset, "frontend-new").is_none());
        assert!(reset_context_for_frontend(&reset, "").is_none());
    }

    #[test]
    fn owed_token_up_waits_for_cancellation_and_owned_focus_then_releases_once() {
        let mut pending = true;
        let mut logical_down = true;
        let physical_down = true;
        let mut ups_sent = 0;

        // A valid physical hold keeps the synthetic token held.
        if token_up_ready(pending, logical_down, physical_down, true) {
            ups_sent += 1;
            pending = false;
        }
        assert_eq!(ups_sent, 0);

        // The down succeeded; cancellation ends its logical context, creating
        // an owed up even though Caps itself remains physically held.
        logical_down = false;
        if token_up_ready(pending, logical_down, physical_down, false) {
            ups_sent += 1;
            pending = false;
        }
        assert!(pending);
        assert_eq!(ups_sent, 0);

        // Once this app owns focus, release the marker and clear the debt.
        if token_up_ready(pending, logical_down, physical_down, true) {
            ups_sent += 1;
            pending = false;
        }
        assert!(!pending);
        assert_eq!(ups_sent, 1);
        assert!(!token_up_ready(pending, logical_down, physical_down, true));
    }
}

#[allow(dead_code)]
const _: () = {
    assert!(size_of::<INPUT>() == 40);
    assert!(size_of::<KEYBDINPUT>() == 24);
};
