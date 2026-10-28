import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
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
  diagnostics: LuaAutomationDiagnostic[];
};

export type LuaAutomationDiagnostic = { level: 'info' | 'error'; message: string };

export type CapsPolicyLease = {
  frontendId: string;
  generation: number;
  policyEpoch: number;
  markerToken: string | null;
  tabId: string | null;
  processName: string | null;
  enabled: boolean;
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
  private pendingUpdate: { frontendId: string; snapshot: LuaAutomationSnapshot } | null = null;
  private publishing = false;
  private startPromise: Promise<LuaAutomationStatus> | null = null;
  private unlistenCapsPolicy: UnlistenFn | null = null;
  private contextKey = '';
  private contextRevision = 0;
  private latestPolicyEpoch = 0;
  private latestPolicyGeneration = 0;
  private acceptedCapsPolicy: CapsPolicyLease | null = null;

  constructor(
    private readonly onError: (message: string) => void,
    private readonly call: InvokeLua = invoke,
    private readonly onCapsPolicy: (lease: CapsPolicyLease | null) => void = () => undefined,
  ) {}

  start(): Promise<LuaAutomationStatus> {
    if (this.startPromise) return this.startPromise;
    if (this.disposed) return Promise.resolve({ state: 'error', configPath: null, error: 'Lua automation coordinator was disposed before startup', diagnostics: [] } satisfies LuaAutomationStatus);
    this.started = true;
    const startPromise = listen<CapsPolicyLease>('caps-policy-lease', ({ payload }) => this.receiveCapsPolicy(payload))
      .then((unlisten) => {
        if (this.disposed) { unlisten(); return null; }
        this.unlistenCapsPolicy = unlisten;
        return this.call('lua_automation_start');
      })
      .then((response) => {
        if (!response) return { state: 'error', configPath: null, error: 'Lua automation coordinator was disposed before startup', diagnostics: [] } satisfies LuaAutomationStatus;
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
        return { state: 'error', configPath: null, error: message, diagnostics: [] } satisfies LuaAutomationStatus;
      });
    this.startPromise = startPromise;
    return startPromise;
  }

  update(snapshot: LuaAutomationSnapshot): void {
    if (this.disposed) return;
    this.latest = snapshot;
    const active = snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId);
    const contextKey = JSON.stringify([snapshot.activeTabId, snapshot.focused && Boolean(active), active?.processName ?? null]);
    if (contextKey !== this.contextKey) {
      this.contextKey = contextKey;
      this.contextRevision += 1;
      this.acceptedCapsPolicy = null;
      this.onCapsPolicy(null);
    }
    if (this.frontendId) this.publish();
  }

  dispose(): void {
    if (this.disposed) return;
    this.latest = { activeTabId: null, focused: false, tabs: [] };
    this.acceptedCapsPolicy = null;
    this.onCapsPolicy(null);
    this.disposed = true;
    if (this.frontendId) this.publish(true);
    this.unlistenCapsPolicy?.();
    this.unlistenCapsPolicy = null;
    this.frontendId = null;
  }

  private publish(force = false): void {
    if (!this.frontendId) return;
    const key = JSON.stringify(this.latest);
    if (!force && key === this.lastPublished) return;
    this.lastPublished = key;
    this.pendingUpdate = { frontendId: this.frontendId, snapshot: { ...this.latest, tabs: [...this.latest.tabs] } };
    if (!this.publishing) void this.publishPendingUpdates();
  }

  private async publishPendingUpdates(): Promise<void> {
    this.publishing = true;
    try {
      while (this.pendingUpdate) {
        const { frontendId, snapshot } = this.pendingUpdate;
        this.pendingUpdate = null;
        try {
          await this.call('lua_automation_update', { snapshot: { ...snapshot, frontendId, generation: ++this.generation } });
        } catch (reason) {
          if (!this.disposed) this.onError(`Lua automation update failed: ${String(reason)}`);
        }
      }
    } finally {
      this.publishing = false;
      if (this.pendingUpdate) void this.publishPendingUpdates();
    }
  }

  private receiveCapsPolicy(lease: CapsPolicyLease): void {
    if (this.disposed || !this.frontendId || lease.frontendId !== this.frontendId || lease.enabled && !/^[0-9a-f]{16}$/i.test(lease.markerToken ?? '') || lease.policyEpoch < this.latestPolicyEpoch) return;
    if (lease.policyEpoch === this.latestPolicyEpoch && lease.generation < this.latestPolicyGeneration) return;
    const supersedesAccepted = lease.policyEpoch > this.latestPolicyEpoch && this.acceptedCapsPolicy !== null;
    if (lease.policyEpoch > this.latestPolicyEpoch) this.latestPolicyGeneration = lease.generation;
    else this.latestPolicyGeneration = Math.max(this.latestPolicyGeneration, lease.generation);
    this.latestPolicyEpoch = lease.policyEpoch;
    if (supersedesAccepted) {
      this.acceptedCapsPolicy = null;
      this.onCapsPolicy(null);
    }
    if (!lease.enabled) {
      this.acceptedCapsPolicy = null;
      if (!supersedesAccepted) this.onCapsPolicy(null);
      return;
    }
    const revision = this.contextRevision;
    const active = this.latest.tabs.find((tab) => tab.id === this.latest.activeTabId);
    const eligible = Boolean(lease.tabId && lease.processName && this.latest.focused && active && lease.tabId === active.id && lease.processName === active.processName);
    if (!eligible) return;
    void this.call('caps_policy_ack', { ack: lease }).then((response) => {
      const accepted = response === true || (response as { accepted?: boolean } | null)?.accepted === true;
      const current = this.latest.tabs.find((tab) => tab.id === this.latest.activeTabId);
      const stillCurrent = revision === this.contextRevision && this.latest.focused && current?.id === lease.tabId && current.processName === lease.processName && lease.policyEpoch === this.latestPolicyEpoch && lease.generation === this.latestPolicyGeneration;
      if (accepted && eligible && stillCurrent) {
        this.acceptedCapsPolicy = lease;
        this.onCapsPolicy(lease);
      } else if (revision === this.contextRevision && lease.policyEpoch === this.latestPolicyEpoch) {
        if (this.acceptedCapsPolicy?.policyEpoch === lease.policyEpoch) this.acceptedCapsPolicy = null;
        this.onCapsPolicy(null);
      }
    }).catch((reason) => {
      if (revision === this.contextRevision && lease.policyEpoch === this.latestPolicyEpoch) {
        this.acceptedCapsPolicy = null;
        this.onCapsPolicy(null);
        this.onError(`Caps policy acknowledgement failed: ${String(reason)}`);
      }
    });
  }
}
