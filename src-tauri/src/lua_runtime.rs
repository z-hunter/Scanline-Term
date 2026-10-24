//! Sandboxed, tab-local Lua event scripts. The controller owns this runtime on
//! its bounded worker and applies returned actions after checking its generation.

use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use mlua::{Function, HookTriggers, Lua, LuaOptions, StdLib, Table, Value, VmState};
use serde_json::{Map as JsonMap, Number as JsonNumber, Value as JsonValue};

const MAX_CONFIG_BYTES: usize = 256 * 1024;
const MAX_SCRIPT_BYTES: usize = 256 * 1024;
const MAX_ATTACHMENTS: usize = 64;
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

#[derive(Clone)]
struct Attachment {
    source_name: String,
    source: Arc<str>,
    process_matches: Option<Vec<String>>,
    options: JsonValue,
    events: HashSet<String>,
}

/// Immutable source generation. Reload by constructing a new snapshot and then
/// replacing the runtime's current generation on its owning controller worker.
#[derive(Clone)]
pub struct RuntimeSnapshot {
    config_path: PathBuf,
    attachments: Vec<Attachment>,
    wants_input_language_events: bool,
}

struct ScriptInstance {
    source_name: String,
    process_matches: Option<Vec<String>>,
    lua: Lua,
    handlers: HashMap<String, Vec<Function>>,
    activate_handlers: Vec<Function>,
    deactivate_handlers: Vec<Function>,
    active: bool,
    disabled: bool,
    epoch: Arc<AtomicU64>,
}

struct TabRuntime {
    scripts: Vec<ScriptInstance>,
}

pub struct LuaRuntime {
    snapshot: RuntimeSnapshot,
    tabs: HashMap<String, TabRuntime>,
}

impl RuntimeSnapshot {
    /// Loads the entry file and exactly the `.use()` scripts it declares.
    /// Relative paths are canonicalized under the entry file's directory.
    pub fn load(entry_path: &Path) -> Result<Self, Vec<Diagnostic>> {
        let mut diagnostics = Vec::new();
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
        let entry_source = match read_limited(&entry_path, MAX_CONFIG_BYTES) {
            Ok(source) => Arc::<str>::from(source),
            Err(error) => return Err(vec![diagnostic(Some(entry_name), None, error)]),
        };

        let registration_lua = match new_lua() {
            Ok(lua) => lua,
            Err(error) => return Err(vec![diagnostic(None, None, error.to_string())]),
        };
        let registrations = Arc::new(Mutex::new(
            Vec::<(String, Option<Vec<String>>, JsonValue)>::new(),
        ));
        if let Err(error) = install_registration_api(&registration_lua, registrations.clone()) {
            return Err(vec![diagnostic(Some(entry_name), None, error.to_string())]);
        }
        if let Err(error) = execute_limited(&registration_lua, &entry_source, &entry_name) {
            return Err(vec![diagnostic(Some(entry_name), None, error.to_string())]);
        }
        let registrations = match Arc::try_unwrap(registrations) {
            Ok(registrations) => registrations.into_inner().unwrap_or_default(),
            Err(registrations) => registrations
                .lock()
                .map(|items| items.clone())
                .unwrap_or_default(),
        };
        if registrations.len() > MAX_ATTACHMENTS {
            return Err(vec![diagnostic(
                Some(entry_name),
                None,
                format!("configuration declares more than {MAX_ATTACHMENTS} script attachments"),
            )]);
        }

        let mut source_cache = HashMap::<PathBuf, Arc<str>>::new();
        let mut total_bytes = entry_source.len();
        let mut attachments = Vec::with_capacity(registrations.len());
        for (relative, process_matches, options) in registrations {
            let resolved = match confined_script_path(root, &relative) {
                Ok(path) => path,
                Err(error) => {
                    diagnostics.push(diagnostic(Some(entry_name.clone()), None, error));
                    continue;
                }
            };
            let source_name = relative.replace('\\', "/");
            if attachments.len() >= MAX_ATTACHMENTS {
                return Err(vec![diagnostic(
                    Some(entry_name),
                    None,
                    format!(
                        "configuration declares more than {MAX_ATTACHMENTS} script attachments"
                    ),
                )]);
            }
            let source = if let Some(source) = source_cache.get(&resolved) {
                source.clone()
            } else {
                match read_limited(&resolved, MAX_SCRIPT_BYTES) {
                    Ok(source) => {
                        total_bytes += source.len();
                        if total_bytes > MAX_TOTAL_SCRIPT_BYTES {
                            return Err(vec![diagnostic(
                                Some(entry_name),
                                None,
                                "Lua source snapshot exceeds the total size limit",
                            )]);
                        }
                        let source = Arc::<str>::from(source);
                        source_cache.insert(resolved.clone(), source.clone());
                        source
                    }
                    Err(error) => {
                        diagnostics.push(diagnostic(Some(source_name.clone()), None, error));
                        continue;
                    }
                }
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
                if let Err(error) = install_script_api(&lua, &source_name, &source) {
                    diagnostics.push(diagnostic(
                        Some(source_name.clone()),
                        None,
                        error.to_string(),
                    ));
                    continue;
                }
                if let Err(error) = execute_limited_with_args(&lua, &source, &source_name, options)
                {
                    diagnostics.push(diagnostic(
                        Some(source_name.clone()),
                        None,
                        format!("script validation failed: {error}"),
                    ));
                    continue;
                }
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
            config_path: entry_path,
            attachments,
            wants_input_language_events,
        })
    }

    pub fn config_path(&self) -> &Path {
        &self.config_path
    }

    pub fn wants_input_language_events(&self) -> bool {
        self.wants_input_language_events
    }
}

impl LuaRuntime {
    pub fn new(snapshot: RuntimeSnapshot) -> Self {
        Self {
            snapshot,
            tabs: HashMap::new(),
        }
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
                tab.local_process_name.as_deref(),
            ) && tab.active
                && tab.focused;
            if let Err(error) =
                install_script_api(&lua, &attachment.source_name, &attachment.source)
            {
                result.diagnostics.push(diagnostic(
                    Some(attachment.source_name.clone()),
                    None,
                    error.to_string(),
                ));
                continue;
            }
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
            let (handlers, activate_handlers, deactivate_handlers) = match handlers {
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
                lua,
                handlers,
                activate_handlers,
                deactivate_handlers,
                active,
                disabled: false,
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
            let callback_allowed = script.active
                || matches!(
                    event,
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
        } else {
            script.deactivate_handlers.clone()
        };
        let value = event.cloned().unwrap_or(JsonValue::Null);
        for handler in handlers {
            Self::run_callback(script, tab, input, &value, lifecycle, handler, result);
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
        result: &mut DispatchResult,
    ) {
        let epoch = script.epoch.fetch_add(1, Ordering::SeqCst).wrapping_add(1);
        let pending = Arc::new(Mutex::new(Vec::<Action>::new()));
        if let Err(error) = install_context_api(
            &script.lua,
            tab,
            input,
            script.active,
            script.epoch.clone(),
            epoch,
            pending.clone(),
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
    let started = Instant::now();
    let instructions = Arc::new(AtomicU64::new(0));
    lua.set_hook(
        HookTriggers::new().every_nth_instruction(HOOK_INSTRUCTION_INTERVAL),
        move |_, _| {
            let used = instructions.fetch_add(HOOK_INSTRUCTION_INTERVAL as u64, Ordering::Relaxed)
                + HOOK_INSTRUCTION_INTERVAL as u64;
            if used > MAX_INSTRUCTIONS || started.elapsed() > MAX_EXECUTION_TIME {
                return Err(mlua::Error::RuntimeError(
                    "Lua execution budget exceeded".into(),
                ));
            }
            Ok(VmState::Continue)
        },
    )
}

fn execute_limited(lua: &Lua, source: &str, name: &str) -> mlua::Result<()> {
    configure_budget(lua)?;
    lua.load(source).set_name(name).exec()
}

fn execute_limited_with_args(lua: &Lua, source: &str, name: &str, args: Value) -> mlua::Result<()> {
    configure_budget(lua)?;
    lua.load(source).set_name(name).call(args)
}

fn install_registration_api(
    lua: &Lua,
    registrations: Arc<Mutex<Vec<(String, Option<Vec<String>>, JsonValue)>>>,
) -> mlua::Result<()> {
    let module = lua.create_table()?;
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
            if registrations.len() >= MAX_ATTACHMENTS {
                return Err(mlua::Error::RuntimeError(format!(
                    "configuration exceeds the {MAX_ATTACHMENTS}-attachment limit"
                )));
            }
            registrations.push((path, process, script_options));
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

fn install_script_api(lua: &Lua, source_name: &str, source: &str) -> mlua::Result<()> {
    let handlers = lua.create_table()?;
    lua.globals().set("__sterm_handlers", handlers.clone())?;
    let handler_count = Arc::new(AtomicUsize::new(0));
    let module = lua.create_table()?;
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
    let _ = (source_name, source);
    lua.globals().set("sterm", module.clone())?;
    lua.globals().set(
        "require",
        lua.create_function(move |_, name: String| {
            if name == "sterm" {
                Ok(module.clone())
            } else {
                Err(mlua::Error::RuntimeError(
                    "script modules may require only the built-in 'sterm' module".into(),
                ))
            }
        })?,
    )
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
) -> mlua::Result<(HashMap<String, Vec<Function>>, Vec<Function>, Vec<Function>)> {
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
    Ok((handlers, activate, deactivate))
}

fn install_context_api(
    lua: &Lua,
    tab: &TabState,
    input: &InputState,
    active: bool,
    epoch: Arc<AtomicU64>,
    expected_epoch: u64,
    actions: Arc<Mutex<Vec<Action>>>,
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
    ctx.set("tab", tab_api)?;
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

fn process_matches(matches: Option<&[String]>, process: Option<&str>) -> bool {
    let Some(matches) = matches else {
        return true;
    };
    let Some(process) = process else {
        return false;
    };
    let process = process.rsplit(['\\', '/']).next().unwrap_or(process);
    matches
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(process))
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
        dir.write("config.lua", include_str!("../../examples/lua/sterm.lua"));
        dir.write(
            "scripts/modal-layout.lua",
            include_str!("../../examples/lua/scripts/modal-layout.lua"),
        );
        let snapshot = RuntimeSnapshot::load(&dir.entry()).unwrap();
        assert_eq!(snapshot.attachments.len(), 2);

        let mut runtime = LuaRuntime::new(snapshot);
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
            vec![intent("scripts/modal-layout.lua", "activate", "en-US")]
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
            vec![intent("scripts/modal-layout.lua", "activate", "en-US")]
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
        assert!(runtime
            .dispatch(
                &helix_insert,
                &InputState {
                    current_layout: Some("de-DE".into())
                },
                RuntimeEvent::ContextUpdated,
            )
            .actions
            .is_empty());

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
            vec![intent(
                "scripts/modal-layout.lua",
                "context-updated",
                "ru-RU"
            )]
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
            vec![intent("scripts/modal-layout.lua", "activate", "en-US")]
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
            vec![intent(
                "scripts/modal-layout.lua",
                "context-updated",
                "en-US"
            )]
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
        dir.write("config.lua", include_str!("../../examples/lua/sterm.lua"));
        dir.write(
            "scripts/modal-layout.lua",
            include_str!("../../examples/lua/scripts/modal-layout.lua"),
        );
        let snapshot = RuntimeSnapshot::load(&dir.entry()).unwrap();
        let mut runtime = LuaRuntime::new(snapshot);
        let input = InputState {
            current_layout: Some("0xF0080419".into()),
        };

        let mut helix_insert = tab("hx", Some("hx.exe"), true, true);
        helix_insert.cursor_style.shape = CursorShape::Bar;
        assert!(runtime
            .attach_tab(helix_insert.clone(), input.clone())
            .actions
            .is_empty());

        let mut helix_normal = helix_insert.clone();
        helix_normal.cursor_style.visible = false;
        assert_eq!(
            runtime
                .dispatch(
                    &helix_normal,
                    &input,
                    RuntimeEvent::ContextUpdated,
                )
                .actions,
            vec![intent("scripts/modal-layout.lua", "context-updated", "en-US")]
        );

        let unexpected_layout = InputState {
            current_layout: Some("0x04190419".into()),
        };
        assert!(runtime
            .dispatch(
                &helix_normal,
                &unexpected_layout,
                RuntimeEvent::InputLanguageChanged {
                    layout: "0x04190419".into(),
                },
            )
            .actions
            .is_empty());
        assert_eq!(
            runtime
                .dispatch(
                    &helix_normal,
                    &unexpected_layout,
                    RuntimeEvent::ContextUpdated
                )
                .actions,
            vec![intent(
                "scripts/modal-layout.lua",
                "context-updated",
                "en-US"
            )]
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
            vec![intent(
                "scripts/modal-layout.lua",
                "context-updated",
                "0xF0080419"
            )]
        );

        let mut nvim_insert = tab("nvim", Some("nvim.exe"), true, true);
        nvim_insert.cursor_style.shape = CursorShape::Bar;
        assert!(runtime
            .attach_tab(nvim_insert.clone(), input.clone())
            .actions
            .is_empty());
        let mut nvim_hidden_bar = nvim_insert.clone();
        nvim_hidden_bar.cursor_style.visible = false;
        assert!(runtime
            .dispatch(
                &nvim_hidden_bar,
                &input,
                RuntimeEvent::ContextUpdated,
            )
            .actions
            .is_empty());
    }

    #[test]
    fn shared_example_captures_and_restores_exact_insert_layout_across_mode_events() {
        let dir = TempDir::new();
        dir.write("config.lua", include_str!("../../examples/lua/sterm.lua"));
        dir.write(
            "scripts/modal-layout.lua",
            include_str!("../../examples/lua/scripts/modal-layout.lua"),
        );
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
            vec![intent("scripts/modal-layout.lua", "activate", "en-US")]
        );

        let mut insert = normal.clone();
        insert.cursor_style.shape = CursorShape::Bar;
        assert!(runtime
            .dispatch(
                &insert,
                &input("en-US"),
                RuntimeEvent::CursorStyleChanged {
                    old_cursor: normal.cursor_style.clone(),
                    new_cursor: insert.cursor_style.clone(),
                },
            )
            .actions
            .is_empty());
        assert_eq!(
            runtime
                .dispatch(&insert, &input("en-US"), RuntimeEvent::ContextUpdated)
                .actions,
            vec![intent(
                "scripts/modal-layout.lua",
                "context-updated",
                old_russian
            )]
        );
        runtime.dispatch(
            &insert,
            &input(old_russian),
            RuntimeEvent::InputLanguageChanged {
                layout: old_russian.into(),
            },
        );

        assert!(runtime
            .dispatch(
                &normal,
                &input(typewriter_russian),
                RuntimeEvent::CursorStyleChanged {
                    old_cursor: insert.cursor_style.clone(),
                    new_cursor: normal.cursor_style.clone(),
                },
            )
            .actions
            .is_empty());
        assert_eq!(
            runtime
                .dispatch(
                    &normal,
                    &input(typewriter_russian),
                    RuntimeEvent::ContextUpdated,
                )
                .actions,
            vec![intent(
                "scripts/modal-layout.lua",
                "context-updated",
                "en-US"
            )]
        );
        assert_eq!(
            runtime
                .dispatch(&normal, &input("en-US"), RuntimeEvent::ContextUpdated)
                .actions,
            vec![intent(
                "scripts/modal-layout.lua",
                "context-updated",
                "en-US"
            )]
        );

        let mut block = normal.clone();
        block.cursor_style.shape = CursorShape::Block;
        runtime.dispatch(&block, &input("en-US"), RuntimeEvent::ContextUpdated);
        assert_eq!(
            runtime
                .dispatch(&insert, &input("en-US"), RuntimeEvent::ContextUpdated)
                .actions,
            vec![intent(
                "scripts/modal-layout.lua",
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
                "scripts/modal-layout.lua",
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
        assert!(runtime
            .dispatch(&insert, &input(old_russian), RuntimeEvent::ContextUpdated,)
            .actions
            .is_empty());
        assert_eq!(
            runtime
                .dispatch(&normal, &input(old_russian), RuntimeEvent::ContextUpdated)
                .actions,
            vec![intent(
                "scripts/modal-layout.lua",
                "context-updated",
                "en-US"
            )]
        );
        assert_eq!(
            runtime
                .dispatch(&insert, &input("en-US"), RuntimeEvent::ContextUpdated)
                .actions,
            vec![intent(
                "scripts/modal-layout.lua",
                "context-updated",
                old_russian
            )]
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
