// -----------------------------------------------------------------------------
// The stove document of `GET device/{mac}/info` (pure).
//
// - processResponse(): the API sends some fields as a Node.js Buffer of gzip
//   data (`{ type: 'Buffer', data: [31, 139, …] }`): they are inflated and
//   parsed, as edilkamin.py buffer_utils does, with bounds (size, depth).
// - parseStove(): the values the integration uses, each one checked; a value
//   missing or out of its range is `undefined`, never a guess. The paths are
//   those of edilkamin.py api.py; `nvm.alarms_log` is not in edilkamin.py
//   (read only when present, to check on a real stove: TODO.md).
// -----------------------------------------------------------------------------

import { gunzipSync } from 'node:zlib';
import { FANS, LIMITS, POWER_LEVEL } from './constants.js';

const MAX_DEPTH = 8;

const isBuffer = (value) =>
  Boolean(value) &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  value.type === 'Buffer' &&
  Array.isArray(value.data);

/** A gzip Buffer field -> its JSON, or the field unchanged when it is not that. */
export function decompressBuffer(value) {
  if (!isBuffer(value)) {
    return value;
  }
  const { data } = value;
  if (
    data.length > LIMITS.responseBytes ||
    !data.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)
  ) {
    return value;
  }
  try {
    const text = gunzipSync(Buffer.from(data), { maxOutputLength: LIMITS.inflatedBytes }).toString(
      'utf8',
    );
    return JSON.parse(text);
  } catch {
    // Not gzip, too big once inflated, or not JSON: kept as it came.
    return value;
  }
}

/** Every gzip Buffer field of an answer inflated (edilkamin.py `process_response`). */
export function processResponse(value, depth = 0) {
  if (depth > MAX_DEPTH || !value || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      isBuffer(item) ? decompressBuffer(item) : processResponse(item, depth + 1),
    );
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = isBuffer(item) ? decompressBuffer(item) : processResponse(item, depth + 1);
  }
  return result;
}

const get = (root, path) =>
  path.reduce(
    (node, key) =>
      node && typeof node === 'object' && !Array.isArray(node) ? node[key] : undefined,
    root,
  );

/** A number in [min, max], else undefined (null, '', true are not numbers). */
const numberIn = (value, min, max) =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : undefined;

const integerIn = (value, min, max) => {
  const n = numberIn(value, min, max);
  return Number.isInteger(n) ? n : undefined;
};

/** true/false, or 1/0 (edilkamin.py tests use both); anything else is unknown. */
const flag = (value) => {
  if (value === true || value === 1) {
    return true;
  }
  if (value === false || value === 0) {
    return false;
  }
  return undefined;
};

/** The last alarm of `nvm.alarms_log` when present: `{ count, code, at }`. */
function alarmsOf(info) {
  const log = get(info, ['nvm', 'alarms_log']);
  if (!log || typeof log !== 'object' || Array.isArray(log)) {
    return undefined;
  }
  const list = Array.isArray(log.alarms) ? log.alarms : [];
  const count =
    integerIn(log.number, 0, 1_000_000) ?? (Array.isArray(log.alarms) ? list.length : undefined);
  if (count === undefined) {
    return undefined;
  }
  // The newest entry: the highest timestamp, else the last one.
  let last;
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || integerIn(entry.type, 0, 9999) === undefined) {
      continue;
    }
    const at = integerIn(entry.timestamp, 0, 4_102_444_800);
    if (!last || (at ?? -1) >= (last.at ?? -1)) {
      last = { code: entry.type, at };
    }
  }
  return { count, code: last?.code, at: last?.at };
}

/**
 * The stove as the integration uses it. `mac`: the id asked for (the answer
 * itself is not trusted to say which stove it is).
 */
export function parseStove(mac, info) {
  const fansNumber = integerIn(
    get(info, ['nvm', 'installer_parameters', 'fans_number']),
    0,
    FANS.max,
  );
  const fans = [];
  for (let n = 1; n <= (fansNumber ?? 0); n += 1) {
    fans.push(integerIn(get(info, ['status', 'fans', `fan_${n}_speed`]), 0, FANS.speedMax));
  }
  return {
    mac,
    power: flag(get(info, ['status', 'commands', 'power'])),
    temperature: numberIn(get(info, ['status', 'temperatures', 'enviroment']), -40, 100),
    setpoint: numberIn(get(info, ['nvm', 'user_parameters', 'enviroment_1_temperature']), 0, 50),
    powerLevel: integerIn(
      get(info, ['nvm', 'user_parameters', 'manual_power']),
      POWER_LEVEL.min,
      POWER_LEVEL.max,
    ),
    fansNumber,
    fans,
    pelletReserve: flag(get(info, ['status', 'flags', 'is_pellet_in_reserve'])),
    alarms: alarmsOf(info),
  };
}
