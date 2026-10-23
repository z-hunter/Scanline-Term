import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { ScreenProfile } from 'scanline-virtual-screen/core';
import { profileFromLegacyPreset, profileToRenderSettings } from 'scanline-virtual-screen/core';
import {
  AdvancedCRTSettingsSection,
  DisplaySettingsSection,
  SegmentedControl,
  Switch,
  TerminalSettingsSection,
} from 'scanline-virtual-screen/react';
import 'scanline-virtual-screen/react/styles.css';
import { BROWSER_FORM_FACTORS, RESOLUTIONS, type ResolutionId, type StoredSettings, type TabPlacement, type TabPresetState } from '../crt/settings';
import type { ShellInfo } from '../terminal/useTerminal';
import { LuaAutomationPanel } from './LuaAutomationPanel';

export function SettingsPanel({
  stored,
  setStored,
  monospaceFonts,
  shells,
  terminalSize,
  fps,
  appVersion,
  presetState = null,
  cursorStyleOverridden = false,
  presetNames = [],
  presetDisabled = false,
  browserTabActive = false,
  onLoadPreset = () => undefined,
  onSavePreset = () => undefined,
  onPresetNameChange = () => undefined,
  onOpenHome = () => undefined,
  onSetExplorerIntegrationEnabled = () => undefined,
  smoothScrollDiagnosticsEnabled = false,
  getSmoothScrollDiagnostics = () => '',
  geometryDiagnosticsEnabled = false,
  getGeometryDiagnostics = () => '',
}: {
  stored: StoredSettings;
  setStored: Dispatch<SetStateAction<StoredSettings>>;
  monospaceFonts: string[];
  shells: ShellInfo[];
  terminalSize: { cols: number; rows: number };
  fps: number;
  appVersion: string;
  presetState?: TabPresetState | null;
  cursorStyleOverridden?: boolean;
  presetNames?: string[];
  presetDisabled?: boolean;
  browserTabActive?: boolean;
  onLoadPreset?: (name: string) => void;
  onSavePreset?: (name: string) => void;
  onPresetNameChange?: (name: string) => void;
  onOpenHome?: () => void;
  onSetExplorerIntegrationEnabled?: (enabled: boolean) => void;
  smoothScrollDiagnosticsEnabled?: boolean;
  getSmoothScrollDiagnostics?: () => string;
  geometryDiagnosticsEnabled?: boolean;
  getGeometryDiagnostics?: () => string;
}) {
  const wheelBlockedKnobs = useRef(new Map<HTMLElement, { x: number; y: number }>()).current;
  const panelRef = useRef<HTMLElement>(null);
  const pointerPosition = useRef({ x: 0, y: 0 });
  const panelScrollTop = useRef<number | null>(null);
  const releaseKnobsOutsidePointer = (x: number, y: number) => {
    for (const [knob, blockedAt] of wheelBlockedKnobs) {
      const bounds = knob.getBoundingClientRect();
      const outside = (pointX: number, pointY: number) => pointX < bounds.left || pointX > bounds.right || pointY < bounds.top || pointY > bounds.bottom;
      if (outside(blockedAt.x, blockedAt.y) || outside(x, y)) wheelBlockedKnobs.delete(knob);
    }
  };
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const preventPanelScrollOverKnobs = (event: WheelEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const knob = target.closest<HTMLElement>('.knob');
      if (knob && knob.getAttribute('aria-disabled') !== 'true' && !wheelBlockedKnobs.has(knob)) event.preventDefault();
    };
    panel.addEventListener('wheel', preventPanelScrollOverKnobs, { capture: true, passive: false });
    return () => panel.removeEventListener('wheel', preventPanelScrollOverKnobs, true);
  }, [wheelBlockedKnobs]);
  const canSavePreset = Boolean(presetState && (presetState.dirty || presetState.draftName !== presetState.name));
  const [scrollDiagnosticsCopied, setScrollDiagnosticsCopied] = useState<boolean | null>(null);
  const [geometryDiagnosticsCopied, setGeometryDiagnosticsCopied] = useState<boolean | null>(null);
  const copySmoothScrollDiagnostics = () => void navigator.clipboard.writeText(getSmoothScrollDiagnostics()).then(() => setScrollDiagnosticsCopied(true)).catch(() => setScrollDiagnosticsCopied(false));
  const copyGeometryDiagnostics = () => void navigator.clipboard.writeText(getGeometryDiagnostics()).then(() => setGeometryDiagnosticsCopied(true)).catch(() => setGeometryDiagnosticsCopied(false));
  const screenProfile = profileFromLegacyPreset({ version: 1, resolution: stored.resolution, crt: stored.crt });
  const updateProfile = (profile: ScreenProfile) => setStored((current) => ({
    ...current,
    resolution: profile.virtualScreen.modeId as ResolutionId,
    crt: profileToRenderSettings(profile),
  }));

  return (
    <aside
      ref={panelRef}
      className="settings-panel"
      onWheelCapture={(event) => {
        pointerPosition.current = { x: event.clientX, y: event.clientY };
        const target = event.target;
        if (!(target instanceof Element)) return;
        const knob = target.closest<HTMLElement>('.knob');
        const panel = event.currentTarget;
        const panelWasScrolling = panelScrollTop.current !== null && panel.scrollTop !== panelScrollTop.current;
        panelScrollTop.current = panel.scrollTop;
        if (knob && (wheelBlockedKnobs.has(knob) || panelWasScrolling)) {
          wheelBlockedKnobs.set(knob, { x: event.clientX, y: event.clientY });
          event.stopPropagation();
        }
      }}
      onScrollCapture={(event) => {
        const scrollTop = event.currentTarget.scrollTop;
        if (scrollTop === panelScrollTop.current) return;
        panelScrollTop.current = scrollTop;
        const { x, y } = pointerPosition.current;
        const knob = document.elementFromPoint(x, y)?.closest<HTMLElement>('.knob');
        if (knob && event.currentTarget.contains(knob)) wheelBlockedKnobs.set(knob, { x, y });
      }}
      onPointerMoveCapture={(event) => {
        pointerPosition.current = { x: event.clientX, y: event.clientY };
        releaseKnobsOutsidePointer(event.clientX, event.clientY);
      }}
      onPointerLeave={(event) => releaseKnobsOutsidePointer(event.clientX, event.clientY)}
    >
      <header>
        <div className="settings-heading">
          <p className="eyebrow">SETTINGS</p>
          <button type="button" className="settings-home-button" data-testid="settings-home" aria-label="Open Scanline Term home" title="Open Scanline Term home" onClick={onOpenHome}>?</button>
        </div>
        <p className="display-status">{browserTabActive ? 'BROWSER TAB' : `CONSOLE BUFFER: ${terminalSize.cols} × ${terminalSize.rows} · FPS: ${fps}`}</p>
      </header>

      {!browserTabActive && <fieldset className={cursorStyleOverridden ? 'preset-controls cursor-style-overridden' : 'preset-controls'} disabled={presetDisabled}>
        <fieldset className="preset-picker">
          <legend>Presets</legend>
          <div className="preset-picker-row">
            <input
              value={presetState?.draftName ?? ''}
              placeholder={presetDisabled ? 'Terminal tabs only' : 'Preset name'}
              aria-label="Preset name"
              onChange={(event) => onPresetNameChange(event.target.value)}
            />
            <button type="button" data-testid="preset-save" disabled={!canSavePreset} onClick={() => onSavePreset(presetState?.draftName ?? '')}>Save</button>
          </div>
          <label className="preset-load-control">
            <select
              aria-label="Load preset"
              defaultValue=""
              onChange={(event) => {
                const name = event.target.value;
                event.currentTarget.value = '';
                if (name) onLoadPreset(name);
              }}
            >
              <option value="" disabled>Load preset…</option>
              {presetNames.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
        </fieldset>

        <DisplaySettingsSection value={screenProfile} modes={RESOLUTIONS} onChange={updateProfile} showChannelSwitch={false} />
        <TerminalSettingsSection
          value={screenProfile}
          fonts={monospaceFonts}
          onChange={updateProfile}
          smoothScrolling={{
            enabled: stored.smoothScrollback,
            tuiEnabled: stored.smoothTuiScrolling,
            onEnabledChange: (smoothScrollback) => setStored((current) => ({ ...current, smoothScrollback })),
            onTuiEnabledChange: (smoothTuiScrolling) => setStored((current) => ({ ...current, smoothTuiScrolling })),
          }}
        />
        {smoothScrollDiagnosticsEnabled && <div className="host-setting-block"><span className="host-setting-label">Smooth scroll diagnostics</span><button type="button" onClick={copySmoothScrollDiagnostics} data-testid="copy-smooth-scroll-diagnostics">{scrollDiagnosticsCopied === false ? 'Copy failed' : scrollDiagnosticsCopied ? 'Copied' : 'Copy log'}</button></div>}
        {geometryDiagnosticsEnabled && <div className="host-setting-block"><span className="host-setting-label">Terminal geometry diagnostics</span><button type="button" onClick={copyGeometryDiagnostics} data-testid="copy-geometry-diagnostics">{geometryDiagnosticsCopied === false ? 'Copy failed' : geometryDiagnosticsCopied ? 'Copied' : 'Copy log'}</button></div>}
        <AdvancedCRTSettingsSection value={screenProfile} onChange={updateProfile} />
      </fieldset>}

      {browserTabActive && <fieldset>
        <legend>Browser</legend>
        <label className="host-select-control">
          Browser form factor
          <select
            aria-label="Browser form factor"
            data-testid="browser-form-factor-select"
            value={stored.browserFormFactor}
            onChange={(event) => setStored((current) => ({ ...current, browserFormFactor: event.target.value as StoredSettings['browserFormFactor'] }))}
          >
            {BROWSER_FORM_FACTORS.map((factor) => <option key={factor.id} value={factor.id}>{factor.label}</option>)}
          </select>
        </label>
      </fieldset>}

      <fieldset>
        <legend>UI</legend>
        <Switch label="RMB menu in term." checked={stored.rmbMenuInTerm} onChange={(rmbMenuInTerm) => setStored((current) => ({ ...current, rmbMenuInTerm }))} />
        <Switch label="Tab switch animation" checked={stored.channelSwitchEffect} onChange={(channelSwitchEffect) => setStored((current) => ({ ...current, channelSwitchEffect }))} />
        <div className="host-setting-block">
          <span className="host-setting-label">Tab placement</span>
          <SegmentedControl
            value={stored.tabPlacement}
            options={[{ value: 'left', label: 'Left of monitor' }, { value: 'top', label: 'Above monitor' }]}
            onChange={(tabPlacement) => setStored((current) => ({ ...current, tabPlacement: tabPlacement as TabPlacement }))}
          />
        </div>
        <Switch label="Hide tabs bar" checked={stored.hideTabsBar} onChange={(hideTabsBar) => setStored((current) => ({ ...current, hideTabsBar }))} />
        {stored.hideTabsBar && <Switch label="...only if single tab" checked={stored.hideTabsBarOnlyIfSingleTab} onChange={(hideTabsBarOnlyIfSingleTab) => setStored((current) => ({ ...current, hideTabsBarOnlyIfSingleTab }))} />}
        <Switch label="Global hotkey: Win+~" checked={stored.globalHotkeyEnabled} onChange={(globalHotkeyEnabled) => setStored((current) => ({ ...current, globalHotkeyEnabled }))} />
        {stored.globalHotkeyEnabled && <Switch label="Slide from top" checked={stored.slideFromTop} onChange={(slideFromTop) => setStored((current) => ({ ...current, slideFromTop }))} />}
        <label className="host-select-control">
          Settings scale
          <select value={stored.settingsScale} onChange={(event) => setStored((current) => ({ ...current, settingsScale: Number(event.target.value) }))}>
            {[0.75, 0.9, 1, 1.1, 1.25, 1.5].map((scale) => <option key={scale} value={scale}>{Math.round(scale * 100)}%</option>)}
          </select>
        </label>
      </fieldset>

      <fieldset>
        <legend>System</legend>
        <LuaAutomationPanel />
        <label className="host-select-control">
          Default shell
          <select value={stored.defaultShell} onChange={(event) => setStored((current) => ({ ...current, defaultShell: event.target.value }))}>
            <option value="">Windows default (%ComSpec%)</option>
            {stored.defaultShell && !shells.some((shell) => shell.command === stored.defaultShell) && <option value={stored.defaultShell}>{stored.defaultShell} (unavailable)</option>}
            {shells.map((shell) => <option key={shell.command} value={shell.command}>{shell.name}</option>)}
          </select>
        </label>
        <Switch label="Check for updates automatically" checked={stored.autoUpdateEnabled} onChange={(autoUpdateEnabled) => setStored((current) => ({ ...current, autoUpdateEnabled }))} />
        <Switch label="Windows Explorer: Open with ScanlineTerm here" checked={stored.explorerIntegrationEnabled} onChange={onSetExplorerIntegrationEnabled} />
        <Switch label="Disable AI assistant" checked={stored.aiAssistantDisabled} onChange={(aiAssistantDisabled) => setStored((current) => ({ ...current, aiAssistantDisabled, ...(aiAssistantDisabled ? { showAiPanel: false } : {}) }))} />
        <Switch label="Enable MCP terminal mode" checked={stored.mcpEnabled} onChange={(mcpEnabled) => setStored((current) => ({ ...current, mcpEnabled }))} />
        {stored.mcpEnabled && <Switch label="Keep MCP tabs open" checked={stored.mcpKeepTabsOpen} onChange={(mcpKeepTabsOpen) => setStored((current) => ({ ...current, mcpKeepTabsOpen }))} />}
      </fieldset>

      <footer>v{appVersion} (c) Michael Voitovich, 2026</footer>
    </aside>
  );
}
