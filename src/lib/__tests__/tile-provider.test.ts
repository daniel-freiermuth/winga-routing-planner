import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tilesForBbox } from '../tile-provider';

// At z=3, there are 2^3 = 8 tiles along x (indices 0–7).
// latLonToTile(40, 170, 3) → x=7;  latLonToTile(30, -170, 3) → x=0.
// A bbox crossing the antimeridian (lonMin=170, lonMax=-170) must include
// tiles on both sides: at minimum x=7 (eastern) and x=0 (western).

void test('tilesForBbox: normal bbox returns expected tiles', () => {
  const tiles = tilesForBbox({ latMin: 30, latMax: 40, lonMin: 0, lonMax: 45 }, 3);
  assert.ok(tiles.length > 0, 'normal bbox should return tiles');
  // lon 0–45 at z=3 → x=4 only (tiles are 45° wide)
  assert.ok(tiles.some(t => t.x === 4), 'should include tile x=4');
});

void test('tilesForBbox: antimeridian-crossing bbox returns tiles on both sides', () => {
  // lonMin=170 (east of antimeridian), lonMax=-170 (west of antimeridian)
  const tiles = tilesForBbox({ latMin: 30, latMax: 40, lonMin: 170, lonMax: -170 }, 3);
  assert.ok(tiles.length > 0, `antimeridian-crossing bbox must return tiles, got ${tiles.length}`);
  const xs = new Set(tiles.map(t => t.x));
  assert.ok(xs.has(7), 'must include tile x=7 (170°E side)');
  assert.ok(xs.has(0), 'must include tile x=0 (-170°W side)');
});

void test('tilesForBbox: antimeridian-crossing bbox tile count is correct', () => {
  // At z=3, lonMin=170 → x=7, lonMax=-170 → x=0.
  // Wrapping: tiles x=7, x=0 → 2 x-tiles.
  // latMin=30 → y=3, latMax=40 → y=3 → 1 y-tile.
  // Total: 2 × 1 = 2 tiles.
  const tiles = tilesForBbox({ latMin: 30, latMax: 40, lonMin: 170, lonMax: -170 }, 3);
  assert.strictEqual(tiles.length, 2, `expected 2 tiles, got ${tiles.length}`);
});
