// Data layer — provides wind/wave/current grid data from Windy tiles,
// and land polygon data from the GSHHG edge-index binary.
// Replaces server API calls (/wind-grid, /wave-grid, /current-grid,
// /wind-times, /land-polygons).
//
// All functions return the same data shapes that app.js expects so the UI
// rendering code doesn't change.

import {
  fetchMinifest,
  refToCompact,
  getValidTimes,
  buildTileUrl,
  decodeTileHeader,
  sampleTilePixel,
  latLonToTile,
  latLonToPixel,
} from '@winga-weather-routing/windy-lib';
import type { WindyMinifest, WindyTileHeader } from '@winga-weather-routing/windy-lib';
import type { BoundingBox, LandIndex } from '../src/types';

// ── Tile cache ────────────────────────────────────────────────────────────────

const tileCache = new Map<string, Promise<{ rgba: Uint8Array; header: WindyTileHeader }>>();

async function fetchTile(url: string) {
  let pending = tileCache.get(url);
  if (pending) return pending;
  pending = (async () => {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Tile ${String(resp.status)}`);
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    // Draw to an OffscreenCanvas to extract RGBA pixel data
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2d context');
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const data = new Uint8Array(imageData.data.buffer);
    bitmap.close();
    const header = decodeTileHeader(data);
    return { rgba: data, header };
  })();
  tileCache.set(url, pending);
  pending.catch(() => tileCache.delete(url));
  return pending;
}

// ── Minifest cache ────────────────────────────────────────────────────────────

const manifests = new Map<string, { data: WindyMinifest; fetchedAt: number }>();
const MANIFEST_TTL = 10 * 60 * 1000;

async function getManifest(modelId: string) {
  const cached = manifests.get(modelId);
  if (cached && Date.now() - cached.fetchedAt < MANIFEST_TTL) return cached.data;
  const data = await fetchMinifest(modelId);
  manifests.set(modelId, { data, fetchedAt: Date.now() });
  return data;
}

// ── State ─────────────────────────────────────────────────────────────────────

interface ForecastStep {
  iso: string;
  compact: string;
}

interface GridPoint {
  lat: number;
  lon: number;
  u: number;
  v: number;
  speed: number;
  height?: number;
}

interface WaveGridResult {
  points: { lat: number; lon: number; waveHeight: number }[];
  timeMs: number;
}

interface GeoJSONCollection {
  type: string;
  features: {
    type: string;
    geometry: { type: string; coordinates: unknown };
    properties: null;
  }[];
}

const windModel = 'ecmwf-hres';
let windSteps: ForecastStep[] = [];
let waveSteps: ForecastStep[] = [];
let cmemsSteps: ForecastStep[] = [];
let windModelRun = '';
let waveModelRun = '';
let cmemsModelRun = '';

/**
 * Load forecast time axes from Windy minifests.
 * @returns {Promise<{windTimes: string[], currentTimes: string[]}>}
 */
export async function loadTimesFromWindy(): Promise<{ windTimes: string[]; currentTimes: string[] }> {
  const [windMf, waveMf, cmemsMf] = await Promise.all([
    getManifest(windModel),
    getManifest('ecmwf-wam'),
    getManifest('cmems'),
  ]);

  windModelRun = refToCompact(windMf.ref);
  waveModelRun = refToCompact(waveMf.ref);
  cmemsModelRun = refToCompact(cmemsMf.ref);
  windSteps = getValidTimes(windMf);
  waveSteps = getValidTimes(waveMf);
  cmemsSteps = getValidTimes(cmemsMf);

  return {
    windTimes: windSteps.map((s) => s.iso),
    currentTimes: cmemsSteps.map((s) => s.iso),
  };
}

// ── Grid sampling helpers ─────────────────────────────────────────────────────

const ZOOM = 3;

function closestStep(steps: ForecastStep[], targetMs: number) {
  let best = steps[0];
  let bestDiff = Infinity;
  for (const s of steps) {
    const diff = Math.abs(new Date(s.iso).getTime() - targetMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = s;
    }
  }
  return best;
}

/**
 * Sample a Windy tile overlay across a bounding box at a given step density.
 * Fetches only the tiles needed for the bbox, caches them.
 *
 * @param {string} model       e.g. 'ecmwf-hres', 'ecmwf-wam', 'cmems'
 * @param {string} modelRun    compact model run time
 * @param {string} validTime   compact valid time
 * @param {string} overlay     e.g. 'wind', 'waves', 'seacurrents'
 * @param {boolean} isOcean    true for CMEMS (B-channel land check)
 * @param {{latMin:number, latMax:number, lonMin:number, lonMax:number}} bbox
 * @param {number} step        grid spacing in degrees
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<{lat:number, lon:number, u:number, v:number, speed:number}>>}
 */
async function sampleOverlayGrid(
  model: string,
  modelRun: string,
  validTime: string,
  overlay: string,
  isOcean: boolean,
  bbox: BoundingBox,
  step: number,
  signal?: AbortSignal,
  isPng = false,
) {
  // Determine which tiles cover the bbox
  const tl = latLonToTile(bbox.latMax, bbox.lonMin, ZOOM);
  const br = latLonToTile(bbox.latMin, bbox.lonMax, ZOOM);

  // Pre-fetch all needed tiles in parallel
  const tilePromises = new Map<string, Promise<{ rgba: Uint8Array; header: WindyTileHeader } | null>>();
  for (let tx = tl.x; tx <= br.x; tx++) {
    for (let ty = tl.y; ty <= br.y; ty++) {
      const url = buildTileUrl(model, modelRun, validTime, ZOOM, tx, ty, overlay, 'surface', isPng ? 'png' : 'jpg');
      if (!tilePromises.has(`${String(tx)}/${String(ty)}`)) {
        tilePromises.set(
          `${String(tx)}/${String(ty)}`,
          fetchTile(url).catch(() => null),
        );
      }
    }
  }

  // Resolve all tiles
  const tiles = new Map<string, { rgba: Uint8Array; header: WindyTileHeader }>();
  for (const [key, promise] of tilePromises) {
    const tile = await promise;
    if (tile) tiles.set(key, tile);
  }

  if (signal?.aborted === true) return [];

  // Sample the grid
  const points = [];
  for (let lat = bbox.latMin; lat <= bbox.latMax; lat += step) {
    for (let lon = bbox.lonMin; lon <= bbox.lonMax; lon += step) {
      const { x, y } = latLonToTile(lat, lon, ZOOM);
      const tile = tiles.get(`${String(x)}/${String(y)}`);
      if (!tile) continue;
      const { px, py } = latLonToPixel(lat, lon, ZOOM, x, y);
      const val = sampleTilePixel(tile.rgba, tile.header, px, py, isOcean, isPng);
      if (val.hasData) {
        points.push({
          lat: Math.round(lat * 10000) / 10000,
          lon: Math.round(lon * 10000) / 10000,
          u: val.u,
          v: val.v,
          speed: val.speed,
          height: val.height,
        });
      }
    }
  }
  return points;
}

// ── Public: grid endpoints ────────────────────────────────────────────────────

/**
 * Fetch wind grid for a time step within a bounding box.
 * @param {number} timeIdx   index into windSteps
 * @param {{latMin:number,latMax:number,lonMin:number,lonMax:number}} bbox
 * @param {AbortSignal} [signal]
 * @returns {Promise<{lat:number,lon:number,u:number,v:number}[]>}
 */
export async function fetchWindGrid(timeIdx: number, bbox: BoundingBox, signal?: AbortSignal): Promise<GridPoint[]> {
  const step = windSteps[timeIdx];
  if (!step) return [];
  return sampleOverlayGrid(windModel, windModelRun, step.compact, 'wind', false, bbox, 0.5, signal);
}

/**
 * Fetch wind grid interpolated at an arbitrary time (ms).
 * Finds the two bracketing native forecast steps and linearly interpolates u/v.
 */
export async function fetchWindGridAtTime(
  timeMs: number,
  bbox: BoundingBox,
  signal?: AbortSignal,
): Promise<GridPoint[]> {
  if (windSteps.length === 0) return [];
  // Find bracketing steps
  let lo = 0;
  for (let i = 1; i < windSteps.length; i++) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    if (new Date(windSteps[i]!.iso).getTime() <= timeMs) lo = i;
    else break;
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const t0ms = new Date(windSteps[lo]!.iso).getTime();
  // Exact match or at/past last step → no interpolation needed
  if (lo >= windSteps.length - 1 || t0ms === timeMs) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return sampleOverlayGrid(windModel, windModelRun, windSteps[lo]!.compact, 'wind', false, bbox, 0.5, signal);
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const t1ms = new Date(windSteps[lo + 1]!.iso).getTime();
  const f = (timeMs - t0ms) / (t1ms - t0ms);
  if (f < 0.01)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return sampleOverlayGrid(windModel, windModelRun, windSteps[lo]!.compact, 'wind', false, bbox, 0.5, signal);
  if (f > 0.99)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return sampleOverlayGrid(windModel, windModelRun, windSteps[lo + 1]!.compact, 'wind', false, bbox, 0.5, signal);
  // Fetch both grids and interpolate
  const [g0, g1] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    sampleOverlayGrid(windModel, windModelRun, windSteps[lo]!.compact, 'wind', false, bbox, 0.5, signal),
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    sampleOverlayGrid(windModel, windModelRun, windSteps[lo + 1]!.compact, 'wind', false, bbox, 0.5, signal),
  ]);
  if (signal?.aborted === true) return [];
  // Build lookup for g1 by position
  const g1Map = new Map<string, { u: number; v: number }>();
  for (const p of g1) g1Map.set(`${String(p.lat)},${String(p.lon)}`, p);
  // Interpolate
  const result = [];
  for (const p0 of g0) {
    const p1 = g1Map.get(`${String(p0.lat)},${String(p0.lon)}`);
    if (p1) {
      const u = p0.u * (1 - f) + p1.u * f;
      const v = p0.v * (1 - f) + p1.v * f;
      result.push({ lat: p0.lat, lon: p0.lon, u, v, speed: Math.sqrt(u * u + v * v) });
    } else {
      result.push(p0);
    }
  }
  return result;
}

/**
 * Fetch wave grid for a time step within a bounding box.
 * @param {number} timeIdx   index into windSteps
 * @param {{latMin:number,latMax:number,lonMin:number,lonMax:number}} bbox
 * @param {AbortSignal} [signal]
 * @returns {Promise<{points: {lat:number,lon:number,waveHeight:number}[], timeMs: number}>}
 */
export async function fetchWaveGrid(timeIdx: number, bbox: BoundingBox, signal?: AbortSignal): Promise<WaveGridResult> {
  const windStep = windSteps[timeIdx];
  if (!windStep) return { points: [], timeMs: 0 };
  const windTimeMs = new Date(windStep.iso).getTime();
  const waveStep = closestStep(waveSteps, windTimeMs);
  if (!waveStep) return { points: [], timeMs: 0 };

  const raw = await sampleOverlayGrid(
    'ecmwf-wam',
    waveModelRun,
    waveStep.compact,
    'waves',
    true,
    bbox,
    0.5,
    signal,
    true,
  );
  const points = raw
    .filter((p) => p.height > 0.1)
    .map((p) => ({ lat: p.lat, lon: p.lon, waveHeight: Math.round(p.height * 1000) / 1000 }));
  return { points, timeMs: windTimeMs };
}

/**
 * Fetch wave grid interpolated at an arbitrary time (ms).
 */
export async function fetchWaveGridAtTime(
  timeMs: number,
  bbox: BoundingBox,
  signal?: AbortSignal,
): Promise<WaveGridResult> {
  if (waveSteps.length === 0) return { points: [] as { lat: number; lon: number; waveHeight: number }[], timeMs };
  let lo = 0;
  for (let i = 1; i < waveSteps.length; i++) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    if (new Date(waveSteps[i]!.iso).getTime() <= timeMs) lo = i;
    else break;
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const t0ms = new Date(waveSteps[lo]!.iso).getTime();

  const sampleWave = async (step: { compact: string }) => {
    const raw = await sampleOverlayGrid(
      'ecmwf-wam',
      waveModelRun,
      step.compact,
      'waves',
      true,
      bbox,
      0.5,
      signal,
      true,
    );
    return raw.filter((p) => p.height > 0.1);
  };

  if (lo >= waveSteps.length - 1 || t0ms === timeMs) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const raw = await sampleWave(waveSteps[lo]!);
    return {
      points: raw.map((p) => ({ lat: p.lat, lon: p.lon, waveHeight: Math.round(p.height * 1000) / 1000 })),
      timeMs,
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const t1ms = new Date(waveSteps[lo + 1]!.iso).getTime();
  const f = (timeMs - t0ms) / (t1ms - t0ms);
  if (f < 0.01) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const raw = await sampleWave(waveSteps[lo]!);
    return {
      points: raw.map((p) => ({ lat: p.lat, lon: p.lon, waveHeight: Math.round(p.height * 1000) / 1000 })),
      timeMs,
    };
  }
  if (f > 0.99) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const raw = await sampleWave(waveSteps[lo + 1]!);
    return {
      points: raw.map((p) => ({ lat: p.lat, lon: p.lon, waveHeight: Math.round(p.height * 1000) / 1000 })),
      timeMs,
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const [g0, g1] = await Promise.all([sampleWave(waveSteps[lo]!), sampleWave(waveSteps[lo + 1]!)]);
  if (signal?.aborted === true) return { points: [], timeMs };
  const g1Map = new Map<string, number>();
  for (const p of g1) g1Map.set(`${String(p.lat)},${String(p.lon)}`, p.height);
  const points = g0.map((p) => {
    const h1 = g1Map.get(`${String(p.lat)},${String(p.lon)}`);
    const h = h1 != null ? p.height * (1 - f) + h1 * f : p.height;
    return { lat: p.lat, lon: p.lon, waveHeight: Math.round(h * 1000) / 1000 };
  });
  return { points, timeMs };
}

/**
 * Fetch current grid for a time (ms) within a bounding box.
 * @param {number} timeMs
 * @param {{latMin:number,latMax:number,lonMin:number,lonMax:number}} bbox
 * @param {AbortSignal} [signal]
 * @returns {Promise<{lat:number,lon:number,u:number,v:number}[]>}
 */
export async function fetchCurrentGrid(timeMs: number, bbox: BoundingBox, signal?: AbortSignal): Promise<GridPoint[]> {
  const step = closestStep(cmemsSteps, timeMs);
  if (!step) return [];
  const raw = await sampleOverlayGrid('cmems', cmemsModelRun, step.compact, 'seacurrents', true, bbox, 0.5, signal);
  return raw.filter((p) => p.speed > 0.01);
}

/**
 * Query weather at a single point and time.
 * Returns wind (u/v m/s), gust (m/s), wave height (m), and current (u/v m/s).
 *
 * @param {number} lat
 * @param {number} lon
 * @param {number} timeMs  target time in ms since epoch
 * @returns {Promise<{wind:{u:number,v:number}|null, gustMs:number|null, waveHeightM:number|null, current:{u:number,v:number}|null}>}
 */
interface PointWeather {
  wind: { u: number; v: number } | null;
  gustMs: number | null;
  waveHeightM: number | null;
  current: { u: number; v: number } | null;
}

export async function queryPointWeather(lat: number, lon: number, timeMs: number): Promise<PointWeather> {
  const result: PointWeather = { wind: null, gustMs: null, waveHeightM: null, current: null };

  const windStep = closestStep(windSteps, timeMs);
  const { x, y } = latLonToTile(lat, lon, ZOOM);
  const { px, py } = latLonToPixel(lat, lon, ZOOM, x, y);

  // Wind from ECMWF tile
  if (windStep) {
    try {
      const url = buildTileUrl(windModel, windModelRun, windStep.compact, ZOOM, x, y, 'wind');
      const tile = await fetchTile(url);
      const val = sampleTilePixel(tile.rgba, tile.header, px, py, false);
      if (val.hasData) result.wind = { u: val.u, v: val.v };
    } catch {
      /* tile unavailable */
    }

    // Gust from ECMWF tile (scalar overlay — value is in the R channel = val.u)
    try {
      const url = buildTileUrl(windModel, windModelRun, windStep.compact, ZOOM, x, y, 'gust');
      const tile = await fetchTile(url);
      const val = sampleTilePixel(tile.rgba, tile.header, px, py, false);
      if (val.hasData) result.gustMs = val.u; // scalar: R channel only
    } catch {
      /* tile unavailable */
    }
  }

  // Wave from ECMWF-WAM tile
  const waveStep = closestStep(waveSteps, timeMs);
  if (waveStep) {
    try {
      const url = buildTileUrl('ecmwf-wam', waveModelRun, waveStep.compact, ZOOM, x, y, 'waves', 'surface', 'png');
      const tile = await fetchTile(url);
      const val = sampleTilePixel(tile.rgba, tile.header, px, py, false, true);
      if (val.hasData && val.height > 0.05) result.waveHeightM = val.height;
    } catch {
      /* tile unavailable */
    }
  }

  // Current from CMEMS tile (72h horizon)
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const cmemsEnd = cmemsSteps.length > 0 ? new Date(cmemsSteps[cmemsSteps.length - 1]!.iso).getTime() : 0;
  if (timeMs <= cmemsEnd) {
    const curStep = closestStep(cmemsSteps, timeMs);
    if (curStep) {
      try {
        const url = buildTileUrl('cmems', cmemsModelRun, curStep.compact, ZOOM, x, y, 'seacurrents');
        const tile = await fetchTile(url);
        const val = sampleTilePixel(tile.rgba, tile.header, px, py, true);
        if (val.hasData && val.speed > 0.005) result.current = { u: val.u, v: val.v };
      } catch {
        /* tile unavailable */
      }
    }
  }

  return result;
}

// ── Land overlay ──────────────────────────────────────────────────────────────

import { fetchLandIndex } from '../src/lib/land-index-loader';
import { polygonsInBbox, buildLandIndex } from '../src/lib/landmask';

let landIndex: LandIndex | null = null; // LandIndex for the standard (h-tier) coastline
let dilatedLandIndex: LandIndex | null = null; // LandIndex for the dilated (safety margin) coastline

/**
 * Load the land edge-index binary from a URL. Call once; subsequent calls
 * for the same URL are no-ops.
 *
 * @param {string} url           URL to edge-index.bin.gz
 * @param {string} [dilatedUrl]  URL to dilated-edge-index.bin.gz (optional)
 */
export async function loadLandData(url: string, dilatedUrl?: string): Promise<void> {
  if (!landIndex) {
    const edgeIndex = await fetchLandIndex(url);
    landIndex = buildLandIndex(edgeIndex.polygons);
  }
  if (dilatedUrl !== undefined && dilatedUrl !== '' && !dilatedLandIndex) {
    try {
      const dilatedEdge = await fetchLandIndex(dilatedUrl);
      dilatedLandIndex = buildLandIndex(dilatedEdge.polygons);
    } catch {
      // Dilated index is optional — safety margin just won't be available
    }
  }
}

/** Whether land data has been loaded. */
export function landDataReady(): boolean {
  return landIndex !== null;
}

/** Whether dilated land data has been loaded. */
export function dilatedLandDataReady(): boolean {
  return dilatedLandIndex !== null;
}

/**
 * Return a GeoJSON FeatureCollection of land polygons within the bbox.
 * Same shape as the old /land-polygons endpoint.
 *
 * @param {{latMin:number,latMax:number,lonMin:number,lonMax:number}} bbox
 * @param {boolean} [dilated=false]
 * @returns {{type:string, features:object[]}}
 */
export function getLandPolygonsGeoJSON(bbox: BoundingBox, dilated = false): GeoJSONCollection {
  const idx = dilated ? dilatedLandIndex : landIndex;
  if (!idx) return { type: 'FeatureCollection', features: [] };

  const polys = polygonsInBbox(idx, bbox.latMin, bbox.lonMin, bbox.latMax, bbox.lonMax);

  const features = polys.map((p) => {
    const coords = [];
    for (let j = 0; j + 1 < p.exterior.length; j += 2) {
      coords.push([p.exterior[j], p.exterior[j + 1]]); // [lon, lat]
    }
    if (coords.length > 0) coords.push(coords[0]); // close the ring
    return {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [coords] },
      properties: null,
    };
  });

  return { type: 'FeatureCollection', features };
}
