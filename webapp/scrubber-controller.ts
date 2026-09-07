// Scrubber controller — pure computation functions for the time scrubber.
// No DOM access. Returns data that the Svelte template renders reactively.

import type { WaypointMeta, GribFileMeta } from './types';

const C64_PALETTE = [
  '#6c7086',
  '#ffffff',
  '#883932',
  '#67b6bd',
  '#8b3f96',
  '#55a049',
  '#40318d',
  '#bfce72',
  '#8b5429',
  '#574200',
];

export interface ScrubberState {
  windTimes: string[];
  scrubberLockedToRoute: boolean;
  routeScrubberRange: { i0: number; iN: number } | null;
  graphMeta: WaypointMeta[] | null;
  gribInfoFiles: GribFileMeta[];
  enabledGribPaths: Set<string>;
  currentEnabled: boolean;
  currentFileTimes: string[];
}

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

/** Build coverage bar HTML string for reactive rendering. */
export function computeCoverageHtml(rangeStart: number, rangeEnd: number, state: ScrubberState): string {
  const span = Math.max(1, rangeEnd - rangeStart);
  const rows: string[] = [];

  const addRow = (color: string, si: number, ei: number) => {
    si = Math.max(si, rangeStart);
    ei = Math.min(ei, rangeEnd);
    if (si > ei) return;
    const p1 = (((si - rangeStart) / span) * 100).toFixed(2);
    const p2 = (((ei - rangeStart) / span) * 100).toFixed(2);
    rows.push(
      `<div style="height:4px;border-radius:2px;background:linear-gradient(to right,#313244 0% ${p1}%,${color} ${p1}% ${p2}%,#313244 ${p2}% 100%)"></div>`,
    );
  };

  if (state.scrubberLockedToRoute && state.graphMeta?.some((m) => m.gribFile != null) === true) {
    const stops: string[] = [];
    for (let i = 0; i < state.graphMeta.length; i++) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const tMs = new Date(state.graphMeta[i]!.time).getTime();
      let si = state.windTimes.findIndex((t) => new Date(t).getTime() >= tMs);
      if (si < 0) si = rangeEnd;
      const windTimeAtEnd = state.windTimes[rangeEnd];
      const nextMs =
        i < state.graphMeta.length - 1
          ? // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            new Date(state.graphMeta[i + 1]!.time).getTime()
          : windTimeAtEnd !== undefined
            ? new Date(windTimeAtEnd).getTime()
            : tMs;
      let ei = state.windTimes.findIndex((t) => new Date(t).getTime() >= nextMs);
      if (ei < 0) ei = rangeEnd;
      ei = Math.max(si, ei - 1);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const fp = state.graphMeta[i]!.gribFile;
      const colorIdx = fp != null ? state.gribInfoFiles.findIndex((f) => f.path === fp) : -1;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const color = colorIdx >= 0 ? C64_PALETTE[colorIdx % C64_PALETTE.length]! : '#45475a';
      const a = (((Math.max(rangeStart, Math.min(rangeEnd, si)) - rangeStart) / span) * 100).toFixed(2);
      const b = (((Math.max(rangeStart, Math.min(rangeEnd, ei)) - rangeStart) / span) * 100).toFixed(2);
      stops.push(`${color} ${a}% ${b}%`);
    }
    if (stops.length > 0) {
      rows.push(
        `<div style="height:4px;border-radius:2px;background:linear-gradient(to right,${stops.join(',')})"></div>`,
      );
    }
  } else {
    state.gribInfoFiles.forEach((f, i) => {
      if (f.type === 'current' || !state.enabledGribPaths.has(f.path)) return;
      const startMs = new Date(f.timeStart).getTime();
      const endMs = new Date(f.timeEnd).getTime();
      const si = state.windTimes.findIndex((t) => new Date(t).getTime() >= startMs);
      const ei = state.windTimes.findLastIndex((t) => new Date(t).getTime() <= endMs);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      addRow(C64_PALETTE[i % C64_PALETTE.length]!, si, ei);
    });
  }

  if (state.currentEnabled && state.currentFileTimes.length > 0) {
    const currentSet = new Set(state.currentFileTimes);
    const si = state.windTimes.findIndex((t) => currentSet.has(t));
    const ei = state.windTimes.findLastIndex((t) => currentSet.has(t));
    addRow('#89dceb', si, ei);
  }

  return rows.join('');
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
