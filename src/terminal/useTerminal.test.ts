import { act, createElement, useEffect, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocked = vi.hoisted(() => ({
  invoke: vi.fn(),
  mockCloseWindow: vi.fn(),
  mockSetFullscreen: vi.fn(),
  mockIsFullscreen: vi.fn().mockResolvedValue(false),
  emit: vi.fn(async (...args: [string, unknown?]): Promise<void> => { void args; }),
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: mocked.invoke,
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    close: mocked.mockCloseWindow,
    setFullscreen: mocked.mockSetFullscreen,
    isFullscreen: mocked.mockIsFullscreen,
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  emit: mocked.emit,
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => { mocked.handlers.set(name, handler); return () => mocked.handlers.delete(name); }),
}));

import { DEFAULT_CRT_SETTINGS, RESOLUTIONS } from '../crt/settings';
import { terminalSession, TerminalSession } from './TerminalSession';
import { terminalDimensions } from './ScanlineTerminalRenderer';
import { adjacentTabId, browserTabColor, linkAt, linkAtLine, nextTabId, previousActiveTabId, previousTabId, reorderTabs, renumberTabs, tabIdAtOrdinal, useTerminal, type TerminalTab } from './useTerminal';
import { win32InputKey } from '../win32-input';

const tabs: TerminalTab[] = [
  { id: 'one', ordinal: 1, title: '1. cmd.exe', status: 'running', background: '#000000', foreground: '#ffffff' },
  { id: 'two', ordinal: 2, title: '2. cmd.exe', status: 'running', background: '#000000', foreground: '#ffffff' },
  { id: 'three', ordinal: 3, title: '3. cmd.exe', status: 'running', background: '#000000', foreground: '#ffffff' },
];

describe('adjacentTabId', () => {
  it('selects the right neighbor, then the left, when closing a tab', () => {
    expect(adjacentTabId(tabs, 'two')).toBe('three');
    expect(adjacentTabId(tabs, 'three')).toBe('two');
    expect(adjacentTabId([tabs[0]], 'one')).toBeNull();
  });
});

describe('nextTabId', () => {
  it('cycles to the next tab and wraps around from last to first', () => {
    expect(nextTabId(tabs, 'one')).toBe('two');
    expect(nextTabId(tabs, 'two')).toBe('three');
    expect(nextTabId(tabs, 'three')).toBe('one');
  });

  it('returns null when there is only one tab or tabs are empty', () => {
    expect(nextTabId([tabs[0]], 'one')).toBeNull();
    expect(nextTabId([], 'one')).toBeNull();
  });

  it('returns null if active tab is not found', () => {
    expect(nextTabId(tabs, 'unknown')).toBeNull();
  });
});

describe('previousTabId', () => {
  it('cycles to the previous tab and wraps around from first to last', () => {
    expect(previousTabId(tabs, 'three')).toBe('two');
    expect(previousTabId(tabs, 'two')).toBe('one');
    expect(previousTabId(tabs, 'one')).toBe('three');
  });

  it('returns null when there is only one tab or tabs are empty', () => {
    expect(previousTabId([tabs[0]], 'one')).toBeNull();
    expect(previousTabId([], 'one')).toBeNull();
  });

  it('returns null if active tab is not found', () => {
    expect(previousTabId(tabs, 'unknown')).toBeNull();
  });
});

describe('previousActiveTabId', () => {
  it('returns the most recently used previous tab', () => {
    expect(previousActiveTabId(tabs, ['three', 'one', 'two'], 'three')).toBe('one');
    expect(previousActiveTabId(tabs, ['one', 'three', 'two'], 'one')).toBe('three');
  });

  it('skips tabs that are no longer in tabs list', () => {
    expect(previousActiveTabId([tabs[0], tabs[2]], ['three', 'two', 'one'], 'three')).toBe('one');
  });

  it('returns null if there is no previous tab in history', () => {
    expect(previousActiveTabId(tabs, ['one'], 'one')).toBeNull();
    expect(previousActiveTabId(tabs, [], 'one')).toBeNull();
  });
});

describe('tabIdAtOrdinal', () => {
  it('maps Menu+digit ordinals to tabs', () => {
    expect(tabIdAtOrdinal(tabs, 2)).toBe('two');
    expect(tabIdAtOrdinal([tabs[0], tabs[2]], 3)).toBe('three');
    expect(tabIdAtOrdinal(tabs, 9)).toBeNull();
  });

  it('maps zero to the tenth tab for the gallery shortcut contract', () => {
    const ten = [...tabs, ...Array.from({ length: 7 }, (_, index) => ({ ...tabs[0], id: `extra-${index}`, ordinal: index + 4, title: `${index + 4}. cmd.exe` }))];
    expect(tabIdAtOrdinal(ten, 10)).toBe('extra-6');
  });
});

describe('renumberTabs', () => {
  it('reassigns ordinals and title prefixes after a tab is removed', () => {
    const remaining = renumberTabs([tabs[1], tabs[2]]);

    expect(remaining.map((tab) => ({ id: tab.id, ordinal: tab.ordinal, title: tab.title }))).toEqual([
      { id: 'two', ordinal: 1, title: '1. cmd.exe' },
      { id: 'three', ordinal: 2, title: '2. cmd.exe' },
    ]);
  });
});

describe('browserTabColor', () => {
  it('normalizes page colors and picks readable tab text', () => {
    expect(browserTabColor('#F0F0F0')).toEqual({ background: '#f0f0f0', foreground: '#101a14' });
    expect(browserTabColor('102030')).toEqual({ background: '#102030', foreground: '#d7f5df' });
    expect(browserTabColor('#fff')).toBeNull();
  });
});

describe('reorderTabs', () => {
  it('moves one tab and keeps ordinals and title prefixes sequential', () => {
    const reordered = reorderTabs(tabs, 'three', 0);
    expect(reordered.map((tab) => ({ id: tab.id, ordinal: tab.ordinal, title: tab.title }))).toEqual([
      { id: 'three', ordinal: 1, title: '1. cmd.exe' },
      { id: 'one', ordinal: 2, title: '2. cmd.exe' },
      { id: 'two', ordinal: 3, title: '3. cmd.exe' },
    ]);
  });

  it('clamps the target and leaves missing or unchanged tabs untouched', () => {
    expect(reorderTabs(tabs, 'one', -1).map((tab) => tab.id)).toEqual(['one', 'two', 'three']);
    expect(reorderTabs(tabs, 'one', 99).map((tab) => tab.id)).toEqual(['two', 'three', 'one']);
    expect(reorderTabs(tabs, 'unknown', 1)).toBe(tabs);
  });
});

describe('linkAt', () => {
  it('returns the full valid HTTP(S) URL under the pointer column', () => {
    const text = 'open https://github.com/z-hunter/Scanline-Term?tab=readme now';
    expect(linkAt(text, text.indexOf('github'))).toEqual({ url: 'https://github.com/z-hunter/Scanline-Term?tab=readme', start: 5, end: 56 });
    expect(linkAt(text, 0)).toBeNull();
    expect(linkAt('https://', 0)).toBeNull();
  });

  it('does not include sentence punctuation or unmatched closing delimiters', () => {
    const text = 'see https://example.com/docs).';
    const url = 'https://example.com/docs';
    expect(linkAt(text, text.indexOf('example'))).toEqual({ url, start: 4, end: 4 + url.length - 1 });
    expect(linkAt('see https://example.com/(docs).', 20)?.url).toBe('https://example.com/(docs)');
    expect(linkAt("see https://example.com/docs'", 20)?.url).toBe('https://example.com/docs');
  });
  it('maps cursor-positioned text and URLs through translated empty cells', () => {
    const cells: { getChars: () => string }[] = [...'     '].map(() => ({ getChars: () => '' }));
    cells.push(...'prompt'.split('').map((char) => ({ getChars: () => char })));
    cells.push({ getChars: () => '' }, { getChars: () => '' });
    cells.push(...'https://example.com'.split('').map((char) => ({ getChars: () => char })));
    const line = { length: cells.length, translateToString: () => '     prompt  https://example.com', getCell: (column: number) => cells[column] };

    expect(linkAtLine(line, 13)).toEqual({ url: 'https://example.com', start: 13, end: 31 });
  });
});

describe('terminal launch event', () => {
  it('publishes only native-ready sessions and excludes a failed startup from snapshots', async () => {
    mocked.handlers.clear();
    mocked.invoke.mockClear();
    let completeStart!: (shellName: string) => void;
    let failNextStart = false;
    mocked.invoke.mockImplementation((command: string) => {
      if (command === 'lua_automation_start') return Promise.resolve({ frontendId: 'frontend-startup', state: 'ready', configPath: null, error: null, diagnostics: [] });
      if (command === 'start_terminal') {
        if (failNextStart) { failNextStart = false; return Promise.reject(new Error('startup failed')); }
        return new Promise<string>((resolve) => { completeStart = resolve; });
      }
      return Promise.resolve({});
    });
    let hookResult!: ReturnType<typeof useTerminal>;
    function TestComponent() {
      hookResult = useTerminal({ defaultPreset: { version: 1, resolution: '1024x768', crt: { ...DEFAULT_CRT_SETTINGS } }, ready: false, onError: vi.fn(), onToggleSettings: vi.fn() });
      return null;
    }
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(TestComponent)); });
    const output = document.createElement('canvas'); output.tabIndex = 0; document.body.appendChild(output);
    await act(async () => { hookResult.resizeSource(output); });

    let liveId!: string | null;
    let starting!: Promise<string | null>;
    await act(async () => { starting = hookResult.openSession(); await Promise.resolve(); });
    const latestSnapshot = () => mocked.invoke.mock.calls.filter(([command]) => command === 'lua_automation_update').at(-1)?.[1]?.snapshot as Record<string, unknown>;
    expect(latestSnapshot()).toMatchObject({ activeTabId: null, focused: false, tabs: [] });
    await act(async () => { completeStart('cmd.exe'); liveId = await starting; });
    expect(latestSnapshot()).toMatchObject({ activeTabId: liveId, tabs: [expect.objectContaining({ id: liveId })] });

    failNextStart = true;
    let failedId!: string | null;
    await act(async () => { failedId = await hookResult.openSession(); });
    expect(failedId).not.toBeNull();
    expect(latestSnapshot()).toMatchObject({ activeTabId: null, focused: false, tabs: [expect.objectContaining({ id: liveId })] });
    expect((latestSnapshot().tabs as { id: string }[]).some((tab) => tab.id === failedId)).toBe(false);

    await act(async () => { root.unmount(); });
    terminalSession(liveId!)?.dispose(); terminalSession(failedId!)?.dispose();
    container.remove(); output.remove(); vi.restoreAllMocks();
  });

  it('publishes process and cursor state with active focus, and disarms when a browser tab is selected', async () => {
    mocked.handlers.clear();
    mocked.invoke.mockClear();
    const processBySession = new Map<string, string>();
    mocked.invoke.mockImplementation((command: string, args?: { sessionId?: string }) => {
      if (command === 'lua_automation_start') return Promise.resolve({ frontendId: 'frontend-test', state: 'ready', configPath: null, error: null, diagnostics: [] });
      if (command === 'start_terminal') {
        processBySession.set(args!.sessionId!, processBySession.size === 0 ? 'nvim.exe' : 'pwsh.exe');
        return Promise.resolve('cmd.exe');
      }
      if (command === 'active_terminal_process') return Promise.resolve(processBySession.get(args?.sessionId ?? '') ?? null);
      return Promise.resolve({});
    });
    let hookResult!: ReturnType<typeof useTerminal>;
    function TestComponent() {
      const result = useTerminal({ defaultPreset: { version: 1, resolution: '1024x768', crt: { ...DEFAULT_CRT_SETTINGS } }, channelSwitchEffect: false, ready: false, onError: vi.fn(), onToggleSettings: vi.fn() });
      useEffect(() => { hookResult = result; });
      return null;
    }
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(TestComponent)); });
    const output = document.createElement('canvas'); output.tabIndex = 0; document.body.appendChild(output);
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    await act(async () => { hookResult.resizeSource(output); output.focus(); });
    let nvimId!: string | null;
    let shellId!: string | null;
    await act(async () => { nvimId = await hookResult.openSession(); shellId = await hookResult.openSession(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const latestSnapshot = () => mocked.invoke.mock.calls.filter(([command]) => command === 'lua_automation_update').at(-1)?.[1]?.snapshot as Record<string, unknown>;
    expect(latestSnapshot()).toMatchObject({ activeTabId: shellId, tabs: expect.arrayContaining([expect.objectContaining({ id: nvimId, processName: 'nvim.exe' })]) });

    await act(async () => { hookResult.selectSession(nvimId!, false, false); hookResult.canvasProps.onFocus(); });
    await act(async () => { await new Promise<void>((resolve) => terminalSession(nvimId!)!.terminal!.write('\x1b[5 q', resolve)); });
    expect(latestSnapshot()).toMatchObject({ activeTabId: nvimId, focused: true, tabs: expect.arrayContaining([expect.objectContaining({ id: nvimId, cursor: { shape: 'bar', blink: true } })]) });

    await act(async () => { hookResult.openBrowser(); });
    await act(async () => { await new Promise<void>((resolve) => terminalSession(nvimId!)!.terminal!.write('\x1b[6 q', resolve)); });
    expect(latestSnapshot()).toMatchObject({ activeTabId: null, focused: false, tabs: expect.arrayContaining([expect.objectContaining({ id: nvimId, cursor: { shape: 'bar', blink: false } })]) });

    await act(async () => { root.unmount(); });
    expect(latestSnapshot()).toMatchObject({ activeTabId: null, focused: false, tabs: [] });
    terminalSession(nvimId!)?.dispose(); terminalSession(shellId!)?.dispose();
    container.remove(); output.remove(); hasFocus.mockRestore(); vi.restoreAllMocks();
  });

  it('tracks cursor overrides separately for the active terminal tab', async () => {
    mocked.handlers.clear();
    mocked.invoke.mockClear();
    mocked.invoke.mockImplementation((command: string) => Promise.resolve(command === 'start_terminal' ? 'cmd.exe' : {}));
    let hookResult!: ReturnType<typeof useTerminal>;
    function TestComponent() {
      const result = useTerminal({ defaultPreset: { version: 1, resolution: '1024x768', crt: { ...DEFAULT_CRT_SETTINGS } }, ready: false, onError: vi.fn(), onToggleSettings: vi.fn() });
      useEffect(() => { hookResult = result; });
      return null;
    }
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(TestComponent)); });
    const output = document.createElement('canvas'); output.tabIndex = 0; document.body.appendChild(output);
    await act(async () => { hookResult.resizeSource(output); });
    let first: string | null = null; let second: string | null = null;
    await act(async () => { first = await hookResult.openSession(); second = await hookResult.openSession(); });
    const firstSession = terminalSession(first!);
    const secondSession = terminalSession(second!);
    const write = (session: TerminalSession, data: string) => new Promise<void>((resolve) => session.terminal!.write(data, resolve));

    await act(async () => { await write(firstSession!, '\x1b[5 q'); });
    expect(hookResult.cursorStyleOverridden).toBe(false);
    await act(async () => { await write(secondSession!, '\x1b[3 q'); });
    expect(hookResult.cursorStyleOverridden).toBe(true);
    await act(async () => { hookResult.selectSession(first!, false, false); });
    expect(hookResult.cursorStyleOverridden).toBe(true);
    await act(async () => { await write(firstSession!, '\x1b[0 q'); });
    expect(hookResult.cursorStyleOverridden).toBe(false);
    await act(async () => { hookResult.selectSession(second!, false, false); });
    expect(hookResult.cursorStyleOverridden).toBe(true);

    firstSession?.dispose();
    secondSession?.dispose();
    await act(async () => { root.unmount(); });
    container.remove(); output.remove(); vi.restoreAllMocks();
  });

  it('moves focus reports with the active terminal when the canvas keeps focus', async () => {
    mocked.handlers.clear();
    mocked.invoke.mockClear();
    mocked.invoke.mockImplementation((command: string) => Promise.resolve(command === 'start_terminal' ? 'cmd.exe' : {}));
    let hookResult!: ReturnType<typeof useTerminal>;
    function TestComponent() {
      const result = useTerminal({ defaultPreset: { version: 1, resolution: '1024x768', crt: { ...DEFAULT_CRT_SETTINGS } }, ready: false, onError: vi.fn(), onToggleSettings: vi.fn() });
      useEffect(() => { hookResult = result; });
      return null;
    }
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(TestComponent)); });
    const output = document.createElement('canvas'); output.tabIndex = 0; document.body.appendChild(output);
    await act(async () => { hookResult.resizeSource(output); });
    let first!: string | null; let second!: string | null;
    await act(async () => { first = await hookResult.openSession(); second = await hookResult.openSession(); });
    const firstSession = terminalSession(first!);
    const secondSession = terminalSession(second!);
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const enableFocusReporting = (session: TerminalSession) => new Promise<void>((resolve) => session.terminal!.write('\x1b[?1004h', resolve));
    await act(async () => { await enableFocusReporting(firstSession!); await enableFocusReporting(secondSession!); });
    mocked.invoke.mockClear();
    output.focus();
    await act(async () => { hookResult.canvasProps.onFocus(); });
    expect(mocked.invoke).toHaveBeenCalledWith('write_terminal', { sessionId: second, input: '\x1b[I' });

    mocked.invoke.mockClear();
    await act(async () => { hookResult.selectSession(first!, false, false); });
    expect(mocked.invoke).toHaveBeenCalledWith('write_terminal', { sessionId: second, input: '\x1b[O' });
    expect(mocked.invoke).toHaveBeenCalledWith('write_terminal', { sessionId: first, input: '\x1b[I' });

    mocked.invoke.mockClear();
    hasFocus.mockReturnValue(false);
    await act(async () => { hookResult.selectSession(second!, false, false); });
    expect(mocked.invoke).toHaveBeenCalledWith('write_terminal', { sessionId: first, input: '\x1b[O' });
    expect(mocked.invoke).not.toHaveBeenCalledWith('write_terminal', { sessionId: second, input: '\x1b[I' });

    firstSession?.dispose();
    secondSession?.dispose();
    await act(async () => { root.unmount(); });
    container.remove(); output.remove(); vi.restoreAllMocks();
  });

  it('does not overwrite browser frame form factor styles', async () => {
    mocked.handlers.clear();
    mocked.invoke.mockClear();
    mocked.invoke.mockImplementation((command: string) => Promise.resolve(command === 'start_terminal' ? 'cmd.exe' : {}));
    let hookResult!: ReturnType<typeof useTerminal>;
    function TestComponent() {
      const result = useTerminal({ defaultPreset: { version: 1, resolution: '1024x768', crt: { ...DEFAULT_CRT_SETTINGS } }, ready: false, onError: vi.fn(), onToggleSettings: vi.fn() });
      useEffect(() => { hookResult = result; });
      return null;
    }
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(TestComponent)); });
    const frame = document.createElement('div'); const output = document.createElement('canvas'); frame.appendChild(output); document.body.appendChild(frame);
    vi.spyOn(output, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 500, width: 1000, height: 500, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    await act(async () => { hookResult.openBrowser(); });
    frame.style.setProperty('--screen-ratio', '1.6');
    frame.style.setProperty('aspect-ratio', '8 / 5');
    await act(async () => { hookResult.resizeSource(output); });
    expect(frame.style.getPropertyValue('--screen-ratio')).toBe('1.6');
    expect(frame.style.getPropertyValue('aspect-ratio')).toBe('8 / 5');
    await act(async () => { root.unmount(); });
    container.remove(); frame.remove(); vi.restoreAllMocks();
  });

  it('sizes a first Physical 8:5 session from the inner bezel raster, not a stale canvas backing size', async () => {
    mocked.handlers.clear();
    mocked.invoke.mockClear();
    mocked.invoke.mockImplementation((command: string) => Promise.resolve(command === 'start_terminal' ? 'cmd.exe' : {}));
    const preset = { version: 1 as const, resolution: 'physical-8x5' as const, crt: { ...DEFAULT_CRT_SETTINGS, bezelThickness: 5 } };
    let hookResult!: ReturnType<typeof useTerminal>;
    function TestComponent() {
      const result = useTerminal({ defaultPreset: preset, ready: false, onError: vi.fn(), onToggleSettings: vi.fn() });
      useEffect(() => { hookResult = result; });
      return null;
    }
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(TestComponent)); });
    const frame = document.createElement('div'); const output = document.createElement('canvas'); frame.appendChild(output); document.body.appendChild(frame); output.width = 1234; output.height = 567;
    vi.spyOn(output, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 500, width: 1000, height: 500, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    await act(async () => { hookResult.resizeSource(output); });
    expect(frame.style.getPropertyValue('--screen-ratio')).toBe('1.6');
    expect(frame.style.getPropertyValue('aspect-ratio')).toBe('8 / 5');
    expect(JSON.parse(hookResult.exportGeometryDiagnostics()).entries).toEqual([]);
    hookResult.renderer.resizeSource(output.width, output.height);
    await act(async () => { hookResult.openSession(); await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(mocked.invoke).toHaveBeenCalledWith('start_terminal', expect.objectContaining(terminalDimensions(990, 490, preset.crt.consoleFontSize, preset.crt.consoleFont, preset.crt.cellWidthAdjustment, preset.crt.cellHeightAdjustment)));
    const resizeCalls = mocked.invoke.mock.calls.filter(([command]) => command === 'resize_terminal').length;
    await act(async () => { hookResult.resizeSource(output, 'preset-change', 'stale-session'); });
    expect(mocked.invoke.mock.calls.filter(([command]) => command === 'resize_terminal')).toHaveLength(resizeCalls);
    await act(async () => { root.unmount(); });
    container.remove(); frame.remove(); vi.restoreAllMocks();
  });

  it('scales physical terminal fonts by fractional DPI without changing preset values or fixed modes', async () => {
    const oldDpr = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1.25 });
    mocked.handlers.clear();
    mocked.invoke.mockClear();
    mocked.invoke.mockImplementation((command: string) => Promise.resolve(command === 'start_terminal' ? 'cmd.exe' : {}));
    const preset = { version: 1 as const, resolution: 'physical' as const, crt: { ...DEFAULT_CRT_SETTINGS, consoleFontSize: 16 } };
    let hookResult!: ReturnType<typeof useTerminal>;
    function TestComponent() {
      const result = useTerminal({ defaultPreset: preset, ready: false, onError: vi.fn(), onToggleSettings: vi.fn() });
      useEffect(() => { hookResult = result; });
      return null;
    }
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(TestComponent)); });
    const output = document.createElement('canvas'); document.body.appendChild(output);
    vi.spyOn(output, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 500, width: 1000, height: 500, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    await act(async () => { hookResult.resizeSource(output); });
    expect(hookResult.settingsRef.current.consoleFontSize).toBe(20);
    let physicalTab!: string | null;
    let fixedTab!: string | null;
    await act(async () => { physicalTab = await hookResult.openSession(); fixedTab = await hookResult.openSession(); });
    expect(mocked.invoke).toHaveBeenCalledWith('start_terminal', expect.objectContaining(terminalDimensions(1250, 625, 20, preset.crt.consoleFont, preset.crt.cellWidthAdjustment, preset.crt.cellHeightAdjustment)));

    const fixedPreset = { version: 1 as const, resolution: '1024x768' as const, crt: { ...DEFAULT_CRT_SETTINGS, consoleFontSize: 16 } };
    await act(async () => { hookResult.replaceActivePreset(fixedPreset, 'Fixed', fixedTab!); });
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1.5 });
    await act(async () => { hookResult.resizeSource(output); });
    expect(hookResult.settingsRef.current.consoleFontSize).toBe(16);
    await act(async () => { hookResult.selectSession(physicalTab!, false, false); });
    expect(hookResult.settingsRef.current.consoleFontSize).toBe(24);
    expect(hookResult.activePreset.crt.consoleFontSize).toBe(16);
    await act(async () => { hookResult.selectSession(fixedTab!, false, false); });
    expect(hookResult.settingsRef.current.consoleFontSize).toBe(16);

    await act(async () => { root.unmount(); });
    container.remove(); output.remove();
    if (oldDpr) Object.defineProperty(window, 'devicePixelRatio', oldDpr);
    else Reflect.deleteProperty(window, 'devicePixelRatio');
    vi.restoreAllMocks();
  });

  it('replaces the requested session preset even when another session is active', async () => {
    mocked.handlers.clear();
    mocked.invoke.mockImplementation((command: string) => Promise.resolve(command === 'start_terminal' ? 'cmd.exe' : {}));
    let hookResult!: ReturnType<typeof useTerminal>;
    let expectedTargetId: string | null = null;
    let targetSourceAtLayout: { width: number; height: number } | null = null;
    let outputBackingAtLayout: { width: number; height: number } | null = null;
    let targetOutput: HTMLCanvasElement | null = null;
    function TestComponent() {
      const result = useTerminal({ defaultPreset: { version: 1, resolution: '1024x768', crt: { ...DEFAULT_CRT_SETTINGS } }, channelSwitchEffect: false, ready: false, onError: vi.fn(), onToggleSettings: vi.fn() });
      useLayoutEffect(() => {
        if (result.activeTabId === expectedTargetId && expectedTargetId) {
          targetSourceAtLayout = { width: result.renderer.sourceCanvas.width, height: result.renderer.sourceCanvas.height };
          if (targetOutput) outputBackingAtLayout = { width: targetOutput.width, height: targetOutput.height };
        }
      }, [result.activeTabId, result.renderer]);
      useEffect(() => { hookResult = result; });
      return null;
    }
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(TestComponent)); });
    const frame = document.createElement('div'); const output = document.createElement('canvas'); frame.appendChild(output); document.body.appendChild(frame);
    targetOutput = output;
    vi.spyOn(output, 'getBoundingClientRect').mockImplementation(() => {
      const ratio = frame.style.getPropertyValue('aspect-ratio');
      const [width, height] = ratio ? ratio.split('/').map(Number) : [4, 3];
      const cssHeight = 800 * height / width;
      return { left: 0, top: 0, right: 800, bottom: cssHeight, width: 800, height: cssHeight, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    await act(async () => { hookResult.resizeSource(output); });
    let first!: string | null; let second!: string | null;
    await act(async () => { first = await hookResult.openSession(); second = await hookResult.openSession(); });
    const replacement = { version: 1 as const, resolution: '1280x800' as const, crt: { ...DEFAULT_CRT_SETTINGS, consoleFontSize: 22 } };
    await act(async () => { hookResult.selectSession(second!, false, false); hookResult.replaceActivePreset(replacement, 'Trinitron touch', first!); });
    expectedTargetId = first;
    await act(async () => {
      hookResult.selectSession(first!, false, false);
      expect(hookResult.settingsRef.current.consoleFontSize).toBe(22);
      expect(hookResult.settingsRef.current.channelSwitchEffect).toBe(false);
    });
    expect(targetSourceAtLayout).toEqual({ width: 1280, height: 800 });
    output.width = 1404; output.height = 912;
    await act(async () => { hookResult.selectSession(second!, false, false); });
    output.width = 1404; output.height = 912;
    await act(async () => { hookResult.selectSession(first!, false, false); });
    expect(outputBackingAtLayout).toEqual({ width: 800, height: 500 });
    expect(output.width).toBe(Math.round(output.getBoundingClientRect().width * (window.devicePixelRatio || 1)));
    expect(output.height).toBe(Math.round(output.getBoundingClientRect().height * (window.devicePixelRatio || 1)));
    expect(hookResult.activePreset.resolution).toBe('1280x800');
    const targetResizeCalls = mocked.invoke.mock.calls.filter(([command]) => command === 'resize_terminal').length;
    await act(async () => { hookResult.resizeSource(output, 'preset-change', second!); });
    expect(hookResult.renderer.sourceCanvas).toMatchObject({ width: 1280, height: 800 });
    expect(mocked.invoke.mock.calls.filter(([command]) => command === 'resize_terminal')).toHaveLength(targetResizeCalls);
    await act(async () => { hookResult.selectSession(second!, false, false); });
    expect(hookResult.activePreset.resolution).toBe('1024x768');
    await act(async () => { root.unmount(); });
    container.remove(); frame.remove(); vi.restoreAllMocks();
  });

  it('starts a new session with the command and working directory from -T', async () => {
    mocked.handlers.clear();
    mocked.invoke.mockImplementation((command: string) => Promise.resolve(command === 'initial_terminal_launch' ? {} : 'cmd.exe'));
    let hookResult!: ReturnType<typeof useTerminal>;
    const onError = vi.fn();
    const onToggleSettings = vi.fn();
    function TestComponent() {
      const result = useTerminal({ settings: DEFAULT_CRT_SETTINGS, resolution: RESOLUTIONS[1], onError, onToggleSettings });
      useEffect(() => { hookResult = result; });
      return null;
    }
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(TestComponent)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    await act(async () => { mocked.handlers.get('terminal-launch')!({ payload: { command: 'pwsh', cwd: 'C:\\Windows' } }); await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(hookResult.tabs).toHaveLength(2);
    expect(mocked.invoke).toHaveBeenCalledWith('start_terminal', expect.objectContaining({ launch: { command: 'pwsh', cwd: 'C:\\Windows' } }));
    await act(async () => { await hookResult.closeSession(hookResult.tabs[0].id); });
    expect(hookResult.tabs[0]).toMatchObject({ ordinal: 1, title: '1. cmd.exe' });
    await act(async () => { root.unmount(); });
    container.remove(); vi.restoreAllMocks();
  });

  it('safely ignores DOM event arguments passed to openSession from onClick handlers', async () => {
    mocked.handlers.clear();
    mocked.invoke.mockClear();
    mocked.invoke.mockImplementation((command: string) => Promise.resolve(command === 'initial_terminal_launch' ? {} : 'cmd.exe'));
    let hookResult!: ReturnType<typeof useTerminal>;
    const onError = vi.fn();
    const onToggleSettings = vi.fn();
    function TestComponent() {
      const result = useTerminal({ settings: DEFAULT_CRT_SETTINGS, resolution: RESOLUTIONS[1], onError, onToggleSettings });
      useEffect(() => { hookResult = result; });
      return null;
    }
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(TestComponent)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

    const circular: Record<string, unknown> = { nativeEvent: {} };
    circular.self = circular;

    await act(async () => {
      hookResult.openSession(circular as never);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const startTerminalCalls = mocked.invoke.mock.calls.filter((call) => call[0] === 'start_terminal');
    expect(startTerminalCalls.length).toBe(2);
    expect(startTerminalCalls[1][1]).toEqual(expect.not.objectContaining({ launch: circular }));
    await act(async () => { root.unmount(); });
    container.remove(); vi.restoreAllMocks();
  });
});

describe('useTerminal closeSession concurrent closures', () => {
  it('removes the address modal when an unvisited browser tab closes', async () => {
    mocked.invoke.mockResolvedValue('cmd.exe');
    let hookResult!: ReturnType<typeof useTerminal>;
    const onError = vi.fn();
    function TestComponent() {
      const result = useTerminal({ settings: DEFAULT_CRT_SETTINGS, resolution: RESOLUTIONS[1], onError, onToggleSettings: vi.fn() });
      useEffect(() => { hookResult = result; });
      return null;
    }
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(TestComponent)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    await act(async () => { hookResult.openBrowser(); });
    const browserId = hookResult.activeTabId!;
    expect(hookResult.addressTabId).toBe(browserId);
    await act(async () => { mocked.handlers.get('browser-color')!({ payload: { sessionId: browserId, background: '#f0f0f0' } }); });
    expect(hookResult.tabs.find((tab) => tab.id === browserId)).toMatchObject({ background: '#f0f0f0', foreground: '#101a14' });
    await act(async () => { hookResult.closeAddress(); });
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO', bubbles: true })); });
    expect(hookResult.addressTabId).toBe(browserId);
    await act(async () => { await hookResult.closeSession(browserId); });
    expect(hookResult.addressTabId).toBeNull();
    expect(hookResult.tabs).toHaveLength(1);
    await act(async () => { root.unmount(); });
    container.remove(); vi.restoreAllMocks();
  });

  it('does not intercept KeyO in editable elements or host controls while allowing global F6', async () => {
    mocked.invoke.mockResolvedValue('cmd.exe');
    let hookResult!: ReturnType<typeof useTerminal>;
    const onError = vi.fn();
    function TestComponent() {
      const result = useTerminal({ settings: DEFAULT_CRT_SETTINGS, resolution: RESOLUTIONS[1], onError, onToggleSettings: vi.fn() });
      useEffect(() => { hookResult = result; });
      return null;
    }
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(TestComponent)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    await act(async () => { hookResult.openBrowser(); });
    const browserId = hookResult.activeTabId!;
    expect(hookResult.addressTabId).toBe(browserId);
    await act(async () => { hookResult.closeAddress(); });
    expect(hookResult.addressTabId).toBeNull();

    const input = document.createElement('input');
    container.appendChild(input);
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO', bubbles: true })); });
    expect(hookResult.addressTabId).toBeNull();

    const hostControl = document.createElement('div');
    hostControl.className = 'settings-panel';
    const hostButton = document.createElement('button');
    hostControl.appendChild(hostButton);
    container.appendChild(hostControl);
    await act(async () => { hostButton.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO', bubbles: true })); });
    expect(hookResult.addressTabId).toBeNull();

    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6', bubbles: true })); });
    expect(hookResult.addressTabId).toBe(browserId);

    await act(async () => { await hookResult.closeSession(browserId); });
    await act(async () => { root.unmount(); });
    container.remove(); vi.restoreAllMocks();
  });

  it('serializes final-session decision when two tabs close before either session.close resolves', async () => {
    mocked.invoke.mockResolvedValue('cmd.exe');
    mocked.mockCloseWindow.mockReset();

    const closeResolvers: Array<() => void> = [];
    vi.spyOn(TerminalSession.prototype, 'close').mockImplementation(() => {
      return new Promise<void>((resolve) => {
        closeResolvers.push(resolve);
      });
    });

    let hookResult!: ReturnType<typeof useTerminal>;
    const onError = vi.fn();
    const onToggleSettings = vi.fn();
    function TestComponent() {
      const result = useTerminal({
        settings: DEFAULT_CRT_SETTINGS,
        resolution: RESOLUTIONS[1],
        onError,
        onToggleSettings,
      });
      useEffect(() => {
        hookResult = result;
      });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(TestComponent));
    });

    // Wait for the initial openSession (scheduled via setTimeout)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Open a second session
    await act(async () => {
      hookResult.openSession();
    });

    // Wait for the second session.start promise to resolve so status becomes 'running'
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(hookResult.tabs.length).toBe(2);
    const tab1Id = hookResult.tabs[0].id;
    const tab2Id = hookResult.tabs[1].id;

    // Concurrently close both tabs before either session.close resolves
    let closePromise1!: Promise<void>;
    let closePromise2!: Promise<void>;
    await act(async () => {
      closePromise1 = hookResult.closeSession(tab1Id);
      closePromise2 = hookResult.closeSession(tab2Id);
    });

    expect(closeResolvers.length).toBe(2);
    expect(mocked.mockCloseWindow).not.toHaveBeenCalled();

    // Resolve the first session.close
    await act(async () => {
      closeResolvers[0]();
      await closePromise1;
    });

    // App should NOT close yet because tab 2 is still a managed session
    expect(mocked.mockCloseWindow).not.toHaveBeenCalled();

    // Resolve the second session.close
    await act(async () => {
      closeResolvers[1]();
      await closePromise2;
    });

    // Exactly one closure observed the final managed session and closed the window
    expect(mocked.mockCloseWindow).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('marks tab as failed and selects live replacement when session.close fails', async () => {
    mocked.invoke.mockResolvedValue('cmd.exe');
    mocked.mockCloseWindow.mockReset();

    let hookResult!: ReturnType<typeof useTerminal>;
    const onError = vi.fn();
    const onToggleSettings = vi.fn();
    function TestComponent() {
      const result = useTerminal({
        settings: DEFAULT_CRT_SETTINGS,
        resolution: RESOLUTIONS[1],
        onError,
        onToggleSettings,
      });
      useEffect(() => {
        hookResult = result;
      });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(TestComponent));
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    await act(async () => {
      hookResult.openSession();
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(hookResult.tabs.length).toBe(2);
    const tab1Id = hookResult.tabs[0].id;
    const tab2Id = hookResult.tabs[1].id;

    // Make tab 2 close fail
    vi.spyOn(TerminalSession.prototype, 'close').mockRejectedValueOnce(new Error('Kill process failed'));

    await act(async () => {
      await hookResult.closeSession(tab2Id);
    });

    expect(onError).toHaveBeenCalledWith(expect.stringContaining('Kill process failed'));
    expect(hookResult.tabs.find((t) => t.id === tab2Id)?.status).toBe('failed');
    expect(hookResult.activeSessionId).toBe(tab1Id);

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('reports errors through teardown-safe sink when session.close rejects during unmount', async () => {
    mocked.invoke.mockResolvedValue('cmd.exe');
    mocked.mockCloseWindow.mockReset();

    const onError = vi.fn();
    const onToggleSettings = vi.fn();
    function TestComponent() {
      useTerminal({
        settings: DEFAULT_CRT_SETTINGS,
        resolution: RESOLUTIONS[1],
        onError,
        onToggleSettings,
      });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(TestComponent));
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    vi.spyOn(TerminalSession.prototype, 'close').mockRejectedValueOnce(new Error('Teardown close failed'));

    await act(async () => {
      root.unmount();
    });

    expect(onError).toHaveBeenCalledWith(expect.stringContaining('Teardown close failed'));
    container.remove();
    vi.restoreAllMocks();
  });

  it('marks tab as exited and preserves session buffer when terminal-exit fires', async () => {
    mocked.invoke.mockResolvedValue('cmd.exe');
    mocked.mockCloseWindow.mockReset();
    mocked.handlers.clear();

    let hookResult!: ReturnType<typeof useTerminal>;
    const onError = vi.fn();
    const onToggleSettings = vi.fn();
    function TestComponent() {
      const result = useTerminal({
        settings: DEFAULT_CRT_SETTINGS,
        resolution: RESOLUTIONS[1],
        onError,
        onToggleSettings,
      });
      useEffect(() => {
        hookResult = result;
      });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(TestComponent));
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(hookResult.tabs.length).toBe(1);
    const sessionId = hookResult.tabs[0].id;
    const closeSpy = vi.spyOn(TerminalSession.prototype, 'close');

    await act(async () => {
      mocked.handlers.get('terminal-exit')!({ payload: { sessionId } });
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(hookResult.tabs.length).toBe(1);
    expect(hookResult.tabs[0].status).toBe('exited');
    expect(closeSpy).not.toHaveBeenCalled();
    expect(hookResult.live).toBe(false);

    await act(async () => {
      await hookResult.closeSession(sessionId);
    });
    expect(closeSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('skips startup completion and error handling if initial launch effect cleanup runs first', async () => {
    let rejectLaunch!: (err: Error) => void;
    mocked.invoke.mockImplementation((command: string) => {
      if (command === 'initial_terminal_launch') {
        return new Promise((_, reject) => {
          rejectLaunch = reject;
        });
      }
      return Promise.resolve('cmd.exe');
    });

    const onError = vi.fn();
    const onToggleSettings = vi.fn();
    function TestComponent() {
      useTerminal({
        settings: DEFAULT_CRT_SETTINGS,
        resolution: RESOLUTIONS[1],
        onError,
        onToggleSettings,
      });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(TestComponent));
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    await act(async () => {
      root.unmount();
    });

    await act(async () => {
      rejectLaunch(new Error('Spawn failed after unmount'));
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(onError).not.toHaveBeenCalledWith(expect.stringContaining('Could not read startup arguments'));

    container.remove();
    vi.restoreAllMocks();
  });

  it('triggers onToggleAi on <menu-A> shortcut', async () => {
    mocked.handlers.clear();
    mocked.invoke.mockClear();
    mocked.invoke.mockImplementation(() => Promise.resolve('cmd.exe'));

    const onError = vi.fn();
    const onToggleSettings = vi.fn();
    const onToggleAi = vi.fn();

    function TestComponent() {
      useTerminal({
        settings: DEFAULT_CRT_SETTINGS,
        resolution: RESOLUTIONS[1],
        onError,
        onToggleSettings,
        onToggleAi,
      });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(TestComponent));
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ContextMenu', bubbles: true }));
    });

    expect(onToggleAi).toHaveBeenCalledOnce();

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('routes Menu+V clipboard text to the active session without writing clipboard in either input mode', async () => {
    mocked.handlers.clear();
    mocked.invoke.mockClear();
    mocked.invoke.mockImplementation((command: string) => Promise.resolve(command === 'start_terminal' ? 'powershell.exe' : {}));

    const onError = vi.fn();
    let hookResult!: ReturnType<typeof useTerminal>;
    function TestComponent() {
      const result = useTerminal({ settings: DEFAULT_CRT_SETTINGS, resolution: RESOLUTIONS[1], ready: false, onError, onToggleSettings: vi.fn() });
      useEffect(() => { hookResult = result; });
      return null;
    }

    const clipboardText = 'Get-ChildItem C:\\';
    const readText = vi.fn().mockResolvedValue(clipboardText);
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let session: TerminalSession | undefined;

    try {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText, writeText } });
      await act(async () => {
        root.render(createElement(TestComponent));
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      await act(async () => { await hookResult.openSession(); });
      const sessionId = hookResult.activeSessionId!;
      session = terminalSession(sessionId);
      expect(session).not.toBeNull();

      for (const win32InputMode of [false, true]) {
        session!.win32InputMode = win32InputMode;
        mocked.invoke.mockClear();
        const keyDown = new KeyboardEvent('keydown', { code: 'KeyQ', key: 'q', bubbles: true, cancelable: true });
        const keyUp = new KeyboardEvent('keyup', { code: 'KeyQ', key: 'q', bubbles: true, cancelable: true });
        await act(async () => {
          window.dispatchEvent(keyDown);
          window.dispatchEvent(keyUp);
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(mocked.invoke.mock.calls.filter(([command]) => command === 'write_terminal')).toEqual(win32InputMode
          ? [
              ['write_terminal', { sessionId, input: win32InputKey(keyDown, true) }],
              ['write_terminal', { sessionId, input: win32InputKey(keyUp, false) }],
            ]
          : [['write_terminal', { sessionId, input: 'q' }]]);
      }

      session!.win32InputMode = true;
      mocked.invoke.mockClear();
      const modeSwitchDown = new KeyboardEvent('keydown', { code: 'KeyT', key: 't', bubbles: true, cancelable: true });
      await act(async () => { window.dispatchEvent(modeSwitchDown); });
      session!.win32InputMode = false;
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyT', key: 't', bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(mocked.invoke.mock.calls.filter(([command]) => command === 'write_terminal')).toEqual([
        ['write_terminal', { sessionId, input: win32InputKey(modeSwitchDown, true) }],
      ]);

      const observed: { win32InputMode: boolean; releaseMenuFirst: boolean; writes: unknown[] }[] = [];
      for (const win32InputMode of [false, true]) {
        for (const releaseMenuFirst of [false, true]) {
          session!.win32InputMode = win32InputMode;
          mocked.invoke.mockClear();
          readText.mockClear();
          await act(async () => {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true }));
            window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV', key: 'v', bubbles: true, cancelable: true }));
            if (releaseMenuFirst) {
              window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ContextMenu', bubbles: true, cancelable: true }));
              window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyV', key: 'v', bubbles: true, cancelable: true }));
            } else {
              window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyV', key: 'v', bubbles: true, cancelable: true }));
              window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ContextMenu', bubbles: true, cancelable: true }));
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          });

          expect(readText).toHaveBeenCalledOnce();
          observed.push({
            win32InputMode,
            releaseMenuFirst,
            writes: mocked.invoke.mock.calls.filter(([command]) => command === 'write_terminal'),
          });
        }
      }
      expect(observed).toEqual([false, true].flatMap((win32InputMode) => [false, true].map((releaseMenuFirst) => ({
        win32InputMode,
        releaseMenuFirst,
        writes: [['write_terminal', { sessionId, input: clipboardText }]],
      }))));
      expect(writeText).not.toHaveBeenCalled();
    } finally {
      session?.dispose();
      await act(async () => { root.unmount(); });
      container.remove();
      if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
      else Reflect.deleteProperty(navigator, 'clipboard');
      vi.restoreAllMocks();
    }
  });

  it('switches between tabs on Menu+ArrowRight and Menu+ArrowLeft shortcuts', async () => {
    mocked.handlers.clear();
    mocked.invoke.mockClear();
    mocked.invoke.mockImplementation(() => Promise.resolve('cmd.exe'));

    const onError = vi.fn();
    const onToggleSettings = vi.fn();
    let hookResult!: ReturnType<typeof useTerminal>;

    function TestComponent() {
      const result = useTerminal({
        settings: DEFAULT_CRT_SETTINGS,
        resolution: RESOLUTIONS[1],
        onError,
        onToggleSettings,
      });
      useEffect(() => { hookResult = result; });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(TestComponent));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    await act(async () => {
      hookResult.openSession();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(hookResult.tabs).toHaveLength(2);
    const tab1 = hookResult.tabs[0].id;
    const tab2 = hookResult.tabs[1].id;
    expect(hookResult.activeTabId).toBe(tab2);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ContextMenu', bubbles: true }));
    });
    expect(hookResult.activeTabId).toBe(tab1);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Period', key: '>', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ContextMenu', bubbles: true }));
    });
    expect(hookResult.activeTabId).toBe(tab2);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowLeft', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ContextMenu', bubbles: true }));
    });
    expect(hookResult.activeTabId).toBe(tab1);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Comma', key: '<', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ContextMenu', bubbles: true }));
    });
    expect(hookResult.activeTabId).toBe(tab2);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowLeft', shiftKey: true, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ContextMenu', bubbles: true }));
    });
    expect(hookResult.activeTabId).toBe(tab2);
    expect(hookResult.tabs.map((tab) => tab.id)).toEqual([tab2, tab1]);

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('toggles between two tabs on Menu+Tab shortcut', async () => {
    mocked.handlers.clear();
    mocked.invoke.mockClear();
    mocked.invoke.mockImplementation(() => Promise.resolve('cmd.exe'));

    const onError = vi.fn();
    const onToggleSettings = vi.fn();
    let hookResult!: ReturnType<typeof useTerminal>;

    function TestComponent() {
      const result = useTerminal({
        settings: DEFAULT_CRT_SETTINGS,
        resolution: RESOLUTIONS[1],
        onError,
        onToggleSettings,
      });
      useEffect(() => { hookResult = result; });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(TestComponent));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    await act(async () => {
      hookResult.openSession();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    await act(async () => {
      hookResult.openSession();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(hookResult.tabs.length).toBeGreaterThanOrEqual(2);
    const tab1 = hookResult.tabs[0].id;
    const tab2 = hookResult.tabs[1].id;

    await act(async () => {
      hookResult.selectSession(tab1);
    });
    expect(hookResult.activeTabId).toBe(tab1);

    await act(async () => {
      hookResult.selectSession(tab2);
    });
    expect(hookResult.activeTabId).toBe(tab2);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Tab', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ContextMenu', bubbles: true }));
    });
    expect(hookResult.activeTabId).toBe(tab1);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Tab', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ContextMenu', bubbles: true }));
    });
    expect(hookResult.activeTabId).toBe(tab2);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Tab', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ContextMenu', bubbles: true }));
    });
    expect(hookResult.activeTabId).toBe(tab1);

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('resets fullscreen guard on window blur so later Enter keyup is not consumed', async () => {
    mocked.handlers.clear();
    mocked.invoke.mockClear();
    mocked.invoke.mockImplementation((command: string) => Promise.resolve(command === 'initial_terminal_launch' ? {} : 'cmd.exe'));
    mocked.mockIsFullscreen.mockResolvedValue(false);
    mocked.mockSetFullscreen.mockResolvedValue(undefined);

    let hookResult!: ReturnType<typeof useTerminal>;
    const onError = vi.fn();
    const onToggleSettings = vi.fn();
    function TestComponent() {
      const result = useTerminal({
        settings: DEFAULT_CRT_SETTINGS,
        resolution: RESOLUTIONS[1],
        onError,
        onToggleSettings,
      });
      useEffect(() => { hookResult = result; });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(TestComponent));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const activeId = hookResult.activeTabId!;
    const session = terminalSession(activeId);
    expect(session).toBeDefined();
    if (session) {
      session.win32InputMode = true;
    }

    const sendInputSpy = vi.spyOn(TerminalSession.prototype, 'sendInput');

    // Alt reaches the terminal immediately; Alt+Enter releases it before toggling fullscreen.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'AltLeft', key: 'Alt', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', altKey: true, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'AltLeft', key: 'Alt', bubbles: true }));
    });
    expect(mocked.mockSetFullscreen).toHaveBeenCalled();
    expect(sendInputSpy).toHaveBeenCalledWith('\x1b[18;56;0;1;2;1_');
    expect(sendInputSpy).toHaveBeenCalledWith('\x1b[18;56;0;0;0;1_');

    // Trigger blur without a preceding Enter keyup (e.g. focus transition on fullscreen toggle)
    await act(async () => {
      window.dispatchEvent(new Event('blur'));
    });

    sendInputSpy.mockClear();

    // The consumed Alt+Enter keydown has no matching terminal keyup to send.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Enter', bubbles: true }));
    });

    expect(sendInputSpy).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('does not forward Alt+F4 to terminal session, does not prevent default, and releases forwarded Alt', async () => {
    mocked.handlers.clear();
    mocked.invoke.mockClear();
    mocked.invoke.mockImplementation((command: string) => Promise.resolve(command === 'initial_terminal_launch' ? {} : 'cmd.exe'));

    let hookResult!: ReturnType<typeof useTerminal>;
    const onError = vi.fn();
    const onToggleSettings = vi.fn();
    function TestComponent() {
      const result = useTerminal({
        settings: DEFAULT_CRT_SETTINGS,
        resolution: RESOLUTIONS[1],
        onError,
        onToggleSettings,
      });
      useEffect(() => { hookResult = result; });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(TestComponent));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const activeId = hookResult.activeTabId!;
    const session = terminalSession(activeId);
    expect(session).toBeDefined();
    if (session) {
      session.win32InputMode = true;
    }

    const sendInputSpy = vi.spyOn(TerminalSession.prototype, 'sendInput');

    const f4DownEvent = new KeyboardEvent('keydown', { code: 'F4', key: 'F4', altKey: true, bubbles: true, cancelable: true });
    const f4UpEvent = new KeyboardEvent('keyup', { code: 'F4', key: 'F4', altKey: true, bubbles: true, cancelable: true });

    // Press Alt, then F4, then release F4, then release Alt
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'AltLeft', key: 'Alt', bubbles: true, cancelable: true }));
      window.dispatchEvent(f4DownEvent);
      window.dispatchEvent(f4UpEvent);
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'AltLeft', key: 'Alt', bubbles: true, cancelable: true }));
    });

    // Alt down was forwarded, and when F4 was pressed, forwarded Alt was released
    expect(sendInputSpy).toHaveBeenCalledWith('\x1b[18;56;0;1;2;1_');
    expect(sendInputSpy).toHaveBeenCalledWith('\x1b[18;56;0;0;0;1_');

    // F4 itself was NOT sent to session in any form
    expect(sendInputSpy).not.toHaveBeenCalledWith(expect.stringContaining('115;62'));

    // Default was not prevented on F4 down or up so window close handler receives it
    expect(f4DownEvent.defaultPrevented).toBe(false);
    expect(f4UpEvent.defaultPrevented).toBe(false);

    // Releasing Alt did not trigger duplicate Alt release
    const altUpCalls = sendInputSpy.mock.calls.filter((call) => call[0] === '\x1b[18;56;0;0;0;1_');
    expect(altUpCalls).toHaveLength(1);

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('toggles fullscreen on Right-Alt (AltGr) with Enter and NumpadEnter without requiring event.altKey', async () => {
    mocked.handlers.clear();
    mocked.invoke.mockClear();
    mocked.mockSetFullscreen.mockClear();
    mocked.invoke.mockImplementation((command: string) => Promise.resolve(command === 'initial_terminal_launch' ? {} : 'cmd.exe'));

    let hookResult!: ReturnType<typeof useTerminal>;
    const onError = vi.fn();
    const onToggleSettings = vi.fn();
    function TestComponent() {
      const result = useTerminal({
        settings: DEFAULT_CRT_SETTINGS,
        resolution: RESOLUTIONS[1],
        onError,
        onToggleSettings,
      });
      useEffect(() => { hookResult = result; });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(TestComponent));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const activeId = hookResult.activeTabId!;
    const session = terminalSession(activeId);
    expect(session).toBeDefined();
    if (session) {
      session.win32InputMode = true;
    }

    const sendInputSpy = vi.spyOn(TerminalSession.prototype, 'sendInput');

    // Right-Alt (AltGr) keydown where event.altKey is false on Enter
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'AltRight', key: 'AltGraph', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', altKey: false, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Enter', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'AltRight', key: 'AltGraph', bubbles: true }));
    });

    expect(mocked.mockSetFullscreen).toHaveBeenCalledTimes(1);
    expect(sendInputSpy).toHaveBeenCalledWith('\x1b[18;56;0;1;1;1_');
    expect(sendInputSpy).toHaveBeenCalledWith('\x1b[18;56;0;0;0;1_');

    mocked.mockSetFullscreen.mockClear();
    sendInputSpy.mockClear();

    // Right-Alt with NumpadEnter
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'AltRight', key: 'Alt', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'NumpadEnter', altKey: false, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'NumpadEnter', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'AltRight', key: 'Alt', bubbles: true }));
    });

    expect(mocked.mockSetFullscreen).toHaveBeenCalledTimes(1);
    expect(sendInputSpy).toHaveBeenCalledWith('\x1b[18;56;0;1;1;1_');
    expect(sendInputSpy).toHaveBeenCalledWith('\x1b[18;56;0;0;0;1_');

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('sends matching Win32 Alt keyup on blur when replayed Alt was forwarded', async () => {
    mocked.handlers.clear();
    mocked.invoke.mockClear();
    mocked.invoke.mockImplementation((command: string) => Promise.resolve(command === 'initial_terminal_launch' ? {} : 'cmd.exe'));

    let hookResult!: ReturnType<typeof useTerminal>;
    const onError = vi.fn();
    const onToggleSettings = vi.fn();
    function TestComponent() {
      const result = useTerminal({
        settings: DEFAULT_CRT_SETTINGS,
        resolution: RESOLUTIONS[1],
        onError,
        onToggleSettings,
      });
      useEffect(() => { hookResult = result; });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(TestComponent));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const activeId = hookResult.activeTabId!;
    const session = terminalSession(activeId);
    expect(session).toBeDefined();
    if (session) {
      session.win32InputMode = true;
    }

    const sendInputSpy = vi.spyOn(TerminalSession.prototype, 'sendInput');

    const altDown = new KeyboardEvent('keydown', { code: 'AltLeft', key: 'Alt', bubbles: true, cancelable: true });
    const keyA = new KeyboardEvent('keydown', { code: 'KeyA', key: 'a', altKey: true, bubbles: true, cancelable: true });

    // Press Alt (buffered), then press A (triggers replay of Alt, then forwards KeyA)
    await act(async () => {
      window.dispatchEvent(altDown);
      window.dispatchEvent(keyA);
    });

    const expectedAltDown = win32InputKey(altDown, true);
    expect(sendInputSpy).toHaveBeenCalledWith(expectedAltDown);

    sendInputSpy.mockClear();

    // Blur window before Alt keyup is received
    await act(async () => {
      window.dispatchEvent(new Event('blur'));
    });

    const expectedAltUp = win32InputKey(altDown, false);
    expect(sendInputSpy).toHaveBeenCalledWith(expectedAltUp);

    // Subsequent blur does not send another keyup
    sendInputSpy.mockClear();
    await act(async () => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(sendInputSpy).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('does not suppress Alt when focus is on application controls or when no terminal session is active', async () => {
    mocked.handlers.clear();
    mocked.invoke.mockClear();
    mocked.invoke.mockImplementation((command: string) => Promise.resolve(command === 'initial_terminal_launch' ? {} : 'cmd.exe'));

    let hookResult!: ReturnType<typeof useTerminal>;
    const onError = vi.fn();
    const onToggleSettings = vi.fn();
    function TestComponent() {
      const result = useTerminal({
        settings: DEFAULT_CRT_SETTINGS,
        resolution: RESOLUTIONS[1],
        onError,
        onToggleSettings,
      });
      useEffect(() => { hookResult = result; });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(TestComponent));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // Create an application control (e.g. .settings-panel input)
    const settingsPanel = document.createElement('div');
    settingsPanel.className = 'settings-panel';
    const settingsInput = document.createElement('input');
    settingsPanel.appendChild(settingsInput);
    container.appendChild(settingsPanel);
    settingsInput.focus();

    const altDown1 = new KeyboardEvent('keydown', { code: 'AltLeft', key: 'Alt', bubbles: true, cancelable: true });
    const altUp1 = new KeyboardEvent('keyup', { code: 'AltLeft', key: 'Alt', bubbles: true, cancelable: true });

    await act(async () => {
      settingsInput.dispatchEvent(altDown1);
      settingsInput.dispatchEvent(altUp1);
    });

    expect(altDown1.defaultPrevented).toBe(false);
    expect(altUp1.defaultPrevented).toBe(false);

    // Open browser tab so no terminal session is active
    await act(async () => {
      hookResult.openBrowser('https://example.com');
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // Focus document body (terminal-eligible focus, but active tab is browser)
    document.body.focus();

    const altDown2 = new KeyboardEvent('keydown', { code: 'AltLeft', key: 'Alt', bubbles: true, cancelable: true });
    const altUp2 = new KeyboardEvent('keyup', { code: 'AltLeft', key: 'Alt', bubbles: true, cancelable: true });

    await act(async () => {
      window.dispatchEvent(altDown2);
      window.dispatchEvent(altUp2);
    });

    expect(altDown2.defaultPrevented).toBe(false);
    expect(altUp2.defaultPrevented).toBe(false);

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('sends Alt keyup to original session on keyup and blur even if focus or active tab has changed', async () => {
    mocked.handlers.clear();
    mocked.invoke.mockClear();
    mocked.invoke.mockImplementation((command: string) => Promise.resolve(command === 'initial_terminal_launch' ? {} : 'cmd.exe'));

    let hookResult!: ReturnType<typeof useTerminal>;
    const onError = vi.fn();
    const onToggleSettings = vi.fn();
    function TestComponent() {
      const result = useTerminal({
        settings: DEFAULT_CRT_SETTINGS,
        resolution: RESOLUTIONS[1],
        onError,
        onToggleSettings,
      });
      useEffect(() => { hookResult = result; });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(TestComponent));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    await act(async () => {
      hookResult.openSession();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(hookResult.tabs).toHaveLength(2);
    const tab1Id = hookResult.tabs[0].id;
    const tab2Id = hookResult.tabs[1].id;

    await act(async () => {
      hookResult.selectSession(tab1Id);
    });

    const session1 = terminalSession(tab1Id);
    const session2 = terminalSession(tab2Id);
    expect(session1).toBeDefined();
    expect(session2).toBeDefined();
    if (session1) session1.win32InputMode = true;
    if (session2) session2.win32InputMode = true;

    const spy1 = vi.spyOn(session1!, 'sendInput');
    const spy2 = vi.spyOn(session2!, 'sendInput');

    const altDown = new KeyboardEvent('keydown', { code: 'AltLeft', key: 'Alt', bubbles: true, cancelable: true });
    const keyA = new KeyboardEvent('keydown', { code: 'KeyA', key: 'a', altKey: true, bubbles: true, cancelable: true });

    await act(async () => {
      window.dispatchEvent(altDown);
      window.dispatchEvent(keyA);
    });

    expect(spy1).toHaveBeenCalledWith(win32InputKey(altDown, true));
    spy1.mockClear();
    spy2.mockClear();

    await act(async () => {
      hookResult.selectSession(tab2Id);
    });

    const altUp = new KeyboardEvent('keyup', { code: 'AltLeft', key: 'Alt', bubbles: true, cancelable: true });
    await act(async () => {
      window.dispatchEvent(altUp);
    });

    expect(spy1).toHaveBeenCalledWith(win32InputKey(altDown, false));
    expect(spy2).not.toHaveBeenCalledWith(win32InputKey(altDown, false));

    spy1.mockClear();
    spy2.mockClear();

    await act(async () => {
      hookResult.selectSession(tab1Id);
    });

    const altDown2 = new KeyboardEvent('keydown', { code: 'AltLeft', key: 'Alt', bubbles: true, cancelable: true });
    const keyA2 = new KeyboardEvent('keydown', { code: 'KeyA', key: 'a', altKey: true, bubbles: true, cancelable: true });

    await act(async () => {
      window.dispatchEvent(altDown2);
      window.dispatchEvent(keyA2);
    });

    expect(spy1).toHaveBeenCalledWith(win32InputKey(altDown2, true));
    spy1.mockClear();
    spy2.mockClear();

    await act(async () => {
      hookResult.selectSession(tab2Id);
    });

    await act(async () => {
      window.dispatchEvent(new Event('blur'));
    });

    expect(spy1).toHaveBeenCalledWith(win32InputKey(altDown2, false));
    expect(spy2).not.toHaveBeenCalledWith(win32InputKey(altDown2, false));

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('preserves separate session associations for AltLeft and AltRight and releases appropriately on keyup and blur', async () => {
    mocked.handlers.clear();
    mocked.invoke.mockClear();
    mocked.invoke.mockImplementation((command: string) => Promise.resolve(command === 'initial_terminal_launch' ? {} : 'cmd.exe'));

    let hookResult!: ReturnType<typeof useTerminal>;
    const onError = vi.fn();
    const onToggleSettings = vi.fn();
    function TestComponent() {
      const result = useTerminal({
        settings: DEFAULT_CRT_SETTINGS,
        resolution: RESOLUTIONS[1],
        onError,
        onToggleSettings,
      });
      useEffect(() => { hookResult = result; });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(TestComponent));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    await act(async () => {
      hookResult.openSession();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(hookResult.tabs).toHaveLength(2);
    const tab1Id = hookResult.tabs[0].id;
    const tab2Id = hookResult.tabs[1].id;

    await act(async () => {
      hookResult.selectSession(tab1Id);
    });

    const session1 = terminalSession(tab1Id);
    const session2 = terminalSession(tab2Id);
    expect(session1).toBeDefined();
    expect(session2).toBeDefined();
    if (session1) session1.win32InputMode = true;
    if (session2) session2.win32InputMode = true;

    const spy1 = vi.spyOn(session1!, 'sendInput');
    const spy2 = vi.spyOn(session2!, 'sendInput');

    const altLeft = new KeyboardEvent('keydown', { code: 'AltLeft', key: 'Alt', bubbles: true, cancelable: true });
    const keyA = new KeyboardEvent('keydown', { code: 'KeyA', key: 'a', altKey: true, bubbles: true, cancelable: true });

    await act(async () => {
      window.dispatchEvent(altLeft);
      window.dispatchEvent(keyA);
    });

    expect(spy1).toHaveBeenCalledWith(win32InputKey(altLeft, true));

    await act(async () => {
      hookResult.selectSession(tab2Id);
    });

    const altRight = new KeyboardEvent('keydown', { code: 'AltRight', key: 'Alt', bubbles: true, cancelable: true });
    const keyB = new KeyboardEvent('keydown', { code: 'KeyB', key: 'b', altKey: true, bubbles: true, cancelable: true });

    await act(async () => {
      window.dispatchEvent(altRight);
      window.dispatchEvent(keyB);
    });

    expect(spy2).toHaveBeenCalledWith(win32InputKey(altRight, true));

    spy1.mockClear();
    spy2.mockClear();

    const altLeftUp = new KeyboardEvent('keyup', { code: 'AltLeft', key: 'Alt', bubbles: true, cancelable: true });
    await act(async () => {
      window.dispatchEvent(altLeftUp);
    });

    expect(spy1).toHaveBeenCalledWith(win32InputKey(altLeftUp, false));
    expect(spy2).not.toHaveBeenCalledWith(win32InputKey(altLeftUp, false));

    spy1.mockClear();
    spy2.mockClear();

    await act(async () => {
      window.dispatchEvent(new Event('blur'));
    });

    expect(spy2).toHaveBeenCalledWith(win32InputKey(altRight, false));
    expect(spy1).toHaveBeenCalledWith(win32InputKey(keyA, false));

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('cancels pending delayed session transitions when reselecting the active terminal', async () => {
    mocked.handlers.clear();
    mocked.invoke.mockClear();
    mocked.invoke.mockImplementation((command: string) => Promise.resolve(command === 'initial_terminal_launch' ? {} : 'cmd.exe'));

    let hookResult!: ReturnType<typeof useTerminal>;
    const onError = vi.fn();
    const onToggleSettings = vi.fn();
    const onTerminalTabTransition = vi.fn();
    function TestComponent() {
      const result = useTerminal({
        settings: { ...DEFAULT_CRT_SETTINGS, channelSwitchEffect: false },
        channelSwitchEffect: true,
        resolution: RESOLUTIONS[1],
        onError,
        onToggleSettings,
        onTerminalTabTransition,
      });
      useEffect(() => { hookResult = result; });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(TestComponent));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    await act(async () => {
      hookResult.openSession();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(hookResult.tabs).toHaveLength(2);
    const tab1Id = hookResult.tabs[0].id;
    const tab2Id = hookResult.tabs[1].id;

    await act(async () => {
      hookResult.selectSession(tab1Id, false);
    });
    expect(hookResult.activeTabId).toBe(tab1Id);

    await act(async () => {
      hookResult.selectSession(tab2Id, true);
    });
    expect(onTerminalTabTransition).toHaveBeenCalledTimes(1);
    expect(onTerminalTabTransition).toHaveBeenCalledWith(false);
    expect(hookResult.activeTabId).toBe(tab1Id);

    // Reselect the active tab before the 150ms timeout expires
    await act(async () => {
      hookResult.selectSession(tab1Id);
    });

    // Wait for longer than the 150ms transition timeout
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    // Tab 1 must remain active, delayed transition to tab 2 was cancelled
    expect(hookResult.activeTabId).toBe(tab1Id);
    expect(onTerminalTabTransition).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('restricts wheel intent to terminal canvas and clears pending intent when viewportY does not change', async () => {
    mocked.handlers.clear();
    mocked.invoke.mockClear();
    mocked.invoke.mockImplementation((command: string) => Promise.resolve(command === 'initial_terminal_launch' ? {} : 'cmd.exe'));

    let hookResult!: ReturnType<typeof useTerminal>;
    const onError = vi.fn();
    const onToggleSettings = vi.fn();
    function TestComponent() {
      const result = useTerminal({
        settings: DEFAULT_CRT_SETTINGS,
        resolution: RESOLUTIONS[1],
        onError,
        onToggleSettings,
      });
      useEffect(() => { hookResult = result; });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(TestComponent));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const canvas = document.createElement('canvas');
    canvas.id = 'terminal-canvas';
    canvas.width = 640;
    canvas.height = 400;
    container.appendChild(canvas);
    await act(async () => {
      hookResult.resizeSource(canvas);
    });

    expect(hookResult.tabs.length).toBeGreaterThan(0);
    const tabId = hookResult.tabs[0].id;
    const session = terminalSession(tabId);
    expect(session).toBeDefined();
    const terminal = session!.terminal!;

    await new Promise<void>((resolve) => terminal.write(Array.from({ length: 60 }, (_, i) => `line ${i}\r\n`).join(''), resolve));

    expect(terminal.buffer.active.baseY).toBeGreaterThan(0);
    expect(terminal.buffer.active.viewportY).toBe(terminal.buffer.active.baseY);
    expect(hookResult.scrollback).toBeNull();

    // 1. Wheel event targeting a non-canvas element
    const nonCanvas = document.createElement('div');
    container.appendChild(nonCanvas);
    const nonCanvasWheel = new WheelEvent('wheel', { deltaY: -100, bubbles: true });
    await act(async () => {
      nonCanvas.dispatchEvent(nonCanvasWheel);
    });

    await act(async () => {
      terminal.scrollLines(-5);
      terminal.scrollToBottom();
    });
    expect(hookResult.scrollback).toBeNull();

    // 2. Wheel event on canvas that leaves viewportY unchanged (scrolling down while already at bottom)
    const downWheel = new WheelEvent('wheel', { deltaY: 100, bubbles: true });
    await act(async () => {
      canvas.dispatchEvent(downWheel);
      hookResult.canvasProps.onWheel({
        deltaY: 100,
        preventDefault: vi.fn(),
        currentTarget: canvas,
        clientX: 10,
        clientY: 10,
      } as unknown as React.WheelEvent<HTMLCanvasElement>);
    });

    await act(async () => {
      terminal.scrollLines(-5);
      terminal.scrollToBottom();
    });
    expect(hookResult.scrollback).toBeNull();

    // 3. Wheel event on canvas that actually scrolls terminal up
    const upWheel = new WheelEvent('wheel', { deltaY: -100, bubbles: true });
    await act(async () => {
      canvas.dispatchEvent(upWheel);
      hookResult.canvasProps.onWheel({
        deltaY: -100,
        preventDefault: vi.fn(),
        currentTarget: canvas,
        clientX: 10,
        clientY: 10,
      } as unknown as React.WheelEvent<HTMLCanvasElement>);
    });

    expect(hookResult.scrollback).not.toBeNull();
    const activityAfterScroll = hookResult.scrollback!.activity;
    expect(activityAfterScroll).toBeGreaterThan(0);

    // Later output-driven scroll does not increment user activity
    await act(async () => {
      terminal.scrollToBottom();
    });
    expect(hookResult.scrollback?.activity).toBe(activityAfterScroll);

    // 4. Keyboard PageUp when already at top of scrollback
    await act(async () => {
      terminal.scrollToLine(0);
    });
    expect(terminal.buffer.active.viewportY).toBe(0);

    const contextMenuKey = new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true });
    const pageUpKey = new KeyboardEvent('keydown', { code: 'PageUp', bubbles: true, cancelable: true });

    await act(async () => {
      window.dispatchEvent(contextMenuKey);
      window.dispatchEvent(pageUpKey);
    });

    const activityBefore = hookResult.scrollback?.activity ?? 0;
    await act(async () => {
      terminal.scrollToBottom();
    });
    expect(hookResult.scrollback?.activity).toBe(activityBefore);

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });
});

describe('automation probe input routing', () => {
  it('de-arms the probe after closing its active last terminal while preserving the window', async () => {
    mocked.handlers.clear();
    mocked.emit.mockClear();
    mocked.invoke.mockClear();
    mocked.invoke.mockImplementation((command: string) => Promise.resolve(command === 'start_terminal' ? 'cmd.exe' : {}));
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    let hookResult!: ReturnType<typeof useTerminal>;
    function TestComponent() {
      const result = useTerminal({ defaultPreset: { version: 1, resolution: '1024x768', crt: { ...DEFAULT_CRT_SETTINGS } }, ready: false, onError: vi.fn(), onToggleSettings: vi.fn() });
      useEffect(() => { hookResult = result; });
      return null;
    }
    const container = document.createElement('div'); document.body.appendChild(container);
    const output = document.createElement('canvas'); output.tabIndex = 0; document.body.appendChild(output);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(TestComponent)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { hookResult.resizeSource(output); });
    let id: string | null = null;
    await act(async () => { id = await hookResult.openSession(); });
    expect(terminalSession(id!)?.live).toBe(true);
    await act(async () => { output.focus(); hookResult.canvasProps.onFocus(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const frontendId = (mocked.emit.mock.calls.find(([name]) => name === 'automation-probe-ready')?.[1] as { frontendId: string }).frontendId;
    mocked.handlers.get('automation-probe-status')?.({ payload: { frontendId, enabled: true, layouts: [], targets: null } });
    expect((window as Window & { __scanlineAutomationProbe?: { context: unknown } }).__scanlineAutomationProbe?.context).toMatchObject({ tabId: id, focused: true });

    await act(async () => { await hookResult.closeSession(id!, true, true); });

    expect((window as Window & { __scanlineAutomationProbe?: { context: unknown } }).__scanlineAutomationProbe?.context).toMatchObject({ tabId: null, focused: false });
    const sentContexts = mocked.emit.mock.calls.filter(([name]) => name === 'automation-probe-context').map(([, payload]) => payload as { focused: boolean; tabId: string | null });
    expect(sentContexts.at(-1)).toMatchObject({ tabId: null, focused: false });
    await act(async () => { root.unmount(); });
    container.remove(); output.remove(); vi.restoreAllMocks();
  });

  it.each(['vt', 'win32'] as const)('routes Cyrillic physical H and empty-code VK H as Ctrl+H through the %s encoder', async (encoder) => {
    mocked.handlers.clear();
    mocked.emit.mockClear();
    mocked.invoke.mockClear();
    mocked.invoke.mockImplementation((command: string) => Promise.resolve(command === 'start_terminal' ? 'cmd.exe' : {}));
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    let hookResult!: ReturnType<typeof useTerminal>;
    function TestComponent() {
      const result = useTerminal({ defaultPreset: { version: 1, resolution: '1024x768', crt: { ...DEFAULT_CRT_SETTINGS } }, ready: false, onError: vi.fn(), onToggleSettings: vi.fn() });
      useEffect(() => { hookResult = result; });
      return null;
    }
    const container = document.createElement('div'); document.body.appendChild(container);
    const output = document.createElement('canvas'); output.tabIndex = 0; document.body.appendChild(output);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(TestComponent)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { hookResult.resizeSource(output); });
    let id: string | null = null;
    await act(async () => { id = await hookResult.openSession(); });
    const session = terminalSession(id!);
    expect(session?.live).toBe(true);
    if (encoder === 'win32') session!.win32InputMode = true;
    const sendInput = vi.spyOn(session!, 'sendInput');

    await act(async () => {
      output.focus();
      hookResult.canvasProps.onFocus();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocked.emit).toHaveBeenCalledWith('automation-probe-ready', { frontendId: expect.any(String) });
    const frontendId = (mocked.emit.mock.calls.find(([name]) => name === 'automation-probe-ready')?.[1] as { frontendId: string }).frontendId;
    const statusHandler = mocked.handlers.get('automation-probe-status');
    expect(statusHandler).toBeDefined();
    await act(async () => { statusHandler!({ payload: { frontendId, enabled: true, layouts: [], targets: null } }); });

    const dispatch = (type: 'keydown' | 'keyup', init: KeyboardEventInit, keyCode?: number) => {
      const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
      if (keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: keyCode });
      window.dispatchEvent(event);
      return event;
    };
    const tokenTapDown = dispatch('keydown', { key: 'Unidentified', code: '', repeat: false }, 252);
    const tokenTapUp = dispatch('keyup', { key: 'Unidentified', code: '', repeat: false }, 252);
    const chordTokenDown = dispatch('keydown', { key: 'Unidentified', code: '', repeat: false }, 252);
    const hDown = dispatch('keydown', { key: 'р', code: 'KeyH' }, 72);
    const hUp = dispatch('keyup', { key: 'р', code: 'KeyH' }, 72);
    const chordTokenUp = dispatch('keyup', { key: 'Unidentified', code: '', repeat: false }, 252);
    const vkChordTokenDown = dispatch('keydown', { key: 'Unidentified', code: '', repeat: false }, 252);
    const vkHDown = dispatch('keydown', { key: 'р', code: '' }, 72);
    const vkHUp = dispatch('keyup', { key: 'р', code: '' }, 72);
    const vkChordTokenUp = dispatch('keyup', { key: 'Unidentified', code: '', repeat: false }, 252);
    expect([tokenTapDown.defaultPrevented, tokenTapUp.defaultPrevented, chordTokenDown.defaultPrevented, hDown.defaultPrevented, hUp.defaultPrevented, chordTokenUp.defaultPrevented, vkChordTokenDown.defaultPrevented, vkHDown.defaultPrevented, vkHUp.defaultPrevented, vkChordTokenUp.defaultPrevented]).toEqual(Array(10).fill(true));

    if (encoder === 'vt') {
      expect(sendInput.mock.calls.map(([input]) => input)).toEqual(['\x1b', '\x08', '\x08']);
    } else {
      const escape = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape' });
      const h = new KeyboardEvent('keydown', { key: 'h', code: 'KeyH', ctrlKey: true });
      const vkH = new KeyboardEvent('keydown', { key: 'h', code: '', ctrlKey: true });
      const vkHUp = new KeyboardEvent('keyup', { key: 'h', code: '', ctrlKey: true });
      Object.defineProperty(vkH, 'keyCode', { value: 72 });
      Object.defineProperty(vkHUp, 'keyCode', { value: 72 });
      expect(sendInput.mock.calls.map(([input]) => input)).toEqual([
        win32InputKey(escape, true),
        win32InputKey(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape' }), false),
        win32InputKey(h, true),
        win32InputKey(h, false),
        win32InputKey(vkH, true),
        win32InputKey(vkHUp, false),
      ]);
      expect(sendInput).toHaveBeenCalledTimes(6);
    }
    const trace = (window as Window & { __scanlineAutomationProbe?: { trace: { kind: string }[] } }).__scanlineAutomationProbe?.trace;
    expect(trace?.map(({ kind }) => kind)).toEqual(expect.arrayContaining(['token-down', 'token-up', 'chord-keydown', 'terminal-send']));

    session?.dispose();
    await act(async () => { root.unmount(); });
    container.remove(); output.remove(); vi.restoreAllMocks();
  });

  it('releases a held Win32 chord to its original tab on blur and suppresses late releases after refocus', async () => {
    mocked.handlers.clear();
    mocked.emit.mockClear();
    mocked.invoke.mockClear();
    mocked.invoke.mockImplementation((command: string) => Promise.resolve(command === 'start_terminal' ? 'cmd.exe' : {}));
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    let hookResult!: ReturnType<typeof useTerminal>;
    function TestComponent() {
      const result = useTerminal({ defaultPreset: { version: 1, resolution: '1024x768', crt: { ...DEFAULT_CRT_SETTINGS } }, ready: false, onError: vi.fn(), onToggleSettings: vi.fn() });
      useEffect(() => { hookResult = result; });
      return null;
    }
    const container = document.createElement('div'); document.body.appendChild(container);
    const output = document.createElement('canvas'); output.tabIndex = 0; document.body.appendChild(output);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(TestComponent)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { hookResult.resizeSource(output); });
    let firstId: string | null = null;
    await act(async () => { firstId = await hookResult.openSession(); });
    const first = terminalSession(firstId!);
    expect(first?.live).toBe(true);
    first!.win32InputMode = true;
    const firstSend = vi.spyOn(first!, 'sendInput');
    await act(async () => { output.focus(); hookResult.canvasProps.onFocus(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const frontendId = (mocked.emit.mock.calls.find(([name]) => name === 'automation-probe-ready')?.[1] as { frontendId: string }).frontendId;
    mocked.handlers.get('automation-probe-status')?.({ payload: { frontendId, enabled: true, layouts: [], targets: null } });

    const dispatch = (type: 'keydown' | 'keyup', init: KeyboardEventInit, keyCode?: number) => {
      const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
      if (keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: keyCode });
      window.dispatchEvent(event);
      return event;
    };
    const tokenDown = dispatch('keydown', { key: 'Unidentified', code: '' }, 252);
    const hDown = dispatch('keydown', { key: 'р', code: '' }, 72);
    expect([tokenDown.defaultPrevented, hDown.defaultPrevented]).toEqual([true, true]);
    expect(firstSend).toHaveBeenCalledTimes(1);

    output.blur();
    await act(async () => { hookResult.canvasProps.onBlur(); });
    expect(firstSend).toHaveBeenCalledTimes(2);
    expect(firstSend.mock.calls[1][0]).toContain(';0;8;1_');
    const lateTokenDown = dispatch('keydown', { key: 'Unidentified', code: '' }, 252);
    const lateTokenUp = dispatch('keyup', { key: 'Unidentified', code: '' }, 252);
    const unmatchedTokenUp = dispatch('keyup', { key: 'Unidentified', code: '' }, 252);
    expect([lateTokenDown.defaultPrevented, lateTokenUp.defaultPrevented, unmatchedTokenUp.defaultPrevented]).toEqual([true, true, true]);
    expect(firstSend).toHaveBeenCalledTimes(2);

    let secondId: string | null = null;
    await act(async () => { secondId = await hookResult.openSession(); });
    const second = terminalSession(secondId!);
    expect(second?.live).toBe(true);
    second!.win32InputMode = true;
    const secondSend = vi.spyOn(second!, 'sendInput');
    await act(async () => { output.focus(); hookResult.canvasProps.onFocus(); });
    const lateHUp = dispatch('keyup', { key: 'р', code: '' }, 72);
    const refocusedTokenUp = dispatch('keyup', { key: 'Unidentified', code: '' }, 252);
    expect([lateHUp.defaultPrevented, refocusedTokenUp.defaultPrevented]).toEqual([true, true]);
    expect(firstSend).toHaveBeenCalledTimes(2);
    expect(secondSend).not.toHaveBeenCalled();

    first?.dispose(); second?.dispose();
    await act(async () => { root.unmount(); });
    container.remove(); output.remove(); vi.restoreAllMocks();
  });
});
