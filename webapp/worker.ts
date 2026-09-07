// Routing Web Worker — session-driven loop with on-demand weather streaming.
//
// PROTOCOL
// ─────────
// Main thread → Worker:
//   { type: 'calculate', payload: CalculateRequest }
//
// Worker → Main thread:
//   { type: 'progress', pct: number, frontier: [number,number][] }
//   { type: 'result', route: RoutePoint[], warning?: string }
//   { type: 'error', message: string }

import { TileWindProvider, TileCurrentProvider } from '../src/lib/tile-provider';
import { parsePolarCsv } from '../src/lib/polar';
import { windSpeedKnots, windDirection } from '../src/lib/geo';
import type { BoundingBox, CalculationRequest, RoutePoint } from '../src/types';

// ── Message types ─────────────────────────────────────────────────────────────

interface CalculatePayload {
  request: CalculationRequest;
  polarCsv: string;
  tileBbox: BoundingBox;
  landIndexUrl: string;
  dilatedIndexUrl?: string;
  windModel?: 'ecmwf' | 'gfs' | 'icon';
  useSafetyMargin?: boolean;
}

interface InMessage {
  type: 'calculate';
  payload: CalculatePayload;
}

type OutMessage =
  | {
      type: 'progress';
      pct: number;
      frontier: [number, number][];
      legOrigin?: [number, number];
      clearIsochrones?: boolean;
      status?: string;
    }
  | { type: 'result'; route: RoutePoint[]; warning?: string }
  | { type: 'error'; message: string };

function post(msg: OutMessage): void {
  postMessage(msg);
}

// ── Single remaining WASM callback: progress ──────────────────────────────────
// The WASM RouterSession calls js_on_progress during step() to report frontier.

const _self = globalThis as Record<string, unknown>;
let lastPct = 0;
let lastFrontierLats: number[] = [];
let lastFrontierLons: number[] = [];

_self['js_on_progress'] = (pct: number, frontier: Float64Array): void => {
  lastPct = pct;
  lastFrontierLats = [];
  lastFrontierLons = [];
  const pairs: [number, number][] = [];
  for (let i = 0; i < frontier.length; i += 2) {
    /* eslint-disable @typescript-eslint/no-non-null-assertion -- hot loop, i bounded by frontier.length */
    lastFrontierLats.push(frontier[i]!);
    lastFrontierLons.push(frontier[i + 1]!);
    pairs.push([frontier[i]!, frontier[i + 1]!]);
    /* eslint-enable @typescript-eslint/no-non-null-assertion */
  }
  post({ type: 'progress', pct, frontier: pairs });
};

// ── WASM loading ──────────────────────────────────────────────────────────────

interface WasmModule {
  RouterSession: new (
    polar_twa: Float64Array,
    polar_tws: Float64Array,
    polar_speeds: Float64Array,
    legs: Float64Array,
    departure_ms: number,
    forecast_end_ms: number,
    options: Float64Array,
    land_index: Uint8Array,
  ) => WasmRouterSession;
}

interface WasmRouterSession {
  push_wind_frame(
    time_ms: number,
    u: Float32Array,
    v: Float32Array,
    lat_min: number,
    lon_min: number,
    lat_step: number,
    lon_step: number,
    n_lat: number,
    n_lon: number,
  ): void;
  push_current_frame(
    time_ms: number,
    u: Float32Array,
    v: Float32Array,
    lat_min: number,
    lon_min: number,
    lat_step: number,
    lon_step: number,
    n_lat: number,
    n_lon: number,
  ): void;
  needs(): Float64Array;
  step(): number;
  progress(): Float64Array;
  route(): Float64Array;
  error(): string | undefined;
  evict_old_frames(): void;
  clear_weather(): void;
  free(): void;
}

let wasmModule: WasmModule | null = null;

async function loadWasm(): Promise<WasmModule> {
  if (wasmModule) return wasmModule;
  // Dynamic import: WASM build artifact, not known at author time; types available after build:wasm
  const mod = await import('./wasm-pkg/wasm_router.js');
  await mod.default();
  const loaded = mod as WasmModule;
  wasmModule = loaded;
  console.log('[routing] WASM module loaded');
  return loaded;
}

// ── Shared helpers ────────────────────────────────────────────────────────────

async function fetchGzBinary(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${String(r.status)}: ${url}`);
  const buf = await r.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const isGzipped = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (!isGzipped) return buf;
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  void writer.write(bytes).then(async () => writer.close());
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    const chunk: Uint8Array = result.value;
    chunks.push(chunk);
    total += chunk.length;
  }
  const combined = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    combined.set(c, off);
    off += c.length;
  }
  return combined.buffer;
}

// ── Weather grid pre-sampling ─────────────────────────────────────────────────
// Sample tile data onto a regular lat/lon grid for passing to WASM.

interface WeatherGrid {
  u: Float32Array;
  v: Float32Array;
  latMin: number;
  lonMin: number;
  latStep: number;
  lonStep: number;
  nLat: number;
  nLon: number;
}

/** Spatial grid metadata for the corridor (shared by wind/current/land sampling). */
interface CorridorGridSpec {
  latMin: number;
  lonMin: number;
  latStep: number;
  lonStep: number;
  nLat: number;
  nLon: number;
}

/**
 * Build the corridor grid spec from the route bounding box.
 * Step size matches the tile pixel spacing at the given zoom level
 * so we don't alias away fine structure (e.g. Skagerrak eddies at z=4).
 */
function corridorGridSpec(bbox: BoundingBox, zoom: number): CorridorGridSpec {
  // Tile pixel spacing: 360 / (2^z * 256) degrees
  const step = 360 / (Math.pow(2, zoom) * 256);
  // Round step to a clean fraction to avoid floating-point drift
  const cleanStep = Math.round(step * 10000) / 10000;
  const latMin = Math.floor(bbox.latMin / cleanStep) * cleanStep;
  const lonMin = Math.floor(bbox.lonMin / cleanStep) * cleanStep;
  const latMax = Math.ceil(bbox.latMax / cleanStep) * cleanStep;
  const lonMax = Math.ceil(bbox.lonMax / cleanStep) * cleanStep;
  const nLat = Math.round((latMax - latMin) / cleanStep) + 1;
  const nLon = Math.round((lonMax - lonMin) / cleanStep) + 1;
  return { latMin, lonMin, latStep: cleanStep, lonStep: cleanStep, nLat, nLon };
}

/**
 * Sample wind at a specific forecast time onto the corridor grid.
 */
function sampleWindGrid(provider: TileWindProvider, timeMs: number, spec: CorridorGridSpec): WeatherGrid {
  const { latMin, lonMin, latStep, lonStep, nLat, nLon } = spec;
  const u = new Float32Array(nLat * nLon);
  const v = new Float32Array(nLat * nLon);
  for (let iLat = 0; iLat < nLat; iLat++) {
    const lat = latMin + iLat * latStep;
    for (let iLon = 0; iLon < nLon; iLon++) {
      const lon = lonMin + iLon * lonStep;
      const w = provider.getWindAtTime(lat, lon, timeMs);
      const idx = iLat * nLon + iLon;
      u[idx] = w.u;
      v[idx] = w.v;
    }
  }
  return { u, v, latMin, lonMin, latStep, lonStep, nLat, nLon };
}

/**
 * Sample current at a specific time onto the corridor grid.
 */
function sampleCurrentGrid(provider: TileCurrentProvider, timeMs: number, spec: CorridorGridSpec): WeatherGrid {
  const { latMin, lonMin, latStep, lonStep, nLat, nLon } = spec;
  const u = new Float32Array(nLat * nLon);
  const v = new Float32Array(nLat * nLon);
  const date = new Date(timeMs);
  for (let iLat = 0; iLat < nLat; iLat++) {
    const lat = latMin + iLat * latStep;
    for (let iLon = 0; iLon < nLon; iLon++) {
      const lon = lonMin + iLon * lonStep;
      const c = provider.getCurrent(lat, lon, date);
      const idx = iLat * nLon + iLon;
      u[idx] = c.u;
      v[idx] = c.v;
    }
  }
  return { u, v, latMin, lonMin, latStep, lonStep, nLat, nLon };
}

// ── Handler ───────────────────────────────────────────────────────────────────

// Track which forecast step times have been pushed to the WASM session
// to avoid re-sampling and re-pushing.
const pushedWindTimes = new Set<number>();
const pushedCurrentTimes = new Set<number>();

async function handleCalculate(payload: CalculatePayload): Promise<void> {
  const { request, polarCsv, landIndexUrl, dilatedIndexUrl, windModel, useSafetyMargin } = payload;
  const tileBbox = { ...payload.tileBbox };

  const departureMs = new Date(request.departureTime).getTime();
  lastPct = 0;
  post({ type: 'progress', pct: 0, frontier: [] });

  // Reset pushed-frame tracking
  pushedWindTimes.clear();
  pushedCurrentTimes.clear();

  // 1. Parse polar
  const polar = parsePolarCsv(polarCsv);

  // 2. Load everything in parallel (land index as raw binary, not parsed to JS objects)
  const landBinaryFetch = fetchGzBinary(
    useSafetyMargin === true && dilatedIndexUrl !== undefined ? dilatedIndexUrl : landIndexUrl,
  );

  // Use the full tile coverage area as the weather corridor — let the
  // routing algorithm explore freely instead of pre-guessing a corridor.
  // tileBbox already has generous margin (30% of route span, min 3°).
  const zoom = TileWindProvider.computeZoom(tileBbox, 2);
  const windProvider = new TileWindProvider({ windModel: windModel ?? 'ecmwf', zoom });
  const currentProvider = new TileCurrentProvider(zoom);

  const [landBinary] = await Promise.all([
    landBinaryFetch,
    windProvider.load(tileBbox),
    currentProvider.load(tileBbox, departureMs, departureMs + 72 * 3_600_000),
    loadWasm(),
  ]);

  const hasCurrent = currentProvider.times.length > 0;
  let gridSpec = corridorGridSpec(tileBbox, zoom);

  // Forecast end from the provider
  const forecastEnd = windProvider.times[windProvider.times.length - 1];
  const forecastEndMs = forecastEnd ? forecastEnd.getTime() : departureMs + 7 * 24 * 3_600_000;

  post({ type: 'progress', pct: 5, frontier: [] });

  // 3. Create WASM session
  const wasm = wasmModule;
  if (!wasm) throw new Error('WASM module not loaded');

  const waypoints = request.waypoints ?? [];
  const allPoints = [request.start, ...waypoints, request.end];
  const legs = new Float64Array(allPoints.length * 2);
  for (let i = 0; i < allPoints.length; i++) {
    /* eslint-disable @typescript-eslint/no-non-null-assertion -- i bounded by allPoints.length */
    legs[i * 2] = allPoints[i]!.lat;
    legs[i * 2 + 1] = allPoints[i]!.lon;
    /* eslint-enable @typescript-eslint/no-non-null-assertion */
  }

  const opts = request.options ?? {};
  const options = new Float64Array([
    Number(opts['headingStep'] ?? 5),
    Number(opts['sectorSize'] ?? 1),
    Number(opts['minBoatSpeed'] ?? 0.3),
    Number(opts['maxWindKn'] ?? 0),
    Number(opts['maxWaveM'] ?? 0),
    Number(opts['motorSpeedKn'] ?? 0),
    Number(opts['motorBelowKn'] ?? 0),
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- options value is loosely typed
    opts['waitForWind'] ? 1 : 0,
    Number(opts['tackPenaltySec'] ?? 30),
    Number(opts['tackThresholdDeg'] ?? 60),
    100, // coneHalfAngle
    100, // coneDisableLookaheadNm
    120, // maxHeadingChange
    0, // arrivalRadiusNm (0 = dynamic)
  ]);

  const session = new wasm.RouterSession(
    new Float64Array(polar.twa),
    new Float64Array(polar.tws),
    new Float64Array(polar.speeds.flat()),
    legs,
    departureMs,
    forecastEndMs,
    options,
    new Uint8Array(landBinary),
  );

  // 4. Step loop with on-demand weather streaming
  const LOOKAHEAD_FRAMES = 4; // prefetch this many frames ahead
  const windTimesMs = windProvider.times.map((d) => d.getTime());
  const currentTimesMs = currentProvider.times.map((d) => d.getTime());

  try {
    let exhausted = false;
    for (let iteration = 0; iteration < 500; iteration++) {
      const bracket = session.needs();
      if (bracket.length === 0) break; // done or error

      /* eslint-disable @typescript-eslint/no-non-null-assertion -- bracket has ≥1 element (checked on line 344) */
      const timeLo = bracket[0]!;
      const timeHi = bracket[1]!;
      /* eslint-enable @typescript-eslint/no-non-null-assertion */

      // Report weather-loading status — reuse last WASM pct to avoid bar flicker
      post({
        type: 'progress',
        pct: Math.max(lastPct, 5),
        frontier: [],
        status: `Loading weather data (step ${String(iteration + 1)})…`,
      });

      // Find which forecast steps bracket this time range (+ lookahead)
      const lookaheadMs = timeHi + LOOKAHEAD_FRAMES * (timeHi - timeLo);
      await ensureWindFrames(windProvider, windTimesMs, session, gridSpec, timeLo, lookaheadMs);
      if (hasCurrent) {
        ensureCurrentFrames(currentProvider, currentTimesMs, session, gridSpec, timeLo, lookaheadMs);
      }

      // Run one step
      const stepStatus = session.step();

      if (stepStatus === 1) {
        // Arrived — extract route
        break;
      } else if (stepStatus === 2) {
        // No progress
        const err = session.error();
        if (err !== undefined && err !== '') {
          post({ type: 'error', message: err });
          return;
        }
        break; // partial route
      } else if (stepStatus === 3) {
        // Forecast exhausted
        exhausted = true;
        break;
      }

      // ── Dynamic corridor expansion ──────────────────────────────────────
      // If any frontier point is within 1° of the grid edge, expand the
      // tile coverage, re-sample weather, and re-push to WASM.
      const EDGE_MARGIN = 1.0;
      if (lastFrontierLats.length > 0) {
        let needExpand = false;
        for (let fi = 0; fi < lastFrontierLats.length; fi++) {
          /* eslint-disable @typescript-eslint/no-non-null-assertion -- fi bounded by lastFrontierLats.length */
          const fLat = lastFrontierLats[fi]!;
          const fLon = lastFrontierLons[fi]!;
          /* eslint-enable @typescript-eslint/no-non-null-assertion */
          if (
            fLat < gridSpec.latMin + EDGE_MARGIN ||
            fLat > gridSpec.latMin + (gridSpec.nLat - 1) * gridSpec.latStep - EDGE_MARGIN ||
            fLon < gridSpec.lonMin + EDGE_MARGIN ||
            fLon > gridSpec.lonMin + (gridSpec.nLon - 1) * gridSpec.lonStep - EDGE_MARGIN
          ) {
            needExpand = true;
            break;
          }
        }
        if (needExpand) {
          // Grow tileBbox by 5° in all directions
          tileBbox.latMin -= 5;
          tileBbox.latMax += 5;
          tileBbox.lonMin -= 5;
          tileBbox.lonMax += 5;
          // Reload tile metadata for the expanded area
          await windProvider.load(tileBbox);
          await currentProvider.load(tileBbox, departureMs, departureMs + 72 * 3_600_000);
          // Recompute grid and re-push all weather frames
          gridSpec = corridorGridSpec(tileBbox, zoom);
          session.clear_weather();
          pushedWindTimes.clear();
          pushedCurrentTimes.clear();
        }
      }

      // Evict old frames periodically (every 10 steps)
      if (iteration % 10 === 9) {
        session.evict_old_frames();
      }
    }

    // 5. Extract and enrich route
    const flat = session.route();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- route header element
    const nRoutePoints = flat[0]!;
    const route: RoutePoint[] = [];
    for (let i = 0; i < nRoutePoints; i++) {
      const base = 1 + i * 7;
      /* eslint-disable @typescript-eslint/no-non-null-assertion -- structured WASM route array, indices valid by layout */
      const lat = flat[base]!;
      const lon = flat[base + 1]!;
      const timeMs = flat[base + 2]!;
      /* eslint-enable @typescript-eslint/no-non-null-assertion */
      const time = new Date(timeMs);

      // Resample weather at each waypoint for display-only fields
      const gustMs = windProvider.getGustAtTime(lat, lon, timeMs);
      const cur = hasCurrent ? currentProvider.getCurrent(lat, lon, time) : undefined;
      const resampled = windProvider.getWindAtTime(lat, lon, timeMs);

      const wowU = resampled.u - (cur?.u ?? 0);
      const wowV = resampled.v - (cur?.v ?? 0);

      const pt: RoutePoint = {
        lat,
        lon,
        time,
        /* eslint-disable @typescript-eslint/no-non-null-assertion -- structured WASM route array */
        ctw: flat[base + 3]!,
        twa: flat[base + 4]!,
        /* eslint-enable @typescript-eslint/no-non-null-assertion */
        tws: windSpeedKnots(resampled.u, resampled.v),
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        boatSpeed: flat[base + 5]! > 0 ? flat[base + 5]! : undefined,
        windDir: windDirection(resampled.u, resampled.v),
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        legCalcMs: flat[base + 6]!,
        waveHeight: windProvider.getWaveAtTime(lat, lon, timeMs),
        wavePeriod: windProvider.getWavePeriodAtTime(lat, lon, timeMs),
        waveDir: windProvider.getWaveDirAtTime(lat, lon, timeMs),
        gustKn: gustMs != null ? gustMs * 1.94384 : undefined,
        currentU: cur?.u,
        currentV: cur?.v,
        wowTws: cur ? windSpeedKnots(wowU, wowV) : undefined,
        wowDir: cur ? windDirection(wowU, wowV) : undefined,
      };
      route.push(pt);
    }

    if (exhausted) {
      post({ type: 'result', route, warning: 'Route is partial — forecast coverage exhausted before arrival' });
    } else if (route.length === 0) {
      post({ type: 'result', route, warning: 'No route found — check wind coverage and polar diagram' });
    } else {
      post({ type: 'result', route });
    }
  } finally {
    session.free();
  }
}

/**
 * Ensure wind frames covering [timeLo, timeHi] are fetched and pushed to the session.
 * Uses windowed prefetch: fetches tile data for bracketing steps, samples onto corridor grid,
 * and pushes to the WASM session. Already-pushed frames are skipped.
 */
async function ensureWindFrames(
  provider: TileWindProvider,
  timesMs: number[],
  session: WasmRouterSession,
  gridSpec: CorridorGridSpec,
  timeLo: number,
  timeHi: number,
): Promise<void> {
  // Find all forecast steps that might be needed for interpolation in [timeLo, timeHi]
  const stepsNeeded = bracketingSteps(timesMs, timeLo, timeHi);

  // Prefetch tiles for all needed steps
  const fetches: Promise<void>[] = [];
  for (const ms of stepsNeeded) {
    fetches.push(provider.prefetchForTime(ms));
  }
  if (fetches.length > 0) await Promise.all(fetches);

  // Sample and push any new frames
  for (const ms of stepsNeeded) {
    if (!pushedWindTimes.has(ms)) {
      const grid = sampleWindGrid(provider, ms, gridSpec);
      session.push_wind_frame(
        ms,
        grid.u,
        grid.v,
        grid.latMin,
        grid.lonMin,
        grid.latStep,
        grid.lonStep,
        grid.nLat,
        grid.nLon,
      );
      pushedWindTimes.add(ms);
    }
  }
}

/**
 * Same as ensureWindFrames but for ocean currents.
 */
function ensureCurrentFrames(
  provider: TileCurrentProvider,
  timesMs: number[],
  session: WasmRouterSession,
  gridSpec: CorridorGridSpec,
  timeLo: number,
  timeHi: number,
): void {
  const stepsNeeded = bracketingSteps(timesMs, timeLo, timeHi);

  for (const ms of stepsNeeded) {
    if (!pushedCurrentTimes.has(ms)) {
      const grid = sampleCurrentGrid(provider, ms, gridSpec);
      session.push_current_frame(
        ms,
        grid.u,
        grid.v,
        grid.latMin,
        grid.lonMin,
        grid.latStep,
        grid.lonStep,
        grid.nLat,
        grid.nLon,
      );
      pushedCurrentTimes.add(ms);
    }
  }
}

/**
 * Find forecast step timestamps needed to interpolate within [timeLo, timeHi].
 * Returns the lower bracket step (last step ≤ timeLo) plus all steps up to
 * the first step > timeHi.
 */
function bracketingSteps(timesMs: number[], timeLo: number, timeHi: number): number[] {
  if (timesMs.length === 0) return [];
  const result: number[] = [];

  // Binary search for the lower bracket
  let lo = 0;
  let hi = timesMs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((timesMs[mid] ?? 0) <= timeLo) lo = mid;
    else hi = mid - 1;
  }

  // Include from the lower bracket through the upper bracket of timeHi
  for (let i = lo; i < timesMs.length; i++) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- i bounded by timesMs.length
    result.push(timesMs[i]!);
    if ((timesMs[i] ?? 0) > timeHi) break;
  }

  return result;
}

// ── Message listener ──────────────────────────────────────────────────────────

self.addEventListener('message', (event: MessageEvent) => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- MessageEvent.data is inherently untyped
  const msg = event.data as InMessage;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive runtime type check
  if (msg.type === 'calculate') {
    handleCalculate(msg.payload).catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      post({ type: 'error', message });
    });
  }
});
