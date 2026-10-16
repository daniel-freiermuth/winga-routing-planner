// Pure conversion of worker route points into GeoJSON RouteData (with derived COG/SOG/current) and scrubber lookup.

import type { WaypointMeta, RouteData } from './types';

/** Route point as received from the routing worker (structured clone keeps `time` a Date). */
export interface WorkerRoutePoint {
  lat: number;
  lon: number;
  time: string | Date;
  ctw: number;
  twa: number;
  tws: number;
  boatSpeed?: number;
  windDir: number;
  waveHeight?: number;
  gribFilePath?: string;
  gustKn?: number;
  currentU?: number;
  currentV?: number;
  wavePeriod?: number;
  waveDir?: number;
  wowTws?: number;
  wowDir?: number;
}

const MS_TO_KN = 1.94384;
const EARTH_RADIUS_NM = 3440.065;
const MIN_CURRENT_KN = 0.01;
const MS_PER_HOUR = 3600000;
const DEG_TO_RAD = Math.PI / 180;

function toMeta(p: WorkerRoutePoint, prev: WorkerRoutePoint | undefined): WaypointMeta {
  const meta: WaypointMeta = {
    name: '',
    time: typeof p.time === 'string' ? p.time : new Date(p.time).toISOString(),
    windDir: p.windDir,
    ctw: p.ctw,
    twa: p.twa,
    tws: p.tws,
  };
  if (p.boatSpeed != null) meta.boatSpeed = p.boatSpeed;
  if (p.waveHeight != null) meta.waveHeight = p.waveHeight;
  if (p.gribFilePath != null) meta.gribFile = p.gribFilePath;
  if (p.gustKn != null) meta.gustKn = p.gustKn;
  if (p.wavePeriod != null) meta.wavePeriod = p.wavePeriod;
  if (p.waveDir != null) meta.waveDir = p.waveDir;
  if (p.wowTws != null) meta.wowTws = p.wowTws;
  if (p.wowDir != null) meta.wowDir = p.wowDir;
  if (p.currentU != null && p.currentV != null) {
    const cSpd = Math.sqrt(p.currentU * p.currentU + p.currentV * p.currentV) * MS_TO_KN;
    if (cSpd > MIN_CURRENT_KN) {
      meta.currentSpeedKn = cSpd;
      meta.currentDir = (Math.atan2(p.currentU, p.currentV) / DEG_TO_RAD + 360) % 360;
    }
  }
  // COG and SOG from consecutive positions (ground track)
  if (prev) {
    const dLat = (p.lat - prev.lat) * DEG_TO_RAD;
    const dLon = (p.lon - prev.lon) * DEG_TO_RAD;
    const lat1r = prev.lat * DEG_TO_RAD;
    const lat2r = p.lat * DEG_TO_RAD;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1r) * Math.cos(lat2r) * Math.sin(dLon / 2) ** 2;
    const distNM = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * EARTH_RADIUS_NM;
    const y = Math.sin(dLon) * Math.cos(lat2r);
    const x = Math.cos(lat1r) * Math.sin(lat2r) - Math.sin(lat1r) * Math.cos(lat2r) * Math.cos(dLon);
    meta.cogDeg = (Math.atan2(y, x) / DEG_TO_RAD + 360) % 360;
    const t0 = typeof prev.time === 'string' ? new Date(prev.time).getTime() : Number(prev.time);
    const t1 = typeof p.time === 'string' ? new Date(p.time).getTime() : Number(p.time);
    const dtH = (t1 - t0) / MS_PER_HOUR;
    meta.sogKn = dtH > 0 ? distNM / dtH : 0;
  }
  return meta;
}

/** Convert worker route points into the GeoJSON RouteData consumed by drawRoute and the conditions graph. */
export function routePointsToRouteData(route: WorkerRoutePoint[]): RouteData {
  return {
    feature: {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: route.map((p) => [p.lon, p.lat]),
      },
      properties: {
        coordinatesMeta: route.map((p, i) => toMeta(p, i > 0 ? route[i - 1] : undefined)),
      },
    },
  };
}

/** Index of the leg whose [start, end] time interval contains tMs, or -1. */
export function findScrubberPosition(graphMeta: WaypointMeta[] | null, tMs: number): { wpIdx: number; legIdx: number } {
  if (!graphMeta || graphMeta.length < 2) return { wpIdx: -1, legIdx: -1 };
  for (let i = 0; i < graphMeta.length - 1; i++) {
    const entry = graphMeta[i];
    const nextEntry = graphMeta[i + 1];
    if (entry === undefined || nextEntry === undefined) continue;
    const t1 = new Date(entry.time).getTime();
    const t2 = new Date(nextEntry.time).getTime();
    if (tMs >= t1 && tMs <= t2) return { wpIdx: i, legIdx: i };
  }
  return { wpIdx: -1, legIdx: -1 };
}
