import { describe, expect, it, vi } from 'vitest';
import { LuaAutomationCoordinator, type LuaAutomationSnapshot } from './lua-automation';

const snapshot: LuaAutomationSnapshot = {
  activeTabId: 'tab-1', focused: true,
  tabs: [{ id: 'tab-1', title: '1. nvim.exe', processName: 'nvim.exe', cursor: { shape: 'bar', blink: true } }],
};

describe('LuaAutomationCoordinator', () => {
  it('waits for native readiness and publishes only the latest full state with increasing generations', async () => {
    let ready!: (value: { frontendId: string; state: 'ready'; configPath: null; error: null; diagnostics: [] }) => void;
    const call = vi.fn(<T>(command: string): Promise<T> => command === 'lua_automation_start'
      ? new Promise<T>((resolve) => { ready = (value) => resolve(value as T); })
      : Promise.resolve(undefined as T));
    const coordinator = new LuaAutomationCoordinator(vi.fn(), call);

    const starting = coordinator.start();
    coordinator.update(snapshot);
    coordinator.update({ ...snapshot, focused: false });
    expect(call).toHaveBeenCalledOnce();

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
});
