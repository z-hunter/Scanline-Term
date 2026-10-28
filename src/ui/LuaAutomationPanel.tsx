import { openPath } from '@tauri-apps/plugin-opener';
import type { LuaAutomationStatus } from '../terminal/lua-automation';

export function LuaAutomationPanel({ status, reload, onError, available }: {
  status: LuaAutomationStatus;
  reload: () => Promise<void>;
  onError: (message: string) => void;
  available: boolean;
}) {
  const openConfig = async () => {
    if (!status.configPath) {
      onError('No Lua configuration file is loaded.');
      return;
    }
    try {
      await openPath(status.configPath);
    } catch (reason) {
      onError(`Could not open Lua configuration: ${String(reason)}`);
    }
  };

  return <div className="host-setting-block lua-automation-status" aria-live="polite">
    <span className="host-setting-label">Lua automation: {available ? status.state : 'unavailable outside the Windows app'}</span>
    <div className="lua-automation-actions">
      <span className="glass-button-recess"><button type="button" onClick={() => void reload()} disabled={!available || status.state === 'loading'}>Reload config</button></span>
      <span className="glass-button-recess"><button type="button" onClick={() => void openConfig()}>Edit config</button></span>
    </div>
  </div>;
}
