-- Paper trades table for simulated trading
CREATE TABLE IF NOT EXISTS paper_trades (
  id           UUID    DEFAULT gen_random_uuid() PRIMARY KEY,
  symbol       TEXT    NOT NULL,
  action       TEXT    NOT NULL,   -- BUY or SELL
  strategy     TEXT,
  entry_price  NUMERIC NOT NULL,
  exit_price   NUMERIC,
  lots         INTEGER DEFAULT 1,
  lot_size     INTEGER DEFAULT 75,
  pnl          NUMERIC,
  reason       TEXT,
  status       TEXT    DEFAULT 'open',   -- open | closed
  entry_time   TIMESTAMPTZ DEFAULT NOW(),
  exit_time    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS paper_trades_status ON paper_trades(status);
CREATE INDEX IF NOT EXISTS paper_trades_symbol ON paper_trades(symbol, status);
