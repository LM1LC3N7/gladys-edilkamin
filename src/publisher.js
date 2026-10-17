// -----------------------------------------------------------------------------
// What goes to Gladys, within its limits: 300 states and 300 scene events per
// minute.
//
// - push(): the current value of a feature. The last one wins; unchanged
//   values are skipped by publishChangedStates and sent again every 30 min.
// - pushSceneEvent(): a scene trigger, queued and all sent, never merged.
// Everything left over (budget spent, Gladys unreachable) waits for the next
// flush, every second.
// -----------------------------------------------------------------------------

import { LIMITS, MINUTE, TIMINGS } from './constants.js';

/** Gladys refused the event itself (undeclared key, invalid data): retrying will not help. */
const refusedForGood = (err) =>
  (err?.status !== undefined && err.status !== 429 && err.status < 500) ||
  /^publishSceneEvent:/.test(String(err?.message));

export class StatePublisher {
  constructor({ gladys, logger, now = Date.now, timers = globalThis }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    /** featureId -> { state } | { text } */
    this.pending = new Map();
    /** Scene events, in order: { key, data }. */
    this.sceneEvents = [];
    this.stateWindow = [];
    this.sceneWindow = [];
    this.timer = undefined;
    this.flushing = undefined;
  }

  start() {
    this.stop();
    this.timer = this.timers.setInterval(() => {
      this.flush().catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
    }, TIMINGS.flushInterval);
  }

  stop() {
    if (this.timer) {
      this.timers.clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  push(featureId, value) {
    this.pending.set(featureId, value);
  }

  pushSceneEvent(key, data) {
    this.sceneEvents.push({ key, data });
    if (this.sceneEvents.length > LIMITS.queuedEvents) {
      this.sceneEvents.shift();
    }
  }

  /** Forgets what is pending for a deleted device and its features. */
  forget(deviceId) {
    for (const id of [...this.pending.keys()]) {
      if (id === deviceId || id.startsWith(`${deviceId}:`)) {
        this.pending.delete(id);
      }
    }
  }

  /**
   * One flush at a time. A flush asked during another one runs right after
   * it (a command's "moving" state must not wait for the next second); it
   * resolves with that second flush.
   */
  flush() {
    if (this.flushing) {
      this.again ??= this.flushing
        .catch(() => {})
        .then(() => {
          this.again = undefined;
          return this.flush();
        });
      return this.again;
    }
    this.flushing = this.doFlush().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  async doFlush() {
    await this.flushSceneEvents();
    await this.flushStates();
  }

  async flushSceneEvents() {
    const now = this.now();
    this.sceneWindow = this.sceneWindow.filter((t) => now - t < MINUTE);
    while (this.sceneEvents.length > 0 && this.sceneWindow.length < LIMITS.sceneEventsPerMinute) {
      const { key, data } = this.sceneEvents[0];
      try {
        await this.gladys.publishSceneEvent(key, data);
      } catch (err) {
        if (!refusedForGood(err)) {
          throw err;
        }
        this.logger.warn(`Gladys refused the scene event ${key}: ${err.message}`);
      }
      this.sceneEvents.shift();
      this.sceneWindow.push(now);
    }
  }

  async flushStates() {
    const now = this.now();
    this.stateWindow = this.stateWindow.filter((t) => now - t < MINUTE);
    const room = Math.min(
      LIMITS.statesPerMinute - this.stateWindow.length,
      LIMITS.statesPerRequest,
    );
    if (room <= 0 || this.pending.size === 0) {
      return;
    }
    const batch = [];
    for (const [featureId, value] of this.pending) {
      if (batch.length >= room) {
        break;
      }
      this.pending.delete(featureId);
      batch.push({ device_feature_external_id: featureId, ...value });
    }
    try {
      const result = await this.gladys.publishChangedStates(batch, {
        heartbeat: TIMINGS.stateHeartbeat,
      });
      for (let i = 0; i < (result?.count ?? batch.length); i += 1) {
        this.stateWindow.push(now);
      }
    } catch (err) {
      // Kept for the next round, unless a newer value arrived meanwhile.
      for (const { device_feature_external_id: id, ...value } of batch) {
        if (!this.pending.has(id)) {
          this.pending.set(id, value);
        }
      }
      throw err;
    }
  }
}
