import type { TerminalInputAction, TerminalMouseAction, TerminalObservation, TerminalSession } from './TerminalSession';

type Arguments = Record<string, unknown>;

function object(value: unknown): Arguments {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Arguments : {};
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function number(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}

function inputAction(value: unknown): TerminalInputAction {
  const action = object(value);
  const kind = action.kind ?? action.type;
  if (kind === 'text' || (kind === undefined && typeof action.text === 'string')) {
    return { kind: 'text', text: string(action.text ?? '', 'text'), submit: boolean(action.submit) };
  }
  if (kind !== 'key') throw new Error('terminal input action must be text or key');
  return {
    kind: 'key',
    key: string(action.key, 'key'),
    ctrl: boolean(action.ctrl),
    alt: boolean(action.alt),
    shift: boolean(action.shift),
    repeat: number(action.repeat, 'repeat'),
  };
}

function mouseAction(value: unknown): TerminalMouseAction {
  const action = object(value);
  const kind = action.action;
  const col = number(action.col, 'col');
  const row = number(action.row, 'row');
  if (typeof col !== 'number' || typeof row !== 'number' || !Number.isInteger(col) || !Number.isInteger(row)) throw new Error('mouse col and row must be integers');
  const common = { col, row, ctrl: boolean(action.ctrl), alt: boolean(action.alt), shift: boolean(action.shift) };
  if (kind === 'click' || kind === 'press' || kind === 'release') {
    if (action.button !== 'primary' && action.button !== 'secondary') throw new Error('mouse button must be primary or secondary');
    return { action: kind, button: action.button, ...common };
  }
  if (kind === 'move') {
    if (action.heldButton !== undefined && action.heldButton !== 'primary' && action.heldButton !== 'secondary') throw new Error('heldButton must be primary or secondary');
    return { action: 'move', heldButton: action.heldButton as 'primary' | 'secondary' | undefined, ...common };
  }
  if (kind === 'wheel') {
    if (action.direction !== 'up' && action.direction !== 'down') throw new Error('wheel direction must be up or down');
    return { action: 'wheel', direction: action.direction, steps: number(action.steps, 'steps'), ...common };
  }
  throw new Error('unknown terminal mouse action');
}

export async function dispatchTerminalTool(session: TerminalSession, tool: string, rawArguments: unknown): Promise<unknown> {
  const args = object(rawArguments);
  if (tool === 'observe_terminal') {
    const afterSequence = number(args.afterSequence, 'afterSequence');
    const includeScrollback = args.includeScrollback === true || args.history === 'full';
    return typeof afterSequence === 'number'
      ? session.waitForOutput(afterSequence, number(args.quietMs, 'quietMs'), number(args.timeoutMs, 'timeoutMs'), includeScrollback)
      : { snapshot: session.snapshot(includeScrollback), status: 'snapshot', timedOut: false } satisfies TerminalObservation;
  }
  if (tool === 'send_terminal_input') {
    const action = args.action ?? args;
    return session.sendAutomationInput(inputAction(action));
  }
  if (tool === 'send_text') return session.sendAutomationInput({ kind: 'text', text: string(args.text, 'text'), submit: boolean(args.submit) });
  if (tool === 'press_key') return session.sendAutomationInput(inputAction({ ...args, kind: 'key' }));
  if (tool === 'paste_text') {
    if (!session.terminal?.modes.bracketedPasteMode) throw new Error('terminal bracketed paste mode is disabled');
    const text = string(args.text, 'text');
    // eslint-disable-next-line no-control-regex -- Reject terminal control bytes before bracketed paste.
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text)) throw new Error('text contains unsupported control characters');
    if (!text) return { status: 'no_input', kind: 'paste', bytesQueued: 0 };
    return session.sendAutomationInput({ kind: 'paste', text: text.replace(/\r\n|\r|\n/g, '\r') });
  }
  if (tool === 'paste_terminal_clipboard') {
    const text = await navigator.clipboard.readText();
    const result = await session.sendAutomationInput({ kind: 'text', text });
    return result.status === 'no_input' ? 'Clipboard was empty; nothing pasted.' : 'Clipboard text pasted.';
  }
  if (tool === 'send_terminal_mouse') {
    await session.sendAutomationMouse(mouseAction(args.action ?? args));
    return 'Mouse input encoded and queued.';
  }
  throw new Error(`Unknown terminal tool: ${tool}`);
}

export function normalizeTerminalInput(value: unknown): TerminalInputAction {
  return inputAction(value);
}

export function normalizeTerminalMouse(value: unknown): TerminalMouseAction {
  return mouseAction(value);
}
