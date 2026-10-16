# Development

## Prerequisites

- Node.js 20+ (22 or 24 recommended)
- pnpm

## Setup

```bash
pnpm install
```

## Building

```bash
pnpm build          # server plugin (tsc) + webapp (vite)
pnpm build:webapp   # webapp only
```

## Checking

```bash
pnpm check          # tsc + svelte-check + eslint + tests
```

## Development server

```bash
cd webapp && npx vite dev
```

The webapp runs at `http://localhost:5173/`. Configure SignalK server URL in the
Settings panel at the bottom of the sidebar, or set `wr-signalk-url` in localStorage.

## Architecture

```
webapp/                     Svelte 5 + MapLibre GL JS (client-side)
  components/               UI components (pure props → template → events)
  app.ts                    Bootstrap: SK URL detection, mount App
  calc-state.svelte.ts      Shared reactive state (calculation module)
  sk-state.svelte.ts        Shared reactive state (SK resources module)
  config-state.svelte.ts    Shared reactive state (config module)
  data-layer.ts             Windy tile fetching and sampling
  forecast-fetcher.ts       Overlay data fetching (writes to stores)
  route-display.ts          Route polyline + wind barb rendering (MapLibre)
  calculation.ts            Routing worker orchestration + conditions graph
  worker.ts                 Web Worker — runs isochrone algorithm
  route-weather.ts          Per-waypoint weather analysis along a route
src/
  index.ts                  SignalK plugin registration (minimal)
  types.ts                  Shared types
  lib/routing/              Isochrone algorithm (used by worker.ts)
  lib/geo.ts                Geodesic math (haversine, bearing)
  lib/polar.ts              Polar diagram parsing + interpolation
  lib/landmask.ts           Land polygon bbox index (land overlay)
  lib/land-index-loader.ts  Binary land index loader
```

### Key design decisions

- **Windy tiles** for forecast data — no GRIB files needed on the server
- **Client-side routing** via Web Worker — no server-side computation
- **Svelte 5 runes** (`$state`, `$derived`, `$effect`) for all UI reactivity
- **MapLibre GL JS** via `svelte-maplibre-gl` for the map
- **Overlay components** receive map + data as props, manage MapLibre layers via `$effect`

## Running tests

```bash
pnpm test
```

## Generating land data

The plugin bundles pre-built land indices in `data/edge-index.bin.gz` and
`data/dilated-edge-index.bin.gz`. To regenerate (e.g. after changing resolution):

```bash
pip3 install shapely fiona
python3 scripts/prepare-land-data.py
```

## Publishing

1. Bump `version` in `package.json`
2. Update `CHANGELOG.md`
3. Commit, tag, push:
   ```bash
   git tag vX.Y.Z
   git push origin main --tags
   ```

The publish workflow publishes to npm automatically.
