CREATE TYPE deposit_status AS ENUM ('PENDING', 'CREDITED');
CREATE TYPE signer_job_status AS ENUM ('PENDING', 'CLAIMED', 'DONE', 'FAILED');

CREATE TABLE deposit_addresses (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  derivation_index INTEGER NOT NULL UNIQUE CHECK (derivation_index >= 0),
  address          TEXT NOT NULL UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE deposits (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_hash       TEXT NOT NULL,
  log_index     INTEGER NOT NULL,
  address       TEXT NOT NULL REFERENCES deposit_addresses(address) ON DELETE RESTRICT,
  from_address  TEXT NOT NULL,
  amount        BIGINT NOT NULL CHECK (amount > 0),
  block_number  BIGINT NOT NULL,
  status        deposit_status NOT NULL DEFAULT 'PENDING',
  ledger_tx_id  UUID REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  credited_at   TIMESTAMPTZ,
  CONSTRAINT deposits_chain_uq UNIQUE (tx_hash, log_index),
  CONSTRAINT deposits_credited_has_ledger CHECK (
    (status = 'CREDITED' AND ledger_tx_id IS NOT NULL AND credited_at IS NOT NULL)
    OR (status = 'PENDING' AND ledger_tx_id IS NULL AND credited_at IS NULL)
  )
);

CREATE INDEX deposits_status_idx  ON deposits (status);
CREATE INDEX deposits_address_idx ON deposits (address);

CREATE TABLE signer_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload         JSONB NOT NULL,
  status          signer_job_status NOT NULL DEFAULT 'PENDING',
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  tx_hash         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ
);

CREATE INDEX signer_jobs_status_idx ON signer_jobs (status, created_at);

-- Named high-water marks so the poller need not rescan from genesis.
CREATE TABLE chain_cursors (
  name       TEXT PRIMARY KEY,
  value      BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
