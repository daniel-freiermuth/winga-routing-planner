# Changelog

## Unreleased

- Routing options reach the router as named, validated fields; a missing, non-finite or negative option now fails the calculation with an error instead of falling back to a default
- A max wave height limit now fails the calculation with an error; previously it was silently ignored because wave data does not reach the router

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
