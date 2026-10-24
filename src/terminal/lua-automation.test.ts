import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LuaAutomationCoordinator, type LuaAutomationSnapshot } from './lua-automation';

const mocked = vi.hoisted(() => ({ handler: undefined as ((event: { payload: unknown }) => void) | undefined, listen: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: mocked.listen,
}));

const snapshot: LuaAutomationSnapshot = {
  activeTabId: 'tab-1', focused: true,
  tabs: [{ id: 'tab-1', title: '1. nvim.exe', processName: 'nvim.exe', cursor: { shape: 'bar', blink: true, visible: true } }],
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
    expect(call).toHaveBeenCalledTimes(3);
    expect(call).toHaveBeenLastCalledWith('lua_automation_update', {
      snapshot: { ...snapshot, frontendId: 'native-frontend', generation: 2 },
    });
  });

  it('invalidates native state on disposal and ignores later updates', async () => {
    const call = vi.fn(<T>(command: string): Promise<T> => Promise.resolve((command === 'lua_automation_start'
      ? { frontendId: 'native-frontend', state: 'ready', configPath: null, error: null, diagnostics: [] }
      : undefined) as T));
    const coordinator = new LuaAutomationCoordinator(vi.fn(), call);
    await coordinator.start();
    coordinator.update(snapshot);
    coordinator.dispose();
    coordinator.update(snapshot);

    expect(call).toHaveBeenCalledTimes(4);
    expect(call).toHaveBeenLastCalledWith('lua_automation_update', {
      snapshot: { activeTabId: null, focused: false, tabs: [], frontendId: 'native-frontend', generation: 3 },
    });
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
