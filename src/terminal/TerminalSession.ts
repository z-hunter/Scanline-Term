import { Terminal } from '@xterm/xterm';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { colorProfile, type TerminalColorProfile } from '../terminal-color-profiles';

export type TerminalSize = { cols: number; rows: number };
export type TerminalLaunch = { command?: string | null; cwd?: string | null };
type TerminalOutput = { sessionId: string; data: number[] };
type TerminalExit = { sessionId: string };

function tabTitle(title: string): string {
  const executable = title.match(/^[A-Za-z]:\\.*\\([^\\]+?\.(?:exe|com|bat|cmd))(?:\s.*)?$/i);
  return executable?.[1] ?? title;
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

  constructor(readonly id: string, private readonly onError: (message: string) => void, private readonly onState: (live: boolean, size: TerminalSize) => void, private readonly onExit: () => void, private readonly onOutput: () => void, private readonly onTitle: (title: string) => void, private readonly onProcessName: (name: string) => void) {}

  async start(size: TerminalSize, profile: TerminalColorProfile, launch?: TerminalLaunch): Promise<string | null> {
    if (!isTauri() || this.disposed || this.terminal) return null;
    const terminal = new Terminal({ cols: size.cols, rows: size.rows, scrollback: 1000, theme: { foreground: profile.foreground, background: profile.background } });
    this.terminal = terminal;
    this.size = size;
    this.disposables.push(
      terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
        if (params.includes(1006)) this.sgrMouseMode = true;
        if (params.length !== 1 || params[0] !== 9001) return false;
        this.win32InputMode = true;
        return true;
      }),
      terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
        if (params.includes(1006)) this.sgrMouseMode = false;
        if (params.length !== 1 || params[0] !== 9001) return false;
        this.win32InputMode = false;
        return true;
      }),
      terminal.onData((input) => this.sendInput(input)),
      terminal.onKey(() => terminal.scrollToBottom()),
      terminal.onTitleChange((title) => { this.title = tabTitle(title); this.onTitle(this.title); }),
    );
    try {
      this.unlisten = await Promise.all([
        listen<TerminalOutput>('terminal-output', (event) => { if (event.payload.sessionId === this.id) terminal.write(Uint8Array.from(event.payload.data), this.onOutput); }),
        listen<TerminalExit>('terminal-exit', (event) => {
          if (event.payload.sessionId !== this.id || this.disposed) return;
          this.exited = true;
          this.live = false;
          this.onState(false, this.size);
          this.onExit();
        }),
      ]);
      const validLaunch = launch && typeof launch === 'object' && !('nativeEvent' in launch) && ('command' in launch || 'cwd' in launch)
        ? { command: typeof launch.command === 'string' ? launch.command : null, cwd: typeof launch.cwd === 'string' ? launch.cwd : null }
        : undefined;
      const shellName = await invoke<string>('start_terminal', { sessionId: this.id, ...size, ...(validLaunch && { launch: validLaunch }) });
      if (this.disposed) {
        void invoke('close_terminal', { sessionId: this.id });
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
    void invoke('write_terminal', { sessionId: this.id, input }).catch((reason) => this.onError(`Terminal input failed: ${String(reason)}`));
  }

  private pollProcess(): void {
    void invoke<string | null>('active_terminal_process', { sessionId: this.id }).then((name) => {
      if (this.disposed || name === this.processName) return;
      if (this.title?.toLowerCase() === this.shellName?.toLowerCase()) this.title = null;
      this.processName = name;
      if (!this.title && (name ?? this.shellName)) this.onProcessName(name ?? this.shellName!);
    }).catch((reason) => { if (!this.disposed && !this.exited) this.onError(`Terminal process lookup failed: ${String(reason)}`); });
  }

  resize(size: TerminalSize): void {
    if (!this.live || !this.terminal || (size.cols === this.size.cols && size.rows === this.size.rows)) return;
    this.size = size;
    this.terminal.resize(size.cols, size.rows);
    this.onState(true, size);
    void invoke('resize_terminal', { sessionId: this.id, ...size }).catch((reason) => this.onError(`Terminal resize failed: ${String(reason)}`));
  }

  async close(): Promise<void> {
    try {
      if (isTauri()) await invoke('close_terminal', { sessionId: this.id });
    } finally {
      this.dispose();
    }
  }

  dispose(): void {
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
    if (this.processInterval !== null) window.clearInterval(this.processInterval);
    this.processInterval = null;
    this.size = { cols: 0, rows: 0 };
    this.onState(false, this.size);
  }
}

export const initialProfile = (id: string) => colorProfile(id as Parameters<typeof colorProfile>[0]);
