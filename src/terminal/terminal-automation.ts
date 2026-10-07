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
      : { snapshot: session.snapshot(includeScrollback), timedOut: false } satisfies TerminalObservation;
  }
  if (tool === 'send_terminal_input') {
    const action = args.action ?? args;
    await session.sendAutomationInput(inputAction(action));
    return 'Input encoded and queued.';
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
