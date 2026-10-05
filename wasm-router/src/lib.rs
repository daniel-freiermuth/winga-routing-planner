// WASM isochrone routing — session-based entry point for wasm-bindgen.
#![allow(clippy::too_many_arguments)]
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

// ── RouterSession ────────────────────────────────────────────────────────────

/// Step-based routing session. Create one per route calculation.
///
/// # Lifecycle
/// 1. `new(polar, legs, options, land_index_binary)` — construct session
/// 2. Loop:
///    a. `needs()` → `[time_lo_ms, time_hi_ms]` (empty if done/error)
///    b. Push weather frames covering that bracket via `push_wind_frame` / `push_current_frame`
///    c. `step()` → status code
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
    // Status
    done: bool,
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
    /// - `options`: `RoutingOptions` object with named fields; missing, unknown,
    ///   non-finite, out-of-range or unsupported values are rejected
    /// - `land_index`: raw binary land-edge-index buffer (LNDX or DLND, version 2)
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
            done: false,
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
    /// Returns an empty array if done or error.
    pub fn needs(&self) -> js_sys::Float64Array {
        if self.done || self.error.is_some() {
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

    /// Run one expansion step. Returns a status code:
    /// - `0` = running (frontier advanced)
    /// - `1` = arrived at destination (call `route()` to get results)
    /// - `2` = no progress (frontier collapsed — blocked or no wind)
    /// - `3` = forecast exhausted
    pub fn step(&mut self) -> u32 {
        if self.done {
            return 1;
        }
        if self.error.is_some() {
            return 2;
        }

        let state = match self.leg_state.as_mut() {
            Some(s) => s,
            None => return 2,
        };

        let result = state.step(
            &self.polar,
            &self.config,
            &self.wind,
            &self.current,
            &self.land,
        );

        match result {
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
                0
            }
            StepResult::Arrived => {
                self.finish_leg();
                if self.current_leg >= self.legs.len() {
                    // All legs done
                    self.done = true;
                    1
                } else {
                    // More legs — still running
                    0
                }
            }
            StepResult::NoProgress => {
                // Try to use partial route
                self.finish_leg();
                self.done = true;
                if self.full_route.is_empty() {
                    self.error = Some(format!(
                        "No reachable positions on leg {}",
                        self.current_leg
                    ));
                    2
                } else {
                    // Partial route available
                    1
                }
            }
            StepResult::ForecastExhausted => {
                self.finish_leg();
                self.done = true;
                3
            }
        }
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
