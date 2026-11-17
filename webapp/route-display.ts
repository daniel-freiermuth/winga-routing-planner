// Route rendering — draws the route polyline on the map.

import type * as maplibregl from 'maplibre-gl';
import type { WaypointMeta, RouteData } from './types';

interface RouteDisplayResult {
  routeLayer: { sourceId: string; layerId: string };
  routeLegCoords: [number, number][][];
  meta: WaypointMeta[];
}

const ROUTE_SOURCE = 'calculated-route';
const ROUTE_LAYER = 'calculated-route-line';

export function drawRoute(route: RouteData, map: maplibregl.Map): RouteDisplayResult | null {
  const coords = route.feature.geometry.coordinates;

  // ── Route polyline ──────────────────────────────────────────────────────────
  map.addSource(ROUTE_SOURCE, {
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
  map.addLayer({
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
  return { routeLayer, routeLegCoords, meta };
}
