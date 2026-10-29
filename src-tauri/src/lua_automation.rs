//! Native controller for the optional Lua event runtime.

use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    ops::Range,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicIsize, AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State, WebviewWindow};

use crate::{
    TerminalState,
    lua_runtime::{
        Action, AnsiPalette, CursorShape, CursorStyle, Diagnostic, DispatchResult, InputState,
        LuaRuntime, MAX_CONFIG_BYTES, ManagedSettings, RuntimeEvent, RuntimeSnapshot,
        ScenarioStateStore, TabState,
    },
};

const MAX_TABS: usize = 64;
const MAX_TITLE_CHARS: usize = 4096;
const MAX_PROCESS_CHARS: usize = 260;
const MAX_DIAGNOSTICS: usize = 32;
const MAX_DIAGNOSTIC_CHARS: usize = 1000;
const ACTION_TIMEOUT: Duration = Duration::from_secs(2);
const LAYOUT_POLL: Duration = Duration::from_millis(20);
const QUEUE_CAPACITY: usize = 16;
const MAX_RELOAD_CLEANUP_IDS: usize = 64;

static NEXT_FRONTEND_TOKEN: AtomicU64 = AtomicU64::new(1);
static NEXT_RELOAD_TOKEN: AtomicU64 = AtomicU64::new(1);
static NEXT_MANAGED_TEMP: AtomicU64 = AtomicU64::new(1);
static MANAGED_SETTINGS_SAVE_LOCK: Mutex<()> = Mutex::new(());

const MANAGED_BEGIN: &[u8] = b"-- scanline-term:managed-settings:begin";
const MANAGED_END: &[u8] = b"-- scanline-term:managed-settings:end";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FrontendSnapshot {
    frontend_id: String,
    generation: u64,
    active_tab_id: Option<String>,
    focused: bool,
    tabs: Vec<FrontendTab>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrontendTab {
    id: String,
    title: String,
    #[serde(alias = "localProcessName")]
    process_name: Option<String>,
    preset_name: String,
    cursor: FrontendCursor,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrontendCursor {
    shape: Option<String>,
    blink: Option<bool>,
    #[serde(default = "cursor_visible_default")]
    visible: bool,
}

fn cursor_visible_default() -> bool {
    true
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomationStatus {
    state: &'static str,
    config_path: Option<String>,
    error: Option<String>,
    diagnostics: Vec<AutomationDiagnostic>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AutomationDiagnostic {
    level: &'static str,
    message: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct CapsPolicyContext {
    tab_id: Option<String>,
    process_name: Option<String>,
    enabled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct CachedCapsPolicy {
    context: CapsPolicyContext,
    generation: u64,
}

impl AutomationDiagnostic {
    fn error(message: impl Into<String>) -> Self {
        Self {
            level: "error",
            message: message.into(),
        }
    }

    fn info(message: impl Into<String>) -> Self {
        Self {
            level: "info",
            message: message.into(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartResult {
    frontend_id: String,
    #[serde(flatten)]
    status: AutomationStatus,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReloadCleanupRequest {
    id: String,
    tab_id: String,
    name: String,
    expected_current_preset: String,
    #[serde(skip_serializing)]
    attachment_key: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReloadPreparation {
    token: String,
    frontend_id: String,
    generation: u64,
    cleanup: Vec<ReloadCleanupRequest>,
    palettes: Option<Vec<AnsiPalette>>,
    candidate_status: &'static str,
    error: Option<String>,
}

struct Shared {
    frontend_id: Option<String>,
    generation: u64,
    action_epoch: u64,
    active_tab_id: Option<String>,
    focused: bool,
    tabs: Vec<TabState>,
    status: AutomationStatus,
}

enum Work {
    Start {
        frontend_id: String,
        epoch: u64,
    },
    Update {
        frontend_id: String,
        generation: u64,
        epoch: u64,
        tabs: Vec<TabState>,
        window_focused: bool,
        active_tab_id: Option<String>,
    },
    // Startup bootstrap only; user reloads use the prepare/commit transition.
    Reload {
        epoch: u64,
    },
    PrepareReload {
        token: String,
        frontend_id: String,
        generation: u64,
        epoch: u64,
        reply: mpsc::Sender<Result<ReloadPreparation, String>>,
    },
    CommitReload {
        token: String,
        frontend_id: String,
        handled_cleanup_ids: Vec<String>,
        reply: mpsc::Sender<Result<AutomationStatus, String>>,
    },
    AbortReload {
        token: String,
        frontend_id: String,
        reply: mpsc::Sender<Result<AutomationStatus, String>>,
    },
    FailClosed {
        frontend_id: String,
        epoch: u64,
        error: String,
    },
    Shutdown,
}

struct PendingLayout {
    frontend_id: String,
    generation: u64,
    action_epoch: u64,
    tab_id: String,
    requested: String,
    script: String,
    event: String,
    deadline: Instant,
}

struct PendingReload {
    plan: ReloadPreparation,
    epoch: u64,
    candidate: Option<RuntimeSnapshot>,
    config_path: Option<String>,
    diagnostics: Vec<AutomationDiagnostic>,
}

pub struct LuaAutomation {
    app: Option<tauri::AppHandle>,
    shared: Arc<Mutex<Shared>>,
    sender: SyncSender<Work>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Clone)]
struct ReloadClient {
    shared: Arc<Mutex<Shared>>,
    sender: SyncSender<Work>,
}

impl LuaAutomation {
    pub fn unavailable(error: String) -> Self {
        let shared = Arc::new(Mutex::new(Shared {
            frontend_id: None,
            generation: 0,
            action_epoch: 0,
            active_tab_id: None,
            focused: false,
            tabs: Vec::new(),
            status: AutomationStatus {
                state: "error",
                config_path: None,
                error: Some(error.clone()),
                diagnostics: vec![AutomationDiagnostic::error(error)],
            },
        }));
        let (sender, receiver) = mpsc::sync_channel(QUEUE_CAPACITY);
        drop(receiver);
        Self {
            app: None,
            shared,
            sender,
            worker: Mutex::new(None),
        }
    }

    pub fn new(app: tauri::AppHandle, window: &WebviewWindow) -> Result<Self, String> {
        if window.label() != "main" {
            return Err("Lua automation must be attached to the main window".into());
        }
        let layouts = NativeLayouts::new(window)?;
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(Path::to_path_buf));
        let app_config_dir = app.path().app_config_dir().ok();
        let shared = Arc::new(Mutex::new(Shared {
            frontend_id: None,
            generation: 0,
            action_epoch: 0,
            active_tab_id: None,
            focused: false,
            tabs: Vec::new(),
            status: AutomationStatus {
                state: "loading",
                config_path: None,
                error: None,
                diagnostics: Vec::new(),
            },
        }));
        let (sender, receiver) = mpsc::sync_channel(QUEUE_CAPACITY);
        let worker_shared = shared.clone();
        let worker_layouts = layouts.clone();
        let worker_app = app.clone();
        let worker_exe_dir = exe_dir.clone();
        let worker_config_dir = app_config_dir.clone();
        let worker_lua_examples_dir = if cfg!(debug_assertions) {
            Some(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join("examples")
                    .join("lua"),
            )
        } else {
            app.path()
                .resource_dir()
                .ok()
                .map(|directory| directory.join("lua-examples"))
        };
        let worker = thread::Builder::new()
            .name("scanline-lua-automation".into())
            .spawn(move || {
                worker_loop(
                    worker_app,
                    worker_shared,
                    receiver,
                    worker_layouts,
                    worker_exe_dir,
                    worker_config_dir,
                    worker_lua_examples_dir,
                )
            })
            .map_err(|error| format!("could not start Lua automation worker: {error}"))?;
        let automation = Self {
            app: Some(app),
            shared,
            sender,
            worker: Mutex::new(Some(worker)),
        };
        automation.enqueue(Work::Reload { epoch: 0 }, "Lua startup queue is full")?;
        Ok(automation)
    }

    fn enqueue(&self, work: Work, full_message: &str) -> Result<(), String> {
        match self.sender.try_send(work) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => {
                self.record_error(full_message.to_owned());
                Err(full_message.to_owned())
            }
            Err(TrySendError::Disconnected(_)) => {
                self.record_error("Lua automation worker stopped".into());
                Err("Lua automation worker stopped".into())
            }
        }
    }

    pub(crate) fn report_native_error(&self, error: impl Into<String>) {
        let error = error.into();
        if let Ok(mut shared) = self.shared.lock() {
            fail_closed(&mut shared, error);
        }
        if let Some(app) = &self.app {
            crate::caps_hook::revoke(app);
        }
    }

    fn record_error(&self, error: String) {
        self.report_native_error(error);
    }

    fn reject_snapshot(&self, snapshot: &FrontendSnapshot, error: &str) {
        if let Ok(mut shared) = self.shared.lock() {
            if fail_closed_if_newer(
                &mut shared,
                &snapshot.frontend_id,
                snapshot.generation,
                error,
            ) {
                if let Some(app) = &self.app {
                    crate::caps_hook::revoke(app);
                }
            }
        }
    }

    pub fn shutdown(&self) {
        if let Ok(mut worker) = self.worker.lock() {
            if let Some(worker) = worker.take() {
                let _ = self.sender.send(Work::Shutdown);
                let _ = worker.join();
            }
        }
    }

    fn status(&self) -> AutomationStatus {
        self.shared
            .lock()
            .map(|shared| shared.status.clone())
            .unwrap_or_else(|_| AutomationStatus {
                state: "error",
                config_path: None,
                error: Some("Lua automation state is unavailable".into()),
                diagnostics: Vec::new(),
            })
    }

    fn start(&self) -> Result<StartResult, String> {
        let token = format!(
            "{}-{}",
            std::process::id(),
            NEXT_FRONTEND_TOKEN.fetch_add(1, Ordering::Relaxed)
        );
        let epoch = {
            let mut shared = self
                .shared
                .lock()
                .map_err(|_| "Lua automation state is unavailable")?;
            shared.frontend_id = Some(token.clone());
            shared.generation = 0;
            shared.active_tab_id = None;
            shared.focused = false;
            shared.tabs.clear();
            shared.action_epoch
        };
        self.enqueue(
            Work::Start {
                frontend_id: token.clone(),
                epoch,
            },
            "Lua automation start queue is full",
        )?;
        Ok(StartResult {
            frontend_id: token,
            status: self.status(),
        })
    }

    fn update(
        &self,
        app: &tauri::AppHandle,
        mut snapshot: FrontendSnapshot,
        terminals: &TerminalState,
    ) -> Result<(), String> {
        {
            let shared = self
                .shared
                .lock()
                .map_err(|_| "Lua automation state is unavailable")?;
            if shared.frontend_id.as_deref() != Some(snapshot.frontend_id.as_str()) {
                return Err("Lua automation frontend instance is stale".into());
            }
            if !snapshot_is_fresh(&shared, &snapshot.frontend_id, snapshot.generation) {
                return Err("Lua automation snapshot generation is stale".into());
            }
        }
        if let Err(error) = validate_snapshot(&snapshot) {
            self.reject_snapshot(&snapshot, &error);
            return Err(error);
        }
        let sessions = terminals
            .0
            .lock()
            .map_err(|_| "terminal state is unavailable")?;
        let live_ids = sessions
            .keys()
            .cloned()
            .collect::<std::collections::HashSet<_>>();
        drop(sessions);
        normalize_snapshot_to_live_sessions(&mut snapshot, &live_ids);

        let window_focused = snapshot.focused;
        let active_tab_id = snapshot.active_tab_id.clone();
        let (frontend_id, generation, epoch, tabs) = {
            let mut shared = self
                .shared
                .lock()
                .map_err(|_| "Lua automation state is unavailable")?;
            if shared.frontend_id.as_deref() != Some(snapshot.frontend_id.as_str()) {
                return Err("Lua automation frontend instance is stale".into());
            }
            if !snapshot_is_fresh(&shared, &snapshot.frontend_id, snapshot.generation) {
                return Err("Lua automation snapshot generation is stale".into());
            }
            let active = snapshot.active_tab_id.as_deref();
            let has_active = active.is_some_and(|id| snapshot.tabs.iter().any(|tab| tab.id == id));
            let focused = snapshot.focused && has_active;
            let tabs = snapshot
                .tabs
                .into_iter()
                .map(|tab| {
                    let id = tab.id;
                    TabState {
                        id: id.clone(),
                        title: tab.title,
                        local_process_name: tab.process_name,
                        preset_name: tab.preset_name,
                        cursor_style: CursorStyle {
                            shape: cursor_shape(tab.cursor.shape.as_deref()),
                            blink: tab.cursor.blink,
                            visible: tab.cursor.visible,
                        },
                        active: has_active && active == Some(id.as_str()),
                        focused: focused && has_active && active == Some(id.as_str()),
                    }
                })
                .collect::<Vec<_>>();
            let active_tab = tabs.iter().find(|tab| tab.active);
            crate::caps_hook::context_changed(
                app,
                &snapshot.frontend_id,
                snapshot.generation,
                active_tab.map(|tab| tab.id.as_str()),
                active_tab.and_then(|tab| tab.local_process_name.as_deref()),
                focused,
            );
            shared.generation = snapshot.generation;
            shared.active_tab_id = has_active.then(|| active.unwrap().to_owned());
            shared.focused = focused;
            shared.tabs = tabs.clone();
            (
                snapshot.frontend_id,
                snapshot.generation,
                shared.action_epoch,
                tabs,
            )
        };
        self.enqueue(
            Work::Update {
                frontend_id,
                generation,
                epoch,
                tabs,
                window_focused,
                active_tab_id,
            },
            "Lua automation update queue is full",
        )
    }

    fn reload_client(&self) -> ReloadClient {
        ReloadClient {
            shared: self.shared.clone(),
            sender: self.sender.clone(),
        }
    }
}

impl Drop for LuaAutomation {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl ReloadClient {
    fn fail_reload_request(&self, app: &tauri::AppHandle, frontend_id: &str, error: String) {
        crate::caps_hook::revoke(app);
        let epoch = if let Ok(mut shared) = self.shared.lock() {
            if shared.frontend_id.as_deref() != Some(frontend_id) {
                return;
            }
            fail_closed(&mut shared, error.clone());
            shared.action_epoch
        } else {
            return;
        };
        let _ = self.sender.try_send(Work::FailClosed {
            frontend_id: frontend_id.to_owned(),
            epoch,
            error,
        });
    }

    fn prepare_reload(
        &self,
        app: &tauri::AppHandle,
        frontend_id: String,
    ) -> Result<ReloadPreparation, String> {
        if frontend_id.is_empty() || frontend_id.len() > 128 {
            return Err("Lua automation frontend ID is invalid".into());
        }
        crate::caps_hook::revoke(app);
        let (generation, epoch) = {
            let mut shared = self
                .shared
                .lock()
                .map_err(|_| "Lua automation state is unavailable")?;
            if shared.frontend_id.as_deref() != Some(frontend_id.as_str()) {
                return Err("Lua automation frontend instance is stale".into());
            }
            shared.action_epoch = shared.action_epoch.wrapping_add(1);
            shared.status.state = "loading";
            shared.status.error = None;
            (shared.generation, shared.action_epoch)
        };
        let token = format!(
            "{}-{}",
            std::process::id(),
            NEXT_RELOAD_TOKEN.fetch_add(1, Ordering::Relaxed)
        );
        let (reply, response) = mpsc::channel();
        let work = Work::PrepareReload {
            token,
            frontend_id: frontend_id.clone(),
            generation,
            epoch,
            reply,
        };
        if let Err(error) = self.sender.try_send(work) {
            let message = match error {
                TrySendError::Full(_) => "Lua automation reload queue is full".to_owned(),
                TrySendError::Disconnected(_) => "Lua automation worker stopped".to_owned(),
            };
            self.fail_reload_request(app, &frontend_id, message.clone());
            return Err(message);
        }
        match response.recv_timeout(Duration::from_secs(10)) {
            Ok(result) => result,
            Err(_) => {
                let error = "Lua automation worker did not prepare reload".to_owned();
                self.fail_reload_request(app, &frontend_id, error.clone());
                Err(error)
            }
        }
    }

    fn commit_reload(
        &self,
        app: &tauri::AppHandle,
        frontend_id: String,
        token: String,
        handled_cleanup_ids: Vec<String>,
    ) -> Result<AutomationStatus, String> {
        if token.is_empty()
            || token.len() > 128
            || frontend_id.is_empty()
            || frontend_id.len() > 128
            || handled_cleanup_ids.len() > MAX_RELOAD_CLEANUP_IDS
            || handled_cleanup_ids
                .iter()
                .any(|id| id.is_empty() || id.len() > 128)
        {
            return Err("Lua reload acknowledgement is invalid".into());
        }
        if self
            .shared
            .lock()
            .map_err(|_| "Lua automation state is unavailable")?
            .frontend_id
            .as_deref()
            != Some(frontend_id.as_str())
        {
            return Err("Lua automation frontend instance is stale".into());
        }
        let (reply, response) = mpsc::channel();
        let work = Work::CommitReload {
            token,
            frontend_id: frontend_id.clone(),
            handled_cleanup_ids,
            reply,
        };
        if let Err(error) = self.sender.try_send(work) {
            let message = match error {
                TrySendError::Full(_) => "Lua automation reload queue is full".to_owned(),
                TrySendError::Disconnected(_) => "Lua automation worker stopped".to_owned(),
            };
            self.fail_reload_request(app, &frontend_id, message.clone());
            return Err(message);
        }
        match response.recv_timeout(Duration::from_secs(10)) {
            Ok(result) => result,
            Err(_) => {
                let error = "Lua automation worker did not commit reload".to_owned();
                self.fail_reload_request(app, &frontend_id, error.clone());
                Err(error)
            }
        }
    }

    fn abort_reload(
        &self,
        app: &tauri::AppHandle,
        frontend_id: String,
        token: String,
    ) -> Result<AutomationStatus, String> {
        if frontend_id.is_empty()
            || frontend_id.len() > 128
            || token.is_empty()
            || token.len() > 128
        {
            return Err("Lua reload token or frontend ID is invalid".into());
        }
        if self
            .shared
            .lock()
            .map_err(|_| "Lua automation state is unavailable")?
            .frontend_id
            .as_deref()
            != Some(frontend_id.as_str())
        {
            return Err("Lua automation frontend instance is stale".into());
        }
        let (reply, response) = mpsc::channel();
        let work = Work::AbortReload {
            token,
            frontend_id: frontend_id.clone(),
            reply,
        };
        if let Err(error) = self.sender.try_send(work) {
            let message = match error {
                TrySendError::Full(_) => "Lua automation reload queue is full".to_owned(),
                TrySendError::Disconnected(_) => "Lua automation worker stopped".to_owned(),
            };
            self.fail_reload_request(app, &frontend_id, message.clone());
            return Err(message);
        }
        match response.recv_timeout(Duration::from_secs(10)) {
            Ok(result) => result,
            Err(_) => {
                let error = "Lua automation worker did not abort reload".to_owned();
                self.fail_reload_request(app, &frontend_id, error.clone());
                Err(error)
            }
        }
    }
}

#[tauri::command]
pub fn lua_automation_start(
    window: WebviewWindow,
    automation: State<'_, LuaAutomation>,
) -> Result<StartResult, String> {
    require_main(&window)?;
    automation.start()
}

#[tauri::command]
pub fn lua_automation_update(
    window: WebviewWindow,
    automation: State<'_, LuaAutomation>,
    terminals: State<'_, TerminalState>,
    snapshot: FrontendSnapshot,
) -> Result<(), String> {
    require_main(&window)?;
    automation.update(&window.app_handle(), snapshot, &terminals)
}

#[tauri::command]
pub fn lua_automation_status(
    window: WebviewWindow,
    automation: State<'_, LuaAutomation>,
) -> Result<AutomationStatus, String> {
    require_main(&window)?;
    Ok(automation.status())
}

#[tauri::command]
pub async fn lua_automation_reload(
    window: WebviewWindow,
    automation: State<'_, LuaAutomation>,
    frontend_id: String,
) -> Result<ReloadPreparation, String> {
    require_main(&window)?;
    let client = automation.reload_client();
    let app = window.app_handle().clone();
    let on_failure = client.clone();
    let failure_app = app.clone();
    let failure_frontend_id = frontend_id.clone();
    match tauri::async_runtime::spawn_blocking(move || client.prepare_reload(&app, frontend_id))
        .await
    {
        Ok(result) => result,
        Err(_) => {
            let error = "Lua reload task failed".to_owned();
            on_failure.fail_reload_request(&failure_app, &failure_frontend_id, error.clone());
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn lua_automation_prepare_reload(
    window: WebviewWindow,
    automation: State<'_, LuaAutomation>,
    frontend_id: String,
) -> Result<ReloadPreparation, String> {
    require_main(&window)?;
    let client = automation.reload_client();
    let app = window.app_handle().clone();
    let on_failure = client.clone();
    let failure_app = app.clone();
    let failure_frontend_id = frontend_id.clone();
    match tauri::async_runtime::spawn_blocking(move || client.prepare_reload(&app, frontend_id))
        .await
    {
        Ok(result) => result,
        Err(_) => {
            let error = "Lua reload task failed".to_owned();
            on_failure.fail_reload_request(&failure_app, &failure_frontend_id, error.clone());
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn lua_automation_commit_reload(
    window: WebviewWindow,
    automation: State<'_, LuaAutomation>,
    frontend_id: String,
    token: String,
    handled_cleanup_ids: Vec<String>,
) -> Result<AutomationStatus, String> {
    require_main(&window)?;
    let client = automation.reload_client();
    let app = window.app_handle().clone();
    let on_failure = client.clone();
    let failure_app = app.clone();
    let failure_frontend_id = frontend_id.clone();
    match tauri::async_runtime::spawn_blocking(move || {
        client.commit_reload(&app, frontend_id, token, handled_cleanup_ids)
    })
    .await
    {
        Ok(result) => result,
        Err(_) => {
            let error = "Lua reload task failed".to_owned();
            on_failure.fail_reload_request(&failure_app, &failure_frontend_id, error.clone());
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn lua_automation_abort_reload(
    window: WebviewWindow,
    automation: State<'_, LuaAutomation>,
    frontend_id: String,
    token: String,
) -> Result<AutomationStatus, String> {
    require_main(&window)?;
    let client = automation.reload_client();
    let app = window.app_handle().clone();
    let on_failure = client.clone();
    let failure_app = app.clone();
    let failure_frontend_id = frontend_id.clone();
    match tauri::async_runtime::spawn_blocking(move || {
        client.abort_reload(&app, frontend_id, token)
    })
    .await
    {
        Ok(result) => result,
        Err(_) => {
            let error = "Lua reload task failed".to_owned();
            on_failure.fail_reload_request(&failure_app, &failure_frontend_id, error.clone());
            Err(error)
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedSettingsPayload {
    pub default_preset: Option<String>,
    pub smooth_scrollback: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSettingsResult {
    pub settings: ManagedSettingsPayload,
    pub revision: String,
    pub path: String,
    pub has_settings: bool,
    pub palettes: Vec<AnsiPalette>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LuaPresetRequest {
    frontend_id: String,
    generation: u64,
    tab_id: String,
    name: String,
}

#[tauri::command]
pub fn load_managed_settings(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<ManagedSettingsResult, String> {
    require_main(&window)?;
    let path = ensure_managed_config(&app)?;
    let source = read_managed_config(&path)?;
    let source_text = std::str::from_utf8(&source)
        .map_err(|error| format!("Lua configuration is not valid UTF-8: {error}"))?;
    let snapshot =
        RuntimeSnapshot::load_source(&path, source_text).map_err(format_snapshot_error)?;
    Ok(managed_settings_result(
        &path,
        &source,
        snapshot.settings(),
        snapshot.ansi_palettes(),
    ))
}

#[tauri::command]
pub fn save_managed_settings(
    window: WebviewWindow,
    app: tauri::AppHandle,
    settings: ManagedSettingsPayload,
    revision: String,
) -> Result<ManagedSettingsResult, String> {
    require_main(&window)?;
    if revision.len() != 16 || !revision.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Lua settings revision is invalid".into());
    }
    if let Some(name) = &settings.default_preset {
        crate::presets::validate_name(name)?;
    }
    let path = ensure_managed_config(&app)?;
    ensure_regular_managed_config(&path)?;
    let original = read_managed_config(&path)?;
    if revision_token(&path, &original) != revision {
        return Err(
            "Lua configuration changed since it was loaded; reload settings before saving".into(),
        );
    }
    let source = std::str::from_utf8(&original)
        .map_err(|error| format!("Lua configuration is not valid UTF-8: {error}"))?;
    let candidate = splice_managed_settings(source.as_bytes(), &settings)?;
    let candidate_source = std::str::from_utf8(&candidate)
        .map_err(|error| format!("generated Lua configuration is invalid UTF-8: {error}"))?;
    let snapshot =
        RuntimeSnapshot::load_source(&path, candidate_source).map_err(format_snapshot_error)?;
    let actual_settings = snapshot
        .settings()
        .ok_or("generated managed settings declaration was not evaluated")?;
    if actual_settings.default_preset != settings.default_preset
        || actual_settings.smooth_scrollback != settings.smooth_scrollback
    {
        return Err("managed settings were changed by Lua code outside the managed block".into());
    }

    commit_managed_config(&path, &original, &candidate)?;
    Ok(managed_settings_result(
        &path,
        &candidate,
        snapshot.settings(),
        snapshot.ansi_palettes(),
    ))
}

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Lua automation is available only to the main window".into())
    }
}

fn validate_snapshot(snapshot: &FrontendSnapshot) -> Result<(), String> {
    if snapshot.frontend_id.len() > 128 || snapshot.frontend_id.is_empty() {
        return Err("Lua automation frontend ID is invalid".into());
    }
    if snapshot.tabs.len() > MAX_TABS {
        return Err("Lua automation snapshot has too many tabs".into());
    }
    if snapshot
        .active_tab_id
        .as_ref()
        .is_some_and(|id| id.is_empty() || id.len() > 128)
    {
        return Err("Lua automation active tab ID is invalid".into());
    }
    let mut ids = std::collections::HashSet::new();
    for tab in &snapshot.tabs {
        if tab.id.is_empty() || tab.id.len() > 128 || !ids.insert(tab.id.as_str()) {
            return Err("Lua automation snapshot has an invalid or duplicate tab ID".into());
        }
        if tab.title.chars().count() > MAX_TITLE_CHARS {
            return Err("Lua automation tab title is too long".into());
        }
        if tab
            .process_name
            .as_ref()
            .is_some_and(|name| name.chars().count() > MAX_PROCESS_CHARS)
        {
            return Err("Lua automation process name is too long".into());
        }
        crate::presets::validate_name(&tab.preset_name)?;
    }
    Ok(())
}

fn normalize_snapshot_to_live_sessions(
    snapshot: &mut FrontendSnapshot,
    live_ids: &std::collections::HashSet<String>,
) {
    snapshot.tabs.retain(|tab| live_ids.contains(&tab.id));
    if !snapshot
        .active_tab_id
        .as_ref()
        .is_some_and(|active| snapshot.tabs.iter().any(|tab| &tab.id == active))
    {
        snapshot.active_tab_id = None;
        snapshot.focused = false;
    }
}

fn cursor_shape(shape: Option<&str>) -> CursorShape {
    match shape {
        Some("block") => CursorShape::Block,
        Some("underline") => CursorShape::Underline,
        Some("bar") => CursorShape::Bar,
        Some("unknown") => CursorShape::Unknown,
        _ => CursorShape::None,
    }
}

fn worker_loop(
    app: tauri::AppHandle,
    shared: Arc<Mutex<Shared>>,
    receiver: Receiver<Work>,
    layouts: NativeLayouts,
    exe_dir: Option<PathBuf>,
    app_config_dir: Option<PathBuf>,
    lua_examples_dir: Option<PathBuf>,
) {
    let mut runtime: Option<LuaRuntime> = None;
    let mut active_epoch = 0;
    let scenario_state = ScenarioStateStore::default();
    let mut prepared_reload: Option<PendingReload> = None;
    let mut previous: HashMap<String, TabState> = HashMap::new();
    let mut previous_window_focus = false;
    let mut last_layout = None::<String>;
    let mut last_caps_policy = None::<CachedCapsPolicy>;
    let mut pending: Option<PendingLayout> = None;
    loop {
        let transition_pending = shared.lock().ok().is_some_and(|state| {
            state.status.state == "loading" || state.action_epoch != active_epoch
        });
        let timeout = if transition_pending
            || pending.is_some()
            || runtime
                .as_ref()
                .is_some_and(LuaRuntime::wants_input_language_events)
        {
            LAYOUT_POLL
        } else {
            Duration::from_secs(60)
        };
        match receiver.recv_timeout(timeout) {
            Ok(Work::Start { frontend_id, epoch }) => {
                if !is_current(&shared, &frontend_id, None, epoch) {
                    continue;
                }
                active_epoch = epoch;
                crate::caps_hook::revoke(&app);
                last_caps_policy = None;
                for id in previous.keys() {
                    if let Some(runtime) = runtime.as_mut() {
                        runtime.close_tab(id);
                    }
                }
                scenario_state.clear_all();
                prepared_reload = None;
                previous.clear();
                previous_window_focus = false;
                last_layout = None;
                pending = None;
            }
            Ok(Work::Update {
                frontend_id,
                generation,
                epoch,
                tabs,
                window_focused,
                active_tab_id,
            }) => {
                if prepared_reload.is_some()
                    || shared
                        .lock()
                        .ok()
                        .is_some_and(|state| state.status.state == "loading")
                {
                    continue;
                }
                if !is_frontend_epoch_ready(&shared, &frontend_id, epoch)
                    || !is_current(&shared, &frontend_id, Some(generation), epoch)
                {
                    continue;
                }
                active_epoch = epoch;
                pending = None;
                let Some(runtime) = runtime.as_mut() else {
                    let context = caps_policy_context(None, &tabs);
                    publish_caps_policy_candidate(
                        &app,
                        &shared,
                        &mut last_caps_policy,
                        context,
                        &frontend_id,
                        generation,
                        epoch,
                    );
                    continue;
                };
                let active_tab_id = active_tab_id.filter(|id| tabs.iter().any(|tab| &tab.id == id));
                // Keep queued immutable snapshots ordered; native focus is checked at
                // the side-effect boundary before any layout request.
                let focused = window_focused && active_tab_id.is_some();
                let tabs = tabs
                    .into_iter()
                    .map(|mut tab| {
                        tab.active = active_tab_id.as_deref() == Some(tab.id.as_str());
                        tab.focused = focused && tab.active;
                        tab
                    })
                    .collect::<Vec<_>>();
                let language = (focused
                    && is_current(&shared, &frontend_id, Some(generation), epoch))
                .then(|| layouts.current())
                .flatten();
                let next: HashMap<_, _> = tabs
                    .iter()
                    .cloned()
                    .map(|tab| (tab.id.clone(), tab))
                    .collect();
                let input = InputState {
                    current_layout: language.clone(),
                };
                let mut results = Vec::new();
                for id in previous.keys() {
                    if !next.contains_key(id) {
                        runtime.close_tab(id);
                    }
                }
                for (id, tab) in &next {
                    if !previous.contains_key(id) {
                        results.push((id.clone(), runtime.attach_tab(tab.clone(), input.clone())));
                        results.push((
                            id.clone(),
                            runtime.dispatch(tab, &input, RuntimeEvent::TabCreated),
                        ));
                    }
                }
                for (id, tab) in &next {
                    let Some(old) = previous.get(id) else {
                        continue;
                    };
                    if old.title != tab.title {
                        results.push((
                            id.clone(),
                            runtime.dispatch(
                                tab,
                                &input,
                                RuntimeEvent::TabTitleChanged {
                                    old_title: old.title.clone(),
                                    new_title: tab.title.clone(),
                                },
                            ),
                        ));
                    }
                    if old.local_process_name != tab.local_process_name {
                        results.push((
                            id.clone(),
                            runtime.dispatch(
                                tab,
                                &input,
                                RuntimeEvent::LocalProcessChanged {
                                    old_process: old.local_process_name.clone(),
                                    new_process: tab.local_process_name.clone(),
                                },
                            ),
                        ));
                    }
                    if old.cursor_style != tab.cursor_style {
                        results.push((
                            id.clone(),
                            runtime.dispatch(
                                tab,
                                &input,
                                RuntimeEvent::CursorStyleChanged {
                                    old_cursor: old.cursor_style.clone(),
                                    new_cursor: tab.cursor_style.clone(),
                                },
                            ),
                        ));
                    }
                    if old.focused != tab.focused {
                        results.push((
                            id.clone(),
                            runtime.dispatch(
                                tab,
                                &input,
                                RuntimeEvent::TabFocusChanged {
                                    focused: tab.focused,
                                },
                            ),
                        ));
                    }
                    if !old.active && tab.active {
                        results.push((
                            id.clone(),
                            runtime.dispatch(tab, &input, RuntimeEvent::TabActivated),
                        ));
                    }
                    if old.active && !tab.active {
                        results.push((
                            id.clone(),
                            runtime.dispatch(tab, &input, RuntimeEvent::TabDeactivated),
                        ));
                    }
                }
                if previous_window_focus != focused {
                    if let Some(tab) = tabs.iter().find(|tab| tab.active) {
                        results.push((
                            tab.id.clone(),
                            runtime.dispatch(
                                tab,
                                &input,
                                RuntimeEvent::WindowFocusChanged { focused },
                            ),
                        ));
                    }
                    previous_window_focus = focused;
                }
                if is_current(&shared, &frontend_id, Some(generation), epoch) {
                    if let Some(tab) = tabs.iter().find(|tab| tab.active) {
                        results.push((
                            tab.id.clone(),
                            runtime.dispatch(tab, &input, RuntimeEvent::ContextUpdated),
                        ));
                    }
                }
                previous = next;
                last_layout = language.clone();
                apply_results(
                    &app,
                    &shared,
                    &layouts,
                    &mut pending,
                    results,
                    &frontend_id,
                    generation,
                    epoch,
                );
                let context = caps_policy_context(Some(runtime), &tabs);
                publish_caps_policy_candidate(
                    &app,
                    &shared,
                    &mut last_caps_policy,
                    context,
                    &frontend_id,
                    generation,
                    epoch,
                );
            }
            Ok(Work::PrepareReload {
                token,
                frontend_id,
                generation,
                epoch,
                reply,
            }) => {
                if !is_current(&shared, &frontend_id, Some(generation), epoch) {
                    let same_epoch = shared.lock().ok().is_some_and(|state| {
                        state.frontend_id.as_deref() == Some(frontend_id.as_str())
                            && state.action_epoch == epoch
                    });
                    if same_epoch {
                        crate::caps_hook::revoke(&app);
                        runtime = None;
                        previous.clear();
                        scenario_state.clear_all();
                        prepared_reload = None;
                        pending = None;
                        last_caps_policy = None;
                        set_status(
                            &shared,
                            "error",
                            None,
                            Some("Lua automation reload context became stale".into()),
                            vec![AutomationDiagnostic::error(
                                "Lua automation reload context became stale",
                            )],
                        );
                    }
                    let _ = reply.send(Err("Lua automation reload request is stale".into()));
                    continue;
                }
                active_epoch = epoch;
                crate::caps_hook::revoke(&app);
                last_caps_policy = None;
                pending = None;
                let tabs = shared
                    .lock()
                    .map(|state| state.tabs.clone())
                    .unwrap_or_default();
                let language = layouts.current();
                let contexts = tabs
                    .iter()
                    .cloned()
                    .map(|tab| {
                        (
                            tab.id.clone(),
                            (
                                tab,
                                InputState {
                                    current_layout: language.clone(),
                                },
                            ),
                        )
                    })
                    .collect::<HashMap<_, _>>();

                let (candidate, config_path, candidate_status, error, mut diagnostics) =
                    match seed_lua_config(
                        exe_dir.as_deref(),
                        app_config_dir.as_deref(),
                        lua_examples_dir.as_deref(),
                    ) {
                        Err(error) => (
                            None,
                            app_config_dir.as_deref().map(|directory| {
                                directory.join("config.lua").display().to_string()
                            }),
                            "error",
                            Some(error.clone()),
                            vec![AutomationDiagnostic::error(error)],
                        ),
                        Ok(()) => {
                            match resolve_config_path(exe_dir.as_deref(), app_config_dir.as_deref())
                            {
                                None => (None, None, "disabled", None, Vec::new()),
                                Some(path) => match RuntimeSnapshot::load(&path) {
                                    Ok(snapshot) => (
                                        Some(snapshot),
                                        Some(path.display().to_string()),
                                        "ready",
                                        None,
                                        Vec::new(),
                                    ),
                                    Err(items) => (
                                        None,
                                        Some(path.display().to_string()),
                                        "error",
                                        Some("Lua configuration failed to load".into()),
                                        render_diagnostics(items),
                                    ),
                                },
                            }
                        }
                    };
                let retained = candidate
                    .as_ref()
                    .map(RuntimeSnapshot::attachment_state_keys)
                    .unwrap_or_default();
                let mut cleanup_intents: Vec<ReloadCleanupRequest> = prepared_reload
                    .take()
                    .map(|previous| {
                        previous
                            .plan
                            .cleanup
                            .into_iter()
                            .filter(|cleanup| !retained.contains(&cleanup.attachment_key))
                            .collect()
                    })
                    .unwrap_or_default();
                if let Some(runtime) = runtime.as_mut() {
                    let removed = runtime.prepare_removed_attachments(&retained, &contexts);
                    diagnostics.extend(
                        removed
                            .diagnostics
                            .into_iter()
                            .map(|item| AutomationDiagnostic::error(format_diagnostic(item))),
                    );
                    cleanup_intents.extend(removed.cleanup.into_iter().map(|item| {
                        ReloadCleanupRequest {
                            id: String::new(),
                            tab_id: item.tab_id,
                            name: item.name,
                            expected_current_preset: item.expected_current_preset,
                            attachment_key: item.attachment_key,
                        }
                    }));
                }
                let mut unique = std::collections::HashSet::new();
                cleanup_intents.retain(|cleanup| {
                    unique.insert((
                        cleanup.tab_id.clone(),
                        cleanup.name.clone(),
                        cleanup.expected_current_preset.clone(),
                    ))
                });
                for (index, cleanup) in cleanup_intents.iter_mut().enumerate() {
                    cleanup.id = format!("{token}:{index}");
                }
                let plan = ReloadPreparation {
                    token,
                    frontend_id: frontend_id.clone(),
                    generation,
                    cleanup: cleanup_intents,
                    palettes: candidate
                        .as_ref()
                        .map(|snapshot| snapshot.ansi_palettes().to_vec()),
                    candidate_status,
                    error,
                };
                let path = config_path;
                prepared_reload = Some(PendingReload {
                    plan: plan.clone(),
                    epoch,
                    candidate,
                    config_path: path,
                    diagnostics,
                });
                if reply.send(Ok(plan)).is_err()
                    && is_current(&shared, &frontend_id, Some(generation), epoch)
                {
                    crate::caps_hook::revoke(&app);
                    runtime = None;
                    previous.clear();
                    prepared_reload = None;
                    scenario_state.clear_all();
                    pending = None;
                    last_caps_policy = None;
                    set_status(
                        &shared,
                        "error",
                        None,
                        Some("Lua automation reload preparation was abandoned".into()),
                        vec![AutomationDiagnostic::error(
                            "Lua automation reload preparation was abandoned",
                        )],
                    );
                }
            }
            Ok(Work::CommitReload {
                token,
                frontend_id,
                handled_cleanup_ids,
                reply,
            }) => {
                let Some(prepared) = prepared_reload.as_ref() else {
                    let _ = reply.send(Err("Lua reload transition is stale".into()));
                    continue;
                };
                let current = shared.lock().ok().is_some_and(|state| {
                    transition_context_matches(
                        &state,
                        &prepared.plan,
                        prepared.epoch,
                        &frontend_id,
                        &token,
                    )
                });
                if !current {
                    let _ = reply.send(Err("Lua reload transition is stale".into()));
                    continue;
                }
                let expected_ids = prepared
                    .plan
                    .cleanup
                    .iter()
                    .map(|cleanup| cleanup.id.as_str())
                    .collect::<Vec<_>>();
                if !cleanup_acknowledgement_is_exact(&expected_ids, &handled_cleanup_ids) {
                    let _ = reply.send(Err("Lua reload cleanup acknowledgement is invalid".into()));
                    continue;
                }
                let prepared = prepared_reload.take().unwrap();
                let tabs: Vec<String> = shared
                    .lock()
                    .map(|state| state.tabs.iter().map(|tab| tab.id.clone()).collect())
                    .unwrap_or_default();
                if let Some(candidate) = prepared.candidate {
                    let attachment_keys = candidate.attachment_state_keys();
                    let tab_ids = tabs.into_iter().collect::<std::collections::HashSet<_>>();
                    scenario_state.retain(&tab_ids, &attachment_keys);
                    runtime = Some(LuaRuntime::with_state_store(
                        candidate,
                        scenario_state.clone(),
                    ));
                    previous.clear();
                    let status = AutomationStatus {
                        state: "ready",
                        config_path: prepared.config_path,
                        error: None,
                        diagnostics: bounded_diagnostics(prepared.diagnostics),
                    };
                    if let Ok(mut state) = shared.lock() {
                        state.status = status.clone();
                    }
                    active_epoch = prepared.epoch;
                    let _ = reply.send(Ok(status));
                } else {
                    runtime = None;
                    previous.clear();
                    scenario_state.clear_all();
                    let state_label = prepared.plan.candidate_status;
                    let status = AutomationStatus {
                        state: state_label,
                        config_path: prepared.config_path,
                        error: prepared.plan.error,
                        diagnostics: bounded_diagnostics(prepared.diagnostics),
                    };
                    if let Ok(mut state) = shared.lock() {
                        state.status = status.clone();
                    }
                    active_epoch = prepared.epoch;
                    let _ = reply.send(Ok(status));
                }
                pending = None;
                last_caps_policy = None;
            }
            Ok(Work::AbortReload {
                token,
                frontend_id,
                reply,
            }) => {
                let matches = prepared_reload.as_ref().is_some_and(|prepared| {
                    prepared.plan.token == token && prepared.plan.frontend_id == frontend_id
                }) && shared.lock().ok().is_some_and(|state| {
                    state.frontend_id.as_deref() == Some(frontend_id.as_str())
                });
                if !matches {
                    let _ = reply.send(Err("Lua reload transition is stale".into()));
                    continue;
                }
                crate::caps_hook::revoke(&app);
                runtime = None;
                previous.clear();
                prepared_reload = None;
                scenario_state.clear_all();
                pending = None;
                last_caps_policy = None;
                if let Ok(mut state) = shared.lock() {
                    state.action_epoch = state.action_epoch.wrapping_add(1);
                    active_epoch = state.action_epoch;
                    state.status.state = "error";
                    state.status.error =
                        Some("Lua reload was aborted; reload config to retry".into());
                    push_diagnostic(
                        &mut state.status.diagnostics,
                        AutomationDiagnostic::error(
                            "Lua reload was aborted; reload config to retry",
                        ),
                    );
                }
                let _ = reply.send(Ok(shared
                    .lock()
                    .map(|state| state.status.clone())
                    .unwrap_or_else(|_| AutomationStatus {
                        state: "error",
                        config_path: None,
                        error: Some("Lua automation state is unavailable".into()),
                        diagnostics: Vec::new(),
                    })));
            }
            Ok(Work::FailClosed {
                frontend_id,
                epoch,
                error,
            }) => {
                if shared.lock().ok().is_some_and(|state| {
                    state.frontend_id.as_deref() == Some(frontend_id.as_str())
                        && state.action_epoch == epoch
                }) {
                    crate::caps_hook::revoke(&app);
                    runtime = None;
                    previous.clear();
                    prepared_reload = None;
                    scenario_state.clear_all();
                    pending = None;
                    last_caps_policy = None;
                    set_status(
                        &shared,
                        "error",
                        None,
                        Some(error.clone()),
                        vec![AutomationDiagnostic::error(error)],
                    );
                    active_epoch = epoch;
                }
            }
            Ok(Work::Reload { epoch }) => {
                if !is_epoch_current(&shared, epoch) {
                    continue;
                }
                active_epoch = epoch;
                crate::caps_hook::revoke(&app);
                last_caps_policy = None;
                pending = None;
                if let Err(error) = seed_lua_config(
                    exe_dir.as_deref(),
                    app_config_dir.as_deref(),
                    lua_examples_dir.as_deref(),
                ) {
                    runtime = None;
                    previous.clear();
                    scenario_state.clear_all();
                    let config_path = app_config_dir
                        .as_deref()
                        .map(|directory| directory.join("config.lua").display().to_string());
                    set_status(
                        &shared,
                        "error",
                        config_path,
                        Some(error.clone()),
                        vec![AutomationDiagnostic::error(error)],
                    );
                    publish_caps_policy_clear(&app, &shared, &mut last_caps_policy, epoch);
                    continue;
                }
                match resolve_config_path(exe_dir.as_deref(), app_config_dir.as_deref()) {
                    None => {
                        runtime = None;
                        previous.clear();
                        scenario_state.clear_all();
                        set_status(&shared, "disabled", None, None, Vec::new());
                        publish_caps_policy_clear(&app, &shared, &mut last_caps_policy, epoch);
                    }
                    Some(path) => {
                        set_status(
                            &shared,
                            "loading",
                            Some(path.display().to_string()),
                            None,
                            Vec::new(),
                        );
                        match RuntimeSnapshot::load(&path) {
                            Err(diagnostics) => {
                                runtime = None;
                                previous.clear();
                                scenario_state.clear_all();
                                set_status(
                                    &shared,
                                    "error",
                                    Some(path.display().to_string()),
                                    Some("Lua configuration failed to load".into()),
                                    render_diagnostics(diagnostics),
                                );
                                publish_caps_policy_clear(
                                    &app,
                                    &shared,
                                    &mut last_caps_policy,
                                    epoch,
                                );
                            }
                            Ok(snapshot) => {
                                if !is_epoch_current(&shared, epoch) {
                                    continue;
                                }
                                let config_path = snapshot.config_path().to_path_buf();
                                let (tabs, _, language, _, _, _, _) =
                                    current_state(&shared, &layouts).unwrap_or_default();
                                let input = InputState {
                                    current_layout: language.clone(),
                                };
                                let tab_ids =
                                    tabs.iter().map(|tab| tab.id.clone()).collect::<Vec<_>>();
                                let contexts = tabs
                                    .iter()
                                    .cloned()
                                    .map(|tab| (tab, input.clone()))
                                    .collect::<Vec<_>>();
                                let dispatches = if let Some(runtime) = runtime.as_mut() {
                                    runtime.reload(snapshot, contexts)
                                } else {
                                    let mut new_runtime = LuaRuntime::with_state_store(
                                        snapshot,
                                        scenario_state.clone(),
                                    );
                                    let dispatches = contexts
                                        .into_iter()
                                        .map(|(tab, input)| new_runtime.attach_tab(tab, input))
                                        .collect();
                                    runtime = Some(new_runtime);
                                    dispatches
                                };
                                let mut results =
                                    tab_ids.into_iter().zip(dispatches).collect::<Vec<_>>();
                                if let (Some(runtime), Some(tab)) =
                                    (runtime.as_mut(), tabs.iter().find(|tab| tab.active))
                                {
                                    results.push((
                                        tab.id.clone(),
                                        runtime.dispatch(tab, &input, RuntimeEvent::ContextUpdated),
                                    ));
                                }
                                previous =
                                    tabs.into_iter().map(|tab| (tab.id.clone(), tab)).collect();
                                if let Ok(mut shared) = shared.lock() {
                                    shared.status.state = "ready";
                                    shared.status.config_path =
                                        Some(config_path.display().to_string());
                                    shared.status.error = None;
                                }
                                let current = shared
                                    .lock()
                                    .ok()
                                    .map(|s| (s.frontend_id.clone(), s.generation, s.action_epoch));
                                if let Some((Some(frontend_id), generation, current_epoch)) =
                                    current.filter(|(_, _, current_epoch)| *current_epoch == epoch)
                                {
                                    apply_results(
                                        &app,
                                        &shared,
                                        &layouts,
                                        &mut pending,
                                        results,
                                        &frontend_id,
                                        generation,
                                        current_epoch,
                                    );
                                    let current_tabs =
                                        previous.values().cloned().collect::<Vec<_>>();
                                    let context =
                                        caps_policy_context(runtime.as_ref(), &current_tabs);
                                    publish_caps_policy_candidate(
                                        &app,
                                        &shared,
                                        &mut last_caps_policy,
                                        context,
                                        &frontend_id,
                                        generation,
                                        current_epoch,
                                    );
                                }
                            }
                        }
                    }
                }
            }
            Ok(Work::Shutdown) => {
                crate::caps_hook::revoke(&app);
                scenario_state.clear_all();
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let (loading, current_epoch) = shared
                    .lock()
                    .map(|state| (state.status.state == "loading", state.action_epoch))
                    .unwrap_or((true, active_epoch));
                if reload_transition_invalidated(active_epoch, current_epoch, loading) {
                    crate::caps_hook::revoke(&app);
                    runtime = None;
                    previous.clear();
                    prepared_reload = None;
                    scenario_state.clear_all();
                    pending = None;
                    last_caps_policy = None;
                    active_epoch = current_epoch;
                    set_status(
                        &shared,
                        "error",
                        None,
                        Some("Lua automation transition was interrupted".into()),
                        vec![AutomationDiagnostic::error(
                            "Lua automation transition was interrupted",
                        )],
                    );
                    continue;
                }
                if prepared_reload.is_some() || loading {
                    continue;
                }
                let Some(runtime) = runtime.as_mut() else {
                    continue;
                };
                let Some((tabs, focused, language, frontend_id, generation, epoch, active_tab)) =
                    current_state(&shared, &layouts)
                else {
                    continue;
                };
                if !is_current(&shared, &frontend_id, Some(generation), epoch)
                    || !is_frontend_epoch_ready(&shared, &frontend_id, epoch)
                {
                    continue;
                }
                if let Some(action) = pending.take() {
                    if action.frontend_id != frontend_id
                        || action.generation != generation
                        || action.action_epoch != epoch
                        || !focused
                        || active_tab.as_deref() != Some(action.tab_id.as_str())
                        || !is_live_terminal(&app, &action.tab_id)
                    {
                        continue;
                    }
                    if layout_acknowledged(layouts.current().as_deref(), &action.requested) {
                        push_shared_diagnostic(
                            &shared,
                            AutomationDiagnostic::info(format!(
                                "Lua action {} ({}) on tab {} generation {} observed layout {}",
                                action.script,
                                action.event,
                                action.tab_id,
                                action.generation,
                                action.requested
                            )),
                        );
                        if runtime.wants_input_language_events()
                            && last_layout.as_deref() != Some(action.requested.as_str())
                            && is_current(&shared, &frontend_id, Some(generation), epoch)
                        {
                            dispatch_language(
                                &app,
                                runtime,
                                &shared,
                                &layouts,
                                &tabs,
                                &mut pending,
                                &action.requested,
                                &frontend_id,
                                generation,
                                epoch,
                            );
                        }
                        last_layout = Some(action.requested);
                    } else if Instant::now() >= action.deadline {
                        push_shared_diagnostic(
                            &shared,
                            AutomationDiagnostic::error(format!(
                                "Keyboard layout change to {} was not observed before timeout",
                                action.requested
                            )),
                        );
                    } else {
                        pending = Some(action);
                    }
                } else if runtime.wants_input_language_events() {
                    if let Some(language) = language {
                        if last_layout.as_deref() != Some(language.as_str())
                            && is_current(&shared, &frontend_id, Some(generation), epoch)
                        {
                            dispatch_language(
                                &app,
                                runtime,
                                &shared,
                                &layouts,
                                &tabs,
                                &mut pending,
                                &language,
                                &frontend_id,
                                generation,
                                epoch,
                            );
                            last_layout = Some(language);
                        }
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    crate::caps_hook::revoke(&app);
}

const LUA_STARTER_FILES: &[(&str, &str)] = &[
    ("editors/nvim.lua", "editors/nvim.lua"),
    ("editors/hx.lua", "editors/hx.lua"),
    ("modules/modal_editor.lua", "modules/modal_editor.lua"),
    ("scripts/far_preset.lua", "scripts/far_preset.lua"),
    ("palettes/users.lua", "palettes/users.lua"),
    ("sterm.lua", "config.lua"),
];

fn seed_lua_config(
    exe_dir: Option<&Path>,
    app_config_dir: Option<&Path>,
    examples_dir: Option<&Path>,
) -> Result<(), String> {
    if exe_dir
        .map(|directory| directory.join("sterm.lua").is_file())
        .unwrap_or(false)
    {
        return Ok(());
    }
    let Some(app_config_dir) = app_config_dir else {
        return Err("could not locate the user configuration directory".into());
    };
    let entry = app_config_dir.join("config.lua");
    if entry.is_file() {
        return Ok(());
    }
    match fs::symlink_metadata(&entry) {
        Ok(_) => return Err("Lua config destination exists and is not a regular file".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("could not inspect Lua config destination: {error}")),
    }
    let examples_dir = examples_dir.ok_or("bundled Lua examples are unavailable")?;
    let source_entry = examples_dir.join("sterm.lua");
    RuntimeSnapshot::load(&source_entry).map_err(|diagnostics| {
        let detail = diagnostics
            .into_iter()
            .map(|diagnostic| diagnostic.message)
            .collect::<Vec<_>>()
            .join("; ");
        format!("bundled Lua starter config is invalid: {detail}")
    })?;

    let mut files = Vec::with_capacity(LUA_STARTER_FILES.len());
    for (source_relative, destination_relative) in LUA_STARTER_FILES {
        let source = examples_dir.join(source_relative);
        let metadata = fs::symlink_metadata(&source).map_err(|error| {
            format!("could not read bundled Lua file {source_relative}: {error}")
        })?;
        if !metadata.file_type().is_file() {
            return Err(format!(
                "bundled Lua file {source_relative} is not a regular file"
            ));
        }
        let contents = fs::read(&source).map_err(|error| {
            format!("could not read bundled Lua file {source_relative}: {error}")
        })?;
        files.push((source_relative, destination_relative, contents));
    }

    fs::create_dir_all(app_config_dir)
        .map_err(|error| format!("could not create Lua config directory: {error}"))?;
    let root = fs::canonicalize(app_config_dir)
        .map_err(|error| format!("could not resolve Lua config directory: {error}"))?;
    ensure_lua_subdirectory(&root, "editors")?;
    ensure_lua_subdirectory(&root, "modules")?;
    ensure_lua_subdirectory(&root, "scripts")?;
    ensure_lua_subdirectory(&root, "palettes")?;

    // Existing regular dependencies belong to the user and are preserved.
    for (_, destination_relative, _) in &files {
        let destination = root.join(destination_relative);
        match fs::symlink_metadata(&destination) {
            Ok(metadata)
                if metadata.file_type().is_file() && **destination_relative != "config.lua" => {}
            Ok(_) => {
                return Err(format!(
                    "Lua starter destination already exists: {destination_relative}"
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "could not inspect Lua starter destination {destination_relative}: {error}"
                ));
            }
        }
    }

    for (_, destination_relative, contents) in &files {
        let destination = root.join(destination_relative);
        if fs::symlink_metadata(&destination).is_ok_and(|metadata| metadata.file_type().is_file()) {
            continue;
        }
        write_lua_file_new(&destination, contents).map_err(|error| {
            format!("could not create Lua starter file {destination_relative}: {error}")
        })?;
    }
    Ok(())
}

fn ensure_lua_subdirectory(root: &Path, name: &str) -> Result<(), String> {
    let path = root.join(name);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_dir() => {}
        Ok(_) => return Err(format!("Lua config path {name} is not a regular directory")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match fs::create_dir(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => {
                    return Err(format!(
                        "could not create Lua config directory {name}: {error}"
                    ));
                }
            }
            let metadata = fs::symlink_metadata(&path).map_err(|error| {
                format!("could not inspect Lua config directory {name}: {error}")
            })?;
            if !metadata.file_type().is_dir() {
                return Err(format!("Lua config path {name} is not a regular directory"));
            }
        }
        Err(error) => {
            return Err(format!(
                "could not inspect Lua config directory {name}: {error}"
            ));
        }
    }
    let resolved = fs::canonicalize(&path)
        .map_err(|error| format!("could not resolve Lua config directory {name}: {error}"))?;
    if !resolved.starts_with(root) {
        return Err(format!("Lua config directory {name} escapes its root"));
    }
    Ok(())
}

fn write_lua_file_new(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?
        .write_all(contents)
}

fn resolve_config_path(exe_dir: Option<&Path>, app_config_dir: Option<&Path>) -> Option<PathBuf> {
    let portable = exe_dir.map(|dir| dir.join("sterm.lua"));
    if portable.as_ref().is_some_and(|path| path.is_file()) {
        return portable;
    }
    let appdata = app_config_dir.map(|dir| dir.join("config.lua"));
    appdata.filter(|path| path.is_file())
}

fn ensure_managed_config(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf));
    let app_config_dir = app.path().app_config_dir().ok();
    let examples_dir = if cfg!(debug_assertions) {
        Some(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("examples")
                .join("lua"),
        )
    } else {
        app.path()
            .resource_dir()
            .ok()
            .map(|directory| directory.join("lua-examples"))
    };
    seed_lua_config(
        exe_dir.as_deref(),
        app_config_dir.as_deref(),
        examples_dir.as_deref(),
    )?;
    resolve_config_path(exe_dir.as_deref(), app_config_dir.as_deref())
        .ok_or_else(|| "Lua configuration is unavailable".into())
}

fn managed_settings_result(
    path: &Path,
    source: &[u8],
    settings: Option<&ManagedSettings>,
    palettes: &[AnsiPalette],
) -> ManagedSettingsResult {
    ManagedSettingsResult {
        settings: ManagedSettingsPayload {
            default_preset: settings.and_then(|settings| settings.default_preset.clone()),
            smooth_scrollback: settings.and_then(|settings| settings.smooth_scrollback),
        },
        revision: revision_token(path, source),
        path: path.display().to_string(),
        has_settings: settings.is_some(),
        palettes: palettes.to_vec(),
    }
}

fn format_snapshot_error(diagnostics: Vec<Diagnostic>) -> String {
    diagnostics
        .into_iter()
        .map(|diagnostic| diagnostic.message)
        .collect::<Vec<_>>()
        .join("; ")
}

fn read_managed_config(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_CONFIG_BYTES as u64 {
        return Err("Lua configuration is too large".into());
    }
    let mut source = Vec::with_capacity(metadata.len() as usize);
    fs::File::open(path)
        .and_then(|file| {
            file.take(MAX_CONFIG_BYTES as u64 + 1)
                .read_to_end(&mut source)
        })
        .map_err(|error| error.to_string())?;
    if source.len() > MAX_CONFIG_BYTES {
        return Err("Lua configuration is too large".into());
    }
    Ok(source)
}

fn ensure_regular_managed_config(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.file_type().is_file() {
        return Err("Lua configuration is not a regular file".into());
    }
    Ok(())
}

fn revision_token(path: &Path, source: &[u8]) -> String {
    use std::hash::{DefaultHasher, Hash, Hasher};
    let mut revision = DefaultHasher::new();
    path.hash(&mut revision);
    source.hash(&mut revision);
    format!("{:016x}", revision.finish())
}

fn commit_managed_config(path: &Path, original: &[u8], candidate: &[u8]) -> Result<(), String> {
    let _guard = MANAGED_SETTINGS_SAVE_LOCK
        .lock()
        .map_err(|_| "Lua settings save lock is unavailable")?;
    ensure_regular_managed_config(path)?;
    if read_managed_config(path)? != original {
        return Err("Lua configuration changed while saving; reload settings before saving".into());
    }
    atomic_replace_managed_config(path, candidate)
}

fn find_managed_block(source: &[u8]) -> Result<Option<Range<usize>>, String> {
    let mut begin = None;
    let mut end = None;
    let mut line_start = 0;
    while line_start < source.len() {
        let mut line_end = line_start;
        while line_end < source.len() && source[line_end] != b'\n' && source[line_end] != b'\r' {
            line_end += 1;
        }
        let mut content_start = line_start;
        if line_start == 0 && source.starts_with(&[0xEF, 0xBB, 0xBF]) {
            content_start = 3;
        }
        let content = &source[content_start..line_end];
        if content == MANAGED_BEGIN {
            if begin.replace(content_start).is_some() {
                return Err("Lua managed settings markers are duplicated".into());
            }
        } else if content == MANAGED_END {
            if end.replace(line_start).is_some() {
                return Err("Lua managed settings markers are duplicated".into());
            }
        } else if content
            .windows(MANAGED_BEGIN.len())
            .any(|part| part == MANAGED_BEGIN)
            || content
                .windows(MANAGED_END.len())
                .any(|part| part == MANAGED_END)
        {
            return Err("Lua managed settings marker must occupy its own line".into());
        }
        if line_end == source.len() {
            line_start = source.len();
        } else if source[line_end] == b'\r' && source.get(line_end + 1) == Some(&b'\n') {
            line_start = line_end + 2;
        } else {
            line_start = line_end + 1;
        }
    }
    match (begin, end) {
        (None, None) => Ok(None),
        (Some(start), Some(end_start)) if start < end_start => {
            let mut end = end_start + MANAGED_END.len();
            if source.get(end) == Some(&b'\r') {
                end += 1;
            }
            if source.get(end) == Some(&b'\n') {
                end += 1;
            }
            Ok(Some(start..end))
        }
        _ => Err("Lua managed settings markers are incomplete or out of order".into()),
    }
}

fn newline_style(source: &[u8]) -> &'static str {
    source
        .windows(2)
        .position(|pair| pair == b"\r\n")
        .map(|_| "\r\n")
        .unwrap_or("\n")
}

fn lua_string_literal(value: &str) -> String {
    let mut literal = String::from("\"");
    for character in value.chars() {
        match character {
            '\\' => literal.push_str("\\\\"),
            '"' => literal.push_str("\\\""),
            '\n' => literal.push_str("\\n"),
            '\r' => literal.push_str("\\r"),
            '\t' => literal.push_str("\\t"),
            character if character.is_control() => {
                use std::fmt::Write as _;
                let _ = write!(literal, "\\{:03}", character as u32);
            }
            character => literal.push(character),
        }
    }
    literal.push('"');
    literal
}

fn managed_settings_block(
    settings: &ManagedSettingsPayload,
    newline: &str,
    trailing_newline: bool,
) -> Vec<u8> {
    let mut fields = Vec::new();
    if let Some(name) = &settings.default_preset {
        fields.push(format!("default_preset = {}", lua_string_literal(name)));
    }
    if let Some(enabled) = settings.smooth_scrollback {
        fields.push(format!("smooth_scrollback = {enabled}"));
    }
    let call = format!("require('sterm').settings({{ {} }})", fields.join(", "));
    let mut block = format!(
        "{begin}{newline}{call}{newline}{end}",
        begin = String::from_utf8_lossy(MANAGED_BEGIN),
        end = String::from_utf8_lossy(MANAGED_END),
    )
    .into_bytes();
    if trailing_newline {
        block.extend_from_slice(newline.as_bytes());
    }
    block
}

fn managed_insertion_offset(source: &[u8]) -> (usize, bool) {
    let mut start = usize::from(source.starts_with(&[0xEF, 0xBB, 0xBF])) * 3;
    if source.get(start..start + 2) != Some(b"#!") {
        return (start, false);
    }
    while start < source.len() && source[start] != b'\n' && source[start] != b'\r' {
        start += 1;
    }
    if start == source.len() {
        return (start, true);
    }
    if source[start] == b'\r' && source.get(start + 1) == Some(&b'\n') {
        (start + 2, false)
    } else {
        (start + 1, false)
    }
}

fn splice_managed_settings(
    source: &[u8],
    settings: &ManagedSettingsPayload,
) -> Result<Vec<u8>, String> {
    if let Some(name) = &settings.default_preset {
        crate::presets::validate_name(name)?;
    }
    let newline = newline_style(source);
    match find_managed_block(source)? {
        Some(range) => {
            let trailing_newline = source.get(range.end.saturating_sub(1)) == Some(&b'\n');
            let block = managed_settings_block(settings, newline, trailing_newline);
            let mut output =
                Vec::with_capacity(source.len() - (range.end - range.start) + block.len());
            output.extend_from_slice(&source[..range.start]);
            output.extend_from_slice(&block);
            output.extend_from_slice(&source[range.end..]);
            Ok(output)
        }
        None => {
            let (offset, needs_separator) = managed_insertion_offset(source);
            let mut output = Vec::with_capacity(source.len() + 128);
            output.extend_from_slice(&source[..offset]);
            if needs_separator {
                output.extend_from_slice(newline.as_bytes());
            }
            output.extend_from_slice(&managed_settings_block(settings, newline, true));
            output.extend_from_slice(&source[offset..]);
            Ok(output)
        }
    }
}

fn atomic_replace_managed_config(path: &Path, contents: &[u8]) -> Result<(), String> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Lua configuration name is unavailable")?;
    let temp = path.with_file_name(format!(
        ".{file_name}.managed.{}.{}.tmp",
        std::process::id(),
        NEXT_MANAGED_TEMP.fetch_add(1, Ordering::Relaxed)
    ));
    let mut created = false;
    let result = (|| -> io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        created = true;
        file.write_all(contents)?;
        file.sync_all()?;
        drop(file);
        // shortcut: an external editor can race after byte comparison; use cross-process locking if that becomes a requirement.
        replace_managed_file(&temp, path)
    })();
    if result.is_err() && created {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(|error| format!("could not safely replace Lua configuration: {error}"))
}

#[cfg(windows)]
fn replace_managed_file(temp: &Path, destination: &Path) -> io::Result<()> {
    use std::{os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::Storage::FileSystem::{REPLACEFILE_WRITE_THROUGH, ReplaceFileW};
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let temp: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
    let replaced = unsafe {
        ReplaceFileW(
            destination.as_ptr(),
            temp.as_ptr(),
            ptr::null(),
            REPLACEFILE_WRITE_THROUGH,
            ptr::null(),
            ptr::null(),
        )
    };
    if replaced == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_managed_file(temp: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(temp, destination)
}

fn is_epoch_current(shared: &Arc<Mutex<Shared>>, epoch: u64) -> bool {
    shared
        .lock()
        .is_ok_and(|shared| shared.action_epoch == epoch)
}

fn snapshot_is_fresh(shared: &Shared, frontend_id: &str, generation: u64) -> bool {
    shared.frontend_id.as_deref() == Some(frontend_id) && generation > shared.generation
}

fn fail_closed_if_newer(
    shared: &mut Shared,
    frontend_id: &str,
    generation: u64,
    error: &str,
) -> bool {
    if !snapshot_is_fresh(shared, frontend_id, generation) {
        return false;
    }
    fail_closed(shared, error.to_owned());
    true
}

fn action_context_is_current(
    shared: &Shared,
    frontend_id: &str,
    generation: u64,
    epoch: u64,
    tab_id: &str,
) -> bool {
    shared.frontend_id.as_deref() == Some(frontend_id)
        && shared.generation == generation
        && shared.action_epoch == epoch
        && shared.status.state == "ready"
        && shared.active_tab_id.as_deref() == Some(tab_id)
        && shared.focused
}

fn preset_action_context_is_current(
    shared: &Shared,
    frontend_id: &str,
    generation: u64,
    epoch: u64,
    tab_id: &str,
) -> bool {
    shared.frontend_id.as_deref() == Some(frontend_id)
        && shared.generation == generation
        && shared.action_epoch == epoch
        && shared.status.state == "ready"
        && shared.active_tab_id.as_deref() == Some(tab_id)
}

fn layout_acknowledged(current: Option<&str>, resolved_hkl: &str) -> bool {
    current.is_some_and(|current| current.eq_ignore_ascii_case(resolved_hkl))
}

fn is_current(
    shared: &Arc<Mutex<Shared>>,
    frontend_id: &str,
    generation: Option<u64>,
    epoch: u64,
) -> bool {
    shared.lock().is_ok_and(|shared| {
        shared.frontend_id.as_deref() == Some(frontend_id)
            && generation.is_none_or(|generation| shared.generation == generation)
            && shared.action_epoch == epoch
    })
}

fn is_frontend_epoch_ready(shared: &Arc<Mutex<Shared>>, frontend_id: &str, epoch: u64) -> bool {
    shared.lock().is_ok_and(|shared| {
        shared.frontend_id.as_deref() == Some(frontend_id)
            && shared.action_epoch == epoch
            && shared.status.state == "ready"
    })
}

fn caps_policy_context(runtime: Option<&LuaRuntime>, tabs: &[TabState]) -> CapsPolicyContext {
    let active = tabs.iter().find(|tab| tab.active);
    CapsPolicyContext {
        tab_id: active.map(|tab| tab.id.clone()),
        process_name: active.and_then(|tab| tab.local_process_name.clone()),
        enabled: active.is_some_and(|tab| {
            tab.focused && runtime.is_some_and(|runtime| runtime.smart_caps_enabled(&tab.id))
        }),
    }
}

fn publish_caps_policy_clear(
    app: &tauri::AppHandle,
    shared: &Arc<Mutex<Shared>>,
    last: &mut Option<CachedCapsPolicy>,
    epoch: u64,
) {
    let Some((Some(frontend_id), generation, tabs)) = shared.lock().ok().map(|shared| {
        (
            shared.frontend_id.clone(),
            shared.generation,
            shared.tabs.clone(),
        )
    }) else {
        return;
    };
    if !is_epoch_current(shared, epoch) {
        return;
    }
    let mut context = caps_policy_context(None, &tabs);
    context.enabled = false;
    publish_caps_policy_candidate(app, shared, last, context, &frontend_id, generation, epoch);
}

fn publish_caps_policy_candidate(
    app: &tauri::AppHandle,
    shared: &Arc<Mutex<Shared>>,
    last: &mut Option<CachedCapsPolicy>,
    context: CapsPolicyContext,
    frontend_id: &str,
    generation: u64,
    epoch: u64,
) {
    if caps_policy_is_cached(last, &context, generation)
        || !is_current(shared, frontend_id, Some(generation), epoch)
    {
        return;
    }
    match crate::caps_hook::publish_candidate(
        app,
        frontend_id.to_owned(),
        generation,
        context.tab_id.clone(),
        context.process_name.clone(),
        context.enabled,
    ) {
        Ok(true) => cache_caps_policy_candidate(last, context, generation, true),
        Ok(false) => return,
        Err(error) => {
            push_shared_diagnostic(
                shared,
                AutomationDiagnostic::error(format!(
                    "Could not publish Caps policy candidate: {error}"
                )),
            );
            return;
        }
    }
}

fn caps_policy_is_cached(
    last: &Option<CachedCapsPolicy>,
    context: &CapsPolicyContext,
    generation: u64,
) -> bool {
    last.as_ref()
        .is_some_and(|last| last.context == *context && last.generation >= generation)
}

fn cache_caps_policy_candidate(
    last: &mut Option<CachedCapsPolicy>,
    context: CapsPolicyContext,
    generation: u64,
    accepted: bool,
) {
    if accepted {
        *last = Some(CachedCapsPolicy {
            context,
            generation,
        });
    }
}

fn current_state(
    shared: &Arc<Mutex<Shared>>,
    layouts: &NativeLayouts,
) -> Option<(
    Vec<TabState>,
    bool,
    Option<String>,
    String,
    u64,
    u64,
    Option<String>,
)> {
    let (tabs, active, focused, epoch, frontend_id, generation) = {
        let shared = shared.lock().ok()?;
        (
            shared.tabs.clone(),
            shared.active_tab_id.clone(),
            shared.focused,
            shared.action_epoch,
            shared.frontend_id.clone()?,
            shared.generation,
        )
    };
    let native_focus = focused && layouts.is_main_focused();
    if !is_current(shared, &frontend_id, Some(generation), epoch) {
        return None;
    }
    let active = active.filter(|id| tabs.iter().any(|tab| &tab.id == id));
    let tabs = tabs
        .into_iter()
        .map(|mut tab| {
            tab.active = active.as_deref() == Some(tab.id.as_str());
            tab.focused = native_focus && tab.active;
            tab
        })
        .collect();
    let language = native_focus.then(|| layouts.current()).flatten();
    Some((
        tabs,
        native_focus && active.is_some(),
        language,
        frontend_id,
        generation,
        epoch,
        active,
    ))
}

fn apply_results(
    app: &tauri::AppHandle,
    shared: &Arc<Mutex<Shared>>,
    layouts: &NativeLayouts,
    pending: &mut Option<PendingLayout>,
    results: Vec<(String, DispatchResult)>,
    frontend_id: &str,
    generation: u64,
    epoch: u64,
) {
    for (tab_id, result) in results {
        for diagnostic in result.diagnostics {
            push_shared_diagnostic(
                shared,
                AutomationDiagnostic::error(format_diagnostic(diagnostic)),
            );
        }
        for intent in result.actions {
            match intent.action {
                Action::SetLayout(layout) => {
                    let terminal_state = app.state::<TerminalState>();
                    let Ok(terminals) = terminal_state.0.lock() else {
                        continue;
                    };
                    if !terminals.contains_key(&tab_id) {
                        continue;
                    }
                    let Ok(current) = shared.lock() else {
                        continue;
                    };
                    if !action_context_is_current(&current, frontend_id, generation, epoch, &tab_id)
                        || !layouts.is_main_focused()
                    {
                        continue;
                    }
                    if pending.is_some() {
                        continue;
                    }
                    match layouts.request(&layout) {
                        Ok(Some(hkl)) => {
                            let requested = hkl_string(hkl);
                            drop(current);
                            push_shared_diagnostic(
                                shared,
                                AutomationDiagnostic::info(format!(
                                    "Lua action {} ({}) on tab {} generation {} requested layout {}",
                                    intent.script, intent.event, tab_id, generation, requested
                                )),
                            );
                            *pending = Some(PendingLayout {
                                frontend_id: frontend_id.into(),
                                generation,
                                action_epoch: epoch,
                                tab_id: tab_id.clone(),
                                requested,
                                script: intent.script,
                                event: intent.event,
                                deadline: Instant::now() + ACTION_TIMEOUT,
                            })
                        }
                        Ok(None) => {}
                        Err(error) => {
                            drop(current);
                            push_shared_diagnostic(
                                shared,
                                AutomationDiagnostic::error(format!(
                                    "Lua action {} ({}) on tab {}: {error}",
                                    intent.script, intent.event, tab_id
                                )),
                            );
                        }
                    }
                }
                Action::ApplyPreset(name) => {
                    if let Err(error) = crate::presets::validate_name(&name) {
                        push_shared_diagnostic(
                            shared,
                            AutomationDiagnostic::error(format!(
                                "Lua action {} ({}) on tab {}: {error}",
                                intent.script, intent.event, tab_id
                            )),
                        );
                        continue;
                    }
                    let terminal_state = app.state::<TerminalState>();
                    let Ok(terminals) = terminal_state.0.lock() else {
                        continue;
                    };
                    if !terminals.contains_key(&tab_id) {
                        continue;
                    }
                    let Ok(current) = shared.lock() else {
                        continue;
                    };
                    if !preset_action_context_is_current(
                        &current,
                        frontend_id,
                        generation,
                        epoch,
                        &tab_id,
                    ) {
                        continue;
                    }
                    drop(current);
                    drop(terminals);
                    if let Err(error) = app.emit(
                        "lua-preset-request",
                        LuaPresetRequest {
                            frontend_id: frontend_id.to_owned(),
                            generation,
                            tab_id: tab_id.clone(),
                            name: name.clone(),
                        },
                    ) {
                        push_shared_diagnostic(
                            shared,
                            AutomationDiagnostic::error(format!(
                                "Lua action {} ({}) could not request preset {name}: {error}",
                                intent.script, intent.event
                            )),
                        );
                    }
                }
                Action::RestorePreset { .. } => {
                    push_shared_diagnostic(
                        shared,
                        AutomationDiagnostic::error(format!(
                            "Lua action {} ({}) restore was outside a reload transition",
                            intent.script, intent.event
                        )),
                    );
                }
            }
        }
    }
}

fn is_live_terminal(app: &tauri::AppHandle, tab_id: &str) -> bool {
    let terminal_state = app.state::<TerminalState>();
    terminal_state
        .0
        .lock()
        .is_ok_and(|terminals| terminals.contains_key(tab_id))
}

fn dispatch_language(
    app: &tauri::AppHandle,
    runtime: &mut LuaRuntime,
    shared: &Arc<Mutex<Shared>>,
    layouts: &NativeLayouts,
    tabs: &[TabState],
    pending: &mut Option<PendingLayout>,
    language: &str,
    frontend_id: &str,
    generation: u64,
    epoch: u64,
) {
    let Some(tab) = tabs.iter().find(|tab| tab.active && tab.focused) else {
        return;
    };
    let result = runtime.dispatch(
        tab,
        &InputState {
            current_layout: Some(language.into()),
        },
        RuntimeEvent::InputLanguageChanged {
            layout: language.into(),
        },
    );
    apply_results(
        app,
        shared,
        layouts,
        pending,
        vec![(tab.id.clone(), result)],
        frontend_id,
        generation,
        epoch,
    );
}

fn set_status(
    shared: &Arc<Mutex<Shared>>,
    state: &'static str,
    config_path: Option<String>,
    error: Option<String>,
    diagnostics: Vec<AutomationDiagnostic>,
) {
    if let Ok(mut shared) = shared.lock() {
        shared.status = AutomationStatus {
            state,
            config_path,
            error,
            diagnostics: bounded_diagnostics(diagnostics),
        };
    }
}

fn push_shared_diagnostic(shared: &Arc<Mutex<Shared>>, diagnostic: AutomationDiagnostic) {
    if let Ok(mut shared) = shared.lock() {
        push_diagnostic(&mut shared.status.diagnostics, diagnostic);
    }
}

fn fail_closed(shared: &mut Shared, error: String) {
    shared.action_epoch = shared.action_epoch.wrapping_add(1);
    shared.focused = false;
    for tab in &mut shared.tabs {
        tab.focused = false;
    }
    shared.status.state = "error";
    shared.status.error = Some(error.clone());
    push_diagnostic(
        &mut shared.status.diagnostics,
        AutomationDiagnostic::error(error),
    );
}

fn transition_context_matches(
    shared: &Shared,
    plan: &ReloadPreparation,
    epoch: u64,
    frontend_id: &str,
    token: &str,
) -> bool {
    shared.frontend_id.as_deref() == Some(frontend_id)
        && shared.generation == plan.generation
        && shared.action_epoch == epoch
        && plan.frontend_id == frontend_id
        && plan.token == token
}

fn cleanup_acknowledgement_is_exact(expected: &[&str], received: &[String]) -> bool {
    if expected.len() != received.len() {
        return false;
    }
    let expected = expected
        .iter()
        .copied()
        .collect::<std::collections::HashSet<_>>();
    let received = received
        .iter()
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>();
    expected.len() == received.len() && expected == received
}

fn reload_transition_invalidated(active_epoch: u64, current_epoch: u64, loading: bool) -> bool {
    !loading && active_epoch != current_epoch
}

fn push_diagnostic(
    diagnostics: &mut Vec<AutomationDiagnostic>,
    mut diagnostic: AutomationDiagnostic,
) {
    diagnostic.message = diagnostic
        .message
        .chars()
        .take(MAX_DIAGNOSTIC_CHARS)
        .collect();
    if diagnostics.len() == MAX_DIAGNOSTICS {
        diagnostics.remove(0);
    }
    diagnostics.push(diagnostic);
}

fn bounded_diagnostics(diagnostics: Vec<AutomationDiagnostic>) -> Vec<AutomationDiagnostic> {
    diagnostics
        .into_iter()
        .take(MAX_DIAGNOSTICS)
        .map(|mut diagnostic| {
            diagnostic.message = diagnostic
                .message
                .chars()
                .take(MAX_DIAGNOSTIC_CHARS)
                .collect();
            diagnostic
        })
        .collect()
}

fn render_diagnostics(diagnostics: Vec<Diagnostic>) -> Vec<AutomationDiagnostic> {
    bounded_diagnostics(
        diagnostics
            .into_iter()
            .map(|diagnostic| AutomationDiagnostic::error(format_diagnostic(diagnostic)))
            .collect(),
    )
}

fn format_diagnostic(diagnostic: Diagnostic) -> String {
    let mut prefix = diagnostic.script.unwrap_or_else(|| "Lua".into());
    if let Some(event) = diagnostic.event {
        prefix.push_str(&format!(" ({event})"));
    }
    format!("{prefix}: {}", diagnostic.message)
}

#[derive(Clone)]
struct NativeLayouts {
    #[cfg(windows)]
    root: isize,
    #[cfg(windows)]
    webview: Arc<AtomicIsize>,
    #[cfg(not(windows))]
    _unsupported: bool,
}

impl NativeLayouts {
    fn new(window: &WebviewWindow) -> Result<Self, String> {
        #[cfg(windows)]
        {
            use windows_sys::Win32::{
                Foundation::HWND,
                UI::WindowsAndMessaging::{GetClassNameW, IsChild},
            };
            let root = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
            let webview = Arc::new(AtomicIsize::new(0));
            let target = webview.clone();
            window
                .with_webview(move |platform| {
                    let mut parent = unsafe { std::mem::zeroed() };
                    if unsafe { platform.controller().ParentWindow(&mut parent) }.is_ok()
                        && !parent.0.is_null()
                        && unsafe { IsChild(root as HWND, parent.0 as HWND) } != 0
                    {
                        let mut class = [0u16; 64];
                        let count = unsafe {
                            GetClassNameW(parent.0 as HWND, class.as_mut_ptr(), class.len() as i32)
                        };
                        if count > 0
                            && String::from_utf16_lossy(&class[..count as usize]) == "WRY_WEBVIEW"
                        {
                            target.store(parent.0 as isize, Ordering::Release);
                        }
                    }
                })
                .map_err(|error| error.to_string())?;
            Ok(Self { root, webview })
        }
        #[cfg(not(windows))]
        {
            let _ = window;
            Ok(Self { _unsupported: true })
        }
    }

    fn request(&self, layout: &str) -> Result<Option<isize>, String> {
        #[cfg(windows)]
        {
            use windows_sys::Win32::{
                Foundation::{LPARAM, WPARAM},
                UI::WindowsAndMessaging::{PostMessageW, WM_INPUTLANGCHANGEREQUEST},
            };
            let installed = installed_layouts();
            let requested = layout.trim();
            let hkl = installed
                .into_iter()
                .find(|hkl| {
                    hkl_name(*hkl).eq_ignore_ascii_case(requested)
                        || locale_name(*hkl)
                            .is_some_and(|name| name.eq_ignore_ascii_case(requested))
                })
                .ok_or_else(|| format!("keyboard layout '{layout}' is not installed"))?;
            let Some((focus, _, current)) = self.focused_layout() else {
                return Err(
                    "keyboard layout change requires the focused main terminal window".into(),
                );
            };
            if current == hkl {
                return Ok(None);
            }
            if unsafe { PostMessageW(focus, WM_INPUTLANGCHANGEREQUEST, 0 as WPARAM, hkl as LPARAM) }
                == 0
            {
                return Err(format!(
                    "keyboard layout request failed: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(Some(hkl as isize))
        }
        #[cfg(not(windows))]
        {
            let _ = layout;
            Err("keyboard layout automation is available only on Windows".into())
        }
    }

    fn current(&self) -> Option<String> {
        #[cfg(windows)]
        {
            self.focused_layout().map(|(_, _, hkl)| hkl_name(hkl))
        }
        #[cfg(not(windows))]
        {
            None
        }
    }

    fn is_main_focused(&self) -> bool {
        #[cfg(windows)]
        {
            self.focused_layout().is_some()
        }
        #[cfg(not(windows))]
        {
            false
        }
    }

    #[cfg(windows)]
    fn focused_layout(
        &self,
    ) -> Option<(
        windows_sys::Win32::Foundation::HWND,
        u32,
        windows_sys::Win32::UI::Input::KeyboardAndMouse::HKL,
    )> {
        use std::mem::size_of;
        use windows_sys::Win32::{
            Foundation::HWND,
            UI::{
                Input::KeyboardAndMouse::GetKeyboardLayout,
                WindowsAndMessaging::{
                    GA_ROOT, GUITHREADINFO, GetAncestor, GetForegroundWindow, GetGUIThreadInfo,
                    GetWindowThreadProcessId, IsChild,
                },
            },
        };
        let root = self.root as HWND;
        let target = self.webview.load(Ordering::Acquire) as HWND;
        if root.is_null() || target.is_null() {
            return None;
        }
        let foreground = unsafe { GetForegroundWindow() };
        if foreground.is_null()
            || unsafe { GetAncestor(foreground, GA_ROOT) } != root
            || unsafe { IsChild(root, target) } == 0
        {
            return None;
        }
        let host_thread = unsafe { GetWindowThreadProcessId(target, std::ptr::null_mut()) };
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
        let thread = unsafe { GetWindowThreadProcessId(focus, std::ptr::null_mut()) };
        if thread == 0 {
            return None;
        }
        let hkl = unsafe { GetKeyboardLayout(thread) };
        (!hkl.is_null()).then_some((focus, thread, hkl))
    }
}

#[cfg(windows)]
fn installed_layouts() -> Vec<windows_sys::Win32::UI::Input::KeyboardAndMouse::HKL> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetKeyboardLayoutList;
    let count = unsafe { GetKeyboardLayoutList(0, std::ptr::null_mut()) };
    if count <= 0 {
        return Vec::new();
    }
    let mut layouts = vec![std::ptr::null_mut(); count as usize];
    let actual = unsafe { GetKeyboardLayoutList(count, layouts.as_mut_ptr()) };
    layouts.truncate(actual.max(0) as usize);
    layouts
}

#[cfg(windows)]
fn locale_name(hkl: windows_sys::Win32::UI::Input::KeyboardAndMouse::HKL) -> Option<String> {
    use windows_sys::Win32::Globalization::{GetLocaleInfoW, LOCALE_SNAME};
    let locale = hkl as usize as u32 & 0xFFFF;
    let mut name = [0u16; 85];
    let count =
        unsafe { GetLocaleInfoW(locale, LOCALE_SNAME, name.as_mut_ptr(), name.len() as i32) };
    (count > 1).then(|| String::from_utf16_lossy(&name[..count as usize - 1]))
}

#[cfg(windows)]
fn hkl_name(hkl: windows_sys::Win32::UI::Input::KeyboardAndMouse::HKL) -> String {
    hkl_string(hkl as isize)
}

fn hkl_string(hkl: isize) -> String {
    format!("0x{:08X}", hkl as u32)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::lua_runtime::ActionIntent;

    fn shared_state() -> Shared {
        Shared {
            frontend_id: Some("front-1".into()),
            generation: 5,
            action_epoch: 2,
            active_tab_id: Some("tab-1".into()),
            focused: true,
            tabs: Vec::new(),
            status: AutomationStatus {
                state: "ready",
                config_path: None,
                error: None,
                diagnostics: Vec::new(),
            },
        }
    }

    fn frontend_tab(id: &str) -> FrontendTab {
        FrontendTab {
            id: id.into(),
            title: id.into(),
            process_name: None,
            preset_name: "DEC VT-100 (1978)".into(),
            cursor: FrontendCursor {
                shape: Some("block".into()),
                blink: Some(true),
                visible: true,
            },
        }
    }

    fn frontend_snapshot(
        active_tab_id: Option<&str>,
        focused: bool,
        tabs: &[&str],
    ) -> FrontendSnapshot {
        FrontendSnapshot {
            frontend_id: "front-1".into(),
            generation: 6,
            active_tab_id: active_tab_id.map(str::to_owned),
            focused,
            tabs: tabs.iter().map(|id| frontend_tab(id)).collect(),
        }
    }

    #[test]
    fn rejected_stale_caps_candidate_is_retried_for_same_policy() {
        let context = CapsPolicyContext {
            tab_id: Some("tab-1".into()),
            process_name: Some("nvim.exe".into()),
            enabled: true,
        };
        let mut last = None;

        // A generation-10 candidate can be ignored after generation 11 has
        // already advanced native context. The unchanged semantic policy must
        // remain eligible for publication from the next accepted snapshot.
        assert!(!caps_policy_is_cached(&last, &context, 10));
        cache_caps_policy_candidate(&mut last, context.clone(), 10, false);
        assert!(!caps_policy_is_cached(&last, &context, 11));

        cache_caps_policy_candidate(&mut last, context.clone(), 11, true);
        assert!(caps_policy_is_cached(&last, &context, 11));

        // Native may revoke after this successful generation-11 candidate
        // when a transient context change is accepted. A newer generation
        // retries the unchanged policy; native dedupes if it remains armed.
        assert!(!caps_policy_is_cached(&last, &context, 12));
    }

    #[test]
    fn update_and_action_guards_reject_stale_frontends_and_generations() {
        let state = shared_state();
        assert!(snapshot_is_fresh(&state, "front-1", 6));
        assert!(!snapshot_is_fresh(&state, "old-front", 6));
        assert!(!snapshot_is_fresh(&state, "front-1", 5));

        assert!(action_context_is_current(&state, "front-1", 5, 2, "tab-1"));
        assert!(preset_action_context_is_current(
            &state, "front-1", 5, 2, "tab-1"
        ));
        assert!(!action_context_is_current(
            &state,
            "old-front",
            5,
            2,
            "tab-1"
        ));
        assert!(!action_context_is_current(&state, "front-1", 4, 2, "tab-1"));
        assert!(!action_context_is_current(&state, "front-1", 5, 1, "tab-1"));

        let mut unfocused = shared_state();
        unfocused.focused = false;
        assert!(!action_context_is_current(
            &unfocused, "front-1", 5, 2, "tab-1"
        ));
        assert!(preset_action_context_is_current(
            &unfocused, "front-1", 5, 2, "tab-1"
        ));
        assert!(!preset_action_context_is_current(
            &unfocused,
            "old-front",
            5,
            2,
            "tab-1"
        ));
        assert!(!preset_action_context_is_current(
            &unfocused, "front-1", 4, 2, "tab-1"
        ));
    }

    #[test]
    fn frontend_cursor_visibility_defaults_true_and_preserves_explicit_hidden_state() {
        let snapshot: FrontendSnapshot = serde_json::from_str(
            r#"{"frontendId":"front-1","generation":1,"activeTabId":"tab-1","focused":true,"tabs":[{"id":"tab-1","title":"hx.exe","processName":"hx.exe","presetName":"Saved profile","cursor":{"shape":"bar","blink":false}}]}"#,
        )
        .unwrap();
        assert!(snapshot.tabs[0].cursor.visible);
        let hidden: FrontendSnapshot = serde_json::from_str(
            r#"{"frontendId":"front-1","generation":1,"activeTabId":"tab-1","focused":true,"tabs":[{"id":"tab-1","title":"hx.exe","processName":"hx.exe","presetName":"Saved profile","cursor":{"shape":"bar","blink":false,"visible":false}}]}"#,
        )
        .unwrap();
        assert!(!hidden.tabs[0].cursor.visible);
    }

    #[test]
    fn stale_generation_intent_is_rejected_and_fresh_context_update_reissues_it() {
        let root = std::env::temp_dir().join(format!(
            "scanline-lua-context-test-{}-{}",
            std::process::id(),
            NEXT_FRONTEND_TOKEN.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join("editors")).unwrap();
        fs::create_dir_all(root.join("modules")).unwrap();
        fs::create_dir_all(root.join("palettes")).unwrap();
        fs::write(
            root.join("config.lua"),
            include_str!("../../examples/lua/sterm.lua"),
        )
        .unwrap();
        fs::write(
            root.join("editors/nvim.lua"),
            include_str!("../../examples/lua/editors/nvim.lua"),
        )
        .unwrap();
        fs::write(
            root.join("editors/hx.lua"),
            include_str!("../../examples/lua/editors/hx.lua"),
        )
        .unwrap();
        fs::write(
            root.join("modules/modal_editor.lua"),
            include_str!("../../examples/lua/modules/modal_editor.lua"),
        )
        .unwrap();
        fs::write(
            root.join("palettes/users.lua"),
            include_str!("../../examples/lua/palettes/users.lua"),
        )
        .unwrap();
        let template_snapshot = RuntimeSnapshot::load(&root.join("config.lua")).unwrap();
        assert!(!template_snapshot.wants_input_language_events());
        let mut template_runtime = LuaRuntime::new(template_snapshot);
        let template_tab = TabState {
            id: "template-tab".into(),
            title: "Helix".into(),
            local_process_name: Some("hx.exe".into()),
            preset_name: "DEC VT-100 (1978)".into(),
            cursor_style: CursorStyle {
                shape: CursorShape::Underline,
                blink: Some(false),
                visible: true,
            },
            active: true,
            focused: true,
        };
        assert!(
            template_runtime
                .attach_tab(
                    template_tab.clone(),
                    InputState {
                        current_layout: Some("ru-RU".into()),
                    },
                )
                .actions
                .is_empty()
        );
        assert!(
            template_runtime
                .dispatch(
                    &template_tab,
                    &InputState {
                        current_layout: Some("ru-RU".into()),
                    },
                    RuntimeEvent::ContextUpdated,
                )
                .actions
                .is_empty()
        );
        assert!(!template_runtime.smart_caps_enabled("template-tab"));

        let mut enabled_config = include_str!("../../examples/lua/sterm.lua").to_owned();
        enabled_config.push_str(
            "\nlocal sterm = require 'sterm'\n\
             sterm.use('editors/nvim.lua', { when = { process = { 'vim.exe', 'nvim.exe' } } })\n\
             sterm.use('editors/hx.lua', { when = { process = { 'hx.exe' } } })\n",
        );
        fs::write(root.join("config.lua"), enabled_config).unwrap();
        let snapshot = RuntimeSnapshot::load(&root.join("config.lua")).unwrap();
        let mut runtime = LuaRuntime::new(snapshot);
        let mut tab = TabState {
            id: "tab-1".into(),
            title: "Helix".into(),
            local_process_name: Some("hx.exe".into()),
            preset_name: "DEC VT-100 (1978)".into(),
            cursor_style: CursorStyle {
                shape: CursorShape::Underline,
                blink: Some(false),
                visible: true,
            },
            active: true,
            focused: true,
        };
        let input = InputState {
            current_layout: Some("ru-RU".into()),
        };
        let nvim = runtime.attach_tab(
            TabState {
                id: "nvim-tab".into(),
                title: "Neovim".into(),
                local_process_name: Some("nvim.exe".into()),
                preset_name: "DEC VT-100 (1978)".into(),
                cursor_style: CursorStyle {
                    shape: CursorShape::Block,
                    blink: Some(false),
                    visible: true,
                },
                active: true,
                focused: true,
            },
            input.clone(),
        );
        assert_eq!(nvim.actions[0].action, Action::SetLayout("en-US".into()));
        assert_eq!(nvim.actions[0].script, "editors/nvim.lua");
        assert!(runtime.smart_caps_enabled("nvim-tab"));

        let attached = runtime.attach_tab(tab.clone(), input.clone());
        assert_eq!(
            attached.actions[0].action,
            Action::SetLayout("en-US".into())
        );
        assert!(runtime.smart_caps_enabled("tab-1"));

        let stale = runtime.dispatch(&tab, &input, RuntimeEvent::ContextUpdated);
        assert_eq!(
            stale.actions,
            vec![ActionIntent {
                action: Action::SetLayout("en-US".into()),
                script: "editors/hx.lua".into(),
                event: "context-updated".into(),
            }]
        );
        let mut current = shared_state();
        current.generation = 7;
        current.tabs = vec![tab.clone()];
        assert!(!action_context_is_current(
            &current,
            "front-1",
            6,
            current.action_epoch,
            "tab-1"
        ));

        tab.title = "Helix: file.txt".into();
        let fresh = runtime.dispatch(&tab, &input, RuntimeEvent::ContextUpdated);
        assert_eq!(
            fresh.actions,
            vec![ActionIntent {
                action: Action::SetLayout("en-US".into()),
                script: "editors/hx.lua".into(),
                event: "context-updated".into(),
            }]
        );
        assert!(action_context_is_current(
            &current,
            "front-1",
            current.generation,
            current.action_epoch,
            "tab-1"
        ));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejected_new_context_disarms_previously_accepted_actions() {
        let mut state = shared_state();
        assert!(action_context_is_current(&state, "front-1", 5, 2, "tab-1"));
        assert!(snapshot_is_fresh(&state, "front-1", 6));
        assert!(fail_closed_if_newer(
            &mut state,
            "front-1",
            6,
            "snapshot refers to a closed terminal",
        ));
        assert!(!state.focused);
        assert_eq!(state.action_epoch, 3);
        assert!(!action_context_is_current(&state, "front-1", 5, 2, "tab-1"));

        let mut newer = shared_state();
        newer.frontend_id = Some("new-front".into());
        assert!(!fail_closed_if_newer(
            &mut newer,
            "front-1",
            6,
            "stale frontend snapshot",
        ));
        assert_eq!(newer.status.state, "ready");
    }

    #[test]
    fn closed_background_id_is_filtered_without_poisoning_live_context() {
        let mut snapshot = frontend_snapshot(Some("tab-1"), true, &["tab-1", "closed-tab"]);
        let live = ["tab-1".to_owned()].into_iter().collect();
        normalize_snapshot_to_live_sessions(&mut snapshot, &live);
        assert_eq!(snapshot.tabs.len(), 1);
        assert_eq!(snapshot.tabs[0].id, "tab-1");
        assert_eq!(snapshot.active_tab_id.as_deref(), Some("tab-1"));
        assert!(snapshot.focused);

        let mut state = shared_state();
        state.generation = snapshot.generation;
        assert_eq!(state.action_epoch, 2);
        assert_eq!(state.status.state, "ready");
        assert!(action_context_is_current(&state, "front-1", 6, 2, "tab-1"));
    }

    #[test]
    fn closed_active_id_clears_focus_and_next_live_snapshot_recovers() {
        let live = ["tab-1".to_owned()].into_iter().collect();
        let mut closed_active = frontend_snapshot(Some("closed-tab"), true, &["closed-tab"]);
        normalize_snapshot_to_live_sessions(&mut closed_active, &live);
        assert!(closed_active.tabs.is_empty());
        assert_eq!(closed_active.active_tab_id, None);
        assert!(!closed_active.focused);

        let mut state = shared_state();
        state.generation = closed_active.generation;
        state.active_tab_id = closed_active.active_tab_id;
        state.focused = closed_active.focused;
        assert!(!action_context_is_current(&state, "front-1", 6, 2, "tab-1"));
        assert_eq!(state.status.state, "ready");

        let mut next = frontend_snapshot(Some("tab-1"), true, &["tab-1"]);
        next.generation = 7;
        normalize_snapshot_to_live_sessions(&mut next, &live);
        state.generation = next.generation;
        state.active_tab_id = next.active_tab_id;
        state.focused = next.focused;
        assert_eq!(state.action_epoch, 2);
        assert_eq!(state.status.state, "ready");
        assert!(action_context_is_current(&state, "front-1", 7, 2, "tab-1"));
    }

    #[test]
    fn queue_overflow_epoch_invalidates_automation_until_reload() {
        let shared = Arc::new(Mutex::new(shared_state()));
        let (sender, receiver) = mpsc::sync_channel(1);
        drop(receiver);
        let controller = LuaAutomation {
            app: None,
            shared: shared.clone(),
            sender,
            worker: Mutex::new(None),
        };
        controller.record_error("Lua automation update queue is full".into());
        let state = shared.lock().unwrap();
        assert_eq!(state.action_epoch, 3);
        assert_eq!(state.status.state, "error");
        drop(state);
        assert!(!is_frontend_epoch_ready(&shared, "front-1", 3));
        controller.shutdown();
    }

    #[test]
    fn portable_config_wins_and_missing_config_is_disabled() {
        let root = std::env::temp_dir().join(format!(
            "scanline-lua-test-{}",
            NEXT_FRONTEND_TOKEN.fetch_add(1, Ordering::Relaxed)
        ));
        let exe = root.join("exe");
        let config = root.join("config");
        std::fs::create_dir_all(&exe).unwrap();
        std::fs::create_dir_all(&config).unwrap();
        let portable = exe.join("sterm.lua");
        let app_config = config.join("config.lua");
        std::fs::write(&app_config, "-- app config").unwrap();
        assert_eq!(
            resolve_config_path(Some(&exe), Some(&config)),
            Some(app_config.clone())
        );
        std::fs::write(&portable, "-- portable config").unwrap();
        assert_eq!(
            resolve_config_path(Some(&exe), Some(&config)),
            Some(portable)
        );
        assert_eq!(resolve_config_path(None, None), None);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn managed_settings_splice_preserves_bom_crlf_and_all_unmanaged_bytes() {
        let root = lua_seed_test_root("managed-bytes");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(root.join("palettes")).unwrap();
        let palette_source = include_str!("../../examples/lua/palettes/users.lua");
        fs::write(root.join("palettes/users.lua"), palette_source).unwrap();
        let path = root.join("config.lua");
        let original = concat!(
            "\u{feff}local sterm=require 'sterm'\r\n",
            "local preset = ('DEC ' .. 'VT-100')\r\n",
            "sterm.include('palettes/users.lua')\r\n",
            "-- scanline-term:managed-settings:begin\r\n",
            "-- old GUI settings\r\n",
            "-- scanline-term:managed-settings:end\r\n",
            "return preset\r\n",
        );
        fs::write(&path, original.as_bytes()).unwrap();
        let prefix = "\u{feff}local sterm=require 'sterm'\r\nlocal preset = ('DEC ' .. 'VT-100')\r\nsterm.include('palettes/users.lua')\r\n";
        let suffix = "return preset\r\n";
        let candidate = splice_managed_settings(
            original.as_bytes(),
            &ManagedSettingsPayload {
                default_preset: Some("DEC VT-100".into()),
                smooth_scrollback: Some(false),
            },
        )
        .unwrap();
        let candidate_text = std::str::from_utf8(&candidate).unwrap();
        assert!(candidate_text.starts_with(prefix));
        assert!(candidate_text.ends_with(suffix));
        assert!(candidate_text.contains("\r\n"));
        assert!(!candidate_text.contains("-- old GUI settings"));
        let snapshot = RuntimeSnapshot::load_source(&path, candidate_text).unwrap();
        assert_eq!(
            snapshot.settings(),
            Some(&ManagedSettings {
                default_preset: Some("DEC VT-100".into()),
                smooth_scrollback: Some(false),
            })
        );
        assert_eq!(snapshot.ansi_palettes()[0].label, "User's");
        assert_eq!(
            fs::read(root.join("palettes/users.lua")).unwrap(),
            palette_source.as_bytes()
        );
        let original_snapshot = RuntimeSnapshot::load_source(&path, original).unwrap();
        let result = managed_settings_result(
            &path,
            original.as_bytes(),
            original_snapshot.settings(),
            original_snapshot.ansi_palettes(),
        );
        assert!(!result.has_settings);
        assert_eq!(result.palettes[0].id, "lua:users");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn managed_settings_missing_block_inserts_after_bom_and_shebang() {
        let source =
            b"\xEF\xBB\xBF#!/usr/bin/env lua\r\nlocal sterm=require 'sterm'\r\nreturn true\r\n";
        let candidate = splice_managed_settings(
            source,
            &ManagedSettingsPayload {
                default_preset: None,
                smooth_scrollback: Some(true),
            },
        )
        .unwrap();
        assert!(candidate.starts_with(b"\xEF\xBB\xBF#!/usr/bin/env lua\r\n"));
        let text = std::str::from_utf8(&candidate).unwrap();
        assert!(text.contains("-- scanline-term:managed-settings:begin\r\n"));
        assert!(text.ends_with("local sterm=require 'sterm'\r\nreturn true\r\n"));
    }

    #[test]
    fn malformed_managed_markers_and_stale_revisions_fail_without_overwriting() {
        for source in [
            b"-- scanline-term:managed-settings:begin\n".as_slice(),
            b"-- scanline-term:managed-settings:end\n-- scanline-term:managed-settings:begin\n",
            b"-- scanline-term:managed-settings:begin\n-- scanline-term:managed-settings:begin\n-- scanline-term:managed-settings:end\n",
            b"local marker='-- scanline-term:managed-settings:begin'\n",
        ] {
            assert!(splice_managed_settings(source, &ManagedSettingsPayload::default()).is_err());
        }

        let root = lua_seed_test_root("managed-malformed");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("config.lua");
        let malformed = b"-- scanline-term:managed-settings:begin\nuser bytes";
        fs::write(&path, malformed).unwrap();
        assert!(splice_managed_settings(malformed, &ManagedSettingsPayload::default()).is_err());
        assert_eq!(fs::read(&path).unwrap(), malformed);
        fs::remove_dir_all(root).unwrap();

        let root = lua_seed_test_root("managed-conflict");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("config.lua");
        let loaded = b"-- loaded bytes";
        fs::write(&path, loaded).unwrap();
        fs::write(&path, b"-- external edit").unwrap();
        assert!(commit_managed_config(&path, loaded, b"-- candidate").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"-- external edit");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_atomic_replacement_keeps_the_original_config() {
        let root = lua_seed_test_root("managed-atomic-failure");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("config.lua");
        let missing = root.join("missing.tmp");
        fs::write(&path, b"-- original").unwrap();
        assert!(replace_managed_file(&missing, &path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"-- original");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn generated_lua_string_literals_escape_quotes_and_backslashes() {
        let lua = mlua::Lua::new();
        let value = "a \"quoted\" \\ path";
        let literal = lua_string_literal(value);
        assert_eq!(
            lua.load(format!("return {literal}"))
                .eval::<String>()
                .unwrap(),
            value
        );
    }

    fn lua_seed_test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "scanline-lua-seed-{label}-{}-{}",
            std::process::id(),
            NEXT_FRONTEND_TOKEN.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn write_lua_seed_sources(directory: &Path) {
        fs::create_dir_all(directory.join("editors")).unwrap();
        fs::create_dir_all(directory.join("modules")).unwrap();
        fs::create_dir_all(directory.join("scripts")).unwrap();
        fs::create_dir_all(directory.join("palettes")).unwrap();
        fs::write(
            directory.join("sterm.lua"),
            include_str!("../../examples/lua/sterm.lua"),
        )
        .unwrap();
        fs::write(
            directory.join("editors/nvim.lua"),
            include_str!("../../examples/lua/editors/nvim.lua"),
        )
        .unwrap();
        fs::write(
            directory.join("editors/hx.lua"),
            include_str!("../../examples/lua/editors/hx.lua"),
        )
        .unwrap();
        fs::write(
            directory.join("modules/modal_editor.lua"),
            include_str!("../../examples/lua/modules/modal_editor.lua"),
        )
        .unwrap();
        fs::write(
            directory.join("scripts/far_preset.lua"),
            include_str!("../../examples/lua/scripts/far_preset.lua"),
        )
        .unwrap();
        fs::write(
            directory.join("palettes/users.lua"),
            include_str!("../../examples/lua/palettes/users.lua"),
        )
        .unwrap();
    }

    #[test]
    fn first_launch_seeds_valid_full_config_tree_without_activating_examples() {
        let root = lua_seed_test_root("fresh");
        let source = root.join("source");
        let config = root.join("profile");
        write_lua_seed_sources(&source);

        seed_lua_config(None, Some(&config), Some(&source)).unwrap();

        let snapshot = RuntimeSnapshot::load(&config.join("config.lua")).unwrap();
        assert!(snapshot.settings().is_none());
        assert_eq!(snapshot.ansi_palettes()[0].label, "User's");

        assert_eq!(
            fs::read(config.join("config.lua")).unwrap(),
            fs::read(source.join("sterm.lua")).unwrap()
        );
        for relative in [
            "editors/nvim.lua",
            "editors/hx.lua",
            "modules/modal_editor.lua",
            "scripts/far_preset.lua",
            "palettes/users.lua",
        ] {
            assert_eq!(
                fs::read(config.join(relative)).unwrap(),
                fs::read(source.join(relative)).unwrap()
            );
        }
        let snapshot = RuntimeSnapshot::load(&config.join("config.lua")).unwrap();
        assert!(!snapshot.wants_input_language_events());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn existing_config_or_dependency_is_never_overwritten() {
        let root = lua_seed_test_root("preserve");
        let source = root.join("source");
        let config = root.join("profile");
        write_lua_seed_sources(&source);
        fs::create_dir_all(config.join("editors")).unwrap();
        let custom_dependency = b"-- user's editor script\n";
        fs::write(config.join("editors/nvim.lua"), custom_dependency).unwrap();

        seed_lua_config(None, Some(&config), Some(&source)).unwrap();
        assert_eq!(
            fs::read(config.join("editors/nvim.lua")).unwrap(),
            custom_dependency
        );
        assert!(config.join("config.lua").is_file());

        let entry_before = fs::read(config.join("config.lua")).unwrap();
        let custom_config = b"-- existing user config\n";
        fs::write(config.join("config.lua"), custom_config).unwrap();
        seed_lua_config(None, Some(&config), Some(&source)).unwrap();
        assert_eq!(fs::read(config.join("config.lua")).unwrap(), custom_config);
        assert_eq!(entry_before, fs::read(source.join("sterm.lua")).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_or_conflicting_starter_fails_before_publishing_entry() {
        let root = lua_seed_test_root("invalid");
        let source = root.join("source");
        let config = root.join("profile");
        write_lua_seed_sources(&source);
        fs::write(source.join("sterm.lua"), "local = ! invalid").unwrap();
        assert!(seed_lua_config(None, Some(&config), Some(&source)).is_err());
        assert!(!config.exists());

        write_lua_seed_sources(&source);
        fs::create_dir_all(config.join("editors/nvim.lua")).unwrap();
        assert!(seed_lua_config(None, Some(&config), Some(&source)).is_err());
        assert!(!config.join("config.lua").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn portable_entry_skips_profile_seeding_and_missing_resources_error_cleanly() {
        let root = lua_seed_test_root("portable");
        let exe = root.join("exe");
        let config = root.join("profile");
        fs::create_dir_all(&exe).unwrap();
        fs::write(exe.join("sterm.lua"), "-- portable\n").unwrap();
        seed_lua_config(Some(&exe), Some(&config), None).unwrap();
        assert!(!config.exists());

        let no_portable_config = root.join("other-profile");
        assert!(seed_lua_config(None, Some(&no_portable_config), None).is_err());
        assert!(!no_portable_config.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn layout_acknowledgement_uses_resolved_hkl_not_locale_alias() {
        assert!(layout_acknowledged(Some("0x00000419"), "0x00000419"));
        assert!(!layout_acknowledged(Some("en-US"), "0x00000409"));
        assert!(!layout_acknowledged(None, "0x00000409"));
    }

    #[test]
    fn status_diagnostics_serialize_their_explicit_severity() {
        let status = AutomationStatus {
            state: "ready",
            config_path: None,
            error: None,
            diagnostics: vec![
                AutomationDiagnostic::info("layout requested"),
                AutomationDiagnostic::error("callback failed"),
            ],
        };
        let value = serde_json::to_value(status).unwrap();
        assert_eq!(value["diagnostics"][0]["level"], "info");
        assert_eq!(value["diagnostics"][0]["message"], "layout requested");
        assert_eq!(value["diagnostics"][1]["level"], "error");
        assert_eq!(value["diagnostics"][1]["message"], "callback failed");
    }

    #[test]
    fn reload_commit_is_bound_to_frontend_token_generation_and_epoch() {
        let shared = Shared {
            frontend_id: Some("frontend-1".into()),
            generation: 7,
            action_epoch: 11,
            active_tab_id: None,
            focused: false,
            tabs: Vec::new(),
            status: AutomationStatus {
                state: "loading",
                config_path: None,
                error: None,
                diagnostics: Vec::new(),
            },
        };
        let plan = ReloadPreparation {
            token: "reload-1".into(),
            frontend_id: "frontend-1".into(),
            generation: 7,
            cleanup: Vec::new(),
            palettes: Some(Vec::new()),
            candidate_status: "ready",
            error: None,
        };
        assert!(transition_context_matches(
            &shared,
            &plan,
            11,
            "frontend-1",
            "reload-1"
        ));
        assert!(!transition_context_matches(
            &shared,
            &plan,
            11,
            "frontend-2",
            "reload-1"
        ));
        assert!(!transition_context_matches(
            &shared,
            &plan,
            11,
            "frontend-1",
            "stale-token"
        ));
        assert!(!transition_context_matches(
            &shared,
            &plan,
            10,
            "frontend-1",
            "reload-1"
        ));
    }

    #[test]
    fn cleanup_ack_requires_every_unique_known_id() {
        assert!(cleanup_acknowledgement_is_exact(
            &["reload:0", "reload:1"],
            &["reload:1".into(), "reload:0".into()]
        ));
        assert!(!cleanup_acknowledgement_is_exact(
            &["reload:0", "reload:1"],
            &["reload:0".into()]
        ));
        assert!(!cleanup_acknowledgement_is_exact(
            &["reload:0", "reload:1"],
            &["reload:0".into(), "reload:0".into()]
        ));
        assert!(!cleanup_acknowledgement_is_exact(
            &["reload:0"],
            &["reload:other".into()]
        ));
    }

    #[test]
    fn epoch_failure_cancels_a_prepared_transition_unless_it_is_loading() {
        assert!(reload_transition_invalidated(4, 5, false));
        assert!(!reload_transition_invalidated(4, 5, true));
        assert!(!reload_transition_invalidated(4, 4, false));
    }
}
