//! Native controller for the optional Lua event runtime.

use std::{
    collections::HashMap,
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
use tauri::{Manager, State, WebviewWindow};

use crate::{
    TerminalState,
    lua_runtime::{
        Action, CursorShape, CursorStyle, Diagnostic, DispatchResult, InputState, LuaRuntime,
        RuntimeEvent, RuntimeSnapshot, TabState,
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

static NEXT_FRONTEND_TOKEN: AtomicU64 = AtomicU64::new(1);

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
    diagnostics: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartResult {
    frontend_id: String,
    #[serde(flatten)]
    status: AutomationStatus,
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
    Reload {
        epoch: u64,
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

pub struct LuaAutomation {
    shared: Arc<Mutex<Shared>>,
    sender: SyncSender<Work>,
    worker: Mutex<Option<JoinHandle<()>>>,
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
                diagnostics: vec![error],
            },
        }));
        let (sender, receiver) = mpsc::sync_channel(QUEUE_CAPACITY);
        drop(receiver);
        Self {
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
                )
            })
            .map_err(|error| format!("could not start Lua automation worker: {error}"))?;
        let automation = Self {
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

    fn record_error(&self, error: String) {
        if let Ok(mut shared) = self.shared.lock() {
            fail_closed(&mut shared, error);
        }
    }

    fn reject_snapshot(&self, snapshot: &FrontendSnapshot, error: &str) {
        if let Ok(mut shared) = self.shared.lock() {
            fail_closed_if_newer(
                &mut shared,
                &snapshot.frontend_id,
                snapshot.generation,
                error,
            );
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

    fn reload(&self) -> Result<AutomationStatus, String> {
        let epoch = {
            let mut shared = self
                .shared
                .lock()
                .map_err(|_| "Lua automation state is unavailable")?;
            shared.action_epoch = shared.action_epoch.wrapping_add(1);
            shared.status.state = "loading";
            shared.status.error = None;
            shared.action_epoch
        };
        self.enqueue(
            Work::Reload { epoch },
            "Lua automation reload queue is full",
        )?;
        Ok(self.status())
    }
}

impl Drop for LuaAutomation {
    fn drop(&mut self) {
        self.shutdown();
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
    automation.update(snapshot, &terminals)
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
pub fn lua_automation_reload(
    window: WebviewWindow,
    automation: State<'_, LuaAutomation>,
) -> Result<AutomationStatus, String> {
    require_main(&window)?;
    automation.reload()
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
) {
    let mut runtime: Option<LuaRuntime> = None;
    let mut previous: HashMap<String, TabState> = HashMap::new();
    let mut previous_window_focus = false;
    let mut last_layout = None::<String>;
    let mut pending: Option<PendingLayout> = None;
    loop {
        let timeout = if pending.is_some()
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
                for id in previous.keys() {
                    if let Some(runtime) = runtime.as_mut() {
                        runtime.close_tab(id);
                    }
                }
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
                if !is_frontend_epoch_ready(&shared, &frontend_id, epoch) {
                    continue;
                }
                pending = None;
                let Some(runtime) = runtime.as_mut() else {
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
                    if let Some(tab) = tabs.iter().find(|tab| tab.active && tab.focused) {
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
            }
            Ok(Work::Reload { epoch }) => {
                if !is_epoch_current(&shared, epoch) {
                    continue;
                }
                pending = None;
                match resolve_config_path(exe_dir.as_deref(), app_config_dir.as_deref()) {
                    None => {
                        runtime = None;
                        previous.clear();
                        set_status(&shared, "disabled", None, None, Vec::new());
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
                                set_status(
                                    &shared,
                                    "error",
                                    Some(path.display().to_string()),
                                    Some("Lua configuration failed to load".into()),
                                    render_diagnostics(diagnostics),
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
                                    let mut new_runtime = LuaRuntime::new(snapshot);
                                    let dispatches = contexts
                                        .into_iter()
                                        .map(|(tab, input)| new_runtime.attach_tab(tab, input))
                                        .collect();
                                    runtime = Some(new_runtime);
                                    dispatches
                                };
                                let results =
                                    tab_ids.into_iter().zip(dispatches).collect::<Vec<_>>();
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
                                }
                            }
                        }
                    }
                }
            }
            Ok(Work::Shutdown) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {
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
                            format!(
                                "Lua action {} ({}) on tab {} generation {} observed layout {}",
                                action.script,
                                action.event,
                                action.tab_id,
                                action.generation,
                                action.requested
                            ),
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
                            format!(
                                "Keyboard layout change to {} was not observed before timeout",
                                action.requested
                            ),
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
}

fn resolve_config_path(exe_dir: Option<&Path>, app_config_dir: Option<&Path>) -> Option<PathBuf> {
    let portable = exe_dir.map(|dir| dir.join("sterm.lua"));
    if portable.as_ref().is_some_and(|path| path.is_file()) {
        return portable;
    }
    let appdata = app_config_dir.map(|dir| dir.join("config.lua"));
    appdata.filter(|path| path.is_file())
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
            push_shared_diagnostic(shared, format_diagnostic(diagnostic));
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
                                format!(
                                    "Lua action {} ({}) on tab {} generation {} requested layout {}",
                                    intent.script, intent.event, tab_id, generation, requested
                                ),
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
                                format!(
                                    "Lua action {} ({}) on tab {}: {error}",
                                    intent.script, intent.event, tab_id
                                ),
                            );
                        }
                    }
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
    diagnostics: Vec<String>,
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

fn push_shared_diagnostic(shared: &Arc<Mutex<Shared>>, diagnostic: String) {
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
    push_diagnostic(&mut shared.status.diagnostics, error);
}

fn push_diagnostic(diagnostics: &mut Vec<String>, diagnostic: String) {
    let diagnostic: String = diagnostic.chars().take(MAX_DIAGNOSTIC_CHARS).collect();
    if diagnostics.len() == MAX_DIAGNOSTICS {
        diagnostics.remove(0);
    }
    diagnostics.push(diagnostic);
}

fn bounded_diagnostics(diagnostics: Vec<String>) -> Vec<String> {
    diagnostics
        .into_iter()
        .take(MAX_DIAGNOSTICS)
        .map(|text| text.chars().take(MAX_DIAGNOSTIC_CHARS).collect())
        .collect()
}

fn render_diagnostics(diagnostics: Vec<Diagnostic>) -> Vec<String> {
    bounded_diagnostics(diagnostics.into_iter().map(format_diagnostic).collect())
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
    fn update_and_action_guards_reject_stale_frontends_and_generations() {
        let state = shared_state();
        assert!(snapshot_is_fresh(&state, "front-1", 6));
        assert!(!snapshot_is_fresh(&state, "old-front", 6));
        assert!(!snapshot_is_fresh(&state, "front-1", 5));

        assert!(action_context_is_current(&state, "front-1", 5, 2, "tab-1"));
        assert!(!action_context_is_current(
            &state,
            "old-front",
            5,
            2,
            "tab-1"
        ));
        assert!(!action_context_is_current(&state, "front-1", 4, 2, "tab-1"));
        assert!(!action_context_is_current(&state, "front-1", 5, 1, "tab-1"));
    }

    #[test]
    fn frontend_cursor_visibility_defaults_true_and_preserves_explicit_hidden_state() {
        let snapshot: FrontendSnapshot = serde_json::from_str(
            r#"{"frontendId":"front-1","generation":1,"activeTabId":"tab-1","focused":true,"tabs":[{"id":"tab-1","title":"hx.exe","processName":"hx.exe","cursor":{"shape":"bar","blink":false}}]}"#,
        )
        .unwrap();
        assert!(snapshot.tabs[0].cursor.visible);
        let hidden: FrontendSnapshot = serde_json::from_str(
            r#"{"frontendId":"front-1","generation":1,"activeTabId":"tab-1","focused":true,"tabs":[{"id":"tab-1","title":"hx.exe","processName":"hx.exe","cursor":{"shape":"bar","blink":false,"visible":false}}]}"#,
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
        fs::create_dir_all(root.join("scripts")).unwrap();
        fs::write(
            root.join("config.lua"),
            include_str!("../../examples/lua/sterm.lua"),
        )
        .unwrap();
        fs::write(
            root.join("scripts/modal-layout.lua"),
            include_str!("../../examples/lua/scripts/modal-layout.lua"),
        )
        .unwrap();
        let snapshot = RuntimeSnapshot::load(&root.join("config.lua")).unwrap();
        let mut runtime = LuaRuntime::new(snapshot);
        let mut tab = TabState {
            id: "tab-1".into(),
            title: "Helix".into(),
            local_process_name: Some("hx.exe".into()),
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
        let attached = runtime.attach_tab(tab.clone(), input.clone());
        assert_eq!(
            attached.actions[0].action,
            Action::SetLayout("en-US".into())
        );

        let stale = runtime.dispatch(&tab, &input, RuntimeEvent::ContextUpdated);
        assert_eq!(
            stale.actions,
            vec![ActionIntent {
                action: Action::SetLayout("en-US".into()),
                script: "scripts/modal-layout.lua".into(),
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
                script: "scripts/modal-layout.lua".into(),
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
    fn layout_acknowledgement_uses_resolved_hkl_not_locale_alias() {
        assert!(layout_acknowledged(Some("0x00000419"), "0x00000419"));
        assert!(!layout_acknowledged(Some("en-US"), "0x00000409"));
        assert!(!layout_acknowledged(None, "0x00000409"));
    }
}
