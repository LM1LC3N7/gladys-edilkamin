// -----------------------------------------------------------------------------
// The features against the Gladys core: the categories and types exist, and
// the units are those DEVICE_FEATURE_UNITS_BY_CATEGORY of
// server/utils/constants.js allows (copied here: the tests never read
// outside the repository).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as TYPES,
} from '@gladysassistant/integration-sdk';
import { FEATURES, ROLES, buildDevice, parseFeatureId, rolesOf, statesOf } from '../src/devices.js';

/** DEVICE_FEATURE_UNITS_BY_CATEGORY of the core, for the categories used here. */
const UNITS_BY_CATEGORY = {
  'temperature-sensor': ['celsius', 'fahrenheit', 'kelvin'],
  thermostat: ['celsius', 'fahrenheit'],
  fan: ['percent'],
};

const gladys = {
  externalIds: (type, id) => ({
    device: `ext:sel:${type}:${id}`,
    feature: (r) => `ext:sel:${type}:${id}:${r}`,
  }),
};

test('every feature has a core category and type, and only a unit the core allows', () => {
  const categories = new Set(Object.values(C));
  for (const [role, feature] of Object.entries(FEATURES)) {
    assert.ok(categories.has(feature.category), `${role}: category ${feature.category}`);
    const group = Object.entries(C).find(([, v]) => v === feature.category)[0];
    const types = new Set([...Object.values(TYPES[group] ?? {}), ...Object.values(TYPES.SENSOR)]);
    assert.ok(types.has(feature.type), `${role}: type ${feature.type}`);
    if (feature.unit !== undefined) {
      assert.ok(UNITS_BY_CATEGORY[feature.category]?.includes(feature.unit), `${role}: unit`);
    }
  }
  assert.equal(FEATURES.temperature.unit, 'celsius');
  assert.equal(FEATURES.setpoint.unit, 'celsius');
  assert.equal(FEATURES['fan-1'].unit, undefined, 'a fan level is not a percent');
});

test('feature ids: the MAC and the role, nothing else', () => {
  assert.deepEqual(parseFeatureId('ext:sel:edilkamin:a8032a123456:power-off'), {
    mac: 'a8032a123456',
    role: 'power-off',
  });
  assert.equal(parseFeatureId('ext:sel:edilkamin:a8032a123456:switch'), undefined);
  assert.equal(parseFeatureId('ext:sel:edilkamin:A8032A123456:power'), undefined);
  assert.ok(ROLES.every((role) => /^[a-z0-9-]+$/.test(role)));
});

test('a device keeps the roles it was created with; the power level is a choice P1 to P5', () => {
  const stove = { mac: 'a8032a123456', fans: [], fansNumber: 0 };
  assert.ok(!rolesOf(stove).includes('fan-1'));
  assert.ok(rolesOf(stove, new Set(['fan-1', 'bogus'])).includes('fan-1'));
  const device = buildDevice(gladys, stove, 'en', new Set());
  const level = device.features.find((f) => f.external_id.endsWith(':power-level'));
  assert.deepEqual(
    level.supported_options.map((o) => [o.value, o.label]),
    [
      ['1', 'P1'],
      ['2', 'P2'],
      ['3', 'P3'],
      ['4', 'P4'],
      ['5', 'P5'],
    ],
  );
  assert.equal(device.name, 'Edilkamin stove 3456');
});

test('states: unknown values are not published', () => {
  const states = statesOf(
    { mac: 'a8032a123456', fans: [undefined], power: undefined, alarms: { count: 0 } },
    'en',
  );
  assert.deepEqual(states, [{ role: 'last-alarm', text: 'No alarm' }]);
});
