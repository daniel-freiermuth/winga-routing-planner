// Routing-worker glue to the WASM RouterSession: step-loop status handling, forecast-frame bracketing, corridor grid spec, flat route decoding.

import type { BoundingBox } from '../types';

/** Hard cap on session.step() calls per calculation. */
export const MAX_STEP_ITERATIONS = 500;

/** Evict expired weather frames from the session every this many steps. */
const EVICT_INTERVAL_STEPS = 10;

// RouterSession.step() return codes (wasm-router/src/lib.rs)
const STEP_ARRIVED = 1;
const STEP_NO_PROGRESS = 2;
const STEP_FORECAST_EXHAUSTED = 3;

/** Number of f64 fields per point in RouterSession.route(): lat, lon, timeMs, ctw, twa, boatSpeed, legCalcMs. */
export const ROUTE_STRIDE = 7;

/** Subset of the WASM RouterSession used by the step loop. */
export interface StepSession {
  needs(): Float64Array;
  step(): number;
  error(): string | undefined;
  evict_old_frames(): void;
}

export interface StepLoopHooks {
  /** Load and push weather frames so the session can interpolate within [timeLo, timeHi]. */
  beforeStep(iteration: number, timeLo: number, timeHi: number): Promise<void>;
  /** Runs after a step that did not terminate the loop (e.g. corridor expansion). */
  afterStep(): Promise<void>;
}

export type StepLoopOutcome =
  | { kind: 'idle' } // needs() returned an empty bracket
  | { kind: 'arrived' }
  | { kind: 'noProgress' } // step() returned no-progress without an error message
  | { kind: 'error'; message: string }
  | { kind: 'exhausted' }
  | { kind: 'iterationLimit' };

/** Drive the session until it arrives, stops, fails, or hits MAX_STEP_ITERATIONS. */
export async function runStepLoop(session: StepSession, hooks: StepLoopHooks): Promise<StepLoopOutcome> {
  for (let iteration = 0; iteration < MAX_STEP_ITERATIONS; iteration++) {
    const bracket = session.needs();
    if (bracket.length === 0) return { kind: 'idle' };

    /* eslint-disable @typescript-eslint/no-non-null-assertion -- needs() returns [timeLo, timeHi] when non-empty */
    const timeLo = bracket[0]!;
    const timeHi = bracket[1]!;
    /* eslint-enable @typescript-eslint/no-non-null-assertion */

    await hooks.beforeStep(iteration, timeLo, timeHi);

    const stepStatus = session.step();
    if (stepStatus === STEP_ARRIVED) return { kind: 'arrived' };
    if (stepStatus === STEP_NO_PROGRESS) {
      const err = session.error();
      return err !== undefined && err !== '' ? { kind: 'error', message: err } : { kind: 'noProgress' };
    }
    if (stepStatus === STEP_FORECAST_EXHAUSTED) return { kind: 'exhausted' };

    await hooks.afterStep();

    if (iteration % EVICT_INTERVAL_STEPS === EVICT_INTERVAL_STEPS - 1) {
      session.evict_old_frames();
    }
  }
  return { kind: 'iterationLimit' };
}

/** Spatial grid metadata for the corridor (shared by wind/current/land sampling). */
export interface CorridorGridSpec {
  latMin: number;
  lonMin: number;
  latStep: number;
  lonStep: number;
  nLat: number;
  nLon: number;
}

/**
 * Build the corridor grid spec from the route bounding box.
 * Step size matches the tile pixel spacing at the given zoom level
 * so we don't alias away fine structure (e.g. Skagerrak eddies at z=4).
 */
export function corridorGridSpec(bbox: BoundingBox, zoom: number): CorridorGridSpec {
  // Tile pixel spacing: 360 / (2^z * 256) degrees
  const step = 360 / (Math.pow(2, zoom) * 256);
  // Round step to a clean fraction to avoid floating-point drift
  const cleanStep = Math.round(step * 10000) / 10000;
  const latMin = Math.floor(bbox.latMin / cleanStep) * cleanStep;
  const lonMin = Math.floor(bbox.lonMin / cleanStep) * cleanStep;
  const latMax = Math.ceil(bbox.latMax / cleanStep) * cleanStep;
  const lonMax = Math.ceil(bbox.lonMax / cleanStep) * cleanStep;
  const nLat = Math.round((latMax - latMin) / cleanStep) + 1;
  const nLon = Math.round((lonMax - lonMin) / cleanStep) + 1;
  return { latMin, lonMin, latStep: cleanStep, lonStep: cleanStep, nLat, nLon };
}

/** True if any frontier point lies within `margin` degrees of the grid edge. */
export function frontierNearGridEdge(lats: number[], lons: number[], spec: CorridorGridSpec, margin: number): boolean {
  const latMax = spec.latMin + (spec.nLat - 1) * spec.latStep;
  const lonMax = spec.lonMin + (spec.nLon - 1) * spec.lonStep;
  for (let i = 0; i < lats.length; i++) {
    /* eslint-disable @typescript-eslint/no-non-null-assertion -- i bounded by lats.length; lons is parallel */
    const lat = lats[i]!;
    const lon = lons[i]!;
    /* eslint-enable @typescript-eslint/no-non-null-assertion */
    if (lat < spec.latMin + margin || lat > latMax - margin || lon < spec.lonMin + margin || lon > lonMax - margin) {
      return true;
    }
  }
  return false;
}

/**
 * Find forecast step timestamps needed to interpolate within [timeLo, timeHi].
 * Returns the lower bracket step (last step ≤ timeLo) plus all steps up to
 * the first step > timeHi.
 */
export function bracketingSteps(timesMs: number[], timeLo: number, timeHi: number): number[] {
  if (timesMs.length === 0) return [];
  const result: number[] = [];

  // Binary search for the lower bracket
  let lo = 0;
  let hi = timesMs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((timesMs[mid] ?? 0) <= timeLo) lo = mid;
    else hi = mid - 1;
  }

  // Include from the lower bracket through the upper bracket of timeHi
  for (let i = lo; i < timesMs.length; i++) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- i bounded by timesMs.length
    result.push(timesMs[i]!);
    if ((timesMs[i] ?? 0) > timeHi) break;
  }

  return result;
}

/** One route point as computed by WASM, before weather enrichment. */
export interface DecodedRoutePoint {
  lat: number;
  lon: number;
  timeMs: number;
  ctw: number;
  twa: number;
  boatSpeed: number | undefined;
  legCalcMs: number;
}

/** Decode RouterSession.route(): [n, (lat, lon, timeMs, ctw, twa, boatSpeed, legCalcMs) * n]. */
export function decodeRoute(flat: Float64Array): DecodedRoutePoint[] {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- route header element
  const n = flat[0]!;
  const points: DecodedRoutePoint[] = [];
  for (let i = 0; i < n; i++) {
    const base = 1 + i * ROUTE_STRIDE;
    /* eslint-disable @typescript-eslint/no-non-null-assertion -- structured WASM route array, indices valid by layout */
    const boatSpeed = flat[base + 5]!;
    points.push({
      lat: flat[base]!,
      lon: flat[base + 1]!,
      timeMs: flat[base + 2]!,
      ctw: flat[base + 3]!,
      twa: flat[base + 4]!,
      boatSpeed: boatSpeed > 0 ? boatSpeed : undefined,
      legCalcMs: flat[base + 6]!,
    });
    /* eslint-enable @typescript-eslint/no-non-null-assertion */
  }
  return points;
}
