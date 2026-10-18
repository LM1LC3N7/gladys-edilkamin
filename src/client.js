// -----------------------------------------------------------------------------
// The Edilkamin account: the Cognito tokens (src/cognito.js), renewed from the
// refresh token before they expire (never a new sign-in at each cycle), and
// the two calls of the Edilkamin API the integration needs (edilkamin.py
// api.py): the document of one stove (`GET device/{mac}/info`) and a command
// (`PUT mqtt/command`).
// -----------------------------------------------------------------------------

import { CognitoClient } from './cognito.js';
import { API, TIMINGS } from './constants.js';
import { processResponse } from './edilkamin.js';
import { EdilkaminError, httpRequest, parseJson, parseRetryAfter } from './http.js';

/** The error of an Edilkamin API answer, or undefined when it is a success. */
export function apiError({ status, headers = {} }, now) {
  if (status >= 200 && status < 300) {
    return undefined;
  }
  if (status === 401) {
    return new EdilkaminError('unauthorized', 'token refused', { status });
  }
  if (status === 429) {
    return new EdilkaminError('rate_limited', 'too many requests', {
      status,
      retryAfter: parseRetryAfter(headers['retry-after'], now),
    });
  }
  if (status === 403) {
    return new EdilkaminError('forbidden', 'request refused', { status });
  }
  if (status === 404) {
    return new EdilkaminError('not_found', 'not found', { status });
  }
  if (status >= 500) {
    return new EdilkaminError('unavailable', 'Edilkamin is unavailable', { status });
  }
  return new EdilkaminError('http', 'request failed', { status });
}

/** A MAC address as the API wants it (edilkamin.py `format_mac`): 12 hex digits, lower case. */
export const MAC = /^[0-9a-f]{12}$/;

export class EdilkaminClient {
  constructor({
    transport = httpRequest,
    now = Date.now,
    random,
    cognitoUrl,
    apiUrl = API.url,
    onChange,
  } = {}) {
    this.transport = transport;
    this.now = now;
    this.apiUrl = apiUrl;
    this.cognito = new CognitoClient({ transport, now, random, url: cognitoUrl });
    /** Called after the tokens changed (persist them; never throws). */
    this.onChange = onChange;
    this.username = '';
    this.password = '';
    /** { idToken, refreshToken, expiresAt } | null */
    this.tokens = null;
    this.renewing = undefined;
    /** One new sign-in or forced renewal per cycle at most (beginCycle resets it). */
    this.renewedThisCycle = false;
    this.signedInThisCycle = false;
    /** Per-request timeout; undefined = TIMINGS.requestTimeout (shorter for the buttons). */
    this.timeout = undefined;
  }

  configure({ username, password, tokens = null }) {
    this.username = username;
    this.password = password;
    this.tokens = tokens?.idToken || tokens?.refreshToken ? tokens : null;
    this.beginCycle();
  }

  get hasCredentials() {
    return this.username !== '' && this.password !== '';
  }

  beginCycle() {
    this.renewedThisCycle = false;
    this.signedInThisCycle = false;
  }

  async changed() {
    try {
      await this.onChange?.();
    } catch {
      // Persisting is best effort: the tokens still work in memory.
    }
  }

  /** A shorter timeout for the buttons (undefined: the default again). */
  setTimeoutMs(value) {
    this.timeout = value;
    this.cognito.timeout = value;
  }

  /** The token is valid for `ms` more. */
  tokenValidFor(ms) {
    return Boolean(this.tokens?.idToken) && this.tokens.expiresAt - ms > this.now();
  }

  /** When the token should be renewed (its expiry minus the margin), or undefined. */
  get renewAt() {
    return this.tokens?.idToken && this.tokens.refreshToken
      ? this.tokens.expiresAt - TIMINGS.tokenMargin
      : undefined;
  }

  /** A full sign-in with the password. */
  async signIn() {
    if (!this.hasCredentials) {
      throw new EdilkaminError('no_credentials', 'no user name or password');
    }
    const { username } = this;
    const tokens = await this.cognito.signIn(username, this.password);
    if (this.username !== username) {
      throw new EdilkaminError('network', 'the account changed during the sign-in');
    }
    this.tokens = tokens;
    await this.changed();
    return tokens;
  }

  /**
   * A valid token: the current one, else renewed from the refresh token,
   * else (once per cycle) a new sign-in. One renewal at a time. `timeout`:
   * the Cognito request of a renewal started here (a command's deadline).
   */
  token({ force = false, signIn = true, validity = TIMINGS.tokenMargin, timeout } = {}) {
    if (!force && this.tokenValidFor(validity)) {
      return Promise.resolve(this.tokens.idToken);
    }
    if (!this.renewing) {
      this.renewing = this.renew({ signIn, timeout }).finally(() => {
        this.renewing = undefined;
      });
    }
    return this.renewing;
  }

  async renew({ signIn, timeout }) {
    if (this.tokens?.refreshToken) {
      const before = this.tokens;
      try {
        const tokens = await this.cognito.refresh(before, { timeout });
        if (this.tokens === before) {
          this.tokens = tokens;
          await this.changed();
        }
        if (!this.tokens?.idToken) {
          // The account changed (or was emptied) during the renewal.
          throw new EdilkaminError('network', 'the account changed during the renewal');
        }
        return this.tokens.idToken;
      } catch (err) {
        if (err.kind !== 'refresh_refused') {
          throw err;
        }
        // Never renewed again with a refused refresh token: the password signs in.
        if (this.tokens === before) {
          this.tokens = null;
          await this.changed();
        }
      }
    }
    if (!signIn) {
      throw new EdilkaminError('unauthorized', 'no valid token');
    }
    if (this.signedInThisCycle) {
      throw new EdilkaminError('session_refused', 'the session was refused after a new sign-in');
    }
    this.signedInThisCycle = true;
    const tokens = await this.signIn();
    return tokens.idToken;
  }

  /** One request to the Edilkamin API with a given token. */
  async send(method, path, token, { payload, timeout, startBy } = {}) {
    if (startBy !== undefined && this.now() > startBy) {
      throw new EdilkaminError('late', 'the command deadline passed');
    }
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': API.userAgent,
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const answer = await this.transport(`${this.apiUrl}/${path}`, {
      method,
      headers,
      body,
      timeout:
        (typeof timeout === 'function' ? timeout() : timeout) ??
        this.timeout ??
        TIMINGS.requestTimeout,
    });
    const error = apiError(answer, this.now());
    if (error) {
      throw error;
    }
    return parseJson(answer.body);
  }

  /**
   * An authenticated call. A refused token is renewed once (refresh token
   * first) and the call tried once more; refused again it is
   * `session_refused` and the caller stops. `retry: false` (commands): a
   * refused token is never retried, the command is refused.
   */
  async call(method, path, { retry = true, signIn = true, validity, ...options } = {}) {
    const token = await this.token({ signIn, validity });
    try {
      return await this.send(method, path, token, options);
    } catch (err) {
      if (err.kind !== 'unauthorized' || !retry) {
        if (err.kind === 'unauthorized' && this.tokens?.idToken === token) {
          // The next call renews it first.
          this.tokens = { ...this.tokens, expiresAt: 0 };
        }
        throw err;
      }
      if (this.renewedThisCycle) {
        throw new EdilkaminError('session_refused', 'the token was refused again', {
          status: err.status,
        });
      }
    }
    this.renewedThisCycle = true;
    const renewed = await this.token({ force: true, signIn });
    try {
      return await this.send(method, path, renewed, options);
    } catch (err) {
      if (err.kind === 'unauthorized') {
        throw new EdilkaminError('session_refused', 'the token was refused again', {
          status: err.status,
        });
      }
      throw err;
    }
  }

  /**
   * The document of one stove (`GET device/{mac}/info`), its gzip Buffer
   * fields inflated. `options`: the command path (no retry, no sign-in, a
   * deadline).
   */
  async info(mac, options = {}) {
    if (!MAC.test(mac)) {
      throw new EdilkaminError('not_found', 'not a MAC address');
    }
    const data = await this.call('GET', `device/${mac}/info`, options);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new EdilkaminError('bad_response', 'Edilkamin sent no stove document');
    }
    return processResponse(data);
  }

  /** A command to one stove: `PUT mqtt/command` `{ mac_address, name, value }`. */
  async command(mac, name, value, options = {}) {
    if (!MAC.test(mac)) {
      throw new EdilkaminError('not_found', 'not a MAC address');
    }
    return this.call('PUT', 'mqtt/command', {
      retry: false,
      signIn: false,
      payload: { mac_address: mac, name, value },
      ...options,
    });
  }
}
