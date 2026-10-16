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

// Metadata read from a GRIB file at startup — no grid data loaded yet.
export interface GribFileMeta {
  path: string;
  mtime: number; // file modification time, ms since epoch (used for conflict resolution)
  type: 'wind' | 'current';
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
  latStep: number;
  lonStep: number;
  timeStart: Date;
  timeEnd: Date;
  nTimes: number;
  referenceTime: Date; // model run time (GRIB_REF_TIME of first wind or current band)
  hasWave?: boolean; // true when the file contains wave bands (HTSGW) — usually combined wind+wave EWAM files
}

// One entry per wind GRIB file; data is null until lazy-loaded at calculation time.
export interface GribFileEntry {
  meta: GribFileMeta; // type === 'wind'
  data: GribData | null;
}

// Provides ocean current lookups for use by the routing algorithm.
export interface CurrentProvider {
  getCurrent(lat: number, lon: number, t: Date): WindVector; // {u:0,v:0} when outside domain
  readonly times: Date[];
  readonly meta: GribFileMeta;
}

// Abstraction over wind/wave data; used by the routing algorithm.
// Coverage checking is handled by the WASM routing engine (WeatherStore::covers),
// not by the provider — the provider only samples data at requested positions.
export interface WindProvider {
  readonly times: Date[]; // merged, sorted, deduplicated time axis across all files
  getWind(lat: number, lon: number, timeIdx: number): WindVector;
  /** Wind at continuous time (ms) with temporal interpolation */
  getWindAtTime(lat: number, lon: number, timeMs: number): WindVector;
  getWave(lat: number, lon: number, t: Date): number | undefined;
  /** Wave height at continuous time (ms) */
  getWaveAtTime?(lat: number, lon: number, timeMs: number): number | undefined;
  /** Gust speed at continuous time (ms) with temporal interpolation, in m/s */
  getGustAtTime?(lat: number, lon: number, timeMs: number): number | undefined;
  /** Mean wave period at continuous time (ms) with temporal interpolation, in seconds */
  getWavePeriodAtTime?(lat: number, lon: number, timeMs: number): number | undefined;
  /** Wave propagation direction at continuous time (ms), degrees from north */
  getWaveDirAtTime?(lat: number, lon: number, timeMs: number): number | undefined;
  /** Fetch tiles on-demand for a specific time step. Call before each algorithm step. */
  prefetchForTime?(timeMs: number): Promise<void>;
}

export interface GribData {
  times: Date[];
  latMin: number;
  latStep: number;
  lonMin: number;
  lonStep: number;
  nLat: number;
  nLon: number;
  u10: Float32Array[]; // [timeIdx][latIdx * nLon + lonIdx], m/s, index 0 = latMin
  v10: Float32Array[];
  swhByTime?: Map<number, Float32Array>; // validTimeMs → swh grid (m), same layout as u10
  // Present when wave data was loaded from a different grid than wind data (mixed-grid files).
  swhGrid?: { latMin: number; latStep: number; lonMin: number; lonStep: number; nLat: number; nLon: number };
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
  gribFilePath?: string | undefined; // path of the GRIB file that supplied weather data at this waypoint
  gustKn?: number | undefined; // gust speed (knots), present when gust data available
  currentU?: number | undefined; // ocean current east component (m/s)
  currentV?: number | undefined; // ocean current north component (m/s)
  wavePeriod?: number | undefined; // mean wave period (seconds)
  waveDir?: number | undefined; // wave propagation direction (degrees from north)
  wowTws?: number | undefined; // wind-over-water speed (knots) = true wind - current
  wowDir?: number | undefined; // wind-over-water direction (degrees, meteorological FROM)
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
  options?: Record<string, unknown>; // per-algorithm tuning
}
