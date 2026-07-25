CREATE TYPE withdrawal_status AS ENUM (
  'REQUESTED', 'APPROVED', 'BROADCAST', 'CONFIRMED', 'REJECTED', 'CANCELLED', 'FAILED'
);

CREATE TABLE withdrawal_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  address       TEXT NOT NULL,
  amount        BIGINT NOT NULL CHECK (amount > 0),
  status        withdrawal_status NOT NULL DEFAULT 'REQUESTED',
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by   UUID REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at   TIMESTAMPTZ,
  review_note   TEXT,
  signer_job_id UUID REFERENCES signer_jobs(id) ON DELETE RESTRICT,
  tx_hash       TEXT,
  broadcast_at  TIMESTAMPTZ,
  confirmed_at  TIMESTAMPTZ,
  failure_reason TEXT,
  CONSTRAINT withdrawals_reviewed_together CHECK (
    (reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);

CREATE INDEX withdrawals_status_idx ON withdrawal_requests (status, requested_at);
CREATE INDEX withdrawals_user_idx   ON withdrawal_requests (user_id, requested_at DESC);
