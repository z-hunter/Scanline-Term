import type { TerminalInputAction, TerminalMouseAction, TerminalObservation, TerminalSession } from './TerminalSession';

type Arguments = Record<string, unknown>;
type ObservationOptions = { includeStyles?: boolean; includeWraps?: boolean; quietMs?: number; timeoutMs?: number; waitFor?: { text: string; match: 'present' | 'absent' } };

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

function observationOptions(value: unknown): ObservationOptions {
  const options = object(value);
  if (options.includeStyles !== undefined && typeof options.includeStyles !== 'boolean') throw new Error('includeStyles must be a boolean');
  if (options.includeWraps !== undefined && typeof options.includeWraps !== 'boolean') throw new Error('includeWraps must be a boolean');
  const wait = options.waitFor === undefined ? undefined : object(options.waitFor);
  if (wait && (typeof wait.text !== 'string' || !wait.text.length || wait.text.length > 1024 || !['present', 'absent'].includes(String(wait.match))))
    throw new Error('waitFor requires 1-1024 characters and match present or absent');
  return {
    includeStyles: boolean(options.includeStyles), includeWraps: boolean(options.includeWraps),
    quietMs: number(options.quietMs, 'quietMs'), timeoutMs: number(options.timeoutMs, 'timeoutMs'),
    ...(wait ? { waitFor: { text: wait.text as string, match: wait.match as 'present' | 'absent' } } : {}),
  };
}

async function observed(session: TerminalSession, result: unknown, before: ReturnType<TerminalSession['snapshot']>, options: ObservationOptions = {}) {
  const receipt = object(result);
  if (receipt.status === 'no_input') return { result, observation: { snapshot: session.snapshot(options), status: 'snapshot', timedOut: false } };
  try {
    const observation = await session.waitForOutput(before.sequence, options.quietMs ?? 100, options.timeoutMs ?? 750, options);
    return { result, observation };
  } catch (error) {
    return { result, observation: { snapshot: before, status: 'unavailable', timedOut: false, error: String(error) } };
  }
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
    code: action.code === undefined ? undefined : string(action.code, 'code'),
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
    if (afterSequence !== undefined && (!Number.isSafeInteger(afterSequence) || afterSequence < 0)) throw new Error('afterSequence must be a non-negative safe integer');
    const options = observationOptions(args);
    if (afterSequence === undefined && options.waitFor === undefined && (options.quietMs !== undefined || options.timeoutMs !== undefined))
      throw new Error('quietMs and timeoutMs require afterSequence or waitFor');
    if (options.waitFor && afterSequence === undefined) {
      const currentSequence = session.snapshot().sequence;
      return session.waitForOutput(currentSequence - 1, options.quietMs, options.timeoutMs ?? 5_000, options);
    }
    return typeof afterSequence === 'number'
      ? session.waitForOutput(afterSequence, options.quietMs, options.timeoutMs ?? 60_000, options)
      : { snapshot: session.snapshot(options), status: 'snapshot', timedOut: false } satisfies TerminalObservation;
  }
  if (tool === 'read_scrollback') return session.readScrollback(number(args.count, 'count')!, number(args.offsetFromEnd, 'offsetFromEnd') ?? 0, number(args.revision, 'revision'), args.includeWraps === true);
  if (tool === 'capture_terminal_frames') {
    const count = number(args.count, 'count');
    const intervalMs = number(args.intervalMs, 'intervalMs');
    const timeoutMs = number(args.timeoutMs, 'timeoutMs');
    if (!Number.isInteger(count) || count! < 1 || count! > 20) throw new Error('count must be an integer from 1 to 20');
    if (!Number.isInteger(intervalMs) || intervalMs! < 50 || intervalMs! > 5000) throw new Error('intervalMs must be an integer from 50 to 5000');
    if (!Number.isInteger(timeoutMs) || timeoutMs! < 1 || timeoutMs! > 60000) throw new Error('timeoutMs must be an integer from 1 to 60000');
    const options = observationOptions(args);
    const started = performance.now();
    const frames: { capturedAtMs: number; snapshot: ReturnType<TerminalSession['snapshot']> }[] = [];
    let status: 'completed' | 'timeout' | 'exited' | 'unavailable' = 'completed';
    for (let index = 0; index < count!; index += 1) {
      if (index > 0) {
        const remaining = timeoutMs! - (performance.now() - started);
        if (remaining <= 0) { status = 'timeout'; break; }
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(intervalMs!, remaining)));
        if (performance.now() - started >= timeoutMs!) { status = 'timeout'; break; }
      }
      try {
        const snapshot = session.snapshot(options);
        frames.push({ capturedAtMs: Date.now(), snapshot });
        if (snapshot.status === 'exited') { status = 'exited'; break; }
      } catch {
        status = 'unavailable';
        break;
      }
    }
    return { status, collected: frames.length, frames };
  }
  const options = observationOptions(args.observe);
  const before = session.snapshot();
  if (tool === 'send_terminal_input') {
    const action = args.action ?? args;
    return observed(session, await session.sendAutomationInput(inputAction(action)), before, options);
  }
  if (tool === 'send_text') return observed(session, await session.sendAutomationInput({ kind: 'text', text: string(args.text, 'text'), submit: boolean(args.submit) }), before, options);
  if (tool === 'press_key') return observed(session, await session.sendAutomationInput(inputAction({ ...args, kind: 'key' })), before, options);
  if (tool === 'paste_text') {
    if (!session.terminal?.modes.bracketedPasteMode) throw new Error('terminal bracketed paste mode is disabled');
    const text = string(args.text, 'text');
    // eslint-disable-next-line no-control-regex -- Reject terminal control bytes before bracketed paste.
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text)) throw new Error('text contains unsupported control characters');
    if (!text) return { result: { status: 'no_input', kind: 'paste', bytesQueued: 0 }, observation: { snapshot: session.snapshot(options), status: 'snapshot', timedOut: false } };
    return observed(session, await session.sendAutomationInput({ kind: 'paste', text: text.replace(/\r\n|\r|\n/g, '\r') }), before, options);
  }
  if (tool === 'paste_terminal_clipboard') {
    const text = await navigator.clipboard.readText();
    const result = await session.sendAutomationInput({ kind: 'text', text });
    return observed(session, result.status === 'no_input' ? 'Clipboard was empty; nothing pasted.' : 'Clipboard text pasted.', before, options);
  }
  if (tool === 'send_terminal_mouse') {
    await session.sendAutomationMouse(mouseAction(args.action ?? args));
    return observed(session, { status: 'queued', kind: 'mouse' }, before, options);
  }
  throw new Error(`Unknown terminal tool: ${tool}`);
}

export function normalizeTerminalInput(value: unknown): TerminalInputAction {
  return inputAction(value);
}

export function normalizeTerminalMouse(value: unknown): TerminalMouseAction {
  return mouseAction(value);
}
