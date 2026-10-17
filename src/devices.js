// -----------------------------------------------------------------------------
// The Edilkamin stoves -> Gladys devices, and their states (pure).
//
// One Gladys device per stove, `ext:<selector>:edilkamin:<mac>`, the MAC
// address of its Wi-Fi module (12 hex digits, lower case: the id the cloud
// knows it by). The features are keyed by their role (the last part of their
// external id): those keys are published forever, never rename them. A device
// already created keeps all its features when it is published again.
//
// A flame appliance must never be lit by an "everything on" (Google Home,
// Alexa, HomeKit, MCP, `switch.*` scenes): no switch, no writable binary. The
// on/off state is read only (`unknown/binary`); lighting and turning off are
// two `button/push` features.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as TYPES,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { FANS, GLADYS, LIMITS, POWER_LEVEL, SETPOINT } from './constants.js';
import { ALARM, DEVICE_NAME, FEATURE_NAMES, powerLevelLabel, word } from './i18n.js';

const binary = { min: 0, max: 1 };
const button = {
  category: C.BUTTON,
  type: TYPES.BUTTON.PUSH,
  ...binary,
  read_only: false,
  has_feedback: false,
  keep_history: false,
};

/** The features, by role. */
export const FEATURES = {
  // Read only: 1 the stove is on (lit or lighting), 0 off.
  power: { category: C.UNKNOWN, type: TYPES.SENSOR.BINARY, ...binary },
  // A push lights the stove, behind allow_power_on.
  'power-on': button,
  // A push turns the stove off: always allowed.
  'power-off': button,
  temperature: {
    category: C.TEMPERATURE_SENSOR,
    type: TYPES.SENSOR.DECIMAL,
    unit: U.CELSIUS,
    min: -40,
    max: 100,
  },
  // Writable behind allow_commands; never turns the stove on.
  setpoint: {
    category: C.THERMOSTAT,
    type: TYPES.THERMOSTAT.TARGET_TEMPERATURE,
    unit: U.CELSIUS,
    min: SETPOINT.min,
    max: SETPOINT.max,
    read_only: false,
    has_feedback: true,
  },
  // P1 to P5, writable behind allow_commands (a choice, never a switch).
  'power-level': {
    category: C.TEXT,
    type: TYPES.TEXT.SELECT,
    min: 0,
    max: 0,
    read_only: false,
    has_feedback: true,
    keep_history: false,
  },
  'fan-1': { category: C.FAN, type: TYPES.FAN.SPEED, min: 0, max: FANS.speedMax },
  'fan-2': { category: C.FAN, type: TYPES.FAN.SPEED, min: 0, max: FANS.speedMax },
  'fan-3': { category: C.FAN, type: TYPES.FAN.SPEED, min: 0, max: FANS.speedMax },
  // 1 the pellet tank is in reserve. A read-only state, never a switch.
  'pellet-reserve': { category: C.UNKNOWN, type: TYPES.SENSOR.BINARY, ...binary },
  'last-alarm': { category: C.TEXT, type: TYPES.TEXT.TEXT, min: 0, max: 0 },
};

export const ROLES = Object.keys(FEATURES);
export const COMMAND_ROLES = ['power-on', 'power-off', 'setpoint', 'power-level'];
const FAN_ROLES = ['fan-1', 'fan-2', 'fan-3'];

export const deviceIds = (gladys, mac) => gladys.externalIds('edilkamin', String(mac));

/** The MAC and the role of a feature external id. */
export function parseFeatureId(externalId) {
  const match = /:edilkamin:([0-9a-f]{12}):([a-z0-9-]+)$/.exec(String(externalId ?? ''));
  return match && ROLES.includes(match[2]) ? { mac: match[1], role: match[2] } : undefined;
}

/** "Poêle Edilkamin 3456": the device name, from the end of the MAC (no other name is read). */
export const deviceName = (stove, language) =>
  `${word(DEVICE_NAME, language)} ${stove.mac.slice(-4)}`;

/**
 * The roles of one stove: those it reports now, plus those of the device
 * already created in Gladys (`created`: its role set), so a republished
 * device never loses a feature.
 */
export function rolesOf(stove, created = new Set()) {
  const roles = new Set([
    'power',
    'power-on',
    'power-off',
    'temperature',
    'setpoint',
    'power-level',
    'pellet-reserve',
  ]);
  for (let n = 1; n <= Math.min(stove.fansNumber ?? 0, FANS.max); n += 1) {
    roles.add(`fan-${n}`);
  }
  if (stove.alarms !== undefined) {
    roles.add('last-alarm');
  }
  for (const role of created) {
    if (ROLES.includes(role)) {
      roles.add(role);
    }
  }
  return ROLES.filter((role) => roles.has(role));
}

const powerLevelOptions = (language) => {
  const options = [];
  for (let level = POWER_LEVEL.min; level <= POWER_LEVEL.max; level += 1) {
    options.push({
      value: String(level),
      label: word(powerLevelLabel(level), language),
      sort_order: level - POWER_LEVEL.min,
    });
  }
  return options;
};

/** The Gladys device of one stove. `created`: the roles of the device already in Gladys. */
export function buildDevice(gladys, stove, language, created) {
  const ids = deviceIds(gladys, stove.mac);
  return {
    name: deviceName(stove, language),
    external_id: ids.device,
    features: rolesOf(stove, created).map((role) => ({
      name: word(FEATURE_NAMES[role], language),
      external_id: ids.feature(role),
      read_only: true,
      has_feedback: false,
      keep_history: true,
      ...FEATURES[role],
      ...(role === 'power-level' ? { supported_options: powerLevelOptions(language) } : {}),
    })),
    params: [{ name: 'mac_address', value: stove.mac }],
  };
}

/** "2026-10-17 21:04 UTC" from a Unix time in seconds (UTC: no time zone guess). */
const utc = (seconds) =>
  seconds === undefined
    ? undefined
    : `${new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** The last alarm of a stove, as a text. */
export function lastAlarm(alarms, language) {
  if (alarms.count === 0) {
    return word(ALARM.none, language);
  }
  if (alarms.code === undefined) {
    return word(ALARM.unknown(alarms.count), language);
  }
  return word(ALARM.code(alarms.code, utc(alarms.at)), language).slice(0, LIMITS.textLength);
}

/** The Gladys states of one stove: `[{ role, state }]` or `[{ role, text }]`. */
export function statesOf(stove, language) {
  const states = [];
  const add = (role, state) => {
    if (state !== undefined) {
      states.push({ role, state });
    }
  };
  if (stove.power !== undefined) {
    add('power', stove.power ? GLADYS.ON : GLADYS.OFF);
  }
  add('temperature', stove.temperature);
  add('setpoint', stove.setpoint);
  if (stove.powerLevel !== undefined) {
    states.push({ role: 'power-level', text: String(stove.powerLevel) });
  }
  stove.fans.forEach((speed, i) => {
    if (i < FAN_ROLES.length) {
      add(FAN_ROLES[i], speed);
    }
  });
  if (stove.pelletReserve !== undefined) {
    add('pellet-reserve', stove.pelletReserve ? GLADYS.ON : GLADYS.OFF);
  }
  if (stove.alarms !== undefined) {
    states.push({ role: 'last-alarm', text: lastAlarm(stove.alarms, language) });
  }
  return states;
}
