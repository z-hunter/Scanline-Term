import { describe, expect, it } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { findTerminalMatches, nextSearchIndex } from './terminal-search';

function terminal(lines: string[], alternate = false, viewportY = 0, rows = 2): Terminal {
  const makeLine = (text: string) => ({
    getCell: (column: number) => {
      const chars = text[column] ?? ' ';
      return { getChars: () => chars, getWidth: () => 1 };
    },
  });
  const normal = { length: lines.length, viewportY, getLine: (index: number) => makeLine(lines[index] ?? '') };
  const active = alternate ? { ...normal, length: rows, viewportY, getLine: (index: number) => makeLine(lines[index] ?? '') } : normal;
  return { cols: Math.max(...lines.map((line) => line.length), 1), rows, buffer: { active, normal, alternate: active } } as unknown as Terminal;
}

describe('terminal search', () => {
  it('searches normal buffer including scrollback and uses smart case', () => {
    const result = findTerminalMatches(terminal(['Boot', 'boot BOOT']), 'boot');
    expect(result.buffer).toBe('normal');
    expect(result.matches.map(({ line, startColumn }) => [line, startColumn])).toEqual([[0, 0], [1, 0], [1, 5]]);
    expect(findTerminalMatches(terminal(['Boot', 'boot BOOT']), 'BOOT').matches.map((match) => match.line)).toEqual([1]);
  });

  it('limits alternate-buffer searches to the visible screen', () => {
    const result = findTerminalMatches(terminal(['hit', 'hit', 'hit', 'hit'], true, 0, 2), 'hit');
    expect(result.buffer).toBe('alternate');
    expect(result.matches.map((match) => match.line)).toEqual([0, 1]);
  });

  it('supports repeated matches and cyclic navigation', () => {
    expect(findTerminalMatches(terminal(['aaaa']), 'aa').matches).toHaveLength(2);
    expect(nextSearchIndex(1, 2, 1)).toBe(0);
    expect(nextSearchIndex(0, 2, -1)).toBe(1);
    expect(nextSearchIndex(0, 0, 1)).toBe(-1);
  });
});
