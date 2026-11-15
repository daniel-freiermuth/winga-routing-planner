// Geographic primitives: haversine distance, bearing, destination point, longitude unwrapping, route bounding box, wind vector conversions.

import type { BoundingBox, LatLon } from '../types';

const R_NM = 3440.065; // Earth radius in nautical miles
const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;
// Weather corridor margin around the route: the larger of a fixed minimum and a fraction of the route span.
const ROUTE_BBOX_MIN_MARGIN_DEG = 3;
const ROUTE_BBOX_MARGIN_FRACTION = 0.3;
// Poleward limit for corridor padding. Weather tiles (Web Mercator) end at 85.0511°; this stays inside that by more
// than the coarsest corridor grid step (0.1758° at zoom 3), which corridorGridSpec may add when rounding outward,
// so every padded grid row samples an existing tile row.
export const CORRIDOR_MAX_LAT = 84.8;
// Padding limit for a bound already beyond CORRIDOR_MAX_LAT (a route point there). Any latitude between the tile
// limit and the pole maps to a non-existent tile row, which is requested and fails the calculation loudly; at ±90°
// the tile row is NaN (or ±Infinity), so no row would be requested and the corridor would sample silent calm.
// A route point between this and the pole is left outside the bbox, which still requests non-existent rows.
export const POLAR_PAD_MAX_LAT = 89;

export function haversineNM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function bearingTo(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const lat1R = lat1 * DEG_TO_RAD;
  const lat2R = lat2 * DEG_TO_RAD;
  const y = Math.sin(dLon) * Math.cos(lat2R);
  const x = Math.cos(lat1R) * Math.sin(lat2R) - Math.sin(lat1R) * Math.cos(lat2R) * Math.cos(dLon);
  return (Math.atan2(y, x) * RAD_TO_DEG + 360) % 360;
}

export function destinationPoint(
  lat: number,
  lon: number,
  distNM: number,
  bearingDeg: number,
): { lat: number; lon: number } {
  const d = distNM / R_NM;
  const brng = bearingDeg * DEG_TO_RAD;
  const lat1 = lat * DEG_TO_RAD;
  const lon1 = lon * DEG_TO_RAD;

  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
  const lon2 =
    lon1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));

  return {
    lat: lat2 * RAD_TO_DEG,
    lon: ((lon2 * RAD_TO_DEG + 540) % 360) - 180, // +540 not +360: guarantees positive operand for % when lon2 is just outside [−π, π]
  };
}

/** The longitude equivalent to `lon` within the 360° window [frameStart, frameStart + 360). */
export function lonInFrame(lon: number, frameStart: number): number {
  return frameStart + ((((lon - frameStart) % 360) + 360) % 360);
}

/**
 * Bounding box around the route points plus the weather margin. Longitudes are unwrapped along the
 * leg chain (each leg takes the shorter way round), so a route across the antimeridian yields a
 * contiguous box with lonMin < lonMax whose edges may lie beyond ±180°.
 */
export function routeBbox(points: readonly [LatLon, ...LatLon[]]): BoundingBox {
  let prevLon = points[0].lon;
  let latMin = Infinity;
  let latMax = -Infinity;
  let lonMin = Infinity;
  let lonMax = -Infinity;
  for (const p of points) {
    const lon = lonInFrame(p.lon, prevLon - 180);
    prevLon = lon;
    latMin = Math.min(latMin, p.lat);
    latMax = Math.max(latMax, p.lat);
    lonMin = Math.min(lonMin, lon);
    lonMax = Math.max(lonMax, lon);
  }
  const margin = Math.max(
    ROUTE_BBOX_MIN_MARGIN_DEG,
    (latMax - latMin) * ROUTE_BBOX_MARGIN_FRACTION,
    (lonMax - lonMin) * ROUTE_BBOX_MARGIN_FRACTION,
  );
  return { ...padLatBounds(latMin, latMax, margin), lonMin: lonMin - margin, lonMax: lonMax + margin };
}

/**
 * Widen a latitude range by `pad` degrees on each side, stopping at CORRIDOR_MAX_LAT so the padding never reaches
 * beyond the weather tile rows. A bound already beyond that limit (a route point there) is padded up to
 * POLAR_PAD_MAX_LAT instead, so its out-of-coverage tile rows are requested and fail loudly rather than being sampled
 * as silent calm.
 */
export function padLatBounds(latMin: number, latMax: number, pad: number): { latMin: number; latMax: number } {
  const southLimit = latMin < -CORRIDOR_MAX_LAT ? POLAR_PAD_MAX_LAT : CORRIDOR_MAX_LAT;
  const northLimit = latMax > CORRIDOR_MAX_LAT ? POLAR_PAD_MAX_LAT : CORRIDOR_MAX_LAT;
  return { latMin: Math.max(latMin - pad, -southLimit), latMax: Math.min(latMax + pad, northLimit) };
}

export function windSpeedKnots(u: number, v: number): number {
  return Math.sqrt(u * u + v * v) * 1.94384; // m/s → knots
}

// Meteorological wind direction: the direction FROM which the wind blows (0=N, 90=E)
export function windDirection(u: number, v: number): number {
  return (Math.atan2(-u, -v) * RAD_TO_DEG + 360) % 360;
}

// Oceanographic current direction: the direction TOWARD which the current flows (0=N, 90=E)
export function currentDirection(u: number, v: number): number {
  return (Math.atan2(u, v) * RAD_TO_DEG + 360) % 360;
}
