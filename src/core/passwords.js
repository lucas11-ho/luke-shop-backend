import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const N = 1 << 15;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 64 * 1024 * 1024;

export function assertPasswordPolicy(password) {
  const value = String(password || '');
  if (value.length < 12) throw new Error('Password must contain at least 12 characters');
  if (value.length > 128) throw new Error('Password must contain at most 128 characters');
  return value;
}

export async function hashPassword(password) {
  const safe = assertPasswordPolicy(password);
  const salt = randomBytes(16);
  const derived = await scrypt(safe, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${Buffer.from(derived).toString('base64url')}`;
}

export async function verifyPassword(encoded, password) {
  try {
    const [kind, nRaw, rRaw, pRaw, saltRaw, hashRaw] = String(encoded || '').split('$');
    if (kind !== 'scrypt') return false;
    const n = Number.parseInt(nRaw, 10);
    const r = Number.parseInt(rRaw, 10);
    const p = Number.parseInt(pRaw, 10);
    const salt = Buffer.from(saltRaw, 'base64url');
    const expected = Buffer.from(hashRaw, 'base64url');
    if (!n || !r || !p || expected.length !== KEYLEN) return false;
    const actual = Buffer.from(await scrypt(String(password || ''), salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
