import type { Dispatch, SetStateAction } from 'react';
import type { CRTColorMode, CRTSettings } from '../crt/CRTFilter';
import { RESOLUTIONS, type ResolutionId, type StoredSettings, type TabPlacement } from '../crt/settings';
import { COLOR_PROFILES } from '../terminal-color-profiles';
import { Knob, formatValue } from './Knob';
import type { RenderStats } from '../terminal/TerminalRenderer';

type NumericKey = Exclude<
  keyof CRTSettings,
  | 'crtEmulation'
  | 'colorProfile'
  | 'consoleFont'
  | 'bezelGlow'
  | 'showBezel'
  | 'antiAliasedPixels'
  | 'colorMode'
  | 'bloomAlgorithm'
>;

const SHOW_TELEMETRY = false;

const controls: Record<string, { key: NumericKey; label: string; min: number; max: number; step: number }[]> = {
  Geometry: [
    { key: 'curvature', label: 'Curvature', min: 0, max: 0.5, step: 0.01 },
    { key: 'vignette', label: 'Vignette', min: 0, max: 1, step: 0.05 },
  ],
  Raster: [
    { key: 'scanlineCount', label: 'Scanline count', min: 0, max: 768, step: 10 },
    { key: 'scanlineIntensity', label: 'Scanline intensity', min: 0, max: 1, step: 0.05 },
    { key: 'beamModulation', label: 'Beam modulation', min: 0, max: 1, step: 0.05 },
  ],
  Light: [
    { key: 'bloom', label: 'Bloom', min: 0, max: 1, step: 0.05 },
    { key: 'glow', label: 'Screen glow', min: 0, max: 2, step: 0.05 },
    { key: 'phosphor', label: 'Phosphor / grain', min: 0, max: 1, step: 0.05 },
  ],
  'Final image': [
    { key: 'imageBrightness', label: 'Image brightness', min: 0.5, max: 1.5, step: 0.05 },
    { key: 'imageContrast', label: 'Image contrast', min: 0.5, max: 1.5, step: 0.05 },
    { key: 'backgroundDesaturation', label: 'Background desaturation', min: 0, max: 1, step: 0.05 },
  ],
  Temporal: [
    { key: 'persistence', label: 'Phosphor trail', min: 0, max: 1, step: 0.05 },
    { key: 'persistenceIntensity', label: 'Trail intensity', min: 0, max: 4, step: 0.05 },
    { key: 'breathing', label: 'HV breathing', min: 0, max: 1, step: 0.05 },
  ],
};

type SwitchProps = {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  'data-testid'?: string;
};

function Switch({ label, checked, onChange, 'data-testid': testId }: SwitchProps) {
  return (
    <label className="switch-control">
      <span className="switch-label">{label}</span>
      <span className="switch-toggle">
        <input
          type="checkbox"
          role="switch"
          aria-checked={checked}
          checked={checked}
          data-testid={testId}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="switch-track">
          <span className="switch-thumb" />
        </span>
      </span>
    </label>
  );
}

type SegmentedControlProps<T extends string> = {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  'data-testid'?: string;
};

function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  disabled,
  'data-testid': testId,
}: SegmentedControlProps<T>) {
  return (
    <div className={`segmented-control ${disabled ? 'disabled' : ''}`} data-testid={testId} role="radiogroup">
      {options.map((option) => {
        const isSelected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={isSelected}
            disabled={disabled}
            className={`segmented-control-item ${isSelected ? 'active' : ''}`}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function SettingsPanel({
  stored,
  setStored,
  monospaceFonts,
  terminalSize,
  fps,
  renderStats,
  onReset,
}: {
  stored: StoredSettings;
  setStored: Dispatch<SetStateAction<StoredSettings>>;
  monospaceFonts: string[];
  terminalSize: { cols: number; rows: number };
  fps: number;
  renderStats: RenderStats;
  onReset: () => void;
}) {
  const update = (key: NumericKey, value: number) =>
    setStored((current) => ({ ...current, crt: { ...current.crt, [key]: value } }));
  const averageCanvasMs = renderStats.redraws ? renderStats.canvasMs / renderStats.redraws : 0;

  return (
    <aside className="settings-panel">
      <header>
        <p className="eyebrow">SCANLINE TERM</p>
        <h1>CRT display lab</h1>
        <p className="display-status">
          CONSOLE BUFFER: {terminalSize.cols} × {terminalSize.rows} · FPS: {fps}
          {SHOW_TELEMETRY && (
            <>
              <br />
              REDRAWS: {renderStats.redraws * 2}/s · CANVAS: {averageCanvasMs.toFixed(1)} ms · GLYPHS:{' '}
              {renderStats.glyphs * 2}/s
            </>
          )}
        </p>
      </header>

      <label className="resolution-control">
        Virtual resolution
        <select
          value={stored.resolution}
          data-testid="resolution-select"
          onChange={(event) =>
            setStored((current) => ({ ...current, resolution: event.target.value as ResolutionId }))
          }
        >
          {RESOLUTIONS.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </label>

      <label className="resolution-control">
        Color mode
        <select
          value={stored.crt.colorMode}
          data-testid="color-mode-select"
          onChange={(event) =>
            setStored((current) => ({
              ...current,
              crt: { ...current.crt, colorMode: event.target.value as CRTColorMode },
            }))
          }
        >
          <option value="color">Color</option>
          <option value="bw">B&amp;W</option>
          <option value="green">Green</option>
          <option value="amber">Amber</option>
          <option value="blue">Phosphor Blue</option>
        </select>
      </label>

      <label className="resolution-control">
        Color profile
        <select
          value={stored.crt.colorProfile}
          data-testid="color-profile-select"
          onChange={(event) =>
            setStored((current) => ({
              ...current,
              crt: { ...current.crt, colorProfile: event.target.value as CRTSettings['colorProfile'] },
            }))
          }
        >
          {COLOR_PROFILES.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.label}
            </option>
          ))}
        </select>
      </label>

      <div className="font-control-row">
        <label className="resolution-control font-name-control">
          Console font
          <select
            value={stored.crt.consoleFont}
            onChange={(event) =>
              setStored((current) => ({ ...current, crt: { ...current.crt, consoleFont: event.target.value } }))
            }
          >
            {!monospaceFonts.includes(stored.crt.consoleFont) && (
              <option value={stored.crt.consoleFont}>{stored.crt.consoleFont} (fallback)</option>
            )}
            {monospaceFonts.map((font) => (
              <option key={font} value={font}>
                {font}
              </option>
            ))}
          </select>
        </label>
        <label className="resolution-control font-size-control">
          Size
          <input
            type="number"
            min={6}
            max={32}
            step={1}
            value={stored.crt.consoleFontSize}
            onChange={(event) => {
              const val = Number(event.target.value);
              if (!Number.isNaN(val)) {
                setStored((current) => ({
                  ...current,
                  crt: {
                    ...current.crt,
                    consoleFontSize: Math.max(6, Math.min(32, val)),
                  },
                }));
              }
            }}
          />
        </label>
      </div>

      {Object.entries(controls).map(([group, groupControls]) => (
        <fieldset className="knob-group" key={group}>
          <legend>{group}</legend>
          {groupControls.map((control) => {
            if (group === 'Light' && control.key === 'bloom') {
              return (
                <div className="bloom-card" key={control.key}>
                  <label className="slider-control">
                    <span>
                      {control.label}
                      <output>{formatValue(stored.crt[control.key])}</output>
                    </span>
                    <Knob
                      {...control}
                      value={stored.crt[control.key]}
                      onChange={(value) => update(control.key, value)}
                    />
                  </label>
                  <SegmentedControl
                    value={stored.crt.bloomAlgorithm}
                    disabled={stored.crt.bloom === 0}
                    options={[
                      { value: 'soft', label: 'Soft' },
                      { value: 'spiral', label: 'Spiral' },
                    ]}
                    onChange={(algo) =>
                      setStored((current) => ({
                        ...current,
                        crt: { ...current.crt, bloomAlgorithm: algo },
                      }))
                    }
                  />
                </div>
              );
            }
            return (
              <label className="slider-control" key={control.key}>
                <span>
                  {control.label}
                  <output>{formatValue(stored.crt[control.key])}</output>
                </span>
                <Knob
                  {...control}
                  value={stored.crt[control.key]}
                  onChange={(value) => update(control.key, value)}
                />
              </label>
            );
          })}
        </fieldset>
      ))}

      <fieldset>
        <legend>Display</legend>
        {(
          [
            ['crtEmulation', 'CRT Emulation'],
            ['bezelGlow', 'Bezel glow'],
            ['showBezel', 'Monitor frame'],
            ['antiAliasedPixels', 'Anti-moiré pixels'],
          ] as const
        ).map(([key, label]) => (
          <Switch
            key={key}
            label={label}
            checked={stored.crt[key]}
            data-testid={key === 'crtEmulation' ? 'control-crtEmulation' : undefined}
            onChange={(checked) =>
              setStored((current) => ({
                ...current,
                crt: { ...current.crt, [key]: checked },
              }))
            }
          />
        ))}
      </fieldset>

      <fieldset>
        <legend>UI</legend>
        <div className="setting-block">
          <span className="setting-label">Tab placement</span>
          <SegmentedControl
            value={stored.tabPlacement}
            options={[
              { value: 'left', label: 'Left of monitor' },
              { value: 'top', label: 'Above monitor' },
            ]}
            onChange={(placement) =>
              setStored((current) => ({
                ...current,
                tabPlacement: placement as TabPlacement,
              }))
            }
          />
        </div>
        <Switch
          label="Hide tabs when single session"
          checked={stored.hideTabsWhenSingleSession}
          onChange={(checked) =>
            setStored((current) => ({ ...current, hideTabsWhenSingleSession: checked }))
          }
        />
        <Switch
          label="Global hotkey: Win+~"
          checked={stored.globalHotkeyEnabled}
          onChange={(checked) =>
            setStored((current) => ({ ...current, globalHotkeyEnabled: checked }))
          }
        />
        <label className="resolution-control">
          Settings scale
          <select
            value={stored.settingsScale}
            onChange={(event) =>
              setStored((current) => ({ ...current, settingsScale: Number(event.target.value) }))
            }
          >
            {[0.75, 0.9, 1, 1.1, 1.25, 1.5].map((scale) => (
              <option key={scale} value={scale}>
                {Math.round(scale * 100)}%
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      <button type="button" className="reset-button" onClick={onReset}>
        Reset defaults
      </button>
      <footer>v.0.1a (c) Michael Voitovich, 2026</footer>
    </aside>
  );
}
