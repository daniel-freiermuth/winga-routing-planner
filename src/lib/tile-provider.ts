// TileWindProvider / TileCurrentProvider: WindProvider and CurrentProvider
// implementations backed by pre-fetched Windy forecast tiles.
//
// ARCHITECTURE
// ────────────
//   The providers are data samplers, not coverage gatekeepers. Coverage
//   checking is handled by the WASM routing engine (WeatherStore::covers)
//   using the grid dimensions pushed via push_wind_frame/push_current_frame.
//   The worker dynamically expands the tile corridor when the frontier
//   approaches the grid edge (see worker.ts corridor expansion).
//
// LIFECYCLE (TileWindProvider)
// ────────────────────────────
//   1. Construct with model and optional zoom level.
//   2. Call load(bbox) — fetches model metadata and sets up tile grid.
//   3. Call prefetchForTime(timeMs) — lazily fetches tile data for a time bracket.
//   4. Use getWind / getWave — fully synchronous after prefetch.
//   5. Call load(expandedBbox) again on corridor expansion — resets tile grid,
//      keeps cached tiles (they remain valid at new positions).
//
// LIFECYCLE (TileCurrentProvider)
// ───────────────────────────────
//   1. Construct with optional zoom level.
//   2. Call load(bbox, fromMs, toMs) — fetches metadata and all tiles eagerly.
//   3. Use getCurrent — fully synchronous after load.
//
// TILE CACHING
// ─────────────
// Each tile is fetched once and its decoded RGBA buffer + header are stored
// in memory. At z=3, one tile covers ~45°×25–40°; at z=4, ~22°×12–20°.
// The cache accumulates across load() calls — old tiles remain valid and
// are reused when the corridor expands.
//
// BROWSER COMPATIBILITY
// ──────────────────────
// This module uses fetch() + OffscreenCanvas for JPEG decoding. No Node.js APIs.
// It runs in a browser or Web Worker (OffscreenCanvas is available in both).

import {
  WINDY_MODELS,
  buildTileUrl,
  decodeTileHeader,
  sampleTileBilinear,
  latLonToTile,
  latLonToPixelFrac,
  refToCompact,
  getValidTimes,
  fetchMinifest,
  browserRgbaDecoder,
} from '@winga-weather-routing/windy-lib';
import type { WindyModelKey, WindyTileHeader } from '@winga-weather-routing/windy-lib';
import type { BoundingBox, CurrentProvider, GribFileMeta, WindProvider, WindVector } from '../types';

// ── Cached tile ───────────────────────────────────────────────────────────────

interface CachedTile {
  rgba: Uint8Array;
  header: WindyTileHeader;
}

/** Fetch a tile (JPEG or PNG), decode to RGBA, extract header. Deduplicates by URL. */
const inflight = new Map<string, Promise<CachedTile>>();

async function fetchAndDecode(url: string): Promise<CachedTile> {
  let pending = inflight.get(url);
  if (pending !== undefined) return pending;
  pending = (async () => {
    const rgba = await browserRgbaDecoder(url);
    const header = decodeTileHeader(rgba);
    return { rgba, header };
  })();
  inflight.set(url, pending);
  pending.catch(() => inflight.delete(url));
  return pending;
}

/** Cache key: `${model}/${overlay}/${validTimeCompact}/${z}/${x}/${y}` */
function tileKey(model: string, overlay: string, validTime: string, z: number, x: number, y: number): string {
  return `${model}/${overlay}/${validTime}/${String(z)}/${String(x)}/${String(y)}`;
}

/** Find the closest minifest step to a target timestamp. Uses binary search on sorted steps. */
function closestStepIdx(steps: { iso: string; compact: string }[], targetMs: number, precomputedMs?: number[]): number {
  if (steps.length === 0) return 0;
  const ms = precomputedMs ?? steps.map((s) => new Date(s.iso).getTime());
  // Binary search for nearest
  let lo = 0,
    hi = ms.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((ms[mid] ?? 0) < targetMs) lo = mid + 1;
    else hi = mid;
  }
  // Check lo and lo-1 for closest
  if (lo > 0 && Math.abs((ms[lo - 1] ?? 0) - targetMs) <= Math.abs((ms[lo] ?? 0) - targetMs)) return lo - 1;
  return lo;
}

/** Determine all tile coordinates at zoom z that cover a bounding box. */
export function tilesForBbox(bbox: BoundingBox, z: number): { x: number; y: number }[] {
  const tl = latLonToTile(bbox.latMax, bbox.lonMin, z);
  const br = latLonToTile(bbox.latMin, bbox.lonMax, z);
  const n = 2 ** z;
  // When tl.x > br.x the bbox crosses the antimeridian: wrap x through the tile count.
  const xCount = tl.x <= br.x ? br.x - tl.x + 1 : n - tl.x + br.x + 1;
  const tiles: { x: number; y: number }[] = [];
  for (let i = 0; i < xCount; i++) {
    const x = (tl.x + i) % n;
    for (let y = tl.y; y <= br.y; y++) {
      tiles.push({ x, y });
    }
  }
  return tiles;
}

// ── TileWindProvider ──────────────────────────────────────────────────────────

export interface TileWindProviderOptions {
  /** NWP model for wind. Default: `'ecmwf'`. */
  windModel?: Exclude<WindyModelKey, 'cmems'>;
  /** Tile zoom level. Max 3 for ECMWF/GFS. Default: 3. */
  zoom?: number;
}

/**
 * Windy wind + wave tile provider: loads model metadata eagerly, fetches
 * tile data lazily per time step. Provides synchronous O(1) wind/wave lookups.
 *
 * ```
 * const wp = new TileWindProvider({ windModel: 'ecmwf', zoom });
 * await wp.load(bbox);
 * // Before each routing step:
 * await wp.prefetchForTime(timeMs);
 * // Then sample synchronously:
 * wp.getWindAtTime(lat, lon, timeMs);
 * ```
 */
export class TileWindProvider implements WindProvider {
  readonly times: Date[] = [];

  private readonly windModel: string;
  private readonly waveModel = 'ecmwf-wam';
  private readonly zoom: number;
  private readonly cache = new Map<string, CachedTile>();
  private windSteps: { iso: string; compact: string }[] = [];
  private waveSteps: { iso: string; compact: string }[] = [];
  private windStepsMs: number[] = []; // precomputed timestamps for fast lookup
  private waveStepsMs: number[] = [];
  private windModelRun = '';
  private waveModelRun = '';
  private tiles: { x: number; y: number }[] = [];

  constructor(opts: TileWindProviderOptions = {}) {
    const model = opts.windModel ?? 'ecmwf';
    this.windModel = WINDY_MODELS[model].minifestId;
    this.zoom = opts.zoom ?? 3;
  }

  /** Load metadata (model runs, time steps, tile grid). No tiles fetched yet. */
  async load(bbox: BoundingBox, _fromMs?: number, _toMs?: number): Promise<void> {
    const [windMf, waveMf] = await Promise.all([fetchMinifest(this.windModel), fetchMinifest(this.waveModel)]);

    this.windModelRun = refToCompact(windMf.ref);
    this.waveModelRun = refToCompact(waveMf.ref);
    this.windSteps = getValidTimes(windMf);
    this.waveSteps = getValidTimes(waveMf);
    this.windStepsMs = this.windSteps.map((s) => new Date(s.iso).getTime());
    this.waveStepsMs = this.waveSteps.map((s) => new Date(s.iso).getTime());
    this.tiles = tilesForBbox(bbox, this.zoom);

    // Build full time axis from all available wind steps
    this.times.length = 0;
    this.times.push(...this.windStepsMs.map((ms) => new Date(ms)));
  }

  /**
   * Fetch tiles for a specific time (and its neighbor for temporal interpolation).
   * Call before each algorithm step. Already-cached tiles are skipped.
   */
  async prefetchForTime(timeMs: number): Promise<void> {
    // Find the two bracketing wind steps for temporal interpolation
    const windIdxs = new Set<number>();
    const wi = closestStepIdx(this.windSteps, timeMs, this.windStepsMs);
    windIdxs.add(wi);
    if (wi > 0) windIdxs.add(wi - 1);
    if (wi < this.windSteps.length - 1) windIdxs.add(wi + 1);

    // Same for wave
    const waveIdxs = new Set<number>();
    const wvi = closestStepIdx(this.waveSteps, timeMs, this.waveStepsMs);
    waveIdxs.add(wvi);
    if (wvi > 0) waveIdxs.add(wvi - 1);
    if (wvi < this.waveSteps.length - 1) waveIdxs.add(wvi + 1);

    const fetches: Promise<void>[] = [];
    for (const t of this.tiles) {
      for (const si of windIdxs) {
        const step = this.windSteps[si];
        if (!step) continue;
        // Wind tiles
        const windKey = tileKey(this.windModel, 'wind', step.compact, this.zoom, t.x, t.y);
        if (!this.cache.has(windKey)) {
          const url = buildTileUrl(this.windModel, this.windModelRun, step.compact, this.zoom, t.x, t.y, 'wind');
          fetches.push(
            fetchAndDecode(url).then((tile) => {
              this.cache.set(windKey, tile);
            }),
          );
        }
        // Gust tiles (same model/steps as wind)
        const gustKey = tileKey(this.windModel, 'gust', step.compact, this.zoom, t.x, t.y);
        if (!this.cache.has(gustKey)) {
          const url = buildTileUrl(this.windModel, this.windModelRun, step.compact, this.zoom, t.x, t.y, 'gust');
          fetches.push(
            fetchAndDecode(url)
              .then((tile) => {
                this.cache.set(gustKey, tile);
              })
              .catch(() => {
                /* gust tiles may 404 */
              }),
          );
        }
      }
      for (const si of waveIdxs) {
        const step = this.waveSteps[si];
        if (!step) continue;
        const key = tileKey(this.waveModel, 'waves', step.compact, this.zoom, t.x, t.y);
        if (!this.cache.has(key)) {
          const url = buildTileUrl(
            this.waveModel,
            this.waveModelRun,
            step.compact,
            this.zoom,
            t.x,
            t.y,
            'waves',
            'surface',
            'png',
          );
          fetches.push(
            fetchAndDecode(url)
              .then((tile) => {
                this.cache.set(key, tile);
              })
              .catch(() => {
                /* wave tiles may 404 over land */
              }),
          );
        }
      }
    }
    if (fetches.length > 0) await Promise.all(fetches);
  }

  getWind(lat: number, lon: number, timeIdx: number): WindVector {
    const step = this.windSteps[this.stepIdxForTimeIdx(timeIdx)];
    if (step === undefined) return { u: 0, v: 0 };
    return this.sampleWind(lat, lon, step.compact);
  }

  getWave(lat: number, lon: number, t: Date): number | undefined {
    const idx = closestStepIdx(this.waveSteps, t.getTime(), this.waveStepsMs);
    const step = this.waveSteps[idx];
    if (step === undefined) return undefined;
    return this.sampleWaveTile(lat, lon, step.compact)?.height;
  }

  // Cache the last time-bracket index to avoid repeated binary searches
  // (algorithm queries the same timeMs for many points within each step)
  private lastTimeMs = -1;
  private lastTimeBracket = 0;
  private lastTimeFrac = 0;

  getWindAtTime(lat: number, lon: number, timeMs: number): WindVector {
    const times = this.times;
    if (times.length === 0) return { u: 0, v: 0 };
    const first = times[0];
    const last = times[times.length - 1];
    if (first === undefined || last === undefined) return { u: 0, v: 0 };
    if (timeMs <= first.getTime()) return this.getWindByDate(lat, lon, first);
    if (timeMs >= last.getTime()) return this.getWindByDate(lat, lon, last);

    // Reuse cached bracket if same timeMs (very common — same time for all frontier points)
    let i: number;
    let f: number;
    if (timeMs === this.lastTimeMs) {
      i = this.lastTimeBracket;
      f = this.lastTimeFrac;
    } else {
      // Binary search for bracket
      let lo = 0,
        hi = times.length - 2;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((times[mid]?.getTime() ?? 0) <= timeMs) lo = mid;
        else hi = mid - 1;
      }
      i = lo;
      const t0 = times[i]?.getTime() ?? 0;
      const t1 = times[i + 1]?.getTime() ?? 0;
      f = (timeMs - t0) / (t1 - t0);
      this.lastTimeMs = timeMs;
      this.lastTimeBracket = i;
      this.lastTimeFrac = f;
    }

    // If very close to a step boundary, skip interpolation
    if (f < 0.01) {
      const t = times[i];
      return t ? this.getWindByDate(lat, lon, t) : { u: 0, v: 0 };
    }
    if (f > 0.99) {
      const t = times[i + 1];
      return t ? this.getWindByDate(lat, lon, t) : { u: 0, v: 0 };
    }

    const ti = times[i],
      ti1 = times[i + 1];
    const w0 = ti ? this.getWindByDate(lat, lon, ti) : { u: 0, v: 0 };
    const w1 = ti1 ? this.getWindByDate(lat, lon, ti1) : { u: 0, v: 0 };

    return {
      u: w0.u * (1 - f) + w1.u * f,
      v: w0.v * (1 - f) + w1.v * f,
    };
  }

  /** Generic temporal interpolation for scalar values over a set of forecast steps. */
  private interpolateOverTime(
    stepsMs: number[],
    steps: { iso: string; compact: string }[],
    timeMs: number,
    sample: (validTime: string) => number | undefined,
  ): number | undefined {
    if (steps.length === 0) return undefined;
    const i = closestStepIdx(steps, timeMs, stepsMs);
    const s0 = steps[i];
    if (!s0) return undefined;
    if (i >= steps.length - 1) return sample(s0.compact);
    const t0 = stepsMs[i] ?? 0;
    const t1 = stepsMs[i + 1] ?? 0;
    if (t1 <= t0) return sample(s0.compact);
    const f = Math.max(0, Math.min(1, (timeMs - t0) / (t1 - t0)));
    if (f < 0.01) return sample(s0.compact);
    const s1 = steps[i + 1];
    if (!s1) return sample(s0.compact);
    if (f > 0.99) return sample(s1.compact);
    const v0 = sample(s0.compact);
    const v1 = sample(s1.compact);
    if (v0 === undefined) return v1;
    if (v1 === undefined) return v0;
    return v0 * (1 - f) + v1 * f;
  }

  /** Sample wave tile at a position: returns height (B), period and direction (R/G vector). */
  private sampleWaveTile(
    lat: number,
    lon: number,
    validTime: string,
  ): { height: number; period: number; direction: number } | undefined {
    const { x, y } = latLonToTile(lat, lon, this.zoom);
    const key = tileKey(this.waveModel, 'waves', validTime, this.zoom, x, y);
    const tile = this.cache.get(key);
    if (tile === undefined) return undefined;
    const { px, py } = latLonToPixelFrac(lat, lon, this.zoom, x, y);
    const val = sampleTileBilinear(tile.rgba, tile.header, px, py, false, true);
    if (!val.hasData) return undefined;
    return { height: val.height, period: val.speed, direction: val.direction };
  }

  /** Sample gust speed (m/s) at a specific valid time. Gust is a scalar (R channel). */
  private sampleGust(lat: number, lon: number, validTime: string): number | undefined {
    const { x, y } = latLonToTile(lat, lon, this.zoom);
    const key = tileKey(this.windModel, 'gust', validTime, this.zoom, x, y);
    const tile = this.cache.get(key);
    if (tile === undefined) return undefined;
    const { px, py } = latLonToPixelFrac(lat, lon, this.zoom, x, y);
    const val = sampleTileBilinear(tile.rgba, tile.header, px, py, false);
    return val.hasData ? val.u : undefined;
  }

  getWaveAtTime(lat: number, lon: number, timeMs: number): number | undefined {
    return this.interpolateOverTime(
      this.waveStepsMs,
      this.waveSteps,
      timeMs,
      (vt) => this.sampleWaveTile(lat, lon, vt)?.height,
    );
  }

  getWavePeriodAtTime(lat: number, lon: number, timeMs: number): number | undefined {
    return this.interpolateOverTime(
      this.waveStepsMs,
      this.waveSteps,
      timeMs,
      (vt) => this.sampleWaveTile(lat, lon, vt)?.period,
    );
  }

  getWaveDirAtTime(lat: number, lon: number, timeMs: number): number | undefined {
    return this.interpolateOverTime(
      this.waveStepsMs,
      this.waveSteps,
      timeMs,
      (vt) => this.sampleWaveTile(lat, lon, vt)?.direction,
    );
  }

  getGustAtTime(lat: number, lon: number, timeMs: number): number | undefined {
    return this.interpolateOverTime(this.windStepsMs, this.windSteps, timeMs, (vt) => this.sampleGust(lat, lon, vt));
  }

  /** Compute optimal zoom level so the route area fits within maxTilesPerDim tiles.
   *  Capped at zoom 4 — Windy tile CDN only serves zoom 3 and 4. */
  static computeZoom(bbox: BoundingBox, maxTilesPerDim = 2): number {
    const latSpan = bbox.latMax - bbox.latMin;
    const lonSpan = bbox.lonMax - bbox.lonMin;
    const span = Math.max(latSpan, lonSpan);
    const z = Math.floor(Math.log2((maxTilesPerDim * 360) / span));
    return Math.max(3, Math.min(z, 4)); // Windy serves zoom 3–4 only
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /** Map a times[] index to the closest wind step index. */
  private stepIdxForTimeIdx(timeIdx: number): number {
    const t = this.times[timeIdx];
    if (t === undefined) return 0;
    return closestStepIdx(this.windSteps, t.getTime(), this.windStepsMs);
  }

  private sampleWind(lat: number, lon: number, validTime: string): WindVector {
    const { x, y } = latLonToTile(lat, lon, this.zoom);
    const key = tileKey(this.windModel, 'wind', validTime, this.zoom, x, y);
    const tile = this.cache.get(key);
    if (tile === undefined) return { u: 0, v: 0 };
    const { px, py } = latLonToPixelFrac(lat, lon, this.zoom, x, y);
    const val = sampleTileBilinear(tile.rgba, tile.header, px, py, false);
    return { u: val.u, v: val.v };
  }

  private getWindByDate(lat: number, lon: number, t: Date): WindVector {
    const idx = closestStepIdx(this.windSteps, t.getTime(), this.windStepsMs);
    const step = this.windSteps[idx];
    if (!step) return { u: 0, v: 0 };
    return this.sampleWind(lat, lon, step.compact);
  }
}

// ── TileCurrentProvider ───────────────────────────────────────────────────────

/**
 * Pre-fetch CMEMS ocean current tiles for a geographic area and time range,
 * then provide synchronous current lookups for the routing algorithm.
 */
export class TileCurrentProvider implements CurrentProvider {
  readonly times: Date[] = [];
  readonly meta: GribFileMeta;

  private readonly zoom: number;
  private readonly cache = new Map<string, CachedTile>();
  private steps: { iso: string; compact: string }[] = [];
  private stepsMs: number[] = [];
  private modelRun = '';
  private tiles: { x: number; y: number }[] = [];
  private loaded = false;

  constructor(zoom = 3) {
    this.zoom = zoom;
    // Synthetic meta for the routing algorithm (only used by UI, not routing core).
    this.meta = {
      path: 'windy/cmems',
      mtime: Date.now(),
      type: 'current',
      latMin: -90,
      latMax: 90,
      lonMin: -180,
      lonMax: 180,
      latStep: 0.1,
      lonStep: 0.1,
      timeStart: new Date(),
      timeEnd: new Date(),
      nTimes: 0,
      referenceTime: new Date(),
    };
  }

  async load(bbox: BoundingBox, fromMs: number, toMs: number): Promise<void> {
    const mf = await fetchMinifest('cmems');
    this.modelRun = refToCompact(mf.ref);
    this.steps = getValidTimes(mf);
    this.stepsMs = this.steps.map((s) => new Date(s.iso).getTime());
    this.tiles = tilesForBbox(bbox, this.zoom);

    const horizonMs = new Date(mf.end).getTime();
    const effectiveToMs = Math.min(toMs, horizonMs);

    const timesSet = new Set<number>();
    for (const s of this.steps) {
      const ms = new Date(s.iso).getTime();
      if (ms >= fromMs && ms <= effectiveToMs) timesSet.add(ms);
    }
    const sortedMs = [...timesSet].sort((a, b) => a - b);
    this.times.length = 0;
    this.times.push(...sortedMs.map((ms) => new Date(ms)));

    // Update synthetic meta
    this.meta.timeStart = this.times[0] ?? new Date();
    this.meta.timeEnd = this.times[this.times.length - 1] ?? new Date();
    this.meta.nTimes = this.times.length;
    this.meta.referenceTime = new Date(mf.ref);
    this.meta.latMin = bbox.latMin;
    this.meta.latMax = bbox.latMax;
    this.meta.lonMin = bbox.lonMin;
    this.meta.lonMax = bbox.lonMax;

    const fetches: Promise<void>[] = [];
    for (const t of this.tiles) {
      for (const step of this.steps) {
        const ms = new Date(step.iso).getTime();
        if (ms < fromMs || ms > effectiveToMs) continue;
        const key = tileKey('cmems', 'seacurrents', step.compact, this.zoom, t.x, t.y);
        if (!this.cache.has(key)) {
          const url = buildTileUrl('cmems', this.modelRun, step.compact, this.zoom, t.x, t.y, 'seacurrents');
          fetches.push(
            fetchAndDecode(url)
              .then((tile) => {
                this.cache.set(key, tile);
              })
              .catch(() => {
                /* may fail over land */
              }),
          );
        }
      }
    }
    await Promise.all(fetches);
    this.loaded = true;
  }

  getCurrent(lat: number, lon: number, t: Date): WindVector {
    if (!this.loaded || this.steps.length === 0) return { u: 0, v: 0 };
    const timeMs = t.getTime();
    const i = closestStepIdx(this.steps, timeMs, this.stepsMs);

    // Temporal interpolation between bracketing steps
    if (i < this.steps.length - 1) {
      const t0 = this.stepsMs[i] ?? 0;
      const t1 = this.stepsMs[i + 1] ?? 0;
      if (t1 > t0) {
        const f = Math.max(0, Math.min(1, (timeMs - t0) / (t1 - t0)));
        if (f > 0.01 && f < 0.99) {
          const s0 = this.steps[i],
            s1 = this.steps[i + 1];
          if (s0 && s1) {
            const c0 = this.sampleCurrent(lat, lon, s0.compact);
            const c1 = this.sampleCurrent(lat, lon, s1.compact);
            return { u: c0.u * (1 - f) + c1.u * f, v: c0.v * (1 - f) + c1.v * f };
          }
        }
      }
    }
    const step = this.steps[i];
    return step ? this.sampleCurrent(lat, lon, step.compact) : { u: 0, v: 0 };
  }

  private sampleCurrent(lat: number, lon: number, validTime: string): WindVector {
    const { x, y } = latLonToTile(lat, lon, this.zoom);
    const key = tileKey('cmems', 'seacurrents', validTime, this.zoom, x, y);
    const tile = this.cache.get(key);
    if (tile === undefined) return { u: 0, v: 0 };
    const { px, py } = latLonToPixelFrac(lat, lon, this.zoom, x, y);
    const val = sampleTileBilinear(tile.rgba, tile.header, px, py, true);
    return val.hasData ? { u: val.u, v: val.v } : { u: 0, v: 0 };
  }
}
