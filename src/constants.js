// -----------------------------------------------------------------------------
// Constants of the Edilkamin "The Mind" cloud and of the integration.
//
// The cloud values are those of AndreMiras/edilkamin.py 1.7.0 (MIT, see
// THIRD_PARTY_NOTICES.md), read from the Edilkamin "The Mind" app: the AWS
// Cognito user pool and app client of the app (a public client, without a
// secret) and the base URL of the API. They are the app's own public
// constants, not secrets of the user.
// -----------------------------------------------------------------------------

/** The manifest action keys. */
export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** The manifest scene trigger keys. */
export const SCENE_TRIGGERS = {
  ALARM: 'stove_alarm',
};

/** AWS Cognito, as edilkamin.py signs in (pycognito SRP; the id token is the bearer). */
export const COGNITO = {
  region: 'eu-central-1',
  poolId: 'eu-central-1_BYmQ2VBlo',
  clientId: '7sc1qltkqobo3ddqsk4542dg2h',
  url: 'https://cognito-idp.eu-central-1.amazonaws.com/',
};

/** The "new" Edilkamin API of edilkamin.py (constants.NEW_API_URL). */
export const API = {
  url: 'https://the-mind-api.edilkamin.com',
  userAgent: 'gladys-edilkamin',
};

/**
 * The `name` of the `PUT mqtt/command` payloads (edilkamin.py api.py).
 * `power`: 1 lights the stove, 0 turns it off.
 */
export const COMMANDS = {
  POWER: 'power',
  SETPOINT: 'enviroment_1_temperature',
  POWER_LEVEL: 'power_level',
};

/** Gladys values (server/utils/constants.js of the core). */
export const GLADYS = {
  ON: 1,
  OFF: 0,
  /** BUTTON_PUSH.PRESSED: the value a `button/push` feature sends. */
  PRESSED: 1,
};

/**
 * The setpoint accepted from Gladys (°C), half degrees. A guess on the safe
 * side of the app's range, to check on a real stove (TODO.md).
 */
export const SETPOINT = { min: 12, max: 30, step: 0.5 };

/** The manual power level of the stove (edilkamin.py `manual_power`, the app's P1 to P5). */
export const POWER_LEVEL = { min: 1, max: 5 };

/** Fans read (`nvm.installer_parameters.fans_number`, `status.fans.fan_<n>_speed`). */
export const FANS = { max: 3, speedMax: 6 };

/** The poll interval of the configuration, in seconds. */
export const POLL_INTERVAL = { default: 60, min: 60, max: 900 };

export const SECOND = 1_000;
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** A read of a stove, a sign-in step. */
  requestTimeout: 15_000,
  /** The test button and the Discovery scan wait for Gladys; their requests are shorter. */
  quickTimeout: 10_000,
  /**
   * Gladys gives up on a set_value after 5 s and shows a failure: a command
   * not sent 3.5 s after it arrived is refused, never sent after the failure.
   */
  commandDeadline: 3_500,
  /** The command itself is sent 3.4 s after the arrival at the latest… */
  commandStartBy: 3_400,
  /** …and answered by 4.6 s after the arrival (its timeout: receivedAt + 4.6 s - now). */
  commandAnswerBy: 4_600,
  /** The read just before a command: 3 s at most. */
  commandReadTimeout: 3_000,
  /**
   * The read before turning off: 2 s at most. Turning off never waits on it:
   * when it fails, the stove is turned off anyway (the safe direction).
   */
  offReadTimeout: 2_000,
  /** A command uses the current token when it is valid for 60 s more. */
  commandTokenValidity: MINUTE,
  /** Turning off uses the current token while it is valid at all (10 s more). */
  offTokenValidity: 10 * SECOND,
  /** The shortest timeout worth a request, inside the command deadline. */
  minRequestTimeout: 300,
  /**
   * After a power command (sent or maybe sent): lighting is refused, and
   * turning off never answers "already off", until a read shows the expected
   * state, or for 60 s at most.
   */
  powerGuard: MINUTE,
  /** A read this soon after the command never ends its guard (the cloud may lag). */
  guardMinAge: 4_000,
  /** The re-reads after a command, to show its effect. */
  followUps: [5_000, 15_000, 45_000],
  /** The renewal timer tries again this long after a failed renewal. */
  renewRetry: MINUTE,
  /** Renew the token this long before it expires. */
  tokenMargin: 5 * MINUTE,
  /** Lifetime assumed when Cognito gives none (its default: 1 h). */
  tokenLifetime: HOUR,
  /** Pauses after failures, never shorter than the poll interval. */
  backoff: [MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE],
  /** After refused credentials: one new sign-in after 1 h, 6 h, then every 24 h. */
  refusedRetry: [HOUR, 6 * HOUR, 24 * HOUR],
  /** 429 (or Cognito TooManyRequests): a pause between 60 s and 6 h, Retry-After when given. */
  rateLimitMin: MINUTE,
  rateLimitMax: 6 * HOUR,
  rateLimitDefault: 5 * MINUTE,
  /** Every stove answered 403 (a WAF or CDN block): a 30-minute pause. */
  forbiddenPause: 30 * MINUTE,
  /** The test button and the Discovery scan read the cloud at most every 30 s. */
  testCooldown: 30_000,
  /** States flushed to Gladys every second; unchanged ones again every 30 min. */
  flushInterval: 1_000,
  stateHeartbeat: 30 * MINUTE,
};

export const LIMITS = {
  /** Gladys accepts 300 states per minute. */
  statesPerMinute: 280,
  statesPerRequest: 100,
  sceneEventsPerMinute: 280,
  queuedEvents: 200,
  /** The biggest answer read (a stove document is a few KB)… */
  responseBytes: 1024 * 1024,
  /** …and the biggest gzip Buffer field once inflated. */
  inflatedBytes: 1024 * 1024,
  /** Stoves of the configuration. */
  stoves: 10,
  textLength: 120,
};
