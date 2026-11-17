// Unit tests for the routing-worker message boundary: valid messages pass typed, contract mismatches name the field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkerInMessage } from '../worker-protocol';
import type { WorkerInMessage } from '../../src/types';

function validMessage(): WorkerInMessage {
  return {
    type: 'calculate',
    payload: {
      request: {
        start: { lat: 57.7, lon: 11.9 },
        end: { lat: 55.6, lon: 12.6 },
        departureTime: '2026-01-01T00:00:00.000Z',
        waypoints: [{ lat: 56.5, lon: 12.2 }],
        options: {
          maxWindKn: 0,
          maxWaveM: 0,
          motorSpeedKn: 0,
          motorBelowKn: 0,
          waitForWind: false,
          tackPenaltySec: 30,
          tackThresholdDeg: 60,
        },
      },
      polarCsv: 'twa/tws;6\n90;5',
      tileBbox: { latMin: 52, latMax: 61, lonMin: 8, lonMax: 16 },
      landIndexUrl: 'http://localhost/data/edge-index.bin.gz',
      windModel: 'ecmwf',
    },
  };
}

void test('parseWorkerInMessage: a contract-conforming message comes back unchanged', () => {
  assert.deepEqual(parseWorkerInMessage(validMessage()), validMessage());
});

void test('parseWorkerInMessage: missing request.start is rejected naming the field', () => {
  const raw = validMessage();
  const request = { ...raw.payload.request, start: undefined };
  assert.throws(() => parseWorkerInMessage({ ...raw, payload: { ...raw.payload, request } }), {
    message: 'Invalid calculate message: payload.request.start must be an object',
  });
});

void test('parseWorkerInMessage: a bad waypoint coordinate is rejected with its index', () => {
  const raw = validMessage();
  const request = {
    ...raw.payload.request,
    waypoints: [
      { lat: 56.5, lon: 12.2 },
      { lat: Number.NaN, lon: 12 },
    ],
  };
  assert.throws(() => parseWorkerInMessage({ ...raw, payload: { ...raw.payload, request } }), {
    message: 'Invalid calculate message: payload.request.waypoints[1].lat must be a finite number',
  });
});

void test('parseWorkerInMessage: an unparseable departure time is rejected', () => {
  const raw = validMessage();
  const request = { ...raw.payload.request, departureTime: 'tomorrow' };
  assert.throws(() => parseWorkerInMessage({ ...raw, payload: { ...raw.payload, request } }), {
    message: 'Invalid calculate message: payload.request.departureTime must be an ISO 8601 timestamp',
  });
});

void test('parseWorkerInMessage: an unknown wind model is rejected', () => {
  const raw = validMessage();
  assert.throws(() => parseWorkerInMessage({ ...raw, payload: { ...raw.payload, windModel: 'cmems' } }), {
    message: "Invalid calculate message: payload.windModel must be 'ecmwf', 'gfs' or 'icon'",
  });
});

void test('parseWorkerInMessage: a message of another type is rejected', () => {
  assert.throws(() => parseWorkerInMessage({ type: 'cancel' }), {
    message: "Invalid calculate message: message.type must be 'calculate'",
  });
});
