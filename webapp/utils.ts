// Pure utility functions shared across the webapp.

/** Converts a Date to a datetime-local input value string. */
export function toLocalDateTimeInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const DEG = Math.PI / 180;

/** Geodesic initial bearing (great-circle formula). */
function geodesicBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const φ1 = lat1 * DEG,
    φ2 = lat2 * DEG,
    dλ = (lon2 - lon1) * DEG;
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return Math.atan2(y, x) / DEG; // degrees, -180..+180
}

/**
 * Sort frontier points by bearing from origin (for isochrone rendering).
 */
export function sortByBearing(pts: number[][], origin: { lat: number; lon: number }): number[][] {
  return pts.slice().sort(
    (a, b) =>
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- GeoJSON coordinate positions guaranteed to exist
      geodesicBearing(origin.lat, origin.lon, a[0]!, a[1]!) - geodesicBearing(origin.lat, origin.lon, b[0]!, b[1]!),
  );
}

/**
 * Split sorted ring at angular gaps larger than threshold.
 * Merges the last segment into the first if the wrap-around gap is within threshold.
 */
export function splitByAngularGap(
  pts: number[][],
  origin: { lat: number; lon: number },
  thresholdDeg: number,
): number[][][] {
  if (pts.length < 2) return [pts];
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- GeoJSON coordinate positions guaranteed to exist
  const bearing = (p: number[]) => geodesicBearing(origin.lat, origin.lon, p[0]!, p[1]!);
  const bearings = pts.map(bearing);
  const angularGap = (a: number, b: number) => ((b - a + 540) % 360) - 180;
  const segments: number[][][] = [];
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- pts.length >= 2 checked above
  let current: number[][] = [pts[0]!];
  for (let i = 1; i < pts.length; i++) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- i and i-1 are valid indices within loop bounds
    if (angularGap(bearings[i - 1]!, bearings[i]!) > thresholdDeg) {
      segments.push(current);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- i < pts.length in loop bound
      current = [pts[i]!];
    } else {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- i < pts.length in loop bound
      current.push(pts[i]!);
    }
  }
  segments.push(current);
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- bearings has pts.length >= 2 entries
  if (segments.length > 1 && angularGap(bearings[bearings.length - 1]!, bearings[0]! + 360) <= thresholdDeg) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- segments always has at least one entry
    segments[0] = [...segments[segments.length - 1]!, ...segments[0]!];
    segments.pop();
  }
  return segments;
}
