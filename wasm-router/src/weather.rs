/// Wind weather data store with bilinear spatial and linear temporal interpolation.
///
/// Stores GRIB-style forecast frames as flat row-major grids and provides
/// allocation-free sampling for the isochrone router.
///
/// A single forecast frame on a regular lat/lon grid.
struct WeatherFrame {
    time_ms: f64,
    /// Wind U component (west→east) in m/s, row-major [lat_idx * n_lon + lon_idx].
    u: Vec<f32>,
    /// Wind V component (south→north) in m/s, same layout.
    v: Vec<f32>,
    lat_min: f64,
    lon_min: f64,
    lat_step: f64,
    lon_step: f64,
    n_lat: usize,
    n_lon: usize,
}

impl WeatherFrame {
    /// Bilinear interpolation of a single component at (lat, lon).
    /// Returns None if the point is outside the spatial domain.
    #[inline]
    fn sample_component(&self, lat: f64, lon: f64, data: &[f32]) -> Option<f64> {
        let lat_idx_f = (lat - self.lat_min) / self.lat_step;
        let lon_idx_f = (lon - self.lon_min) / self.lon_step;

        // Outside domain check.
        if lat_idx_f < 0.0
            || lon_idx_f < 0.0
            || lat_idx_f > (self.n_lat - 1) as f64
            || lon_idx_f > (self.n_lon - 1) as f64
        {
            return None;
        }

        let lat0 = lat_idx_f.floor() as usize;
        let lon0 = lon_idx_f.floor() as usize;
        let lat1 = lat0.min(self.n_lat - 2); // clamp so lat1+1 is valid
        let lon1 = lon0.min(self.n_lon - 2);
        let lat_hi = lat1 + 1;
        let lon_hi = lon1 + 1;

        let t_lat = lat_idx_f - lat1 as f64;
        let t_lon = lon_idx_f - lon1 as f64;

        let c00 = data[lat1 * self.n_lon + lon1] as f64;
        let c01 = data[lat1 * self.n_lon + lon_hi] as f64;
        let c10 = data[lat_hi * self.n_lon + lon1] as f64;
        let c11 = data[lat_hi * self.n_lon + lon_hi] as f64;

        let v = c00 * (1.0 - t_lat) * (1.0 - t_lon)
            + c01 * (1.0 - t_lat) * t_lon
            + c10 * t_lat * (1.0 - t_lon)
            + c11 * t_lat * t_lon;

        Some(v)
    }

    /// Sample (u, v) at a position. Returns None if outside spatial domain.
    #[inline]
    fn sample(&self, lat: f64, lon: f64) -> Option<(f64, f64)> {
        let u = self.sample_component(lat, lon, &self.u)?;
        let v = self.sample_component(lat, lon, &self.v)?;
        Some((u, v))
    }

    /// Whether (lat, lon) falls within this frame's spatial domain.
    #[inline]
    fn contains(&self, lat: f64, lon: f64) -> bool {
        let lat_max = self.lat_min + (self.n_lat - 1) as f64 * self.lat_step;
        let lon_max = self.lon_min + (self.n_lon - 1) as f64 * self.lon_step;
        lat >= self.lat_min && lat <= lat_max && lon >= self.lon_min && lon <= lon_max
    }
}

/// Stores forecast frames and provides interpolated wind sampling.
///
/// Frames are kept sorted by time. Spatial interpolation is bilinear on
/// the regular grid; temporal interpolation is linear between bracketing frames.
pub(crate) struct WeatherStore {
    frames: Vec<WeatherFrame>,
}

impl WeatherStore {
    /// Create an empty store.
    pub fn new() -> Self {
        Self { frames: Vec::new() }
    }

    /// Add a forecast frame. Frames must be pushed in chronological order.
    ///
    /// `u`, `v`: flat row-major f32 arrays `[lat_idx * n_lon + lon_idx]`, values in m/s.
    /// Grid: regular lat/lon starting at `(lat_min, lon_min)` with steps `(lat_step, lon_step)`.
    pub fn push_frame(
        &mut self,
        time_ms: f64,
        u: &[f32],
        v: &[f32],
        lat_min: f64,
        lon_min: f64,
        lat_step: f64,
        lon_step: f64,
        n_lat: usize,
        n_lon: usize,
    ) {
        debug_assert_eq!(u.len(), n_lat * n_lon);
        debug_assert_eq!(v.len(), n_lat * n_lon);
        debug_assert!(
            self.frames.is_empty() || self.frames.last().unwrap().time_ms <= time_ms,
            "frames must be pushed in chronological order"
        );
        self.frames.push(WeatherFrame {
            time_ms,
            u: u.to_vec(),
            v: v.to_vec(),
            lat_min,
            lon_min,
            lat_step,
            lon_step,
            n_lat,
            n_lon,
        });
    }

    /// Evict all frames with time < `cutoff_ms`.
    ///
    /// Retains the most recent frame *before* the cutoff so it can still serve
    /// as the lower bracket for temporal interpolation.
    pub fn evict_before(&mut self, cutoff_ms: f64) {
        // Find the last frame with time < cutoff_ms — that's the one we keep.
        let mut keep_from = 0;
        for (i, f) in self.frames.iter().enumerate() {
            if f.time_ms < cutoff_ms {
                keep_from = i;
            } else {
                break;
            }
        }
        if keep_from > 0 {
            self.frames.drain(..keep_from);
        }
    }

    /// Sample wind `(u, v)` in m/s at a position and time.
    ///
    /// Spatial: bilinear interpolation within the frame's grid.
    /// Temporal: linear interpolation between the two bracketing frames.
    /// Outside spatial domain: returns `(0.0, 0.0)`.
    /// Outside temporal domain: clamps to the nearest frame.
    pub fn sample(&self, lat: f64, lon: f64, time_ms: f64) -> (f64, f64) {
        if self.frames.is_empty() {
            return (0.0, 0.0);
        }

        // Clamp to temporal domain.
        let first_time = self.frames[0].time_ms;
        let last_time = self.frames[self.frames.len() - 1].time_ms;

        if time_ms <= first_time {
            return self.frames[0].sample(lat, lon).unwrap_or((0.0, 0.0));
        }
        if time_ms >= last_time {
            return self.frames[self.frames.len() - 1]
                .sample(lat, lon)
                .unwrap_or((0.0, 0.0));
        }

        // Find bracketing frames via linear scan (typically few frames).
        let mut lo = 0;
        for i in 1..self.frames.len() {
            if self.frames[i].time_ms > time_ms {
                break;
            }
            lo = i;
        }
        let hi = lo + 1;

        let f_lo = &self.frames[lo];
        let f_hi = &self.frames[hi];

        // Exact hit — skip temporal interpolation.
        if (f_lo.time_ms - time_ms).abs() < 1e-6 {
            return f_lo.sample(lat, lon).unwrap_or((0.0, 0.0));
        }

        let (u0, v0) = f_lo.sample(lat, lon).unwrap_or((0.0, 0.0));
        let (u1, v1) = f_hi.sample(lat, lon).unwrap_or((0.0, 0.0));

        let dt = f_hi.time_ms - f_lo.time_ms;
        let t = (time_ms - f_lo.time_ms) / dt;

        (u0 + (u1 - u0) * t, v0 + (v1 - v0) * t)
    }

    /// Check if a point is covered at a given time.
    ///
    /// Returns `true` when at least one frame is loaded, the point falls within
    /// the spatial domain of the bracketing frame(s), and the time is within
    /// `[first_frame_time, last_frame_time]`.
    pub fn covers(&self, lat: f64, lon: f64, time_ms: f64) -> bool {
        if self.frames.is_empty() {
            return false;
        }
        let first_time = self.frames[0].time_ms;
        let last_time = self.frames[self.frames.len() - 1].time_ms;
        if time_ms < first_time || time_ms > last_time {
            return false;
        }
        // Check spatial coverage against the frame(s) that would be used.
        if time_ms <= first_time {
            return self.frames[0].contains(lat, lon);
        }
        if time_ms >= last_time {
            return self.frames[self.frames.len() - 1].contains(lat, lon);
        }
        // Find bracketing frames.
        let mut lo = 0;
        for i in 1..self.frames.len() {
            if self.frames[i].time_ms > time_ms {
                break;
            }
            lo = i;
        }
        self.frames[lo].contains(lat, lon) && self.frames[lo + 1].contains(lat, lon)
    }
}

#[cfg(test)]
impl WeatherStore {
    fn frame_count(&self) -> usize {
        self.frames.len()
    }
    fn time_range(&self) -> Option<(f64, f64)> {
        let first = self.frames.first()?.time_ms;
        let last = self.frames.last()?.time_ms;
        Some((first, last))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: build a 3×3 grid with known values.
    /// lat: 0, 1, 2  lon: 0, 1, 2
    fn make_store_single() -> WeatherStore {
        let mut s = WeatherStore::new();
        // u values: row-major, u[lat][lon] = (lat * 10 + lon) as f32
        let u: Vec<f32> = (0..9)
            .map(|i| {
                let lat = i / 3;
                let lon = i % 3;
                (lat * 10 + lon) as f32
            })
            .collect();
        // v values: constant 5.0
        let v: Vec<f32> = vec![5.0; 9];
        s.push_frame(1000.0, &u, &v, 0.0, 0.0, 1.0, 1.0, 3, 3);
        s
    }

    #[test]
    fn single_frame_grid_points() {
        let s = make_store_single();
        // Corner (0,0) → u=0, v=5
        let (u, v) = s.sample(0.0, 0.0, 1000.0);
        assert!((u - 0.0).abs() < 1e-9);
        assert!((v - 5.0).abs() < 1e-9);
        // Point (1,2) → u=12, v=5
        let (u, v) = s.sample(1.0, 2.0, 1000.0);
        assert!((u - 12.0).abs() < 1e-9);
        assert!((v - 5.0).abs() < 1e-9);
        // Point (2,1) → u=21, v=5
        let (u, v) = s.sample(2.0, 1.0, 1000.0);
        assert!((u - 21.0).abs() < 1e-9);
        assert!((v - 5.0).abs() < 1e-9);
    }

    #[test]
    fn single_frame_bilinear() {
        let s = make_store_single();
        // Sample at (0.5, 0.5) — between corners (0,0)=0, (0,1)=1, (1,0)=10, (1,1)=11
        // bilinear: 0*0.25 + 1*0.25 + 10*0.25 + 11*0.25 = 5.5
        let (u, v) = s.sample(0.5, 0.5, 1000.0);
        assert!((u - 5.5).abs() < 1e-6, "got u={u}");
        assert!((v - 5.0).abs() < 1e-6);
    }

    #[test]
    fn two_frames_temporal() {
        let mut s = WeatherStore::new();
        let u0: Vec<f32> = vec![10.0; 4];
        let v0: Vec<f32> = vec![2.0; 4];
        let u1: Vec<f32> = vec![20.0; 4];
        let v1: Vec<f32> = vec![4.0; 4];
        s.push_frame(0.0, &u0, &v0, 0.0, 0.0, 1.0, 1.0, 2, 2);
        s.push_frame(100.0, &u1, &v1, 0.0, 0.0, 1.0, 1.0, 2, 2);

        // Midpoint in time → lerp
        let (u, v) = s.sample(0.0, 0.0, 50.0);
        assert!((u - 15.0).abs() < 1e-6, "got u={u}");
        assert!((v - 3.0).abs() < 1e-6, "got v={v}");

        // Quarter point
        let (u, v) = s.sample(0.0, 0.0, 25.0);
        assert!((u - 12.5).abs() < 1e-6);
        assert!((v - 2.5).abs() < 1e-6);
    }

    #[test]
    fn outside_spatial_domain() {
        let s = make_store_single();
        let (u, v) = s.sample(-1.0, 0.0, 1000.0);
        assert_eq!(u, 0.0);
        assert_eq!(v, 0.0);
        let (u, v) = s.sample(0.0, 3.0, 1000.0);
        assert_eq!(u, 0.0);
        assert_eq!(v, 0.0);
    }

    #[test]
    fn outside_temporal_domain_clamps() {
        let mut s = WeatherStore::new();
        let u: Vec<f32> = vec![7.0; 4];
        let v: Vec<f32> = vec![3.0; 4];
        s.push_frame(100.0, &u, &v, 0.0, 0.0, 1.0, 1.0, 2, 2);
        let u2: Vec<f32> = vec![14.0; 4];
        let v2: Vec<f32> = vec![6.0; 4];
        s.push_frame(200.0, &u2, &v2, 0.0, 0.0, 1.0, 1.0, 2, 2);

        // Before first frame → clamp to first
        let (u, v) = s.sample(0.0, 0.0, 0.0);
        assert!((u - 7.0).abs() < 1e-6);
        assert!((v - 3.0).abs() < 1e-6);

        // After last frame → clamp to last
        let (u, v) = s.sample(0.0, 0.0, 999.0);
        assert!((u - 14.0).abs() < 1e-6);
        assert!((v - 6.0).abs() < 1e-6);
    }

    #[test]
    fn evict_keeps_lower_bracket() {
        let mut s = WeatherStore::new();
        for t in 0..5 {
            let u: Vec<f32> = vec![t as f32; 4];
            let v: Vec<f32> = vec![0.0; 4];
            s.push_frame(t as f64 * 100.0, &u, &v, 0.0, 0.0, 1.0, 1.0, 2, 2);
        }
        assert_eq!(s.frame_count(), 5);

        // Evict before 250 → frames at 0,100,200 are < 250; keep 200 (lower bracket), drop 0 and 100.
        s.evict_before(250.0);
        assert_eq!(s.frame_count(), 3);
        let (lo, _) = s.time_range().unwrap();
        assert!(
            (lo - 200.0).abs() < 1e-6,
            "lowest frame should be 200, got {lo}"
        );
    }

    #[test]
    fn covers_correctness() {
        let mut s = WeatherStore::new();
        assert!(!s.covers(0.0, 0.0, 0.0)); // empty

        let u: Vec<f32> = vec![1.0; 4];
        let v: Vec<f32> = vec![1.0; 4];
        s.push_frame(100.0, &u, &v, 10.0, 20.0, 1.0, 1.0, 2, 2);
        s.push_frame(200.0, &u, &v, 10.0, 20.0, 1.0, 1.0, 2, 2);

        // Inside spatial + temporal domain
        assert!(s.covers(10.5, 20.5, 150.0));
        // On boundaries
        assert!(s.covers(10.0, 20.0, 100.0));
        assert!(s.covers(11.0, 21.0, 200.0));
        // Outside spatial
        assert!(!s.covers(9.0, 20.0, 150.0));
        assert!(!s.covers(10.0, 22.0, 150.0));
        // Outside temporal
        assert!(!s.covers(10.5, 20.5, 50.0));
        assert!(!s.covers(10.5, 20.5, 250.0));
    }
}
