// Forecast data fetching — loads wind, wave, and current overlay data from Windy tiles.
// Pushes results into stores so overlay components react automatically.

import { windPoints, wavePoints, currentPoints, waveGridMetaStore } from './stores';
import * as dataLayer from './data-layer';
import type { WindPoint, WavePoint } from './stores';
import type { Map as MapLibreMap } from 'maplibre-gl';

/** State tracking for the time axis */
interface TimeAxisState {
  windTimes: string[];
  windNativeTimes: string[];
  windTimesLoaded: boolean;
}

let allWindPoints: WindPoint[] = [];
let allWavePoints: WavePoint[] = [];
let allCurrentPoints: { lat: number; lon: number; u: number; v: number }[] = [];

export function getWindPoints(): WindPoint[] {
  return allWindPoints;
}
export function getWavePoints(): WavePoint[] {
  return allWavePoints;
}
export function getCurrentPoints(): { lat: number; lon: number; u: number; v: number }[] {
  return allCurrentPoints;
}

export async function fetchWindPoints(
  timeIdx: number,
  timeAxis: TimeAxisState,
  map: MapLibreMap,
  signal?: AbortSignal,
): Promise<void> {
  if (!timeAxis.windTimesLoaded) return;
  const timeStr = timeAxis.windTimes[timeIdx];
  if (timeStr === undefined || timeStr === '') {
    allWindPoints = [];
    windPoints.set([]);
    return;
  }
  const bounds = map.getBounds();
  const bbox = {
    latMin: bounds.getSouth(),
    latMax: bounds.getNorth(),
    lonMin: bounds.getWest(),
    lonMax: bounds.getEast(),
  };
  try {
    if (timeAxis.windNativeTimes.includes(timeStr)) {
      // Native forecast step — fetch directly (no interpolation overhead)
      const nativeIdx = timeAxis.windNativeTimes.indexOf(timeStr);
      allWindPoints = await dataLayer.fetchWindGrid(nativeIdx, bbox, signal);
    } else {
      // Non-native time — interpolate between bracketing steps
      const timeMs = new Date(timeStr).getTime();
      allWindPoints = await dataLayer.fetchWindGridAtTime(timeMs, bbox, signal);
    }
    windPoints.set(allWindPoints);
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AbortError') return;
    throw e;
  }
}

export async function fetchWavePoints(
  timeIdx: number,
  timeAxis: TimeAxisState,
  map: MapLibreMap,
  signal?: AbortSignal,
): Promise<void> {
  if (!timeAxis.windTimesLoaded) return;
  const timeStr = timeAxis.windTimes[timeIdx];
  if (timeStr === undefined || timeStr === '') {
    allWavePoints = [];
    wavePoints.set([]);
    return;
  }
  const bounds = map.getBounds();
  const bbox = {
    latMin: bounds.getSouth(),
    latMax: bounds.getNorth(),
    lonMin: bounds.getWest(),
    lonMax: bounds.getEast(),
  };
  try {
    let result: { points: { lat: number; lon: number; waveHeight: number }[]; timeMs: number };
    if (timeAxis.windNativeTimes.includes(timeStr)) {
      const nativeIdx = timeAxis.windNativeTimes.indexOf(timeStr);
      result = await dataLayer.fetchWaveGrid(nativeIdx, bbox, signal);
    } else {
      const timeMs = new Date(timeStr).getTime();
      result = await dataLayer.fetchWaveGridAtTime(timeMs, bbox, signal);
    }
    allWavePoints = result.points;
    wavePoints.set(allWavePoints);
    if (allWavePoints.length > 0) {
      const lats = allWavePoints.map((p) => p.lat);
      const lons = allWavePoints.map((p) => p.lon);
      waveGridMetaStore.set({
        latMin: Math.min(...lats),
        latMax: Math.max(...lats),
        lonMin: Math.min(...lons),
        lonMax: Math.max(...lons),
        latStep: 0.5,
        lonStep: 0.5,
      });
    }
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AbortError') return;
    throw e;
  }
}

export async function fetchCurrentPoints(timeMs: number, map: MapLibreMap, signal?: AbortSignal): Promise<void> {
  const bounds = map.getBounds();
  const bbox = {
    latMin: bounds.getSouth(),
    latMax: bounds.getNorth(),
    lonMin: bounds.getWest(),
    lonMax: bounds.getEast(),
  };
  try {
    allCurrentPoints = await dataLayer.fetchCurrentGrid(timeMs, bbox, signal);
    currentPoints.set(allCurrentPoints);
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AbortError') return;
    throw e;
  }
}
