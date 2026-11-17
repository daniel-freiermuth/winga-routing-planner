// Unit tests for routing settings read from saved prefs: they hold whether or not the Settings modal is mounted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prefs } from '../prefs';
import { landIndexFile, unsupportedSettingError } from '../saved-routing-settings';

void test('unsupportedSettingError: coast avoidance unchecked in saved settings blocks the calculation', () => {
  prefs.coastAvoidance = false;
  assert.match(unsupportedSettingError() ?? '', /coast avoidance is not supported/i);
});

void test('unsupportedSettingError: coast avoidance checked lets the calculation run', () => {
  prefs.coastAvoidance = true;
  assert.equal(unsupportedSettingError(), undefined);
});

void test('landIndexFile: saved Safety margin on routes against the dilated coastline', () => {
  prefs.safetyMargin = true;
  assert.equal(landIndexFile(), 'dilated-edge-index.bin.gz');
});

void test('landIndexFile: saved Safety margin off routes against the plain coastline', () => {
  prefs.safetyMargin = false;
  assert.equal(landIndexFile(), 'edge-index.bin.gz');
});
