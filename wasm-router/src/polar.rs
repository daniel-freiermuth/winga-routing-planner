// Polar diagram interpolation — bilinear lookup of boat speed from TWA and TWS.
// Mirrors src/lib/polar.ts interpolateBoatSpeed.

/// Polar diagram: TWA values (degrees, ascending 0–180), TWS values (knots, ascending),
/// and a row-major speed table `[twa_idx * n_tws + tws_idx]`.
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
            let mid = usize::midpoint(lo, hi);
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
