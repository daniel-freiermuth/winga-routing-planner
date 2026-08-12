// Isochrone routing algorithm — time-optimal route search via frontier expansion.
// This is the hot loop that benefits from WASM: O(frontier × headings × steps) of
// trig, polar lookup, and candidate pruning.

use crate::geo::{bearing_to, destination_point, haversine_nm, wind_direction, wind_speed_knots};
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
                // Heading-change constraint (same as regular loop, line 302-307)
                let direct_ok = if pt_has_parent {
                    let delta = ((pt_to_dest - pt_ctw + 180.0 + 360.0) % 360.0 - 180.0).abs();
                    delta <= config.max_heading_change
                } else {
                    true
                };
                // Tack penalty (same as regular loop, line 346-351)
                let penalty_h = if config.tack_penalty_sec > 0.0 && pt_has_parent {
                    let ctw_change = ((pt_to_dest - pt_ctw + 180.0 + 360.0) % 360.0 - 180.0).abs();
                    if ctw_change > config.tack_threshold_deg {
                        config.tack_penalty_sec / 3600.0
                    } else {
                        0.0
                    }
                } else {
                    0.0
                };
                if direct_ok
                    && eff >= config.min_boat_speed
                    && eff * (dt_hours - penalty_h).max(0.0) >= dist_to_dest
                    && !land.segment_crosses_land(pt_lat, pt_lon, end_lat, end_lon)
                {
                    let travel_h = dist_to_dest / eff + penalty_h;
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
