// WASM isochrone routing — session-based entry point for wasm-bindgen.
#![allow(clippy::too_many_arguments)]
//
// The JS worker creates a RouterSession, pushes weather frames on demand,
// and drives the routing loop one step at a time. No per-point JS callbacks
// in the hot loop — all data crosses the boundary once as flat arrays.

mod geo;
mod isochrone;
mod land;
mod polar;
mod weather;

use isochrone::{LegConfig, LegState, RoutePoint, StepResult};
use land::LandIndex;
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
    /// The frontier collapsed after some progress; `route()` stops short of the destination.
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
    /// - `options`: flat config array (same layout as before)
    /// - `land_index`: raw binary land-edge-index buffer (LNDX or DLND, version 2)
    #[wasm_bindgen(constructor)]
    pub fn new(
        polar_twa: &[f64],
        polar_tws: &[f64],
        polar_speeds: &[f64],
        legs: &[f64],
        departure_ms: f64,
        forecast_end_ms: f64,
        options: &[f64],
        land_index: &[u8],
    ) -> Result<RouterSession, JsValue> {
        let polar = PolarData::from_flat(polar_twa, polar_tws, polar_speeds);

        let config = LegConfig {
            heading_step: options.first().copied().unwrap_or(5.0),
            sector_size: options.get(1).copied().unwrap_or(1.0),
            min_boat_speed: options.get(2).copied().unwrap_or(0.3),
            max_wind_kn: options.get(3).copied().unwrap_or(0.0),
            motor_speed_kn: options.get(5).copied().unwrap_or(0.0),
            motor_below_kn: options.get(6).copied().unwrap_or(0.0),
            wait_for_wind: options.get(7).copied().unwrap_or(0.0) > 0.5,
            tack_penalty_sec: options.get(8).copied().unwrap_or(30.0),
            tack_threshold_deg: options.get(9).copied().unwrap_or(60.0),
            cone_half_angle: options.get(10).copied().unwrap_or(100.0),
            cone_disable_lookahead_nm: options.get(11).copied().unwrap_or(100.0),
            max_heading_change: options.get(12).copied().unwrap_or(120.0),
            arrival_radius_nm: options.get(13).copied().unwrap_or(0.0),
        };

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

        let state = match self.leg_state.as_mut() {
            Some(s) => s,
            None => return StepStatus::Blocked,
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
                    .map(|p| p.time_ms)
                    .unwrap_or(self.departure_ms);
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

// ── tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const LAND_INDEX_MAGIC_LNDX: u32 = 0x4c4e4458;
    const LAND_INDEX_VERSION: u32 = 2;
    const HOUR_MS: f64 = 3_600_000.0;
    const FORECAST_HOURS: f64 = 48.0;
    const WIND_V_MS: f32 = 5.0;

    // Waypoints along the equator. `session()` puts wind at `WINDY_LON` and a flat
    // calm at `CALM_LON`, so a leg starting at `CALM_LON` cannot make way.
    const WINDY_LON: f64 = 0.0;
    const CALM_LON: f64 = 0.03;
    const FAR_LON: f64 = 1.0;

    /// Land index with no polygons: open water everywhere.
    fn empty_land_binary() -> Vec<u8> {
        let mut buf = Vec::with_capacity(32);
        buf.extend_from_slice(&LAND_INDEX_MAGIC_LNDX.to_le_bytes());
        buf.extend_from_slice(&LAND_INDEX_VERSION.to_le_bytes());
        buf.extend_from_slice(&[0u8; 24]); // reserved, zero polygon/edge/poly counts, padding
        buf
    }

    /// Session over the given `[lat, lon, ...]` waypoints with a 10 kn beam-reach polar
    /// and one wind frame: 5 m/s southerly for lon ≤ 0.01, flat calm for lon ≥ 0.02.
    fn session(waypoints: &[f64]) -> RouterSession {
        let options = [
            5.0, 1.0, 0.3, 0.0, 0.0, 0.0, 0.0, 0.0, 30.0, 60.0, 100.0, 100.0, 120.0, 0.0,
        ];
        let mut session = RouterSession::new(
            &[0.0, 90.0, 180.0],
            &[5.0, 10.0, 20.0],
            &[0.0, 0.0, 0.0, 10.0, 10.0, 10.0, 8.0, 8.0, 8.0],
            waypoints,
            0.0,
            FORECAST_HOURS * HOUR_MS,
            &options,
            &empty_land_binary(),
        )
        .unwrap_or_else(|_| panic!("session construction failed"));

        // Grid lon nodes: -0.01, 0.00, 0.01, 0.02, 0.03, 0.04; lat nodes: -0.01, 0.01.
        let row = [WIND_V_MS, WIND_V_MS, WIND_V_MS, 0.0, 0.0, 0.0];
        let v: Vec<f32> = row.iter().chain(row.iter()).copied().collect();
        let u = vec![0.0f32; v.len()];
        session.push_wind_frame(0.0, &u, &v, -0.01, -0.01, 0.02, 0.01, 2, 6);
        session
    }

    #[test]
    fn single_leg_reaching_destination_reports_arrived() {
        let mut s = session(&[0.0, WINDY_LON, 0.0, CALM_LON]);

        assert_eq!(s.step(), StepStatus::Arrived);
        let last = s.full_route.last().expect("route has points");
        assert_eq!((last.lat, last.lon), (0.0, CALM_LON));
        assert_eq!(s.error(), None);
    }

    #[test]
    fn blocked_second_leg_reports_partial_route_not_arrived() {
        let mut s = session(&[0.0, WINDY_LON, 0.0, CALM_LON, 0.0, FAR_LON]);

        // First leg arrives; the session moves on to the second leg.
        assert_eq!(s.step(), StepStatus::Running);
        // Second leg starts in a calm and its frontier collapses immediately.
        assert_eq!(s.step(), StepStatus::PartialNoProgress);
        assert_eq!(s.error(), None);
        let last = s.full_route.last().expect("partial route has points");
        assert_eq!((last.lat, last.lon), (0.0, CALM_LON));
        // The terminal status is sticky — it never turns into Arrived.
        assert_eq!(s.step(), StepStatus::PartialNoProgress);
    }

    #[test]
    fn first_leg_without_progress_reports_blocked_with_error() {
        let mut s = session(&[0.0, CALM_LON, 0.0, FAR_LON]);

        assert_eq!(s.step(), StepStatus::Blocked);
        assert!(s.full_route.is_empty());
        assert!(s.error().is_some());
        assert_eq!(s.step(), StepStatus::Blocked);
    }
}
