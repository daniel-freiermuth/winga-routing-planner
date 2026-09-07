// Routing engine — dispatches calculation to the Web Worker and processes results.

import type maplibregl from 'maplibre-gl';
import { sortByBearing, splitByAngularGap } from './utils';

export interface IsochroneState {
  sourceIds: string[];
  layerIds: string[];
  count: number;
  map: maplibregl.Map;
}

interface RoutingRequest {
  start: { lat: number; lon: number };
  end: { lat: number; lon: number };
  departureTime: string;
  waypoints?: { lat: number; lon: number }[] | undefined;
  polarCsv: string;
  useLandAvoidance: boolean;
  useSafetyMargin: boolean;
  options: {
    motorBelowKn?: number | undefined;
    motorSpeedKn?: number | undefined;
    waitForWind?: boolean | undefined;
    maxWindKn?: number | undefined;
    maxWaveM?: number | undefined;
    tackPenaltySec?: number | undefined;
    tackThresholdDeg?: number | undefined;
  };
}

const ISOCHRONE_GAP_THRESHOLD_DEG = 10;
const ISOCHRONE_COLOURS = ['#000000', '#4477ff', '#8833cc', '#cc3333'];

/**
 * Remove all tracked isochrone sources and layers from the map.
 */
export function clearIsochrones(state: IsochroneState): void {
  for (const layerId of state.layerIds) {
    if (state.map.getLayer(layerId)) state.map.removeLayer(layerId);
  }
  for (const sourceId of state.sourceIds) {
    if (state.map.getSource(sourceId)) state.map.removeSource(sourceId);
  }
  state.layerIds = [];
  state.sourceIds = [];
  state.count = 0;
}

/**
 * Render isochrone frontier segments on the map.
 */
export function renderIsochrone(
  frontier: number[][],
  origin: { lat: number; lon: number },
  isochroneState: IsochroneState,
): void {
  const pts = sortByBearing(
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    frontier.map((pt) => [pt[0]!, pt[1]!]),
    origin,
  );
  const segments = splitByAngularGap(pts, origin, ISOCHRONE_GAP_THRESHOLD_DEG);
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const color = ISOCHRONE_COLOURS[isochroneState.count % ISOCHRONE_COLOURS.length]!;
  const isoIdx = isochroneState.count;
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const seg = segments[segIdx]!;
    if (seg.length >= 2) {
      const sourceId = `isochrone-${String(isoIdx)}-${String(segIdx)}`;
      const layerId = `isochrone-${String(isoIdx)}-${String(segIdx)}-line`;
      isochroneState.map.addSource(sourceId, {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'LineString',
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            coordinates: seg.map(([lat, lon]) => [lon!, lat!]),
          },
        },
      });
      isochroneState.map.addLayer({
        id: layerId,
        type: 'line',
        source: sourceId,
        paint: { 'line-color': color, 'line-width': 1, 'line-opacity': 0.5 },
      });
      isochroneState.sourceIds.push(sourceId);
      isochroneState.layerIds.push(layerId);
    }
  }
  isochroneState.count++;
}

/**
 * Build the worker message payload for a routing calculation.
 */
export function buildWorkerPayload(req: RoutingRequest): unknown {
  const allCoords = [req.start, ...(req.waypoints ?? []), req.end];
  const lats = allCoords.map((c) => c.lat);
  const lons = allCoords.map((c) => c.lon);
  const latMin = Math.min(...lats);
  const latMax = Math.max(...lats);
  const lonMin = Math.min(...lons);
  const lonMax = Math.max(...lons);
  const margin = Math.max(3, (latMax - latMin) * 0.3, (lonMax - lonMin) * 0.3);

  return {
    type: 'calculate',
    payload: {
      request: {
        start: req.start,
        end: req.end,
        departureTime: req.departureTime,
        ...(req.waypoints && req.waypoints.length > 0 ? { waypoints: req.waypoints } : {}),
        useLandAvoidance: req.useLandAvoidance,
        options: req.options,
      },
      polarCsv: req.polarCsv,
      tileBbox: {
        latMin: latMin - margin,
        latMax: latMax + margin,
        lonMin: lonMin - margin,
        lonMax: lonMax + margin,
      },
      landIndexUrl: new URL(`${import.meta.env.BASE_URL}data/edge-index.bin.gz`, location.href).href,
      dilatedIndexUrl: req.useSafetyMargin
        ? new URL(`${import.meta.env.BASE_URL}data/dilated-edge-index.bin.gz`, location.href).href
        : undefined,
      windModel: 'ecmwf',
      useSafetyMargin: req.useSafetyMargin,
    },
  };
}
