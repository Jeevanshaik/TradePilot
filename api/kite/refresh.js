// ─────────────────────────────────────────────────────────────────────────────
// GET /api/kite/refresh
//
// Fully automated daily Kite access_token refresh.
// Called by cron-job.org at 8:30 AM IST (3:00 AM UTC) every weekday.
// No manual login needed.
//
// Required env vars:
//   KITE_USER_ID       — Zerodha user ID (e.g. AB1234)
//   KITE_PASSWORD      — Zerodha login password
//   KITE_TOTP_SECRET   — TOTP secret key from Zerodha 2FA setup
//   KITE_API_KEY       — Kite Connect app API key
//   KITE_API_SECRET    — Kite Connect app API secret
//   CRON_SECRET        — Authorization header value
//   SUPABASE_URL / SUPABASE_SERVICE_KEY
// ─────────────────────────────────────────────────────────────────────────────

import { createHmac, createHash } from "crypto";
import { createClient }           from "@supabase/supabase-js";

// ── TOTP generator (RFC 6238, no external deps) ───────────────────────────────
function totp(secret) {
  const base32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean  = secret.toUpperCase().replace(/[\s=]/g, "");
  let bits = 0, val = 0;
  const bytes = [];
  for (const ch of clean) {
    const idx = base32.indexOf(ch);
    if (idx < 0) continue;
    val = (val << 5) | idx;
    bits += 5;
    if (bits >= 8) { bytes.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }

  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf     = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const hash   = createHmac("sha1", Buffer.from(bytes)).update(buf).digest();
  const offset = hash[19] & 0xf;
  const otp    = ((hash[offset] & 0x7f) << 24 | hash[offset+1] << 16 |
                   hash[offset+2] << 8  | hash[offset+3]) % 1_000_000;
  return String(otp).padStart(6, "0");
}

// ── Zerodha login flow ────────────────────────────────────────────────────────
async function getRequestToken(userId, password, totpSecret, apiKey) {
  const jar = {};

  const saveCookies = (resp) => {
    for (const [, v] of (resp.headers.raw?.()["set-cookie"] || []).entries?.() ?? []) {
      const [pair] = v.split(";");
      const [k, val] = pair.split("=");
      jar[k.trim()] = val?.trim() ?? "";
    }
    // also try single header
    const sc = resp.headers.get("set-cookie");
    if (sc) {
      const [pair] = sc.split(";");
      const [k, val] = pair.split("=");
      jar[k.trim()] = val?.trim() ?? "";
    }
  };

  const cookieStr = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");

  // 1. Login
  const loginResp = await fetch("https://kite.zerodha.com/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ user_id: userId, password }),
  });
  saveCookies(loginResp);
  const loginData = await loginResp.json();
  if (loginData.status !== "success") throw new Error(`Login failed: ${loginData.message}`);
  const requestId = loginData.data.request_id;

  // 2. TOTP 2FA
  const totpCode   = totp(totpSecret);
  const twoFaResp  = await fetch("https://kite.zerodha.com/api/twofa", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieStr(),
    },
    body: new URLSearchParams({
      user_id:      userId,
      request_id:   requestId,
      twofa_value:  totpCode,
      twofa_type:   "totp",
      skip_session: "",
    }),
  });
  saveCookies(twoFaResp);
  const twoFaData = await twoFaResp.json();
  if (twoFaData.status !== "success") throw new Error(`2FA failed: ${twoFaData.message}`);

  // 3. Kite Connect OAuth redirect → capture request_token
  const connectResp = await fetch(
    `https://kite.trade/connect/login?v=3&api_key=${apiKey}`,
    {
      redirect: "manual",
      headers: { Cookie: cookieStr() },
    },
  );

  const location = connectResp.headers.get("location") || "";
  const match    = location.match(/request_token=([^&]+)/);
  if (!match) throw new Error(`No request_token in redirect: ${location}`);
  return match[1];
}

// ── Exchange request_token for access_token ───────────────────────────────────
async function exchangeToken(apiKey, apiSecret, requestToken) {
  const checksum = createHash("sha256")
    .update(apiKey + requestToken + apiSecret)
    .digest("hex");

  const resp = await fetch("https://api.kite.trade/session/token", {
    method: "POST",
    headers: {
      "X-Kite-Version":  "3",
      "Content-Type":    "application/x-www-form-urlencoded",
      Authorization:     `token ${apiKey}:`,
    },
    body: new URLSearchParams({ api_key: apiKey, request_token: requestToken, checksum }),
  });
  const data = await resp.json();
  if (data.status !== "success") throw new Error(`Token exchange failed: ${data.message}`);
  return data.data;
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Auth
  const secret = process.env.CRON_SECRET || "";
  const auth   = (req.headers["authorization"] || "").replace("Bearer ", "");
  if (secret && auth !== secret) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const { KITE_USER_ID, KITE_PASSWORD, KITE_TOTP_SECRET,
            KITE_API_KEY, KITE_API_SECRET } = process.env;

    if (!KITE_USER_ID || !KITE_PASSWORD || !KITE_TOTP_SECRET)
      throw new Error("Missing KITE_USER_ID / KITE_PASSWORD / KITE_TOTP_SECRET env vars");

    // Step 1: Get request_token via automated login
    const requestToken = await getRequestToken(
      KITE_USER_ID, KITE_PASSWORD, KITE_TOTP_SECRET, KITE_API_KEY,
    );

    // Step 2: Exchange for access_token
    const session = await exchangeToken(KITE_API_KEY, KITE_API_SECRET, requestToken);

    // Step 3: Store in Supabase
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { error } = await sb.from("kite_session").upsert({
      id:           1,
      api_key:      KITE_API_KEY,
      access_token: session.access_token,
      user_name:    session.user_name || KITE_USER_ID,
      refreshed_at: new Date().toISOString(),
    });

    if (error) throw new Error(`Supabase upsert failed: ${error.message}`);

    return res.status(200).json({
      ok:       true,
      message:  "Kite token refreshed successfully",
      user:     session.user_name,
      expires:  "Today midnight IST",
    });

  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
