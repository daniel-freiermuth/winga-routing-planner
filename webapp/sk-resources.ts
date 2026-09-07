// SignalK resource loading: departure points, waypoint routes, vessel position.

import type maplibregl from 'maplibre-gl';
import { skState } from './sk-state.svelte';

/** External dependencies injected from app.ts. */
export interface SkDeps {
  skFetch: (path: string, options?: RequestInit) => Promise<Response>;
  skWebSocketUrl: (path: string) => string;
  map: maplibregl.Map;
  startMarker: maplibregl.Marker;
  endMarker: maplibregl.Marker;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ── Departure resources ──────────────────────────────────────────────────────

export async function loadDepartureResources(deps: SkDeps): Promise<void> {
  const entries: { label: string; lat: number; lon: number }[] = [];
  try {
    const r = await deps.skFetch('/signalk/v2/api/resources/waypoints');
    if (r.ok) {
      const data: unknown = await r.json();
      if (!isRecord(data)) return;
      for (const [, wp] of Object.entries(data)) {
        if (!isRecord(wp)) continue;
        const feature = wp['feature'];
        if (!isRecord(feature)) continue;
        const geometry = feature['geometry'];
        if (!isRecord(geometry)) continue;
        const coords = geometry['coordinates'];
        if (!Array.isArray(coords) || coords.length < 2) continue;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- narrowed by typeof checks below
        const [lon, lat] = coords;
        if (typeof lat !== 'number' || typeof lon !== 'number') continue;
        const nameVal = wp['name'];
        entries.push({ label: typeof nameVal === 'string' ? nameVal : 'Unnamed waypoint', lat, lon });
      }
    }
  } catch {
    /* offline */
  }
  skState.departureResources = entries;
}

export async function loadWaypointRoutes(deps: SkDeps): Promise<void> {
  try {
    const r = await deps.skFetch('/signalk/v2/api/resources/routes');
    if (!r.ok) return;
    const data: unknown = await r.json();
    if (!isRecord(data)) return;
    const routes: { label: string; coords: number[][] }[] = [];
    for (const [, v] of Object.entries(data)) {
      if (!isRecord(v)) continue;
      const feature = v['feature'];
      if (!isRecord(feature)) continue;
      const geometry = feature['geometry'];
      if (!isRecord(geometry)) continue;
      const coords = geometry['coordinates'];
      if (!Array.isArray(coords) || coords.length < 2) continue;
      const nameVal = v['name'];
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- coords validated by Array.isArray + length check
      routes.push({ label: typeof nameVal === 'string' ? nameVal : 'Unnamed', coords });
    }
    skState.waypointRoutes = routes;
  } catch {
    /* offline */
  }
}

// ── Vessel position stream ───────────────────────────────────────────────────

export function connectVesselPositionStream(deps: SkDeps): void {
  const ws = new WebSocket(deps.skWebSocketUrl('/signalk/v1/stream?subscribe=none'));
  skState.vesselPositionWs = ws;
  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        context: 'vessels.self',
        subscribe: [{ path: 'navigation.position', period: 1000 }],
      }),
    );
  };
  ws.onmessage = (e) => {
    try {
      const rawData: unknown = e.data;
      if (typeof rawData !== 'string') return;
      const delta: unknown = JSON.parse(rawData);
      if (!isRecord(delta)) return;
      const updates = delta['updates'];
      if (!Array.isArray(updates)) return;
      for (const update of updates) {
        if (!isRecord(update)) continue;
        const values = update['values'];
        if (!Array.isArray(values)) continue;
        for (const v of values) {
          if (!isRecord(v)) continue;
          if (v['path'] === 'navigation.position' && isRecord(v['value'])) {
            const val = v['value'];
            const latitude = val['latitude'];
            const longitude = val['longitude'];
            if (typeof latitude === 'number' && typeof longitude === 'number') {
              skState.vesselPosition = { lat: latitude, lon: longitude };
            }
          }
        }
      }
    } catch {
      /* ignore parse errors */
    }
  };
  ws.onclose = () => {
    skState.vesselPosition = null;
    skState.vesselPositionWs = null;
    setTimeout(() => {
      connectVesselPositionStream(deps);
    }, 5000);
  };
}
