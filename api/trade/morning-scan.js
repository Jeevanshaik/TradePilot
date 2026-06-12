// ═══════════════════════════════════════════════════════════════════════════
// GET /api/trade/morning-scan
//
// 🧠 THE BRAIN — Runs every trading day at 9:15 AM IST (03:45 UTC)
//
// What it does:
//   1. Fetches India VIX + Nifty/BankNifty price from Kite
//   2. Detects event days (RBI, Budget, expiry)
//   3. Selects the safest strategy for today
//   4. For Iron Condor: computes strikes + places all 4 legs immediately
//   5. For Strangle:    computes strikes + places both legs
//   6. For Spread:      saves plan only (TradingView confirms direction)
//   7. Saves decision + trades to Supabase
//
// ── Strategy Selection Logic ─────────────────────────────────────────────────
//   VIX < 13            → Iron Condor  (sell both sides, collect premium)
//   VIX 13–17           → Bull/Bear Spread (directional hedge, await signal)
//   VIX > 17            → Strangle Buy (both sides, expect big move)
//   Event day           → Strangle Buy (override, big move expected)
//   VIX data unavail    → Spread (safest fallback)
//
// ── Required Env Vars ────────────────────────────────────────────────────────
//   CRON_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY
//   TRADE_SYMBOL       = NIFTY or BANKNIFTY (default NIFTY)
//   LOTS               = 1 (default)
// ═══════════════════════════════════════════════════════════════════════════

import { createClient } from "@supabase/supabase-js";

// ── Supabase ──────────────────────────────────────────────────────────────────
const sb = () => createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function getKiteSession(supa) {
  const { data } = await supa
    .from("kite_session")
    .select("api_key, access_token")
    .eq("id", 1)
    .maybeSingle();
  return data;
}

function kiteHdr(session) {
  return {
    "X-Kite-Version": "3",
    "Authorization":  `token ${session.api_key}:${session.access_token}`,
  };
}

// ── Option symbol builder ─────────────────────────────────────────────────────
// Format: SYMBOL + YY + MonthCode + DD + Strike + CE/PE
// Month codes: 1-9 for Jan-Sep, O=Oct, N=Nov, D=Dec
function buildSymbol(base, expiry, strike, type) {
  const yy  = String(expiry.getFullYear()).slice(-2);
  const m   = expiry.getMonth() + 1;
  const dd  = String(expiry.getDate()).padStart(2, "0");
  const mon = m <= 9 ? String(m) : m === 10 ? "O" : m === 11 ? "N" : "D";
  return `${base}${yy}${mon}${dd}${strike}${type}`;
}

// ── Next expiry (Nifty=Thu, BankNifty=Wed) ────────────────────────────────────
function nextExpiry(base) {
  const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const targetDay = base === "BANKNIFTY" ? 3 : 4; // Wed=3, Thu=4
  let ahead = (targetDay - ist.getDay() + 7) % 7;
  if (ahead === 0) ahead = 7; // already expiry day → next week
  const exp = new Date(ist);
  exp.setDate(ist.getDate() + ahead);
  return exp;
}

// ── Days to expiry ────────────────────────────────────────────────────────────
function dte(base) {
  const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const exp = nextExpiry(base);
  return Math.max(1, Math.round((exp - ist) / 86400000));
}

// ── Round to nearest strike interval ─────────────────────────────────────────
function roundStrike(price, base) {
  const step = base === "BANKNIFTY" ? 100 : 50;
  return Math.round(price / step) * step;
}

// ── Kite: get index quote ─────────────────────────────────────────────────────
async function getQuote(session, instrument) {
  const url  = `https://api.kite.trade/quote?i=${encodeURIComponent(instrument)}`;
  const resp = await fetch(url, { headers: kiteHdr(session) });
  const data = await resp.json();
  return data?.data?.[instrument]?.last_price ?? null;
}

// ── Kite: place single order ──────────────────────────────────────────────────
async function placeOrder(session, params) {
  const resp = await fetch("https://api.kite.trade/orders/regular", {
    method:  "POST",
    headers: { ...kiteHdr(session), "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams(params),
  });
  const data = await resp.json();
  if (data.status !== "success") throw new Error(data.message || JSON.stringify(data));
  return data.data.order_id;
}

// ── Log trade to Supabase ─────────────────────────────────────────────────────
async function logTrade(supa, payload) {
  try {
    const { data } = await supa
      .from("trades")
      .insert({ ...payload, created_at: new Date().toISOString() })
      .select("id").single();
    return data?.id;
  } catch (_) { return null; }
}

// ── Save daily strategy decision ──────────────────────────────────────────────
async function saveDayStrategy(supa, payload) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    await supa.from("day_strategy").upsert({
      id:          today,
      ...payload,
      updated_at:  new Date().toISOString(),
    });
  } catch (_) {}
}

// ── Strategy selector ─────────────────────────────────────────────────────────
function selectStrategy(vix, isEventDay) {
  if (isEventDay)  return "strangle";   // event day → buy both sides
  if (!vix)        return "spread";     // VIX unavailable → safest fallback
  if (vix < 13)    return "iron_condor";
  if (vix <= 17)   return "spread";
  return "strangle";
}

// ── Known event dates (update quarterly) ─────────────────────────────────────
const EVENT_DATES = new Set([
  // RBI policy dates 2026 (add more as announced)
  "2026-06-06", "2026-08-06", "2026-10-07", "2026-12-05",
  // Budget
  "2026-07-01",
  // Add more: "YYYY-MM-DD"
]);

function isEventDay() {
  const ist  = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const key  = ist.toISOString().slice(0, 10);
  return EVENT_DATES.has(key);
}

// ═══════════════════════════════════════════════════════════════════════════
// Strategy Executors
// ═══════════════════════════════════════════════════════════════════════════

// ── Iron Condor ───────────────────────────────────────────────────────────────
// Sell OTM Call + Buy farther OTM Call (cap loss above)
// Sell OTM Put  + Buy farther OTM Put  (cap loss below)
// Max profit = net premium collected
// Max loss   = spread width – net premium (defined & small)
async function executeIronCondor(session, supa, price, vix, base, lots) {
  const exp       = nextExpiry(base);
  const days      = dte(base);
  const lotSize   = base === "BANKNIFTY" ? 35 : 75;
  const qty       = lotSize * lots;
  const step      = base === "BANKNIFTY" ? 100 : 50;

  // Expected weekly move = price × VIX% × √(days/365)
  const move      = price * (vix / 100) * Math.sqrt(days / 365);

  // Sell legs: 1.3σ away   — high probability OTM (~85% chance expiring worthless)
  const sellCall  = roundStrike(price + 1.3 * move, base);
  const sellPut   = roundStrike(price - 1.3 * move, base);

  // Buy legs (hedge): one spread-width further out
  const buyCall   = sellCall + step * 2;   // 100 pts above sell call
  const buyPut    = sellPut  - step * 2;   // 100 pts below sell put

  const callSellSym = buildSymbol(base, exp, sellCall, "CE");
  const callBuySym  = buildSymbol(base, exp, buyCall,  "CE");
  const putSellSym  = buildSymbol(base, exp, sellPut,  "PE");
  const putBuySym   = buildSymbol(base, exp, buyPut,   "PE");

  const results = [];
  const orderParams = (sym, txType) => ({
    tradingsymbol:    sym,
    exchange:         "NFO",
    transaction_type: txType,
    order_type:       "MARKET",
    quantity:         String(qty),
    product:          "NRML",   // NRML for overnight/spread positions
    validity:         "DAY",
    tag:              "tp_condor",
  });

  // Place all 4 legs
  const legs = [
    { sym: callSellSym, tx: "SELL", role: "sell_call" },
    { sym: callBuySym,  tx: "BUY",  role: "buy_call"  },
    { sym: putSellSym,  tx: "SELL", role: "sell_put"   },
    { sym: putBuySym,   tx: "BUY",  role: "buy_put"    },
  ];

  let totalOrders = 0;
  for (const leg of legs) {
    try {
      const orderId = await placeOrder(session, orderParams(leg.sym, leg.tx));
      await logTrade(supa, {
        symbol:        leg.sym,
        action:        leg.tx,
        lots,
        quantity:      qty,
        status:        "open",
        strategy:      `iron_condor_${leg.role}`,
        kite_order_id: orderId,
        signal_data:   { strategy: "iron_condor", vix, price, leg: leg.role },
      });
      results.push({ leg: leg.role, symbol: leg.sym, orderId, ok: true });
      totalOrders++;
    } catch (err) {
      results.push({ leg: leg.role, symbol: leg.sym, error: err.message, ok: false });
    }
  }

  const spread      = step * 2;                      // e.g. 100 pts
  const maxLossEst  = spread * qty * 0.6;            // rough estimate
  const maxProfEst  = spread * qty * 0.4;            // rough estimate

  return {
    strategy:    "iron_condor",
    legs:        results,
    symbols:     { callSellSym, callBuySym, putSellSym, putBuySym },
    strikes:     { sellCall, buyCall, sellPut, buyPut },
    maxLossEst:  Math.round(maxLossEst),
    maxProfEst:  Math.round(maxProfEst),
    ordersPlaced: totalOrders,
    message:     `✅ Iron Condor: ${totalOrders}/4 legs placed | Range ${sellPut}–${sellCall}`,
  };
}

// ── Strangle Buy ──────────────────────────────────────────────────────────────
// Buy OTM Call + Buy OTM Put
// Profits when market makes a BIG move in either direction
// Max loss = both premiums paid (happens only if market stays flat)
async function executeStrangle(session, supa, price, vix, base, lots) {
  const exp      = nextExpiry(base);
  const days     = dte(base);
  const lotSize  = base === "BANKNIFTY" ? 35 : 75;
  const qty      = lotSize * lots;

  const move     = price * (vix / 100) * Math.sqrt(days / 365);

  // Strike 1σ OTM for strangle
  const callStrike = roundStrike(price + 0.8 * move, base);
  const putStrike  = roundStrike(price - 0.8 * move, base);

  const callSym  = buildSymbol(base, exp, callStrike, "CE");
  const putSym   = buildSymbol(base, exp, putStrike,  "PE");

  const results  = [];
  for (const [sym, label] of [[callSym, "call"], [putSym, "put"]]) {
    try {
      const orderId = await placeOrder(session, {
        tradingsymbol:    sym,
        exchange:         "NFO",
        transaction_type: "BUY",
        order_type:       "MARKET",
        quantity:         String(qty),
        product:          "MIS",
        validity:         "DAY",
        tag:              "tp_strangle",
      });
      await logTrade(supa, {
        symbol:        sym,
        action:        "BUY",
        lots,
        quantity:      qty,
        status:        "open",
        strategy:      `strangle_${label}`,
        kite_order_id: orderId,
        signal_data:   { strategy: "strangle", vix, price },
      });
      results.push({ label, symbol: sym, orderId, ok: true });
    } catch (err) {
      results.push({ label, symbol: sym, error: err.message, ok: false });
    }
  }

  return {
    strategy:    "strangle",
    legs:        results,
    symbols:     { callSym, putSym },
    strikes:     { callStrike, putStrike },
    message:     `✅ Strangle: bought ${callSym} + ${putSym}`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Main Handler
// ═══════════════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();

  // Auth
  const cronSecret = process.env.CRON_SECRET || "";
  if (cronSecret) {
    const token = (req.headers.authorization || "").replace("Bearer ", "").trim()
                || req.query.secret || "";
    if (token !== cronSecret) return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const supa    = sb();
  const session = await getKiteSession(supa);

  if (!session?.access_token) {
    return res.status(200).json({ ok: false, message: "Kite not connected — skipping scan" });
  }

  try {
    const base  = (process.env.TRADE_SYMBOL || "NIFTY").toUpperCase();
    const lots  = parseInt(process.env.LOTS || "1");
    const kiteInstrument = base === "BANKNIFTY" ? "NSE:NIFTY BANK" : "NSE:NIFTY 50";

    // Fetch VIX and index price in parallel
    const [vix, price] = await Promise.all([
      getQuote(session, "NSE:INDIA VIX"),
      getQuote(session, kiteInstrument),
    ]);

    console.log(`[morning-scan] VIX=${vix} | ${base}=${price} | base=${base}`);

    const eventDay = isEventDay();
    const strategy = selectStrategy(vix, eventDay);

    // Save decision to DB (so dashboard can read it)
    await saveDayStrategy(supa, {
      strategy,
      vix,
      price,
      base,
      lots,
      event_day: eventDay,
      expiry:    nextExpiry(base).toISOString().slice(0, 10),
    });

    // Execute
    let result = {};
    if (strategy === "iron_condor") {
      result = await executeIronCondor(session, supa, price, vix, base, lots);
    } else if (strategy === "strangle") {
      result = await executeStrangle(session, supa, price, vix, base, lots);
    } else {
      // Spread: save plan, wait for TradingView direction signal
      result = {
        strategy: "spread",
        message:  "📡 Spread selected — awaiting direction signal from TradingView strategy",
        vix, price, base,
        expiry:   nextExpiry(base).toISOString().slice(0, 10),
      };
    }

    return res.status(200).json({
      ok: true,
      vix,
      price,
      base,
      eventDay,
      ...result,
    });

  } catch (err) {
    console.error("[morning-scan]", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
