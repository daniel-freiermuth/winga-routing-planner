// Calculation orchestration — wires the routing worker, draws results,
// and manages scrubber highlighting for the calculated route.

import maplibregl from 'maplibre-gl';
import { calcState, removeSourceAndLayer } from './calc-state.svelte';
import type { WaypointMeta, GraphLayout, RouteData, GribFileMeta } from './types';
import type { ScrubberState } from './scrubber-controller';
import { fmt as _fmt, toDisplay as _toDisplay } from './units';
import { drawRoute } from './route-display';
import { buildConditionsGraph } from './conditions-graph';
import { buildWorkerPayload, renderIsochrone, clearIsochrones } from './routing-engine';
import { haversineNM, bearingTo, currentDirection } from '../src/lib/geo';
import type { IsochroneState } from './routing-engine';

interface LatLon {
  lat: number;
  lon: number;
}

const C64_PALETTE = [
  '#6c7086',
  '#ffffff',
  '#883932',
  '#67b6bd',
  '#8b3f96',
  '#55a049',
  '#40318d',
  '#bfce72',
  '#8b5429',
  '#574200',
];

interface RoutingOptionsLike {
  getOptions: () => {
    useLandAvoidance: boolean;
    useSafetyMargin: boolean;
    motorBelowKn: number | undefined;
    motorSpeedKn: number | undefined;
    waitForWind: boolean | undefined;
    maxWindKn: number | undefined;
    maxWaveM: number | undefined;
    tackPenaltySec: number;
    tackThresholdDeg: number;
    waypointLabels: boolean;
    waypointLabelInterval: number;
  };
}

/** All dependencies the calculation module needs from the app shell. */
interface CalculationContext {
  map: maplibregl.Map;
  routingWorker: Worker;
  isochroneState: IsochroneState;

  // Callbacks (replace DOM refs)
  setProgress(pct: number): void;
  setCalculating(v: boolean): void;
  setShowProgress(v: boolean): void;
  setStatus(type: string, msg: string): void;
  showFailurePopup(msg: string, isWarning: boolean): void;
  fetchWindPointsAt(timeIdx: number): Promise<void>;
  fetchWavePointsAt(timeIdx: number): Promise<void>;
  scrubberState(): ScrubberState;

  // Conditions graph callbacks (replace getElementById)
  setConditionsGraph(data: { svgContent: string; viewBox: string; hasWave: boolean; layout: GraphLayout } | null): void;
  lockScrubberToRoute(i0: number, iN: number): void;
  setRouteWaypointTimes(times: string[]): void;
  setShowRangeToggle(v: boolean): void;
  /** Called when the user clicks on the route polyline — jumps scrubber to nearest time. */
  onRouteClick(timeMs: number): void;

  // Getters for read-only state owned by App.svelte
  getStartLatLon(): LatLon | null;
  getEndLatLon(): LatLon | null;
  getRouteWaypoints(): LatLon[];
  getRoutingOptions(): RoutingOptionsLike | null;
  getWindSpeedMs(): boolean;
  getWindTimes(): string[];
  getWindTimesLoaded(): boolean;
  getDepartureTime(): string;
  getIsochroneEnabled(): boolean;
  getGribInfoFiles(): GribFileMeta[];
  getForecastSkillHorizonHours(): number;
  getPolarCsv(): string | undefined;
}

export interface CalculationApi {
  startCalculation(): Promise<void>;
  drawRouteFromData(route: RouteData): void;
  fetchAndDrawRoute(): void;
  updateScrubberHighlight(windTimeIdx: number): void;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function findScrubberPosition(graphMeta: WaypointMeta[] | null, tMs: number) {
  if (!graphMeta || graphMeta.length < 2) return { wpIdx: -1, legIdx: -1 };
  for (let i = 0; i < graphMeta.length - 1; i++) {
    const entry = graphMeta[i];
    const nextEntry = graphMeta[i + 1];
    if (entry === undefined || nextEntry === undefined) continue;
    const t1 = new Date(entry.time).getTime();
    const t2 = new Date(nextEntry.time).getTime();
    if (tMs >= t1 && tMs <= t2) return { wpIdx: i, legIdx: i };
  }
  return { wpIdx: -1, legIdx: -1 };
}

function drawConditionsGraph(ctx: CalculationContext, meta: WaypointMeta[], intermediateIdxs: number[] = []) {
  const result = buildConditionsGraph({
    meta,
    intermediateIdxs,
    windSpeedMs: ctx.getWindSpeedMs(),
    gribInfoFiles: ctx.getGribInfoFiles(),
    c64Palette: C64_PALETTE,
    forecastSkillHorizonHours: ctx.getForecastSkillHorizonHours(),
    toDisplay: _toDisplay,
    fmt: _fmt,
  });
  if (!result) return;
  calcState.graphMeta = meta;
  calcState.graphLayout = result.layout;
  ctx.setConditionsGraph({
    svgContent: result.svgContent,
    viewBox: result.viewBox,
    hasWave: result.hasWave,
    layout: result.layout,
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Wire the routing worker listener and return calculation functions
 * that close over the provided context.
 */
export function setupCalculation(ctx: CalculationContext): CalculationApi {
  const { map, routingWorker } = ctx;
  const isochroneState = ctx.isochroneState;

  function fetchAndDrawRoute() {
    if (calcState.pendingRouteData) drawRouteFromData(calcState.pendingRouteData);
  }

  function drawRouteFromData(route: RouteData) {
    try {
      if (calcState.routeLayer) removeSourceAndLayer(map, calcState.routeLayer);
      for (const m of calcState.windBarbLayer) m.remove();
      if (calcState.legLabelLayer) removeSourceAndLayer(map, calcState.legLabelLayer);
      if (calcState.highlightLegLayer) {
        removeSourceAndLayer(map, calcState.highlightLegLayer);
        calcState.highlightLegLayer = null;
      }
      calcState.windBarbMarkers = [];
      calcState.routeLegCoords = [];
      calcState.prevHighlightWpIdx = -1;
      const routingOptions = ctx.getRoutingOptions();
      const result = drawRoute(route, {
        map,
        fmt: _fmt,
        windSpeedMs: ctx.getWindSpeedMs(),
        getWaypointLabels: () => {
          const opts = routingOptions?.getOptions();
          return { labels: opts?.waypointLabels ?? true, intervalH: opts?.waypointLabelInterval ?? 0 };
        },
        routeWaypoints: ctx.getRouteWaypoints(),
        setStatus: (type: string, msg: string) => {
          ctx.setStatus(type, msg);
        },
      });
      if (!result) return;
      calcState.routeLayer = result.routeLayer;
      calcState.windBarbLayer = result.windBarbLayer;
      calcState.legLabelLayer = result.legLabelLayer;
      calcState.windBarbMarkers = result.windBarbMarkers;
      calcState.routeLegCoords = result.routeLegCoords;

      // Click on route → find closest waypoint and jump scrubber there
      map.on('click', 'calculated-route-line', (e: maplibregl.MapMouseEvent) => {
        if (!calcState.graphMeta || calcState.graphMeta.length === 0) return;
        const { lng, lat } = e.lngLat;
        // Find the closest waypoint (meta entry) to the click
        const coords = route.feature.geometry.coordinates;
        let bestIdx = 0,
          bestDist = Infinity;
        for (let i = 0; i < coords.length; i++) {
          const dx = (coords[i]?.[0] ?? 0) - lng;
          const dy = (coords[i]?.[1] ?? 0) - lat;
          const d = dx * dx + dy * dy;
          if (d < bestDist) {
            bestDist = d;
            bestIdx = i;
          }
        }
        const meta = calcState.graphMeta[bestIdx];
        if (meta) ctx.onRouteClick(new Date(meta.time).getTime());
      });
      map.on('mouseenter', 'calculated-route-line', () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'calculated-route-line', () => {
        map.getCanvas().style.cursor = '';
      });
      drawConditionsGraph(ctx, result.meta, result.intermediateIdxs);
      if (ctx.getWindTimesLoaded() && result.meta.length > 0) {
        // Inject route waypoint times into the scrubber time grid
        ctx.setRouteWaypointTimes(result.meta.map((m) => m.time));
        // Now find i0/iN in the updated windTimes (which now includes waypoint times)
        const updatedWindTimes = ctx.getWindTimes();
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const t0ms = new Date(result.meta[0]!.time).getTime();
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const tNms = new Date(result.meta[result.meta.length - 1]!.time).getTime();
        let i0 = updatedWindTimes.findIndex((t) => new Date(t).getTime() >= t0ms);
        let iN = updatedWindTimes.findIndex((t) => new Date(t).getTime() >= tNms);
        if (i0 < 0) i0 = 0;
        if (iN < 0) iN = updatedWindTimes.length - 1;
        ctx.lockScrubberToRoute(i0, iN);
        calcState.routeScrubberRange = { i0, iN };
        calcState.scrubberLockedToRoute = true;
        void ctx.fetchWindPointsAt(i0);
        void ctx.fetchWavePointsAt(i0);
      }
      // Fit map to route AFTER Svelte renders the conditions panel and the map
      // container resizes. Two rAF frames: first for Svelte DOM update, second
      // for MapLibre to process the container resize.
      const coords = route.feature.geometry.coordinates;
      if (coords.length > 0) {
        const lngs = coords.map((c: number[]) => c[0] ?? 0);
        const lats = coords.map((c: number[]) => c[1] ?? 0);
        const lngMin = Math.min(...lngs),
          lngMax = Math.max(...lngs);
        const latMin = Math.min(...lats),
          latMax = Math.max(...lats);
        const lngPad = (lngMax - lngMin) * 0.5 || 0.5;
        const latPad = (latMax - latMin) * 0.5 || 0.5;
        requestAnimationFrame(() => {
          map.resize();
          requestAnimationFrame(() => {
            map.fitBounds(
              [
                [lngMin - lngPad, latMin - latPad],
                [lngMax + lngPad, latMax + latPad],
              ],
              { padding: 20 },
            );
          });
        });
      }
    } catch (e) {
      ctx.setStatus('error', `Draw failed: ${String(e)}`);
    }
  }

  function updateScrubberHighlight(windTimeIdx: number) {
    // No-op when route isn't being displayed (e.g. user is back in planning mode)
    if (!calcState.pendingRouteData) return;
    if (!calcState.graphMeta || calcState.graphMeta.length < 2 || !calcState.graphLayout) return;
    const windTimes = ctx.getWindTimes();
    const t = windTimes[windTimeIdx];
    if (t === undefined || t === '') return;
    const tMs = new Date(t).getTime();
    const { wpIdx } = findScrubberPosition(calcState.graphMeta, tMs);
    if (wpIdx === calcState.prevHighlightWpIdx) return;
    calcState.prevHighlightWpIdx = wpIdx;

    // Update wind barb opacity
    for (let i = 0; i < calcState.windBarbMarkers.length; i++) {
      const m = calcState.windBarbMarkers[i];
      if (!m) continue;
      m.getElement().style.opacity = i === wpIdx ? '1' : '0.4';
    }

    // Place/move red circle marker at the selected waypoint
    if (wpIdx >= 0 && calcState.routeLegCoords[wpIdx]) {
      const wpCoord = calcState.routeLegCoords[wpIdx][0]; // [lat, lng]
      if (wpCoord) {
        const lngLat: [number, number] = [wpCoord[1], wpCoord[0]];
        if (!calcState.highlightMarker) {
          const el = document.createElement('div');
          el.style.width = '14px';
          el.style.height = '14px';
          el.style.borderRadius = '50%';
          el.style.border = '3px solid #e64553';
          el.style.backgroundColor = 'rgba(230, 69, 83, 0.25)';
          el.style.pointerEvents = 'none';
          calcState.highlightMarker = new maplibregl.Marker({ element: el, anchor: 'center' })
            .setLngLat(lngLat)
            .addTo(map);
        } else {
          calcState.highlightMarker.setLngLat(lngLat);
        }

        // Pan map to keep selected point in the middle 50% of the viewport
        const pt = map.project(lngLat);
        const { width, height } = map.getCanvas();
        const r = window.devicePixelRatio || 1;
        const w = width / r,
          h = height / r;
        const inCenter = pt.x > w * 0.25 && pt.x < w * 0.75 && pt.y > h * 0.25 && pt.y < h * 0.75;
        if (!inCenter) {
          map.easeTo({ center: lngLat, duration: 300 });
        }
      }
    } else if (calcState.highlightMarker) {
      calcState.highlightMarker.remove();
      calcState.highlightMarker = null;
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async function startCalculation() {
    const startLatLon = ctx.getStartLatLon();
    const endLatLon = ctx.getEndLatLon();
    if (!startLatLon || !endLatLon) return;

    const depTime = ctx.getDepartureTime();
    if (!depTime) {
      ctx.setStatus('error', 'Please set a departure time');
      return;
    }

    clearIsochrones(isochroneState);
    ctx.setShowProgress(true);
    ctx.setProgress(0);
    ctx.setCalculating(true);

    ctx.setStatus('', 'Starting calculation…');

    const polarCsv = ctx.getPolarCsv();
    if (polarCsv === undefined || polarCsv === '') {
      ctx.setStatus('error', 'No polar diagram loaded — upload a polar CSV file');
      ctx.setCalculating(false);
      return;
    }

    calcState.pendingRouteData = null;
    const opts = ctx.getRoutingOptions()?.getOptions();

    // Unwrap Svelte $state proxies — structured cloning (postMessage) can't handle Proxy objects
    const plainStart = { lat: startLatLon.lat, lon: startLatLon.lon };
    const plainEnd = { lat: endLatLon.lat, lon: endLatLon.lon };
    const plainWaypoints = ctx.getRouteWaypoints().map((wp) => ({ lat: wp.lat, lon: wp.lon }));

    routingWorker.postMessage(
      buildWorkerPayload({
        start: plainStart,
        end: plainEnd,
        departureTime: new Date(depTime).toISOString(),
        waypoints: plainWaypoints.length > 0 ? plainWaypoints : undefined,
        polarCsv,
        useLandAvoidance: opts?.useLandAvoidance ?? true,
        useSafetyMargin: opts?.useSafetyMargin ?? false,
        options: {
          motorBelowKn: opts?.motorBelowKn,
          motorSpeedKn: opts?.motorSpeedKn,
          waitForWind: opts?.waitForWind,
          maxWindKn: opts?.maxWindKn,
          maxWaveM: opts?.maxWaveM,
          tackPenaltySec: opts?.tackPenaltySec ?? 30,
          tackThresholdDeg: opts?.tackThresholdDeg ?? 60,
        },
      }),
    );

    ctx.setStatus('', 'Calculating…');
  }

  // Wire worker message handler
  routingWorker.addEventListener('message', (e) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const j = e.data as {
      type: string;
      pct?: number;
      progress?: number;
      frontier?: number[][];
      legOrigin?: [number, number];
      clearIsochrones?: boolean;
      status?: string;
      route?: {
        lat: number;
        lon: number;
        time: string;
        ctw: number;
        twa: number;
        tws: number;
        boatSpeed?: number;
        windDir: number;
        waveHeight?: number;
        gribFilePath?: string;
        gustKn?: number;
        currentU?: number;
        currentV?: number;
        wavePeriod?: number;
        waveDir?: number;
        wowTws?: number;
        wowDir?: number;
      }[];
      warning?: string;
      error?: string;
    };
    if (j.type === 'progress') {
      const pct = Math.round(j.pct ?? j.progress ?? 0);
      ctx.setProgress(pct);
      ctx.setStatus('', j.status ?? `Calculating… ${String(pct)}%`);
      if (j.clearIsochrones === true) {
        clearIsochrones(isochroneState);
      }
      if (j.frontier !== undefined && j.frontier.length > 0 && ctx.getIsochroneEnabled()) {
        const origin = j.legOrigin ? { lat: j.legOrigin[0], lon: j.legOrigin[1] } : ctx.getStartLatLon();
        if (origin) renderIsochrone(j.frontier, origin, isochroneState);
      }
    } else if (j.type === 'result') {
      ctx.setShowProgress(false);
      ctx.setCalculating(false);
      if (j.route && j.route.length >= 2) {
        // Convert RoutePoint[] to GeoJSON RouteData
        const routeData: RouteData = {
          feature: {
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: j.route.map((p) => [p.lon, p.lat]),
            },
            properties: {
              coordinatesMeta: j.route.map((p, i) => {
                const meta: WaypointMeta = {
                  name: '',
                  time: typeof p.time === 'string' ? p.time : new Date(p.time).toISOString(),
                  windDir: p.windDir,
                  ctw: p.ctw,
                  twa: p.twa,
                  tws: p.tws,
                };
                if (p.boatSpeed != null) meta.boatSpeed = p.boatSpeed;
                if (p.waveHeight != null) meta.waveHeight = p.waveHeight;
                if (p.gribFilePath != null) meta.gribFile = p.gribFilePath;
                if (p.gustKn != null) meta.gustKn = p.gustKn;
                if (p.wavePeriod != null) meta.wavePeriod = p.wavePeriod;
                if (p.waveDir != null) meta.waveDir = p.waveDir;
                if (p.wowTws != null) meta.wowTws = p.wowTws;
                if (p.wowDir != null) meta.wowDir = p.wowDir;
                if (p.currentU != null && p.currentV != null) {
                  const cSpd = Math.sqrt(p.currentU * p.currentU + p.currentV * p.currentV) * 1.94384;
                  if (cSpd > 0.01) {
                    meta.currentSpeedKn = cSpd;
                    meta.currentDir = currentDirection(p.currentU, p.currentV);
                  }
                }
                // COG and SOG from consecutive positions (ground track)
                if (i > 0) {
                  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                  const prev = j.route![i - 1]!;
                  const distNM = haversineNM(prev.lat, prev.lon, p.lat, p.lon);
                  meta.cogDeg = bearingTo(prev.lat, prev.lon, p.lat, p.lon);
                  // SOG in knots
                  const t0 = typeof prev.time === 'string' ? new Date(prev.time).getTime() : Number(prev.time);
                  const t1 = typeof p.time === 'string' ? new Date(p.time).getTime() : Number(p.time);
                  const dtH = (t1 - t0) / 3600000;
                  meta.sogKn = dtH > 0 ? distNM / dtH : 0;
                }
                return meta;
              }),
            },
          },
        };
        calcState.pendingRouteData = routeData;
        ctx.setStatus('done', 'Route calculated');
        fetchAndDrawRoute();
      } else if (j.error !== undefined && j.error !== '') {
        ctx.setStatus('error', j.error);
        ctx.showFailurePopup(j.error, false);
      } else {
        ctx.setStatus('error', 'No route returned');
      }
    }
  });

  return { startCalculation, drawRouteFromData, fetchAndDrawRoute, updateScrubberHighlight };
}
