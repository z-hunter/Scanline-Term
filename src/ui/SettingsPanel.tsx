import { useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { createPortal } from 'react-dom';
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
import { shellIdentity, splitShellCatalog } from '../terminal/shells';
import type { LuaAutomationStatus } from '../terminal/lua-automation';
import { LuaAutomationPanel } from './LuaAutomationPanel';

const settingHelp: Record<string, string> = {
  'Preset name': 'Name the current terminal display and CRT settings preset.',
  'Load preset': 'Apply a saved preset to the active terminal tab.',
  'Virtual resolution': 'Set the pixel resolution used to render the virtual screen.',
  'Anti-moiré pixels': 'Applies anti-moiré smoothing after CRT effects to reduce interference from fine pixel and scanline patterns.',
  'Pixel smoothing': 'Smooths the source pixels before CRT effects are rendered. Turn it off to keep enlarged pixels crisp.',
  'ANSI color profile': 'Choose the ANSI palette used by terminal applications.',
  'Console font': 'Choose the typeface used to render terminal text.',
  'Size': 'Set the terminal font size in pixels.',
  'Cell width ±px': 'Adjust the width of each terminal character cell.',
  'Cell height ±px': 'Adjust the height of each terminal character cell.',
  'Smooth terminal scrolling': 'Animate normal terminal scrollback instead of jumping between rows.',
  'Heuristic TUI scrolling': 'Detect and smoothly animate scrolling regions used by terminal applications.',
  'Cursor style': 'Choose whether the terminal cursor is a block, underline, or bar.',
  'Cursor blink': 'Make the terminal cursor blink.',
  'Cursor brightness': 'Set how brightly the terminal cursor is drawn.',
  'CRT Emulation': 'Enable the CRT display effects and their detailed controls.',
  'Color mode': 'Choose full color, monochrome, or a colored phosphor display.',
  'Surface desat.': 'Reduce color saturation across the phosphor surface.',
  'Color mask': 'Simulates the RGB phosphor stripes or dots used in color CRTs. Three electron beams excite red, green, and blue phosphors, which combine to produce color; the mask recreates their physical pattern and gaps for characteristic CRT color and texture. Only applies in Color mode.',
  'Strength': 'Set how strongly the phosphor color mask is visible.',
  'Color mask strength': 'Set how strongly the phosphor color mask is visible.',
  'Background desaturation': 'Reduce saturation in the background behind a colored phosphor image.',
  'Edge misconvergence': 'Offset color channels near the screen edges, as in a misaligned CRT.',
  'Edge falloff': 'Set how quickly edge misconvergence fades toward the screen center.',
  'Brightness': 'Adjust the overall brightness of the final image.',
  'Contrast': 'Adjust the difference between dark and bright parts of the image.',
  'Phosphor / grain': 'Add subtle phosphor texture and film-like grain.',
  'Curvature': 'Bend the image to simulate a curved CRT screen.',
  'Vignette': 'Darken the image toward the edges.',
  'Scanline count': 'Set the number of horizontal scanlines.',
  'Scanline intensity': 'Set how visible the horizontal scanlines are.',
  'Beam modulation': 'Simulates changes in electron-beam intensity as it scans the phosphor screen; scanlines become thicker in brighter areas.',
  'Bloom': 'Adds a soft halo around bright image details, simulating how strongly excited phosphor spots could excite nearby phosphors.',
  'Soft': 'Use a soft, diffuse bloom shape.',
  'Spiral': 'Use a spiral sampling pattern for bloom.',
  'Screen glow': 'Sets the glow of the image diffusing through the CRT’s thick leaded glass.',
  'Glow radius': 'Set how far screen glow spreads beyond bright details.',
  'Ambient glass light': 'Add reflected ambient light across the display glass.',
  'Reflex-bar': 'Enable a moving reflection band across the screen glass.',
  'Intensity': 'Set the brightness of the glass reflection band.',
  'Vertical pos.': 'Set the vertical position of the reflection band.',
  'Width': 'Set the horizontal coverage of the reflection band.',
  'Height': 'Set the thickness of the reflection band.',
  'Phosphor trail': 'Simulates CRT phosphor persistence: sets how long the phosphor glow takes to fade after the image changes.',
  'Afterglow energy': 'Sets the initial brightness of the phosphor afterglow when image areas become darker. Higher energy makes the new trail brighter; Phosphor trail controls how long it fades.',
  'Trail intensity': 'Amplify or reduce the brightness of the phosphor trail.',
  'HV breathing': 'Simulates cathode breathing: bright images make the CRT raster expand slightly, as if the picture grows under the stronger beam load.',
  'Imperfect signal': 'Add subtle analog signal instability.',
  'Hum-bar': 'Add a faint horizontal brightness band associated with CRT power hum.',
  'Bezel glow': 'Choose whether screen light spills onto the bezel or reflects in the glass.',
  'Bezel thickness': 'Set the thickness of the simulated monitor frame.',
  'Bezel highlight': 'Set the brightness of highlights along the monitor frame.',
  'Monitor frame': 'Show the simulated physical monitor frame around the screen.',
  'Browser form factor': 'Choose the viewport aspect ratio used for browser tabs.',
  'RMB menu in term.': 'Show the context menu when right-clicking inside the terminal.',
  'Tab switch animation': 'Briefly rolls the image during tab changes, like a momentary loss of scan sync. Works with CRT emulation on or off.',
  'Tab placement': 'Place the tab bar to the left of or above the monitor.',
  'Hide tabs bar': 'Hide the tab bar to give the monitor more room.',
  '...only if single tab': 'Hide the tab bar only while there is one tab open.',
  'Global hotkey: Win+~': 'Allow Win+tilde to show or hide Scanline Term from other apps.',
  'Slide from top': 'Animate the app sliding down from the top when shown by its hotkey.',
  'Settings scale': 'Change the size of the settings panel controls and text.',
  'Default shell': 'Choose the shell started in new terminal tabs.',
  'Check for updates automatically': 'Check for new Scanline Term versions automatically.',
  'Windows Explorer: Open with ScanlineTerm here': 'Add a Windows Explorer menu action that opens the selected folder in Scanline Term.',
  'Disable AI assistant': 'Hide and disable the built-in Codex assistant.',
  'Enable MCP terminal mode': 'Allow MCP clients to create and control terminal tabs.',
  'Keep MCP tabs open': 'Keep MCP-owned tabs open after their client disconnects.',
  'Smooth scroll diagnostics': 'Copy diagnostic data used to investigate smooth scrolling behavior.',
  'Terminal geometry diagnostics': 'Copy measurements used to investigate terminal sizing and layout.',
  'Lua automation: loading': 'Lua automation status and configuration for terminal tabs. Lua scripts can extend terminal functionality.',
};

function settingLabelText(label: HTMLElement) {
  const copy = label.cloneNode(true) as HTMLElement;
  const ariaLabel = label.getAttribute('aria-label') ?? label.querySelector<HTMLElement>('[aria-label]')?.getAttribute('aria-label');
  const slider = label.matches('[role="slider"]') ? label : label.querySelector<HTMLElement>('[role="slider"]');
  copy.querySelectorAll('select, input, button, [role="slider"], output, .switch-toggle').forEach((control) => control.remove());
  const text = copy.textContent?.replace(/\s+/g, ' ').trim();
  return (text || slider?.getAttribute('aria-label') || ariaLabel || '').replace(/\s+/g, ' ').trim();
}

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
  defaultPresetName = 'default',
  showDefaultPreset = true,
  onDefaultPresetChange = () => undefined,
  managedSettingsReady = true,
  managedSettingsSaving = false,
  onSmoothScrollbackChange,
  smoothScrollDiagnosticsEnabled = false,
  getSmoothScrollDiagnostics = () => '',
  geometryDiagnosticsEnabled = false,
  getGeometryDiagnostics = () => '',
  luaAutomationStatus = { state: 'loading', configPath: null, error: null, diagnostics: [] },
  reloadLuaConfig = async () => undefined,
  luaAutomationAvailable = false,
  onError = () => undefined,
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
  defaultPresetName?: string;
  showDefaultPreset?: boolean;
  onDefaultPresetChange?: (name: string) => void;
  managedSettingsReady?: boolean;
  managedSettingsSaving?: boolean;
  onSmoothScrollbackChange?: (enabled: boolean) => void;
  smoothScrollDiagnosticsEnabled?: boolean;
  getSmoothScrollDiagnostics?: () => string;
  geometryDiagnosticsEnabled?: boolean;
  getGeometryDiagnostics?: () => string;
  luaAutomationStatus?: LuaAutomationStatus;
  reloadLuaConfig?: () => Promise<void>;
  luaAutomationAvailable?: boolean;
  onError?: (message: string) => void;
}) {
  const wheelBlockedKnobs = useRef(new Map<HTMLElement, { x: number; y: number }>()).current;
  const panelRef = useRef<HTMLElement>(null);
  const pointerPosition = useRef({ x: 0, y: 0 });
  const panelScrollTop = useRef<number | null>(null);
  const pointerOverSettings = useRef(false);
  const helpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [helpTooltip, setHelpTooltip] = useState<{ text: string; left: number; top: number } | null>(null);
  useEffect(() => () => { if (helpTimer.current) clearTimeout(helpTimer.current); }, []);
  const cancelSettingHelp = () => {
    if (helpTimer.current) clearTimeout(helpTimer.current);
    helpTimer.current = null;
    setHelpTooltip(null);
  };
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({ display: true, browser: true });
  const toggleSection = (id: string) => setExpandedSections((current) => ({ ...current, [id]: !current[id] }));
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
  useEffect(() => {
    const handleSectionShortcut = (event: KeyboardEvent) => {
      const panel = panelRef.current;
      const active = document.activeElement;
      if (!panel || !pointerOverSettings.current || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (active instanceof HTMLElement && (active.matches('input, textarea, select, [contenteditable="true"]') || active.closest('.custom-select-container'))) return;
      if (!/^[0-5]$/.test(event.key)) return;
      const section = panel.querySelector<HTMLElement>(`[data-section-number="${event.key}"]`);
      if (!section) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const id = section.dataset.sectionId;
      if (id && id !== 'presets') setExpandedSections((current) => current[id] ? current : { ...current, [id]: true });
      const panelTop = panel.getBoundingClientRect().top;
      const sectionTop = section.getBoundingClientRect().top;
      panel.scrollTo({ top: Math.max(0, panel.scrollTop + sectionTop - panelTop - 8), behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    };
    window.addEventListener('keydown', handleSectionShortcut, true);
    return () => window.removeEventListener('keydown', handleSectionShortcut, true);
  }, []);
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
      onPointerEnter={() => { pointerOverSettings.current = true; }}
      onPointerLeave={(event) => { pointerOverSettings.current = false; releaseKnobsOutsidePointer(event.clientX, event.clientY); cancelSettingHelp(); }}
      onPointerOverCapture={(event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const label = target.closest<HTMLElement>('label, .setting-label, .host-setting-label') ?? target.closest<HTMLElement>('[aria-label]');
        if (!label) { cancelSettingHelp(); return; }
        const name = settingLabelText(label);
        const text = settingHelp[name] ?? (name.startsWith('Lua automation:') ? 'Lua scripts can extend terminal functionality. This shows Lua automation status and configuration.' : undefined);
        if (!text) { cancelSettingHelp(); return; }
        if (helpTimer.current) clearTimeout(helpTimer.current);
        setHelpTooltip(null);
        helpTimer.current = setTimeout(() => {
          const bounds = label.getBoundingClientRect();
          setHelpTooltip({ text, left: Math.min(window.innerWidth - 320, Math.max(12, bounds.left)), top: Math.min(window.innerHeight - 96, bounds.bottom + 8) });
          helpTimer.current = null;
        }, 650);
      }}
      onPointerOutCapture={(event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const label = target.closest('label, .setting-label, .host-setting-label') ?? target.closest('[aria-label]');
        const related = event.relatedTarget;
        if (label && related instanceof Element && label.contains(related)) return;
        cancelSettingHelp();
      }}
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
        cancelSettingHelp();
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
    >
      <header>
        <div className="settings-heading">
          <p className="eyebrow">SETTINGS</p>
          <button type="button" className="settings-home-button" data-testid="settings-home" aria-label="Open Scanline Term home" title="Open Scanline Term home" onClick={onOpenHome}>?</button>
        </div>
        <p className="display-status">{browserTabActive ? 'BROWSER TAB' : `CONSOLE BUFFER: ${terminalSize.cols} × ${terminalSize.rows} · FPS: ${fps}`}</p>
      </header>

      {!browserTabActive && <fieldset className={cursorStyleOverridden ? 'preset-controls cursor-style-overridden' : 'preset-controls'}>
        <SettingsAccordionSection id="presets" number={0} title="Presets" icon="presets" pinned disabled={presetDisabled}>
          <div className="preset-picker">
            <div className="preset-picker-row">
              <input
                value={presetState?.draftName ?? ''}
                placeholder={presetDisabled ? 'Terminal tabs only' : 'Preset name'}
                aria-label="Preset name"
                onChange={(event) => onPresetNameChange(event.target.value)}
              />
              <span className="glass-button-recess"><button type="button" data-testid="preset-save" disabled={!canSavePreset} onClick={() => onSavePreset(presetState?.draftName ?? '')}>Save</button></span>
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
          </div>
        </SettingsAccordionSection>

        <SettingsAccordionSection id="display" number={1} title="Display" icon="display" expanded={Boolean(expandedSections.display)} disabled={presetDisabled} onToggle={() => toggleSection('display')}>
          <DisplaySettingsSection value={screenProfile} modes={RESOLUTIONS} onChange={updateProfile} showChannelSwitch={false} />
        </SettingsAccordionSection>
        <SettingsAccordionSection id="terminal" number={2} title="Terminal" icon="terminal" expanded={Boolean(expandedSections.terminal)} disabled={presetDisabled} onToggle={() => toggleSection('terminal')}>
          <TerminalSettingsSection
            value={screenProfile}
            fonts={monospaceFonts}
            onChange={updateProfile}
            smoothScrolling={{
              enabled: stored.smoothScrollback,
              tuiEnabled: stored.smoothTuiScrolling,
              onEnabledChange: onSmoothScrollbackChange ?? ((smoothScrollback) => setStored((current) => ({ ...current, smoothScrollback }))),
              onTuiEnabledChange: (smoothTuiScrolling) => setStored((current) => ({ ...current, smoothTuiScrolling })),
            }}
          />
          {smoothScrollDiagnosticsEnabled && <div className="host-setting-block"><span className="host-setting-label">Smooth scroll diagnostics</span><button type="button" onClick={copySmoothScrollDiagnostics} data-testid="copy-smooth-scroll-diagnostics">{scrollDiagnosticsCopied === false ? 'Copy failed' : scrollDiagnosticsCopied ? 'Copied' : 'Copy log'}</button></div>}
          {geometryDiagnosticsEnabled && <div className="host-setting-block"><span className="host-setting-label">Terminal geometry diagnostics</span><button type="button" onClick={copyGeometryDiagnostics} data-testid="copy-geometry-diagnostics">{geometryDiagnosticsCopied === false ? 'Copy failed' : geometryDiagnosticsCopied ? 'Copied' : 'Copy log'}</button></div>}
        </SettingsAccordionSection>
        <SettingsAccordionSection id="crt" number={3} title="CRT" icon="crt" expanded={Boolean(expandedSections.crt)} disabled={presetDisabled} onToggle={() => toggleSection('crt')}>
          <AdvancedCRTSettingsSection value={screenProfile} onChange={updateProfile} />
        </SettingsAccordionSection>
      </fieldset>}

      {browserTabActive && <SettingsAccordionSection id="browser" number={1} title="Browser" icon="browser" expanded={Boolean(expandedSections.browser)} onToggle={() => toggleSection('browser')}>
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
      </SettingsAccordionSection>}

      <SettingsAccordionSection id="ui" number={browserTabActive ? 2 : 4} title="UI" icon="ui" expanded={Boolean(expandedSections.ui)} onToggle={() => toggleSection('ui')}>
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
      </SettingsAccordionSection>

      <SettingsAccordionSection id="system" number={browserTabActive ? 3 : 5} title="System" icon="system" expanded={Boolean(expandedSections.system)} onToggle={() => toggleSection('system')}>
        <LuaAutomationPanel status={luaAutomationStatus} reload={reloadLuaConfig} onError={onError} available={luaAutomationAvailable} />
        {showDefaultPreset && <label className="host-select-control">
          Default preset for new tabs
          <select aria-label="Default preset for new tabs" data-testid="default-preset-select" value={defaultPresetName} disabled={!managedSettingsReady || managedSettingsSaving} onChange={(event) => onDefaultPresetChange(event.target.value)}>
            {presetNames.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>}
        <label className="host-select-control">
          Default shell
          <select value={stored.defaultShell} onChange={(event) => setStored((current) => ({ ...current, defaultShell: event.target.value }))}>
            <option value="">Windows default (%ComSpec%)</option>
            {stored.defaultShell && !shells.some((shell) => shellIdentity(shell) === stored.defaultShell) && <option value={stored.defaultShell}>{stored.defaultShell} (unavailable)</option>}
            <optgroup label="Detected shells">{splitShellCatalog(shells).automatic.map((shell) => <option key={shellIdentity(shell)} value={shellIdentity(shell)}>{shell.name}</option>)}</optgroup>
            {splitShellCatalog(shells).user.length > 0 && <optgroup label="Custom shells">{splitShellCatalog(shells).user.map((shell) => <option key={shellIdentity(shell)} value={shellIdentity(shell)}>{shell.name}</option>)}</optgroup>}
          </select>
        </label>
        <Switch label="Check for updates automatically" checked={stored.autoUpdateEnabled} onChange={(autoUpdateEnabled) => setStored((current) => ({ ...current, autoUpdateEnabled }))} />
        <Switch label="Windows Explorer: Open with ScanlineTerm here" checked={stored.explorerIntegrationEnabled} onChange={onSetExplorerIntegrationEnabled} />
        <Switch label="Disable AI assistant" checked={stored.aiAssistantDisabled} onChange={(aiAssistantDisabled) => setStored((current) => ({ ...current, aiAssistantDisabled, ...(aiAssistantDisabled ? { showAiPanel: false } : {}) }))} />
        <Switch label="Enable MCP terminal mode" checked={stored.mcpEnabled} onChange={(mcpEnabled) => setStored((current) => ({ ...current, mcpEnabled }))} />
        {stored.mcpEnabled && <Switch label="Keep MCP tabs open" checked={stored.mcpKeepTabsOpen} onChange={(mcpKeepTabsOpen) => setStored((current) => ({ ...current, mcpKeepTabsOpen }))} />}
      </SettingsAccordionSection>

      <footer>v{appVersion} (c) Michael Voitovich, 2026</footer>
      {helpTooltip && createPortal(<div className="settings-help-tooltip" role="tooltip" style={{ left: helpTooltip.left, top: helpTooltip.top }}>{helpTooltip.text}</div>, document.body)}
    </aside>
  );
}

function SettingsAccordionSection({
  id,
  number,
  title,
  icon,
  expanded = false,
  pinned = false,
  disabled = false,
  onToggle,
  children,
}: {
  id: string;
  number: number;
  title: string;
  icon: 'presets' | 'display' | 'terminal' | 'crt' | 'browser' | 'ui' | 'system';
  expanded?: boolean;
  pinned?: boolean;
  disabled?: boolean;
  onToggle?: () => void;
  children: ReactNode;
}) {
  return (
    <fieldset className={`settings-section${pinned ? ' settings-section-pinned' : ''}`} data-section-number={number} data-section-id={id} aria-keyshortcuts={`${number}`} disabled={disabled}>
      <legend>
        {pinned ? <span className="settings-section-title"><SettingsSectionIcon name={icon} />{title}</span> : (
          <button
            type="button"
            className="settings-section-toggle"
            data-section-number={number}
            aria-label={`${number} ${title}`}
            aria-expanded={expanded}
            aria-controls={`settings-section-content-${id}`}
            onClick={onToggle}
          >
            <span className="settings-section-title"><SettingsSectionIcon name={icon} />{title}</span>
            <span className="settings-section-chevron" aria-hidden="true" />
          </button>
        )}
      </legend>
      <div id={`settings-section-content-${id}`} className="settings-section-content" hidden={!pinned && !expanded}>
        {children}
      </div>
    </fieldset>
  );
}

function SettingsSectionIcon({ name }: { name: 'presets' | 'display' | 'terminal' | 'crt' | 'browser' | 'ui' | 'system' }) {
  if (name === 'ui') {
    return <svg className="settings-section-icon" viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="3" width="6" height="6" rx="1" /><rect x="11" y="3" width="6" height="6" rx="1" /><rect x="3" y="11" width="6" height="6" rx="1" /><rect x="11" y="11" width="6" height="6" rx="1" /></svg>;
  }
  if (name === 'system') {
    return <svg className="settings-section-icon" viewBox="0 0 20 20" aria-hidden="true"><rect x="5" y="5" width="10" height="10" rx="1" /><path d="M8 2.5v2.3m4-2.3v2.3m4 3h2.3m-2.3 4h2.3m-2.3 4v2.3m-4-2.3v2.3m-4-2.3v2.3m-4-6.3H2.5m2.3-4H2.5m2.3 8H2.5" /><path d="M8 8h4v4H8z" /></svg>;
  }
  return <span className="settings-section-icon" data-icon={name} aria-hidden="true" />;
}
