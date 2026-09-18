import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type MouseEvent, type WheelEvent } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import { open as openFile } from '@tauri-apps/plugin-dialog';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { RESOLUTIONS } from '../crt/settings';
import type { CRTSettings } from '../crt/CRTFilter';
import type { Resolution } from './TerminalRenderer';
import { canvasFontLoad, TerminalRenderer, terminalAverageColor, terminalDimensions, type CopyPoint, type TabColor, type TerminalImage } from './TerminalRenderer';
import { TerminalSession, initialProfile, type TerminalLaunch, type TerminalOutputScroll, type TerminalSize } from './TerminalSession';
import { terminalKey } from './terminal-input';
import { terminalMouse, type MouseTrackingMode } from './terminal-mouse';
import { win32InputKey } from '../win32-input';
import { showNativeImageMenu, showNativeNewTabMenu } from '../ui/nativeNewTabMenu';
import { clonePresetSettings, DEFAULT_PRESET_SETTINGS, type PresetSettings, type TabPresetState } from '../crt/settings';

export type TerminalTab = { kind?: 'terminal'; id: string; ordinal: number; title: string; status: 'starting' | 'running' | 'exited' | 'failed' } & TabColor;
export type BrowserTab = { kind: 'browser'; id: string; ordinal: number; title: string; status: 'starting' | 'running' | 'failed'; page: 'home' | 'web' } & TabColor;
export type WorkspaceTab = TerminalTab | BrowserTab;
export type ShellInfo = { name: string; command: string };
type SessionRecord = { tab: TerminalTab; session: TerminalSession; inputLocked: boolean; preset: TabPresetState; images: TerminalImage[] };

export function adjacentTabId(tabs: WorkspaceTab[], id: string): string | null {
  const index = tabs.findIndex((tab) => tab.id === id);
  return index < 0 ? null : tabs[index + 1]?.id ?? tabs[index - 1]?.id ?? null;
}

export function nextTabId(tabs: WorkspaceTab[], id: string): string | null {
  if (tabs.length <= 1) return null;
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return null;
  return tabs[(index + 1) % tabs.length].id;
}

export function previousTabId(tabs: WorkspaceTab[], id: string): string | null {
  if (tabs.length <= 1) return null;
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return null;
  return tabs[(index - 1 + tabs.length) % tabs.length].id;
}

export function previousActiveTabId(tabs: WorkspaceTab[], recentTabIds: string[], activeId: string | null): string | null {
  return recentTabIds.find((id) => id !== activeId && tabs.some((tab) => tab.id === id)) ?? null;
}

export function tabIdAtOrdinal(tabs: WorkspaceTab[], ordinal: number): string | null {
  return tabs.find((tab) => tab.ordinal === ordinal)?.id ?? null;
}

export function renumberTabs(tabs: WorkspaceTab[]): WorkspaceTab[] {
  return tabs.map((tab, index) => {
    const ordinal = index + 1;
    const title = tab.title.replace(/^\d+\.\s*/, '');
    return tab.ordinal === ordinal && tab.title === `${ordinal}. ${title}`
      ? tab
      : { ...tab, ordinal, title: `${ordinal}. ${title}` };
  });
}

export function browserTabColor(value: string): TabColor | null {
  const normalized = value.startsWith('#') ? value.slice(1) : value;
  if (!/^[\da-f]{6}$/i.test(normalized)) return null;
  const channels = [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16));
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return { background: `#${normalized.toLowerCase()}`, foreground: luminance > 150 ? '#101a14' : '#d7f5df' };
}

export function useTerminal({ defaultPreset, ready = true, settings, resolution, defaultShell = '', smoothScrollback = false, shells = [], onError, onToggleSettings, onToggleAi, onTerminalTabTransition }: { defaultPreset?: PresetSettings; ready?: boolean; settings?: CRTSettings; resolution?: Resolution; defaultShell?: string; smoothScrollback?: boolean; shells?: ShellInfo[]; onError: (message: string) => void; onToggleSettings: () => void; onToggleAi?: () => void; onTerminalTabTransition?: () => void }) {
  const initialPreset: PresetSettings = defaultPreset ?? { version: 1, resolution: (resolution?.id ?? DEFAULT_PRESET_SETTINGS.resolution) as PresetSettings['resolution'], crt: { ...(settings ?? DEFAULT_PRESET_SETTINGS.crt) } };
  const [live, setLive] = useState(false); const [size, setSize] = useState<TerminalSize>({ cols: 0, rows: 0 }); const [fonts, setFonts] = useState(['Consolas']); const [tabs, setTabs] = useState<WorkspaceTab[]>([]); const [activeTabId, setActiveTabId] = useState<string | null>(null); const [addressTabId, setAddressTabId] = useState<string | null>(null);
  const [activePresetState, setActivePresetState] = useState<TabPresetState | null>(null);
  const renderer = useRef<TerminalRenderer | null>(null); if (!renderer.current) renderer.current = new TerminalRenderer();
  const defaultPresetRef = useRef(initialPreset); const settingsRef = useRef(initialPreset.crt); const defaultShellRef = useRef(defaultShell); const smoothScrollbackRef = useRef(smoothScrollback); const outputRef = useRef<HTMLCanvasElement | null>(null); const sessions = useRef(new Map<string, SessionRecord>()); const browsers = useRef(new Set<string>()); const tabsRef = useRef<WorkspaceTab[]>([]); const activeRef = useRef<string | null>(null); const recentTabs = useRef<string[]>([]); const nextOrdinal = useRef(1); const colorFrames = useRef(new Map<string, number>()); const pressed = useRef(new Set<number>()); const copyStart = useRef<CopyPoint | null>(null); const copyMode = useRef(false); const imageDrag = useRef<{ image: TerminalImage; x: number; y: number } | null>(null); const menu = useRef(false); const menuEvent = useRef<KeyboardEvent | null>(null); const menuShortcut = useRef(false); const fullscreen = useRef(false); const suppressAlt = useRef(false); const pendingAlt = useRef<KeyboardEvent[]>([]); const forwardedAltRef = useRef(new Map<string, { event: KeyboardEvent; session: TerminalSession }>()); const alt = useRef(false); const closing = useRef(new Set<string>()); const onErrorRef = useRef(onError); const onTerminalTabTransitionRef = useRef(onTerminalTabTransition); const pendingSelection = useRef<number | null>(null);
  defaultPresetRef.current = initialPreset; settingsRef.current = activePresetState?.settings.crt ?? initialPreset.crt; defaultShellRef.current = defaultShell; smoothScrollbackRef.current = smoothScrollback; tabsRef.current = tabs; activeRef.current = activeTabId; onErrorRef.current = onError; onTerminalTabTransitionRef.current = onTerminalTabTransition;
  const updateTab = useCallback((id: string, update: (tab: WorkspaceTab) => WorkspaceTab) => setTabs((current) => current.map((tab) => tab.id === id ? update(tab) : tab)), []);
  const refreshTabColor = useCallback((id: string) => {
    if (colorFrames.current.has(id)) return;
    const frame = window.requestAnimationFrame(() => {
      colorFrames.current.delete(id);
      const terminal = sessions.current.get(id)?.session.terminal;
      if (!terminal) return;
      const crt = sessions.current.get(id)?.preset.settings.crt ?? defaultPresetRef.current.crt;
      const color = terminalAverageColor(terminal, initialProfile(crt.colorProfile), crt.colorMode, crt.backgroundDesaturation);
      updateTab(id, (current) => ({ ...current, ...color }));
    });
    colorFrames.current.set(id, frame);
  }, [updateTab]);
  const selectSession = useCallback((id: string, animate = true) => {
    if (pendingSelection.current !== null) {
      window.clearTimeout(pendingSelection.current);
      pendingSelection.current = null;
    }
    if (id === activeRef.current) return;
    const record = sessions.current.get(id);
    if (animate && record && sessions.current.has(activeRef.current ?? '') && settingsRef.current.channelSwitchEffect && onTerminalTabTransitionRef.current) {
      onTerminalTabTransitionRef.current();
      pendingSelection.current = window.setTimeout(() => {
        pendingSelection.current = null;
        selectSession(id, false);
      }, 150);
      return;
    }
    recentTabs.current = [id, ...recentTabs.current.filter((item) => item !== id)];
    activeRef.current = id; setActiveTabId(id);
    if (!record) { setActivePresetState(null); settingsRef.current = defaultPresetRef.current.crt; setLive(false); renderer.current!.bindTerminal(null); renderer.current!.setImages([]); renderer.current!.setFocused(false); renderer.current!.setSelection(null); return; }
    setActivePresetState(record.preset);
    settingsRef.current = record.preset.settings.crt;
    renderer.current!.bindTerminal(record.session.terminal); renderer.current!.setImages(record.images); renderer.current!.setSelection(null); pressed.current.clear(); copyStart.current = null; copyMode.current = false; setLive(record.session.live); setSize(record.session.size);
  }, []);
  const updateActivePreset = useCallback((update: (current: TabPresetState) => TabPresetState) => {
    const record = activeRef.current ? sessions.current.get(activeRef.current) : undefined;
    if (!record) return;
    const next = update(record.preset);
    record.preset = next;
    setActivePresetState(next);
    settingsRef.current = next.settings.crt;
    renderer.current?.cancelScroll(); renderer.current?.markDirty();
  }, []);
  const replaceActivePreset = useCallback((settings: PresetSettings, name: string) => {
    updateActivePreset(() => ({ name, draftName: name, settings: clonePresetSettings(settings), dirty: false }));
  }, [updateActivePreset]);
  const markActivePresetSaved = useCallback((name: string) => {
    updateActivePreset((current) => ({ ...current, name, draftName: name, dirty: false }));
  }, [updateActivePreset]);
  const openSession = useCallback((launch?: TerminalLaunch) => {
    if (!isTauri()) return;
    const id = crypto.randomUUID(); const ordinal = nextOrdinal.current++; const preset = clonePresetSettings(defaultPresetRef.current); const initialColor = initialProfile(preset.crt.colorProfile); const tab: TerminalTab = { id, ordinal, title: `${ordinal}. Starting`, status: 'starting', background: initialColor.background, foreground: initialColor.foreground };
    const session = new TerminalSession(id, onError, (nextLive, nextSize) => { if (activeRef.current === id) { setLive(nextLive); setSize(nextSize); } }, () => { const record = sessions.current.get(id); if (record) record.tab.status = 'exited'; updateTab(id, (current) => ({ ...(current as TerminalTab), status: 'exited' })); }, (scroll?: TerminalOutputScroll) => { if (activeRef.current === id && scroll?.autoScroll && smoothScrollbackRef.current) renderer.current?.beginScroll(scroll.fromViewportY, scroll.toViewportY); refreshTabColor(id); }, (title) => updateTab(id, (current) => ({ ...(current as TerminalTab), title: `${current.ordinal}. ${title}` })), (name) => updateTab(id, (current) => ({ ...(current as TerminalTab), title: `${current.ordinal}. ${name}` })));
    sessions.current.set(id, { tab, session, inputLocked: false, preset: { name: 'default', draftName: 'default', settings: preset, dirty: false }, images: [] }); setTabs((current) => [...current, tab]); selectSession(id, false);
    const resolution = RESOLUTIONS.find((item) => item.id === preset.resolution) ?? RESOLUTIONS[6]; if (outputRef.current) renderer.current!.resizeSource(resolution, outputRef.current); const source = renderer.current!.sourceCanvas; const dimensions = terminalDimensions(source.width || ('width' in resolution ? resolution.width : 1), source.height || ('height' in resolution ? resolution.height : 1), preset.crt.consoleFontSize, preset.crt.consoleFont, preset.crt.cellWidthAdjustment, preset.crt.cellHeightAdjustment, preset.crt.fallbackFont);
    const validLaunch = launch && typeof launch === 'object' && !('nativeEvent' in launch) && ('command' in launch || 'cwd' in launch) ? { command: typeof launch.command === 'string' ? launch.command : null, cwd: typeof launch.cwd === 'string' ? launch.cwd : null } : undefined;
    const effectiveLaunch = validLaunch || defaultShellRef.current ? { ...validLaunch, command: validLaunch?.command || defaultShellRef.current || null } : undefined;
    const starting = session.start(dimensions, initialProfile(preset.crt.colorProfile), effectiveLaunch);
    if (session.terminal) session.terminal.options.cursorStyle = preset.crt.cursorStyle;
    renderer.current!.bindTerminal(session.terminal);
    void starting.then((shellName) => updateTab(id, (current) => current.status === 'exited' ? current : shellName ? { ...current, title: `${current.ordinal}. ${session.title ?? shellName}`, status: 'running' } : { ...current, title: `${current.ordinal}. Failed`, status: 'failed' })).catch((reason) => { updateTab(id, (current) => ({ ...current, title: `${current.ordinal}. Failed`, status: 'failed' })); onError(`Terminal startup failed: ${String(reason)}`); });
  }, [onError, refreshTabColor, selectSession, updateTab]);
  const addImage = useCallback(async () => {
    const id = activeRef.current; const record = id ? sessions.current.get(id) : undefined;
    if (!record || !isTauri()) return;
    let selected: string | string[] | null;
    try { selected = await openFile({ multiple: false, directory: false, filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }] }); }
    catch (reason) { onError(`Could not open image picker: ${String(reason)}`); return; }
    const path = Array.isArray(selected) ? selected[0] : selected;
    if (!path) return;
    if (!/\.(png|jpe?g)$/i.test(path)) { onError('Unsupported image format. Choose PNG or JPG.'); return; }
    const image = new Image(); image.crossOrigin = 'anonymous';
    const item: TerminalImage = { id: crypto.randomUUID(), src: path, image, x: 0, y: 0, width: 0, height: 0, baseWidth: 0, baseHeight: 0 };
    image.onload = () => {
      const source = renderer.current!.sourceCanvas; const scale = Math.min(1, source.width * .8 / image.naturalWidth, source.height * .8 / image.naturalHeight); const width = image.naturalWidth * scale; const height = image.naturalHeight * scale;
      item.width = item.baseWidth = width / source.width; item.height = item.baseHeight = height / source.height; item.x = (1 - item.width) / 2; item.y = (1 - item.height) / 2;
      if (activeRef.current === id) renderer.current!.markImagesDirty();
    };
    image.onerror = () => { const index = record.images.indexOf(item); if (index >= 0) record.images.splice(index, 1); if (item.objectUrl) URL.revokeObjectURL(item.objectUrl); if (activeRef.current === id) { renderer.current!.markImagesDirty(); onError(`Could not decode image: ${path}`); } };
    record.images.push(item); if (activeRef.current === id) renderer.current!.setImages(record.images);
    try { void fetch(convertFileSrc(path)).then((response) => { if (!response.ok) throw new Error(`asset request returned ${response.status}`); return response.blob(); }).then((blob) => { item.objectUrl = URL.createObjectURL(blob); image.src = item.objectUrl; }).catch((reason) => { const index = record.images.indexOf(item); if (index >= 0) record.images.splice(index, 1); if (activeRef.current === id) { renderer.current!.markImagesDirty(); onError(`Could not load image: ${String(reason)}`); } }); } catch (reason) { record.images.splice(record.images.indexOf(item), 1); onError(`Could not load image: ${String(reason)}`); }
  }, [onError]);
  const openBrowser = useCallback((url?: string) => {
    if (!isTauri()) return;
    const id = crypto.randomUUID(); const ordinal = nextOrdinal.current++; const tab: BrowserTab = { kind: 'browser', id, ordinal, title: `${ordinal}. ${url ? new URL(url).hostname : 'Home'}`, status: 'running', page: url ? 'web' : 'home', background: '#18241e', foreground: '#d7f4dc' };
    setTabs((current) => [...current, tab]); setActivePresetState(null); selectSession(id, false);
    if (!url) { setAddressTabId(id); return; }
    void invoke('create_browser', { sessionId: id, url }).then(() => browsers.current.add(id)).catch((reason) => { updateTab(id, (current) => current.kind === 'browser' ? { ...current, status: 'failed', title: `${current.ordinal}. Failed` } : current); onError(`Could not create browser: ${String(reason)}`); });
  }, [onError, selectSession, updateTab]);
  const navigateBrowser = useCallback((id: string, value: string) => {
    const url = /^(?:https?:\/\/|file:\/)/i.test(value.trim()) ? value.trim() : `https://${value.trim()}`;
    try { const parsed = new URL(url); if (!/^(?:https?|file):$/.test(parsed.protocol)) throw new Error('URL must use http, https, or file'); } catch (reason) { onError(`Invalid browser URL: ${String(reason)}`); return; }
    setAddressTabId(null);
    const command = browsers.current.has(id) ? 'navigate_browser' : 'create_browser';
    void invoke(command, { sessionId: id, url }).then(() => { browsers.current.add(id); updateTab(id, (current) => current.kind === 'browser' ? { ...current, page: 'web' as const, status: 'running', title: `${current.ordinal}. ${new URL(url).hostname}` } : current); }).catch((reason) => { updateTab(id, (current) => current.kind === 'browser' ? { ...current, page: 'home' as const, status: 'failed' } : current); onError(`Browser navigation failed: ${String(reason)}`); });
  }, [onError, updateTab]);
  const closeSession = useCallback(async (id: string) => {
    const tab = tabsRef.current.find((item) => item.id === id); const record = sessions.current.get(id);
    if (tab?.kind === 'browser') { const nativeBrowser = browsers.current.delete(id); recentTabs.current = recentTabs.current.filter((item) => item !== id); const next = adjacentTabId(tabsRef.current, id); const remaining = renumberTabs(tabsRef.current.filter((item) => item.id !== id)); let focusTerminal = false; setAddressTabId((current) => current === id ? null : current); nextOrdinal.current = remaining.length + 1; tabsRef.current = remaining; setTabs((current) => renumberTabs(current.filter((item) => item.id !== id))); if (activeRef.current === id) { const targetId = next ?? remaining[0]?.id; if (targetId) { focusTerminal = sessions.current.has(targetId); selectSession(targetId); } else try { await getCurrentWindow().close(); } catch (reason) { onError(`Could not close application: ${String(reason)}`); } } const restoreTerminalFocus = () => { if (focusTerminal) window.requestAnimationFrame(() => outputRef.current?.focus()); }; if (nativeBrowser) void invoke('close_browser', { sessionId: id }).catch((reason) => onError(`Browser close failed: ${String(reason)}`)).finally(restoreTerminalFocus); else restoreTerminalFocus(); return; }
    if (!record || (tab?.status === 'starting' && record.session.live) || closing.current.has(id)) return;
    if (record.preset.dirty && !window.confirm(`Close tab with unsaved preset changes?`)) return;
    closing.current.add(id);
    try {
      await record.session.close();
    } catch (reason) {
      closing.current.delete(id);
      record.tab.status = 'failed';
      updateTab(id, (current) => ({ ...current, status: 'failed' }));
      if (activeRef.current === id) {
        const surviving = tabsRef.current.filter((tab) => tab.id === id || (sessions.current.has(tab.id) && sessions.current.get(tab.id)?.tab.status !== 'failed'));
        const replacementId = adjacentTabId(surviving, id) ?? Array.from(sessions.current.values()).find((r) => r.tab.id !== id && r.session.live)?.tab.id;
        if (replacementId && sessions.current.has(replacementId)) selectSession(replacementId);
      }
      onError(`Terminal close failed: ${String(reason)}`);
      return;
    }
    closing.current.delete(id); record.images.forEach((image) => { image.image.onload = null; image.image.onerror = null; image.image.src = ''; if (image.objectUrl) URL.revokeObjectURL(image.objectUrl); }); sessions.current.delete(id); recentTabs.current = recentTabs.current.filter((item) => item !== id);
    const surviving = tabsRef.current.filter((tab) => tab.id === id || sessions.current.has(tab.id) || tab.kind === 'browser');
    const nextId = adjacentTabId(surviving, id);
    const remaining = renumberTabs(tabsRef.current.filter((tab) => tab.id !== id));
    nextOrdinal.current = remaining.length + 1;
    tabsRef.current = remaining;
    setTabs((current) => renumberTabs(current.filter((tab) => tab.id !== id)));
    if (remaining.length === 0) {
      try { await getCurrentWindow().close(); } catch (reason) { onError(`Could not close application: ${String(reason)}`); }
      return;
    }
    if (activeRef.current === id) {
      const targetId = nextId ?? sessions.current.keys().next().value;
      if (targetId) selectSession(targetId);
    }
  }, [onError, selectSession, updateTab]);
  useEffect(() => { if (!isTauri()) return; void invoke<string[]>('list_monospace_fonts').then((items) => setFonts([...new Set(['Consolas', ...items])])).catch((reason) => onError(`Could not list system fonts: ${String(reason)}`)); }, [onError]);
  useEffect(() => { for (const id of sessions.current.keys()) refreshTabColor(id); }, [refreshTabColor, activePresetState?.settings.crt.colorProfile, activePresetState?.settings.crt.colorMode, activePresetState?.settings.crt.backgroundDesaturation]);
  useEffect(() => {
    if (!ready) return;
    let active = true;
    const activeSessions = sessions.current; const cleanupFrames = colorFrames.current;
    const start = window.setTimeout(() => {
      void invoke<{ kind?: string; command?: string; cwd?: string; url?: string }>('initial_terminal_launch')
        .then((launch) => {
          if (!active) return;
          if (launch?.kind === 'browser' && typeof launch.url === 'string') openBrowser(launch.url); else openSession(launch);
        })
        .catch((reason) => {
          if (!active) return;
          onErrorRef.current(`Could not read startup arguments: ${String(reason)}`);
          openSession();
        });
    });
    return () => {
      active = false;
      window.clearTimeout(start);
      if (pendingSelection.current !== null) window.clearTimeout(pendingSelection.current);
      for (const frame of cleanupFrames.values()) window.cancelAnimationFrame(frame);
      cleanupFrames.clear();
      for (const { session } of activeSessions.values()) void session.close().catch((reason) => onErrorRef.current(`Terminal close failed: ${String(reason)}`));
      activeSessions.clear();
      renderer.current!.dispose();
    };
  }, [openBrowser, openSession, ready]);
  const closingWindow = useRef(false);
  useEffect(() => {
    if (!isTauri()) return;
    const currentWindow = getCurrentWindow() as unknown as { close: () => Promise<void>; onCloseRequested?: (handler: (event: { preventDefault: () => void }) => void | Promise<void>) => Promise<() => void> };
    if (typeof currentWindow.onCloseRequested !== 'function') return;
    let unlisten: (() => void) | undefined;
    void currentWindow.onCloseRequested(async (event) => {
      if (closingWindow.current) return;
      const liveSessions = [...sessions.current.values()].some((record) => record.session.live);
      if (!liveSessions && ![...sessions.current.values()].some((record) => record.preset.dirty)) return;
      event.preventDefault();
      if (liveSessions ? !await invoke<boolean>('confirm_close_with_sessions') : !window.confirm('Close with unsaved preset changes?')) return;
      closingWindow.current = true;
      try {
        await currentWindow.close();
      } catch (reason) {
        closingWindow.current = false;
        onErrorRef.current(`Could not close application: ${String(reason)}`);
      }
    }).then((cleanup) => { unlisten = cleanup; });
    return () => unlisten?.();
  }, []);
  useEffect(() => {
    if (!isTauri() || !ready) return;
    let unlisten: UnlistenFn | undefined;
    void listen<TerminalLaunch>('terminal-launch', (event) => openSession(event.payload)).then((cleanup) => { unlisten = cleanup; }).catch((reason) => onError(`Could not receive terminal launch: ${String(reason)}`));
    return () => unlisten?.();
  }, [onError, openSession, ready]);
  useEffect(() => { let unlisten: UnlistenFn | undefined; void listen<{ sessionId?: string; title?: string }>('browser-title', (event) => { const { sessionId, title } = event.payload ?? {}; if (sessionId && typeof title === 'string') updateTab(sessionId, (tab) => tab.kind === 'browser' ? { ...tab, title: `${tab.ordinal}. ${title || 'New tab'}` } : tab); }).then((cleanup) => { unlisten = cleanup; }).catch((reason) => onError(`Could not receive browser title: ${String(reason)}`)); return () => unlisten?.(); }, [onError, updateTab]);
  useEffect(() => { let unlisten: UnlistenFn | undefined; void listen<{ sessionId?: string; background?: string }>('browser-color', (event) => { const { sessionId, background } = event.payload ?? {}; const color = typeof background === 'string' ? browserTabColor(background) : null; if (sessionId && color) updateTab(sessionId, (tab) => tab.kind === 'browser' ? { ...tab, ...color } : tab); }).then((cleanup) => { unlisten = cleanup; }).catch((reason) => onError(`Could not receive browser color: ${String(reason)}`)); return () => unlisten?.(); }, [onError, updateTab]);
  useEffect(() => { let unlisten: UnlistenFn | undefined; void listen<{ sessionId?: string; code?: string }>('browser-shortcut', (event) => { const { sessionId, code } = event.payload ?? {}; if (sessionId === activeRef.current && typeof code === 'string') { menu.current = true; window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true })); menu.current = false; } }).then((cleanup) => { unlisten = cleanup; }).catch((reason) => onError(`Could not receive browser shortcut: ${String(reason)}`)); return () => unlisten?.(); }, [onError]);
  useEffect(() => { let unlisten: UnlistenFn | undefined; void listen<{ kind?: string; url?: string }>('browser-launch', (event) => { if (event.payload?.kind === 'browser' && typeof event.payload.url === 'string') openBrowser(event.payload.url); }).then((cleanup) => { unlisten = cleanup; }).catch((reason) => onError(`Could not receive browser launch: ${String(reason)}`)); return () => unlisten?.(); }, [onError, openBrowser]);
  const resizeSource = useCallback((output: HTMLCanvasElement) => {
    outputRef.current = output;
    const preset = (activeRef.current ? sessions.current.get(activeRef.current)?.preset.settings : undefined) ?? defaultPresetRef.current;
    const resolution = RESOLUTIONS.find((item) => item.id === preset.resolution) ?? RESOLUTIONS[6];
    renderer.current!.resizeSource(resolution, output);
    const source = renderer.current!.sourceCanvas;
    const session = activeRef.current ? sessions.current.get(activeRef.current)?.session : undefined;
    if (session) session.resize(terminalDimensions(source.width, source.height, preset.crt.consoleFontSize, preset.crt.consoleFont, preset.crt.cellWidthAdjustment, preset.crt.cellHeightAdjustment, preset.crt.fallbackFont));
  }, []);
  const currentPreset = activePresetState?.settings ?? defaultPresetRef.current;
  useEffect(() => {
    if (!isTauri()) return;
    const family = currentPreset.crt.consoleFont;
    const fallbackFont = currentPreset.crt.fallbackFont;
    let cancelled = false;
    const loadFont = (f: string) => canvasFontLoad(f, () => invoke<number[] | null>('load_monospace_font', { family: f }))!;
    const loads: Promise<void>[] = [loadFont(family)];
    if (fallbackFont && fallbackFont !== family) {
      loads.push(loadFont(fallbackFont));
    }
    void Promise.all(loads).then(() => {
      if (cancelled) return;
      renderer.current?.markDirty();
      if (outputRef.current) resizeSource(outputRef.current);
    }).catch((reason) => onError(`Could not load font: ${String(reason)}`));
    return () => { cancelled = true; };
  }, [currentPreset.crt.consoleFont, currentPreset.crt.fallbackFont, onError, resizeSource]);
  useEffect(() => { const output = outputRef.current; if (output) resizeSource(output); }, [resizeSource, currentPreset.resolution, currentPreset.crt.consoleFont, currentPreset.crt.fallbackFont, currentPreset.crt.consoleFontSize, currentPreset.crt.cellWidthAdjustment, currentPreset.crt.cellHeightAdjustment]);
  useEffect(() => {
    renderer.current!.markDirty();
    const session = activeRef.current ? sessions.current.get(activeRef.current)?.session : undefined;
    if (session?.terminal) session.terminal.options.cursorStyle = settingsRef.current.cursorStyle;
  }, [activePresetState?.settings.crt.cursorStyle, activePresetState?.settings.crt.breathing]);
  useEffect(() => {
    const reopenAddress = (event: KeyboardEvent) => {
      const tab = tabsRef.current.find((item) => item.id === activeRef.current && item.kind === 'browser');
      if (!addressTabId && tab && !browsers.current.has(tab.id)) {
        if (event.key === 'F6') {
          event.preventDefault();
          event.stopImmediatePropagation();
          setAddressTabId(tab.id);
          return;
        }
        if (event.code === 'KeyO') {
          const target = event.target instanceof Element ? event.target : (event.target as Node | null)?.parentElement;
          if (
            target &&
            ((target as HTMLElement).isContentEditable ||
              Boolean(target.closest('input, textarea, select, .settings-panel, .terminal-tabs, .new-tab-button, .browser-address')))
          ) {
            return;
          }
          event.preventDefault();
          event.stopImmediatePropagation();
          setAddressTabId(tab.id);
        }
      }
    };
    window.addEventListener('keydown', reopenAddress, true);
    return () => window.removeEventListener('keydown', reopenAddress, true);
  }, [addressTabId]);
  const getKeyboardSession = () =>
    document.activeElement instanceof Element &&
    document.activeElement.closest('.settings-panel, .terminal-tabs, .new-tab-button, .browser-address, .ai-panel')
      ? undefined
      : (activeRef.current ? sessions.current.get(activeRef.current)?.session : undefined);
  useEffect(() => {
    const down = (event: KeyboardEvent) => { if (menu.current && event.code === 'KeyI') { event.preventDefault(); event.stopImmediatePropagation(); if (!event.repeat) void addImage(); } };
    window.addEventListener('keydown', down, true);
    return () => window.removeEventListener('keydown', down, true);
  }, [addImage]);
  useEffect(() => {
    const canvas = () => outputRef.current;
    const point = (event: globalThis.MouseEvent | globalThis.WheelEvent) => { const output = canvas(); return output ? renderer.current!.sourcePointAt(event.clientX, event.clientY, output, settingsRef.current) : null; };
    const hit = (event: globalThis.MouseEvent | globalThis.WheelEvent) => { const p = point(event); return p ? renderer.current!.imageAtSourcePoint(p.x, p.y) : null; };
    const wheel = (event: globalThis.WheelEvent) => {
      if (event.target !== canvas() || !event.deltaY) return;
      const image = hit(event); const p = point(event); if (!image || !p) return;
      const source = renderer.current!.sourceCanvas; const oldWidth = image.width * source.width; const oldHeight = image.height * source.height; const factor = event.deltaY < 0 ? 1.1 : 0.9; const width = Math.max(image.baseWidth * source.width * .1, Math.min(image.baseWidth * source.width * 8, oldWidth * factor)); const height = oldHeight * width / oldWidth; const anchorX = (p.x - image.x * source.width) / oldWidth; const anchorY = (p.y - image.y * source.height) / oldHeight;
      image.width = width / source.width; image.height = height / source.height; image.x = Math.max(0, Math.min(1 - image.width, (p.x - anchorX * width) / source.width)); image.y = Math.max(0, Math.min(1 - image.height, (p.y - anchorY * height) / source.height)); renderer.current!.markImagesDirty(); event.preventDefault(); event.stopImmediatePropagation();
    };
    const down = (event: globalThis.MouseEvent) => {
      if (event.target !== canvas() || event.button !== 0) return;
      const image = hit(event); const p = point(event); const record = activeRef.current ? sessions.current.get(activeRef.current) : undefined; if (!image || !p || !record) return;
      const index = record.images.indexOf(image); if (index >= 0) { record.images.splice(index, 1); record.images.push(image); }
      imageDrag.current = { image, x: p.x / renderer.current!.sourceCanvas.width - image.x, y: p.y / renderer.current!.sourceCanvas.height - image.y }; renderer.current!.markImagesDirty(); event.preventDefault(); event.stopImmediatePropagation();
    };
    const move = (event: globalThis.MouseEvent) => {
      const drag = imageDrag.current; if (!drag) return;
      const output = canvas(); const p = output ? renderer.current!.sourcePointAt(event.clientX, event.clientY, output, settingsRef.current) : null; if (!p) return;
      const source = renderer.current!.sourceCanvas; drag.image.x = Math.max(0, Math.min(1 - drag.image.width, p.x / source.width - drag.x)); drag.image.y = Math.max(0, Math.min(1 - drag.image.height, p.y / source.height - drag.y)); renderer.current!.markImagesDirty(); event.preventDefault(); event.stopImmediatePropagation();
    };
    const up = (event: globalThis.MouseEvent) => { if (!imageDrag.current) return; imageDrag.current = null; event.preventDefault(); event.stopImmediatePropagation(); };
    const context = (event: globalThis.MouseEvent) => { if (event.target !== canvas()) return; const image = hit(event); if (!image) return; event.preventDefault(); event.stopImmediatePropagation(); void showNativeImageMenu({ onDelete: () => removeImage(image) }).catch((reason) => onErrorRef.current(`Could not open image menu: ${String(reason)}`)); };
    window.addEventListener('wheel', wheel, true); window.addEventListener('mousedown', down, true); window.addEventListener('mousemove', move, true); window.addEventListener('mouseup', up, true); window.addEventListener('contextmenu', context, true);
    return () => { window.removeEventListener('wheel', wheel, true); window.removeEventListener('mousedown', down, true); window.removeEventListener('mousemove', move, true); window.removeEventListener('mouseup', up, true); window.removeEventListener('contextmenu', context, true); };
  }, []);
  useEffect(() => {
    const forwardedAlt = forwardedAltRef.current;
    const isAlt = (event: KeyboardEvent) =>
      event.code === 'AltLeft' || event.code === 'AltRight' || event.key === 'AltGraph';
    const isEnter = (event: KeyboardEvent) =>
      event.code === 'Enter' || event.code === 'NumpadEnter' || event.key === 'Enter';
    const isF4 = (event: KeyboardEvent) =>
      event.code === 'F4' || event.key === 'F4';
    const hasAlt = (event: KeyboardEvent) =>
      event.altKey || alt.current || (typeof event.getModifierState === 'function' && (event.getModifierState('Alt') || event.getModifierState('AltGraph')));
    const isAltF4 = (event: KeyboardEvent) =>
      isF4(event) && hasAlt(event) && !event.ctrlKey && !event.shiftKey && !event.metaKey;
    const releaseForwardedAlt = () => {
      for (const { event, session } of forwardedAlt.values()) {
        if (session.live && session.win32InputMode) session.sendInput(win32InputKey(event, false));
      }
      forwardedAlt.clear();
    };
    const down = async (event: KeyboardEvent) => {
      if (isAlt(event)) {
        alt.current = true;
        const session = getKeyboardSession();
        const terminal = session?.terminal;
        if (!session?.live || !terminal) return;
        // Do not defer Alt until keyup: Windows/WebView2 may consume the
        // left-Alt keyup while handling the system menu, leaving console apps
        // with no modifier event at all.
        const input = session.win32InputMode ? win32InputKey(event, true) : terminalKey(event, terminal.modes);
        if (input) {
          session.sendInput(input);
          if (session.win32InputMode) forwardedAlt.set(event.code, { event, session });
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (isEnter(event) && hasAlt(event) && isTauri()) {
        releaseForwardedAlt();
        suppressAlt.current = true;
        fullscreen.current = true;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) try {
          const window = getCurrentWindow();
          await window.setFullscreen(!(await window.isFullscreen()));
        } catch (reason) { onError(`Fullscreen toggle failed: ${String(reason)}`); }
        return;
      }
      if (isAltF4(event)) {
        releaseForwardedAlt();
        suppressAlt.current = true;
        return;
      }
      if (fullscreen.current && isEnter(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const up = (event: KeyboardEvent) => {
      if (isAlt(event)) {
        alt.current = false;
        if (suppressAlt.current) { suppressAlt.current = false; event.preventDefault(); event.stopImmediatePropagation(); return; }
        const targetSession = forwardedAlt.get(event.code)?.session;
        if (!targetSession) return;
        if (targetSession.live && targetSession.win32InputMode) targetSession.sendInput(win32InputKey(event, false));
        forwardedAlt.delete(event.code);
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const blur = () => {
      releaseForwardedAlt();
      alt.current = false;
      fullscreen.current = false;
      pendingAlt.current = [];
      suppressAlt.current = false;
      renderer.current?.setFocused(false);
    };
    const focus = () => {
      if (document.activeElement === outputRef.current) renderer.current?.setFocused(true);
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', blur);
    window.addEventListener('focus', focus);
    return () => { window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); window.removeEventListener('blur', blur); window.removeEventListener('focus', focus); };
  }, [onError]);
  const activeSession = () => activeRef.current ? sessions.current.get(activeRef.current)?.session : undefined;
  const keyboardSession = useCallback(() => document.activeElement instanceof Element && document.activeElement.closest('.ai-panel') ? undefined : activeSession(), []);
  const cell = (event: MouseEvent<HTMLCanvasElement> | WheelEvent<HTMLCanvasElement>) => renderer.current!.cellAtPoint(event.clientX, event.clientY, event.currentTarget, settingsRef.current);
  const imagePoint = (event: MouseEvent<HTMLCanvasElement> | WheelEvent<HTMLCanvasElement>) => renderer.current!.sourcePointAt(event.clientX, event.clientY, event.currentTarget, settingsRef.current);
  const imageAt = (event: MouseEvent<HTMLCanvasElement> | WheelEvent<HTMLCanvasElement>) => { const point = imagePoint(event); return point ? renderer.current!.imageAtSourcePoint(point.x, point.y) : null; };
  const removeImage = (image: TerminalImage) => { const record = activeRef.current ? sessions.current.get(activeRef.current) : undefined; if (!record) return; const index = record.images.indexOf(image); if (index >= 0) { record.images.splice(index, 1); image.image.onload = null; image.image.onerror = null; image.image.src = ''; if (image.objectUrl) URL.revokeObjectURL(image.objectUrl); renderer.current!.markImagesDirty(); } };
  const copyPoint = (point: { col: number; row: number }): CopyPoint => { const terminal = activeSession()?.terminal; if (!terminal) return { row: 0, column: 0 }; return { row: Math.max(terminal.buffer.active.viewportY, terminal.buffer.active.viewportY + point.row - 1), column: Math.max(0, point.col - 1) }; };
  const sendMouse = (event: MouseEvent<HTMLCanvasElement> | WheelEvent<HTMLCanvasElement>, action: Parameters<typeof terminalMouse>[0]['action'], button?: 0 | 1 | 2) => { const session = activeSession(); const terminal = session?.terminal; const tracking = terminal?.modes.mouseTrackingMode as MouseTrackingMode | undefined; if (!session || !terminal || !tracking || tracking === 'none' || (tracking === 'x10' && (action !== 'press' || event.ctrlKey || event.altKey || event.shiftKey)) || (tracking === 'vt200' && action === 'move')) return false; const point = cell(event); if (!point) return false; event.preventDefault(); session.sendInput(terminalMouse({ ...point, action, button, sgr: session.sgrMouseMode, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey })); return true; };
  const copy = async (start: CopyPoint, end: CopyPoint) => { const terminal = activeSession()?.terminal; if (!terminal) return; const [first,last] = start.row < end.row || start.row === end.row && start.column <= end.column ? [start,end] : [end,start]; const text = Array.from({ length: last.row - first.row + 1 }, (_, index) => { const row = first.row + index; return terminal.buffer.active.getLine(row)?.translateToString(index === last.row - first.row, row === first.row ? first.column : 0, row === last.row ? last.column + 1 : terminal.cols) ?? ''; }).join('\r\n').replace(/(?:\r\n|\r|\n)$/, ''); if (text) await navigator.clipboard.writeText(text); };
  const openNativeContextMenu = (event: MouseEvent<HTMLCanvasElement>) => { event.preventDefault(); if (!isTauri()) return; const image = imageAt(event); if (image) { void showNativeImageMenu({ onDelete: () => removeImage(image) }).catch((reason) => onError(`Could not open image menu: ${String(reason)}`)); return; } void showNativeNewTabMenu({ onNew: () => openSession(), onNewBrowser: () => openBrowser(), onNewShell: (command) => openSession({ command }), shells }).catch((reason) => onError(`Could not open terminal context menu: ${String(reason)}`)); };
  useEffect(() => { const down = async (event: KeyboardEvent) => { if (event.code === 'AltLeft' || event.code === 'AltRight' || event.key === 'AltGraph') alt.current = true; if ((event.code === 'F4' || event.key === 'F4') && (event.altKey || alt.current || (typeof event.getModifierState === 'function' && (event.getModifierState('Alt') || event.getModifierState('AltGraph')))) && !event.ctrlKey && !event.shiftKey && !event.metaKey) return; if (event.key === 'ContextMenu') { menu.current = true; menuShortcut.current = false; menuEvent.current = event; event.preventDefault(); return; } if (menu.current && event.code !== 'ContextMenu') menuShortcut.current = true; if (menu.current && event.code === 'KeyW') { event.preventDefault(); if (!event.repeat && activeRef.current) void closeSession(activeRef.current); return; } if (event.target instanceof Element && event.target.closest('.settings-panel, .terminal-tabs, .new-tab-button, .browser-address')) return; const session = keyboardSession(); const terminal = session?.terminal; if (menu.current && event.code === 'KeyS') { event.preventDefault(); if (!event.repeat) onToggleSettings(); return; } if (menu.current && event.code === 'KeyA') { event.preventDefault(); if (!event.repeat) onToggleAi?.(); return; } if (menu.current && event.code === 'KeyB') { event.preventDefault(); if (!event.repeat) openBrowser(); return; } if (menu.current && event.code === 'KeyV') { event.preventDefault(); if (!event.repeat) navigator.clipboard.readText().then((input) => session?.sendInput(input)).catch((reason) => onError(`Clipboard paste failed: ${String(reason)}`)); return; } if (menu.current && event.code === 'KeyC') { event.preventDefault(); if (!event.repeat) copyMode.current = true; return; } if (menu.current && event.code === 'KeyN') { event.preventDefault(); if (!event.repeat) openSession(); return; } if (menu.current && event.code === 'Quote') { event.preventDefault(); if (!event.repeat) { const aiComposer = document.querySelector('.ai-composer textarea') as HTMLTextAreaElement | null; if (document.activeElement?.closest('.ai-panel') || document.activeElement === aiComposer) { const canvas = document.querySelector('.terminal-workspace canvas') as HTMLCanvasElement | null; canvas?.focus(); } else { if (aiComposer) aiComposer.focus(); else onToggleAi?.(); } } return; } if (menu.current && /^Digit[1-9]$/.test(event.code)) { event.preventDefault(); if (!event.repeat) { const id = tabIdAtOrdinal(tabsRef.current, Number(event.code.at(-1))); if (id) selectSession(id); } return; } if (menu.current && (event.code === 'ArrowRight' || event.code === 'Period' || event.key === '>')) { event.preventDefault(); if (!event.repeat && activeRef.current) { const id = nextTabId(tabsRef.current, activeRef.current); if (id) selectSession(id); } return; } if (menu.current && (event.code === 'ArrowLeft' || event.code === 'Comma' || event.key === '<')) { event.preventDefault(); if (!event.repeat && activeRef.current) { const id = previousTabId(tabsRef.current, activeRef.current); if (id) selectSession(id); } return; } if (menu.current && (event.code === 'Tab' || event.key === 'Tab')) { event.preventDefault(); if (!event.repeat && activeRef.current) { const id = previousActiveTabId(tabsRef.current, recentTabs.current, activeRef.current); if (id) selectSession(id); } return; } if (menu.current && (event.code === 'PageUp' || event.code === 'PageDown')) { event.preventDefault(); if (terminal && terminal.buffer.active === terminal.buffer.normal) terminal.scrollLines((event.code === 'PageUp' ? -1 : 1) * (terminal.rows - 1)); return; } if (menu.current && (event.code === 'KeyJ' || event.code === 'KeyK')) { event.preventDefault(); const isUp = event.code === 'KeyK'; if (document.activeElement?.closest('.ai-panel')) { const aiMessages = document.querySelector('.ai-messages'); if (aiMessages) aiMessages.scrollBy(0, (isUp ? -1 : 1) * aiMessages.clientHeight * 0.8); } else if (terminal && terminal.buffer.active === terminal.buffer.normal) { terminal.scrollLines((isUp ? -1 : 1) * (terminal.rows - 1)); } return; } if ((event.altKey || alt.current || (typeof event.getModifierState === 'function' && (event.getModifierState('Alt') || event.getModifierState('AltGraph')))) && (event.code === 'Enter' || event.code === 'NumpadEnter' || event.key === 'Enter') && isTauri()) { event.preventDefault(); fullscreen.current = true; if (!event.repeat) try { const window = getCurrentWindow(); await window.setFullscreen(!(await window.isFullscreen())); } catch (reason) { onError(`Fullscreen toggle failed: ${String(reason)}`); } return; } if (!session?.live || !terminal) return; const input = session.win32InputMode ? win32InputKey(event, true) : terminalKey(event, terminal.modes); event.preventDefault(); if (input) { terminal.scrollToBottom(); session.sendInput(input); } }; const up = (event: KeyboardEvent) => { if (event.code === 'AltLeft' || event.code === 'AltRight' || event.key === 'AltGraph') alt.current = false; if ((event.code === 'F4' || event.key === 'F4') && (event.altKey || alt.current || (typeof event.getModifierState === 'function' && (event.getModifierState('Alt') || event.getModifierState('AltGraph')))) && !event.ctrlKey && !event.shiftKey && !event.metaKey) return; if (event.key === 'ContextMenu') { const source = menuEvent.current; const standalone = !menuShortcut.current; menu.current = false; menuEvent.current = null; event.preventDefault(); if (standalone && source && !(event.target instanceof Element && event.target.closest('.settings-panel, .terminal-tabs, .new-tab-button, .browser-address'))) { const session = keyboardSession(); if (session?.live && session.win32InputMode) { session.sendInput(win32InputKey(source, true)); session.sendInput(win32InputKey(event, false)); } } return; } if (event.target instanceof Element && event.target.closest('.settings-panel, .terminal-tabs, .new-tab-button, .browser-address')) return; if (fullscreen.current && (event.code === 'Enter' || event.code === 'NumpadEnter')) { fullscreen.current = false; event.preventDefault(); return; } const session = keyboardSession(); if (!session?.live || !session.terminal) return; event.preventDefault(); if (session.win32InputMode) session.sendInput(win32InputKey(event, false)); }; const clearAlt = () => { alt.current = false; fullscreen.current = false; menu.current = false; menuEvent.current = null; menuShortcut.current = false; renderer.current?.setFocused(false); }; window.addEventListener('keydown', down, true); window.addEventListener('keyup', up, true); window.addEventListener('blur', clearAlt); return () => { window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); window.removeEventListener('blur', clearAlt); }; }, [closeSession, keyboardSession, onError, onToggleAi, onToggleSettings, openBrowser, openSession, selectSession]);
  return { renderer: renderer.current, live, size, fonts, tabs, activeTabId, activeSessionId: sessions.current.has(activeTabId ?? '') ? activeTabId : null, activePreset: activePresetState?.settings ?? defaultPresetRef.current, activePresetState, updateActivePreset, replaceActivePreset, markActivePresetSaved, addressTabId, openAddress: (id: string) => setAddressTabId(id), closeAddress: () => setAddressTabId(null), navigateBrowser, openSession, openBrowser, selectSession, closeSession, resizeSource, canvasProps: { onFocus: () => renderer.current?.setFocused(true), onBlur: () => renderer.current?.setFocused(false), onWheel: (event: WheelEvent<HTMLCanvasElement>) => { const terminal = activeSession()?.terminal; if (!terminal || event.deltaY === 0) return; if (sendMouse(event, event.deltaY < 0 ? 'wheel-up' : 'wheel-down')) return; event.preventDefault(); if (terminal.buffer.active === terminal.buffer.normal) { const from = terminal.buffer.active.viewportY; terminal.scrollLines(Math.sign(event.deltaY) * 3); const to = terminal.buffer.active.viewportY; if (smoothScrollbackRef.current) renderer.current?.beginScroll(from, to); } }, onMouseDown: (event: MouseEvent<HTMLCanvasElement>) => { event.currentTarget.focus(); renderer.current?.cancelScroll(); const terminal = activeSession()?.terminal; if (terminal && ((copyMode.current && event.button === 0) || event.button === 1)) { const point = cell(event); if (point) { event.preventDefault(); copyStart.current = copyPoint(point); renderer.current!.setSelection({ start: copyStart.current, end: copyStart.current }); } return; } if (event.button <= 2 && sendMouse(event, 'press', event.button as 0|1|2)) pressed.current.add(event.button); }, onMouseMove: (event: MouseEvent<HTMLCanvasElement>) => { const terminal = activeSession()?.terminal; if (terminal && copyStart.current && event.buttons) { const point = cell(event); if (point) renderer.current!.setSelection({ start: copyStart.current, end: copyPoint(point) }); return; } const tracking = terminal?.modes.mouseTrackingMode as MouseTrackingMode | undefined; if (tracking && tracking !== 'none' && !(tracking === 'drag' && pressed.current.size === 0) && tracking !== 'x10' && tracking !== 'vt200') sendMouse(event, 'move', pressed.current.values().next().value as 0|1|2|undefined); }, onMouseUp: (event: MouseEvent<HTMLCanvasElement>) => { const terminal = activeSession()?.terminal; if (terminal && copyStart.current) { const start = copyStart.current; copyStart.current = null; copyMode.current = false; const point = cell(event); if (point) void copy(start, copyPoint(point)).catch((reason) => onError(`Clipboard copy failed: ${String(reason)}`)); renderer.current!.setSelection(null); return; } if (event.button <= 2) { sendMouse(event, 'release', event.button as 0|1|2); pressed.current.delete(event.button); } }, onMouseLeave: (event: MouseEvent<HTMLCanvasElement>) => { for (const button of pressed.current) sendMouse(event, 'release', button as 0|1|2); pressed.current.clear(); }, onContextMenu: openNativeContextMenu, onPaste: (event: ClipboardEvent<HTMLCanvasElement>) => { const input = event.clipboardData.getData('text'); if (!input) return; event.preventDefault(); renderer.current?.cancelScroll(); activeSession()?.terminal?.scrollToBottom(); activeSession()?.sendInput(input); } } };
}
