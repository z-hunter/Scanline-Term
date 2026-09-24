import type { IBufferCell, Terminal } from '@xterm/xterm';

export type ScrollCandidate = { deltaRows: number; topRow: number; bottomRow: number; overlapRows: number; matchTopRow: number; matchBottomRow: number; presentationMismatchRows: number[] };
export type ScrollDetection = { candidate: ScrollCandidate | null; maxExactOverlap: number; maxExactDelta: number | null; rejection: string | null };
export type TerminalScreenSnapshot = {
  buffer: unknown;
  cols: number;
  rows: number;
  viewportY: number;
  baseY: number;
  presentation: string[];
  content: string[];
  text: string[];
};

const MIN_SCROLL_OVERLAP = 4;
const MIN_SCROLL_TEXT_ROWS = 3;
const MAX_PRESENTATION_MISMATCH_ROWS = 2;
const MAX_UNSCROLLED_ROWS = 2;

function rowHasText(signature: string): boolean { return signature.includes(':') ? /:[^,\s;]/.test(signature) : /\S/.test(signature); }

export function inspectVerticalScroll(previous: readonly string[], next: readonly string[], previousContent = previous, nextContent = next): ScrollDetection {
  if (!previous.length || previous.length !== next.length || previousContent.length !== previous.length || nextContent.length !== next.length) return { candidate: null, maxExactOverlap: 0, maxExactDelta: null, rejection: 'different-row-count' };
  const candidates: ScrollCandidate[] = [];
  let maxExactOverlap = 0; let maxExactDelta: number | null = null;
  let ambiguousRuns = false; let insufficientText = false; let insufficientRegion = false; let unchangedIncoming = false;
  const maxDelta = previous.length - MIN_SCROLL_OVERLAP;
  for (let delta = -maxDelta; delta <= maxDelta; delta += 1) {
    if (!delta) continue;
    let runStart = -1; let exactStart = -1; let presentationMismatchRows: number[] = [];
    const runs: { start: number; end: number; presentationMismatchRows: number[] }[] = [];
    const finish = (runEnd: number) => { if (runStart >= 0 && presentationMismatchRows.length <= MAX_PRESENTATION_MISMATCH_ROWS) runs.push({ start: runStart, end: runEnd, presentationMismatchRows }); };
    const finishExact = (runEnd: number) => { if (exactStart >= 0 && runEnd - exactStart > maxExactOverlap) { maxExactOverlap = runEnd - exactStart; maxExactDelta = delta; } };
    for (let row = 0; row <= next.length; row += 1) {
      const inRange = row < next.length && row + delta >= 0 && row + delta < previous.length;
      const exact = inRange && next[row] === previous[row + delta];
      const presentationOnly = inRange && !exact && nextContent[row] === previousContent[row + delta];
      if (exact) { if (exactStart < 0) exactStart = row; } else { finishExact(row); exactStart = -1; }
      if (exact || presentationOnly) { if (runStart < 0) { runStart = row; presentationMismatchRows = []; } if (presentationOnly) presentationMismatchRows.push(row); }
      else { finish(row); runStart = -1; presentationMismatchRows = []; }
    }
    finishExact(next.length);
    const longest = Math.max(...runs.map((run) => run.end - run.start), 0);
    const bestRuns = runs.filter((run) => run.end - run.start === longest);
    if (longest < MIN_SCROLL_OVERLAP) continue;
    if (bestRuns.length !== 1) { ambiguousRuns = true; continue; }
    const run = bestRuns[0];
    if (next.slice(run.start, run.end).filter(rowHasText).length < MIN_SCROLL_TEXT_ROWS) { insufficientText = true; continue; }
    const topRow = Math.min(run.start, run.start + delta); const bottomRow = Math.max(run.end, run.end + delta);
    if (bottomRow - topRow < previous.length - MAX_UNSCROLLED_ROWS) { insufficientRegion = true; continue; }
    let incomingChanged = false;
    const incomingStart = delta > 0 ? run.end : run.start + delta; const incomingEnd = delta > 0 ? run.end + delta : run.start;
    for (let row = incomingStart; row < incomingEnd; row += 1) if (next[row] !== previous[row]) { incomingChanged = true; break; }
    if (incomingChanged) candidates.push({ deltaRows: delta, topRow, bottomRow, overlapRows: longest, matchTopRow: run.start, matchBottomRow: run.end, presentationMismatchRows: run.presentationMismatchRows }); else unchangedIncoming = true;
  }
  candidates.sort((a, b) => b.overlapRows - a.overlapRows || Math.abs(a.deltaRows) - Math.abs(b.deltaRows));
  const best = candidates[0]; const candidate = best && (!candidates[1] || best.overlapRows >= candidates[1].overlapRows + 2) ? best : null;
  const rejection = candidate ? null : candidates.length > 1 ? 'ambiguous-candidates' : ambiguousRuns ? 'ambiguous-run' : insufficientText ? 'fewer-than-three-text-rows' : insufficientRegion ? 'region-too-small' : unchangedIncoming ? 'unchanged-incoming-band' : maxExactOverlap < MIN_SCROLL_OVERLAP ? 'no-four-row-exact-overlap' : 'no-eligible-candidate';
  return { candidate, maxExactOverlap, maxExactDelta, rejection };
}

export function detectVerticalScroll(previous: readonly string[], next: readonly string[], previousContent = previous, nextContent = next): ScrollCandidate | null { return inspectVerticalScroll(previous, next, previousContent, nextContent).candidate; }

function cellSignature(cell: IBufferCell | undefined): string {
  if (!cell) return ';';
  const attrs = ['isBold', 'isItalic', 'isUnderline', 'isStrikethrough', 'isOverline'].map((name) => Number(typeof cell[name as keyof IBufferCell] === 'function' && (cell[name as keyof IBufferCell] as unknown as () => number)())).join('');
  return `${cell.getChars().length}:${cell.getChars()},${cell.getWidth()},${cell.getFgColor()},${cell.getBgColor()},${Number(cell.isFgRGB())}${Number(cell.isBgRGB())}${Number(cell.isFgPalette())}${Number(cell.isBgPalette())},${Number(cell.isInverse())}${Number(cell.isDim())}${attrs}${Number(cell.isInvisible())};`;
}

export function snapshotTerminal(terminal: Terminal): TerminalScreenSnapshot {
  const buffer = terminal.buffer.active; const cell = buffer.getNullCell(); const presentation: string[] = []; const content: string[] = []; const text: string[] = [];
  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(buffer.viewportY + row); let signature = ''; let contentSignature = ''; let lineText = '';
    for (let column = 0; column < terminal.cols; column += 1) {
      const current = line?.getCell(column, cell); signature += cellSignature(current); contentSignature += current ? `${current.getChars().length}:${current.getChars()},${current.getWidth()};` : ';'; lineText += current?.getChars() ?? '';
    }
    presentation.push(signature); content.push(contentSignature); text.push(lineText);
  }
  return { buffer, cols: terminal.cols, rows: terminal.rows, viewportY: buffer.viewportY, baseY: buffer.baseY, presentation, content, text };
}
