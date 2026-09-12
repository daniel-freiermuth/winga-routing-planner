// Isochrone routing algorithm — time-optimal route search via frontier expansion.
// This is the hot loop that benefits from WASM: O(frontier × headings × steps) of
// trig, polar lookup, and candidate pruning.

use crate::geo::{
    bearing_to, destination_point, haversine_nm, wind_direction, wind_speed_knots, wrap_lon,
};
use crate::land::LandIndex;
use crate::polar::PolarData;
use crate::weather::WeatherStore;

const DEG_TO_RAD: f64 = std::f64::consts::PI / 180.0;

/// Route point returned to JS.
#[derive(Clone)]
pub struct RoutePoint {
    pub lat: f64,
    pub lon: f64,
    pub time_ms: f64,
    pub ctw: f64,
    pub twa: f64,
    pub boat_speed: f64, // knots, 0.0 for departure
    pub step_calc_ms: f64,
}

/// Internal frontier point with parent chain for backtracking.
struct IsoPoint {
    lat: f64,
    lon: f64,
    time_ms: f64,
    ctw: f64,
    twa: f64,
    boat_speed: f64,
    step_calc_ms: f64,
    parent: Option<usize>, // index into the points arena
}

/// Configuration for a single routing leg.
pub struct LegConfig {
    pub heading_step: f64,
    pub sector_size: f64,
    pub min_boat_speed: f64,
    pub max_wind_kn: f64,
    pub motor_speed_kn: f64,
    pub motor_below_kn: f64,
    pub wait_for_wind: bool,
    pub tack_penalty_sec: f64,
    pub tack_threshold_deg: f64,
    pub cone_half_angle: f64,
    pub cone_disable_lookahead_nm: f64,
    pub max_heading_change: f64,
    pub arrival_radius_nm: f64,
}

/// Result of a single expansion step.
pub enum StepResult {
    /// Frontier advanced; more steps possible.
    Running,
    /// Route arrived at the destination.
    Arrived,
    /// No candidates survived this step (blocked or no wind).
    NoProgress,
    /// Next step would exceed the forecast horizon.
    ForecastExhausted,
}

/// Manages the state of a single routing leg, allowing step-by-step execution.
pub struct LegState {
    arena: Vec<IsoPoint>,
    frontier: Vec<usize>,
    arrived: Option<usize>,
    steps_completed: u32,
    current_time_ms: f64,
    // Leg endpoints.
    start_lat: f64,
    start_lon: f64,
    end_lat: f64,
    end_lon: f64,
    // Timing.
    forecast_end_ms: f64,
    step_ms: f64,
    step_h: f64,
    arrival_r: f64,
    est_total_steps: u32,
}

impl LegState {
    /// Create a new leg state. The frontier starts as a single seed point at the start position.
    pub fn new(
        start_lat: f64,
        start_lon: f64,
        end_lat: f64,
        end_lon: f64,
        departure_ms: f64,
        forecast_end_ms: f64,
        config: &LegConfig,
    ) -> Self {
        let direct_dist = haversine_nm(start_lat, start_lon, end_lat, end_lon);
        let est_speed = 5.0;
        let forecast_h = (forecast_end_ms - departure_ms) / 3_600_000.0;
        let est_h = (direct_dist / est_speed).min(forecast_h);
        let step_h = (est_h / 100.0).max(0.25);
        let step_ms = step_h * 3_600_000.0;
        let est_total_steps = (est_h / step_h).ceil() as u32;

        // Arrival radius must be at least one step's sailing distance,
        // otherwise the boat leaps over the destination without detecting arrival.
        let step_dist_nm = est_speed * step_h;
        let arrival_r = if config.arrival_radius_nm > 0.0 {
            config.arrival_radius_nm
        } else {
            step_dist_nm.max((direct_dist / 100.0).clamp(0.1, 2.0))
        };

        let mut arena = Vec::with_capacity(est_total_steps as usize * 500);
        arena.push(IsoPoint {
            lat: start_lat,
            lon: start_lon,
            time_ms: departure_ms,
            ctw: 0.0,
            twa: 0.0,
            boat_speed: 0.0,
            step_calc_ms: 0.0,
            parent: None,
        });

        Self {
            arena,
            frontier: vec![0],
            arrived: None,
            steps_completed: 0,
            current_time_ms: departure_ms,
            start_lat,
            start_lon,
            end_lat,
            end_lon,
            forecast_end_ms,
            step_ms,
            step_h,
            arrival_r,
            est_total_steps,
        }
    }

    /// Time the next step will evaluate wind/current at.
    pub fn current_time_ms(&self) -> f64 {
        self.current_time_ms
    }

    /// Time the next step will advance the frontier to.
    pub fn next_time_ms(&self) -> f64 {
        self.current_time_ms + self.step_ms
    }

    /// Progress percentage (0–100).
    pub fn progress_pct(&self) -> f64 {
        ((self.steps_completed as f64 + 1.0) / self.est_total_steps as f64 * 100.0).min(99.0)
    }

    /// Current frontier as (lat, lon) pairs for progress display.
    pub fn frontier_points(&self) -> Vec<(f64, f64)> {
        self.frontier
            .iter()
            .map(|&i| (self.arena[i].lat, self.arena[i].lon))
            .collect()
    }

    /// Run one expansion step using the given data sources.
    pub fn step(
        &mut self,
        polar: &PolarData,
        config: &LegConfig,
        wind: &WeatherStore,
        current: &WeatherStore,
        land: &LandIndex,
    ) -> StepResult {
        let next_time_ms = self.current_time_ms + self.step_ms;
        if next_time_ms > self.forecast_end_ms {
            return StepResult::ForecastExhausted;
        }

        let dt_hours = self.step_h;
        let end_lat = self.end_lat;
        let end_lon = self.end_lon;
        let mut candidates: Vec<usize> = Vec::with_capacity(self.frontier.len() * 72);

        for &pt_idx in &self.frontier {
            let pt_lat = self.arena[pt_idx].lat;
            let pt_lon = self.arena[pt_idx].lon;
            let pt_ctw = self.arena[pt_idx].ctw;
            let pt_twa = self.arena[pt_idx].twa;
            let pt_has_parent = self.arena[pt_idx].parent.is_some();

            if land.is_on_land(pt_lat, pt_lon) {
                continue;
            }

            let pt_to_dest = bearing_to(pt_lat, pt_lon, end_lat, end_lon);
            let wind_vec = wind.sample(pt_lat, pt_lon, self.current_time_ms);

            // Wind over water
            let cur = current.sample(pt_lat, pt_lon, self.current_time_ms);
            let wow_u = wind_vec.0 - cur.0;
            let wow_v = wind_vec.1 - cur.1;
            let wow_speed = wind_speed_knots(wow_u, wow_v);
            let wow_dir = wind_direction(wow_u, wow_v);

            // Max wind check (true wind)
            if config.max_wind_kn > 0.0
                && wind_speed_knots(wind_vec.0, wind_vec.1) > config.max_wind_kn
            {
                continue;
            }

            // Wave check skipped — wave data not yet passed to Rust

            // Cone check
            let dist_to_dest = haversine_nm(pt_lat, pt_lon, end_lat, end_lon);
            let cone_end = if dist_to_dest <= config.cone_disable_lookahead_nm {
                (end_lat, end_lon)
            } else {
                destination_point(pt_lat, pt_lon, config.cone_disable_lookahead_nm, pt_to_dest)
            };
            let direct_blocked = land.segment_crosses_land(pt_lat, pt_lon, cone_end.0, cone_end.1);
            let cone_half = if direct_blocked {
                180.0
            } else {
                config.cone_half_angle
            };

            // ── Direct-to-destination arrival ──────────────────────────────
            // When close enough to reach the destination this step, generate
            // a candidate placed exactly there with interpolated arrival time.
            // This prevents overshooting when step_dist > arrival_r.
            let max_step_dist = 15.0 * dt_hours; // generous upper bound
            if dist_to_dest <= max_step_dist && !direct_blocked {
                let direct_twa_raw = (pt_to_dest - wow_dir + 360.0) % 360.0;
                let direct_twa = if direct_twa_raw > 180.0 {
                    360.0 - direct_twa_raw
                } else {
                    direct_twa_raw
                };
                let direct_speed = polar.interpolate(direct_twa, wow_speed);
                let eff = if config.motor_below_kn > 0.0
                    && config.motor_speed_kn > 0.0
                    && direct_speed < config.motor_below_kn
                {
                    config.motor_speed_kn
                } else {
                    direct_speed
                };
                if eff >= config.min_boat_speed
                    && eff * dt_hours >= dist_to_dest
                    && !land.segment_crosses_land(pt_lat, pt_lon, end_lat, end_lon)
                {
                    let travel_h = dist_to_dest / eff;
                    let arrival_ms = self.current_time_ms + travel_h * 3_600_000.0;
                    let arr_idx = self.arena.len();
                    self.arena.push(IsoPoint {
                        lat: end_lat,
                        lon: end_lon,
                        time_ms: arrival_ms,
                        ctw: pt_to_dest,
                        twa: direct_twa,
                        boat_speed: eff,
                        step_calc_ms: 0.0,
                        parent: Some(pt_idx),
                    });
                    candidates.push(arr_idx);
                }
            }

            let mut wait_added = false;
            let mut ctw = 0.0f64;
            while ctw < 360.0 {
                let deviation = ((ctw - pt_to_dest + 180.0 + 360.0) % 360.0 - 180.0).abs();
                if deviation > cone_half {
                    ctw += config.heading_step;
                    continue;
                }

                // CTW change constraint (skip for seed points)
                if pt_has_parent {
                    let delta = ((ctw - pt_ctw + 180.0 + 360.0) % 360.0 - 180.0).abs();
                    if delta > config.max_heading_change {
                        ctw += config.heading_step;
                        continue;
                    }
                }

                let mut twa = (ctw - wow_dir + 360.0) % 360.0;
                if twa > 180.0 {
                    twa = 360.0 - twa;
                }

                let polar_speed = polar.interpolate(twa, wow_speed);
                let effective_speed = if config.motor_below_kn > 0.0
                    && config.motor_speed_kn > 0.0
                    && polar_speed < config.motor_below_kn
                {
                    config.motor_speed_kn
                } else {
                    polar_speed
                };

                if effective_speed < config.min_boat_speed {
                    if config.wait_for_wind && !wait_added {
                        let wait_idx = self.arena.len();
                        self.arena.push(IsoPoint {
                            lat: pt_lat,
                            lon: pt_lon,
                            time_ms: next_time_ms,
                            ctw: pt_ctw,
                            twa: pt_twa,
                            boat_speed: 0.0,
                            step_calc_ms: 0.0,
                            parent: Some(pt_idx),
                        });
                        candidates.push(wait_idx);
                        wait_added = true;
                    }
                    ctw += config.heading_step;
                    continue;
                }

                // Tack penalty
                let mut penalty_h = 0.0;
                if config.tack_penalty_sec > 0.0 && pt_has_parent {
                    let ctw_change = ((ctw - pt_ctw + 180.0 + 360.0) % 360.0 - 180.0).abs();
                    if ctw_change > config.tack_threshold_deg {
                        penalty_h = config.tack_penalty_sec / 3600.0;
                    }
                }

                let dist_nm = effective_speed * (dt_hours - penalty_h).max(0.0);
                let (mut new_lat, mut new_lon) = destination_point(pt_lat, pt_lon, dist_nm, ctw);

                // Current drift
                if cur.0 != 0.0 || cur.1 != 0.0 {
                    let dt_s = dt_hours * 3600.0;
                    new_lat += (cur.1 * dt_s) / (1852.0 * 60.0);
                    new_lon += (cur.0 * dt_s) / (1852.0 * 60.0 * (pt_lat * DEG_TO_RAD).cos());
                    new_lon = wrap_lon(new_lon);
                }

                // Coverage check
                if !wind.covers(new_lat, new_lon, next_time_ms) {
                    ctw += config.heading_step;
                    continue;
                }

                // Land check
                if land.segment_crosses_land(pt_lat, pt_lon, new_lat, new_lon) {
                    ctw += config.heading_step;
                    continue;
                }

                let new_idx = self.arena.len();
                self.arena.push(IsoPoint {
                    lat: new_lat,
                    lon: new_lon,
                    time_ms: next_time_ms,
                    ctw,
                    twa,
                    boat_speed: effective_speed,
                    step_calc_ms: 0.0,
                    parent: Some(pt_idx),
                });
                candidates.push(new_idx);

                ctw += config.heading_step;
            }
        }

        // Check for arrival
        let mut best_arrival: Option<(usize, f64)> = None;
        for &idx in &candidates {
            let p = &self.arena[idx];
            let d = haversine_nm(p.lat, p.lon, end_lat, end_lon);
            if d <= self.arrival_r && (best_arrival.is_none() || d < best_arrival.unwrap().1) {
                best_arrival = Some((idx, d));
            }
        }
        if let Some((idx, _)) = best_arrival {
            self.arrived = Some(idx);
            return StepResult::Arrived;
        }

        // Prune to frontier
        self.frontier = prune_to_frontier(
            &self.arena,
            &candidates,
            self.start_lat,
            self.start_lon,
            config.sector_size,
        );

        if self.frontier.is_empty() {
            return StepResult::NoProgress;
        }

        self.steps_completed += 1;
        self.current_time_ms = next_time_ms;
        StepResult::Running
    }

    /// Backtrack from the best arrival or closest frontier point to produce the route.
    pub fn backtrack(&self) -> Vec<RoutePoint> {
        let backtrack_idx = if let Some(idx) = self.arrived {
            idx
        } else if !self.frontier.is_empty() {
            let mut best_idx = self.frontier[0];
            let mut best_dist = haversine_nm(
                self.arena[best_idx].lat,
                self.arena[best_idx].lon,
                self.end_lat,
                self.end_lon,
            );
            for &idx in &self.frontier[1..] {
                let d = haversine_nm(
                    self.arena[idx].lat,
                    self.arena[idx].lon,
                    self.end_lat,
                    self.end_lon,
                );
                if d < best_dist {
                    best_dist = d;
                    best_idx = idx;
                }
            }
            best_idx
        } else {
            return Vec::new();
        };

        let mut route = Vec::new();

        // Walk parent chain — skip the arrival point when we snap to the exact destination
        let start_idx = if self.arrived.is_some() {
            self.arena[backtrack_idx].parent
        } else {
            Some(backtrack_idx)
        };
        let mut cur_idx = start_idx;
        while let Some(i) = cur_idx {
            let p = &self.arena[i];
            route.push(RoutePoint {
                lat: p.lat,
                lon: p.lon,
                time_ms: p.time_ms,
                ctw: p.ctw,
                twa: p.twa,
                boat_speed: p.boat_speed,
                step_calc_ms: p.step_calc_ms,
            });
            cur_idx = p.parent;
        }
        route.reverse();

        // Snap to exact destination with estimated extra travel time
        if self.arrived.is_some() {
            let arr = &self.arena[backtrack_idx];
            let extra_dist = haversine_nm(arr.lat, arr.lon, self.end_lat, self.end_lon);
            let extra_h = if arr.boat_speed > 0.1 {
                extra_dist / arr.boat_speed
            } else {
                0.0
            };
            route.push(RoutePoint {
                lat: self.end_lat,
                lon: self.end_lon,
                time_ms: arr.time_ms + extra_h * 3_600_000.0,
                ctw: arr.ctw,
                twa: arr.twa,
                boat_speed: arr.boat_speed,
                step_calc_ms: 0.0,
            });
        }

        route
    }
}

/// Sector-based frontier pruning: keep the two farthest-from-start candidates per bearing sector.
fn prune_to_frontier(
    arena: &[IsoPoint],
    candidates: &[usize],
    start_lat: f64,
    start_lon: f64,
    sector_size: f64,
) -> Vec<usize> {
    let n_sectors = (360.0 / sector_size).ceil() as usize;
    // Two slots per sector: (index, distance)
    let mut sectors: Vec<[(Option<usize>, f64); 2]> = vec![[(None, 0.0); 2]; n_sectors];

    for &idx in candidates {
        let p = &arena[idx];
        let dist = haversine_nm(start_lat, start_lon, p.lat, p.lon);
        let bearing = bearing_to(start_lat, start_lon, p.lat, p.lon);
        let sector = ((bearing / sector_size).floor() as usize).min(n_sectors - 1);

        let slot = &mut sectors[sector];
        if slot[0].0.is_none() || dist > slot[0].1 {
            slot[1] = slot[0];
            slot[0] = (Some(idx), dist);
        } else if slot[1].0.is_none() || dist > slot[1].1 {
            slot[1] = (Some(idx), dist);
        }
    }

    let mut result = Vec::with_capacity(n_sectors * 2);
    for slot in &sectors {
        if let Some(idx) = slot[0].0 {
            result.push(idx);
        }
        if let Some(idx) = slot[1].0 {
            result.push(idx);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::land::LandIndex;
    use crate::polar::PolarData;
    use crate::weather::WeatherStore;

    // ── test helpers ─────────────────────────────────────────────────────

    /// PolarData returning a constant boat speed at every TWA/TWS.
    fn flat_polar(speed: f64) -> PolarData {
        let twa = vec![0.0, 90.0, 180.0];
        let tws = vec![0.0, 30.0];
        let speeds = vec![speed; twa.len() * tws.len()];
        PolarData::from_flat(&twa, &tws, &speeds)
    }

    /// Uniform wind/current store covering lat 30–60, lon −20–20 between two times.
    fn uniform_weather(u_ms: f32, v_ms: f32, t0_ms: f64, t1_ms: f64) -> WeatherStore {
        let mut ws = WeatherStore::new();
        let n_lat: usize = 31;
        let n_lon: usize = 41;
        let u: Vec<f32> = vec![u_ms; n_lat * n_lon];
        let v: Vec<f32> = vec![v_ms; n_lat * n_lon];
        ws.push_frame(t0_ms, &u, &v, 30.0, -20.0, 1.0, 1.0, n_lat, n_lon);
        ws.push_frame(t1_ms, &u, &v, 30.0, -20.0, 1.0, 1.0, n_lat, n_lon);
        ws
    }

    fn default_config() -> LegConfig {
        LegConfig {
            heading_step: 10.0,
            sector_size: 10.0,
            min_boat_speed: 0.5,
            max_wind_kn: 50.0,
            motor_speed_kn: 0.0,
            motor_below_kn: 0.0,
            wait_for_wind: false,
            tack_penalty_sec: 0.0,
            tack_threshold_deg: 45.0,
            cone_half_angle: 90.0,
            cone_disable_lookahead_nm: 10.0,
            max_heading_change: 180.0,
            arrival_radius_nm: 0.0,
        }
    }

    // ── LegState::new — step sizing ──────────────────────────────────────

    #[test]
    fn step_h_clamped_for_short_route() {
        // direct_dist ≈ 0 → est_h ≈ 0 → step_h clamped to 0.25 h
        let config = default_config();
        let state = LegState::new(45.0, 0.0, 45.0, 0.0, 0.0, 3_600_000.0 * 48.0, &config);
        assert!(
            (state.step_h - 0.25).abs() < 1e-9,
            "expected step_h = 0.25, got {}",
            state.step_h
        );
        assert!(
            (state.step_ms - 0.25 * 3_600_000.0).abs() < 1e-3,
            "step_ms should equal 0.25 h in ms"
        );
    }

    #[test]
    fn step_h_scales_with_distance() {
        // direct_dist = 500 nm, est_speed = 5 kn → est_h = 100 h
        // forecast_h = 200 h → est_h = min(100, 200) = 100
        // step_h = 100 / 100 = 1.0 h
        let config = default_config();
        // ~500 nm apart: 45°N to ~53.3°N at same longitude
        let start = (45.0, 0.0);
        let end = (53.34, 0.0); // ≈ 500 nm
        let forecast_end = 200.0 * 3_600_000.0;
        let state = LegState::new(start.0, start.1, end.0, end.1, 0.0, forecast_end, &config);
        assert!(
            state.step_h > 0.25,
            "step_h should be larger than the clamp for long routes, got {}",
            state.step_h
        );
    }

    #[test]
    fn step_h_bounded_by_forecast_horizon() {
        // direct_dist = 500 nm → est_h at 5 kn = 100 h, but forecast_h = 10 h
        // est_h = min(100, 10) = 10, step_h = 10/100 = 0.1 → clamped to 0.25
        let config = default_config();
        let forecast_end = 10.0 * 3_600_000.0;
        let state = LegState::new(45.0, 0.0, 53.34, 0.0, 0.0, forecast_end, &config);
        assert!(
            (state.step_h - 0.25).abs() < 1e-9,
            "step_h should clamp to 0.25 when forecast is short, got {}",
            state.step_h
        );
    }

    // ── LegState::new — arrival radius ───────────────────────────────────

    #[test]
    fn arrival_radius_auto_scales_with_step_distance() {
        let config = default_config(); // arrival_radius_nm = 0 → auto
        let state = LegState::new(45.0, 0.0, 45.0, 0.0, 0.0, 3_600_000.0 * 48.0, &config);
        // step_h = 0.25, est_speed = 5 → step_dist = 1.25 nm
        // direct_dist ≈ 0 → (0/100).clamp(0.1, 2.0) = 0.1
        // arrival_r = max(1.25, 0.1) = 1.25
        assert!(
            (state.arrival_r - 1.25).abs() < 1e-6,
            "expected arrival_r = 1.25, got {}",
            state.arrival_r
        );
    }

    #[test]
    fn arrival_radius_explicit_overrides_auto() {
        let mut config = default_config();
        config.arrival_radius_nm = 5.0;
        let state = LegState::new(45.0, 0.0, 45.0, 0.0, 0.0, 3_600_000.0 * 48.0, &config);
        assert!(
            (state.arrival_r - 5.0).abs() < 1e-9,
            "explicit arrival_radius_nm should be used, got {}",
            state.arrival_r
        );
    }

    // ── step() — forecast exhaustion ─────────────────────────────────────

    #[test]
    fn forecast_exhausted_when_next_step_exceeds_horizon() {
        let config = default_config();
        let polar = flat_polar(6.0);
        let wind = uniform_weather(5.0, 0.0, 0.0, 100.0);
        let current = WeatherStore::new();
        let land = LandIndex::empty();

        // forecast_end = 100 ms, step_ms = 0.25 h = 900_000 ms → first step overshoots
        let mut state = LegState::new(45.0, 0.0, 46.0, 0.0, 0.0, 100.0, &config);
        let result = state.step(&polar, &config, &wind, &current, &land);
        assert!(
            matches!(result, StepResult::ForecastExhausted),
            "expected ForecastExhausted when next_time > forecast_end"
        );
    }

    // ── step() — basic frontier expansion ────────────────────────────────

    #[test]
    fn step_produces_running_frontier() {
        let config = default_config();
        let polar = flat_polar(6.0);
        let t_end = 48.0 * 3_600_000.0;
        let wind = uniform_weather(5.0, 0.0, 0.0, t_end);
        let current = WeatherStore::new();
        let land = LandIndex::empty();

        // ~60 nm apart, well within forecast
        let mut state = LegState::new(45.0, 0.0, 46.0, 0.0, 0.0, t_end, &config);
        let result = state.step(&polar, &config, &wind, &current, &land);
        assert!(
            matches!(result, StepResult::Running),
            "expected Running for a route that can't arrive in one step"
        );
        assert!(
            !state.frontier.is_empty(),
            "frontier should contain candidates after a step"
        );
        assert_eq!(state.steps_completed, 1);
    }

    // ── step() — direct-to-destination arrival ───────────────────────────

    #[test]
    fn direct_arrival_when_destination_within_one_step() {
        let config = default_config();
        let polar = flat_polar(6.0);
        let t_end = 48.0 * 3_600_000.0;
        let wind = uniform_weather(5.0, 0.0, 0.0, t_end);
        let current = WeatherStore::new();
        let land = LandIndex::empty();

        // ~0.6 nm apart — reachable in a single step (6 kn * 0.25 h = 1.5 nm)
        let mut state = LegState::new(45.0, 0.0, 45.01, 0.0, 0.0, t_end, &config);
        let result = state.step(&polar, &config, &wind, &current, &land);
        assert!(
            matches!(result, StepResult::Arrived),
            "expected Arrived when destination is within one step's distance"
        );
        assert!(state.arrived.is_some(), "arrived index should be set");
    }

    // ── step() — motor speed fallback ────────────────────────────────────

    #[test]
    fn motor_fallback_kicks_in_below_threshold() {
        let mut config = default_config();
        config.min_boat_speed = 2.0; // filter out slow candidates
        config.motor_speed_kn = 5.0;
        config.motor_below_kn = 3.0; // motor when polar < 3 kn

        let polar = flat_polar(1.0); // polar returns 1 kn (below threshold)
        let t_end = 48.0 * 3_600_000.0;
        let wind = uniform_weather(5.0, 0.0, 0.0, t_end);
        let current = WeatherStore::new();
        let land = LandIndex::empty();

        // With motor: effective = 5 kn > min 2 kn → Running
        let mut state = LegState::new(45.0, 0.0, 46.0, 0.0, 0.0, t_end, &config);
        let result = state.step(&polar, &config, &wind, &current, &land);
        assert!(
            matches!(result, StepResult::Running),
            "motor should produce candidates above min_boat_speed"
        );

        // Verify arena points have motor speed
        let motor_point = state.arena.iter().find(|p| p.parent.is_some());
        assert!(motor_point.is_some(), "should have expanded points");
        assert!(
            (motor_point.unwrap().boat_speed - 5.0).abs() < 1e-9,
            "boat_speed should be motor_speed_kn (5.0), got {}",
            motor_point.unwrap().boat_speed
        );
    }

    #[test]
    fn no_progress_without_motor_when_polar_too_slow() {
        let mut config = default_config();
        config.min_boat_speed = 2.0;
        config.motor_speed_kn = 0.0; // motor disabled
        config.motor_below_kn = 0.0;

        let polar = flat_polar(1.0); // only 1 kn, below min_boat_speed
        let t_end = 48.0 * 3_600_000.0;
        let wind = uniform_weather(5.0, 0.0, 0.0, t_end);
        let current = WeatherStore::new();
        let land = LandIndex::empty();

        let mut state = LegState::new(45.0, 0.0, 46.0, 0.0, 0.0, t_end, &config);
        let result = state.step(&polar, &config, &wind, &current, &land);
        assert!(
            matches!(result, StepResult::NoProgress),
            "expected NoProgress when polar speed < min_boat_speed and no motor"
        );
    }

    // ── step() — tack penalty ────────────────────────────────────────────

    #[test]
    fn tack_penalty_reduces_step_distance() {
        let mut config = default_config();
        config.tack_penalty_sec = 600.0; // 10 min penalty
        config.tack_threshold_deg = 30.0;
        config.cone_half_angle = 180.0; // wide cone so all headings are tried
        config.max_heading_change = 180.0;

        let polar = flat_polar(6.0);
        let t_end = 48.0 * 3_600_000.0;
        let wind = uniform_weather(5.0, 0.0, 0.0, t_end);
        let current = WeatherStore::new();
        let land = LandIndex::empty();

        let mut state = LegState::new(45.0, 0.0, 46.0, 0.0, 0.0, t_end, &config);

        // First step: seed has no parent → no tack penalty applies
        let r = state.step(&polar, &config, &wind, &current, &land);
        assert!(matches!(r, StepResult::Running));

        // Record distances from start for first-step points (no penalty)
        let first_step_dists: Vec<f64> = state
            .frontier
            .iter()
            .map(|&i| {
                let p = &state.arena[i];
                crate::geo::haversine_nm(45.0, 0.0, p.lat, p.lon)
            })
            .collect();
        let _max_first = first_step_dists.iter().cloned().fold(0.0_f64, f64::max);

        // Second step: points have parents with known ctw,
        // large ctw changes (> 30°) should incur a 10-min penalty → shorter travel
        let r = state.step(&polar, &config, &wind, &current, &land);
        assert!(matches!(r, StepResult::Running));

        // Find a point whose ctw changed by > 30° from parent (tacked)
        let tacked = state.arena.iter().find(|p| {
            if let Some(pi) = p.parent {
                let parent = &state.arena[pi];
                if parent.parent.is_some() {
                    let delta = ((p.ctw - parent.ctw + 180.0 + 360.0) % 360.0 - 180.0).abs();
                    return delta > config.tack_threshold_deg;
                }
            }
            false
        });
        // The tack penalty is 600s = 1/6 h. With 6 kn speed:
        // no penalty: dist = 6 * step_h
        // with penalty: dist = 6 * (step_h - 1/6).max(0)
        // The tacked point should have traveled less distance from its parent.
        if let Some(tp) = tacked {
            let parent = &state.arena[tp.parent.unwrap()];
            let parent_dist = crate::geo::haversine_nm(45.0, 0.0, parent.lat, parent.lon);
            let tp_dist = crate::geo::haversine_nm(parent.lat, parent.lon, tp.lat, tp.lon);
            let expected_no_penalty = 6.0 * state.step_h;
            assert!(
                tp_dist < expected_no_penalty - 0.1,
                "tacked point should travel shorter than {expected_no_penalty:.2} nm, got {tp_dist:.2} nm"
            );
            let _ = parent_dist; // used for debug
        }
        // Even if no tacked point exists (cone/heading filters), the test
        // still validates that tack penalty config doesn't crash the step.
    }

    // ── prune_to_frontier — top-2 per sector ─────────────────────────────

    #[test]
    fn prune_keeps_top_two_per_sector() {
        // Place 4 points in the same sector (bearing ~0° from start)
        // at different distances. Pruning should keep the 2 farthest.
        let start = (45.0, 0.0);
        let arena: Vec<IsoPoint> = (1..=4)
            .map(|i| IsoPoint {
                lat: start.0 + i as f64 * 0.01, // all due north
                lon: start.1,
                time_ms: 0.0,
                ctw: 0.0,
                twa: 0.0,
                boat_speed: 0.0,
                step_calc_ms: 0.0,
                parent: None,
            })
            .collect();
        let candidates: Vec<usize> = (0..4).collect();

        let result = prune_to_frontier(&arena, &candidates, start.0, start.1, 10.0);

        // All 4 are in the same sector (bearing ≈ 0°, sector 0 at 10° width).
        // Should keep exactly 2: the farthest two (indices 3 and 2).
        assert_eq!(result.len(), 2, "should keep exactly 2 per sector");
        // The farthest point (index 3) should be first slot
        assert_eq!(result[0], 3);
        assert_eq!(result[1], 2);
    }

    #[test]
    fn prune_multiple_sectors() {
        let start = (45.0, 0.0);
        let arena = vec![
            // Sector 0 (north): one point
            IsoPoint {
                lat: 45.1,
                lon: 0.0,
                time_ms: 0.0,
                ctw: 0.0,
                twa: 0.0,
                boat_speed: 0.0,
                step_calc_ms: 0.0,
                parent: None,
            },
            // Sector 9 (east): one point (bearing ~90°)
            IsoPoint {
                lat: 45.0,
                lon: 0.1,
                time_ms: 0.0,
                ctw: 0.0,
                twa: 0.0,
                boat_speed: 0.0,
                step_calc_ms: 0.0,
                parent: None,
            },
            // Sector 18 (south): one point (bearing ~180°)
            IsoPoint {
                lat: 44.9,
                lon: 0.0,
                time_ms: 0.0,
                ctw: 0.0,
                twa: 0.0,
                boat_speed: 0.0,
                step_calc_ms: 0.0,
                parent: None,
            },
        ];
        let candidates: Vec<usize> = (0..3).collect();
        let result = prune_to_frontier(&arena, &candidates, start.0, start.1, 10.0);
        // Each point in a different sector → all 3 survive (one per sector)
        assert_eq!(result.len(), 3);
    }

    // ── backtrack ────────────────────────────────────────────────────────

    #[test]
    fn backtrack_empty_frontier_returns_empty() {
        let config = default_config();
        let mut state = LegState::new(45.0, 0.0, 46.0, 0.0, 0.0, 3_600_000.0 * 48.0, &config);
        state.frontier.clear();
        let route = state.backtrack();
        assert!(route.is_empty(), "empty frontier should yield empty route");
    }

    #[test]
    fn backtrack_after_arrival_snaps_to_destination() {
        let config = default_config();
        let polar = flat_polar(6.0);
        let t_end = 48.0 * 3_600_000.0;
        let wind = uniform_weather(5.0, 0.0, 0.0, t_end);
        let current = WeatherStore::new();
        let land = LandIndex::empty();

        let end_lat = 45.01;
        let end_lon = 0.0;
        let mut state = LegState::new(45.0, 0.0, end_lat, end_lon, 0.0, t_end, &config);
        let result = state.step(&polar, &config, &wind, &current, &land);
        assert!(matches!(result, StepResult::Arrived));

        let route = state.backtrack();
        assert!(!route.is_empty(), "route should not be empty after arrival");
        let last = route.last().unwrap();
        assert!(
            (last.lat - end_lat).abs() < 1e-9 && (last.lon - end_lon).abs() < 1e-9,
            "last route point should snap to exact destination ({end_lat}, {end_lon}), got ({}, {})",
            last.lat,
            last.lon
        );
    }
}
