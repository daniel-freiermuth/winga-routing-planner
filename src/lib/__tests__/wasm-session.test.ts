// Tests for the routing worker's WASM session glue: step-loop status handling, frame bracketing, corridor grid, route decoding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_STEP_ITERATIONS,
  ROUTE_STRIDE,
  bracketingSteps,
  corridorGridSpec,
  decodeRoute,
  frontierNearGridEdge,
  runStepLoop,
  type CorridorGridSpec,
  type StepLoopHooks,
  type StepSession,
} from '../wasm-session';

// ── runStepLoop ───────────────────────────────────────────────────────────────

interface FakeSession extends StepSession {
  log: string[];
}

/** Session that returns `statuses` from successive step() calls, then repeats the last one. */
function fakeSession(statuses: number[], opts: { error?: string; bracket?: number[] } = {}): FakeSession {
  const log: string[] = [];
  let calls = 0;
  return {
    log,
    needs: () => new Float64Array(opts.bracket ?? [1000, 2000]),
    step: () => {
      log.push('step');
      const status = statuses[Math.min(calls, statuses.length - 1)] ?? 0;
      calls++;
      return status;
    },
    error: () => opts.error,
    evict_old_frames: () => {
      log.push('evict');
    },
  };
}

function recordingHooks(log: string[]): StepLoopHooks {
  return {
    beforeStep: async (iteration, timeLo, timeHi) => {
      log.push(`before ${String(iteration)} ${String(timeLo)} ${String(timeHi)}`);
      await Promise.resolve();
    },
    afterStep: async () => {
      log.push('after');
      await Promise.resolve();
    },
  };
}

void test('runStepLoop: pushes weather for the needed bracket before every step, until arrival', async () => {
  const session = fakeSession([0, 0, 1], { bracket: [1000, 4600] });
  const outcome = await runStepLoop(session, recordingHooks(session.log));
  assert.deepStrictEqual(outcome, { kind: 'arrived' });
  assert.deepStrictEqual(session.log, [
    'before 0 1000 4600',
    'step',
    'after',
    'before 1 1000 4600',
    'step',
    'after',
    'before 2 1000 4600',
    'step',
  ]);
});

void test('runStepLoop: no-progress with an error message → error outcome carrying the message', async () => {
  const session = fakeSession([2], { error: 'Start position is on land' });
  const outcome = await runStepLoop(session, recordingHooks(session.log));
  assert.deepStrictEqual(outcome, { kind: 'error', message: 'Start position is on land' });
});

void test('runStepLoop: no-progress with empty or missing error → noProgress, distinct from arrival', async () => {
  for (const error of ['', undefined]) {
    const session = fakeSession([0, 2], error === undefined ? {} : { error });
    const outcome = await runStepLoop(session, recordingHooks(session.log));
    assert.deepStrictEqual(outcome, { kind: 'noProgress' });
    assert.strictEqual(session.log.filter((e) => e === 'after').length, 1, 'afterStep not run for terminal step');
  }
});

void test('runStepLoop: forecast exhausted → exhausted outcome', async () => {
  const session = fakeSession([0, 0, 3]);
  const outcome = await runStepLoop(session, recordingHooks(session.log));
  assert.deepStrictEqual(outcome, { kind: 'exhausted' });
});

void test('runStepLoop: empty needs() bracket stops before stepping', async () => {
  const session = fakeSession([1], { bracket: [] });
  const outcome = await runStepLoop(session, recordingHooks(session.log));
  assert.deepStrictEqual(outcome, { kind: 'idle' });
  assert.deepStrictEqual(session.log, []);
});

void test('runStepLoop: never-arriving session stops at the iteration cap with iterationLimit', async () => {
  const session = fakeSession([0]);
  const outcome = await runStepLoop(session, recordingHooks(session.log));
  assert.deepStrictEqual(outcome, { kind: 'iterationLimit' });
  assert.strictEqual(session.log.filter((e) => e === 'step').length, MAX_STEP_ITERATIONS);
});

void test('runStepLoop: evicts old frames after every 10th running step', async () => {
  const statuses = [...Array<number>(25).fill(0), 1];
  const session = fakeSession(statuses);
  await runStepLoop(session, recordingHooks(session.log));
  const steps = session.log.filter((e) => e === 'step' || e === 'evict');
  assert.strictEqual(steps.filter((e) => e === 'evict').length, 2);
  // Eviction follows the 10th and 20th step
  assert.strictEqual(steps.indexOf('evict'), 10);
  assert.strictEqual(steps.lastIndexOf('evict'), 21);
});

// ── bracketingSteps ───────────────────────────────────────────────────────────

const HOUR = 3_600_000;
const STEPS = [0, 3 * HOUR, 6 * HOUR, 9 * HOUR];

void test('bracketingSteps: no forecast steps → nothing to push', () => {
  assert.deepStrictEqual(bracketingSteps([], 0, HOUR), []);
});

void test('bracketingSteps: range inside one interval → both surrounding steps', () => {
  assert.deepStrictEqual(bracketingSteps(STEPS, 4 * HOUR, 5 * HOUR), [3 * HOUR, 6 * HOUR]);
});

void test('bracketingSteps: timeLo exactly on a step → that step is the lower bracket', () => {
  assert.deepStrictEqual(bracketingSteps(STEPS, 3 * HOUR, 4 * HOUR), [3 * HOUR, 6 * HOUR]);
});

void test('bracketingSteps: timeHi exactly on a step → includes the next step as upper bracket', () => {
  assert.deepStrictEqual(bracketingSteps(STEPS, 4 * HOUR, 6 * HOUR), [3 * HOUR, 6 * HOUR, 9 * HOUR]);
});

void test('bracketingSteps: range spanning several intervals → every step in between', () => {
  assert.deepStrictEqual(bracketingSteps(STEPS, HOUR, 8 * HOUR), STEPS);
});

void test('bracketingSteps: timeLo before first step → starts at the first step', () => {
  assert.deepStrictEqual(bracketingSteps(STEPS, -HOUR, HOUR), [0, 3 * HOUR]);
});

void test('bracketingSteps: timeHi beyond last step → ends at the last step', () => {
  assert.deepStrictEqual(bracketingSteps(STEPS, 7 * HOUR, 20 * HOUR), [6 * HOUR, 9 * HOUR]);
  assert.deepStrictEqual(bracketingSteps(STEPS, 10 * HOUR, 20 * HOUR), [9 * HOUR]);
});

void test('bracketingSteps: any in-domain range is bracketed on both sides', () => {
  const steps = [0, 1, 3, 6, 10, 15, 21].map((h) => h * HOUR);
  for (let lo = 0; lo < 21 * HOUR; lo += HOUR / 2) {
    for (let hi = lo; hi < 21 * HOUR; hi += HOUR) {
      const got = bracketingSteps(steps, lo, hi);
      const first = got[0] ?? Number.NaN;
      const last = got[got.length - 1] ?? Number.NaN;
      assert.ok(first <= lo, `lower bracket ${String(first)} > timeLo ${String(lo)}`);
      assert.ok(last > hi, `upper bracket ${String(last)} ≤ timeHi ${String(hi)}`);
      assert.deepStrictEqual(
        got,
        steps.filter((t) => t >= first && t <= last),
        'contiguous run of steps',
      );
    }
  }
});

// ── corridorGridSpec ──────────────────────────────────────────────────────────

void test('corridorGridSpec: step matches tile pixel spacing at the zoom level', () => {
  const bbox = { latMin: 54, latMax: 58, lonMin: 8, lonMax: 12 };
  assert.strictEqual(corridorGridSpec(bbox, 2).latStep, 0.3516); // 360 / (4 * 256)
  assert.strictEqual(corridorGridSpec(bbox, 4).latStep, 0.0879); // 360 / (16 * 256)
  assert.strictEqual(corridorGridSpec(bbox, 4).lonStep, 0.0879);
});

void test('corridorGridSpec: grid covers the bbox edges with less than one step of overshoot', () => {
  const EPS = 1e-9;
  const bboxes = [
    { latMin: 54.31, latMax: 59.07, lonMin: 5.23, lonMax: 12.71 },
    { latMin: -12.05, latMax: -3.4, lonMin: -71.9, lonMax: -60.02 },
    { latMin: 0, latMax: 1, lonMin: 0, lonMax: 1 },
  ];
  for (const bbox of bboxes) {
    for (const zoom of [2, 3, 4]) {
      const g = corridorGridSpec(bbox, zoom);
      const latMax = g.latMin + (g.nLat - 1) * g.latStep;
      const lonMax = g.lonMin + (g.nLon - 1) * g.lonStep;
      assert.ok(g.latMin <= bbox.latMin + EPS && bbox.latMin - g.latMin < g.latStep);
      assert.ok(g.lonMin <= bbox.lonMin + EPS && bbox.lonMin - g.lonMin < g.lonStep);
      assert.ok(latMax >= bbox.latMax - EPS && latMax - bbox.latMax < g.latStep);
      assert.ok(lonMax >= bbox.lonMax - EPS && lonMax - bbox.lonMax < g.lonStep);
    }
  }
});

// ── frontierNearGridEdge ──────────────────────────────────────────────────────

// Grid spanning lat 50..60, lon 0..10
const GRID: CorridorGridSpec = { latMin: 50, lonMin: 0, latStep: 1, lonStep: 1, nLat: 11, nLon: 11 };

void test('frontierNearGridEdge: empty frontier or all points inside the margin → no expansion', () => {
  assert.strictEqual(frontierNearGridEdge([], [], GRID, 1), false);
  assert.strictEqual(frontierNearGridEdge([55, 51, 59], [5, 1, 9], GRID, 1), false);
});

void test('frontierNearGridEdge: any point within the margin of any edge → expansion', () => {
  const near: [number, number][] = [
    [50.9, 5],
    [59.1, 5],
    [55, 0.9],
    [55, 9.1],
  ];
  for (const [lat, lon] of near) {
    assert.strictEqual(frontierNearGridEdge([55, lat], [5, lon], GRID, 1), true, `(${String(lat)}, ${String(lon)})`);
  }
});

// ── decodeRoute ───────────────────────────────────────────────────────────────

void test('decodeRoute: unpacks [n, (lat, lon, t, ctw, twa, speed, legMs) * n] in field order', () => {
  const flat = new Float64Array([2, 57.7, 11.9, 1_000, 270, -45, 6.5, 12, 57.8, 11.5, 4_600_000, 300, 120, 7.25, 3]);
  assert.strictEqual(flat.length, 1 + 2 * ROUTE_STRIDE);
  assert.deepStrictEqual(decodeRoute(flat), [
    { lat: 57.7, lon: 11.9, timeMs: 1_000, ctw: 270, twa: -45, boatSpeed: 6.5, legCalcMs: 12 },
    { lat: 57.8, lon: 11.5, timeMs: 4_600_000, ctw: 300, twa: 120, boatSpeed: 7.25, legCalcMs: 3 },
  ]);
});

void test('decodeRoute: zero boat speed (start point / waiting) → boatSpeed undefined', () => {
  const flat = new Float64Array([1, 57.7, 11.9, 0, 0, 0, 0, 0]);
  const [pt] = decodeRoute(flat);
  assert.strictEqual(pt?.boatSpeed, undefined);
});

void test('decodeRoute: empty route → no points', () => {
  assert.deepStrictEqual(decodeRoute(new Float64Array([0])), []);
});
