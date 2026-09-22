-- Migration 018: Real user accounts (Part A of the multi-league accounts
-- foundation). Purely additive — no existing table is touched. Apply with:
--   npx wrangler d1 execute smbhl-rsvp --remote --file=./migrate-018.sql

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  email_verified_at TEXT,
  last_login_at TEXT,
  -- Bumped on logout (and would be bumped on a future password change) to
  -- invalidate every outstanding signed session cookie for this user. See
  -- src/auth.js's checkUserSession/invalidateAllSessions.
  session_epoch INTEGER NOT NULL DEFAULT 0
);

-- Fixed-window signup rate limiting (src/auth.js's checkSignupRateLimit).
CREATE TABLE IF NOT EXISTS signup_attempts (
  ip TEXT PRIMARY KEY,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);
