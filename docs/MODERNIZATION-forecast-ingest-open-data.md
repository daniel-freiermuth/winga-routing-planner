# RFC: move forecast ingest from Windy tiles to official open data

**Status:** RFC. Nothing here has been decided. Under the repo's Specification Rule and No Assumptions Rule, decisions D1–D8 (section 6) must be recorded in `SPEC.md`, each with a GitHub issue, before any code is written.

**Fingerprint:** `winga-weather-routing:forecast-ingest:windy-reverse-engineered-tiles:format-or-protocol-shift`

All facts below were checked on 2026-11-17 against the tree at `d5a30ea` and against live endpoints. Statements marked **[INFERENCE]** were not measured.

---

## 1. Current state

### 1.1 Where forecast data enters

| File | Role |
|---|---|
| `windy-lib/ts/` (workspace package `@winga-weather-routing/windy-lib`) | Client for Windy's internal API. `index.ts` says: "reverse-engineered Windy internal API client … Discovered by inspecting network traffic and index.js (v50.1.2)". |
| `windy-lib/ts/minifest.ts` | Model-run discovery from `https://node.windy.com/metadata/v1.0/forecast`, with `CLIENT_VERSION = "50.1.2"`. |
| `windy-lib/ts/tiles.ts`, `types.ts` | Tile URL layout (`ims.windy.com/im/v3.0/forecast/…/wm_grid_257/{z}/{x}/{y}/…`), header decoding from pixel rows, bilinear sampling. `WINDY_OVERLAYS` uses `format: "jpg"` for wind, gust and currents, and `"png"` for waves. |
| `windy-lib/ts/auth.ts`, `client.ts`, `forecast.ts` | Anonymous token via a static CSRF value (`WINDY_CSRF`), a spoofed `Chrome/150` User-Agent, premium login (`loginWindy`) and point forecasts. **The app does not use any of these.** No file in `webapp/`, `src/` or `scripts/` references `WindyClient`, `loginWindy` or `fetchWindyToken`. `webapp/auth-state.svelte.ts` holds SignalK login state, not Windy state. |
| `src/lib/tile-provider.ts` | `TileWindProvider` (wind, gust, waves) and `TileCurrentProvider` (CMEMS) sample decoded tiles. Used by the routing worker. |
| `webapp/worker.ts` | Samples the providers onto a regular corridor grid (`sampleWindGrid`, `sampleCurrentGrid`) and pushes frames into WASM. It also resamples gust, waves and current at each waypoint for display. |
| `src/lib/wasm-session.ts` | `corridorGridSpec`: grid step = `360 / (2^z · 256)` degrees, so **0.176° at z3 and 0.088° at z4**. `TileWindProvider.computeZoom` clamps z to 3–4 ("Windy serves zoom 3–4 only"). |
| `webapp/data-layer.ts`, `forecast-fetcher.ts` | A second tile cache for the overlays (Wind/Wave/CurrentOverlay.svelte), `queryPointWeather`, and the time axis (`loadTimesFromWindy`). |
| `.github/workflows/pages.yml`, `publish.yml`, `package.json` scripts | Build and test the `windy-lib` workspace package. |

### 1.2 The real seam

The proposal names "the existing WindProvider/CurrentProvider types in `src/types.ts`". **Those types no longer exist.** Commit `1a1f9b0` ("drop vestigial GRIB provider types") removed them. The actual seam is narrower and easier to target:

```
RouterSession.push_wind_frame(time_ms, u: Float32Array, v: Float32Array,
                              lat_min, lon_min, lat_step, lon_step, n_lat, n_lon)
RouterSession.push_current_frame(…same shape…)
```

(`wasm-router/src/lib.rs`.) The WASM router consumes regular lat/lon grids of u/v in m/s. ECMWF open data is already a regular lat/lon grid, so the router core does not need to change. Everything above the seam does: the worker's provider classes, the overlay data layer and run discovery.

### 1.3 Which inputs affect the route

- **Affect the route:** wind u/v and current u/v.
- **Display only:** gust (`getGustAtTime`), wave height/period/direction (`getWave*AtTime`). The max-wave constraint is "not yet supported" (README).

### 1.4 Leftovers that are not reusable as-is

`test-data/*.grb2` contain DWD ICON-EU + EWAM data packed with templates 5.3 (complex/spatial differencing) and 5.40 (JPEG2000). No file in the tree references them. ECMWF open data uses template 5.42 (CCSDS), so these files cannot exercise the decoder path this migration needs. The removed GRIB code (`07acd41` "drop grib management code") was a server/upload flow, not a browser decoder.

## 2. Why change (re-verified)

1. **Terms of Use.** Windy General Terms of Use (<https://account.windy.com/agreements/windy-terms-of-use>, "latest update is effective as of 1 September 2023"), §"Prohibited activities". The following are listed as "material breach … may lead to the termination of the provision of the Services":
   - "'crawling' of the Services or otherwise using any automated means to view, access, or collect information from the Services"
   - "reverse engineering, copying, decompiling or disassembling the Services …"

   Other clauses also apply: "Free Services are intended to be used by private persons only", and "You may not use the Services or Content … to generate value added services." The router fetches Windy's private tiles automatically, with no agreement in place, and redistributes derived values to every plugin user.
2. **Continuity.** Run discovery is pinned to `CLIENT_VERSION = "50.1.2"` and a private tile layout, with header rows packed into pixels. If Windy changes either, the result may be silently mis-decoded fields rather than a clean outage. The Nautical Safety Rule treats that as a hazard.
3. **Fidelity.** `tiles.ts` itself says: "JPEG compression introduces ~1–2 DN of quantisation error, acceptable for visualisation." Routing consumes these 8-bit values (256 levels per channel), and wind and currents are JPEG. ECMWF open data is 11 bits per value (2048 levels), stored with lossless CCSDS coding. The section 5 header of the 10u message fetched on 2026-11-17 shows template 5.42 with 11 bits.
4. **The legitimate Windy path does not fit.** Windy's official Point Forecast API (<https://account.windy.com/agreements/windy-api-map-and-point-forecast-terms-of-use>) has two tiers. The Trial tier "is intended for development purposes only and the User is not allowed to use it for production". The Professional tier is paid. Both return point data, not corridor grids.
5. **The open-data constraint is gone.**
   - ECMWF opened its real-time catalogue under CC-BY-4.0 on 2025-10-01 (<https://www.ecmwf.int/en/about/media-centre/news/2025/ecmwf-makes-its-entire-real-time-catalogue-open-all>).
   - The 9 km (0.1°) subset went live on **2026-10-20** (<https://www.ecmwf.int/en/about/media-centre/news/2026/9-km-free-and-open-data-offers-step-change-localised-forecasts>). It is "released with a short delay of two hours rather than in real time … the 25 km data remains freely available in real time for all. All data must be attributed to ECMWF."
   - ECMWF's open-data page states that the data "may be redistributed and used commercially, subject to appropriate attribution".

## 3. Target state

- Wind (10u/10v), gust (10fg), waves (swh/mwd/mwp) and, subject to D3, currents (sve/svn) come from ECMWF Open Data, either `data.ecmwf.int/forecasts/…` or the AWS mirror `ecmwf-forecasts.s3.eu-central-1.amazonaws.com`.
- Each needed field is fetched by HTTP byte range using the run's `.index` file.
- Fields are decoded to `Float32Array`, cropped to the corridor and pushed through the existing `push_*_frame` seam.
- Overlays render from the same decoded grids. There is one cache, not two.
- Run discovery comes from ECMWF's directory structure and index files, not Windy's minifest.
- `windy-lib` is deleted entirely, including the unused credential flow.
- README, the in-app data-source text and CHANGELOG carry the ECMWF CC-BY-4.0 attribution.

## 4. Verified facts about ECMWF Open Data (2026-11-17)

| Fact | Evidence |
|---|---|
| CORS on AWS mirror | `curl -I -H 'Origin: https://example.org' https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com/` → `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: HEAD, GET` |
| CORS on data.ecmwf.int incl. Range | `…/20261117/00z/ifs/0p1/oper/…-27h-oper-fc-sfc.index` → `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Headers: Range, …`, `Access-Control-Expose-Headers: Content-Range, …` |
| Layout | `{date}/{HH}z/ifs/{0p1,0p25}/{oper,wave,enfo,waef}/` |
| 0.1° grid | 10u message: GRIB2, grid template 3.0, Ni=3600, Nj=1801 (6 483 600 points), packing template 5.42 (CCSDS), 11 bits |
| 0.1° steps | 00z: 85 steps, 0–144 h every 3 h, then 6-hourly to 360 h. 06z: last step 144 h. 12z: last step 360 h. Matches Windy's ECMWF `dst` example in `minifest.ts`. |
| Fields present | `oper` sfc: `10u 10v 10fg sve svn` (plus many others). `wave` sfc: `swh mwd mwp pp1d …` |
| Currents exist in ECMWF open data | `sve`/`svn` (eastward/northward sea-water velocity, ECMWF param IDs 262140/262139). Present in 0.1° `oper` sfc at 24 h, 27 h, 144 h, 150 h and 240 h. They come from the IFS-coupled ocean model, **not CMEMS**. |
| Gust gaps | `10fg` was absent from the 0.1° 144 h index. It was present at 27 h, 150 h and 240 h. |
| Open-Meteo marine | `marine-api.open-meteo.com` returned `access-control-allow-origin: *` and `wave_height`, `ocean_current_velocity` for 55.5 N 12.8 E. The free tier is for non-commercial use only (<https://open-meteo.com/en/terms>). |

## 5. The blocking issue: download volume

The proposal assumed byte ranges could select "only the needed fields **and area**". **That is not true.** Each GRIB2 message is one global field, and CCSDS-packed data cannot be cut down by area. Byte ranges select fields only. Measured `_length` per message, 2026-11-17 00z, step 24 h:

| Field | 0.1° | 0.25° |
|---|---|---|
| 10u | 2.93 MB | 0.74 MB |
| 10v | 2.81 MB | 0.60 MB |
| sve | 2.91 MB | 0.56 MB |
| svn | 2.73 MB | 0.53 MB |
| 10fg | 2.43 MB | 0.52 MB |
| swh | 1.92 MB | 0.40 MB |
| mwd | 2.27 MB | 0.47 MB |
| mwp | 2.03 MB | 0.42 MB |
| **Route-critical (u, v, sve, svn) per step** | **11.4 MB** | **2.4 MB** |
| **All eight per step** | **20.0 MB** | **4.2 MB** |

A 72 h route at 3-hourly steps needs 25 frames:

| Fields fetched | 0.1° | 0.25° |
|---|---|---|
| Route-critical only | ≈ 285 MB | ≈ 61 MB |
| All eight | ≈ 500 MB | ≈ 106 MB |

These downloads happen in the browser, typically on a boat's cellular or satellite link. The current Windy tile volume per route was **not measured** in this pass. **[INFERENCE]** It is orders of magnitude smaller, because the tiles are corridor-sized JPEGs. Step 1 of the migration measures it.

**Resolution comparison.** Today's routing grid is 0.176° (z3) or 0.088° (z4). Open 0.25° is coarser than both. Open 0.1° sits between them.

## 6. Decisions a human must make (record in SPEC.md first)

| # | Decision | Options | Notes |
|---|---|---|---|
| D1 | Resolution / latency | (a) 0.1°, 2 h delay; (b) 0.25°, real time; (c) user-selectable | 0.25° is coarser than today's routing grid. 0.1° is about 5× the bytes. Per the No Assumptions Rule, never substitute one for the other silently. |
| D2 | Where fetch and crop happen | (a) browser: global message → WASM decode → crop; (b) SignalK plugin server fetches, caches and serves cropped `Float32` grids; (c) third-party subsetting API | (a) keeps "client-side only" but carries the section 5 volume. (b) uses the same uplink but caches across routes and overlays, and changes the architecture statement in CLAUDE.md. (c) adds a terms/licence dependency. |
| D3 | Current source | (a) ECMWF `sve`/`svn`, same channel and CC-BY-4.0, 3-hourly; (b) Copernicus Marine (CMEMS, needs an account; browser CORS not verified); (c) Open-Meteo marine (non-commercial free tier) | Today's input is CMEMS, hourly to 72 h. (a) is a **model substitution** and needs explicit approval. Under (b) or (c), check the provider's terms against this Apache-2.0 plugin, which is distributed through the SignalK App Store, and against its intended users. |
| D4 | Gust semantics | ECMWF `10fg` vs Windy's `gust` overlay | `10fg` was missing at 144 h. Decide whether the table shows "no data" (fail visibly) or the column is dropped. Never interpolate silently across the gap. |
| D5 | Wave period definition | `mwp` (mean) vs `pp1d` (peak) vs whatever Windy's `waves` PNG encodes | The README's conditions table says "Mean wave period", and encounter period depends on it. |
| D6 | Run selection | Latest run whose **last required step** index exists | Partial runs must be a hard error, not a fallback to an older run without notice. Show the run time in the UI. |
| D7 | GRIB2 decoder | (a) `grib` crate (noritada/grib-rs) with feature `ccsds-unpack-with-rust-aec` (pure Rust) inside `wasm-router`; (b) separate WASM module; (c) JS decoder | Building (a) for `wasm32-unknown-unknown` is **not verified**. Adding a dependency may trigger the New Tooling Rule. |
| D8 | Model selector | Drop `windModel: 'ecmwf' \| 'gfs' \| 'icon'` from `CalculatePayload` | `routing-engine.ts` hard-codes `'ecmwf'`, and the GFS/ICON paths exist only through Windy. |

## 7. Migration steps (in order; each its own branch/PR per Feature Branch Rule)

0. **Spec.** Log a REQ in `SPEC.md` (Original/Interpretation format) with D1–D8 resolved, and open the matching GitHub issue.
1. **Baseline (before touching Windy code).**
   - Measure bytes per route for the current tile path on the Baltic scenarios.
   - Capture reference routes: fixed polar and departure, the same ECMWF cycle that Windy serves, start and end in the Baltic and Denmark areas.
   - Forecasts are not archived anywhere in the repo, so capture the reference runs and the open-data run **on the same day**.
2. **Decoder spike.**
   - Decode one 10u message (CCSDS) inside the WASM build and crop it to a bbox.
   - Cross-check values at fixed points against an independent decoder such as ecCodes, or GDAL if built with libaec.
   - Record CPU time and peak memory for one 6.5 M-point field in a Web Worker.
3. **Run discovery.** List `{date}/{HH}z/ifs/{res}/oper/`, choose the run per D6 and build the step list. Missing or partial data is a hard error.
4. **Open-data wind provider.**
   - Implement the surface the worker uses today: `times`, `load(bbox)`, `prefetchForTime`, `getWindAtTime`, `getGustAtTime`, `getWave*AtTime`, `computeZoom`, which becomes a resolution choice.
   - Push native-grid frames directly. This removes the worker's resampling to `360/(2^z·256)`.
   - Fetch only the brackets that `RouterSession.needs()` requests. That is already lazy.
5. **Current provider** per D3.
6. **Diff harness.**
   - Run each reference scenario through both providers.
   - Report ETA delta, maximum cross-track distance and per-waypoint TWS/TWD deltas.
   - The acceptance thresholds are a human decision; record them in the SPEC entry.
7. **Overlays and data layer.**
   - Port `data-layer.ts` and `forecast-fetcher.ts` to read the same decoded grids.
   - Delete the second tile cache.
   - Port the time axis off `loadTimesFromWindy`.
8. **Cutover in one commit, so rollback is a single `git revert`.**
   - Delete `windy-lib/` and `src/lib/tile-provider.ts` with its tests, including `minifest.test.ts`.
   - Delete the `pnpm-workspace.yaml` entry, the `package.json` dependency and the `test` script tail.
   - Delete the windy-lib build steps in `.github/workflows/pages.yml` and `publish.yml`.
9. **Docs.**
   - README "Data sources" table: model, resolution and latency per D1/D3.
   - Replace "All forecast data is fetched as PNG/JPEG tiles from Windy's CDN" with the ECMWF CC-BY-4.0 attribution, and add the same attribution in the UI.
   - Update the `DEVELOPMENT.md` architecture notes and CHANGELOG `## Upcoming`.

## 8. What breaks, and for whom

- **Sailors on limited links.** Data volume rises sharply under D2(a) (section 5). Routing may become impractical over satellite unless D2(b) or (c) is chosen.
- **Sailors generally:**
  - Forecast resolution and latency change. Routes will differ from today's for the same departure.
  - Under D3(a), currents become 3-hourly IFS-ocean output instead of hourly CMEMS.
  - Gust and wave-period columns may change meaning (D4/D5).
- **Developers.**
  - The `windy-lib` workspace package and its tests go away.
  - `TileWindProvider.computeZoom` and zoom-based grid steps disappear.
  - CI loses the windy-lib build step.
- **Unchanged.** The WASM router core (isochrone, polar, land), the SignalK route saving and the polar editor.

## 9. Effort estimate **[INFERENCE]**

| Work | Estimate |
|---|---|
| Decoder spike + WASM integration | 2–4 days |
| Run discovery + wind/wave provider | 3–5 days |
| Current provider | 1–3 days, depending on D3 |
| Overlay/data-layer port | 3–5 days |
| Diff harness + tests | 2–3 days |
| Cutover + docs | 1 day |
| **Total** | **about 2.5–4 weeks of focused work**, excluding D2(b) |
| D2(b), if chosen | adds a server component: 1 week+ |

## 10. Recommendation

Do the migration, but in the order above, and do not start coding until D1–D3 are decided.

- The ToU exposure and the version-pinned private protocol are real and verified.
- The licensed replacement for wind, waves and, if D3(a) is accepted, currents is live at 0.1° and reachable from a browser.
- The proposal under-estimated one thing: area subsetting by byte range is impossible, so **D2 (where the bytes are fetched) is the decision that determines feasibility**. Steps 1–2 produce the numbers (baseline tile bytes, decode cost) needed to make that decision on evidence.
- Interim action that needs no decision: the unused `windy-lib` credential flow (`auth.ts` `loginWindy`, `client.ts`) can be deleted independently. The app never calls it.
