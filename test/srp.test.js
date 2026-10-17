// -----------------------------------------------------------------------------
// The SRP computation against a vector made by pycognito 2024.5.1 itself
// (aws_srp.AWSSRP.process_challenge with a fixed `a`, a fixed server `b` and
// a fixed clock): the A value, k and the claim signature. The vector was made
// for the pool `us-west-2_2zhrVs9d4`: the computation only takes the pool
// name as a parameter, so it checks the same code the Edilkamin pool uses.
// The end-to-end tests check it again against a fake Cognito running the
// server half, with the Edilkamin pool.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  G,
  K,
  N,
  cognitoTimestamp,
  modPow,
  newEphemeral,
  padHex,
  passwordClaim,
  poolName,
  toHex,
} from '../src/srp.js';
import { COGNITO } from '../src/constants.js';

const VECTOR_POOL = 'us-west-2_2zhrVs9d4';
const SMALL_A = 'a1'.repeat(128);
const A =
  'c02a160ecd7f774f857baa05bd1b2ad7aebfaa860706eab803d36b0a02519016df15f42bf0bba4ebb0cf36bb07f07777120e6cbb168a37bb685b5cb5bf13ed99bed6b6c2fdacd62a1fb99ba64da85256970fbbc9f12c68081ca066770fe7d2a6475855dbb19243d35fa6e63616e8f32c21d5d830c3acb99ef28b416f20e1acdf8e40d4242b7cfeb5864a5123e5fbacb2ce223f08e586910a9e81de64100acf751f366b14d5ce00bc22ca5c79db8dd8d2e0d9f68f19304f1f748cec8cbeb5186596ed35f2088b33152191016395308af48c9fb016e0edf8526989a3a50e9b1c95830ee17bae1ff9834c3915b87ba4cd8500635528440ae81099dd2ee4141751d0dba5e7cf0163a68241312fb1a239b8553404781a623208993b7b803bce0f7fa02f2fe992ed654c3efbea01ed7db620ba4b505bd072ab387d0a0f08ed9e5d7fec9bfbc22d7a5129580eca4c2a933f6f7aaa18a1e4f3f48c27973296b5bef6af7a4b8291daf65a98ca40ad75b6c52c6a0030d423a19a1870467123d843146b2d63';
const CHALLENGE = {
  USER_ID_FOR_SRP: '0f6c1a52-2b4c-4d8e-9a3f-7e5d1c2b3a49',
  USERNAME: '0f6c1a52-2b4c-4d8e-9a3f-7e5d1c2b3a49',
  SALT: '8f3e2a1b0c9d8e7f6a5b4c3d2e1f0a9b',
  SRP_B:
    '78f137b80f121eaa446bda6aaf4e525ae0965bbc93f7c6fe60d62a86bbdbb63176e146daba92b24abcceb3597b954348ed8949913ddc2564942f1ccae0efbe9887ea59f073b5701cc0bea7afcf3657f51b0157839d1431628467c80688d38c778ba229bc34bfe6ff3451aa4126d26c80a2c1bbc54f993eb2190850899962236f13df12df1c8b4b0c08da56d51a2a56fb0e0a153d7f022379b857aba45e3002e905fdde82b7b75a63073fbc3e0694fa1661d3e9e951220c08f9411ee7a9b09c3dec3a7e9fdec6f26f40bb8cbe70bdb9170917ef1eedf1f8516dbbc8cfb8d1ba86354911fd8ee0c3341d89a418b0307ab1f75f108fef8bcac7b041e8e3ee08f079cc25ebf93ab91e97f40e4967f561b4829aedf9d22e0d941f3ccdfa3c32a2d8b40dec6a7037bd2ae47fd5e8bcc0ac603ad677ee2d9cefe13a5b1556af9b4c478ee3a7fae912bc207287e58afddefbff8d4f9b4058a056f47b3d72edd83bf9d6260a4079b4f701bcb0c9af9a12d4714bfd17b15bb69d670045c2612b15304b5ca1',
  SECRET_BLOCK: 'c2VjcmV0LWJsb2NrLWZyb20tY29nbml0bw==',
};
const PASSWORD = 'correct horse – battery staple é';

test('A and k are those of pycognito', () => {
  const a = BigInt(`0x${SMALL_A}`) % N;
  assert.equal(toHex(modPow(G, a, N)), A);
  assert.equal(toHex(K), '538282c4354742d7cbbde2359fcf67f9f5b3a6b08791e5011b43b8a5b66d9ee6');
});

test('the PASSWORD_VERIFIER claim is the one pycognito computes', () => {
  const a = BigInt(`0x${SMALL_A}`) % N;
  const claim = passwordClaim({
    ephemeral: { a, A: modPow(G, a, N) },
    challenge: CHALLENGE,
    password: PASSWORD,
    poolId: VECTOR_POOL,
    date: new Date(Date.UTC(2026, 2, 5, 7, 8, 9)),
  });
  assert.equal(claim.timestamp, 'Thu Mar 5 07:08:09 UTC 2026');
  assert.equal(claim.signature, 'GGyyzwG0Xmjm+k0QcK9pIwFmC1lTsjybZ1fMjV/BPuk=');
});

test('the Edilkamin pool: its name, and a claim that depends on it', () => {
  assert.equal(poolName(COGNITO.poolId), 'BYmQ2VBlo');
  const a = BigInt(`0x${SMALL_A}`) % N;
  const claim = passwordClaim({
    ephemeral: { a, A: modPow(G, a, N) },
    challenge: CHALLENGE,
    password: PASSWORD,
    poolId: COGNITO.poolId,
    date: new Date(Date.UTC(2026, 2, 5, 7, 8, 9)),
  });
  assert.notEqual(claim.signature, 'GGyyzwG0Xmjm+k0QcK9pIwFmC1lTsjybZ1fMjV/BPuk=');
});

test('the timestamp: English, UTC, the day without its leading zero', () => {
  assert.equal(
    cognitoTimestamp(new Date(Date.UTC(2026, 9, 17, 23, 59, 1))),
    'Sat Oct 17 23:59:01 UTC 2026',
  );
  assert.equal(
    cognitoTimestamp(new Date(Date.UTC(2027, 0, 1, 0, 0, 0))),
    'Fri Jan 1 00:00:00 UTC 2027',
  );
});

test('pad_hex', () => {
  assert.equal(padHex('abc'), '0abc');
  assert.equal(padHex('7f'), '7f');
  assert.equal(padHex('8f'), '008f');
  assert.equal(padHex(255n), '00ff');
});

test('a random ephemeral is in the group; a bad challenge is refused', () => {
  const e = newEphemeral();
  assert.ok(e.A > 1n && e.A < N);
  const claim = (challenge) =>
    passwordClaim({
      ephemeral: e,
      challenge: { ...CHALLENGE, ...challenge },
      password: 'x',
      poolId: COGNITO.poolId,
      date: new Date(),
    });
  assert.throws(() => claim({ SRP_B: toHex(N) }), /invalid B/);
  assert.throws(() => claim({ SALT: 'not hex' }), /incomplete/);
  assert.throws(() => claim({ SECRET_BLOCK: '' }), /incomplete/);
});
