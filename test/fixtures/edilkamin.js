// -----------------------------------------------------------------------------
// Made-up stove documents in the shape edilkamin.py reads them
// (`GET device/{mac}/info`: `status`, `nvm`, `component_info`), some of their
// fields sent as gzip Buffers as the "new" API does. Nothing comes from a
// real stove or account.
// -----------------------------------------------------------------------------

import { gzipSync } from 'node:zlib';

export const USERNAME = 'someone@example.com';
export const PASSWORD = 'correct horse – battery staple';
export const USER_ID = '7d0c2b9e-1f3a-4c5d-8e6f-0a1b2c3d4e5f';

export const SECOND = 1_000;
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
/** 2026-10-18 10:00:00 UTC. */
export const NOW = Date.UTC(2026, 9, 18, 10, 0, 0);

/** The stoves, by role in the tests (MACs as typed by a user, and as the API wants them). */
export const MACS = {
  living: 'a8032a123456',
  cabin: 'a8032a654321',
};
export const TYPED = 'A8:03:2A:12:34:56, a8-03-2a-65-43-21';

/** A gzip Buffer field, as the Node.js API serializes it. */
export const buffer = (value) => ({
  type: 'Buffer',
  data: [...gzipSync(Buffer.from(JSON.stringify(value), 'utf8'))],
});

/**
 * One stove document. `gzip`: the three big fields as Buffers. `alarms`:
 * the `nvm.alarms_log` (undefined: none).
 */
export function stoveDocument(
  mac,
  {
    power = 0,
    temperature = 19.5,
    setpoint = 21,
    manualPower = 3,
    fans = [2],
    reserve = false,
    alarms,
    gzip = true,
  } = {},
) {
  const status = {
    commands: { power, alarm_reset: false, perform_cochlea_loading: false },
    temperatures: { enviroment: temperature, board: 31 },
    fans: Object.fromEntries(fans.map((speed, i) => [`fan_${i + 1}_speed`, speed])),
    flags: {
      is_pellet_in_reserve: reserve,
      is_airkare_active: false,
      is_relax_active: false,
      is_crono_active: false,
      is_easytimer_active: false,
    },
    pellet: { autonomy_time: 900 },
    easytimer: { time: 0 },
  };
  const nvm = {
    user_parameters: {
      enviroment_1_temperature: setpoint,
      manual_power: manualPower,
      is_auto: false,
      is_standby_active: false,
    },
    installer_parameters: { fans_number: fans.length },
    ...(alarms ? { alarms_log: alarms } : {}),
  };
  const component = { motherboard: { serial_number: '\u001aC]7JSS   L' } };
  return {
    mac_address: mac,
    pk: 1,
    status: gzip ? buffer(status) : status,
    nvm: gzip ? buffer(nvm) : nvm,
    component_info: gzip ? buffer(component) : component,
  };
}

/** The stoves of the fake account: their state, which the fake cloud changes on commands. */
export function stoves() {
  return {
    [MACS.living]: {
      power: 0,
      temperature: 19.5,
      setpoint: 21,
      manualPower: 3,
      fans: [2, 1],
      reserve: false,
      alarms: { number: 1, alarms: [{ type: 3, timestamp: 1760000000 }] },
    },
    [MACS.cabin]: {
      power: 1,
      temperature: 22,
      setpoint: 22.5,
      manualPower: 5,
      fans: [4],
      reserve: true,
      gzip: false,
    },
  };
}
