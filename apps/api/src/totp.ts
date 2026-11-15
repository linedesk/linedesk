// Time-based one-time codes (TOTP, RFC 6238) for an authenticator app (authenticator.ts): HMAC-SHA1, 30-second steps,
// 6 digits, the defaults every app (Google Authenticator, 1Password, Authy, Microsoft Authenticator) reads from an
// otpauth:// address. No dependency: it is a few lines of node:crypto.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const TOTP_STEP_SECONDS = 30
export const TOTP_DIGITS = 6
/** Codes of one step before and after are accepted too: a phone clock a little off, a code typed as it changes. */
export const TOTP_WINDOW = 1

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(bytes: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of clean) {
    const index = BASE32.indexOf(char)
    if (index === -1) throw new Error('not base32')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** A new secret: 20 random bytes (160 bits, RFC 4226's recommendation), base32 as the apps take it. */
export const newTotpSecret = () => base32Encode(randomBytes(20))

/** The 30-second step a time falls in. */
export const stepAt = (ms: number) => Math.floor(ms / 1000 / TOTP_STEP_SECONDS)

/** The code of one step (RFC 4226 HOTP with the step as counter). */
export function codeAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest()
  const offset = hmac[hmac.length - 1]! & 15
  const number = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** TOTP_DIGITS
  return number.toString().padStart(TOTP_DIGITS, '0')
}

/** A code as typed: digits only (spaces and dashes dropped), or null when it is not 6 digits. */
export function cleanCode(typed: string): string | null {
  const digits = typed.replace(/[\s-]/g, '')
  return /^\d{6}$/.test(digits) ? digits : null
}

/**
 * The step whose code `typed` is, within the window around `now`, and later than `afterStep` (a code works once, and
 * never one older than the last accepted); null when none. Every step in the window is compared, in constant time.
 */
export function matchingStep(
  secret: string,
  typed: string,
  now: number,
  afterStep: number | null = null,
): number | null {
  const code = cleanCode(typed)
  if (!code) return null
  const current = stepAt(now)
  let found: number | null = null
  for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step++) {
    const same = timingSafeEqual(Buffer.from(codeAt(secret, step)), Buffer.from(code))
    if (same && found === null && (afterStep === null || step > afterStep)) found = step
  }
  return found
}

/** The otpauth:// address an app reads from the QR code: issuer and account name shown in the app. */
export function otpauthUrl(secret: string, issuer: string, account: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  })
  return `otpauth://totp/${label}?${params}`
}
