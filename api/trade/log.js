// ─────────────────────────────────────────────────────────────────────────────
// GET  /api/trade/log          → fetch trade history
// PATCH /api/trade/log         → update a trade (close with P&L)
//
// Query params (GET):
//   ?limit=50    — max records (default 50)
//   ?days=7      — last N days (default 30)
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "@supabase/supabase-js";

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const sb = getSupabase();

  // ── GET: fetch trades ─────────────────────────────────────────────────────
  if (req.method === "GET") {
    const limit = Math.min(100, parseInt(req.query.limit || "50"));
    const days  = parseInt(req.query.days || "30");

    const since = new Date();
    since.setDate(since.getDate() - days);

    const { data, error } = await sb
      .from("trades")
      .select("id, created_at, symbol, action, lots, quantity, entry_price, exit_price, pnl, status, strategy, kite_order_id, sl_order_id, reason")
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) return res.status(500).json({ ok: false, error: error.message });

    const trades   = data || [];
    const totalPnl = trades.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
    const wins     = trades.filter(t => (t.pnl || 0) > 0).length;

    return res.status(200).json({
      ok: true,
      trades,
      summary: {
        total:   trades.length,
        wins,
        losses:  trades.filter(t => (t.pnl || 0) < 0).length,
        winRate: trades.length ? Math.round((wins / trades.length) * 100) : 0,
        totalPnl: Math.round(totalPnl * 100) / 100,
      },
    });
  }

  // ── PATCH: close/update a trade ───────────────────────────────────────────
  if (req.method === "PATCH") {
    const { id, pnl, exit_price, status } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: "id required" });

    const updates = { updated_at: new Date().toISOString() };
    if (pnl        != null) updates.pnl        = pnl;
    if (exit_price != null) updates.exit_price  = exit_price;
    if (status)             updates.status      = status;

    const { error } = await sb.from("trades").update(updates).eq("id", id);
    if (error) return res.status(500).json({ ok: false, error: error.message });

    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ ok: false, error: "Method not allowed" });
}
