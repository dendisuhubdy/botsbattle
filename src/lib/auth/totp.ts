import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import * as OTPAuth from 'otpauth'
import type { Db } from '@/lib/db/client'
import { users } from '@/lib/db/schema'

const ISSUER = 'Bots Battle'
/** One step either side, so a code entered as the window rolls still works. */
const WINDOW = 1

export class TotpError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_ENROLLED' | 'ALREADY_ENROLLED' | 'INVALID_CODE' | 'NO_KEY',
  ) {
    super(message)
    this.name = 'TotpError'
  }
}

function keyBytes(key?: string): Buffer {
  const hex = key ?? process.env.TOTP_ENCRYPTION_KEY
  if (!hex) throw new TotpError('TOTP_ENCRYPTION_KEY is not set', 'NO_KEY')
  const buf = Buffer.from(hex, 'hex')
  if (buf.length !== 32) {
    throw new TotpError('TOTP_ENCRYPTION_KEY must be 32 bytes of hex (64 characters)', 'NO_KEY')
  }
  return buf
}

export function generateSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32
}

/** AES-256-GCM, stored as `iv.tag.ciphertext` in hex. */
export function encryptSecret(secret: string, key?: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyBytes(key), iv)
  const enc = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), enc.toString('hex')].join('.')
}

export function decryptSecret(payload: string, key?: string): string {
  const [ivHex, tagHex, dataHex] = payload.split('.')
  if (!ivHex || !tagHex || !dataHex) throw new Error('malformed encrypted TOTP secret')

  const decipher = createDecipheriv('aes-256-gcm', keyBytes(key), Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]).toString('utf8')
}

export function enrolmentUri(args: { secret: string; email: string }): string {
  return new OTPAuth.TOTP({
    issuer: ISSUER,
    label: args.email,
    secret: OTPAuth.Secret.fromBase32(args.secret),
  }).toString()
}

function totpFor(secret: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) })
}

/**
 * Issue a secret and store it encrypted, but leave TOTP disabled until the user proves they
 * can generate a code. Enabling on issue would lock out anyone whose scan failed.
 */
export async function beginEnrolment(
  db: Db,
  userId: string,
): Promise<{ secret: string; uri: string }> {
  const [row] = await db
    .select({ email: users.email, enabled: users.totpEnabled })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (!row) throw new TotpError(`no user ${userId}`, 'NOT_ENROLLED')
  if (row.enabled) throw new TotpError('TOTP is already enabled', 'ALREADY_ENROLLED')

  const secret = generateSecret()
  await db
    .update(users)
    .set({ totpSecretEnc: encryptSecret(secret) })
    .where(eq(users.id, userId))

  return { secret, uri: enrolmentUri({ secret, email: row.email }) }
}

export async function confirmEnrolment(db: Db, userId: string, code: string): Promise<void> {
  const [row] = await db
    .select({ enc: users.totpSecretEnc })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (!row?.enc) throw new TotpError('enrolment has not been started', 'NOT_ENROLLED')

  const secret = decryptSecret(row.enc)
  if (totpFor(secret).validate({ token: code, window: WINDOW }) === null) {
    throw new TotpError('incorrect code', 'INVALID_CODE')
  }

  await db.update(users).set({ totpEnabled: true }).where(eq(users.id, userId))
}

export async function verifyTotp(db: Db, userId: string, code: string): Promise<void> {
  const [row] = await db
    .select({ enc: users.totpSecretEnc, enabled: users.totpEnabled })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  if (!row?.enabled || !row.enc) throw new TotpError('TOTP is not enrolled', 'NOT_ENROLLED')

  const secret = decryptSecret(row.enc)
  if (totpFor(secret).validate({ token: code, window: WINDOW }) === null) {
    throw new TotpError('incorrect code', 'INVALID_CODE')
  }
}
