import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, accountKey, normalizeConfig, parseMacs } from '../src/config.js';

test('defaults: every command but turning off is off', () => {
  const config = normalizeConfig({});
  assert.equal(config.allowPowerOn, false);
  assert.equal(config.allowCommands, false);
  assert.equal(config.pollInterval, DEFAULTS.poll_interval);
  assert.equal(config.language, 'fr');
  assert.deepEqual(config.macs, []);
});

test('the flags: booleans, or strings from a form', () => {
  assert.equal(normalizeConfig({ allow_power_on: 'true' }).allowPowerOn, true);
  assert.equal(normalizeConfig({ allow_power_on: 'false' }).allowPowerOn, false);
  assert.equal(normalizeConfig({ allow_commands: true }).allowCommands, true);
  assert.equal(normalizeConfig({ allow_commands: 'yes' }).allowCommands, false);
});

test('the MAC addresses: separators, case, duplicates, invalid ones counted, 10 at most', () => {
  assert.deepEqual(parseMacs('A8:03:2A:12:34:56, a8-03-2a-65-43-21;A8032A123456 nope'), {
    macs: ['a8032a123456', 'a8032a654321'],
    invalid: 1,
  });
  const many = Array.from({ length: 12 }, (_, i) => `a8032a1234${String(i).padStart(2, '0')}`);
  assert.equal(parseMacs(many.join(',')).macs.length, 10);
  assert.deepEqual(parseMacs(undefined), { macs: [], invalid: 0 });
});

test('the interval is bounded; the user name is trimmed, the password kept as typed', () => {
  assert.equal(normalizeConfig({ poll_interval: 5 }).pollInterval, 60);
  assert.equal(normalizeConfig({ poll_interval: '120' }).pollInterval, 120);
  assert.equal(normalizeConfig({ poll_interval: 99999 }).pollInterval, 900);
  const config = normalizeConfig({ username: ' Someone@Example.com ', password: ' pass ' });
  assert.equal(config.username, 'Someone@Example.com');
  assert.equal(config.password, ' pass ');
  assert.equal(config.account, accountKey('Someone@Example.com'));
  assert.ok(!config.account.includes('@'));
  assert.equal(accountKey(''), '');
});
