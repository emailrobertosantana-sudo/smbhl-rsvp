-- Migration 056: Notre Ligue billing (Stripe), batch 1 of 3.
--
-- Additive only: three new tables, no change to an existing table, no
-- foreign key (D1 enforces them, and code that predates this migration
-- deletes leagues without knowing these tables). Old code never reads
-- them. A league with no league_billing row is "not yet counted"; its
-- trial is computed from leagues.created_at and BILLING_LAUNCH_AT, so no
-- backfill is needed. While BILLING_LAUNCH_AT is unset nothing is gated,
-- no notice is sent and Stripe is never called.
--
-- Apply with:
--   npx wrangler d1 execute notreligue-demo --env demo --remote --file=./migrate-056.sql
--   (production: npx wrangler d1 execute smbhl-rsvp --remote --file=./migrate-056.sql)
--   Apply BEFORE deploying the code that reads it, on BOTH databases: the
--   schema guard checks the same manifest on both workers and refuses to
--   serve (503) and skips the cron until the tables exist.

-- One row per league, written by the regular-player count refresh and by
-- the Stripe webhook. SMBHL never has one.
CREATE TABLE IF NOT EXISTS league_billing (
  league_id              TEXT PRIMARY KEY,
  owner_user_id          TEXT,                 -- leagues.created_by at first write: the account the free slot belongs to
  stripe_customer_id     TEXT,                 -- cus_...
  stripe_subscription_id TEXT,                 -- sub_...
  stripe_price_id        TEXT,                 -- the subscription item's price now
  tier                   TEXT NOT NULL DEFAULT 'free',   -- billed tier: free | standard | plus | custom
  billing_interval       TEXT,                 -- month | year | NULL
  stripe_status          TEXT,                 -- Stripe's own status: active, past_due, unpaid, canceled, paused, ...
  status                 TEXT NOT NULL DEFAULT 'trial',  -- the app's: trial | free | active | past_due | paused | inactive
  trial_started_at       TEXT,
  trial_ends_at          TEXT,
  current_period_end     TEXT,
  cancel_at_period_end   INTEGER NOT NULL DEFAULT 0,
  paused_at              TEXT,                 -- monthly pause (pause_collection) started
  grace_ends_at          TEXT,                 -- a free league reached 15: the end of its 14 days to subscribe
  read_only_since        TEXT,
  emails_paused_since    TEXT,
  inactive_since         TEXT,                 -- unpaid or cancelled: starts the 12-month clock
  last_paid_at           TEXT,                 -- last invoice paid with an amount above 0
  regular_count          INTEGER,              -- regular players with an email address (src/billing.js)
  regular_count_at       TEXT,
  count_tier             TEXT,                 -- the tier the count implies
  pending_tier           TEXT,                 -- the tier to apply at the next billing date
  free_exception         INTEGER NOT NULL DEFAULT 0,  -- super-admin: free even when the owner already has a free league
  billing_exempt         INTEGER NOT NULL DEFAULT 0,  -- super-admin: never billed
  last_stripe_event_at   INTEGER,              -- created time of the last Stripe event applied (diagnostic)
  updated_at             TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_league_billing_sub ON league_billing(stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_league_billing_customer ON league_billing(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_league_billing_owner ON league_billing(owner_user_id);

-- Each Stripe webhook event, once (its id). No payload is kept: the
-- handler fetches the current object from Stripe.
CREATE TABLE IF NOT EXISTS stripe_events (
  id            TEXT PRIMARY KEY,               -- evt_...
  type          TEXT NOT NULL,
  league_id     TEXT,
  object_id     TEXT,                           -- sub_..., in_..., ch_..., cs_...
  created       INTEGER,                        -- the event's created time (unix seconds)
  received_at   TEXT NOT NULL,
  processed_at  TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  error         TEXT
);

-- Billing notices sent once (batch 3): trial, grace, tier, deletion and
-- payment notices. The outbox's dedup_key cancels and re-inserts pending
-- rows, it never blocks a second send, so once-only mail keeps its own
-- record.
CREATE TABLE IF NOT EXISTS billing_notices (
  league_id   TEXT NOT NULL,
  kind        TEXT NOT NULL,                    -- trial_7d | trial_end | grace_start | grace_end | tier_up | deletion_30d | deletion_7d | payment_failed
  period_key  TEXT NOT NULL,                    -- the trial end, grace end, inactive_since or invoice it is about
  sent_at     TEXT NOT NULL,
  PRIMARY KEY (league_id, kind, period_key)
);
