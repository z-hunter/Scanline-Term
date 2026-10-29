import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type MouseEvent, type WheelEvent } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import { open as openFile } from '@tauri-apps/plugin-dialog';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { RESOLUTIONS } from '../crt/settings';
import type { CRTSettings } from 'scanline-virtual-screen/core';
import { canvasFontLoad, fontCellSize, TerminalRenderer, terminalAverageColor, terminalDimensions, type CopyPoint, type TabColor, type TerminalImage } from './ScanlineTerminalRenderer';
import { TerminalSession, initialProfile, scrollToBottomOnKey, type TerminalLaunch, type TerminalOutputScroll, type TerminalSize } from './TerminalSession';
import { terminalKey } from './terminal-input';
import { terminalMouse, type MouseTrackingMode } from './terminal-mouse';
import { win32InputKey } from '../win32-input';
import { TerminalAutomationProbe } from './automation-probe';
import { LuaAutomationCoordinator, type CapsPolicyLease, type LuaAutomationSnapshot, type LuaPresetRequest } from './lua-automation';
import { CapsFrameDecoder } from './caps-frame';
import { emptyTapHoldState, forwardedKeyIdentity, updateTapHold, type TapHoldClassification, type TapHoldState } from './automation-probe-state';
import { findTerminalMatches, nextSearchIndex, type TerminalSearchMatch } from './terminal-search';
import { showNativeImageMenu, showNativeTerminalMenu } from '../ui/nativeNewTabMenu';
import { clonePresetSettings, DEFAULT_PRESET_SETTINGS, loadPresetSettings, warnIfMissingColorProfile, type PresetSettings, type TabPresetState } from '../crt/settings';
import type { ScrollbackScrollbarState } from '../ui/ScrollbackScrollbar';

export type TerminalTab = { kind?: 'terminal'; id: string; ordinal: number; title: string; status: 'starting' | 'running' | 'exited' | 'failed' } & TabColor;
export type BrowserTab = { kind: 'browser'; id: string; ordinal: number; title: string; status: 'starting' | 'running' | 'failed'; page: 'home' | 'web' } & TabColor;
export type WorkspaceTab = TerminalTab | BrowserTab;
export type ShellInfo = { name: string; command: string };
type SessionRecord = { tab: TerminalTab; session: TerminalSession; ownerId: string | null; inputLocked: boolean; preset: TabPresetState; images: TerminalImage[] };
export type OwnedTerminalInfo = { sessionId: string; title: string; status: TerminalTab['status']; processName: string | null; size: TerminalSize };
export type TerminalSearchState = { open: boolean; query: string; matches: TerminalSearchMatch[]; activeIndex: number; buffer: 'normal' | 'alternate' | null; direction: 1 | -1 };
type Resolution = (typeof RESOLUTIONS)[number];

// Set true temporarily when investigating terminal geometry regressions.
export const TERMINAL_GEOMETRY_DIAGNOSTICS = false;

function elementBounds(element: Element | null): Record<string, number> | null {
  if (!element) return null;
  const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
  return { left, top, right, bottom, width, height };
}

function outputRasterSize(output: HTMLCanvasElement): { width: number; height: number } {
  const { width, height } = output.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
  return { width: Math.max(1, Math.round(width * dpr) || output.width || 1), height: Math.max(1, Math.round(height * dpr) || output.height || 1) };
}

function physicalSourceSize(output: { width: number; height: number }, settings: CRTSettings): { width: number; height: number } {
  const inset = settings.crtEmulation ? Math.max(0, Math.round(settings.bezelThickness ?? 0)) : 0;
  return { width: Math.max(1, output.width - inset * 2), height: Math.max(1, output.height - inset * 2) };
}

function displaySettings(settings: CRTSettings, resolutionId: string): CRTSettings {
  return resolutionId.startsWith('physical')
    ? { ...settings, consoleFontSize: settings.consoleFontSize * (window.devicePixelRatio || 1) }
    : settings;
}

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

export function reorderTabs(tabs: WorkspaceTab[], id: string, targetIndex: number): WorkspaceTab[] {
  const sourceIndex = tabs.findIndex((tab) => tab.id === id);
  if (sourceIndex < 0 || tabs.length < 2) return tabs;
  const index = Math.max(0, Math.min(tabs.length - 1, targetIndex));
  if (sourceIndex === index) return tabs;
  const next = tabs.slice();
  const [tab] = next.splice(sourceIndex, 1);
  next.splice(index, 0, tab);
  return renumberTabs(next);
}

function trimLinkEnd(url: string): string {
  const opening: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  let end = url.length;
  while (end > 0) {
    const last = url[end - 1];
    if (/[.,;:!?']/.test(last)) { end -= 1; continue; }
    const open = opening[last];
    if (!open || url.slice(0, end).split(last).length - 1 <= url.slice(0, end).split(open).length - 1) break;
    end -= 1;
  }
  return url.slice(0, end);
}

export function linkAt(text: string, column: number): { url: string; start: number; end: number } | null {
  for (const match of text.matchAll(/https?:\/\/[A-Za-z0-9._~:/?#\x5b\x5d@!$&'()*+,;=%-]+/gi)) {
    const start = match.index ?? 0; const url = trimLinkEnd(match[0]);
    try { if (column >= start && column < start + url.length && /^https?:$/.test(new URL(url).protocol)) return { url, start, end: start + url.length - 1 }; } catch { /* Ignore malformed URL-like text. */ }
  }
  return null;
}

type LinkLine = { length: number; translateToString: () => string; getCell: (column: number) => { getChars: () => string } | undefined };

export function linkAtLine(line: LinkLine, column: number): { url: string; start: number; end: number } | null {
  const text = line.translateToString();
  const cellWidth = (index: number) => line.getCell(index)?.getChars().length || 1;
  let textOffset = 0;
  for (let index = 0; index < column; index += 1) textOffset += cellWidth(index);
  const link = linkAt(text, textOffset);
  if (!link) return null;
  const cellColumn = (offset: number) => {
    let current = 0;
    for (let index = 0; index < line.length; index += 1) {
      const length = cellWidth(index);
      if (offset < current + length) return index;
      current += length;
    }
    return Math.max(0, line.length - 1);
  };
  return { url: link.url, start: cellColumn(link.start), end: cellColumn(link.end) };
}

export function useTerminal({ defaultPreset, defaultPresetName = 'default', ready = true, settings, resolution, defaultShell = '', smoothScrollback = false, smoothTuiScrolling = true, rmbMenuInTerm = true, channelSwitchEffect = true, galleryOpen = false, presetPickerOpen = false, shells = [], onError, onToggleSettings, onToggleAi, onToggleGallery, onTogglePresetPicker, onToggleTabsBar, onBeforeTabChange, onTerminalTabTransition }: { defaultPreset?: PresetSettings; defaultPresetName?: string; ready?: boolean; settings?: CRTSettings; resolution?: Resolution; defaultShell?: string; smoothScrollback?: boolean; smoothTuiScrolling?: boolean; rmbMenuInTerm?: boolean; channelSwitchEffect?: boolean; galleryOpen?: boolean; presetPickerOpen?: boolean; shells?: ShellInfo[]; onError: (message: string) => void; onToggleSettings: () => void; onToggleAi?: () => void; onToggleGallery?: () => void; onTogglePresetPicker?: () => void; onToggleTabsBar?: () => void; onBeforeTabChange?: (id: string) => void; onTerminalTabTransition?: (incoming: boolean) => void }) {
  const initialPreset: PresetSettings = defaultPreset ?? { version: 1, resolution: (resolution?.id ?? DEFAULT_PRESET_SETTINGS.resolution) as PresetSettings['resolution'], crt: { ...(settings ?? DEFAULT_PRESET_SETTINGS.crt) } };
  const [live, setLive] = useState(false); const [size, setSize] = useState<TerminalSize>({ cols: 0, rows: 0 }); const [fonts, setFonts] = useState(['Consolas']); const [tabs, setTabs] = useState<WorkspaceTab[]>([]); const [activeTabId, setActiveTabId] = useState<string | null>(null); const [addressTabId, setAddressTabId] = useState<string | null>(null);
  const [activePresetState, setActivePresetState] = useState<TabPresetState | null>(null); const [cursorStyleOverridden, setCursorStyleOverridden] = useState(false); const [scrollback, setScrollback] = useState<ScrollbackScrollbarState | null>(null); const [search, setSearch] = useState<TerminalSearchState>({ open: false, query: '', matches: [], activeIndex: -1, buffer: null, direction: 1 });
  const renderer = useRef<TerminalRenderer | null>(null); if (!renderer.current) renderer.current = new TerminalRenderer();
  const automationProbe = useRef<TerminalAutomationProbe | null>(null);
  const luaAutomation = useRef<LuaAutomationCoordinator | null>(null);
  const capsPolicy = useRef<CapsPolicyLease | null>(null);
  const capsFrameDecoder = useRef(new CapsFrameDecoder());
  const capsFrameTimer = useRef<number | null>(null);
  const capsInputRevision = useRef(0);
  const probeSnapshot = useRef<{ enabled: boolean; status: unknown; context: { tabId: string | null; generation: number; focused: boolean } | null; trace: Record<string, unknown>[] }>({ enabled: false, status: null, context: null, trace: [] });
  const probeSuppressedTokenUp = useRef(false);
  const tapHold = useRef<TapHoldState>(emptyTapHoldState()); const tapHoldTimer = useRef<number | null>(null); const probeForwardedKeys = useRef(new Map<string, { event: KeyboardEvent; session: TerminalSession }>());
  const tapHoldSession = useRef<TerminalSession | null>(null);
  const geometryDiagnostics = useRef<Record<string, unknown>[]>([]);
  const defaultPresetRef = useRef(initialPreset); const defaultPresetNameRef = useRef(defaultPresetName); const settingsRef = useRef(initialPreset.crt); const defaultShellRef = useRef(defaultShell); const smoothScrollbackRef = useRef(smoothScrollback); const rmbMenuInTermRef = useRef(rmbMenuInTerm); const channelSwitchEffectRef = useRef(channelSwitchEffect); const outputRef = useRef<HTMLCanvasElement | null>(null); const sessions = useRef(new Map<string, SessionRecord>()); const browsers = useRef(new Set<string>()); const tabsRef = useRef<WorkspaceTab[]>([]); const activeRef = useRef<string | null>(null); const recentTabs = useRef<string[]>([]); const nextOrdinal = useRef(1); const colorFrames = useRef(new Map<string, number>()); const pressed = useRef(new Set<number>()); const copyStart = useRef<CopyPoint | null>(null); const linkClick = useRef<{ url: string; selection: { start: CopyPoint; end: CopyPoint } } | null>(null); const copyMode = useRef(false); const imageDrag = useRef<{ image: TerminalImage; x: number; y: number } | null>(null); const menu = useRef(false); const menuEvent = useRef<KeyboardEvent | null>(null); const menuShortcut = useRef(false); const fullscreen = useRef(false); const suppressAlt = useRef(false); const pendingAlt = useRef<KeyboardEvent[]>([]); const forwardedAltRef = useRef(new Map<string, { event: KeyboardEvent; session: TerminalSession }>()); const alt = useRef(false); const closing = useRef(new Set<string>()); const onErrorRef = useRef(onError); const onTerminalTabTransitionRef = useRef(onTerminalTabTransition); const pendingSelection = useRef<number | null>(null); const pendingFirstDraw = useRef<string | null>(null); const scrollbackActivity = useRef(0); const scrollbackRef = useRef<ScrollbackScrollbarState | null>(null); const scrollIntentRef = useRef(false);
  const searchRef = useRef(search); searchRef.current = search;
  const galleryOpenRef = useRef(galleryOpen); galleryOpenRef.current = galleryOpen;
  const presetPickerOpenRef = useRef(presetPickerOpen); presetPickerOpenRef.current = presetPickerOpen;
  const onBeforeTabChangeRef = useRef(onBeforeTabChange); onBeforeTabChangeRef.current = onBeforeTabChange;
  defaultPresetRef.current = initialPreset; defaultPresetNameRef.current = defaultPresetName; channelSwitchEffectRef.current = channelSwitchEffect; settingsRef.current = { ...displaySettings(activePresetState?.settings.crt ?? initialPreset.crt, activePresetState?.settings.resolution ?? initialPreset.resolution), channelSwitchEffect }; defaultShellRef.current = defaultShell; smoothScrollbackRef.current = smoothScrollback; rmbMenuInTermRef.current = rmbMenuInTerm; renderer.current.setTuiScrollingEnabled(smoothScrollback && smoothTuiScrolling); tabsRef.current = tabs; activeRef.current = activeTabId; onErrorRef.current = onError; onTerminalTabTransitionRef.current = onTerminalTabTransition;
  const traceAutomationProbe = useCallback((kind: string, details: Record<string, unknown> = {}) => {
    if (!import.meta.env.DEV || !automationProbe.current?.enabled) return;
    const entry = { at: performance.now(), kind, tabId: activeRef.current, ...details };
    probeSnapshot.current.trace.push(entry);
    if (probeSnapshot.current.trace.length > 256) probeSnapshot.current.trace.splice(0, probeSnapshot.current.trace.length - 256);
  }, []);
  const luaAutomationSnapshot = useCallback((): LuaAutomationSnapshot => {
    const activeId = activeRef.current;
    const active = activeId ? sessions.current.get(activeId) : undefined;
    const liveActive = active?.session.live ? active : undefined;
    const focused = Boolean(liveActive && document.hasFocus() && document.activeElement === outputRef.current);
    return {
      activeTabId: liveActive ? activeId : null,
      focused,
      tabs: Array.from(sessions.current.values()).filter(({ session }) => session.live).map(({ tab, session, preset }) => ({
        id: session.id,
        title: tab.title.replace(/^\d+\.\s*/, ''),
        processName: session.localProcessName,
        presetName: preset.name,
        cursor: session.applicationCursorState,
      })),
    };
  }, []);
  if (import.meta.env.DEV && !automationProbe.current) automationProbe.current = new TerminalAutomationProbe((status) => {
    probeSnapshot.current.enabled = status.enabled;
    probeSnapshot.current.status = status;
    probeSnapshot.current.context = automationProbe.current?.currentContext ?? null;
    const target = window as Window & { __scanlineAutomationProbe?: typeof probeSnapshot.current };
    if (status.enabled && import.meta.env.DEV) target.__scanlineAutomationProbe = probeSnapshot.current;
    else delete target.__scanlineAutomationProbe;
  }, (message) => { traceAutomationProbe('layout-error', { message }); onErrorRef.current(message); });
  const updateTab = useCallback((id: string, update: (tab: WorkspaceTab) => WorkspaceTab) => setTabs((current) => current.map((tab) => tab.id === id ? update(tab) : tab)), []);
  const moveTab = useCallback((id: string, targetIndex: number) => {
    setTabs((current) => {
      const next = reorderTabs(current, id, targetIndex);
      tabsRef.current = next;
      return next;
    });
  }, []);
  const recordGeometry = useCallback((event: string, details: Record<string, unknown> = {}) => {
    if (!TERMINAL_GEOMETRY_DIAGNOSTICS) return;
    const workspace = document.querySelector('.terminal-workspace'); const frame = document.querySelector('#terminal-display'); const tabs = document.querySelector('.terminal-tabs'); const style = workspace ? getComputedStyle(workspace) : null;
    geometryDiagnostics.current.push({ at: new Date().toISOString(), event, ...details, layoutSnapshot: { workspace: elementBounds(workspace), frame: elementBounds(frame), tabs: elementBounds(tabs), variables: { screenRatio: style?.getPropertyValue('--screen-ratio'), workspaceScreenHeight: style?.getPropertyValue('--workspace-screen-height'), terminalScreenWidth: style?.getPropertyValue('--terminal-screen-width'), terminalScreenHeight: style?.getPropertyValue('--terminal-screen-height') } } });
    if (geometryDiagnostics.current.length > 200) geometryDiagnostics.current.shift();
  }, []);
  const publishScrollback = useCallback((id: string, terminal: TerminalSession['terminal'], userInitiated: boolean, viewportY?: number) => {
    const buffer = terminal?.buffer.active;
    if (!terminal || !buffer || buffer !== terminal.buffer.normal || buffer.baseY <= 0) {
      if (userInitiated || scrollbackRef.current?.sessionId === id) { scrollbackRef.current = null; setScrollback(null); }
      return;
    }
    if (!userInitiated && !scrollbackRef.current) return;
    if (userInitiated) scrollbackActivity.current += 1;
    const next = { sessionId: id, viewportY: Math.max(0, Math.min(buffer.baseY, viewportY ?? buffer.viewportY)), baseY: buffer.baseY, rows: terminal.rows, activity: scrollbackActivity.current };
    scrollbackRef.current = next;
    setScrollback(next);
  }, []);
  const clearSearch = useCallback(() => {
    searchRef.current = { open: false, query: '', matches: [], activeIndex: -1, buffer: null, direction: 1 };
    setSearch(searchRef.current);
    renderer.current?.setTextHighlights([]);
  }, []);
  const applySearch = useCallback((query: string, activeIndex = 0, direction: 1 | -1 = searchRef.current.direction) => {
    const id = activeRef.current;
    const record = id ? sessions.current.get(id) : undefined;
    const terminal = record?.session.terminal;
    if (!id || !record || !terminal) return;
    const snapshot = findTerminalMatches(terminal, query);
    const nextIndex = snapshot.matches.length ? Math.max(0, Math.min(snapshot.matches.length - 1, activeIndex)) : -1;
    const next = { open: true, query, matches: snapshot.matches, activeIndex: nextIndex, buffer: snapshot.buffer, direction } satisfies TerminalSearchState;
    searchRef.current = next;
    setSearch(next);
    renderer.current?.cancelScroll();
    renderer.current?.setTextHighlights(snapshot.matches, nextIndex);
    const match = nextIndex >= 0 ? snapshot.matches[nextIndex] : undefined;
    if (match && snapshot.buffer === 'normal') {
      terminal.scrollToLine(match.line);
      const to = terminal.buffer.active.viewportY;
      publishScrollback(id, terminal, true, to);
    }
  }, [publishScrollback]);
  const probeSuppressedKeyUps = useRef(new Set<string>());
  const refreshAutomationProbeContext = useCallback(() => {
    if (!import.meta.env.DEV) return;
    const id = activeRef.current;
    automationProbe.current?.setContext(id && sessions.current.has(id) ? id : null, Boolean(document.hasFocus() && outputRef.current && document.activeElement === outputRef.current));
    probeSnapshot.current.context = automationProbe.current?.currentContext ?? null;
  }, []);
  const cancelAutomationProbeInput = useCallback((reason: string) => {
    if (tapHoldTimer.current !== null) window.clearTimeout(tapHoldTimer.current);
    tapHoldTimer.current = null;
    if (capsFrameTimer.current !== null) window.clearTimeout(capsFrameTimer.current);
    capsFrameTimer.current = null;
    capsFrameDecoder.current.reset();
    capsInputRevision.current += 1;
    const wasActive = tapHold.current.downAt !== null || probeForwardedKeys.current.size > 0;
    if (tapHold.current.downAt !== null) probeSuppressedTokenUp.current = true;
    tapHold.current = updateTapHold(tapHold.current, 'cancel', performance.now(), 180).state;
    tapHoldSession.current = null;
    if (wasActive && import.meta.env.DEV) traceAutomationProbe('token-cancel', { reason });
    for (const [code, forwarded] of probeForwardedKeys.current) {
      if (forwarded.session.live && forwarded.session.win32InputMode) {
        forwarded.session.sendInput(win32InputKey(forwarded.event, false));
        if (import.meta.env.DEV) traceAutomationProbe('win32-keyup', { code, reason, key: forwarded.event.key });
      }
      probeSuppressedKeyUps.current.add(code);
    }
    probeForwardedKeys.current.clear();
  }, [traceAutomationProbe]);
  const openSearch = useCallback((direction: 1 | -1) => {
    const id = activeRef.current;
    const record = id ? sessions.current.get(id) : undefined;
    if (!id || !record || !record.session.terminal) return;
    applySearch('', 0, direction);
    window.requestAnimationFrame(() => (document.querySelector('.terminal-search-input') as HTMLInputElement | null)?.focus());
  }, [applySearch]);
  const moveSearch = useCallback((direction: 1 | -1) => {
    const current = searchRef.current;
    if (!current.open || !current.matches.length) return;
    applySearch(current.query, nextSearchIndex(current.activeIndex, current.matches.length, direction), current.direction);
  }, [applySearch]);
  const scrollToLine = useCallback((line: number, smooth = false) => {
    const session = activeRef.current ? sessions.current.get(activeRef.current)?.session : undefined;
    const terminal = session?.terminal;
    if (!session || !terminal || terminal.buffer.active !== terminal.buffer.normal) return;
    const from = terminal.buffer.active.viewportY;
    terminal.scrollToLine(line);
    const to = terminal.buffer.active.viewportY;
    if (smooth && smoothScrollbackRef.current) renderer.current?.beginBufferScroll(from, to);
    else renderer.current?.cancelScroll();
    publishScrollback(session.id, terminal, true, to);
  }, [publishScrollback]);
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
  const refreshColorProfiles = useCallback(() => {
    for (const [id, record] of sessions.current) {
      record.session.setColorProfile(initialProfile(record.preset.settings.crt.colorProfile));
      warnIfMissingColorProfile(record.preset.settings.crt.colorProfile, onError);
      refreshTabColor(id);
    }
    renderer.current?.cancelScroll();
    renderer.current?.markDirty();
  }, [onError, refreshTabColor]);
  const selectSession = useCallback((id: string, animate = true, capturePrevious = true) => {
    if (pendingSelection.current !== null) {
      window.clearTimeout(pendingSelection.current);
      pendingSelection.current = null;
    }
    if (id === activeRef.current) return;
    if (capturePrevious && !galleryOpenRef.current && activeRef.current) onBeforeTabChangeRef.current?.(activeRef.current);
    const record = sessions.current.get(id);
    if (animate && record && sessions.current.has(activeRef.current ?? '') && channelSwitchEffectRef.current && onTerminalTabTransitionRef.current) {
      onTerminalTabTransitionRef.current(false);
      pendingSelection.current = window.setTimeout(() => {
        pendingSelection.current = null;
        onTerminalTabTransitionRef.current?.(true);
        selectSession(id, false, false);
      }, 150);
      return;
    }
    sessions.current.get(activeRef.current ?? '')?.session.setTerminalFocused(false);
    cancelAutomationProbeInput('tab-change');
    recentTabs.current = [id, ...recentTabs.current.filter((item) => item !== id)];
    activeRef.current = id; refreshAutomationProbeContext(); pendingFirstDraw.current = record && TERMINAL_GEOMETRY_DIAGNOSTICS ? id : null; setActiveTabId(id); scrollIntentRef.current = false; scrollbackRef.current = null; setScrollback(null); clearSearch();
    if (!record) { setActivePresetState(null); setCursorStyleOverridden(false); settingsRef.current = { ...displaySettings(defaultPresetRef.current.crt, defaultPresetRef.current.resolution), channelSwitchEffect: channelSwitchEffectRef.current }; setLive(false); renderer.current!.bindTerminal(null); renderer.current!.setImages([]); renderer.current!.setFocused(false); renderer.current!.setSelection(null); luaAutomation.current?.update(luaAutomationSnapshot()); requestAnimationFrame(() => recordGeometry('tab-select-frame', { sessionId: id, resolution: defaultPresetRef.current.resolution })); return; }
    setCursorStyleOverridden(record.session.cursorStyleOverridden);
    record.session.setTerminalFocused(Boolean(document.hasFocus() && outputRef.current && document.activeElement === outputRef.current));
    luaAutomation.current?.update(luaAutomationSnapshot());
    setActivePresetState(record.preset);
    settingsRef.current = { ...displaySettings(record.preset.settings.crt, record.preset.settings.resolution), channelSwitchEffect: channelSwitchEffectRef.current };
    renderer.current!.bindTerminal(record.session.terminal, (viewportY) => { if (activeRef.current === id && (scrollIntentRef.current || scrollbackRef.current?.sessionId === id)) { const userInitiated = scrollIntentRef.current; scrollIntentRef.current = false; publishScrollback(id, record.session.terminal, userInitiated, viewportY); } }); renderer.current!.setImages(record.images); renderer.current!.setSelection(null); pressed.current.clear(); copyStart.current = null; copyMode.current = false; setLive(record.session.live); setSize(record.session.size);
    recordGeometry('tab-select', { sessionId: id, resolution: record.preset.settings.resolution, terminal: record.session.size, source: { width: renderer.current!.sourceCanvas.width, height: renderer.current!.sourceCanvas.height }, output: elementBounds(outputRef.current), frame: elementBounds(outputRef.current?.parentElement ?? null) });
    requestAnimationFrame(() => recordGeometry('tab-select-frame', { sessionId: id, resolution: record.preset.settings.resolution }));
  }, [cancelAutomationProbeInput, clearSearch, luaAutomationSnapshot, publishScrollback, recordGeometry, refreshAutomationProbeContext]);
  const updateActivePreset = useCallback((update: (current: TabPresetState) => TabPresetState) => {
    const record = activeRef.current ? sessions.current.get(activeRef.current) : undefined;
    if (!record) return;
    const next = update(record.preset);
    record.preset = next;
    luaAutomation.current?.update(luaAutomationSnapshot());
    setActivePresetState(next);
    settingsRef.current = { ...displaySettings(next.settings.crt, next.settings.resolution), channelSwitchEffect: channelSwitchEffectRef.current };
    renderer.current?.cancelScroll(); renderer.current?.markDirty();
  }, [luaAutomationSnapshot]);
  const replaceActivePreset = useCallback((settings: PresetSettings, name: string, sessionId = activeRef.current) => {
    const record = sessionId ? sessions.current.get(sessionId) : undefined;
    if (!record) return;
    const next = { name, draftName: name, settings: clonePresetSettings(settings), dirty: false };
    record.preset = next;
    luaAutomation.current?.update(luaAutomationSnapshot());
    if (activeRef.current === sessionId) {
      setActivePresetState(next);
      settingsRef.current = { ...displaySettings(next.settings.crt, next.settings.resolution), channelSwitchEffect: channelSwitchEffectRef.current };
      renderer.current?.cancelScroll(); renderer.current?.markDirty();
    }
  }, [luaAutomationSnapshot]);
  const markActivePresetSaved = useCallback((name: string) => {
    updateActivePreset((current) => ({ ...current, name, draftName: name, dirty: false }));
  }, [updateActivePreset]);
  const openSession = useCallback(async (launch?: TerminalLaunch, signal?: AbortSignal, ownerId: string | null = null): Promise<string | null> => {
    if (!isTauri()) return null;
    const presetName = launch && typeof launch === 'object' && !('nativeEvent' in launch) && typeof launch.preset === 'string' ? launch.preset : null;
    let preset = clonePresetSettings(defaultPresetRef.current);
    if (presetName) try {
      const raw = await invoke<unknown>('load_preset', { name: presetName });
      if (signal?.aborted) return null;
      const loaded = loadPresetSettings(JSON.stringify(raw));
      if (!loaded) throw new Error('invalid preset format');
      warnIfMissingColorProfile(loaded.crt.colorProfile, onError);
      preset = loaded;
    } catch (reason) { if (signal?.aborted) return null; onError(`Could not load launch preset ${presetName}: ${String(reason)}`); return null; }
    const id = crypto.randomUUID(); const ordinal = nextOrdinal.current++; const initialColor = initialProfile(preset.crt.colorProfile); const tab: TerminalTab = { id, ordinal, title: `${ordinal}. Starting`, status: 'starting', background: initialColor.background, foreground: initialColor.foreground };
    const session = new TerminalSession(id, onError, (nextLive, nextSize) => { if (activeRef.current === id) { setLive(nextLive); setSize(nextSize); } }, () => { const record = sessions.current.get(id); if (record) record.tab.status = 'exited'; updateTab(id, (current) => ({ ...(current as TerminalTab), status: 'exited' })); if (activeRef.current === id) { cancelAutomationProbeInput('session-exit'); luaAutomation.current?.update(luaAutomationSnapshot()); } }, (scroll?: TerminalOutputScroll) => { if (activeRef.current === id && scroll?.autoScroll && smoothScrollbackRef.current) renderer.current?.beginBufferScroll(scroll.fromViewportY, scroll.toViewportY); if (activeRef.current === id) { publishScrollback(id, session.terminal, false); if (searchRef.current.open) applySearch(searchRef.current.query, searchRef.current.activeIndex); } refreshTabColor(id); }, (title) => updateTab(id, (current) => ({ ...(current as TerminalTab), title: `${current.ordinal}. ${title}` })), (name) => updateTab(id, (current) => ({ ...(current as TerminalTab), title: `${current.ordinal}. ${name}` })), (overridden) => { if (activeRef.current === id) setCursorStyleOverridden(overridden); }, (style) => { if (import.meta.env.DEV) { if (activeRef.current === id) traceAutomationProbe('cursor-style', { style }); automationProbe.current?.setCursorStyle(id, style); } }, () => luaAutomation.current?.update(luaAutomationSnapshot()));
    const selectedPresetName = presetName ?? defaultPresetNameRef.current;
    sessions.current.set(id, { tab, session, ownerId: ownerId ?? null, inputLocked: false, preset: { name: selectedPresetName, draftName: selectedPresetName, settings: preset, dirty: false }, images: [] }); setTabs((current) => [...current, tab]); selectSession(id, false);
    const resolution = RESOLUTIONS.find((item) => item.id === preset.resolution) ?? RESOLUTIONS[6]; if (outputRef.current) { const outputSize = outputRasterSize(outputRef.current); const physicalSize = physicalSourceSize(outputSize, preset.crt); const width = resolution.id.startsWith('physical') ? physicalSize.width : ('width' in resolution ? resolution.width : 1); const height = resolution.id.startsWith('physical') ? physicalSize.height : ('height' in resolution ? resolution.height : 1); renderer.current!.resizeSource(width, height); } const source = renderer.current!.sourceCanvas; const dimensions = terminalDimensions(source.width, source.height, displaySettings(preset.crt, resolution.id).consoleFontSize, preset.crt.consoleFont, preset.crt.cellWidthAdjustment, preset.crt.cellHeightAdjustment, preset.crt.fallbackFont);
    recordGeometry('session-start', { sessionId: id, resolution: preset.resolution, output: outputRef.current ? { width: outputRef.current.width, height: outputRef.current.height, css: elementBounds(outputRef.current) } : null, source: { width: source.width, height: source.height }, terminal: dimensions });
    const validLaunch = launch && typeof launch === 'object' && !('nativeEvent' in launch) && ('command' in launch || 'args' in launch || 'cwd' in launch) ? { command: typeof launch.command === 'string' ? launch.command : null, ...(Array.isArray(launch.args) && launch.args.length > 0 && { args: launch.args.filter((argument): argument is string => typeof argument === 'string') }), cwd: typeof launch.cwd === 'string' ? launch.cwd : null } : undefined;
    const effectiveLaunch = validLaunch || defaultShellRef.current ? { ...validLaunch, command: validLaunch?.command || defaultShellRef.current || null } : undefined;
    const starting = session.start(dimensions, initialProfile(preset.crt.colorProfile), effectiveLaunch);
    session.setCursorAppearance(preset.crt.cursorStyle, preset.crt.cursorBlink);
    renderer.current!.bindTerminal(session.terminal, (viewportY) => { if (activeRef.current === id && (scrollIntentRef.current || scrollbackRef.current?.sessionId === id)) { const userInitiated = scrollIntentRef.current; scrollIntentRef.current = false; publishScrollback(id, session.terminal, userInitiated, viewportY); } });
    try {
      const shellName = await starting;
      updateTab(id, (current) => current.status === 'exited' ? current : shellName ? { ...current, title: `${current.ordinal}. ${session.title ?? shellName}`, status: 'running' } : { ...current, title: `${current.ordinal}. Failed`, status: 'failed' });
    } catch (reason) {
      updateTab(id, (current) => ({ ...current, title: `${current.ordinal}. Failed`, status: 'failed' }));
      onError(`Terminal startup failed: ${String(reason)}`);
    }
    luaAutomation.current?.update(luaAutomationSnapshot());
    return id;
  }, [applySearch, cancelAutomationProbeInput, luaAutomationSnapshot, onError, publishScrollback, recordGeometry, refreshTabColor, selectSession, traceAutomationProbe, updateTab]);
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
  const closeSession = useCallback(async (id: string, skipConfirmation = false, preserveWindow = false) => {
    const tab = tabsRef.current.find((item) => item.id === id); const record = sessions.current.get(id);
    if (tab?.kind === 'browser') { const nativeBrowser = browsers.current.delete(id); recentTabs.current = recentTabs.current.filter((item) => item !== id); const next = adjacentTabId(tabsRef.current, id); const remaining = renumberTabs(tabsRef.current.filter((item) => item.id !== id)); let focusTerminal = false; setAddressTabId((current) => current === id ? null : current); nextOrdinal.current = remaining.length + 1; tabsRef.current = remaining; setTabs((current) => renumberTabs(current.filter((item) => item.id !== id))); if (activeRef.current === id) { const targetId = next ?? remaining[0]?.id; if (targetId) { focusTerminal = sessions.current.has(targetId); selectSession(targetId); } else try { await getCurrentWindow().close(); } catch (reason) { onError(`Could not close application: ${String(reason)}`); } } const restoreTerminalFocus = () => { if (focusTerminal) window.requestAnimationFrame(() => outputRef.current?.focus()); }; if (nativeBrowser) void invoke('close_browser', { sessionId: id }).catch((reason) => onError(`Browser close failed: ${String(reason)}`)).finally(restoreTerminalFocus); else restoreTerminalFocus(); return; }
    if (!record || (tab?.status === 'starting' && record.session.live) || closing.current.has(id)) return;
    if (!skipConfirmation && record.preset.dirty && !window.confirm(`Close tab with unsaved preset changes?`)) return;
    closing.current.add(id);
    if (activeRef.current === id) {
      cancelAutomationProbeInput('session-close');
      luaAutomation.current?.update({ ...luaAutomationSnapshot(), activeTabId: null, focused: false });
    }
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
    closing.current.delete(id); record.images.forEach((image) => { image.image.onload = null; image.image.onerror = null; image.image.src = ''; if (image.objectUrl) URL.revokeObjectURL(image.objectUrl); }); sessions.current.delete(id); recentTabs.current = recentTabs.current.filter((item) => item !== id); luaAutomation.current?.update(luaAutomationSnapshot());
    if (activeRef.current === id) { cancelAutomationProbeInput('session-close'); refreshAutomationProbeContext(); }
    const surviving = tabsRef.current.filter((tab) => tab.id === id || sessions.current.has(tab.id) || tab.kind === 'browser');
    const nextId = adjacentTabId(surviving, id);
    const remaining = renumberTabs(tabsRef.current.filter((tab) => tab.id !== id));
    nextOrdinal.current = remaining.length + 1;
    tabsRef.current = remaining;
    setTabs((current) => renumberTabs(current.filter((tab) => tab.id !== id)));
    if (remaining.length === 0 && !preserveWindow) {
      try { await getCurrentWindow().close(); } catch (reason) { onError(`Could not close application: ${String(reason)}`); }
      return;
    }
    if (activeRef.current === id) {
      const targetId = nextId ?? sessions.current.keys().next().value;
      if (targetId) selectSession(targetId);
    }
  }, [cancelAutomationProbeInput, luaAutomationSnapshot, onError, refreshAutomationProbeContext, selectSession, updateTab]);
  useEffect(() => { for (const tab of tabs) if (tab.kind !== 'browser' && tab.status === 'exited' && !sessions.current.get(tab.id)?.preset.dirty) void closeSession(tab.id, true); }, [tabs, closeSession, activePresetState?.dirty]);
  const sessionOwner = useCallback((id: string) => sessions.current.get(id)?.ownerId ?? null, []);
  const ownedSessionInfo = useCallback((ownerId: string): OwnedTerminalInfo[] => [...sessions.current.values()]
    .filter((record) => record.ownerId === ownerId)
    .map((record) => ({ sessionId: record.session.id, title: record.tab.title, status: record.tab.status, processName: record.session.terminal ? record.session.snapshot().processName : null, size: record.session.size })), []);
  const presetStateForSession = useCallback((id: string) => sessions.current.get(id)?.preset, []);
  const isLuaPresetRequestCurrent = useCallback((request: LuaPresetRequest) => {
    const record = sessions.current.get(request.tabId);
    return Boolean(record?.session.live && activeRef.current === request.tabId && luaAutomation.current?.matchesActionContext(request.frontendId, request.generation, request.tabId));
  }, []);
  const pauseLuaAutomationForReload = useCallback(() => luaAutomation.current?.pauseForReload() ?? Promise.resolve(null), []);
  const luaAutomationFrontendId = useCallback(() => luaAutomation.current?.getFrontendId() ?? null, []);
  const isLuaAutomationReloadCurrent = useCallback((token: number) => luaAutomation.current?.isReloadCurrent(token) ?? false, []);
  const isLuaReloadTargetLive = useCallback((tabId: string) => Boolean(sessions.current.get(tabId)?.session.live), []);
  const resumeLuaAutomationAfterReload = useCallback((token: number) => luaAutomation.current?.resumeAfterReload(token) ?? false, []);
  const invalidateLuaPresetRequests = useCallback(() => luaAutomation.current?.invalidateActions(), []);
  const closeOwnedSessions = useCallback(async (ownerId: string) => {
    const owned = [...sessions.current.values()].filter((record) => record.ownerId === ownerId).map((record) => record.session.id);
    for (const id of owned) await closeSession(id, true, true);
    if (!tabsRef.current.length && isTauri()) await openSession();
  }, [closeSession, openSession]);
  const resizeSession = useCallback((id: string, nextSize: TerminalSize) => {
    const record = sessions.current.get(id);
    if (!record) throw new Error('Terminal session is unavailable');
    record.session.resize(nextSize);
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    const coordinator = new LuaAutomationCoordinator((message) => onErrorRef.current(message), undefined, (lease) => {
      if (lease && capsPolicy.current?.policyEpoch === lease.policyEpoch) return;
      cancelAutomationProbeInput('caps-policy-change');
      capsPolicy.current = lease;
    });
    luaAutomation.current = coordinator;
    void coordinator.start();
    coordinator.update(luaAutomationSnapshot());
    return () => {
      coordinator.dispose();
      if (luaAutomation.current === coordinator) luaAutomation.current = null;
    };
  }, [cancelAutomationProbeInput, luaAutomationSnapshot]);
  useEffect(() => { luaAutomation.current?.update(luaAutomationSnapshot()); }, [tabs, activeTabId, luaAutomationSnapshot]);
  useEffect(() => { if (!isTauri()) return; void invoke<string[]>('list_monospace_fonts').then((items) => setFonts([...new Set(['Consolas', ...items])])).catch((reason) => onError(`Could not list system fonts: ${String(reason)}`)); }, [onError]);
  useEffect(() => { for (const id of sessions.current.keys()) refreshTabColor(id); }, [refreshTabColor, activePresetState?.settings.crt.colorProfile, activePresetState?.settings.crt.colorMode, activePresetState?.settings.crt.backgroundDesaturation]);
  useEffect(() => {
    if (!ready) return;
    let active = true;
    const activeSessions = sessions.current; const cleanupFrames = colorFrames.current;
    const controller = new AbortController();
    const start = window.setTimeout(() => {
      void invoke<{ kind?: string; command?: string; args?: string[]; cwd?: string; url?: string }>('initial_terminal_launch')
        .then((launch) => {
          if (!active) return;
          if (launch?.kind === 'browser' && typeof launch.url === 'string') openBrowser(launch.url); else void openSession(launch, controller.signal);
        })
        .catch((reason) => {
          if (!active) return;
          onErrorRef.current(`Could not read startup arguments: ${String(reason)}`);
          void openSession(undefined, controller.signal);
        });
    });
    return () => {
      active = false;
      controller.abort();
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
  useEffect(() => { let unlisten: UnlistenFn | undefined; void listen<{ sessionId?: string; code?: string; shiftKey?: boolean }>('browser-shortcut', (event) => { const { sessionId, code, shiftKey } = event.payload ?? {}; if (sessionId === activeRef.current && typeof code === 'string') { menu.current = true; window.dispatchEvent(new KeyboardEvent('keydown', { code, shiftKey: Boolean(shiftKey), bubbles: true })); menu.current = false; } }).then((cleanup) => { unlisten = cleanup; }).catch((reason) => onError(`Could not receive browser shortcut: ${String(reason)}`)); return () => unlisten?.(); }, [onError]);
  useEffect(() => { let unlisten: UnlistenFn | undefined; void listen<{ kind?: string; url?: string }>('browser-launch', (event) => { if (event.payload?.kind === 'browser' && typeof event.payload.url === 'string') openBrowser(event.payload.url); }).then((cleanup) => { unlisten = cleanup; }).catch((reason) => onError(`Could not receive browser launch: ${String(reason)}`)); return () => unlisten?.(); }, [onError, openBrowser]);
  const resizeSource = useCallback((output: HTMLCanvasElement, reason = 'manual', expectedSessionId?: string | null) => {
    if (expectedSessionId !== undefined && expectedSessionId !== activeRef.current) {
      recordGeometry('resize-source-skipped', { reason, expectedSessionId, activeSessionId: activeRef.current });
      return;
    }
    outputRef.current = output;
    const preset = (activeRef.current ? sessions.current.get(activeRef.current)?.preset.settings : undefined) ?? defaultPresetRef.current;
    const resolution = RESOLUTIONS.find((item) => item.id === preset.resolution) ?? RESOLUTIONS[6];
    const frame = output.parentElement;
    const browserActive = tabsRef.current.some((tab) => tab.id === activeRef.current && tab.kind === 'browser');
    if (!browserActive) {
      if (resolution.id === 'physical') {
        frame?.style.removeProperty('--screen-ratio');
        frame?.style.removeProperty('aspect-ratio');
      } else if ('width' in resolution && 'height' in resolution) {
        frame?.style.setProperty('--screen-ratio', String(resolution.width / resolution.height));
        frame?.style.setProperty('aspect-ratio', `${resolution.width} / ${resolution.height}`);
      }
    }
    const outputBounds = output.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const backingWidth = Math.max(1, Math.round(outputBounds.width * dpr));
    const backingHeight = Math.max(1, Math.round(outputBounds.height * dpr));
    if (output.width !== backingWidth) output.width = backingWidth;
    if (output.height !== backingHeight) output.height = backingHeight;
    const outputSize = outputRasterSize(output);
    const physicalSize = physicalSourceSize(outputSize, preset.crt);
    const width = resolution.id.startsWith('physical') ? physicalSize.width : ('width' in resolution ? resolution.width : 1);
    const height = resolution.id.startsWith('physical') ? physicalSize.height : ('height' in resolution ? resolution.height : 1);
    const sourceChanged = renderer.current!.resizeSource(width, height);
    const source = renderer.current!.sourceCanvas;
    const session = activeRef.current ? sessions.current.get(activeRef.current)?.session : undefined;
    const displayCRT = displaySettings(preset.crt, resolution.id);
    settingsRef.current = { ...displayCRT, channelSwitchEffect: channelSwitchEffectRef.current };
    const dimensions = terminalDimensions(source.width, source.height, displayCRT.consoleFontSize, preset.crt.consoleFont, preset.crt.cellWidthAdjustment, preset.crt.cellHeightAdjustment, preset.crt.fallbackFont);
    const cell = TERMINAL_GEOMETRY_DIAGNOSTICS ? fontCellSize(displayCRT.consoleFontSize, preset.crt.consoleFont, undefined, preset.crt.cellWidthAdjustment, preset.crt.cellHeightAdjustment, preset.crt.fallbackFont) : undefined;
    const terminalChanged = Boolean(session && (session.size.cols !== dimensions.cols || session.size.rows !== dimensions.rows));
    if (session) session.resize(dimensions);
    const workspace = frame?.closest('.terminal-workspace') ?? null;
    const frameStyle = frame ? getComputedStyle(frame) : null;
    recordGeometry('resize-source', { reason, sessionId: session?.id ?? null, resolution: preset.resolution, dpr: window.devicePixelRatio || 1, layout: frame ? { inlineRatio: frame.style.getPropertyValue('--screen-ratio'), computedRatio: frameStyle?.getPropertyValue('--screen-ratio'), inlineAspectRatio: frame.style.getPropertyValue('aspect-ratio'), computedAspectRatio: frameStyle?.aspectRatio } : null, output: { backing: { width: output.width, height: output.height }, raster: outputSize, css: elementBounds(output) }, frame: elementBounds(frame), workspace: elementBounds(workspace), tabs: elementBounds(workspace?.querySelector('.terminal-tabs') ?? null), source: { width: source.width, height: source.height, changed: sourceChanged }, fontCell: cell, terminal: { ...dimensions, changed: terminalChanged, xterm: session?.terminal ? { cols: session.terminal.cols, rows: session.terminal.rows } : null, session: session?.size ?? null } });
  }, [recordGeometry]);
  const recordFirstDraw = useCallback((output: HTMLCanvasElement, frameTime: number, changed: boolean) => {
    const id = pendingFirstDraw.current;
    if (!id || id !== activeRef.current) return;
    pendingFirstDraw.current = null;
    const record = sessions.current.get(id);
    if (!record) return;
    const { crt } = record.preset.settings;
    recordGeometry('tab-first-draw', { frameTime, sessionId: id, changed, dpr: window.devicePixelRatio || 1, output: { backing: { width: output.width, height: output.height }, css: elementBounds(output) }, source: { width: renderer.current!.sourceCanvas.width, height: renderer.current!.sourceCanvas.height }, font: { family: crt.consoleFont, fallback: crt.fallbackFont, size: crt.consoleFontSize, cell: fontCellSize(crt.consoleFontSize, crt.consoleFont, undefined, crt.cellWidthAdjustment, crt.cellHeightAdjustment, crt.fallbackFont) }, terminal: { xterm: record.session.terminal ? { cols: record.session.terminal.cols, rows: record.session.terminal.rows } : null, session: record.session.size } });
  }, [recordGeometry]);
  const currentPreset = activePresetState?.settings ?? defaultPresetRef.current;
  useEffect(() => {
    if (!isTauri()) return;
    const sessionId = activeTabId;
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
      renderer.current?.cancelScroll(); renderer.current?.markDirty();
      if (outputRef.current) resizeSource(outputRef.current, 'font-ready', sessionId);
    }).catch((reason) => { if (!cancelled) onError(`Could not load font: ${String(reason)}`); });
    return () => { cancelled = true; };
  }, [activeTabId, currentPreset.crt.consoleFont, currentPreset.crt.fallbackFont, onError, resizeSource]);
  useLayoutEffect(() => { const sessionId = activeTabId; const output = outputRef.current; if (output) resizeSource(output, 'preset-change', sessionId); }, [activeTabId, resizeSource, currentPreset.resolution, currentPreset.crt.consoleFont, currentPreset.crt.fallbackFont, currentPreset.crt.consoleFontSize, currentPreset.crt.cellWidthAdjustment, currentPreset.crt.cellHeightAdjustment, currentPreset.crt.crtEmulation, currentPreset.crt.bezelThickness]);
  useEffect(() => { renderer.current?.cancelScroll(); renderer.current?.markDirty(); }, [currentPreset.crt]);
  useEffect(() => {
    renderer.current!.cancelScroll(); renderer.current!.markDirty();
    const session = activeRef.current ? sessions.current.get(activeRef.current)?.session : undefined;
    session?.setCursorAppearance(settingsRef.current.cursorStyle, settingsRef.current.cursorBlink);
  }, [activePresetState?.settings.crt.cursorStyle, activePresetState?.settings.crt.cursorBlink, activePresetState?.settings.crt.breathing]);
  useEffect(() => {
    const reopenAddress = (event: KeyboardEvent) => {
      if (event.keyCode === 252) return;
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
    const down = (event: KeyboardEvent) => { if (event.keyCode === 252 || presetPickerOpenRef.current) return; if (menu.current && event.code === 'KeyI') { event.preventDefault(); event.stopImmediatePropagation(); if (!event.repeat) void addImage(); } };
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
      if (event.keyCode === 252) return;
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
      if (event.keyCode === 252) return;
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
      if (activeRef.current) sessions.current.get(activeRef.current)?.session.setTerminalFocused(false);
      renderer.current?.setFocused(false);
      luaAutomation.current?.update(luaAutomationSnapshot());
    };
    const focus = () => {
      if (document.activeElement === outputRef.current) {
        if (activeRef.current) sessions.current.get(activeRef.current)?.session.setTerminalFocused(true);
        renderer.current?.setFocused(true);
        luaAutomation.current?.update(luaAutomationSnapshot());
      }
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', blur);
    window.addEventListener('focus', focus);
    return () => { window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); window.removeEventListener('blur', blur); window.removeEventListener('focus', focus); };
  }, [luaAutomationSnapshot, onError]);
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.keyCode === 252) return;
      if (galleryOpenRef.current || presetPickerOpenRef.current || !menu.current || !event.shiftKey || event.repeat) return;
      if (event.code !== 'ArrowLeft' && event.code !== 'ArrowRight' && event.code !== 'KeyH' && event.code !== 'KeyL') return;
      const id = activeRef.current;
      const index = id ? tabsRef.current.findIndex((tab) => tab.id === id) : -1;
      const target = index + (event.code === 'ArrowLeft' || event.code === 'KeyH' ? -1 : 1);
      if (id && index >= 0 && target >= 0 && target < tabsRef.current.length) moveTab(id, target);
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', down, true);
    return () => window.removeEventListener('keydown', down, true);
  }, [moveTab]);
  useEffect(() => {
    const onWheel = (event: globalThis.WheelEvent) => {
      if (event.deltaY === 0) return;
      const isTerminalCanvas = event.target instanceof HTMLCanvasElement && (!outputRef.current || event.target === outputRef.current);
      if (!isTerminalCanvas) return;
      const session = activeRef.current ? sessions.current.get(activeRef.current)?.session : undefined;
      const terminal = session?.terminal;
      if (!terminal || terminal.buffer.active !== terminal.buffer.normal || (terminal.modes.mouseTrackingMode && terminal.modes.mouseTrackingMode !== 'none')) return;
      scrollIntentRef.current = true;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.keyCode === 252) return;
      if (presetPickerOpenRef.current) return;
      if (!menu.current || event.target instanceof Element && event.target.closest('.settings-panel, .terminal-tabs, .new-tab-button, .browser-address')) return;
      if (event.code !== 'PageUp' && event.code !== 'PageDown' && event.code !== 'KeyJ' && event.code !== 'KeyK') return;
      if ((event.code === 'KeyJ' || event.code === 'KeyK') && document.activeElement?.closest('.ai-panel')) return;
      scrollIntentRef.current = true;
    };
    window.addEventListener('wheel', onWheel, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => { window.removeEventListener('wheel', onWheel, true); window.removeEventListener('keydown', onKeyDown, true); };
  }, [publishScrollback]);
  const activeSession = () => activeRef.current ? sessions.current.get(activeRef.current)?.session : undefined;
  const keyboardSession = useCallback(() => document.activeElement instanceof Element && document.activeElement.closest('.ai-panel') ? undefined : activeSession(), []);
  useEffect(() => {
    const probe = import.meta.env.DEV ? automationProbe.current : null;
    if (probe) { void probe.start(); refreshAutomationProbeContext(); }
    const blur = () => {
      cancelAutomationProbeInput('window-blur');
      probe?.setContext(activeRef.current && sessions.current.has(activeRef.current) ? activeRef.current : null, false);
      luaAutomation.current?.update({ ...luaAutomationSnapshot(), activeTabId: null, focused: false });
    };
    const focus = () => { refreshAutomationProbeContext(); luaAutomation.current?.update(luaAutomationSnapshot()); };
    window.addEventListener('blur', blur);
    window.addEventListener('focus', focus);
    return () => { window.removeEventListener('blur', blur); window.removeEventListener('focus', focus); cancelAutomationProbeInput('probe-cleanup'); probe?.dispose(); };
  }, [cancelAutomationProbeInput, luaAutomationSnapshot, refreshAutomationProbeContext]);
  useEffect(() => {
    const thresholdMs = 180;
    const focusedSession = () => {
      if (!document.hasFocus() || !outputRef.current || document.activeElement !== outputRef.current) return undefined;
      const session = activeSession();
      if (!session?.live || !session.terminal) return undefined;
      const policy = capsPolicy.current;
      const smartCaps = policy?.enabled && policy.tabId === session.id && policy.processName === session.localProcessName;
      return smartCaps || (import.meta.env.DEV && automationProbe.current?.enabled) ? session : undefined;
    };
    const consume = (event: KeyboardEvent) => { event.preventDefault(); event.stopImmediatePropagation(); };
    const matchingToken = (event: KeyboardEvent) => event.keyCode === 252;
    const legacyProbeEnabled = () => import.meta.env.DEV && Boolean(automationProbe.current?.enabled);
    const clearFrameTimeout = () => {
      if (capsFrameTimer.current !== null) window.clearTimeout(capsFrameTimer.current);
      capsFrameTimer.current = null;
    };
    const resetFrame = () => { clearFrameTimeout(); capsFrameDecoder.current.reset(); };
    const sendEncoded = (session: TerminalSession, event: KeyboardEvent, keyDown: boolean) => {
      if (!session.live || !session.terminal) return;
      const input = session.win32InputMode ? win32InputKey(event, keyDown) : keyDown ? terminalKey(event, session.terminal.modes) : null;
      if (input) session.sendInput(input);
      traceAutomationProbe('terminal-send', { encoder: session.win32InputMode ? 'win32' : 'vt', phase: keyDown ? 'down' : 'up', key: event.key, code: event.code, ctrlKey: event.ctrlKey, textLength: input?.length ?? 0 });
      if (keyDown && event.key === 'Escape' && scrollToBottomOnKey(event.key)) session.terminal.scrollToBottom();
    };
    const modified = (event: KeyboardEvent) => {
      let key = event.key;
      if (key.length === 1 && key.charCodeAt(0) > 127) {
        const physicalLetter = /^Key([A-Z])$/.exec(event.code)?.[1];
        const virtualKey = event.keyCode || event.which || 0;
        const letter = physicalLetter ?? (!event.code && virtualKey >= 65 && virtualKey <= 90 ? String.fromCharCode(virtualKey) : undefined);
        if (letter) key = event.shiftKey ? letter : letter.toLowerCase();
      }
      return {
      key, code: event.code, location: event.location, repeat: event.repeat,
      ctrlKey: true, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey,
      keyCode: event.keyCode, which: event.which,
      getModifierState: (key: string) => typeof event.getModifierState === 'function' && event.getModifierState(key),
      } as KeyboardEvent;
    };
    const tokenDown = (event: KeyboardEvent, startedAt = performance.now()) => {
      const session = focusedSession();
      if (!session) return false;
      consume(event);
      const repeated = tapHold.current.downAt !== null;
      tapHold.current = updateTapHold(tapHold.current, repeated ? 'repeat' : 'down', startedAt, thresholdMs).state;
      if (!repeated) tapHoldSession.current = session;
      traceAutomationProbe(repeated ? 'token-repeat' : 'token-down', { encoder: session.win32InputMode ? 'win32' : 'vt', downAt: tapHold.current.downAt });
      if (!repeated) {
        const delay = Math.max(0, thresholdMs - (performance.now() - startedAt));
        tapHoldTimer.current = window.setTimeout(() => {
          tapHoldTimer.current = null;
          const before = tapHold.current.control;
          tapHold.current = updateTapHold(tapHold.current, 'timeout', performance.now(), thresholdMs).state;
          if (!before && tapHold.current.control) traceAutomationProbe('token-control-armed', { reason: 'hold-threshold' });
        }, delay);
      }
      return true;
    };
    const tokenUp = (event: KeyboardEvent, clearLegacySuppression = false, classification?: TapHoldClassification) => {
      if (tapHold.current.downAt === null) {
        if (clearLegacySuppression) probeSuppressedTokenUp.current = false;
        return;
      }
      if (tapHoldTimer.current !== null) window.clearTimeout(tapHoldTimer.current);
      tapHoldTimer.current = null;
      const result = updateTapHold(tapHold.current, 'up', performance.now(), thresholdMs, classification);
      tapHold.current = result.state;
      const origin = tapHoldSession.current;
      tapHoldSession.current = null;
      traceAutomationProbe('token-up', { action: result.escape ? 'escape' : 'control-or-held', classification: classification ?? 'frontend-timing' });
      if (result.escape && origin && origin === focusedSession()) {
        const escape = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape' });
        sendEncoded(origin, escape, true);
        if (origin.win32InputMode) sendEncoded(origin, new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape' }), false);
      }
    };
    const onRawMarker = (event: KeyboardEvent, phase: 'keydown' | 'keyup') => {
      consume(event);
      if (event.code === '' && legacyProbeEnabled()) {
        if (phase === 'keydown') {
          if (!probeSuppressedTokenUp.current) tokenDown(event);
        } else tokenUp(event, true);
        return;
      }
      const lease = capsPolicy.current;
      const markerToken = lease?.enabled ? lease.markerToken : null;
      const frame = capsFrameDecoder.current.feed(
        { code: event.code, keyCode: event.keyCode, phase },
        markerToken,
        capsInputRevision.current,
        performance.now(),
      );
      if (capsFrameDecoder.current.pending) {
        clearFrameTimeout();
        capsFrameTimer.current = window.setTimeout(resetFrame, 250);
      } else clearFrameTimeout();
      if (frame && lease?.enabled && lease.markerToken === frame.markerToken && capsInputRevision.current === frame.contextRevision) {
        if (frame.edge === 'down') tokenDown(event, frame.startedAt);
        else tokenUp(event, false, frame.tapHold ?? undefined);
      }
    };
    const down = (event: KeyboardEvent) => {
      if (matchingToken(event)) {
        onRawMarker(event, 'keydown'); return;
      }
      if (capsFrameDecoder.current.pending) resetFrame();
      const session = focusedSession();
      if (tapHold.current.downAt === null) return;
      if (!session || tapHoldSession.current !== session) { cancelAutomationProbeInput('context-mismatch'); return; }
      consume(event);
      const result = updateTapHold(tapHold.current, 'other-key', performance.now(), thresholdMs);
      tapHold.current = result.state;
      if (!tapHold.current.control) return;
      traceAutomationProbe('chord-keydown', { encoder: session.win32InputMode ? 'win32' : 'vt', key: event.key, code: event.code, repeat: event.repeat });
      if (event.key === 'Control' || event.key === 'Shift' || event.key === 'Alt' || event.key === 'Meta') return;
      const chordEvent = modified(event);
      const identity = forwardedKeyIdentity(event);
      if (session.win32InputMode) {
        if (!probeForwardedKeys.current.has(identity)) probeForwardedKeys.current.set(identity, { event: chordEvent, session });
        sendEncoded(session, chordEvent, true);
      } else sendEncoded(session, chordEvent, true);
    };
    const up = (event: KeyboardEvent) => {
      if (matchingToken(event)) {
        onRawMarker(event, 'keyup'); return;
      }
      if (capsFrameDecoder.current.pending) resetFrame();
      const identity = forwardedKeyIdentity(event);
      const forwarded = probeForwardedKeys.current.get(identity);
      if (forwarded) {
        consume(event);
        if (forwarded.session.live && forwarded.session.win32InputMode) {
          forwarded.session.sendInput(win32InputKey(forwarded.event, false));
          traceAutomationProbe('win32-keyup', { code: event.code, key: forwarded.event.key });
        }
        probeForwardedKeys.current.delete(identity);
        probeSuppressedKeyUps.current.delete(identity);
        return;
      }
      if (probeSuppressedKeyUps.current.has(identity)) {
        consume(event);
        probeSuppressedKeyUps.current.delete(identity);
      }
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => { window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); cancelAutomationProbeInput('input-listener-cleanup'); };
  }, [cancelAutomationProbeInput, traceAutomationProbe]);
  const cell = (event: MouseEvent<HTMLCanvasElement> | WheelEvent<HTMLCanvasElement>) => renderer.current!.cellAtPoint(event.clientX, event.clientY, event.currentTarget, settingsRef.current);
  const imagePoint = (event: MouseEvent<HTMLCanvasElement> | WheelEvent<HTMLCanvasElement>) => renderer.current!.sourcePointAt(event.clientX, event.clientY, event.currentTarget, settingsRef.current);
  const imageAt = (event: MouseEvent<HTMLCanvasElement> | WheelEvent<HTMLCanvasElement>) => { const point = imagePoint(event); return point ? renderer.current!.imageAtSourcePoint(point.x, point.y) : null; };
  const removeImage = (image: TerminalImage) => { const record = activeRef.current ? sessions.current.get(activeRef.current) : undefined; if (!record) return; const index = record.images.indexOf(image); if (index >= 0) { record.images.splice(index, 1); image.image.onload = null; image.image.onerror = null; image.image.src = ''; if (image.objectUrl) URL.revokeObjectURL(image.objectUrl); renderer.current!.markImagesDirty(); } };
  const copyPoint = (point: { col: number; row: number }): CopyPoint => { const terminal = activeSession()?.terminal; if (!terminal) return { row: 0, column: 0 }; return { row: Math.max(terminal.buffer.active.viewportY, terminal.buffer.active.viewportY + point.row - 1), column: Math.max(0, point.col - 1) }; };
  const linkAtPoint = (point: { col: number; row: number }) => { const terminal = activeSession()?.terminal; const position = copyPoint(point); const line = terminal?.buffer.active.getLine(position.row); if (!terminal || !line) return null; const link = linkAtLine(line, position.column); if (!link) return null; return { url: link.url, selection: { start: { ...position, column: link.start }, end: { ...position, column: link.end } } }; };
  const sendMouse = (event: MouseEvent<HTMLCanvasElement> | WheelEvent<HTMLCanvasElement>, action: Parameters<typeof terminalMouse>[0]['action'], button?: 0 | 1 | 2) => { const session = activeSession(); const terminal = session?.terminal; const tracking = terminal?.modes.mouseTrackingMode as MouseTrackingMode | undefined; if (!session || !terminal || !tracking || tracking === 'none' || (tracking === 'x10' && (action !== 'press' || event.ctrlKey || event.altKey || event.shiftKey)) || (tracking === 'vt200' && action === 'move')) return false; const point = cell(event); if (!point) return false; event.preventDefault(); session.sendInput(terminalMouse({ ...point, action, button, sgr: session.sgrMouseMode, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey })); return true; };
  const copy = async (start: CopyPoint, end: CopyPoint) => { const terminal = activeSession()?.terminal; if (!terminal) return; const [first,last] = start.row < end.row || start.row === end.row && start.column <= end.column ? [start,end] : [end,start]; const text = Array.from({ length: last.row - first.row + 1 }, (_, index) => { const row = first.row + index; return terminal.buffer.active.getLine(row)?.translateToString(index === last.row - first.row, row === first.row ? first.column : 0, row === last.row ? last.column + 1 : terminal.cols) ?? ''; }).join('\r\n').replace(/(?:\r\n|\r|\n)$/, ''); if (text) await navigator.clipboard.writeText(text); };
  const openNativeContextMenu = (event: MouseEvent<HTMLCanvasElement>) => { event.preventDefault(); if (!rmbMenuInTermRef.current || !isTauri()) return; const image = imageAt(event); if (image) { void showNativeImageMenu({ onDelete: () => removeImage(image) }).catch((reason) => onError(`Could not open image menu: ${String(reason)}`)); return; } void showNativeTerminalMenu({ onNew: () => openSession(), onNewBrowser: (url) => openBrowser(url), onNewShell: (command) => openSession({ command }), shells, onFind: () => openSearch(1), onFindBack: () => openSearch(-1), onCopyByMouse: () => { copyMode.current = true; }, onToggleTabsBar: () => onToggleTabsBar?.(), onOpenPresetPicker: () => onTogglePresetPicker?.(), onToggleGallery: () => onToggleGallery?.() }).catch((reason) => onError(`Could not open terminal context menu: ${String(reason)}`)); };
  useEffect(() => { const forwardedKeys = new Map<string, { event: KeyboardEvent; session: TerminalSession }>(); const releaseForwardedKeys = () => { for (const { event, session } of forwardedKeys.values()) if (session.live && session.win32InputMode) session.sendInput(win32InputKey(event, false)); forwardedKeys.clear(); }; const down = async (event: KeyboardEvent) => { if (event.code === 'AltLeft' || event.code === 'AltRight' || event.key === 'AltGraph') alt.current = true; if ((event.code === 'F4' || event.key === 'F4') && (event.altKey || alt.current || (typeof event.getModifierState === 'function' && (event.getModifierState('Alt') || event.getModifierState('AltGraph')))) && !event.ctrlKey && !event.shiftKey && !event.metaKey) return; if (event.key === 'ContextMenu') { menu.current = true; menuShortcut.current = false; menuEvent.current = event; event.preventDefault(); return; } if (menu.current && event.code !== 'ContextMenu') menuShortcut.current = true; if (presetPickerOpenRef.current) { if (!(event.target instanceof Element && event.target.closest('.quick-preset-picker'))) event.preventDefault(); return; } if (menu.current && event.code === 'Backspace') { event.preventDefault(); if (!event.repeat) onToggleGallery?.(); return; } if (galleryOpenRef.current) { if (event.code === 'Tab' || event.key === 'Tab') { event.preventDefault(); const dialog = document.querySelector<HTMLElement>('.tab-gallery[role="dialog"]'); const focusable = dialog ? Array.from(dialog.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter((element) => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true') : []; if (focusable.length) { const current = focusable.indexOf(document.activeElement as HTMLElement); const offset = event.shiftKey ? -1 : 1; focusable[(current + offset + focusable.length) % focusable.length].focus(); } } else event.preventDefault(); return; } if (menu.current && event.code === 'KeyW') { event.preventDefault(); if (!event.repeat && activeRef.current) void closeSession(activeRef.current); return; } if (event.target instanceof Element && event.target.closest('.settings-panel, .terminal-tabs, .new-tab-button, .browser-address')) return; if (menu.current && event.code === 'Slash') { event.preventDefault(); menuShortcut.current = true; if (!event.repeat) openSearch(event.shiftKey ? -1 : 1); return; } if (searchRef.current.open) { const inputTarget = event.target instanceof Element && event.target.closest('.terminal-search-input'); if (event.key === 'Escape') { event.preventDefault(); clearSearch(); (document.querySelector('.output-canvas') as HTMLCanvasElement | null)?.focus(); return; } if (event.key === 'Enter') { event.preventDefault(); moveSearch(searchRef.current.direction); (document.querySelector('.output-canvas') as HTMLCanvasElement | null)?.focus(); return; } if (!inputTarget && (event.key === 'n' || event.key === 'N')) { event.preventDefault(); moveSearch(event.key === 'N' ? (searchRef.current.direction === 1 ? -1 : 1) : searchRef.current.direction); return; } if (inputTarget) return; event.preventDefault(); return; } const session = keyboardSession(); const terminal = session?.terminal; if (menu.current && event.code === 'KeyS') { event.preventDefault(); if (!event.repeat) onToggleSettings(); return; } if (menu.current && event.code === 'KeyZ') { event.preventDefault(); if (!event.repeat) onToggleTabsBar?.(); return; } if (menu.current && event.code === 'KeyP') { event.preventDefault(); if (!event.repeat) onTogglePresetPicker?.(); return; } if (menu.current && (event.code === 'Minus' || event.code === 'NumpadSubtract' || event.code === 'Equal' || event.code === 'NumpadAdd')) { event.preventDefault(); if (!event.repeat) updateActivePreset((current) => ({ ...current, settings: { ...current.settings, crt: { ...current.settings.crt, consoleFontSize: Math.max(6, Math.min(32, current.settings.crt.consoleFontSize + (event.code === 'Minus' || event.code === 'NumpadSubtract' ? -1 : 1))) } }, dirty: true })); return; } if (menu.current && event.code === 'KeyA') { event.preventDefault(); if (!event.repeat) onToggleAi?.(); return; } if (menu.current && event.code === 'KeyB') { event.preventDefault(); if (!event.repeat) openBrowser(); return; } if (menu.current && event.code === 'KeyV') { event.preventDefault(); if (!event.repeat) navigator.clipboard.readText().then((input) => session?.sendInput(input)).catch((reason) => onError(`Clipboard paste failed: ${String(reason)}`)); return; } if (menu.current && event.code === 'KeyC') { event.preventDefault(); if (!event.repeat) copyMode.current = true; return; } if (menu.current && event.code === 'KeyN') { event.preventDefault(); if (!event.repeat) openSession(); return; } if (menu.current && event.code === 'Quote') { event.preventDefault(); if (!event.repeat) { const aiComposer = document.querySelector('.ai-composer textarea') as HTMLTextAreaElement | null; if (document.activeElement?.closest('.ai-panel') || document.activeElement === aiComposer) { const canvas = document.querySelector('.terminal-workspace canvas') as HTMLCanvasElement | null; canvas?.focus(); } else { if (aiComposer) aiComposer.focus(); else onToggleAi?.(); } } return; } if (menu.current && /^Digit[0-9]$/.test(event.code)) { event.preventDefault(); if (!event.repeat) { const id = tabIdAtOrdinal(tabsRef.current, event.code === 'Digit0' ? 10 : Number(event.code.at(-1))); if (id) selectSession(id); } return; } if (menu.current && (event.code === 'ArrowRight' || event.code === 'Period' || event.key === '>')) { event.preventDefault(); if (!event.repeat && activeRef.current) { const id = nextTabId(tabsRef.current, activeRef.current); if (id) selectSession(id); } return; } if (menu.current && (event.code === 'ArrowLeft' || event.code === 'Comma' || event.key === '<')) { event.preventDefault(); if (!event.repeat && activeRef.current) { const id = previousTabId(tabsRef.current, activeRef.current); if (id) selectSession(id); } return; } if (menu.current && (event.code === 'Tab' || event.key === 'Tab')) { event.preventDefault(); if (!event.repeat && activeRef.current) { const id = previousActiveTabId(tabsRef.current, recentTabs.current, activeRef.current); if (id) selectSession(id); } return; } if (menu.current && (event.code === 'PageUp' || event.code === 'PageDown')) { event.preventDefault(); if (terminal && terminal.buffer.active === terminal.buffer.normal) { const from = terminal.buffer.active.viewportY; terminal.scrollLines((event.code === 'PageUp' ? -1 : 1) * (terminal.rows - 1)); const to = terminal.buffer.active.viewportY; if (to === from) scrollIntentRef.current = false; } else { scrollIntentRef.current = false; } return; } if (menu.current && (event.code === 'KeyJ' || event.code === 'KeyK')) { event.preventDefault(); const isUp = event.code === 'KeyK'; if (document.activeElement?.closest('.ai-panel')) { const aiMessages = document.querySelector('.ai-messages'); if (aiMessages) aiMessages.scrollBy(0, (isUp ? -1 : 1) * aiMessages.clientHeight * 0.8); scrollIntentRef.current = false; } else if (terminal && terminal.buffer.active === terminal.buffer.normal) { const from = terminal.buffer.active.viewportY; terminal.scrollLines((isUp ? -1 : 1) * (terminal.rows - 1)); const to = terminal.buffer.active.viewportY; if (to === from) scrollIntentRef.current = false; } else { scrollIntentRef.current = false; } return; } if ((event.altKey || alt.current || (typeof event.getModifierState === 'function' && (event.getModifierState('Alt') || event.getModifierState('AltGraph')))) && (event.code === 'Enter' || event.code === 'NumpadEnter' || event.key === 'Enter') && isTauri()) { event.preventDefault(); fullscreen.current = true; if (!event.repeat) try { const window = getCurrentWindow(); await window.setFullscreen(!(await window.isFullscreen())); } catch (reason) { onError(`Fullscreen toggle failed: ${String(reason)}`); } return; } if (!session?.live || !terminal) return; const input = session.win32InputMode ? win32InputKey(event, true) : terminalKey(event, terminal.modes); event.preventDefault(); if (input) { if (session.win32InputMode) forwardedKeys.set(forwardedKeyIdentity(event), { event, session }); if (scrollToBottomOnKey(event.key)) terminal.scrollToBottom(); session.sendInput(input); } }; const up = (event: KeyboardEvent) => { if (event.code === 'AltLeft' || event.code === 'AltRight' || event.key === 'AltGraph') alt.current = false; if ((event.code === 'F4' || event.key === 'F4') && (event.altKey || alt.current || (typeof event.getModifierState === 'function' && (event.getModifierState('Alt') || event.getModifierState('AltGraph')))) && !event.ctrlKey && !event.shiftKey && !event.metaKey) return; if (event.key === 'ContextMenu') { const source = menuEvent.current; const standalone = !menuShortcut.current; menu.current = false; menuEvent.current = null; event.preventDefault(); if (standalone && source && !(event.target instanceof Element && event.target.closest('.settings-panel, .terminal-tabs, .new-tab-button, .browser-address'))) { const session = keyboardSession(); if (session?.live && session.win32InputMode) { session.sendInput(win32InputKey(source, true)); session.sendInput(win32InputKey(event, false)); } } return; } const identity = forwardedKeyIdentity(event); const forwarded = forwardedKeys.get(identity); if (forwarded) { if (forwarded.session.live && forwarded.session.win32InputMode) forwarded.session.sendInput(win32InputKey(event, false)); forwardedKeys.delete(identity); event.preventDefault(); return; } if (fullscreen.current && (event.code === 'Enter' || event.code === 'NumpadEnter')) { fullscreen.current = false; event.preventDefault(); return; } if (galleryOpenRef.current || presetPickerOpenRef.current) { event.preventDefault(); return; } if (event.target instanceof Element && event.target.closest('.settings-panel, .terminal-tabs, .new-tab-button, .browser-address')) return; if (searchRef.current.open) { if (!(event.target instanceof Element && event.target.closest('.terminal-search-input'))) event.preventDefault(); return; } if (fullscreen.current && (event.code === 'Enter' || event.code === 'NumpadEnter')) { fullscreen.current = false; event.preventDefault(); return; } const session = keyboardSession(); if (!session?.live || !session.terminal) return; event.preventDefault(); }; const clearAlt = () => { alt.current = false; fullscreen.current = false; menu.current = false; menuEvent.current = null; menuShortcut.current = false; releaseForwardedKeys(); renderer.current?.setFocused(false); scrollIntentRef.current = false; }; window.addEventListener('keydown', down, true); window.addEventListener('keyup', up, true); window.addEventListener('blur', clearAlt); return () => { releaseForwardedKeys(); window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); window.removeEventListener('blur', clearAlt); }; }, [clearSearch, closeSession, keyboardSession, moveSearch, onError, onToggleAi, onToggleGallery, onTogglePresetPicker, onToggleSettings, onToggleTabsBar, openBrowser, openSearch, openSession, selectSession, updateActivePreset]);
  return { moveTab, search, openSearch, clearSearch, setSearchQuery: (query: string) => applySearch(query, 0), moveSearch, renderer: renderer.current, settingsRef, recordFirstDraw, live, size, fonts, tabs, activeTabId, activeSessionId: sessions.current.has(activeTabId ?? '') ? activeTabId : null, activePreset: activePresetState?.settings ?? defaultPresetRef.current, activePresetState, cursorStyleOverridden, scrollback, scrollToLine, updateActivePreset, replaceActivePreset, markActivePresetSaved, presetStateForSession, isLuaPresetRequestCurrent, pauseLuaAutomationForReload, luaAutomationFrontendId, isLuaAutomationReloadCurrent, isLuaReloadTargetLive, resumeLuaAutomationAfterReload, invalidateLuaPresetRequests, refreshColorProfiles, addressTabId, openAddress: (id: string) => setAddressTabId(id), closeAddress: () => setAddressTabId(null), navigateBrowser, openSession, openBrowser, selectSession, closeSession, sessionOwner, ownedSessionInfo, closeOwnedSessions, resizeSession, isMcpSession: (id: string) => Boolean(sessions.current.get(id)?.ownerId), resizeSource, exportGeometryDiagnostics: () => JSON.stringify({ version: 1, entries: geometryDiagnostics.current }, null, 2), canvasProps: { onFocus: () => { activeSession()?.setTerminalFocused(true); renderer.current?.setFocused(true); refreshAutomationProbeContext(); luaAutomation.current?.update(luaAutomationSnapshot()); }, onBlur: () => { activeSession()?.setTerminalFocused(false); renderer.current?.setFocused(false); cancelAutomationProbeInput('canvas-blur'); refreshAutomationProbeContext(); luaAutomation.current?.update(luaAutomationSnapshot()); }, onWheel: (event: WheelEvent<HTMLCanvasElement>) => { const terminal = activeSession()?.terminal; if (!terminal || event.deltaY === 0) { scrollIntentRef.current = false; return; } if (sendMouse(event, event.deltaY < 0 ? 'wheel-up' : 'wheel-down')) { scrollIntentRef.current = false; return; } event.preventDefault(); if (terminal.buffer.active === terminal.buffer.normal) { const from = terminal.buffer.active.viewportY; terminal.scrollLines(Math.sign(event.deltaY) * 3); const to = terminal.buffer.active.viewportY; if (to === from) scrollIntentRef.current = false; else if (smoothScrollbackRef.current) renderer.current?.beginScroll(from, to); } else { scrollIntentRef.current = false; } }, onMouseDown: (event: MouseEvent<HTMLCanvasElement>) => { event.currentTarget.focus(); renderer.current?.cancelScroll(); const terminal = activeSession()?.terminal; const point = terminal ? cell(event) : null; if (event.button === 1 && event.ctrlKey && point) { linkClick.current = linkAtPoint(point); if (linkClick.current) { event.preventDefault(); renderer.current!.setSelection(linkClick.current.selection); return; } } if (terminal && ((copyMode.current && event.button === 0) || event.button === 1)) { if (point) { event.preventDefault(); copyStart.current = copyPoint(point); renderer.current!.setSelection({ start: copyStart.current, end: copyStart.current }); } return; } if (event.button <= 2 && sendMouse(event, 'press', event.button as 0|1|2)) pressed.current.add(event.button); }, onMouseMove: (event: MouseEvent<HTMLCanvasElement>) => { const terminal = activeSession()?.terminal; if (linkClick.current) { const point = event.ctrlKey ? cell(event) : null; const link = point ? linkAtPoint(point) : null; renderer.current!.setSelection(link?.url === linkClick.current.url ? linkClick.current.selection : null); return; } if (terminal && copyStart.current && event.buttons) { const point = cell(event); if (point) renderer.current!.setSelection({ start: copyStart.current, end: copyPoint(point) }); return; } const tracking = terminal?.modes.mouseTrackingMode as MouseTrackingMode | undefined; if (tracking && tracking !== 'none' && !(tracking === 'drag' && pressed.current.size === 0) && tracking !== 'x10' && tracking !== 'vt200') sendMouse(event, 'move', pressed.current.values().next().value as 0|1|2|undefined); }, onMouseUp: (event: MouseEvent<HTMLCanvasElement>) => { const terminal = activeSession()?.terminal; if (event.button === 1 && linkClick.current) { const clicked = linkClick.current; const point = event.ctrlKey ? cell(event) : null; const link = point ? linkAtPoint(point) : null; linkClick.current = null; renderer.current!.setSelection(null); if (link?.url === clicked.url) openBrowser(clicked.url); return; } if (terminal && copyStart.current) { const start = copyStart.current; const explicitCopy = copyMode.current; copyStart.current = null; copyMode.current = false; const point = cell(event); const end = point ? copyPoint(point) : null; if (end && (explicitCopy || end.row !== start.row || end.column !== start.column)) void copy(start, end).catch((reason) => onError(`Clipboard copy failed: ${String(reason)}`)); renderer.current!.setSelection(null); return; } if (event.button <= 2) { sendMouse(event, 'release', event.button as 0|1|2); pressed.current.delete(event.button); } }, onMouseLeave: (event: MouseEvent<HTMLCanvasElement>) => { if (linkClick.current) { linkClick.current = null; renderer.current!.setSelection(null); } for (const button of pressed.current) sendMouse(event, 'release', button as 0|1|2); pressed.current.clear(); }, onContextMenu: openNativeContextMenu, onPaste: (event: ClipboardEvent<HTMLCanvasElement>) => { const input = event.clipboardData.getData('text'); if (!input) return; event.preventDefault(); renderer.current?.cancelScroll(); activeSession()?.terminal?.scrollToBottom(); activeSession()?.sendInput(input); } } };
}
