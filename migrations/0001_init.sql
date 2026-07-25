CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE account_kind AS ENUM (
  'user_available',
  'user_pending_withdrawal',
  'pool',
  'house_rake',
  'house_dust',
  'hot_wallet'
);

CREATE TABLE accounts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       account_kind NOT NULL,
  user_id    UUID,
  fight_id   UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One user_available / user_pending_withdrawal account per user.
CREATE UNIQUE INDEX accounts_user_kind_uq
  ON accounts (kind, user_id)
  WHERE user_id IS NOT NULL;

-- One pool account per fight.
CREATE UNIQUE INDEX accounts_pool_fight_uq
  ON accounts (fight_id)
  WHERE kind = 'pool';

-- Exactly one of each house/system account.
CREATE UNIQUE INDEX accounts_singleton_uq
  ON accounts (kind)
  WHERE kind IN ('house_rake', 'house_dust', 'hot_wallet');

CREATE TABLE ledger_transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_id      UUID NOT NULL REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  amount     BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id);
CREATE INDEX ledger_entries_tx_idx ON ledger_entries (tx_id);

CREATE FUNCTION assert_ledger_balanced() RETURNS trigger AS $$
DECLARE
  total BIGINT;
BEGIN
  SELECT COALESCE(SUM(amount), 0) INTO total
  FROM ledger_entries WHERE tx_id = NEW.tx_id;

  IF total <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % does not sum to zero (sum = %)', NEW.tx_id, total
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_ledger_balanced();

-- A ledger transaction with no entries at all is also invalid.
CREATE FUNCTION assert_ledger_tx_nonempty() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ledger_entries WHERE tx_id = NEW.id) THEN
    RAISE EXCEPTION 'ledger transaction % has no entries', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_transactions_nonempty
  AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_ledger_tx_nonempty();

-- Singleton house accounts.
INSERT INTO accounts (kind) VALUES ('house_rake'), ('house_dust'), ('hot_wallet');
