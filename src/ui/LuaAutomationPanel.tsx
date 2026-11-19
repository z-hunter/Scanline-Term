import { revealItemInDir } from '@tauri-apps/plugin-opener';
import type { LuaAutomationStatus } from '../terminal/lua-automation';

export function LuaAutomationPanel({ status, reload, onError, available }: {
  status: LuaAutomationStatus;
  reload: () => Promise<void>;
  onError: (message: string) => void;
  available: boolean;
}) {
  const openConfigFolder = async () => {
    if (!status.configPath) {
      onError('No Lua configuration file is loaded.');
      return;
    }
    try {
      await revealItemInDir(status.configPath);
    } catch (reason) {
      onError(`Could not open Lua configuration folder: ${String(reason)}`);
    }
  };

  return <div className="host-setting-block lua-automation-status" aria-live="polite">
    <span className="host-setting-label">Lua automation: {available ? status.state : 'unavailable outside the Windows app'}</span>
    <div className="lua-automation-actions">
      <span className="glass-button-recess"><button type="button" onClick={() => void reload()} disabled={!available || status.state === 'loading'}>Reload config</button></span>
      <span className="glass-button-recess"><button type="button" aria-label="Open Lua config folder" title="Open Lua config folder" onClick={() => void openConfigFolder()}><svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 8V5.5A1.5 1.5 0 0 1 4 4h4l2 2h6a1.5 1.5 0 0 1 1.5 1.5V9" /><path d="M2.5 9.5h15l-1.7 5.7a1.5 1.5 0 0 1-1.4 1H4.7a1.5 1.5 0 0 1-1.4-1L2 11.3a1.5 1.5 0 0 1 1.4-1.8h1.7" /></svg></button></span>
    </div>
  </div>;
}
