// Route rendering — draws the route polyline on the map.

import type * as maplibregl from 'maplibre-gl';
import type { WaypointMeta, RouteData } from './types';

interface FmtResult {
  num: string;
  sym: string;
}

interface RouteDisplayCtx {
  map: maplibregl.Map;
  fmt: (value: number, category: 'speed' | 'depth', forceMs?: boolean) => FmtResult;
  windSpeedMs: boolean;
  getWaypointLabels: () => { labels: boolean; intervalH: number };
  setStatus: (type: string, msg: string) => void;
}

interface RouteDisplayResult {
  routeLayer: { sourceId: string; layerId: string };
  windBarbLayer: maplibregl.Marker[];
  legLabelLayer: { sourceId: string; layerId: string } | null;
  windBarbMarkers: (maplibregl.Marker | null)[];
  routeLegCoords: [number, number][][];
  meta: WaypointMeta[];
}

const ROUTE_SOURCE = 'calculated-route';
const ROUTE_LAYER = 'calculated-route-line';

export function drawRoute(route: RouteData, ctx: RouteDisplayCtx): RouteDisplayResult | null {
  const coords = route.feature.geometry.coordinates;

  // ── Route polyline ──────────────────────────────────────────────────────────
  ctx.map.addSource(ROUTE_SOURCE, {
    type: 'geojson',
    data: {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        coordinates: coords.map(([lng, lat]: number[]) => [lng!, lat!]),
      },
    },
  });
  ctx.map.addLayer({
    id: ROUTE_LAYER,
    type: 'line',
    source: ROUTE_SOURCE,
    paint: { 'line-color': '#e64553', 'line-width': 3, 'line-opacity': 0.9 },
  });
  const routeLayer = { sourceId: ROUTE_SOURCE, layerId: ROUTE_LAYER };

  const meta = route.feature.properties.coordinatesMeta;

  // ── Leg coordinates for highlighting ────────────────────────────────────────
  const routeLegCoords: [number, number][][] = [];
  for (let i = 0; i < coords.length - 1; i++) {
    routeLegCoords.push([
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      [coords[i]![1]!, coords[i]![0]!],
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      [coords[i + 1]![1]!, coords[i + 1]![0]!],
    ]);
  }
  return {
    routeLayer,
    windBarbLayer: [],
    legLabelLayer: null,
    windBarbMarkers: [],
    routeLegCoords,
    meta,
  };
}
