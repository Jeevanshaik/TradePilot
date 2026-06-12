// ─────────────────────────────────────────────────────────────────────────────
// GET /api/trade/day-strategy
//
// Returns today's strategy decision for the dashboard.
// Written by morning-scan.js every trading day at 9:15 AM IST.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET")    return res.status(405).json({ ok: false });

  try {
    const supa  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const today = new Date().toISOString().slice(0, 10);

    const { data } = await supa
      .from("day_strategy")
      .select("*")
      .eq("id", today)
      .maybeSingle();

    if (!data) {
      return res.status(200).json({
        ok:       true,
        hasData:  false,
        strategy: null,
        message:  "Morning scan not run yet — will run at 9:15 AM IST",
      });
    }

    // Strategy metadata for the dashboard
    const META = {
      iron_condor: {
        label:    "Iron Condor",
        emoji:    "🔒",
        color:    "#10B981",
        desc:     "Market stays range-bound → collect premium from both sides",
        riskLevel:"Low",
        winRate:  "65–75%",
      },
      spread: {
        label:    "Directional Spread",
        emoji:    "📐",
        color:    "#F59E0B",
        desc:     "Hedged directional trade — awaiting TradingView signal",
        riskLevel:"Medium",
        winRate:  "60–65%",
      },
      strangle: {
        label:    "Strangle Buy",
        emoji:    "⚡",
        color:    "#8B5CF6",
        desc:     "High VIX / event day — buy both sides for big move",
        riskLevel:"Medium",
        winRate:  "45–55%",
      },
      no_trade: {
        label:    "No Trade",
        emoji:    "🛑",
        color:    "#6B7280",
        desc:     "Conditions unfavorable — protecting capital",
        riskLevel:"None",
        winRate:  "N/A",
      },
    };

    return res.status(200).json({
      ok:       true,
      hasData:  true,
      ...data,
      meta:     META[data.strategy] || META.no_trade,
    });

  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
