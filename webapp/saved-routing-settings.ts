// Routing settings read from the saved prefs, which exist whether or not the Settings modal is mounted.

import { prefs } from './prefs';

/**
 * A setting the router cannot honour blocks the calculation (Nautical Safety Rule).
 * Returns the message to show, or undefined when every setting can be honoured.
 */
export function unsupportedSettingError(): string | undefined {
  // The router always applies land avoidance.
  return prefs.coastAvoidance
    ? undefined
    : 'Disabling coast avoidance is not supported yet — enable Coast avoidance in Settings to calculate a route';
}

/** Land index for the saved Safety margin choice; the dilated coastline carries the 0.5 NM margin. */
export function landIndexFile(): string {
  return prefs.safetyMargin ? 'dilated-edge-index.bin.gz' : 'edge-index.bin.gz';
}
