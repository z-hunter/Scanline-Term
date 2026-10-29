# Scanline Term — Lua Configuration & Automation Layer

Status: Windows V1 is an intermediate development stage, not a public release. Its bounded automation slice, first-launch profile seeding, and the managed-settings pilot are implemented. The pilot covers saved default preset, smooth scrollback, and a guarded runtime saved-preset action; its frontend/Rust suites pass. It does not complete the full GUI-backed migration. The user reports manually enabled Neovim and Helix bindings work in installed 0.6.0. Earlier development and packaged 0.6.0 Neovim Caps tap/hold smokes passed, as did packaged MCP create/echo/observe/close and cleanup checks. The focused packaged smoke did not establish the full focus/tab/reload/error matrix. See the [Lua automation guide](lua-automation.md) for the current API and limits.
Target: Deliver the Windows V1 automation slice and managed-settings pilot, then complete the broader canonical Lua settings/configuration contract before public release.
Scope: lightweight, sandboxed Lua 5.4 event automation and tab-local scripting; the pilot canonicalizes two settings while the broader all-GUI-settings migration remains required before public release.

## 1. Purpose

### Accepted and implemented Windows V1 contract

Windows V1 provides bounded Lua event automation plus an explicitly declared Smart Caps policy for a matching active, focused terminal tab. The entry file uses `require 'sterm'`, `sterm.module(name, path)` to declare trusted local modules, and `sterm.use(path, options)` to attach scripts. Lua can load only the built-in `sterm` API and modules captured in that declaration manifest; it receives no runtime filesystem access. The managed-settings pilot persists `default_preset`, `smooth_scrollback`, and `restore_window` in the bounded Lua config and adds guarded saved-preset selection plus temporary focused-tab window/panel actions; other GUI settings keep their existing JSON/local persistence pending broader migration. Window geometry is stored separately by the app, restored by default, and never overwritten by Lua actions.

The example entry → editor wrapper → shared modal-editor module pattern supports Neovim and Helix through shared cursor/layout logic. Neovim uses its visible Normal-mode block cursor; Helix additionally treats its hidden physical cursor as Normal mode. Layout changes are guarded by active-tab and window focus checks. Load and runtime failures are surfaced as error toasts, and Edit config opens the current entry file in the operating system's default editor.

The optional editor examples remain inactive by default. The entry registers the shared module but keeps both editor `sterm.use` bindings commented out; users explicitly uncomment the bindings they want. Release packaging includes the examples as inert resources; activation remains a manual edit, with no UI activation/Create action.

Smart Caps is an opt-in Windows policy implemented with one native `WH_KEYBOARD_LL` hook per app instance, shared across its tabs. A policy lease is accepted only for the active, focused, process-matched tab and owning frontend. The hook callback stays minimal: it classifies physical edges and does not call Lua, use IPC, or log each key. A physical Caps tap shorter than 180 ms maps to Escape; a hold of 180 ms or longer maps to Control. Context changes cancel a pending tap and release any owed synthetic key-up/modifier state before ordinary input resumes. Lua declares the policy during script initialization; all key-edge handling remains native.

The user reports manually enabling the Neovim and Helix bindings in installed 0.6.0 and testing that they work. Earlier development and packaged 0.6.0 smokes verified Neovim Caps tap and Caps+H. The packaged 0.6.0 smoke also validated MCP create/echo/observe/close and cleanup; it did not establish the full focus/tab/reload/error matrix.

The rest of this document describes proposed capabilities and acceptance criteria for future phases. They must not be read as claims about Windows V1.

Add an optional Lua layer to Scanline Term that can:

1. observe a small, explicit set of terminal/application events;
2. activate scripts conditionally for the application currently represented by a terminal tab;
3. keep script state isolated per tab;
4. invoke a bounded set of safe Scanline Term host actions;
5. intercept and transform terminal-session key input before it is sent to ConPTY;
6. expose every GUI-configurable setting through the same validated settings model, including runtime tab-local overrides;
7. optionally define startup/application configuration, launch profiles, and key bindings.

The feature is intended to enable small workflow automations without turning Scanline Term into a general-purpose scripting host. Scanline Term remains GUI-first: common settings such as fonts, display/CRT options, presets, tabs, browser behavior, and ordinary shortcuts remain configurable through the UI. Lua exists for behavior that is conditional, stateful, or inconvenient to express in GUI controls. The managed-settings pilot makes only the saved default preset and smooth scrollback canonical in Lua. Font choice and size remain properties of a saved preset: Lua may select a named saved preset, but must never expose standalone font fields or arbitrary font overrides. The broader post-V1 settings contract is still future work for other GUI settings.

Unlike WezTerm, Scanline Term keeps the GUI as the primary user interface. The current pilot stores only the saved default preset and smooth scrollback in Lua; other GUI settings retain their existing storage. For public release, Lua should become the canonical configuration document behind the GUI for the broader settings model: the GUI must read and write the same settings through shared validation and side-effect paths, while users may also edit the file directly. Lua is therefore not an optional parallel escape hatch in the release architecture.

The canonical acceptance scenario is automatic Windows input-language management for Vim, Neovim, or Helix based on terminal state:

- detect that the active, focused terminal tab is running a configured editor such as Vim, Neovim, or Helix;
- observe application-requested cursor type changes (for example via DECSCUSR), which a user script may use as an editor-mode heuristic;
- remember the user's last input language while in Insert mode;
- force English when entering Normal mode;
- restore the remembered Insert-mode language when returning to Insert mode;
- never allow a background tab to change the user's global input language.

The mapping from cursor shape to editor mode is per-editor and user-configured. Scanline Term does not promise that any editor emits a complete shape transition for every mode change.

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


### 2.10 Post-V1 release requirement: one settings model, two interfaces

GUI and Lua are peer interfaces to the canonical settings they share. The pilot covers the saved default preset and smooth scrollback. Font choice and size are represented only by named saved presets; Lua can select a preset but cannot set font properties directly. The eventual broader contract may cover other GUI settings through shared validation and side-effect paths, subject to explicit capability restrictions.

Both paths must use the same schema, normalization, range checks, persistence rules, and side-effect handlers. A Lua call must not bypass the behavior used by the GUI, and GUI code must not maintain hidden settings that Lua cannot represent. This is a required post-V1 release contract, not a claim about the current Windows V1 implementation.

Runtime Lua changes should normally be tab-local and lifecycle-scoped rather than silently rewriting the user's saved GUI preferences.

## 3. Runtime architecture

The accepted Windows V1 implementation uses a Rust-hosted Lua runtime on a dedicated bounded worker, with native Windows input policy handled separately. The frontend/WASM and split-runtime approaches below are historical alternatives, not current or planned Rust-runtime alternatives:

- a Lua/WASM runtime near the frontend input path;
- a split runtime where general callbacks execute in Rust while latency-sensitive keyboard rules are compiled/mirrored into a synchronous frontend state machine.

The current implementation uses `mlua` with Lua 5.4, a vendored runtime, execution limits, and explicit host bindings.

The implemented boundaries are:

- runtime script state is isolated per tab by default;
- callbacks are serialized within a tab context;
- callbacks have a bounded execution budget;
- host APIs are exposed through the built-in `sterm` module;
- only modules declared in the entry-file source manifest can be required; unrestricted native Lua module loading is disabled;
- Smart Caps edge classification stays in the native hook path and does not require Lua or per-key Tauri IPC.

Broader module and API expansion remains subject to the sandbox constraints later in this document.

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

The current fixed Smart Caps transformation runs in the native Windows keyboard hook. Any future generic Lua input remapping must stay synchronous with the input path and must not add a per-key worker or IPC round trip; its design remains future work.

## 4. Configuration file

Windows V1 resolves its Lua entry using the portable/AppData lookup. Startup and config reload seed a missing profile config from the bundled inert template. The portable packaging script places the config tree beside the executable. Focused seed tests and packaged 0.6.0 Neovim Caps/MCP smokes pass; the user reports manually enabled Neovim and Helix bindings work in installed 0.6.0. The focused smoke did not establish the full focus/tab/reload/error matrix. The required behavior is:

```text
1. <sterm executable directory>\sterm.lua, if present
2. %APPDATA%\com.zhunter.scanlineterm\config.lua, otherwise
3. If config seeding fails → report the error, keep terminal tabs available, retain legacy GUI values, and disable managed-settings writes until config loads
```

These are alternative locations for the same canonical entrypoint, not separate files to load. The executable-directory file takes precedence; the profile path is the installed-build fallback. First-launch seeding creates the profile config only when absent and preserves existing user files. The portable packaging script includes root `sterm.lua` plus its `editors/` and `modules/` dependencies beside the executable. If seeding fails, status reports an error; **Reload config** retries the operation. If no Lua config can be found during V1, the existing GUI settings behavior remains in effect.

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

This precedence describes the broader post-V1 release model. The current pilot uses the Lua file as the source of truth only for the saved default preset and smooth scrollback; the remaining GUI settings still use their existing storage. Full GUI file-backed reads/writes and synchronization of every GUI setting are not implemented yet. For release, Lua should replace the remaining settings records as separate authorities and use the same validation and side-effect paths.

Pilot GUI saves seed a missing profile config before writing the managed block and preserve existing files; portable configuration keeps precedence over the profile copy. The broader release migration must also ensure that any future GUI save path creates a missing profile config without replacing user data.

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

A future runtime override layer could apply a named saved preset or another approved non-font setting while Neovim is active. Font choice and size must come only from the selected preset. When a future scoped override deactivates, reloads, fails, or its tab closes, its layer would be removed and the current underlying GUI/base value would become visible again. The implementation must not restore a stale snapshot if the user changed the GUI setting while the script was active. The current pilot provides a guarded one-shot preset action, not scoped override layers.

If multiple active scripts override the same property, declaration/pipeline order is authoritative: later layers win for that property. Diagnostics should identify the current winning source.

GUI edits remain allowed while a script override is active. If the edited property is currently shadowed by a Lua override, the GUI should make that state discoverable (for example, `Overridden by vim.lua`) rather than appearing broken. When the override disappears, the latest GUI value takes effect automatically.

Imperative one-shot actions may still use last-writer semantics where an override layer is inappropriate, but visual/configuration settings should prefer scoped layers.

## 6. Built-in Lua module

Scripts should use a built-in module:

```lua
local sterm = require 'sterm'
```

In Windows V1, `require` resolves the built-in `sterm` API and local modules explicitly declared by the entry file with `sterm.module(name, path)`. The loader captures declared files into a bounded snapshot; Lua has no runtime filesystem access. Undeclared modules, arbitrary paths, and native modules remain unavailable.

Potential future extension:

```lua
local profiles = require 'profiles'
```

loaded only from the trusted configuration directory.

## 7. Declarative configuration API

One proposed future API is an optional `config_builder()` helper that constructs the configuration object illustrated here. It is not part of Windows V1, and required coverage of existing GUI settings does not depend on implementing this helper. The optional `launch_menu` example in Section 8 can be assigned to that proposed object.

```lua
local sterm = require 'sterm'
local config = sterm.config_builder()

config.default_prog = { 'pwsh.exe', '-NoLogo' }
config.default_cwd = 'D:\\Projects'
config.default_preset = 'DEC VT-220 (1983)'

return config
```

Illustrative fields for a proposed configuration object:

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

The list illustrates possible names; it is not a complete release checklist. The required post-V1 contract is that every setting already represented in the GUI maps to the same canonical settings structures, with documented Lua names/types. New startup and launch features that do not correspond to existing GUI settings, including a launch menu, remain optional as described in Section 27. This work is beyond the current intermediate V1.

## 8. Launch profiles / launch menu

Example:

```lua
config.launch_menu = {
  {
    label = 'PowerShell',
    command = 'pwsh.exe',
    args = { '-NoLogo' },
  },
  {
    label = 'FAR',
    command = 'far.exe',
    preset = 'IBM 3278 (1977)',
  },
  {
    label = 'TurboIDE',
    command = 'D:\\Tools\\TurboIDE\\turboide.exe',
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

Cursor state keeps the existing `.shape` event field and exposes the application's requested type, independently of the effective preset appearance:

```text
shape: block | underline | bar | unknown | null
blink: boolean | null
```

DECSCUSR codes 1–6 normalize to block, underline, and bar. An unsupported code is `unknown`; it is not guessed from the renderer. Code 0, RIS, or another terminal reset clears the application request (`shape: null`, `blink: null`) and returns to the current preset appearance. Lua must receive change events for application requests and resets. These are terminal-state signals only: Scanline Term does not guarantee that they identify Vim/Helix mode or any other editor mode.

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

This event originates from a Windows-level input-language notification (for example, `WM_INPUTLANGCHANGE`). The host dispatches it only to the active, focused terminal tab; unfocused/background tab contexts do not receive it. The event describes a process/window-level change, not a per-tab Windows notification.

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

Initial configurable activation can use the locally running process name together with current cursor type; editor names are examples, not built-in targets. An unavailable/unknown process name or cursor type does not activate the behavior. Application markers and title/OSC matching are optional fallbacks, not prerequisites.

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

- evidence categories use precedence: `app` marker, then local `process`, then `title`; evaluate only the highest-precedence configured category for which evidence is available;
- values inside one category are OR alternatives;
- a script is active when a value in the selected category matches; a mismatch does not fall through to a lower-precedence category;
- a script without a `when` clause is always active in its owning tab;
- transition from unmatched to matched emits/executes `on_activate`;
- transition from matched to unmatched emits/executes `on_deactivate`;
- tab close destroys the script instance and all transient state.

The exact surface syntax is provisional, but activation/deactivation semantics are part of the contract.

### 11.1 Explicit application marker

Sterm should reserve a small terminal-to-host metadata mechanism analogous in spirit to terminal user variables. A Vim/Helix plugin may explicitly publish application identity/state without forcing Sterm to infer semantics from process trees or titles.

Conceptually:

```text
application/plugin -> OSC/user variable -> untrusted tab metadata -> Lua match/event
```

An OSC application marker is an untrusted hint, never authenticated identity. By default, OSC-supplied markers, including markers emitted by remote applications, must not be exposed to Lua matching or events. A user must explicitly opt in to accepting OSC markers for a tab before they can be used; local process evidence remains host-observed, and title text remains user/script-controlled fallback evidence.

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

Each runtime script has a separate VM per attachment and tab, so ordinary Lua locals and module values are isolated but reset on reload. The Windows V1 runtime also provides bounded, memory-only scalar state through `ctx.state:get(key)` and `ctx.state:set(key, value)`. Valid reload retains committed values only for the same tab and canonical attachment identity; a callback error rolls back that callback's writes/actions while preserving previously committed state. Removal calls `sterm.on_unload(ctx)` once per script instance and tab, then clears its state. This API does not persist values to disk or across application restarts.

```lua
local insert_layout = nil
```

The instance is destroyed with the tab, so local state cannot leak into another tab. See the [Lua automation guide](lua-automation.md) for attachment identity, value types, and limits.

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

## 15. Canonical Vim / Neovim / Helix automation

Application identification and mode interpretation are separate concerns. Sterm determines only tab-local evidence; the user script decides what that evidence means.

Illustrative script semantics:

```lua
local insert_layout = nil
local target_processes = { ['vim.exe'] = true, ['nvim.exe'] = true, ['hx.exe'] = true }

local function is_target_process(ctx)
  local process = ctx.tab:local_process_name()
  return process ~= nil and target_processes[process:lower()]
end

local function apply_layout(ctx)
  if not ctx.tab:is_active() or not ctx.tab:is_focused() then
    return
  end

  if not is_target_process(ctx) then
    return
  end

  local cursor = ctx.tab:cursor_style()

  if cursor.shape == 'bar' then
    -- User configuration interprets bar as Insert mode.
    if insert_layout then
      ctx.input:set_layout(insert_layout)
    end
  elseif cursor.shape == 'block' then
    -- This editor's user configuration maps block to Normal mode.
    local current = ctx.input:current_layout()
    if current ~= 'en-US' then
      insert_layout = current
    end
    ctx.input:set_layout('en-US')
  else
    -- Unknown/reset shapes do not identify a mode.
    return
  end
end

sterm.on('tab-activated', function(ctx)
  apply_layout(ctx)
end)

sterm.on('cursor-style-changed', function(ctx, event)
  apply_layout(ctx)
end)

sterm.on('input-language-changed', function(ctx, event)
  if ctx.tab:is_active() and ctx.tab:is_focused() and is_target_process(ctx)
      and ctx.tab:cursor_style().shape == 'bar' then
    insert_layout = event.language
  end
end)
```

The process-name set is user-configurable; the example checks it before interpreting cursor type and keeps the active/focused guard. Unknown process names and cursor shapes do nothing. No editor-specific marker or title/OSC signal is required.

The script intentionally treats cursor shape as a user-defined heuristic. Scanline Term exposes terminal state; it does not claim to know Vim mode semantically. A Vim/Neovim plugin may provide an explicit `STERM_APP=nvim` marker to make application identification reliable, while mode interpretation may still remain user-script logic.

## 16. Host-side input interception and remapping

### Accepted Windows V1: Smart Caps policy

An attachment may opt in during initialization with `sterm.input.smart_caps()`. The policy applies only under a native lease for the owning frontend's active, focused tab with a matching local process. Each app instance uses one Windows `WH_KEYBOARD_LL` hook shared across its tabs. The callback only classifies physical Caps edges and performs the required native input handling; it never calls Lua, performs IPC, or logs every key. Lua does not receive per-key callbacks.

The fixed policy maps a physical Caps tap shorter than 180 ms to Escape and a hold of 180 ms or longer to Control. Context changes revoke the lease, cancel a pending tap, and release any owed synthetic key-up/modifier state before ordinary input resumes. Lease acknowledgement is tied to the exact frontend, tab, process, and current context generation. These constraints are part of the accepted V1 contract. Automated tests pass. An earlier development smoke and the packaged 0.6.0 smoke verified Neovim Caps tap and Caps+H; the user reports manually enabled Neovim and Helix bindings work in installed 0.6.0. The focused smoke did not establish the full focus/tab/reload/error matrix.

### Future work: general input transforms

V1 does not expose arbitrary per-key Lua remapping, reusable key-policy modules, configurable tap-hold rules, or a user-defined timeout. Any later expansion must preserve the constraints below: physical edges are consumed before ordinary terminal encoding, only the matching active/focused context may transform input, and deactivation cancels pending state and releases synthetic modifiers. Remote application identity remains heuristic unless explicitly supplied by the user.

### Future design: input event model

The host input layer must distinguish at least:

- physical key down;
- physical key up;
- repeat;
- modifier state;
- text/composition input where applicable;
- whether an input event has been consumed by Sterm/Lua policy.

The remapper runs before the normal xterm/terminal key encoding path. A consumed physical event must not also reach ConPTY in its original form.

### Future design: configurable tap-hold semantics

Tap-hold behavior cannot be implemented as a simple `key-pressed` callback. The host must maintain a tiny state machine for the candidate key.

For Caps→Esc/Ctrl:

```text
Caps down
  + released alone before timeout_ms             -> send Esc
  + timeout_ms expires while still held          -> enter Ctrl-hold state
  + another key pressed while held               -> synthesize Ctrl+that key
  + release after timeout with no chord          -> consume release; send neither Esc nor Caps
  + release after chord                          -> end Ctrl state
```

Releasing Caps after the timeout without pressing another key is consumed, so a long hold with no chord produces no tap action or Caps keystroke.

The implementation should avoid perceptible latency for ordinary keys. Only the ambiguous tap-hold key may require short deferred resolution.

### Future design: context activation

Input remaps exist inside the owning tab's automation context and are effective only when:

1. the script's application match is active;
2. the owning tab is the active tab;
3. the Scanline Term window has focus.

Matching may use:

- explicit application marker (`STERM_APP=nvim`, etc.) when available;
- local child/process name when meaningful;
- tab title / OSC title as a user-defined fallback heuristic;
- terminal kind where useful.

Remote applications over SSH cannot be identified reliably from the local process tree; users may opt into explicit markers/title heuristics when they need remote matching. Sterm must not claim semantic knowledge of the remote application.

Deactivation is atomic from the input system's perspective: pending tap-hold candidates are cancelled and any synthetic modifier state is released before ordinary input resumes.

### Future-design guardrails

- Keep physical key decisions out of asynchronous Tauri IPC and out of Lua callbacks.
- Preserve the native hook's minimal callback and exact context-lease checks.
- On focus loss, tab deactivation, reload, or terminal close, cancel pending tap state and release owed synthetic input.
- Background tabs must never consume or transform foreground input.
- Add tests for any new transform policy, including rapid taps/holds, auto-repeat, context changes, and ordinary Caps behavior outside the lease.

Future manual acceptance examples:

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

## 18. Post-V1 settings API and optional runtime overrides

Before public release, Lua must be able to read and update every GUI-configurable setting through the same canonical model, validation, and side-effect path used by the GUI. This persisted settings contract is required and is not part of the current intermediate V1. Exact API naming remains provisional.

Scoped per-tab runtime overrides are an optional extension. If implemented, they should use bounded layers rather than silently mutating saved preferences; removing an override should reveal the latest underlying GUI value.

Example:

```lua
on_activate(function(ctx)
  ctx.settings:override {
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
local effective = ctx.settings:get('preset')
local base = ctx.settings:get_base('preset')
local source = ctx.settings:source('preset')
```

The implementation may expose a structured settings table instead of string-key access, but it must preserve the same validation and source tracking.

Examples of settings that should eventually be scriptable because they are already GUI-configurable include:

- saved preset selection (including that preset's saved font and display settings);
- cursor shape/blink where host-controlled;
- preset/profile selection;
- CRT enablement and all exposed CRT/display parameters;
- resolution/display form factor;
- smooth scrollback and TUI scrolling;
- tab-bar visibility/placement where applicable;
- browser form factor;
- other current/future GUI settings unless explicitly excluded for safety or lifecycle reasons.

Persistence is separate from runtime override. A script must not silently save permanent GUI preferences merely because it changes an effective setting. Any explicit persistence API should be visibly named and capability-restricted. GUI save actions write the canonical Lua configuration; when no profile file exists, saving must create it automatically without replacing user data.

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
- title changes may keep only the latest pending value while the match result stays on the same side of the activation boundary; if a sequence crosses that boundary (matched → unmatched → matched, or the reverse), preserve each transition in order;
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
- provide a Settings action named `Reload config` and an `Edit config` action that opens the current entry file in the operating system's default editor;
- on reload, rebuild fresh callbacks, locals, and VMs; preserve only committed scalar state for retained tab/attachment identities.
- before committing, run `on_unload` for removed attachments and apply only guarded saved-preset cleanup; abort fail-closed if prepare, cleanup, or commit fails.

Automatic file watching is not required for V1.

Open tabs should not be recreated on reload. New configuration applies to future launches and to runtime-safe settings/actions only.

## 25. Diagnostics

Lua errors should be visible without breaking normal terminal use.

The Settings panel reports the Lua automation state. Load/runtime errors appear as error toasts, and diagnostic messages are written to the WebView console with a `[Lua]` prefix, using info or error level as appropriate.

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

The lists in this section are proposed acceptance coverage for the broader scope. They are not evidence of release-build validation. The live development smoke is summarized in the accepted Windows V1 section above.

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
- Caps tap-hold release after `timeout_ms` with no chord is consumed without sending Esc or Caps;
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
- application activation can select a saved tab-local preset; any future font choice continues to come only from that saved preset.

### Future/release manual acceptance: Vim/Neovim layout scenario

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

### Future/release manual acceptance: Caps tap-hold timeout

1. Configure Caps→Esc/Ctrl with a known `timeout_ms`.
2. Release Caps alone before the timeout and verify the terminal receives Esc.
3. Hold Caps beyond the timeout, press no other key, then release it; verify the terminal receives neither Esc nor Caps.
4. Hold Caps beyond the timeout, press another key, and verify the terminal receives that key with Ctrl held.

## 27. Phased scope

Windows V1 is an intermediate development stage, not a public release. First-launch profile seeding and portable config packaging belong to current V1 work as described in Section 4. The following settings/configuration work is required after V1 and before public release; it is not optional backlog.

### Required post-V1 release scope — canonical Lua settings and configuration

- make Lua the canonical persisted settings/configuration document while keeping the GUI as the primary user interface;
- route GUI settings reads and writes through the same canonical model, normalization, validation, and side-effect paths as Lua;
- cover every GUI setting in the canonical Lua schema;
- automatically create the profile configuration file when a GUI save occurs and the file is absent, preserving existing user files;
- validate save-time creation, upgrade behavior, portable precedence, and preservation of user files before release.

### Optional backlog after the required release scope

The following capabilities remain future choices beyond the required settings/configuration release work.

#### Remaining event automation and settings extensions

- broader event and application-identification capabilities beyond the implemented local-process, cursor, focus, and layout slice;
- broader diagnostics and execution-limit reporting;
- extended Windows input-language acceptance coverage beyond the current smoke;

#### General host-side input automation

- user-defined synchronous input transformers and key-down/up/repeat model;
- configurable remapping rules beyond the fixed Smart Caps policy;
- tests for custom policy cleanup, repeat handling, and ordinary input outside an active lease.

#### Launch profiles and startup options

- `config_builder()`;
- startup-only fields that add behavior beyond settings already configurable in the GUI, including a launch menu;
- precedence rules for optional launch/profile-specific overrides beyond the required canonical GUI settings;
- script-selectable launch fields and profile-specific overrides beyond the canonical persisted settings contract;
- optional scoped per-tab runtime override layers with source diagnostics.

#### Configurable keymap

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

## 29. Definition of future full-scope success

The accepted Windows V1 slice is described at the start of this document and in the [Lua automation guide](lua-automation.md). The criteria below describe full-scope product behavior; required post-V1 release scope is listed in Section 27. None of these statements implies that the work is implemented today.

The feature is successful when:

1. Scanline Term can load trusted Lua automation without requiring an external Lua installation.
2. Scripts are instantiated and state-isolated per terminal tab.
3. A script can activate/deactivate from application marker, local process evidence, or title fallback without gaining cross-tab access.
4. A script can subscribe to terminal-state events through a tab-scoped capability context.
5. The Vim/Neovim input-language scenario works reliably on Windows.
6. A future general input-policy API, if prioritized, preserves the accepted Smart Caps behavior and scope without exposing per-key callbacks to Lua.
7. Background/inactive tabs cannot transform foreground keyboard input or change the active input language.
8. Deactivation, tab switch, focus loss, reload, close, or script failure cannot leave synthetic modifiers/input state stuck.
9. A broken or looping script cannot freeze terminal I/O or the UI.
10. No unrestricted filesystem/process/network/native API is exposed.
11. The GUI remains the primary user interface, while its reads and writes use the canonical Lua settings document and shared validation/state path.
12. Saving GUI settings creates the profile Lua configuration if absent; first launch seeds the bundled inert template only when absent, and the portable ZIP provides the entry and dependencies beside the executable.
13. The implementation makes no claim of WezTerm Lua compatibility.
