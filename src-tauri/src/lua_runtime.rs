//! Sandboxed, tab-local Lua event scripts. The controller owns this runtime on
//! its bounded worker and applies returned actions after checking its generation.

use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use mlua::{Function, HookTriggers, Lua, LuaOptions, StdLib, Table, Value, VmState};
use serde_json::{Map as JsonMap, Number as JsonNumber, Value as JsonValue};

pub const MAX_CONFIG_BYTES: usize = 256 * 1024;
const MAX_SCRIPT_BYTES: usize = 256 * 1024;
const MAX_ATTACHMENTS: usize = 64;
const MAX_MODULES: usize = 64;
const MAX_CONFIG_INCLUDES: usize = 64;
const MAX_ANSI_PALETTES: usize = 64;
const MAX_CUSTOM_SHELLS: usize = 64;
const MAX_CONFIG_INCLUDE_DEPTH: usize = 16;
const MAX_TOTAL_SCRIPT_BYTES: usize = 2 * 1024 * 1024;
const MAX_SCRIPT_INSTANCES: usize = 64;
const MAX_HANDLERS_PER_VM: usize = 128;
const MAX_ACTIONS_PER_CALLBACK: usize = 16;
const MAX_MEMORY_BYTES: usize = 2 * 1024 * 1024;
const MAX_INSTRUCTIONS: u64 = 1_000_000;
const MAX_EXECUTION_TIME: Duration = Duration::from_millis(50);
const HOOK_INSTRUCTION_INTERVAL: u32 = 1_000;
const MAX_VALUE_DEPTH: usize = 16;
const MAX_VALUE_ITEMS: usize = 1_024;
const MAX_STATE_KEY_BYTES: usize = 64;
const MAX_STATE_VALUE_BYTES: usize = 4_096;
const MAX_STATE_KEYS: usize = 32;
const MAX_STATE_SCOPE_BYTES: usize = 16 * 1024;
const MAX_STATE_TOTAL_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CursorStyle {
    pub shape: CursorShape,
    pub blink: Option<bool>,
    pub visible: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CursorShape {
    Block,
    Underline,
    Bar,
    Unknown,
    None,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TabState {
    pub id: String,
    pub title: String,
    pub local_process_name: Option<String>,
    pub process_names: Vec<String>,
    pub preset_name: String,
    pub cursor_style: CursorStyle,
    pub active: bool,
    pub focused: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InputState {
    pub current_layout: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RuntimeEvent {
    TabCreated,
    TabActivated,
    TabDeactivated,
    TabTitleChanged {
        old_title: String,
        new_title: String,
    },
    LocalProcessChanged {
        old_process: Option<String>,
        new_process: Option<String>,
    },
    CursorStyleChanged {
        old_cursor: CursorStyle,
        new_cursor: CursorStyle,
    },
    ContextUpdated,
    TabFocusChanged {
        focused: bool,
    },
    WindowFocusChanged {
        focused: bool,
    },
    InputLanguageChanged {
        layout: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    SetLayout(String),
    ApplyPreset(String),
    SetWindowPosition(i32, i32),
    SetWindowSize(u32, u32),
    SetPanelVisibility(String, bool),
    RestorePreset {
        name: String,
        expected_current: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActionIntent {
    pub action: Action,
    pub script: String,
    pub event: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostic {
    pub script: Option<String>,
    pub event: Option<String>,
    pub message: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DispatchResult {
    pub actions: Vec<ActionIntent>,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReloadCleanup {
    pub tab_id: String,
    pub attachment_key: String,
    pub name: String,
    pub expected_current_preset: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReloadDispatchResult {
    pub cleanup: Vec<ReloadCleanup>,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Clone)]
struct Attachment {
    state_key: String,
    source_name: String,
    source: Arc<str>,
    process_matches: Option<Vec<String>>,
    options: JsonValue,
    events: HashSet<String>,
}

#[derive(Clone, Debug, PartialEq)]
enum ScenarioValue {
    Boolean(bool),
    Integer(i64),
    Number(f64),
    String(String),
}

#[derive(Clone, Debug, Default)]
pub struct ScenarioStateStore(
    Arc<Mutex<HashMap<(String, String), HashMap<String, ScenarioValue>>>>,
);

impl ScenarioStateStore {
    pub fn clear_tab(&self, tab_id: &str) {
        if let Ok(mut state) = self.0.lock() {
            state.retain(|(id, _), _| id != tab_id);
        }
    }

    pub fn clear_all(&self) {
        if let Ok(mut state) = self.0.lock() {
            state.clear();
        }
    }

    pub(crate) fn retain(&self, tabs: &HashSet<String>, attachments: &HashSet<String>) {
        if let Ok(mut state) = self.0.lock() {
            state.retain(|(tab, attachment), _| {
                tabs.contains(tab) && attachments.contains(attachment)
            });
        }
    }
}

#[derive(Clone)]
struct LuaModule {
    source_name: String,
    source: Arc<str>,
}

#[derive(Clone, Default)]
struct ConfigRegistrations {
    attachments: Vec<(String, Option<Vec<String>>, JsonValue)>,
    modules: HashMap<String, String>,
    ansi_palettes: Vec<AnsiPalette>,
    custom_shells: Vec<CustomShell>,
    custom_shells_declared: bool,
    settings: Option<ManagedSettings>,
}

#[derive(Default)]
struct ConfigSourceSnapshot {
    sources: HashMap<PathBuf, Arc<str>>,
    total_bytes: usize,
}

#[derive(Default)]
struct ConfigIncludeState {
    active: Vec<PathBuf>,
    loaded: HashSet<PathBuf>,
}

#[derive(Clone)]
struct LuaExecutionBudget {
    started: Instant,
    instructions: Arc<AtomicU64>,
}

impl Default for LuaExecutionBudget {
    fn default() -> Self {
        Self {
            started: Instant::now(),
            instructions: Arc::new(AtomicU64::new(0)),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ManagedSettings {
    pub default_preset: Option<String>,
    pub smooth_scrollback: Option<bool>,
    pub restore_window: Option<bool>,
    pub browser_form_factor: Option<String>,
    pub tab_placement: Option<String>,
    pub hide_tabs_bar: Option<bool>,
    pub hide_tabs_bar_only_if_single_tab: Option<bool>,
    pub global_hotkey_enabled: Option<bool>,
    pub slide_from_top: Option<bool>,
    pub auto_update_enabled: Option<bool>,
    pub settings_scale: Option<f64>,
    pub show_settings_panel: Option<bool>,
    pub show_ai_panel: Option<bool>,
    pub ai_assistant_disabled: Option<bool>,
    pub last_ai_selection: Option<LastAiSelection>,
    pub mcp_enabled: Option<bool>,
    pub mcp_keep_tabs_open: Option<bool>,
    pub default_shell: Option<String>,
    pub explorer_integration_enabled: Option<bool>,
    pub smooth_tui_scrolling: Option<bool>,
    pub rmb_menu_in_term: Option<bool>,
    pub channel_switch_effect: Option<bool>,
    pub settings_version: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LastAiSelection { pub model: String, pub effort: String }

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomShell { pub id: String, pub name: String, pub command: String, pub args: Vec<String> }

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnsiPalette {
    pub id: String,
    pub label: String,
    pub foreground: String,
    pub background: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    pub colors: Vec<String>,
}

/// Immutable source generation. Reload by constructing a new snapshot and then
/// replacing the runtime's current generation on its owning controller worker.
#[derive(Clone)]
pub struct RuntimeSnapshot {
    config_path: PathBuf,
    attachments: Vec<Attachment>,
    modules: HashMap<String, LuaModule>,
    ansi_palettes: Vec<AnsiPalette>,
    custom_shells: Vec<CustomShell>,
    settings: Option<ManagedSettings>,
    wants_input_language_events: bool,
}

struct ScriptInstance {
    source_name: String,
    process_matches: Option<Vec<String>>,
    state_scope: (String, String),
    state_store: ScenarioStateStore,
    lua: Lua,
    handlers: HashMap<String, Vec<Function>>,
    activate_handlers: Vec<Function>,
    deactivate_handlers: Vec<Function>,
    unload_handlers: Vec<Function>,
    active: bool,
    disabled: bool,
    smart_caps: bool,
    unload_called: bool,
    epoch: Arc<AtomicU64>,
}

struct SmartCapsDeclaration {
    enabled: Arc<AtomicBool>,
    initializing: Arc<AtomicBool>,
}

impl SmartCapsDeclaration {
    fn finish(&self) {
        self.initializing.store(false, Ordering::SeqCst);
    }
}

struct TabRuntime {
    scripts: Vec<ScriptInstance>,
}

pub struct LuaRuntime {
    snapshot: RuntimeSnapshot,
    tabs: HashMap<String, TabRuntime>,
    state: ScenarioStateStore,
}

impl RuntimeSnapshot {
    /// Loads the entry file and exactly the `.use()` scripts it declares.
    /// Relative paths are canonicalized under the entry file's directory.
    pub fn load(entry_path: &Path) -> Result<Self, Vec<Diagnostic>> {
        let entry_path = match fs::canonicalize(entry_path) {
            Ok(path) => path,
            Err(error) => {
                return Err(vec![diagnostic(
                    None,
                    None,
                    format!("could not read Lua configuration: {error}"),
                )]);
            }
        };
        let entry_name = entry_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("config.lua")
            .to_owned();
        let entry_source = match read_limited(&entry_path, MAX_CONFIG_BYTES) {
            Ok(source) => Arc::<str>::from(source),
            Err(error) => return Err(vec![diagnostic(Some(entry_name), None, error)]),
        };
        Self::load_source_at(&entry_path, entry_source)
    }

    /// Evaluates a candidate entry with the same bounded registration sandbox as a loaded file.
    pub fn load_source(entry_path: &Path, source: &str) -> Result<Self, Vec<Diagnostic>> {
        if source.len() > MAX_CONFIG_BYTES {
            return Err(vec![diagnostic(None, None, "Lua config is too large")]);
        }
        let entry_path = fs::canonicalize(entry_path).map_err(|error| {
            vec![diagnostic(
                None,
                None,
                format!("could not resolve Lua configuration: {error}"),
            )]
        })?;
        Self::load_source_at(&entry_path, Arc::<str>::from(source))
    }

    fn load_source_at(entry_path: &Path, entry_source: Arc<str>) -> Result<Self, Vec<Diagnostic>> {
        let mut diagnostics = Vec::new();
        let entry_source = entry_source
            .strip_prefix('\u{feff}')
            .map(Arc::<str>::from)
            .unwrap_or(entry_source);
        let Some(root) = entry_path.parent() else {
            return Err(vec![diagnostic(
                None,
                None,
                "Lua configuration has no parent directory",
            )]);
        };
        let entry_name = entry_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("config.lua")
            .to_owned();
        let registration_lua = match new_lua() {
            Ok(lua) => lua,
            Err(error) => return Err(vec![diagnostic(None, None, error.to_string())]),
        };
        let mut source_snapshot = ConfigSourceSnapshot::default();
        source_snapshot.total_bytes = entry_source.len();
        source_snapshot
            .sources
            .insert(entry_path.to_path_buf(), entry_source.clone());
        let source_snapshot = Arc::new(Mutex::new(source_snapshot));
        let registration_budget = LuaExecutionBudget::default();
        let registrations = Arc::new(Mutex::new(ConfigRegistrations::default()));
        if let Err(error) = install_registration_api(
            &registration_lua,
            root,
            registrations.clone(),
            source_snapshot.clone(),
            registration_budget.clone(),
        ) {
            return Err(vec![diagnostic(Some(entry_name), None, error.to_string())]);
        }
        if let Err(error) = execute_limited_with_budget(
            &registration_lua,
            &entry_source,
            &entry_name,
            &registration_budget,
        ) {
            return Err(vec![diagnostic(Some(entry_name), None, error.to_string())]);
        }
        let registrations = match Arc::try_unwrap(registrations) {
            Ok(registrations) => registrations.into_inner().unwrap_or_default(),
            Err(registrations) => registrations
                .lock()
                .map(|items| items.clone())
                .unwrap_or_default(),
        };
        if registrations.attachments.len() > MAX_ATTACHMENTS {
            return Err(vec![diagnostic(
                Some(entry_name),
                None,
                format!("configuration declares more than {MAX_ATTACHMENTS} script attachments"),
            )]);
        }
        if registrations.modules.len() > MAX_MODULES {
            return Err(vec![diagnostic(
                Some(entry_name),
                None,
                format!("configuration declares more than {MAX_MODULES} Lua modules"),
            )]);
        }

        let mut modules = HashMap::with_capacity(registrations.modules.len());
        for (name, relative) in registrations.modules {
            let resolved = match confined_script_path(root, &relative) {
                Ok(path) => path,
                Err(error) => {
                    diagnostics.push(diagnostic(Some(entry_name.clone()), None, error));
                    continue;
                }
            };
            let source_name = relative.replace('\\', "/");
            let source = match snapshot_source(&source_snapshot, &resolved) {
                Ok(source) => source,
                Err(error) => return Err(vec![diagnostic(Some(source_name), None, error)]),
            };
            modules.insert(
                name,
                LuaModule {
                    source_name,
                    source,
                },
            );
        }
        let mut attachments = Vec::with_capacity(registrations.attachments.len());
        let mut attachment_occurrences = HashMap::<(String, Vec<String>), usize>::new();
        for (relative, process_matches, options) in registrations.attachments {
            let resolved = match confined_script_path(root, &relative) {
                Ok(path) => path,
                Err(error) => {
                    diagnostics.push(diagnostic(Some(entry_name.clone()), None, error));
                    continue;
                }
            };
            let source_name = relative.replace('\\', "/");
            let mut identity_processes = process_matches
                .as_deref()
                .unwrap_or_default()
                .iter()
                .map(|name| name.to_ascii_lowercase())
                .collect::<Vec<_>>();
            identity_processes.sort();
            identity_processes.dedup();
            let identity_base = (
                resolved.to_string_lossy().to_ascii_lowercase(),
                identity_processes,
            );
            let occurrence = attachment_occurrences
                .entry(identity_base.clone())
                .or_default();
            let state_key = serde_json::to_string(&(identity_base, *occurrence))
                .expect("attachment identity contains only strings");
            *occurrence += 1;
            if attachments.len() >= MAX_ATTACHMENTS {
                return Err(vec![diagnostic(
                    Some(entry_name),
                    None,
                    format!(
                        "configuration declares more than {MAX_ATTACHMENTS} script attachments"
                    ),
                )]);
            }
            let source = match snapshot_source(&source_snapshot, &resolved) {
                Ok(source) => source,
                Err(error) => return Err(vec![diagnostic(Some(source_name.clone()), None, error)]),
            };
            {
                let options_json = options.clone();
                let options_value = {
                    let lua = match new_lua() {
                        Ok(lua) => lua,
                        Err(error) => {
                            diagnostics.push(diagnostic(
                                Some(source_name.clone()),
                                None,
                                error.to_string(),
                            ));
                            continue;
                        }
                    };
                    match json_to_lua(&lua, &options) {
                        Ok(value) => (lua, value),
                        Err(error) => {
                            diagnostics.push(diagnostic(
                                Some(source_name.clone()),
                                None,
                                error.to_string(),
                            ));
                            continue;
                        }
                    }
                };
                let (lua, options) = options_value;
                let smart_caps = match install_script_api(&lua, &modules) {
                    Ok(smart_caps) => smart_caps,
                    Err(error) => {
                        diagnostics.push(diagnostic(
                            Some(source_name.clone()),
                            None,
                            error.to_string(),
                        ));
                        continue;
                    }
                };
                if let Err(error) = execute_limited_with_args(&lua, &source, &source_name, options)
                {
                    diagnostics.push(diagnostic(
                        Some(source_name.clone()),
                        None,
                        format!("script validation failed: {error}"),
                    ));
                    continue;
                }
                smart_caps.finish();
                let events = lua
                    .globals()
                    .get::<Table>("__sterm_handlers")
                    .and_then(|table| {
                        table
                            .clone()
                            .pairs::<String, Table>()
                            .map(|pair| pair.map(|(name, _)| name))
                            .collect::<mlua::Result<HashSet<_>>>()
                    })
                    .unwrap_or_default();
                attachments.push(Attachment {
                    state_key,
                    source_name,
                    source,
                    process_matches,
                    options: options_json,
                    events,
                });
            }
        }
        if !diagnostics.is_empty() {
            return Err(diagnostics);
        }
        let wants_input_language_events = attachments
            .iter()
            .any(|attachment| attachment.events.contains("input-language-changed"));
        Ok(Self {
            config_path: entry_path.to_path_buf(),
            attachments,
            modules,
            ansi_palettes: registrations.ansi_palettes,
            custom_shells: registrations.custom_shells,
            settings: registrations.settings,
            wants_input_language_events,
        })
    }

    pub fn settings(&self) -> Option<&ManagedSettings> {
        self.settings.as_ref()
    }

    pub fn ansi_palettes(&self) -> &[AnsiPalette] {
        &self.ansi_palettes
    }

    pub fn custom_shells(&self) -> &[CustomShell] { &self.custom_shells }

    pub fn config_path(&self) -> &Path {
        &self.config_path
    }

    #[cfg(test)]
    pub fn wants_input_language_events(&self) -> bool {
        self.wants_input_language_events
    }

    pub fn attachment_state_keys(&self) -> HashSet<String> {
        self.attachments
            .iter()
            .map(|attachment| attachment.state_key.clone())
            .collect()
    }
}

impl LuaRuntime {
    #[cfg(test)]
    pub fn new(snapshot: RuntimeSnapshot) -> Self {
        Self::with_state_store(snapshot, ScenarioStateStore::default())
    }

    pub fn with_state_store(snapshot: RuntimeSnapshot, state: ScenarioStateStore) -> Self {
        Self {
            snapshot,
            tabs: HashMap::new(),
            state,
        }
    }

    pub fn prepare_removed_attachments(
        &mut self,
        retained_keys: &HashSet<String>,
        contexts: &HashMap<String, (TabState, InputState)>,
    ) -> ReloadDispatchResult {
        let mut result = ReloadDispatchResult::default();
        for (tab_id, runtime) in &mut self.tabs {
            let Some((tab, input)) = contexts.get(tab_id) else {
                continue;
            };
            for script in runtime.scripts.iter_mut().filter(|script| {
                !retained_keys.contains(&script.state_scope.1) && !script.unload_called
            }) {
                script.unload_called = true;
                let mut dispatched = DispatchResult::default();
                Self::run_handlers(script, tab, input, "unload", None, &mut dispatched);
                result.diagnostics.extend(dispatched.diagnostics);
                for intent in dispatched.actions {
                    match intent.action {
                        Action::RestorePreset {
                            name,
                            expected_current,
                        } => {
                            result.cleanup.push(ReloadCleanup {
                                tab_id: tab_id.clone(),
                                attachment_key: script.state_scope.1.clone(),
                                name,
                                expected_current_preset: expected_current,
                            });
                        }
                        _ => result.diagnostics.push(diagnostic(
                            Some(script.source_name.clone()),
                            Some("unload".into()),
                            "on_unload may only request preset restoration",
                        )),
                    }
                }
            }
        }
        result
    }

    pub fn wants_input_language_events(&self) -> bool {
        self.snapshot.wants_input_language_events
    }

    /// Replaces every tab context with fresh per-tab VMs and script state.
    pub fn reload(
        &mut self,
        snapshot: RuntimeSnapshot,
        tabs: impl IntoIterator<Item = (TabState, InputState)>,
    ) -> Vec<DispatchResult> {
        let tabs = tabs.into_iter().collect::<Vec<_>>();
        let tab_ids = tabs
            .iter()
            .map(|(tab, _)| tab.id.clone())
            .collect::<HashSet<_>>();
        let attachment_keys = snapshot
            .attachments
            .iter()
            .map(|attachment| attachment.state_key.clone())
            .collect::<HashSet<_>>();
        self.state.retain(&tab_ids, &attachment_keys);
        self.snapshot = snapshot;
        self.tabs.clear();
        tabs.into_iter()
            .map(|(tab, input)| self.attach_tab(tab, input))
            .collect()
    }

    pub fn attach_tab(&mut self, tab: TabState, input: InputState) -> DispatchResult {
        self.tabs.remove(&tab.id);
        let mut result = DispatchResult::default();
        let possible_instances = self
            .tabs
            .values()
            .map(|runtime| runtime.scripts.len())
            .sum::<usize>()
            + self.snapshot.attachments.len();
        if possible_instances > MAX_SCRIPT_INSTANCES {
            result.diagnostics.push(diagnostic(
                None,
                None,
                format!("Lua script instance limit ({MAX_SCRIPT_INSTANCES}) exceeded"),
            ));
            return result;
        }
        let mut scripts = Vec::new();
        for attachment in &self.snapshot.attachments {
            let lua = match new_lua() {
                Ok(lua) => lua,
                Err(error) => {
                    result.diagnostics.push(diagnostic(
                        Some(attachment.source_name.clone()),
                        None,
                        error.to_string(),
                    ));
                    continue;
                }
            };
            let epoch = Arc::new(AtomicU64::new(1));
            let active = process_matches(
                attachment.process_matches.as_deref(),
                &tab.process_names,
                tab.local_process_name.as_deref(),
            ) && tab.active
                && tab.focused;
            let smart_caps = match install_script_api(&lua, &self.snapshot.modules) {
                Ok(smart_caps) => smart_caps,
                Err(error) => {
                    result.diagnostics.push(diagnostic(
                        Some(attachment.source_name.clone()),
                        None,
                        error.to_string(),
                    ));
                    continue;
                }
            };
            let options = match json_to_lua(&lua, &attachment.options) {
                Ok(value) => value,
                Err(error) => {
                    result.diagnostics.push(diagnostic(
                        Some(attachment.source_name.clone()),
                        None,
                        error.to_string(),
                    ));
                    continue;
                }
            };
            if let Err(error) = execute_limited_with_args(
                &lua,
                &attachment.source,
                &attachment.source_name,
                options,
            ) {
                result.diagnostics.push(diagnostic(
                    Some(attachment.source_name.clone()),
                    None,
                    format!("script initialization failed: {error}"),
                ));
                continue;
            }
            smart_caps.finish();
            let handlers = match lua.globals().get::<Table>("__sterm_handlers") {
                Ok(table) => collect_handlers(&table),
                Err(error) => {
                    result.diagnostics.push(diagnostic(
                        Some(attachment.source_name.clone()),
                        None,
                        error.to_string(),
                    ));
                    continue;
                }
            };
            let (handlers, activate_handlers, deactivate_handlers, unload_handlers) = match handlers
            {
                Ok(handlers) => handlers,
                Err(error) => {
                    result.diagnostics.push(diagnostic(
                        Some(attachment.source_name.clone()),
                        None,
                        error.to_string(),
                    ));
                    continue;
                }
            };
            let mut script = ScriptInstance {
                source_name: attachment.source_name.clone(),
                process_matches: attachment.process_matches.clone(),
                state_scope: (tab.id.clone(), attachment.state_key.clone()),
                state_store: self.state.clone(),
                lua,
                handlers,
                activate_handlers,
                deactivate_handlers,
                unload_handlers,
                active,
                disabled: false,
                smart_caps: smart_caps.enabled.load(Ordering::SeqCst),
                unload_called: false,
                epoch,
            };
            if active {
                Self::run_handlers(&mut script, &tab, &input, "activate", None, &mut result);
            }
            scripts.push(script);
        }
        self.tabs.insert(tab.id, TabRuntime { scripts });
        result
    }

    pub fn dispatch(
        &mut self,
        tab: &TabState,
        input: &InputState,
        event: RuntimeEvent,
    ) -> DispatchResult {
        let Some(runtime) = self.tabs.get_mut(&tab.id) else {
            return DispatchResult::default();
        };
        let mut result = DispatchResult::default();
        let mut event_value = event_to_json(&event);
        if let JsonValue::Object(object) = &mut event_value {
            object.insert("tab".into(), tab_to_json(tab));
        }
        let event_name = event_name(&event);
        for script in &mut runtime.scripts {
            if script.disabled {
                continue;
            }
            let should_be_active = process_matches(
                script.process_matches.as_deref(),
                &tab.process_names,
                tab.local_process_name.as_deref(),
            ) && tab.active
                && tab.focused;
            if should_be_active != script.active {
                script.active = should_be_active;
                let lifecycle = if should_be_active {
                    "activate"
                } else {
                    "deactivate"
                };
                Self::run_handlers(script, tab, input, lifecycle, None, &mut result);
                if script.disabled {
                    continue;
                }
            }
            let preset_context = matches!(&event, RuntimeEvent::ContextUpdated)
                && tab.active
                && process_matches(
                    script.process_matches.as_deref(),
                    &tab.process_names,
                    tab.local_process_name.as_deref(),
                );
            let callback_allowed = script.active
                || preset_context
                || matches!(
                    &event,
                    RuntimeEvent::TabDeactivated
                        | RuntimeEvent::TabFocusChanged { focused: false }
                        | RuntimeEvent::WindowFocusChanged { focused: false }
                );
            if callback_allowed {
                if let Some(handlers) = script.handlers.get(event_name) {
                    for handler in handlers.clone() {
                        Self::run_callback(
                            script,
                            tab,
                            input,
                            &event_value,
                            event_name,
                            handler,
                            preset_context,
                            &mut result,
                        );
                        if script.disabled {
                            break;
                        }
                    }
                }
            }
        }
        result
    }

    pub fn close_tab(&mut self, tab_id: &str) {
        self.tabs.remove(tab_id);
        self.state.clear_tab(tab_id);
    }

    pub fn smart_caps_enabled(&self, tab_id: &str) -> bool {
        self.tabs.get(tab_id).is_some_and(|runtime| {
            runtime
                .scripts
                .iter()
                .any(|script| script.active && !script.disabled && script.smart_caps)
        })
    }

    fn run_handlers(
        script: &mut ScriptInstance,
        tab: &TabState,
        input: &InputState,
        lifecycle: &str,
        event: Option<&JsonValue>,
        result: &mut DispatchResult,
    ) {
        let handlers = if lifecycle == "activate" {
            script.activate_handlers.clone()
        } else if lifecycle == "unload" {
            script.unload_handlers.clone()
        } else {
            script.deactivate_handlers.clone()
        };
        let value = event.cloned().unwrap_or(JsonValue::Null);
        for handler in handlers {
            Self::run_callback(
                script, tab, input, &value, lifecycle, handler, false, result,
            );
            if script.disabled {
                break;
            }
        }
    }

    fn run_callback(
        script: &mut ScriptInstance,
        tab: &TabState,
        input: &InputState,
        event: &JsonValue,
        event_name: &str,
        handler: Function,
        allow_unfocused_preset: bool,
        result: &mut DispatchResult,
    ) {
        let epoch = script.epoch.fetch_add(1, Ordering::SeqCst).wrapping_add(1);
        let pending = Arc::new(Mutex::new(Vec::<Action>::new()));
        let state_writes = Arc::new(Mutex::new(HashMap::new()));
        if let Err(error) = install_context_api(
            &script.lua,
            tab,
            input,
            script.active,
            allow_unfocused_preset,
            script.epoch.clone(),
            epoch,
            pending.clone(),
            script.state_store.clone(),
            script.state_scope.clone(),
            state_writes.clone(),
            event_name == "unload",
        ) {
            result.diagnostics.push(diagnostic(
                Some(script.source_name.clone()),
                Some(event_name.to_owned()),
                error.to_string(),
            ));
            script.disabled = true;
            return;
        }
        let ctx: Table = match script.lua.globals().get("__sterm_ctx") {
            Ok(ctx) => ctx,
            Err(error) => {
                result.diagnostics.push(diagnostic(
                    Some(script.source_name.clone()),
                    Some(event_name.to_owned()),
                    error.to_string(),
                ));
                script.disabled = true;
                return;
            }
        };
        let event_value = match json_to_lua(&script.lua, event) {
            Ok(value) => value,
            Err(error) => {
                result.diagnostics.push(diagnostic(
                    Some(script.source_name.clone()),
                    Some(event_name.to_owned()),
                    error.to_string(),
                ));
                script.disabled = true;
                return;
            }
        };
        if let Err(error) = configure_budget(&script.lua) {
            result.diagnostics.push(diagnostic(
                Some(script.source_name.clone()),
                Some(event_name.to_owned()),
                error.to_string(),
            ));
            script.disabled = true;
            return;
        }
        let start = Instant::now();
        let call = handler.call::<()>((ctx, event_value));
        script.epoch.fetch_add(1, Ordering::SeqCst);
        match call {
            Ok(()) if start.elapsed() <= MAX_EXECUTION_TIME => {
                if event_name != "unload" {
                    if let Err(error) =
                        commit_state_writes(&script.state_store, &script.state_scope, &state_writes)
                    {
                        script.disabled = true;
                        result.diagnostics.push(diagnostic(
                            Some(script.source_name.clone()),
                            Some(event_name.to_owned()),
                            error,
                        ));
                        return;
                    }
                }
                if let Ok(mut actions) = pending.lock() {
                    result
                        .actions
                        .extend(actions.drain(..).map(|action| ActionIntent {
                            action,
                            script: script.source_name.clone(),
                            event: event_name.to_owned(),
                        }));
                }
            }
            Ok(()) => {
                script.disabled = true;
                result.diagnostics.push(diagnostic(
                    Some(script.source_name.clone()),
                    Some(event_name.to_owned()),
                    "callback exceeded wall-clock budget",
                ));
            }
            Err(error) => {
                script.disabled = true;
                result.diagnostics.push(diagnostic(
                    Some(script.source_name.clone()),
                    Some(event_name.to_owned()),
                    error.to_string(),
                ));
            }
        }
    }
}

fn new_lua() -> mlua::Result<Lua> {
    let lua = Lua::new_with(
        StdLib::TABLE | StdLib::STRING | StdLib::MATH | StdLib::UTF8,
        LuaOptions::new(),
    )?;
    lua.set_memory_limit(MAX_MEMORY_BYTES)?;
    for name in [
        "dofile",
        "loadfile",
        "load",
        "collectgarbage",
        "pcall",
        "xpcall",
        "package",
        "io",
        "os",
        "debug",
        "coroutine",
    ] {
        lua.globals().set(name, Value::Nil)?;
    }
    for name in ["match", "gmatch", "gsub", "find", "dump"] {
        lua.globals()
            .get::<Table>("string")?
            .set(name, Value::Nil)?;
    }
    Ok(lua)
}

fn configure_budget(lua: &Lua) -> mlua::Result<()> {
    configure_budget_with(lua, LuaExecutionBudget::default())
}

fn configure_budget_with(lua: &Lua, budget: LuaExecutionBudget) -> mlua::Result<()> {
    lua.set_hook(
        HookTriggers::new().every_nth_instruction(HOOK_INSTRUCTION_INTERVAL),
        move |_, _| {
            let used = budget
                .instructions
                .fetch_add(HOOK_INSTRUCTION_INTERVAL as u64, Ordering::Relaxed)
                + HOOK_INSTRUCTION_INTERVAL as u64;
            if used > MAX_INSTRUCTIONS || budget.started.elapsed() > MAX_EXECUTION_TIME {
                return Err(mlua::Error::RuntimeError(
                    "Lua execution budget exceeded".into(),
                ));
            }
            Ok(VmState::Continue)
        },
    )
}

#[cfg(test)]
fn execute_limited(lua: &Lua, source: &str, name: &str) -> mlua::Result<()> {
    configure_budget(lua)?;
    lua.load(source).set_name(name).exec()
}

fn execute_limited_with_budget(
    lua: &Lua,
    source: &str,
    name: &str,
    budget: &LuaExecutionBudget,
) -> mlua::Result<()> {
    configure_budget_with(lua, budget.clone())?;
    lua.load(source).set_name(name).exec()
}

fn execute_limited_with_args(lua: &Lua, source: &str, name: &str, args: Value) -> mlua::Result<()> {
    configure_budget(lua)?;
    lua.load(source).set_name(name).call(args)
}

fn install_registration_api(
    lua: &Lua,
    config_root: &Path,
    registrations: Arc<Mutex<ConfigRegistrations>>,
    source_snapshot: Arc<Mutex<ConfigSourceSnapshot>>,
    registration_budget: LuaExecutionBudget,
) -> mlua::Result<()> {
    let module = lua.create_table()?;
    module.set("include", {
        let config_root = config_root.to_path_buf();
        let source_snapshot = source_snapshot.clone();
        let registration_budget = registration_budget.clone();
        let include_state = Arc::new(Mutex::new(ConfigIncludeState::default()));
        let include_state_for_fn = include_state.clone();
        lua.create_function(move |lua, path: String| {
            let path = validate_relative_script(&path).map_err(mlua::Error::RuntimeError)?;
            let resolved =
                confined_script_path(&config_root, &path).map_err(mlua::Error::RuntimeError)?;
            let mut include_state = include_state_for_fn.lock().map_err(|_| {
                mlua::Error::RuntimeError("Lua include state is unavailable".into())
            })?;
            if include_state.active.contains(&resolved) {
                return Err(mlua::Error::RuntimeError(format!(
                    "cyclic Lua config include '{path}'"
                )));
            }
            if include_state.loaded.contains(&resolved) {
                return Ok(());
            }
            if include_state.loaded.len() + include_state.active.len() >= MAX_CONFIG_INCLUDES {
                return Err(mlua::Error::RuntimeError(format!(
                    "configuration exceeds the {MAX_CONFIG_INCLUDES}-include limit"
                )));
            }
            if include_state.active.len() >= MAX_CONFIG_INCLUDE_DEPTH {
                return Err(mlua::Error::RuntimeError(format!(
                    "Lua config include depth exceeds {MAX_CONFIG_INCLUDE_DEPTH}"
                )));
            }
            include_state.active.push(resolved.clone());
            drop(include_state);
            let result = (|| {
                let source = snapshot_source(&source_snapshot, &resolved)
                    .map_err(mlua::Error::RuntimeError)?;
                execute_limited_with_budget(lua, &source, &path, &registration_budget).map_err(
                    |error| {
                        mlua::Error::RuntimeError(format!(
                            "included config '{path}' failed: {error}"
                        ))
                    },
                )
            })();
            if let Ok(mut include_state) = include_state_for_fn.lock() {
                include_state.active.pop();
                if result.is_ok() {
                    include_state.loaded.insert(resolved);
                }
            }
            result
        })?
    })?;
    module.set("ansi_palette", {
        let registrations = registrations.clone();
        lua.create_function(move |_, (name, options): (String, Table)| {
            let id = format!("lua:{name}");
            if !valid_module_name(&name) || name == "sterm" || !valid_palette_registration_id(&id) {
                return Err(mlua::Error::RuntimeError(
                    "palette name must be a simple identifier other than 'sterm'".into(),
                ));
            }
            for pair in options.clone().pairs::<Value, Value>() {
                let (key, _) = pair?;
                let Value::String(key) = key else {
                    return Err(mlua::Error::RuntimeError(
                        "sterm.ansi_palette requires named fields".into(),
                    ));
                };
                let key = key.to_str()?.to_owned();
                if !matches!(
                    key.as_str(),
                    "label" | "foreground" | "background" | "cursor" | "colors"
                ) {
                    return Err(mlua::Error::RuntimeError(format!(
                        "unknown sterm.ansi_palette field '{key}'"
                    )));
                }
            }
            let label: String = options
                .get("label")
                .map_err(|_| mlua::Error::RuntimeError("palette label must be a string".into()))?;
            if label.is_empty() || label.len() > 64 {
                return Err(mlua::Error::RuntimeError(
                    "palette label must contain 1 to 64 UTF-8 bytes".into(),
                ));
            }
            let foreground = palette_color(options.get::<String>("foreground").map_err(|_| {
                mlua::Error::RuntimeError("palette foreground must be #RRGGBB".into())
            })?)?;
            let background = palette_color(options.get::<String>("background").map_err(|_| {
                mlua::Error::RuntimeError("palette background must be #RRGGBB".into())
            })?)?;
            let cursor = match options.get::<Value>("cursor")? {
                Value::Nil => None,
                Value::String(value) => Some(palette_color(value.to_str()?.to_owned())?),
                _ => {
                    return Err(mlua::Error::RuntimeError(
                        "palette cursor must be #RRGGBB or omitted".into(),
                    ));
                }
            };
            let values: Table = options.get("colors").map_err(|_| {
                mlua::Error::RuntimeError(
                    "palette colors must contain exactly 16 or 256 #RRGGBB entries".into(),
                )
            })?;
            let count = values.clone().pairs::<Value, Value>().count();
            if !matches!(count, 16 | 256) {
                return Err(mlua::Error::RuntimeError(
                    "palette colors must contain exactly 16 or 256 #RRGGBB entries".into(),
                ));
            }
            let mut colors = Vec::with_capacity(count);
            for index in 1..=count {
                let color = values.get::<String>(index).map_err(|_| {
                    mlua::Error::RuntimeError(
                        "palette colors must be a dense array of #RRGGBB strings".into(),
                    )
                })?;
                colors.push(palette_color(color)?);
            }
            let mut registrations = registrations.lock().map_err(|_| {
                mlua::Error::RuntimeError("Lua registration state is unavailable".into())
            })?;
            if registrations
                .ansi_palettes
                .iter()
                .any(|palette| palette.id == id)
            {
                return Err(mlua::Error::RuntimeError(format!(
                    "ANSI palette '{id}' is already declared"
                )));
            }
            if registrations.ansi_palettes.len() >= MAX_ANSI_PALETTES {
                return Err(mlua::Error::RuntimeError(format!(
                    "configuration exceeds the {MAX_ANSI_PALETTES}-palette limit"
                )));
            }
            registrations.ansi_palettes.push(AnsiPalette {
                id,
                label,
                foreground,
                background,
                cursor,
                colors,
            });
            Ok(())
        })?
    })?;
    module.set("settings", {
        let registrations = registrations.clone();
        lua.create_function(move |_, settings: Table| {
            let mut default_preset = None;
            let mut smooth_scrollback = None;
            let mut restore_window = None;
            macro_rules! bool_field { ($key:literal, $var:ident) => { let $var = match settings.get::<Value>($key)? { Value::Nil => None, Value::Boolean(value) => Some(value), _ => return Err(mlua::Error::RuntimeError(concat!($key, " must be a boolean or nil").into())) }; }; }
            for pair in settings.clone().pairs::<Value, Value>() {
                let (key, _) = pair?;
                let Value::String(key) = key else {
                    return Err(mlua::Error::RuntimeError(
                        "sterm.settings requires named fields".into(),
                    ));
                };
                let key = key.to_str()?.to_owned();
                if !matches!(key.as_str(), "default_preset" | "smooth_scrollback" | "restore_window" | "browser_form_factor" | "tab_placement" | "hide_tabs_bar" | "hide_tabs_bar_only_if_single_tab" | "global_hotkey_enabled" | "slide_from_top" | "auto_update_enabled" | "settings_scale" | "show_settings_panel" | "show_ai_panel" | "ai_assistant_disabled" | "last_ai_selection" | "mcp_enabled" | "mcp_keep_tabs_open" | "default_shell" | "explorer_integration_enabled" | "smooth_tui_scrolling" | "rmb_menu_in_term" | "channel_switch_effect" | "settings_version") {
                    return Err(mlua::Error::RuntimeError(format!(
                        "unknown sterm.settings field '{key}'"
                    )));
                }
            }
            match settings.get::<Value>("default_preset")? {
                Value::Nil => {}
                Value::String(value) => {
                    let name = value.to_str()?.to_owned();
                    crate::presets::validate_name(&name).map_err(mlua::Error::RuntimeError)?;
                    default_preset = Some(name);
                }
                _ => {
                    return Err(mlua::Error::RuntimeError(
                        "default_preset must be a saved preset name or nil".into(),
                    ));
                }
            }
            match settings.get::<Value>("smooth_scrollback")? {
                Value::Nil => {}
                Value::Boolean(value) => smooth_scrollback = Some(value),
                _ => {
                    return Err(mlua::Error::RuntimeError(
                        "smooth_scrollback must be a boolean or nil".into(),
                    ));
                }
            }
            match settings.get::<Value>("restore_window")? {
                Value::Nil => {}
                Value::Boolean(value) => restore_window = Some(value),
                _ => return Err(mlua::Error::RuntimeError("restore_window must be a boolean or nil".into())),
            }
            let browser_form_factor = optional_enum(&settings, "browser_form_factor", &["physical", "4:3", "8:5"])?;
            let tab_placement = optional_enum(&settings, "tab_placement", &["top", "left"])?;
            bool_field!("hide_tabs_bar", hide_tabs_bar); bool_field!("hide_tabs_bar_only_if_single_tab", hide_tabs_bar_only_if_single_tab);
            bool_field!("global_hotkey_enabled", global_hotkey_enabled); bool_field!("slide_from_top", slide_from_top);
            bool_field!("auto_update_enabled", auto_update_enabled); bool_field!("show_settings_panel", show_settings_panel);
            bool_field!("show_ai_panel", show_ai_panel); bool_field!("ai_assistant_disabled", ai_assistant_disabled);
            bool_field!("mcp_enabled", mcp_enabled); bool_field!("mcp_keep_tabs_open", mcp_keep_tabs_open);
            bool_field!("explorer_integration_enabled", explorer_integration_enabled); bool_field!("smooth_tui_scrolling", smooth_tui_scrolling);
            bool_field!("rmb_menu_in_term", rmb_menu_in_term); bool_field!("channel_switch_effect", channel_switch_effect);
            let settings_scale = match settings.get::<Value>("settings_scale")? {
                Value::Nil => None,
                Value::Integer(value) if (0.75..=1.5).contains(&(value as f64)) => Some(value as f64),
                Value::Number(value) if value.is_finite() && (0.75..=1.5).contains(&value) => Some(value),
                _ => return Err(mlua::Error::RuntimeError("settings_scale must be a finite number from 0.75 to 1.5 or nil".into())),
            };
            let default_shell = match settings.get::<Value>("default_shell")? { Value::Nil => None, Value::String(value) => { let value = value.to_str()?.to_owned(); if value.encode_utf16().count() > 1024 || value.contains('\0') { return Err(mlua::Error::RuntimeError("default_shell is invalid or too long".into())); } Some(value) }, _ => return Err(mlua::Error::RuntimeError("default_shell must be a string or nil".into())) };
            let last_ai_selection = match settings.get::<Value>("last_ai_selection")? {
                Value::Nil => None,
                Value::Table(value) => {
                    for pair in value.clone().pairs::<Value, Value>() { let (key, _) = pair?; if !matches!(key, Value::String(ref key) if matches!(key.to_str()?.as_ref(), "model" | "effort")) { return Err(mlua::Error::RuntimeError("last_ai_selection has an unknown field".into())); } }
                    let model = strict_lua_string(&value, "model", "last_ai_selection.model")?;
                    let effort = strict_lua_string(&value, "effort", "last_ai_selection.effort")?;
                    if model.is_empty() || model.encode_utf16().count() > 128 || effort.is_empty() || effort.encode_utf16().count() > 64 { return Err(mlua::Error::RuntimeError("last_ai_selection is invalid".into())); }
                    Some(LastAiSelection { model, effort })
                },
                _ => return Err(mlua::Error::RuntimeError("last_ai_selection must be a table or nil".into()))
            };
            let settings_version = match settings.get::<Value>("settings_version")? { Value::Nil => None, Value::Integer(value) if value == 1 => Some(1), _ => return Err(mlua::Error::RuntimeError("settings_version must be 1 or nil".into())) };
            let mut registrations = registrations.lock().map_err(|_| {
                mlua::Error::RuntimeError("Lua registration state is unavailable".into())
            })?;
            if registrations.settings.is_some() {
                return Err(mlua::Error::RuntimeError(
                    "sterm.settings may only be declared once".into(),
                ));
            }
            registrations.settings = Some(ManagedSettings {
                default_preset,
                smooth_scrollback,
                restore_window,
                browser_form_factor, tab_placement, hide_tabs_bar, hide_tabs_bar_only_if_single_tab,
                global_hotkey_enabled, slide_from_top, auto_update_enabled, settings_scale,
                show_settings_panel, show_ai_panel, ai_assistant_disabled, last_ai_selection,
                mcp_enabled, mcp_keep_tabs_open, default_shell, explorer_integration_enabled,
                smooth_tui_scrolling, rmb_menu_in_term, channel_switch_effect, settings_version,
            });
            Ok(())
        })?
    })?;
    module.set("shells", {
        let registrations = registrations.clone();
        lua.create_function(move |_, shells: Table| {
            let count = shells.clone().pairs::<Value, Value>().count();
            if count > MAX_CUSTOM_SHELLS { return Err(mlua::Error::RuntimeError("too many custom shells".into())); }
            let mut parsed = Vec::with_capacity(count);
            let mut ids = HashSet::new();
            let mut total = 0usize;
            for index in 1..=count {
                let shell: Table = shells.get(index).map_err(|_| mlua::Error::RuntimeError("shells must be a dense array of shell tables".into()))?;
                let mut values = HashMap::new();
                for pair in shell.clone().pairs::<Value, Value>() { let (key, value) = pair?; let Value::String(key) = key else { return Err(mlua::Error::RuntimeError("shell fields must be named".into())); }; values.insert(key.to_str()?.to_owned(), value); }
                if values.keys().any(|key| !matches!(key.as_str(), "id" | "name" | "command" | "args")) { return Err(mlua::Error::RuntimeError("unknown custom shell field".into())); }
                let id = strict_lua_string(&shell, "id", "shell id")?;
                if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') || !ids.insert(id.clone()) { return Err(mlua::Error::RuntimeError("shell id is invalid or duplicated".into())); }
                let name = strict_lua_string(&shell, "name", "shell name")?;
                let command = strict_lua_string(&shell, "command", "shell command")?;
                if name.is_empty() || name.chars().count() > 128 || command.is_empty() || command.chars().count() > 1024 || name.contains('\0') || command.contains('\0') { return Err(mlua::Error::RuntimeError("custom shell name or command is invalid".into())); }
                let mut args = Vec::new();
                match shell.get::<Value>("args")? {
                    Value::Nil => (),
                    Value::Table(table) => { let n = table.clone().pairs::<Value, Value>().count(); if n > 64 { return Err(mlua::Error::RuntimeError("too many custom shell arguments".into())); } for i in 1..=n { let arg = strict_lua_array_string(&table, i)?; if arg.chars().count() > 4096 || arg.contains('\0') { return Err(mlua::Error::RuntimeError("shell argument is invalid or too long".into())); } args.push(arg); } },
                    _ => return Err(mlua::Error::RuntimeError("shell args must be a string array".into())),
                }
                total += id.len() + name.len() + command.len() + args.iter().map(String::len).sum::<usize>();
                if total > 256 * 1024 { return Err(mlua::Error::RuntimeError("custom shell declarations are too large".into())); }
                parsed.push(CustomShell { id: format!("lua:{id}"), name, command, args });
            }
            let mut registrations = registrations.lock().map_err(|_| mlua::Error::RuntimeError("Lua registration state is unavailable".into()))?;
            if registrations.custom_shells_declared { return Err(mlua::Error::RuntimeError("sterm.shells may only be declared once".into())); }
            registrations.custom_shells_declared = true;
            registrations.custom_shells = parsed;
            Ok(())
        })?
    })?;
    module.set("module", {
        let registrations = registrations.clone();
        lua.create_function(move |_, (name, path): (String, String)| {
            if !valid_module_name(&name) || name == "sterm" {
                return Err(mlua::Error::RuntimeError(
                    "module name must be a simple identifier other than 'sterm'".into(),
                ));
            }
            let path = validate_relative_script(&path).map_err(mlua::Error::RuntimeError)?;
            let mut registrations = registrations.lock().map_err(|_| {
                mlua::Error::RuntimeError("Lua registration state is unavailable".into())
            })?;
            if registrations.modules.contains_key(&name) {
                return Err(mlua::Error::RuntimeError(format!(
                    "Lua module '{name}' is already registered"
                )));
            }
            if registrations.modules.len() >= MAX_MODULES {
                return Err(mlua::Error::RuntimeError(format!(
                    "configuration exceeds the {MAX_MODULES}-module limit"
                )));
            }
            registrations.modules.insert(name, path);
            Ok(())
        })?
    })?;
    module.set(
        "use",
        lua.create_function(move |_, (path, options): (String, Option<Table>)| {
            let path = validate_relative_script(&path).map_err(mlua::Error::RuntimeError)?;
            let mut process = None;
            let mut script_options = JsonValue::Object(JsonMap::new());
            if let Some(options) = options {
                for pair in options.clone().pairs::<Value, Value>() {
                    let (key, _) = pair?;
                    if !matches!(key, Value::String(_)) {
                        return Err(mlua::Error::RuntimeError(
                            "sterm.use options require named fields".into(),
                        ));
                    }
                    let key = match key {
                        Value::String(key) => key.to_str()?.to_owned(),
                        _ => unreachable!(),
                    };
                    if key != "when" && key != "options" {
                        return Err(mlua::Error::RuntimeError(format!(
                            "unknown sterm.use field '{key}'"
                        )));
                    }
                }
                if let Some(when) = options.get::<Option<Table>>("when")? {
                    for pair in when.clone().pairs::<Value, Value>() {
                        let (key, _) = pair?;
                        let key = match key {
                            Value::String(key) => key.to_str()?.to_owned(),
                            _ => {
                                return Err(mlua::Error::RuntimeError(
                                    "when requires named fields".into(),
                                ));
                            }
                        };
                        if key != "process" {
                            return Err(mlua::Error::RuntimeError(format!(
                                "unknown when field '{key}'"
                            )));
                        }
                    }
                    if let Some(values) = when.get::<Option<Table>>("process")? {
                        let mut names = Vec::new();
                        for value in values.sequence_values::<String>() {
                            let name = value?;
                            if name.is_empty()
                                || name.contains('/')
                                || name.contains('\\')
                                || name.len() > 128
                            {
                                return Err(mlua::Error::RuntimeError(
                                    "process matches must be executable basenames".into(),
                                ));
                            }
                            names.push(name);
                            if names.len() > 32 {
                                return Err(mlua::Error::RuntimeError(
                                    "process match has too many values".into(),
                                ));
                            }
                        }
                        if names.is_empty() {
                            return Err(mlua::Error::RuntimeError(
                                "when.process must contain at least one process name".into(),
                            ));
                        }
                        process = Some(names);
                    } else {
                        return Err(mlua::Error::RuntimeError("when.process is required".into()));
                    }
                }
                if let Some(value) = options.get::<Option<Value>>("options")? {
                    let mut item_count = 0;
                    script_options = lua_to_json(value, 0, &mut item_count)?;
                    if !script_options.is_object() {
                        return Err(mlua::Error::RuntimeError(
                            "script options must be a table".into(),
                        ));
                    }
                }
            }
            let mut registrations = registrations.lock().map_err(|_| {
                mlua::Error::RuntimeError("Lua registration state is unavailable".into())
            })?;
            if registrations.attachments.len() >= MAX_ATTACHMENTS {
                return Err(mlua::Error::RuntimeError(format!(
                    "configuration exceeds the {MAX_ATTACHMENTS}-attachment limit"
                )));
            }
            registrations
                .attachments
                .push((path, process, script_options));
            Ok(())
        })?,
    )?;
    lua.globals().set("sterm", module.clone())?;
    lua.globals().set(
        "require",
        lua.create_function(move |_, name: String| {
            if name == "sterm" {
                return Ok(module.clone());
            }
            Err(mlua::Error::RuntimeError(
                "only the built-in 'sterm' module is available in configuration".into(),
            ))
        })?,
    )
}

fn install_script_api(
    lua: &Lua,
    modules: &HashMap<String, LuaModule>,
) -> mlua::Result<SmartCapsDeclaration> {
    let handlers = lua.create_table()?;
    lua.globals().set("__sterm_handlers", handlers.clone())?;
    let handler_count = Arc::new(AtomicUsize::new(0));
    let module = lua.create_table()?;
    let smart_caps = Arc::new(AtomicBool::new(false));
    let initializing = Arc::new(AtomicBool::new(true));
    let input = lua.create_table()?;
    input.set("smart_caps", {
        let smart_caps = smart_caps.clone();
        let initializing = initializing.clone();
        lua.create_function(move |_, ()| {
            if !initializing.load(Ordering::SeqCst) {
                return Err(mlua::Error::RuntimeError(
                    "sterm.input.smart_caps() is only available during script initialization"
                        .into(),
                ));
            }
            smart_caps.store(true, Ordering::SeqCst);
            Ok(())
        })?
    })?;
    module.set("input", input)?;
    module.set("on", {
        let handlers = handlers.clone();
        let handler_count = handler_count.clone();
        lua.create_function(move |lua, (name, handler): (String, Function)| {
            if !valid_event_name(&name) {
                return Err(mlua::Error::RuntimeError(format!(
                    "unsupported event '{name}'"
                )));
            }
            if handler_count.fetch_add(1, Ordering::Relaxed) >= MAX_HANDLERS_PER_VM {
                return Err(mlua::Error::RuntimeError(format!(
                    "script exceeds {MAX_HANDLERS_PER_VM} handler registrations"
                )));
            }
            let list = match handlers.get::<Table>(name.as_str()) {
                Ok(list) => list,
                Err(_) => {
                    let list = lua.create_table()?;
                    handlers.set(name.as_str(), list.clone())?;
                    list
                }
            };
            let index = list.raw_len() + 1;
            list.set(index, handler)?;
            Ok(())
        })?
    })?;
    module.set("on_activate", {
        let handlers = handlers.clone();
        let handler_count = handler_count.clone();
        lua.create_function(move |lua, handler: Function| {
            if handler_count.fetch_add(1, Ordering::Relaxed) >= MAX_HANDLERS_PER_VM {
                return Err(mlua::Error::RuntimeError(format!(
                    "script exceeds {MAX_HANDLERS_PER_VM} handler registrations"
                )));
            }
            let list = get_or_create_list(lua, &handlers, "__activate")?;
            list.set(list.raw_len() + 1, handler)?;
            Ok(())
        })?
    })?;
    module.set("on_deactivate", {
        let handlers = handlers.clone();
        let handler_count = handler_count.clone();
        lua.create_function(move |lua, handler: Function| {
            if handler_count.fetch_add(1, Ordering::Relaxed) >= MAX_HANDLERS_PER_VM {
                return Err(mlua::Error::RuntimeError(format!(
                    "script exceeds {MAX_HANDLERS_PER_VM} handler registrations"
                )));
            }
            let list = get_or_create_list(lua, &handlers, "__deactivate")?;
            list.set(list.raw_len() + 1, handler)?;
            Ok(())
        })?
    })?;
    module.set("on_unload", {
        let handlers = handlers.clone();
        let handler_count = handler_count.clone();
        lua.create_function(move |lua, handler: Function| {
            if handler_count.fetch_add(1, Ordering::Relaxed) >= MAX_HANDLERS_PER_VM {
                return Err(mlua::Error::RuntimeError(format!(
                    "script exceeds {MAX_HANDLERS_PER_VM} handler registrations"
                )));
            }
            let list = get_or_create_list(lua, &handlers, "__unload")?;
            if list.raw_len() > 0 {
                return Err(mlua::Error::RuntimeError(
                    "a script may register only one on_unload callback".into(),
                ));
            }
            list.set(list.raw_len() + 1, handler)?;
            Ok(())
        })?
    })?;
    lua.globals().set("sterm", module.clone())?;
    let module_cache = lua.create_table()?;
    let modules_loading = lua.create_table()?;
    let modules = modules.clone();
    lua.globals().set(
        "require",
        lua.create_function(move |lua, name: String| {
            if name == "sterm" {
                return Ok(Value::Table(module.clone()));
            }
            let cached = module_cache.get::<Value>(name.as_str())?;
            if !matches!(cached, Value::Nil) {
                return Ok(cached);
            }
            if !matches!(modules_loading.get::<Value>(name.as_str())?, Value::Nil) {
                return Err(mlua::Error::RuntimeError(format!(
                    "cyclic Lua module dependency involving '{name}'"
                )));
            }
            let source = modules.get(&name).ok_or_else(|| {
                mlua::Error::RuntimeError(format!(
                    "Lua module '{name}' is not registered in the trusted configuration"
                ))
            })?;
            modules_loading.set(name.as_str(), true)?;
            let loaded = lua
                .load(source.source.as_ref())
                .set_name(source.source_name.as_str())
                .eval::<Value>();
            modules_loading.set(name.as_str(), Value::Nil)?;
            let value = loaded?;
            let value = if matches!(value, Value::Nil) {
                Value::Boolean(true)
            } else {
                value
            };
            module_cache.set(name.as_str(), value.clone())?;
            Ok(value)
        })?,
    )?;
    Ok(SmartCapsDeclaration {
        enabled: smart_caps,
        initializing,
    })
}

fn strict_lua_string(table: &Table, key: &str, label: &str) -> mlua::Result<String> {
    match table.get::<Value>(key)? {
        Value::String(value) => Ok(value.to_str()?.to_owned()),
        _ => Err(mlua::Error::RuntimeError(format!("{label} must be a string"))),
    }
}

fn optional_enum(table: &Table, key: &str, allowed: &[&str]) -> mlua::Result<Option<String>> {
    match table.get::<Value>(key)? {
        Value::Nil => Ok(None),
        Value::String(value) => {
            let value = value.to_str()?.to_owned();
            if allowed.contains(&value.as_str()) { Ok(Some(value)) }
            else { Err(mlua::Error::RuntimeError(format!("{key} has an unsupported value"))) }
        }
        _ => Err(mlua::Error::RuntimeError(format!("{key} must be a supported string or nil"))),
    }
}

fn strict_lua_array_string(table: &Table, index: usize) -> mlua::Result<String> {
    match table.get::<Value>(index)? {
        Value::String(value) => Ok(value.to_str()?.to_owned()),
        _ => Err(mlua::Error::RuntimeError("shell args must be a dense string array".into())),
    }
}

fn valid_module_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(first) if first == '_' || first.is_ascii_alphabetic())
        && chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
        && name.len() <= 64
}

fn valid_palette_registration_id(id: &str) -> bool {
    let Some(suffix) = id.strip_prefix("lua:") else {
        return false;
    };
    let mut chars = suffix.chars();
    matches!(chars.next(), Some(first) if first.is_ascii_alphanumeric())
        && chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
}

fn get_or_create_list(lua: &Lua, handlers: &Table, key: &str) -> mlua::Result<Table> {
    match handlers.get::<Table>(key) {
        Ok(list) => Ok(list),
        Err(_) => {
            let list = lua.create_table()?;
            handlers.set(key, list.clone())?;
            Ok(list)
        }
    }
}

fn collect_handlers(
    table: &Table,
) -> mlua::Result<(
    HashMap<String, Vec<Function>>,
    Vec<Function>,
    Vec<Function>,
    Vec<Function>,
)> {
    let mut handlers = HashMap::new();
    for pair in table.clone().pairs::<String, Table>() {
        let (name, list) = pair?;
        if name == "__activate" || name == "__deactivate" {
            continue;
        }
        handlers.insert(
            name,
            list.sequence_values::<Function>()
                .collect::<mlua::Result<Vec<_>>>()?,
        );
    }
    let activate = table
        .get::<Table>("__activate")
        .ok()
        .map(|list| {
            list.sequence_values::<Function>()
                .collect::<mlua::Result<Vec<_>>>()
        })
        .transpose()?
        .unwrap_or_default();
    let deactivate = table
        .get::<Table>("__deactivate")
        .ok()
        .map(|list| {
            list.sequence_values::<Function>()
                .collect::<mlua::Result<Vec<_>>>()
        })
        .transpose()?
        .unwrap_or_default();
    let unload = table
        .get::<Table>("__unload")
        .ok()
        .map(|list| {
            list.sequence_values::<Function>()
                .collect::<mlua::Result<Vec<_>>>()
        })
        .transpose()?
        .unwrap_or_default();
    Ok((handlers, activate, deactivate, unload))
}

fn install_context_api(
    lua: &Lua,
    tab: &TabState,
    input: &InputState,
    active: bool,
    allow_unfocused_preset: bool,
    epoch: Arc<AtomicU64>,
    expected_epoch: u64,
    actions: Arc<Mutex<Vec<Action>>>,
    state: ScenarioStateStore,
    scope: (String, String),
    state_writes: Arc<Mutex<HashMap<String, Option<ScenarioValue>>>>,
    unloading: bool,
) -> mlua::Result<()> {
    let ctx = lua.create_table()?;
    let tab_api = lua.create_table()?;
    let id = tab.id.clone();
    tab_api.set(
        "id",
        lua.create_function(move |_, _: Value| Ok(id.clone()))?,
    )?;
    let title = tab.title.clone();
    tab_api.set(
        "title",
        lua.create_function(move |_, _: Value| Ok(title.clone()))?,
    )?;
    let process = tab.local_process_name.clone();
    tab_api.set(
        "local_process_name",
        lua.create_function(move |_, _: Value| Ok(process.clone()))?,
    )?;
    let process_names = tab.process_names.clone();
    let local_process_name = tab.local_process_name.clone();
    tab_api.set(
        "has_process",
        lua.create_function(move |_, (_tab, name): (Value, String)| {
            Ok(process_matches(
                Some(std::slice::from_ref(&name)),
                &process_names,
                local_process_name.as_deref(),
            ))
        })?,
    )?;
    let preset_name = tab.preset_name.clone();
    tab_api.set(
        "preset_name",
        lua.create_function(move |_, _: Value| Ok(preset_name.clone()))?,
    )?;
    let cursor = cursor_to_json(&tab.cursor_style);
    tab_api.set(
        "cursor_style",
        lua.create_function(move |lua, _: Value| json_to_lua(lua, &cursor))?,
    )?;
    let tab_active = tab.active;
    tab_api.set(
        "is_active",
        lua.create_function(move |_, _: Value| Ok(tab_active))?,
    )?;
    let tab_focused = tab.focused;
    tab_api.set(
        "is_focused",
        lua.create_function(move |_, _: Value| Ok(tab_focused))?,
    )?;
    let epoch_for_preset = epoch.clone();
    let actions_for_preset = actions.clone();
    let preset_for_preset = tab.preset_name.clone();
    let tab_active = tab.active;
    let tab_focused = tab.focused;
    let restoring = unloading;
    tab_api.set(
        "apply_preset",
        lua.create_function(move |_, (_, name): (Value, String)| {
            if epoch_for_preset.load(Ordering::SeqCst) != expected_epoch {
                return Err(mlua::Error::RuntimeError(
                    "callback context has expired".into(),
                ));
            }
            crate::presets::validate_name(&name).map_err(mlua::Error::RuntimeError)?;
            if !restoring
                && ((!allow_unfocused_preset && (!active || !tab_active || !tab_focused))
                    || (allow_unfocused_preset && !tab_active))
            {
                return Ok(false);
            }
            let mut actions = actions_for_preset
                .lock()
                .map_err(|_| mlua::Error::RuntimeError("action queue is unavailable".into()))?;
            let action = if restoring {
                Action::RestorePreset {
                    name,
                    expected_current: preset_for_preset.clone(),
                }
            } else {
                Action::ApplyPreset(name)
            };
            if restoring && actions.iter().any(|existing| existing != &action) {
                return Err(mlua::Error::RuntimeError(
                    "on_unload may request only one preset restoration".into(),
                ));
            }
            if actions.contains(&action) {
                return Ok(true);
            }
            if actions.len() >= MAX_ACTIONS_PER_CALLBACK {
                return Err(mlua::Error::RuntimeError(format!(
                    "callback exceeds {MAX_ACTIONS_PER_CALLBACK} host actions"
                )));
            }
            actions.push(action);
            Ok(true)
        })?,
    )?;
    ctx.set("tab", tab_api)?;
    let window_api = lua.create_table()?;
    let epoch_for_position = epoch.clone();
    let actions_for_position = actions.clone();
    let eligible = active && tab.active && tab.focused;
    window_api.set("set_position", lua.create_function(move |_, (_, x, y): (Value, i32, i32)| {
        if x.abs_diff(0) > 100_000 || y.abs_diff(0) > 100_000 {
            return Err(mlua::Error::RuntimeError("window coordinates must be within ±100000 logical pixels".into()));
        }
        queue_window_action(&epoch_for_position, expected_epoch, unloading, eligible, &actions_for_position, Action::SetWindowPosition(x, y))
    })?)?;
    let epoch_for_size = epoch.clone();
    let actions_for_size = actions.clone();
    window_api.set("set_size", lua.create_function(move |_, (_, width, height): (Value, u32, u32)| {
        if !(320..=8192).contains(&width) || !(320..=8192).contains(&height) {
            return Err(mlua::Error::RuntimeError("window dimensions must be between 320 and 8192 logical pixels".into()));
        }
        queue_window_action(&epoch_for_size, expected_epoch, unloading, eligible, &actions_for_size, Action::SetWindowSize(width, height))
    })?)?;
    ctx.set("window", window_api)?;
    let ui_api = lua.create_table()?;
    let epoch_for_panel = epoch.clone();
    let actions_for_panel = actions.clone();
    ui_api.set("set_panel", lua.create_function(move |_, (_, name, visible): (Value, String, bool)| {
        if !["settings", "assistant", "tabs"].contains(&name.as_str()) {
            return Err(mlua::Error::RuntimeError("panel must be 'settings', 'assistant', or 'tabs'".into()));
        }
        queue_window_action(&epoch_for_panel, expected_epoch, unloading, eligible, &actions_for_panel, Action::SetPanelVisibility(name, visible))
    })?)?;
    ctx.set("ui", ui_api)?;
    let state_api = lua.create_table()?;
    let store_for_get = state.clone();
    let scope_for_get = scope.clone();
    let writes_for_get = state_writes.clone();
    let epoch_for_get = epoch.clone();
    state_api.set(
        "get",
        lua.create_function(move |lua, (_, key): (Value, String)| {
            check_state_key(&key)?;
            if epoch_for_get.load(Ordering::SeqCst) != expected_epoch {
                return Err(mlua::Error::RuntimeError(
                    "callback context has expired".into(),
                ));
            }
            let staged = writes_for_get
                .lock()
                .map_err(|_| mlua::Error::RuntimeError("scenario state is unavailable".into()))?;
            if let Some(value) = staged.get(&key) {
                return value
                    .as_ref()
                    .map(|value| scenario_value_to_lua(lua, value))
                    .unwrap_or(Ok(Value::Nil));
            }
            let store = store_for_get
                .0
                .lock()
                .map_err(|_| mlua::Error::RuntimeError("scenario state is unavailable".into()))?;
            store
                .get(&scope_for_get)
                .and_then(|values| values.get(&key))
                .map(|value| scenario_value_to_lua(lua, value))
                .unwrap_or(Ok(Value::Nil))
        })?,
    )?;
    let store_for_set = state;
    let scope_for_set = scope;
    let writes_for_set = state_writes;
    let epoch_for_set_state = epoch.clone();
    state_api.set(
        "set",
        lua.create_function(move |_, (_, key, value): (Value, String, Value)| {
            check_state_key(&key)?;
            if epoch_for_set_state.load(Ordering::SeqCst) != expected_epoch {
                return Err(mlua::Error::RuntimeError(
                    "callback context has expired".into(),
                ));
            }
            let value = scenario_value_from_lua(value)?;
            let mut writes = writes_for_set
                .lock()
                .map_err(|_| mlua::Error::RuntimeError("scenario state is unavailable".into()))?;
            validate_state_write(&store_for_set, &scope_for_set, &writes, &key, &value)?;
            writes.insert(key, value);
            Ok(())
        })?,
    )?;
    ctx.set("state", state_api)?;
    let input_api = lua.create_table()?;
    let current_layout = input.current_layout.clone();
    let epoch_for_current = epoch.clone();
    input_api.set(
        "current_layout",
        lua.create_function(move |_, _: Value| {
            if epoch_for_current.load(Ordering::SeqCst) != expected_epoch {
                return Err(mlua::Error::RuntimeError(
                    "callback context has expired".into(),
                ));
            }
            Ok(current_layout.clone())
        })?,
    )?;
    let epoch_for_set = epoch;
    let tab_active = tab.active;
    let tab_focused = tab.focused;
    input_api.set(
        "set_layout",
        lua.create_function(move |_, (_, layout): (Value, String)| {
            if epoch_for_set.load(Ordering::SeqCst) != expected_epoch {
                return Err(mlua::Error::RuntimeError(
                    "callback context has expired".into(),
                ));
            }
            if unloading {
                return Err(mlua::Error::RuntimeError(
                    "on_unload may only request preset restoration".into(),
                ));
            }
            if layout.is_empty() || layout.len() > 64 {
                return Err(mlua::Error::RuntimeError("layout name is invalid".into()));
            }
            if !active || !tab_active || !tab_focused {
                return Ok(false);
            }
            let mut actions = actions
                .lock()
                .map_err(|_| mlua::Error::RuntimeError("action queue is unavailable".into()))?;
            let action = Action::SetLayout(layout);
            if actions.contains(&action) {
                return Ok(true);
            }
            if actions.len() >= MAX_ACTIONS_PER_CALLBACK {
                return Err(mlua::Error::RuntimeError(format!(
                    "callback exceeds {MAX_ACTIONS_PER_CALLBACK} host actions"
                )));
            }
            actions.push(action);
            Ok(true)
        })?,
    )?;
    ctx.set("input", input_api)?;
    lua.globals().set("__sterm_ctx", ctx)
}

fn queue_window_action(epoch: &AtomicU64, expected_epoch: u64, unloading: bool, eligible: bool, actions: &Mutex<Vec<Action>>, action: Action) -> mlua::Result<bool> {
    if epoch.load(Ordering::SeqCst) != expected_epoch { return Err(mlua::Error::RuntimeError("callback context has expired".into())); }
    if unloading { return Err(mlua::Error::RuntimeError("on_unload cannot change window or panel state".into())); }
    if !eligible { return Ok(false); }
    let mut actions = actions.lock().map_err(|_| mlua::Error::RuntimeError("action queue is unavailable".into()))?;
    if actions.contains(&action) { return Ok(true); }
    if actions.len() >= MAX_ACTIONS_PER_CALLBACK {
        return Err(mlua::Error::RuntimeError(format!("callback exceeds {MAX_ACTIONS_PER_CALLBACK} host actions")));
    }
    actions.push(action);
    Ok(true)
}

fn check_state_key(key: &str) -> mlua::Result<()> {
    if key.is_empty() || key.len() > MAX_STATE_KEY_BYTES {
        return Err(mlua::Error::RuntimeError(format!(
            "scenario state keys must be 1 to {MAX_STATE_KEY_BYTES} UTF-8 bytes"
        )));
    }
    Ok(())
}

fn scenario_value_from_lua(value: Value) -> mlua::Result<Option<ScenarioValue>> {
    match value {
        Value::Nil => Ok(None),
        Value::Boolean(value) => Ok(Some(ScenarioValue::Boolean(value))),
        Value::Integer(value) => Ok(Some(ScenarioValue::Integer(value))),
        Value::Number(value) if value.is_finite() => Ok(Some(ScenarioValue::Number(value))),
        Value::Number(_) => Err(mlua::Error::RuntimeError(
            "scenario state numbers must be finite".into(),
        )),
        Value::String(value) => {
            let value = value.to_str()?.to_owned();
            if value.len() > MAX_STATE_VALUE_BYTES {
                return Err(mlua::Error::RuntimeError(format!(
                    "scenario state strings are limited to {MAX_STATE_VALUE_BYTES} UTF-8 bytes"
                )));
            }
            Ok(Some(ScenarioValue::String(value)))
        }
        _ => Err(mlua::Error::RuntimeError(
            "scenario state supports only nil, boolean, finite number, and string values".into(),
        )),
    }
}

fn scenario_value_to_lua(lua: &Lua, value: &ScenarioValue) -> mlua::Result<Value> {
    match value {
        ScenarioValue::Boolean(value) => Ok(Value::Boolean(*value)),
        ScenarioValue::Integer(value) => Ok(Value::Integer(*value)),
        ScenarioValue::Number(value) => Ok(Value::Number(*value)),
        ScenarioValue::String(value) => Ok(Value::String(lua.create_string(value)?)),
    }
}

fn state_scope_bytes(values: &HashMap<String, ScenarioValue>) -> usize {
    values
        .iter()
        .map(|(key, value)| {
            key.len()
                + 16
                + match value {
                    ScenarioValue::Boolean(_)
                    | ScenarioValue::Integer(_)
                    | ScenarioValue::Number(_) => 8,
                    ScenarioValue::String(value) => value.len(),
                }
        })
        .sum()
}

fn validate_state_write(
    state: &ScenarioStateStore,
    scope: &(String, String),
    staged: &HashMap<String, Option<ScenarioValue>>,
    key: &str,
    value: &Option<ScenarioValue>,
) -> mlua::Result<()> {
    let store = state
        .0
        .lock()
        .map_err(|_| mlua::Error::RuntimeError("scenario state is unavailable".into()))?;
    let mut projected = store.get(scope).cloned().unwrap_or_default();
    for (staged_key, staged_value) in staged {
        match staged_value {
            Some(value) => {
                projected.insert(staged_key.clone(), value.clone());
            }
            None => {
                projected.remove(staged_key);
            }
        }
    }
    match value {
        Some(value) => {
            projected.insert(key.to_owned(), value.clone());
        }
        None => {
            projected.remove(key);
        }
    }
    if projected.len() > MAX_STATE_KEYS {
        return Err(mlua::Error::RuntimeError(format!(
            "scenario state is limited to {MAX_STATE_KEYS} keys per script and tab"
        )));
    }
    let scope_bytes = state_scope_bytes(&projected);
    if scope_bytes > MAX_STATE_SCOPE_BYTES {
        return Err(mlua::Error::RuntimeError(format!(
            "scenario state is limited to {MAX_STATE_SCOPE_BYTES} bytes per script and tab"
        )));
    }
    let total_bytes = store
        .iter()
        .filter(|(other_scope, _)| *other_scope != scope)
        .map(|(_, values)| state_scope_bytes(values))
        .sum::<usize>()
        + scope_bytes;
    if total_bytes > MAX_STATE_TOTAL_BYTES {
        return Err(mlua::Error::RuntimeError(format!(
            "scenario state is limited to {MAX_STATE_TOTAL_BYTES} bytes across the app"
        )));
    }
    Ok(())
}

fn commit_state_writes(
    state: &ScenarioStateStore,
    scope: &(String, String),
    writes: &Arc<Mutex<HashMap<String, Option<ScenarioValue>>>>,
) -> Result<(), String> {
    let writes = writes
        .lock()
        .map_err(|_| "scenario state is unavailable".to_owned())?
        .clone();
    let mut store = state
        .0
        .lock()
        .map_err(|_| "scenario state is unavailable".to_owned())?;
    let values = store.entry(scope.clone()).or_default();
    for (key, value) in writes {
        match value {
            Some(value) => {
                values.insert(key, value);
            }
            None => {
                values.remove(&key);
            }
        }
    }
    if values.is_empty() {
        store.remove(scope);
    }
    Ok(())
}

fn json_to_lua(lua: &Lua, value: &JsonValue) -> mlua::Result<Value> {
    match value {
        JsonValue::Null => Ok(Value::Nil),
        JsonValue::Bool(value) => Ok(Value::Boolean(*value)),
        JsonValue::Number(value) => Ok(Value::Number(value.as_f64().unwrap_or_default())),
        JsonValue::String(value) => Ok(Value::String(lua.create_string(value)?)),
        JsonValue::Array(values) => {
            let table = lua.create_table()?;
            for (index, value) in values.iter().enumerate() {
                table.set(index + 1, json_to_lua(lua, value)?)?;
            }
            Ok(Value::Table(table))
        }
        JsonValue::Object(values) => {
            let table = lua.create_table()?;
            for (key, value) in values {
                table.set(key.as_str(), json_to_lua(lua, value)?)?;
            }
            Ok(Value::Table(table))
        }
    }
}

fn lua_to_json(value: Value, depth: usize, count: &mut usize) -> mlua::Result<JsonValue> {
    if depth > MAX_VALUE_DEPTH {
        return Err(mlua::Error::RuntimeError(
            "Lua table nesting limit exceeded".into(),
        ));
    }
    *count += 1;
    if *count > MAX_VALUE_ITEMS {
        return Err(mlua::Error::RuntimeError(
            "Lua table size limit exceeded".into(),
        ));
    }
    match value {
        Value::Nil => Ok(JsonValue::Null),
        Value::Boolean(value) => Ok(JsonValue::Bool(value)),
        Value::Integer(value) => Ok(JsonValue::Number(value.into())),
        Value::Number(value) => JsonNumber::from_f64(value)
            .map(JsonValue::Number)
            .ok_or_else(|| mlua::Error::RuntimeError("Lua number is not finite".into())),
        Value::String(value) => Ok(JsonValue::String(value.to_str()?.to_owned())),
        Value::Table(table) => {
            let mut array = Vec::new();
            let mut object = JsonMap::new();
            let mut sequence = true;
            for pair in table.clone().pairs::<Value, Value>() {
                let (key, value) = pair?;
                match key {
                    Value::Integer(index) if index > 0 => {
                        if index as u64 > MAX_VALUE_ITEMS as u64 {
                            return Err(mlua::Error::RuntimeError(
                                "Lua options array index exceeds the size limit".into(),
                            ));
                        }
                        let index = index as usize;
                        while array.len() < index {
                            array.push(JsonValue::Null);
                        }
                        array[index - 1] = lua_to_json(value, depth + 1, count)?;
                    }
                    Value::String(key) => {
                        sequence = false;
                        object.insert(
                            key.to_str()?.to_owned(),
                            lua_to_json(value, depth + 1, count)?,
                        );
                    }
                    _ => {
                        return Err(mlua::Error::RuntimeError(
                            "Lua options tables need string or positive integer keys".into(),
                        ));
                    }
                }
            }
            if sequence {
                Ok(JsonValue::Array(array))
            } else if array.is_empty() {
                Ok(JsonValue::Object(object))
            } else {
                Err(mlua::Error::RuntimeError(
                    "Lua options table cannot mix named and array values".into(),
                ))
            }
        }
        _ => Err(mlua::Error::RuntimeError(
            "Lua options support only strings, numbers, booleans, and tables".into(),
        )),
    }
}

fn confined_script_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = validate_relative_script(relative)?;
    let root = fs::canonicalize(root)
        .map_err(|error| format!("could not resolve config directory: {error}"))?;
    let candidate = root.join(&relative);
    let resolved = fs::canonicalize(&candidate)
        .map_err(|error| format!("script '{relative}' could not be resolved: {error}"))?;
    if !resolved.starts_with(&root) {
        return Err(format!(
            "script '{relative}' escapes the trusted config directory"
        ));
    }
    if !resolved.is_file() {
        return Err(format!("script '{relative}' is not a file"));
    }
    Ok(resolved)
}

fn validate_relative_script(path: &str) -> Result<String, String> {
    let path = Path::new(path);
    if path.as_os_str().is_empty() || path.extension().and_then(|ext| ext.to_str()) != Some("lua") {
        return Err("script path must name a .lua file".into());
    }
    if path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("script path must stay inside the trusted config directory".into());
    }
    Ok(path.to_string_lossy().into_owned())
}

fn read_limited(path: &Path, max_bytes: usize) -> Result<String, String> {
    let metadata =
        fs::metadata(path).map_err(|error| format!("could not inspect Lua file: {error}"))?;
    if metadata.len() as usize > max_bytes {
        return Err(format!("Lua file exceeds the {max_bytes}-byte limit"));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    fs::File::open(path)
        .and_then(|file| file.take(max_bytes as u64 + 1).read_to_end(&mut bytes))
        .map_err(|error| format!("could not read Lua source: {error}"))?;
    if bytes.len() > max_bytes {
        return Err(format!("Lua file exceeds the {max_bytes}-byte limit"));
    }
    let source =
        String::from_utf8(bytes).map_err(|_| "Lua source is not valid UTF-8".to_owned())?;
    Ok(source)
}

fn snapshot_source(
    snapshot: &Arc<Mutex<ConfigSourceSnapshot>>,
    path: &Path,
) -> Result<Arc<str>, String> {
    if let Some(source) = snapshot
        .lock()
        .map_err(|_| "Lua source snapshot is unavailable".to_owned())?
        .sources
        .get(path)
        .cloned()
    {
        return Ok(source);
    }
    let source = Arc::<str>::from(read_limited(path, MAX_SCRIPT_BYTES)?);
    let mut snapshot = snapshot
        .lock()
        .map_err(|_| "Lua source snapshot is unavailable".to_owned())?;
    if let Some(existing) = snapshot.sources.get(path) {
        return Ok(existing.clone());
    }
    if snapshot.total_bytes + source.len() > MAX_TOTAL_SCRIPT_BYTES {
        return Err("Lua source snapshot exceeds the total size limit".into());
    }
    snapshot.total_bytes += source.len();
    snapshot.sources.insert(path.to_path_buf(), source.clone());
    Ok(source)
}

fn palette_color(color: String) -> mlua::Result<String> {
    if color.len() != 7
        || !color.starts_with('#')
        || !color[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(mlua::Error::RuntimeError(
            "palette colors must use #RRGGBB".into(),
        ));
    }
    Ok(color.to_ascii_uppercase())
}

fn process_name_matches(candidate: &str, process: &str) -> bool {
    let candidate = candidate.rsplit(['\\', '/']).next().unwrap_or(candidate);
    let process = process.rsplit(['\\', '/']).next().unwrap_or(process);
    candidate.eq_ignore_ascii_case(process)
}

fn process_matches(
    matches: Option<&[String]>,
    process_names: &[String],
    process: Option<&str>,
) -> bool {
    let Some(matches) = matches else {
        return true;
    };
    matches.iter().any(|candidate| {
        process_names
            .iter()
            .any(|process| process_name_matches(candidate, process))
            || process_names.is_empty()
                && process.is_some_and(|process| process_name_matches(candidate, process))
    })
}

fn event_name(event: &RuntimeEvent) -> &'static str {
    match event {
        RuntimeEvent::TabCreated => "tab-created",
        RuntimeEvent::TabActivated => "tab-activated",
        RuntimeEvent::TabDeactivated => "tab-deactivated",
        RuntimeEvent::TabTitleChanged { .. } => "tab-title-changed",
        RuntimeEvent::LocalProcessChanged { .. } => "local-process-changed",
        RuntimeEvent::CursorStyleChanged { .. } => "cursor-style-changed",
        RuntimeEvent::ContextUpdated => "context-updated",
        RuntimeEvent::TabFocusChanged { .. } => "tab-focus-changed",
        RuntimeEvent::WindowFocusChanged { .. } => "window-focus-changed",
        RuntimeEvent::InputLanguageChanged { .. } => "input-language-changed",
    }
}

fn valid_event_name(name: &str) -> bool {
    matches!(
        name,
        "tab-created"
            | "tab-activated"
            | "tab-deactivated"
            | "tab-title-changed"
            | "local-process-changed"
            | "cursor-style-changed"
            | "context-updated"
            | "tab-focus-changed"
            | "window-focus-changed"
            | "input-language-changed"
    )
}

fn event_to_json(event: &RuntimeEvent) -> JsonValue {
    let mut object = JsonMap::new();
    match event {
        RuntimeEvent::TabTitleChanged {
            old_title,
            new_title,
        } => {
            object.insert("old_title".into(), old_title.clone().into());
            object.insert("new_title".into(), new_title.clone().into());
        }
        RuntimeEvent::LocalProcessChanged {
            old_process,
            new_process,
        } => {
            object.insert(
                "old_process".into(),
                old_process
                    .clone()
                    .map_or(JsonValue::Null, JsonValue::String),
            );
            object.insert(
                "new_process".into(),
                new_process
                    .clone()
                    .map_or(JsonValue::Null, JsonValue::String),
            );
        }
        RuntimeEvent::CursorStyleChanged {
            old_cursor,
            new_cursor,
        } => {
            object.insert("old_cursor".into(), cursor_to_json(old_cursor));
            object.insert("new_cursor".into(), cursor_to_json(new_cursor));
        }
        RuntimeEvent::TabFocusChanged { focused }
        | RuntimeEvent::WindowFocusChanged { focused } => {
            object.insert("focused".into(), (*focused).into());
        }
        RuntimeEvent::InputLanguageChanged { layout } => {
            object.insert("language".into(), layout.clone().into());
        }
        RuntimeEvent::TabCreated
        | RuntimeEvent::TabActivated
        | RuntimeEvent::TabDeactivated
        | RuntimeEvent::ContextUpdated => {}
    }
    JsonValue::Object(object)
}

fn tab_to_json(tab: &TabState) -> JsonValue {
    let mut object = JsonMap::new();
    object.insert("id".into(), tab.id.clone().into());
    object.insert("title".into(), tab.title.clone().into());
    object.insert("kind".into(), "terminal".into());
    object.insert(
        "local_process_name".into(),
        tab.local_process_name
            .clone()
            .map_or(JsonValue::Null, JsonValue::String),
    );
    object.insert(
        "process_names".into(),
        JsonValue::Array(
            tab.process_names
                .iter()
                .cloned()
                .map(JsonValue::String)
                .collect(),
        ),
    );
    object.insert("cursor_style".into(), cursor_to_json(&tab.cursor_style));
    object.insert("active".into(), tab.active.into());
    object.insert("focused".into(), tab.focused.into());
    JsonValue::Object(object)
}

fn cursor_to_json(cursor: &CursorStyle) -> JsonValue {
    let mut object = JsonMap::new();
    let shape = match cursor.shape {
        CursorShape::Block => "block",
        CursorShape::Underline => "underline",
        CursorShape::Bar => "bar",
        CursorShape::Unknown => "unknown",
        CursorShape::None => "null",
    };
    object.insert(
        "shape".into(),
        if cursor.shape == CursorShape::None {
            JsonValue::Null
        } else {
            shape.into()
        },
    );
    object.insert(
        "blink".into(),
        cursor.blink.map_or(JsonValue::Null, JsonValue::Bool),
    );
    object.insert("visible".into(), cursor.visible.into());
    JsonValue::Object(object)
}

fn diagnostic(
    script: Option<String>,
    event: Option<String>,
    message: impl Into<String>,
) -> Diagnostic {
    Diagnostic {
        script,
        event,
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEMP: AtomicUsize = AtomicUsize::new(0);
    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "sterm-lua-test-{}-{}",
                std::process::id(),
                NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn write(&self, name: &str, source: &str) {
            let path = self.0.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, source).unwrap();
        }
        fn entry(&self) -> PathBuf {
            self.0.join("config.lua")
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn tab(id: &str, process: Option<&str>, active: bool, focused: bool) -> TabState {
        TabState {
            id: id.into(),
            title: String::new(),
            local_process_name: process.map(str::to_owned),
            process_names: process.into_iter().map(str::to_owned).collect(),
            preset_name: "DEC VT-100 (1978)".into(),
            cursor_style: CursorStyle {
                shape: CursorShape::Block,
                blink: Some(true),
                visible: true,
            },
            active,
            focused,
        }
    }
    fn setup(script: &str) -> (TempDir, LuaRuntime) {
        let dir = TempDir::new();
        dir.write("config.lua", "local sterm=require 'sterm'; sterm.use('scripts/modal-layout.lua', { when={process={'nvim.exe'}}, options={normal_layout='en-US'} })");
        dir.write("scripts/modal-layout.lua", script);
        let snapshot = RuntimeSnapshot::load(&dir.entry()).unwrap();
        (dir, LuaRuntime::new(snapshot))
    }
    fn write_shared_examples(dir: &TempDir) {
        let config = format!(
            "{}\n\
             sterm.use('editors/nvim.lua', {{ when = {{ process = {{ 'vim.exe', 'nvim.exe' }} }} }})\n\
             sterm.use('editors/hx.lua', {{ when = {{ process = {{ 'hx.exe' }} }} }})\n",
            include_str!("../../examples/lua/sterm.lua")
        );
        dir.write("config.lua", &config);
        dir.write(
            "editors/nvim.lua",
            include_str!("../../examples/lua/editors/nvim.lua"),
        );
        dir.write(
            "editors/hx.lua",
            include_str!("../../examples/lua/editors/hx.lua"),
        );
        dir.write(
            "modules/modal_editor.lua",
            include_str!("../../examples/lua/modules/modal_editor.lua"),
        );
        dir.write(
            "palettes/users.lua",
            include_str!("../../examples/lua/palettes/users.lua"),
        );
    }
    fn intent(script: &str, event: &str, layout: &str) -> ActionIntent {
        ActionIntent {
            action: Action::SetLayout(layout.into()),
            script: script.into(),
            event: event.into(),
        }
    }

    #[test]
    fn action_intent_keeps_its_origin_for_controller_tracing() {
        let (_dir, mut runtime) = setup(
            "local sterm=require 'sterm'; sterm.on('cursor-style-changed', function(ctx) ctx.input:set_layout('en-US') end)",
        );
        let state = tab("a", Some("nvim.exe"), true, true);
        runtime.attach_tab(state.clone(), InputState::default());
        let result = runtime.dispatch(
            &state,
            &InputState::default(),
            RuntimeEvent::CursorStyleChanged {
                old_cursor: state.cursor_style.clone(),
                new_cursor: state.cursor_style.clone(),
            },
        );
        assert_eq!(
            result.actions,
            vec![intent(
                "scripts/modal-layout.lua",
                "cursor-style-changed",
                "en-US"
            )]
        );
    }

    #[test]
    fn scenario_state_isolated_by_tab_and_preserved_across_fresh_vms() {
        let dir = TempDir::new();
        dir.write(
            "config.lua",
            "local sterm=require 'sterm'; sterm.use('counter.lua')",
        );
        dir.write(
            "counter.lua",
            "local local_count=0; sterm.on('context-updated', function(ctx) local_count=local_count+1; ctx.state:set('persisted', (ctx.state:get('persisted') or 0)+1); ctx.state:set('local', local_count) end)",
        );
        let snapshot = RuntimeSnapshot::load(&dir.entry()).unwrap();
        let mut runtime = LuaRuntime::new(snapshot.clone());
        let first = tab("first", None, true, true);
        let second = tab("second", None, true, true);
        runtime.attach_tab(first.clone(), InputState::default());
        runtime.attach_tab(second.clone(), InputState::default());
        runtime.dispatch(&first, &InputState::default(), RuntimeEvent::ContextUpdated);
        runtime.dispatch(
            &second,
            &InputState::default(),
            RuntimeEvent::ContextUpdated,
        );
        let key = snapshot.attachments[0].state_key.clone();
        let state = runtime.state.0.lock().unwrap();
        assert_eq!(
            state[&(first.id.clone(), key.clone())]["persisted"],
            ScenarioValue::Integer(1)
        );
        assert_eq!(
            state[&(second.id.clone(), key.clone())]["persisted"],
            ScenarioValue::Integer(1)
        );
        drop(state);

        dir.write(
            "counter.lua",
            "local local_count=0; sterm.on('context-updated', function(ctx) local_count=local_count+1; ctx.state:set('persisted', (ctx.state:get('persisted') or 0)+1); ctx.state:set('local', local_count) end)",
        );
        let next = RuntimeSnapshot::load(&dir.entry()).unwrap();
        runtime.reload(next, [(first.clone(), InputState::default())]);
        runtime.dispatch(&first, &InputState::default(), RuntimeEvent::ContextUpdated);
        let state = runtime.state.0.lock().unwrap();
        let values = &state[&(first.id, key)];
        assert_eq!(values["persisted"], ScenarioValue::Integer(2));
        assert_eq!(values["local"], ScenarioValue::Integer(1));
    }

    #[test]
    fn scenario_state_writes_roll_back_when_callback_fails() {
        let (_dir, mut runtime) = setup(
            "sterm.on('context-updated', function(ctx) ctx.state:set('value', 7); error('failed') end)",
        );
        let state = tab("a", Some("nvim.exe"), true, true);
        runtime.attach_tab(state.clone(), InputState::default());
        let result = runtime.dispatch(&state, &InputState::default(), RuntimeEvent::ContextUpdated);
        assert_eq!(result.diagnostics.len(), 1);
        assert!(runtime.state.0.lock().unwrap().is_empty());
    }

    #[test]
    fn scenario_state_rejects_non_scalars_and_enforces_scope_limits() {
        let (_dir, mut runtime) =
            setup("sterm.on('context-updated', function(ctx) ctx.state:set('value', {}) end)");
        let state = tab("a", Some("nvim.exe"), true, true);
        runtime.attach_tab(state.clone(), InputState::default());
        let result = runtime.dispatch(&state, &InputState::default(), RuntimeEvent::ContextUpdated);
        assert!(result.diagnostics[0].message.contains("only nil, boolean"));
        assert!(runtime.state.0.lock().unwrap().is_empty());

        let (_dir, mut runtime) = setup(
            "sterm.on('context-updated', function(ctx) for i=1,33 do ctx.state:set('k'..i, true) end end)",
        );
        runtime.attach_tab(state.clone(), InputState::default());
        let result = runtime.dispatch(&state, &InputState::default(), RuntimeEvent::ContextUpdated);
        assert!(result.diagnostics[0].message.contains("limited to 32 keys"));
        assert!(runtime.state.0.lock().unwrap().is_empty());
    }

    #[test]
    fn settings_capture_evaluates_values_in_the_bounded_registration_vm() {
        let dir = TempDir::new();
        dir.write("config.lua", "");
        let snapshot = RuntimeSnapshot::load_source(
            &dir.entry(),
            "local sterm=require 'sterm'; local function choose() return 'DEC VT-100', (1 == 1) end; local preset, enabled=choose(); sterm.settings({default_preset=preset, smooth_scrollback=enabled, restore_window=false})",
        )
        .unwrap();
        assert_eq!(
            snapshot.settings(),
            Some(&ManagedSettings {
                default_preset: Some("DEC VT-100".into()),
                smooth_scrollback: Some(true),
                restore_window: Some(false),
                ..Default::default()
            })
        );
    }

    #[test]
    fn expanded_settings_and_custom_shells_validate_and_round_trip() {
        let dir = TempDir::new();
        dir.write("config.lua", "");
        let source = r#"local sterm=require 'sterm'; sterm.settings({settings_scale=1, last_ai_selection={model='gpt-x', effort='high'}, settings_version=1}); sterm.shells({{id='clean', name='Clean', command='pwsh.exe', args={'-NoProfile', 'say "hi" \\done'}}})"#;
        let snapshot = RuntimeSnapshot::load_source(&dir.entry(), source).unwrap();
        assert_eq!(snapshot.settings().unwrap().settings_scale, Some(1.0));
        assert_eq!(snapshot.settings().unwrap().settings_version, Some(1));
        assert_eq!(snapshot.custom_shells(), &[CustomShell { id: "lua:clean".into(), name: "Clean".into(), command: "pwsh.exe".into(), args: vec!["-NoProfile".into(), "say \"hi\" \\done".into()] }]);
        for invalid in [
            "require('sterm').settings({settings_scale=1.6})",
            "require('sterm').settings({last_ai_selection={model=7, effort='high'}})",
            "require('sterm').shells({{id=7, name='Clean', command='pwsh.exe', args={}}})",
            "require('sterm').shells({{id='clean', name='Clean', command='pwsh.exe', args='bad'}})",
            "require('sterm').shells({{id='clean', name='Clean', command='pwsh.exe', args={true}}})",
            "require('sterm').shells({}); require('sterm').shells({})",
        ] {
            assert!(RuntimeSnapshot::load_source(&dir.entry(), invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn window_and_panel_actions_are_temporary_host_intents_for_focused_tabs() {
        let dir = TempDir::new();
        dir.write("config.lua", "local sterm=require 'sterm'; sterm.use('window.lua')");
        dir.write("window.lua", "sterm.on('context-updated', function(ctx) ctx.window:set_position(40, 50); ctx.window:set_size(1200, 800); ctx.ui:set_panel('assistant', false) end)");
        let mut runtime = LuaRuntime::new(RuntimeSnapshot::load(&dir.entry()).unwrap());
        let focused = tab("focused", None, true, true);
        runtime.attach_tab(focused.clone(), InputState::default());
        let actions = runtime.dispatch(&focused, &InputState::default(), RuntimeEvent::ContextUpdated).actions;
        assert_eq!(actions.iter().map(|intent| intent.action.clone()).collect::<Vec<_>>(), vec![
            Action::SetWindowPosition(40, 50),
            Action::SetWindowSize(1200, 800),
            Action::SetPanelVisibility("assistant".into(), false),
        ]);
        let background = tab("background", None, false, false);
        runtime.attach_tab(background.clone(), InputState::default());
        assert!(runtime.dispatch(&background, &InputState::default(), RuntimeEvent::ContextUpdated).actions.is_empty());
    }

    #[test]
    fn settings_capture_rejects_unknown_fields_wrong_types_and_duplicates() {
        let dir = TempDir::new();
        dir.write("config.lua", "");
        for source in [
            "require('sterm').settings({ unknown=true })",
            "require('sterm').settings({ smooth_scrollback='yes' })",
            "require('sterm').settings({ default_preset='../escape' })",
            "require('sterm').settings({ restore_window=1 })",
            "require('sterm').settings({}); require('sterm').settings({})",
        ] {
            assert!(
                RuntimeSnapshot::load_source(&dir.entry(), source).is_err(),
                "{source}"
            );
        }
    }

    #[test]
    fn shipped_users_palette_loads_inline_and_palette_registration_is_strict() {
        let dir = TempDir::new();
        dir.write("config.lua", include_str!("../../examples/lua/sterm.lua"));
        dir.write(
            "modules/modal_editor.lua",
            include_str!("../../examples/lua/modules/modal_editor.lua"),
        );
        dir.write(
            "palettes/users.lua",
            include_str!("../../examples/lua/palettes/users.lua"),
        );
        let snapshot = RuntimeSnapshot::load(&dir.entry()).unwrap();
        let [palette] = snapshot.ansi_palettes() else {
            panic!("expected the enabled example palette");
        };
        assert_eq!(palette.id, "lua:users");
        assert_eq!(palette.label, "User's");
        assert_eq!(palette.colors.len(), 16);
        assert_eq!(palette.foreground, "#C0C0C0");
        assert!(snapshot.settings().is_none());

        dir.write(
            "config.lua",
            "local sterm=require 'sterm'; sterm.include('palette.lua')",
        );
        let valid_colors = (0..16).map(|_| "'#102030'").collect::<Vec<_>>().join(",");
        for source in [
            format!(
                "require 'sterm'.ansi_palette('users', {{ label='User', foreground='#000000', background='#FFFFFF', colors={{ {valid_colors} }}, nope=true }})"
            ),
            format!(
                "require 'sterm'.ansi_palette('users', {{ label='User', foreground='black', background='#FFFFFF', colors={{ {valid_colors} }} }})"
            ),
            format!(
                "require 'sterm'.ansi_palette('users', {{ label='User', foreground='#000000', background='#FFFFFF', colors={{ {valid_colors}, '#000000' }} }})"
            ),
            format!(
                "require 'sterm'.ansi_palette('users', {{ label='User', foreground='#000000', background='#FFFFFF', colors={{ {valid_colors} }} }}); require 'sterm'.ansi_palette('users', {{ label='Again', foreground='#000000', background='#FFFFFF', colors={{ {valid_colors} }} }})"
            ),
            format!(
                "require 'sterm'.ansi_palette('_users', {{ label='User', foreground='#000000', background='#FFFFFF', colors={{ {valid_colors} }} }})"
            ),
        ] {
            dir.write("palette.lua", &source);
            assert!(RuntimeSnapshot::load(&dir.entry()).is_err(), "{source}");
        }
        let colors_256 = (0..256).map(|_| "'#102030'").collect::<Vec<_>>().join(",");
        dir.write("palette.lua", &format!("require 'sterm'.ansi_palette('wide', {{ label='Wide', foreground='#000000', background='#FFFFFF', colors={{ {colors_256} }} }})"));
        assert_eq!(
            RuntimeSnapshot::load(&dir.entry()).unwrap().ansi_palettes()[0]
                .colors
                .len(),
            256
        );

        let mut too_many = String::from("local sterm=require 'sterm'; local colors={");
        too_many.push_str(&valid_colors);
        too_many.push_str("}; for index=1,65 do sterm.ansi_palette('p'..index, {label='Palette', foreground='#000000', background='#FFFFFF', colors=colors}) end");
        dir.write("palette.lua", &too_many);
        assert!(RuntimeSnapshot::load(&dir.entry()).is_err());
        assert!(valid_palette_registration_id("lua:users"));
        assert!(valid_palette_registration_id("lua:custom_1"));
        assert!(!valid_palette_registration_id("lua:_users"));
        assert!(!valid_palette_registration_id("users"));
        assert!(!valid_palette_registration_id("lua:"));
    }

    #[test]
    fn config_includes_are_confined_cycle_checked_and_share_source_budget() {
        let dir = TempDir::new();
        dir.write("config.lua", "require 'sterm'.include('../outside.lua')");
        assert!(RuntimeSnapshot::load(&dir.entry()).is_err());
        dir.write("config.lua", "require 'sterm'.include('nested.lua')");
        dir.write("nested.lua", "require 'sterm'.include('config.lua')");
        assert!(RuntimeSnapshot::load(&dir.entry()).is_err());

        for index in 0..17 {
            let next = if index == 16 {
                "".to_owned()
            } else {
                format!("require 'sterm'.include('depth{}.lua')", index + 1)
            };
            dir.write(&format!("depth{index}.lua"), &next);
        }
        dir.write("config.lua", "require 'sterm'.include('depth0.lua')");
        assert!(RuntimeSnapshot::load(&dir.entry()).is_err());

        let mut includes = String::new();
        for index in 0..65 {
            includes.push_str(&format!("require 'sterm'.include('include{index}.lua');\n"));
            dir.write(&format!("include{index}.lua"), "-- include");
        }
        dir.write("config.lua", &includes);
        assert!(RuntimeSnapshot::load(&dir.entry()).is_err());

        let mut includes = String::new();
        for index in 0..9 {
            includes.push_str(&format!("require 'sterm'.include('part{index}.lua')\n"));
            dir.write(
                &format!("part{index}.lua"),
                &format!("--{}", "x".repeat(MAX_SCRIPT_BYTES - 2)),
            );
        }
        dir.write("config.lua", &includes);
        assert!(RuntimeSnapshot::load(&dir.entry()).is_err());
    }

    #[test]
    fn apply_preset_uses_tab_action_intent_and_rejects_invalid_names() {
        let (_dir, mut runtime) = setup(
            "local sterm=require 'sterm'; sterm.on('context-updated', function(ctx) ctx.tab:apply_preset('DEC VT-100') end)",
        );
        let state = tab("a", Some("nvim.exe"), true, true);
        runtime.attach_tab(state.clone(), InputState::default());
        let result = runtime.dispatch(&state, &InputState::default(), RuntimeEvent::ContextUpdated);
        assert_eq!(result.actions.len(), 1);
        assert_eq!(
            result.actions[0].action,
            Action::ApplyPreset("DEC VT-100".into())
        );

        let (_dir, mut runtime) = setup(
            "local sterm=require 'sterm'; sterm.on('context-updated', function(ctx) ctx.tab:apply_preset('../escape') end)",
        );
        runtime.attach_tab(state.clone(), InputState::default());
        let result = runtime.dispatch(&state, &InputState::default(), RuntimeEvent::ContextUpdated);
        assert!(result.actions.is_empty());
        assert_eq!(result.diagnostics.len(), 1);
    }

    #[test]
    fn unfocused_active_context_can_apply_preset_but_not_layout_or_background_actions() {
        let (_dir, mut runtime) = setup(
            "local sterm=require 'sterm'; sterm.on('context-updated', function(ctx) ctx.tab:apply_preset('DEC VT-100'); ctx.input:set_layout('en-US') end)",
        );
        let unfocused = tab("active", Some("nvim.exe"), true, false);
        runtime.attach_tab(unfocused.clone(), InputState::default());
        let result = runtime.dispatch(
            &unfocused,
            &InputState::default(),
            RuntimeEvent::ContextUpdated,
        );
        assert_eq!(result.actions.len(), 1);
        assert_eq!(
            result.actions[0].action,
            Action::ApplyPreset("DEC VT-100".into())
        );
        assert!(!runtime.smart_caps_enabled("active"));

        let mismatch = tab("mismatch", Some("cmd.exe"), true, false);
        runtime.attach_tab(mismatch.clone(), InputState::default());
        assert!(
            runtime
                .dispatch(
                    &mismatch,
                    &InputState::default(),
                    RuntimeEvent::ContextUpdated
                )
                .actions
                .is_empty()
        );

        let background = tab("background", Some("nvim.exe"), false, false);
        runtime.attach_tab(background.clone(), InputState::default());
        assert!(
            runtime
                .dispatch(
                    &background,
                    &InputState::default(),
                    RuntimeEvent::ContextUpdated
                )
                .actions
                .is_empty()
        );

        let (_dir, mut deactivation_runtime) = setup(
            "local sterm=require 'sterm'; sterm.on_deactivate(function(ctx) ctx.tab:apply_preset('DEC VT-100') end)",
        );
        let focused = tab("deactivate", Some("nvim.exe"), true, true);
        deactivation_runtime.attach_tab(focused.clone(), InputState::default());
        let unfocused = tab("deactivate", Some("nvim.exe"), true, false);
        assert!(
            deactivation_runtime
                .dispatch(
                    &unfocused,
                    &InputState::default(),
                    RuntimeEvent::TabFocusChanged { focused: false },
                )
                .actions
                .is_empty()
        );
    }

    #[test]
    fn shipped_far_example_restores_selected_preset_across_process_and_focus_transitions() {
        let dir = TempDir::new();
        dir.write(
            "config.lua",
            "local sterm=require 'sterm'; sterm.use('scripts/far_preset.lua', {})",
        );
        dir.write(
            "scripts/far_preset.lua",
            include_str!("../../examples/lua/scripts/far_preset.lua"),
        );
        let snapshot = RuntimeSnapshot::load(&dir.entry()).unwrap();
        let mut runtime = LuaRuntime::new(snapshot);
        let mut state = tab("a", Some("cmd.exe"), true, true);
        state.preset_name = "Saved profile".into();
        let far = "FAR.EXE";

        assert!(
            runtime
                .attach_tab(state.clone(), InputState::default())
                .actions
                .is_empty()
        );
        state.local_process_name = Some(far.into());
        state.process_names = vec!["cmd.exe".into(), far.into()];
        let entered = runtime.dispatch(
            &state,
            &InputState::default(),
            RuntimeEvent::LocalProcessChanged {
                old_process: Some("cmd.exe".into()),
                new_process: Some(far.into()),
            },
        );
        assert_eq!(
            entered.actions.len(),
            1,
            "diagnostics: {:?}",
            entered.diagnostics
        );
        assert_eq!(
            entered.actions[0].action,
            Action::ApplyPreset("DEC VT-100 (1978)".into())
        );

        state.preset_name = "DEC VT-100 (1978)".into();
        assert!(
            runtime
                .dispatch(&state, &InputState::default(), RuntimeEvent::ContextUpdated)
                .actions
                .is_empty()
        );

        state.local_process_name = None;
        state.process_names = vec!["cmd.exe".into()];
        let exited = runtime.dispatch(
            &state,
            &InputState::default(),
            RuntimeEvent::LocalProcessChanged {
                old_process: Some(far.into()),
                new_process: None,
            },
        );
        assert_eq!(exited.actions.len(), 1);
        assert_eq!(
            exited.actions[0].action,
            Action::ApplyPreset("Saved profile".into())
        );
        state.preset_name = "Saved profile".into();

        state.local_process_name = Some("cmd.exe".into());
        state.process_names = vec!["cmd.exe".into()];
        let shell_ready = runtime.dispatch(
            &state,
            &InputState::default(),
            RuntimeEvent::LocalProcessChanged {
                old_process: None,
                new_process: Some("cmd.exe".into()),
            },
        );
        assert!(shell_ready.actions.is_empty());

        let mut second = tab("b", Some("pwsh.exe"), true, true);
        second.preset_name = "Another profile".into();
        assert!(
            runtime
                .attach_tab(second.clone(), InputState::default())
                .actions
                .is_empty()
        );
        second.local_process_name = Some(far.into());
        second.process_names = vec!["pwsh.exe".into(), far.into()];
        assert_eq!(
            runtime
                .dispatch(
                    &second,
                    &InputState::default(),
                    RuntimeEvent::LocalProcessChanged {
                        old_process: Some("pwsh.exe".into()),
                        new_process: Some(far.into()),
                    },
                )
                .actions[0]
                .action,
            Action::ApplyPreset("DEC VT-100 (1978)".into())
        );
        second.preset_name = "DEC VT-100 (1978)".into();
        assert!(
            runtime
                .dispatch(
                    &second,
                    &InputState::default(),
                    RuntimeEvent::ContextUpdated
                )
                .actions
                .is_empty()
        );
        second.local_process_name = Some("pwsh.exe".into());
        second.process_names = vec!["pwsh.exe".into()];
        assert_eq!(
            runtime
                .dispatch(
                    &second,
                    &InputState::default(),
                    RuntimeEvent::LocalProcessChanged {
                        old_process: Some(far.into()),
                        new_process: Some("pwsh.exe".into()),
                    },
                )
                .actions[0]
                .action,
            Action::ApplyPreset("Another profile".into())
        );

        state.local_process_name = Some(far.into());
        state.process_names = vec!["cmd.exe".into(), far.into()];
        let reentered = runtime.dispatch(
            &state,
            &InputState::default(),
            RuntimeEvent::LocalProcessChanged {
                old_process: Some("cmd.exe".into()),
                new_process: Some(far.into()),
            },
        );
        assert_eq!(reentered.actions.len(), 1);
        state.preset_name = "DEC VT-100 (1978)".into();
        state.local_process_name = Some("cmd.exe".into());
        state.process_names = vec!["cmd.exe".into()];
        let inactive = tab("a", Some("cmd.exe"), false, false);
        assert!(
            runtime
                .dispatch(
                    &inactive,
                    &InputState::default(),
                    RuntimeEvent::LocalProcessChanged {
                        old_process: Some(far.into()),
                        new_process: Some("cmd.exe".into()),
                    },
                )
                .actions
                .is_empty()
        );
        let resumed = runtime.dispatch(&state, &InputState::default(), RuntimeEvent::TabActivated);
        assert_eq!(resumed.actions.len(), 1);
        assert_eq!(
            resumed.actions[0].action,
            Action::ApplyPreset("Saved profile".into())
        );
    }

    #[test]
    fn smart_caps_declaration_is_static_and_active_tab_scoped() {
        let (_dir, mut runtime) = setup("local sterm=require 'sterm'; sterm.input.smart_caps()");
        let active = tab("a", Some("nvim.exe"), true, true);
        let background = tab("b", Some("nvim.exe"), false, true);
        let process_mismatch = tab("c", Some("cmd.exe"), true, true);
        runtime.attach_tab(active.clone(), InputState::default());
        runtime.attach_tab(background.clone(), InputState::default());
        runtime.attach_tab(process_mismatch.clone(), InputState::default());
        assert!(runtime.smart_caps_enabled("a"));
        assert!(!runtime.smart_caps_enabled("b"));
        assert!(!runtime.smart_caps_enabled("c"));

        let unfocused = tab("a", Some("nvim.exe"), true, false);
        runtime.dispatch(
            &unfocused,
            &InputState::default(),
            RuntimeEvent::TabFocusChanged { focused: false },
        );
        assert!(!runtime.smart_caps_enabled("a"));

        let deactivated = tab("a", Some("nvim.exe"), false, true);
        runtime.dispatch(
            &deactivated,
            &InputState::default(),
            RuntimeEvent::TabDeactivated,
        );
        let activated = tab("b", Some("nvim.exe"), true, true);
        runtime.dispatch(
            &activated,
            &InputState::default(),
            RuntimeEvent::TabActivated,
        );
        assert!(!runtime.smart_caps_enabled("a"));
        assert!(runtime.smart_caps_enabled("b"));

        let snapshot = runtime.snapshot.clone();
        runtime.reload(snapshot, [(activated, InputState::default())]);
        assert!(runtime.smart_caps_enabled("b"));
    }

    #[test]
    fn process_filter_matches_an_editor_nested_under_a_file_manager() {
        let (_dir, mut runtime) = setup("local sterm=require 'sterm'; sterm.on('context-updated', function(ctx) ctx.input:set_layout('en-US') end)");
        let mut nested_editor = tab("nested", Some("nvim.exe"), true, true);
        nested_editor.process_names = vec!["pwsh.exe".into(), "Far.exe".into(), "nvim.exe".into()];

        let input = InputState::default();
        runtime.attach_tab(nested_editor.clone(), input.clone());
        let result = runtime.dispatch(&nested_editor, &input, RuntimeEvent::ContextUpdated);
        assert_eq!(result.actions.len(), 1);
        assert_eq!(result.actions[0].action, Action::SetLayout("en-US".into()));
    }

    #[test]
    fn smart_caps_declaration_from_callback_disables_script() {
        let (_dir, mut runtime) = setup(
            "local sterm=require 'sterm'; sterm.input.smart_caps(); sterm.on('context-updated', function() sterm.input.smart_caps() end)",
        );
        let state = tab("a", Some("nvim.exe"), true, true);
        runtime.attach_tab(state.clone(), InputState::default());
        assert!(runtime.smart_caps_enabled("a"));
        let result = runtime.dispatch(&state, &InputState::default(), RuntimeEvent::ContextUpdated);
        assert_eq!(result.diagnostics.len(), 1);
        assert!(!runtime.smart_caps_enabled("a"));
    }

    #[test]
    fn process_binding_and_cursor_event_emit_layout_only_for_active_focused_editor() {
        let (_dir, mut runtime) = setup(
            r#"
local sterm = require 'sterm'
local options = ...
local insert_layout
local function apply(ctx)
  if not ctx.tab:is_active() or not ctx.tab:is_focused() then return end
  local shape = ctx.tab:cursor_style().shape
  if shape == 'bar' and insert_layout then ctx.input:set_layout(insert_layout)
  elseif shape == 'block' then
    ctx.input:set_layout(options.normal_layout)
  end
end
sterm.on('cursor-style-changed', function(ctx, event) apply(ctx) end)
sterm.on('local-process-changed', function(ctx, event) apply(ctx) end)
sterm.on('input-language-changed', function(ctx, event)
  if ctx.tab:is_active() and ctx.tab:is_focused() and ctx.tab:cursor_style().shape == 'bar' then insert_layout = event.language end
end)
"#,
        );
        let tab = tab("a", Some("nvim.exe"), true, true);
        let attached = runtime.attach_tab(
            tab.clone(),
            InputState {
                current_layout: Some("ru-RU".into()),
            },
        );
        assert!(attached.diagnostics.is_empty());
        let mut insert = tab.clone();
        insert.cursor_style.shape = CursorShape::Bar;
        let observed = runtime.dispatch(
            &insert,
            &InputState {
                current_layout: Some("ru-RU".into()),
            },
            RuntimeEvent::InputLanguageChanged {
                layout: "ru-RU".into(),
            },
        );
        assert!(observed.actions.is_empty());
        let normal = runtime.dispatch(
            &tab,
            &InputState {
                current_layout: Some("ru-RU".into()),
            },
            RuntimeEvent::CursorStyleChanged {
                old_cursor: insert.cursor_style.clone(),
                new_cursor: tab.cursor_style.clone(),
            },
        );
        assert_eq!(
            normal.actions,
            vec![intent(
                "scripts/modal-layout.lua",
                "cursor-style-changed",
                "en-US"
            )]
        );
        let restored = runtime.dispatch(
            &insert,
            &InputState {
                current_layout: Some("en-US".into()),
            },
            RuntimeEvent::CursorStyleChanged {
                old_cursor: tab.cursor_style.clone(),
                new_cursor: insert.cursor_style.clone(),
            },
        );
        assert_eq!(
            restored.actions,
            vec![intent(
                "scripts/modal-layout.lua",
                "cursor-style-changed",
                "ru-RU"
            )]
        );
    }

    #[test]
    fn background_tab_cannot_change_layout_and_state_is_isolated() {
        let (_dir, mut runtime) = setup(
            r#"
local sterm = require 'sterm'; local n=0
sterm.on('cursor-style-changed', function(ctx) n=n+1; ctx.input:set_layout('en-US') end)
"#,
        );
        let background = tab("b", Some("nvim.exe"), false, false);
        runtime.attach_tab(background.clone(), InputState::default());
        let result = runtime.dispatch(
            &background,
            &InputState::default(),
            RuntimeEvent::CursorStyleChanged {
                old_cursor: background.cursor_style.clone(),
                new_cursor: background.cursor_style.clone(),
            },
        );
        assert!(result.actions.is_empty());
        assert!(result.diagnostics.is_empty());
        let foreground = tab("a", Some("nvim.exe"), true, true);
        runtime.attach_tab(foreground.clone(), InputState::default());
        let result = runtime.dispatch(
            &foreground,
            &InputState::default(),
            RuntimeEvent::CursorStyleChanged {
                old_cursor: foreground.cursor_style.clone(),
                new_cursor: foreground.cursor_style.clone(),
            },
        );
        assert_eq!(
            result.actions,
            vec![intent(
                "scripts/modal-layout.lua",
                "cursor-style-changed",
                "en-US"
            )]
        );
    }

    #[test]
    fn one_reusable_file_can_bind_to_multiple_process_names_with_separate_state() {
        let dir = TempDir::new();
        dir.write("config.lua", r#"
local sterm = require 'sterm'
sterm.use('scripts/modal-layout.lua', { when={process={'vim.exe'}}, options={normal_layout='en-US'} })
sterm.use('scripts/modal-layout.lua', { when={process={'test-editor.exe'}}, options={normal_layout='fr-FR'} })
"#);
        dir.write(
            "scripts/modal-layout.lua",
            r#"
local sterm = require 'sterm'
local options = ...
local insert_layout
sterm.on('cursor-style-changed', function(ctx)
  local shape = ctx.tab:cursor_style().shape
  if shape == 'bar' then
    insert_layout = insert_layout or ctx.input:current_layout()
    if insert_layout then ctx.input:set_layout(insert_layout) end
  elseif shape == 'block' then ctx.input:set_layout(options.normal_layout) end
end)
sterm.on('input-language-changed', function(ctx, event)
  if ctx.tab:cursor_style().shape == 'bar' then insert_layout = event.language end
end)
"#,
        );
        let snapshot = RuntimeSnapshot::load(&dir.entry()).unwrap();
        assert_eq!(snapshot.attachments.len(), 2);
        assert!(snapshot.wants_input_language_events());
        dir.write(
            "scripts/modal-layout.lua",
            "error('post-load edits are not in this generation')",
        );
        let mut runtime = LuaRuntime::new(snapshot);
        let vim = tab("vim", Some("vim.exe"), true, true);
        let test_editor = tab("other", Some("test-editor.exe"), true, true);
        runtime.attach_tab(
            vim.clone(),
            InputState {
                current_layout: Some("ru-RU".into()),
            },
        );
        runtime.attach_tab(
            test_editor.clone(),
            InputState {
                current_layout: Some("de-DE".into()),
            },
        );
        let mut vim_insert = vim.clone();
        vim_insert.cursor_style.shape = CursorShape::Bar;
        let mut other_insert = test_editor.clone();
        other_insert.cursor_style.shape = CursorShape::Bar;
        runtime.dispatch(
            &vim_insert,
            &InputState {
                current_layout: Some("ru-RU".into()),
            },
            RuntimeEvent::InputLanguageChanged {
                layout: "ru-RU".into(),
            },
        );
        runtime.dispatch(
            &other_insert,
            &InputState {
                current_layout: Some("de-DE".into()),
            },
            RuntimeEvent::InputLanguageChanged {
                layout: "de-DE".into(),
            },
        );
        let vim_normal = runtime.dispatch(
            &vim,
            &InputState {
                current_layout: Some("ru-RU".into()),
            },
            RuntimeEvent::CursorStyleChanged {
                old_cursor: vim_insert.cursor_style.clone(),
                new_cursor: vim.cursor_style.clone(),
            },
        );
        let other_normal = runtime.dispatch(
            &test_editor,
            &InputState {
                current_layout: Some("de-DE".into()),
            },
            RuntimeEvent::CursorStyleChanged {
                old_cursor: other_insert.cursor_style.clone(),
                new_cursor: test_editor.cursor_style.clone(),
            },
        );
        assert_eq!(
            vim_normal.actions,
            vec![intent(
                "scripts/modal-layout.lua",
                "cursor-style-changed",
                "en-US"
            )]
        );
        assert_eq!(
            other_normal.actions,
            vec![intent(
                "scripts/modal-layout.lua",
                "cursor-style-changed",
                "fr-FR"
            )]
        );
    }

    #[test]
    fn shared_example_supports_per_binding_normal_shapes_and_focus_reactivation() {
        let dir = TempDir::new();
        write_shared_examples(&dir);
        let snapshot = RuntimeSnapshot::load(&dir.entry()).unwrap();
        assert_eq!(snapshot.attachments.len(), 2);

        let mut runtime = LuaRuntime::new(snapshot);
        let vim = tab("vim", Some("vim.exe"), true, true);
        assert_eq!(
            runtime
                .attach_tab(
                    vim,
                    InputState {
                        current_layout: Some("ru-RU".into())
                    },
                )
                .actions,
            vec![intent("editors/nvim.lua", "activate", "en-US")]
        );
        let nvim = tab("nvim", Some("nvim.exe"), true, true);
        assert_eq!(
            runtime
                .attach_tab(
                    nvim.clone(),
                    InputState {
                        current_layout: Some("ru-RU".into())
                    },
                )
                .actions,
            vec![intent("editors/nvim.lua", "activate", "en-US")]
        );
        let mut nvim_insert = nvim.clone();
        nvim_insert.cursor_style.shape = CursorShape::Bar;
        runtime.dispatch(
            &nvim_insert,
            &InputState {
                current_layout: Some("ru-RU".into()),
            },
            RuntimeEvent::InputLanguageChanged {
                layout: "ru-RU".into(),
            },
        );
        let mut helix = tab("helix", Some("hx.exe"), true, true);
        helix.cursor_style.shape = CursorShape::Underline;
        assert_eq!(
            runtime
                .attach_tab(
                    helix.clone(),
                    InputState {
                        current_layout: Some("ru-RU".into())
                    },
                )
                .actions,
            vec![intent("editors/hx.lua", "activate", "en-US")]
        );
        let mut helix_insert = helix.clone();
        helix_insert.cursor_style.shape = CursorShape::Bar;
        runtime.dispatch(
            &helix_insert,
            &InputState {
                current_layout: Some("de-DE".into()),
            },
            RuntimeEvent::InputLanguageChanged {
                layout: "de-DE".into(),
            },
        );
        assert!(
            runtime
                .dispatch(
                    &helix_insert,
                    &InputState {
                        current_layout: Some("de-DE".into())
                    },
                    RuntimeEvent::CursorStyleChanged {
                        old_cursor: helix.cursor_style.clone(),
                        new_cursor: helix_insert.cursor_style.clone(),
                    },
                )
                .actions
                .is_empty()
        );
        assert!(
            runtime
                .dispatch(
                    &helix_insert,
                    &InputState {
                        current_layout: Some("de-DE".into())
                    },
                    RuntimeEvent::ContextUpdated,
                )
                .actions
                .is_empty()
        );

        assert!(
            runtime
                .dispatch(
                    &nvim_insert,
                    &InputState {
                        current_layout: Some("de-DE".into())
                    },
                    RuntimeEvent::CursorStyleChanged {
                        old_cursor: nvim.cursor_style.clone(),
                        new_cursor: nvim_insert.cursor_style.clone(),
                    },
                )
                .actions
                .is_empty()
        );
        assert_eq!(
            runtime
                .dispatch(
                    &nvim_insert,
                    &InputState {
                        current_layout: Some("de-DE".into())
                    },
                    RuntimeEvent::ContextUpdated,
                )
                .actions,
            vec![intent("editors/nvim.lua", "context-updated", "ru-RU")]
        );

        let mut helix_unfocused = helix.clone();
        helix_unfocused.focused = false;
        assert!(
            runtime
                .dispatch(
                    &helix_unfocused,
                    &InputState {
                        current_layout: Some("de-DE".into())
                    },
                    RuntimeEvent::TabFocusChanged { focused: false },
                )
                .actions
                .is_empty()
        );
        let mut helix_unfocused_normal = helix_unfocused.clone();
        helix_unfocused_normal.cursor_style.shape = CursorShape::Underline;
        assert!(
            runtime
                .dispatch(
                    &helix_unfocused_normal,
                    &InputState {
                        current_layout: Some("de-DE".into())
                    },
                    RuntimeEvent::CursorStyleChanged {
                        old_cursor: helix_insert.cursor_style.clone(),
                        new_cursor: helix_unfocused_normal.cursor_style.clone(),
                    },
                )
                .actions
                .is_empty()
        );
        let mut helix_refocused = helix_unfocused_normal.clone();
        helix_refocused.focused = true;
        assert_eq!(
            runtime
                .dispatch(
                    &helix_refocused,
                    &InputState {
                        current_layout: Some("de-DE".into())
                    },
                    RuntimeEvent::TabFocusChanged { focused: true },
                )
                .actions,
            vec![intent("editors/hx.lua", "activate", "en-US")]
        );
        assert_eq!(
            runtime
                .dispatch(
                    &helix_refocused,
                    &InputState {
                        current_layout: Some("de-DE".into())
                    },
                    RuntimeEvent::ContextUpdated,
                )
                .actions,
            vec![intent("editors/hx.lua", "context-updated", "en-US")]
        );

        let background = tab("background", Some("hx.exe"), false, true);
        let mut background_normal = background.clone();
        background_normal.cursor_style.shape = CursorShape::Underline;
        assert!(
            runtime
                .attach_tab(
                    background.clone(),
                    InputState {
                        current_layout: Some("de-DE".into())
                    },
                )
                .actions
                .is_empty()
        );
        assert!(
            runtime
                .dispatch(
                    &background_normal,
                    &InputState {
                        current_layout: Some("de-DE".into())
                    },
                    RuntimeEvent::CursorStyleChanged {
                        old_cursor: background.cursor_style.clone(),
                        new_cursor: background_normal.cursor_style.clone(),
                    },
                )
                .actions
                .is_empty()
        );
        assert!(
            runtime
                .dispatch(
                    &background_normal,
                    &InputState {
                        current_layout: Some("de-DE".into())
                    },
                    RuntimeEvent::ContextUpdated,
                )
                .actions
                .is_empty()
        );
    }

    #[test]
    fn hidden_cursor_policy_is_opt_in_and_preserves_the_exact_insert_layout() {
        let dir = TempDir::new();
        write_shared_examples(&dir);
        let snapshot = RuntimeSnapshot::load(&dir.entry()).unwrap();
        let mut runtime = LuaRuntime::new(snapshot);
        let input = InputState {
            current_layout: Some("0xF0080419".into()),
        };

        let mut helix_insert = tab("hx", Some("hx.exe"), true, true);
        helix_insert.cursor_style.shape = CursorShape::Bar;
        assert!(
            runtime
                .attach_tab(helix_insert.clone(), input.clone())
                .actions
                .is_empty()
        );

        let mut helix_normal = helix_insert.clone();
        helix_normal.cursor_style.visible = false;
        assert_eq!(
            runtime
                .dispatch(&helix_normal, &input, RuntimeEvent::ContextUpdated,)
                .actions,
            vec![intent("editors/hx.lua", "context-updated", "en-US")]
        );

        let unexpected_layout = InputState {
            current_layout: Some("0x04190419".into()),
        };
        assert!(
            runtime
                .dispatch(
                    &helix_normal,
                    &unexpected_layout,
                    RuntimeEvent::InputLanguageChanged {
                        layout: "0x04190419".into(),
                    },
                )
                .actions
                .is_empty()
        );
        assert_eq!(
            runtime
                .dispatch(
                    &helix_normal,
                    &unexpected_layout,
                    RuntimeEvent::ContextUpdated
                )
                .actions,
            vec![intent("editors/hx.lua", "context-updated", "en-US")]
        );

        assert_eq!(
            runtime
                .dispatch(
                    &helix_insert,
                    &InputState {
                        current_layout: Some("en-US".into()),
                    },
                    RuntimeEvent::ContextUpdated,
                )
                .actions,
            vec![intent("editors/hx.lua", "context-updated", "0xF0080419")]
        );

        let mut nvim_insert = tab("nvim", Some("nvim.exe"), true, true);
        nvim_insert.cursor_style.shape = CursorShape::Bar;
        assert!(
            runtime
                .attach_tab(nvim_insert.clone(), input.clone())
                .actions
                .is_empty()
        );
        let mut nvim_hidden_bar = nvim_insert.clone();
        nvim_hidden_bar.cursor_style.visible = false;
        assert!(
            runtime
                .dispatch(&nvim_hidden_bar, &input, RuntimeEvent::ContextUpdated,)
                .actions
                .is_empty()
        );
    }

    #[test]
    fn shared_example_captures_and_restores_exact_insert_layout_across_mode_events() {
        let dir = TempDir::new();
        write_shared_examples(&dir);
        let snapshot = RuntimeSnapshot::load(&dir.entry()).unwrap();
        let mut runtime = LuaRuntime::new(snapshot);
        let mut normal = tab("helix", Some("hx.exe"), true, true);
        normal.cursor_style.shape = CursorShape::Underline;
        let old_russian = "0x04190419";
        let typewriter_russian = "0xF0080419";
        let input = |layout: &str| InputState {
            current_layout: Some(layout.into()),
        };

        assert_eq!(
            runtime
                .attach_tab(normal.clone(), input(old_russian))
                .actions,
            vec![intent("editors/hx.lua", "activate", "en-US")]
        );

        let mut insert = normal.clone();
        insert.cursor_style.shape = CursorShape::Bar;
        assert!(
            runtime
                .dispatch(
                    &insert,
                    &input("en-US"),
                    RuntimeEvent::CursorStyleChanged {
                        old_cursor: normal.cursor_style.clone(),
                        new_cursor: insert.cursor_style.clone(),
                    },
                )
                .actions
                .is_empty()
        );
        assert_eq!(
            runtime
                .dispatch(&insert, &input("en-US"), RuntimeEvent::ContextUpdated)
                .actions,
            vec![intent("editors/hx.lua", "context-updated", old_russian)]
        );
        runtime.dispatch(
            &insert,
            &input(old_russian),
            RuntimeEvent::InputLanguageChanged {
                layout: old_russian.into(),
            },
        );

        assert!(
            runtime
                .dispatch(
                    &normal,
                    &input(typewriter_russian),
                    RuntimeEvent::CursorStyleChanged {
                        old_cursor: insert.cursor_style.clone(),
                        new_cursor: normal.cursor_style.clone(),
                    },
                )
                .actions
                .is_empty()
        );
        assert_eq!(
            runtime
                .dispatch(
                    &normal,
                    &input(typewriter_russian),
                    RuntimeEvent::ContextUpdated,
                )
                .actions,
            vec![intent("editors/hx.lua", "context-updated", "en-US")]
        );
        assert_eq!(
            runtime
                .dispatch(&normal, &input("en-US"), RuntimeEvent::ContextUpdated)
                .actions,
            vec![intent("editors/hx.lua", "context-updated", "en-US")]
        );

        let mut block = normal.clone();
        block.cursor_style.shape = CursorShape::Block;
        runtime.dispatch(&block, &input("en-US"), RuntimeEvent::ContextUpdated);
        assert_eq!(
            runtime
                .dispatch(&insert, &input("en-US"), RuntimeEvent::ContextUpdated)
                .actions,
            vec![intent(
                "editors/hx.lua",
                "context-updated",
                typewriter_russian
            )]
        );

        runtime.dispatch(
            &insert,
            &input("en-US"),
            RuntimeEvent::InputLanguageChanged {
                layout: "en-US".into(),
            },
        );
        assert_eq!(
            runtime
                .dispatch(&insert, &input("en-US"), RuntimeEvent::ContextUpdated)
                .actions,
            vec![intent(
                "editors/hx.lua",
                "context-updated",
                typewriter_russian
            )]
        );
        runtime.dispatch(
            &insert,
            &input(typewriter_russian),
            RuntimeEvent::InputLanguageChanged {
                layout: typewriter_russian.into(),
            },
        );
        assert!(
            runtime
                .dispatch(&insert, &input(old_russian), RuntimeEvent::ContextUpdated,)
                .actions
                .is_empty()
        );
        assert_eq!(
            runtime
                .dispatch(&normal, &input(old_russian), RuntimeEvent::ContextUpdated)
                .actions,
            vec![intent("editors/hx.lua", "context-updated", "en-US")]
        );
        assert_eq!(
            runtime
                .dispatch(&insert, &input("en-US"), RuntimeEvent::ContextUpdated)
                .actions,
            vec![intent("editors/hx.lua", "context-updated", old_russian)]
        );
    }

    #[test]
    fn failed_callback_discards_all_intents_and_disables_only_until_reload() {
        let (_dir, mut runtime) = setup(
            "local sterm=require 'sterm'; sterm.on('tab-activated', function(ctx) ctx.input:set_layout('en-US'); error('broken') end)",
        );
        let state = tab("a", Some("nvim.exe"), true, true);
        runtime.attach_tab(state.clone(), InputState::default());
        let result = runtime.dispatch(&state, &InputState::default(), RuntimeEvent::TabActivated);
        assert!(result.actions.is_empty());
        assert_eq!(result.diagnostics.len(), 1);
        let again = runtime.dispatch(&state, &InputState::default(), RuntimeEvent::TabActivated);
        assert!(again.actions.is_empty() && again.diagnostics.is_empty());
    }

    #[test]
    fn retained_callback_context_expires_and_reload_resets_disabled_state() {
        let (_dir, mut runtime) = setup(
            r#"
local sterm=require 'sterm'; local stale
sterm.on('tab-activated', function(ctx) stale=ctx end)
sterm.on('cursor-style-changed', function() stale.input:set_layout('en-US') end)
"#,
        );
        let state = tab("a", Some("nvim.exe"), true, true);
        runtime.attach_tab(state.clone(), InputState::default());
        runtime.dispatch(&state, &InputState::default(), RuntimeEvent::TabActivated);
        let result = runtime.dispatch(
            &state,
            &InputState::default(),
            RuntimeEvent::CursorStyleChanged {
                old_cursor: state.cursor_style.clone(),
                new_cursor: state.cursor_style.clone(),
            },
        );
        assert!(result.actions.is_empty());
        assert_eq!(result.diagnostics.len(), 1);
        let snapshot = runtime.snapshot.clone();
        let attached = runtime.reload(snapshot, [(state.clone(), InputState::default())]);
        assert!(attached.iter().all(|result| result.diagnostics.is_empty()));
        runtime.close_tab(&state.id);
        let closed = runtime.dispatch(&state, &InputState::default(), RuntimeEvent::TabActivated);
        assert!(closed.actions.is_empty() && closed.diagnostics.is_empty());
    }

    #[test]
    fn each_process_binding_gets_independent_lua_state() {
        let dir = TempDir::new();
        dir.write("config.lua", "local sterm=require 'sterm'; sterm.use('same.lua', {when={process={'vim.exe'}}}); sterm.use('same.lua', {when={process={'test-editor.exe'}}})");
        dir.write("same.lua", "local sterm=require 'sterm'; local count=0; sterm.on('cursor-style-changed', function(ctx) count=count+1; ctx.input:set_layout(tostring(count)) end)");
        let mut runtime = LuaRuntime::new(RuntimeSnapshot::load(&dir.entry()).unwrap());
        let vim = tab("vim", Some("vim.exe"), true, true);
        let other = tab("other", Some("test-editor.exe"), true, true);
        runtime.attach_tab(vim.clone(), InputState::default());
        runtime.attach_tab(other.clone(), InputState::default());
        for state in [&vim, &other] {
            let result = runtime.dispatch(
                state,
                &InputState::default(),
                RuntimeEvent::CursorStyleChanged {
                    old_cursor: state.cursor_style.clone(),
                    new_cursor: state.cursor_style.clone(),
                },
            );
            assert_eq!(
                result.actions,
                vec![intent("same.lua", "cursor-style-changed", "1")]
            );
        }
    }

    #[test]
    fn execution_and_memory_budgets_stop_loops_and_large_allocations() {
        let lua = new_lua().unwrap();
        assert!(
            execute_limited(
                &lua,
                "while true do if pcall then pcall(function() end) end end",
                "loop"
            )
            .is_err()
        );
        let lua = new_lua().unwrap();
        assert!(
            execute_limited(
                &lua,
                "local t={}; while true do t[#t+1]=string.rep('x',100000) end",
                "memory"
            )
            .is_err()
        );
    }

    #[test]
    fn declared_modules_are_cached_per_vm_and_isolated_per_tab() {
        let dir = TempDir::new();
        dir.write(
            "config.lua",
            "local sterm=require 'sterm'; sterm.module('counter', 'modules/counter.lua'); sterm.use('editor.lua', {when={process={'nvim.exe'}}})",
        );
        dir.write(
            "modules/counter.lua",
            "local count=0; return function() count=count+1; return count end",
        );
        dir.write(
            "editor.lua",
            "local next=require 'counter'; assert(next == require 'counter'); local sterm=require 'sterm'; sterm.on('tab-activated', function(ctx) ctx.input:set_layout(tostring(next())) end)",
        );

        let mut runtime = LuaRuntime::new(RuntimeSnapshot::load(&dir.entry()).unwrap());
        let first = tab("first", Some("nvim.exe"), true, true);
        let second = tab("second", Some("nvim.exe"), true, true);
        runtime.attach_tab(first.clone(), InputState::default());
        runtime.attach_tab(second.clone(), InputState::default());

        for state in [&first, &second] {
            assert_eq!(
                runtime
                    .dispatch(state, &InputState::default(), RuntimeEvent::TabActivated)
                    .actions,
                vec![intent("editor.lua", "tab-activated", "1")]
            );
        }
        assert_eq!(
            runtime
                .dispatch(&first, &InputState::default(), RuntimeEvent::TabActivated)
                .actions,
            vec![intent("editor.lua", "tab-activated", "2")]
        );
    }

    #[test]
    fn module_source_stays_snapshotted_until_reload() {
        let dir = TempDir::new();
        dir.write(
            "config.lua",
            "local sterm=require 'sterm'; sterm.module('value', 'value.lua'); sterm.use('editor.lua', {when={process={'nvim.exe'}}})",
        );
        dir.write("value.lua", "return 'before'");
        dir.write(
            "editor.lua",
            "local value=require 'value'; local sterm=require 'sterm'; sterm.on('tab-activated', function(ctx) ctx.input:set_layout(value) end)",
        );
        let mut runtime = LuaRuntime::new(RuntimeSnapshot::load(&dir.entry()).unwrap());
        let state = tab("tab", Some("nvim.exe"), true, true);
        runtime.attach_tab(state.clone(), InputState::default());
        dir.write("value.lua", "return 'after'");

        assert_eq!(
            runtime
                .dispatch(&state, &InputState::default(), RuntimeEvent::TabActivated)
                .actions,
            vec![intent("editor.lua", "tab-activated", "before")]
        );

        let next_snapshot = RuntimeSnapshot::load(&dir.entry()).unwrap();
        runtime.reload(next_snapshot, [(state.clone(), InputState::default())]);
        assert_eq!(
            runtime
                .dispatch(&state, &InputState::default(), RuntimeEvent::TabActivated)
                .actions,
            vec![intent("editor.lua", "tab-activated", "after")]
        );
    }

    #[test]
    fn module_manifest_rejects_unregistered_paths_and_cycles() {
        let dir = TempDir::new();
        dir.write(
            "config.lua",
            "local sterm=require 'sterm'; sterm.module('shared', '../outside.lua')",
        );
        assert!(RuntimeSnapshot::load(&dir.entry()).is_err());

        dir.write(
            "config.lua",
            "local sterm=require 'sterm'; sterm.module('shared', 'shared.lua'); sterm.use('editor.lua', {})",
        );
        dir.write("shared.lua", "return true");
        dir.write("editor.lua", "require 'not_registered'");
        assert!(RuntimeSnapshot::load(&dir.entry()).is_err());

        dir.write(
            "config.lua",
            "local sterm=require 'sterm'; sterm.module('first', 'first.lua'); sterm.module('second', 'second.lua'); sterm.use('editor.lua', {})",
        );
        dir.write("first.lua", "return require 'second'");
        dir.write("second.lua", "return require 'first'");
        dir.write("editor.lua", "require 'first'");
        assert!(RuntimeSnapshot::load(&dir.entry()).is_err());

        for invalid_config in [
            "local sterm=require 'sterm'; sterm.module('sterm', 'shared.lua')",
            "local sterm=require 'sterm'; sterm.module('bad-name', 'shared.lua')",
            "local sterm=require 'sterm'; sterm.module('same', 'first.lua'); sterm.module('same', 'second.lua')",
        ] {
            dir.write("config.lua", invalid_config);
            assert!(RuntimeSnapshot::load(&dir.entry()).is_err());
        }

        dir.write(
            "config.lua",
            "local sterm=require 'sterm'; sterm.module('missing', 'missing.lua')",
        );
        assert!(RuntimeSnapshot::load(&dir.entry()).is_err());

        dir.write(
            "config.lua",
            "local sterm=require 'sterm'; sterm.module('loop', 'loop.lua'); sterm.use('editor.lua', {})",
        );
        dir.write("loop.lua", "while true do end");
        dir.write("editor.lua", "require 'loop'");
        assert!(RuntimeSnapshot::load(&dir.entry()).is_err());

        let mut config = String::from("local sterm=require 'sterm';");
        for index in 0..8 {
            config.push_str(&format!(" sterm.module('m{index}', 'm{index}.lua');"));
            dir.write(
                &format!("m{index}.lua"),
                &format!("--{}", "x".repeat(MAX_SCRIPT_BYTES - 2)),
            );
        }
        dir.write("config.lua", &config);
        assert!(RuntimeSnapshot::load(&dir.entry()).is_err());
    }

    #[test]
    fn loader_rejects_traversal_missing_modules_and_unsafe_lua_apis() {
        let dir = TempDir::new();
        dir.write(
            "config.lua",
            "local sterm=require 'sterm'; sterm.use('../outside.lua', {})",
        );
        assert!(RuntimeSnapshot::load(&dir.entry()).is_err());
        dir.write(
            "config.lua",
            "local sterm=require 'sterm'; sterm.use('scripts/modal-layout.lua', {})",
        );
        dir.write("scripts/modal-layout.lua", "assert(io == nil and os == nil and package == nil and debug == nil and load == nil and dofile == nil and pcall == nil and xpcall == nil and coroutine == nil and string.match == nil); local sterm=require 'sterm'; sterm.on('input-language-changed', function() end)");
        let snapshot = RuntimeSnapshot::load(&dir.entry()).unwrap();
        assert!(snapshot.wants_input_language_events());
    }

    #[test]
    fn unknown_cursor_shape_does_not_force_an_action() {
        let (_dir, mut runtime) = setup(
            "local sterm=require 'sterm'; sterm.on('cursor-style-changed', function(ctx) if ctx.tab:cursor_style().shape == 'bar' then ctx.input:set_layout('en-US') end end)",
        );
        let mut state = tab("a", Some("nvim.exe"), true, true);
        state.cursor_style.shape = CursorShape::Unknown;
        runtime.attach_tab(state.clone(), InputState::default());
        let result = runtime.dispatch(
            &state,
            &InputState::default(),
            RuntimeEvent::CursorStyleChanged {
                old_cursor: state.cursor_style.clone(),
                new_cursor: state.cursor_style.clone(),
            },
        );
        assert!(result.actions.is_empty() && result.diagnostics.is_empty());
    }
}

#[cfg(test)]
mod scenario_reload_lifecycle_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEMP: AtomicUsize = AtomicUsize::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "sterm-lua-reload-test-{}-{}",
                std::process::id(),
                NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn write(&self, name: &str, source: &str) {
            let path = self.0.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, source).unwrap();
        }

        fn entry(&self) -> PathBuf {
            self.0.join("config.lua")
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn tab(process: &str, preset_name: &str) -> TabState {
        TabState {
            id: "far-tab".into(),
            title: "FAR".into(),
            local_process_name: Some(process.into()),
            process_names: vec![process.into()],
            preset_name: preset_name.into(),
            cursor_style: CursorStyle {
                shape: CursorShape::Block,
                blink: Some(true),
                visible: true,
            },
            active: true,
            focused: true,
        }
    }

    fn write_far(dir: &TempDir, target: &str) {
        dir.write(
            "config.lua",
            "local sterm=require 'sterm'; sterm.use('scripts/far_preset.lua', {})",
        );
        let source = include_str!("../../examples/lua/scripts/far_preset.lua").replace(
            "local far_preset = 'DEC VT-100 (1978)'",
            &format!("local far_preset = '{target}'"),
        );
        dir.write("scripts/far_preset.lua", &source);
    }

    #[test]
    fn shipped_far_binding_keeps_baseline_on_retarget_reload_exit_and_inactive_removal() {
        let dir = TempDir::new();
        write_far(&dir, "FAR profile B");

        let initial = RuntimeSnapshot::load(&dir.entry()).unwrap();
        let state_key = initial.attachment_state_keys().into_iter().next().unwrap();
        let state_store = ScenarioStateStore::default();
        let mut runtime = LuaRuntime::with_state_store(initial, state_store.clone());
        let input = InputState::default();
        let mut tab = tab("cmd.exe", "Saved profile");
        runtime.attach_tab(tab.clone(), input.clone());

        tab.local_process_name = Some("FAR.EXE".into());
        tab.process_names = vec!["cmd.exe".into(), "FAR.EXE".into()];
        let entered = runtime.dispatch(
            &tab,
            &input,
            RuntimeEvent::LocalProcessChanged {
                old_process: Some("cmd.exe".into()),
                new_process: Some("FAR.EXE".into()),
            },
        );
        assert_eq!(
            entered.actions[0].action,
            Action::ApplyPreset("FAR profile B".into())
        );
        tab.preset_name = "FAR profile B".into();
        runtime.dispatch(&tab, &input, RuntimeEvent::ContextUpdated);
        let scope = (tab.id.clone(), state_key.clone());
        assert_eq!(
            state_store.0.lock().unwrap()[&scope]["far_preset.baseline"],
            ScenarioValue::String("Saved profile".into())
        );

        tab.local_process_name = Some("nvim.exe".into());
        tab.process_names = vec!["pwsh.exe".into(), "FAR.EXE".into(), "nvim.exe".into()];
        runtime.dispatch(
            &tab,
            &input,
            RuntimeEvent::LocalProcessChanged {
                old_process: Some("FAR.EXE".into()),
                new_process: Some("nvim.exe".into()),
            },
        );
        assert!(runtime.dispatch(&tab, &input, RuntimeEvent::ContextUpdated).actions.is_empty());
        assert_eq!(
            state_store.0.lock().unwrap()[&scope]["far_preset.baseline"],
            ScenarioValue::String("Saved profile".into())
        );
        tab.local_process_name = Some("FAR.EXE".into());
        tab.process_names = vec!["pwsh.exe".into(), "FAR.EXE".into()];
        runtime.dispatch(
            &tab,
            &input,
            RuntimeEvent::LocalProcessChanged {
                old_process: Some("nvim.exe".into()),
                new_process: Some("FAR.EXE".into()),
            },
        );
        assert!(runtime.dispatch(&tab, &input, RuntimeEvent::ContextUpdated).actions.is_empty());

        write_far(&dir, "FAR profile C");
        let next = RuntimeSnapshot::load(&dir.entry()).unwrap();
        tab.focused = false;
        let reloaded = runtime.reload(next, [(tab.clone(), input.clone())]);
        assert!(reloaded[0].actions.is_empty());
        let reload_context = runtime.dispatch(&tab, &input, RuntimeEvent::ContextUpdated);
        assert_eq!(
            reload_context.actions[0].action,
            Action::ApplyPreset("FAR profile C".into())
        );
        tab.preset_name = "FAR profile C".into();
        assert!(
            runtime
                .dispatch(&tab, &input, RuntimeEvent::ContextUpdated)
                .actions
                .is_empty()
        );
        assert_eq!(
            state_store.0.lock().unwrap()[&scope]["far_preset.baseline"],
            ScenarioValue::String("Saved profile".into())
        );
        let repeated = RuntimeSnapshot::load(&dir.entry()).unwrap();
        let reloaded = runtime.reload(repeated, [(tab.clone(), input.clone())]);
        assert!(reloaded[0].actions.is_empty());
        assert_eq!(
            runtime
                .dispatch(&tab, &input, RuntimeEvent::ContextUpdated)
                .actions[0]
                .action,
            Action::ApplyPreset("FAR profile C".into())
        );
        assert_eq!(
            state_store.0.lock().unwrap()[&scope]["far_preset.baseline"],
            ScenarioValue::String("Saved profile".into())
        );

        tab.preset_name = "FAR profile C".into();
        tab.local_process_name = Some("cmd.exe".into());
        tab.process_names = vec!["pwsh.exe".into()];
        runtime.dispatch(
            &tab,
            &input,
            RuntimeEvent::LocalProcessChanged {
                old_process: Some("FAR.EXE".into()),
                new_process: Some("cmd.exe".into()),
            },
        );
        let exited = runtime.dispatch(&tab, &input, RuntimeEvent::ContextUpdated);
        assert_eq!(
            exited.actions[0].action,
            Action::ApplyPreset("Saved profile".into())
        );
        assert!(state_store.0.lock().unwrap().is_empty());

        tab.preset_name = "Saved profile".into();
        tab.local_process_name = Some("FAR.EXE".into());
        tab.process_names = vec!["pwsh.exe".into(), "FAR.EXE".into()];
        runtime.dispatch(
            &tab,
            &input,
            RuntimeEvent::LocalProcessChanged {
                old_process: Some("cmd.exe".into()),
                new_process: Some("FAR.EXE".into()),
            },
        );
        assert_eq!(
            runtime
                .dispatch(&tab, &input, RuntimeEvent::ContextUpdated)
                .actions[0]
                .action,
            Action::ApplyPreset("FAR profile C".into())
        );
        tab.preset_name = "FAR profile C".into();
        tab.active = false;
        tab.focused = false;

        let removed = RuntimeSnapshot::load_source(&dir.entry(), "").unwrap();
        let cleanup = runtime.prepare_removed_attachments(
            &removed.attachment_state_keys(),
            &HashMap::from([(tab.id.clone(), (tab.clone(), input))]),
        );
        assert_eq!(cleanup.cleanup.len(), 1);
        assert_eq!(cleanup.cleanup[0].tab_id, tab.id);
        assert_eq!(cleanup.cleanup[0].attachment_key, state_key);
        assert_eq!(cleanup.cleanup[0].name, "Saved profile");
        assert_eq!(cleanup.cleanup[0].expected_current_preset, "FAR profile C");
        assert_eq!(
            state_store.0.lock().unwrap()[&scope]["far_preset.baseline"],
            ScenarioValue::String("Saved profile".into())
        );
        state_store.retain(
            &HashSet::from([tab.id.clone()]),
            &removed.attachment_state_keys(),
        );
        assert!(state_store.0.lock().unwrap().is_empty());
    }
}
