import type { Executor } from '@/lib/db/client'
import { houseAccount, userAvailableAccount } from '@/lib/ledger/accounts'
import { postTransaction, type PostResult } from '@/lib/ledger/post'

export class CreditError extends Error {
  constructor(
    message: string,
    readonly code: 'NON_POSITIVE',
  ) {
    super(message)
    this.name = 'CreditError'
  }
}

export type CreditArgs = {
  userId: string
  amount: bigint
  reference: string
  creditedBy: string
}

/**
 * Funded from `hot_wallet`, which therefore goes negative in Slice 1. That is correct
 * double-entry: it records that the platform owes users money it has not received on
 * chain. Slice 2's deposit crediting restores `hot_wallet` to a true on-chain figure.
 */
export async function creditUser(x: Executor, args: CreditArgs): Promise<PostResult> {
  if (args.amount <= 0n) {
    throw new CreditError(`credit amount must be positive, got ${args.amount}`, 'NON_POSITIVE')
  }

  const [userAccount, hotWallet] = await Promise.all([
    userAvailableAccount(x, args.userId),
    houseAccount(x, 'hot_wallet'),
  ])

  return postTransaction(x, {
    kind: 'ADMIN_CREDIT',
    idempotencyKey: `credit:${args.reference}`,
    metadata: { userId: args.userId, creditedBy: args.creditedBy, reference: args.reference },
    legs: [
      { accountId: hotWallet, amount: -args.amount },
      { accountId: userAccount, amount: args.amount },
    ],
  })
}
