import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync } from '@scure/bip39'
import { testDb, truncateAll } from '../helpers/db'
import { makeUser } from '../helpers/fixtures'
import type { Db } from '@/lib/db/client'
import { deposits as depositsTable } from '@/lib/db/schema'
import { ACCOUNT_PATH, deriveAddress } from '@/lib/tron/address'
import { assignDepositAddress } from '@/lib/deposits/addresses'
import { recordSeenTransfer, creditConfirmedDeposits } from '@/lib/deposits/credit'
import { userBalance, balanceOf, houseAccount } from '@/lib/ledger/accounts'
import type { Trc20Transfer } from '@/lib/tron/client'

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const XPUB = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC)).derive(ACCOUNT_PATH)
  .publicExtendedKey
const USDT = 1_000_000n

/**
 * An address from a different wallet entirely. Deriving the "not ours" address from a
 * *different* seed means it can never collide with an index of XPUB, however many deposit
 * addresses get assigned. A literal lifted from `deriveAddress(XPUB, n)` silently becomes
 * one of ours the moment allocation reaches n.
 */
const FOREIGN_ADDRESS = deriveAddress(
  HDKey.fromMasterSeed(
    mnemonicToSeedSync(
      'legal winner thank year wave sausage worth useful legal winner thank yellow',
    ),
  ).derive(ACCOUNT_PATH).publicExtendedKey,
  0,
)

function transfer(over: Partial<Trc20Transfer> & { to: string }): Trc20Transfer {
  return {
    txHash: 'aa'.repeat(32),
    logIndex: 0,
    from: 'TEPSrSYPDSQ7yXpMFPq91Fb1QEWpMkRGfn',
    amountMicros: 50n * USDT,
    blockNumber: 100,
    ...over,
  }
}

describe('deposit crediting', () => {
  let db: Db
  let user: string
  let address: string

  beforeAll(async () => {
    ;({ db } = await testDb())
  })

  beforeEach(async () => {
    await truncateAll(db)
    user = await makeUser(db)
    address = (await assignDepositAddress(db, { userId: user, xpub: XPUB })).address
  })

  it('records a seen transfer as PENDING without crediting', async () => {
    const result = await recordSeenTransfer(db, transfer({ to: address }))

    expect(result).not.toBeNull()
    expect(result!.alreadyKnown).toBe(false)
    expect(await userBalance(db, user)).toBe(0n)

    const rows = await db.select().from(depositsTable)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('PENDING')
  })

  it('ignores a transfer to an address we do not own', async () => {
    const result = await recordSeenTransfer(
      db,
      transfer({ to: FOREIGN_ADDRESS }),
    )
    expect(result).toBeNull()
    expect(await db.select().from(depositsTable)).toHaveLength(0)
  })

  it('does not credit before the confirmation threshold', async () => {
    await recordSeenTransfer(db, transfer({ to: address, blockNumber: 100 }))

    // head 118 means 19 confirmations only from block 100 onward; threshold not yet met.
    expect(await creditConfirmedDeposits(db, 117, 19)).toEqual([])
    expect(await userBalance(db, user)).toBe(0n)
  })

  it('credits once the threshold is reached', async () => {
    await recordSeenTransfer(db, transfer({ to: address, blockNumber: 100 }))

    const credited = await creditConfirmedDeposits(db, 118, 19)
    expect(credited).toHaveLength(1)

    expect(await userBalance(db, user)).toBe(50n * USDT)
    expect(await balanceOf(db, await houseAccount(db, 'hot_wallet'))).toBe(-50n * USDT)

    const [row] = await db.select().from(depositsTable)
    expect(row.status).toBe('CREDITED')
    expect(row.ledgerTxId).not.toBeNull()
    expect(row.creditedAt).not.toBeNull()
  })

  it('is idempotent on (tx_hash, log_index): reseeing writes nothing new', async () => {
    const t = transfer({ to: address, blockNumber: 100 })
    await recordSeenTransfer(db, t)
    const second = await recordSeenTransfer(db, t)

    expect(second!.alreadyKnown).toBe(true)
    expect(await db.select().from(depositsTable)).toHaveLength(1)
  })

  it('does not double-credit when crediting runs twice', async () => {
    await recordSeenTransfer(db, transfer({ to: address, blockNumber: 100 }))

    await creditConfirmedDeposits(db, 200, 19)
    const secondRun = await creditConfirmedDeposits(db, 200, 19)

    expect(secondRun).toEqual([])
    expect(await userBalance(db, user)).toBe(50n * USDT)
  })

  it('treats two transfers sharing a tx hash as distinct deposits', async () => {
    await recordSeenTransfer(
      db,
      transfer({ to: address, txHash: 'bb'.repeat(32), logIndex: 0, amountMicros: 10n * USDT }),
    )
    await recordSeenTransfer(
      db,
      transfer({ to: address, txHash: 'bb'.repeat(32), logIndex: 1, amountMicros: 20n * USDT }),
    )

    await creditConfirmedDeposits(db, 200, 19)
    expect(await userBalance(db, user)).toBe(30n * USDT)
  })

  it('credits several users independently in one run', async () => {
    const other = await makeUser(db)
    const otherAddress = (await assignDepositAddress(db, { userId: other, xpub: XPUB })).address

    await recordSeenTransfer(
      db,
      transfer({ to: address, txHash: 'cc'.repeat(32), amountMicros: 10n * USDT }),
    )
    await recordSeenTransfer(
      db,
      transfer({ to: otherAddress, txHash: 'dd'.repeat(32), amountMicros: 7n * USDT }),
    )

    expect(await creditConfirmedDeposits(db, 200, 19)).toHaveLength(2)
    expect(await userBalance(db, user)).toBe(10n * USDT)
    expect(await userBalance(db, other)).toBe(7n * USDT)
  })

  it('leaves every ledger transaction balanced', async () => {
    await recordSeenTransfer(db, transfer({ to: address }))
    await creditConfirmedDeposits(db, 200, 19)

    const unbalanced = await db.execute<{ tx_id: string }>(
      sql`SELECT tx_id FROM ledger_entries GROUP BY tx_id HAVING SUM(amount) <> 0`,
    )
    expect(unbalanced.rows).toEqual([])
  })
})
