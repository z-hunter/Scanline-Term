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
    terminalSize: { cols: 80, rows: 24 },
    fps: 60,
    renderStats: { redraws: 0, canvasMs: 0, glyphs: 0 },
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
});
