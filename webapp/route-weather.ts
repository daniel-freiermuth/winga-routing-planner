// Route weather analysis — compute ETAs and forecast conditions along a fixed route.
//
// Given a route (array of waypoints), a departure time, and a polar diagram,
// steps through each leg computing:
//   1. Leg bearing and distance (haversine)
//   2. Forecast wind at the leg start point at the estimated time
//   3. True wind angle (TWA) from bearing vs wind direction
//   4. Boat speed from the polar for that TWA + TWS
//   5. Leg duration → cumulative ETA at each waypoint
//   6. Wave height and current at each waypoint at its ETA
//
// Returns an array of per-waypoint results for display.

import { haversineNM, bearingTo, windSpeedKnots, windDirection, currentDirection } from '../src/lib/geo';
import { parsePolarCsv, interpolateBoatSpeed } from '../src/lib/polar';
import * as dataLayer from './data-layer';

export interface WaypointWeather {
  idx: number;
  lat: number;
  lon: number;
  eta: string;
  etaMs: number;
  legDistNm: number;
  legDurationH: number;
  cumDistNm: number;
  cumDurationH: number;
  twsKn: number | null;
  gustKn: number | null;
  twdDeg: number | null;
  twaAbs: number | null;
  boatSpeedKn: number | null;
  waveHeightM: number | null;
  currentSpeedKn: number | null;
  currentDirDeg: number | null;
}

/**
 * Analyse weather conditions along a fixed route.
 *
 * @param {Array<{lat: number, lon: number}>} waypoints  Route waypoints in order
 * @param {number} departureMs  Departure time in ms since epoch
 * @param {string} polarCsv    Polar diagram CSV content
 * @param {(pct: number) => void} [onProgress]  Progress callback (0-100)
 * @returns {Promise<WaypointWeather[]>}
 */
export async function analyseRouteWeather(
  waypoints: { lat: number; lon: number }[],
  departureMs: number,
  polarCsv: string,
  onProgress?: (pct: number) => void,
): Promise<WaypointWeather[]> {
  if (waypoints.length < 2) return [];

  const polar = parsePolarCsv(polarCsv);
  const results: WaypointWeather[] = [];
  let currentTimeMs = departureMs;
  let cumDistNm = 0;
  let cumDurationH = 0;

  for (let i = 0; i < waypoints.length; i++) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const wp = waypoints[i]!;
    if (onProgress) onProgress(Math.round((i / waypoints.length) * 100));

    // Compute arrival time at this waypoint before querying weather
    let legDistNm = 0;
    let legDurationH = 0;
    if (i > 0) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const prev = waypoints[i - 1]!;
      legDistNm = haversineNM(prev.lat, prev.lon, wp.lat, wp.lon);
      // Duration for this leg: use the boat speed computed at the PREVIOUS waypoint
      const prevResult = results[i - 1];
      const prevSpeed = prevResult?.boatSpeedKn;
      if (prevSpeed != null && prevSpeed > 0.1) {
        legDurationH = legDistNm / prevSpeed;
      } else {
        // No wind / can't sail — assume 3 kn motoring as fallback
        legDurationH = legDistNm / 3;
      }
      cumDistNm += legDistNm;
      cumDurationH += legDurationH;
      currentTimeMs = departureMs + cumDurationH * 3_600_000;
    }

    // Query weather at this waypoint at the estimated arrival time
    const wx = await dataLayer.queryPointWeather(wp.lat, wp.lon, currentTimeMs);

    const twsKn = wx.wind ? windSpeedKnots(wx.wind.u, wx.wind.v) : null;
    const twdDeg = wx.wind ? windDirection(wx.wind.u, wx.wind.v) : null;

    const currentSpeedKn = wx.current ? windSpeedKnots(wx.current.u, wx.current.v) : null;
    const currentDirDeg = wx.current ? currentDirection(wx.current.u, wx.current.v) : null;

    // Compute leg info for the NEXT leg (from this waypoint to the next)
    let twaAbs = null;
    let boatSpeedKn = null;

    if (i < waypoints.length - 1 && twdDeg !== null && twsKn !== null) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const nextWp = waypoints[i + 1]!;
      const bearing = bearingTo(wp.lat, wp.lon, nextWp.lat, nextWp.lon);
      let twa = (bearing - twdDeg + 360) % 360;
      if (twa > 180) twa = 360 - twa;
      twaAbs = Math.round(twa);
      boatSpeedKn = Math.round(interpolateBoatSpeed(polar, twa, twsKn) * 10) / 10;
    }

    const gustKn = wx.gustMs !== null ? Math.round(wx.gustMs * 1.94384 * 10) / 10 : null;

    results.push({
      idx: i,
      lat: wp.lat,
      lon: wp.lon,
      eta: new Date(currentTimeMs).toISOString(),
      etaMs: currentTimeMs,
      legDistNm: Math.round(legDistNm * 10) / 10,
      legDurationH: Math.round(legDurationH * 10) / 10,
      cumDistNm: Math.round(cumDistNm * 10) / 10,
      cumDurationH: Math.round(cumDurationH * 10) / 10,
      twsKn: twsKn !== null ? Math.round(twsKn * 10) / 10 : null,
      gustKn,
      twdDeg: twdDeg !== null ? Math.round(twdDeg) : null,
      twaAbs,
      boatSpeedKn,
      waveHeightM: wx.waveHeightM !== null ? Math.round(wx.waveHeightM * 10) / 10 : null,
      currentSpeedKn: currentSpeedKn !== null ? Math.round(currentSpeedKn * 100) / 100 : null,
      currentDirDeg: currentDirDeg !== null ? Math.round(currentDirDeg) : null,
    });
  }

  if (onProgress) onProgress(100);
  return results;
}
