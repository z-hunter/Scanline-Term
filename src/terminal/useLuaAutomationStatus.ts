import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { LuaAutomationDiagnostic, LuaAutomationStatus } from './lua-automation';

const emptyStatus: LuaAutomationStatus = { state: 'loading', configPath: null, error: null, diagnostics: [] };

function sameDiagnostic(left: LuaAutomationDiagnostic, right: LuaAutomationDiagnostic): boolean {
  return left.level === right.level && left.message === right.message;
}

function newDiagnostics(previous: LuaAutomationDiagnostic[], current: LuaAutomationDiagnostic[]): LuaAutomationDiagnostic[] {
  if (previous.length <= current.length && previous.every((line, index) => sameDiagnostic(line, current[index]))) return current.slice(previous.length);
  for (let overlap = Math.min(previous.length, current.length); overlap > 0; overlap -= 1) {
    if (previous.slice(-overlap).every((line, index) => sameDiagnostic(line, current[index]))) return current.slice(overlap);
  }
  return current;
}

export function useLuaAutomationStatus(onError: (message: string) => void) {
  const [status, setStatus] = useState<LuaAutomationStatus>(emptyStatus);
  const tauri = isTauri();
  const mounted = useRef(false);
  const generation = useRef(0);
  const busy = useRef(false);
  const previousDiagnostics = useRef<LuaAutomationDiagnostic[]>([]);
  const previousErrors = useRef(new Set<string>());
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const receive = useCallback((current: LuaAutomationStatus) => {
    if (!mounted.current) return;
    const error = current.error?.slice(0, 500) ?? null;
    const diagnostics = current.diagnostics.map((diagnostic) => ({ ...diagnostic, message: diagnostic.message.slice(0, 500) }));
    const fresh = newDiagnostics(previousDiagnostics.current, diagnostics);
    previousDiagnostics.current = diagnostics;
    for (const diagnostic of fresh) {
      const { level, message } = diagnostic;
      if (level === 'info') console.info(`[Lua] ${message}`);
      else console.error(`[Lua] ${message}`);
    }
    const errors = new Set(diagnostics.filter((diagnostic) => diagnostic.level === 'error').map((diagnostic) => diagnostic.message));
    if (error) errors.add(error);
    for (const message of errors) {
      if (!previousErrors.current.has(message)) {
        if (!diagnostics.some((diagnostic) => diagnostic.message === message && diagnostic.level === 'error')) console.error(`[Lua] ${message}`);
        onErrorRef.current(`Lua: ${message}`);
      }
    }
    previousErrors.current = errors;
    setStatus({ ...current, error, diagnostics });
  }, []);

  const refresh = useCallback(async () => {
    if (!tauri || busy.current) return;
    busy.current = true;
    const request = generation.current;
    try {
      const current = await invoke<LuaAutomationStatus>('lua_automation_status');
      if (mounted.current && request === generation.current) receive(current);
    } catch (reason) {
      if (!mounted.current || request !== generation.current) return;
      const message = `Lua automation status failed: ${String(reason).slice(0, 500)}`;
      if (!previousErrors.current.has(message)) onErrorRef.current(message);
      previousErrors.current = new Set([message]);
      setStatus({ state: 'error', configPath: null, error: message, diagnostics: [] });
      previousDiagnostics.current = [];
    } finally {
      busy.current = false;
    }
  }, [receive, tauri]);

  const reload = useCallback(async () => {
    if (!tauri || busy.current) return;
    busy.current = true;
    const request = generation.current;
    previousDiagnostics.current = [];
    previousErrors.current.clear();
    if (mounted.current) setStatus((current) => ({ ...current, state: 'loading', error: null }));
    try {
      const current = await invoke<LuaAutomationStatus>('lua_automation_reload');
      if (mounted.current && request === generation.current) receive(current);
    } catch (reason) {
      if (!mounted.current || request !== generation.current) return;
      const message = `Lua configuration reload failed: ${String(reason).slice(0, 500)}`;
      if (!previousErrors.current.has(message)) onErrorRef.current(message);
      previousErrors.current = new Set([message]);
      setStatus({ state: 'error', configPath: null, error: message, diagnostics: [] });
      previousDiagnostics.current = [];
    } finally {
      busy.current = false;
    }
  }, [receive, tauri]);

  useEffect(() => {
    mounted.current = true;
    generation.current += 1;
    if (!tauri) {
      setStatus({ state: 'disabled', configPath: null, error: null, diagnostics: [] });
      return () => { mounted.current = false; generation.current += 1; };
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => { mounted.current = false; generation.current += 1; window.clearInterval(timer); };
  }, [refresh, tauri]);

  return { status, reload, available: tauri };
}
