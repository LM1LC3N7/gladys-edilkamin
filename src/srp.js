// -----------------------------------------------------------------------------
// AWS Cognito SRP (USER_SRP_AUTH), the way edilkamin.py signs in through
// pycognito: the 3072-bit group of RFC 5054, k = H(00 N | 0 g), the
// "Caldera Derived Key" HKDF and the PASSWORD_VERIFIER claim signature. Pure:
// the random `a` and the clock are given. The test vector of
// test/srp.test.js comes from pycognito itself. The Edilkamin app client has
// no secret: no SECRET_HASH.
// -----------------------------------------------------------------------------

import { createHash, createHmac, randomBytes } from 'node:crypto';

const N_HEX =
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1' +
  '29024E088A67CC74020BBEA63B139B22514A08798E3404DD' +
  'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245' +
  'E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED' +
  'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D' +
  'C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F' +
  '83655D23DCA3AD961C62F356208552BB9ED529077096966D' +
  '670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B' +
  'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9' +
  'DE2BCBF6955817183995497CEA956AE515D2261898FA0510' +
  '15728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64' +
  'ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7' +
  'ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6B' +
  'F12FFA06D98A0864D87602733EC86A64521F2B18177B200C' +
  'BBE117577A615D6C770988C0BAD946E208E24FA074E5AB31' +
  '43DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF';
const G_HEX = '2';

export const N = BigInt(`0x${N_HEX}`);
export const G = 2n;

const sha256Hex = (buffer) => createHash('sha256').update(buffer).digest('hex');
export const hexHash = (hex) => sha256Hex(Buffer.from(hex, 'hex'));
export const toHex = (value) => value.toString(16);
const fromHex = (hex) => BigInt(`0x${hex}`);

/** pycognito pad_hex: an even length, and a leading 00 when the first digit has its high bit. */
export function padHex(value) {
  let hex = typeof value === 'bigint' ? toHex(value) : String(value);
  if (hex.length % 2 === 1) {
    hex = `0${hex}`;
  } else if ('89abcdefABCDEF'.includes(hex[0])) {
    hex = `00${hex}`;
  }
  return hex;
}

export const K = fromHex(hexHash(`00${N_HEX}0${G_HEX}`));

/** base^exp mod m, for BigInt. */
export function modPow(base, exp, m) {
  let result = 1n;
  let b = ((base % m) + m) % m;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) {
      result = (result * b) % m;
    }
    e >>= 1n;
    b = (b * b) % m;
  }
  return result;
}

/** A random `a` (128 bytes, as pycognito) and A = g^a mod N. */
export function newEphemeral(random = randomBytes) {
  const a = fromHex(random(128).toString('hex')) % N;
  const A = modPow(G, a, N);
  if (A % N === 0n) {
    throw new Error('SRP: invalid A');
  }
  return { a, A, srpA: toHex(A) };
}

/** The "Caldera Derived Key": HKDF-SHA256, 16 bytes. */
function hkdf(ikm, salt) {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  const info = Buffer.concat([Buffer.from('Caldera Derived Key', 'utf8'), Buffer.from([1])]);
  return createHmac('sha256', prk).update(info).digest().subarray(0, 16);
}

/** The pool name: the part of the pool id after the region. */
export const poolName = (poolId) => String(poolId).split('_')[1];

/** "Thu Mar 5 07:08:09 UTC 2026": the day without its leading zero, in English, UTC. */
export function cognitoTimestamp(date) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const two = (n) => String(n).padStart(2, '0');
  return (
    `${days[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${date.getUTCDate()} ` +
    `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())} ` +
    `UTC ${date.getUTCFullYear()}`
  );
}

/**
 * The answer to PASSWORD_VERIFIER: `{ timestamp, signature }`. `ephemeral`:
 * from newEphemeral(); `challenge`: the ChallengeParameters of InitiateAuth.
 */
export function passwordClaim({ ephemeral, challenge, password, poolId, date }) {
  const userId = String(challenge.USER_ID_FOR_SRP ?? '');
  const salt = String(challenge.SALT ?? '');
  const srpB = String(challenge.SRP_B ?? '');
  const secretBlock = String(challenge.SECRET_BLOCK ?? '');
  if (!userId || !/^[0-9a-f]+$/i.test(salt) || !/^[0-9a-f]+$/i.test(srpB) || !secretBlock) {
    throw new Error('SRP: incomplete challenge');
  }
  const B = fromHex(srpB);
  if (B % N === 0n) {
    throw new Error('SRP: invalid B');
  }
  const u = fromHex(hexHash(padHex(ephemeral.A) + padHex(B)));
  if (u === 0n) {
    throw new Error('SRP: invalid u');
  }
  const identity = sha256Hex(Buffer.from(`${poolName(poolId)}${userId}:${password}`, 'utf8'));
  const x = fromHex(hexHash(padHex(salt) + identity));
  const base = (((B - K * modPow(G, x, N)) % N) + N) % N;
  const S = modPow(base, ephemeral.a + u * x, N);
  const key = hkdf(Buffer.from(padHex(S), 'hex'), Buffer.from(padHex(toHex(u)), 'hex'));
  const timestamp = cognitoTimestamp(date);
  const message = Buffer.concat([
    Buffer.from(poolName(poolId), 'utf8'),
    Buffer.from(userId, 'utf8'),
    Buffer.from(secretBlock, 'base64'),
    Buffer.from(timestamp, 'utf8'),
  ]);
  const signature = createHmac('sha256', key).update(message).digest('base64');
  return { timestamp, signature };
}
