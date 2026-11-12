// Password hashing and session tokens, using only node:crypto — zero new
// dependencies, and every step is explainable in an interview.
//
// Passwords: scrypt with a per-user random salt. The stored value carries
// its own parameters ("scrypt$N$r$p$salt$hash") so the cost can be raised
// later without invalidating existing hashes.
// Sessions: opaque random tokens. Only the SHA-256 hash is stored, so a
// database leak does not hand out live sessions.

import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto'

interface ScryptOptions {
  N: number
  r: number
  p: number
  maxmem: number
}

// The callback form, wrapped by hand: promisify() picks the wrong
// overload of scrypt (the one without options), so the wrapper is
// explicit about the cost parameters instead.
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err)
      else resolve(derived)
    })
  })
}

// OWASP's guidance for scrypt interactive logins; ~80ms per hash on this
// hardware — slow enough to hurt brute force, fast enough to not annoy.
const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LENGTH = 64

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = await scryptAsync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  })
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${derived.toString('hex')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, saltHex, hashHex] = parts
  const expected = Buffer.from(hashHex, 'hex')
  const derived = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  })
  // Constant-time comparison: a plain === would leak how many leading
  // bytes matched through timing.
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}

/** A fresh session token: 32 random bytes, hex-encoded (256 bits). */
export function newSessionToken(): string {
  return randomBytes(32).toString('hex')
}

/** The stored form of a token — the raw token itself never touches the DB. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
