// Shared reactive stores — data channel between imperative modules and Svelte components.
// Only stores that are written by .ts modules and read by .svelte components belong here.

import { writable } from 'svelte/store';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WindPoint {
  lat: number;
  lon: number;
  u: number;
  v: number;
}
export interface WavePoint {
  lat: number;
  lon: number;
  waveHeight: number;
}
export interface CurrentPoint {
  lat: number;
  lon: number;
  u: number;
  v: number;
}

export interface WaveGridMeta {
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
  latStep: number;
  lonStep: number;
}

// ── Overlay data (written by forecast-fetcher.ts, read by App.svelte) ─────────

export const windPoints = writable<WindPoint[]>([]);
export const wavePoints = writable<WavePoint[]>([]);
export const currentPoints = writable<CurrentPoint[]>([]);
export const waveGridMetaStore = writable<WaveGridMeta | null>(null);

// ── Config (written by config.ts, read by App.svelte) ─────────────────────────

export const waveOverlayMaxMStore = writable(3.0);

// ── Forecast readiness (written by App.svelte, read by time-axis.ts) ──────────

export const forecastLoaded = writable(false);
