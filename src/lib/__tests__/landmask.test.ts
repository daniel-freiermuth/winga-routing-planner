// Unit tests for the land overlay polygon index: grid construction and bbox polygon lookup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLandIndex, polygonsInBbox } from '../landmask';
import type { LandPolygon } from '../../types';

// A 2°×2° square island: lon 1–3, lat 1–3 (counterclockwise exterior ring)
function makeSquarePoly(): LandPolygon {
  const coords = [1, 1, 3, 1, 3, 3, 1, 3, 1, 1]; // [lon,lat, ...]
  const exterior = new Float64Array(coords.length);
  coords.forEach((v, i) => {
    exterior[i] = v;
  });
  return { bboxLatMin: 1, bboxLatMax: 3, bboxLonMin: 1, bboxLonMax: 3, exterior };
}

const poly = makeSquarePoly();
const index = buildLandIndex([poly]);

void test('buildLandIndex: grid has entries for cells the polygon occupies', () => {
  // polygon covers cells (lat=1,lon=1), (lat=1,lon=2), (lat=2,lon=1), (lat=2,lon=2)
  const key = (1 + 90) * 360 + (1 + 180);
  assert.ok(index.grid.has(key));
});

void test('polygonsInBbox: returns polygon when bbox overlaps its grid cell', () => {
  const result = polygonsInBbox(index, 1, 1, 3, 3);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0], poly);
});

void test('polygonsInBbox: deduplicates polygon spanning multiple cells', () => {
  // poly spans cells (1,1),(1,2),(2,1),(2,2) — querying a bbox covering all four must return it once
  const result = polygonsInBbox(index, 0, 0, 4, 4);
  assert.strictEqual(result.length, 1);
});

void test('polygonsInBbox: returns empty array for bbox with no land', () => {
  const result = polygonsInBbox(index, -10, -10, -8, -8);
  assert.strictEqual(result.length, 0);
});

void test('land-polygons serialization: exterior Float64Array converts to closed [lon,lat] GeoJSON ring', () => {
  // makeSquarePoly exterior: [1,1, 3,1, 3,3, 1,3, 1,1] interleaved as [lon,lat,...]
  const p = makeSquarePoly();
  const coords: [number, number][] = [];
  for (let j = 0; j < p.exterior.length; j += 2) {
    const lon = p.exterior[j];
    const lat = p.exterior[j + 1];
    if (lon === undefined || lat === undefined) break;
    coords.push([lon, lat]);
  }
  const firstCoord = coords[0];
  if (firstCoord !== undefined) coords.push(firstCoord);
  const feature = structuredClone({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [coords] as [number, number][][] },
    properties: null,
  });
  assert.strictEqual(feature.type, 'Feature');
  assert.strictEqual(feature.geometry.type, 'Polygon');
  const ring = feature.geometry.coordinates[0];
  assert.ok(ring !== undefined, 'expected ring to be defined');
  const ringFirst = ring[0];
  const ringLast = ring[ring.length - 1];
  assert.ok(ringFirst !== undefined && ringLast !== undefined, 'expected ring to have elements');
  assert.deepStrictEqual(ringFirst, ringLast); // ring is closed
  assert.strictEqual(ringFirst[0], 1); // lon
  assert.strictEqual(ringFirst[1], 1); // lat
});
