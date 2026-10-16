// Unit tests for geographic primitives: distance, bearing, destination point, route bounding box, wind/current directions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  haversineNM,
  bearingTo,
  destinationPoint,
  routeBbox,
  windSpeedKnots,
  windDirection,
  currentDirection,
} from '../geo';

const EPSILON = 0.01; // 0.01 nm / 0.01 deg tolerance

void test('haversineNM: same point is zero', () => {
  assert.strictEqual(haversineNM(51, 4, 51, 4), 0);
});

void test('haversineNM: known distance — London to Paris ~185 nm', () => {
  const dist = haversineNM(51.5, -0.12, 48.85, 2.35);
  assert.ok(dist > 183 && dist < 187, `expected ~185 nm, got ${dist.toFixed(1)}`);
});

void test('haversineNM: one degree latitude ≈ 60 nm', () => {
  const dist = haversineNM(50, 10, 51, 10);
  assert.ok(Math.abs(dist - 60) < 0.5, `expected ~60 nm, got ${dist.toFixed(2)}`);
});

void test('bearingTo: due north', () => {
  const b = bearingTo(50, 10, 51, 10);
  assert.ok(Math.abs(b - 0) < EPSILON || Math.abs(b - 360) < EPSILON, `expected 0°, got ${String(b)}`);
});

void test('bearingTo: due east', () => {
  const b = bearingTo(50, 10, 50, 11);
  assert.ok(Math.abs(b - 90) < 1, `expected ~90°, got ${String(b)}`);
});

void test('bearingTo: due south', () => {
  const b = bearingTo(51, 10, 50, 10);
  assert.ok(Math.abs(b - 180) < EPSILON, `expected 180°, got ${String(b)}`);
});

void test('bearingTo: due west', () => {
  const b = bearingTo(50, 11, 50, 10);
  assert.ok(Math.abs(b - 270) < 1, `expected ~270°, got ${String(b)}`);
});

void test('destinationPoint: north 60 nm → ~1 degree latitude', () => {
  const { lat, lon } = destinationPoint(50, 10, 60, 0);
  assert.ok(Math.abs(lat - 51) < 0.01, `expected lat ~51, got ${String(lat)}`);
  assert.ok(Math.abs(lon - 10) < 0.01, `expected lon ~10, got ${String(lon)}`);
});

void test('destinationPoint: round-trip — arrive back at start', () => {
  const { lat, lon } = destinationPoint(48, 2, 100, 45);
  const dist = haversineNM(48, 2, lat, lon);
  assert.ok(Math.abs(dist - 100) < 0.01, `round-trip distance off: ${String(dist)}`);
});

void test('windSpeedKnots: unit vector → 1.94384 kt', () => {
  const kt = windSpeedKnots(1, 0);
  assert.ok(Math.abs(kt - 1.94384) < 0.0001);
});

void test('windSpeedKnots: pythagoras', () => {
  const kt = windSpeedKnots(3, 4); // magnitude 5 m/s
  assert.ok(Math.abs(kt - 5 * 1.94384) < 0.001);
});

void test('windDirection: northerly (blowing from north, u=0 v=-5)', () => {
  const dir = windDirection(0, -5);
  assert.ok(Math.abs(dir - 0) < EPSILON || Math.abs(dir - 360) < EPSILON, `expected 0°, got ${String(dir)}`);
});

void test('windDirection: southerly (blowing from south, u=0 v=5)', () => {
  const dir = windDirection(0, 5);
  assert.ok(Math.abs(dir - 180) < EPSILON, `expected 180°, got ${String(dir)}`);
});

void test('windDirection: westerly (blowing from west, u=5 v=0)', () => {
  const dir = windDirection(5, 0);
  assert.ok(Math.abs(dir - 270) < EPSILON, `expected 270°, got ${String(dir)}`);
});

void test('currentDirection: northward current (u=0 v=0.5) → 0° toward north', () => {
  const dir = currentDirection(0, 0.5);
  assert.ok(Math.abs(dir - 0) < EPSILON || Math.abs(dir - 360) < EPSILON, `expected 0°, got ${String(dir)}`);
});

void test('currentDirection: eastward current (u=0.5 v=0) → 90° toward east', () => {
  const dir = currentDirection(0.5, 0);
  assert.ok(Math.abs(dir - 90) < EPSILON, `expected 90°, got ${String(dir)}`);
});

void test('currentDirection: southward current (u=0 v=-0.5) → 180° toward south', () => {
  const dir = currentDirection(0, -0.5);
  assert.ok(Math.abs(dir - 180) < EPSILON, `expected 180°, got ${String(dir)}`);
});

void test('currentDirection: differs from windDirection by 180° (toward vs from)', () => {
  // Northward flow: currentDirection = 0° (toward N), windDirection = 180° (from S)
  const toward = currentDirection(0, 0.5);
  const from = windDirection(0, 0.5);
  assert.ok(
    Math.abs(((toward - from + 360) % 360) - 180) < EPSILON,
    `expected 180° difference, got toward=${String(toward)} from=${String(from)}`,
  );
});

void test('routeBbox: route away from the antimeridian gets the margin on every side', () => {
  assert.deepStrictEqual(
    routeBbox([
      { lat: 54, lon: 10 },
      { lat: 57, lon: 12 },
    ]),
    { latMin: 51, latMax: 60, lonMin: 7, lonMax: 15 },
  );
});

void test('routeBbox: route across the antimeridian spans the short way, not the whole globe', () => {
  // 175°E → 175°W is a 10° hop eastward; the box continues past 180° instead of covering -175..175.
  assert.deepStrictEqual(
    routeBbox([
      { lat: 35, lon: 175 },
      { lat: 36, lon: -175 },
    ]),
    { latMin: 32, latMax: 39, lonMin: 172, lonMax: 188 },
  );
});

void test('routeBbox: each leg is unwrapped from the previous point', () => {
  // 100°E → 180° → 100°W runs eastward across the Pacific (160° of longitude, margin 48°),
  // although 100°W is closer to the start going west.
  assert.deepStrictEqual(
    routeBbox([
      { lat: 0, lon: 100 },
      { lat: 0, lon: 180 },
      { lat: 0, lon: -100 },
    ]),
    { latMin: -48, latMax: 48, lonMin: 52, lonMax: 308 },
  );
});
