// ─────────────────────────────────────────────────────────────────────────────
// GET /api/trade/signal  —  Alpha Engine (v3)
//
// Ensemble alpha engine — every 15-min cycle:
//   1. Time window + weekend gate
//   2. Regime classification  (STORM / TREND_UP / TREND_DOWN / RANGE)
//      from India VIX + realized vol + ADX + EMA slope
//   3. Microstructure from current-month FUTURES book:
//      order-book imbalance (5-level), pending-flow imbalance, spread,
//      liquidity-vacuum detection, VPIN-lite flow toxicity
//   4. 7-component weighted ensemble score in [-1..+1]
//      (EMA structure, momentum, VWAP, ORB, OBI, flow, volume)
//      weights + threshold are regime-conditional
//   5. Bayesian-lite strategy weighting from realized paper-trade win rate
//   6. INTRADAY position management: stop-loss / target / signal-flip exits
//      every cycle (not just 3:20 PM)
//   7. Daily kill-switch: max loss + losing-streak circuit breaker
//
// ?dry=1 → runs the full pipeline on synthetic data (no Kite, no DB writes)
//          so the deployed engine can prove itself outside market hours.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "@supabase/supabase-js";
import { ema, rsi, adx, vwap, atr, emaSlope, realizedVol } from "../../lib/alpha/indicators.js";
import { fetchMicro, vpinLite }                            from "../../lib/alpha/microstructure.js";
import { classifyRegime, regimeWeights, regimeThreshold }  from "../../lib/alpha/regime.js";
import { componentScores, ensembleScore, decide }          from "../../lib/alpha/ensemble.js";
import { bayesFactor, killSwitch, manageOpenTrades, stopsFor } from "../../lib/alpha/risk.js";

const INSTRUMENTS = [
  { token: 256265,  symbol: "NIFTY",     lots: 1 },
  { token: 260105,  symbol: "BANKNIFTY", lots: 1 },
];
const VIX_TOKEN = 264969; // NSE:INDIA VIX

// ── IST helpers ───────────────────────────────────────────────────────────────
function nowIST() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}
function todayStr() { return nowIST().toISOString().slice(0, 10); }

function tradingWindow() {
  const t   = nowIST();
  const day = t.getDay();
  if (day === 0 || day === 6) return { ok: false, reason: "Weekend" };
  const m = t.getHours() * 60 + t.getMinutes();
  if (m < 9 * 60 + 45)                          return { ok: false, reason: "Opening chaos — wait until 9:45 AM" };
  if (m >= 11 * 60 + 30 && m < 12 * 60 + 30)   return { ok: false, reason: "Lunch chop — skip 11:30–12:30 PM" };
  if (m > 14 * 60 + 45)                         return { ok: false, reason: "Close rush — skip after 2:45 PM" };
  return { ok: true };
}

// NIFTY weekly expiry is TUESDAY (NSE single-expiry-day rule since Sep 2025)
function nextExpiry() {
  const t = nowIST();
  const d = t.getDay();
  const ahead = d === 2 ? 7 : (2 - d + 7) % 7;
  const e = new Date(t);
  e.setDate(t.getDate() + ahead);
  return e.toISOString().slice(0, 10);
}

// ── Kite candles ──────────────────────────────────────────────────────────────
async function fetchCandles(token, apiKey, accessToken, days = 5) {
  const to   = new Date();
  const from = new Date(to - days * 24 * 60 * 60 * 1000);
  const fmt  = d => d.toISOString().slice(0, 19).replace("T", " ");
  const url  = `https://api.kite.trade/instruments/historical/${token}/15minute` +
               `?from=${encodeURIComponent(fmt(from))}&to=${encodeURIComponent(fmt(to))}&oi=0`;
  const r    = await fetch(url, {
    headers: { "X-Kite-Version": "3", Authorization: `token ${apiKey}:${accessToken}` },
  });
  const data = await r.json();
  if (data.status !== "success") throw new Error(data.message || `Kite fetch failed (${token})`);
  return data.data.candles;
}

// ── Full per-instrument analysis (pure — no I/O besides inputs) ───────────────
function analyze({ symbol, closed, todayCandles, vixLevel, micro }) {
  const closes  = closed.map(c => c[4]);
  const volumes = closed.map(c => c[5]);
  const last    = closes[closes.length - 1];

  const e7c   = ema(closes, 7);
  const e21c  = ema(closes, 21);
  const e7p   = ema(closes.slice(0, -1), 7);
  const e21p  = ema(closes.slice(0, -1), 21);
  const rsiV  = rsi(closes, 7);
  const adxV  = adx(closed, 14);
  const atrV  = atr(closed, 14);
  const slope = emaSlope(closes, 21, 5);
  const rv    = realizedVol(closes, 26);
  const vwapV = vwap(todayCandles.slice(0, -1));
  const vpin  = vpinLite(closed, 20);

  const avgVol   = volumes.slice(-20).reduce((s, v) => s + v, 0) / 20;
  const lastVol  = volumes[volumes.length - 1];
  const volRatio = avgVol > 0 ? lastVol / avgVol : 1;
  const lastBar  = closed[closed.length - 1];
  const lastCandleDir = lastBar[4] > lastBar[1] ? 1 : lastBar[4] < lastBar[1] ? -1 : 0;

  const orbC  = todayCandles.slice(0, 2);
  const orbHi = orbC.length >= 2 ? Math.max(...orbC.map(c => c[2])) : null;
  const orbLo = orbC.length >= 2 ? Math.min(...orbC.map(c => c[3])) : null;

  const { regime, why: regimeWhy } = classifyRegime({ adx: adxV, slope, vix: vixLevel, rv });
  const weights   = regimeWeights(regime);
  const threshold = regimeThreshold(regime);

  const components = componentScores({
    closes, e7: e7c, e21: e21c, e7prev: e7p, e21prev: e21p,
    rsiV, vwapV, last, orbHi, orbLo, micro, vpin, volRatio, lastCandleDir,
  });
  const rawScore = ensembleScore(components, weights);

  return {
    symbol, last, regime, regimeWhy, weights, threshold, components, rawScore,
    vpin, atrV,
    state: {
      symbol,
      regime,
      score:  rawScore.toFixed(2),
      ema7:   e7c?.toFixed(1),  ema21: e21c?.toFixed(1),
      rsi:    rsiV?.toFixed(0), adx:   adxV?.toFixed(0),
      vwap:   vwapV?.toFixed(0), vix:  vixLevel?.toFixed(1),
      vol:    `${volRatio.toFixed(2)}x`,
      obi:    micro ? micro.obi.toFixed(2) : "n/a",
      flow:   micro ? micro.flowImb.toFixed(2) : "n/a",
      toxicity: vpin ? vpin.toxicity.toFixed(2) : "n/a",
      spread: micro ? `${micro.spreadBps}bps` : "n/a",
      components: Object.fromEntries(
        Object.entries(components).map(([k, v]) => [k, Math.round(v * 100) / 100])),
    },
  };
}

// ── Dry run: prove the deployed pipeline with synthetic data ─────────────────
function dryRun() {
  // Synthetic 60-bar uptrend with volume surge + last-2-bar ORB breakout
  const mk = (i, base) => {
    const drift = i * 14;
    const wave  = Math.sin(i / 4) * 22;
    const o = base + drift + wave, c = o + 12;
    return [`2026-09-01T${String(9 + Math.floor(i / 4)).padStart(2, "0")}:00:00`,
            o, c + 8, o - 8, c, 200000 + (i >= 58 ? 250000 : 0)];
  };
  const candles = Array.from({ length: 60 }, (_, i) => mk(i, 24000));
  const today   = candles.slice(-12);
  const micro   = { contract: "SYNTH", futPrice: 24900, obi: 0.42, flowImb: 0.31,
                    spreadBps: 1.2, liquidityVacuum: false, bidQty: 4200, askQty: 1700 };

  const a = analyze({ symbol: "NIFTY(dry)", closed: candles, todayCandles: today,
                      vixLevel: 13.5, micro });
  const verdict = decide(a.components, a.weights, a.threshold, 1, a.vpin);
  return {
    ok: true, dry: true,
    note: "Synthetic uptrend — engine should score bullish. No DB writes, no Kite calls.",
    regime: a.regime, regimeWhy: a.regimeWhy,
    rawScore: a.rawScore, threshold: a.threshold,
    components: a.state.components,
    verdict: verdict || "no-trade (below threshold)",
    pipeline: ["indicators ✓", "microstructure ✓", "regime ✓", "ensemble ✓", "decision ✓"],
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Auth
  const secret = process.env.CRON_SECRET || "";
  const auth   = (req.headers["authorization"] || "").replace("Bearer ", "");
  if (secret && auth !== secret) return res.status(401).json({ ok: false, error: "Unauthorized" });

  // Deployed-logic self-test — works nights/weekends, touches nothing
  if (req.query.dry === "1") return res.status(200).json(dryRun());

  // Time window
  const win = tradingWindow();
  if (!win.ok) return res.status(200).json({ ok: false, skipped: true, reason: win.reason });

  // Kite session
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: sess } = await sb
    .from("kite_session").select("api_key, access_token").eq("id", 1).maybeSingle();
  if (!sess?.access_token)
    return res.status(200).json({ ok: false, error: "No Kite session — connect Zerodha first" });

  const { api_key: apiKey, access_token: accessToken } = sess;
  const ist = nowIST();

  // ── India VIX (feeds regime; STORM regime blocks entries) ─────────────────
  let vixLevel = 15;
  try {
    const vixC = await fetchCandles(VIX_TOKEN, apiKey, accessToken, 2);
    vixLevel   = vixC[vixC.length - 2]?.[4] ?? 15;
  } catch (e) { console.warn(`[signal] VIX fetch: ${e.message}`); }

  // ── Daily kill-switch (once per run) ──────────────────────────────────────
  const maxLoss = parseInt(process.env.MAX_DAILY_LOSS || "3000");
  const ks      = await killSwitch(sb, `${todayStr()}T00:00:00+05:30`, maxLoss);

  const expiry  = nextExpiry();
  const today   = todayStr();
  const baseUrl = "https://trade-pilot-beige.vercel.app";
  // SAFETY: paper mode unless PAPER_TRADE is explicitly "false".
  // Real money requires a deliberate env-var change, never a missing one.
  const isPaper = process.env.PAPER_TRADE !== "false";
  const results = [];

  for (const inst of INSTRUMENTS) {
    try {
      const candles      = await fetchCandles(inst.token, apiKey, accessToken, 5);
      const todayCandles = candles.filter(c => c[0].startsWith(today));
      const closed       = candles.slice(0, -1); // exclude live candle

      if (closed.length < 40) {
        results.push({ symbol: inst.symbol, skipped: true, reason: "Insufficient history" });
        continue;
      }

      // Microstructure from the current-month futures book
      const micro = await fetchMicro(inst.symbol, ist, apiKey, accessToken);

      const a = analyze({ symbol: inst.symbol, closed, todayCandles, vixLevel, micro });

      // ── Intraday exit management FIRST (stop / target / signal flip) ──────
      const exits = isPaper
        ? await manageOpenTrades(sb, inst.symbol, a.last, a.rawScore)
        : [];

      // ── STORM regime: manage exits only, never open ───────────────────────
      if (a.regime === "STORM") {
        results.push({ ...a.state, signal: "none", exits, reason: `STORM regime — ${a.regimeWhy}` });
        continue;
      }

      // ── Kill-switch ───────────────────────────────────────────────────────
      if (ks.blocked) {
        results.push({ ...a.state, signal: "none", exits, reason: `Kill-switch: ${ks.why}` });
        continue;
      }

      // ── Execution-quality gate ────────────────────────────────────────────
      if (micro?.liquidityVacuum) {
        results.push({ ...a.state, signal: "none", exits, reason: "Liquidity vacuum — book too thin to trade" });
        continue;
      }
      if (micro && micro.spreadBps > 8) {
        results.push({ ...a.state, signal: "none", exits, reason: `Spread ${micro.spreadBps}bps too wide` });
        continue;
      }

      // ── Bayesian strategy weight from realized performance ────────────────
      const bf = await bayesFactor(sb, inst.symbol);

      // ── Ensemble decision ─────────────────────────────────────────────────
      const verdict = decide(a.components, a.weights, a.threshold, bf, a.vpin);

      if (!verdict) {
        results.push({ ...a.state, signal: "none", exits, bayes: bf });
        continue;
      }

      const { sl, tgt } = stopsFor(inst.symbol);
      const strategy = verdict.action === "BUY" ? "bull_put_spread" : "bear_call_spread";
      const reason   =
        `Alpha ${verdict.score >= 0 ? "+" : ""}${verdict.score} (${verdict.confidence}% conf, ` +
        `${verdict.agreeing}/7 agree) | ${a.regime} | bayes ${bf} | ` +
        `OBI ${a.state.obi} flow ${a.state.flow} tox ${a.state.toxicity} | SL ${sl}% TGT ${tgt}%`;

      // ── Paper trade logging ───────────────────────────────────────────────
      if (isPaper) {
        const { data: existing } = await sb
          .from("paper_trades").select("id")
          .eq("symbol", inst.symbol).eq("status", "open").maybeSingle();

        if (existing) {
          results.push({ ...a.state, signal: verdict.action, mode: "PAPER", exits,
                         note: "Already in open paper trade — skipped" });
          continue;
        }

        const LOT_SIZES = { NIFTY: 75, BANKNIFTY: 35, FINNIFTY: 40 };
        const lotSize   = LOT_SIZES[inst.symbol] || 75;

        const { error: insErr } = await sb.from("paper_trades").insert({
          symbol:      inst.symbol,
          action:      verdict.action,
          strategy,
          entry_price: a.last,
          lots:        inst.lots,
          lot_size:    lotSize,
          reason,
          status:      "open",
          entry_time:  new Date().toISOString(),
        });
        if (insErr) throw new Error(`paper insert failed: ${insErr.message}`);

        results.push({
          ...a.state, signal: verdict.action, mode: "PAPER", exits,
          confidence: verdict.confidence, bayes: bf,
          entry_price: a.last, lot_size: lotSize,
          note: `Paper ${verdict.action} @ ₹${a.last} | SL ${sl}% TGT ${tgt}% — managed every 15 min`,
        });
        continue;
      }

      // ── Live mode → webhook ───────────────────────────────────────────────
      const wh = await fetch(`${baseUrl}/api/webhook/trading`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret: process.env.WEBHOOK_SECRET,
          action: verdict.action, symbol: inst.symbol,
          strategy, lots: inst.lots,
          price: a.last, expiry, reason,
        }),
      });
      results.push({ ...a.state, signal: verdict.action, mode: "LIVE",
                     confidence: verdict.confidence, webhook: await wh.json() });

    } catch (err) {
      console.warn(`[signal] ${inst.symbol}: ${err.message}`);
      results.push({ symbol: inst.symbol, error: err.message });
    }
  }

  return res.status(200).json({
    ok: true, engine: "alpha-v3",
    timestamp: nowIST().toISOString(),
    vix: vixLevel.toFixed(1), expiry,
    killSwitch: ks.blocked ? ks.why : null,
    results,
  });
}
