import { describe, expect, it } from 'vitest';
import { CapsFrameDecoder, type CapsFrameKeyEvent } from './caps-frame';

const token = '0123456789abcdef';
const events = (edge: 'down' | 'up', value = token, tapHold: 'tap' | 'held' = 'tap'): CapsFrameKeyEvent[] => [
  { phase: 'keydown', code: edge === 'down' ? 'Backquote' : tapHold === 'tap' ? 'Backslash' : 'IntlBackslash', keyCode: 252 },
  ...[...value].map((digit) => ({
    phase: 'keydown' as const,
    code: digit <= '9' ? `Digit${digit}` : `Key${digit.toUpperCase()}`,
    keyCode: 252,
    repeat: true,
  })),
  { phase: 'keyup', code: 'Semicolon', keyCode: 252 },
];

function feedFrame(decoder: CapsFrameDecoder, edge: 'down' | 'up', currentToken = token, revision = 1, startedAt = 12) {
  let decoded = null;
  for (const [index, event] of events(edge, currentToken).entries()) {
    decoded = decoder.feed(event, currentToken, revision, startedAt + index);
  }
  return decoded;
}

describe('CapsFrameDecoder', () => {
  it('decodes down/up frames with MSB-first opaque token and scan-derived codes', () => {
    const decoder = new CapsFrameDecoder();
    expect(feedFrame(decoder, 'down')).toEqual({ edge: 'down', markerToken: token, contextRevision: 1, startedAt: 12, tapHold: null });
    expect(feedFrame(decoder, 'up')).toEqual({ edge: 'up', markerToken: token, contextRevision: 1, startedAt: 12, tapHold: 'tap' });
  });

  it('distinguishes native held-up header from tap-up header', () => {
    const decoder = new CapsFrameDecoder();
    let decoded = null;
    for (const event of events('up', token, 'held')) decoded = decoder.feed(event, token, 1, 12);
    expect(decoded).toMatchObject({ edge: 'up', tapHold: 'held' });
  });

  it('discards a frame carrying a prior lease token', () => {
    const decoder = new CapsFrameDecoder();
    const oldToken = 'fedcba9876543210';
    for (const event of events('down', oldToken)) expect(decoder.feed(event, token, 2, 12)).toBeNull();
  });

  it('discards a partially queued frame across context changes, including A to B to A', () => {
    const decoder = new CapsFrameDecoder();
    const oldFrame = events('down');
    for (const event of oldFrame.slice(0, 6)) expect(decoder.feed(event, token, 1, 1)).toBeNull();
    for (const event of oldFrame.slice(6)) expect(decoder.feed(event, token, 3, 2)).toBeNull();
    expect(decoder.pending).toBe(false);
  });

  it('rejects malformed headers, wrong terminators, too few nibbles, and extra payload', () => {
    const decoder = new CapsFrameDecoder();
    const noTerminator = events('down').slice(0, 10);
    for (const event of noTerminator) expect(decoder.feed(event, token, 1, 0)).toBeNull();
    expect(decoder.feed({ phase: 'keyup', code: 'Enter', keyCode: 252 }, token, 1, 1)).toBeNull();
    expect(decoder.pending).toBe(false);

    for (const event of events('up').slice(0, 10)) expect(decoder.feed(event, token, 1, 2)).toBeNull();
    expect(decoder.feed({ phase: 'keyup', code: 'Semicolon', keyCode: 252 }, token, 1, 3)).toBeNull();
    expect(decoder.pending).toBe(false);

    const extraNibble = [
      events('down')[0],
      ...events('down').slice(1, 17),
      { phase: 'keydown' as const, code: 'Digit0', keyCode: 252 },
    ];
    for (const event of extraNibble) expect(decoder.feed(event, token, 1, 4)).toBeNull();
    expect(decoder.pending).toBe(false);
  });

  it('resets on non-marker input so ordinary keys are left to the existing handler', () => {
    const decoder = new CapsFrameDecoder();
    const frame = events('down');
    for (const event of frame.slice(0, 5)) decoder.feed(event, token, 1, 0);
    expect(decoder.feed({ phase: 'keydown', code: 'KeyA', keyCode: 65 }, token, 1, 1)).toBeNull();
    for (const event of frame.slice(5)) expect(decoder.feed(event, token, 1, 2)).toBeNull();
  });

  it('does not let an old A frame become valid after an A to B to A transition', () => {
    const decoder = new CapsFrameDecoder();
    const oldToken = 'aaaaaaaaaaaaaaaa';
    const newToken = 'bbbbbbbbbbbbbbbb';
    const oldFrame = events('up', oldToken);
    for (const event of oldFrame) expect(decoder.feed(event, newToken, 3, 1)).toBeNull();
    expect(feedFrame(decoder, 'up', newToken, 3)).toEqual({ edge: 'up', markerToken: newToken, contextRevision: 3, startedAt: 12, tapHold: 'tap' });
  });
});
