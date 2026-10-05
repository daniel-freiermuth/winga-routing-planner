// Routing configuration received from JS: named fields, strictly validated into a LegConfig.

use serde::Deserialize;

use crate::isochrone::LegConfig;

/// Routing configuration as sent by the worker. Every field is required, so a
/// renamed, misspelt or missing option is an error rather than a silent default.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingOptions {
    pub heading_step: f64,
    pub sector_size: f64,
    pub min_boat_speed: f64,
    /// 0 = no limit.
    pub max_wind_kn: f64,
    /// 0 = no limit. Any other value is rejected until wave data reaches the router.
    pub max_wave_m: f64,
    pub motor_speed_kn: f64,
    pub motor_below_kn: f64,
    pub wait_for_wind: bool,
    pub tack_penalty_sec: f64,
    pub tack_threshold_deg: f64,
    pub cone_half_angle: f64,
    pub cone_disable_lookahead_nm: f64,
    pub max_heading_change: f64,
    /// 0 = derive the arrival radius from step distance.
    pub arrival_radius_nm: f64,
}

fn non_negative(name: &str, value: f64) -> Result<f64, String> {
    if value.is_finite() && value >= 0.0 {
        Ok(value)
    } else {
        Err(format!("{name} must be a finite number ≥ 0, got {value}"))
    }
}

/// Used where 0 would cause a division by zero or a non-advancing loop.
fn positive(name: &str, value: f64) -> Result<f64, String> {
    if value.is_finite() && value > 0.0 {
        Ok(value)
    } else {
        Err(format!("{name} must be a finite number > 0, got {value}"))
    }
}

impl TryFrom<RoutingOptions> for LegConfig {
    type Error = String;

    fn try_from(o: RoutingOptions) -> Result<Self, Self::Error> {
        if non_negative("maxWaveM", o.max_wave_m)? != 0.0 {
            return Err(
                "Max wave height limit is not supported: wave data is not available to the router. \
                 Clear the max wave setting to calculate a route."
                    .to_string(),
            );
        }
        Ok(LegConfig {
            heading_step: positive("headingStep", o.heading_step)?,
            sector_size: positive("sectorSize", o.sector_size)?,
            min_boat_speed: non_negative("minBoatSpeed", o.min_boat_speed)?,
            max_wind_kn: non_negative("maxWindKn", o.max_wind_kn)?,
            motor_speed_kn: non_negative("motorSpeedKn", o.motor_speed_kn)?,
            motor_below_kn: non_negative("motorBelowKn", o.motor_below_kn)?,
            wait_for_wind: o.wait_for_wind,
            tack_penalty_sec: non_negative("tackPenaltySec", o.tack_penalty_sec)?,
            tack_threshold_deg: non_negative("tackThresholdDeg", o.tack_threshold_deg)?,
            cone_half_angle: positive("coneHalfAngle", o.cone_half_angle)?,
            cone_disable_lookahead_nm: non_negative(
                "coneDisableLookaheadNm",
                o.cone_disable_lookahead_nm,
            )?,
            max_heading_change: positive("maxHeadingChange", o.max_heading_change)?,
            arrival_radius_nm: non_negative("arrivalRadiusNm", o.arrival_radius_nm)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid() -> RoutingOptions {
        RoutingOptions {
            heading_step: 5.0,
            sector_size: 1.0,
            min_boat_speed: 0.3,
            max_wind_kn: 25.0,
            max_wave_m: 0.0,
            motor_speed_kn: 6.0,
            motor_below_kn: 2.0,
            wait_for_wind: true,
            tack_penalty_sec: 30.0,
            tack_threshold_deg: 60.0,
            cone_half_angle: 100.0,
            cone_disable_lookahead_nm: 100.0,
            max_heading_change: 120.0,
            arrival_radius_nm: 0.0,
        }
    }

    #[test]
    fn valid_options_map_by_name() {
        let c = LegConfig::try_from(valid()).unwrap();
        assert_eq!(c.heading_step, 5.0);
        assert_eq!(c.max_wind_kn, 25.0);
        assert_eq!(c.motor_speed_kn, 6.0);
        assert_eq!(c.motor_below_kn, 2.0);
        assert!(c.wait_for_wind);
        assert_eq!(c.tack_penalty_sec, 30.0);
        assert_eq!(c.max_heading_change, 120.0);
    }

    #[test]
    fn wave_limit_is_rejected() {
        let err = LegConfig::try_from(RoutingOptions {
            max_wave_m: 3.0,
            ..valid()
        })
        .err()
        .unwrap();
        assert!(err.contains("wave"), "{err}");
    }

    #[test]
    fn nan_is_rejected() {
        let err = LegConfig::try_from(RoutingOptions {
            max_wind_kn: f64::NAN,
            ..valid()
        })
        .err()
        .unwrap();
        assert!(err.contains("maxWindKn"), "{err}");
    }

    #[test]
    fn negative_is_rejected() {
        let err = LegConfig::try_from(RoutingOptions {
            tack_penalty_sec: -1.0,
            ..valid()
        })
        .err()
        .unwrap();
        assert!(err.contains("tackPenaltySec"), "{err}");
    }

    #[test]
    fn zero_heading_step_is_rejected() {
        let err = LegConfig::try_from(RoutingOptions {
            heading_step: 0.0,
            ..valid()
        })
        .err()
        .unwrap();
        assert!(err.contains("headingStep"), "{err}");
    }
}
