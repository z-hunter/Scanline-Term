export type CapsFrameEdge = 'down' | 'up';
export type CapsFrameTapHold = 'tap' | 'held';

export type CapsFrameKeyEvent = {
  code: string;
  keyCode: number;
  phase: 'keydown' | 'keyup';
  repeat?: boolean;
};

export type DecodedCapsFrame = {
  edge: CapsFrameEdge;
  markerToken: string;
  contextRevision: number;
  startedAt: number;
  tapHold: CapsFrameTapHold | null;
};

type PartialFrame = {
  edge: CapsFrameEdge;
  markerToken: string;
  contextRevision: number;
  startedAt: number;
  tapHold: CapsFrameTapHold | null;
  nibbles: string[];
};

const NIBBLE_BY_CODE: Readonly<Record<string, string>> = {
  Digit0: '0', Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4',
  Digit5: '5', Digit6: '6', Digit7: '7', Digit8: '8', Digit9: '9',
  KeyA: 'a', KeyB: 'b', KeyC: 'c', KeyD: 'd', KeyE: 'e', KeyF: 'f',
};

/** Decodes the fixed VK_NONAME scan-code frame; callers must consume every keyCode 252 event. */
export class CapsFrameDecoder {
  private partial: PartialFrame | null = null;

  get pending(): boolean { return this.partial !== null; }

  reset(): void { this.partial = null; }

  feed(
    event: CapsFrameKeyEvent,
    markerToken: string | null,
    contextRevision: number,
    now: number,
  ): DecodedCapsFrame | null {
    if (event.keyCode !== 252) {
      this.reset();
      return null;
    }

    if (event.phase === 'keydown' && (event.code === 'Backquote' || event.code === 'Backslash' || event.code === 'IntlBackslash')) {
      const edge = event.code === 'Backquote' ? 'down' : 'up';
      this.partial = markerToken && /^[0-9a-f]{16}$/i.test(markerToken)
        ? {
            edge,
            markerToken: markerToken.toLowerCase(),
            contextRevision,
            startedAt: now,
            tapHold: edge === 'down' ? null : event.code === 'Backslash' ? 'tap' : 'held',
            nibbles: [],
          }
        : null;
      return null;
    }

    const partial = this.partial;
    if (!partial || partial.contextRevision !== contextRevision || partial.markerToken !== markerToken?.toLowerCase()) {
      this.reset();
      return null;
    }

    if (event.phase === 'keydown') {
      const nibble = NIBBLE_BY_CODE[event.code];
      if (!nibble || partial.nibbles.length >= 16) {
        this.reset();
        return null;
      }
      partial.nibbles.push(nibble);
      return null;
    }

    if (event.code !== 'Semicolon' || partial.nibbles.length !== 16) {
      this.reset();
      return null;
    }

    const decodedToken = partial.nibbles.join('');
    const frame = decodedToken === partial.markerToken
      ? { edge: partial.edge, markerToken: partial.markerToken, contextRevision: partial.contextRevision, startedAt: partial.startedAt, tapHold: partial.tapHold }
      : null;
    this.reset();
    return frame;
  }
}
