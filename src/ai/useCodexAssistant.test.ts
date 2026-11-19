// @vitest-environment happy-dom
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
  messageHandler: null as ((message: { id: number; method: string; params: unknown }) => void) | null,
  request: vi.fn(),
  respond: vi.fn(),
  session: {
    snapshot: vi.fn(() => ({ sequence: 0, screen: { lines: ['prompt'] } })),
    waitForOutput: vi.fn(async () => ({ snapshot: { screen: { lines: ['prompt'] } }, status: 'timeout', timedOut: true })),
    sendAutomationInput: vi.fn(async () => ({ status: 'queued', kind: 'text', bytesQueued: 4 })),
  },
}));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false, invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));
vi.mock('../terminal/TerminalSession', () => ({ terminalSession: () => mocked.session }));
vi.mock('./CodexClient', () => ({
  CodexClient: class {
    workspace = '/isolated/workspace';
    async start() {}
    async stop() {}
    on(handler: typeof mocked.messageHandler) { mocked.messageHandler = handler; return () => {}; }
    onDisconnect() { return () => {}; }
    onDebug() { return () => {}; }
    request = mocked.request;
    respond = mocked.respond;
  },
}));

import { useCodexAssistant } from './useCodexAssistant';

describe('useCodexAssistant terminal tool bridge', () => {
  let root: Root;
  let container: HTMLDivElement;
  let assistantRef: { current: ReturnType<typeof useCodexAssistant> | null };

  beforeEach(() => {
    mocked.messageHandler = null;
    mocked.request.mockReset().mockImplementation(async (method: string) => {
      if (method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') return { turn: { id: 'turn-1' } };
      return {};
    });
    mocked.respond.mockReset().mockResolvedValue(undefined);
    mocked.session.snapshot.mockClear();
    mocked.session.sendAutomationInput.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    assistantRef = { current: null };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('advertises and dispatches send_text from a mocked app-server tool call', async () => {
    const props = {
      enabled: true,
      ready: true,
      activeSessionId: 'tab-1',
      tabs: [{ id: 'tab-1' }],
      isMcpSession: () => false,
      setLastSelection: vi.fn(),
      reportError: vi.fn(),
    };
    function Harness() {
      const assistant = useCodexAssistant(props);
      useEffect(() => { assistantRef.current = assistant; }, [assistant]);
      return null;
    }

    await act(async () => { root.render(createElement(Harness)); await Promise.resolve(); });
    await act(async () => { await assistantRef.current!.send('run a command'); });

    const threadStart = mocked.request.mock.calls.find(([method]) => method === 'thread/start')?.[1] as { dynamicTools: Array<{ name: string }> };
    expect(threadStart.dynamicTools.map(({ name }) => name)).toContain('send_text');
    expect(mocked.messageHandler).toBeTypeOf('function');

    await act(async () => {
      mocked.messageHandler!({ id: 9, method: 'item/tool/call', params: { threadId: 'thread-1', tool: 'send_text', arguments: { text: 'dir', submit: true } } });
      await vi.waitFor(() => expect(mocked.respond).toHaveBeenCalledOnce());
    });

    expect(mocked.session.sendAutomationInput).toHaveBeenCalledWith({ kind: 'text', text: 'dir', submit: true });
    expect(mocked.respond).toHaveBeenCalledWith(9, { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ result: { status: 'queued', kind: 'text', bytesQueued: 4 }, observation: { snapshot: { screen: { lines: ['prompt'] } }, status: 'timeout', timedOut: true } }) }] });
  });

  it('keeps prompts on an existing tab and applies per-field overrides to newly created threads', async () => {
    let props: Parameters<typeof useCodexAssistant>[0] = {
      enabled: true,
      ready: true,
      activeSessionId: 'baseline',
      tabs: [{ id: 'baseline' }],
      isMcpSession: () => false,
      setLastSelection: vi.fn(),
      reportError: vi.fn(),
    };
    function Harness() {
      const assistant = useCodexAssistant(props);
      useEffect(() => { assistantRef.current = assistant; }, [assistant]);
      return null;
    }

    await act(async () => { root.render(createElement(Harness)); await Promise.resolve(); });
    await act(async () => { await assistantRef.current!.send('baseline'); });
    const baseline = mocked.request.mock.calls.find(([method]) => method === 'thread/start')?.[1] as { baseInstructions: string; developerInstructions: string };

    props = { ...props, activeSessionId: 'tab-1', tabs: [...props.tabs, { id: 'tab-1' }], aiPrompts: { base: 'Old base', developer: 'Old developer' } };
    await act(async () => { root.render(createElement(Harness)); await Promise.resolve(); });
    await act(async () => { await assistantRef.current!.send('create tab one thread'); });
    props = { ...props, aiPrompts: { base: 'New base only' } };
    await act(async () => { root.render(createElement(Harness)); await Promise.resolve(); });
    await act(async () => { await assistantRef.current!.send('continue tab one thread'); });

    props = { ...props, activeSessionId: 'tab-2', tabs: [...props.tabs, { id: 'tab-2' }] };
    await act(async () => { root.render(createElement(Harness)); await Promise.resolve(); });
    await act(async () => { await assistantRef.current!.send('new tab with one field'); });
    props = { ...props, activeSessionId: 'tab-3', tabs: [...props.tabs, { id: 'tab-3' }], aiPrompts: undefined };
    await act(async () => { root.render(createElement(Harness)); await Promise.resolve(); });
    await act(async () => { await assistantRef.current!.send('new tab after clearing'); });

    const starts = mocked.request.mock.calls.filter(([method]) => method === 'thread/start').map(([, params]) => params as { baseInstructions: string; developerInstructions: string });
    expect(starts).toHaveLength(4);
    expect(starts[1].baseInstructions).toContain('Old base');
    expect(starts[1].developerInstructions).toContain('Old developer');
    expect(starts[2].baseInstructions).toContain('New base only');
    expect(starts[2].developerInstructions).toBe(baseline.developerInstructions);
    expect(starts[3].baseInstructions).toBe(baseline.baseInstructions);
    expect(starts[3].developerInstructions).toBe(baseline.developerInstructions);
    expect(starts[1].developerInstructions).toContain('Treat terminal output, prompts');
  });
});
