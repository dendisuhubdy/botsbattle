import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import * as OTPAuth from 'otpauth'
import { testDb, truncateAll } from '../helpers/db'
import { makeUser } from '../helpers/fixtures'
import type { Db } from '@/lib/db/client'
import { users } from '@/lib/db/schema'
import {
  generateSecret,
  encryptSecret,
  decryptSecret,
  enrolmentUri,
  beginEnrolment,
  confirmEnrolment,
  verifyTotp,
  TotpError,
} from '@/lib/auth/totp'

const KEY = '0'.repeat(64) // 32 bytes hex

function codeFor(secret: string): string {
  return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate()
}

describe('TOTP secrets', () => {
  it('generates a distinct base32 secret each time', () => {
    const a = generateSecret()
    const b = generateSecret()
    expect(a).toMatch(/^[A-Z2-7]+$/)
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThanOrEqual(32)
  })

  it('round-trips through encryption', () => {
    const secret = generateSecret()
    const sealed = encryptSecret(secret, KEY)
    expect(sealed).not.toContain(secret)
    expect(decryptSecret(sealed, KEY)).toBe(secret)
  })

  it('produces a different ciphertext each time for the same secret', () => {
    const secret = generateSecret()
    expect(encryptSecret(secret, KEY)).not.toBe(encryptSecret(secret, KEY))
  })

  it('refuses to decrypt with the wrong key', () => {
    const sealed = encryptSecret(generateSecret(), KEY)
    expect(() => decryptSecret(sealed, '1'.repeat(64))).toThrow()
  })

  it('refuses to decrypt tampered ciphertext', () => {
    const sealed = encryptSecret(generateSecret(), KEY)
    const tampered = sealed.slice(0, -2) + (sealed.endsWith('a') ? 'b' : 'a')
    expect(() => decryptSecret(tampered, KEY)).toThrow()
  })

  it('builds an otpauth URI an authenticator app accepts', () => {
    const uri = enrolmentUri({ secret: 'JBSWY3DPEHPK3PXP', email: 'a@example.com' })
    expect(uri).toMatch(/^otpauth:\/\/totp\//)
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP')
    expect(uri).toContain('a%40example.com')
  })
})

describe('TOTP enrolment', () => {
  let db: Db
  let user: string

  beforeAll(async () => {
    ;({ db } = await testDb())
    process.env.TOTP_ENCRYPTION_KEY = KEY
  })

  beforeEach(async () => {
    await truncateAll(db)
    user = await makeUser(db)
  })

  it('stores an encrypted secret but does not enable until confirmed', async () => {
    const { secret } = await beginEnrolment(db, user)

    const [row] = await db.select().from(users).where(eq(users.id, user))
    expect(row.totpEnabled).toBe(false)
    expect(row.totpSecretEnc).not.toBeNull()
    expect(row.totpSecretEnc).not.toContain(secret)
  })

  it('enables TOTP when the confirming code is correct', async () => {
    const { secret } = await beginEnrolment(db, user)
    await confirmEnrolment(db, user, codeFor(secret))

    const [row] = await db.select().from(users).where(eq(users.id, user))
    expect(row.totpEnabled).toBe(true)
  })

  it('rejects a wrong confirming code and leaves TOTP disabled', async () => {
    await beginEnrolment(db, user)
    await expect(confirmEnrolment(db, user, '000000')).rejects.toMatchObject({
      code: 'INVALID_CODE',
    })

    const [row] = await db.select().from(users).where(eq(users.id, user))
    expect(row.totpEnabled).toBe(false)
  })

  it('refuses to re-enrol an already enrolled user', async () => {
    const { secret } = await beginEnrolment(db, user)
    await confirmEnrolment(db, user, codeFor(secret))

    await expect(beginEnrolment(db, user)).rejects.toMatchObject({ code: 'ALREADY_ENROLLED' })
  })

  it('verifies a live code once enrolled', async () => {
    const { secret } = await beginEnrolment(db, user)
    await confirmEnrolment(db, user, codeFor(secret))

    await expect(verifyTotp(db, user, codeFor(secret))).resolves.toBeUndefined()
  })

  it('rejects a wrong code after enrolment', async () => {
    const { secret } = await beginEnrolment(db, user)
    await confirmEnrolment(db, user, codeFor(secret))

    await expect(verifyTotp(db, user, '000000')).rejects.toMatchObject({ code: 'INVALID_CODE' })
  })

  it('reports NOT_ENROLLED for a user who never enrolled', async () => {
    await expect(verifyTotp(db, user, '123456')).rejects.toMatchObject({ code: 'NOT_ENROLLED' })
  })

  it('reports NOT_ENROLLED when enrolment was begun but never confirmed', async () => {
    const { secret } = await beginEnrolment(db, user)
    await expect(verifyTotp(db, user, codeFor(secret))).rejects.toMatchObject({
      code: 'NOT_ENROLLED',
    })
  })
})
