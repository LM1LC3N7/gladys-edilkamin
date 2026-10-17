// -----------------------------------------------------------------------------
// A fake AWS Cognito and a fake Edilkamin API behind the transport the
// integration is given (no network). The Cognito side runs the server half of
// SRP: it checks the password proof for real (v = g^x, S = (A v^u)^b), so a
// wrong SRP computation fails here. Refresh tokens; stoves that change on
// `PUT mqtt/command`. Records every request.
// -----------------------------------------------------------------------------

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { COGNITO } from '../../src/constants.js';
import { EdilkaminError } from '../../src/http.js';
import { G, K, N, hexHash, modPow, padHex, poolName, toHex } from '../../src/srp.js';
import { HOUR, PASSWORD, USERNAME, USER_ID, stoveDocument, stoves } from '../fixtures/edilkamin.js';

export const COGNITO_URL = 'https://cognito.test/';
export const API_URL = 'https://api.test';

const json = (status, body, headers = {}) => ({
  status,
  headers,
  body: body === undefined ? '' : JSON.stringify(body),
});
const cognitoError = (type, message, status = 400) => json(status, { __type: type, message });

const big = (hex) => BigInt(`0x${hex}`);

function hkdf(ikm, salt) {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  const info = Buffer.concat([Buffer.from('Caldera Derived Key', 'utf8'), Buffer.from([1])]);
  return createHmac('sha256', prk).update(info).digest().subarray(0, 16);
}

const jwt = (claims) =>
  `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

export function fakeEdilkamin({ lifetime = HOUR, challenge } = {}) {
  const server = {
    username: USERNAME,
    password: PASSWORD,
    lifetime,
    /** A Cognito challenge after the password proof (e.g. 'SMS_MFA'), or none. */
    challenge,
    stoves: stoves(),
    requests: [],
    /** Live id tokens -> expiry; refresh tokens. */
    ids: new Map(),
    refresh: new Set(),
    srp: new Map(),
    /** Every token ever made, to check none reaches the logs. */
    secrets: [],
    down: false,
    /** One-shot answers: { match(request), status, body, headers, before(), throws } */
    queue: [],
    of(path) {
      return this.requests.filter((r) => r.target === path || r.path === path);
    },
    srpStarts() {
      return this.requests.filter((r) => r.flow === 'USER_SRP_AUTH');
    },
    refreshes() {
      return this.requests.filter((r) => r.flow === 'REFRESH_TOKEN_AUTH');
    },
    api() {
      return this.requests.filter((r) => r.host === 'api.test');
    },
    commands() {
      return this.requests.filter((r) => r.method === 'PUT').map((r) => r.body);
    },
    reads(mac) {
      return this.requests.filter((r) => r.path === `/device/${mac}/info`);
    },
    issue() {
      const exp = Math.floor((Date.now() + this.lifetime) / 1000);
      const id = jwt({ sub: USER_ID, email: USERNAME, exp, n: this.secrets.length });
      const refresh = `refresh-${randomBytes(8).toString('hex')}`;
      this.ids.set(id, exp * 1000);
      this.refresh.add(refresh);
      this.secrets.push(id, refresh);
      return { id, refresh };
    },
    /** Refuse every token issued so far (revoked on the server side). */
    revoke() {
      this.ids.clear();
      this.refresh.clear();
    },
  };

  const result = ({ id, refresh }, withRefresh = true) => {
    const access = jwt({ sub: USER_ID, kind: 'access' });
    server.secrets.push(access);
    return {
      AuthenticationResult: {
        AccessToken: access,
        IdToken: id,
        ...(withRefresh ? { RefreshToken: refresh } : {}),
        ExpiresIn: Math.round(server.lifetime / 1000),
        TokenType: 'Bearer',
      },
      ChallengeParameters: {},
    };
  };

  function cognito(request) {
    const body = request.body ?? {};
    const target = request.target;
    if (body.ClientId !== COGNITO.clientId) {
      return cognitoError('ResourceNotFoundException', 'User pool client does not exist.');
    }
    if (target === 'InitiateAuth' && body.AuthFlow === 'USER_SRP_AUTH') {
      const { USERNAME: name, SRP_A, SECRET_HASH } = body.AuthParameters ?? {};
      if (SECRET_HASH !== undefined) {
        return cognitoError('NotAuthorizedException', 'Client has no secret');
      }
      if (name !== server.username) {
        return cognitoError('UserNotFoundException', 'User does not exist.');
      }
      const salt = randomBytes(16).toString('hex');
      const b = big(randomBytes(64).toString('hex'));
      const identity = createHash('sha256')
        .update(`${poolName(COGNITO.poolId)}${USER_ID}:${server.password}`, 'utf8')
        .digest('hex');
      const x = big(hexHash(padHex(salt) + identity));
      const v = modPow(G, x, N);
      const B = (K * v + modPow(G, b, N)) % N;
      const secretBlock = randomBytes(24).toString('base64');
      server.srp.set(secretBlock, { A: big(SRP_A), B, b, v });
      return json(200, {
        ChallengeName: 'PASSWORD_VERIFIER',
        ChallengeParameters: {
          SALT: salt,
          SECRET_BLOCK: secretBlock,
          SRP_B: toHex(B),
          USERNAME: USER_ID,
          USER_ID_FOR_SRP: USER_ID,
        },
      });
    }
    if (target === 'RespondToAuthChallenge' && body.ChallengeName === 'PASSWORD_VERIFIER') {
      const r = body.ChallengeResponses ?? {};
      const state = server.srp.get(r.PASSWORD_CLAIM_SECRET_BLOCK);
      server.srp.delete(r.PASSWORD_CLAIM_SECRET_BLOCK);
      if (!state || r.USERNAME !== USER_ID) {
        return cognitoError('NotAuthorizedException', 'Incorrect username or password.');
      }
      const u = big(hexHash(padHex(state.A) + padHex(state.B)));
      const S = modPow(state.A * modPow(state.v, u, N), state.b, N);
      const key = hkdf(Buffer.from(padHex(S), 'hex'), Buffer.from(padHex(toHex(u)), 'hex'));
      const expected = createHmac('sha256', key)
        .update(
          Buffer.concat([
            Buffer.from(poolName(COGNITO.poolId), 'utf8'),
            Buffer.from(USER_ID, 'utf8'),
            Buffer.from(r.PASSWORD_CLAIM_SECRET_BLOCK, 'base64'),
            Buffer.from(r.TIMESTAMP ?? '', 'utf8'),
          ]),
        )
        .digest('base64');
      server.lastTimestamp = r.TIMESTAMP;
      if (expected !== r.PASSWORD_CLAIM_SIGNATURE) {
        return cognitoError('NotAuthorizedException', 'Incorrect username or password.');
      }
      if (server.challenge) {
        const session = `session-${randomBytes(8).toString('hex')}`;
        server.secrets.push(session);
        return json(200, {
          ChallengeName: server.challenge,
          Session: session,
          ChallengeParameters: {},
        });
      }
      return json(200, result(server.issue()));
    }
    if (target === 'InitiateAuth' && body.AuthFlow === 'REFRESH_TOKEN_AUTH') {
      const { REFRESH_TOKEN } = body.AuthParameters ?? {};
      if (!server.refresh.has(REFRESH_TOKEN)) {
        return cognitoError('NotAuthorizedException', 'Refresh Token has expired');
      }
      const issued = server.issue();
      server.refresh.delete(issued.refresh);
      return json(200, result(issued, false));
    }
    return cognitoError('InvalidParameterException', 'unexpected request');
  }

  function api(request) {
    const token = String(request.headers.Authorization ?? '').replace(/^Bearer /, '');
    const exp = server.ids.get(token);
    if (exp === undefined || Date.now() >= exp) {
      return json(401, { message: 'Unauthorized' });
    }
    let match;
    if (
      request.method === 'GET' &&
      (match = /^\/device\/([0-9a-f]{12})\/info$/.exec(request.path))
    ) {
      const stove = server.stoves[match[1]];
      if (!stove) {
        return json(404, { message: 'Not found' });
      }
      return json(200, stoveDocument(match[1], stove));
    }
    if (request.method === 'PUT' && request.path === '/mqtt/command') {
      const { mac_address: mac, name, value } = request.body ?? {};
      const stove = server.stoves[mac];
      if (!stove) {
        return json(404, { message: 'Not found' });
      }
      if (name === 'power' && (value === 0 || value === 1)) {
        if (stove.power === value) {
          return json(200, `Value is already ${value}`);
        }
        stove.power = value;
      } else if (name === 'enviroment_1_temperature' && typeof value === 'number') {
        stove.setpoint = value;
      } else if (name === 'power_level' && Number.isInteger(value)) {
        stove.manualPower = value;
      } else {
        return json(400, { message: 'Bad request' });
      }
      return json(200, 'Command 0123456789abcdef executed successfully');
    }
    return json(404, { message: 'Not found' });
  }

  server.transport = async (url, { method = 'GET', headers = {}, body, timeout } = {}) => {
    const target = new URL(url);
    const parsed = body === undefined ? undefined : JSON.parse(body);
    const request = {
      method,
      host: target.host,
      path: target.pathname,
      headers,
      body: parsed,
      timeout,
      target: headers['X-Amz-Target']?.replace('AWSCognitoIdentityProviderService.', ''),
      flow: parsed?.AuthFlow,
    };
    server.requests.push(request);
    const forced = server.queue.findIndex((q) => q.match(request));
    if (forced >= 0) {
      const [entry] = server.queue.splice(forced, 1);
      await entry.before?.();
      if (entry.throws) {
        throw entry.throws;
      }
      if (entry.status) {
        return json(entry.status, entry.body, entry.headers);
      }
    }
    if (server.down) {
      throw new EdilkaminError('network', 'connection refused');
    }
    if (target.host === 'cognito.test') {
      return cognito(request);
    }
    if (target.host === 'api.test') {
      return api(request);
    }
    return json(404, {});
  };

  return server;
}

/** An in-memory store, in place of the /data file. */
export function memoryStore(initial = null) {
  return {
    data: initial,
    saves: 0,
    async load() {
      return this.data === null ? null : structuredClone(this.data);
    },
    async save(data) {
      this.saves += 1;
      this.data = structuredClone(data);
    },
  };
}

/** Lets the pending promises settle (no timer involved). */
export const settle = async (rounds = 30) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};
