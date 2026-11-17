# Changelog

## Unreleased

- Routing options reach the router as named, validated fields; a missing, non-finite or negative option now fails the calculation with an error instead of falling back to a default
- A max wave height limit now fails the calculation with an error; previously it was silently ignored because wave data does not reach the router
- Unchecking Coast avoidance now fails the calculation with an error; previously the setting was silently ignored and land avoidance was always applied
- A ticked Safety margin now applies to the route when the Settings window is closed; previously the route was calculated against the plain coastline unless Settings was open
- A route cut short by an impassable later leg or by the 500-step calculation limit now shows a partial-route warning; previously it was reported as "Route calculated"
- A typed waypoint that combines a hemisphere letter with a minus sign on the same value (e.g. `S-33.86 E151.2`) is now rejected; previously the two signs cancelled and the waypoint landed in the opposite hemisphere
- Typed waypoint text that is a single decimal-comma value ("57,68") or degrees and minutes ("57 41.5") is now rejected; previously it was read as a latitude/longitude pair
- Long east-west routes in high latitudes (e.g. Hobart → Cape Horn) now fetch weather; previously the corridor margin reached past the pole, no tiles were fetched and the route was calculated in zero wind and current. Corridor expansion near 85° latitude no longer requests non-existent tiles, which aborted the calculation
- `conditionsGraphHeight` and `forecastSkillHorizonHours` in `config.json` are no longer read; neither has had a visible effect since the conditions graph was replaced by the conditions table

## 0.1.0

Initial release under the winga-weather-routing name.

- Isochrone routing with ECMWF wind, ECMWF-WAM waves, CMEMS currents (via Windy tiles)
- Intermediate waypoint routing (multi-leg)
- Tack/gybe penalty (configurable)
- Conditions table with Windy color coding, wind unit cycling, scrubber sync
- Wind-over-water display (TWS, WoW, TWA with port/starboard indicator)
- Wave height, period, direction, encounter period
- Ocean current speed and direction
- COG/SOG computed from ground track
- Click-on-route to jump scrubber
- Land validation for start, destination, and intermediate waypoints
- Polar diagram editor (half-circle SVG, CSV upload, quick-generate)
- Forecast overlay interpolation between native time steps
- Preference persistence (map position, routing settings, wind unit)
- Route saving to SignalK resources/routes
- Svelte 5 + MapLibre GL JS architecture (all computation client-side)
