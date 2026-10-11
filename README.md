# Winga Weather Routing

> [!CAUTION]
> **Experimental — read before use.**
>
> - Calculated routes have not been validated by sailing them and **may cross land or shallow water**.
> - Weather forecasts change. The route calculated now may not reflect conditions at departure time. Always obtain up-to-date forecasts and check for NOTAMs and local hazards.
> - This plugin **does not replace good seamanship**, a qualified navigator, or certified navigation software. Use is entirely at your own risk.

A SignalK webapp that calculates time-optimal sailing routes using live weather forecasts and the isochrone method.

![logo](wr-icon-128px.png)

## Features

- **Isochrone routing** with ECMWF wind forecasts, CMEMS ocean currents, and ECMWF-WAM wave data
- **Intermediate waypoints** — route through required waypoints in order
- **Land avoidance** using [GSHHG](https://www.soest.hawaii.edu/pwessel/gshhg/) high-resolution coastlines, with optional 0.5 NM safety margin
- **Tack/gybe penalty** — configurable time penalty (default 30 s) for heading changes above a threshold (default 60 deg)
- **Conditions table** — horizontal timeline showing per-waypoint TWS, gust, wind direction, TWA (with port/starboard indicator), CTW, STW, COG, SOG, wave height, wave period, encounter period, wave direction, WoW speed/direction, current speed/direction
- **Wind/wave/current overlays** with temporal interpolation between forecast steps
- **Polar diagram editor** — half-circle SVG view, drag vertices, CSV upload, or quick-generate from three speeds
- **Route saving** to SignalK `resources/routes` — visible in freeboard-sk

## Requirements

- SignalK server >= 2.0.0
- A polar diagram (upload CSV or enter upwind/beam/downwind speeds)
- A modern browser (WebGL for MapLibre GL JS, Web Worker for routing)

## Installation

Install from the **SignalK App Store** (Server -> Appstore -> Available) and restart SignalK.

## Usage

Open the webapp at `http://<your-signalk-host>:3000/winga-weather-routing/`.

### Workflow

1. **Load a polar** — upload a CSV or enter three speeds and click Generate
2. **Set start and destination** — click the map or right-click -> context menu
3. **Add intermediate waypoints** (optional) — right-click -> Add waypoint, or click "+ Add waypoint"
4. **Set departure time**
5. **Calculate Route** — isochrones animate live; the result shows a red route line, wind barbs, and a conditions table

### Conditions table

Below the map. Each column is a waypoint along the route, left to right in time.

| Row | Description |
|-----|-------------|
| TWS | True Wind Speed (forecast wind, not adjusted for current) |
| Gust | Peak gust speed from ECMWF |
| Wind | True wind direction (meteorological FROM convention) |
| WoW | Wind over Water — true wind minus current (only shown with current data) |
| WoW dir | Wind over Water direction |
| TWA | True Wind Angle with tack indicator (◀ port, ▶ starboard) |
| CTW | Course Through Water (before current drift) |
| STW | Speed Through Water (from polar lookup) |
| COG | Course Over Ground (including current drift) |
| SOG | Speed Over Ground |
| Wave | Significant wave height (Hs) |
| Period | Mean wave period |
| Enc. per. | Encounter period — wave period as felt by the moving boat |
| Wave dir | Wave propagation direction |
| Current | Ocean current speed |
| Cur dir | Current flow direction |

- Click a column to jump the scrubber to that time
- Click the unit label (kn/m/s/km/h/Bft) on wind rows to cycle units
- Hover row labels for explanations

### Routing settings

In the Settings gear icon:

- **Coast avoidance** — enabled by default
- **Safety margin** — dilates coastline by 0.5 NM
- **Motor** — threshold wind speed and motor speed for light-wind legs
- **Wait for wind** — hold position through calm patches instead of giving up
- **Max wind** — reject routes through areas exceeding the limit
- **Max wave** — not yet supported by the router; setting a value stops the calculation with an error (leave empty)
- **Tack/gybe penalty** — seconds lost per tack (default 30 s when heading changes > 60 deg)

### Map interactions

- **Right-click** — set start, destination, or add waypoint
- **Click route line** — jump scrubber to that point
- **Layer toggles** — wind barbs, wave height, currents, land, isochrones, regions

### Time scrubber

Drag to browse forecast times. Wind, wave, and current overlays interpolate between native forecast steps. After route calculation, the scrubber includes waypoint times for exact column-to-scrubber sync.

## Polar diagram

### Format

Standard ORC/OpenCPN semicolon-delimited CSV:

```
twa/tws;6;8;10;12;14;16;20
52;4.5;5.2;5.8;6.1;6.3;6.4;6.5
...
```

### Interpretation

- **TWA** — angle between wind-over-water direction and course through water. VPP-derived polars (ORC, IRC) include leeway in their TWA values.
- **TWS** — wind speed relative to the water. The algorithm subtracts the current vector from the true wind before polar lookup.
- **Boat speed** — speed through water along the course. Current is applied separately for the ground track.

## Routing physics

At each isochrone step, the algorithm computes:

1. **True wind** — ECMWF forecast, bilinear spatial + linear temporal interpolation
2. **Ocean current** — CMEMS forecast (72 h horizon), same interpolation
3. **Wind over water** — `true_wind − current` (what the boat feels)
4. **TWA + boat speed** — from the polar at `|CTW − WoW_direction|`
5. **Tack penalty** — if heading changes > threshold, deduct penalty time from the step
6. **Water track** — boat moves at polar speed along CTW
7. **Ground track** — water track + current displacement
8. **Land/region check** — ground track tested against GSHHG coastline and avoidance regions

### Displayed vs computed values

| Displayed | Source |
|-----------|--------|
| TWS, Wind dir | True (forecast) wind — NOT adjusted for current |
| WoW, WoW dir | True wind minus current — what the polar uses |
| TWA | Computed from CTW and WoW direction |
| STW | Polar lookup at TWA/WoW speed |
| COG, SOG | From consecutive ground positions |
| Encounter period | Deep-water dispersion: `T_e = 2pi / (omega_0 * (1 - omega_0 * V * cos(mu) / g))` |

### What is NOT modelled

- **Leeway** — not computed explicitly; VPP polars include it
- **Apparent wind** — polar is indexed by true wind over water
- **Wave effects on speed** — wave height is a constraint, not a speed reduction
- **Shallow-water dispersion** — encounter period uses the deep-water approximation (accurate when depth > wavelength / 2)

## Data sources

| Data | Source | Resolution | Horizon |
|------|--------|------------|---------|
| Wind, gust | ECMWF HRES via Windy | ~9 km | 6 days |
| Waves, period, direction | ECMWF WAM via Windy | ~14 km | 6 days |
| Ocean currents | CMEMS via Windy | ~9 km | 72 h |
| Coastlines | GSHHG v2.3.7 | ~100 m | static |

All forecast data is fetched as PNG/JPEG tiles from Windy's CDN. No API key required.

## Land data

Pre-built binary indices are bundled. High-resolution coastlines (~100 m) are available from [weather-routing-hires-land-data](https://github.com/kristianwiklund/weather-routing-hires-land-data).

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md).
