// ─────────────────────────────────────────────────────────────────────────────
// GET /api/trade/status
//
// Returns live trading status for the dashboard:
//   - Today's P&L, trade count, win rate
//   - List of today's trades
//   - Zerodha Kite connection status
//   - Live open positions from Kite (if connected)
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "@supabase/supabase-js";

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

function todayStartISO() {
  const t = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const d = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  return `${d}T00:00:00+05:30`;
}

async function getKitePositions(session) {
  try {
    const resp = await fetch("https://api.kite.trade/portfolio/positions", {
      headers: {
        "X-Kite-Version": "3",
        Authorization:    `token ${session.api_key}:${session.access_token}`,
      },
    });
    const data = await resp.json();
    if (data.status !== "success") return [];
    // Only return day/MIS positions with open quantity
    return (data.data?.day || []).filter(p => Math.abs(p.quantity) > 0);
  } catch { return []; }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET")     return res.status(405).json({ ok: false, error: "GET only" });

  try {
    const sb = getSupabase();

    // Today's trades from DB
    const { data: todayTrades } = await sb
      .from("trades")
      .select("*")
      .gte("created_at", todayStartISO())
      .order("created_at", { ascending: false });

    const trades    = todayTrades || [];
    const todayPnl  = trades.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
    const wins      = trades.filter(t => (t.pnl || 0) > 0).length;
    const losses    = trades.filter(t => (t.pnl || 0) < 0).length;
    const openCount = trades.filter(t => t.status === "open").length;

    // Kite connection
    const { data: session } = await sb
      .from("kite_session")
      .select("api_key, access_token, user_name, user_id, created_at")
      .eq("id", 1)
      .maybeSingle();

    const kiteConnected = !!(session?.access_token);

    // Live positions from Kite
    let livePositions = [];
    if (kiteConnected) {
      livePositions = await getKitePositions(session);
    }

    return res.status(200).json({
      ok: true,
      todayPnl:      Math.round(todayPnl * 100) / 100,
      tradeCount:    trades.length,
      openCount,
      wins,
      losses,
      winRate:       trades.length ? Math.round((wins / trades.length) * 100) : 0,
      trades:        trades.slice(0, 30),
      kiteConnected,
      kiteUser:      session?.user_name || null,
      kiteUserId:    session?.user_id   || null,
      livePositions,
      maxDailyLoss:  parseInt(process.env.MAX_DAILY_LOSS     || "3000"),
      maxTrades:     parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
    });

  } catch (err) {
    console.error("[trade/status]", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
