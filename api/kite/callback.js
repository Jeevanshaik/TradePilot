// GET /api/kite/callback?request_token=XXX
// Zerodha redirects here after user login. Exchanges token and saves to Supabase.
// Set this URL as redirect URL in kite.zerodha.com/apps → TradePilot

import crypto        from "crypto";
import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  const { request_token, status } = req.query;

  if (status === "error" || !request_token) {
    return res.redirect(`/trade?kite_error=${encodeURIComponent("Login cancelled or failed")}`);
  }

  try {
    const apiKey    = process.env.KITE_API_KEY    || "";
    const apiSecret = process.env.KITE_API_SECRET || "";

    if (!apiKey || !apiSecret) {
      return res.redirect(`/trade?kite_error=${encodeURIComponent("KITE_API_KEY or KITE_API_SECRET not configured in Vercel")}`);
    }

    const checksum = crypto.createHash("sha256")
      .update(apiKey + request_token + apiSecret)
      .digest("hex");

    const resp = await fetch("https://api.kite.trade/session/token", {
      method:  "POST",
      headers: { "X-Kite-Version": "3", "Content-Type": "application/x-www-form-urlencoded" },
      body:    new URLSearchParams({ api_key: apiKey, request_token, checksum }),
    });

    const data = await resp.json();
    if (data.status !== "success") {
      return res.redirect(`/trade?kite_error=${encodeURIComponent(data.message || "Token exchange failed")}`);
    }

    const { access_token, user_name } = data.data;

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { error: dbErr } = await sb.from("kite_session").upsert({ id: 1, api_key: apiKey, access_token });

    if (dbErr) {
      return res.redirect(`/trade?kite_error=${encodeURIComponent("DB save failed: " + dbErr.message)}`);
    }

    return res.redirect(`/trade?kite_success=${encodeURIComponent(user_name)}`);

  } catch (err) {
    return res.redirect(`/trade?kite_error=${encodeURIComponent(err.message)}`);
  }
}
