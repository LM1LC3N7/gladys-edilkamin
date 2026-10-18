// -----------------------------------------------------------------------------
// The integration: the Edilkamin account (user name, password), the MAC
// addresses of the stoves, one read of each stove per cycle (60 s by
// default), the Gladys devices and their states, the "stove alarm" scene
// trigger, the transport badges and the commands of the stoves, under
// Louis's rules for a flame appliance:
//
// - turning off is always allowed; lighting (allow_power_on) and the
//   setpoint and power level (allow_commands) are off until the user turns
//   them on;
// - no switch: lighting and turning off are two buttons, the on/off state is
//   read only (an "everything on" can never light the stove);
// - lighting, the setpoint and the power level read the stove again (GET
//   device/{mac}/info) just before acting, never decide on a state in memory,
//   and are refused when that read fails or lacks the value;
// - turning off decides nothing: `power` 0 is always sent (never answered
//   "already off"), it never waits behind the queue, only behind a lighting
//   request already in flight (so it lands after it), and renews an expired
//   token within its own deadline;
// - a turn off counts at its arrival: a lighting queued or in progress that
//   sees the count change is refused, up to the moment it sends;
// - lighting, the setpoint and the power level of one stove run one at a time
//   (a promise chain per stove);
// - a command not sent 3.5 s after it arrived is refused (Gladys shows a
//   failure after 5 s: nothing must happen after that);
// - after a power command (sent or maybe sent), lighting is refused until a
//   later read shows the expected state, 60 s at most.
//
// The pauses (429, 403) and the stops (refused credentials) are kept in
// /data and hold for every path but turning off. A pause of the Edilkamin API
// does not stop the token renewals (one of Cognito does). index.js only wires
// the SDK handlers to this class.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { EdilkaminClient } from './client.js';
import { normalizeConfig } from './config.js';
import { COMMANDS, GLADYS, POWER_LEVEL, SCENE_TRIGGERS, SETPOINT, TIMINGS } from './constants.js';
import {
  COMMAND_ROLES,
  buildDevice,
  deviceIds,
  deviceName,
  parseFeatureId,
  statesOf,
} from './devices.js';
import { parseStove } from './edilkamin.js';
import { EdilkaminError, errorReason } from './http.js';
import { T, age, join, reasonOf, word } from './i18n.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory } from './store.js';

/** Errors after which Edilkamin did not answer usefully: every stove is unreachable. */
const OFFLINE = new Set(['network', 'timeout', 'unavailable']);

/** Errors of one stove only: the others are still read. */
const PER_STOVE = new Set([
  'not_found',
  'forbidden',
  'bad_response',
  'size',
  'http',
  'unavailable',
  'timeout',
]);

/** Per-stove errors that say nothing about the stove itself (the cloud did not answer). */
const TRANSIENT = new Set(['unavailable', 'timeout', 'http']);

/** Stops retried by themselves, spaced (1 h, 6 h, then every 24 h). */
const SPACED = new Set(['refused', 'new_password', 'session_refused']);

/**
 * Stops never retried by themselves (each sign-in could send a code, or meet
 * the same unknown step): only the test button, or new credentials, lift them.
 */
const NO_AUTO_RETRY = new Set(['two_factor', 'unsupported_challenge']);

/** Command errors after which Edilkamin may have executed it anyway. */
const MAYBE_SENT = new Set(['timeout', 'network', 'unavailable', 'bad_response', 'size']);

/** A refusal shown in the ack of the command (Gladys shows the message). */
class Refusal extends Error {}

/** The last 4 digits of a MAC, for the logs (never the whole address). */
const short = (mac) => `…${String(mac).slice(-4)}`;

export class EdilkaminApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'edilkamin' }),
    transport,
    now = Date.now,
    timers = globalThis,
    store = fileStore(),
    random,
    cognitoUrl,
    apiUrl,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.store = store;
    this.client = new EdilkaminClient({
      transport,
      now,
      random,
      cognitoUrl,
      apiUrl,
      onChange: () => this.persist(),
    });
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null);
    /** mac -> stove as last read (src/edilkamin.js parseStove), plus `seenAt` */
    this.stoves = new Map();
    /** mac -> the kind of the error of its last read, while it fails */
    this.unreadable = new Map();
    this.readAt = undefined;
    this.published = undefined;
    /** deviceId -> badge last published (JSON) */
    this.badges = new Map();
    this.timer = undefined;
    this.renewTimer = undefined;
    this.followUpTimers = new Set();
    this.running = undefined;
    this.generation = 0;
    /**
     * undefined | 'refused' | 'new_password' | 'unsupported_challenge' |
     * 'session_refused' (tried again at `retryAt`) | 'two_factor' (no new
     * try by itself: each sign-in would send a code).
     */
    this.blocked = undefined;
    this.blockDetail = undefined;
    this.retries = 0;
    this.retryAt = 0;
    this.offline = false;
    this.failures = 0;
    this.pausedUntil = 0;
    /** 'rate' (429), 'forbidden' (403): every path waits; 'backoff': the polling only. */
    this.pauseKind = undefined;
    /** mac -> tail of its command chain: one command at a time per stove */
    this.commandChains = new Map();
    /** mac -> { expected, sentAt, until }: see observe(). */
    this.guards = new Map();
    /** mac -> how many turn offs arrived (a lighting is refused when it changed). */
    this.offCounts = new Map();
    /** mac -> the lighting request in flight (settles, never rejects). */
    this.lightings = new Map();
    /** 'api' | 'cognito': where the current 429 pause comes from. */
    this.pauseSource = undefined;
    this.lastStatus = undefined;
    this.lastTestAt = -Infinity;
    /** When the renewal timer last renewed the token (at most one per renewRetry). */
    this.lastRenewAt = -Infinity;
    this.started = false;
  }

  // --- Lifecycle -------------------------------------------------------------

  /** `fresh`: the user changed the credentials, the stops are lifted. */
  async start(raw = {}, { fresh = false } = {}) {
    this.stop();
    await this.running;
    this.config = normalizeConfig(raw);
    this.reset();
    this.memory = normalizeMemory(await this.store.load().catch(() => null), this.now());
    const { account } = this.config;
    if (this.memory.account !== account) {
      // Another account: its tokens and its stops are not this one's. A 429 pause stays.
      this.memory = { ...this.memory, account, tokens: null, block: null };
    }
    if (fresh) {
      // New credentials: the stop is lifted and the tokens of the old ones go.
      this.memory.block = null;
      this.memory.tokens = null;
    }
    const { pause, block } = this.memory;
    if (pause && pause.until > this.now()) {
      this.pausedUntil = pause.until;
      this.pauseKind = pause.kind;
      this.pauseSource = pause.source;
    }
    if (block) {
      this.blocked = block.kind;
      this.blockDetail = block.detail;
      this.retries = block.retries;
      this.retryAt = block.retryAt ?? 0;
    }
    if (!this.config.username || !this.config.password) {
      // A missing user name or password: the tokens of the account go too.
      this.memory.tokens = null;
    }
    this.client.configure({
      username: this.config.username,
      password: this.config.password,
      tokens: this.memory.tokens,
    });
    await this.saveMemory();
    this.publisher.start();
    if (!this.client.hasCredentials) {
      await this.setStatus(false, T.noCredentials);
      return;
    }
    if (this.config.macs.length === 0) {
      await this.setStatus(false, T.noStoves);
      return;
    }
    this.scheduleRenew();
    if (this.blocked) {
      await this.setStatus(false, this.blockedMessage());
      this.scheduleNext();
      return;
    }
    await this.setStatus(false, this.pauseMessage() ?? T.connecting);
    await this.tick();
  }

  stop() {
    this.generation += 1;
    this.clearTimer();
    this.clearRenewTimer();
    for (const handle of this.followUpTimers) {
      this.timers.clearTimeout(handle);
    }
    this.followUpTimers.clear();
    this.publisher.stop();
  }

  clearTimer() {
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  clearRenewTimer() {
    if (this.renewTimer) {
      this.timers.clearTimeout(this.renewTimer);
      this.renewTimer = undefined;
    }
  }

  /** The integration has something to read: credentials and at least one MAC. */
  get configured() {
    return this.client.hasCredentials && this.config.macs.length > 0;
  }

  /** A 429 or 403 pause holds now (every path waits, but turning off). */
  get hardPaused() {
    return (
      (this.pauseKind === 'rate' || this.pauseKind === 'forbidden') && this.now() < this.pausedUntil
    );
  }

  /**
   * A 429 of Cognito itself holds now: the renewals wait for its end. A pause
   * of the Edilkamin API (429, 403) does not stop them, so turning off always
   * finds a valid token.
   */
  get cognitoPaused() {
    return this.pauseKind === 'rate' && this.pauseSource === 'cognito' && this.hardPaused;
  }

  /**
   * The renewal of the token, at its expiry minus the margin, whatever the
   * poll interval: a command never meets an expired token. It waits for the
   * end of a Cognito 429 pause and never runs during a stop.
   */
  scheduleRenew(delay) {
    this.clearRenewTimer();
    const renewAt = this.client.renewAt;
    if (!this.configured || this.blocked || renewAt === undefined) {
      return;
    }
    let at = delay === undefined ? renewAt : this.now() + delay;
    // A floor: a token shorter than the margin, or a host clock ahead, would
    // otherwise renew at once again and again.
    at = Math.max(at, this.lastRenewAt + TIMINGS.renewRetry);
    if (this.cognitoPaused) {
      at = Math.max(at, this.pausedUntil);
    }
    const generation = this.generation;
    this.renewTimer = this.timers.setTimeout(
      () => {
        this.renewTimer = undefined;
        if (generation !== this.generation || this.blocked) {
          return;
        }
        if (this.cognitoPaused || this.now() < (this.client.renewAt ?? Infinity) - 1_000) {
          this.scheduleRenew();
          return;
        }
        // A success persists the new tokens, which schedules the next renewal.
        this.lastRenewAt = this.now();
        this.client
          .token({ force: true, signIn: false })
          .catch((err) => this.renewFailed(err, generation));
      },
      Math.max(0, at - this.now()),
    );
  }

  /** A renewal outside a read failed: a pause, or a new try in a minute; never a sign-in. */
  async renewFailed(err, generation = this.generation) {
    if (generation !== this.generation) {
      return;
    }
    this.logger.info(`Edilkamin: token renewal failed (${errorReason(err)})`);
    if (err.kind === 'rate_limited') {
      this.pause(err);
      await this.persist();
      return;
    }
    if (err.kind === 'unauthorized') {
      // The refresh token was refused: the next read signs in.
      return;
    }
    this.scheduleRenew(Math.max(TIMINGS.renewRetry, this.config.pollInterval * 1000));
  }

  /** Forgets the stoves and the failures: a new account, or a restart. A 429 pause stays. */
  reset() {
    this.stoves.clear();
    this.unreadable.clear();
    this.guards.clear();
    this.readAt = undefined;
    this.published = undefined;
    this.badges.clear();
    this.blocked = undefined;
    this.blockDetail = undefined;
    this.retries = 0;
    this.retryAt = 0;
    this.offline = false;
    this.failures = 0;
    if (this.pauseKind !== 'rate' || this.now() >= this.pausedUntil) {
      this.pausedUntil = 0;
      this.pauseKind = undefined;
      this.pauseSource = undefined;
    }
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection (Gladys
   * restarted), resend what Gladys keeps in memory only (Discovery list,
   * status, badges). The pauses, the stops and the tokens stay.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.configUpdated(raw);
    this.published = undefined;
    this.badges.clear();
    const status = this.lastStatus;
    this.lastStatus = undefined;
    if (status) {
      const [connected, message] = JSON.parse(status);
      await this.setStatus(connected, message ?? undefined);
    }
    await this.publishDevices();
    await this.publishBadges();
  }

  /** New credentials restart (and lift the stops); the rest applies at once. */
  async configUpdated(raw = {}) {
    const next = normalizeConfig(raw);
    const previous = this.config;
    if (next.username !== previous.username || next.password !== previous.password) {
      return this.start(raw, { fresh: true });
    }
    if (previous.macs.length === 0 && next.macs.length > 0) {
      // The first stove: a start (status, renewal timer, first read).
      return this.start(raw);
    }
    this.config = next;
    const macsChanged = next.macs.join() !== previous.macs.join();
    if (macsChanged) {
      for (const mac of [...this.stoves.keys(), ...this.unreadable.keys()]) {
        if (!next.macs.includes(mac)) {
          this.stoves.delete(mac);
          this.unreadable.delete(mac);
          this.guards.delete(mac);
        }
      }
      this.published = undefined;
      if (next.macs.length === 0) {
        this.clearTimer();
        await this.publishDevices();
        await this.setStatus(false, T.noStoves);
        return;
      }
      // The new stoves are read at once (a pause or a stop still holds).
      this.tick().catch((err) => this.logger.warn(`Edilkamin refresh failed: ${err.message}`));
      return;
    }
    if (next.pollInterval !== previous.pollInterval && this.timer) {
      this.scheduleNext();
    }
    if (next.language !== previous.language) {
      this.published = undefined;
      await this.publishDevices();
      this.queueAll();
      await this.flush();
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  /** The message of the last status (multi-language), or undefined. */
  get lastMessage() {
    return JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? undefined;
  }

  async saveMemory() {
    await this.store
      .save(this.memory)
      .catch((err) => this.logger.warn(`Saving the state to /data failed: ${err.message}`));
  }

  /** The tokens, the pause and the stop, with the account they belong to. */
  async persist() {
    this.memory.account = this.config.account;
    this.memory.tokens = this.client.tokens ? { ...this.client.tokens } : null;
    this.memory.pause = this.hardPaused
      ? { kind: this.pauseKind, until: this.pausedUntil, source: this.pauseSource ?? 'api' }
      : null;
    this.memory.block = this.blocked
      ? {
          kind: this.blocked,
          retries: this.retries,
          retryAt: this.retryAt || undefined,
          detail: this.blockDetail,
        }
      : null;
    await this.saveMemory();
    // New tokens, a new pause or a stop: the renewal follows.
    this.scheduleRenew();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  // --- Polling ---------------------------------------------------------------

  /** The next read: after the pause or the spaced retry, else the interval. */
  scheduleNext() {
    this.clearTimer();
    if (!this.configured) {
      return;
    }
    const now = this.now();
    let delay;
    if (NO_AUTO_RETRY.has(this.blocked)) {
      return;
    } else if (this.blocked) {
      delay = Math.max(this.retryAt, this.pausedUntil) - now;
    } else if (now < this.pausedUntil) {
      // Never read again faster than the interval, a pause included.
      delay = Math.max(this.pausedUntil - now, this.config.pollInterval * 1000);
    } else {
      delay = this.config.pollInterval * 1000;
    }
    const generation = this.generation;
    this.timer = this.timers.setTimeout(
      () => {
        this.timer = undefined;
        if (generation === this.generation) {
          this.tick().catch((err) => this.logger.error(`Edilkamin refresh failed: ${err.message}`));
        }
      },
      Math.max(0, delay),
    );
  }

  /** One run at a time: a tick during a run joins it. `quick`: for a button. */
  tick({ quick = false } = {}) {
    if (!this.running) {
      this.running = this.run({ quick }).finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  async run({ quick = false } = {}) {
    const generation = this.generation;
    if (!this.configured) {
      return;
    }
    if (this.blocked && SPACED.has(this.blocked) && this.now() >= this.retryAt) {
      // The spaced new try: one sign-in at most.
      this.logger.info(`Edilkamin: trying again after a stop (${this.blocked})`);
      this.blocked = undefined;
    }
    if (this.blocked || this.now() < this.pausedUntil) {
      this.scheduleNext();
      return;
    }
    this.client.beginCycle();
    this.client.setTimeoutMs(quick ? TIMINGS.quickTimeout : undefined);
    try {
      const { read, forbidden, transient } = await this.readAll(generation);
      if (generation !== this.generation) {
        return;
      }
      const total = this.config.macs.length;
      if (read === 0 && forbidden === total) {
        // Every stove refused (403): a WAF or a CDN block, not one wrong MAC.
        throw new EdilkaminError('forbidden', 'every stove was refused', { status: 403 });
      }
      if (read === 0 && transient) {
        // No stove answered at all: Edilkamin is unreachable, the backoff follows.
        throw transient;
      }
      this.readAt = this.now();
      await this.publishDevices();
      const hadStop = this.retries > 0 || this.pauseKind !== undefined;
      this.failures = 0;
      this.retries = 0;
      this.retryAt = 0;
      this.offline = false;
      // A 429 met meanwhile by a command (its read) still holds.
      if (this.pauseKind === 'backoff' || this.now() >= this.pausedUntil) {
        this.pauseKind = undefined;
        this.pausedUntil = 0;
      }
      if (hadStop || this.memory.block || this.memory.pause) {
        await this.persist();
      }
      if (read === 0) {
        await this.setStatus(false, T.noneRead(total));
      } else {
        await this.setStatus(true, T.connected(read, total, this.config.invalidMacs));
      }
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      await this.failed(err);
    } finally {
      this.client.setTimeoutMs(undefined);
    }
    await this.publishBadges();
    await this.flush();
    if (generation === this.generation) {
      this.scheduleNext();
    }
  }

  /**
   * Every stove of the configuration, one after the other. An error of one
   * stove (404, 403, 5xx, a timeout, a bad document) marks only that stove;
   * any other error (network, 429, the session) ends the cycle.
   * `transient`: the last 5xx/timeout/other HTTP error, when no stove answered.
   */
  async readAll(generation) {
    let read = 0;
    let forbidden = 0;
    let transient;
    for (const mac of this.config.macs) {
      try {
        const info = await this.client.info(mac);
        if (generation !== this.generation) {
          return { read, forbidden };
        }
        this.unreadable.delete(mac);
        this.ingest(parseStove(mac, info));
        read += 1;
      } catch (err) {
        if (!PER_STOVE.has(err.kind)) {
          throw err;
        }
        if (err.kind === 'forbidden') {
          forbidden += 1;
        }
        if (TRANSIENT.has(err.kind)) {
          transient = err;
        }
        if (!this.unreadable.has(mac)) {
          this.logger.warn(`Edilkamin stove ${short(mac)}: ${errorReason(err)}`);
        }
        this.unreadable.set(mac, err.kind);
      }
    }
    return { read, forbidden, transient: read === 0 ? transient : undefined };
  }

  /** The message of a stop. */
  blockedMessage() {
    const wait = age(Math.max(TIMINGS.rateLimitMin, this.retryAt - this.now()));
    switch (this.blocked) {
      case 'two_factor':
        return T.twoFactor;
      case 'new_password':
        return T.newPassword;
      case 'unsupported_challenge':
        return T.unsupportedChallenge(this.blockDetail);
      case 'session_refused':
        return T.sessionRefused(wait);
      default:
        return T.refused(wait);
    }
  }

  /** A failure: a stop, a pause, or a backoff. Never a dead integration but for a code. */
  async failed(err) {
    const reason = errorReason(err);
    if (err.kind === 'no_credentials') {
      await this.setStatus(false, T.noCredentials);
      return;
    }
    if (NO_AUTO_RETRY.has(err.kind)) {
      // Never signed in again by itself: each sign-in could send a new code,
      // or meet the same unknown step again.
      this.blocked = err.kind;
      this.blockDetail = err.challenge;
      this.retryAt = 0;
      this.logger.warn(`Edilkamin asks for a sign-in step (${err.challenge ?? '?'}): stopped`);
      await this.persist();
      await this.setStatus(false, this.blockedMessage());
      return;
    }
    if (SPACED.has(err.kind)) {
      const wait = TIMINGS.refusedRetry[Math.min(this.retries, TIMINGS.refusedRetry.length - 1)];
      this.retries += 1;
      this.blocked = err.kind;
      this.blockDetail = err.challenge;
      this.retryAt = this.now() + wait;
      this.logger.warn(
        `Edilkamin stopped: ${reason}; one new try in ${Math.round(wait / 60_000)} min`,
      );
      await this.persist();
      await this.setStatus(false, this.blockedMessage());
      return;
    }
    let wait;
    let message;
    if (err.kind === 'rate_limited') {
      wait = this.pause(err);
      message = T.rateLimited(age(wait));
    } else if (err.kind === 'forbidden') {
      wait = this.forbid();
      this.offline = true;
      message = T.forbidden(age(wait));
      if (this.config.macs.length === 1) {
        // One stove only: a wrong MAC address is the likely cause.
        message = join(message, T.checkMac);
      }
    } else {
      // Never read again faster than the poll interval.
      wait = Math.max(
        this.config.pollInterval * 1000,
        TIMINGS.backoff[Math.min(this.failures, TIMINGS.backoff.length - 1)],
      );
      this.pauseKind = 'backoff';
      this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
      this.offline = OFFLINE.has(err.kind) || err.kind === 'unauthorized' || this.offline;
      message = T.unreachable(reasonOf(err), age(wait));
    }
    this.failures += 1;
    await this.persist();
    const connected = err.kind === 'rate_limited' && this.readAt !== undefined;
    await this.setStatus(connected, message);
    this.logger.warn(`Edilkamin: ${reason}; next try in ${Math.round(wait / 1000)} s`);
  }

  /** 429: a pause of Retry-After, between 60 s and 6 h, for every path (kept in /data). */
  pause(err) {
    const asked = err.retryAfter ?? TIMINGS.rateLimitDefault;
    const wait = Math.max(TIMINGS.rateLimitMin, Math.min(TIMINGS.rateLimitMax, asked));
    if (this.pauseKind !== 'rate' || this.now() + wait > this.pausedUntil) {
      // The source of the longest pause: Cognito (renewals wait) or the API (they go on).
      this.pauseSource = err.source === 'cognito' ? 'cognito' : 'api';
    }
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
    this.pauseKind = 'rate';
    return wait;
  }

  /** Every stove refused (403): a 30-minute pause for every path (kept in /data); a 429 pause stays. */
  forbid() {
    const wait = TIMINGS.forbiddenPause;
    if (!(this.pauseKind === 'rate' && this.pausedUntil > this.now() + wait)) {
      this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
      this.pauseKind = 'forbidden';
      this.pauseSource = 'api';
    }
    return wait;
  }

  /**
   * One stove as read: the scene event of a new alarm since the previous read
   * (never on the first one), the guard of a command, its states queued.
   */
  ingest(read, created = this.createdFeatures()) {
    const stove = { ...read, seenAt: this.now() };
    const previous = this.stoves.get(stove.mac);
    // A previous read too old (a pause, an outage) tells no "change": no trigger then.
    const recent =
      previous?.seenAt !== undefined &&
      stove.seenAt - previous.seenAt <= 2 * this.config.pollInterval * 1000;
    const before = previous?.alarms?.count;
    const after = stove.alarms?.count;
    if (recent && before !== undefined && after !== undefined && after > before) {
      this.publisher.pushSceneEvent(SCENE_TRIGGERS.ALARM, {
        stove: deviceName(stove, this.config.language),
        code: stove.alarms.code === undefined ? '' : String(stove.alarms.code),
      });
      this.logger.warn(
        `Edilkamin stove ${short(stove.mac)}: new alarm (${stove.alarms.code ?? '?'})`,
      );
    }
    this.observe(stove);
    this.stoves.set(stove.mac, stove);
    this.queue(stove, created);
    return stove;
  }

  // --- Gladys ----------------------------------------------------------------

  /** The roles of the device already created in Gladys for a stove. */
  createdRoles(mac) {
    const externalId = deviceIds(this.gladys, mac).device;
    const device = (this.gladys.devices ?? []).find((d) => d.external_id === externalId);
    return new Set(
      (device?.features ?? [])
        .map((f) => parseFeatureId(f.external_id)?.role)
        .filter((role) => role !== undefined),
    );
  }

  async publishDevices() {
    if (this.readAt === undefined && this.stoves.size === 0) {
      return;
    }
    const devices = this.config.macs
      .filter((mac) => this.stoves.has(mac))
      .map((mac) =>
        buildDevice(
          this.gladys,
          this.stoves.get(mac),
          this.config.language,
          this.createdRoles(mac),
        ),
      );
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  /** Queues the states of one stove (the features created in Gladys only). */
  queue(stove, created = this.createdFeatures()) {
    const ids = deviceIds(this.gladys, stove.mac);
    for (const { role, ...value } of statesOf(stove, this.config.language)) {
      const id = ids.feature(role);
      if (created.has(id)) {
        this.publisher.push(id, value);
      }
    }
  }

  queueAll(created = this.createdFeatures()) {
    for (const stove of this.stoves.values()) {
      this.queue(stove, created);
    }
  }

  badge(mac) {
    if (this.blocked || this.offline) {
      return { transport: DEVICE_TRANSPORTS.UNREACHABLE };
    }
    if (this.unreadable.has(mac)) {
      return {
        transport: DEVICE_TRANSPORTS.UNREACHABLE,
        degraded: true,
        message: TRANSIENT.has(this.unreadable.get(mac)) ? T.stoveNoAnswer : T.stoveUnreadable,
      };
    }
    return { transport: DEVICE_TRANSPORTS.CLOUD };
  }

  async publishBadges() {
    const created = new Set((this.gladys.devices ?? []).map((d) => d.external_id));
    const entries = [];
    for (const mac of this.config.macs) {
      const externalId = deviceIds(this.gladys, mac).device;
      if (!created.has(externalId)) {
        continue;
      }
      const entry = { external_id: externalId, ...this.badge(mac) };
      const json = JSON.stringify(entry);
      if (this.badges.get(externalId) !== json) {
        entries.push([externalId, json, entry]);
      }
    }
    if (entries.length === 0) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries.map(([, , entry]) => entry));
      for (const [externalId, json] of entries) {
        this.badges.set(externalId, json);
      }
    } catch (err) {
      this.logger.warn(`Transport badges failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): send its last values at once. */
  async deviceCreated(device) {
    this.badges.delete(device?.external_id);
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    this.queueAll(created);
    await this.flush();
    await this.publishBadges();
  }

  async deviceDeleted(device) {
    this.badges.delete(device?.external_id);
    if (device?.external_id) {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: a fresh read if the last one is old enough. */
  async scan() {
    if (
      this.configured &&
      !this.blocked &&
      this.now() >= this.pausedUntil &&
      (this.readAt === undefined || this.now() - this.readAt >= TIMINGS.testCooldown)
    ) {
      await this.tick({ quick: true });
      return;
    }
    await this.publishDevices();
  }

  // --- Commands --------------------------------------------------------------

  refusal(text, cause) {
    return new Refusal(word(text, this.config.language), cause ? { cause } : undefined);
  }

  /**
   * The value of a command, strictly: null, '', ' ', false or [] are never
   * read as a number. Throws a refusal when it is not valid.
   */
  commandValue(role, value) {
    if (role === 'power-on' || role === 'power-off') {
      if (value === GLADYS.PRESSED || value === String(GLADYS.PRESSED)) {
        return GLADYS.PRESSED;
      }
      throw this.refusal(T.denied.badButton);
    }
    const number =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && /^\s*\d+(?:[.,]\d+)?\s*$/.test(value)
          ? Number(value.trim().replace(',', '.'))
          : NaN;
    if (role === 'setpoint') {
      const steps = number / SETPOINT.step;
      if (
        !Number.isFinite(number) ||
        number < SETPOINT.min ||
        number > SETPOINT.max ||
        Math.abs(steps - Math.round(steps)) > 1e-9
      ) {
        throw this.refusal(T.denied.badSetpoint(SETPOINT.min, SETPOINT.max, SETPOINT.step));
      }
      return Math.round(steps) * SETPOINT.step;
    }
    if (!Number.isInteger(number) || number < POWER_LEVEL.min || number > POWER_LEVEL.max) {
      throw this.refusal(T.denied.badPowerLevel(POWER_LEVEL.min, POWER_LEVEL.max));
    }
    return number;
  }

  async setValue(_gladysDevice, feature, value) {
    // The ack deadline counts from the arrival of the command, before any wait.
    const receivedAt = this.now();
    const target = parseFeatureId(feature?.external_id);
    if (!target || !COMMAND_ROLES.includes(target.role)) {
      throw new Error(`${feature?.external_id} cannot be set`);
    }
    const checked = this.commandValue(target.role, value);
    const { mac, role } = target;
    if (role === 'power-off') {
      // Counted at once (synchronously): a lighting queued or reading now sees it.
      this.offCounts.set(mac, (this.offCounts.get(mac) ?? 0) + 1);
      // Turning off never waits behind a lighting or a setpoint of the same stove.
      return this.powerOff(mac, receivedAt);
    }
    if (role === 'power-on') {
      // The turn-off count at the arrival of the lighting, before any wait.
      const offSeen = this.offCounts.get(mac) ?? 0;
      return this.serialized(mac, () => this.powerOn(mac, receivedAt, offSeen));
    }
    return this.serialized(mac, () => this.setParameter(mac, role, checked, receivedAt));
  }

  /** Runs `task` after the previous task of the same key (a promise chain per key). */
  serialized(key, task) {
    const previous = this.commandChains.get(key) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    const tail = run.catch(() => {});
    this.commandChains.set(key, tail);
    tail.then(() => {
      if (this.commandChains.get(key) === tail) {
        this.commandChains.delete(key);
      }
    });
    return run;
  }

  /** Time left before the deadline of a command that arrived at `receivedAt`. */
  remaining(receivedAt) {
    return receivedAt + TIMINGS.commandDeadline - this.now();
  }

  /** A turn off of this stove arrived after `offSeen` was taken. */
  offRequested(mac, offSeen) {
    return (this.offCounts.get(mac) ?? 0) !== offSeen;
  }

  /** The checks every command but turning off shares, before its read. */
  checkCommand(mac, receivedAt, generation) {
    if (!this.client.hasCredentials) {
      throw this.refusal(T.denied.noConfig);
    }
    if (!this.config.macs.includes(mac)) {
      throw this.refusal(T.denied.unknownDevice);
    }
    if (this.blocked) {
      throw this.refusal(T.denied.stopped);
    }
    if (this.hardPaused) {
      throw this.refusal(this.pauseKind === 'forbidden' ? T.denied.forbidden : T.denied.paused);
    }
    if (!this.client.tokenValidFor(TIMINGS.commandTokenValidity)) {
      // A renewal inside the 3.5 s would leave too little time: renewed now, refused.
      // (The renewal timer makes this rare: the token is renewed 5 min before its end.)
      this.client
        .token({ signIn: false, validity: TIMINGS.commandTokenValidity })
        .catch((err) => this.renewFailed(err, generation));
      throw this.refusal(T.denied.session);
    }
    if (this.remaining(receivedAt) <= TIMINGS.minRequestTimeout) {
      throw this.refusal(T.denied.late);
    }
  }

  /**
   * Lighting: behind allow_power_on, on a fresh read showing the stove off,
   * and refused as soon as a turn off of the stove arrived after it (checked
   * before the read, after it, and right before sending).
   */
  async powerOn(mac, receivedAt, offSeen) {
    const generation = this.generation;
    if (!this.config.allowPowerOn) {
      throw this.refusal(T.denied.powerOn);
    }
    if (this.offRequested(mac, offSeen)) {
      throw this.refusal(T.denied.offMeanwhile);
    }
    this.checkCommand(mac, receivedAt, generation);
    // The state just before acting, never the one in memory.
    const stove = await this.readStove(mac, receivedAt);
    if (this.offRequested(mac, offSeen)) {
      throw this.refusal(T.denied.offMeanwhile);
    }
    if (this.guardActive(mac)) {
      // The previous power command may not show yet: never "already on" on it.
      throw this.refusal(T.denied.inProgress);
    }
    if (this.remaining(receivedAt) <= 0) {
      throw this.refusal(T.denied.late);
    }
    if (stove.power === undefined) {
      throw this.refusal(T.denied.unknown);
    }
    if (stove.power === true) {
      return;
    }
    // The options may have changed during the read: checked again right before sending.
    if (generation !== this.generation || this.blocked || !this.config.allowPowerOn) {
      throw this.refusal(this.config.allowPowerOn ? T.denied.stopped : T.denied.powerOn);
    }
    // Synchronous with the start of the request: no turn off can slip in between.
    if (this.offRequested(mac, offSeen)) {
      throw this.refusal(T.denied.offMeanwhile);
    }
    await this.send(mac, COMMANDS.POWER, GLADYS.ON, receivedAt, { guard: true, lighting: true });
    this.logger.info(`Edilkamin stove ${short(mac)}: lighting sent`);
  }

  /**
   * Turning off: always allowed, also during a pause or a stop, and always
   * sent (`power` 0 on a stove already off changes nothing: the cloud answers
   * "Value is already 0"), so it is never answered "already off" while a
   * lighting is queued or on its way. A lighting request in flight is waited
   * for (until the turn off's own deadline), so the turn off arrives after it.
   * An expired token is renewed within the deadline.
   */
  async powerOff(mac, receivedAt) {
    if (!this.client.hasCredentials) {
      throw this.refusal(T.denied.noConfig);
    }
    if (!this.config.macs.includes(mac)) {
      throw this.refusal(T.denied.unknownDevice);
    }
    if (!this.client.tokenValidFor(TIMINGS.offTokenValidity)) {
      await this.refreshWithin(receivedAt);
    }
    const lighting = this.lightings.get(mac);
    if (lighting) {
      const wait = receivedAt + TIMINGS.commandStartBy - TIMINGS.minRequestTimeout - this.now();
      await this.withDeadline(lighting, wait).catch(() => {});
    }
    await this.send(mac, COMMANDS.POWER, GLADYS.OFF, receivedAt, {
      guard: true,
      expected: false,
      renewOn401: true,
    });
    this.logger.info(`Edilkamin stove ${short(mac)}: turning off sent`);
  }

  /**
   * A new token from the refresh token, within the deadline of the command
   * that arrived at `receivedAt` (the Cognito request is bounded by the time
   * left); a refusal when it cannot be had.
   */
  async refreshWithin(receivedAt) {
    const budget = receivedAt + TIMINGS.commandStartBy - TIMINGS.minRequestTimeout - this.now();
    if (!this.client.tokens?.refreshToken || this.cognitoPaused) {
      throw this.refusal(
        this.blocked ? T.denied.stopped : this.cognitoPaused ? T.denied.paused : T.denied.session,
      );
    }
    if (budget < TIMINGS.minRequestTimeout) {
      throw this.refusal(T.denied.late);
    }
    try {
      await this.withDeadline(
        this.client.token({ force: true, signIn: false, timeout: budget }),
        budget,
      );
    } catch (err) {
      if (err.kind === 'rate_limited') {
        this.pause(err);
        await this.persist();
      }
      this.logger.info(`Edilkamin: no new token within the command (${errorReason(err)})`);
      throw this.refusal(T.denied.session, err);
    }
  }

  /** `promise`, or a timeout error after `ms` (the promise itself goes on). */
  withDeadline(promise, ms) {
    let handle;
    const deadline = new Promise((_, reject) => {
      handle = this.timers.setTimeout(
        () => reject(new EdilkaminError('timeout', 'no answer within the command')),
        Math.max(0, ms),
      );
    });
    return Promise.race([promise, deadline]).finally(() => this.timers.clearTimeout(handle));
  }

  /** The setpoint or the power level: behind allow_commands, on a fresh read. */
  async setParameter(mac, role, value, receivedAt) {
    const generation = this.generation;
    if (!this.config.allowCommands) {
      throw this.refusal(T.denied.commands);
    }
    this.checkCommand(mac, receivedAt, generation);
    const stove = await this.readStove(mac, receivedAt);
    if (this.remaining(receivedAt) <= 0) {
      throw this.refusal(T.denied.late);
    }
    const current = role === 'setpoint' ? stove.setpoint : stove.powerLevel;
    if (current === undefined) {
      throw this.refusal(T.denied.unreadable);
    }
    if (current === value) {
      return;
    }
    if (generation !== this.generation || this.blocked || !this.config.allowCommands) {
      throw this.refusal(this.config.allowCommands ? T.denied.stopped : T.denied.commands);
    }
    const name = role === 'setpoint' ? COMMANDS.SETPOINT : COMMANDS.POWER_LEVEL;
    await this.send(mac, name, value, receivedAt, { guard: false });
    this.logger.info(`Edilkamin stove ${short(mac)}: ${role} sent`);
  }

  /**
   * `PUT mqtt/command` within the deadline; a guard and follow-up reads after
   * it. `lighting`: the request is kept while in flight (a turn off waits for
   * it). `renewOn401`: a refused token is renewed within the deadline and the
   * command sent once more (turning off only: it is safe to repeat).
   */
  async send(
    mac,
    name,
    value,
    receivedAt,
    { guard, expected = value === GLADYS.ON, lighting = false, renewOn401 = false },
  ) {
    try {
      const request = this.client.command(mac, name, value, {
        // Sent 3.4 s after the arrival at the latest; answered by 4.6 s after it.
        startBy: receivedAt + TIMINGS.commandStartBy,
        validity: TIMINGS.offTokenValidity,
        timeout: () =>
          Math.max(TIMINGS.minRequestTimeout, receivedAt + TIMINGS.commandAnswerBy - this.now()),
      });
      if (lighting) {
        const settled = request.catch(() => {});
        this.lightings.set(mac, settled);
        settled.then(() => {
          if (this.lightings.get(mac) === settled) {
            this.lightings.delete(mac);
          }
        });
      }
      await request;
    } catch (err) {
      if (err.kind === 'late') {
        throw this.refusal(T.denied.late, err);
      }
      if (err.kind === 'unauthorized') {
        if (renewOn401) {
          await this.refreshWithin(receivedAt);
          return this.send(mac, name, value, receivedAt, { guard, expected });
        }
        // Renewed at once for the next command (never inside this one).
        const generation = this.generation;
        this.client
          .token({ force: true, signIn: false })
          .catch((renewal) => this.renewFailed(renewal, generation));
        throw this.refusal(T.denied.session, err);
      }
      if (err.kind === 'rate_limited') {
        this.pause(err);
        await this.persist();
      }
      if (MAYBE_SENT.has(err.kind)) {
        // The request may have reached Edilkamin: the stove may change anyway.
        if (guard) {
          this.guard(mac, expected);
        }
        this.followUp();
        throw new Error(word(T.maybeSent(reasonOf(err)), this.config.language), {
          cause: err,
        });
      }
      throw new Error(word(T.commandFailed(reasonOf(err)), this.config.language), {
        cause: err,
      });
    }
    if (guard) {
      this.guard(mac, expected);
    }
    this.followUp();
  }

  /** Sets the guard of a stove after a power command. */
  guard(mac, expected) {
    this.guards.set(mac, {
      expected,
      sentAt: this.now(),
      until: this.now() + TIMINGS.powerGuard,
    });
  }

  guardActive(mac) {
    const guard = this.guards.get(mac);
    if (guard && this.now() >= guard.until) {
      this.guards.delete(mac);
      return false;
    }
    return Boolean(guard);
  }

  /**
   * A stove as read, through its guard: the guard ends, besides its expiry,
   * when a read at least 4 s after the command shows the expected state.
   * Never on an unknown state.
   */
  observe(stove) {
    if (!this.guardActive(stove.mac)) {
      return;
    }
    const guard = this.guards.get(stove.mac);
    if (this.now() - guard.sentAt >= TIMINGS.guardMinAge && stove.power === guard.expected) {
      this.guards.delete(stove.mac);
    }
  }

  /**
   * GET device/{mac}/info within the command deadline (3 s at most); a
   * refusal on any failure.
   */
  async readStove(mac, receivedAt) {
    const budget = TIMINGS.commandReadTimeout;
    let info;
    try {
      info = await this.client.info(mac, {
        retry: false,
        signIn: false,
        validity: TIMINGS.offTokenValidity,
        startBy: receivedAt + TIMINGS.commandDeadline - TIMINGS.minRequestTimeout,
        timeout: () =>
          Math.max(TIMINGS.minRequestTimeout, Math.min(budget, this.remaining(receivedAt))),
      });
    } catch (err) {
      if (err.kind === 'late') {
        throw this.refusal(T.denied.late, err);
      }
      if (err.kind === 'rate_limited') {
        this.pause(err);
        await this.persist();
      }
      this.logger.info(
        `Edilkamin stove ${short(mac)}: no state before the command (${errorReason(err)})`,
      );
      throw this.refusal(T.denied.unreadable, err);
    }
    const stove = this.ingest(parseStove(mac, info));
    this.unreadable.delete(mac);
    this.flush();
    return stove;
  }

  /** A few reads after a command, to show its effect. */
  followUp() {
    const generation = this.generation;
    for (const delay of TIMINGS.followUps) {
      const handle = this.timers.setTimeout(() => {
        this.followUpTimers.delete(handle);
        if (generation === this.generation) {
          this.tick().catch((err) => this.logger.warn(`Edilkamin refresh failed: ${err.message}`));
        }
      }, delay);
      this.followUpTimers.add(handle);
    }
  }

  // --- Configuration button --------------------------------------------------

  /** A 429 or 403 pause holds for every path, the button included. */
  pauseMessage() {
    const left = this.pausedUntil - this.now();
    if (left <= 0) {
      return undefined;
    }
    if (this.pauseKind === 'rate') {
      return T.rateLimited(age(left));
    }
    return this.pauseKind === 'forbidden' ? T.forbidden(age(left)) : undefined;
  }

  async testConnection() {
    if (!this.client.hasCredentials) {
      return T.noCredentials;
    }
    if (this.config.macs.length === 0) {
      return T.noStoves;
    }
    const paused = this.pauseMessage();
    if (paused) {
      return paused;
    }
    // At most one read (and one sign-in) per 30 s from this button.
    if (this.now() - this.lastTestAt < TIMINGS.testCooldown) {
      const last = this.lastMessage;
      return last ? join(T.test.cooldown, last) : T.test.cooldown;
    }
    if (this.running) {
      return T.busy;
    }
    this.lastTestAt = this.now();
    // The button is how a stopped account is retried at once.
    this.blocked = undefined;
    this.blockDetail = undefined;
    this.retryAt = 0;
    this.pausedUntil = 0;
    this.pauseKind = undefined;
    await this.tick({ quick: true });
    return this.lastMessage ?? T.noCredentials;
  }
}
