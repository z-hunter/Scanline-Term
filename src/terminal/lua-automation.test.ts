import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LuaAutomationCoordinator, type LuaAutomationSnapshot } from './lua-automation';

const mocked = vi.hoisted(() => ({ handler: undefined as ((event: { payload: unknown }) => void) | undefined, listen: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: mocked.listen,
}));

const snapshot: LuaAutomationSnapshot = {
  activeTabId: 'tab-1', focused: true,
  tabs: [{ id: 'tab-1', title: '1. nvim.exe', processName: 'nvim.exe', presetName: 'default', cursor: { shape: 'bar', blink: true, visible: true } }],
};

describe('LuaAutomationCoordinator', () => {
  beforeEach(() => {
    mocked.handler = undefined;
    mocked.listen.mockImplementation(async (_name: string, handler: (event: { payload: unknown }) => void) => {
      mocked.handler = handler;
      return () => { mocked.handler = undefined; };
    });
  });

  it('waits for native readiness and publishes only the latest full state with increasing generations', async () => {
    let ready!: (value: { frontendId: string; state: 'ready'; configPath: null; error: null; diagnostics: [] }) => void;
    const call = vi.fn(<T>(command: string): Promise<T> => command === 'lua_automation_start'
      ? new Promise<T>((resolve) => { ready = (value) => resolve(value as T); })
      : Promise.resolve(undefined as T));
    const coordinator = new LuaAutomationCoordinator(vi.fn(), call);

    const starting = coordinator.start();
    coordinator.update(snapshot);
    coordinator.update({ ...snapshot, focused: false });
    await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());

    ready({ frontendId: 'native-frontend', state: 'ready', configPath: null, error: null, diagnostics: [] });
    await starting;
    expect(call).toHaveBeenNthCalledWith(2, 'lua_automation_update', {
      snapshot: { ...snapshot, focused: false, frontendId: 'native-frontend', generation: 1 },
    });

    coordinator.update({ ...snapshot, focused: false });
    coordinator.update(snapshot);
    coordinator.update(snapshot);
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(3));
    expect(call).toHaveBeenLastCalledWith('lua_automation_update', {
      snapshot: { ...snapshot, frontendId: 'native-frontend', generation: 2 },
    });
  });

  it('serializes updates and coalesces pending snapshots to the newest state', async () => {
    let finishFirstUpdate!: () => void;
    const call = vi.fn(<T>(command: string, _args?: unknown): Promise<T> => {
      if (command === 'lua_automation_start') return Promise.resolve({ frontendId: 'native-frontend', state: 'ready', configPath: null, error: null, diagnostics: [] } as T);
      if (command === 'lua_automation_update' && call.mock.calls.filter(([name]) => name === command).length === 1) {
        return new Promise<T>((resolve) => { finishFirstUpdate = () => resolve(undefined as T); });
      }
      return Promise.resolve(undefined as T);
    });
    const coordinator = new LuaAutomationCoordinator(vi.fn(), call);
    await coordinator.start();

    coordinator.update(snapshot);
    coordinator.update({ ...snapshot, focused: false });
    expect(call.mock.calls.filter(([name]) => name === 'lua_automation_update')).toHaveLength(1);

    finishFirstUpdate();
    await vi.waitFor(() => expect(call.mock.calls.filter(([name]) => name === 'lua_automation_update')).toHaveLength(2));
    expect(call).toHaveBeenLastCalledWith('lua_automation_update', {
      snapshot: { ...snapshot, focused: false, frontendId: 'native-frontend', generation: 2 },
    });
    coordinator.dispose();
  });

  it('rejects a queued preset action after synchronous context invalidation and fresh publication', async () => {
    const call = vi.fn(<T>(command: string, _args?: unknown): Promise<T> => Promise.resolve((command === 'lua_automation_start'
      ? { frontendId: 'native-frontend', state: 'ready', configPath: null, error: null, diagnostics: [] }
      : undefined) as T));
    const coordinator = new LuaAutomationCoordinator(vi.fn(), call);
    await coordinator.start();
    coordinator.update(snapshot);
    await vi.waitFor(() => expect(call.mock.calls.filter(([name]) => name === 'lua_automation_update')).toHaveLength(2));
    const oldGeneration = (call.mock.calls.at(-1)?.[1] as { snapshot: { generation: number } }).snapshot.generation;
    expect(coordinator.matchesActionContext('native-frontend', oldGeneration, 'tab-1')).toBe(true);

    coordinator.invalidateActions();
    expect(coordinator.matchesActionContext('native-frontend', oldGeneration, 'tab-1')).toBe(false);
    await vi.waitFor(() => expect(call.mock.calls.filter(([name]) => name === 'lua_automation_update')).toHaveLength(3));
    const newGeneration = (call.mock.calls.at(-1)?.[1] as { snapshot: { generation: number } }).snapshot.generation;
    expect(newGeneration).toBeGreaterThan(oldGeneration);
    expect(coordinator.matchesActionContext('native-frontend', oldGeneration, 'tab-1')).toBe(false);
    expect(coordinator.matchesActionContext('native-frontend', newGeneration, 'tab-1')).toBe(true);
    coordinator.update({ ...snapshot, focused: false });
    await vi.waitFor(() => expect(call.mock.calls.filter(([name]) => name === 'lua_automation_update')).toHaveLength(4));
    const unfocusedGeneration = (call.mock.calls.at(-1)?.[1] as { snapshot: { generation: number } }).snapshot.generation;
    expect(coordinator.matchesActionContext('native-frontend', unfocusedGeneration, 'tab-1')).toBe(true);
    coordinator.dispose();
  });

  it('pauses actions and coalesces terminal snapshots until reload cleanup commits', async () => {
    const call = vi.fn(<T>(command: string, _args?: unknown): Promise<T> => Promise.resolve((command === 'lua_automation_start'
      ? { frontendId: 'native-frontend', state: 'ready', configPath: null, error: null, diagnostics: [] }
      : undefined) as T));
    const coordinator = new LuaAutomationCoordinator(vi.fn(), call);
    await coordinator.start();
    coordinator.update(snapshot);
    await vi.waitFor(() => expect(call.mock.calls.filter(([name]) => name === 'lua_automation_update')).toHaveLength(2));
    const reloadToken = await coordinator.pauseForReload();
    const oldGeneration = (call.mock.calls.at(-1)?.[1] as { snapshot: { generation: number } }).snapshot.generation;
    expect(coordinator.matchesActionContext('native-frontend', oldGeneration, 'tab-1')).toBe(false);
    expect(coordinator.isReloadCurrent(reloadToken)).toBe(true);

    coordinator.update({ ...snapshot, tabs: [{ ...snapshot.tabs[0], presetName: 'restored' }] });
    expect(call.mock.calls.filter(([name]) => name === 'lua_automation_update')).toHaveLength(2);

    expect(coordinator.resumeAfterReload(reloadToken)).toBe(true);
    await vi.waitFor(() => expect(call.mock.calls.filter(([name]) => name === 'lua_automation_update')).toHaveLength(3));
    expect(call).toHaveBeenLastCalledWith('lua_automation_update', {
      snapshot: { ...snapshot, tabs: [{ ...snapshot.tabs[0], presetName: 'restored' }], frontendId: 'native-frontend', generation: oldGeneration + 1 },
    });
    expect(coordinator.isReloadCurrent(reloadToken)).toBe(false);
    coordinator.dispose();
  });

  it('waits for an in-flight snapshot command before allowing native reload preparation', async () => {
    let finishUpdate!: () => void;
    const call = vi.fn(<T>(command: string, _args?: unknown): Promise<T> => {
      if (command === 'lua_automation_start') return Promise.resolve({ frontendId: 'native-frontend', state: 'ready', configPath: null, error: null, diagnostics: [] } as T);
      return new Promise<T>((resolve) => { finishUpdate = () => resolve(undefined as T); });
    });
    const coordinator = new LuaAutomationCoordinator(vi.fn(), call);
    await coordinator.start();
    coordinator.update(snapshot);
    const paused = coordinator.pauseForReload();
    let pauseFinished = false;
    void paused.then(() => { pauseFinished = true; });
    await Promise.resolve();
    expect(pauseFinished).toBe(false);
    coordinator.update({ ...snapshot, tabs: [{ ...snapshot.tabs[0], presetName: 'restored' }] });
    finishUpdate();
    const token = await paused;
    expect(pauseFinished).toBe(true);
    expect(coordinator.isReloadCurrent(token)).toBe(true);
    expect(call.mock.calls.filter(([name]) => name === 'lua_automation_update')).toHaveLength(1);
    coordinator.resumeAfterReload(token);
    await vi.waitFor(() => expect(call.mock.calls.filter(([name]) => name === 'lua_automation_update')).toHaveLength(2));
    expect(call).toHaveBeenLastCalledWith('lua_automation_update', {
      snapshot: { ...snapshot, tabs: [{ ...snapshot.tabs[0], presetName: 'restored' }], frontendId: 'native-frontend', generation: 2 },
    });
    coordinator.dispose();
  });

  it('invalidates native state on disposal and ignores later updates', async () => {
    const call = vi.fn(<T>(command: string, _args?: unknown): Promise<T> => Promise.resolve((command === 'lua_automation_start'
      ? { frontendId: 'native-frontend', state: 'ready', configPath: null, error: null, diagnostics: [] }
      : undefined) as T));
    const coordinator = new LuaAutomationCoordinator(vi.fn(), call);
    await coordinator.start();
    coordinator.update(snapshot);
    coordinator.dispose();
    coordinator.update(snapshot);

    await vi.waitFor(() => expect(call.mock.calls.at(-1)).toEqual(['lua_automation_update', {
      snapshot: expect.objectContaining({ activeTabId: null, focused: false, tabs: [], frontendId: 'native-frontend' }),
    }]));
    expect((call.mock.calls.at(-1)?.[1] as { snapshot: { generation: number } }).snapshot.generation).toBeGreaterThan(1);
  });

  it('reports a bounded startup error and never sends state without a native token', async () => {
    const onError = vi.fn();
    const call = vi.fn().mockRejectedValue(new Error('runtime unavailable'));
    const coordinator = new LuaAutomationCoordinator(onError, call);
    const status = await coordinator.start();
    coordinator.update(snapshot);

    expect(status.state).toBe('error');
    expect(onError).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledOnce();
  });

  it('acknowledges only a lease matching the active focused process and ignores a late ack after context change', async () => {
    let finishAck!: (value: { accepted: boolean }) => void;
    const call = vi.fn(<T>(command: string): Promise<T> => {
      if (command === 'lua_automation_start') return Promise.resolve({ frontendId: 'native-frontend', state: 'ready', configPath: null, error: null, diagnostics: [] } as T);
      if (command === 'caps_policy_ack') return new Promise<T>((resolve) => { finishAck = (value) => resolve(value as T); });
      return Promise.resolve(undefined as T);
    });
    const onCapsPolicy = vi.fn();
    const coordinator = new LuaAutomationCoordinator(vi.fn(), call, onCapsPolicy);
    await coordinator.start();
    coordinator.update(snapshot);
    const lease = { frontendId: 'native-frontend', generation: 1, policyEpoch: 4, markerToken: '0123456789abcdef', tabId: 'tab-1', processName: 'nvim.exe', enabled: true };
    mocked.handler?.({ payload: lease });
    expect(call).toHaveBeenCalledWith('caps_policy_ack', { ack: lease });

    coordinator.update({ ...snapshot, activeTabId: 'tab-2', tabs: [...snapshot.tabs, { ...snapshot.tabs[0], id: 'tab-2' }] });
    finishAck({ accepted: true });
    await vi.waitFor(() => expect(onCapsPolicy).toHaveBeenLastCalledWith(null));
    expect(onCapsPolicy).not.toHaveBeenCalledWith(lease);
    coordinator.dispose();
  });

  it('clears an accepted lease immediately when native reports policy disabled', async () => {
    const call = vi.fn(<T>(command: string): Promise<T> => Promise.resolve((command === 'lua_automation_start'
      ? { frontendId: 'native-frontend', state: 'ready', configPath: null, error: null, diagnostics: [] }
      : true) as T));
    const onCapsPolicy = vi.fn();
    const coordinator = new LuaAutomationCoordinator(vi.fn(), call, onCapsPolicy);
    await coordinator.start();
    coordinator.update(snapshot);
    const lease = { frontendId: 'native-frontend', generation: 1, policyEpoch: 4, markerToken: '0123456789abcdef', tabId: 'tab-1', processName: 'nvim.exe', enabled: true };
    mocked.handler?.({ payload: lease });
    await vi.waitFor(() => expect(onCapsPolicy).toHaveBeenLastCalledWith(lease));

    mocked.handler?.({ payload: { ...lease, generation: 2, policyEpoch: 5, enabled: false } });
    expect(onCapsPolicy).toHaveBeenLastCalledWith(null);
    expect(call.mock.calls.filter(([command]) => command === 'caps_policy_ack')).toHaveLength(1);
    coordinator.dispose();
  });

  it('disarms an accepted lease while a newer enabled policy awaits acknowledgement', async () => {
    const pending = new Map<number, (value: boolean) => void>();
    const call = vi.fn(<T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      if (command === 'lua_automation_start') return Promise.resolve({ frontendId: 'native-frontend', state: 'ready', configPath: null, error: null, diagnostics: [] } as T);
      if (command === 'caps_policy_ack') {
        const epoch = (args?.ack as { policyEpoch: number }).policyEpoch;
        return new Promise<T>((resolve) => { pending.set(epoch, (value) => resolve(value as T)); });
      }
      return Promise.resolve(undefined as T);
    });
    const onCapsPolicy = vi.fn();
    const coordinator = new LuaAutomationCoordinator(vi.fn(), call, onCapsPolicy);
    await coordinator.start();
    coordinator.update(snapshot);
    const previous = { frontendId: 'native-frontend', generation: 1, policyEpoch: 4, markerToken: '0123456789abcdef', tabId: 'tab-1', processName: 'nvim.exe', enabled: true };
    const next = { ...previous, generation: 2, policyEpoch: 5, markerToken: 'fedcba9876543210' };
    mocked.handler?.({ payload: previous });
    pending.get(4)?.(true);
    await vi.waitFor(() => expect(onCapsPolicy).toHaveBeenLastCalledWith(previous));

    mocked.handler?.({ payload: next });
    expect(onCapsPolicy).toHaveBeenLastCalledWith(null);
    expect(call).toHaveBeenCalledWith('caps_policy_ack', { ack: next });
    pending.get(5)?.(true);
    await vi.waitFor(() => expect(onCapsPolicy).toHaveBeenLastCalledWith(next));
    coordinator.dispose();
  });

  it('keeps the accepted policy across cursor-only snapshots in the same focused tab', async () => {
    const call = vi.fn(<T>(command: string): Promise<T> => Promise.resolve((command === 'lua_automation_start'
      ? { frontendId: 'native-frontend', state: 'ready', configPath: null, error: null, diagnostics: [] }
      : true) as T));
    const onCapsPolicy = vi.fn();
    const coordinator = new LuaAutomationCoordinator(vi.fn(), call, onCapsPolicy);
    await coordinator.start();
    coordinator.update(snapshot);
    const lease = { frontendId: 'native-frontend', generation: 1, policyEpoch: 4, markerToken: '0123456789abcdef', tabId: 'tab-1', processName: 'nvim.exe', enabled: true };
    mocked.handler?.({ payload: lease });
    await vi.waitFor(() => expect(onCapsPolicy).toHaveBeenLastCalledWith(lease));

    coordinator.update({ ...snapshot, tabs: [{ ...snapshot.tabs[0], cursor: { shape: 'block', blink: false, visible: true } }] });
    expect(onCapsPolicy).toHaveBeenLastCalledWith(lease);
    expect(call.mock.calls.filter(([command]) => command === 'caps_policy_ack')).toHaveLength(1);
    coordinator.dispose();
  });

  it('keeps a newer acknowledged lease when an older acknowledgement resolves late', async () => {
    const pending = new Map<number, (value: boolean) => void>();
    const call = vi.fn(<T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      if (command === 'lua_automation_start') return Promise.resolve({ frontendId: 'native-frontend', state: 'ready', configPath: null, error: null, diagnostics: [] } as T);
      if (command === 'caps_policy_ack') {
        const epoch = (args?.ack as { policyEpoch: number }).policyEpoch;
        return new Promise<T>((resolve) => { pending.set(epoch, (value) => resolve(value as T)); });
      }
      return Promise.resolve(undefined as T);
    });
    const onCapsPolicy = vi.fn();
    const coordinator = new LuaAutomationCoordinator(vi.fn(), call, onCapsPolicy);
    await coordinator.start();
    coordinator.update(snapshot);
    const lease = { frontendId: 'native-frontend', generation: 1, policyEpoch: 4, markerToken: '0123456789abcdef', tabId: 'tab-1', processName: 'nvim.exe', enabled: true };
    mocked.handler?.({ payload: lease });
    const newer = { ...lease, generation: 2, policyEpoch: 5 };
    mocked.handler?.({ payload: newer });
    pending.get(5)?.(true);
    await vi.waitFor(() => expect(onCapsPolicy).toHaveBeenLastCalledWith(newer));
    pending.get(4)?.(true);
    await Promise.resolve();
    expect(onCapsPolicy).toHaveBeenLastCalledWith(newer);
    coordinator.dispose();
  });
});
