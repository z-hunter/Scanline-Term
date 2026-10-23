import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { LuaAutomationStatus } from '../terminal/lua-automation';

const emptyStatus: LuaAutomationStatus = { state: 'loading', configPath: null, error: null, diagnostics: [] };
const visibleStatus = (status: LuaAutomationStatus): LuaAutomationStatus => ({
  ...status,
  error: status.error?.slice(0, 500) ?? null,
  diagnostics: status.diagnostics.slice(-5).map((line) => line.slice(0, 500)),
});

export function LuaAutomationPanel() {
  const [status, setStatus] = useState<LuaAutomationStatus>(emptyStatus);
  const tauri = isTauri();
  const mounted = useRef(false);
  const generation = useRef(0);
  const busy = useRef(false);
  const refresh = useCallback(async () => {
    if (!tauri || busy.current) return;
    busy.current = true;
    const request = generation.current;
    try {
      const current = await invoke<LuaAutomationStatus>('lua_automation_status');
      if (mounted.current && generation.current === request) setStatus(visibleStatus(current));
    } catch (reason) {
      if (mounted.current && generation.current === request) setStatus({ state: 'error', configPath: null, error: String(reason).slice(0, 500), diagnostics: [] });
    } finally {
      busy.current = false;
    }
  }, [tauri]);
  useEffect(() => {
    generation.current += 1;
    mounted.current = true;
    if (!tauri) {
      setStatus({ state: 'disabled', configPath: null, error: null, diagnostics: [] });
      return () => { mounted.current = false; generation.current += 1; };
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => { mounted.current = false; generation.current += 1; window.clearInterval(timer); };
  }, [refresh, tauri]);
  const reload = async () => {
    if (!tauri || busy.current) return;
    busy.current = true;
    const request = generation.current;
    setStatus((current) => ({ ...current, state: 'loading', error: null }));
    try {
      const current = await invoke<LuaAutomationStatus>('lua_automation_reload');
      if (mounted.current && generation.current === request) setStatus(visibleStatus(current));
    } catch (reason) {
      if (mounted.current && generation.current === request) setStatus({ state: 'error', configPath: null, error: String(reason).slice(0, 500), diagnostics: [] });
    } finally {
      busy.current = false;
      if (mounted.current) void refresh();
    }
  };

  return <div className="host-setting-block lua-automation-status" aria-live="polite">
    <span className="host-setting-label">Lua automation: {!tauri ? 'unavailable outside the Windows app' : status.state}</span>
    <span>{status.configPath ?? 'No configuration file loaded'}</span>
    {status.error && <span role="alert">{status.error}</span>}
    {status.diagnostics.map((line, index) => <span key={`${index}-${line}`}>{line}</span>)}
    <button type="button" onClick={() => void reload()} disabled={!tauri || status.state === 'loading'}>Reload Lua Configuration</button>
  </div>;
}
