// Shared type definitions for the weather routing webapp.

export interface WaypointMeta {
  name: string;
  time: string;
  windDir: number;
  ctw: number;
  twa: number;
  tws: number;
  boatSpeed?: number;
  waveHeight?: number;
  gustKn?: number;
  currentSpeedKn?: number;
  currentDir?: number; // degrees, direction current flows TOWARDS
  cogDeg?: number; // course over ground (degrees)
  sogKn?: number; // speed over ground (knots)
  wavePeriod?: number; // mean wave period (seconds)
  waveDir?: number; // wave propagation direction (degrees from north)
  wowTws?: number; // wind-over-water speed (knots)
  wowDir?: number; // wind-over-water direction (degrees, meteorological FROM)
}

export interface RouteData {
  feature: {
    type: string;
    geometry: { type: string; coordinates: number[][] };
    properties: { coordinatesMeta: WaypointMeta[] };
  };
}

export interface UnitPref {
  formula?: string;
  inverseFormula?: string;
  displayFormat?: string;
  symbol?: string;
}

export type UnitCategory = 'speed' | 'depth' | 'distance';
