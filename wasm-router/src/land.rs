// Land index — spatial grid over coastline polygons for fast land-crossing
// and point-on-land checks. Parses the binary land-edge-index format produced
// by the TypeScript `buildEdgeIndex` pipeline and consumed by `landmask.ts`.

use std::collections::HashMap;

/// Resolution of the edge grid in degrees.
const EDGE_CELL_DEG: f64 = 0.1;

/// A single coastline polygon with bounding box and exterior ring.
struct LandPolygon {
    bbox_lat_min: f64,
    bbox_lat_max: f64,
    bbox_lon_min: f64,
    bbox_lon_max: f64,
    /// Interleaved [lon0, lat0, lon1, lat1, ...] — same layout as the TS Float64Array.
    exterior: Vec<f64>,
}

/// Spatial index over coastline polygons for segment-crossing and point-in-polygon queries.
///
/// Two grid levels:
/// - `edge_grid` — 0.1° cells mapping to polygon-edge pairs for `segment_crosses_land`.
/// - `poly_grid` — 1° cells mapping to polygon indices for `is_on_land`.
pub(crate) struct LandIndex {
    polygons: Vec<LandPolygon>,
    /// 0.1° cell key → flat [poly_idx, edge_idx, ...] pairs.
    edge_grid: HashMap<u32, Vec<u32>>,
    /// 1° cell key → polygon indices.
    poly_grid: HashMap<u32, Vec<u32>>,
}

// ── helpers ──────────────────────────────────────────────────────────────────

/// Read a little-endian u32 from `buf` at `off`.
#[inline]
fn read_u32_le(buf: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]])
}

/// Read a big-endian f64 from `buf` at `off`.
#[inline]
fn read_f64_be(buf: &[u8], off: usize) -> f64 {
    f64::from_be_bytes([
        buf[off],
        buf[off + 1],
        buf[off + 2],
        buf[off + 3],
        buf[off + 4],
        buf[off + 5],
        buf[off + 6],
        buf[off + 7],
    ])
}

/// Read a native-endian (little-endian on WASM/x86) f64 from `buf` at `off`.
#[inline]
fn read_f64_le(buf: &[u8], off: usize) -> f64 {
    f64::from_le_bytes([
        buf[off],
        buf[off + 1],
        buf[off + 2],
        buf[off + 3],
        buf[off + 4],
        buf[off + 5],
        buf[off + 6],
        buf[off + 7],
    ])
}

/// Edge-grid cell key matching the TS `edgeCellKey`:
/// `(latCell + 900) * 3600 + (((lonCell % 3600) + 3600) % 3600)`
#[inline]
fn edge_cell_key(lat_cell: i32, lon_cell: i32) -> u32 {
    let lon_wrapped = lon_cell.rem_euclid(3600);
    ((lat_cell + 900) as u32) * 3600 + lon_wrapped as u32
}

/// Poly-grid cell key: `(floor(lat) + 90) * 360 + (floor(lon) + 180)`.
#[inline]
fn poly_cell_key(lat: f64, lon: f64) -> u32 {
    let la = lat.floor() as i32;
    let lo = lon.floor() as i32;
    ((la + 90) as u32) * 360 + ((lo + 180) as u32)
}

/// Parametric segment-segment intersection matching the TS `segmentsIntersect`.
/// Arguments are (x=lon, y=lat) order.
#[inline]
fn segments_intersect(
    x1: f64,
    y1: f64,
    x2: f64,
    y2: f64,
    x3: f64,
    y3: f64,
    x4: f64,
    y4: f64,
) -> bool {
    let d1x = x2 - x1;
    let d1y = y2 - y1;
    let d2x = x4 - x3;
    let d2y = y4 - y3;
    let cross = d1x * d2y - d1y * d2x;
    if cross.abs() < 1e-12 {
        return false;
    }
    let dx = x3 - x1;
    let dy = y3 - y1;
    let t = (dx * d2y - dy * d2x) / cross;
    let u = (dx * d1y - dy * d1x) / cross;
    t > 0.0 && t < 1.0 && u > 0.0 && u < 1.0
}

/// Ray-cast point-in-ring test matching the TS `pointInRing`.
/// Ring is interleaved [lon, lat, lon, lat, ...].
#[inline]
fn point_in_ring(lat: f64, lon: f64, ring: &[f64]) -> bool {
    let n = ring.len() / 2;
    if n == 0 {
        return false;
    }
    let mut inside = false;
    let mut xj = ring[(n - 1) * 2];
    let mut yj = ring[(n - 1) * 2 + 1];
    for i in 0..n {
        let xi = ring[i * 2];
        let yi = ring[i * 2 + 1];
        if (yi > lat) != (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        xj = xi;
        yj = yi;
    }
    inside
}

// ── public API ───────────────────────────────────────────────────────────────

const EDGE_INDEX_MAGIC: u32 = 0x4c4e4458; // 'LNDX'
const DILATED_INDEX_MAGIC: u32 = 0x444c4e44; // 'DLND'
const EDGE_INDEX_VERSION: u32 = 2;

impl LandIndex {
    /// Parse a `LandIndex` from the binary land-edge-index buffer.
    ///
    /// Accepts both LNDX (`0x4c4e4458`) and DLND (`0x444c4e44`) magic, version 2.
    /// Layout mirrors the TypeScript `parseIndexFromArrayBuffer` byte for byte.
    pub fn from_binary(buf: &[u8]) -> Result<Self, String> {
        if buf.len() < 32 {
            return Err("Land index buffer too short for header".into());
        }

        let magic = read_u32_le(buf, 0);
        if magic != EDGE_INDEX_MAGIC && magic != DILATED_INDEX_MAGIC {
            return Err(format!(
                "Invalid land index: bad magic 0x{magic:08x} (expected LNDX or DLND)"
            ));
        }

        let version = read_u32_le(buf, 4);
        if version != EDGE_INDEX_VERSION {
            return Err(format!(
                "Unsupported land index version {version} (expected {EDGE_INDEX_VERSION})"
            ));
        }

        let n_polygons = read_u32_le(buf, 16) as usize;
        let n_edge_cells = read_u32_le(buf, 20) as usize;
        let n_poly_cells = read_u32_le(buf, 24) as usize;
        let mut off: usize = 32;

        // ── polygons ─────────────────────────────────────────────────────
        let mut polygons = Vec::with_capacity(n_polygons);
        for _ in 0..n_polygons {
            if off + 40 > buf.len() {
                return Err("Buffer truncated in polygon header".into());
            }
            let bbox_lat_min = read_f64_be(buf, off);
            let bbox_lat_max = read_f64_be(buf, off + 8);
            let bbox_lon_min = read_f64_be(buf, off + 16);
            let bbox_lon_max = read_f64_be(buf, off + 24);
            let n_floats = read_u32_le(buf, off + 32) as usize;
            off += 40; // 4×f64 + u32 + 4-byte pad

            let byte_len = n_floats * 8;
            if off + byte_len > buf.len() {
                return Err("Buffer truncated in polygon ring data".into());
            }
            let mut exterior = Vec::with_capacity(n_floats);
            for i in 0..n_floats {
                exterior.push(read_f64_le(buf, off + i * 8));
            }
            off += byte_len;

            polygons.push(LandPolygon {
                bbox_lat_min,
                bbox_lat_max,
                bbox_lon_min,
                bbox_lon_max,
                exterior,
            });
        }

        // ── edge grid ────────────────────────────────────────────────────
        let mut edge_grid = HashMap::with_capacity(n_edge_cells);
        for _ in 0..n_edge_cells {
            if off + 8 > buf.len() {
                return Err("Buffer truncated in edge grid header".into());
            }
            let key = read_u32_le(buf, off);
            let n_entries = read_u32_le(buf, off + 4) as usize;
            off += 8;

            let byte_len = n_entries * 4;
            if off + byte_len > buf.len() {
                return Err("Buffer truncated in edge grid data".into());
            }
            let mut entries = Vec::with_capacity(n_entries);
            for i in 0..n_entries {
                entries.push(read_u32_le(buf, off + i * 4));
            }
            off += byte_len;

            edge_grid.insert(key, entries);
        }

        // ── poly grid ────────────────────────────────────────────────────
        let mut poly_grid = HashMap::with_capacity(n_poly_cells);
        for _ in 0..n_poly_cells {
            if off + 8 > buf.len() {
                return Err("Buffer truncated in poly grid header".into());
            }
            let key = read_u32_le(buf, off);
            let n_polys = read_u32_le(buf, off + 4) as usize;
            off += 8;

            let byte_len = n_polys * 4;
            if off + byte_len > buf.len() {
                return Err("Buffer truncated in poly grid data".into());
            }
            let mut polys = Vec::with_capacity(n_polys);
            for i in 0..n_polys {
                polys.push(read_u32_le(buf, off + i * 4));
            }
            off += byte_len;

            poly_grid.insert(key, polys);
        }

        Ok(LandIndex {
            polygons,
            edge_grid,
            poly_grid,
        })
    }

    /// Check whether the segment from (`lat1`, `lon1`) to (`lat2`, `lon2`) crosses
    /// any land polygon edge.
    ///
    /// Uses a DDA grid walk over 0.1° edge-grid cells with parametric
    /// segment-segment intersection tests. Does **not** check whether the
    /// endpoints themselves are inside a polygon — call [`is_on_land`] for that.
    pub fn segment_crosses_land(&self, lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> bool {
        let d = EDGE_CELL_DEG;
        let mut lat_cell = (lat1 / d).floor() as i32;
        let mut lon_cell = (lon1 / d).floor() as i32;
        let lat_end = (lat2 / d).floor() as i32;
        let lon_end = (lon2 / d).floor() as i32;

        let d_lat = lat2 - lat1;
        let d_lon = lon2 - lon1;

        let s_lat: i32 = if d_lat > 0.0 {
            1
        } else if d_lat < 0.0 {
            -1
        } else {
            0
        };
        let s_lon: i32 = if d_lon > 0.0 {
            1
        } else if d_lon < 0.0 {
            -1
        } else {
            0
        };

        let td_lat = if s_lat != 0 {
            (d / d_lat).abs()
        } else {
            f64::INFINITY
        };
        let td_lon = if s_lon != 0 {
            (d / d_lon).abs()
        } else {
            f64::INFINITY
        };

        let mut tm_lat = if s_lat > 0 {
            ((lat_cell + 1) as f64 * d - lat1) / d_lat
        } else if s_lat < 0 {
            (lat_cell as f64 * d - lat1) / d_lat
        } else {
            f64::INFINITY
        };
        let mut tm_lon = if s_lon > 0 {
            ((lon_cell + 1) as f64 * d - lon1) / d_lon
        } else if s_lon < 0 {
            (lon_cell as f64 * d - lon1) / d_lon
        } else {
            f64::INFINITY
        };

        let max_cells =
            (lat_end - lat_cell).unsigned_abs() + (lon_end - lon_cell).unsigned_abs() + 1;

        for _ in 0..max_cells {
            let key = edge_cell_key(lat_cell, lon_cell);
            if let Some(entries) = self.edge_grid.get(&key) {
                let mut i = 0;
                while i + 1 < entries.len() {
                    let pi = entries[i] as usize;
                    let ei = entries[i + 1] as usize;
                    i += 2;
                    if let Some(poly) = self.polygons.get(pi) {
                        let ring = &poly.exterior;
                        let nv = ring.len() / 2;
                        if nv == 0 {
                            continue;
                        }
                        let ni = if ei + 1 < nv { ei + 1 } else { 0 };
                        let x3 = ring[ei * 2];
                        let y3 = ring[ei * 2 + 1];
                        let x4 = ring[ni * 2];
                        let y4 = ring[ni * 2 + 1];
                        if segments_intersect(lon1, lat1, lon2, lat2, x3, y3, x4, y4) {
                            return true;
                        }
                    }
                }
            }
            if lat_cell == lat_end && lon_cell == lon_end {
                break;
            }
            if tm_lat < tm_lon {
                tm_lat += td_lat;
                lat_cell += s_lat;
            } else {
                tm_lon += td_lon;
                lon_cell += s_lon;
            }
        }

        false
    }

    /// Check whether a point is inside any land polygon.
    ///
    /// Uses 1° poly-grid lookup to find candidates, then a ray-cast
    /// point-in-ring test on each candidate's exterior ring.
    pub fn is_on_land(&self, lat: f64, lon: f64) -> bool {
        let key = poly_cell_key(lat, lon);
        let candidates = match self.poly_grid.get(&key) {
            Some(c) => c,
            None => return false,
        };
        for &pi in candidates {
            if let Some(poly) = self.polygons.get(pi as usize) {
                if lat < poly.bbox_lat_min || lat > poly.bbox_lat_max {
                    continue;
                }
                if lon < poly.bbox_lon_min || lon > poly.bbox_lon_max {
                    continue;
                }
                if point_in_ring(lat, lon, &poly.exterior) {
                    return true;
                }
            }
        }
        false
    }
}

#[cfg(test)]
impl LandIndex {
    fn empty() -> Self {
        Self {
            polygons: Vec::new(),
            edge_grid: HashMap::new(),
            poly_grid: HashMap::new(),
        }
    }
}

// ── tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal binary buffer for testing.
    /// One triangle polygon at (lon,lat): (1,1)→(3,1)→(2,3)→(1,1).
    /// One edge-grid cell, one poly-grid cell.
    fn build_test_binary() -> Vec<u8> {
        let mut buf = Vec::new();

        // ── header (32 bytes) ────────────────────────────────────────
        buf.extend_from_slice(&EDGE_INDEX_MAGIC.to_le_bytes()); // magic
        buf.extend_from_slice(&EDGE_INDEX_VERSION.to_le_bytes()); // version
        buf.extend_from_slice(&[0u8; 8]); // reserved
        buf.extend_from_slice(&1u32.to_le_bytes()); // n_polygons
        buf.extend_from_slice(&1u32.to_le_bytes()); // n_edge_cells
        buf.extend_from_slice(&1u32.to_le_bytes()); // n_poly_cells
        buf.extend_from_slice(&[0u8; 4]); // padding
        assert_eq!(buf.len(), 32);

        // ── polygon: triangle (1,1)→(3,1)→(2,3)→(1,1) ──────────────
        // ring in [lon, lat] pairs: 4 vertices (closed)
        let ring: &[(f64, f64)] = &[(1.0, 1.0), (3.0, 1.0), (2.0, 3.0), (1.0, 1.0)];
        let n_floats = (ring.len() * 2) as u32; // 8 f64 values

        // bbox (BE f64): lat_min=1, lat_max=3, lon_min=1, lon_max=3
        buf.extend_from_slice(&1.0_f64.to_be_bytes()); // bbox_lat_min
        buf.extend_from_slice(&3.0_f64.to_be_bytes()); // bbox_lat_max
        buf.extend_from_slice(&1.0_f64.to_be_bytes()); // bbox_lon_min
        buf.extend_from_slice(&3.0_f64.to_be_bytes()); // bbox_lon_max
        buf.extend_from_slice(&n_floats.to_le_bytes()); // n_floats (LE u32)
        buf.extend_from_slice(&[0u8; 4]); // padding
        // ring data: native LE f64 — interleaved [lon, lat]
        for &(lon, lat) in ring {
            buf.extend_from_slice(&lon.to_le_bytes());
            buf.extend_from_slice(&lat.to_le_bytes());
        }

        // ── edge grid: 1 cell ────────────────────────────────────────
        // Put edge 0 (vertex 0→1, the bottom edge lat=1 from lon 1→3)
        // into a cell that covers lat=1, lon=2 → lat_cell=10, lon_cell=20
        let cell_key = edge_cell_key(10, 20);
        buf.extend_from_slice(&cell_key.to_le_bytes()); // key
        buf.extend_from_slice(&2u32.to_le_bytes()); // n_entries (1 pair = 2 u32s)
        buf.extend_from_slice(&0u32.to_le_bytes()); // poly_idx
        buf.extend_from_slice(&0u32.to_le_bytes()); // edge_idx

        // ── poly grid: 1 cell ────────────────────────────────────────
        // 1° cell covering lat=2, lon=2 → key = (2+90)*360 + (2+180)
        let poly_key = poly_cell_key(2.0, 2.0);
        buf.extend_from_slice(&poly_key.to_le_bytes()); // key
        buf.extend_from_slice(&1u32.to_le_bytes()); // n_polys
        buf.extend_from_slice(&0u32.to_le_bytes()); // poly_idx

        buf
    }

    #[test]
    fn empty_index_no_land() {
        let idx = LandIndex::empty();
        assert!(!idx.segment_crosses_land(0.0, 0.0, 1.0, 1.0));
        assert!(!idx.is_on_land(0.0, 0.0));
    }

    #[test]
    fn parse_binary_valid() {
        let buf = build_test_binary();
        let idx = LandIndex::from_binary(&buf).expect("parse should succeed");
        assert_eq!(idx.polygons.len(), 1);
        let poly = &idx.polygons[0];
        assert_eq!(poly.bbox_lat_min, 1.0);
        assert_eq!(poly.bbox_lat_max, 3.0);
        assert_eq!(poly.bbox_lon_min, 1.0);
        assert_eq!(poly.bbox_lon_max, 3.0);
        assert_eq!(poly.exterior.len(), 8); // 4 vertices × 2
        // First vertex: (lon=1, lat=1)
        assert_eq!(poly.exterior[0], 1.0);
        assert_eq!(poly.exterior[1], 1.0);
        assert_eq!(idx.edge_grid.len(), 1);
        assert_eq!(idx.poly_grid.len(), 1);
    }

    #[test]
    fn parse_binary_dlnd_magic() {
        let mut buf = build_test_binary();
        // Overwrite magic with DLND
        buf[0..4].copy_from_slice(&DILATED_INDEX_MAGIC.to_le_bytes());
        assert!(LandIndex::from_binary(&buf).is_ok());
    }

    #[test]
    fn parse_binary_invalid_magic() {
        let mut buf = build_test_binary();
        buf[0..4].copy_from_slice(&0xDEADBEEFu32.to_le_bytes());
        match LandIndex::from_binary(&buf) {
            Err(e) => assert!(e.contains("bad magic"), "unexpected error: {e}"),
            Ok(_) => panic!("expected error for invalid magic"),
        }
    }

    #[test]
    fn parse_binary_wrong_version() {
        let mut buf = build_test_binary();
        buf[4..8].copy_from_slice(&99u32.to_le_bytes());
        match LandIndex::from_binary(&buf) {
            Err(e) => assert!(e.contains("version"), "unexpected error: {e}"),
            Ok(_) => panic!("expected error for wrong version"),
        }
    }

    /// Build an index programmatically for geometry tests. Triangle at
    /// (lon,lat): (1,1)→(3,1)→(2,3)→(1,1) with all edges in the grid.
    fn build_test_index() -> LandIndex {
        // Ring: 4 vertices (closed), interleaved [lon, lat]
        let exterior = vec![1.0, 1.0, 3.0, 1.0, 2.0, 3.0, 1.0, 1.0];
        let poly = LandPolygon {
            bbox_lat_min: 1.0,
            bbox_lat_max: 3.0,
            bbox_lon_min: 1.0,
            bbox_lon_max: 3.0,
            exterior,
        };

        // Insert all 4 edges into every 0.1° cell they touch.
        // Edges: 0→1 (bottom), 1→2 (right), 2→3 (left, same as 2→0 due to closure).
        let mut edge_grid: HashMap<u32, Vec<u32>> = HashMap::new();
        let ring = &poly.exterior;
        let nv = ring.len() / 2;
        for ei in 0..nv {
            let ni = if ei + 1 < nv { ei + 1 } else { 0 };
            let lon_a = ring[ei * 2];
            let lat_a = ring[ei * 2 + 1];
            let lon_b = ring[ni * 2];
            let lat_b = ring[ni * 2 + 1];
            // Rasterize this edge into 0.1° cells (simple bbox approach).
            let lat_lo = (lat_a.min(lat_b) / EDGE_CELL_DEG).floor() as i32;
            let lat_hi = (lat_a.max(lat_b) / EDGE_CELL_DEG).floor() as i32;
            let lon_lo = (lon_a.min(lon_b) / EDGE_CELL_DEG).floor() as i32;
            let lon_hi = (lon_a.max(lon_b) / EDGE_CELL_DEG).floor() as i32;
            for la in lat_lo..=lat_hi {
                for lo in lon_lo..=lon_hi {
                    let key = edge_cell_key(la, lo);
                    let cell = edge_grid.entry(key).or_default();
                    cell.push(0); // poly_idx
                    cell.push(ei as u32); // edge_idx
                }
            }
        }

        // Poly grid: cover every 1° cell the bbox touches.
        let mut poly_grid: HashMap<u32, Vec<u32>> = HashMap::new();
        let lat_lo = poly.bbox_lat_min.floor() as i32;
        let lat_hi = poly.bbox_lat_max.floor() as i32;
        let lon_lo = poly.bbox_lon_min.floor() as i32;
        let lon_hi = poly.bbox_lon_max.floor() as i32;
        for la in lat_lo..=lat_hi {
            for lo in lon_lo..=lon_hi {
                let key = ((la + 90) as u32) * 360 + ((lo + 180) as u32);
                poly_grid.entry(key).or_default().push(0);
            }
        }

        LandIndex {
            polygons: vec![poly],
            edge_grid,
            poly_grid,
        }
    }

    #[test]
    fn segment_crosses_land_crossing() {
        let idx = build_test_index();
        // Vertical line at lon=2 from lat=0 to lat=2 — crosses bottom edge at lat=1
        assert!(idx.segment_crosses_land(0.0, 2.0, 2.0, 2.0));
    }

    #[test]
    fn segment_crosses_land_no_crossing() {
        let idx = build_test_index();
        // Horizontal at lat=0 — well below the triangle
        assert!(!idx.segment_crosses_land(0.0, 0.0, 0.0, 5.0));
    }

    #[test]
    fn is_on_land_inside() {
        let idx = build_test_index();
        // Centroid of the triangle ≈ (lon=2, lat=1.67) — inside
        assert!(idx.is_on_land(1.67, 2.0));
    }

    #[test]
    fn is_on_land_outside() {
        let idx = build_test_index();
        assert!(!idx.is_on_land(0.0, 0.0));
    }

    #[test]
    fn is_on_land_far_outside() {
        let idx = build_test_index();
        assert!(!idx.is_on_land(-10.0, -10.0));
    }
}
