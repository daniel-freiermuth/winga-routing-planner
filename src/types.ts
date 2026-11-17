// All shared TypeScript interfaces and data types for the plugin.

export interface LatLon {
  lat: number;
  lon: number;
}

export interface WindVector {
  u: number; // eastward m/s
  v: number; // northward m/s
}

export interface BoundingBox {
  readonly latMin: number;
  readonly latMax: number;
  readonly lonMin: number;
  readonly lonMax: number;
}

export interface PolarData {
  tws: number[]; // sorted ascending, knots
  twa: number[]; // sorted ascending, 0–180 degrees
  speeds: number[][]; // speeds[twaIdx][twsIdx], knots
}

export interface LandPolygon {
  bboxLatMin: number;
  bboxLatMax: number;
  bboxLonMin: number;
  bboxLonMax: number;
  exterior: Float64Array; // interleaved [lon0,lat0, lon1,lat1, ...]
}

// Spatial grid: cell key = (floor(lat)+90)*360 + (floor(lon)+180)
export interface LandIndex {
  polygons: LandPolygon[];
  grid: Map<number, number[]>; // cell key → polygon indices
}

// Edge-tile index for segment-crossing and point-on-land checks (built offline by scripts/prepare-land-data.py).
// edgeGrid: 0.1° cell key → flat Uint32Array of [polyIdx, edgeIdx, polyIdx, edgeIdx, ...].
// polyGrid: 1° cell key → polygon indices (same key formula as LandIndex.grid), for point-in-polygon checks.
export interface LandEdgeIndex {
  polygons: LandPolygon[];
  edgeGrid: Map<number, Uint32Array>;
  polyGrid: Map<number, number[]>;
}

export interface RoutePoint {
  lat: number;
  lon: number;
  time: Date;
  ctw: number; // course through water (degrees), before current drift
  twa: number; // degrees, 0–180
  tws: number; // true wind speed (knots), resampled at this waypoint's position and time
  boatSpeed?: number | undefined; // knots; undefined on the departure waypoint
  windDir: number; // meteorological: degrees FROM which wind blows, 0–360
  legCalcMs: number; // wall-clock ms the algorithm spent computing this leg; 0 for start and destination
  waveHeight?: number | undefined; // significant wave height (m), present when swh data available in GRIB
  gustKn?: number | undefined; // gust speed (knots), present when gust data available
  currentU?: number | undefined; // ocean current east component (m/s)
  currentV?: number | undefined; // ocean current north component (m/s)
  wavePeriod?: number | undefined; // mean wave period (seconds)
  waveDir?: number | undefined; // wave propagation direction (degrees from north)
  wowTws?: number | undefined; // wind-over-water speed (knots) = true wind - current
  wowDir?: number | undefined; // wind-over-water direction (degrees, meteorological FROM)
}

/** User-chosen routing constraints. A limit of 0 means "no limit". */
export interface RoutingPreferences {
  maxWindKn: number;
  maxWaveM: number; // the router rejects any value other than 0 until wave data reaches it
  motorSpeedKn: number; // 0 = no motoring
  motorBelowKn: number; // motor when sailing speed drops below this; 0 = never
  waitForWind: boolean;
  tackPenaltySec: number;
  tackThresholdDeg: number;
}

/** Full router configuration passed to the WASM RouterSession; field names match the Rust side. */
export interface RoutingOptions extends RoutingPreferences {
  headingStep: number;
  sectorSize: number;
  minBoatSpeed: number;
  coneHalfAngle: number;
  coneDisableLookaheadNm: number;
  maxHeadingChange: number;
  arrivalRadiusNm: number; // 0 = derived from step distance
}

export interface CalculationRequest {
  start: LatLon;
  end: LatLon;
  departureTime: string; // ISO 8601
  waypoints?: LatLon[]; // intermediate required waypoints in order
  useSafetyMargin?: boolean;
  useLandAvoidance?: boolean;
  enabledGribPaths?: string[]; // if absent, all files are used
  avoidRegionIds?: string[];
  options: RoutingPreferences;
}
