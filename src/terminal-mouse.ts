export type MouseTrackingMode = 'none' | 'x10' | 'vt200' | 'drag' | 'any';
export type MouseAction = 'press' | 'release' | 'move' | 'wheel-up' | 'wheel-down';

export type MouseEventData = {
  action: MouseAction;
  button?: 0 | 1 | 2;
  col: number;
  row: number;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  sgr: boolean;
};

function code(event: MouseEventData): number {
  const modifiers = Number(event.shiftKey) * 4 + Number(event.altKey) * 8 + Number(event.ctrlKey) * 16;
  if (event.action === 'wheel-up') return 64 + modifiers;
  if (event.action === 'wheel-down') return 65 + modifiers;
  if (event.action === 'release') return (event.sgr ? (event.button ?? 0) : 3) + modifiers;
  return (event.button ?? (event.action === 'move' ? 3 : 0)) + (event.action === 'move' ? 32 : 0) + modifiers;
}

/** Encodes an xterm-compatible mouse event for the current console input mode. */
export function terminalMouse(event: MouseEventData): string {
  const button = code(event);
  if (event.sgr) return `\x1b[<${button};${event.col};${event.row}${event.action === 'release' ? 'm' : 'M'}`;
  return `\x1b[M${String.fromCharCode(32 + button, 32 + event.col, 32 + event.row)}`;
}
