import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from './SettingsPanel';
import { DEFAULT_CRT_SETTINGS, loadStoredSettings } from '../crt/settings';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('SettingsPanel font-size editing flow', () => {
  const defaultProps = {
    stored: {
      ...loadStoredSettings(null),
      crt: {
        ...DEFAULT_CRT_SETTINGS,
        consoleFontSize: 14,
      },
    },
    setStored: vi.fn(),
    monospaceFonts: ['Consolas', 'Lucida Console'],
    shells: [],
    terminalSize: { cols: 80, rows: 24 },
    fps: 60,
    renderStats: { redraws: 0, canvasMs: 0, glyphs: 0 },
    appVersion: '0.1.3',
    onReset: vi.fn(),
  };

  const setInputValue = (input: HTMLInputElement, value: string) => {
    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const blurInput = (input: HTMLInputElement) => {
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    input.dispatchEvent(new Event('blur'));
  };

  it('retains local string value while editing and persists clamped value on blur', async () => {
    let currentStored = defaultProps.stored;
    const setStored = vi.fn((updater) => {
      currentStored = typeof updater === 'function' ? updater(currentStored) : updater;
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(SettingsPanel, {
          ...defaultProps,
          stored: currentStored,
          setStored,
        }),
      );
    });

    const input = container.querySelector<HTMLInputElement>('.font-size-control input');
    expect(input).not.toBeNull();
    expect(input?.value).toBe('14');

    // Edit to empty string
    await act(async () => {
      setInputValue(input!, '');
    });
    expect(input?.value).toBe('');
    expect(setStored).not.toHaveBeenCalled();

    // Blur on empty should restore stored value
    await act(async () => {
      blurInput(input!);
    });
    expect(input?.value).toBe('14');
    expect(setStored).toHaveBeenCalled();

    setStored.mockClear();

    // Type value below range (e.g. "3")
    await act(async () => {
      setInputValue(input!, '3');
    });
    expect(input?.value).toBe('3');
    expect(setStored).not.toHaveBeenCalled();

    // Blur should clamp to 6
    await act(async () => {
      blurInput(input!);
    });
    expect(input?.value).toBe('6');
    expect(setStored).toHaveBeenCalled();

    // Re-render with updated stored value
    await act(async () => {
      root.render(
        createElement(SettingsPanel, {
          ...defaultProps,
          stored: currentStored,
          setStored,
        }),
      );
    });
    expect(input?.value).toBe('6');

    setStored.mockClear();

    // Type value above range (e.g. "50") and submit via Enter
    await act(async () => {
      setInputValue(input!, '50');
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(input?.value).toBe('32');
    expect(setStored).toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('rejects decimal or non-integer input and retains stored font-size', async () => {
    let currentStored = defaultProps.stored;
    const setStored = vi.fn((updater) => {
      currentStored = typeof updater === 'function' ? updater(currentStored) : updater;
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(SettingsPanel, {
          ...defaultProps,
          stored: currentStored,
          setStored,
        }),
      );
    });

    const input = container.querySelector<HTMLInputElement>('.font-size-control input');
    expect(input).not.toBeNull();
    expect(input?.value).toBe('14');

    // Type decimal value (e.g. "18.5")
    await act(async () => {
      setInputValue(input!, '18.5');
    });
    expect(input?.value).toBe('18.5');

    // Blur should reject decimal and restore previous stored value (14)
    await act(async () => {
      blurInput(input!);
    });
    expect(input?.value).toBe('14');
    expect(currentStored.crt.consoleFontSize).toBe(14);

    // Type non-integer value (e.g. "20px") and submit via Enter
    await act(async () => {
      setInputValue(input!, '20px');
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(input?.value).toBe('14');
    expect(currentStored.crt.consoleFontSize).toBe(14);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('synchronizes displayed value when stored consoleFontSize changes externally', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(SettingsPanel, defaultProps));
    });

    const input = container.querySelector<HTMLInputElement>('.font-size-control input');
    expect(input?.value).toBe('14');

    // Simulate external change (e.g. Reset defaults to 16)
    await act(async () => {
      root.render(
        createElement(SettingsPanel, {
          ...defaultProps,
          stored: {
            ...defaultProps.stored,
            crt: {
              ...defaultProps.stored.crt,
              consoleFontSize: 16,
            },
          },
        }),
      );
    });

    expect(input?.value).toBe('16');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('retains raw valid input text such as "08" during live persistence until blur or Enter', async () => {
    let currentStored = defaultProps.stored;
    const setStored = vi.fn((updater) => {
      currentStored = typeof updater === 'function' ? updater(currentStored) : updater;
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(SettingsPanel, {
          ...defaultProps,
          stored: currentStored,
          setStored,
        }),
      );
    });

    const input = container.querySelector<HTMLInputElement>('.font-size-control input');
    expect(input?.value).toBe('14');

    // Type "08" (parsed to 8 which is >= 6 and <= 32)
    await act(async () => {
      setInputValue(input!, '08');
    });

    // Simulated parent re-render with updated stored value
    await act(async () => {
      root.render(
        createElement(SettingsPanel, {
          ...defaultProps,
          stored: currentStored,
          setStored,
        }),
      );
    });

    // Stored should be updated to 8, but input should keep raw text "08"
    expect(currentStored.crt.consoleFontSize).toBe(8);
    expect(input?.value).toBe('08');

    // Blur should canonicalize to "8"
    await act(async () => {
      blurInput(input!);
    });
    expect(input?.value).toBe('8');
    expect(currentStored.crt.consoleFontSize).toBe(8);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('updates cursorStyle when a segmented control option is clicked', async () => {
    let currentStored = defaultProps.stored;
    const setStored = vi.fn((updater) => {
      currentStored = typeof updater === 'function' ? updater(currentStored) : updater;
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(SettingsPanel, {
          ...defaultProps,
          stored: currentStored,
          setStored,
        }),
      );
    });

    const control = container.querySelector('[data-testid="cursor-style-segmented"]');
    expect(control).not.toBeNull();

    const buttons = control!.querySelectorAll('button');
    expect(buttons).toHaveLength(3);
    expect(buttons[0].textContent).toBe('Block');
    expect(buttons[1].textContent).toBe('Underline');
    expect(buttons[2].textContent).toBe('Bar');

    // Click 'Underline'
    await act(async () => {
      buttons[1].click();
    });

    expect(setStored).toHaveBeenCalled();
    expect(currentStored.crt.cursorStyle).toBe('underline');

    // Click 'Bar'
    await act(async () => {
      buttons[2].click();
    });

    expect(currentStored.crt.cursorStyle).toBe('bar');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('renders Bezel section with Monitor frame, Bezel glow, Bezel highlight, and Channel switch roll in Temporal', async () => {
    let currentStored = defaultProps.stored;
    const setStored = vi.fn((updater) => {
      currentStored = typeof updater === 'function' ? updater(currentStored) : updater;
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(SettingsPanel, {
          ...defaultProps,
          stored: currentStored,
          setStored,
        }),
      );
    });

    // Find Bezel fieldset
    const fieldsets = Array.from(container.querySelectorAll('fieldset'));
    const bezelFieldset = fieldsets.find((fs) => fs.querySelector('legend')?.textContent === 'Bezel');
    expect(bezelFieldset).toBeDefined();

    // Verify .bezel-control-row inside Bezel fieldset
    const row = bezelFieldset?.querySelector('.bezel-control-row');
    expect(row).not.toBeNull();

    const bezelGlowBlock = row?.querySelector('.setting-block');
    expect(bezelGlowBlock?.textContent).toContain('Bezel glow');

    const bezelHighlightControl = row?.querySelector('.bezel-highlight-control');
    expect(bezelHighlightControl?.textContent).toContain('Bezel highlight');

    const glowButtons = bezelGlowBlock?.querySelectorAll('button');
    expect(glowButtons).toHaveLength(3);
    expect(glowButtons?.[2].textContent).toBe('Relect.');
    await act(async () => {
      glowButtons?.[2].click();
    });
    expect(setStored).toHaveBeenCalled();
    expect(currentStored.crt.bezelGlow).toBe(true);
    expect(currentStored.crt.bezelGlowMode).toBe('reflection');
    setStored.mockClear();

    // Verify Monitor frame switch inside Bezel fieldset is below the bezel-control-row
    const monitorFrameSwitch = bezelFieldset?.querySelector('.switch-control');
    expect(row).not.toBeNull();
    expect(monitorFrameSwitch).not.toBeNull();
    expect(monitorFrameSwitch?.textContent).toContain('Monitor frame');
    if (row && monitorFrameSwitch) {
      expect(Boolean(row.compareDocumentPosition(monitorFrameSwitch) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    }

    // Toggle Monitor frame
    const monitorFrameCheckbox = monitorFrameSwitch?.querySelector('input');
    await act(async () => {
      monitorFrameCheckbox?.click();
    });
    expect(setStored).toHaveBeenCalled();
    expect(currentStored.crt.showBezel).toBe(true);
    setStored.mockClear();

    // Verify Channel switch roll is inside the Temporal fieldset
    const temporalFieldset = fieldsets.find((fs) => fs.querySelector('legend')?.textContent === 'Temporal');
    expect(temporalFieldset?.textContent).toContain('Channel switch roll');

    // Toggle Channel switch roll
    const channelSwitch = temporalFieldset?.querySelector('.switch-control');
    const channelSwitchCheckbox = channelSwitch?.querySelector('input');
    await act(async () => {
      channelSwitchCheckbox?.click();
    });
    expect(setStored).toHaveBeenCalled();
    expect(currentStored.crt.channelSwitchEffect).toBe(false);
    setStored.mockClear();

    // Verify Display fieldset still has Anti-moiré pixels and no longer has Monitor frame
    const displayFieldset = fieldsets.find((fs) => fs.querySelector('legend')?.textContent === 'Display');
    expect(displayFieldset?.textContent).toContain('Anti-moiré pixels');
    expect(displayFieldset?.textContent).not.toContain('Monitor frame');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('shows the Colors section and color-only mask controls', async () => {
    let currentStored = defaultProps.stored;
    const setStored = vi.fn((updater) => {
      currentStored = typeof updater === 'function' ? updater(currentStored) : updater;
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const render = async () => {
      await act(async () => {
        root.render(createElement(SettingsPanel, { ...defaultProps, stored: currentStored, setStored }));
      });
    };

    await render();
    const maskSelect = container.querySelector<HTMLSelectElement>('[data-testid="color-mask-select"]');
    const colorModeSelect = container.querySelector<HTMLSelectElement>('[data-testid="color-mode-select"]');
    expect(maskSelect).not.toBeNull();
    expect(maskSelect?.closest('.font-control-row')).not.toBe(colorModeSelect?.closest('.font-control-row'));
    expect(container.querySelector('[data-testid="color-mask-size-select"]')).toBeNull();
    expect(container.textContent).toContain('Colors');
    expect(container.textContent).toContain('Strength');

    const strengthKnobOff = container.querySelector('.knob[aria-label="Color mask strength"]');
    expect(strengthKnobOff?.classList.contains('disabled')).toBe(true);
    expect(strengthKnobOff?.getAttribute('aria-disabled')).toBe('true');
    expect(strengthKnobOff?.closest('.slider-control')?.classList.contains('disabled')).toBe(true);

    const convergenceKnob = container.querySelector('.knob[aria-label="Edge misconvergence"]');
    const falloffKnobOff = container.querySelector('.knob[aria-label="Edge falloff"]');
    expect(convergenceKnob).not.toBeNull();
    expect(falloffKnobOff?.classList.contains('disabled')).toBe(true);
    expect(falloffKnobOff?.getAttribute('aria-disabled')).toBe('true');

    await act(async () => {
      convergenceKnob?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    expect(currentStored.crt.aberration).toBe(0.25);
    await render();
    const falloffKnobOn = container.querySelector('.knob[aria-label="Edge falloff"]');
    expect(falloffKnobOn?.getAttribute('aria-disabled')).toBeNull();
    await act(async () => {
      falloffKnobOn?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    expect(currentStored.crt.aberrationFalloff).toBe(2.25);

    await act(async () => {
      maskSelect!.value = 'aperture';
      maskSelect!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(currentStored.crt.maskType).toBe('aperture');
    await render();
    expect(container.querySelector('[data-testid="color-mask-size-select"]')).toBeNull();
    expect(container.textContent).toContain('Strength');

    const strengthKnobOn = container.querySelector('.knob[aria-label="Color mask strength"]');
    expect(strengthKnobOn?.classList.contains('disabled')).toBe(false);
    expect(strengthKnobOn?.getAttribute('aria-disabled')).toBeNull();
    expect(strengthKnobOn?.closest('.slider-control')?.classList.contains('disabled')).toBe(false);

    currentStored = { ...currentStored, crt: { ...currentStored.crt, colorMode: 'green' } };
    await render();
    expect(container.querySelector('[data-testid="color-mask-select"]')).toBeNull();
    expect(container.querySelector('.knob[aria-label="Edge misconvergence"]')).toBeNull();
    expect(container.querySelector('.knob[aria-label="Edge falloff"]')).toBeNull();
    const desatKnob = container.querySelector('.knob[aria-label="Background desaturation"]');
    expect(desatKnob).not.toBeNull();
    const updatedColorModeSelect = container.querySelector<HTMLSelectElement>('[data-testid="color-mode-select"]');
    expect(desatKnob?.closest('.font-control-row')).toBe(updatedColorModeSelect?.closest('.font-control-row'));

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
