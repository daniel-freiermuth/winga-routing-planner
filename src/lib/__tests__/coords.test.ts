// Tests for the free-text coordinate parser used by the waypoint inputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tryParseCoords } from '../coords';

void test('tryParseCoords: hemisphere prefixes N/E', () => {
  assert.deepStrictEqual(tryParseCoords('N57.68 E11.87'), { lat: 57.68, lon: 11.87 });
});

void test('tryParseCoords: hemisphere prefixes S/W negate both values', () => {
  assert.deepStrictEqual(tryParseCoords('S57.68 W11.87'), { lat: -57.68, lon: -11.87 });
});

void test('tryParseCoords: hemisphere prefixes are case-insensitive', () => {
  assert.deepStrictEqual(tryParseCoords('s33.86, w70.5'), { lat: -33.86, lon: -70.5 });
});

void test('tryParseCoords: plain comma-separated decimals', () => {
  assert.deepStrictEqual(tryParseCoords('57.68, 11.87'), { lat: 57.68, lon: 11.87 });
});

void test('tryParseCoords: plain space-separated decimals', () => {
  assert.deepStrictEqual(tryParseCoords('57.68 11.87'), { lat: 57.68, lon: 11.87 });
});

void test('tryParseCoords: signed decimals without hemisphere letters', () => {
  assert.deepStrictEqual(tryParseCoords('-33.86, -151.2'), { lat: -33.86, lon: -151.2 });
});

void test('tryParseCoords: surrounding whitespace is ignored', () => {
  assert.deepStrictEqual(tryParseCoords('  57.68, 11.87  '), { lat: 57.68, lon: 11.87 });
});

void test('tryParseCoords: |lat| = 90 and |lon| = 180 are accepted', () => {
  assert.deepStrictEqual(tryParseCoords('90, 180'), { lat: 90, lon: 180 });
  assert.deepStrictEqual(tryParseCoords('-90, -180'), { lat: -90, lon: -180 });
  assert.deepStrictEqual(tryParseCoords('S90 W180'), { lat: -90, lon: -180 });
});

void test('tryParseCoords: latitude beyond 90 is rejected', () => {
  assert.strictEqual(tryParseCoords('90.0001, 0'), null);
  assert.strictEqual(tryParseCoords('-90.0001, 0'), null);
  assert.strictEqual(tryParseCoords('S90.0001 E0'), null);
});

void test('tryParseCoords: longitude beyond 180 is rejected', () => {
  assert.strictEqual(tryParseCoords('0, 180.0001'), null);
  assert.strictEqual(tryParseCoords('0, -180.0001'), null);
  assert.strictEqual(tryParseCoords('N0 W180.0001'), null);
});

void test('tryParseCoords: non-coordinate text is rejected', () => {
  assert.strictEqual(tryParseCoords(''), null);
  assert.strictEqual(tryParseCoords('Gothenburg'), null);
  assert.strictEqual(tryParseCoords('57.68'), null);
  assert.strictEqual(tryParseCoords('57.68, 11.87, 3'), null);
});
