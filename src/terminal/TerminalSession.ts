import { Terminal } from '@xterm/xterm';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { colorProfile, type TerminalColorProfile } from '../terminal-color-profiles';

export type TerminalSize = { cols: number; rows: number };

export class TerminalSession {
  terminal: Terminal | null = null;
  live = false;
  size: TerminalSize = { cols: 0, rows: 0 };
  win32InputMode = false;
  sgrMouseMode = false;
  private unlisten: UnlistenFn | undefined;
  private disposables: { dispose(): void }[] = [];
  private disposed = false;

  constructor(private readonly onError: (message: string) => void, private readonly onState: (live: boolean, size: TerminalSize) => void) {}

  async start(size: TerminalSize, profile: TerminalColorProfile): Promise<void> {
    if (!isTauri() || this.disposed || this.terminal) return;
    const terminal = new Terminal({ cols: size.cols, rows: size.rows, scrollback: 1000, theme: { foreground: profile.foreground, background: profile.background } });
    this.terminal = terminal;
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
    );
    try {
      this.unlisten = await listen<number[]>('terminal-output', (event) => terminal.write(Uint8Array.from(event.payload)));
      if (this.disposed) {
        this.unlisten();
        return;
      }
      await invoke('start_terminal', size);
      if (this.disposed) {
        void invoke('write_terminal', { input: 'exit\r' });
        return;
      }
      this.live = true;
      this.size = size;
      this.onState(true, size);
    } catch (reason) {
      this.onError(`Windows console could not start: ${String(reason)}`);
    }
  }

  sendInput(input: string): void {
    if (!this.live || !input) return;
    void invoke('write_terminal', { input }).catch((reason) => this.onError(`Terminal input failed: ${String(reason)}`));
  }

  resize(size: TerminalSize): void {
    if (!this.live || !this.terminal || (size.cols === this.size.cols && size.rows === this.size.rows)) return;
    this.size = size;
    this.terminal.resize(size.cols, size.rows);
    this.onState(true, size);
    void invoke('resize_terminal', size).catch((reason) => this.onError(`Terminal resize failed: ${String(reason)}`));
  }

  dispose(): void {
    this.disposed = true;
    this.unlisten?.();
    this.disposables.forEach((item) => item.dispose());
    this.disposables = [];
    this.terminal?.dispose();
    this.terminal = null;
    this.live = false;
    this.win32InputMode = false;
    this.sgrMouseMode = false;
    this.size = { cols: 0, rows: 0 };
    this.onState(false, this.size);
  }
}

export const initialProfile = (id: string) => colorProfile(id as Parameters<typeof colorProfile>[0]);
