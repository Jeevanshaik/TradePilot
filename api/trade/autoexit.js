// ─────────────────────────────────────────────────────────────────────────────
// GET /api/trade/autoexit
//
// 🛡️  SAFETY NET — Closes ALL open MIS positions before market close.
//
// Called automatically by Vercel Cron at 3:15 PM IST (09:45 UTC) Mon–Fri.
// Can also be triggered manually from the dashboard "Emergency Exit" button.
//
// What it does:
//   1. Fetches all live MIS positions from Zerodha Kite
//   2. Places MARKET SELL order for every open long position
//   3. Places MARKET BUY  order for every open short position
//   4. Updates trade P&L in Supabase
//   5. Returns a summary
//
// ── Required Env Vars ────────────────────────────────────────────────────────
//   CRON_SECRET           — protects the endpoint from public access
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "@supabase/supabase-js";

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

async function getKiteSession(sb) {
  const { data } = await sb
    .from("kite_session")
    .select("api_key, access_token")
    .eq("id", 1)
    .maybeSingle();
  return data;
}

function kiteHeaders(session) {
  return {
    "X-Kite-Version": "3",
    Authorization:    `token ${session.api_key}:${session.access_token}`,
    "Content-Type":   "application/x-www-form-urlencoded",
  };
}

async function getOpenPositions(session) {
  const resp = await fetch("https://api.kite.trade/portfolio/positions", {
    headers: kiteHeaders(session),
  });
  const data = await resp.json();
  if (data.status !== "success") return [];
  // Day (MIS) positions with non-zero net quantity
  return (data.data?.day || []).filter(p => p.quantity !== 0);
}

async function placeMarketOrder(session, { tradingsymbol, exchange, quantity, side }) {
  const resp = await fetch("https://api.kite.trade/orders/regular", {
    method:  "POST",
    headers: kiteHeaders(session),
    body:    new URLSearchParams({
      tradingsymbol,
      exchange,
      transaction_type: side,       // BUY or SELL
      order_type:       "MARKET",
      quantity:         String(Math.abs(quantity)),
      product:          "MIS",
      validity:         "DAY",
      tag:              "tradepilot_autoexit",
    }),
  });
  const data = await resp.json();
  return data.status === "success" ? data.data.order_id : null;
}

async function updateTradesPnl(sb, closed) {
  for (const item of closed) {
    try {
      // Find the most recent open trade for this symbol
      const { data: trade } = await sb
        .from("trades")
        .select("id, entry_price, quantity")
        .eq("symbol",  item.tradingsymbol)
        .eq("status",  "open")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!trade) continue;

      const exitPrice = item.last_price || item.average_price || 0;
      const pnl       = (exitPrice - (trade.entry_price || 0)) * trade.quantity;

      await sb.from("trades").update({
        status:     "closed",
        exit_price:  exitPrice,
        pnl:         Math.round(pnl * 100) / 100,
        reason:      "Auto-exit at market close",
        updated_at:  new Date().toISOString(),
      }).eq("id", trade.id);
    } catch (_) {}
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();

  // ── Auth: Vercel Cron sends Authorization: Bearer <CRON_SECRET>
  //          Dashboard button can also pass it as ?secret=xxx
  const cronSecret = process.env.CRON_SECRET || "";
  if (cronSecret) {
    const authHeader = req.headers.authorization || "";
    const querySecret = req.query.secret || "";
    const provided    = authHeader.replace("Bearer ", "").trim() || querySecret;
    if (provided !== cronSecret) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
  }

  try {
    const sb      = getSupabase();
    const session = await getKiteSession(sb);

    if (!session?.access_token) {
      return res.status(200).json({ ok: false, message: "Kite not connected — nothing to exit" });
    }

    // 1. Get all open MIS positions
    const positions = await getOpenPositions(session);

    if (positions.length === 0) {
      return res.status(200).json({ ok: true, message: "No open positions to close", closed: 0 });
    }

    // 2. Close each position
    const results  = [];
    const closed   = [];

    for (const pos of positions) {
      const side = pos.quantity > 0 ? "SELL" : "BUY"; // reverse the position
      try {
        const orderId = await placeMarketOrder(session, {
          tradingsymbol: pos.tradingsymbol,
          exchange:      pos.exchange,
          quantity:      pos.quantity,
          side,
        });

        results.push({
          symbol:  pos.tradingsymbol,
          qty:     pos.quantity,
          side,
          orderId: orderId || "failed",
          pnl:     pos.pnl,
        });

        if (orderId) closed.push(pos);
      } catch (err) {
        results.push({ symbol: pos.tradingsymbol, error: err.message });
      }
    }

    // 3. Update P&L in DB
    await updateTradesPnl(sb, closed);

    const totalPnl = positions.reduce((s, p) => s + (p.pnl || 0), 0);

    // 4. Close any open PAPER trades
    let paperSummary = null;
    try {
      const { data: openPaper } = await sb
        .from("paper_trades")
        .select("*")
        .eq("status", "open");

      if (openPaper?.length) {
        const LOT_SIZES = { NIFTY: 75, BANKNIFTY: 35, FINNIFTY: 40 };
        // Fetch current prices via Kite
        const TOKENS = { NIFTY: 256265, BANKNIFTY: 260105 };
        const priceMap = {};
        for (const sym of ["NIFTY", "BANKNIFTY"]) {
          try {
            const r = await fetch(
              `https://api.kite.trade/quote?i=NSE:${sym === "NIFTY" ? "NIFTY+50" : "NIFTY+BANK"}`,
              { headers: { "X-Kite-Version": "3", Authorization: `token ${session.api_key}:${session.access_token}` } }
            );
            const d = await r.json();
            const key = Object.keys(d.data || {})[0];
            if (key) priceMap[sym] = d.data[key].last_price;
          } catch {}
        }

        let paperPnl = 0;
        for (const pt of openPaper) {
          const exitPrice = priceMap[pt.symbol] || pt.entry_price;
          const lotSize   = pt.lot_size || LOT_SIZES[pt.symbol] || 75;
          const direction = pt.action === "BUY" ? 1 : -1;
          // Delta-based P&L approximation for credit spread
          const rawPnl    = direction * (exitPrice - pt.entry_price) * lotSize * 0.3;
          // Cap: max profit 50pts × delta, max loss 80pts × delta
          const cappedPnl = Math.max(Math.min(rawPnl, 50 * lotSize * 0.3), -80 * lotSize * 0.3);
          const pnl       = Math.round(cappedPnl);
          paperPnl       += pnl;

          await sb.from("paper_trades").update({
            status:     "closed",
            exit_price: exitPrice,
            pnl,
            exit_time:  new Date().toISOString(),
          }).eq("id", pt.id);
        }
        paperSummary = { closedPaperTrades: openPaper.length, paperPnl };
        console.log(`[autoexit] Paper trades closed: ${openPaper.length} | Paper P&L ₹${paperPnl}`);
      }
    } catch (e) { console.warn("[autoexit] Paper trade close error:", e.message); }

    console.log(`[autoexit] Closed ${closed.length}/${positions.length} positions | P&L ₹${totalPnl}`);

    return res.status(200).json({
      ok:      true,
      message: `✅ Closed ${closed.length} position(s)`,
      closed:  closed.length,
      totalPnl: Math.round(totalPnl * 100) / 100,
      paperSummary,
      details: results,
    });

  } catch (err) {
    console.error("[autoexit]", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
