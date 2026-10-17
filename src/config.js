// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { LIMITS, POLL_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = {
  // Setpoint and power level from Gladys: off until the user turns them on.
  allow_commands: false,
  // Lighting a flame appliance from afar: off until the user turns it on.
  allow_power_on: false,
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

export const LANGUAGES = ['fr', 'en'];

/** A checkbox may arrive as a boolean or as a string from a form; absent = its default. */
const flag = (value, fallback) => {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return value === true || value === 'true' || value === 1 || value === '1';
};

/**
 * The key of an account in /data: a hash of the user name, never the user
 * name itself. Only tells whether what is kept there belongs to this account.
 */
export const accountKey = (username) =>
  username
    ? createHash('sha256').update(`edilkamin:${username}`, 'utf8').digest('hex').slice(0, 32)
    : '';

/**
 * The MAC addresses typed by the user ("A8:03:2A:12:34:56, a8032a654321"):
 * `{ macs, invalid }`, the MACs as the API wants them (12 hex digits, lower
 * case, edilkamin.py `format_mac`), without duplicates, 10 at most.
 */
export function parseMacs(raw) {
  const macs = [];
  let invalid = 0;
  for (const part of String(raw ?? '').split(/[\s,;]+/)) {
    if (part === '') {
      continue;
    }
    const mac = part.replace(/[:.-]/g, '').toLowerCase();
    if (!/^[0-9a-f]{12}$/.test(mac)) {
      invalid += 1;
    } else if (!macs.includes(mac) && macs.length < LIMITS.stoves) {
      macs.push(mac);
    }
  }
  return { macs, invalid };
}

export function normalizeConfig(raw = {}) {
  const given = raw?.poll_interval;
  const interval = given === undefined || given === null || given === '' ? NaN : Number(given);
  const language = String(raw?.language ?? DEFAULTS.language)
    .trim()
    .toLowerCase();
  // The user name is kept as typed but for the spaces around it (Cognito
  // user names may be case-sensitive).
  const username = String(raw?.username ?? '').trim();
  // The password is kept as typed: spaces may be part of it.
  const password = typeof raw?.password === 'string' ? raw.password : String(raw?.password ?? '');
  const { macs, invalid } = parseMacs(raw?.mac_addresses);
  return {
    username,
    password,
    account: accountKey(username),
    macs,
    invalidMacs: invalid,
    allowCommands: flag(raw?.allow_commands, DEFAULTS.allow_commands),
    allowPowerOn: flag(raw?.allow_power_on, DEFAULTS.allow_power_on),
    pollInterval: Number.isFinite(interval)
      ? Math.round(Math.max(POLL_INTERVAL.min, Math.min(POLL_INTERVAL.max, interval)))
      : DEFAULTS.poll_interval,
    language: LANGUAGES.includes(language) ? language : DEFAULTS.language,
  };
}
