// ── Bootstrap ─────────────────────────────────────────────────────────────────
// Detects the SignalK server and mounts <App>.
// The MapLibre map is created declaratively via <MapLibre> in App.svelte.

import 'maplibre-gl/dist/maplibre-gl.css';
import type { Marker } from 'maplibre-gl';

declare global {
  interface Window {
    _routeWeatherMarkers?: Marker[];
  }
}

import { mount } from 'svelte';
import App from './components/App.svelte';
import { prefs, savePrefs } from './prefs';
import { authState } from './auth-state.svelte';

// ── SignalK Server URL ────────────────────────────────────────────────────────

function detectSkBase(): string {
  let stored = localStorage.getItem('wr-signalk-url');
  if (stored !== null) {
    stored = stored.trim().replace(/\/+$/, '');
    if (stored && !stored.startsWith('http://') && !stored.startsWith('https://')) {
      stored = 'http://' + stored;
      localStorage.setItem('wr-signalk-url', stored);
    }
    return stored;
  }
  if (
    location.pathname.includes('winga-weather-routing') ||
    location.pathname.includes('signalk-weather-routing') ||
    location.port === '3000'
  )
    return '';
  return '';
}

const SK_BASE = detectSkBase();

async function skFetch(path: string, options?: RequestInit): Promise<Response> {
  const url = path.startsWith('http') ? path : SK_BASE + path;
  const headers = new Headers(options?.headers);
  if (SK_BASE !== '' && prefs.skToken !== '') {
    headers.set('Authorization', `Bearer ${prefs.skToken}`);
  }
  return fetch(url, { ...options, headers, credentials: SK_BASE !== '' ? 'omit' : 'same-origin' });
}

function skWebSocketUrl(path: string): string {
  if (SK_BASE) return SK_BASE.replace(/^http/, 'ws') + path;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}`;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

async function checkAuth(): Promise<void> {
  try {
    const r = await skFetch('/signalk/v2/auth/loginStatus');
    if (!r.ok) {
      authState.status = 'unauthenticated';
      return;
    }
    const data: unknown = await r.json();
    if (typeof data === 'object' && data !== null && 'status' in data) {
      if (data.status === 'loggedIn') {
        authState.status = 'authenticated';
        if ('username' in data && typeof data.username === 'string') {
          authState.username = data.username;
        }
      } else {
        authState.status = 'unauthenticated';
      }
    } else {
      authState.status = 'unauthenticated';
    }
  } catch {
    authState.status = 'no-server';
  }
}

async function skLogin(username: string, password: string): Promise<void> {
  const r = await skFetch('/signalk/v2/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!r.ok) throw new Error(`Login failed: HTTP ${String(r.status)}`);
  const data: unknown = await r.json();
  if (typeof data === 'object' && data !== null && 'token' in data && typeof data.token === 'string') {
    prefs.skToken = data.token;
    savePrefs(prefs);
  }
  authState.status = 'authenticated';
  authState.username = username;
}

function skLogout(): void {
  prefs.skToken = '';
  savePrefs(prefs);
  authState.status = 'unauthenticated';
  authState.username = '';
}

// ── Auth Check (async, non-blocking) ──────────────────────────────────────────

void checkAuth();

// ── Mount App ─────────────────────────────────────────────────────────────────

const appEl = document.getElementById('app');
if (appEl === null) throw new Error('Missing #app element');
mount(App, {
  target: appEl,
  props: { skFetch, skWebSocketUrl, skLogin, skLogout },
});
