// Loads config.json + SK unit preferences and build info on startup.

import type { UnitPref } from './types';
import { unitPrefsStore, windSpeedMsStore } from './units';
import { fmt } from './units';
import { waveOverlayMaxMStore } from './stores';
import { configState } from './config-state.svelte';

export interface ConfigCallbacks {
  setBuildVersion: (v: string) => void;
  setWaveLegendMax: (text: string) => void;
  setSafetyMarginDist: (text: string) => void;
}

export async function loadConfig(
  skFetch: (path: string, options?: RequestInit) => Promise<Response>,
  callbacks: ConfigCallbacks,
): Promise<void> {
  try {
    const cfgRes = await fetch('./config.json');
    if (!cfgRes.ok) return;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON parsed value
    const cfg = (await cfgRes.json()) as Record<string, unknown>;
    const waveVal = cfg['waveOverlayMaxM'];
    if (typeof waveVal === 'number') {
      configState.waveOverlayMaxM = waveVal;
      waveOverlayMaxMStore.set(configState.waveOverlayMaxM);
    }
    configState.windSpeedMs = cfg['windSpeedMs'] === true;
    windSpeedMsStore.set(configState.windSpeedMs);
    const graphHeight = cfg['conditionsGraphHeight'];
    if (typeof graphHeight === 'number') {
      configState.conditionsGraphHeight = graphHeight;
    }
    const horizonHours = cfg['forecastSkillHorizonHours'];
    if (typeof horizonHours === 'number') configState.forecastSkillHorizonHours = horizonHours;
  } catch {
    /* no config file */
  }

  try {
    const up = await skFetch('/signalk/v1/unitpreferences/active');
    if (up.ok) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON parsed value
      const upData = (await up.json()) as { categories: Record<string, UnitPref> };
      configState.unitPrefs = upData.categories;
      unitPrefsStore.set(configState.unitPrefs);
    }
  } catch {
    /* offline or not supported */
  }

  const depthSym = fmt(0, 'depth').sym;
  callbacks.setWaveLegendMax(`${fmt(configState.waveOverlayMaxM, 'depth').num} ${depthSym}`);
  const smFmt = fmt(0.5, 'distance');
  callbacks.setSafetyMarginDist(`${smFmt.num} ${smFmt.sym}`);

  try {
    const bi = await fetch('./buildinfo.json');
    if (bi.ok) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON parsed value
      const { version } = (await bi.json()) as { version: string };
      callbacks.setBuildVersion(`v${version}`);
    }
  } catch {
    /* no buildinfo */
  }
}
