import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { colorProfile, type CursorStyle, type TerminalColorProfile } from "scanline-virtual-screen/core";
import { terminalKey } from "./terminal-input";
import { terminalMouse, type MouseTrackingMode } from "./terminal-mouse";
import { win32InputKey } from "../win32-input";

export type TerminalSize = { cols: number; rows: number };
export type TerminalLaunch = { command?: string | null; args?: string[] | null; cwd?: string | null; preset?: string | null };
export type TerminalInputAction =
  | { kind: "text"; text: string; submit?: boolean }
  | {
      kind: "key";
      key: string;
      ctrl?: boolean;
      alt?: boolean;
      shift?: boolean;
      repeat?: number;
    };
export type TerminalMouseAction =
  | { action: "click" | "press" | "release"; button: "primary" | "secondary"; col: number; row: number; ctrl?: boolean; alt?: boolean; shift?: boolean }
  | { action: "move"; col: number; row: number; heldButton?: "primary" | "secondary"; ctrl?: boolean; alt?: boolean; shift?: boolean }
  | { action: "wheel"; direction: "up" | "down"; col: number; row: number; steps?: number; ctrl?: boolean; alt?: boolean; shift?: boolean };
export type TerminalColor =
  | { mode: "default" }
  | { mode: "palette"; index: number }
  | { mode: "rgb"; value: string };
export type TerminalStyleRun = {
  row: number;
  startColumn: number;
  endColumn: number;
  foreground?: TerminalColor;
  background?: TerminalColor;
  bold?: true;
  italic?: true;
  dim?: true;
  underline?: true;
  blink?: true;
  inverse?: true;
  invisible?: true;
  strikethrough?: true;
  overline?: true;
};
export type TerminalSnapshot = {
  status: "running" | "exited";
  title: string | null;
  processName: string | null;
  size: TerminalSize;
  buffer: "normal" | "alternate";
  sequence: number;
  cursor: { x: number; y: number };
  viewportY: number;
  screen: { firstLine: number; lines: string[]; styles: TerminalStyleRun[] };
  scrollback?: { firstLine: 0; lines: string[] };
};
export type TerminalObservation = {
  snapshot: TerminalSnapshot;
  timedOut: boolean;
};
type TerminalOutput = { sessionId: string; data: number[] };
type TerminalExit = { sessionId: string };
type PendingOutput = { data: Uint8Array; acknowledge: () => void };
export type TerminalOutputScroll = { fromViewportY: number; toViewportY: number; autoScroll: boolean };

const OUTPUT_CHUNK_BYTES = 16 * 1024;

const sessions = new Map<string, TerminalSession>();
export const terminalSession = (id: string) => sessions.get(id);

const automationKeyAliases: Record<string, string> = {
  ESC: "Escape", ESCAPE: "Escape", TAB: "Tab", ENTER: "Enter", RETURN: "Enter",
  BACKSPACE: "Backspace", BS: "Backspace", SPACE: "Space", INSERT: "Insert", INS: "Insert",
  DELETE: "Delete", DEL: "Delete", HOME: "Home", END: "End", PAGEUP: "PageUp", PGUP: "PageUp",
  PAGEDOWN: "PageDown", PGDN: "PageDown", UP: "ArrowUp", ARROWUP: "ArrowUp", ARROW_UP: "ArrowUp",
  DOWN: "ArrowDown", ARROWDOWN: "ArrowDown", ARROW_DOWN: "ArrowDown", LEFT: "ArrowLeft", ARROWLEFT: "ArrowLeft", ARROW_LEFT: "ArrowLeft",
  RIGHT: "ArrowRight", ARROWRIGHT: "ArrowRight", ARROW_RIGHT: "ArrowRight", PAUSE: "Pause",
};
const automationNamedKeys = new Set([
  "Escape", "Tab", "Enter", "Backspace", "Space", "Insert", "Delete", "Home", "End",
  "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Pause",
]);

function automationKeyEvent(action: Extract<TerminalInputAction, { kind: "key" }>): KeyboardEvent {
  const name = action.key.length === 1
    ? action.key
    : automationKeyAliases[action.key.toUpperCase()] ?? action.key;
  if (
    name.length !== 1 &&
    !automationNamedKeys.has(name) &&
    !/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(name)
  )
    throw new Error(`unsupported terminal key: ${action.key}`);
  return {
    key: name === "Space" ? " " : name,
    code: name === "Space" ? "Space" : name.length === 1 ? `Key${name.toUpperCase()}` : name,
    ctrlKey: !!action.ctrl,
    altKey: !!action.alt,
    shiftKey: !!action.shift,
    metaKey: false,
  } as KeyboardEvent;
}

function tabTitle(title: string): string {
  const executable = title.match(
    /^[A-Za-z]:\\.*\\([^\\]+?\.(?:exe|com|bat|cmd))(?:\s.*)?$/i,
  );
  return executable?.[1] ?? title;
}

function automationMouseButton(button: "primary" | "secondary"): 0 | 2 {
  return button === "primary" ? 0 : 2;
}

function mouseTrackingMode(terminal: Terminal): MouseTrackingMode {
  return (terminal.modes.mouseTrackingMode as MouseTrackingMode | undefined) ?? "none";
}

function cellColor(cell: {
  isFgDefault(): boolean; isFgRGB(): boolean; getFgColor(): number;
  isBgDefault(): boolean; isBgRGB(): boolean; getBgColor(): number;
}, foreground: boolean): TerminalColor | undefined {
  const isDefault = foreground ? cell.isFgDefault() : cell.isBgDefault();
  if (isDefault) return undefined;
  const rgb = foreground ? cell.isFgRGB() : cell.isBgRGB();
  const value = foreground ? cell.getFgColor() : cell.getBgColor();
  return rgb ? { mode: "rgb", value: `#${value.toString(16).padStart(6, "0")}` } : { mode: "palette", index: value };
}

function cellStyle(cell: {
  isFgDefault(): boolean; isFgRGB(): boolean; getFgColor(): number;
  isBgDefault(): boolean; isBgRGB(): boolean; getBgColor(): number;
  isBold(): number; isItalic(): number; isDim(): number; isUnderline(): number; isBlink(): number;
  isInverse(): number; isInvisible(): number; isStrikethrough(): number; isOverline(): number;
}): Omit<TerminalStyleRun, "row" | "startColumn" | "endColumn"> {
  const style: Omit<TerminalStyleRun, "row" | "startColumn" | "endColumn"> = {};
  const foreground = cellColor(cell, true);
  const background = cell.isBgDefault() ? undefined : (cell.isBgRGB() ? { mode: "rgb" as const, value: `#${cell.getBgColor().toString(16).padStart(6, "0")}` } : { mode: "palette" as const, index: cell.getBgColor() });
  if (foreground) style.foreground = foreground;
  if (background) style.background = background;
  if (cell.isBold()) style.bold = true;
  if (cell.isItalic()) style.italic = true;
  if (cell.isDim()) style.dim = true;
  if (cell.isUnderline()) style.underline = true;
  if (cell.isBlink()) style.blink = true;
  if (cell.isInverse()) style.inverse = true;
  if (cell.isInvisible()) style.invisible = true;
  if (cell.isStrikethrough()) style.strikethrough = true;
  if (cell.isOverline()) style.overline = true;
  return style;
}

function styleKey(style: Omit<TerminalStyleRun, "row" | "startColumn" | "endColumn">): string {
  return JSON.stringify(style);
}

export function scrollToBottomOnKey(key: string): boolean {
  return !['Alt', 'AltGraph', 'CapsLock', 'Control', 'Fn', 'FnLock', 'Hyper', 'Meta', 'NumLock', 'OS', 'ScrollLock', 'Shift', 'Super', 'Symbol', 'SymbolLock'].includes(key);
}

export class TerminalSession {
  terminal: Terminal | null = null;
  live = false;
  size: TerminalSize = { cols: 0, rows: 0 };
  win32InputMode = false;
  sgrMouseMode = false;
  title: string | null = null;
  private shellName: string | null = null;
  private processName: string | null = null;
  private processInterval: number | null = null;
  private unlisten: UnlistenFn[] = [];
  private disposables: { dispose(): void }[] = [];
  private disposed = false;
  private exited = false;
  private sequence = 0;
  private pendingOutput: PendingOutput[] = [];
  private outputTimer: number | null = null;
  private outputWritePending = false;
  private outputCompletion: Promise<void> | null = null;
  private resolveOutputCompletion: (() => void) | null = null;
  private cursorStyle: CursorStyle = 'block';
  private cursorBlink = true;
  private applicationCursorStyle = false;

  constructor(
    readonly id: string,
    private readonly onError: (message: string) => void,
    private readonly onState: (live: boolean, size: TerminalSize) => void,
    private readonly onExit: () => void,
    private readonly onOutput: (scroll?: TerminalOutputScroll) => void,
    private readonly onTitle: (title: string) => void,
    private readonly onProcessName: (name: string) => void,
  ) {
    sessions.set(id, this);
  }

  async start(
    size: TerminalSize,
    profile: TerminalColorProfile,
    launch?: TerminalLaunch,
  ): Promise<string | null> {
    if (!isTauri() || this.disposed || this.terminal) return null;
    const terminal = new Terminal({
      cols: size.cols,
      rows: size.rows,
      scrollback: 10000,
      allowProposedApi: true,
      theme: { foreground: profile.foreground, background: profile.background },
    });
    this.terminal = terminal;
    this.size = size;
    this.disposables.push(
      terminal.parser.registerCsiHandler(
        { prefix: "?", final: "h" },
        (params) => {
          if (params.includes(1006)) this.sgrMouseMode = true;
          if (params.length !== 1 || params[0] !== 9001) return false;
          this.win32InputMode = true;
          return true;
        },
      ),
      terminal.parser.registerCsiHandler(
        { prefix: "?", final: "l" },
        (params) => {
          if (params.includes(1006)) this.sgrMouseMode = false;
          if (params.length !== 1 || params[0] !== 9001) return false;
          this.win32InputMode = false;
          return true;
        },
      ),
      terminal.parser.registerCsiHandler(
        { intermediates: ' ', final: 'q' },
        (params) => {
          const param = params.length === 0 ? 1 : params[0];
          if (typeof param !== 'number') return false;
          if (param === 0) this.applicationCursorStyle = false;
          else {
            const style = ({ 1: 'block', 2: 'block', 3: 'underline', 4: 'underline', 5: 'bar', 6: 'bar' } as const)[param as 1 | 2 | 3 | 4 | 5 | 6];
            if (!style) return false;
            this.applicationCursorStyle = true;
            terminal.options.cursorStyle = style;
            terminal.options.cursorBlink = param % 2 === 1;
            return true;
          }
          terminal.options.cursorStyle = this.cursorStyle;
          terminal.options.cursorBlink = this.cursorBlink;
          return true;
        },
      ),
      terminal.parser.registerEscHandler(
        { final: 'c' },
        () => {
          this.applicationCursorStyle = false;
          terminal.options.cursorStyle = this.cursorStyle;
          terminal.options.cursorBlink = this.cursorBlink;
          return false;
        },
      ),
      terminal.onData((input) => this.sendInput(input)),
      terminal.onKey(({ domEvent }) => { if (scrollToBottomOnKey(domEvent.key)) terminal.scrollToBottom(); }),
      terminal.onTitleChange((title) => {
        this.title = tabTitle(title);
        this.onTitle(this.title);
      }),
    );
    try {
      terminal.loadAddon(new Unicode11Addon());
      terminal.unicode.activeVersion = "11";
      this.unlisten = await Promise.all([
        listen<TerminalOutput>("terminal-output", (event) => {
          if (event.payload.sessionId === this.id) this.queueOutput(event.payload.data);
        }),
        listen<TerminalExit>("terminal-exit", (event) => {
          if (event.payload.sessionId !== this.id || this.disposed) return;
          void this.handleExit();
        }),
      ]);
      const validLaunch =
        launch &&
        typeof launch === "object" &&
        !("nativeEvent" in launch) &&
        ("command" in launch || "args" in launch || "cwd" in launch)
          ? {
              command:
                typeof launch.command === "string" ? launch.command : null,
              ...(Array.isArray(launch.args) && launch.args.length > 0 && {
                args: launch.args.filter((argument): argument is string => typeof argument === "string"),
              }),
              cwd: typeof launch.cwd === "string" ? launch.cwd : null,
            }
          : undefined;
      const shellName = await invoke<string>("start_terminal", {
        sessionId: this.id,
        ...size,
        ...(validLaunch && { launch: validLaunch }),
      });
      if (this.disposed) {
        void invoke("close_terminal", { sessionId: this.id });
        return null;
      }
      if (this.exited) return shellName;
      this.shellName = shellName;
      this.pollProcess();
      this.processInterval = window.setInterval(() => this.pollProcess(), 500);
      this.live = true;
      this.size = size;
      this.onState(true, size);
      return shellName;
    } catch (reason) {
      this.onError(`Windows console could not start: ${String(reason)}`);
      const wasDisposed = this.disposed;
      this.dispose();
      this.disposed = wasDisposed;
      return null;
    }
  }

  sendInput(input: string): void {
    if (!this.live || !input) return;
    void invoke("write_terminal", { sessionId: this.id, input }).catch(
      (reason) => this.onError(`Terminal input failed: ${String(reason)}`),
    );
  }

  setCursorAppearance(style: CursorStyle, blink: boolean): void {
    this.cursorStyle = style;
    this.cursorBlink = blink;
    if (this.applicationCursorStyle || !this.terminal) return;
    this.terminal.options.cursorStyle = style;
    this.terminal.options.cursorBlink = blink;
  }

  private queueOutput(data: number[]): void {
    this.pendingOutput.push({ data: Uint8Array.from(data), acknowledge: () => this.acknowledgeOutput() });
    this.scheduleOutputFlush();
  }

  private scheduleOutputFlush(): void {
    if (this.outputWritePending || this.outputTimer !== null || this.disposed || this.exited) return;
    this.outputTimer = window.setTimeout(() => {
      this.outputTimer = null;
      this.flushOutput();
    }, 0);
  }

  private flushOutput(): void {
    const terminal = this.terminal;
    if (!terminal || this.disposed || this.outputWritePending || !this.pendingOutput.length) return;
    const chunks: Uint8Array[] = [];
    const acknowledgements: (() => void)[] = [];
    let length = 0;
    while (this.pendingOutput.length && length < OUTPUT_CHUNK_BYTES) {
      const pending = this.pendingOutput[0];
      const take = Math.min(pending.data.length, OUTPUT_CHUNK_BYTES - length);
      chunks.push(pending.data.subarray(0, take));
      length += take;
      if (take === pending.data.length) {
        this.pendingOutput.shift();
        acknowledgements.push(pending.acknowledge);
      } else pending.data = pending.data.subarray(take);
    }
    const input = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { input.set(chunk, offset); offset += chunk.length; }
    const buffer = terminal.buffer.active;
    const fromViewportY = buffer.viewportY;
    const wasAtBottom = buffer.viewportY === buffer.baseY;
    const normalBuffer = buffer === terminal.buffer.normal;
    this.outputWritePending = true;
    this.outputCompletion = new Promise((resolve) => { this.resolveOutputCompletion = resolve; });
    terminal.write(input, () => {
      this.outputWritePending = false;
      this.outputCompletion = null;
      this.resolveOutputCompletion?.();
      this.resolveOutputCompletion = null;
      const toViewportY = buffer.viewportY;
      const autoScroll = normalBuffer && wasAtBottom && toViewportY > fromViewportY;
      this.sequence++;
      this.onOutput({ fromViewportY, toViewportY: autoScroll ? toViewportY : fromViewportY, autoScroll });
      acknowledgements.forEach((acknowledge) => acknowledge());
      this.scheduleOutputFlush();
    });
  }

  private acknowledgeOutput(): void {
    if (this.disposed) return;
    void invoke("ack_terminal_output", { sessionId: this.id }).catch((reason) => this.onError(`Terminal output acknowledgment failed: ${String(reason)}`));
  }

  private async handleExit(): Promise<void> {
    if (this.exited) return;
    this.exited = true;
    if (this.outputTimer !== null) window.clearTimeout(this.outputTimer);
    this.outputTimer = null;
    while (this.pendingOutput.length || this.outputWritePending) {
      this.flushOutput();
      if (this.outputWritePending && this.outputCompletion) await this.outputCompletion;
    }
    if (this.disposed) return;
    this.live = false;
    this.onState(false, this.size);
    this.onExit();
  }

  async sendAutomationInput(action: TerminalInputAction): Promise<void> {
    if (!this.live) throw new Error("terminal is not running");
    let input: string | null;
    if (action.kind === "text") {
      if (action.text.length > 64 * 1024)
        throw new Error("terminal text input exceeds 64 KiB");
      input = action.text + (action.submit ? "\r" : "");
    } else {
      const repeat = action.repeat ?? 1;
      if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100)
        throw new Error("terminal key repeat must be an integer from 1 to 100");
      const event = automationKeyEvent(action);
      input = this.win32InputMode
        ? `${win32InputKey(event, true)}${win32InputKey(event, false)}`
        : terminalKey(event, this.terminal!.modes);
      input = input?.repeat(repeat) ?? null;
    }
    if (input) await invoke("write_terminal", { sessionId: this.id, input });
  }

  async sendAutomationMouse(action: TerminalMouseAction): Promise<void> {
    if (!this.live || !this.terminal) throw new Error("terminal is not running");
    const terminal = this.terminal;
    const tracking = mouseTrackingMode(terminal);
    if (tracking === "none") throw new Error("terminal mouse tracking is disabled");
    if (!Number.isInteger(action.col) || !Number.isInteger(action.row) || action.col < 1 || action.col > terminal.cols || action.row < 1 || action.row > terminal.rows)
      throw new Error(`terminal mouse position is outside ${terminal.cols}x${terminal.rows}`);
    const modifiers = { ctrlKey: !!action.ctrl, altKey: !!action.alt, shiftKey: !!action.shift };
    const send = async (event: Parameters<typeof terminalMouse>[0]) => {
      const input = terminalMouse(event);
      if (input) await invoke("write_terminal", { sessionId: this.id, input });
    };
    const button = "button" in action ? automationMouseButton(action.button) : undefined;
    const allowed = (event: "press" | "release" | "move" | "wheel-up" | "wheel-down") => {
      if (tracking === "x10" && event !== "press") return false;
      if (tracking === "vt200" && event === "move") return false;
      if (tracking === "drag" && event === "move" && !("heldButton" in action && action.heldButton)) return false;
      return true;
    };
    const emit = async (event: "press" | "release" | "move" | "wheel-up" | "wheel-down", eventButton = button) => {
      if (!allowed(event)) {
        if (event === "release" && tracking === "x10") return;
        throw new Error(`mouse action ${event} is not supported by ${tracking} tracking`);
      }
      await send({ action: event, button: eventButton, col: action.col, row: action.row, sgr: this.sgrMouseMode, ...modifiers });
    };
    if (action.action === "click") {
      await emit("press", button);
      await emit("release", button);
      return;
    }
    if (action.action === "press" || action.action === "release") {
      await emit(action.action, button);
      return;
    }
    if (action.action === "move") {
      await emit("move", action.heldButton ? automationMouseButton(action.heldButton) : undefined);
      return;
    }
    const wheel = action as Extract<TerminalMouseAction, { action: "wheel" }>;
    const steps = wheel.steps ?? 1;
    if (!Number.isInteger(steps) || steps < 1 || steps > 100) throw new Error("terminal mouse steps must be an integer from 1 to 100");
    for (let index = 0; index < steps; index += 1) await emit(wheel.direction === "up" ? "wheel-up" : "wheel-down", undefined);
  }

  snapshot(includeScrollback: boolean | "recent" | "full" = false): TerminalSnapshot {
    const terminal = this.terminal;
    if (!terminal) throw new Error("terminal is unavailable");
    const buffer = terminal.buffer.active;
    const screenStart = buffer.baseY;
    const screen = this.readLines(buffer, screenStart, Math.min(buffer.length, screenStart + terminal.rows), true);
    const full = includeScrollback === true || includeScrollback === "full";
    return {
      status: this.live ? "running" : "exited",
      title: this.title,
      processName: this.processName,
      size: this.size,
      buffer: buffer === terminal.buffer.normal ? "normal" : "alternate",
      sequence: this.sequence,
      cursor: { x: buffer.cursorX, y: buffer.cursorY },
      viewportY: buffer.viewportY,
      screen: { firstLine: screenStart, lines: screen.lines, styles: screen.styles },
      ...(full ? { scrollback: { firstLine: 0 as const, lines: this.readLines(buffer, 0, buffer.length, false).lines } } : {}),
    };
  }

  private readLines(buffer: NonNullable<Terminal["buffer"]>["active"], start: number, end: number, styles: boolean): { lines: string[]; styles: TerminalStyleRun[] } {
    const lines: string[] = [];
    const styleRuns: TerminalStyleRun[] = [];
    for (let lineIndex = start; lineIndex < end; lineIndex += 1) {
      const line = buffer.getLine(lineIndex);
      if (!line) { lines.push(""); continue; }
      const limit = Math.min(line.length, this.size.cols || 0);
      let lastMeaningful = 0;
      for (let column = 0; column < limit; column += 1) {
        const cell = line.getCell(column);
        if (!cell) continue;
        if (cell.getChars() || !cell.isAttributeDefault()) lastMeaningful = Math.max(lastMeaningful, column + Math.max(1, cell.getWidth()));
      }
      lines.push(line.translateToString(false, 0, Math.min(limit, lastMeaningful)));
      if (!styles) continue;
      let previousKey: string | null = null;
      let runStart = 0;
      let previousStyle: Omit<TerminalStyleRun, "row" | "startColumn" | "endColumn"> = {};
      const flush = (endColumn: number) => {
        if (previousKey && previousKey !== "{}" && endColumn > runStart) styleRuns.push({ row: lineIndex - start, startColumn: runStart, endColumn, ...previousStyle });
      };
      for (let column = 0; column < limit; column += 1) {
        const cell = line.getCell(column);
        const style = cell ? cellStyle(cell) : {};
        const key = styleKey(style);
        if (key !== previousKey) {
          flush(column);
          previousKey = key;
          previousStyle = style;
          runStart = column;
        }
      }
      flush(limit);
    }
    return { lines, styles: styleRuns };
  }

  waitForOutput(
    afterSequence: number,
    quietMs = 400,
    timeoutMs = 60_000,
    includeScrollback: boolean | "recent" | "full" = false,
  ): Promise<TerminalObservation> {
    if (!this.live) return Promise.reject(new Error("terminal is not running"));
    const quiet = Math.max(0, Math.min(5_000, Number.isFinite(quietMs) ? quietMs : 400));
    const timeout = Math.max(1, Math.min(60_000, Number.isFinite(timeoutMs) ? timeoutMs : 60_000));
    const started = Date.now();
    let changedAt: number | null =
      this.sequence > afterSequence ? Date.now() : null;
    let seen = this.sequence;
    return new Promise((resolve, reject) => {
      const timer = window.setInterval(() => {
        if (!this.live) {
          window.clearInterval(timer);
          reject(new Error("terminal exited while waiting for output"));
          return;
        }
        if (this.sequence !== seen) {
          seen = this.sequence;
          changedAt = Date.now();
        }
        const now = Date.now();
        if (changedAt !== null && now - changedAt >= quiet) {
          window.clearInterval(timer);
          resolve({ snapshot: this.snapshot(includeScrollback), timedOut: false });
        } else if (now - started >= timeout) {
          window.clearInterval(timer);
          resolve({ snapshot: this.snapshot(includeScrollback), timedOut: true });
        }
      }, 25);
    });
  }

  private pollProcess(): void {
    void invoke<string | null>("active_terminal_process", {
      sessionId: this.id,
    })
      .then((name) => {
        if (this.disposed || name === this.processName) return;
        if (this.title?.toLowerCase() === this.shellName?.toLowerCase())
          this.title = null;
        this.processName = name;
        if (!this.title && (name ?? this.shellName))
          this.onProcessName(name ?? this.shellName!);
      })
      .catch((reason) => {
        if (!this.disposed && !this.exited)
          this.onError(`Terminal process lookup failed: ${String(reason)}`);
      });
  }

  resize(size: TerminalSize): void {
    if (
      !this.live ||
      !this.terminal ||
      (size.cols === this.size.cols && size.rows === this.size.rows)
    )
      return;
    this.size = size;
    this.terminal.resize(size.cols, size.rows);
    this.onState(true, size);
    void invoke("resize_terminal", { sessionId: this.id, ...size }).catch(
      (reason) => this.onError(`Terminal resize failed: ${String(reason)}`),
    );
  }

  async close(): Promise<void> {
    try {
      if (isTauri()) await invoke("close_terminal", { sessionId: this.id });
    } finally {
      this.dispose();
    }
  }

  dispose(): void {
    sessions.delete(this.id);
    this.disposed = true;
    this.unlisten.forEach((unlisten) => unlisten());
    this.unlisten = [];
    this.disposables.forEach((item) => item.dispose());
    this.disposables = [];
    this.terminal?.dispose();
    this.terminal = null;
    this.live = false;
    this.exited = false;
    this.win32InputMode = false;
    this.sgrMouseMode = false;
    this.title = null;
    this.shellName = null;
    this.processName = null;
    if (this.processInterval !== null)
      window.clearInterval(this.processInterval);
    this.processInterval = null;
    if (this.outputTimer !== null) window.clearTimeout(this.outputTimer);
    this.outputTimer = null;
    this.pendingOutput = [];
    this.resolveOutputCompletion?.();
    this.resolveOutputCompletion = null;
    this.outputCompletion = null;
    this.outputWritePending = false;
    this.cursorStyle = 'block';
    this.cursorBlink = true;
    this.applicationCursorStyle = false;
    this.size = { cols: 0, rows: 0 };
    this.onState(false, this.size);
  }
}

export const initialProfile = (id: string) =>
  colorProfile(id as Parameters<typeof colorProfile>[0]);
