// GSHHG land polygon index: 1° grid of polygon bboxes, queried by bbox for the land overlay.

import type { LandPolygon, LandIndex } from '../types';

export function buildLandIndex(polygons: LandPolygon[]): LandIndex {
  const grid = new Map<number, number[]>();

  for (const [i, p] of polygons.entries()) {
    const latLo = Math.floor(p.bboxLatMin);
    const latHi = Math.floor(p.bboxLatMax);
    const lonLo = Math.floor(p.bboxLonMin);
    const lonHi = Math.floor(p.bboxLonMax);

    for (let la = latLo; la <= latHi; la++) {
      for (let lo = lonLo; lo <= lonHi; lo++) {
        const key = (la + 90) * 360 + (lo + 180);
        let cell = grid.get(key);
        if (!cell) {
          cell = [];
          grid.set(key, cell);
        }
        cell.push(i);
      }
    }
  }

  return { polygons, grid };
}

export function polygonsInBbox(
  index: LandIndex,
  latMin: number,
  lonMin: number,
  latMax: number,
  lonMax: number,
): LandPolygon[] {
  const seen = new Set<number>();
  const result: LandPolygon[] = [];
  for (let lat = Math.floor(latMin); lat <= Math.floor(latMax); lat++) {
    for (let lon = Math.floor(lonMin); lon <= Math.floor(lonMax); lon++) {
      const key = (lat + 90) * 360 + (lon + 180);
      for (const idx of index.grid.get(key) ?? []) {
        if (!seen.has(idx)) {
          seen.add(idx);
          const poly = index.polygons[idx];
          if (poly) result.push(poly);
        }
      }
    }
  }
  return result;
}
