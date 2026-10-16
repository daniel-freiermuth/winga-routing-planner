// Tests for tile coordinate conversion, header decoding, and pixel sampling.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  latLonToTile,
  latLonToPixel,
  latLonToPixelFrac,
  decodeTileHeader,
  sampleTilePixel,
  sampleTileBilinear,
} from "../tiles.js";

import type { WindyTileHeader } from "../types.js";

// ---------------------------------------------------------------------------
// Constants mirrored from tiles.ts
// ---------------------------------------------------------------------------

const TILE_SIZE = 257;
const HEADER_ROWS = 8;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal 265×257 RGBA buffer whose 8-row header encodes the given
 * rescale floats [Rmin, Rmax, Gmin, Gmax, Bmin, Bmax, spare].
 *
 * Reproduces the Windy p_() encoding: 28 bytes stored across 28 groups of 4
 * redundant pixels at stride 16 bytes, starting at byte offset 8 (pixel 2).
 *
 * Each byte is split: 2 bits from R (*64), 4 bits from G (*16), 2 bits from B (*64).
 */
function buildHeaderRgba(floats: Float32Array): Uint8Array {
  const totalRows = HEADER_ROWS + TILE_SIZE; // 265
  const rgba = new Uint8Array(totalRows * TILE_SIZE * 4);

  const bytes = new Uint8Array(floats.buffer);
  let offset = 8; // starting byte offset (pixel 2)
  for (let i = 0; i < 28; i++) {
    const b = bytes[i]!;
    const rBits = (b >> 6) & 0x03; // top 2 bits
    const gBits = (b >> 2) & 0x0f; // middle 4 bits
    const bBits = b & 0x03; // bottom 2 bits

    // Encode into RGBA — multiply by the quantisation step used in decoding
    const R = rBits * 64;
    const G = gBits * 16;
    const B = bBits * 64;
    const A = 255;

    // Write into all 4 redundant pixels at this group
    for (let p = 0; p < 4; p++) {
      rgba[offset + p * 4] = R;
      rgba[offset + p * 4 + 1] = G;
      rgba[offset + p * 4 + 2] = B;
      rgba[offset + p * 4 + 3] = A;
    }
    offset += 16; // stride: 4 pixels × 4 bytes
  }

  return rgba;
}

/**
 * Write a single data pixel into an RGBA buffer at data-row (py) and column (px).
 */
function setDataPixel(
  rgba: Uint8Array,
  px: number,
  py: number,
  r: number,
  g: number,
  b: number,
  a = 255
): void {
  const row = py + HEADER_ROWS;
  const offset = (row * TILE_SIZE + px) * 4;
  rgba[offset] = r;
  rgba[offset + 1] = g;
  rgba[offset + 2] = b;
  rgba[offset + 3] = a;
}

const EPSILON = 1e-6;

// ---------------------------------------------------------------------------
// latLonToTile
// ---------------------------------------------------------------------------

void test("latLonToTile: origin (0, 0) at z=1 → tile (1, 1)", () => {
  const { x, y } = latLonToTile(0, 0, 1);
  assert.strictEqual(x, 1);
  assert.strictEqual(y, 1);
});

void test("latLonToTile: NW corner at z=0 → tile (0, 0)", () => {
  const { x, y } = latLonToTile(80, -170, 0);
  assert.strictEqual(x, 0);
  assert.strictEqual(y, 0);
});

void test("latLonToTile: z=2 has 4×4 grid — known position", () => {
  // London: ~51.5°N, ~-0.1°W → with z=2, n=4
  // x = floor(((-0.1 + 180)/360)*4) = floor(1.9989) = 1
  const { x, y } = latLonToTile(51.5, -0.1, 2);
  assert.strictEqual(x, 1);
  // y: latRad = 0.8988..., Mercator y ≈ floor(((1 - ln(tan+sec)/π)/2)*4)
  // tan(0.8988)=1.2699, sec=1.6243, ln(2.8942)=1.0627, val=0.6614, y=floor(1.3228)=1
  assert.strictEqual(y, 1);
});

void test("latLonToTile: +180° longitude (tile x wrap)", () => {
  // At exactly +180°: x = floor((360/360)*n) = n, but should be n-1 or wrap
  // The function computes floor(n) = n which is technically out of range for
  // a standard tile grid, but this is the raw math — we just verify it doesn't throw.
  const { x } = latLonToTile(0, 180, 3);
  assert.strictEqual(x, 2 ** 3); // 8 — edge case, one past last tile
});

void test("latLonToTile: -180° longitude → tile x=0", () => {
  const { x } = latLonToTile(0, -180, 3);
  assert.strictEqual(x, 0);
});

void test("latLonToTile: extreme latitude near Mercator limit ~85°", () => {
  // 85.05° is the Mercator limit. At z=3, y should be 0 (top tile).
  const { y } = latLonToTile(85, 0, 3);
  assert.strictEqual(y, 0);
});

void test("latLonToTile: extreme negative latitude near -85°", () => {
  const n = 2 ** 3;
  const { y } = latLonToTile(-85, 0, 3);
  // Should be near the bottom tile (n-1 = 7)
  assert.strictEqual(y, n - 1);
});

// ---------------------------------------------------------------------------
// latLonToPixel
// ---------------------------------------------------------------------------

void test("latLonToPixel: tile origin → pixel (0, 0)", () => {
  // A point at the very top-left corner of its tile should map to px=0, py=0.
  // Use z=1: tile (1,1) starts at lon=0, lat=0 (equator at Mercator midpoint).
  // lon=0 → fx = ((0+180)/360)*2 - 1 = 0 → px = round(0 * 256) = 0
  const { px, py } = latLonToPixel(0, 0, 1, 1, 1);
  assert.strictEqual(px, 0);
  assert.strictEqual(py, 0);
});

void test("latLonToPixel: pixel near tile boundary → px close to 256", () => {
  // At z=1, tile (0,0) spans lon [-180, 0]. A point just below lon=0 should
  // map to px near 256.
  const { px } = latLonToPixel(45, -0.001, 1, 0, 0);
  assert.ok(px >= 255, `expected px ≥ 255, got ${px}`);
});

void test("latLonToPixel: centre of tile → px ≈ 128", () => {
  // z=1, tile (0,0) spans lon [-180, 0]. Centre at lon=-90.
  const { px } = latLonToPixel(45, -90, 1, 0, 0);
  assert.strictEqual(px, 128);
});

// ---------------------------------------------------------------------------
// latLonToPixelFrac
// ---------------------------------------------------------------------------

void test("latLonToPixelFrac: returns unrounded fractional coordinates", () => {
  // For a point not at tile boundary, frac version should differ from rounded
  const frac = latLonToPixelFrac(51.5, -0.05, 2, 1, 1);
  // Just verify it returns numbers and they are not necessarily integers
  assert.strictEqual(typeof frac.px, "number");
  assert.strictEqual(typeof frac.py, "number");
  assert.ok(Number.isFinite(frac.px));
  assert.ok(Number.isFinite(frac.py));
});

void test("latLonToPixelFrac: tile origin gives 0, 0", () => {
  const frac = latLonToPixelFrac(0, 0, 1, 1, 1);
  assert.ok(Math.abs(frac.px) < EPSILON, `expected px ≈ 0, got ${frac.px}`);
  assert.ok(Math.abs(frac.py) < EPSILON, `expected py ≈ 0, got ${frac.py}`);
});

// ---------------------------------------------------------------------------
// decodeTileHeader
// ---------------------------------------------------------------------------

void test("decodeTileHeader: round-trips known rescale floats", () => {
  // Known values: wind u component range [-30, 30], v range [-25, 25]
  const floatValues = new Float32Array(7);
  floatValues[0] = -30; // Rmin
  floatValues[1] = 30; // Rmax
  floatValues[2] = -25; // Gmin
  floatValues[3] = 25; // Gmax
  floatValues[4] = 0; // Bmin
  floatValues[5] = 10; // Bmax
  floatValues[6] = 0; // spare

  const rgba = buildHeaderRgba(floatValues);
  const header = decodeTileHeader(rgba);

  // Rmin/Rmax → step = (30 - (-30)) / 255 = 60/255
  assert.ok(
    Math.abs(header.decoderRmin - (-30)) < 0.01,
    `Rmin: expected -30, got ${header.decoderRmin}`
  );
  assert.ok(
    Math.abs(header.decoderRstep - 60 / 255) < 0.001,
    `Rstep: expected ${60 / 255}, got ${header.decoderRstep}`
  );

  // Gmin/Gmax → step = (25 - (-25)) / 255 = 50/255
  assert.ok(
    Math.abs(header.decoderGmin - (-25)) < 0.01,
    `Gmin: expected -25, got ${header.decoderGmin}`
  );
  assert.ok(
    Math.abs(header.decoderGstep - 50 / 255) < 0.001,
    `Gstep: expected ${50 / 255}, got ${header.decoderGstep}`
  );

  // Bmin/Bmax → step = 10/255
  assert.ok(
    Math.abs(header.decoderBmin - 0) < 0.01,
    `Bmin: expected 0, got ${header.decoderBmin}`
  );
  assert.ok(
    Math.abs(header.decoderBstep - 10 / 255) < 0.001,
    `Bstep: expected ${10 / 255}, got ${header.decoderBstep}`
  );
});

void test("decodeTileHeader: zero range → zero step", () => {
  const floatValues = new Float32Array(7); // all zeros
  const rgba = buildHeaderRgba(floatValues);
  const header = decodeTileHeader(rgba);

  assert.ok(
    Math.abs(header.decoderRstep) < EPSILON,
    `Rstep should be ~0, got ${header.decoderRstep}`
  );
  assert.ok(
    Math.abs(header.decoderGstep) < EPSILON,
    `Gstep should be ~0, got ${header.decoderGstep}`
  );
  assert.ok(
    Math.abs(header.decoderBstep) < EPSILON,
    `Bstep should be ~0, got ${header.decoderBstep}`
  );
});

// ---------------------------------------------------------------------------
// sampleTilePixel
// ---------------------------------------------------------------------------

void test("sampleTilePixel: decodes correct u/v from known pixel + header", () => {
  // Header: u = R * Rstep + Rmin, v = G * Gstep + Gmin
  // Rstep = 60/255, Rmin = -30 → R=128: u = 128 * 60/255 + (-30) = 0.1176...
  // Gstep = 50/255, Gmin = -25 → G=200: v = 200 * 50/255 + (-25) = 14.2157...
  const header: WindyTileHeader = {
    decoderRmin: -30,
    decoderRstep: 60 / 255,
    decoderGmin: -25,
    decoderGstep: 50 / 255,
    decoderBmin: 0,
    decoderBstep: 10 / 255,
  };

  const totalRows = HEADER_ROWS + TILE_SIZE;
  const rgba = new Uint8Array(totalRows * TILE_SIZE * 4);
  setDataPixel(rgba, 10, 20, 128, 200, 50);

  const val = sampleTilePixel(rgba, header, 10, 20);

  const expectedU = 128 * (60 / 255) + -30;
  const expectedV = 200 * (50 / 255) + -25;

  assert.ok(
    Math.abs(val.u - expectedU) < EPSILON,
    `u: expected ${expectedU}, got ${val.u}`
  );
  assert.ok(
    Math.abs(val.v - expectedV) < EPSILON,
    `v: expected ${expectedV}, got ${val.v}`
  );
  assert.ok(
    Math.abs(val.speed - Math.sqrt(expectedU ** 2 + expectedV ** 2)) < EPSILON,
    `speed mismatch`
  );
  assert.strictEqual(val.hasData, true);
});

void test("sampleTilePixel: height decoded from B channel", () => {
  const header: WindyTileHeader = {
    decoderRmin: 0,
    decoderRstep: 1 / 255,
    decoderGmin: 0,
    decoderGstep: 1 / 255,
    decoderBmin: 0,
    decoderBstep: 10 / 255,
  };

  const totalRows = HEADER_ROWS + TILE_SIZE;
  const rgba = new Uint8Array(totalRows * TILE_SIZE * 4);
  setDataPixel(rgba, 5, 5, 0, 0, 127);

  const val = sampleTilePixel(rgba, header, 5, 5);
  const expectedHeight = 127 * (10 / 255);
  assert.ok(
    Math.abs(val.height - expectedHeight) < EPSILON,
    `height: expected ${expectedHeight}, got ${val.height}`
  );
});

void test("sampleTilePixel: JPEG ocean model — B ≥ 250 means no data", () => {
  const header: WindyTileHeader = {
    decoderRmin: 0,
    decoderRstep: 1,
    decoderGmin: 0,
    decoderGstep: 1,
    decoderBmin: 0,
    decoderBstep: 1,
  };

  const totalRows = HEADER_ROWS + TILE_SIZE;
  const rgba = new Uint8Array(totalRows * TILE_SIZE * 4);
  setDataPixel(rgba, 3, 3, 100, 100, 255); // B=255 → land

  const val = sampleTilePixel(rgba, header, 3, 3, true, false);
  assert.strictEqual(val.hasData, false);
});

void test("sampleTilePixel: JPEG ocean model — B < 250 means has data", () => {
  const header: WindyTileHeader = {
    decoderRmin: 0,
    decoderRstep: 1,
    decoderGmin: 0,
    decoderGstep: 1,
    decoderBmin: 0,
    decoderBstep: 1,
  };

  const totalRows = HEADER_ROWS + TILE_SIZE;
  const rgba = new Uint8Array(totalRows * TILE_SIZE * 4);
  setDataPixel(rgba, 3, 3, 100, 100, 200); // B=200 < 250

  const val = sampleTilePixel(rgba, header, 3, 3, true, false);
  assert.strictEqual(val.hasData, true);
});

void test("sampleTilePixel: PNG tile — alpha=0 means no data", () => {
  const header: WindyTileHeader = {
    decoderRmin: 0,
    decoderRstep: 1,
    decoderGmin: 0,
    decoderGstep: 1,
    decoderBmin: 0,
    decoderBstep: 1,
  };

  const totalRows = HEADER_ROWS + TILE_SIZE;
  const rgba = new Uint8Array(totalRows * TILE_SIZE * 4);
  setDataPixel(rgba, 7, 7, 100, 100, 100, 0); // alpha=0

  const val = sampleTilePixel(rgba, header, 7, 7, false, true);
  assert.strictEqual(val.hasData, false);
});

void test("sampleTilePixel: PNG tile — alpha > 0 means has data", () => {
  const header: WindyTileHeader = {
    decoderRmin: 0,
    decoderRstep: 1,
    decoderGmin: 0,
    decoderGstep: 1,
    decoderBmin: 0,
    decoderBstep: 1,
  };

  const totalRows = HEADER_ROWS + TILE_SIZE;
  const rgba = new Uint8Array(totalRows * TILE_SIZE * 4);
  setDataPixel(rgba, 7, 7, 100, 100, 100, 128); // alpha=128

  const val = sampleTilePixel(rgba, header, 7, 7, false, true);
  assert.strictEqual(val.hasData, true);
});

void test("sampleTilePixel: non-ocean JPEG always has data", () => {
  const header: WindyTileHeader = {
    decoderRmin: 0,
    decoderRstep: 1,
    decoderGmin: 0,
    decoderGstep: 1,
    decoderBmin: 0,
    decoderBstep: 1,
  };

  const totalRows = HEADER_ROWS + TILE_SIZE;
  const rgba = new Uint8Array(totalRows * TILE_SIZE * 4);
  setDataPixel(rgba, 0, 0, 0, 0, 255); // B=255, but not ocean model

  const val = sampleTilePixel(rgba, header, 0, 0, false, false);
  assert.strictEqual(val.hasData, true);
});

void test("sampleTilePixel: direction wraps to [0, 360)", () => {
  const header: WindyTileHeader = {
    decoderRmin: -10,
    decoderRstep: 20 / 255,
    decoderGmin: -10,
    decoderGstep: 20 / 255,
    decoderBmin: 0,
    decoderBstep: 0,
  };

  const totalRows = HEADER_ROWS + TILE_SIZE;
  const rgba = new Uint8Array(totalRows * TILE_SIZE * 4);
  setDataPixel(rgba, 1, 1, 100, 100, 0);

  const val = sampleTilePixel(rgba, header, 1, 1);
  assert.ok(val.direction >= 0, `direction should be ≥ 0, got ${val.direction}`);
  assert.ok(
    val.direction < 360,
    `direction should be < 360, got ${val.direction}`
  );
});

// ---------------------------------------------------------------------------
// sampleTileBilinear
// ---------------------------------------------------------------------------

void test("sampleTileBilinear: integer pixel coords → same as sampleTilePixel", () => {
  const header: WindyTileHeader = {
    decoderRmin: -30,
    decoderRstep: 60 / 255,
    decoderGmin: -25,
    decoderGstep: 50 / 255,
    decoderBmin: 0,
    decoderBstep: 10 / 255,
  };

  const totalRows = HEADER_ROWS + TILE_SIZE;
  const rgba = new Uint8Array(totalRows * TILE_SIZE * 4);
  setDataPixel(rgba, 50, 50, 128, 200, 50);
  // Also set surrounding pixels for bilinear (51,50), (50,51), (51,51)
  setDataPixel(rgba, 51, 50, 128, 200, 50);
  setDataPixel(rgba, 50, 51, 128, 200, 50);
  setDataPixel(rgba, 51, 51, 128, 200, 50);

  const bilinear = sampleTileBilinear(rgba, header, 50, 50);
  const single = sampleTilePixel(rgba, header, 50, 50);

  // At integer coords (fx=0, fy=0), bilinear weights give 100% to (x0,y0)
  assert.ok(
    Math.abs(bilinear.u - single.u) < EPSILON,
    `u mismatch: ${bilinear.u} vs ${single.u}`
  );
  assert.ok(
    Math.abs(bilinear.v - single.v) < EPSILON,
    `v mismatch: ${bilinear.v} vs ${single.v}`
  );
});

void test("sampleTileBilinear: midpoint interpolation between 4 pixels", () => {
  const header: WindyTileHeader = {
    decoderRmin: 0,
    decoderRstep: 1, // u = R * 1 + 0 = R
    decoderGmin: 0,
    decoderGstep: 1, // v = G * 1 + 0 = G
    decoderBmin: 0,
    decoderBstep: 1,
  };

  const totalRows = HEADER_ROWS + TILE_SIZE;
  const rgba = new Uint8Array(totalRows * TILE_SIZE * 4);

  // Four corners with different R values (u component):
  // (10,10)=R40, (11,10)=R80, (10,11)=R120, (11,11)=R160
  setDataPixel(rgba, 10, 10, 40, 0, 0);
  setDataPixel(rgba, 11, 10, 80, 0, 0);
  setDataPixel(rgba, 10, 11, 120, 0, 0);
  setDataPixel(rgba, 11, 11, 160, 0, 0);

  // At midpoint (10.5, 10.5), bilinear average: (40+80+120+160)/4 = 100
  const val = sampleTileBilinear(rgba, header, 10.5, 10.5);
  assert.ok(
    Math.abs(val.u - 100) < EPSILON,
    `u: expected 100, got ${val.u}`
  );
});

void test("sampleTileBilinear: edge clamp — px near tile size", () => {
  const header: WindyTileHeader = {
    decoderRmin: 0,
    decoderRstep: 1,
    decoderGmin: 0,
    decoderGstep: 1,
    decoderBmin: 0,
    decoderBstep: 1,
  };

  const totalRows = HEADER_ROWS + TILE_SIZE;
  const rgba = new Uint8Array(totalRows * TILE_SIZE * 4);

  // Set pixel at last column (256) and last data row (256)
  setDataPixel(rgba, 256, 256, 100, 50, 25);

  // At px=256.0 (edge), x0=256, x1=min(257, 256)=256 → same column
  const val = sampleTileBilinear(rgba, header, 256, 256);
  assert.ok(
    Math.abs(val.u - 100) < EPSILON,
    `u at edge: expected 100, got ${val.u}`
  );
});

void test("sampleTileBilinear: falls back to nearest when corner has no data (ocean)", () => {
  const header: WindyTileHeader = {
    decoderRmin: 0,
    decoderRstep: 1,
    decoderGmin: 0,
    decoderGstep: 1,
    decoderBmin: 0,
    decoderBstep: 1,
  };

  const totalRows = HEADER_ROWS + TILE_SIZE;
  const rgba = new Uint8Array(totalRows * TILE_SIZE * 4);

  // Set 3 corners with valid data, 1 corner as land (B=255 for ocean model)
  setDataPixel(rgba, 20, 20, 50, 50, 100);
  setDataPixel(rgba, 21, 20, 50, 50, 100);
  setDataPixel(rgba, 20, 21, 50, 50, 100);
  setDataPixel(rgba, 21, 21, 50, 50, 255); // land sentinel

  // Bilinear at (20.3, 20.3) — one corner has no data, should fall back to
  // nearest-pixel: round(20.3)=20, round(20.3)=20 → pixel (20, 20)
  const val = sampleTileBilinear(rgba, header, 20.3, 20.3, true, false);

  const nearest = sampleTilePixel(rgba, header, 20, 20, true, false);
  assert.ok(
    Math.abs(val.u - nearest.u) < EPSILON,
    `should fall back to nearest pixel u`
  );
  assert.ok(
    Math.abs(val.v - nearest.v) < EPSILON,
    `should fall back to nearest pixel v`
  );
});

void test("sampleTileBilinear: hasData is true when all corners have data", () => {
  const header: WindyTileHeader = {
    decoderRmin: 0,
    decoderRstep: 1,
    decoderGmin: 0,
    decoderGstep: 1,
    decoderBmin: 0,
    decoderBstep: 1,
  };

  const totalRows = HEADER_ROWS + TILE_SIZE;
  const rgba = new Uint8Array(totalRows * TILE_SIZE * 4);
  setDataPixel(rgba, 30, 30, 10, 20, 30);
  setDataPixel(rgba, 31, 30, 10, 20, 30);
  setDataPixel(rgba, 30, 31, 10, 20, 30);
  setDataPixel(rgba, 31, 31, 10, 20, 30);

  const val = sampleTileBilinear(rgba, header, 30.5, 30.5);
  assert.strictEqual(val.hasData, true);
});

// ---------------------------------------------------------------------------
// End-to-end: header decode → pixel sample
// ---------------------------------------------------------------------------

void test("end-to-end: encode header, set data pixel, decode and sample", () => {
  // Encode a header with known rescale values
  const floatValues = new Float32Array(7);
  floatValues[0] = -20; // Rmin
  floatValues[1] = 20; // Rmax
  floatValues[2] = -15; // Gmin
  floatValues[3] = 15; // Gmax
  floatValues[4] = 0; // Bmin
  floatValues[5] = 5; // Bmax
  floatValues[6] = 0;

  const rgba = buildHeaderRgba(floatValues);
  const header = decodeTileHeader(rgba);

  // Set a data pixel: R=128, G=64, B=100
  setDataPixel(rgba, 100, 100, 128, 64, 100);

  const val = sampleTilePixel(rgba, header, 100, 100);

  // Expected: u = 128 * ((20-(-20))/255) + (-20) = 128 * 40/255 - 20
  const expectedU = 128 * header.decoderRstep + header.decoderRmin;
  const expectedV = 64 * header.decoderGstep + header.decoderGmin;

  assert.ok(
    Math.abs(val.u - expectedU) < EPSILON,
    `u: expected ${expectedU}, got ${val.u}`
  );
  assert.ok(
    Math.abs(val.v - expectedV) < EPSILON,
    `v: expected ${expectedV}, got ${val.v}`
  );
  assert.strictEqual(val.hasData, true);
});
