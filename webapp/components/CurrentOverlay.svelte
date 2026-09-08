<script lang="ts">
  // Renderless Svelte component — manages ocean current arrows on the map.
  // Each marker shows SET (direction current flows toward) as an arrow
  // and DRIFT (speed in knots) as a text label.

  import { onDestroy } from 'svelte';
  import * as maplibregl from 'maplibre-gl';
  import type { CurrentPoint } from '../stores';

  interface Props {
    map: maplibregl.Map | null;
    points: CurrentPoint[];
    visible: boolean;
  }

  let { map, points, visible }: Props = $props();

  let markers: maplibregl.Marker[] = [];

  const COLOR = '#fab387';    // Catppuccin peach — visible on blue water
  const OUTLINE = '#1e1e2e';  // dark outline for contrast

  function clearMarkers() {
    for (const m of markers) m.remove();
    markers = [];
  }

  function currentSvg(spdKn: number, dirDeg: number): string {
    // Arrow length scales with speed: 8px at ~0.05kn up to 20px at ≥2kn
    const rad = (dirDeg * Math.PI) / 180;
    const len = Math.min(20, Math.max(8, spdKn * 10));
    const dx = Math.sin(rad) * len;
    const dy = -Math.cos(rad) * len;

    // Arrowhead at tip
    const hLen = 5, hW = 3.5;
    const bx = dx - hLen * Math.sin(rad);
    const by = dy + hLen * Math.cos(rad);
    const px = hW * Math.cos(rad);
    const py = hW * Math.sin(rad);

    const label = spdKn < 10 ? spdKn.toFixed(1) : Math.round(spdKn).toString();

    return (
      `<svg width="48" height="48" viewBox="-24 -24 48 48" xmlns="http://www.w3.org/2000/svg">` +
      // Shaft outline + fill
      `<line x1="0" y1="0" x2="${dx.toFixed(1)}" y2="${dy.toFixed(1)}" ` +
        `stroke="${OUTLINE}" stroke-width="4.5" stroke-linecap="round"/>` +
      `<line x1="0" y1="0" x2="${dx.toFixed(1)}" y2="${dy.toFixed(1)}" ` +
        `stroke="${COLOR}" stroke-width="2" stroke-linecap="round"/>` +
      // Arrowhead outline + fill
      `<polygon points="${dx.toFixed(1)},${dy.toFixed(1)} ` +
        `${(bx - px).toFixed(1)},${(by - py).toFixed(1)} ` +
        `${(bx + px).toFixed(1)},${(by + py).toFixed(1)}" ` +
        `fill="${COLOR}" stroke="${OUTLINE}" stroke-width="1.5" stroke-linejoin="round"/>` +
      // Origin dot
      `<circle cx="0" cy="0" r="2" fill="${COLOR}" stroke="${OUTLINE}" stroke-width="1"/>` +
      // Speed label — always horizontal, below center
      `<text x="0" y="23" text-anchor="middle" ` +
        `fill="${COLOR}" stroke="${OUTLINE}" stroke-width="3" paint-order="stroke" ` +
        `font-size="11" font-family="system-ui,sans-serif" font-weight="600">${label}</text>` +
      `</svg>`
    );
  }

  function render(m: maplibregl.Map | null, pts: CurrentPoint[], vis: boolean) {
    clearMarkers();
    if (!m || !vis || pts.length === 0) return;

    const bounds = m.getBounds();
    const MIN_PX = 60; // wider spacing for labels
    const keptPx: { x: number; y: number }[] = [];

    for (const { lat, lon, u, v } of pts) {
      if (lat < bounds.getSouth() || lat > bounds.getNorth() ||
          lon < bounds.getWest() || lon > bounds.getEast()) continue;
      const spdKn = Math.sqrt(u * u + v * v) * 1.94384;
      if (spdKn < 0.05) continue;

      const px = m.project([lon, lat]);
      let tooClose = false;
      for (const p of keptPx) {
        const dx = p.x - px.x, dy = p.y - px.y;
        if (dx * dx + dy * dy < MIN_PX * MIN_PX) { tooClose = true; break; }
      }
      if (tooClose) continue;
      keptPx.push(px);

      // SET = direction current flows toward (oceanographic convention)
      const dir = ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360;

      const el = document.createElement('div');
      el.style.width = '48px';
      el.style.height = '48px';
      el.style.pointerEvents = 'none';
      el.innerHTML = currentSvg(spdKn, dir);

      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([lon, lat])
        .addTo(m);
      markers.push(marker);
    }
  }

  $effect(() => {
    render(map, points, visible);
  });

  onDestroy(() => clearMarkers());
</script>
