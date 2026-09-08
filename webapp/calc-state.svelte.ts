// Shared reactive state for the calculation module.
// Both App.svelte and calculation.ts import from here — no getter/setter bridges needed.
//
// RESET CONTRACT: resetCalcState(map) is the ONE way to tear down route results.
// It removes map objects, then resets all data. Adding a field? Add it to
// CalcState + freshCalcState(). If it's a map resource, add cleanup in resetCalcState().

import type { WaypointMeta, GraphLayout, RouteData } from './types';
import type * as maplibregl from 'maplibre-gl';

interface SourceAndLayer {
  sourceId: string;
  layerId: string;
}

interface CalcState {
  routeScrubberRange: { i0: number; iN: number } | null;
  scrubberLockedToRoute: boolean;
  routeLayer: SourceAndLayer | null;
  windBarbLayer: maplibregl.Marker[];
  legLabelLayer: SourceAndLayer | null;
  highlightLegLayer: SourceAndLayer | null;
  highlightMarker: maplibregl.Marker | null;
  windBarbMarkers: (maplibregl.Marker | null)[];
  routeLegCoords: [number, number][][];
  prevHighlightWpIdx: number;
  graphMeta: WaypointMeta[] | null;
  graphLayout: GraphLayout | null;
  calcStream: { close(): void } | null;
  pendingRouteData: RouteData | null;
}

function freshCalcState(): CalcState {
  return {
    routeScrubberRange: null,
    scrubberLockedToRoute: false,
    routeLayer: null,
    windBarbLayer: [],
    legLabelLayer: null,
    highlightLegLayer: null,
    highlightMarker: null,
    windBarbMarkers: [],
    routeLegCoords: [],
    prevHighlightWpIdx: -1,
    graphMeta: null,
    graphLayout: null,
    calcStream: null,
    pendingRouteData: null,
  };
}

export const calcState: CalcState = $state(freshCalcState());

export function removeSourceAndLayer(map: maplibregl.Map, ids: SourceAndLayer): void {
  if (map.getLayer(ids.layerId)) map.removeLayer(ids.layerId);
  if (map.getSource(ids.sourceId)) map.removeSource(ids.sourceId);
}

/**
 * Tear down all route results: remove map objects, then reset data.
 * This is the ONLY way to clear route state — ensures nothing leaks.
 */
export function resetCalcState(map?: maplibregl.Map): void {
  if (map) {
    if (calcState.routeLayer) removeSourceAndLayer(map, calcState.routeLayer);
    for (const m of calcState.windBarbLayer) m.remove();
    if (calcState.legLabelLayer) removeSourceAndLayer(map, calcState.legLabelLayer);
    if (calcState.highlightLegLayer) removeSourceAndLayer(map, calcState.highlightLegLayer);
    if (calcState.highlightMarker) calcState.highlightMarker.remove();
  }
  Object.assign(calcState, freshCalcState());
}
