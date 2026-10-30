use std::{
    hash::BuildHasher,
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

const FRAME_INPUT_COUNT: usize = 18;
const VK_NONAME_CODE: u16 = 0xfc;
const CAPS_TAP_THRESHOLD_MS: u32 = 180;
const FRAME_START_DOWN_SCAN: u16 = 0x29;
const FRAME_START_UP_TAP_SCAN: u16 = 0x2b;
const FRAME_START_UP_HELD_SCAN: u16 = 0x56;
const FRAME_TERMINATOR_SCAN: u16 = 0x27;
const NIBBLE_SCANS: [u16; 16] = [
    0x0b, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x1e, 0x30, 0x2e, 0x20, 0x12, 0x21,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FrameInputSpec {
    vk_code: u16,
    scan_code: u16,
    keyup: bool,
    marker_token: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CapsFrameKind {
    Down,
    UpTap,
    UpHeld,
}

fn build_caps_frame(token: u64, kind: CapsFrameKind) -> [FrameInputSpec; FRAME_INPUT_COUNT] {
    let header_scan = match kind {
        CapsFrameKind::Down => FRAME_START_DOWN_SCAN,
        CapsFrameKind::UpTap => FRAME_START_UP_TAP_SCAN,
        CapsFrameKind::UpHeld => FRAME_START_UP_HELD_SCAN,
    };
    let mut inputs = [FrameInputSpec {
        vk_code: VK_NONAME_CODE,
        scan_code: header_scan,
        keyup: false,
        marker_token: token,
    }; FRAME_INPUT_COUNT];
    for index in 0..16 {
        let nibble = ((token >> (60 - (index * 4))) & 0x0f) as usize;
        inputs[index + 1].scan_code = NIBBLE_SCANS[nibble];
    }
    inputs[FRAME_INPUT_COUNT - 1].scan_code = FRAME_TERMINATOR_SCAN;
    inputs[FRAME_INPUT_COUNT - 1].keyup = true;
    inputs
}

fn classify_caps_up(down_tick: u32, up_tick: u32) -> CapsFrameKind {
    if up_tick.wrapping_sub(down_tick) < CAPS_TAP_THRESHOLD_MS {
        CapsFrameKind::UpTap
    } else {
        CapsFrameKind::UpHeld
    }
}

fn latch_physical_caps_down(
    suppressed_down: &AtomicBool,
    down_time: &AtomicU32,
    event_time: u32,
) -> bool {
    if suppressed_down
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return false;
    }
    down_time.store(event_time, Ordering::Release);
    true
}

static POLICY_ARMED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PolicyCandidate {
    frontend_id: String,
    generation: u64,
    tab_id: Option<String>,
    process_name: Option<String>,
    enabled: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PolicyLease {
    pub frontend_id: String,
    pub generation: u64,
    pub policy_epoch: u64,
    pub marker_token: String,
    pub tab_id: Option<String>,
    pub process_name: Option<String>,
    pub enabled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Context {
    frontend_id: String,
    latest_generation: u64,
    semantic_generation: u64,
    tab_id: Option<String>,
    process_name: Option<String>,
    focused: bool,
}

impl Context {
    fn identity_matches(
        &self,
        frontend_id: &str,
        tab_id: &Option<String>,
        process_name: &Option<String>,
    ) -> bool {
        self.frontend_id == frontend_id
            && &self.tab_id == tab_id
            && &self.process_name == process_name
    }
}

#[derive(Default)]
struct Control {
    closed: bool,
    context: Option<Context>,
    next_epoch: u64,
    pending: Option<PolicyLease>,
    active: Option<PolicyLease>,
}

fn disabled_lease(control: &mut Control, previous: PolicyLease) -> PolicyLease {
    control.next_epoch = control.next_epoch.wrapping_add(1).max(1);
    PolicyLease {
        frontend_id: previous.frontend_id,
        generation: previous.generation,
        policy_epoch: control.next_epoch,
        marker_token: previous.marker_token,
        tab_id: previous.tab_id,
        process_name: previous.process_name,
        enabled: false,
    }
}

fn disarm_policy() {
    POLICY_ARMED.store(false, std::sync::atomic::Ordering::Release);
    clear_marker_token();
    cancel_logical_hold();
}

fn random_marker_token() -> String {
    format!("{:016x}", random_marker_value())
}

fn random_marker_value() -> u64 {
    static NONCE: AtomicU64 = AtomicU64::new(1);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    std::collections::hash_map::RandomState::new()
        .hash_one((
            std::process::id(),
            timestamp,
            NONCE.fetch_add(1, Ordering::Relaxed),
        ))
        .max(1)
}

fn marker_signature_matches(received: u64, frame_signature: u64, debug_signature: u64) -> bool {
    received != 0 && (received == frame_signature || received == debug_signature)
}

fn startup_hook_error_to_report(
    error: &str,
    already_reported: &std::sync::atomic::AtomicBool,
) -> Option<String> {
    (!already_reported.swap(true, std::sync::atomic::Ordering::AcqRel)).then(|| {
        format!("Caps Lua policy is enabled, but the native keyboard hook failed to start: {error}")
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CapsMode {
    Policy(u64),
    Debug,
    PassThrough,
}

fn select_caps_mode(policy_token_snapshot: u64, debug_armed: bool) -> CapsMode {
    if policy_token_snapshot != 0 {
        CapsMode::Policy(policy_token_snapshot)
    } else if debug_armed {
        CapsMode::Debug
    } else {
        CapsMode::PassThrough
    }
}

pub struct CapsHook {
    control: Mutex<Control>,
    #[cfg(windows)]
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
    #[cfg(windows)]
    startup_error: Option<String>,
    #[cfg(windows)]
    startup_error_reported: std::sync::atomic::AtomicBool,
}

impl CapsHook {
    fn new() -> Self {
        Self {
            control: Mutex::new(Control::default()),
            #[cfg(windows)]
            thread: Mutex::new(None),
            #[cfg(windows)]
            startup_error: None,
            #[cfg(windows)]
            startup_error_reported: std::sync::atomic::AtomicBool::new(false),
        }
    }

    fn context_changed(
        &self,
        app: &AppHandle,
        frontend_id: &str,
        generation: u64,
        tab_id: Option<&str>,
        process_name: Option<&str>,
        focused: bool,
    ) {
        let Ok(mut control) = self.control.lock() else {
            return;
        };
        if control.closed {
            return;
        }
        let next_tab = tab_id.map(str::to_owned);
        let next_process = process_name.map(str::to_owned);
        let identity_changed = control.context.as_ref().is_none_or(|old| {
            old.frontend_id != frontend_id
                || old.tab_id != next_tab
                || old.process_name != next_process
                || old.focused != focused
        });
        let previous = if identity_changed {
            let previous = control.active.take().or_else(|| control.pending.take());
            control.pending = None;
            disarm_policy();
            previous
        } else {
            None
        };
        let semantic_generation = if identity_changed {
            generation
        } else {
            control
                .context
                .as_ref()
                .map_or(generation, |old| old.semantic_generation)
        };
        control.context = Some(Context {
            frontend_id: frontend_id.to_owned(),
            latest_generation: generation,
            semantic_generation,
            tab_id: next_tab,
            process_name: next_process,
            focused,
        });
        if !focused
            || control
                .context
                .as_ref()
                .is_some_and(|context| context.tab_id.is_none())
        {
            control.pending = None;
            control.active = None;
            cancel_logical_hold();
        }
        if let Some(previous) = previous {
            let disabled = disabled_lease(&mut control, previous);
            let _ = app.emit("caps-policy-lease", disabled);
        }
    }

    fn revoke(&self, app: Option<&AppHandle>) {
        let Ok(mut control) = self.control.lock() else {
            return;
        };
        let previous = control.active.take().or_else(|| control.pending.take());
        control.pending = None;
        control.active = None;
        disarm_policy();
        if let (Some(app), Some(previous)) = (app, previous) {
            let _ = app.emit("caps-policy-lease", disabled_lease(&mut control, previous));
        }
    }

    fn candidate(&self, app: &AppHandle, candidate: PolicyCandidate) -> Result<bool, String> {
        if candidate.frontend_id.is_empty()
            || candidate.frontend_id.len() > 128
            || candidate
                .tab_id
                .as_ref()
                .is_some_and(|id| id.is_empty() || id.len() > 128)
            || candidate
                .process_name
                .as_ref()
                .is_some_and(|name| name.is_empty() || name.len() > 260)
        {
            return Err("Caps policy candidate is malformed".into());
        }
        let mut control = self
            .control
            .lock()
            .map_err(|_| "Caps policy state is unavailable")?;
        if control.closed {
            return Ok(false);
        }
        let Some(context) = control.context.as_ref() else {
            return Ok(false);
        };
        if !context.identity_matches(
            &candidate.frontend_id,
            &candidate.tab_id,
            &candidate.process_name,
        ) || candidate.generation < context.semantic_generation
            || candidate.generation > context.latest_generation
            || candidate.enabled
                && (!context.focused
                    || !native_focus_is_valid()
                    || candidate.tab_id.is_none()
                    || candidate.process_name.is_none())
        {
            return Ok(false);
        }
        #[cfg(windows)]
        if candidate.enabled {
            if let Some(error) = self.startup_error.as_ref() {
                if let Some(message) =
                    startup_hook_error_to_report(error, &self.startup_error_reported)
                {
                    return Err(message);
                }
                return Ok(false);
            }
        }
        if candidate.enabled
            && (control.active.as_ref().is_some_and(|active| {
                active.frontend_id == candidate.frontend_id
                    && active.tab_id == candidate.tab_id
                    && active.process_name == candidate.process_name
                    && active.enabled
            }) || control.pending.as_ref().is_some_and(|pending| {
                pending.frontend_id == candidate.frontend_id
                    && pending.tab_id == candidate.tab_id
                    && pending.process_name == candidate.process_name
                    && pending.enabled
            }))
        {
            return Ok(true);
        }
        if candidate.enabled {
            control.next_epoch = control.next_epoch.wrapping_add(1).max(1);
            let marker_token = random_marker_token();
            let lease = PolicyLease {
                frontend_id: candidate.frontend_id,
                generation: candidate.generation,
                policy_epoch: control.next_epoch,
                marker_token,
                tab_id: candidate.tab_id,
                process_name: candidate.process_name,
                enabled: true,
            };
            control.active = None;
            control.pending = Some(lease.clone());
            POLICY_ARMED.store(false, std::sync::atomic::Ordering::Release);
            clear_marker_token();
            app.emit("caps-policy-lease", lease)
                .map_err(|error| error.to_string())?;
        } else {
            let previous = control.active.take().or_else(|| control.pending.take());
            if previous.is_none() {
                return Ok(true);
            }
            control.pending = None;
            control.active = None;
            disarm_policy();
            app.emit(
                "caps-policy-lease",
                disabled_lease(&mut control, previous.unwrap()),
            )
            .map_err(|error| error.to_string())?;
        }
        Ok(true)
    }

    fn acknowledge(&self, ack: PolicyLease) -> bool {
        let Ok(mut control) = self.control.lock() else {
            return false;
        };
        if control.closed {
            return false;
        }
        let Some(pending) = control.pending.as_ref() else {
            return false;
        };
        let marker_token = pending.marker_token.clone();
        let same_lease = pending.frontend_id == ack.frontend_id
            && pending.generation == ack.generation
            && pending.policy_epoch == ack.policy_epoch
            && pending.marker_token == ack.marker_token
            && pending.tab_id == ack.tab_id
            && pending.process_name == ack.process_name
            && pending.enabled == ack.enabled
            && ack.enabled;
        let context_matches = control.context.as_ref().is_some_and(|context| {
            context.focused
                && context.identity_matches(&ack.frontend_id, &ack.tab_id, &ack.process_name)
                && ack.generation >= context.semantic_generation
                && ack.generation <= context.latest_generation
        });
        if !same_lease
            || !context_matches
            || !native_focus_is_valid()
            || !hook_active()
            || !activate_marker_token(&marker_token)
        {
            if control
                .pending
                .as_ref()
                .is_some_and(|lease| lease.policy_epoch == ack.policy_epoch)
            {
                control.pending = None;
            }
            return false;
        }
        let lease = control.pending.take().expect("pending lease checked above");
        control.active = Some(lease);
        POLICY_ARMED.store(true, std::sync::atomic::Ordering::Release);
        true
    }

    pub(crate) fn shutdown(&self) {
        self.stop_accepting();
        #[cfg(windows)]
        {
            let id = windows_hook::HOOK_THREAD_ID.load(std::sync::atomic::Ordering::Acquire);
            if id != 0 {
                unsafe {
                    windows_sys::Win32::UI::WindowsAndMessaging::PostThreadMessageW(
                        id,
                        windows_sys::Win32::UI::WindowsAndMessaging::WM_QUIT,
                        0,
                        0,
                    )
                };
            }
            if let Ok(mut thread) = self.thread.lock() {
                if let Some(thread) = thread.take() {
                    let _ = thread.join();
                }
            }
        }
    }

    pub(crate) fn stop_accepting(&self) {
        let Ok(mut control) = self.control.lock() else {
            return;
        };
        if control.closed {
            return;
        }
        control.closed = true;
        control.pending = None;
        control.active = None;
        disarm_policy();
    }
}

impl Drop for CapsHook {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub fn setup(app: &AppHandle, window: &tauri::WebviewWindow) {
    let hook = CapsHook::new();
    #[cfg(windows)]
    let hook = start_windows_hook(app, window, hook);
    app.manage(hook);
}

pub fn context_changed(
    app: &AppHandle,
    frontend_id: &str,
    generation: u64,
    tab_id: Option<&str>,
    process_name: Option<&str>,
    focused: bool,
) {
    if let Some(hook) = app.try_state::<CapsHook>() {
        hook.context_changed(app, frontend_id, generation, tab_id, process_name, focused);
    }
}

pub fn revoke(app: &AppHandle) {
    if let Some(hook) = app.try_state::<CapsHook>() {
        hook.revoke(Some(app));
    }
}

pub(crate) fn publish_candidate(
    app: &AppHandle,
    frontend_id: String,
    generation: u64,
    tab_id: Option<String>,
    process_name: Option<String>,
    enabled: bool,
) -> Result<bool, String> {
    let hook = app
        .try_state::<CapsHook>()
        .ok_or("Caps hook is unavailable")?;
    hook.candidate(
        app,
        PolicyCandidate {
            frontend_id,
            generation,
            tab_id,
            process_name,
            enabled,
        },
    )
}

#[tauri::command]
pub fn caps_policy_ack(
    window: tauri::WebviewWindow,
    hook: State<'_, CapsHook>,
    ack: PolicyLease,
) -> bool {
    window.label() == "main" && hook.acknowledge(ack)
}

#[cfg(windows)]
pub(crate) fn set_webview_hwnd(hwnd: windows_sys::Win32::Foundation::HWND) {
    windows_hook::TARGET_WEBVIEW_HWND.store(hwnd as isize, std::sync::atomic::Ordering::Release);
}

#[cfg(windows)]
pub(crate) fn native_focus_is_valid() -> bool {
    windows_hook::target_is_foreground()
}

#[cfg(windows)]
fn activate_marker_token(token: &str) -> bool {
    let Ok(token) = u64::from_str_radix(token, 16) else {
        return false;
    };
    if token == 0 {
        return false;
    }
    windows_hook::activate_marker_token(token)
}

#[cfg(not(windows))]
fn activate_marker_token(_token: &str) -> bool {
    false
}

#[cfg(windows)]
fn clear_marker_token() {
    windows_hook::clear_marker_token();
}

#[cfg(not(windows))]
fn clear_marker_token() {}

#[cfg(not(windows))]
pub(crate) fn native_focus_is_valid() -> bool {
    false
}

#[cfg(all(windows, debug_assertions))]
fn trace_hook_event(vk: u32, down: bool, injected: bool, own_token: bool, result: u64) -> usize {
    crate::automation_probe::record_shared_hook(vk, down, injected, own_token, result)
}

#[cfg(all(windows, debug_assertions))]
fn trace_hook_result(slot: usize, result: u64) {
    crate::automation_probe::set_shared_send_result(slot, result);
}

#[cfg(windows)]
fn hook_active() -> bool {
    windows_hook::HOOK_ACTIVE.load(std::sync::atomic::Ordering::Acquire)
}

#[cfg(not(windows))]
fn hook_active() -> bool {
    false
}

#[cfg(windows)]
mod windows_hook {
    use super::{
        AppHandle, CapsFrameKind, CapsMode, FRAME_INPUT_COUNT, FrameInputSpec, POLICY_ARMED,
        VK_NONAME_CODE, build_caps_frame, classify_caps_up, marker_signature_matches,
        random_marker_value, select_caps_mode,
    };
    use std::{
        mem::size_of,
        ptr::{null, null_mut},
        sync::{
            atomic::{AtomicBool, AtomicIsize, AtomicU32, AtomicU64, Ordering},
            mpsc,
        },
        thread,
        time::Duration,
    };
    use tauri::Manager;
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WAIT_FAILED, WPARAM},
        System::{LibraryLoader::GetModuleHandleW, Threading::GetCurrentThreadId},
        UI::{
            Input::KeyboardAndMouse::{
                INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput, VK_CAPITAL,
                VK_NONAME,
            },
            WindowsAndMessaging::{
                CallNextHookEx, DispatchMessageW, GA_ROOT, GUITHREADINFO, GetAncestor,
                GetForegroundWindow, GetGUIThreadInfo, GetWindowThreadProcessId, HC_ACTION,
                IsChild, KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG, MsgWaitForMultipleObjects,
                PM_NOREMOVE, PM_REMOVE, PeekMessageW, PostThreadMessageW, QS_ALLINPUT,
                SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, WH_KEYBOARD_LL,
                WM_KEYDOWN, WM_KEYUP, WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP,
            },
        },
    };

    const LATCH_NONE: u32 = 0;
    const LATCH_POLICY: u32 = 1;
    const LATCH_DEBUG: u32 = 2;
    const WM_RELEASE_PENDING_TOKEN: u32 = 0x8001;
    pub(super) static TARGET_HWND: AtomicIsize = AtomicIsize::new(0);
    pub(super) static TARGET_WEBVIEW_HWND: AtomicIsize = AtomicIsize::new(0);
    pub(super) static TARGET_PID: AtomicU32 = AtomicU32::new(0);
    pub(super) static HOOK_ACTIVE: AtomicBool = AtomicBool::new(false);
    pub(super) static HOOK_THREAD_ID: AtomicU32 = AtomicU32::new(0);
    #[cfg(debug_assertions)]
    pub(super) static HOOK_STARTED_TICK: AtomicU64 = AtomicU64::new(0);
    #[cfg(debug_assertions)]
    pub(super) static HOOK_LOOP_HEARTBEAT_TICK: AtomicU64 = AtomicU64::new(0);
    #[cfg(debug_assertions)]
    pub(super) static HOOK_CALLBACK_COUNT: AtomicU64 = AtomicU64::new(0);
    static CURRENT_MARKER_TOKEN: AtomicU64 = AtomicU64::new(0);
    static CAPS_PHYSICAL_DOWN_TIME: AtomicU32 = AtomicU32::new(0);
    static FRAME_INSTANCE_SIGNATURE: AtomicU64 = AtomicU64::new(0);
    static DEBUG_INSTANCE_SIGNATURE: AtomicU64 = AtomicU64::new(0);
    static CAPS_LATCHED_TOKEN: AtomicU64 = AtomicU64::new(0);
    static CAPS_LATCHED_KIND: AtomicU32 = AtomicU32::new(LATCH_NONE);
    static FRAME_FAILURE_COUNT: AtomicU64 = AtomicU64::new(0);
    static FRAME_FAILURE_REPORTED: AtomicBool = AtomicBool::new(false);
    #[cfg(debug_assertions)]
    static DEBUG_ARMED: AtomicBool = AtomicBool::new(false);
    static CAPS_SUPPRESSED_DOWN: AtomicBool = AtomicBool::new(false);
    static CAPS_LOGICAL_DOWN: AtomicBool = AtomicBool::new(false);
    static TOKEN_UP_PENDING: AtomicBool = AtomicBool::new(false);

    pub(super) fn activate_marker_token(token: u64) -> bool {
        FRAME_FAILURE_COUNT.store(0, Ordering::Release);
        FRAME_FAILURE_REPORTED.store(false, Ordering::Release);
        CURRENT_MARKER_TOKEN.store(token, Ordering::Release);
        true
    }

    pub(super) fn clear_marker_token() {
        CURRENT_MARKER_TOKEN.store(0, Ordering::Release);
    }

    #[cfg(debug_assertions)]
    pub(super) fn set_debug_armed(enabled: bool) {
        DEBUG_ARMED.store(enabled, Ordering::Release);
    }

    pub(super) fn cancel_logical_hold() {
        if CAPS_LOGICAL_DOWN.swap(false, Ordering::AcqRel) {
            TOKEN_UP_PENDING.store(true, Ordering::Release);
        }
        post_pending_token_up();
    }

    pub(super) fn start(
        hwnd: HWND,
        pid: u32,
        app: AppHandle,
    ) -> Result<std::thread::JoinHandle<()>, String> {
        let frame_signature = random_marker_value();
        let mut debug_signature = random_marker_value();
        while debug_signature == frame_signature {
            debug_signature = random_marker_value();
        }
        FRAME_INSTANCE_SIGNATURE.store(frame_signature, Ordering::Release);
        DEBUG_INSTANCE_SIGNATURE.store(debug_signature, Ordering::Release);
        TARGET_HWND.store(hwnd as isize, Ordering::Release);
        TARGET_PID.store(pid, Ordering::Release);
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let thread = thread::Builder::new()
            .name("scanline-caps-hook".into())
            .spawn(move || hook_thread(ready_tx, app))
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

    fn hook_thread(ready: mpsc::SyncSender<Result<(), String>>, app: AppHandle) {
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
            #[cfg(debug_assertions)]
            HOOK_STARTED_TICK.store(tick_ms(), Ordering::Release);
            #[cfg(debug_assertions)]
            HOOK_LOOP_HEARTBEAT_TICK.store(tick_ms(), Ordering::Release);
            let _ = ready.send(Ok(()));
            loop {
                let result = MsgWaitForMultipleObjects(0, null(), 0, 100, QS_ALLINPUT);
                #[cfg(debug_assertions)]
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
                post_pending_token_up();
                report_pending_frame_failure(&app);
                if quit {
                    break;
                }
            }
            // Never send a owed key-up to whichever app happens to own focus during exit.
            release_pending_token_up();
            HOOK_ACTIVE.store(false, Ordering::Release);
            UnhookWindowsHookEx(hook);
            HOOK_THREAD_ID.store(0, Ordering::Release);
        }
    }

    fn report_pending_frame_failure(app: &AppHandle) {
        if FRAME_FAILURE_COUNT.load(Ordering::Acquire) == 0
            || FRAME_FAILURE_REPORTED.load(Ordering::Acquire)
        {
            return;
        }
        let Some(automation) = app.try_state::<crate::lua_automation::LuaAutomation>() else {
            return;
        };
        if FRAME_FAILURE_REPORTED
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            automation.report_native_error(
                "Could not send a Smart Caps frame; the policy was disarmed. Reload Lua automation to retry.",
            );
        }
    }

    unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        #[cfg(debug_assertions)]
        HOOK_CALLBACK_COUNT.fetch_add(1, Ordering::Relaxed);
        if code != HC_ACTION as i32 {
            return unsafe { CallNextHookEx(null_mut(), code, wparam, lparam) };
        }
        let key = unsafe { &*(lparam as *const KBDLLHOOKSTRUCT) };
        let message = wparam as u32;
        let down = matches!(message, WM_KEYDOWN | WM_SYSKEYDOWN);
        let up = matches!(message, WM_KEYUP | WM_SYSKEYUP);
        let event_time = key.time;
        let injected = key.flags & LLKHF_INJECTED != 0;
        let vk = key.vkCode;
        let extra_token = key.dwExtraInfo as u64;
        let frame_signature = FRAME_INSTANCE_SIGNATURE.load(Ordering::Acquire);
        let debug_signature = DEBUG_INSTANCE_SIGNATURE.load(Ordering::Acquire);
        let own_frame = vk == VK_NONAME as u32
            && injected
            && extra_token == frame_signature
            && marker_signature_matches(extra_token, frame_signature, debug_signature);
        let own_debug_marker = vk == VK_NONAME as u32
            && injected
            && extra_token == debug_signature
            && marker_signature_matches(extra_token, frame_signature, debug_signature);
        if !own_frame && !own_debug_marker && vk != VK_CAPITAL as u32 {
            return unsafe { CallNextHookEx(null_mut(), code, wparam, lparam) };
        }
        let target_foreground = target_is_foreground();
        if own_frame || own_debug_marker {
            #[cfg(debug_assertions)]
            if DEBUG_ARMED.load(Ordering::Acquire) {
                super::trace_hook_event(vk, down, injected, true, 0);
            }
            return if target_foreground {
                unsafe { CallNextHookEx(null_mut(), code, wparam, lparam) }
            } else {
                1
            };
        }
        if vk == VK_CAPITAL as u32 && down && CAPS_SUPPRESSED_DOWN.load(Ordering::Acquire) {
            return 1;
        }
        if vk == VK_CAPITAL as u32 && down && target_foreground {
            // This one atomic snapshot selects both the frame token and the latch. A
            // concurrent revoke/re-arm cannot mix the old authorization with a new token.
            #[cfg(debug_assertions)]
            let debug_armed = DEBUG_ARMED.load(Ordering::Acquire);
            #[cfg(not(debug_assertions))]
            let debug_armed = false;
            let mode = select_caps_mode(CURRENT_MARKER_TOKEN.load(Ordering::Acquire), debug_armed);
            if mode == CapsMode::PassThrough {
                return unsafe { CallNextHookEx(null_mut(), code, wparam, lparam) };
            }
            #[cfg(debug_assertions)]
            let trace_slot = if DEBUG_ARMED.load(Ordering::Acquire) {
                Some(super::trace_hook_event(vk, down, injected, false, 0))
            } else {
                None
            };
            if !super::latch_physical_caps_down(
                &CAPS_SUPPRESSED_DOWN,
                &CAPS_PHYSICAL_DOWN_TIME,
                event_time,
            ) {
                return 1;
            }
            let (latch_kind, policy_token) = match mode {
                CapsMode::Policy(token) => {
                    CAPS_LATCHED_TOKEN.store(token, Ordering::Release);
                    (LATCH_POLICY, token)
                }
                CapsMode::Debug => {
                    CAPS_LATCHED_TOKEN.store(debug_signature, Ordering::Release);
                    CAPS_LOGICAL_DOWN.store(true, Ordering::Release);
                    (LATCH_DEBUG, 0)
                }
                CapsMode::PassThrough => unreachable!("pass-through handled above"),
            };
            CAPS_LATCHED_KIND.store(latch_kind, Ordering::Release);
            let result = if latch_kind == LATCH_POLICY {
                send_caps_frame(policy_token, CapsFrameKind::Down)
            } else {
                send_debug_marker(true)
            };
            #[cfg(debug_assertions)]
            if let Some(slot) = trace_slot {
                super::trace_hook_result(
                    slot,
                    if result == FRAME_INPUT_COUNT as u32 {
                        1
                    } else {
                        2
                    },
                );
            }
            if result == FRAME_INPUT_COUNT as u32 || (latch_kind == LATCH_DEBUG && result == 1) {
                if latch_kind == LATCH_DEBUG {
                    TOKEN_UP_PENDING.store(true, Ordering::Release);
                }
                return 1;
            }
            if latch_kind == LATCH_POLICY {
                disarm_after_frame_failure();
                send_frame_cleanup(policy_token);
                return 1;
            }
            CAPS_SUPPRESSED_DOWN.store(false, Ordering::Release);
            CAPS_LOGICAL_DOWN.store(false, Ordering::Release);
            CAPS_LATCHED_TOKEN.store(0, Ordering::Release);
            CAPS_LATCHED_KIND.store(LATCH_NONE, Ordering::Release);
        }
        if vk == VK_CAPITAL as u32 && up && CAPS_SUPPRESSED_DOWN.swap(false, Ordering::AcqRel) {
            #[cfg(debug_assertions)]
            if DEBUG_ARMED.load(Ordering::Acquire) {
                super::trace_hook_event(vk, false, injected, false, 0);
            }
            let latch_kind = CAPS_LATCHED_KIND.load(Ordering::Acquire);
            let token = CAPS_LATCHED_TOKEN.load(Ordering::Acquire);
            if latch_kind == LATCH_POLICY {
                if target_foreground && token != 0 {
                    let down_time = CAPS_PHYSICAL_DOWN_TIME.load(Ordering::Acquire);
                    let kind = classify_caps_up(down_time, event_time);
                    let result = send_caps_frame(token, kind);
                    if result != FRAME_INPUT_COUNT as u32 {
                        disarm_after_frame_failure();
                        send_frame_cleanup(token);
                    }
                }
            } else if latch_kind == LATCH_DEBUG {
                CAPS_LOGICAL_DOWN.store(false, Ordering::Release);
                if target_foreground {
                    if send_debug_marker(false) == 1 {
                        TOKEN_UP_PENDING.store(false, Ordering::Release);
                    }
                } else {
                    TOKEN_UP_PENDING.store(true, Ordering::Release);
                }
                release_pending_token_up();
            }
            CAPS_LATCHED_TOKEN.store(0, Ordering::Release);
            CAPS_LATCHED_KIND.store(LATCH_NONE, Ordering::Release);
            return 1;
        }
        unsafe { CallNextHookEx(null_mut(), code, wparam, lparam) }
    }

    fn disarm_after_frame_failure() {
        FRAME_FAILURE_COUNT.fetch_add(1, Ordering::Relaxed);
        CURRENT_MARKER_TOKEN.store(0, Ordering::Release);
        POLICY_ARMED.store(false, Ordering::Release);
    }

    fn release_pending_token_up() {
        if !super::token_up_ready(
            TOKEN_UP_PENDING.load(Ordering::Acquire),
            CAPS_LOGICAL_DOWN.load(Ordering::Acquire),
            CAPS_SUPPRESSED_DOWN.load(Ordering::Acquire),
            target_is_foreground(),
        ) {
            return;
        }
        if target_is_foreground() && send_debug_marker(false) == 1 {
            TOKEN_UP_PENDING.store(false, Ordering::Release);
        }
    }

    fn post_pending_token_up() {
        if super::token_up_ready(
            TOKEN_UP_PENDING.load(Ordering::Acquire),
            CAPS_LOGICAL_DOWN.load(Ordering::Acquire),
            CAPS_SUPPRESSED_DOWN.load(Ordering::Acquire),
            target_is_foreground(),
        ) {
            let id = HOOK_THREAD_ID.load(Ordering::Acquire);
            if id != 0 {
                unsafe {
                    PostThreadMessageW(id, WM_RELEASE_PENDING_TOKEN, 0, 0);
                }
            }
        }
    }

    #[cfg(debug_assertions)]
    fn tick_ms() -> u64 {
        unsafe { windows_sys::Win32::System::SystemInformation::GetTickCount64() }
    }

    fn send_caps_frame(token: u64, kind: CapsFrameKind) -> u32 {
        let specs = build_caps_frame(token, kind);
        let mut inputs: [INPUT; FRAME_INPUT_COUNT] =
            std::array::from_fn(|index| frame_input(specs[index]));
        unsafe {
            SendInput(
                FRAME_INPUT_COUNT as u32,
                inputs.as_mut_ptr(),
                size_of::<INPUT>() as i32,
            )
        }
    }

    fn frame_input(spec: FrameInputSpec) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: spec.vk_code,
                    wScan: spec.scan_code,
                    dwFlags: if spec.keyup { KEYEVENTF_KEYUP } else { 0 },
                    time: 0,
                    dwExtraInfo: FRAME_INSTANCE_SIGNATURE.load(Ordering::Relaxed) as usize,
                },
            },
        }
    }

    fn send_frame_cleanup(token: u64) {
        if !target_is_foreground() {
            return;
        }
        let mut input = frame_input(FrameInputSpec {
            vk_code: VK_NONAME_CODE,
            // A non-protocol scan makes the frontend discard an incomplete frame.
            // Never complete a short SendInput prefix as a valid Caps edge.
            scan_code: 0,
            keyup: true,
            marker_token: token,
        });
        let _ = unsafe { SendInput(1, &mut input, size_of::<INPUT>() as i32) };
    }

    fn send_debug_marker(down: bool) -> u32 {
        let mut input = frame_input(FrameInputSpec {
            vk_code: VK_NONAME_CODE,
            scan_code: 0,
            keyup: !down,
            marker_token: DEBUG_INSTANCE_SIGNATURE.load(Ordering::Relaxed),
        });
        unsafe { SendInput(1, &mut input, size_of::<INPUT>() as i32) }
    }

    #[cfg(debug_assertions)]
    pub(super) fn frame_failure_count() -> u64 {
        FRAME_FAILURE_COUNT.load(Ordering::Acquire)
    }

    pub(super) fn target_is_foreground() -> bool {
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
}

#[cfg(windows)]
use windows_hook::start as start_hook;

#[cfg(windows)]
fn start_windows_hook(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    mut hook: CapsHook,
) -> CapsHook {
    let hwnd = window
        .hwnd()
        .map(|hwnd| hwnd.0 as windows_sys::Win32::Foundation::HWND)
        .unwrap_or(std::ptr::null_mut());
    let mut pid = 0;
    if !hwnd.is_null() {
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(hwnd, &mut pid);
        }
    }
    match start_hook(hwnd, pid, app.clone()) {
        Ok(thread) => {
            if let Ok(mut slot) = hook.thread.lock() {
                *slot = Some(thread);
            }
        }
        Err(error) => hook.startup_error = Some(error),
    }
    if let Some(webview) = app.get_webview("main") {
        let app = app.clone();
        let root = hwnd as isize;
        let _ = webview.with_webview(move |platform| {
            let mut host = std::mem::MaybeUninit::uninit();
            let result = unsafe { platform.controller().ParentWindow(host.as_mut_ptr()) };
            if let Ok(()) = result {
                let target =
                    unsafe { host.assume_init().0 as windows_sys::Win32::Foundation::HWND };
                if !target.is_null()
                    && root != 0
                    && unsafe {
                        windows_sys::Win32::UI::WindowsAndMessaging::IsChild(root as _, target)
                    } != 0
                {
                    set_webview_hwnd(target);
                }
            }
            let _ = app.emit("caps-hook-webview-resolved", ());
        });
    }
    hook
}

#[cfg(all(windows, debug_assertions))]
pub(crate) fn set_debug_armed(enabled: bool) {
    windows_hook::set_debug_armed(enabled);
    if !enabled {
        windows_hook::cancel_logical_hold();
    }
}

#[cfg(not(windows))]
fn cancel_logical_hold() {}

#[cfg(all(windows, debug_assertions))]
pub(crate) fn hook_is_active() -> bool {
    windows_hook::HOOK_ACTIVE.load(std::sync::atomic::Ordering::Acquire)
}

#[cfg(all(windows, debug_assertions))]
pub(crate) fn hook_callback_count() -> u64 {
    windows_hook::HOOK_CALLBACK_COUNT.load(std::sync::atomic::Ordering::Acquire)
}

#[cfg(all(windows, debug_assertions))]
pub(crate) fn hook_started_tick() -> u64 {
    windows_hook::HOOK_STARTED_TICK.load(std::sync::atomic::Ordering::Acquire)
}

#[cfg(all(windows, debug_assertions))]
pub(crate) fn hook_heartbeat_tick() -> u64 {
    windows_hook::HOOK_LOOP_HEARTBEAT_TICK.load(std::sync::atomic::Ordering::Acquire)
}

#[cfg(all(windows, debug_assertions))]
pub(crate) fn frame_failure_count() -> u64 {
    windows_hook::frame_failure_count()
}

#[cfg(windows)]
fn cancel_logical_hold() {
    windows_hook::cancel_logical_hold();
}

#[cfg(all(windows, debug_assertions))]
pub(crate) fn tick_ms() -> u64 {
    unsafe { windows_sys::Win32::System::SystemInformation::GetTickCount64() }
}

pub(crate) fn token_up_ready(
    pending: bool,
    logical_down: bool,
    physical_down: bool,
    target_foreground: bool,
) -> bool {
    pending && target_foreground && (!logical_down || !physical_down)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

    use super::{
        CapsFrameKind, CapsMode, Context, Control, FRAME_INPUT_COUNT, FRAME_START_DOWN_SCAN,
        FRAME_START_UP_HELD_SCAN, FRAME_START_UP_TAP_SCAN, FRAME_TERMINATOR_SCAN, PolicyLease,
        VK_NONAME_CODE, build_caps_frame, classify_caps_up, disabled_lease,
        latch_physical_caps_down, marker_signature_matches, random_marker_token, select_caps_mode,
        startup_hook_error_to_report, token_up_ready,
    };

    #[test]
    fn frame_builder_uses_the_complete_noname_token_protocol() {
        let token = 0x0123_4567_89ab_cdef;
        let expected_payload = [
            0x0b, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x1e, 0x30, 0x2e, 0x20,
            0x12, 0x21,
        ];
        for (kind, header) in [
            (CapsFrameKind::Down, FRAME_START_DOWN_SCAN),
            (CapsFrameKind::UpTap, FRAME_START_UP_TAP_SCAN),
            (CapsFrameKind::UpHeld, FRAME_START_UP_HELD_SCAN),
        ] {
            let frame = build_caps_frame(token, kind);
            assert_eq!(frame.len(), FRAME_INPUT_COUNT);
            assert!(frame.iter().all(|event| event.vk_code == VK_NONAME_CODE));
            assert!(frame.iter().all(|event| event.marker_token == token));
            assert_eq!(frame[0].scan_code, header);
            assert!(!frame[0].keyup);
            assert_eq!(
                frame[1..17]
                    .iter()
                    .map(|event| event.scan_code)
                    .collect::<Vec<_>>(),
                expected_payload
            );
            assert!(frame[1..17].iter().all(|event| !event.keyup));
            assert_eq!(frame[17].scan_code, FRAME_TERMINATOR_SCAN);
            assert!(frame[17].keyup);
            assert_eq!(frame.iter().filter(|event| event.keyup).count(), 1);
        }
    }

    #[test]
    fn native_caps_duration_classifies_tap_and_hold_at_exact_threshold() {
        assert_eq!(classify_caps_up(100, 279), CapsFrameKind::UpTap);
        assert_eq!(classify_caps_up(100, 280), CapsFrameKind::UpHeld);
        assert_eq!(classify_caps_up(100, 281), CapsFrameKind::UpHeld);
    }

    #[test]
    fn native_caps_duration_uses_wrapping_hook_timestamps() {
        let down = u32::MAX - 100;
        assert_eq!(
            classify_caps_up(down, down.wrapping_add(179)),
            CapsFrameKind::UpTap
        );
        assert_eq!(
            classify_caps_up(down, down.wrapping_add(180)),
            CapsFrameKind::UpHeld
        );
    }

    #[test]
    fn repeated_caps_down_keeps_the_first_physical_timestamp() {
        let suppressed_down = AtomicBool::new(false);
        let down_time = AtomicU32::new(0);
        assert!(latch_physical_caps_down(&suppressed_down, &down_time, 1234));
        assert!(!latch_physical_caps_down(
            &suppressed_down,
            &down_time,
            1450
        ));
        assert_eq!(down_time.load(Ordering::Acquire), 1234);
    }

    #[test]
    fn pending_token_up_waits_for_owned_focus_and_released_latches() {
        assert!(!token_up_ready(true, false, false, false));
        assert!(!token_up_ready(true, true, true, true));
        assert!(token_up_ready(true, false, false, true));
        assert!(token_up_ready(true, true, false, true));
        assert!(!token_up_ready(false, false, false, true));
    }

    #[test]
    fn marker_signatures_are_scoped_to_one_hook_instance() {
        let first_frame = 0x1020_3040_5060_7080;
        let first_debug = 0x8877_6655_4433_2211;
        let second_frame = 0x0102_0304_0506_0708;
        let second_debug = 0x1122_3344_5566_7788;
        assert!(marker_signature_matches(
            first_frame,
            first_frame,
            first_debug
        ));
        assert!(marker_signature_matches(
            first_debug,
            first_frame,
            first_debug
        ));
        assert!(!marker_signature_matches(
            second_frame,
            first_frame,
            first_debug
        ));
        assert!(!marker_signature_matches(
            second_debug,
            first_frame,
            first_debug
        ));
        assert!(!marker_signature_matches(0, first_frame, first_debug));
    }

    #[test]
    fn opted_in_hook_startup_failure_is_reported_once() {
        let reported = std::sync::atomic::AtomicBool::new(false);
        let first = startup_hook_error_to_report("SetWindowsHookEx failed", &reported);
        assert_eq!(
            first.as_deref(),
            Some(
                "Caps Lua policy is enabled, but the native keyboard hook failed to start: SetWindowsHookEx failed"
            )
        );
        assert_eq!(
            startup_hook_error_to_report("SetWindowsHookEx failed", &reported),
            None
        );
    }

    #[test]
    fn marker_tokens_are_fixed_width_and_nonzero() {
        let first = random_marker_token();
        let second = random_marker_token();
        assert_eq!(first.len(), 16);
        assert!(
            first
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        );
        assert_ne!(first, "0000000000000000");
        assert_ne!(first, second);
    }

    #[test]
    fn disabled_lease_advances_identity_and_preserves_origin_token() {
        let mut control = Control {
            next_epoch: 7,
            ..Control::default()
        };
        let previous = PolicyLease {
            frontend_id: "frontend".into(),
            generation: 12,
            policy_epoch: 7,
            marker_token: "0123456789abcdef".into(),
            tab_id: Some("tab".into()),
            process_name: Some("nvim.exe".into()),
            enabled: true,
        };
        let disabled = disabled_lease(&mut control, previous);
        assert_eq!(disabled.policy_epoch, 8);
        assert_eq!(disabled.marker_token, "0123456789abcdef");
        assert!(!disabled.enabled);
    }

    #[test]
    fn lease_ack_uses_the_existing_camel_case_wire_shape() {
        let ack = PolicyLease {
            frontend_id: "frontend".into(),
            generation: 12,
            policy_epoch: 7,
            marker_token: "0123456789abcdef".into(),
            tab_id: Some("tab".into()),
            process_name: Some("nvim.exe".into()),
            enabled: true,
        };
        let expected = serde_json::json!({
            "frontendId": "frontend",
            "generation": 12,
            "policyEpoch": 7,
            "markerToken": "0123456789abcdef",
            "tabId": "tab",
            "processName": "nvim.exe",
            "enabled": true,
        });

        let decoded: PolicyLease = serde_json::from_value(expected.clone()).unwrap();
        assert_eq!(decoded, ack);
        assert_eq!(serde_json::to_value(decoded).unwrap(), expected);
    }

    #[test]
    fn context_identity_ignores_snapshot_generation_but_tracks_tab_and_process() {
        let context = Context {
            frontend_id: "frontend".into(),
            latest_generation: 15,
            semantic_generation: 12,
            tab_id: Some("tab".into()),
            process_name: Some("nvim.exe".into()),
            focused: true,
        };
        assert!(context.identity_matches(
            "frontend",
            &Some("tab".into()),
            &Some("nvim.exe".into())
        ));
        assert!(!context.identity_matches(
            "frontend",
            &Some("other-tab".into()),
            &Some("nvim.exe".into())
        ));
        assert!(!context.identity_matches(
            "frontend",
            &Some("tab".into()),
            &Some("other.exe".into())
        ));
    }

    #[test]
    fn caps_mode_keeps_the_single_token_snapshot_and_prefers_production_policy() {
        assert_eq!(select_caps_mode(0x1234, true), CapsMode::Policy(0x1234));
        assert_eq!(select_caps_mode(0, true), CapsMode::Debug);
        assert_eq!(select_caps_mode(0, false), CapsMode::PassThrough);
    }
}
