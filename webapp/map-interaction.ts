// Map interaction handlers — info popups, viewport-change re-fetches,
// and marker icon factories.

import * as maplibregl from 'maplibre-gl';

import type { WindPoint, WavePoint, CurrentPoint } from './stores';
import { fmt as _fmt } from './units';

// ── Marker icons ──────────────────────────────────────────────────────────────

export function greenIcon(): HTMLDivElement {
  const el = document.createElement('div');
  el.innerHTML =
    '<div style="background:#a6e3a1;width:12px;height:12px;border-radius:50%;border:2px solid #1e2230"></div>';
  return el;
}

export function redIcon(): HTMLDivElement {
  const el = document.createElement('div');
  el.innerHTML =
    '<div style="background:#f38ba8;width:12px;height:12px;border-radius:50%;border:2px solid #1e2230"></div>';
  return el;
}

// ── Info popup (wind/wave/current on click) ───────────────────────────────────

interface InfoPopupState {
  allWindPoints: WindPoint[];
  allWavePoints: WavePoint[];
  allCurrentPoints: CurrentPoint[];
  windSpeedMs: boolean;
  windVisible: boolean;
  waveVisible: boolean;
  currentVisible: boolean;
}

/**
 * Register the info-popup click handler. Returns a cleanup function.
 */
export function setupInfoPopupClick(map: maplibregl.Map, getState: () => InfoPopupState): () => void {
  const handler = (e: maplibregl.MapMouseEvent) => {
    const { lat, lng } = e.lngLat;
    const state = getState();
    const lines: string[] = [];
    if (state.allWindPoints.length > 0 && state.windVisible) {
      const wp = state.allWindPoints.find((p) => Math.abs(p.lat - lat) < 0.04 && Math.abs(p.lon - lng) < 0.04);
      if (wp) {
        const twsKn = Math.sqrt(wp.u * wp.u + wp.v * wp.v) * 1.94384;
        const twsFmt = _fmt(twsKn, 'speed', state.windSpeedMs);
        const dir = Math.round(((Math.atan2(-wp.u, -wp.v) * 180) / Math.PI + 360) % 360);
        lines.push(
          `Wind: ${twsFmt.num} ${twsFmt.sym} from ${String(dir)}°T<br><span style="font-size:10px;color:#a6adc8">${wp.lat.toFixed(4)}°N ${wp.lon.toFixed(4)}°E</span>`,
        );
      }
    }
    if (state.allWavePoints.length > 0 && state.waveVisible) {
      const wp = state.allWavePoints.find((p) => Math.abs(p.lat - lat) < 0.04 && Math.abs(p.lon - lng) < 0.04);
      if (wp) {
        const waveFmt = _fmt(wp.waveHeight, 'depth');
        lines.push(`Wave: ${waveFmt.num} ${waveFmt.sym}`);
      }
    }
    if (state.allCurrentPoints.length > 0 && state.currentVisible) {
      const cp = state.allCurrentPoints.find((p) => Math.abs(p.lat - lat) < 0.06 && Math.abs(p.lon - lng) < 0.06);
      if (cp) {
        const spdKn = (Math.sqrt(cp.u * cp.u + cp.v * cp.v) * 1.94384).toFixed(1);
        const dir = Math.round(((Math.atan2(cp.u, cp.v) * 180) / Math.PI + 360) % 360);
        lines.push(`Current: ${spdKn} kn → ${String(dir)}°T`);
      }
    }
    if (lines.length > 0)
      new maplibregl.Popup({ closeOnClick: true }).setLngLat([lng, lat]).setHTML(lines.join('<br>')).addTo(map);
  };
  map.on('click', handler);
  return () => {
    map.off('click', handler);
  };
}

// ── Viewport change handler ───────────────────────────────────────────────────

interface ViewportCallbacks {
  fetchWindPointsAt(timeIdx: number): void;
  fetchWavePointsAt(timeIdx: number): void;
  fetchCurrentPointsAt(timeMs: number): void;
  isWindTimesLoaded(): boolean;
  isWindVisible(): boolean;
  isWaveVisible(): boolean;
  isCurrentVisible(): boolean;
  getScrubberIndex(): number;
  getWindTimes(): string[];
}

/**
 * Re-fetch overlay data when the viewport changes. Returns a cleanup function.
 */
export function setupViewportRefresh(map: maplibregl.Map, cb: ViewportCallbacks): () => void {
  const handler = () => {
    const idx = cb.getScrubberIndex();
    if (cb.isWindVisible() && cb.isWindTimesLoaded()) {
      cb.fetchWindPointsAt(idx);
    }
    if (cb.isWaveVisible() && cb.isWindTimesLoaded()) {
      cb.fetchWavePointsAt(idx);
    }
    if (cb.isCurrentVisible() && cb.isWindTimesLoaded()) {
      const timeStr = cb.getWindTimes()[idx];
      if (timeStr !== undefined && timeStr !== '') cb.fetchCurrentPointsAt(new Date(timeStr).getTime());
    }
  };
  map.on('moveend', handler);
  return () => {
    map.off('moveend', handler);
  };
}
