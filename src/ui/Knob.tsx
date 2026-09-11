import { useRef } from 'react';

export function formatValue(value: number): string { return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''); }

export function Knob({ value, min, max, step, label, onChange, disabled }: { value: number; min: number; max: number; step: number; label: string; onChange: (value: number) => void; disabled?: boolean }) {
  const start = useRef<{ y: number; value: number } | null>(null); const ratio = (value - min) / (max - min);
  return <div className={`knob ${disabled ? 'disabled' : ''}`} role="slider" aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} aria-disabled={disabled ? 'true' : undefined} tabIndex={disabled ? -1 : 0} style={{ '--knob-progress': `${ratio * 340}deg` } as React.CSSProperties}
    onPointerDown={(event) => { if (disabled) return; start.current = { y: event.clientY, value }; event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={(event) => { if (disabled || !start.current || !event.buttons) return; const next = Math.min(max, Math.max(min, start.current.value + (start.current.y - event.clientY) * step / 8)); onChange(Math.round(next / step) * step); }} onPointerUp={() => { start.current = null; }}
    onWheel={(event) => { if (disabled) return; event.preventDefault(); onChange(Math.min(max, Math.max(min, value + (event.deltaY < 0 ? step : -step)))); }} onKeyDown={(event) => { if (disabled) return; if (event.key === 'ArrowUp' || event.key === 'ArrowRight') onChange(Math.min(max, value + step)); if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') onChange(Math.max(min, value - step)); }}><span>{formatValue(value)}</span></div>;
}
