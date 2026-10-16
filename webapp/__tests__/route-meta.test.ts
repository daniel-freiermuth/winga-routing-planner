// Unit tests for worker-route → RouteData conversion (COG/SOG/current derivation) and scrubber leg lookup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routePointsToRouteData, findScrubberPosition } from '../route-meta';
import type { WorkerRoutePoint } from '../route-meta';
import type { WaypointMeta } from '../types';

const T0 = '2026-01-01T00:00:00.000Z';
const T6H = '2026-01-01T06:00:00.000Z';
const MS_TO_KN = 1.94384;

function pt(lat: number, lon: number, time: string | Date, extra: Partial<WorkerRoutePoint> = {}): WorkerRoutePoint {
  return { lat, lon, time, ctw: 0, twa: 90, tws: 12, windDir: 270, ...extra };
}

function metaOf(route: WorkerRoutePoint[]): WaypointMeta[] {
  return routePointsToRouteData(route).feature.properties.coordinatesMeta;
}

function near(actual: number | undefined, expected: number, eps: number) {
  assert.ok(
    actual !== undefined && Math.abs(actual - expected) < eps,
    `expected ${String(expected)}, got ${String(actual)}`,
  );
}

void test('routePointsToRouteData: GeoJSON LineString uses [lon, lat] order', () => {
  const rd = routePointsToRouteData([pt(50, 1, T0), pt(51, 2, T6H)]);
  assert.equal(rd.feature.type, 'Feature');
  assert.equal(rd.feature.geometry.type, 'LineString');
  assert.deepEqual(rd.feature.geometry.coordinates, [
    [1, 50],
    [2, 51],
  ]);
});

void test('routePointsToRouteData: first point has no COG/SOG', () => {
  const [first] = metaOf([pt(50, 1, T0), pt(51, 1, T6H)]);
  assert.equal(first?.cogDeg, undefined);
  assert.equal(first?.sogKn, undefined);
});

void test('routePointsToRouteData: due north 1° lat in 6 h → COG 0°, SOG ≈ 10 kn', () => {
  const [, second] = metaOf([pt(50, 1, T0), pt(51, 1, T6H)]);
  near(second?.cogDeg, 0, 1e-9);
  near(second?.sogKn, 60.04 / 6, 0.01);
});

void test('routePointsToRouteData: westward leg yields COG in [0,360) (≈270°)', () => {
  const [, second] = metaOf([pt(0, 1, T0), pt(0, 0, T6H)]);
  near(second?.cogDeg, 270, 1e-9);
});

void test('routePointsToRouteData: zero time delta → SOG 0 instead of Infinity', () => {
  const [, second] = metaOf([pt(50, 1, T0), pt(51, 1, T0)]);
  assert.equal(second?.sogKn, 0);
});

void test('routePointsToRouteData: Date times (structured clone) become ISO strings and still yield SOG', () => {
  const [first, second] = metaOf([pt(50, 1, new Date(T0)), pt(51, 1, new Date(T6H))]);
  assert.equal(first?.time, T0);
  assert.equal(second?.time, T6H);
  near(second.sogKn, 60.04 / 6, 0.01);
});

void test('routePointsToRouteData: current flowing south → dir 180°, speed in knots', () => {
  const [first] = metaOf([pt(50, 1, T0, { currentU: 0, currentV: -1 }), pt(51, 1, T6H)]);
  near(first?.currentSpeedKn, MS_TO_KN, 1e-9);
  near(first?.currentDir, 180, 1e-9);
});

void test('routePointsToRouteData: current flowing west wraps to 270° (not -90°)', () => {
  const [first] = metaOf([pt(50, 1, T0, { currentU: -1, currentV: 0 }), pt(51, 1, T6H)]);
  near(first?.currentDir, 270, 1e-9);
});

void test('routePointsToRouteData: current ≤ 0.01 kn or with a missing component is omitted', () => {
  const [weak, onlyU] = metaOf([pt(50, 1, T0, { currentU: 0.005, currentV: 0 }), pt(51, 1, T6H, { currentU: 1 })]);
  assert.equal(weak?.currentSpeedKn, undefined);
  assert.equal(weak?.currentDir, undefined);
  assert.equal(onlyU?.currentSpeedKn, undefined);
  assert.equal(onlyU?.currentDir, undefined);
});

void test('routePointsToRouteData: absent optional fields are omitted; zero values are kept', () => {
  const [bare, zeros] = metaOf([
    pt(50, 1, T0),
    pt(51, 1, T6H, {
      boatSpeed: 0,
      waveHeight: 0,
      gribFilePath: 'f.grb',
      gustKn: 0,
      wavePeriod: 0,
      waveDir: 0,
      wowTws: 0,
      wowDir: 0,
    }),
  ]);
  for (const key of ['boatSpeed', 'waveHeight', 'gribFile', 'gustKn', 'wavePeriod', 'waveDir', 'wowTws', 'wowDir']) {
    assert.ok(!Object.hasOwn(bare ?? {}, key), `${key} should be omitted`);
  }
  assert.equal(zeros?.boatSpeed, 0);
  assert.equal(zeros.waveHeight, 0);
  assert.equal(zeros.gribFile, 'f.grb');
  assert.equal(zeros.gustKn, 0);
  assert.equal(zeros.wavePeriod, 0);
  assert.equal(zeros.waveDir, 0);
  assert.equal(zeros.wowTws, 0);
  assert.equal(zeros.wowDir, 0);
});

const META: WaypointMeta[] = ['2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z', '2026-01-01T02:00:00Z'].map((time) => ({
  name: '',
  time,
  windDir: 0,
  ctw: 0,
  twa: 0,
  tws: 0,
}));
const ms = (iso: string) => new Date(iso).getTime();

void test('findScrubberPosition: null or single-entry meta → -1', () => {
  assert.deepEqual(findScrubberPosition(null, ms('2026-01-01T00:00:00Z')), { wpIdx: -1, legIdx: -1 });
  assert.deepEqual(findScrubberPosition(META.slice(0, 1), ms('2026-01-01T00:00:00Z')), { wpIdx: -1, legIdx: -1 });
});

void test('findScrubberPosition: before first or after last waypoint → -1', () => {
  assert.equal(findScrubberPosition(META, ms('2025-12-31T23:59:59Z')).wpIdx, -1);
  assert.equal(findScrubberPosition(META, ms('2026-01-01T02:00:01Z')).wpIdx, -1);
});

void test('findScrubberPosition: interior time maps to its leg', () => {
  assert.deepEqual(findScrubberPosition(META, ms('2026-01-01T01:30:00Z')), { wpIdx: 1, legIdx: 1 });
});

void test('findScrubberPosition: exact boundaries are inclusive; shared boundary picks the earlier leg', () => {
  assert.equal(findScrubberPosition(META, ms('2026-01-01T00:00:00Z')).wpIdx, 0);
  assert.equal(findScrubberPosition(META, ms('2026-01-01T01:00:00Z')).wpIdx, 0);
  assert.equal(findScrubberPosition(META, ms('2026-01-01T02:00:00Z')).wpIdx, 1);
});
