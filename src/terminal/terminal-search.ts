import type { IBuffer, IBufferLine, Terminal } from '@xterm/xterm';

export type TerminalSearchMatch = {
  line: number;
  startColumn: number;
  endColumn: number;
};

export type TerminalSearchSnapshot = {
  matches: TerminalSearchMatch[];
  buffer: 'normal' | 'alternate';
};

function isCaseSensitive(query: string): boolean {
  return query !== query.toLowerCase();
}

function lineText(line: IBufferLine, cols: number): { text: string; columns: number[] } {
  let text = '';
  const columns: number[] = [];
  for (let column = 0; column < cols; column += 1) {
    const cell = line.getCell(column);
    if (!cell || cell.getWidth() === 0) continue;
    const chars = cell.getChars() || ' '.repeat(Math.max(1, cell.getWidth()));
    for (let index = 0; index < chars.length; index += 1) columns.push(column);
    text += chars;
  }
  return { text, columns };
}

function searchBuffer(buffer: IBuffer, cols: number, rows: number, query: string, bufferKind: 'normal' | 'alternate'): TerminalSearchSnapshot {
  if (!query) return { matches: [], buffer: bufferKind };
  const caseSensitive = isCaseSensitive(query);
  const needle = caseSensitive ? query : query.toLocaleLowerCase();
  const firstLine = bufferKind === 'alternate' ? buffer.viewportY : 0;
  const lastLine = bufferKind === 'alternate' ? Math.min(buffer.length, firstLine + rows) : buffer.length;
  const matches: TerminalSearchMatch[] = [];
  for (let lineNumber = firstLine; lineNumber < lastLine; lineNumber += 1) {
    const line = buffer.getLine(lineNumber);
    if (!line) continue;
    const mapped = lineText(line, cols);
    const haystack = caseSensitive ? mapped.text : mapped.text.toLocaleLowerCase();
    let offset = 0;
    while (offset <= haystack.length - needle.length) {
      const index = haystack.indexOf(needle, offset);
      if (index < 0) break;
      const endIndex = index + needle.length - 1;
      matches.push({
        line: lineNumber,
        startColumn: mapped.columns[index] ?? 0,
        endColumn: (mapped.columns[endIndex] ?? mapped.columns[index] ?? 0) + 1,
      });
      offset = index + Math.max(1, needle.length);
    }
  }
  return { matches, buffer: bufferKind };
}

export function findTerminalMatches(terminal: Terminal, query: string): TerminalSearchSnapshot {
  const buffer = terminal.buffer.active;
  return searchBuffer(buffer, terminal.cols, terminal.rows, query, buffer === terminal.buffer.normal ? 'normal' : 'alternate');
}

export function nextSearchIndex(current: number, count: number, direction: 1 | -1): number {
  if (count <= 0) return -1;
  return (current + direction + count) % count;
}
