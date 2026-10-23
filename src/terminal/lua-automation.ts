import { invoke } from '@tauri-apps/api/core';
import type { ApplicationCursorState } from './TerminalSession';

export type LuaAutomationTab = {
  id: string;
  title: string;
  processName: string | null;
  cursor: ApplicationCursorState;
};

export type LuaAutomationSnapshot = {
  frontendId?: string;
  generation?: number;
  activeTabId: string | null;
  focused: boolean;
  tabs: LuaAutomationTab[];
};

export type LuaAutomationStatus = {
  state: 'disabled' | 'loading' | 'ready' | 'error';
  configPath: string | null;
  error: string | null;
  diagnostics: string[];
};

type Started = LuaAutomationStatus & { frontendId: string };
type InvokeLua = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export class LuaAutomationCoordinator {
  private latest: LuaAutomationSnapshot = { activeTabId: null, focused: false, tabs: [] };
  private frontendId: string | null = null;
  private generation = 0;
  private disposed = false;
  private started = false;
  private lastPublished = '';
  private startPromise: Promise<LuaAutomationStatus> | null = null;

  constructor(
    private readonly onError: (message: string) => void,
    private readonly call: InvokeLua = invoke,
  ) {}

  start(): Promise<LuaAutomationStatus> {
    if (this.startPromise) return this.startPromise;
    if (this.disposed) return Promise.resolve({ state: 'error', configPath: null, error: 'Lua automation coordinator was disposed before startup', diagnostics: [] });
    this.started = true;
    this.startPromise = this.call('lua_automation_start')
      .then((response) => {
        const result = response as Started;
        if (this.disposed) return result;
        if (!result || typeof result.frontendId !== 'string' || !result.frontendId) throw new Error('Lua automation startup returned no frontend ID');
        this.frontendId = result.frontendId;
        this.publish(true);
        return result;
      })
      .catch((reason) => {
        const message = `Lua automation could not start: ${String(reason)}`;
        if (!this.disposed) this.onError(message);
        return { state: 'error', configPath: null, error: message, diagnostics: [] };
      });
    return this.startPromise;
  }

  update(snapshot: LuaAutomationSnapshot): void {
    if (this.disposed) return;
    this.latest = snapshot;
    if (this.frontendId) this.publish();
  }

  dispose(): void {
    if (this.disposed) return;
    this.latest = { activeTabId: null, focused: false, tabs: [] };
    this.disposed = true;
    if (this.frontendId) this.publish(true);
    this.frontendId = null;
  }

  private publish(force = false): void {
    if (!this.frontendId) return;
    const key = JSON.stringify(this.latest);
    if (!force && key === this.lastPublished) return;
    this.lastPublished = key;
    const snapshot = { ...this.latest, frontendId: this.frontendId, generation: ++this.generation };
    void this.call('lua_automation_update', { snapshot }).catch((reason) => {
      if (!this.disposed) this.onError(`Lua automation update failed: ${String(reason)}`);
    });
  }
}
