/** 83.46 -> "1:23.5" */
export function formatTime(seconds: number): string {
  const tenths = Math.round(Math.max(0, seconds) * 10);
  const minutes = Math.floor(tenths / 600);
  const rest = (tenths % 600) / 10;
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`;
}

/** Signed, whole seconds: -5 -> "-0:05" */
export function formatOffset(seconds: number): string {
  const sign = seconds < -0.5 ? '-' : '';
  const s = Math.round(Math.abs(seconds));
  return `${sign}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
