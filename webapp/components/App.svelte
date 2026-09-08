<script lang="ts">
  // Root application component — owns layout, state, and all event wiring.
  // app.ts creates the MapLibre map and mounts this component.

  import SetupPanel from './SetupPanel.svelte';
  import RouteSummary from './RouteSummary.svelte';
  import SettingsModal from './SettingsModal.svelte';
  import PolarEditor from './PolarEditor.svelte';
  import MapLayerControl from './MapLayerControl.svelte';
  import Toast from './Toast.svelte';
  import TimeScrubber from './TimeScrubber.svelte';
  import ConditionsPanel from './ConditionsPanel.svelte';
  import WindOverlay from './WindOverlay.svelte';
  import WaveOverlay from './WaveOverlay.svelte';
  import CurrentOverlay from './CurrentOverlay.svelte';
  import LandOverlay from './LandOverlay.svelte';
  import RegionOverlay from './RegionOverlay.svelte';
  import RouteWeatherTable from './RouteWeatherTable.svelte';
  import SaveRouteModal from './SaveRouteModal.svelte';
  import Disclaimer from './Disclaimer.svelte';
  import MapContextMenu from './MapContextMenu.svelte';

  import type { WaypointMeta, GraphLayout, RouteData, UnitPref, GribFileMeta } from '../types';
  import type { CalculationApi } from '../calculation';
  import type { SkDeps } from '../sk-resources';
  import type { ConfigCallbacks } from '../config';
  import type { WaypointWeather } from '../route-weather';
  import type { WindPoint, WavePoint, CurrentPoint, WaveGridMeta } from '../stores';
  import { forecastLoaded, windPoints as windPointsStore, wavePoints as wavePointsStore, currentPoints as currentPointsStore, waveGridMetaStore as waveGridMetaStoreRef } from '../stores';
  import { calcState, resetCalcState } from '../calc-state.svelte';
  import { prefs, savePrefs } from '../prefs';
  import { skState } from '../sk-state.svelte';
  import { configState } from '../config-state.svelte';
  import { fmt as _fmt } from '../units';
  import { toLocalDateTimeInput } from '../utils';
  import * as forecaster from '../forecast-fetcher';
  import { computeLabel, computeCoverageHtml, computeNowMarkerLeft, findNowIndex } from '../scrubber-controller';
  import type { ScrubberState } from '../scrubber-controller';
  import { createTimeAxis, loadWindyTimes, rebuildTimes } from '../time-axis';
  import { setupCalculation } from '../calculation';
  import { greenIcon, redIcon, setupInfoPopupClick, setupViewportRefresh } from '../map-interaction';
  import { loadDepartureResources as _loadDepartureResources, loadWaypointRoutes as _loadWaypointRoutes, connectVesselPositionStream as _connectVesselPositionStream } from '../sk-resources';
  import { analyseRouteWeather } from '../route-weather';
  import * as dataLayer from '../data-layer';
  import { loadConfig as _loadConfig } from '../config';
  import * as maplibregl from 'maplibre-gl';
  import { MapLibre } from 'svelte-maplibre-gl';
  import { haversineNM, bearingTo } from '../../src/lib/geo';

  // ── Props ──────────────────────────────────────────────────────────────────
  interface Props {
    skFetch: (path: string, options?: RequestInit) => Promise<Response>;
    skWebSocketUrl: (path: string) => string;
    skLogin: (username: string, password: string) => Promise<void>;
    skLogout: () => void;
  }

  let { skFetch, skWebSocketUrl, skLogin, skLogout }: Props = $props();

  // ── Reactive State ─────────────────────────────────────────────────────────

  // UI text (startCoordsText/endCoordsText are now $derived below)
  let statusType = $state('');
  let statusText = $state('Ready');
  let departureTime = $state(defaultDepartureTime());
  let buildVersion = $state('');
  let waveLegendMax = $state('3 m');

  // Booleans / numbers
  let polarCsv = $state<string | null>(localStorage.getItem('wr-polar-csv'));
  const polarLoaded = $derived(!!polarCsv);
  let isCalculating = $state(false);
  let isAnalysing = $state(false);
  let calcProgress = $state(0);
  let showProgress = $state(false);

  // Waypoint list state
  interface UIWaypoint {
    id: string;
    label: string;
    value: { lat: number; lon: number } | null;
  }

  let waypoints = $state<UIWaypoint[]>([
    { id: crypto.randomUUID(), label: 'Start', value: null },
    { id: crypto.randomUUID(), label: 'End', value: null },
  ]);

  // Context menu
  let contextMenu = $state({ visible: false, x: 0, y: 0, lat: 0, lng: 0 });

  // Navigation state
  let regionEnabled = $state(false);
  let windTimesLoaded = $state(false);
  let skConnectedState = $state(false);

  // Analysis results (drives {#if} block in template)
  let analyseResults = $state<WaypointWeather[]>([]);

  // Save modal
  let showSaveModal = $state(false);

  // New UX state
  let sidebarView = $state<'setup' | 'summary'>('setup');
  let routeMode = $state<'route' | 'evaluate'>('route');
  let showSettings = $state(false);
  let showPolarEditor = $state(false);
  let toastMessage = $state('');
  let toastType = $state<'error' | 'warning' | 'info'>('info');
  let toastVisible = $state(false);

  // Overlay visibility
  let windOverlayVisible = $state(true);
  let waveOverlayVisible = $state(false);
  let currentOverlayVisible = $state(false);
  let landOverlayVisible = $state(false);
  let regionOverlayVisible = $state(false);
  let isochroneVisibleState = $state(true);

  // Overlay data (synced from stores written by forecast-fetcher)
  let windPointsData = $state<WindPoint[]>([]);
  let wavePointsData = $state<WavePoint[]>([]);
  let currentPointsData = $state<CurrentPoint[]>([]);
  let waveGridMetaData = $state<WaveGridMeta | null>(null);

  // ── Derived from waypoints ──────────────────────────────────────────────────

  const startCoordsText = $derived(
    waypoints[0]?.value
      ? `${waypoints[0].value.lat.toFixed(4)}, ${waypoints[0].value.lon.toFixed(4)}`
      : '\u2014'
  );
  const endCoordsText = $derived(
    waypoints.length > 0 && waypoints[waypoints.length - 1]?.value
      ? `${waypoints[waypoints.length - 1]!.value!.lat.toFixed(4)}, ${waypoints[waypoints.length - 1]!.value!.lon.toFixed(4)}`
      : '\u2014'
  );

  // Sync waypoints → skState
  $effect(() => {
    skState.startLatLon = waypoints[0]?.value ?? null;
    skState.endLatLon = waypoints.length > 0 ? (waypoints[waypoints.length - 1]?.value ?? null) : null;
    skState.routeWaypoints = waypoints.slice(1, -1)
      .filter((wp): wp is UIWaypoint & { value: NonNullable<UIWaypoint['value']> } => wp.value !== null)
      .map(wp => wp.value);
  });

  // ── Derived State ──────────────────────────────────────────────────────────

  const hasRoute = $derived(
    (!!skState.startLatLon && !!skState.endLatLon) || skState.routeWaypoints.length > 0
  );
  const canCalculate = $derived(hasRoute && windTimesLoaded && !isCalculating);
  const canAnalyse = $derived(
    hasRoute && polarLoaded && !!departureTime && windTimesLoaded && !isAnalysing
  );
  const calcHint = $derived.by(() => {
    if (isCalculating) return '';
    const m: string[] = [];
    if (!windTimesLoaded) m.push('loading forecast…');
    if (!hasRoute) m.push('set route');
    return m.length ? 'Needs: ' + m.join(', ') : '';
  });
  const analyseHint = $derived.by(() => {
    if (isAnalysing) return '';
    const m: string[] = [];
    if (!windTimesLoaded) m.push('loading forecast…');
    if (!hasRoute) m.push('set route');
    if (!polarLoaded) m.push('load polar');
    if (!departureTime) m.push('set departure');
    return m.length ? 'Needs: ' + m.join(', ') : '';
  });

  const routeSummaryWaypoints = $derived.by(() => {
    const rd = calcState.pendingRouteData;
    if (!rd?.feature?.geometry?.coordinates) return [];
    const coords = rd.feature.geometry.coordinates;
    const meta = rd.feature.properties?.coordinatesMeta ?? [];
    return coords.map(([lng, lat]: number[], i: number) => {
      let bearing = 0;
      let distanceNm = 0;
      if (i > 0) {
        const prev = coords[i - 1]!;
        bearing = Math.round(bearingTo(prev[1]!, prev[0]!, lat!, lng!));
        distanceNm = Math.round(haversineNM(prev[1]!, prev[0]!, lat!, lng!) * 10) / 10;
      }
      const m = meta[i];
      return {
        lat: lat!,
        lon: lng!,
        bearing,
        distanceNm,
        eta: m?.time ?? '',
      };
    });
  });

  const routeTotalDistanceNm = $derived(
    routeSummaryWaypoints.reduce((sum, wp) => sum + wp.distanceNm, 0)
  );

  const routeTotalDurationH = $derived.by(() => {
    const wps = routeSummaryWaypoints;
    if (wps.length < 2) return 0;
    const first = wps[0];
    const last = wps[wps.length - 1];
    if (!first?.eta || !last?.eta) return 0;
    return Math.round((new Date(last.eta).getTime() - new Date(first.eta).getTime()) / 3600000 * 10) / 10;
  });

  // ── Internal (non-reactive) State ──────────────────────────────────────────

  let regionOverlayRef: { getAvoidIds: () => string[]; reload: () => Promise<void>; toggleAvoid: (id: string, avoid: boolean) => void } | undefined;
  let regionListData = $state<{ id: string; name: string; avoided: boolean }[]>([]);
  let currentEnabled = true;
  let windTimes = $state<string[]>([]);
  let windTimesCount = 0;
  let windNativeTimes: string[] = [];
  let currentFileTimes: string[] = [];
  let gribInfoFiles: GribFileMeta[] = [];
  let dilatedIndexReady = false;
  let enabledGribPaths = new Set<string>();
  let timeAxis = createTimeAxis();

  // Scrubber reactive state
  let scrubberIndex = $state(0);
  let scrubberLabel = $state('');
  let coverageHtml = $state('');
  let nowMarkerLeft = $state<string | null>(null);
  let showRangeToggle = $state(false);
  let rangeToggleLabel = $state('Full range');
  let scrubberVisible = $state(false);

  // Conditions panel: visible when route results exist in summary view
  const conditionsVisible = $derived(sidebarView === 'summary' && calcState.graphMeta != null && calcState.graphMeta.length > 0);
  let conditionsExpanded = $state(true);

  // Bind:this refs for graph tooltip

  // Subscribe to overlay data stores (forecast-fetcher writes to these)
  windPointsStore.subscribe(v => { windPointsData = v; });
  wavePointsStore.subscribe(v => { wavePointsData = v; });
  currentPointsStore.subscribe(v => { currentPointsData = v; });
  waveGridMetaStoreRef.subscribe(v => { waveGridMetaData = v; });

  // MapLibre layers / markers

  // Map refs at component level
  let mapRef = $state<maplibregl.Map>(undefined as unknown as maplibregl.Map);
  let startMarker: maplibregl.Marker | null = null;
  let endMarker: maplibregl.Marker | null = null;
  let isochroneState: { sourceIds: string[]; layerIds: string[]; count: number; map: maplibregl.Map } | null = null;
  let routingWorker: Worker | null = null;
  let calcApi: CalculationApi | null = null;
  let routeWeatherMarkers: maplibregl.Marker[] = [];

  // SettingsModal component ref (replaces RoutingOptions)
  let settingsModalRef = $state<{ getOptions: () => { useLandAvoidance: boolean; useSafetyMargin: boolean; motorBelowKn: number | undefined; motorSpeedKn: number | undefined; waitForWind: boolean | undefined; maxWindKn: number | undefined; maxWaveM: number | undefined; tackPenaltySec: number; tackThresholdDeg: number; waypointLabels: boolean; waypointLabelInterval: number } } | undefined>();

  // ── Helpers ────────────────────────────────────────────────────────────────

  function defaultDepartureTime(): string {
    const now = new Date(Math.ceil(Date.now() / 1800000) * 1800000);
    return toLocalDateTimeInput(now);
  }

  function setStatus(type: string, msg: string) {
    statusType = type;
    statusText = msg;
    if (type === 'done' && calcState.pendingRouteData) sidebarView = 'summary';
  }

  function handleShowFailurePopup(msg: string, isWarning: boolean) {
    toastMessage = msg;
    toastType = isWarning ? 'warning' : 'error';
    toastVisible = true;
  }

  function timeAxisState() { return { windTimes, windNativeTimes, windTimesLoaded }; }

  async function fetchWindPointsAt(idx: number, signal?: AbortSignal) {
    await forecaster.fetchWindPoints(idx, timeAxisState(), mapRef!, signal);
    scrubberLabel = computeLabel(idx, windTimes);
  }
  async function fetchWavePointsAt(idx: number, signal?: AbortSignal) {
    await forecaster.fetchWavePoints(idx, timeAxisState(), mapRef!, signal);
  }
  async function fetchCurrentPointsAt(timeMs: number, signal?: AbortSignal) {
    await forecaster.fetchCurrentPoints(timeMs, mapRef!, signal);
  }

  function scrubberState(): ScrubberState {
    return { windTimes, scrubberLockedToRoute: calcState.scrubberLockedToRoute, routeScrubberRange: calcState.routeScrubberRange, graphMeta: calcState.graphMeta, gribInfoFiles, enabledGribPaths, currentEnabled, currentFileTimes };
  }

  /** Update all scrubber-derived reactive state from current windTimes / range. */
  function updateScrubberView() {
    const rangeStart = calcState.scrubberLockedToRoute && calcState.routeScrubberRange ? calcState.routeScrubberRange.i0 : 0;
    const rangeEnd = calcState.scrubberLockedToRoute && calcState.routeScrubberRange ? calcState.routeScrubberRange.iN : Math.max(0, windTimes.length - 1);
    coverageHtml = computeCoverageHtml(rangeStart, rangeEnd, scrubberState());
    nowMarkerLeft = computeNowMarkerLeft(rangeStart, rangeEnd, windTimes);
    scrubberLabel = computeLabel(scrubberIndex, windTimes);
  }

  function rebuildScrubberTimes() {
    const result = rebuildTimes(timeAxis);
    timeAxis = result;
    windTimes = result.windTimes;
    windTimesCount = result.windTimesCount;
    windNativeTimes = result.windNativeTimes;
    windTimesLoaded = result.windTimesLoaded;
    if (result.windTimesLoaded) forecastLoaded.set(true);
    if (windTimes.length === 0) {
      scrubberVisible = false;
      return;
    }
    scrubberVisible = true;
    scrubberIndex = Math.min(scrubberIndex, Math.max(0, windTimes.length - 1));
    updateScrubberView();
  }

  function useSafetyMargin(): boolean {
    return settingsModalRef?.getOptions().useSafetyMargin ?? false;
  }

  // ── Scrubber Event Handlers ────────────────────────────────────────────────

  let scrubberDebounce: ReturnType<typeof setTimeout> | null = null;
  let windAbort: AbortController | null = null;
  let waveAbort: AbortController | null = null;
  let currentAbort: AbortController | null = null;

  function handleScrubberChange(idx: number) {
    scrubberIndex = idx;
    scrubberLabel = computeLabel(idx, windTimes);
    clearTimeout(scrubberDebounce ?? undefined);
    scrubberDebounce = setTimeout(() => {
      windAbort?.abort(); windAbort = new AbortController();
      waveAbort?.abort(); waveAbort = new AbortController();
      void fetchWindPointsAt(idx, windAbort.signal);
      void fetchWavePointsAt(idx, waveAbort.signal);
      const timeMs = windTimes[idx] ? new Date(windTimes[idx]).getTime() : Date.now();
      if (currentEnabled || forecaster.getCurrentPoints().length > 0) {
        currentAbort?.abort(); currentAbort = new AbortController();
        void fetchCurrentPointsAt(timeMs, currentAbort.signal);
      }
      calcApi?.updateScrubberHighlight(idx);
    }, 100);
  }

  function handleJumpToNow() {
    if (!windTimesLoaded) return;
    const idx = findNowIndex(windTimes);
    handleScrubberChange(idx);
  }

  function handleToggleRange() {
    if (!calcState.routeScrubberRange) return;
    calcState.scrubberLockedToRoute = !calcState.scrubberLockedToRoute;
    rangeToggleLabel = calcState.scrubberLockedToRoute ? 'Full range' : 'Route only';
    if (calcState.scrubberLockedToRoute) {
      scrubberIndex = Math.max(calcState.routeScrubberRange.i0, Math.min(calcState.routeScrubberRange.iN, scrubberIndex));
    }
    updateScrubberView();
  }

  function handleUseAsDeparture(timeIso: string) {
    if (timeIso) departureTime = toLocalDateTimeInput(new Date(timeIso));
  }

  function handleConditionsToggle() {
    conditionsExpanded = !conditionsExpanded;
  }


  // ── Waypoint Handlers ─────────────────────────────────────────────────────

  function handleWaypointChange(index: number, point: { lat: number; lon: number } | null) {
    // Auto-cancel running calculation — the input changed, old result would be stale
    if (isCalculating) handleCancelCalculation();
    waypoints = waypoints.map((wp, i) => i === index ? { ...wp, value: point } : wp);
    // Update map markers
    if (index === 0 && point) {
      startMarker?.setLngLat([point.lon, point.lat]).addTo(mapRef!);
    } else if (index === 0 && !point) {
      startMarker?.remove();
    } else if (index === waypoints.length - 1 && point) {
      endMarker?.setLngLat([point.lon, point.lat]).addTo(mapRef!);
    } else if (index === waypoints.length - 1 && !point) {
      endMarker?.remove();
    }
    updateIntermediateMarkers();
  }

  function handleWaypointAdd() {
    const newWp: UIWaypoint = { id: crypto.randomUUID(), label: '', value: null };
    waypoints = [...waypoints.slice(0, -1), newWp, waypoints[waypoints.length - 1]!];
    relabelWaypoints();
  }

  function handleWaypointRemove(index: number) {
    if (index === 0 || index === waypoints.length - 1) return;
    waypoints = waypoints.filter((_, i) => i !== index);
    relabelWaypoints();
    updateIntermediateMarkers();
  }

  function handleWaypointReorder(fromIndex: number, toIndex: number) {
    if (fromIndex === toIndex) return;
    if (fromIndex < 0 || fromIndex >= waypoints.length) return;
    if (toIndex < 0 || toIndex >= waypoints.length) return;
    const newList = [...waypoints];
    const [item] = newList.splice(fromIndex, 1);
    newList.splice(toIndex, 0, item!);
    waypoints = newList;
    relabelWaypoints();
    updateIntermediateMarkers();
    // Update start/end markers on map
    if (waypoints[0]?.value) startMarker?.setLngLat([waypoints[0].value.lon, waypoints[0].value.lat]).addTo(mapRef!);
    else startMarker?.remove();
    const last = waypoints[waypoints.length - 1];
    if (last?.value) endMarker?.setLngLat([last.value.lon, last.value.lat]).addTo(mapRef!);
    else endMarker?.remove();
  }

  function relabelWaypoints() {
    let wpNum = 1;
    waypoints = waypoints.map((wp, i) => ({
      ...wp,
      label: i === 0 ? 'Start' : i === waypoints.length - 1 ? 'End' : `Waypoint ${wpNum++}`,
    }));
  }

  function updateIntermediateMarkers() {
    // Remove old intermediate markers
    for (const m of skState.routeWaypointMarkers) m.remove();
    // Create new ones for intermediates with values
    const newMarkers: maplibregl.Marker[] = [];
    for (let i = 1; i < waypoints.length - 1; i++) {
      const wp = waypoints[i];
      if (!wp?.value) continue;
      const el = document.createElement('div');
      el.innerHTML = '<div style="background:#f5c2e7;width:8px;height:8px;border-radius:50%;border:1px solid #1e2230"></div>';
      newMarkers.push(
        new maplibregl.Marker({ element: el, anchor: 'center' })
          .setLngLat([wp.value.lon, wp.value.lat])
          .addTo(mapRef!)
      );
    }
    skState.routeWaypointMarkers = newMarkers;
  }

  function handleLoadRoute(routeIndex: number) {
    const route = skState.waypointRoutes[routeIndex];
    if (!route) return;
    const coords = route.coords;
    if (coords.length < 2) return;
    // Remove old markers
    for (const m of skState.routeWaypointMarkers) m.remove();
    startMarker?.remove();
    endMarker?.remove();

    waypoints = coords.map((coord, i) => ({
      id: crypto.randomUUID(),
      label: i === 0 ? 'Start' : i === coords.length - 1 ? 'End' : `Waypoint ${i}`,
      value: { lat: coord[1]!, lon: coord[0]! },
    }));

    // Place markers
    const first = coords[0]!;
    startMarker?.setLngLat([first[0]!, first[1]!]).addTo(mapRef!);
    const last = coords[coords.length - 1]!;
    endMarker?.setLngLat([last[0]!, last[1]!]).addTo(mapRef!);
    updateIntermediateMarkers();

    // Fit bounds
    const bounds = coords.reduce(
      (b, [lon, lat]) => b.extend([lon!, lat!] as [number, number]),
      new maplibregl.LngLatBounds(),
    );
    mapRef?.fitBounds(bounds, { padding: 30 });
  }

  // ── Context Menu Handlers ─────────────────────────────────────────────────

  /** Transition to planning mode — hides route results and clears stale route state
   *  so scrubber/highlight callbacks don't act on old data. */
  function enterPlanningMode() {
    sidebarView = 'setup';
    resetCalcState(mapRef);
    showRangeToggle = false;
    timeAxis = { ...timeAxis, routeWaypointTimes: [] };
    rebuildScrubberTimes();
  }

  function handleContextSetStart() {
    handleWaypointChange(0, { lat: contextMenu.lat, lon: contextMenu.lng });
    contextMenu = { ...contextMenu, visible: false };
    enterPlanningMode();
  }

  function handleContextSetEnd() {
    handleWaypointChange(waypoints.length - 1, { lat: contextMenu.lat, lon: contextMenu.lng });
    contextMenu = { ...contextMenu, visible: false };
    enterPlanningMode();
  }

  function handleContextAddWaypoint() {
    handleWaypointAdd();
    handleWaypointChange(waypoints.length - 2, { lat: contextMenu.lat, lon: contextMenu.lng });
    contextMenu = { ...contextMenu, visible: false };
    enterPlanningMode();
  }

  // ── Event Handlers ─────────────────────────────────────────────────────────

  function handleCalculate() {
    void calcApi?.startCalculation();
  }
  function handleCancelCalculation() {
    if (!isCalculating) return;
    routingWorker?.terminate();
    isCalculating = false;
    showProgress = false;
    setStatus('', 'Calculation cancelled');
    // Create a new worker and re-setup calculation module
    routingWorker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
    if (mapRef && isochroneState) {
      calcApi = initCalcApi(mapRef, routingWorker!, isochroneState!);
    }
  }

  function handleAnalyse() {
    if (!departureTime) return;
    const csv = polarCsv;
    if (!csv) return;
    isAnalysing = true;

    void (async () => {
      try {
        let coords: number[][] | null = null;
        if (skState.startLatLon && skState.endLatLon) {
          coords = [[skState.startLatLon.lon, skState.startLatLon.lat], [skState.endLatLon.lon, skState.endLatLon.lat]];
          if (skState.routeWaypoints.length > 0) {
            coords = [coords[0]!, ...skState.routeWaypoints.map((wp: { lat: number; lon: number }) => [wp.lon, wp.lat]), coords[1]!];
          }
        }
        if (!coords || coords.length < 2) {
          setStatus('error', 'Need at least 2 route points for analysis');
          return;
        }
        const analyseWaypoints = coords.map(([lon, lat]) => ({ lat: lat!, lon: lon! }));
        const results = await analyseRouteWeather(analyseWaypoints, new Date(departureTime).getTime(), csv);
        analyseResults = results;

        // Add route weather markers on map
        for (const m of routeWeatherMarkers) m.remove();
        routeWeatherMarkers = results.map((r) => {
          const el = document.createElement('div');
          el.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#89b4fa;border:1px solid #1e2230';
          const marker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([r.lon, r.lat]).addTo(mapRef!);
          const tw = _fmt(r.twsKn ?? 0, 'speed');
          const popup = new maplibregl.Popup({ offset: [0, -10], closeButton: false, closeOnClick: false })
            .setHTML(`WP${String(r.idx)}<br>${tw.num} ${tw.sym}, ${Math.round(r.twdDeg ?? 0)}°`);
          marker.setPopup(popup);
          marker.getElement().addEventListener('mouseenter', () => popup.addTo(mapRef!));
          marker.getElement().addEventListener('mouseleave', () => popup.remove());
          return marker;
        });
      } catch (e) {
        setStatus('error', `Analysis failed: ${String(e)}`);
      } finally {
        isAnalysing = false;
      }
    })();
  }

  function handleSaveRoute() {
    if (!calcState.pendingRouteData) {
      setStatus('error', 'No route to save');
      return;
    }
    showSaveModal = true;
  }

  async function handleSaveRouteConfirm(name: string) {
    if (!calcState.pendingRouteData) return;
    const body = { ...calcState.pendingRouteData, name };
    const r = await skFetch('/signalk/v2/api/resources/routes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`HTTP ${String(r.status)}`);
    showSaveModal = false;
  }

  function initCalcApi(map: maplibregl.Map, worker: Worker, iso: typeof isochroneState) {
    return setupCalculation({
      map, routingWorker: worker, isochroneState: iso!,
      setProgress: (pct: number) => { calcProgress = pct; },
      setCalculating: (v: boolean) => { isCalculating = v; },
      setShowProgress: (v: boolean) => { showProgress = v; },
      getDepartureTime: () => departureTime,
      getIsochroneEnabled: () => isochroneVisibleState,
      setStatus,
      showFailurePopup: handleShowFailurePopup,
      fetchWindPointsAt: (idx: number) => fetchWindPointsAt(idx),
      fetchWavePointsAt: (idx: number) => fetchWavePointsAt(idx),
      scrubberState,
      getStartLatLon: () => skState.startLatLon,
      getEndLatLon: () => skState.endLatLon,
      getRouteWaypoints: () => skState.routeWaypoints,
      getRoutingOptions: () => settingsModalRef ?? null,
      getWindSpeedMs: () => configState.windSpeedMs,
      getWindTimes: () => windTimes,
      getWindTimesLoaded: () => windTimesLoaded,
      getGribInfoFiles: () => gribInfoFiles,
      getForecastSkillHorizonHours: () => configState.forecastSkillHorizonHours,
      getPolarCsv: () => polarCsv ?? undefined,
      setConditionsGraph: (data) => {
        if (data) {
          calcState.graphLayout = data.layout;
        }
      },
      lockScrubberToRoute: (i0, iN) => {
        calcState.routeScrubberRange = { i0, iN };
        calcState.scrubberLockedToRoute = true;
        scrubberIndex = i0;
        showRangeToggle = true;
        rangeToggleLabel = 'Full range';
        updateScrubberView();
      },
      setRouteWaypointTimes: (times) => {
        timeAxis = { ...timeAxis, routeWaypointTimes: times };
        rebuildScrubberTimes();
      },
      setShowRangeToggle: (v) => { showRangeToggle = v; },
      onRouteClick: (timeMs) => {
        let best = 0, bestDiff = Infinity;
        for (let i = 0; i < windTimes.length; i++) {
          const diff = Math.abs(new Date(windTimes[i]!).getTime() - timeMs);
          if (diff < bestDiff) { bestDiff = diff; best = i; }
        }
        handleScrubberChange(best);
      },
    });
  }
  // ── Map Initialization ($effect — runs once when map becomes available) ────

  let mapInitialized = false;
  $effect(() => {
    const m = mapRef;
    if (!m || mapInitialized) return;
    mapInitialized = true;

    startMarker = new maplibregl.Marker({ element: greenIcon(), anchor: 'center' });
    endMarker = new maplibregl.Marker({ element: redIcon(), anchor: 'center' });
    isochroneState = { sourceIds: [], layerIds: [], count: 0, map: m };
    routingWorker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });

    // ── Map context menu handler ──────────────────────────────────────────
    m.on('contextmenu', (e: maplibregl.MapMouseEvent) => {
      e.preventDefault();
      const container = m.getContainer().getBoundingClientRect();
      contextMenu = {
        visible: true,
        x: e.point.x + container.left,
        y: e.point.y + container.top,
        lat: e.lngLat.lat,
        lng: e.lngLat.lng,
      };
    });

    // Save map position on pan/zoom
    m.on('moveend', () => {
      const c = m.getCenter();
      prefs.mapCenter = [c.lng, c.lat];
      prefs.mapZoom = m.getZoom();
      savePrefs(prefs);
    });

    // ── Calculation module ──────────────────────────────────────────────────
    // calcState imported from calc-state.svelte.ts — no bridge needed

    calcApi = initCalcApi(m, routingWorker!, isochroneState!);

    // ── SK resources ────────────────────────────────────────────────────────
    // skState imported from sk-state.svelte.ts — no bridge needed
    const skDeps: SkDeps = {
      skFetch, skWebSocketUrl, map: m,
      startMarker: startMarker!,
      endMarker: endMarker!,
    };

    // ── Config ──────────────────────────────────────────────────────────────
    // configState imported from config-state.svelte.ts — no bridge needed
    const configCallbacks: ConfigCallbacks = {
      setBuildVersion: (v: string) => { buildVersion = v; },
      setWaveLegendMax: (text: string) => { waveLegendMax = text; },
      setSafetyMarginDist: (_text: string) => { /* handled by SettingsModal */ },
    };

    // ── Startup ─────────────────────────────────────────────────────────────


    // Init wind scrubber (load Windy times + first overlay fetch)
    void (async () => {
      setStatus('', 'Loading forecast data…');
      try {
        timeAxis = await loadWindyTimes(timeAxis);
        windTimes = timeAxis.windTimes;
        windTimesCount = timeAxis.windTimesCount;
        windNativeTimes = timeAxis.windNativeTimes;
        windTimesLoaded = timeAxis.windTimesLoaded;
      } catch (e) {
        setStatus('error', 'Failed to load forecast: ' + (e instanceof Error ? e.message : String(e)));
        return;
      }
      rebuildScrubberTimes();
      if (windTimesCount > 0) {
        await fetchWindPointsAt(0);
        await fetchWavePointsAt(0);
        const t0 = windTimes[0];
        if (t0) {
          await fetchCurrentPointsAt(new Date(t0).getTime());
        }
      }
      setStatus('done', 'Ready');
    })();

    void _loadConfig(skFetch, configCallbacks);

    // SK-dependent features
    void (async () => {
      try {
        const r = await skFetch('/signalk');
        if (!r.ok) throw new Error(`HTTP ${String(r.status)}`);
        skConnectedState = true;
        void _loadDepartureResources(skDeps);
        void _loadWaypointRoutes(skDeps);
        if (regionOverlayRef) void regionOverlayRef.reload();
        _connectVesselPositionStream(skDeps);
      } catch {
        skConnectedState = false;
        setStatus('', 'Ready (no SignalK server)');
      }
    })();

    // ── Map event handlers ──────────────────────────────────────────────────
    setupViewportRefresh(m, {
      fetchWindPointsAt,
      fetchWavePointsAt,
      fetchCurrentPointsAt,
      isWindTimesLoaded: () => windTimesLoaded,
      isWindVisible: () => windOverlayVisible,
      isWaveVisible: () => waveOverlayVisible,
      isCurrentVisible: () => currentOverlayVisible,
      getScrubberIndex: () => scrubberIndex,
      getWindTimes: () => windTimes,
    });
    setupInfoPopupClick(m, () => ({
      allWindPoints: forecaster.getWindPoints(),
      allWavePoints: forecaster.getWavePoints(),
      allCurrentPoints: forecaster.getCurrentPoints(),
      windSpeedMs: configState.windSpeedMs,
      windVisible: windOverlayVisible,
      waveVisible: waveOverlayVisible,
      currentVisible: currentOverlayVisible,
    }));

    // Dilated land data polling
    const dilatedPoll = setInterval(() => {
      if (dilatedIndexReady) return;
      if (dataLayer.dilatedLandDataReady()) { dilatedIndexReady = true; clearInterval(dilatedPoll); }
    }, 5000);

  });

  // ── Isochrone layer visibility toggle ────────────────────────────────────
  $effect(() => {
    const vis = isochroneVisibleState;
    if (!isochroneState || !mapRef) return;
    const visibility = vis ? 'visible' : 'none';
    for (const layerId of isochroneState.layerIds) {
      if (mapRef.getLayer(layerId)) {
        mapRef.setLayoutProperty(layerId, 'visibility', visibility);
      }
    }
  });

</script>

<!-- Sidebar -->
<div class="sidebar">
  <div class="sidebar-header">
    <h1>&#9973; Weather Routing</h1>
    <button class="gear-btn" onclick={() => showSettings = true} title="Settings">&#9881;</button>
  </div>

  {#if sidebarView === 'setup'}
    <SetupPanel
      mode={routeMode}
      onModeChange={(m) => { routeMode = m; }}
      {waypoints}
      skWaypoints={skState.departureResources}
      vesselPosition={skState.vesselPosition}
      waypointRoutes={skState.waypointRoutes}
      bind:departureTime={departureTime}
      {canCalculate}
      {calcHint}
      {isCalculating}
      {calcProgress}
      {showProgress}
      {canAnalyse}
      analyseHint={analyseHint}
      {isAnalysing}
      {statusText}
      {statusType}
      onWaypointChange={handleWaypointChange}
      onWaypointAdd={handleWaypointAdd}
      onWaypointRemove={handleWaypointRemove}
      onWaypointReorder={handleWaypointReorder}
      onLoadRoute={handleLoadRoute}
      onWaypointRouteChange={(e) => {
        const idx = parseInt((e.target as HTMLSelectElement).value);
        if (!isNaN(idx)) handleLoadRoute(idx);
      }}
      onCalculate={handleCalculate}
      onCancel={handleCancelCalculation}
      onAnalyse={handleAnalyse}
    />
  {:else}
    <RouteSummary
      waypoints={routeSummaryWaypoints}
      totalDistanceNm={routeTotalDistanceNm}
      totalDurationH={routeTotalDurationH}
      departureTime={departureTime}
      {statusText}
      {statusType}
      canSave={calcState.pendingRouteData !== null}
      onEdit={enterPlanningMode}
      onSave={handleSaveRoute}
    />
  {/if}
</div>

<!-- Right column: map + panels -->
<div class="right-col">
  <div class="map-wrap">
    <!-- svelte-ignore binding_property_non_reactive -->
    <MapLibre
      bind:map={mapRef}
      inlineStyle="flex:1;min-height:200px"
      center={prefs.mapCenter}
      zoom={prefs.mapZoom}
      pitchWithRotate={false}
      dragRotate={false}
      touchPitch={false}
      attributionControl={false}
      style={{
        version: 8,
        sources: {
          osm: {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
          },
        },
        layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
      }}
      transformRequest={(url) => ({
        url,
        referrerPolicy: 'strict-origin-when-cross-origin',
      })}
    />
    <MapLayerControl
      bind:windVisible={windOverlayVisible}
      bind:waveVisible={waveOverlayVisible}
      bind:currentVisible={currentOverlayVisible}
      bind:landVisible={landOverlayVisible}
      bind:isochroneVisible={isochroneVisibleState}
      bind:regionVisible={regionOverlayVisible}
      {regionEnabled}
      regions={regionListData}
      onToggleRegionAvoid={(id, avoid) => regionOverlayRef?.toggleAvoid(id, avoid)}
    />
    <Toast
      message={toastMessage}
      type={toastType}
      visible={toastVisible}
      onDismiss={() => { toastVisible = false; }}
    />
    <div class="wave-legend" class:visible={waveOverlayVisible}>
      <div class="wave-legend-bar"></div>
      <div class="wave-legend-labels">
        <span>0</span>
        <span>{waveLegendMax}</span>
      </div>
    </div>
    <MapContextMenu
      visible={contextMenu.visible}
      x={contextMenu.x}
      y={contextMenu.y}
      onSetStart={handleContextSetStart}
      onSetEnd={handleContextSetEnd}
      onAddWaypoint={handleContextAddWaypoint}
      onClose={() => { contextMenu = { ...contextMenu, visible: false }; }}
    />
  </div>

  <TimeScrubber
    {windTimes}
    {scrubberIndex}
    lockedRange={calcState.scrubberLockedToRoute ? calcState.routeScrubberRange : null}
    label={scrubberLabel}
    {coverageHtml}
    {nowMarkerLeft}
    {showRangeToggle}
    {rangeToggleLabel}
    visible={scrubberVisible}
    onIndexChange={handleScrubberChange}
    onJumpToNow={handleJumpToNow}
    onToggleRange={handleToggleRange}
    onUseAsDeparture={handleUseAsDeparture}
  />

  <ConditionsPanel
    visible={conditionsVisible}
    expanded={conditionsExpanded}
    meta={calcState.graphMeta ?? []}
    scrubberTimeMs={windTimes[scrubberIndex] != null ? new Date(windTimes[scrubberIndex]!).getTime() : null}
    onToggle={handleConditionsToggle}
    onTimeClick={(timeMs) => {
      // Find closest windTimes index
      let best = 0, bestDiff = Infinity;
      for (let i = 0; i < windTimes.length; i++) {
        const diff = Math.abs(new Date(windTimes[i]!).getTime() - timeMs);
        if (diff < bestDiff) { bestDiff = diff; best = i; }
      }
      handleScrubberChange(best);
    }}
  />

  {#if analyseResults.length > 0}
    <div class="results-table-panel">
      <RouteWeatherTable data={analyseResults} />
    </div>
  {/if}
</div>


<!-- Renderless overlay components -->
<WindOverlay map={mapRef ?? null} points={windPointsData} visible={windOverlayVisible} />
<WaveOverlay map={mapRef ?? null} points={wavePointsData} visible={waveOverlayVisible} gridMeta={waveGridMetaData} maxM={configState.waveOverlayMaxM} />
<CurrentOverlay map={mapRef ?? null} points={currentPointsData} visible={currentOverlayVisible} />
<LandOverlay map={mapRef ?? null} visible={landOverlayVisible} {useSafetyMargin} />
<RegionOverlay map={mapRef ?? null} visible={regionOverlayVisible} {skFetch} bind:this={regionOverlayRef} onRegionsChange={(r) => { regionListData = r; }} />

<!-- Modals -->
{#if showSettings}
  <SettingsModal
    visible={showSettings}
    onPolarChange={(csv) => { polarCsv = csv; }}
    onOpenPolarEditor={() => { showSettings = false; showPolarEditor = true; }}
    {polarLoaded}
    map={mapRef ?? null}
    skConnected={skConnectedState}
    {skFetch}
    currentSkUrl={localStorage.getItem('wr-signalk-url') ?? ''}
    {buildVersion}
    onLogin={skLogin}
    onLogout={skLogout}
    onClose={() => { showSettings = false; }}
    bind:this={settingsModalRef}
  />
{/if}

{#if showPolarEditor}
  <PolarEditor
    visible={showPolarEditor}
    {polarCsv}
    onPolarChange={(csv) => { polarCsv = csv; }}
    onClose={() => { showPolarEditor = false; }}
  />
{/if}

{#if showSaveModal}
  <SaveRouteModal
    visible={true}
    onSave={handleSaveRouteConfirm}
    onCancel={() => { showSaveModal = false; }}
  />
{/if}

<Disclaimer />

<style>
  .sidebar {
    width: 320px;
    flex-shrink: 0;
    background: #1e2230;
    color: #cdd6f4;
    padding: 12px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    border-right: 2px solid #313244;
  }
  .sidebar h1 {
    font-size: 16px;
    margin: 0;
    color: #cdd6f4;
  }
  .sidebar-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }
  .gear-btn {
    background: none;
    border: none;
    color: #a6adc8;
    font-size: 18px;
    cursor: pointer;
    padding: 4px;
  }
  .gear-btn:hover { color: #cdd6f4; }

  .right-col {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    background: #1e2230;
  }
  .map-wrap {
    position: relative;
    flex: 1;
    min-height: 200px;
    display: flex;
    flex-direction: column;
  }

  .results-table-panel {
    background: #1e2230;
    border-top: 1px solid #313244;
    padding: 8px;
    max-height: 250px;
    overflow-y: auto;
  }

  /* Wave legend */
  .wave-legend {
    position: absolute;
    bottom: 30px;
    left: 10px;
    background: rgba(30, 34, 48, 0.9);
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 10px;
    color: #cdd6f4;
    display: none;
    flex-direction: column;
    gap: 2px;
    z-index: 500;
  }
  .wave-legend.visible {
    display: flex;
  }
  .wave-legend-bar {
    width: 120px;
    height: 8px;
    background: linear-gradient(to right, hsla(240,100%,50%,0.7), hsla(120,100%,50%,0.7), hsla(0,100%,50%,0.7));
    border-radius: 2px;
  }
  .wave-legend-labels {
    display: flex;
    justify-content: space-between;
    font-size: 9px;
  }

</style>
