// -----------------------------------------------------------------------------
// The only network access: HTTPS requests to AWS Cognito and to the Edilkamin
// API, and the errors they end with. The body read is bounded; the messages
// never hold a secret (no password, token, user name or MAC address).
// -----------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';
import { LIMITS, TIMINGS } from './constants.js';

/**
 * A failed call. `kind`:
 * - `no_credentials`: no user name or password (never sent);
 * - `refused`: Cognito refused the user name or the password (or the
 *   account: not confirmed, password reset required…);
 * - `two_factor`: Cognito asks for a verification code (not handled: a stop);
 * - `new_password`: Cognito asks for a new password (done in the app);
 * - `unsupported_challenge`: another Cognito challenge (`challenge`);
 * - `refresh_refused`: the refresh token is no longer valid (sign in again);
 * - `unauthorized`: the API refused the token (401);
 * - `session_refused`: refused again right after a new token;
 * - `forbidden`: a 403 of the API;
 * - `rate_limited`: 429 or Cognito TooManyRequests, `retryAfter` in ms when given;
 * - `unavailable`: 5xx;
 * - `network`, `timeout`: no answer; `late`: not sent, the command deadline passed;
 * - `bad_response`, `size`: not the expected JSON;
 * - `not_found`: 404 (a MAC address unknown to the cloud);
 * - `http`: any other status.
 */
export class EdilkaminError extends Error {
  constructor(kind, message, { status, retryAfter, code, challenge } = {}) {
    super(message);
    this.name = 'EdilkaminError';
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
    this.code = code;
    this.challenge = challenge;
  }
}

const NETWORK_REASONS = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  ENOTFOUND: 'unknown host name',
  EAI_AGAIN: 'host name not resolved',
  ETIMEDOUT: 'connection timed out',
  EPIPE: 'connection closed',
};

/** A socket error -> EdilkaminError (never the request: a sign-in carries the claim). */
export function networkError(err) {
  if (err instanceof EdilkaminError) {
    return err;
  }
  const code = typeof err?.code === 'string' && /^[A-Z_]{1,32}$/.test(err.code) ? err.code : '';
  return new EdilkaminError('network', NETWORK_REASONS[code] ?? (code || 'network error'));
}

/** A short, secret-free reason for a log or a status message. */
export function errorReason(err) {
  if (err instanceof EdilkaminError) {
    const details = [err.code, err.status ? `HTTP ${err.status}` : undefined].filter(Boolean);
    return details.length > 0 ? `${err.message} (${details.join(', ')})` : err.message;
  }
  return 'internal error';
}

/**
 * One request; resolves `{ status, headers, body }` whatever the status. The
 * promise settles once; the body read is bounded.
 */
export function httpRequest(
  url,
  {
    method = 'GET',
    headers = {},
    body,
    timeout = TIMINGS.requestTimeout,
    maxBytes = LIMITS.responseBytes,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    let timer;
    let settled = false;
    const settle = (fn, value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn(value);
      }
    };
    const req = lib.request(target, { method, headers }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          settle(reject, new EdilkaminError('size', 'answer too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () =>
        settle(resolve, {
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      res.on('error', (err) => settle(reject, networkError(err)));
    });
    timer = setTimeout(() => {
      settle(
        reject,
        new EdilkaminError('timeout', `no answer within ${Math.round(timeout / 1000)} s`),
      );
      req.destroy();
    }, timeout);
    req.on('error', (err) => settle(reject, networkError(err)));
    req.end(body);
  });
}

/** Retry-After (seconds or an HTTP date) -> milliseconds, undefined when absent. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** The JSON of a body; `undefined` for an empty body. */
export function parseJson(body) {
  if (body === undefined || body === null || String(body).trim() === '') {
    return undefined;
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new EdilkaminError('bad_response', 'the answer is not JSON');
  }
}
