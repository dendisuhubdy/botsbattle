import {
  pgTable,
  pgEnum,
  uuid,
  text,
  bigint,
  jsonb,
  timestamp,
  index,
  boolean,
  integer,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

export const accountKind = pgEnum('account_kind', [
  'user_available',
  'user_pending_withdrawal',
  'pool',
  'house_rake',
  'house_dust',
  'hot_wallet',
])

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: accountKind('kind').notNull(),
  userId: uuid('user_id'),
  fightId: uuid('fight_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const ledgerTransactions = pgTable('ledger_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    txId: uuid('tx_id')
      .notNull()
      .references(() => ledgerTransactions.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ledger_entries_account_idx').on(t.accountId),
    index('ledger_entries_tx_idx').on(t.txId),
  ],
)

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  totpSecretEnc: text('totp_secret_enc'),
  totpEnabled: boolean('totp_enabled').notNull().default(false),
  verificationStatus: text('verification_status').notNull().default('none'),
  withdrawalLocked: boolean('withdrawal_locked').notNull().default(false),
  isAdmin: boolean('is_admin').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const fightStatus = pgEnum('fight_status', [
  'DRAFT',
  'OPEN',
  'LOCKED',
  'SETTLED',
  'VOIDED',
])
export const fightOutcome = pgEnum('fight_outcome', ['A', 'B', 'VOID'])
export const betSide = pgEnum('bet_side', ['A', 'B'])

export const fights = pgTable('fights', {
  id: uuid('id').primaryKey().defaultRandom(),
  leagueName: text('league_name').notNull(),
  fighterA: text('fighter_a').notNull(),
  fighterB: text('fighter_b').notNull(),
  streamEmbedUrl: text('stream_embed_url'),
  status: fightStatus('status').notNull().default('DRAFT'),
  lockAt: timestamp('lock_at', { withTimezone: true }).notNull(),
  rakeBps: integer('rake_bps').notNull().default(500),
  outcome: fightOutcome('outcome'),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
})

export const bets = pgTable(
  'bets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fightId: uuid('fight_id')
      .notNull()
      .references(() => fights.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    side: betSide('side').notNull(),
    stake: bigint('stake', { mode: 'bigint' }).notNull(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    payout: bigint('payout', { mode: 'bigint' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('bets_fight_idx').on(t.fightId), index('bets_user_idx').on(t.userId)],
)

export const settlements = pgTable('settlements', {
  id: uuid('id').primaryKey().defaultRandom(),
  fightId: uuid('fight_id')
    .notNull()
    .unique()
    .references(() => fights.id),
  outcome: fightOutcome('outcome').notNull(),
  poolTotal: bigint('pool_total', { mode: 'bigint' }).notNull(),
  winningPool: bigint('winning_pool', { mode: 'bigint' }).notNull(),
  rake: bigint('rake', { mode: 'bigint' }).notNull(),
  dust: bigint('dust', { mode: 'bigint' }).notNull(),
  refunded: boolean('refunded').notNull(),
  settledBy: uuid('settled_by')
    .notNull()
    .references(() => users.id),
  settledAt: timestamp('settled_at', { withTimezone: true }).notNull().defaultNow(),
})

export const depositStatus = pgEnum('deposit_status', ['PENDING', 'CREDITED'])
export const signerJobStatus = pgEnum('signer_job_status', [
  'PENDING',
  'CLAIMED',
  'DONE',
  'FAILED',
])

export const depositAddresses = pgTable('deposit_addresses', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id),
  derivationIndex: integer('derivation_index').notNull().unique(),
  address: text('address').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const deposits = pgTable(
  'deposits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    txHash: text('tx_hash').notNull(),
    logIndex: integer('log_index').notNull(),
    address: text('address')
      .notNull()
      .references(() => depositAddresses.address),
    fromAddress: text('from_address').notNull(),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
    status: depositStatus('status').notNull().default('PENDING'),
    ledgerTxId: uuid('ledger_tx_id').references(() => ledgerTransactions.id),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    creditedAt: timestamp('credited_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('deposits_chain_uq').on(t.txHash, t.logIndex),
    index('deposits_status_idx').on(t.status),
    index('deposits_address_idx').on(t.address),
  ],
)

export const signerJobs = pgTable(
  'signer_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    payload: jsonb('payload').notNull(),
    status: signerJobStatus('status').notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    txHash: text('tx_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [index('signer_jobs_status_idx').on(t.status, t.createdAt)],
)

export const chainCursors = pgTable('chain_cursors', {
  name: text('name').primaryKey(),
  value: bigint('value', { mode: 'bigint' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const withdrawalStatus = pgEnum('withdrawal_status', [
  'REQUESTED',
  'APPROVED',
  'BROADCAST',
  'CONFIRMED',
  'REJECTED',
  'CANCELLED',
  'FAILED',
])

export const withdrawalRequests = pgTable(
  'withdrawal_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    address: text('address').notNull(),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    status: withdrawalStatus('status').notNull().default('REQUESTED'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    reviewedBy: uuid('reviewed_by').references(() => users.id),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewNote: text('review_note'),
    signerJobId: uuid('signer_job_id').references(() => signerJobs.id),
    txHash: text('tx_hash'),
    broadcastAt: timestamp('broadcast_at', { withTimezone: true }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    failureReason: text('failure_reason'),
  },
  (t) => [
    index('withdrawals_status_idx').on(t.status, t.requestedAt),
    index('withdrawals_user_idx').on(t.userId),
  ],
)
