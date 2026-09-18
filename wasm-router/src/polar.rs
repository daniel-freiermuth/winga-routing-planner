// Polar diagram interpolation — bilinear lookup of boat speed from TWA and TWS.
// Mirrors src/lib/polar.ts interpolateBoatSpeed.

/// Polar diagram: TWA values (degrees, ascending 0–180), TWS values (knots, ascending),
/// and a row-major speed table [twa_idx * n_tws + tws_idx].
pub struct PolarData {
    pub twa: Vec<f64>,
    pub tws: Vec<f64>,
    pub speeds: Vec<f64>, // row-major: speeds[twa_idx * n_tws + tws_idx]
}

impl PolarData {
    /// Parse from flat arrays passed from JS.
    pub fn from_flat(twa: &[f64], tws: &[f64], speeds: &[f64]) -> Self {
        Self {
            twa: twa.to_vec(),
            tws: tws.to_vec(),
            speeds: speeds.to_vec(),
        }
    }

    /// Bilinear interpolation of boat speed (knots) at given TWA (degrees 0–180) and TWS (knots).
    pub fn interpolate(&self, twa: f64, tws: f64) -> f64 {
        let n_tws = self.tws.len();
        let n_twa = self.twa.len();
        if n_tws == 0 || n_twa == 0 {
            return 0.0;
        }

        // Clamp TWA to 0–180
        let twa = twa.clamp(0.0, 180.0);

        // Find TWA bracket
        let (twa_lo, twa_hi, twa_frac) = Self::bracket(&self.twa, twa);

        // Find TWS bracket
        let (tws_lo, tws_hi, tws_frac) = Self::bracket(&self.tws, tws);

        // Below the lowest TWS column: linearly interpolate toward zero
        if tws_lo == tws_hi && tws < self.tws[0] {
            let min_tws = self.tws[0];
            if min_tws <= 0.0 || tws <= 0.0 {
                return 0.0;
            }
            let speed_at_min = self.bilinear_at(twa_lo, twa_hi, twa_frac, 0, 0, 0.0);
            return speed_at_min * (tws / min_tws);
        }

        self.bilinear_at(twa_lo, twa_hi, twa_frac, tws_lo, tws_hi, tws_frac)
    }

    fn bilinear_at(
        &self,
        twa_lo: usize,
        twa_hi: usize,
        twa_f: f64,
        tws_lo: usize,
        tws_hi: usize,
        tws_f: f64,
    ) -> f64 {
        let n_tws = self.tws.len();
        let s00 = self.speeds[twa_lo * n_tws + tws_lo];
        let s01 = self.speeds[twa_lo * n_tws + tws_hi];
        let s10 = self.speeds[twa_hi * n_tws + tws_lo];
        let s11 = self.speeds[twa_hi * n_tws + tws_hi];
        let top = s00 * (1.0 - tws_f) + s01 * tws_f;
        let bot = s10 * (1.0 - tws_f) + s11 * tws_f;
        top * (1.0 - twa_f) + bot * twa_f
    }

    /// Find the bracketing indices and fraction for a value in a sorted array.
    fn bracket(arr: &[f64], val: f64) -> (usize, usize, f64) {
        if arr.is_empty() {
            return (0, 0, 0.0);
        }
        if val <= arr[0] {
            return (0, 0, 0.0);
        }
        if val >= arr[arr.len() - 1] {
            let last = arr.len() - 1;
            return (last, last, 0.0);
        }
        // Binary search for bracket
        let mut lo = 0usize;
        let mut hi = arr.len() - 1;
        while lo + 1 < hi {
            let mid = (lo + hi) / 2;
            if arr[mid] <= val {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let frac = if arr[hi] > arr[lo] {
            (val - arr[lo]) / (arr[hi] - arr[lo])
        } else {
            0.0
        };
        (lo, hi, frac)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal polar matching the TypeScript test fixture:
    ///   TWS: 10, 20
    ///   TWA: 30 →  3,  5
    ///        90 →  5, 10
    ///       180 →  3,  6
    fn test_polar() -> PolarData {
        PolarData::from_flat(
            &[30.0, 90.0, 180.0],
            &[10.0, 20.0],
            &[3.0, 5.0, 5.0, 10.0, 3.0, 6.0],
        )
    }

    // ── boundary: empty arrays ──────────────────────────────────────────

    #[test]
    fn empty_twa_returns_zero() {
        let p = PolarData::from_flat(&[], &[10.0], &[]);
        assert_eq!(p.interpolate(90.0, 10.0), 0.0);
    }

    #[test]
    fn empty_tws_returns_zero() {
        let p = PolarData::from_flat(&[90.0], &[], &[]);
        assert_eq!(p.interpolate(90.0, 10.0), 0.0);
    }

    // ── boundary: TWA clamping ──────────────────────────────────────────

    #[test]
    fn negative_twa_clamped_to_zero() {
        let p = test_polar();
        // Rust clamps negative TWA to 0, which bracket maps to the first row (TWA=30).
        let at_zero = p.interpolate(0.0, 10.0);
        let at_neg = p.interpolate(-90.0, 10.0);
        assert_eq!(at_neg, at_zero, "negative TWA should clamp to 0");
    }

    #[test]
    fn twa_above_180_clamped() {
        let p = test_polar();
        let at_180 = p.interpolate(180.0, 10.0);
        let at_200 = p.interpolate(200.0, 10.0);
        assert!(
            (at_200 - at_180).abs() < 1e-9,
            "TWA > 180 should clamp to 180: got {at_200}, expected {at_180}"
        );
    }

    // ── boundary: TWS below polar minimum → linear ramp toward zero ────

    #[test]
    fn tws_below_minimum_linear_ramp() {
        let p = test_polar();
        // At TWA=90, TWS=10 → speed = 5.  Below-minimum ramp: speed * (tws / min_tws).
        let at_min = p.interpolate(90.0, 10.0);
        let half = p.interpolate(90.0, 5.0);
        let quarter = p.interpolate(90.0, 2.5);
        assert!(
            (half - at_min / 2.0).abs() < 1e-9,
            "half min TWS should give half speed: got {half}, expected {}",
            at_min / 2.0
        );
        assert!(
            (quarter - at_min / 4.0).abs() < 1e-9,
            "quarter min TWS should give quarter speed: got {quarter}, expected {}",
            at_min / 4.0
        );
    }

    #[test]
    fn tws_zero_returns_zero() {
        let p = test_polar();
        assert_eq!(p.interpolate(90.0, 0.0), 0.0, "TWS=0 must give 0 speed");
    }

    // ── boundary: TWS above polar maximum → clamped to max column ──────

    #[test]
    fn tws_above_maximum_clamped() {
        let p = test_polar();
        let at_max = p.interpolate(90.0, 20.0);
        let beyond = p.interpolate(90.0, 40.0);
        assert!(
            (beyond - at_max).abs() < 1e-9,
            "TWS above max should clamp: got {beyond}, expected {at_max}"
        );
    }

    // ── logic: exact grid points ────────────────────────────────────────

    #[test]
    fn exact_grid_point_twa90_tws10() {
        let p = test_polar();
        assert!((p.interpolate(90.0, 10.0) - 5.0).abs() < 1e-9);
    }

    #[test]
    fn exact_grid_point_twa90_tws20() {
        let p = test_polar();
        assert!((p.interpolate(90.0, 20.0) - 10.0).abs() < 1e-9);
    }

    #[test]
    fn exact_grid_point_twa30_tws10() {
        let p = test_polar();
        assert!((p.interpolate(30.0, 10.0) - 3.0).abs() < 1e-9);
    }

    // ── logic: bilinear interpolation ───────────────────────────────────

    #[test]
    fn midpoint_tws_at_twa90() {
        // TWA=90, TWS=15 (midpoint of 10..20) → (5 + 10) / 2 = 7.5
        let p = test_polar();
        assert!(
            (p.interpolate(90.0, 15.0) - 7.5).abs() < 1e-9,
            "midpoint TWS interpolation: got {}",
            p.interpolate(90.0, 15.0)
        );
    }

    #[test]
    fn midpoint_twa_at_tws10() {
        // TWA=135 (midpoint of 90..180), TWS=10 → (5 + 3) / 2 = 4
        let p = test_polar();
        assert!(
            (p.interpolate(135.0, 10.0) - 4.0).abs() < 1e-9,
            "midpoint TWA interpolation: got {}",
            p.interpolate(135.0, 10.0)
        );
    }

    #[test]
    fn bilinear_centre() {
        // TWA=135, TWS=15 → bilinear of corners [5,10,3,6] → (5+10+3+6)/4 = 6
        let p = test_polar();
        assert!(
            (p.interpolate(135.0, 15.0) - 6.0).abs() < 1e-9,
            "bilinear centre: got {}",
            p.interpolate(135.0, 15.0)
        );
    }

    // ── helper: bracket() ───────────────────────────────────────────────

    #[test]
    fn bracket_below_minimum() {
        let (lo, hi, frac) = PolarData::bracket(&[10.0, 20.0, 30.0], 5.0);
        assert_eq!((lo, hi), (0, 0));
        assert_eq!(frac, 0.0);
    }

    #[test]
    fn bracket_above_maximum() {
        let (lo, hi, frac) = PolarData::bracket(&[10.0, 20.0, 30.0], 40.0);
        assert_eq!((lo, hi), (2, 2));
        assert_eq!(frac, 0.0);
    }

    #[test]
    fn bracket_exact_value() {
        let (lo, hi, frac) = PolarData::bracket(&[10.0, 20.0, 30.0], 20.0);
        assert_eq!((lo, hi), (1, 2));
        assert_eq!(frac, 0.0);
    }

    #[test]
    fn bracket_midpoint() {
        let (lo, hi, frac) = PolarData::bracket(&[10.0, 20.0, 30.0], 15.0);
        assert_eq!((lo, hi), (0, 1));
        assert!((frac - 0.5).abs() < 1e-9);
    }

    #[test]
    fn bracket_empty_array() {
        let (lo, hi, frac) = PolarData::bracket(&[], 10.0);
        assert_eq!((lo, hi, frac), (0, 0, 0.0));
    }

    // ── parity: Rust matches TypeScript for known grid values ───────────

    #[test]
    fn parity_exact_grid_points() {
        // TypeScript: interpolateBoatSpeed(polar, 90, 10) → 5
        //             interpolateBoatSpeed(polar, 90, 20) → 10
        //             interpolateBoatSpeed(polar, 180, 20) → 6
        let p = test_polar();
        assert!((p.interpolate(90.0, 10.0) - 5.0).abs() < 1e-9);
        assert!((p.interpolate(90.0, 20.0) - 10.0).abs() < 1e-9);
        assert!((p.interpolate(180.0, 20.0) - 6.0).abs() < 1e-9);
    }

    #[test]
    fn parity_bilinear_and_midpoints() {
        // TypeScript: interpolateBoatSpeed(polar, 90, 15) → 7.5
        //             interpolateBoatSpeed(polar, 135, 10) → 4
        //             interpolateBoatSpeed(polar, 135, 15) → 6
        let p = test_polar();
        assert!((p.interpolate(90.0, 15.0) - 7.5).abs() < 1e-9);
        assert!((p.interpolate(135.0, 10.0) - 4.0).abs() < 1e-9);
        assert!((p.interpolate(135.0, 15.0) - 6.0).abs() < 1e-9);
    }

    #[test]
    fn parity_tws_above_max_clamped() {
        // TypeScript: TWS=40, TWA=90 → same as TWS=20 → 10
        let p = test_polar();
        assert!((p.interpolate(90.0, 40.0) - 10.0).abs() < 1e-9);
    }

    #[test]
    fn parity_twa_above_180_clamped() {
        // TypeScript: TWA=200, TWS=10 → same as TWA=180 → 3
        let p = test_polar();
        assert!((p.interpolate(200.0, 10.0) - 3.0).abs() < 1e-9);
    }

    #[test]
    fn parity_below_min_tws_linear_ramp() {
        // TypeScript BUG-58: TWA=90, TWS=5 → half of speed@10 = 2.5
        let p = test_polar();
        assert!((p.interpolate(90.0, 5.0) - 2.5).abs() < 1e-9);
    }
}
