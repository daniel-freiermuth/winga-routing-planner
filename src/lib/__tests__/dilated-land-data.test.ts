// Checks the shipped safety-margin coastline (data/dilated-edge-index.bin.gz) against the shipped coastline it was built from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parseIndexFromArrayBuffer } from '../land-index-loader';
import type { LandPolygon } from '../../types';

const DATA_DIR = join(__dirname, '..', '..', '..', 'data');
const SAFETY_MARGIN_NM = 0.5;
// Buffer arcs are polylines through points on the circle; chord sag stays far below this.
const ARC_APPROXIMATION_TOLERANCE_NM = 0.005;
const NM_PER_DEG_LAT = 60;

// Baltic islands at high latitude, where an E-W margin measured in raw degrees would be ~0.25 NM.
const REGION = { latMin: 56, latMax: 60, lonMin: 15, lonMax: 22 };

function loadPolygons(file: string): LandPolygon[] {
  const raw = gunzipSync(readFileSync(join(DATA_DIR, file)));
  const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  return parseIndexFromArrayBuffer(buffer).polygons;
}

function inRegion(p: LandPolygon): boolean {
  return (
    p.bboxLatMin >= REGION.latMin &&
    p.bboxLatMax <= REGION.latMax &&
    p.bboxLonMin >= REGION.lonMin &&
    p.bboxLonMax <= REGION.lonMax
  );
}

function bboxContains(outer: LandPolygon, inner: LandPolygon): boolean {
  return (
    inner.bboxLatMin >= outer.bboxLatMin &&
    inner.bboxLatMax <= outer.bboxLatMax &&
    inner.bboxLonMin >= outer.bboxLonMin &&
    inner.bboxLonMax <= outer.bboxLonMax
  );
}

function nmPerDegLonAt(lat: number): number {
  return NM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

/** Latitude of the vertex lying on the given longitude (the polygon's west- or eastmost point). */
function latOfVertexAtLon(p: LandPolygon, lon: number): number {
  for (let i = 0; i < p.exterior.length; i += 2) {
    const lat = p.exterior[i + 1];
    if (p.exterior[i] === lon && lat !== undefined) return lat;
  }
  throw new Error(`no vertex at lon ${String(lon)}`);
}

void test('dilated coastline keeps the safety margin in every direction around isolated islands', () => {
  const originals = loadPolygons('edge-index.bin.gz').filter(inRegion);
  const dilated = loadPolygons('dilated-edge-index.bin.gz').filter(inRegion);

  let islands = 0;
  for (const d of dilated) {
    const contained = originals.filter((o) => bboxContains(d, o));
    const [o] = contained;
    if (contained.length !== 1 || o === undefined) continue;
    islands++;
    // The margin around a vertex is measured in NM at that vertex's latitude.
    const nmPerDegLonWest = nmPerDegLonAt(latOfVertexAtLon(o, o.bboxLonMin));
    const nmPerDegLonEast = nmPerDegLonAt(latOfVertexAtLon(o, o.bboxLonMax));
    const margins = {
      south: (o.bboxLatMin - d.bboxLatMin) * NM_PER_DEG_LAT,
      north: (d.bboxLatMax - o.bboxLatMax) * NM_PER_DEG_LAT,
      west: (o.bboxLonMin - d.bboxLonMin) * nmPerDegLonWest,
      east: (d.bboxLonMax - o.bboxLonMax) * nmPerDegLonEast,
    };
    for (const [side, nm] of Object.entries(margins)) {
      assert.ok(
        nm >= SAFETY_MARGIN_NM - ARC_APPROXIMATION_TOLERANCE_NM,
        `island at ${o.bboxLatMin.toFixed(3)}°N ${o.bboxLonMin.toFixed(3)}°E: ${side} margin ${nm.toFixed(3)} NM`,
      );
    }
  }
  assert.ok(islands > 0, 'no isolated islands found in the test region');
});
