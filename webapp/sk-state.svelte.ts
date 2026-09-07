// Shared reactive state for the SK resources module.
// Both App.svelte and sk-resources.ts import from here.

import type maplibregl from 'maplibre-gl';

interface LatLon {
  lat: number;
  lon: number;
}

export const skState = $state({
  departureResources: [] as { label: string; lat: number; lon: number }[],
  waypointRoutes: [] as { label: string; coords: number[][] }[],
  routeWaypoints: [] as LatLon[],
  routeWaypointMarkers: [] as maplibregl.Marker[],
  startLatLon: null as LatLon | null,
  endLatLon: null as LatLon | null,
  vesselPosition: null as LatLon | null,
  vesselPositionWs: null as WebSocket | null,
});
