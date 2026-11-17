// Routing-worker message boundary: validates raw postMessage data and rebuilds it as a typed WorkerInMessage.

import type {
  BoundingBox,
  CalculatePayload,
  CalculationRequest,
  LatLon,
  RoutingPreferences,
  WindModel,
  WorkerInMessage,
} from '../src/types';

type Fields = Record<string, unknown>;

function fail(path: string, expected: string): never {
  throw new Error(`Invalid calculate message: ${path} must be ${expected}`);
}

function isFields(v: unknown): v is Fields {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function record(v: unknown, path: string): Fields {
  return isFields(v) ? v : fail(path, 'an object');
}

function finite(v: unknown, path: string): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fail(path, 'a finite number');
}

function text(v: unknown, path: string): string {
  return typeof v === 'string' ? v : fail(path, 'a string');
}

function isWindModel(v: unknown): v is WindModel {
  return v === 'ecmwf' || v === 'gfs' || v === 'icon';
}

function latLon(v: unknown, path: string): LatLon {
  const o = record(v, path);
  return { lat: finite(o['lat'], `${path}.lat`), lon: finite(o['lon'], `${path}.lon`) };
}

function timestamp(v: unknown, path: string): string {
  const s = text(v, path);
  return Number.isNaN(Date.parse(s)) ? fail(path, 'an ISO 8601 timestamp') : s;
}

function preferences(v: unknown, path: string): RoutingPreferences {
  const o = record(v, path);
  const waitForWind = o['waitForWind'];
  return {
    maxWindKn: finite(o['maxWindKn'], `${path}.maxWindKn`),
    maxWaveM: finite(o['maxWaveM'], `${path}.maxWaveM`),
    motorSpeedKn: finite(o['motorSpeedKn'], `${path}.motorSpeedKn`),
    motorBelowKn: finite(o['motorBelowKn'], `${path}.motorBelowKn`),
    waitForWind: typeof waitForWind === 'boolean' ? waitForWind : fail(`${path}.waitForWind`, 'a boolean'),
    tackPenaltySec: finite(o['tackPenaltySec'], `${path}.tackPenaltySec`),
    tackThresholdDeg: finite(o['tackThresholdDeg'], `${path}.tackThresholdDeg`),
  };
}

function request(v: unknown, path: string): CalculationRequest {
  const o = record(v, path);
  const start = latLon(o['start'], `${path}.start`);
  const end = latLon(o['end'], `${path}.end`);
  const departureTime = timestamp(o['departureTime'], `${path}.departureTime`);
  const rawWaypoints = o['waypoints'];
  let waypoints: LatLon[] | undefined;
  if (rawWaypoints !== undefined) {
    if (!Array.isArray(rawWaypoints)) fail(`${path}.waypoints`, 'an array');
    waypoints = rawWaypoints.map((wp, i) => latLon(wp, `${path}.waypoints[${String(i)}]`));
  }
  const options = preferences(o['options'], `${path}.options`);
  return { start, end, departureTime, ...(waypoints ? { waypoints } : {}), options };
}

function bbox(v: unknown, path: string): BoundingBox {
  const o = record(v, path);
  return {
    latMin: finite(o['latMin'], `${path}.latMin`),
    latMax: finite(o['latMax'], `${path}.latMax`),
    lonMin: finite(o['lonMin'], `${path}.lonMin`),
    lonMax: finite(o['lonMax'], `${path}.lonMax`),
  };
}

function payload(v: unknown, path: string): CalculatePayload {
  const o = record(v, path);
  const windModel = o['windModel'];
  return {
    request: request(o['request'], `${path}.request`),
    polarCsv: text(o['polarCsv'], `${path}.polarCsv`),
    tileBbox: bbox(o['tileBbox'], `${path}.tileBbox`),
    landIndexUrl: text(o['landIndexUrl'], `${path}.landIndexUrl`),
    windModel: isWindModel(windModel) ? windModel : fail(`${path}.windModel`, "'ecmwf', 'gfs' or 'icon'"),
  };
}

/** Validate raw worker message data; throws naming the first field that does not match the contract. */
export function parseWorkerInMessage(data: unknown): WorkerInMessage {
  const o = record(data, 'message');
  if (o['type'] !== 'calculate') fail('message.type', "'calculate'");
  return { type: 'calculate', payload: payload(o['payload'], 'payload') };
}
