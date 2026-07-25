CREATE TYPE fight_status  AS ENUM ('DRAFT', 'OPEN', 'LOCKED', 'SETTLED', 'VOIDED');
CREATE TYPE fight_outcome AS ENUM ('A', 'B', 'VOID');
CREATE TYPE bet_side      AS ENUM ('A', 'B');

CREATE TABLE fights (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_name      TEXT NOT NULL,
  fighter_a        TEXT NOT NULL,
  fighter_b        TEXT NOT NULL,
  stream_embed_url TEXT,
  status           fight_status NOT NULL DEFAULT 'DRAFT',
  lock_at          TIMESTAMPTZ NOT NULL,
  rake_bps         INTEGER NOT NULL DEFAULT 500 CHECK (rake_bps >= 0 AND rake_bps <= 2000),
  outcome          fight_outcome,
  created_by       UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at       TIMESTAMPTZ,
  CONSTRAINT fights_outcome_matches_status CHECK (
    (status = 'SETTLED' AND outcome IN ('A', 'B'))
    OR (status = 'VOIDED' AND outcome = 'VOID')
    OR (status IN ('DRAFT', 'OPEN', 'LOCKED') AND outcome IS NULL)
  )
);

CREATE INDEX fights_status_idx ON fights (status, lock_at);

ALTER TABLE accounts
  ADD CONSTRAINT accounts_fight_fk FOREIGN KEY (fight_id) REFERENCES fights(id) ON DELETE RESTRICT;

CREATE TABLE bets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fight_id        UUID NOT NULL REFERENCES fights(id) ON DELETE RESTRICT,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  side            bet_side NOT NULL,
  stake           BIGINT NOT NULL CHECK (stake >= 1000000),
  idempotency_key TEXT NOT NULL UNIQUE,
  payout          BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX bets_fight_idx ON bets (fight_id);
CREATE INDEX bets_user_idx  ON bets (user_id, created_at DESC);

CREATE TABLE settlements (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fight_id     UUID NOT NULL UNIQUE REFERENCES fights(id) ON DELETE RESTRICT,
  outcome      fight_outcome NOT NULL,
  pool_total   BIGINT NOT NULL,
  winning_pool BIGINT NOT NULL,
  rake         BIGINT NOT NULL,
  dust         BIGINT NOT NULL,
  refunded     BOOLEAN NOT NULL,
  settled_by   UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  settled_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
