import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

export type ScrollbackScrollbarState = {
  sessionId: string;
  viewportY: number;
  baseY: number;
  rows: number;
  activity: number;
};

export type ScrollbackMetrics = {
  thumbTop: number;
  thumbHeight: number;
  trackHeight: number;
  maxViewportY: number;
};

const MIN_THUMB_HEIGHT = 24;
const MAX_SMOOTH_DRAG_SPEED = 1;

export function isSlowScrollbarDrag(distance: number, elapsedMs: number): boolean {
  return Math.abs(distance) / Math.max(1, elapsedMs) <= MAX_SMOOTH_DRAG_SPEED;
}

export function scrollbackMetrics(
  state: Pick<ScrollbackScrollbarState, 'viewportY' | 'baseY' | 'rows'>,
  trackHeight: number,
  minThumbHeight = MIN_THUMB_HEIGHT,
): ScrollbackMetrics | null {
  const rows = Math.max(0, Math.floor(state.rows));
  const baseY = Math.max(0, Math.floor(state.baseY));
  const viewportY = Math.max(0, Math.min(baseY, Math.floor(state.viewportY)));
  const height = Math.max(0, trackHeight);
  if (!rows || baseY <= 0 || height <= 0) return null;
  const totalRows = baseY + rows;
  const thumbHeight = Math.min(height, Math.max(minThumbHeight, height * rows / totalRows));
  const travel = Math.max(0, height - thumbHeight);
  return {
    thumbTop: travel * (viewportY / baseY),
    thumbHeight,
    trackHeight: height,
    maxViewportY: baseY,
  };
}

type Props = {
  state: ScrollbackScrollbarState | null;
  onScrollTo: (line: number, smooth: boolean) => void;
};

export function ScrollbackScrollbar({ state, onScrollTo }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  const dragRef = useRef<{ pointerId: number; offset: number; lastY: number; lastTime: number } | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const [trackHeight, setTrackHeight] = useState(1);
  const [hiddenActivity, setHiddenActivity] = useState<number | null>(null);
  const hasState = state !== null;
  const sessionId = state?.sessionId;
  const activity = state?.activity;

  useEffect(() => { stateRef.current = state; }, [state]);

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const measure = () => setTrackHeight(track.getBoundingClientRect().height || track.clientHeight || 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, [hasState]);

  useEffect(() => {
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    if (!hasState) {
      dragRef.current = null;
      return;
    }
    hideTimerRef.current = window.setTimeout(() => setHiddenActivity(activity ?? null), 2000);
    return () => { if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current); };
  }, [hasState, sessionId, activity]);

  if (!state) return null;
  const visible = hiddenActivity !== state.activity;
  const metrics = scrollbackMetrics(state, trackHeight);
  if (!metrics) return null;
  const valueMax = metrics.maxViewportY;

  const release = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (thumbRef.current?.hasPointerCapture(event.pointerId)) thumbRef.current.releasePointerCapture(event.pointerId);
    setHiddenActivity(null);
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setHiddenActivity(stateRef.current?.activity ?? null), 2000);
  };

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const current = stateRef.current;
    const track = trackRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !current || !track) return;
    const rect = track.getBoundingClientRect();
    const currentMetrics = scrollbackMetrics(current, rect.height || trackHeight);
    if (!currentMetrics) return;
    const travel = Math.max(1, currentMetrics.trackHeight - currentMetrics.thumbHeight);
    const thumbTop = Math.max(0, Math.min(travel, event.clientY - rect.top - drag.offset));
    const elapsed = event.timeStamp - drag.lastTime;
    const smooth = isSlowScrollbarDrag(event.clientY - drag.lastY, elapsed);
    drag.lastY = event.clientY;
    drag.lastTime = event.timeStamp;
    onScrollTo(Math.round(thumbTop / travel * currentMetrics.maxViewportY), smooth);
  };

  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !thumbRef.current || !trackRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const thumbRect = thumbRef.current.getBoundingClientRect();
    dragRef.current = { pointerId: event.pointerId, offset: event.clientY - thumbRect.top, lastY: event.clientY, lastTime: event.timeStamp };
    thumbRef.current.setPointerCapture(event.pointerId);
    setHiddenActivity(null);
  };

  return (
    <div ref={trackRef} className={`scrollback-scrollbar${visible ? ' is-visible' : ''}`} aria-hidden={!visible}>
      <div
        ref={thumbRef}
        className="scrollback-scrollbar-thumb"
        role="scrollbar"
        aria-label="Terminal scrollback"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={valueMax}
        aria-valuenow={Math.max(0, Math.min(valueMax, state.viewportY))}
        style={{ height: `${metrics.thumbHeight}px`, transform: `translateY(${metrics.thumbTop}px)` }}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={release}
        onPointerCancel={release}
      />
    </div>
  );
}
