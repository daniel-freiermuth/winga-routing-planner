// Free-text coordinate parser: turns typed waypoint text ("N57.68 E11.87", "57.68, 11.87") into a lat/lon pair.

const MAX_ABS_LAT = 90;
const MAX_ABS_LON = 180;

export function tryParseCoords(text: string): { lat: number; lon: number } | null {
  const trimmed = text.trim();
  // Try "N57.68 E11.87" or "S57.68 W11.87" style
  const dirMatch = /^([NSns])?\s*(-?\d+\.?\d*)\s*[,\s]+\s*([EWew])?\s*(-?\d+\.?\d*)$/.exec(trimmed);
  if (dirMatch) {
    let lat = parseFloat(dirMatch[2] ?? '');
    let lon = parseFloat(dirMatch[4] ?? '');
    if (dirMatch[1]?.toLowerCase() === 's') lat = -lat;
    if (dirMatch[3]?.toLowerCase() === 'w') lon = -lon;
    if (isFinite(lat) && isFinite(lon) && Math.abs(lat) <= MAX_ABS_LAT && Math.abs(lon) <= MAX_ABS_LON) {
      return { lat, lon };
    }
  }
  // Try plain "57.68, 11.87" or "57.68 11.87"
  const plainMatch = /^(-?\d+\.?\d*)\s*[,\s]+\s*(-?\d+\.?\d*)$/.exec(trimmed);
  if (plainMatch) {
    const lat = parseFloat(plainMatch[1] ?? '');
    const lon = parseFloat(plainMatch[2] ?? '');
    if (isFinite(lat) && isFinite(lon) && Math.abs(lat) <= MAX_ABS_LAT && Math.abs(lon) <= MAX_ABS_LON) {
      return { lat, lon };
    }
  }
  return null;
}
