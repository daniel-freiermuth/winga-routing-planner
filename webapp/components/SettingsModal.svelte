<script lang="ts">
  // Settings dialog — polar, routing options (auto-saved to prefs), charts and SignalK login.
  import type { Map } from 'maplibre-gl';
  import { prefs, savePrefs } from '../prefs';
  import { authState } from '../auth-state.svelte';

  interface Props {
    visible: boolean;
    onPolarChange: (csv: string) => void;
    onOpenPolarEditor?: () => void;
    polarLoaded: boolean;
    map: Map | null;
    skConnected: boolean;
    skFetch: (path: string, opts?: RequestInit) => Promise<Response>;
    currentSkUrl: string;
    buildVersion: string;
    onLogin: (username: string, password: string) => Promise<void>;
    onLogout: () => void;
    onClose: () => void;
  }

  let {
    visible,
    onPolarChange,
    onOpenPolarEditor,
    polarLoaded,
    map,
    skConnected,
    skFetch,
    currentSkUrl,
    buildVersion,
    onLogin,
    onLogout,
    onClose,
  }: Props = $props();

  // ── Polar status ──
  let polarStatus = $state(
    localStorage.getItem('wr-polar-csv') ? 'Polar loaded from previous session' : 'No polar loaded',
  );
  let polarStatusColor = $state(localStorage.getItem('wr-polar-csv') ? '#a6e3a1' : '#6c7086');

  // Restore polar from localStorage on init
  $effect(() => {
    const savedPolar = localStorage.getItem('wr-polar-csv');
    if (savedPolar) onPolarChange?.(savedPolar);
  });

  // ── Routing options state (initialized from prefs) ──
  let coastAvoidance = $state(prefs.coastAvoidance);
  let safetyMargin = $state(prefs.safetyMargin);
  let motorBelowKn = $state(prefs.motorBelowKn);
  let motorSpeedKn = $state(prefs.motorSpeedKn);
  let waitForWind = $state(prefs.waitForWind);
  let maxWindKn = $state(prefs.maxWindKn);
  let maxWaveM = $state(prefs.maxWaveM);
  let tackPenaltySec = $state(prefs.tackPenaltySec);
  let tackThresholdDeg = $state(prefs.tackThresholdDeg);
  let waypointLabels = $state(prefs.waypointLabels);
  let waypointLabelInterval = $state(prefs.waypointLabelInterval);

  // Auto-save routing options when any value changes
  $effect(() => {
    prefs.coastAvoidance = coastAvoidance;
    prefs.safetyMargin = safetyMargin;
    prefs.motorBelowKn = motorBelowKn;
    prefs.motorSpeedKn = motorSpeedKn;
    prefs.waitForWind = waitForWind;
    prefs.maxWindKn = maxWindKn;
    prefs.maxWaveM = maxWaveM;
    prefs.tackPenaltySec = tackPenaltySec;
    prefs.tackThresholdDeg = tackThresholdDeg;
    prefs.waypointLabels = waypointLabels;
    prefs.waypointLabelInterval = waypointLabelInterval;
    savePrefs(prefs);
  });

  export function getOptions() {
    return {
      useSafetyMargin: safetyMargin,
      motorBelowKn: parseFloat(motorBelowKn) || undefined,
      motorSpeedKn: parseFloat(motorSpeedKn) || undefined,
      waitForWind: waitForWind || undefined,
      maxWindKn: parseFloat(maxWindKn) || undefined,
      maxWaveM: parseFloat(maxWaveM) || undefined,
      tackPenaltySec: parseFloat(tackPenaltySec) || 0,
      tackThresholdDeg: parseFloat(tackThresholdDeg) || 60,
      waypointLabels,
      waypointLabelInterval: parseFloat(waypointLabelInterval) || 0,
    };
  }

  // ── Chart state ──
  interface Chart {
    name: string;
    url: string;
    attribution: string;
  }

  const CHART_SOURCE = 'chart-tiles';
  const CHART_LAYER = 'chart-tiles';

  let charts = $state<Chart[]>([
    {
      name: 'OpenStreetMap',
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  ]);
  let selectedChartIdx = $state(0);
  let chartApplied = false;

  function expandTileUrls(url: string): string[] {
    if (url.includes('{s}')) {
      return ['a', 'b', 'c'].map((s) => url.replace('{s}', s));
    }
    return [url];
  }

  function applyChart(chart: Chart) {
    if (!map) return;
    if (map.getLayer(CHART_LAYER)) map.removeLayer(CHART_LAYER);
    if (map.getSource(CHART_SOURCE)) map.removeSource(CHART_SOURCE);
    if (map.getLayer('osm')) map.removeLayer('osm');
    if (map.getSource('osm')) map.removeSource('osm');

    map.addSource(CHART_SOURCE, {
      type: 'raster',
      tiles: expandTileUrls(chart.url),
      tileSize: 256,
      attribution: chart.attribution,
    });
    const firstLayer = map.getStyle().layers[0];
    map.addLayer(
      { id: CHART_LAYER, type: 'raster', source: CHART_SOURCE },
      firstLayer?.id,
    );
    chartApplied = true;
  }

  function handleChartChange() {
    if (!map?.isStyleLoaded()) return;
    const chart = charts[selectedChartIdx];
    if (chart) applyChart(chart);
  }

  // Load SK charts once when map + skConnected become available
  let chartsLoaded = false;
  $effect(() => {
    if (!map || !skConnected || chartsLoaded) return;
    chartsLoaded = true;
    void (async () => {
      try {
        const r = await skFetch('/signalk/v2/api/resources/charts');
        if (r.ok) {
          const data: Record<string, { name?: string; url?: string; serverType?: string }> =
            await r.json();
          for (const [id, chart] of Object.entries(data)) {
            if (chart.serverType !== 'tilelayer') continue;
            if (chart.url?.includes('.mvt')) continue;
            charts = [
              ...charts,
              {
                name: chart.name ?? id,
                url: (chart.url ?? '')
                  .replace(/\$z/g, '{z}')
                  .replace(/\$x/g, '{x}')
                  .replace(/\$y/g, '{y}'),
                attribution: chart.name ?? id,
              },
            ];
          }
        }
      } catch {
        /* fall back to OSM only */
      }
    })();
  });

  // Apply default chart once map style is ready
  $effect(() => {
    if (!map || chartApplied) return;
    if (!map.isStyleLoaded()) {
      const handler = () => {
        const first = charts[0];
        if (first) applyChart(first);
      };
      map.once('styledata', handler);
      return () => {
        map!.off('styledata', handler);
      };
    }
    const first = charts[0];
    if (first) applyChart(first);
  });

  // ── SK Server state ──
  let skUrlValue = $state('');
  $effect(() => { skUrlValue = currentSkUrl; });

  function handleSkUrlChange() {
    let val = skUrlValue.trim().replace(/\/+$/, '');
    if (val && !val.startsWith('http://') && !val.startsWith('https://')) {
      val = 'http://' + val;
    }
    if (val) localStorage.setItem('wr-signalk-url', val);
    else localStorage.removeItem('wr-signalk-url');
    location.reload();
  }

  // ── Overlay click to close ──
  function handleOverlayClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  // ── Auth form state ──
  let loginUsername = $state('');
  let loginPassword = $state('');
  let loginBusy = $state(false);
  let loginError = $state('');

  async function handleLogin(): Promise<void> {
    loginBusy = true;
    loginError = '';
    try {
      await onLogin(loginUsername, loginPassword);
      loginUsername = '';
      loginPassword = '';
    } catch (e: unknown) {
      loginError = e instanceof Error ? e.message : String(e);
    } finally {
      loginBusy = false;
    }
  }

  function handleLogout(): void {
    onLogout();
  }
</script>

{#if visible}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="overlay" onclick={handleOverlayClick}>
    <div class="modal">
      <div class="header">
        <span class="title">Settings</span>
        <button class="close-btn" onclick={onClose}>✕</button>
      </div>

      <div class="body">
        <!-- POLAR DIAGRAM -->
        <section>
          <div class="section-title">Polar Diagram</div>
          <span class="status" style:color={polarStatusColor}>{polarStatus}</span>
          <button class="action-btn polar-editor-btn" onclick={onOpenPolarEditor}>
            {polarLoaded ? 'Edit Polar Diagram' : 'Set Up Polar Diagram'}
          </button>
        </section>

        <!-- ROUTING -->
        <section>
          <div class="section-title">Routing</div>

          <label class="toggle">
            <input type="checkbox" bind:checked={coastAvoidance} /> Coast avoidance
          </label>

          <label class="toggle">
            <input type="checkbox" bind:checked={safetyMargin} /> Safety margin (0.5 NM)
          </label>

          <div class="group">
            <span class="field-label">Motor</span>
            <div class="motor-row">
              <span class="field-label">below</span>
              <input type="number" min="0" max="20" step="0.5" placeholder="kn" bind:value={motorBelowKn} />
              <span class="field-label">kn, speed</span>
              <input type="number" min="0" max="20" step="0.5" placeholder="kn" bind:value={motorSpeedKn} />
              <span class="field-label">kn</span>
            </div>
          </div>

          <label class="toggle">
            <input type="checkbox" bind:checked={waitForWind} /> Wait for wind
          </label>

          <label class="field">
            <span class="field-label">Max wind (kn, empty = no limit)</span>
            <input type="number" min="0" max="200" step="1" bind:value={maxWindKn} />
          </label>

          <label class="field">
            <span class="field-label">Max wave (m, empty = no limit)</span>
            <input type="number" min="0" max="30" step="0.5" bind:value={maxWaveM} />
          </label>

          <div class="group">
            <span class="group-label">Tack/gybe penalty</span>
            <label class="field inline">
              <input type="number" min="0" max="300" step="5" class="narrow-input" bind:value={tackPenaltySec} />
              <span class="field-label">s when heading changes &gt;</span>
            </label>
            <label class="field inline">
              <input type="number" min="10" max="180" step="5" class="narrow-input" bind:value={tackThresholdDeg} />
              <span class="field-label">°</span>
            </label>
          </div>

          <div class="labels-row">
            <label class="toggle">
              <input type="checkbox" bind:checked={waypointLabels} /> Waypoint labels every
            </label>
            <input
              type="number"
              min="0"
              max="48"
              step="1"
              class="interval-input"
              bind:value={waypointLabelInterval}
            />
            <span class="field-label">h (0 = all)</span>
          </div>
        </section>

        <!-- CHART SOURCE -->
        <section>
          <div class="section-title">Chart Source</div>
          <select bind:value={selectedChartIdx} onchange={handleChartChange}>
            {#each charts as chart, i}
              <option value={i}>{chart.name}</option>
            {/each}
          </select>
        </section>

        <!-- SIGNALK SERVER -->
        <section>
          <div class="section-title">SignalK Server</div>
          <div class="sk-row">
            <input
              type="text"
              placeholder="auto (same origin)"
              bind:value={skUrlValue}
              onchange={handleSkUrlChange}
            />
            <span class="connection-dot" class:connected={skConnected}></span>
            <span class="connection-label">{skConnected ? 'Connected' : 'Disconnected'}</span>
          </div>
          <span class="hint">
            Leave empty when installed as SK webapp. Set to e.g.
            <code>http://192.168.1.100:3000</code> for standalone use.
          </span>

          {#if authState.status === 'authenticated'}
            <div class="auth-row">
              <span class="auth-label">Logged in as <strong>{authState.username}</strong></span>
              <button class="action-btn" onclick={handleLogout}>Logout</button>
            </div>
          {:else if authState.status === 'unauthenticated'}
            <div class="auth-form">
              <input type="text" placeholder="Username" bind:value={loginUsername} />
              <input type="password" placeholder="Password" bind:value={loginPassword} />
              <div class="auth-actions">
                <button class="action-btn login-btn" disabled={loginBusy} onclick={handleLogin}>
                  {loginBusy ? 'Logging in…' : 'Login'}
                </button>
                {#if loginError !== ''}
                  <span class="auth-error">{loginError}</span>
                {/if}
              </div>
            </div>
          {:else if authState.status === 'no-server'}
            <span class="auth-label">No server connected</span>
          {:else}
            <span class="auth-label">Checking…</span>
          {/if}
        </section>

        <!-- ABOUT -->
        <section class="about">
          <div class="section-title">About</div>
          <span class="about-text">
            v{buildVersion}&ensp;·&ensp;<a
              href="https://github.com/daniel-freiermuth/winga-weather-routing"
              target="_blank"
              rel="noopener">GitHub</a>
          </span>
        </section>
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9000;
  }

  .modal {
    background: #1e2230;
    border: 1px solid #45475a;
    border-radius: 12px;
    max-width: 420px;
    width: 90%;
    max-height: 85vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid #45475a;
    flex-shrink: 0;
  }

  .title {
    font-size: 16px;
    font-weight: 600;
    color: #cdd6f4;
  }

  .close-btn {
    background: none;
    border: none;
    color: #6c7086;
    font-size: 16px;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;
    line-height: 1;
  }
  .close-btn:hover {
    color: #cdd6f4;
    background: #313244;
  }

  .body {
    padding: 12px 16px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  section {
    padding: 10px 0;
    border-bottom: 1px solid #45475a;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  section:first-child {
    padding-top: 4px;
  }
  section:last-child {
    border-bottom: none;
    padding-bottom: 4px;
  }

  .section-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #6c7086;
    margin-bottom: 2px;
  }

  /* Polar */

  .status {
    font-size: 11px;
    display: block;
  }


  .action-btn {
    margin-top: 4px;
    font-size: 11px;
    padding: 4px 10px;
    background: #585b70;
    color: #cdd6f4;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    align-self: flex-start;
  }
  .action-btn:hover {
    background: #6c7086;
  }
  .polar-editor-btn {
    background: #89b4fa;
    color: #1e1e2e;
  }
  .polar-editor-btn:hover {
    background: #a6c8ff;
  }

  /* Routing */
  .toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: #cdd6f4;
    cursor: pointer;
  }

  .field-label {
    font-size: 11px;
    color: #a6adc8;
    white-space: nowrap;
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .motor-row {
    display: flex;
    gap: 4px;
    align-items: center;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .field.inline {
    flex-direction: row;
    align-items: center;
    gap: 4px;
  }

  .narrow-input {
    width: 50px !important;
  }

  .labels-row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .interval-input {
    width: 50px !important;
  }

  input[type='number'] {
    background: #313244;
    color: #cdd6f4;
    border: 1px solid #45475a;
    border-radius: 4px;
    padding: 3px 6px;
    font-size: 12px;
    width: 60px;
  }

  .field input[type='number'] {
    width: 100%;
  }

  input[type='checkbox'] {
    accent-color: #89b4fa;
  }

  /* Chart */
  select {
    width: 100%;
    padding: 4px 8px;
    background: #313244;
    color: #cdd6f4;
    border: 1px solid #45475a;
    border-radius: 4px;
    font-size: 12px;
  }

  /* SK Server */
  .sk-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .sk-row input[type='text'] {
    flex: 1;
    font-size: 11px;
    padding: 4px 6px;
    background: #313244;
    color: #cdd6f4;
    border: 1px solid #45475a;
    border-radius: 4px;
  }

  .connection-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #f38ba8;
    flex-shrink: 0;
  }
  .connection-dot.connected {
    background: #a6e3a1;
  }

  .connection-label {
    font-size: 11px;
    color: #6c7086;
    white-space: nowrap;
  }

  .hint {
    font-size: 10px;
    color: #6c7086;
    margin-top: 2px;
  }

  code {
    background: #313244;
    padding: 1px 3px;
    border-radius: 2px;
    font-size: 10px;
  }

  /* Auth */
  .auth-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
  }

  .auth-label {
    font-size: 11px;
    color: #a6adc8;
  }

  .auth-form {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 4px;
  }

  .auth-form input[type='text'],
  .auth-form input[type='password'] {
    font-size: 11px;
    padding: 4px 6px;
    background: #313244;
    color: #cdd6f4;
    border: 1px solid #45475a;
    border-radius: 4px;
  }

  .auth-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .login-btn {
    background: #89b4fa;
    color: #1e1e2e;
  }
  .login-btn:hover {
    background: #a6c8ff;
  }
  .login-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .auth-error {
    font-size: 11px;
    color: #f38ba8;
  }

  /* About */
  .about-text {
    font-size: 12px;
    color: #a6adc8;
  }
  .about-text a {
    color: #89b4fa;
    text-decoration: none;
  }
  .about-text a:hover {
    text-decoration: underline;
  }
</style>
