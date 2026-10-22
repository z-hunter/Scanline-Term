# Scanline Term — Lua Configuration & Automation Layer

Status: Backlog specification  
Target: post-v0.5.x / implementation only after explicit prioritization  
Scope: lightweight, sandboxed Lua 5.4 event automation, tab-local scripting, host-side input remapping, and optional configuration-as-code  

## 1. Purpose

Add an optional Lua layer to Scanline Term that can:

1. observe a small, explicit set of terminal/application events;
2. activate scripts conditionally for the application currently represented by a terminal tab;
3. keep script state isolated per tab;
4. invoke a bounded set of safe Scanline Term host actions;
5. intercept and transform terminal-session key input before it is sent to ConPTY;
6. expose every GUI-configurable setting through the same validated settings model, including runtime tab-local overrides;
7. optionally define startup/application configuration, launch profiles, and key bindings.

The feature is intended to enable small workflow automations without turning Scanline Term into a general-purpose scripting host. Scanline Term remains GUI-first: common settings such as fonts, display/CRT options, presets, tabs, browser behavior, and ordinary shortcuts remain configurable through the UI. Lua exists for behavior that is conditional, stateful, or inconvenient to express in GUI controls. Every setting that can be changed through the GUI should also be addressable through Lua through the same typed validation/state path; Lua must not gain a parallel or more weakly validated settings implementation.

Unlike WezTerm, Scanline Term does not aim to make Lua the mandatory or primary configuration surface. The product advantage is that ordinary configuration remains accessible through GUI controls while Lua provides an advanced escape hatch for programmable behavior.

The canonical acceptance scenario is automatic Windows input-language management for Vim/Neovim based on terminal state:

- detect that the active terminal tab is running Vim/Neovim;
- infer Insert vs Normal mode from cursor style changes emitted by the application (for example via DECSCUSR);
- remember the user's last input language while in Insert mode;
- force English when entering Normal mode;
- restore the remembered Insert-mode language when returning to Insert mode;
- never allow a background tab to change the user's global input language.

## 2. Design principles

### 2.1 Event-driven, not polling-driven

Lua should react to state changes emitted by Scanline Term. Scripts should not need timers or loops to inspect terminal state repeatedly.

### 2.2 Capability-limited

Lua may inspect approved application state and call approved Scanline Term actions. It must not receive unrestricted filesystem, process, network, Win32, DOM, renderer, or Tauri access.

### 2.3 Existing systems remain authoritative

Lua must operate through existing Scanline Term abstractions. It must not mutate React state, terminal parser state, renderer internals, ConPTY handles, or native window internals directly.

### 2.4 Focus safety

Actions affecting global/user input state, especially keyboard layout, may only be applied for the active tab in the focused Scanline Term window.

### 2.5 Error isolation

A failing or looping script must not freeze the terminal, renderer, input loop, or ConPTY processing.

### 2.6 No compatibility promise with WezTerm

The syntax and concepts may be familiar to WezTerm users, but Scanline Term should expose its own smaller API. Existing `.wezterm.lua` files are not expected to run unchanged.

### 2.7 Tab-local by default

Runtime automation is owned by a specific tab. A script instance attached to one tab must not read or mutate another tab's transient script state or input path in V1.

### 2.8 Explicit activation and deactivation

A script may be attached to a tab while inactive. Matching terminal/application context activates it; loss of that context deactivates it. Deactivation must synchronously cancel pending input transformations and release synthetic modifiers before normal input resumes.

### 2.9 Application identity is evidence, not magic

Scanline Term should not claim to semantically know that a terminal is running Vim, Helix, or another application. Scripts may match a combination of local process evidence, OSC/tab title, and an explicit application marker supplied by the terminal application or plugin.


### 2.10 One settings model, two interfaces

GUI and Lua are peer interfaces to the same canonical settings model. If the GUI can change a setting (font, font size, CRT enablement, CRT parameters, preset, browser form factor, tab-bar behavior, smooth scrolling, etc.), Lua should be able to query and change the equivalent setting unless a specific capability/safety restriction is documented.

Both paths must use the same schema, normalization, range checks, persistence rules, and side-effect handlers. A Lua call must not bypass the behavior used by the GUI, and GUI code must not maintain hidden settings that Lua cannot represent.

Runtime Lua changes should normally be tab-local and lifecycle-scoped rather than silently rewriting the user's saved GUI preferences.

## 3. Runtime architecture

Architecture must be selected by a focused spike rather than fixed in advance. Candidate implementations include:

- a Lua 5.4 VM in Rust/Tauri for ordinary event automation;
- a Lua/WASM runtime near the frontend input path;
- a split runtime where general callbacks execute in Rust while latency-sensitive keyboard rules are compiled/mirrored into a synchronous frontend state machine.

If Rust-hosted Lua is selected, `mlua` with Lua 5.4, vendored runtime, execution limits, and explicit host bindings is the preferred candidate.

Regardless of VM placement:

- runtime script state is isolated per tab by default;
- callbacks are serialized within a tab context;
- callbacks have a bounded execution budget;
- host APIs are exposed explicitly through a built-in `sterm` module/capability context;
- unrestricted native Lua module loading is disabled;
- per-keystroke input decisions must not require asynchronous Tauri IPC.

Conceptual flow:

```text
Terminal / application state change
              ↓
        typed Sterm event
              ↓
       Lua event dispatcher
              ↓
       registered callback
              ↓
       bounded host API
              ↓
 existing Sterm action/state API
```

Lua must never sit on the critical path of terminal output parsing or rendering. Ordinary observation events may be queued after core state has already been updated.

Host-side keyboard remapping is a separate latency-sensitive path. Scripts that define input policy must not require an asynchronous Rust↔frontend round trip for every keystroke. The implementation should either execute the relevant decision logic in the frontend/input path, or compile declarative Lua-defined input rules into a small deterministic frontend keymap state machine.

## 4. Configuration file

Recommended names and lookup order on Windows:

```text
1. <sterm executable directory>\sterm.lua
2. %APPDATA%\com.zhunter.scanlineterm\config.lua
3. no Lua file → current built-in/saved settings behavior
```

The executable-directory file is important for portable ZIP installations.

A future CLI override may be added:

```text
sterm --config D:\dotfiles\sterm.lua
```

This is not required for V1.

## 5. Configuration and runtime settings semantics

Startup/default precedence:

```text
built-in defaults
      ↓
saved GUI settings
      ↓
Lua startup configuration
      ↓
CLI / explicit per-launch options
```

This precedence applies to constructing the initial/base state for a new tab or application session. Runtime automation is intentionally different: scripts should not repeatedly rewrite saved GUI preferences.

Each tab should resolve effective settings from layers:

```text
base tab settings (derived from GUI/default/preset/launch)
        ↓
script override layer 1
        ↓
script override layer 2
        ↓
...
        ↓
effective tab settings
```

A runtime script can therefore apply a scoped override, for example a different font or CRT preset while Neovim is active. When that script deactivates, reloads, fails, or its tab closes, its override layer is removed and the current underlying GUI/base value becomes visible again. The implementation must not restore a stale snapshot if the user changed the GUI setting while the script was active.

If multiple active scripts override the same property, declaration/pipeline order is authoritative: later layers win for that property. Diagnostics should identify the current winning source.

GUI edits remain allowed while a script override is active. If the edited property is currently shadowed by a Lua override, the GUI should make that state discoverable (for example, `Overridden by vim.lua`) rather than appearing broken. When the override disappears, the latest GUI value takes effect automatically.

Imperative one-shot actions may still use last-writer semantics where an override layer is inappropriate, but visual/configuration settings should prefer scoped layers.

## 6. Built-in Lua module

Scripts should use a built-in module:

```lua
local sterm = require 'sterm'
```

In V1, `require` should resolve only built-in Scanline Term modules. Arbitrary filesystem-backed Lua modules are outside the initial scope.

Potential future extension:

```lua
local profiles = require 'profiles'
```

loaded only from the trusted configuration directory.

## 7. Declarative configuration API

A minimal configuration object may be created as:

```lua
local sterm = require 'sterm'
local config = sterm.config_builder()

config.default_prog = { 'pwsh.exe', '-NoLogo' }
config.default_cwd = 'D:\\Projects'
config.default_preset = 'DEC VT-220 (1983)'

return config
```

Candidate V1 fields:

- `default_prog`
- `default_cwd`
- `default_preset`
- `set_environment_variables`
- `launch_menu`
- `global_hotkey_enabled`
- `hide_tab_bar`
- `hide_tab_bar_only_if_single_tab`
- `smooth_scrollback`
- `smooth_tui_scrolling`
- `browser_form_factor`

These fields should map onto existing Scanline Term configuration structures rather than creating parallel state. The long-term contract is broader: all settings represented in the GUI should be representable in Lua using the same canonical field names/types or an explicitly documented Lua mapping.

## 8. Launch profiles / launch menu

Example:

```lua
config.launch_menu = {
  {
    label = 'PowerShell',
    args = { 'pwsh.exe', '-NoLogo' },
  },
  {
    label = 'FAR',
    args = { 'far.exe' },
    preset = 'IBM 3278 (1977)',
  },
  {
    label = 'TurboIDE',
    args = { 'D:\\Tools\\TurboIDE\\turboide.exe' },
    cwd = 'D:\\Projects\\C',
    preset = 'IBM 5151 PC -MDA- (1981)',
  },
}
```

The data model should reuse the existing terminal launch concept:

```text
command
args
cwd
preset
```

Environment overrides may be added as an optional field.

## 9. Event API

Scripts register event handlers with:

```lua
sterm.on('event-name', function(...)
  -- handler
end)
```

Candidate V1 events:

### `tab-created`

Arguments:

```text
tab
```

### `tab-closed`

Arguments:

```text
tab_id
```

The callback must not receive a live object that can outlive the tab.

### `tab-activated`

Arguments:

```text
tab
previous_tab_id
```

### `tab-title-changed`

Arguments:

```text
tab
old_title
new_title
```

### `local-process-changed`

Arguments:

```text
tab
old_process
new_process
```

### `cursor-style-changed`

Arguments:

```text
tab
old_cursor
new_cursor
```

Cursor state should expose normalized values such as:

```text
shape: block | underline | bar
blink: boolean
```

The event should reflect actual terminal state after DECSCUSR or equivalent parsing has completed.

### `tab-focus-changed`

Arguments:

```text
tab
focused: boolean
```

This refers to effective terminal/application focus, not merely whether the tab exists.

### `window-focus-changed`

Arguments:

```text
focused: boolean
```

### `input-language-changed`

Arguments:

```text
language
```

This event should be produced from native Windows input-language notifications, e.g. `WM_INPUTLANGCHANGE` or equivalent application-level handling.

## 10. Tab object

The Lua `tab` object is a safe handle to an existing Scanline Term tab.

Candidate read-only methods:

```lua
tab:id()
tab:title()
tab:kind()            -- 'terminal' | 'browser'
tab:is_active()
tab:is_focused()
tab:local_process_name()
tab:cursor_style()
tab:preset_name()
```

Where process identity is available, `local_process_name()` is preferred over title matching when the locally observable process identity is meaningful. It must not be described as a guaranteed remote/foreground application identity.

Title matching remains useful as a fallback because some terminal applications expose useful state through OSC title changes.

No direct DOM, renderer, xterm, ConPTY, HWND, or process handle should be exposed.


## 11. Application matching and script activation

A runtime script may be attached to a tab without being active. Scanline Term evaluates user-defined matching rules against tab-local application evidence.

Candidate evidence sources, in preferred order when available:

1. **Explicit application marker** — set by the terminal application/plugin through a dedicated Sterm user-variable/OSC mechanism, e.g. `app = "nvim"`. This is the most reliable signal when supported.
2. **Local child/process identity** — useful for local `pwsh -> nvim.exe`, `cmd -> hx.exe`, etc. It must not pretend to identify remote applications behind `ssh`, WSL wrappers, tmux, or arbitrary process trees.
3. **Tab/OSC title** — useful fallback heuristic, especially for remote applications, but user/script controlled and therefore not authoritative.

Example attachment:

```lua
sterm.use('scripts/caps-escape-control.lua', {
  when = {
    app = { 'vim', 'nvim', 'helix' },
    process = { 'vim.exe', 'nvim.exe', 'hx.exe' },
    title = { '*VIM*', '*NVIM*', '*helix*' },
  }
})
```

Matching semantics in V1:

- evidence categories (`app`, `process`, `title`) are OR alternatives;
- values inside one category are OR alternatives;
- a script is active while at least one configured alternative matches;
- a script without a `when` clause is always active in its owning tab;
- transition from unmatched to matched emits/executes `on_activate`;
- transition from matched to unmatched emits/executes `on_deactivate`;
- tab close destroys the script instance and all transient state.

The exact surface syntax is provisional, but activation/deactivation semantics are part of the contract.

### 11.1 Explicit application marker

Sterm should reserve a small terminal-to-host metadata mechanism analogous in spirit to terminal user variables. A Vim/Helix plugin may explicitly publish application identity/state without forcing Sterm to infer semantics from process trees or titles.

Conceptually:

```text
application/plugin -> OSC/user variable -> tab metadata -> Lua match/event
```

Candidate metadata:

```text
STERM_APP=nvim
```

Additional arbitrary application state may be considered later, but V1 only needs enough to identify the active terminal application reliably.

## 12. Script ownership and isolation

Each terminal tab owns independent runtime script instances. Reusable files are loaded from the trusted config directory, but instantiated separately per tab.

```text
Application Lua/config loader
        |
        +-- Tab A automation context
        |      +-- caps-escape-control.lua instance A
        |      +-- vim-input-language.lua instance A
        |
        +-- Tab B automation context
               +-- caps-escape-control.lua instance B
               +-- helix.lua instance B
```

Guarantees:

- transient Lua globals/upvalues are not shared between tab instances by default;
- closing a tab destroys its automation context;
- V1 exposes no arbitrary `get_tab(id)`/cross-tab mutation API;
- a script receives only its own `ctx.tab`;
- terminal-local actions are scoped to the owning tab;
- input remapping and input-language actions are permitted only when the owning tab is the active tab in the focused Sterm window.

This is a capability boundary, not merely a scripting convention.

### 12.1 Callback capability context

Runtime handlers should prefer a callback context object:

```lua
sterm.on('cursor-style-changed', function(ctx, event)
  if ctx.tab:is_active() then
    ctx.input:set_layout('en-US')
  end
end)
```

`ctx` exposes only capabilities valid for the owning tab/event. Inactive/background contexts must not be able to mutate foreground input state.

### 12.2 Multiple scripts in one tab

Observer callbacks receive events independently and should not conflict merely by observing state. Input transformers are ordered deterministically.

Recommended V1 rule: **declaration order is pipeline order**.

```lua
sterm.scripts = {
  'caps-escape-control.lua',
  'vim.lua',
}
```

Conceptual input pipeline:

```text
physical key
   -> script 1 transformer
   -> script 2 transformer
   -> normal terminal key encoder
   -> ConPTY
```

A transformer returns one of:

```text
pass unchanged
consume
replace with validated transformed input
```

No numeric priority system is required in V1 unless real use cases demonstrate the need.

## 13. Per-tab script state

Transient state is naturally isolated because each runtime script is instantiated per tab. A script may therefore use ordinary Lua locals/upvalues:

```lua
local insert_layout = nil
```

The instance is destroyed with the tab, so this state cannot leak into another tab.

An ergonomic host-managed `tab:state()` store may be added later if useful, but it is not required for the core isolation model and should not be mandatory in V1.

## 14. Input-language host API

Candidate API:

```lua
local current = ctx.input:current_layout()
ctx.input:set_layout('en-US')
```

Exact layout identifiers should use a stable representation. Human-readable BCP-47-like names are preferable at the Lua boundary where they can be mapped reliably to Windows layout identifiers.

The host implementation must enforce:

1. Scanline Term window is focused;
2. requesting tab is the active tab;
3. action originates from a currently valid callback context;
4. requested layout is installed/available;
5. failure is returned to Lua and does not surface untrusted terminal text as application UI.

Potential return shape:

```lua
local ok, err = ctx.input:set_layout('en-US')
```

## 15. Canonical Vim / Neovim automation

Application identification and mode interpretation are separate concerns. Sterm determines only tab-local evidence; the user script decides what that evidence means.

Illustrative script semantics:

```lua
local insert_layout = nil

local function apply_layout(ctx)
  local cursor = ctx.tab:cursor_style()

  if cursor.shape == 'bar' then
    -- User configuration interprets bar as Insert mode.
    if insert_layout then
      ctx.input:set_layout(insert_layout)
    end
  else
    -- User configuration interprets block/other as Normal mode.
    local current = ctx.input:current_layout()
    if current ~= 'en-US' then
      insert_layout = current
    end
    ctx.input:set_layout('en-US')
  end
end

sterm.on('activate', function(ctx)
  apply_layout(ctx)
end)

sterm.on('cursor-style-changed', function(ctx, event)
  apply_layout(ctx)
end)

sterm.on('input-language-changed', function(ctx, event)
  if ctx.tab:cursor_style().shape == 'bar' then
    insert_layout = event.language
  end
end)
```

The script instance is attached/activated using matching rules, for example `app = nvim`, local process `nvim.exe`, or title fallback. It therefore does not need to perform global tab discovery.

The script intentionally treats cursor shape as a user-defined heuristic. Scanline Term exposes terminal state; it does not claim to know Vim mode semantically. A Vim/Neovim plugin may provide an explicit `STERM_APP=nvim` marker to make application identification reliable, while mode interpretation may still remain user-script logic.

## 16. Host-side input interception and remapping

Lua automation may optionally define terminal-session keyboard behavior before input is encoded and sent to ConPTY. This is intended for context-sensitive host remapping such as Vim/Helix ergonomics, not global OS-wide keyboard replacement.

Canonical scenario:

- while the active tab matches Vim, Neovim, Helix, or another configured application;
- tapping Caps Lock by itself sends `Esc` to the terminal application;
- holding Caps Lock and pressing another key treats Caps Lock as `Ctrl`;
- the physical Caps Lock function is suppressed for that terminal context;
- leaving the matching application or tab restores normal Caps Lock behavior.

Example user-facing script shape:

```lua
local vim_keys = require 'vim-keys'

sterm.when({
  process = { 'vim.exe', 'nvim.exe', 'hx.exe' },
  title_matches = { 'VIM', 'Helix' },
}, function(ctx)
  ctx.keys:use(vim_keys)
end)
```

A reusable remap module could declare:

```lua
return {
  tap_hold = {
    key = 'CAPSLOCK',
    tap = 'ESC',
    hold_modifier = 'CTRL',
    timeout_ms = 180,
  },
}
```

Exact API names are provisional; the important contract is that scripts can define reusable input-policy modules and activate them conditionally per tab/application.

### 16.1 Input event model

The host input layer must distinguish at least:

- physical key down;
- physical key up;
- repeat;
- modifier state;
- text/composition input where applicable;
- whether an input event has been consumed by Sterm/Lua policy.

The remapper runs before the normal xterm/terminal key encoding path. A consumed physical event must not also reach ConPTY in its original form.

### 16.2 Tap-hold semantics

Tap-hold behavior cannot be implemented as a simple `key-pressed` callback. The host must maintain a tiny state machine for the candidate key.

For Caps→Esc/Ctrl:

```text
Caps down
  + released alone before threshold/without chord -> send Esc
  + another key pressed while held              -> synthesize Ctrl+that key
  + release after chord                         -> end Ctrl state
```

The implementation should avoid perceptible latency for ordinary keys. Only the ambiguous tap-hold key may require short deferred resolution.

### 16.3 Context activation

Input remaps exist inside the owning tab's automation context and are effective only when:

1. the script's application match is active;
2. the owning tab is the active tab;
3. the Scanline Term window has focus.

Matching may use:

- explicit application marker (`STERM_APP=nvim`, etc.) when available;
- local child/process name when meaningful;
- tab title / OSC title as a user-defined fallback heuristic;
- terminal kind where useful.

Remote applications over SSH cannot be identified reliably from the local process tree, so explicit markers/title heuristics remain necessary. Sterm must not claim semantic knowledge of the remote application.

Deactivation is atomic from the input system's perspective: pending tap-hold candidates are cancelled and any synthetic modifier state is released before ordinary input resumes.

### 16.4 Reusable script files

Unlike the minimal built-in-only `require` proposed for configuration V1, input automation has a strong practical case for user modules. A later phase should allow trusted Lua files from the Sterm config directory, for example:

```text
config.lua
lua/vim.lua
lua/helix.lua
lua/caps-escape-control.lua
```

The module search path must remain restricted to the configured trusted directory; native modules and arbitrary system Lua paths remain disabled.

### 16.5 Performance and architecture consequence

This use case strengthens the requirement for an architecture spike before fixing the Lua VM location. Cursor/title/process events can tolerate frontend↔Rust dispatch latency; per-keystroke remapping cannot.

Preferred options to evaluate:

1. Lua VM in/near the frontend input path; or
2. Lua executes at config/reload time and produces a validated declarative input-rule graph/state machine that runs synchronously in the frontend; or
3. a split model where general Lua callbacks live in Rust but latency-sensitive key rules are compiled and mirrored to the frontend.

Do not route every physical key event through asynchronous Tauri IPC.

### 16.6 Safety and failure behavior

- If the script/runtime fails, fall back to normal unmodified terminal input.
- A script must not leave a synthetic modifier logically stuck after tab switch, focus loss, reload, or exception.
- On focus loss, tab deactivation, script reload, or terminal close, all pending tap-hold state is cancelled and synthetic modifiers are released.
- Background tabs cannot consume or transform user input.
- Input remapping is scoped to Scanline Term; V1 does not install a system-wide keyboard hook.

### 16.7 Acceptance tests

Automated:

- tap Caps -> exactly one Esc is sent;
- Caps+H -> exactly Ctrl+H semantics, with no Caps Lock toggle;
- rapid repeated tap/hold sequences do not leave Ctrl stuck;
- auto-repeat is handled deterministically;
- switching tabs while Caps is held cancels state safely;
- window focus loss while Caps is held cancels state safely;
- inactive/non-matching applications receive normal Caps Lock behavior;
- script exception causes pass-through fallback;
- no asynchronous event race can reorder key input.

Manual:

- Vim/Neovim Normal/Insert workflows;
- Helix Normal/Insert workflows;
- local and SSH-hosted editors using title matching fallback;
- interaction with Windows IME/input-language switching.

## 17. Key binding API

Key bindings can share the same Lua runtime, but should use predefined actions rather than arbitrary callbacks in the first implementation.

Example:

```lua
local act = sterm.action

config.keys = {
  {
    key = 'P',
    mods = 'CTRL|SHIFT',
    action = act.ShowPresetPicker,
  },
  {
    key = 'G',
    mods = 'CTRL|SHIFT',
    action = act.ShowGallery,
  },
  {
    key = 'F',
    mods = 'CTRL|SHIFT',
    action = act.SpawnCommand {
      args = { 'far.exe' },
    },
  },
}
```

Candidate actions should wrap existing application operations only.

## 18. Runtime settings API

All GUI-configurable tab settings should be available through a bounded tab-local settings capability. Exact naming is provisional, but the preferred model is a scoped override rather than direct persistence mutation.

Example:

```lua
sterm.on('activate', function(ctx)
  ctx.settings:override {
    font = 'Iosevka Term',
    font_size = 15,
    preset = 'DEC VT-220 (1983)',
    crt = {
      enabled = true,
      curvature = 0.08,
    },
  }
end)
```

The override belongs to that script instance in that tab. It is automatically removed on deactivation/reload/tab close/script failure.

Candidate query surface:

```lua
local effective = ctx.settings:get('font')
local base = ctx.settings:get_base('font')
local source = ctx.settings:source('font')
```

The implementation may expose a structured settings table instead of string-key access, but it must preserve the same validation and source tracking.

Examples of settings that should eventually be scriptable because they are already GUI-configurable include:

- terminal font and fallback font;
- font size and cell geometry adjustments;
- cursor shape/blink where host-controlled;
- preset/profile selection;
- CRT enablement and all exposed CRT/display parameters;
- resolution/display form factor;
- smooth scrollback and TUI scrolling;
- tab-bar visibility/placement where applicable;
- browser form factor;
- other current/future GUI settings unless explicitly excluded for safety or lifecycle reasons.

Persistence is separate from runtime override. A script must not silently save permanent GUI preferences merely because it changes an effective setting. A future explicit persistence API, if added, should be visibly named and capability-restricted.

## 20. Host actions


Candidate initial actions:

- `NewTerminal`
- `NewBrowser`
- `CloseTab`
- `NextTab`
- `PreviousTab`
- `ActivateTab(index)`
- `ShowGallery`
- `ShowSettings`
- `ShowPresetPicker`
- `ToggleTabBar`
- `ToggleAI`
- `IncreaseFontSize`
- `DecreaseFontSize`
- `Paste`
- `CopyMode`
- `Find`
- `ScrollPageUp`
- `ScrollPageDown`
- `ToggleFullscreen`
- `SpawnCommand { ... }`

Potential tab-scoped visual actions may be considered later:

- `SetPreset(name)`
- `SetCRTEnabled(bool)`

These should still route through the same validation/state path as GUI actions.

## 20. Safety and sandboxing

V1 must not expose:

- arbitrary filesystem APIs;
- arbitrary process spawning outside approved launch actions;
- network APIs;
- FFI;
- native Lua modules;
- raw Win32 handles/APIs;
- DOM access;
- React component access;
- xterm parser/buffer internals;
- Scanline Virtual Screen renderer objects;
- direct ConPTY input/output handles;
- MCP ownership/session internals.

Lua standard libraries should be restricted accordingly. `io`, `os.execute`, package loading from arbitrary paths, and native module loading should be unavailable unless explicitly justified later.

## 21. Execution limits

Each callback should run under bounded execution.

Recommended protections:

- instruction-count budget or periodic hook;
- wall-clock timeout as a secondary guard;
- memory limit for the Lua VM;
- serialized callback queue;
- bounded event queue;
- repeated-failure suppression for a broken handler;
- errors logged to a dedicated Lua/config diagnostic surface.

A Lua callback must never block terminal parsing, renderer frames, ConPTY reads, keyboard input, or the native UI message loop.

## 22. Event coalescing

Some events may be noisy. V1 should define coalescing rules where useful.

Candidates:

- repeated identical cursor-state notifications may collapse;
- repeated title changes may keep only the latest pending value;
- focus and tab activation events must preserve ordering;
- input-language events must preserve ordering relative to script-requested language changes sufficiently to prevent feedback loops.

## 23. Reentrancy and feedback loops

A script action may itself produce an event.

Example:

```text
Lua calls set_layout('en-US')
→ Windows sends input-language-changed
→ Lua handler runs again
```

The system must tolerate this safely.

The event should not simply be suppressed globally because scripts may legitimately need to observe the result. Instead:

- callbacks must be serialized;
- state changes should be idempotent where possible;
- `set_layout()` should avoid requesting a change when the requested layout is already active;
- event metadata may optionally include `origin = 'user' | 'lua' | 'system'` in a later version if required.

## 24. Reload behavior

Minimum implementation:

- load Lua configuration at application startup;
- provide an explicit `Reload Lua Configuration` action;
- on reload, discard old callbacks and rebuild the Lua VM/config cleanly.

Automatic file watching is not required for V1.

Open tabs should not be recreated on reload. New configuration applies to future launches and to runtime-safe settings/actions only.

## 25. Diagnostics

Lua errors should be visible without breaking normal terminal use.

Recommended diagnostic information:

- config file path;
- parse/runtime error;
- event name;
- callback failure;
- execution-budget termination;
- invalid host action or argument;
- unavailable input layout;
- stale/closed tab handle;
- automation cause trace: script, owning tab, activation evidence, event, and host action (for example `vim-input-language.lua: cursor bar -> block -> layout en-US`).

A future `Menu` action may open a compact Lua diagnostics/log view.

## 26. Testing

### Unit tests

- config table validation;
- invalid field rejection;
- event registration;
- event ordering;
- per-tab script-instance lifecycle and state isolation;
- no cross-tab state/action access;
- activation/deactivation using app marker, local process, and title fallback;
- closed-tab handle rejection;
- callback error isolation;
- infinite-loop/instruction-budget termination;
- host action validation;
- layout-change focus guard;
- duplicate layout change suppression;
- title/local-process/cursor/application-marker event translation;
- deterministic ordering of multiple input transformers in one tab;
- GUI and Lua paths produce identical normalized values for the same setting;
- scoped runtime setting overrides do not persist unless explicitly requested;
- removing an override reveals the latest underlying GUI value rather than a stale snapshot;
- deterministic conflict resolution when multiple scripts override the same property.

### Integration tests

- Lua config affects new terminal launch;
- launch menu creates expected `command/args/cwd/preset`;
- active tab receives cursor-style event;
- background tab cannot change input language;
- tab activation reapplies expected state;
- reload replaces callbacks without duplicating handlers;
- Lua failure does not interfere with terminal I/O;
- application activation can apply tab-local font/preset/CRT overrides and deactivation removes them without affecting other tabs.

### Manual acceptance: Vim/Neovim layout scenario

1. Start Neovim in a Scanline Term tab.
2. Use a configuration where Insert mode produces a bar cursor and Normal mode a block cursor.
3. Enter Insert mode.
4. Select Russian input language.
5. Leave Insert mode.
6. Verify Sterm switches to English.
7. Re-enter Insert mode.
8. Verify Russian is restored.
9. Change Insert-mode language to another installed layout.
10. Leave and re-enter Insert mode; verify the new layout is restored.
11. While Vim remains open, activate another tab and type there.
12. Trigger cursor/state changes in the background Vim tab; verify the foreground input language does not change.
13. Return to Vim and verify layout is reconciled to the current cursor mode.

## 27. Phased scope

### Phase A — event automation core

- sandboxed Lua 5.4/runtime architecture spike;
- trusted script loading and explicit reload;
- per-tab script instances and capability context;
- activation/deactivation rules;
- application marker + local-process + title evidence;
- cursor/title/tab/window/input-language events;
- Windows input-language query/action;
- diagnostics and execution limits;
- Vim/Neovim input-language acceptance scenario;
- canonical shared Settings API foundation used by both GUI and Lua (runtime overrides may ship in a later phase).

### Phase B — host-side input automation

- synchronous input transformer pipeline;
- key-down/up/repeat model;
- reusable script modules from the trusted config directory;
- tap-hold primitive or equivalent validated rule graph;
- Caps tap -> Esc / chord -> Ctrl acceptance scenario for Vim and Helix;
- atomic cleanup on script deactivation, tab switch, reload, close, and focus loss.

### Phase C — full settings surface, configuration and launch profiles

- `require 'sterm'`;
- `config_builder()`;
- startup config fields;
- launch menu;
- configuration precedence with existing GUI settings;
- script access to the complete GUI-configurable settings schema;
- scoped per-tab runtime override layers with source diagnostics.

### Phase D — configurable keymap

- `config.keys`;
- predefined `sterm.action.*` values;
- spawn/launch action;
- conflict/validation diagnostics.

### Deferred / only with demonstrated demand

- arbitrary Lua/native module loading;
- automatic config-file watching;
- general timers;
- async/coroutine host API;
- custom GUI/DOM/render callbacks;
- arbitrary filesystem/process/network APIs;
- full window/pane object model;
- cross-tab scripting/control;
- WezTerm compatibility;
- persistent Lua state across application restarts.

## 28. Non-goals

This feature is not intended to:

- replace PowerShell or shell scripting;
- expose a generic automation interface to Windows;
- duplicate MCP;
- run untrusted scripts downloaded from terminal output;
- provide a plugin marketplace;
- provide general-purpose renderer scripting;
- emulate the complete WezTerm Lua API.

## 28. Relationship to MCP

Lua and MCP solve different problems.

MCP:

```text
external agent → owned visible terminal sessions
```

Lua:

```text
local trusted user script → application/terminal events → bounded host actions
```

Lua must not bypass MCP ownership or expose MCP-controlled sessions in a way that defeats existing isolation rules.

## 29. Definition of V1 success

The feature is successful when:

1. Scanline Term can load trusted Lua automation without requiring an external Lua installation.
2. Scripts are instantiated and state-isolated per terminal tab.
3. A script can activate/deactivate from application marker, local process evidence, or title fallback without gaining cross-tab access.
4. A script can subscribe to terminal-state events through a tab-scoped capability context.
5. The Vim/Neovim input-language scenario works reliably on Windows.
6. Caps tap -> Esc / Caps chord -> Ctrl works in a matching Vim/Helix tab without installing a system-wide keyboard hook.
7. Background/inactive tabs cannot transform foreground keyboard input or change the active input language.
8. Deactivation, tab switch, focus loss, reload, close, or script failure cannot leave synthetic modifiers/input state stuck.
9. A broken or looping script cannot freeze terminal I/O or the UI.
10. No unrestricted filesystem/process/network/native API is exposed.
11. Existing GUI configuration remains the primary configuration path and continues to work when Lua is absent.
12. Optional declarative Lua configuration can be layered later without requiring GUI users to adopt text configuration.
13. The implementation makes no claim of WezTerm Lua compatibility.
