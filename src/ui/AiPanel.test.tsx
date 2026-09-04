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
    expect(container.querySelector('.ai-composer button')).toBeNull();

    // Enter non-whitespace text into composer
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      if (nativeSetter) {
        nativeSetter.call(textarea, 'help me with terminal');
      } else {
        textarea.value = 'help me with terminal';
      }
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Pressing enter should not submit when not signed in
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

  it('sends input when Enter is pressed and signedIn is true', async () => {
    const onSend = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(AiPanel, {
          messages: [],
          status: 'idle',
          signedIn: true,
          onSend,
          onStop: vi.fn(),
          onLogin: vi.fn(),
          debug: [],
        }),
      );
    });

    const textarea = container.querySelector('textarea')!;
    expect(document.activeElement).toBe(textarea);

    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      if (nativeSetter) {
        nativeSetter.call(textarea, 'help me with terminal');
      } else {
        textarea.value = 'help me with terminal';
      }
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    });

    expect(onSend).toHaveBeenCalledWith('help me with terminal');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('handles slash commands locally and opens the model picker', async () => {
    const onCommand = vi.fn();
    const onSelectModel = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const models = [
      { id: 'gpt-5.6-luna', model: 'gpt-5.6-luna', displayName: 'GPT-5.6-Luna', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
      { id: 'gpt-5.6-terra', model: 'gpt-5.6-terra', displayName: 'GPT-5.6-Terra', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
    ];
    await act(async () => {
      root.render(createElement(AiPanel, { messages: [], status: 'idle', signedIn: true, onSend: vi.fn(), onCommand, onStop: vi.fn(), onLogin: vi.fn(), models, selection: { model: 'gpt-5.6-luna', effort: 'medium' }, modelCatalogError: null, onSelectModel, onSelectEffort: vi.fn(), debug: [] }));
    });
    const textarea = container.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, '/help');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(onCommand).toHaveBeenCalledWith('help');
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, '/model');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(container.querySelector('[aria-label="Codex model settings"]')).not.toBeNull();
    const terra = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('GPT-5.6-Terra'))!;
    await act(async () => terra.click());
    expect(onSelectModel).toHaveBeenCalledWith('gpt-5.6-terra');
    await act(async () => root.unmount());
    container.remove();
  });

  it('shows typing only for the running tab and removes it when complete', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const props = {
      messages: [{ role: 'assistant' as const, text: 'Checking' }],
      status: 'idle' as const,
      isProcessing: true,
      signedIn: true,
      onSend: vi.fn(),
      onStop: vi.fn(),
      onLogin: vi.fn(),
      debug: [],
    };
    await act(async () => root.render(createElement(AiPanel, props)));
    expect(container.querySelector('.ai-typing')).not.toBeNull();
    await act(async () => root.render(createElement(AiPanel, { ...props, isProcessing: false })));
    expect(container.querySelector('.ai-typing')).toBeNull();
    await act(async () => root.unmount());
    container.remove();
  });

  it('scrolls a submitted request into view without overriding a manual scroll', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const props = {
      messages: [{ role: 'user' as const, text: 'First' }],
      status: 'idle' as const,
      signedIn: true,
      onSend: vi.fn(),
      onStop: vi.fn(),
      onLogin: vi.fn(),
      debug: [],
      sessionId: 'tab-1',
    };
    await act(async () => root.render(createElement(AiPanel, props)));
    const messages = container.querySelector<HTMLDivElement>('.ai-messages')!;
    const scrollRequest = { sessionId: 'tab-1', id: 1 };
    Object.defineProperties(messages, {
      scrollHeight: { configurable: true, value: 100 },
      clientHeight: { configurable: true, value: 10 },
    });
    await act(async () => root.render(createElement(AiPanel, { ...props, scrollRequest })));
    expect(messages.scrollTop).toBe(100);
    messages.scrollTop = 0;
    await act(async () => messages.dispatchEvent(new Event('scroll', { bubbles: true })));
    await act(async () => root.render(createElement(AiPanel, { ...props, messages: [...props.messages, { role: 'assistant' as const, text: 'Reply' }], scrollRequest })));
    expect(messages.scrollTop).toBe(0);
    await act(async () => root.unmount());
    container.remove();
  });
});
