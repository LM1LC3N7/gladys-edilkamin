// -----------------------------------------------------------------------------
// The stove document (src/edilkamin.js): the gzip Buffer fields, their
// bounds, and the values read from it, each one checked.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { decompressBuffer, parseStove, processResponse } from '../src/edilkamin.js';
import { MACS, buffer, stoveDocument } from './fixtures/edilkamin.js';

test('gzip Buffer fields are inflated, nested ones and in lists too; plain fields pass', () => {
  const doc = processResponse({
    a: buffer({ x: 1 }),
    nested: { b: buffer([1, 2]) },
    list: [buffer({ y: 2 }), { c: buffer('z') }, 3],
    mac_address: 'a8032a123456',
  });
  assert.deepEqual(doc, {
    a: { x: 1 },
    nested: { b: [1, 2] },
    list: [{ y: 2 }, { c: 'z' }, 3],
    mac_address: 'a8032a123456',
  });
});

test('a Buffer that is not gzip JSON, or too big once inflated, is kept as it came', () => {
  const notGzip = { type: 'Buffer', data: [1, 2, 3] };
  assert.deepEqual(decompressBuffer(notGzip), notGzip);
  const notJson = { type: 'Buffer', data: [...gzipSync(Buffer.from('not json'))] };
  assert.deepEqual(decompressBuffer(notJson), notJson);
  const badBytes = { type: 'Buffer', data: [31, 139, 'x', 300] };
  assert.deepEqual(decompressBuffer(badBytes), badBytes);
  // 2 MB of spaces gzip to a few KB: refused once inflated past 1 MB.
  const bomb = {
    type: 'Buffer',
    data: [...gzipSync(Buffer.from(`"${' '.repeat(2 * 1024 * 1024)}"`))],
  };
  assert.ok(bomb.data.length < 10_000);
  assert.equal(decompressBuffer(bomb), bomb);
});

test('the values of a stove, from the paths of edilkamin.py', () => {
  const stove = parseStove(
    MACS.living,
    processResponse(
      stoveDocument(MACS.living, {
        power: 1,
        temperature: 20.5,
        setpoint: 22,
        manualPower: 4,
        fans: [3, 0],
        reserve: true,
        alarms: {
          number: 2,
          alarms: [
            { type: 7, timestamp: 1760780000 },
            { type: 3, timestamp: 1760000000 },
          ],
        },
      }),
    ),
  );
  assert.deepEqual(stove, {
    mac: MACS.living,
    power: true,
    temperature: 20.5,
    setpoint: 22,
    powerLevel: 4,
    fansNumber: 2,
    fans: [3, 0],
    pelletReserve: true,
    alarms: { count: 2, code: 7, at: 1760780000 },
  });
});

test('a missing or odd value is unknown, never a guess', () => {
  const stove = parseStove(MACS.living, {
    status: {
      commands: { power: 'on' },
      temperatures: { enviroment: '20' },
      fans: { fan_1_speed: null },
      flags: { is_pellet_in_reserve: 'no' },
    },
    nvm: {
      user_parameters: { enviroment_1_temperature: null, manual_power: 9 },
      installer_parameters: { fans_number: 1 },
    },
  });
  assert.equal(stove.power, undefined);
  assert.equal(stove.temperature, undefined);
  assert.equal(stove.setpoint, undefined);
  assert.equal(stove.powerLevel, undefined);
  assert.deepEqual(stove.fans, [undefined]);
  assert.equal(stove.pelletReserve, undefined);
  assert.equal(stove.alarms, undefined);
  assert.equal(parseStove(MACS.living, {}).power, undefined);
  assert.equal(parseStove(MACS.living, null).power, undefined);
});

test('power as a boolean or as 0/1', () => {
  const of = (power) => parseStove(MACS.living, { status: { commands: { power } } }).power;
  assert.equal(of(true), true);
  assert.equal(of(1), true);
  assert.equal(of(false), false);
  assert.equal(of(0), false);
  assert.equal(of(2), undefined);
});
