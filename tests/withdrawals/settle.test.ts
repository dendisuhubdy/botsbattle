import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import * as OTPAuth from 'otpauth'
import { mnemonicToSeedSync } from '@scure/bip39'
import { testDb, truncateAll } from '../helpers/db'
import { makeUser, makeAdmin } from '../helpers/fixtures'
import type { Db } from '@/lib/db/client'
import { withdrawalRequests } from '@/lib/db/schema'
import { creditUser } from '@/lib/admin/credit'
import { beginEnrolment, confirmEnrolment } from '@/lib/auth/totp'
import { requestWithdrawal } from '@/lib/withdrawals/request'
import { approveWithdrawal } from '@/lib/withdrawals/review'
import { markBroadcast, confirmWithdrawal, failWithdrawal } from '@/lib/withdrawals/settle'
import { runOnce } from '@/lib/signer/run'
import { FakeTron } from '@/lib/tron/fake'
import { balanceOf, userAvailableAccount, userPendingWithdrawalAccount, houseAccount } from '@/lib/ledger/accounts'

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const SEED = mnemonicToSeedSync(MNEMONIC)
const USDT = 1_000_000n
const DEST = 'TEnzFm6jmsVnizS7RSuBr7H6zzn4e7H7Pb'
const HOT = 'TTTFe9haCY6CACG9iTM8uyL89pFEPy4ctW'

describe('withdrawal settlement', () => {
  let db: Db
  let user: string
  let admin: string
  let secret: string
  let requestId: string

  beforeAll(async () => {
    ;({ db } = await testDb())
    process.env.TOTP_ENCRYPTION_KEY = '0'.repeat(64)
  })

  beforeEach(async () => {
    await truncateAll(db)
    admin = await makeAdmin(db)
    user = await makeUser(db)
    await creditUser(db, { userId: user, amount: 100n * USDT, reference: 'seed', creditedBy: admin })
    secret = (await beginEnrolment(db, user)).secret
    await confirmEnrolment(db, user, code())
    requestId = (
      await requestWithdrawal(db, {
        userId: user,
        address: DEST,
        amountMicros: 40n * USDT,
        totpCode: code(),
      })
    ).requestId
  })

  function code(): string {
    return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate()
  }

  const pending = async () => balanceOf(db, await userPendingWithdrawalAccount(db, user))
  const available = async () => balanceOf(db, await userAvailableAccount(db, user))
  const hot = async () => balanceOf(db, await houseAccount(db, 'hot_wallet'))

  it('records a broadcast without moving money', async () => {
    await approveWithdrawal(db, { requestId, adminId: admin })
    await markBroadcast(db, { requestId, txHash: 'deadbeef' })

    const [row] = await db.select().from(withdrawalRequests).where(eq(withdrawalRequests.id, requestId))
    expect(row.status).toBe('BROADCAST')
    expect(row.txHash).toBe('deadbeef')
    expect(await pending()).toBe(40n * USDT)
  })

  it('closes out pending into hot_wallet on confirmation', async () => {
    const hotBefore = await hot()
    await approveWithdrawal(db, { requestId, adminId: admin })
    await markBroadcast(db, { requestId, txHash: 'deadbeef' })
    await confirmWithdrawal(db, requestId)

    expect(await pending()).toBe(0n)
    expect(await available()).toBe(60n * USDT)
    // Custody is carried inverted, so money leaving reduces the obligation.
    expect(await hot()).toBe(hotBefore + 40n * USDT)

    const [row] = await db.select().from(withdrawalRequests).where(eq(withdrawalRequests.id, requestId))
    expect(row.status).toBe('CONFIRMED')
    expect(row.confirmedAt).not.toBeNull()
  })

  it('confirming twice moves money once', async () => {
    await approveWithdrawal(db, { requestId, adminId: admin })
    await markBroadcast(db, { requestId, txHash: 'deadbeef' })
    await confirmWithdrawal(db, requestId)
    const hotAfterFirst = await hot()
    await confirmWithdrawal(db, requestId)

    expect(await hot()).toBe(hotAfterFirst)
    expect(await pending()).toBe(0n)
  })

  it('returns the funds when the broadcast fails', async () => {
    await approveWithdrawal(db, { requestId, adminId: admin })
    await failWithdrawal(db, { requestId, reason: 'insufficient energy' })

    expect(await pending()).toBe(0n)
    expect(await available()).toBe(100n * USDT)

    const [row] = await db.select().from(withdrawalRequests).where(eq(withdrawalRequests.id, requestId))
    expect(row.status).toBe('FAILED')
    expect(row.failureReason).toBe('insufficient energy')
  })

  it('failing twice returns the funds once', async () => {
    await approveWithdrawal(db, { requestId, adminId: admin })
    await failWithdrawal(db, { requestId, reason: 'x' })
    await failWithdrawal(db, { requestId, reason: 'x' })
    expect(await available()).toBe(100n * USDT)
  })

  it('the signer broadcasts an approved withdrawal end to end', async () => {
    await approveWithdrawal(db, { requestId, adminId: admin })

    const tron = new FakeTron()
    // Fund the hot wallet on the fake chain so the send can succeed.
    tron.deposit({ to: HOT, amountMicros: 500n * USDT, blockNumber: 1 })

    expect(await runOnce({ db, tron, seed: SEED, hotWalletAddress: HOT })).toBe('done')

    expect(tron.broadcasts).toHaveLength(1)
    expect(tron.broadcasts[0]).toMatchObject({ to: DEST, amountMicros: 40n * USDT })

    const [row] = await db.select().from(withdrawalRequests).where(eq(withdrawalRequests.id, requestId))
    expect(row.status).toBe('BROADCAST')
    expect(row.txHash).toBe(tron.broadcasts[0].txHash)
  })

  it('a failed signer broadcast returns the funds to the user', async () => {
    await approveWithdrawal(db, { requestId, adminId: admin })

    const tron = new FakeTron()
    tron.deposit({ to: HOT, amountMicros: 500n * USDT, blockNumber: 1 })

    // Exhaust every retry so the job is parked and the withdrawal fails for good.
    for (let i = 0; i < 5; i++) {
      tron.failNextSend('node unreachable')
      await runOnce({ db, tron, seed: SEED, hotWalletAddress: HOT })
    }

    const [row] = await db.select().from(withdrawalRequests).where(eq(withdrawalRequests.id, requestId))
    expect(row.status).toBe('FAILED')
    expect(await available()).toBe(100n * USDT)
    expect(await pending()).toBe(0n)
  })
})
