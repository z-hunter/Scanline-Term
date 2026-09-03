# 2 · Architecture

[← Overview](./01-overview.md) · [Index](./README.md) · [Codebase Guide →](./03-codebase-guide.md)

---

## Layer Diagram

```mermaid
graph TB
  subgraph "Windows OS"
    ConPTY["ConPTY DLLs<br/>(bundled x64)"]
    Shell["cmd.exe / PowerShell<br/>(child process)"]
    GDI["Win32 GDI<br/>(font enumeration)"]
  end

  subgraph "Rust / Tauri Process"
    Main["main.rs<br/>Tauri commands"]
    TermState["TerminalState<br/>(Mutex&lt;HashMap&lt;SessionId, TerminalSession&gt;&gt;)"]
    Reader["Output reader thread<br/>(4 KiB buffer loop)"]
    Writer["Input writer thread<br/>(mpsc channel receiver)"]
  end

  subgraph "WebView / Frontend (React + WebGL)"
    AppTsx["App.tsx<br/>React composition root"]
    TabsUi["ui/TerminalTabs.tsx<br/>tab strip"]
    UseTerminal["terminal/useTerminal.ts<br/>terminal lifecycle & input hook"]
    UseCRT["crt/useCRT.ts<br/>CRT animation & render hook"]
    TerminalSession["terminal/TerminalSession.ts<br/>PTY session coordinator"]
    TerminalRenderer["terminal/TerminalRenderer.ts<br/>Canvas 2D character grid"]
    Xterm["@xterm/xterm<br/>headless VT parser"]
    TermInput["terminal/terminal-input.ts<br/>VT key encoding"]
    Win32Input["win32-input.ts<br/>Win32 Input Mode encoding"]
    TermMouse["terminal/terminal-mouse.ts<br/>mouse event encoding"]
    ColorProfiles["terminal-color-profiles.ts<br/>palette definitions"]
    CRTFilter["CRTFilter.ts<br/>WebGL shader pipeline"]
    Settings["settings.ts<br/>localStorage persistence"]
    SourceCanvas["Source canvas<br/>(virtual resolution)"]
    OutputCanvas["Output canvas<br/>(physical pixels)"]
  end

  Shell <--> ConPTY
  ConPTY <--> Main
  GDI --> Main
  Main --> TermState
  TermState --> Writer
  Writer --> ConPTY
  ConPTY --> Reader
  Reader -->|"emit('terminal-output')"| TerminalSession
  Main -->|"emit('terminal-exit')"| TerminalSession

  TerminalSession -->|"invoke('start_terminal')"| Main
  TerminalSession -->|"invoke('write_terminal')"| Main
  TerminalSession -->|"invoke('resize_terminal')"| Main
  UseTerminal -->|"invoke('list_monospace_fonts')"| Main

  AppTsx --> UseTerminal
  AppTsx --> TabsUi
  AppTsx --> UseCRT
  AppTsx --> Settings

  UseTerminal --> TerminalSession
  UseTerminal --> TerminalRenderer
  UseTerminal --> TermInput
  UseTerminal --> Win32Input
  UseTerminal --> TermMouse
  UseTerminal --> ColorProfiles

  TerminalSession --> Xterm
  TerminalRenderer --> Xterm
  TerminalRenderer --> SourceCanvas

  UseCRT --> TerminalRenderer
  UseCRT --> CRTFilter
  SourceCanvas --> CRTFilter
  CRTFilter --> OutputCanvas
```

## Execution Boundary

| Executes in **WebView** (JavaScript/TypeScript) | Executes in **Rust** (native process) |
|----|-----|
| React UI, settings panel, all event handlers | Tauri command handlers |
| xterm VT parsing and buffer management | ConPTY session lifecycle (spawn, I/O, kill) |
| Keyboard → VT/Win32 encoding | PTY input writer (mpsc channel → ConPTY pipe) |
| Mouse → SGR/X10 encoding | PTY output reader (pipe → Tauri event emission) |
| Canvas 2D terminal drawing | PTY resize (`controller.resize()`) |
| WebGL CRT shader rendering | Win32 GDI monospace font enumeration |
| `localStorage` settings persistence | Bundled ConPTY DLL resolution |
| Copy/paste via `navigator.clipboard` | — |

## Data Flows

### Console Output → Screen

```mermaid
sequenceDiagram
    participant Shell as cmd.exe
    participant ConPTY as ConPTY (Rust)
    participant Reader as Reader Thread
    participant Tauri as Tauri Event Bus
    participant Xterm as @xterm/xterm
    participant Canvas as Canvas 2D
    participant CRT as CRTFilter (WebGL)
    participant Screen as Output Canvas

    Shell->>ConPTY: stdout bytes
    ConPTY->>Reader: pipe read (4 KiB buffer)
    Reader->>Tauri: emit("terminal-output", { sessionId, data })
    Tauri->>Xterm: matching session terminal.write(Uint8Array)
    Note over Xterm: VT parse → update buffer cells
    Xterm-->>Canvas: onWriteParsed → compare cached row signatures
    Note over Canvas: requestAnimationFrame loop
    Canvas->>Canvas: drawTerminal() — redraw changed rows only<br/>read cell colors from profile<br/>draw text on source canvas
    Canvas->>CRT: filter.render(source, settings, sourceDirty)
    Note over CRT: Pass 1: Persistence accumulation (FBO ping-pong)<br/>Pass 2: Bloom + Glow blur (separable Gaussian)<br/>Pass 3: Final CRT fragment shader
    CRT->>Screen: WebGL draw to output canvas
```

### Keyboard Input → Console

```mermaid
sequenceDiagram
    participant User as User
    participant DOM as window keydown/keyup
    participant App as App.tsx handler
    participant Encoder as terminal-input.ts<br/>or win32-input.ts
    participant Invoke as invoke("write_terminal")
    participant Writer as Writer Thread (Rust)
    participant ConPTY as ConPTY
    participant Shell as cmd.exe

    User->>DOM: keydown event
    DOM->>App: onKeyDown handler (capture phase)
    App->>App: Check Menu-key shortcuts<br/>Check Alt+Enter fullscreen
    App->>Encoder: win32InputModeRef ? win32InputKey() : terminalKey()
    Encoder-->>App: VT/Win32 escape sequence string
    App->>Invoke: invoke("write_terminal", { input })
    Invoke->>Writer: mpsc channel send(bytes)
    Writer->>ConPTY: pipe write + flush
    ConPTY->>Shell: stdin delivery
```

### Mouse Input → Console

```mermaid
sequenceDiagram
    participant User as User
    participant Canvas as Output Canvas
    participant App as App.tsx mouse handlers
    participant Mouse as terminal-mouse.ts
    participant Invoke as invoke("write_terminal")

    User->>Canvas: mousedown / mousemove / mouseup / wheel
    Canvas->>App: React mouse event handler
    App->>App: terminalMouseCell() — map pixel to cell coords
    alt Copy Mode (Menu+C) or Middle Button
        App->>App: Update copySelectionRef
        App->>App: copySelection() → navigator.clipboard.writeText()
    else Application Mouse Tracking Active
        App->>Mouse: terminalMouse({ col, row, action, button, sgr, ... })
        Mouse-->>App: SGR or X10 escape sequence
        App->>Invoke: invoke("write_terminal", { input })
    else Normal Mode (scrollback)
        App->>App: terminal.scrollLines(±3)
    end
```

### Window Resize → Console Resize

```mermaid
sequenceDiagram
    participant Browser as Window / CSS Layout
    participant Observer as ResizeObserver
    participant App as App.tsx resize handler
    participant Font as fontCellSize()
    participant Xterm as terminal.resize()
    participant Invoke as invoke("resize_terminal")
    participant Rust as main.rs
    participant ConPTY as controller.resize()

    Browser->>Observer: Element size changed
    Observer->>App: resize callback
    App->>App: Update output canvas width/height<br/>(physical pixels × devicePixelRatio)
    App->>App: Update source canvas (if physical mode)
    App->>Font: fontCellSize(fontSize, fontFamily)
    Note over Font: measureText("M") → cellWidth, cellHeight
    App->>App: terminalDimensions() → cols, rows<br/>clamp [20..300] × [8..150]
    App->>Xterm: terminal.resize(cols, rows)
    App->>Invoke: invoke("resize_terminal", { cols, rows })
    Invoke->>Rust: resize_terminal command
    Rust->>Rust: pty_size() validation
    Rust->>ConPTY: controller.resize(Size)
```

## Concurrency Model

### Rust Side

```
┌─────────────────────────────────────┐
│           Main Tauri Thread         │
│  • Handles invoke commands          │
│  • Manages TerminalState (Mutex)    │
│  • start_terminal / write_terminal  │
│    / resize_terminal / close_terminal│
│    list_monospace_fonts             │
└──────────┬──────────┬───────────────┘
           │          │
    ┌──────▼──────┐ ┌─▼─────────────┐
    │Writer Thread│ │ Reader Thread  │
    │ mpsc recv   │ │ pipe read loop │
    │ → pipe write│ │ → emit event   │
    └─────────────┘ └────────────────┘
```

- **`TerminalState`** is a `Mutex<HashMap<SessionId, TerminalSession>>`, accessed by Tauri command handlers on the main thread. Each command carries the frontend-generated UUID for its target session.
- **Writer thread**: receives `Vec<u8>` from an `mpsc::Sender`, writes to the ConPTY input pipe. Blocks on `recv()`, terminates when the sender is dropped or the pipe errors.
- **Reader thread**: each session reads its ConPTY output pipe in a `[0; 4096]` buffer loop. Events carry `sessionId`, so the frontend routes them to the matching xterm buffer. On EOF or error, the reader removes only its own entry and emits `terminal-exit`.
- **`Drop` for `TerminalState`**: kills the child process to prevent orphaned console hosts.

### Frontend Side

- All rendering runs on the **main JavaScript thread** inside a `requestAnimationFrame` loop.
- xterm output is compared against cached row signatures. Only changed rows, plus the old/new cursor row, redraw; scroll, resize, settings, and selection redraw the whole source canvas.
- `ResizeObserver` triggers canvas and ConPTY resizes synchronously on the main thread.
- Keyboard/mouse handlers are registered on `window` in the **capture phase** to intercept events before any other handler.

---

*[Next: Codebase Guide →](./03-codebase-guide.md)*
