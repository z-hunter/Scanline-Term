import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UnlistenFn } from '@tauri-apps/api/event';

const mocked = vi.hoisted(() => ({
  emit: vi.fn(async (...args: [string, unknown?]): Promise<void> => { void args; }),
  listen: vi.fn(),
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/event', () => ({ emit: mocked.emit, listen: mocked.listen }));

import { TerminalAutomationProbe } from './automation-probe';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('TerminalAutomationProbe lifecycle', () => {
  afterEach(() => { mocked.emit.mockReset().mockImplementation(async () => undefined); mocked.listen.mockReset(); mocked.handlers.clear(); });

  it('unlistens every late listener when disposed during async startup and skips ready', async () => {
    const pending = [deferred<UnlistenFn>(), deferred<UnlistenFn>(), deferred<UnlistenFn>()];
    mocked.listen.mockImplementation(() => pending[mocked.listen.mock.calls.length - 1].promise);
    const stops = vi.fn();
    const probe = new TerminalAutomationProbe();
    const started = probe.start();
    expect(mocked.listen).toHaveBeenCalledTimes(3);

    probe.dispose();
    pending.forEach(({ resolve }) => resolve(stops));
    await started;

    expect(stops).toHaveBeenCalledTimes(3);
    expect(mocked.emit).not.toHaveBeenCalled();
  });

  it('uses one frontend ID for ready, context, and layout traffic and ignores stale replies', async () => {
    mocked.listen.mockImplementation(async (name: string, handler: (event: { payload: unknown }) => void) => {
      mocked.handlers.set(name, handler);
      return () => mocked.handlers.delete(name);
    });
    const onError = vi.fn();
    const probe = new TerminalAutomationProbe(undefined, onError);
    await probe.start();
    const ready = mocked.emit.mock.calls.find(([name]) => name === 'automation-probe-ready')?.[1] as { frontendId: string };
    expect(ready?.frontendId).toEqual(expect.any(String));

    probe.setContext('tab', true);
    mocked.handlers.get('automation-probe-status')?.({ payload: {
      frontendId: ready.frontendId,
      enabled: true,
      layouts: [{ hkl: 'en', klid: null, langIdHint: 'en' }, { hkl: 'ru', klid: null, langIdHint: 'ru' }],
      targets: { normalHkl: 'en', insertHkl: 'ru' },
      currentHkl: 'en',
    } });
    probe.setCursorStyle('tab', 'bar');

    const context = mocked.emit.mock.calls.find(([name]) => name === 'automation-probe-context')?.[1] as { frontendId: string };
    const request = mocked.emit.mock.calls.find(([name]) => name === 'automation-probe-layout-request')?.[1] as { frontendId: string; hkl: string; generation: number; tabId: string };
    expect(context.frontendId).toBe(ready.frontendId);
    expect(request).toMatchObject({ frontendId: ready.frontendId, hkl: 'ru', tabId: 'tab' });

    mocked.handlers.get('automation-probe-layout-error')?.({ payload: { ...request, frontendId: 'stale-frontend', reason: 'stale' } });
    expect(onError).not.toHaveBeenCalled();
    mocked.handlers.get('automation-probe-layout-error')?.({ payload: { ...request, frontendId: ready.frontendId, reason: 'current error' } });
    expect(onError).toHaveBeenCalledTimes(1);
    probe.dispose();
  });

  it('never marks a null tab focused', async () => {
    mocked.listen.mockImplementation(async (name: string, handler: (event: { payload: unknown }) => void) => {
      mocked.handlers.set(name, handler);
      return () => mocked.handlers.delete(name);
    });
    const probe = new TerminalAutomationProbe();
    await probe.start();
    const frontendId = (mocked.emit.mock.calls.find(([name]) => name === 'automation-probe-ready')?.[1] as { frontendId: string }).frontendId;
    mocked.handlers.get('automation-probe-status')?.({ payload: { frontendId, enabled: true } });

    probe.setContext(null, true);

    expect(probe.currentContext).toEqual({ tabId: null, focused: false, generation: 0 });
    const contexts = mocked.emit.mock.calls.filter(([name]) => name === 'automation-probe-context').map(([, payload]) => payload as { focused: boolean; tabId: string | null });
    expect(contexts.length).toBeGreaterThan(0);
    expect(contexts.every(({ tabId, focused }) => tabId !== null || !focused)).toBe(true);
    probe.dispose();
  });

  it('clears a pending layout request after emit failure without retrying until a later transition', async () => {
    mocked.listen.mockImplementation(async (name: string, handler: (event: { payload: unknown }) => void) => {
      mocked.handlers.set(name, handler);
      return () => mocked.handlers.delete(name);
    });
    mocked.emit.mockImplementation(async (name: string) => {
      if (name === 'automation-probe-layout-request') throw new Error('emit failed');
    });
    const onError = vi.fn();
    const probe = new TerminalAutomationProbe(undefined, onError);
    await probe.start();
    const ready = mocked.emit.mock.calls.find(([name]) => name === 'automation-probe-ready')?.[1] as { frontendId: string };
    probe.setContext('tab', true);
    mocked.handlers.get('automation-probe-status')?.({ payload: {
      frontendId: ready.frontendId,
      enabled: true,
      layouts: [{ hkl: 'en', klid: null, langIdHint: 'en' }, { hkl: 'ru', klid: null, langIdHint: 'ru' }],
      targets: { normalHkl: 'en', insertHkl: 'ru' },
      currentHkl: 'en',
    } });

    probe.setCursorStyle('tab', 'bar');
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(mocked.emit.mock.calls.filter(([name]) => name === 'automation-probe-layout-request')).toHaveLength(1);

    probe.setCursorStyle('tab', 'block');
    probe.setCursorStyle('tab', 'bar');
    await vi.waitFor(() => expect(mocked.emit.mock.calls.filter(([name]) => name === 'automation-probe-layout-request')).toHaveLength(2));
    expect(onError).toHaveBeenCalledTimes(2);
    probe.dispose();
  });
});
