// WASM isochrone routing — session-based entry point for wasm-bindgen.
//
// The JS worker creates a RouterSession, pushes weather frames on demand,
// and drives the routing loop one step at a time. No per-point JS callbacks
// in the hot loop — all data crosses the boundary once as flat arrays.

mod geo;
mod isochrone;
mod land;
mod options;
mod polar;
mod weather;

use isochrone::{LegConfig, LegState, RoutePoint, StepResult};
use land::LandIndex;
use options::RoutingOptions;
use polar::PolarData;
use wasm_bindgen::prelude::*;
use weather::WeatherStore;

// ── Single remaining JS callback: progress reporting ─────────────────────────

#[wasm_bindgen]
extern "C" {
    fn js_on_progress(pct: f64, frontier: &[f64]); // flat [lat1, lon1, lat2, lon2, ...]
}

// ── Step outcome ─────────────────────────────────────────────────────────────

/// Outcome of `RouterSession::step()`. Every variant except `Running` is terminal.
#[wasm_bindgen]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StepStatus {
    /// Frontier advanced (or a non-final leg arrived); call `step()` again.
    Running = 0,
    /// Every leg reached its destination; `route()` ends at the final destination.
    Arrived = 1,
    /// The frontier collapsed after some progress; `route()` holds the legs completed
    /// before the collapse and stops short of the destination.
    PartialNoProgress = 2,
    /// The frontier collapsed before any route existed; `error()` explains why.
    Blocked = 3,
    /// The next step would exceed the forecast horizon; `route()` stops short of the destination.
    ForecastExhausted = 4,
}

// ── RouterSession ────────────────────────────────────────────────────────────

/// Step-based routing session. Create one per route calculation.
///
/// # Lifecycle
/// 1. `new(polar, legs, options, land_index_binary)` — construct session
/// 2. Loop:
///    a. `needs()` → `[time_lo_ms, time_hi_ms]` (empty if done/error)
///    b. Push weather frames covering that bracket via `push_wind_frame` / `push_current_frame`
///    c. `step()` → `StepStatus`; stop on any status other than `Running`
///    d. Read `progress()` for display
/// 3. `route()` → final route as flat array
#[wasm_bindgen]
pub struct RouterSession {
    polar: PolarData,
    config: LegConfig,
    wind: WeatherStore,
    current: WeatherStore,
    land: LandIndex,
    // Leg management
    legs: Vec<(f64, f64, f64, f64)>, // [(start_lat, start_lon, end_lat, end_lon), ...]
    current_leg: usize,
    leg_state: Option<LegState>,
    full_route: Vec<RoutePoint>,
    departure_ms: f64,
    forecast_end_ms: f64,
    // Terminal step outcome; `None` while routing is still in progress.
    outcome: Option<StepStatus>,
    error: Option<String>,
    // Cached progress
    last_pct: f64,
    last_frontier: Vec<f64>,
}

#[wasm_bindgen]
impl RouterSession {
    /// Create a new routing session.
    ///
    /// # Arguments
    /// - `polar_twa`, `polar_tws`, `polar_speeds`: polar diagram (same as before)
    /// - `legs`: flat `[lat0, lon0, lat1, lon1, ..., latN, lonN]`
    /// - `departure_ms`: departure timestamp
    /// - `forecast_end_ms`: end of forecast coverage (from minifest)
    /// - `options`: `RoutingOptions` object with named fields; missing,
    ///   non-finite, out-of-range or unsupported values are rejected
    /// - `land_index`: raw binary land-edge-index buffer (LNDX or DLND, version 2)
    ///
    /// # Errors
    ///
    /// Returns an error if `land_index` is not a valid land-edge-index buffer or
    /// `legs` holds fewer than two points.
    #[wasm_bindgen(constructor)]
    pub fn new(
        polar_twa: &[f64],
        polar_tws: &[f64],
        polar_speeds: &[f64],
        legs: &[f64],
        departure_ms: f64,
        forecast_end_ms: f64,
        options: JsValue,
        land_index: &[u8],
    ) -> Result<RouterSession, JsValue> {
        let polar = PolarData::from_flat(polar_twa, polar_tws, polar_speeds);

        let options: RoutingOptions = serde_wasm_bindgen::from_value(options)
            .map_err(|e| JsValue::from_str(&format!("Invalid routing options: {e}")))?;
        let config = LegConfig::try_from(options)
            .map_err(|e| JsValue::from_str(&format!("Invalid routing options: {e}")))?;
        let land = LandIndex::from_binary(land_index).map_err(|e| JsValue::from_str(&e))?;

        // Parse leg endpoints
        let n_points = legs.len() / 2;
        if n_points < 2 {
            return Err(JsValue::from_str("Need at least start and end points"));
        }
        let mut leg_list = Vec::with_capacity(n_points - 1);
        for i in 0..n_points - 1 {
            leg_list.push((
                legs[i * 2],
                legs[i * 2 + 1],
                legs[(i + 1) * 2],
                legs[(i + 1) * 2 + 1],
            ));
        }

        // Initialize the first leg
        let (s_lat, s_lon, e_lat, e_lon) = leg_list[0];
        let leg_state = LegState::new(
            s_lat,
            s_lon,
            e_lat,
            e_lon,
            departure_ms,
            forecast_end_ms,
            &config,
        );

        Ok(RouterSession {
            polar,
            config,
            wind: WeatherStore::new(),
            current: WeatherStore::new(),
            land,
            legs: leg_list,
            current_leg: 0,
            leg_state: Some(leg_state),
            full_route: Vec::new(),
            departure_ms,
            forecast_end_ms,
            outcome: None,
            error: None,
            last_pct: 0.0,
            last_frontier: Vec::new(),
        })
    }

    /// Push a wind forecast frame. Frames must be pushed in chronological order.
    ///
    /// `u`, `v`: flat row-major `Float32Array` `[lat_idx * n_lon + lon_idx]`, m/s.
    /// Grid: regular lat/lon starting at `(lat_min, lon_min)` with steps.
    pub fn push_wind_frame(
        &mut self,
        time_ms: f64,
        u: &[f32],
        v: &[f32],
        lat_min: f64,
        lon_min: f64,
        lat_step: f64,
        lon_step: f64,
        n_lat: u32,
        n_lon: u32,
    ) {
        self.wind.push_frame(
            time_ms,
            u,
            v,
            lat_min,
            lon_min,
            lat_step,
            lon_step,
            n_lat as usize,
            n_lon as usize,
        );
    }

    /// Push an ocean current forecast frame (same format as wind).
    pub fn push_current_frame(
        &mut self,
        time_ms: f64,
        u: &[f32],
        v: &[f32],
        lat_min: f64,
        lon_min: f64,
        lat_step: f64,
        lon_step: f64,
        n_lat: u32,
        n_lon: u32,
    ) {
        self.current.push_frame(
            time_ms,
            u,
            v,
            lat_min,
            lon_min,
            lat_step,
            lon_step,
            n_lat as usize,
            n_lon as usize,
        );
    }

    /// Time bracket needed for the next step: `[current_time_ms, next_time_ms]`.
    /// Returns an empty array once a terminal outcome has been reached.
    pub fn needs(&self) -> js_sys::Float64Array {
        if self.outcome.is_some() {
            return js_sys::Float64Array::new_with_length(0);
        }
        if let Some(state) = &self.leg_state {
            let arr = js_sys::Float64Array::new_with_length(2);
            arr.copy_from(&[state.current_time_ms(), state.next_time_ms()]);
            arr
        } else {
            js_sys::Float64Array::new_with_length(0)
        }
    }

    /// Run one expansion step. Once a terminal status has been returned,
    /// further calls return the same status.
    pub fn step(&mut self) -> StepStatus {
        if let Some(outcome) = self.outcome {
            return outcome;
        }

        let Some(state) = self.leg_state.as_mut() else {
            return StepStatus::Blocked;
        };

        let result = state.step(
            &self.polar,
            &self.config,
            &self.wind,
            &self.current,
            &self.land,
        );

        let outcome = match result {
            StepResult::Running => {
                // Update cached progress
                self.last_pct = state.progress_pct();
                self.last_frontier = state
                    .frontier_points()
                    .iter()
                    .flat_map(|(a, b)| [*a, *b])
                    .collect();
                // Report progress via JS callback
                js_on_progress(self.last_pct, &self.last_frontier);
                return StepStatus::Running;
            }
            StepResult::Arrived => {
                self.finish_leg();
                if self.current_leg < self.legs.len() {
                    // More legs — still running
                    return StepStatus::Running;
                }
                StepStatus::Arrived
            }
            StepResult::NoProgress => {
                self.finish_leg();
                if self.full_route.is_empty() {
                    self.error = Some(format!(
                        "No reachable positions on leg {}",
                        self.current_leg
                    ));
                    StepStatus::Blocked
                } else {
                    StepStatus::PartialNoProgress
                }
            }
            StepResult::ForecastExhausted => {
                self.finish_leg();
                StepStatus::ForecastExhausted
            }
        };
        self.outcome = Some(outcome);
        outcome
    }

    /// Progress info: `[pct, lat0, lon0, lat1, lon1, ...]`.
    pub fn progress(&self) -> js_sys::Float64Array {
        let mut flat = Vec::with_capacity(1 + self.last_frontier.len());
        flat.push(self.last_pct);
        flat.extend_from_slice(&self.last_frontier);
        let arr = js_sys::Float64Array::new_with_length(flat.len() as u32);
        arr.copy_from(&flat);
        arr
    }

    /// Final route as flat array: `[n_points, lat, lon, time_ms, ctw, twa, boat_speed, step_calc_ms, ...]`.
    /// 7 fields per point, prefixed with point count.
    pub fn route(&self) -> js_sys::Float64Array {
        let fields_per_point = 7;
        let mut flat = Vec::with_capacity(1 + self.full_route.len() * fields_per_point);
        flat.push(self.full_route.len() as f64);
        for p in &self.full_route {
            flat.push(p.lat);
            flat.push(p.lon);
            flat.push(p.time_ms);
            flat.push(p.ctw);
            flat.push(p.twa);
            flat.push(p.boat_speed);
            flat.push(p.step_calc_ms);
        }
        let arr = js_sys::Float64Array::new_with_length(flat.len() as u32);
        arr.copy_from(&flat);
        arr
    }

    /// Error message, if any.
    pub fn error(&self) -> Option<String> {
        self.error.clone()
    }

    /// Evict weather frames that the router has passed. Call periodically to free memory.
    pub fn evict_old_frames(&mut self) {
        if let Some(state) = &self.leg_state {
            let t = state.current_time_ms();
            self.wind.evict_before(t);
            self.current.evict_before(t);
        }
    }

    /// Clear all stored wind and current frames so they can be re-pushed
    /// with a wider grid (dynamic corridor expansion).
    pub fn clear_weather(&mut self) {
        self.wind = WeatherStore::new();
        self.current = WeatherStore::new();
    }

    // ── internal ─────────────────────────────────────────────────────────────

    /// Finish the current leg: backtrack its route and advance to the next leg.
    fn finish_leg(&mut self) {
        if let Some(state) = self.leg_state.take() {
            let route = state.backtrack();

            if self.full_route.is_empty() {
                self.full_route = route;
            } else if !route.is_empty() {
                // Skip the first point (duplicate of previous leg's end)
                self.full_route.extend_from_slice(&route[1..]);
            }

            self.current_leg += 1;

            // Start next leg if available
            if self.current_leg < self.legs.len() {
                let leg_departure = self
                    .full_route
                    .last()
                    .map_or(self.departure_ms, |p| p.time_ms);
                let (s_lat, s_lon, e_lat, e_lon) = self.legs[self.current_leg];
                self.leg_state = Some(LegState::new(
                    s_lat,
                    s_lon,
                    e_lat,
                    e_lon,
                    leg_departure,
                    self.forecast_end_ms,
                    &self.config,
                ));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR_MS: f64 = 3_600_000.0;
    const FORECAST_END_MS: f64 = 48.0 * HOUR_MS;

    fn config() -> LegConfig {
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

    /// Uniform wind over lat 30–60, lon −20–20: `calm_ms` at t=0, `storm_ms` from 1 s on.
    fn wind_turning_to_storm(calm_ms: f32, storm_ms: f32) -> WeatherStore {
        let (n_lat, n_lon) = (31, 41);
        let mut ws = WeatherStore::new();
        for (time_ms, speed) in [(0.0, calm_ms), (1_000.0, storm_ms)] {
            let u = vec![speed; n_lat * n_lon];
            let v = vec![0.0; n_lat * n_lon];
            ws.push_frame(time_ms, &u, &v, 30.0, -20.0, 1.0, 1.0, n_lat, n_lon);
        }
        ws
    }

    /// Session built field-by-field: `new()` takes a `JsValue`, which is unusable off wasm.
    fn session(legs: Vec<(f64, f64, f64, f64)>, wind: WeatherStore) -> RouterSession {
        let config = config();
        let (s_lat, s_lon, e_lat, e_lon) = legs[0];
        let leg_state = LegState::new(s_lat, s_lon, e_lat, e_lon, 0.0, FORECAST_END_MS, &config);
        let flat_speeds = vec![6.0; 3 * 2];
        RouterSession {
            polar: PolarData::from_flat(&[0.0, 90.0, 180.0], &[0.0, 30.0], &flat_speeds),
            config,
            wind,
            current: WeatherStore::new(),
            land: LandIndex::empty(),
            legs,
            current_leg: 0,
            leg_state: Some(leg_state),
            full_route: Vec::new(),
            departure_ms: 0.0,
            forecast_end_ms: FORECAST_END_MS,
            outcome: None,
            error: None,
            last_pct: 0.0,
            last_frontier: Vec::new(),
        }
    }

    #[test]
    fn single_leg_reaching_destination_reports_arrived() {
        let mut s = session(
            vec![(45.0, 0.0, 45.01, 0.0)],
            wind_turning_to_storm(5.0, 5.0),
        );

        assert_eq!(s.step(), StepStatus::Arrived);
        assert_eq!(s.error(), None);
        let last = s.full_route.last().expect("route has points");
        assert!((last.lat - 45.01).abs() < 1e-9 && last.lon.abs() < 1e-9);
    }

    #[test]
    fn frontier_collapse_on_later_leg_is_not_reported_as_arrival() {
        // Leg 1 (~0.6 nm) is reached in its first step under a 5 m/s breeze. By then the
        // wind is 60 m/s (> max_wind_kn), so leg 2 cannot expand and its frontier collapses.
        let mut s = session(
            vec![(45.0, 0.0, 45.01, 0.0), (45.01, 0.0, 46.0, 0.0)],
            wind_turning_to_storm(5.0, 60.0),
        );

        assert_eq!(s.step(), StepStatus::Running, "leg 1 arrives, leg 2 starts");
        assert_eq!(s.current_leg, 1);

        assert_eq!(s.step(), StepStatus::PartialNoProgress);
        assert_eq!(s.error(), None, "leg 1 is kept as a partial route");
        let last = s.full_route.last().expect("partial route from leg 1");
        assert!((last.lat - 45.01).abs() < 1e-9 && last.lon.abs() < 1e-9);
        // The terminal status is sticky — it never turns into Arrived.
        assert_eq!(s.step(), StepStatus::PartialNoProgress);
    }

    #[test]
    fn first_leg_without_progress_reports_blocked_with_error() {
        // 60 m/s from the start exceeds max_wind_kn, so leg 1 never expands.
        let mut s = session(
            vec![(45.0, 0.0, 46.0, 0.0)],
            wind_turning_to_storm(60.0, 60.0),
        );

        assert_eq!(s.step(), StepStatus::Blocked);
        assert!(s.full_route.is_empty());
        assert!(s.error().is_some());
        assert_eq!(
            s.step(),
            StepStatus::Blocked,
            "a blocked session never reports arrival"
        );
    }
}
