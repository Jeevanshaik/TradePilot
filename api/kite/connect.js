// ─────────────────────────────────────────────────────────────────────────────
// Zerodha Kite API Authentication
//
// GET  /api/kite/connect          → returns Kite login URL
// POST /api/kite/connect          → exchange request_token for access_token
// DELETE /api/kite/connect        → disconnect (clear session)
//
// ── How Zerodha login works ───────────────────────────────────────────────────
//   1. User clicks "Connect Zerodha" → opens kite.trade/connect/login URL
//   2. User logs in on Zerodha → redirected back with ?request_token=XXXXX
//   3. Dashboard detects request_token in URL → calls POST /api/kite/connect
//   4. Server exchanges token → stores access_token in Supabase
//   5. From now on, all orders use this access_token (valid until 6 AM next day)
//
// ── Required Env Vars ────────────────────────────────────────────────────────
//   KITE_API_KEY     — from kite.zerodha.com/apps (optional if passed in body)
//   KITE_API_SECRET  — from kite.zerodha.com/apps (optional if passed in body)
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
// ─────────────────────────────────────────────────────────────────────────────

import crypto        from "crypto";
import { createClient } from "@supabase/supabase-js";

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const sb = getSupabase();

  // ── GET: return Kite login URL ────────────────────────────────────────────
  if (req.method === "GET") {
    const apiKey = process.env.KITE_API_KEY || req.query.api_key;
    if (!apiKey) {
      return res.status(400).json({ ok: false, error: "KITE_API_KEY not configured" });
    }
    const loginUrl = `https://kite.trade/connect/login?api_key=${apiKey}&v=3`;
    return res.status(200).json({ ok: true, loginUrl, api_key: apiKey });
  }

  // ── DELETE: clear session ─────────────────────────────────────────────────
  if (req.method === "DELETE") {
    try {
      await sb.from("kite_session").delete().eq("id", 1);
      return res.status(200).json({ ok: true, message: "Zerodha disconnected" });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // ── POST: exchange request_token → access_token ───────────────────────────
  if (req.method === "POST") {
    const body          = req.body || {};
    const request_token = (body.request_token || "").trim();
    const apiKey        = (body.api_key    || process.env.KITE_API_KEY    || "").trim();
    const apiSecret     = (body.api_secret || process.env.KITE_API_SECRET || "").trim();

    if (!request_token) return res.status(400).json({ ok: false, error: "request_token required" });
    if (!apiKey)         return res.status(400).json({ ok: false, error: "api_key required" });
    if (!apiSecret)      return res.status(400).json({ ok: false, error: "api_secret required" });

    // Checksum = SHA256(api_key + request_token + api_secret)
    const checksum = crypto
      .createHash("sha256")
      .update(apiKey + request_token + apiSecret)
      .digest("hex");

    try {
      const resp = await fetch("https://api.kite.trade/session/token", {
        method: "POST",
        headers: {
          "X-Kite-Version": "3",
          "Content-Type":   "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ api_key: apiKey, request_token, checksum }),
      });

      const data = await resp.json();

      if (!resp.ok || data.status !== "success") {
        return res.status(400).json({
          ok:    false,
          error: data.message || "Token exchange failed",
        });
      }

      const { access_token, user_id, user_name, email } = data.data;

      // Upsert single row (id=1) — we only ever have one Kite account
      await sb.from("kite_session").upsert({
        id:           1,
        api_key:      apiKey,
        api_secret:   apiSecret,
        access_token,
        user_id,
        user_name,
        email:        email || null,
        created_at:   new Date().toISOString(),
      });

      return res.status(200).json({
        ok:       true,
        user_id,
        user_name,
        message:  `✅ Connected as ${user_name} (${user_id})`,
      });

    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  return res.status(405).json({ ok: false, error: "Method not allowed" });
}
