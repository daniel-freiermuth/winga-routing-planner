// Geodesic math — haversine distance, bearing, destination point.
// Mirrors src/lib/geo.ts but in Rust for the WASM routing loop.

use std::f64::consts::PI;

const DEG_TO_RAD: f64 = PI / 180.0;
const RAD_TO_DEG: f64 = 180.0 / PI;
const NM_PER_RAD: f64 = 3440.065; // nautical miles per radian of Earth

/// Great-circle distance in nautical miles.
pub fn haversine_nm(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let d_lat = (lat2 - lat1) * DEG_TO_RAD;
    let d_lon = (lon2 - lon1) * DEG_TO_RAD;
    let lat1r = lat1 * DEG_TO_RAD;
    let lat2r = lat2 * DEG_TO_RAD;
    let a = (d_lat / 2.0).sin().powi(2) + lat1r.cos() * lat2r.cos() * (d_lon / 2.0).sin().powi(2);
    2.0 * a.sqrt().atan2((1.0 - a).sqrt()) * NM_PER_RAD
}

/// Initial bearing from (lat1, lon1) to (lat2, lon2), in degrees 0–360.
pub fn bearing_to(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let lat1r = lat1 * DEG_TO_RAD;
    let lat2r = lat2 * DEG_TO_RAD;
    let d_lon = (lon2 - lon1) * DEG_TO_RAD;
    let y = d_lon.sin() * lat2r.cos();
    let x = lat1r.cos() * lat2r.sin() - lat1r.sin() * lat2r.cos() * d_lon.cos();
    (y.atan2(x) * RAD_TO_DEG + 360.0) % 360.0
}

/// Normalize a longitude to [-180, 180].
#[inline]
pub fn wrap_lon(lon: f64) -> f64 {
    (lon + 180.0).rem_euclid(360.0) - 180.0
}

/// Destination point given start, distance (nm), and bearing (degrees).
pub fn destination_point(lat: f64, lon: f64, dist_nm: f64, bearing_deg: f64) -> (f64, f64) {
    let d = dist_nm / NM_PER_RAD; // angular distance in radians
    let brng = bearing_deg * DEG_TO_RAD;
    let lat1 = lat * DEG_TO_RAD;
    let lon1 = lon * DEG_TO_RAD;
    let new_lat = (lat1.sin() * d.cos() + lat1.cos() * d.sin() * brng.cos()).asin();
    let new_lon =
        lon1 + (brng.sin() * d.sin() * lat1.cos()).atan2(d.cos() - lat1.sin() * new_lat.sin());
    (new_lat * RAD_TO_DEG, wrap_lon(new_lon * RAD_TO_DEG))
}

/// Wind speed in knots from u/v components (m/s).
pub fn wind_speed_knots(u: f64, v: f64) -> f64 {
    (u * u + v * v).sqrt() * 1.94384
}

/// Meteorological wind direction (FROM, degrees 0–360) from u/v components.
pub fn wind_direction(u: f64, v: f64) -> f64 {
    // atan2(-u, -v) gives the direction wind blows FROM
    ((-u).atan2(-v) * RAD_TO_DEG + 360.0) % 360.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destination_point_wraps_longitude_eastward() {
        // 120 nm due east from 179°E — should wrap to negative longitude.
        let (lat, lon) = destination_point(0.0, 179.0, 120.0, 90.0);
        assert!(
            lon >= -180.0 && lon <= 180.0,
            "longitude must be in [-180, 180], got {lon}"
        );
        assert!(
            lon < 0.0,
            "120 nm east from 179°E crosses antimeridian, got {lon}"
        );
        assert!(
            (lon - (-179.0)).abs() < 0.1,
            "expected lon ≈ -179°, got {lon}"
        );
        assert!(
            lat.abs() < 1.0,
            "near-equatorial start should stay near equator, got {lat}"
        );
    }

    #[test]
    fn destination_point_wraps_longitude_westward() {
        // 120 nm due west from 179°W — should wrap to positive longitude.
        let (_lat, lon) = destination_point(0.0, -179.0, 120.0, 270.0);
        assert!(
            lon >= -180.0 && lon <= 180.0,
            "longitude must be in [-180, 180], got {lon}"
        );
        assert!(
            lon > 0.0,
            "120 nm west from 179°W crosses antimeridian, got {lon}"
        );
        assert!((lon - 179.0).abs() < 0.1, "expected lon ≈ 179°, got {lon}");
    }

    #[test]
    fn wrap_lon_large_negative() {
        // Values below -540 broke the previous (lon + 540) % 360 formula
        // because Rust's `%` preserves the sign of the dividend.
        assert_eq!(wrap_lon(-541.0), 179.0);
        assert_eq!(wrap_lon(-900.0), -180.0);
        assert_eq!(wrap_lon(-180.0), -180.0);
        assert_eq!(wrap_lon(180.0), -180.0);
    }

    // --- haversine_nm ---

    #[test]
    fn haversine_nm_same_point_is_zero() {
        assert_eq!(haversine_nm(51.0, 4.0, 51.0, 4.0), 0.0);
    }

    #[test]
    fn haversine_nm_london_to_paris() {
        // Parity with TS geo.test.ts: ~185 nm
        let dist = haversine_nm(51.5, -0.12, 48.85, 2.35);
        assert!(
            dist > 183.0 && dist < 187.0,
            "expected ~185 nm, got {dist:.1}"
        );
    }

    #[test]
    fn haversine_nm_one_degree_latitude() {
        // Parity with TS: one degree of latitude ≈ 60 nm
        let dist = haversine_nm(50.0, 10.0, 51.0, 10.0);
        assert!((dist - 60.0).abs() < 0.5, "expected ~60 nm, got {dist:.2}");
    }

    #[test]
    fn haversine_nm_is_symmetric() {
        let ab = haversine_nm(51.5, -0.12, 48.85, 2.35);
        let ba = haversine_nm(48.85, 2.35, 51.5, -0.12);
        assert!(
            (ab - ba).abs() < 1e-10,
            "haversine should be symmetric: {ab} vs {ba}"
        );
    }

    // --- bearing_to ---

    #[test]
    fn bearing_to_due_north() {
        let b = bearing_to(50.0, 10.0, 51.0, 10.0);
        assert!(
            b.abs() < 0.01 || (b - 360.0).abs() < 0.01,
            "expected 0°, got {b}"
        );
    }

    #[test]
    fn bearing_to_due_east() {
        let b = bearing_to(50.0, 10.0, 50.0, 11.0);
        assert!((b - 90.0).abs() < 1.0, "expected ~90°, got {b}");
    }

    #[test]
    fn bearing_to_due_south() {
        let b = bearing_to(51.0, 10.0, 50.0, 10.0);
        assert!((b - 180.0).abs() < 0.01, "expected 180°, got {b}");
    }

    #[test]
    fn bearing_to_due_west() {
        let b = bearing_to(50.0, 11.0, 50.0, 10.0);
        assert!((b - 270.0).abs() < 1.0, "expected ~270°, got {b}");
    }

    // --- destination_point: boundary & parity ---

    #[test]
    fn destination_point_zero_distance_returns_start() {
        let (lat, lon) = destination_point(48.0, 2.0, 0.0, 45.0);
        assert!(
            (lat - 48.0).abs() < 1e-10,
            "zero distance should keep lat, got {lat}"
        );
        assert!(
            (lon - 2.0).abs() < 1e-10,
            "zero distance should keep lon, got {lon}"
        );
    }

    #[test]
    fn destination_point_north_60nm() {
        // Parity with TS: 60 nm due north from (50, 10) → lat ≈ 51, lon ≈ 10
        let (lat, lon) = destination_point(50.0, 10.0, 60.0, 0.0);
        assert!((lat - 51.0).abs() < 0.01, "expected lat ~51, got {lat}");
        assert!((lon - 10.0).abs() < 0.01, "expected lon ~10, got {lon}");
    }

    #[test]
    fn destination_point_round_trip_distance() {
        // Parity with TS: travel 100 nm at 45°, measure distance back → 100 nm
        let (lat, lon) = destination_point(48.0, 2.0, 100.0, 45.0);
        let dist = haversine_nm(48.0, 2.0, lat, lon);
        assert!(
            (dist - 100.0).abs() < 0.01,
            "round-trip distance off: {dist}"
        );
    }

    #[test]
    fn destination_point_south_pole_vicinity() {
        // Start near the south pole, head further south
        let (lat, lon) = destination_point(-89.0, 0.0, 60.0, 180.0);
        assert!(
            lat >= -90.0 && lat <= 90.0,
            "latitude must be in [-90, 90], got {lat}"
        );
        assert!(
            lat < -89.5,
            "should end very close to south pole, got {lat}"
        );
        assert!(
            lon >= -180.0 && lon <= 180.0,
            "longitude must be in [-180, 180], got {lon}"
        );
    }

    #[test]
    fn destination_point_all_cardinal_directions() {
        // From (0, 0), 60 nm in each cardinal direction
        let (lat_n, lon_n) = destination_point(0.0, 0.0, 60.0, 0.0);
        assert!(lat_n > 0.9, "north: expected lat > 0.9, got {lat_n}");
        assert!(lon_n.abs() < 0.01, "north: lon should stay ~0, got {lon_n}");

        let (lat_e, lon_e) = destination_point(0.0, 0.0, 60.0, 90.0);
        assert!(lat_e.abs() < 0.01, "east: lat should stay ~0, got {lat_e}");
        assert!(lon_e > 0.9, "east: expected lon > 0.9, got {lon_e}");

        let (lat_s, lon_s) = destination_point(0.0, 0.0, 60.0, 180.0);
        assert!(lat_s < -0.9, "south: expected lat < -0.9, got {lat_s}");
        assert!(lon_s.abs() < 0.01, "south: lon should stay ~0, got {lon_s}");

        let (lat_w, lon_w) = destination_point(0.0, 0.0, 60.0, 270.0);
        assert!(lat_w.abs() < 0.01, "west: lat should stay ~0, got {lat_w}");
        assert!(lon_w < -0.9, "west: expected lon < -0.9, got {lon_w}");
    }
}
