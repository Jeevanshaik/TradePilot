// ─────────────────────────────────────────────────────────────────────────────
// GET /api/trade/signal
//
// Called every 15 minutes by cron-job.org (free external cron).
// Fetches 15m NIFTY + BANKNIFTY candles from Kite, calculates EMA 9/21,
// fires /api/webhook/trading automatically on crossover.
//
// Authorization: Bearer <CRON_SECRET>
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "@supabase/supabase-js";

// ── Instruments ───────────────────────────────────────────────────────────────
const INSTRUMENTS = [
  { token: 256265,  symbol: "NIFTY",     lots: 1 },
  { token: 260105,  symbol: "BANKNIFTY", lots: 1 },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function nowIST() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}

function isTradingTime() {
  const t   = nowIST();
  const day = t.getDay();
  if (day === 0 || day === 6) return { ok: false, reason: "Weekend" };
  const mins  = t.getHours() * 60 + t.getMinutes();
  const open  = 9 * 60 + 30;
  const close = 15 * 60 + 20;
  if (mins < open)  return { ok: false, reason: "Before 9:30 AM IST" };
  if (mins > close) return { ok: false, reason: "After 3:20 PM IST" };
  return { ok: true };
}

function nextExpiry() {
  const t   = nowIST();
  const day = t.getDay(); // 4 = Thursday
  // Always use NEXT Thursday (avoid same-day expiry)
  const daysAhead = day === 4 ? 7 : (4 - day + 7) % 7;
  const exp = new Date(t);
  exp.setDate(t.getDate() + daysAhead);
  return exp.toISOString().slice(0, 10);
}

// ── EMA ───────────────────────────────────────────────────────────────────────
function ema(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let val  = prices.slice(0, period).reduce((s, p) => s + p, 0) / period;
  for (let i = period; i < prices.length; i++) val = prices[i] * k + val * (1 - k);
  return val;
}

// ── Kite candles ──────────────────────────────────────────────────────────────
async function fetchCandles(token, apiKey, accessToken) {
  const to   = new Date();
  const from = new Date(to - 3 * 24 * 60 * 60 * 1000); // 3 days back (enough for EMA seed)

  const fmt = d => d.toISOString().slice(0, 19).replace("T", " ");
  const url  = `https://api.kite.trade/instruments/historical/${token}/15minute?from=${encodeURIComponent(fmt(from))}&to=${encodeURIComponent(fmt(to))}&oi=0`;

  const r    = await fetch(url, {
    headers: {
      "X-Kite-Version": "3",
      Authorization: `token ${apiKey}:${accessToken}`,
    },
  });
  const data = await r.json();
  if (data.status !== "success") throw new Error(data.message || "Kite candles failed");
  return data.data.candles; // [timestamp, o, h, l, close, volume]
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "GET or POST only" });
  }

  // Auth
  const secret = process.env.CRON_SECRET || "";
  const auth   = (req.headers["authorization"] || "").replace("Bearer ", "");
  if (secret && auth !== secret) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  // Trading hours check
  const timeCheck = isTradingTime();
  if (!timeCheck.ok) {
    return res.status(200).json({ ok: false, skipped: true, reason: timeCheck.reason });
  }

  // Kite session
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: session } = await sb
    .from("kite_session")
    .select("api_key, access_token")
    .eq("id", 1)
    .maybeSingle();

  if (!session?.access_token) {
    return res.status(200).json({ ok: false, error: "No Kite session — refresh token at dashboard" });
  }

  const expiry  = nextExpiry();
  const baseUrl = "https://trade-pilot-beige.vercel.app";
  const results = [];

  for (const inst of INSTRUMENTS) {
    try {
      const candles = await fetchCandles(inst.token, session.api_key, session.access_token);

      // Drop the current (incomplete) candle; need min 30 closed candles
      const closed = candles.slice(0, -1);
      if (closed.length < 30) {
        results.push({ symbol: inst.symbol, skipped: true, reason: "Not enough candles" });
        continue;
      }

      const closes   = closed.map(c => c[4]);
      const prevClose = closes.slice(0, -1);

      const e9p  = ema(prevClose, 9);
      const e21p = ema(prevClose, 21);
      const e9c  = ema(closes, 9);
      const e21c = ema(closes, 21);

      if (!e9p || !e21p || !e9c || !e21c) {
        results.push({ symbol: inst.symbol, skipped: true, reason: "EMA calc failed" });
        continue;
      }

      const price = closes[closes.length - 1];
      let signal  = null;

      if (e9p <= e21p && e9c > e21c) {
        signal = { action: "BUY", strategy: "bull_put_spread",
          reason: `EMA9 ${e9c.toFixed(1)} crossed above EMA21 ${e21c.toFixed(1)}` };
      }
      if (e9p >= e21p && e9c < e21c) {
        signal = { action: "SELL", strategy: "bear_call_spread",
          reason: `EMA9 ${e9c.toFixed(1)} crossed below EMA21 ${e21c.toFixed(1)}` };
      }

      if (!signal) {
        results.push({ symbol: inst.symbol, signal: "none",
          ema9: e9c.toFixed(1), ema21: e21c.toFixed(1) });
        continue;
      }

      // Fire webhook
      const payload = {
        secret:   process.env.WEBHOOK_SECRET,
        action:   signal.action,
        symbol:   inst.symbol,
        strategy: signal.strategy,
        lots:     inst.lots,
        price,
        expiry,
        reason:   signal.reason,
      };

      const wh   = await fetch(`${baseUrl}/api/webhook/trading`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      });
      const whData = await wh.json();
      results.push({ symbol: inst.symbol, signal: signal.action, webhook: whData });

    } catch (err) {
      results.push({ symbol: inst.symbol, error: err.message });
    }
  }

  return res.status(200).json({
    ok: true,
    timestamp: nowIST().toISOString(),
    expiry,
    results,
  });
}
