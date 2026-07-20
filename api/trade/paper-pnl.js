// GET /api/trade/paper-pnl
// Returns today's paper trades with P&L summary for the dashboard

import { createClient } from "@supabase/supabase-js";

function nowIST() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const todayStart = nowIST();
  todayStart.setHours(0, 0, 0, 0);

  const { data: trades, error } = await sb
    .from("paper_trades")
    .select("*")
    .gte("created_at", todayStart.toISOString())
    .order("entry_time", { ascending: false });

  if (error) return res.status(500).json({ ok: false, error: error.message });

  const closed = trades?.filter(t => t.status === "closed") || [];
  const open   = trades?.filter(t => t.status === "open")   || [];

  const totalPnl   = closed.reduce((s, t) => s + (t.pnl || 0), 0);
  const wins       = closed.filter(t => (t.pnl || 0) > 0).length;
  const losses     = closed.filter(t => (t.pnl || 0) <= 0).length;

  return res.status(200).json({
    ok: true,
    summary: {
      totalPnl:    Math.round(totalPnl),
      totalTrades: closed.length,
      openTrades:  open.length,
      wins,
      losses,
      winRate:     closed.length > 0 ? Math.round((wins / closed.length) * 100) : 0,
    },
    trades: trades || [],
  });
}
