// Scrubber controller — pure computation functions for the time scrubber.
// No DOM access. Returns data that the Svelte template renders reactively.

/** Compute the time label text for a given scrubber index. */
export function computeLabel(idx: number, windTimes: string[]): string {
  const t = windTimes[idx];
  if (t === undefined || t === '') return '';
  return new Date(t).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Compute the now-marker CSS left position (or null if not visible). */
export function computeNowMarkerLeft(rangeStart: number, rangeEnd: number, windTimes: string[]): string | null {
  const nowMs = Date.now();
  const nowIdx = windTimes.findIndex((t) => new Date(t).getTime() >= nowMs);
  if (nowIdx >= rangeStart && nowIdx <= rangeEnd && rangeEnd > rangeStart) {
    return `${(((nowIdx - rangeStart) / (rangeEnd - rangeStart)) * 100).toFixed(2)}%`;
  }
  return null;
}

/** Find the nearest wind time index to "now". */
export function findNowIndex(windTimes: string[]): number {
  const nowMs = Date.now();
  let idx = windTimes.findIndex((t) => new Date(t).getTime() >= nowMs);
  if (idx < 0) idx = windTimes.length - 1;
  return Math.max(0, idx);
}
