-- ═══════════════════════════════════════════════════════════════════════════
-- TradePilot — Supabase Table Setup
-- Run this in: Supabase Dashboard → SQL Editor → New Query → Run
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Zerodha Kite session (single row — id always = 1) ─────────────────────
CREATE TABLE IF NOT EXISTS kite_session (
  id            integer PRIMARY KEY DEFAULT 1,
  api_key       text,
  api_secret    text,
  access_token  text,
  user_id       text,
  user_name     text,
  email         text,
  created_at    timestamptz DEFAULT now(),
  CONSTRAINT    single_row CHECK (id = 1)
);

-- ── 2. Trade log ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trades (
  id              uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz,

  -- Instrument
  symbol          text,                      -- e.g. NIFTY2461224200CE
  action          text,                      -- BUY | SELL
  lots            integer,
  quantity        integer,

  -- Prices
  entry_price     numeric(12, 2),
  exit_price      numeric(12, 2),
  pnl             numeric(12, 2),

  -- Status
  status          text DEFAULT 'open',       -- open | closed | rejected | skipped | failed
  reason          text,                      -- why rejected/skipped
  strategy        text,                      -- strategy name from signal

  -- Kite order IDs
  kite_order_id   text,
  sl_order_id     text,
  target_order_id text,

  -- Full TradingView payload (for debugging)
  signal_data     jsonb
);

-- Index for fast "today's trades" queries
CREATE INDEX IF NOT EXISTS trades_created_at_idx ON trades (created_at DESC);
CREATE INDEX IF NOT EXISTS trades_status_idx     ON trades (status);

-- ── 3. Row Level Security (allow service_role full access) ───────────────────
ALTER TABLE kite_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE trades        ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS automatically — no policy needed for server-side
-- If you want to view trades from the browser (future use), add a policy here.

-- ── 3. Daily strategy decision (one row per trading day) ────────────────────
CREATE TABLE IF NOT EXISTS day_strategy (
  id          text PRIMARY KEY,            -- YYYY-MM-DD (IST date)
  strategy    text,                        -- iron_condor | spread | strangle | no_trade
  vix         numeric(6, 2),
  price       numeric(10, 2),
  base        text DEFAULT 'NIFTY',
  lots        integer DEFAULT 1,
  event_day   boolean DEFAULT false,
  expiry      text,                        -- YYYY-MM-DD of next expiry
  updated_at  timestamptz DEFAULT now()
);

ALTER TABLE day_strategy ENABLE ROW LEVEL SECURITY;

-- ── 4. Verify tables created ─────────────────────────────────────────────────
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('kite_session', 'trades');
