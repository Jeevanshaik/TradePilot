// ─────────────────────────────────────────────────────────────────────────────
// POST /api/webhook/trading
//
// Receives alerts from TradingView Pine Script and auto-executes on Zerodha.
//
// ── TradingView Alert Message (JSON) ────────────────────────────────────────
// Paste this in your TradingView Alert → Message box:
//
// {
//   "secret":       "{{YOUR_WEBHOOK_SECRET}}",
//   "action":       "BUY",
//   "tradingsymbol":"NIFTY2461224200CE",
//   "symbol":       "NIFTY",
//   "lots":         1,
//   "price":        {{close}},
//   "reason":       "EMA crossover"
// }
//
// action values:
//   "BUY"  → buy a new position (CE/PE option)
//   "SELL" → exit/close existing position
//
// ── Required Env Vars (set in Vercel dashboard) ──────────────────────────────
//   WEBHOOK_SECRET        — any string you choose (must match TradingView alert)
//   SUPABASE_URL          — your Supabase project URL
//   SUPABASE_SERVICE_KEY  — Supabase service_role key (server-side only)
//   MAX_DAILY_LOSS        — max loss per day in ₹ (default 3000)
//   MAX_TRADES_PER_DAY    — max trades per day (default 3)
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "@supabase/supabase-js";

// ── Supabase client (server-side service key) ────────────────────────────────
function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("Supabase env vars missing");
  return createClient(url, key);
}

// ── IST helpers ───────────────────────────────────────────────────────────────
function nowIST() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}

function isTradingTime() {
  const t   = nowIST();
  const day = t.getDay(); // 0=Sun 6=Sat
  if (day === 0 || day === 6) return { ok: false, reason: "Weekend — market closed" };

  const mins  = t.getHours() * 60 + t.getMinutes();
  const open  = 9 * 60 + 15;   // 9:15 AM
  const close = 15 * 60 + 20;  // 3:20 PM

  if (mins < open)  return { ok: false, reason: "Market not opened yet (before 9:15 AM)" };
  if (mins > close) return { ok: false, reason: "Market closed (after 3:20 PM)" };
  if (mins < open + 15) return { ok: false, reason: "Skipping opening 15 min volatility (9:15–9:30)" };

  return { ok: true };
}

function todayStartISO() {
  const t = nowIST();
  const d = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  return `${d}T00:00:00+05:30`;
}

// ── Zerodha Kite order placement ─────────────────────────────────────────────
async function getKiteSession(sb) {
  const { data } = await sb
    .from("kite_session")
    .select("api_key, access_token, user_name")
    .eq("id", 1)
    .maybeSingle();
  return data;
}

async function placeKiteOrder(session, params) {
  const resp = await fetch("https://api.kite.trade/orders/regular", {
    method: "POST",
    headers: {
      "X-Kite-Version": "3",
      Authorization: `token ${session.api_key}:${session.access_token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });
  const data = await resp.json();
  if (data.status !== "success") {
    throw new Error(data.message || `Kite error: ${JSON.stringify(data)}`);
  }
  return data.data.order_id;
}

// ── Option symbol builder (matches Zerodha NSE weekly format) ────────────────
// Format: SYMBOL + YY + MonthCode(1-9/O/N/D) + DD + Strike + CE/PE
function buildOptionSymbol(base, expiryDateStr, strike, type) {
  const d   = new Date(expiryDateStr);
  const yy  = String(d.getFullYear()).slice(-2);
  const m   = d.getMonth() + 1;
  const dd  = String(d.getDate()).padStart(2, "0");
  const mon = m <= 9 ? String(m) : m === 10 ? "O" : m === 11 ? "N" : "D";
  return `${base}${yy}${mon}${dd}${strike}${type}`;
}

function roundStrike(price, base) {
  const step = base === "BANKNIFTY" ? 100 : 50;
  return Math.round(price / step) * step;
}

// ── Spread handler (Bull Put / Bear Call) ─────────────────────────────────────
// Bull Put Spread : Sell ATM-50 Put  + Buy ATM-150 Put  (bullish, defined risk)
// Bear Call Spread: Sell ATM+50 Call + Buy ATM+150 Call (bearish, defined risk)
async function handleSpread(req, res, sb, session, body, baseSymbol, lots, quantity) {
  const isBull       = (body.strategy || "").toLowerCase() === "bull_put_spread";
  const price        = parseFloat(body.price || "0");
  const expiryDate   = body.expiry || new Date().toISOString().slice(0, 10);
  const spreadWidth  = parseInt(body.spread_width || "100");
  const atm          = roundStrike(price, baseSymbol);
  const step         = baseSymbol === "BANKNIFTY" ? 100 : 50;

  let sellStrike, buyStrike, optType;
  if (isBull) {
    // Bull Put Spread: sell slightly OTM put, buy further OTM put
    sellStrike = atm - step;          // e.g. 24150 (1 step below ATM)
    buyStrike  = atm - step - spreadWidth; // e.g. 24050 (protection)
    optType    = "PE";
  } else {
    // Bear Call Spread: sell slightly OTM call, buy further OTM call
    sellStrike = atm + step;          // e.g. 24250 (1 step above ATM)
    buyStrike  = atm + step + spreadWidth; // e.g. 24350 (protection)
    optType    = "CE";
  }

  const sellSym = buildOptionSymbol(baseSymbol, expiryDate, sellStrike, optType);
  const buySym  = buildOptionSymbol(baseSymbol, expiryDate, buyStrike,  optType);

  const orderBase = {
    exchange:  "NFO",
    order_type:"MARKET",
    quantity:  String(quantity),
    product:   "NRML",
    validity:  "DAY",
    tag:       "tp_spread",
  };

  const results = [];
  for (const [sym, tx] of [[sellSym, "SELL"], [buySym, "BUY"]]) {
    try {
      const orderId = await placeKiteOrder(session, { ...orderBase, tradingsymbol: sym, transaction_type: tx });
      await logTrade(sb, {
        symbol: sym, action: tx, lots, quantity,
        status: "open",
        strategy: body.strategy,
        kite_order_id: orderId,
        signal_data: body,
      });
      results.push({ symbol: sym, tx, orderId, ok: true });
    } catch (err) {
      results.push({ symbol: sym, tx, error: err.message, ok: false });
    }
  }

  const placed  = results.filter(r => r.ok).length;
  const maxLoss = spreadWidth * quantity;    // worst case = full spread width
  const maxProf = Math.round(maxLoss * 0.5); // rough estimate (depends on premium collected)

  return res.status(200).json({
    ok:      placed > 0,
    message: `${isBull ? "Bull Put" : "Bear Call"} Spread — ${placed}/2 legs placed`,
    strategy: body.strategy,
    legs:    results,
    strikes: { sellStrike, buyStrike, optType },
    maxLoss, maxProf,
    tradesLeftToday: Math.max(0, parseInt(process.env.MAX_TRADES_PER_DAY || "3") - 1),
  });
}

// ── Trade logger ──────────────────────────────────────────────────────────────
async function logTrade(sb, payload) {
  try {
    const { data } = await sb
      .from("trades")
      .insert({ ...payload, created_at: new Date().toISOString() })
      .select("id")
      .single();
    return data?.id;
  } catch (_) {
    return null;
  }
}

// ── Lot sizes (SEBI 2025 revised) ────────────────────────────────────────────
const LOT_SIZES = {
  NIFTY:     75,
  BANKNIFTY: 35,
  FINNIFTY:  40,
  MIDCPNIFTY: 75,
};

// ─────────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Webhook-Secret");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")    return res.status(405).json({ ok: false, error: "POST only" });

  let sb;
  try { sb = getSupabase(); } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }

  const body = req.body || {};
  const SECRET = process.env.WEBHOOK_SECRET || "";

  // ── 1. Validate secret ────────────────────────────────────────────────────
  if (!SECRET || body.secret !== SECRET) {
    await logTrade(sb, { status: "rejected", reason: "Invalid secret", signal_data: body });
    return res.status(401).json({ ok: false, error: "Unauthorized — wrong webhook secret" });
  }

  // ── 2. Trading time check ─────────────────────────────────────────────────
  const timeCheck = isTradingTime();
  if (!timeCheck.ok) {
    await logTrade(sb, { status: "skipped", reason: timeCheck.reason, signal_data: body });
    return res.status(200).json({ ok: false, skipped: true, reason: timeCheck.reason });
  }

  // ── 3. Daily loss limit ───────────────────────────────────────────────────
  const maxLoss   = parseInt(process.env.MAX_DAILY_LOSS     || "3000");
  const maxTrades = parseInt(process.env.MAX_TRADES_PER_DAY || "3");

  const { data: todayRows } = await sb
    .from("trades")
    .select("pnl, status")
    .gte("created_at", todayStartISO())
    .in("status", ["open", "closed", "filled"]);

  const todayPnl    = (todayRows || []).reduce((s, t) => s + (t.pnl || 0), 0);
  const todayCount  = (todayRows || []).filter(t => ["open", "closed", "filled"].includes(t.status)).length;

  if (todayPnl <= -maxLoss) {
    await logTrade(sb, { status: "rejected", reason: `Daily loss limit ₹${maxLoss} hit`, signal_data: body });
    return res.status(200).json({ ok: false, skipped: true, reason: `Daily loss limit hit (₹${Math.abs(todayPnl)} lost today)` });
  }

  if (todayCount >= maxTrades) {
    await logTrade(sb, { status: "rejected", reason: `Max ${maxTrades} trades/day reached`, signal_data: body });
    return res.status(200).json({ ok: false, skipped: true, reason: `Max ${maxTrades} trades/day already taken` });
  }

  // ── 4. Parse signal ───────────────────────────────────────────────────────
  const action        = (body.action || "").toUpperCase();
  const strategyType  = (body.strategy || "").toLowerCase(); // bull_put_spread | bear_call_spread | simple
  const tradingsymbol = (body.tradingsymbol || "").trim();
  const baseSymbol    = (body.symbol || "NIFTY").toUpperCase();
  const lots          = Math.max(1, parseInt(body.lots || "1"));

  if (!["BUY", "SELL", "EXIT"].includes(action)) {
    return res.status(400).json({ ok: false, error: `Invalid action "${action}". Use BUY, SELL or EXIT.` });
  }

  const lotSize  = LOT_SIZES[baseSymbol] || 75;
  const quantity = lotSize * lots;

  // ── 5. Get Kite session ───────────────────────────────────────────────────
  const session = await getKiteSession(sb);
  if (!session?.access_token) {
    await logTrade(sb, { status: "rejected", reason: "Kite not connected", signal_data: body });
    return res.status(200).json({ ok: false, skipped: true, reason: "Zerodha not connected — go to Setup tab" });
  }

  // ── 6. Route to correct strategy handler ─────────────────────────────────
  if (strategyType === "bull_put_spread" || strategyType === "bear_call_spread") {
    return handleSpread(req, res, sb, session, body, baseSymbol, lots, quantity);
  }

  // ── Simple single-leg trade ───────────────────────────────────────────────
  if (!tradingsymbol) {
    return res.status(400).json({
      ok: false,
      error: 'tradingsymbol is required. Example: "NIFTY2461224200CE"',
    });
  }

  const txType = (action === "BUY") ? "BUY" : "SELL";

  // ── 7. Place order ────────────────────────────────────────────────────────
  let orderId;
  try {
    orderId = await placeKiteOrder(session, {
      tradingsymbol,
      exchange:         "NFO",
      transaction_type: txType,
      order_type:       "MARKET",
      quantity:         String(quantity),
      product:          "MIS",
      validity:         "DAY",
      tag:              "tradepilot",
    });
  } catch (err) {
    await logTrade(sb, {
      status: "failed", reason: err.message,
      symbol: tradingsymbol, action: txType,
      lots, quantity, signal_data: body,
    });
    return res.status(200).json({ ok: false, error: `Order failed: ${err.message}` });
  }

  // ── 8. Auto stop-loss (BUY trades only) ──────────────────────────────────
  let slOrderId = null;
  if (txType === "BUY" && body.price) {
    try {
      const premium   = parseFloat(body.price);
      const slPct     = parseFloat(body.stop_loss_pct || "40") / 100;
      const slTrigger = Math.round(premium * (1 - slPct) * 100) / 100;
      slOrderId = await placeKiteOrder(session, {
        tradingsymbol,
        exchange:         "NFO",
        transaction_type: "SELL",
        order_type:       "SL-M",
        quantity:         String(quantity),
        product:          "MIS",
        validity:         "DAY",
        trigger_price:    String(slTrigger),
        tag:              "tradepilot_sl",
      });
    } catch (slErr) {
      console.warn("[webhook] SL order failed:", slErr.message);
    }
  }

  // ── 9. Log the trade ──────────────────────────────────────────────────────
  const tradeId = await logTrade(sb, {
    symbol:         tradingsymbol,
    action:         txType,
    lots,
    quantity,
    entry_price:    body.price ? parseFloat(body.price) : null,
    status:         "open",
    kite_order_id:  orderId,
    sl_order_id:    slOrderId,
    strategy:       body.reason || body.strategy || null,
    signal_data:    body,
  });

  console.log(`[webhook] ✅ ${txType} ${quantity} ${tradingsymbol} | order=${orderId} sl=${slOrderId}`);

  return res.status(200).json({
    ok: true,
    message:   `✅ ${txType} ${lots} lot(s) of ${tradingsymbol} placed`,
    orderId,
    slOrderId,
    tradeId,
    symbol:    tradingsymbol,
    quantity,
    tradesLeftToday: maxTrades - todayCount - 1,
  });
}
