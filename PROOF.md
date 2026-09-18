# Data-flow trace: direct-to-destination bypasses heading-change and tack penalty

## Setup (concrete values)

- Frontier point `pt` at lat=55.0, lon=10.0, heading south: `pt_ctw=180`
- Destination at lat=55.1, lon=10.05 → `pt_to_dest ≈ 30` (bearing NNE)
- `pt_has_parent = true` (not a seed point)
- `config.max_heading_change = 120` (default)
- `config.tack_penalty_sec = 30` (default)
- `config.tack_threshold_deg = 30` (default)
- Heading change: `|30 − 180| = 150°` (exceeds 120° limit)
- Distance to dest: ~6.1 nm
- `dt_hours = 1.0`, `max_step_dist = 15.0` → `dist_to_dest <= max_step_dist`

## Regular loop path (isochrone.rs:273–331): CORRECTLY REJECTS

When `ctw = 30` in the regular heading sweep:

1. **Line 274**: `deviation = |30 − 30| = 0` → within cone ✓
2. **Line 281–286**: `pt_has_parent = true`, so:
   ```
   delta = ((30 − 180 + 180 + 360) % 360 − 180).abs()
         = ((390) % 360 − 180).abs()
         = (30 − 180).abs() = 150
   150 > 120 → skip (continue)
   ```
   **Result: heading 30° is rejected** — the boat cannot turn 150° in one step.

3. If it weren't rejected, **lines 324–330** would apply tack penalty:
   ```
   ctw_change = 150 > tack_threshold_deg(30) → penalty_h = 30/3600 = 0.00833 h
   ```

## Direct-to-destination path (isochrone.rs:234–268): INCORRECTLY ACCEPTS

1. **Line 234**: `dist_to_dest(6.1) <= max_step_dist(15) && !direct_blocked` → enters block ✓
2. **Lines 235–249**: Computes `direct_twa`, `direct_speed`, `eff` — normal
3. **Line 250–252**: `eff >= min_boat_speed && eff * dt_hours >= dist_to_dest && !land_blocked` → enters block ✓
4. **NO heading-change check**: The code never computes
   `((pt_to_dest − pt_ctw + 180 + 360) % 360 − 180).abs()` and never compares
   against `config.max_heading_change`. The 150° turn is silently accepted.
5. **NO tack penalty**: Line 254 computes `travel_h = dist_to_dest / eff` with
   zero penalty. The arrival time is too optimistic by `tack_penalty_sec` (30s).
6. **Line 257–267**: Creates a candidate at the destination with heading
   `ctw: pt_to_dest (30°)` — a 150° turn from the parent's 180°.

## Consequence

The routing engine produces a route where the boat instantly snaps from heading
180° to heading 30° in the final approach — a turn that exceeds the physical
maneuvering limit. The arrival time is also underestimated by the tack penalty.
