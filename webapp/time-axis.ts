// Time axis management — builds the unified wind+current timeline,
// manages scrubber range, and handles Windy tile time loading.

import * as dataLayer from './data-layer';

interface TimeAxisManager {
  windTimes: string[];
  windTimesCount: number;
  windNativeTimes: string[];
  windTimesLoaded: boolean;
  actualWindTimes: string[] | null;
  currentFileTimes: string[];
  /** Route waypoint times to merge into the scrubber time grid. */
  routeWaypointTimes: string[];
}

/**
 * Create a new empty time axis manager.
 */
export function createTimeAxis(): TimeAxisManager {
  return {
    windTimes: [],
    windTimesCount: 0,
    windNativeTimes: [],
    windTimesLoaded: false,
    actualWindTimes: null,
    currentFileTimes: [],
    routeWaypointTimes: [],
  };
}

/**
 * Rebuild the unified time axis from Windy wind, current and route waypoint times.
 * Returns the new state; caller must apply it.
 */
export function rebuildTimes(mgr: TimeAxisManager): TimeAxisManager {
  const windArr = Array.from(new Set(mgr.actualWindTimes)).sort();
  const unifiedSet = new Set(windArr);
  for (const t of mgr.currentFileTimes) unifiedSet.add(t);
  // Merge route waypoint times so the scrubber can land on exact waypoint positions
  for (const t of mgr.routeWaypointTimes) unifiedSet.add(t);
  const unified = Array.from(unifiedSet).sort();

  const loaded = unified.length > 0;

  return {
    ...mgr,
    windTimes: unified,
    windTimesCount: windArr.length,
    windNativeTimes: windArr,
    windTimesLoaded: loaded,
  };
}

/**
 * Load forecast times from Windy CDN and return the initial time axis state.
 */
export async function loadWindyTimes(mgr: TimeAxisManager): Promise<TimeAxisManager> {
  const { windTimes: wt, currentTimes: ct } = await dataLayer.loadTimesFromWindy();
  const updated: TimeAxisManager = {
    ...mgr,
    actualWindTimes: wt,
    currentFileTimes: ct,
  };
  return rebuildTimes(updated);
}
