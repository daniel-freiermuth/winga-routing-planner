// Shared reactive state for the config module.
// Both App.svelte and config.ts import from here.

import type { UnitPref } from './types';

export const configState = $state({
  waveOverlayMaxM: 3.0,
  windSpeedMs: false,
  unitPrefs: null as Record<string, UnitPref> | null,
});
