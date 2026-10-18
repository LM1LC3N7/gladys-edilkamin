// -----------------------------------------------------------------------------
// The sign-in to the Edilkamin account through AWS Cognito, as edilkamin.py
// does with pycognito: USER_SRP_AUTH then PASSWORD_VERIFIER (src/srp.js),
// then REFRESH_TOKEN_AUTH to renew the tokens without the password. The
// bearer of the "new" Edilkamin API is the **id token** (edilkamin.py
// `sign_in`, `use_legacy_api=False`). Plain JSON calls to the public Cognito
// endpoint: no AWS signature, and the app client has no secret.
// -----------------------------------------------------------------------------

import { COGNITO, TIMINGS } from './constants.js';
import { EdilkaminError, httpRequest, parseJson, parseRetryAfter } from './http.js';
import { newEphemeral, passwordClaim } from './srp.js';

/** Cognito errors meaning the user name, the password or the account itself. */
const REFUSED = new Set([
  'NotAuthorizedException',
  'InvalidPasswordException',
  'PasswordResetRequiredException',
  'UserNotFoundException',
  'UserNotConfirmedException',
]);
const RATE = new Set(['TooManyRequestsException', 'LimitExceededException']);

/** Verification code challenges: never answered here (each sign-in would send a code). */
export const CODE_CHALLENGES = ['SMS_MFA', 'SOFTWARE_TOKEN_MFA', 'EMAIL_OTP', 'SELECT_MFA_TYPE'];

/** The `__type` of a Cognito error answer, without its namespace: a short identifier only. */
export function cognitoCode(json) {
  const raw = json && typeof json === 'object' ? (json.__type ?? json.code) : undefined;
  const code = typeof raw === 'string' ? raw.split('#').pop() : undefined;
  return code && /^[A-Za-z]{1,64}$/.test(code) ? code : undefined;
}

const decodeClaims = (token) => {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1] ?? '', 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
};

export class CognitoClient {
  constructor({ transport = httpRequest, now = Date.now, random, url = COGNITO.url } = {}) {
    this.transport = transport;
    this.now = now;
    this.random = random;
    this.url = url;
    /** Per-request timeout; undefined = TIMINGS.requestTimeout. */
    this.timeout = undefined;
  }

  /**
   * One Cognito call; rejects an EdilkaminError of the `kind` the caller
   * chose for refusals, marked `source: 'cognito'` (a 429 of Cognito pauses
   * the renewals, one of the Edilkamin API does not). `timeout`: this call only.
   */
  async call(target, payload, options = {}) {
    try {
      return await this.request(target, payload, options);
    } catch (err) {
      if (err instanceof EdilkaminError) {
        err.source = 'cognito';
      }
      throw err;
    }
  }

  async request(target, payload, { refusal = 'refused', timeout } = {}) {
    const body = JSON.stringify(payload);
    const answer = await this.transport(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}`,
        'Content-Length': Buffer.byteLength(body),
      },
      body,
      timeout: timeout ?? this.timeout ?? TIMINGS.requestTimeout,
    });
    let json;
    try {
      json = parseJson(answer.body);
    } catch (err) {
      if (answer.status >= 200 && answer.status < 300) {
        throw err;
      }
    }
    if (answer.status >= 200 && answer.status < 300) {
      if (!json || typeof json !== 'object') {
        throw new EdilkaminError('bad_response', 'Cognito sent no answer');
      }
      return json;
    }
    const code = cognitoCode(json);
    const status = answer.status;
    if (RATE.has(code) || status === 429) {
      throw new EdilkaminError('rate_limited', 'too many sign-in requests', {
        status,
        code,
        retryAfter: parseRetryAfter(answer.headers?.['retry-after'], this.now()),
      });
    }
    if (code === 'TooManyFailedAttemptsException') {
      throw new EdilkaminError('rate_limited', 'too many failed attempts', {
        status,
        code,
        retryAfter: TIMINGS.refusedRetry[0],
      });
    }
    if (REFUSED.has(code)) {
      throw new EdilkaminError(refusal, 'refused by Cognito', { status, code });
    }
    if (status >= 500 || code === 'InternalErrorException') {
      throw new EdilkaminError('unavailable', 'Cognito is unavailable', { status, code });
    }
    throw new EdilkaminError('http', 'Cognito request failed', { status, code });
  }

  /** The tokens of an AuthenticationResult; `previousRefresh`: kept on a refresh. */
  tokensOf(result, previousRefresh) {
    const idToken = result?.IdToken;
    if (typeof idToken !== 'string' || idToken === '') {
      throw new EdilkaminError('bad_response', 'Cognito sent no id token');
    }
    const refreshToken =
      typeof result.RefreshToken === 'string' && result.RefreshToken !== ''
        ? result.RefreshToken
        : previousRefresh;
    const seconds = Number(result.ExpiresIn);
    const exp = Number(decodeClaims(idToken)?.exp);
    // ExpiresIn counts from now on our own clock (a host clock ahead or behind
    // does not matter); the `exp` of the JWT only when Cognito gives no ExpiresIn.
    const expiresAt =
      Number.isFinite(seconds) && seconds > 0
        ? this.now() + seconds * 1000
        : Number.isFinite(exp) && exp > 0
          ? exp * 1000
          : this.now() + TIMINGS.tokenLifetime;
    return { idToken, refreshToken, expiresAt };
  }

  /** A full sign-in with the password; resolves the tokens. */
  async signIn(username, password) {
    const ephemeral = newEphemeral(this.random);
    const start = await this.call('InitiateAuth', {
      AuthFlow: 'USER_SRP_AUTH',
      ClientId: COGNITO.clientId,
      AuthParameters: { USERNAME: username, SRP_A: ephemeral.srpA },
    });
    if (start.AuthenticationResult) {
      return this.tokensOf(start.AuthenticationResult);
    }
    if (typeof start.ChallengeName === 'string' && start.ChallengeName !== 'PASSWORD_VERIFIER') {
      // Another first step (custom challenge, MFA…): a stop, never a loop.
      return this.unexpectedChallenge(start.ChallengeName);
    }
    if (!start.ChallengeParameters) {
      throw new EdilkaminError('bad_response', 'Cognito did not ask for the password proof');
    }
    const challenge = start.ChallengeParameters;
    const userId = String(challenge.USERNAME ?? challenge.USER_ID_FOR_SRP ?? username);
    let claim;
    try {
      claim = passwordClaim({
        ephemeral,
        challenge,
        password,
        poolId: COGNITO.poolId,
        date: new Date(this.now()),
      });
    } catch (err) {
      throw new EdilkaminError('bad_response', err.message);
    }
    const answer = await this.call('RespondToAuthChallenge', {
      ChallengeName: 'PASSWORD_VERIFIER',
      ClientId: COGNITO.clientId,
      ChallengeResponses: {
        USERNAME: userId,
        TIMESTAMP: claim.timestamp,
        PASSWORD_CLAIM_SECRET_BLOCK: challenge.SECRET_BLOCK,
        PASSWORD_CLAIM_SIGNATURE: claim.signature,
      },
    });
    if (answer.AuthenticationResult) {
      return this.tokensOf(answer.AuthenticationResult);
    }
    return this.unexpectedChallenge(answer.ChallengeName);
  }

  /**
   * Any challenge but the password proof: a code (`two_factor`), a new
   * password, or another step (`unsupported_challenge`). The app stops on all
   * of them; only `new_password` is tried again by itself (spaced).
   */
  unexpectedChallenge(challengeName) {
    const name = String(challengeName ?? '');
    if (CODE_CHALLENGES.includes(name)) {
      throw new EdilkaminError('two_factor', 'Cognito asks for a verification code', {
        challenge: name,
      });
    }
    if (name === 'NEW_PASSWORD_REQUIRED') {
      throw new EdilkaminError('new_password', 'Cognito asks for a new password', {
        challenge: name,
      });
    }
    throw new EdilkaminError('unsupported_challenge', 'unsupported Cognito challenge', {
      challenge: /^[A-Z_]{1,40}$/.test(name) ? name : undefined,
    });
  }

  /** New tokens from the refresh token, without the password. */
  async refresh(tokens, { timeout } = {}) {
    const answer = await this.call(
      'InitiateAuth',
      {
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: COGNITO.clientId,
        AuthParameters: { REFRESH_TOKEN: tokens.refreshToken },
      },
      { refusal: 'refresh_refused', timeout },
    );
    return this.tokensOf(answer.AuthenticationResult, tokens.refreshToken);
  }
}
