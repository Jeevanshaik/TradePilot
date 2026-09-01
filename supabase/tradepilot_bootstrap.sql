-- ═══════════════════════════════════════════════════════════════════════════
-- TradePilot — COMPLETE bootstrap for a fresh, dedicated Supabase project.
-- ONE paste into: Supabase Dashboard → SQL Editor → Run.
--
-- Creates every table the API uses (schemas match the code exactly) plus the
-- pg_cron scheduler. Safe to re-run (idempotent).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Zerodha session (single row, id always = 1) ───────────────────────────
CREATE TABLE IF NOT EXISTS kite_session (
  id           INTEGER PRIMARY KEY DEFAULT 1,
  api_key      TEXT,
  access_token TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT single_row CHECK (id = 1)
);
INSERT INTO kite_session (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── 2. Live trade log ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trades (
  id              UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ,
  symbol          TEXT,
  action          TEXT,
  lots            INTEGER,
  quantity        INTEGER,
  entry_price     NUMERIC(12,2),
  exit_price      NUMERIC(12,2),
  pnl             NUMERIC(12,2),
  status          TEXT DEFAULT 'open',
  reason          TEXT,
  strategy        TEXT,
  kite_order_id   TEXT,
  sl_order_id     TEXT,
  target_order_id TEXT,
  signal_data     JSONB
);
CREATE INDEX IF NOT EXISTS trades_created_at_idx ON trades (created_at DESC);
CREATE INDEX IF NOT EXISTS trades_status_idx     ON trades (status);

-- ── 3. Paper trades ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS paper_trades (
  id           UUID    DEFAULT gen_random_uuid() PRIMARY KEY,
  symbol       TEXT    NOT NULL,
  action       TEXT    NOT NULL,
  strategy     TEXT,
  entry_price  NUMERIC NOT NULL,
  exit_price   NUMERIC,
  lots         INTEGER DEFAULT 1,
  lot_size     INTEGER DEFAULT 75,
  pnl          NUMERIC,
  reason       TEXT,
  status       TEXT    DEFAULT 'open',
  entry_time   TIMESTAMPTZ DEFAULT NOW(),
  exit_time    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS paper_trades_status ON paper_trades(status);
CREATE INDEX IF NOT EXISTS paper_trades_symbol ON paper_trades(symbol, status);

-- ── 4. Daily strategy decision ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS day_strategy (
  id          TEXT PRIMARY KEY,           -- YYYY-MM-DD (IST)
  strategy    TEXT,
  vix         NUMERIC(6,2),
  price       NUMERIC(10,2),
  base        TEXT DEFAULT 'NIFTY',
  lots        INTEGER DEFAULT 1,
  event_day   BOOLEAN DEFAULT FALSE,
  expiry      TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── 5. RLS on (service key bypasses; browser gets nothing) ───────────────────
ALTER TABLE kite_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE trades       ENABLE ROW LEVEL SECURITY;
ALTER TABLE paper_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE day_strategy ENABLE ROW LEVEL SECURITY;

-- ── 6. Scheduler: 15-min engine scans + daily token refresh (UTC times) ──────
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.unschedule(jobname)
FROM cron.job
WHERE jobname IN ('alpha_signal_15min', 'kite_refresh_daily');

SELECT cron.schedule(
  'alpha_signal_15min',
  '*/15 4-9 * * 1-5',
  $$ SELECT net.http_get('https://project-tcc78.vercel.app/api/trade/signal') $$
);

SELECT cron.schedule(
  'kite_refresh_daily',
  '0 3 * * 1-5',
  $$ SELECT net.http_get('https://project-tcc78.vercel.app/api/kite/refresh') $$
);

-- ── 7. Verify: 4 tables + 2 cron jobs should appear below ────────────────────
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('kite_session','trades','paper_trades','day_strategy')
UNION ALL
SELECT jobname FROM cron.job WHERE jobname LIKE 'alpha%' OR jobname LIKE 'kite%';
