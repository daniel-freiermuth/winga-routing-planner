// Unit tests for tile coverage (tilesForBbox) and TileWindProvider sampling across the antimeridian.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tilesForBbox, TileWindProvider } from '../tile-provider';
import { routeBbox } from '../geo';

// At z=3, there are 2^3 = 8 tiles along x (indices 0–7).
// latLonToTile(40, 170, 3) → x=7;  latLonToTile(30, -170, 3) → x=0.
// A bbox crossing the antimeridian (lonMin=170, lonMax=-170) must include
// tiles on both sides: at minimum x=7 (eastern) and x=0 (western).

void test('tilesForBbox: normal bbox returns exactly the covering tiles', () => {
  // lon 0–40 at z=3 → x=4 only (tiles are 45° wide); lat 30–40 → y=3 only.
  const tiles = tilesForBbox({ latMin: 30, latMax: 40, lonMin: 0, lonMax: 40 }, 3);
  assert.deepStrictEqual(tiles, [{ x: 4, y: 3 }]);
});

void test('tilesForBbox: antimeridian-crossing bbox returns tiles on both sides', () => {
  // lonMin=170 (east of antimeridian), lonMax=-170 (west of antimeridian)
  const tiles = tilesForBbox({ latMin: 30, latMax: 40, lonMin: 170, lonMax: -170 }, 3);
  assert.ok(tiles.length > 0, `antimeridian-crossing bbox must return tiles, got ${String(tiles.length)}`);
  const xs = new Set(tiles.map((t) => t.x));
  assert.ok(xs.has(7), 'must include tile x=7 (170°E side)');
  assert.ok(xs.has(0), 'must include tile x=0 (-170°W side)');
});

void test('tilesForBbox: antimeridian-crossing bbox tile count is correct', () => {
  // At z=3, lonMin=170 → x=7, lonMax=-170 → x=0.
  // Wrapping: tiles x=7, x=0 → 2 x-tiles.
  // latMin=30 → y=3, latMax=40 → y=3 → 1 y-tile.
  // Total: 2 × 1 = 2 tiles.
  const tiles = tilesForBbox({ latMin: 30, latMax: 40, lonMin: 170, lonMax: -170 }, 3);
  assert.strictEqual(tiles.length, 2, `expected 2 tiles, got ${String(tiles.length)}`);
});

void test('tilesForBbox: antimeridian-crossing bbox with both edges in one tile column covers all columns', () => {
  // lonMin=-150 and lonMax=-160 both map to x=0, but the bbox spans 350° across the antimeridian.
  const tiles = tilesForBbox({ latMin: 30, latMax: 40, lonMin: -150, lonMax: -160 }, 3);
  assert.deepStrictEqual(
    tiles.map((t) => t.x),
    [0, 1, 2, 3, 4, 5, 6, 7],
  );
});

void test('tilesForBbox: bbox extending west of -180° wraps to the eastern tile column', () => {
  // At z=4 tiles are 22.5° wide: lon -181 lies in the last column (x=15, 157.5°E..180°), lon -167 in x=0.
  const tiles = tilesForBbox({ latMin: 32, latMax: 39, lonMin: -181, lonMax: -167 }, 4);
  assert.deepStrictEqual(
    tiles.map((t) => t.x),
    [15, 0],
  );
});

void test('tilesForBbox: route bbox across the antimeridian covers both sides with valid columns', () => {
  const bbox = routeBbox([
    { lat: 35, lon: 175 },
    { lat: 36, lon: -175 },
  ]);
  const z = TileWindProvider.computeZoom(bbox);
  const tiles = tilesForBbox(bbox, z);
  const n = 2 ** z;
  assert.ok(tiles.length > 0, 'route bbox must yield tiles');
  for (const t of tiles) {
    assert.ok(t.x >= 0 && t.x < n && t.y >= 0 && t.y < n, `tile out of range: ${JSON.stringify(t)}`);
  }
  // z=4: 172°E lies in column 15, 188° (= 172°W) in column 0.
  assert.deepStrictEqual([...new Set(tiles.map((t) => t.x))], [15, 0]);
});

// ── TileWindProvider with stubbed Windy network + image decoding ──────────────

const TILE_SIZE = 257;
const TILE_ROWS = 265; // 8 header rows + 257 data rows
const HEADER_FLOAT_COUNT = 7;
const HEADER_BYTE_OFFSET = 8;
const HEADER_BYTE_STRIDE = 16;
const STUB_WIND_U = 7;
const STUB_REF = '2026-07-19T00:00:00Z';

/** A wind tile whose every pixel decodes to (u, v) = (STUB_WIND_U, 0), encoded like Windy's JPEG header. */
function uniformWindTile(): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(TILE_SIZE * TILE_ROWS * 4);
  const header = new Uint8Array(new Float32Array([STUB_WIND_U, STUB_WIND_U, 0, 0, 0, 0, 0]).buffer);
  for (let i = 0; i < HEADER_FLOAT_COUNT * 4; i++) {
    const byte = header[i] ?? 0;
    const off = HEADER_BYTE_OFFSET + i * HEADER_BYTE_STRIDE;
    rgba[off] = (byte >> 6) * 64;
    rgba[off + 1] = ((byte >> 2) & 15) * 16;
    rgba[off + 2] = (byte & 3) * 64;
  }
  return rgba;
}

void test('TileWindProvider: wind east of 180° is read from the wrapped tile, not reported as calm', async () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { fetch: g['fetch'], createImageBitmap: g['createImageBitmap'], OffscreenCanvas: g['OffscreenCanvas'] };
  const tile = uniformWindTile();
  // eslint-disable-next-line @typescript-eslint/require-await
  g['fetch'] = async (url: string) =>
    url.includes('minifest') ? Response.json({ ref: STUB_REF, end: STUB_REF, dst: [[3, 0, 0]] }) : new Response();
  // eslint-disable-next-line @typescript-eslint/require-await
  g['createImageBitmap'] = async () => ({ width: TILE_SIZE, height: TILE_ROWS });
  g['OffscreenCanvas'] = class {
    getContext(): unknown {
      return { drawImage: () => undefined, getImageData: () => ({ data: tile }) };
    }
  };
  try {
    // Bbox 167..181 at z=4 fetches columns 15 and 0 (wrapped).
    const provider = new TileWindProvider({ zoom: 4 });
    await provider.load({ latMin: 32, latMax: 39, lonMin: 167, lonMax: 181 });
    const t = new Date(STUB_REF).getTime();
    await provider.prefetchForTime(t);
    assert.strictEqual(provider.getWindAtTime(35, 181, t).u, STUB_WIND_U);
  } finally {
    Object.assign(g, saved);
  }
});
