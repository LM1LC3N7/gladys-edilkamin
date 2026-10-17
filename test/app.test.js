// -----------------------------------------------------------------------------
// End to end: the real SDK wiring (src/handlers.js) against the SDK's fake
// Gladys, a fake Cognito (real SRP check) and a fake Edilkamin API behind the
// transport. Timers and Date are mocked: the tests move the clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { EdilkaminApp } from '../src/app.js';
import { accountKey } from '../src/config.js';
import { ACTIONS, SCENE_TRIGGERS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { EdilkaminError } from '../src/http.js';
import {
  HOUR,
  MACS,
  MINUTE,
  NOW,
  PASSWORD,
  SECOND,
  TYPED,
  USERNAME,
} from './fixtures/edilkamin.js';
import {
  API_URL,
  COGNITO_URL,
  fakeEdilkamin,
  memoryStore,
  settle,
} from './helpers/fakeEdilkamin.js';

const CONFIG = { username: USERNAME, password: PASSWORD, mac_addresses: TYPED };
const dev = (mac) => `ext:test-integration:edilkamin:${mac}`;

/** A logger keeping every line, to check that no secret ever reaches the logs. */
const recorder = (logs) =>
  Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')),
    ]),
  );

function makeApp(gladys, server, store, logs) {
  const app = new EdilkaminApp({
    gladys,
    logger: recorder(logs),
    transport: server.transport,
    now: () => Date.now(),
    store,
    cognitoUrl: COGNITO_URL,
    apiUrl: API_URL,
  });
  registerHandlers(gladys, app);
  return app;
}

async function setup(
  t,
  {
    config = CONFIG,
    store = memoryStore(),
    server = fakeEdilkamin(),
    create = true,
    logs = [],
  } = {},
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const gladys = createFakeGladys({ config });
  const app = makeApp(gladys, server, store, logs);
  await gladys.connect();
  await settle();
  t.after(() => app.stop());
  const advance = async (ms, step = 5 * SECOND) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      t.mock.timers.tick(Math.min(step, ms - elapsed));
      await settle();
    }
  };
  if (create) {
    for (const device of gladys.fake.discoveredDevices) {
      await gladys.fake.deviceCreated(device);
    }
    await settle();
  }
  return { gladys, app, server, store, advance, logs };
}

const deviceOf = (gladys, mac) =>
  gladys.fake.discoveredDevices.find((d) => d.external_id === dev(mac));
const featureOf = (gladys, mac, role) =>
  deviceOf(gladys, mac).features.find((f) => f.external_id === `${dev(mac)}:${role}`);
const press = (gladys, mac, role, value = 1) =>
  gladys.fake.setValue(deviceOf(gladys, mac), featureOf(gladys, mac, role), value);
const last = (gladys, mac, role) => gladys.fake.lastState(`${dev(mac)}:${role}`);
const message = (gladys) => gladys.fake.connectionStatus?.message ?? {};
const badgeOf = (gladys, mac) =>
  gladys.fake.transports.filter((b) => b.device_external_id === dev(mac)).at(-1);
const allowAll = { ...CONFIG, allow_power_on: true, allow_commands: true };

function assertNoSecret(where, text, server) {
  for (const secret of [PASSWORD, USERNAME, ...server.secrets]) {
    assert.ok(!text.includes(secret), `${where} holds a secret`);
  }
}

test('without credentials, the status asks for them and nothing is requested', async (t) => {
  const { gladys, server } = await setup(t, { config: { username: '', password: '' } });
  assert.equal(server.requests.length, 0);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).en, /user name \(e-mail\) and the password/);
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.fr, /identifiant \(e-mail\) et le mot de passe/);
});

test('without a MAC address, the status asks for one and nothing is requested', async (t) => {
  const { gladys, server, app } = await setup(t, {
    config: { username: USERNAME, password: PASSWORD, mac_addresses: 'nope' },
  });
  assert.equal(server.requests.length, 0);
  assert.match(message(gladys).fr, /adresse MAC de chaque poêle/);
  // Adding one later starts the reads.
  await app.configUpdated(CONFIG);
  await settle();
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('start: an SRP sign-in checked by Cognito, one read per stove, devices, states', async (t) => {
  const { gladys, server, store, logs } = await setup(t);
  assert.deepEqual(
    server.requests.map((r) => r.target ?? `${r.method} ${r.path}`),
    [
      'InitiateAuth',
      'RespondToAuthChallenge',
      `GET /device/${MACS.living}/info`,
      `GET /device/${MACS.cabin}/info`,
    ],
  );
  assert.match(
    server.lastTimestamp,
    /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d\d:\d\d:\d\d UTC \d{4}$/,
  );
  assert.ok(
    !JSON.stringify(server.requests).includes(PASSWORD),
    'SRP: the password itself is never sent',
  );
  // The bearer is the id token (edilkamin.py, new API), not the access token.
  const [read] = server.api();
  const bearer = read.headers.Authorization.replace('Bearer ', '');
  assert.ok(server.ids.has(bearer));

  assert.deepEqual(gladys.fake.connectionStatus, {
    connected: true,
    message: {
      en: 'Connected to Edilkamin: 2 stoves read. Open Discovery to add them.',
      fr: 'Connecté à Edilkamin : 2 poêles lus. Ouvrez Découverte pour les ajouter.',
    },
  });
  const living = deviceOf(gladys, MACS.living);
  assert.equal(living.name, 'Poêle Edilkamin 3456');
  assert.deepEqual(
    living.features.map((f) => f.external_id.split(':').pop()),
    [
      'power',
      'power-on',
      'power-off',
      'temperature',
      'setpoint',
      'power-level',
      'fan-1',
      'fan-2',
      'pellet-reserve',
      'last-alarm',
    ],
  );
  assert.deepEqual(
    deviceOf(gladys, MACS.cabin).features.map((f) => f.external_id.split(':').pop()),
    [
      'power',
      'power-on',
      'power-off',
      'temperature',
      'setpoint',
      'power-level',
      'fan-1',
      'pellet-reserve',
    ],
  );
  // Gzip Buffer fields (living) and plain JSON (cabin) alike.
  assert.equal(last(gladys, MACS.living, 'power'), 0);
  assert.equal(last(gladys, MACS.living, 'temperature'), 19.5);
  assert.equal(last(gladys, MACS.living, 'setpoint'), 21);
  assert.equal(last(gladys, MACS.living, 'power-level'), '3');
  assert.equal(last(gladys, MACS.living, 'fan-1'), 2);
  assert.equal(last(gladys, MACS.living, 'fan-2'), 1);
  assert.equal(last(gladys, MACS.living, 'pellet-reserve'), 0);
  assert.equal(last(gladys, MACS.living, 'last-alarm'), 'Alarme 3 (2025-10-09 08:53 UTC)');
  assert.equal(last(gladys, MACS.cabin, 'power'), 1);
  assert.equal(last(gladys, MACS.cabin, 'setpoint'), 22.5);
  assert.equal(last(gladys, MACS.cabin, 'pellet-reserve'), 1);
  assert.equal(badgeOf(gladys, MACS.living).transport, 'cloud');

  assertNoSecret('the devices', JSON.stringify(gladys.fake.discoveredDevices), server);
  assertNoSecret('the states', JSON.stringify(gladys.fake.states), server);
  assertNoSecret('the logs', logs.join('\n'), server);
  assert.ok(!logs.join('\n').includes(MACS.living), 'no whole MAC address in the logs');
  const kept = JSON.stringify(store.data);
  assert.ok(
    !kept.includes(PASSWORD) && !kept.includes(USERNAME),
    'no password nor user name in /data',
  );
  assert.equal(store.data.account, accountKey(USERNAME));
  assert.ok(store.data.tokens.refreshToken.startsWith('refresh-'));
});

test('a flame appliance: no switch, no writable binary; the on/off state is read only', async (t) => {
  const { gladys } = await setup(t);
  for (const device of gladys.fake.discoveredDevices) {
    for (const feature of device.features) {
      assert.notEqual(feature.category, 'switch', feature.external_id);
      if (!feature.read_only) {
        assert.ok(
          ['button', 'thermostat', 'text'].includes(feature.category),
          `${feature.external_id} is writable`,
        );
        assert.notEqual(feature.type, 'binary', feature.external_id);
      }
    }
    const power = device.features.find((f) => f.external_id.endsWith(':power'));
    assert.equal(power.read_only, true);
    assert.deepEqual([power.category, power.type], ['unknown', 'binary']);
    for (const role of ['power-on', 'power-off']) {
      const button = device.features.find((f) => f.external_id.endsWith(`:${role}`));
      assert.deepEqual([button.category, button.type, button.read_only], ['button', 'push', false]);
    }
  }
});

test('lighting is off by default: refused, nothing sent; turning off is always allowed', async (t) => {
  const { gladys, server } = await setup(t);
  const on = await press(gladys, MACS.living, 'power-on');
  assert.equal(on.success, false);
  assert.match(on.error, /allumage du poêle depuis Gladys est désactivé/);
  assert.deepEqual(server.commands(), []);

  const before = server.reads(MACS.cabin).length;
  const off = await press(gladys, MACS.cabin, 'power-off');
  assert.equal(off.success, true, off.error);
  assert.equal(server.reads(MACS.cabin).length, before + 1, 'read again just before acting');
  assert.deepEqual(server.commands(), [{ mac_address: MACS.cabin, name: 'power', value: 0 }]);
  assert.equal(server.stoves[MACS.cabin].power, 0);
});

test('turning off an already-off stove sends nothing; a failed read never stops turning off', async (t) => {
  const { gladys, server } = await setup(t);
  const ack = await press(gladys, MACS.living, 'power-off');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(server.commands(), [], 'already off');

  server.queue.push({
    match: (r) => r.path === `/device/${MACS.cabin}/info`,
    throws: new EdilkaminError('network', 'connection reset'),
  });
  const off = await press(gladys, MACS.cabin, 'power-off');
  assert.equal(off.success, true, off.error);
  assert.deepEqual(server.commands(), [{ mac_address: MACS.cabin, name: 'power', value: 0 }]);
});

test('lighting, when allowed: fresh read, one command, a guard until a later read', async (t) => {
  const { gladys, server, advance } = await setup(t, { config: allowAll });
  const ack = await press(gladys, MACS.living, 'power-on');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(server.commands(), [{ mac_address: MACS.living, name: 'power', value: 1 }]);

  // Right after: the guard refuses a new lighting, even though the read shows it on.
  const again = await press(gladys, MACS.living, 'power-on');
  assert.equal(again.success, false);
  assert.match(again.error, /encore en cours/);

  // A read 5 s later shows it on: the guard ends; lighting again is "already on".
  await advance(6 * SECOND, SECOND);
  const third = await press(gladys, MACS.living, 'power-on');
  assert.equal(third.success, true, third.error);
  assert.equal(server.commands().length, 1);
  assert.equal(last(gladys, MACS.living, 'power'), 1);
});

test('lighting is refused when the read fails or does not say whether it is on', async (t) => {
  const { gladys, server } = await setup(t, { config: allowAll });
  server.queue.push({
    match: (r) => r.path === `/device/${MACS.living}/info`,
    status: 503,
    body: {},
  });
  const ack = await press(gladys, MACS.living, 'power-on');
  assert.equal(ack.success, false);
  assert.match(ack.error, /n'a pas pu être relu/);

  delete server.stoves[MACS.living].power;
  server.stoves[MACS.living].power = 'unknown';
  const unknown = await press(gladys, MACS.living, 'power-on');
  assert.equal(unknown.success, false);
  assert.match(unknown.error, /n'a pas indiqué s'il est allumé/);
  assert.deepEqual(server.commands(), []);
});

test('a command that cannot be sent within 3.5 s is refused, nothing sent', async (t) => {
  const { gladys, server } = await setup(t, { config: allowAll });
  server.queue.push({
    match: (r) => r.path === `/device/${MACS.living}/info`,
    before: () => t.mock.timers.tick(3_600),
  });
  const ack = await press(gladys, MACS.living, 'power-on');
  assert.equal(ack.success, false);
  assert.match(ack.error, /trop tard/);
  assert.deepEqual(server.commands(), []);
});

test('turning off never waits behind a slow lighting of the same stove', async (t) => {
  const { gladys, server } = await setup(t, { config: allowAll });
  let release;
  server.queue.push({
    match: (r) => r.path === `/device/${MACS.living}/info`,
    before: () => new Promise((resolve) => (release = resolve)),
  });
  const on = press(gladys, MACS.living, 'power-on');
  await settle();
  server.stoves[MACS.living].power = 1;
  const off = await press(gladys, MACS.living, 'power-off');
  assert.equal(off.success, true, off.error);
  assert.deepEqual(server.commands(), [{ mac_address: MACS.living, name: 'power', value: 0 }]);
  release();
  await on;
});

test('the buttons accept only 1; the setpoint and the power level are strict', async (t) => {
  const { gladys, server } = await setup(t, { config: allowAll });
  for (const value of [0, '0', '', null, 2]) {
    const ack = await press(gladys, MACS.cabin, 'power-off', value);
    assert.equal(ack.success, false, `button value ${value}`);
  }
  for (const value of [null, '', ' ', true, 40, 11.5, 21.3, 'abc']) {
    const ack = await press(gladys, MACS.living, 'setpoint', value);
    assert.equal(ack.success, false, `setpoint ${value}`);
  }
  for (const value of ['0', '6', 2.5, '', null]) {
    const ack = await press(gladys, MACS.living, 'power-level', value);
    assert.equal(ack.success, false, `power level ${value}`);
  }
  assert.deepEqual(server.commands(), []);
});

test('the setpoint and the power level are off by default, sent after a fresh read when allowed', async (t) => {
  const { gladys, server, app } = await setup(t);
  const refused = await press(gladys, MACS.living, 'setpoint', 22);
  assert.equal(refused.success, false);
  assert.match(refused.error, /consigne et la puissance ne peuvent pas être changées/);

  await app.configUpdated(allowAll);
  const same = await press(gladys, MACS.living, 'setpoint', 21);
  assert.equal(same.success, true, same.error);
  assert.deepEqual(server.commands(), [], 'already 21 °C');
  const set = await press(gladys, MACS.living, 'setpoint', '21,5');
  assert.equal(set.success, true, set.error);
  const level = await press(gladys, MACS.living, 'power-level', '4');
  assert.equal(level.success, true, level.error);
  assert.deepEqual(server.commands(), [
    { mac_address: MACS.living, name: 'enviroment_1_temperature', value: 21.5 },
    { mac_address: MACS.living, name: 'power_level', value: 4 },
  ]);
  assert.equal(server.stoves[MACS.living].power, 0, 'neither lights the stove');
});

test('a 429: a pause for every path but turning off, kept in /data', async (t) => {
  const { gladys, server, store, advance } = await setup(t, { config: allowAll });
  server.queue.push({
    match: (r) => r.path === `/device/${MACS.living}/info`,
    status: 429,
    headers: { 'retry-after': '600' },
  });
  await advance(MINUTE);
  assert.match(message(gladys).fr, /ralentir : pause de 10 min/);
  assert.equal(store.data.pause.kind, 'rate');
  const reads = server.api().length;
  await advance(5 * MINUTE);
  assert.equal(server.api().length, reads, 'no read during the pause');

  const on = await press(gladys, MACS.living, 'power-on');
  assert.equal(on.success, false);
  assert.match(on.error, /ralentir/);
  const off = await press(gladys, MACS.cabin, 'power-off');
  assert.equal(off.success, true, off.error);
  assert.deepEqual(server.commands(), [{ mac_address: MACS.cabin, name: 'power', value: 0 }]);
});

test('refused credentials: a stop with a new try after 1 h; the test button retries at once', async (t) => {
  const server = fakeEdilkamin();
  server.password = 'another one';
  const { gladys, advance } = await setup(t, { server, create: false });
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).fr, /refusé l'identifiant ou le mot de passe/);
  assert.equal(server.srpStarts().length, 1);
  await advance(30 * MINUTE, MINUTE);
  assert.equal(server.srpStarts().length, 1, 'no loop');
  await advance(31 * MINUTE, MINUTE);
  assert.equal(server.srpStarts().length, 2, 'one new try after 1 h');

  server.password = PASSWORD;
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.fr, /Connecté à Edilkamin/);
});

test('a verification code asked: a stop, never a new sign-in by itself', async (t) => {
  const server = fakeEdilkamin({ challenge: 'SMS_MFA' });
  const { gladys, advance, store } = await setup(t, { server, create: false });
  assert.match(message(gladys).fr, /code de vérification/);
  assert.equal(store.data.block.kind, 'two_factor');
  await advance(25 * HOUR, 10 * MINUTE);
  assert.equal(server.srpStarts().length, 1);
});

test('the token is renewed from the refresh token, never a new sign-in each cycle', async (t) => {
  const { server, advance, gladys } = await setup(t);
  await advance(3 * HOUR, 30 * SECOND);
  assert.equal(server.srpStarts().length, 1, 'one sign-in only');
  assert.ok(server.refreshes().length >= 3 && server.refreshes().length <= 4);
  assert.ok(server.reads(MACS.living).length >= 170, 'read every minute');
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a revoked refresh token: one new sign-in, never a loop', async (t) => {
  const { server, advance, gladys } = await setup(t);
  server.revoke();
  await advance(2 * MINUTE, 30 * SECOND);
  assert.equal(server.srpStarts().length, 2);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a restart reuses the tokens kept in /data: no new sign-in', async (t) => {
  const store = memoryStore();
  const server = fakeEdilkamin();
  const first = await setup(t, { store, server });
  first.app.stop();
  const gladys = createFakeGladys({ config: CONFIG });
  const app = makeApp(gladys, server, store, []);
  t.after(() => app.stop());
  await gladys.connect();
  await settle();
  assert.equal(server.srpStarts().length, 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('an unknown MAC: that stove is unreadable (degraded badge), the others are read', async (t) => {
  const server = fakeEdilkamin();
  const { gladys, advance } = await setup(t, { server });
  delete server.stoves[MACS.cabin];
  await advance(MINUTE);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(message(gladys).fr, /1 poêle n'a pas pu être lu/);
  const badge = badgeOf(gladys, MACS.cabin);
  assert.deepEqual([badge.transport, badge.degraded], ['unreachable', true]);
  assert.equal(badgeOf(gladys, MACS.living).transport, 'cloud');
  // Kept in Discovery with its features, last values unchanged.
  assert.ok(deviceOf(gladys, MACS.cabin));
});

test('every stove refused (403): a 30-minute pause', async (t) => {
  const { gladys, server, advance } = await setup(t);
  for (const mac of Object.values(MACS)) {
    server.queue.push({ match: (r) => r.path === `/device/${mac}/info`, status: 403 });
  }
  await advance(MINUTE);
  assert.match(message(gladys).fr, /HTTP 403\) : pause de 30 min/);
  const reads = server.api().length;
  await advance(20 * MINUTE, MINUTE);
  assert.equal(server.api().length, reads);
  await advance(12 * MINUTE, MINUTE);
  assert.ok(server.api().length > reads);
});

test('a new alarm in the log fires the scene trigger, never on the first read', async (t) => {
  const { gladys, server, advance } = await setup(t);
  assert.equal(gladys.fake.sceneEvents.length, 0);
  server.stoves[MACS.living].alarms = {
    number: 2,
    alarms: [
      { type: 3, timestamp: 1760000000 },
      { type: 7, timestamp: 1760780000 },
    ],
  };
  await advance(MINUTE);
  assert.deepEqual(gladys.fake.sceneEvents, [
    { key: SCENE_TRIGGERS.ALARM, data: { stove: 'Poêle Edilkamin 3456', code: '7' } },
  ]);
  assert.match(last(gladys, MACS.living, 'last-alarm'), /^Alarme 7 \(/);
});

test('a reconnection to Gladys sends the status and Discovery again, the pause stays', async (t) => {
  const { gladys, server, app, advance } = await setup(t);
  server.queue.push({
    match: (r) => r.path === `/device/${MACS.living}/info`,
    status: 429,
    headers: { 'retry-after': '3600' },
  });
  await advance(MINUTE);
  const statuses = gladys.fake.connectionStatuses.length;
  await app.connected(CONFIG);
  assert.ok(gladys.fake.connectionStatuses.length > statuses);
  assert.ok(app.hardPaused, 'the 429 pause holds');
});

test('a republished device keeps the features it was created with', async (t) => {
  const { gladys, server, advance } = await setup(t);
  delete server.stoves[MACS.living].alarms;
  server.stoves[MACS.living].fans = [2];
  await advance(MINUTE);
  const roles = deviceOf(gladys, MACS.living).features.map((f) => f.external_id.split(':').pop());
  assert.ok(roles.includes('fan-2') && roles.includes('last-alarm'));
});
