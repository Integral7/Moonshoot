// Mission clock formatting.

const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, '0');

/**
 * Mission Elapsed Time: "T+00:12:34", "T+3d 04:12:00", or "T-00:00:10" for a
 * countdown (negative t).
 */
export function formatMET(t: number): string {
  const sign = t < 0 ? '-' : '+';
  let s = Math.floor(Math.abs(t));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const hms = `${pad(h)}:${pad(m)}:${pad(s)}`;
  return d > 0 ? `T${sign}${d}d ${hms}` : `T${sign}${hms}`;
}

/** Compact duration: "45 s", "12 m 05 s", "3 h 20 m", "4 d 06 h". */
export function formatDuration(t: number): string {
  if (!Number.isFinite(t)) return '--';
  const a = Math.abs(t);
  const sign = t < 0 ? '-' : '';
  if (a < 60) return `${sign}${a.toFixed(a < 10 ? 1 : 0)} s`;
  if (a < 3600) return `${sign}${Math.floor(a / 60)} m ${pad(a % 60)} s`;
  if (a < 86400) return `${sign}${Math.floor(a / 3600)} h ${pad((a % 3600) / 60)} m`;
  return `${sign}${Math.floor(a / 86400)} d ${pad((a % 86400) / 3600)} h`;
}

/** Distance with adaptive units: m, km, or Mm-scale km with separators. */
export function formatDistance(m: number): string {
  if (!Number.isFinite(m)) return '--';
  const a = Math.abs(m);
  if (a < 10_000) return `${m.toFixed(0)} m`;
  if (a < 1_000_000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000).toLocaleString('en-US')} km`;
}

export function formatSpeed(ms: number): string {
  if (!Number.isFinite(ms)) return '--';
  return Math.abs(ms) < 1000 ? `${ms.toFixed(1)} m/s` : `${(ms / 1000).toFixed(3)} km/s`;
}
