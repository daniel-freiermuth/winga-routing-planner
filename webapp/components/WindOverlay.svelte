<script lang="ts">
  // Renderless Svelte component — manages wind barb markers on the map.
  // Receives map, points, and visibility as props from App.svelte.

  import { onDestroy } from 'svelte';
  import * as maplibregl from 'maplibre-gl';
  import type { WindPoint } from '../stores';
  import { windBarbSvg } from '../wind-barb';

  interface Props {
    map: maplibregl.Map | null;
    points: WindPoint[];
    visible: boolean;
  }

  let { map, points, visible }: Props = $props();

  let markers: maplibregl.Marker[] = [];

  function clearMarkers() {
    for (const m of markers) m.remove();
    markers = [];
  }

  function render(m: maplibregl.Map | null, pts: WindPoint[], vis: boolean) {
    clearMarkers();
    if (!m || !vis || pts.length === 0) return;

    const bounds = m.getBounds();
    const MIN_PX = 40;
    const keptPx: { x: number; y: number }[] = [];

    for (const { lat, lon, u, v } of pts) {
      if (lat < bounds.getSouth() || lat > bounds.getNorth() ||
          lon < bounds.getWest() || lon > bounds.getEast()) continue;
      const spd = Math.sqrt(u * u + v * v) * 1.94384;
      if (spd < 0.5) continue;

      const px = m.project([lon, lat]);
      let tooClose = false;
      for (const p of keptPx) {
        const dx = p.x - px.x, dy = p.y - px.y;
        if (dx * dx + dy * dy < MIN_PX * MIN_PX) { tooClose = true; break; }
      }
      if (tooClose) continue;

      keptPx.push(px);
      const dir = ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360;

      const el = document.createElement('div');
      el.style.width = '30px';
      el.style.height = '36px';
      el.style.opacity = '0.85';
      el.style.pointerEvents = 'none';
      el.style.filter = 'drop-shadow(0 0 2px rgba(0,0,0,0.9))';
      el.innerHTML = windBarbSvg(spd, dir, '#ffffff');

      const marker = new maplibregl.Marker({ element: el, anchor: 'bottom-left' })
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
