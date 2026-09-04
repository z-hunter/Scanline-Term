import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { AiPanel } from './AiPanel';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('AiPanel', () => {
  it('does not send input when signedIn is false', async () => {
    const onSend = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(AiPanel, {
          messages: [],
          status: 'idle',
          signedIn: false,
          onSend,
          onStop: vi.fn(),
          onLogin: vi.fn(),
          debug: [],
        }),
      );
    });

    const textarea = container.querySelector('textarea')!;
    const sendButton = container.querySelector<HTMLButtonElement>('.ai-composer button')!;

    // Send button should be disabled
    expect(sendButton.disabled).toBe(true);

    // Pressing enter should not submit
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    });

    expect(onSend).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
