// ─────────────────────────────────────────────────────────────────────────────
// GET /api/trade/positions
//
// Returns live open positions from Zerodha Kite.
// Polled every 10 seconds by the dashboard to show real-time P&L.
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
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET")    return res.status(405).json({ ok: false, error: "GET only" });

  try {
    const sb = getSupabase();
    const { data: session } = await sb
      .from("kite_session")
      .select("api_key, access_token, user_name")
      .eq("id", 1)
      .maybeSingle();

    if (!session?.access_token) {
      return res.status(200).json({ ok: true, connected: false, positions: [], livePnl: 0 });
    }

    // Fetch positions from Kite
    const resp = await fetch("https://api.kite.trade/portfolio/positions", {
      headers: {
        "X-Kite-Version": "3",
        Authorization:    `token ${session.api_key}:${session.access_token}`,
      },
    });

    const data = await resp.json();

    if (data.status !== "success") {
      return res.status(200).json({
        ok: false, connected: true,
        error: data.message || "Kite positions fetch failed",
        positions: [], livePnl: 0,
      });
    }

    const dayPositions = (data.data?.day || []).filter(p => p.quantity !== 0);
    const livePnl      = dayPositions.reduce((s, p) => s + (p.pnl || 0), 0);

    // Map to a clean shape for the dashboard
    const positions = dayPositions.map(p => ({
      symbol:       p.tradingsymbol,
      exchange:     p.exchange,
      quantity:     p.quantity,
      buyPrice:     p.buy_price,
      lastPrice:    p.last_price,
      pnl:          Math.round((p.pnl || 0) * 100) / 100,
      pnlPct:       p.buy_price > 0
                      ? Math.round(((p.last_price - p.buy_price) / p.buy_price) * 100 * 10) / 10
                      : 0,
      product:      p.product,
    }));

    return res.status(200).json({
      ok:        true,
      connected: true,
      kiteUser:  session.user_name,
      positions,
      livePnl:   Math.round(livePnl * 100) / 100,
      count:     positions.length,
    });

  } catch (err) {
    console.error("[positions]", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
