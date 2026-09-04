/* eslint-disable react-hooks/refs */
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type MouseEvent, type WheelEvent } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { CRTSettings } from '../crt/CRTFilter';
import type { Resolution } from './TerminalRenderer';
import { TerminalRenderer, terminalAverageColor, terminalDimensions, type CopyPoint, type TabColor } from './TerminalRenderer';
import { TerminalSession, initialProfile, type TerminalLaunch, type TerminalSize } from './TerminalSession';
import { terminalKey } from './terminal-input';
import { terminalMouse, type MouseTrackingMode } from './terminal-mouse';
import { win32InputKey } from '../win32-input';

export type TerminalTab = { id: string; ordinal: number; title: string; status: 'starting' | 'running' | 'exited' | 'failed' } & TabColor;
type SessionRecord = { tab: TerminalTab; session: TerminalSession; inputLocked: boolean };

export function adjacentTabId(tabs: TerminalTab[], id: string): string | null {
  const index = tabs.findIndex((tab) => tab.id === id);
  return index < 0 ? null : tabs[index + 1]?.id ?? tabs[index - 1]?.id ?? null;
}

export function tabIdAtOrdinal(tabs: TerminalTab[], ordinal: number): string | null {
  return tabs.find((tab) => tab.ordinal === ordinal)?.id ?? null;
}

export function useTerminal({ settings, resolution, onError, onToggleSettings, onToggleAi }: { settings: CRTSettings; resolution: Resolution; onError: (message: string) => void; onToggleSettings: () => void; onToggleAi?: () => void }) {
  const [live, setLive] = useState(false); const [size, setSize] = useState<TerminalSize>({ cols: 0, rows: 0 }); const [fonts, setFonts] = useState(['Consolas']); const [tabs, setTabs] = useState<TerminalTab[]>([]); const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const renderer = useRef<TerminalRenderer | null>(null); if (!renderer.current) renderer.current = new TerminalRenderer();
  const settingsRef = useRef(settings); const resolutionRef = useRef(resolution); const outputRef = useRef<HTMLCanvasElement | null>(null); const sessions = useRef(new Map<string, SessionRecord>()); const tabsRef = useRef<TerminalTab[]>([]); const activeRef = useRef<string | null>(null); const nextOrdinal = useRef(1); const colorFrames = useRef(new Map<string, number>()); const pressed = useRef(new Set<number>()); const copyStart = useRef<CopyPoint | null>(null); const copyMode = useRef(false); const menu = useRef(false); const fullscreen = useRef(false); const closing = useRef(new Set<string>()); const onErrorRef = useRef(onError);
  settingsRef.current = settings; resolutionRef.current = resolution; tabsRef.current = tabs; activeRef.current = activeSessionId; onErrorRef.current = onError;
  const updateTab = useCallback((id: string, update: (tab: TerminalTab) => TerminalTab) => setTabs((current) => current.map((tab) => tab.id === id ? update(tab) : tab)), []);
  const refreshTabColor = useCallback((id: string) => {
    if (colorFrames.current.has(id)) return;
    const frame = window.requestAnimationFrame(() => {
      colorFrames.current.delete(id);
      const terminal = sessions.current.get(id)?.session.terminal;
      if (!terminal) return;
      const color = terminalAverageColor(terminal, initialProfile(settingsRef.current.colorProfile));
      updateTab(id, (current) => ({ ...current, ...color }));
    });
    colorFrames.current.set(id, frame);
  }, [updateTab]);
  const selectSession = useCallback((id: string) => {
    const record = sessions.current.get(id); if (!record) return;
    activeRef.current = id; setActiveSessionId(id); renderer.current!.bindTerminal(record.session.terminal); renderer.current!.setSelection(null); pressed.current.clear(); copyStart.current = null; copyMode.current = false; setLive(record.session.live); setSize(record.session.size);
  }, []);
  const openSession = useCallback((launch?: TerminalLaunch) => {
    if (!isTauri()) return;
    const id = crypto.randomUUID(); const ordinal = nextOrdinal.current++; const initialColor = initialProfile(settingsRef.current.colorProfile); const tab: TerminalTab = { id, ordinal, title: `${ordinal}. Starting`, status: 'starting', background: initialColor.background, foreground: initialColor.foreground };
    const session = new TerminalSession(id, onError, (nextLive, nextSize) => { if (activeRef.current === id) { setLive(nextLive); setSize(nextSize); } }, () => { const record = sessions.current.get(id); if (record) record.tab.status = 'exited'; updateTab(id, (current) => ({ ...current, status: 'exited' })); }, () => refreshTabColor(id), (title) => updateTab(id, (current) => ({ ...current, title: `${ordinal}. ${title}` })), (name) => updateTab(id, (current) => ({ ...current, title: `${ordinal}. ${name}` })));
    sessions.current.set(id, { tab, session, inputLocked: false }); setTabs((current) => [...current, tab]); selectSession(id);
    const source = renderer.current!.sourceCanvas; const dimensions = terminalDimensions(source.width || resolutionRef.current.width || 1, source.height || resolutionRef.current.height || 1, settingsRef.current.consoleFontSize, settingsRef.current.consoleFont);
    const validLaunch = launch && typeof launch === 'object' && !('nativeEvent' in launch) && ('command' in launch || 'cwd' in launch) ? { command: typeof launch.command === 'string' ? launch.command : null, cwd: typeof launch.cwd === 'string' ? launch.cwd : null } : undefined;
    const starting = session.start(dimensions, initialProfile(settingsRef.current.colorProfile), validLaunch); renderer.current!.bindTerminal(session.terminal);
    void starting.then((shellName) => updateTab(id, (current) => current.status === 'exited' ? current : shellName ? { ...current, title: `${ordinal}. ${session.title ?? shellName}`, status: 'running' } : { ...current, title: `${ordinal}. Failed`, status: 'failed' }));
  }, [onError, refreshTabColor, selectSession, updateTab]);
  const closeSession = useCallback(async (id: string) => {
    const record = sessions.current.get(id); if (!record || (tabsRef.current.find((tab) => tab.id === id)?.status === 'starting' && record.session.live) || closing.current.has(id)) return;
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
    closing.current.delete(id); sessions.current.delete(id); setTabs((current) => current.filter((tab) => tab.id !== id));
    if (sessions.current.size === 0) {
      tabsRef.current = tabsRef.current.filter((tab) => tab.id !== id);
      try { await getCurrentWindow().close(); } catch (reason) { onError(`Could not close application: ${String(reason)}`); }
      return;
    }
    if (activeRef.current === id) {
      const surviving = tabsRef.current.filter((tab) => tab.id === id || sessions.current.has(tab.id));
      const nextId = adjacentTabId(surviving, id);
      tabsRef.current = tabsRef.current.filter((tab) => tab.id !== id);
      const targetId = (nextId && sessions.current.has(nextId)) ? nextId : sessions.current.keys().next().value;
      if (targetId) selectSession(targetId);
    } else {
      tabsRef.current = tabsRef.current.filter((tab) => tab.id !== id);
    }
  }, [onError, selectSession, updateTab]);
  useEffect(() => { if (!isTauri()) return; void invoke<string[]>('list_monospace_fonts').then((items) => setFonts([...new Set(['Consolas', ...items])])).catch((reason) => onError(`Could not list system fonts: ${String(reason)}`)); }, [onError]);
  useEffect(() => { for (const id of sessions.current.keys()) refreshTabColor(id); }, [refreshTabColor, settings.colorProfile]);
  useEffect(() => {
    let active = true;
    const activeSessions = sessions.current;
    const start = window.setTimeout(() => {
      void invoke<TerminalLaunch>('initial_terminal_launch')
        .then((launch) => {
          if (!active) return;
          openSession(launch);
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
      for (const frame of colorFrames.current.values()) window.cancelAnimationFrame(frame);
      colorFrames.current.clear();
      for (const { session } of activeSessions.values()) void session.close().catch((reason) => onErrorRef.current(`Terminal close failed: ${String(reason)}`));
      activeSessions.clear();
      renderer.current!.dispose();
    };
  }, [openSession]);
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    void listen<TerminalLaunch>('terminal-launch', (event) => openSession(event.payload)).then((cleanup) => { unlisten = cleanup; }).catch((reason) => onError(`Could not receive terminal launch: ${String(reason)}`));
    return () => unlisten?.();
  }, [onError, openSession]);
  const resizeSource = useCallback((output: HTMLCanvasElement) => { outputRef.current = output; renderer.current!.resizeSource(resolutionRef.current, output); const source = renderer.current!.sourceCanvas; const dimensions = terminalDimensions(source.width, source.height, settingsRef.current.consoleFontSize, settingsRef.current.consoleFont); for (const { session } of sessions.current.values()) session.resize(dimensions); }, []);
  useEffect(() => { const output = outputRef.current; if (output) resizeSource(output); }, [resizeSource, settings.consoleFont, settings.consoleFontSize, resolution]);
  useEffect(() => { renderer.current!.markDirty(); }, [settings.colorProfile, settings.consoleFont, settings.consoleFontSize]);
  const activeSession = () => activeRef.current ? sessions.current.get(activeRef.current)?.session : undefined;
  const keyboardSession = useCallback(() => document.activeElement instanceof Element && document.activeElement.closest('.ai-panel') ? undefined : activeSession(), []);
  const cell = (event: MouseEvent<HTMLCanvasElement> | WheelEvent<HTMLCanvasElement>) => renderer.current!.cellAtPoint(event.clientX, event.clientY, event.currentTarget, settingsRef.current);
  const copyPoint = (point: { col: number; row: number }): CopyPoint => { const terminal = activeSession()?.terminal; if (!terminal) return { row: 0, column: 0 }; return { row: Math.max(terminal.buffer.active.viewportY, terminal.buffer.active.viewportY + point.row - 1), column: Math.max(0, point.col - 1) }; };
  const sendMouse = (event: MouseEvent<HTMLCanvasElement> | WheelEvent<HTMLCanvasElement>, action: Parameters<typeof terminalMouse>[0]['action'], button?: 0 | 1 | 2) => { const session = activeSession(); const terminal = session?.terminal; const tracking = terminal?.modes.mouseTrackingMode as MouseTrackingMode | undefined; if (!session || !terminal || !tracking || tracking === 'none' || (tracking === 'x10' && (action !== 'press' || event.ctrlKey || event.altKey || event.shiftKey)) || (tracking === 'vt200' && action === 'move')) return false; const point = cell(event); if (!point) return false; event.preventDefault(); session.sendInput(terminalMouse({ ...point, action, button, sgr: session.sgrMouseMode, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey })); return true; };
  const copy = async (start: CopyPoint, end: CopyPoint) => { const terminal = activeSession()?.terminal; if (!terminal) return; const [first,last] = start.row < end.row || start.row === end.row && start.column <= end.column ? [start,end] : [end,start]; const text = Array.from({ length: last.row - first.row + 1 }, (_, index) => { const row = first.row + index; return terminal.buffer.active.getLine(row)?.translateToString(index === last.row - first.row, row === first.row ? first.column : 0, row === last.row ? last.column + 1 : terminal.cols) ?? ''; }).join('\r\n').replace(/(?:\r\n|\r|\n)$/, ''); if (text) await navigator.clipboard.writeText(text); };
  useEffect(() => { const down = async (event: KeyboardEvent) => { if (event.target instanceof Element && event.target.closest('.settings-panel, .terminal-tabs, .new-tab-button')) return; const session = keyboardSession(); const terminal = session?.terminal; if (event.key === 'ContextMenu') menu.current = true; if (menu.current && event.code === 'KeyS') { event.preventDefault(); if (!event.repeat) onToggleSettings(); return; } if (menu.current && event.code === 'KeyA') { event.preventDefault(); if (!event.repeat) onToggleAi?.(); return; } if (menu.current && event.code === 'KeyV') { event.preventDefault(); if (!event.repeat) navigator.clipboard.readText().then((input) => session?.sendInput(input)).catch((reason) => onError(`Clipboard paste failed: ${String(reason)}`)); return; } if (menu.current && event.code === 'KeyC') { event.preventDefault(); if (!event.repeat) copyMode.current = true; return; } if (menu.current && event.code === 'KeyN') { event.preventDefault(); if (!event.repeat) openSession(); return; } if (menu.current && /^Digit[1-9]$/.test(event.code)) { event.preventDefault(); if (!event.repeat) { const id = tabIdAtOrdinal(tabsRef.current, Number(event.code.at(-1))); if (id) selectSession(id); } return; } if (menu.current && (event.code === 'PageUp' || event.code === 'PageDown')) { event.preventDefault(); if (terminal && terminal.buffer.active === terminal.buffer.normal) terminal.scrollLines((event.code === 'PageUp' ? -1 : 1) * (terminal.rows - 1)); return; } if (event.altKey && event.key === 'Enter' && isTauri()) { event.preventDefault(); fullscreen.current = true; if (!event.repeat) try { const window = getCurrentWindow(); await window.setFullscreen(!(await window.isFullscreen())); } catch (reason) { onError(`Fullscreen toggle failed: ${String(reason)}`); } return; } if (!session?.live || !terminal) return; const input = session.win32InputMode ? win32InputKey(event, true) : terminalKey(event, terminal.modes); event.preventDefault(); if (input) { terminal.scrollToBottom(); session.sendInput(input); } }; const up = (event: KeyboardEvent) => { if (event.target instanceof Element && event.target.closest('.settings-panel, .terminal-tabs, .new-tab-button')) return; if (event.key === 'ContextMenu') menu.current = false; if (fullscreen.current && event.key === 'Enter') { fullscreen.current = false; event.preventDefault(); return; } const session = keyboardSession(); if (!session?.live || !session.terminal) return; event.preventDefault(); if (session.win32InputMode) session.sendInput(win32InputKey(event, false)); }; window.addEventListener('keydown', down, true); window.addEventListener('keyup', up, true); return () => { window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); }; }, [keyboardSession, onError, onToggleAi, onToggleSettings, openSession, selectSession]);
  return { renderer: renderer.current, live, size, fonts, tabs, activeSessionId, openSession, selectSession, closeSession, resizeSource, canvasProps: { onWheel: (event: WheelEvent<HTMLCanvasElement>) => { const terminal = activeSession()?.terminal; if (!terminal || event.deltaY === 0) return; if (sendMouse(event, event.deltaY < 0 ? 'wheel-up' : 'wheel-down')) return; event.preventDefault(); if (terminal.buffer.active === terminal.buffer.normal) terminal.scrollLines(Math.sign(event.deltaY) * 3); }, onMouseDown: (event: MouseEvent<HTMLCanvasElement>) => { const terminal = activeSession()?.terminal; if (terminal && ((copyMode.current && event.button === 0) || event.button === 1)) { const point = cell(event); if (point) { event.preventDefault(); copyStart.current = copyPoint(point); renderer.current!.setSelection({ start: copyStart.current, end: copyStart.current }); } return; } if (event.button <= 2 && sendMouse(event, 'press', event.button as 0|1|2)) pressed.current.add(event.button); }, onMouseMove: (event: MouseEvent<HTMLCanvasElement>) => { const terminal = activeSession()?.terminal; if (terminal && copyStart.current && event.buttons) { const point = cell(event); if (point) renderer.current!.setSelection({ start: copyStart.current, end: copyPoint(point) }); return; } const tracking = terminal?.modes.mouseTrackingMode as MouseTrackingMode | undefined; if (tracking && tracking !== 'none' && !(tracking === 'drag' && pressed.current.size === 0) && tracking !== 'x10' && tracking !== 'vt200') sendMouse(event, 'move', pressed.current.values().next().value as 0|1|2|undefined); }, onMouseUp: (event: MouseEvent<HTMLCanvasElement>) => { const terminal = activeSession()?.terminal; if (terminal && copyStart.current) { const start = copyStart.current; copyStart.current = null; copyMode.current = false; const point = cell(event); if (point) void copy(start, copyPoint(point)).catch((reason) => onError(`Clipboard copy failed: ${String(reason)}`)); renderer.current!.setSelection(null); return; } if (event.button <= 2) { sendMouse(event, 'release', event.button as 0|1|2); pressed.current.delete(event.button); } }, onMouseLeave: (event: MouseEvent<HTMLCanvasElement>) => { for (const button of pressed.current) sendMouse(event, 'release', button as 0|1|2); pressed.current.clear(); }, onContextMenu: (event: MouseEvent<HTMLCanvasElement>) => event.preventDefault(), onPaste: (event: ClipboardEvent<HTMLCanvasElement>) => { const input = event.clipboardData.getData('text'); if (!input) return; event.preventDefault(); activeSession()?.terminal?.scrollToBottom(); activeSession()?.sendInput(input); } } };
}
