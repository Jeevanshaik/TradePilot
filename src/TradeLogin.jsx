import React, { useState } from "react";

// ─── tiny helpers ───────────────────────────────
const CRED_KEY  = "tp_credentials";
const SESSION_KEY = "tp_session";

function getCredentials() {
  try {
    const raw = localStorage.getItem(CRED_KEY);
    if (!raw) return null;
    return JSON.parse(atob(raw));
  } catch { return null; }
}

function saveCredentials(username, password) {
  const data = btoa(JSON.stringify({ username, password }));
  localStorage.setItem(CRED_KEY, data);
}

export function isLoggedIn() {
  return sessionStorage.getItem(SESSION_KEY) === "active";
}

export function logout() {
  sessionStorage.removeItem(SESSION_KEY);
}
// ────────────────────────────────────────────────

export default function TradeLogin({ onLogin }) {
  const isFirstTime = !getCredentials();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm,  setConfirm]  = useState("");
  const [error,    setError]    = useState("");
  const [loading,  setLoading]  = useState(false);
  const [showPass, setShowPass] = useState(false);

  const handleSubmit = (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    setTimeout(() => {
      if (isFirstTime) {
        // ── First-time setup ──
        if (!username.trim()) { setError("Enter a username."); setLoading(false); return; }
        if (password.length < 6) { setError("Password must be at least 6 characters."); setLoading(false); return; }
        if (password !== confirm) { setError("Passwords don't match."); setLoading(false); return; }
        saveCredentials(username.trim(), password);
        sessionStorage.setItem(SESSION_KEY, "active");
        onLogin(username.trim());
      } else {
        // ── Login ──
        const creds = getCredentials();
        if (!creds || username.trim() !== creds.username || password !== creds.password) {
          setError("Wrong username or password.");
          setLoading(false);
          return;
        }
        sessionStorage.setItem(SESSION_KEY, "active");
        onLogin(username.trim());
      }
      setLoading(false);
    }, 600);
  };

  // ── shared input style ──
  const INPUT = {
    width: "100%",
    background: "rgba(255,255,255,.06)",
    border: "1px solid rgba(16,185,129,.25)",
    borderRadius: 10,
    color: "#E2FFF6",
    padding: "13px 14px",
    fontSize: 15,
    outline: "none",
    boxSizing: "border-box",
    letterSpacing: ".3px",
    transition: "border .2s",
  };

  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(160deg,#060D0A 0%,#0A1F15 50%,#050C09 100%)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "'Segoe UI', system-ui, sans-serif",
      padding: 20,
    }}>

      {/* ── Animated grid background ── */}
      <div style={{
        position: "fixed", inset: 0, zIndex: 0, overflow: "hidden",
        backgroundImage: `
          linear-gradient(rgba(16,185,129,.05) 1px, transparent 1px),
          linear-gradient(90deg, rgba(16,185,129,.05) 1px, transparent 1px)
        `,
        backgroundSize: "40px 40px",
        pointerEvents: "none",
      }} />

      {/* ── Glow blobs ── */}
      <div style={{
        position: "fixed", top: "15%", left: "10%", width: 300, height: 300,
        borderRadius: "50%", background: "rgba(16,185,129,.07)",
        filter: "blur(80px)", pointerEvents: "none", zIndex: 0,
      }} />
      <div style={{
        position: "fixed", bottom: "20%", right: "10%", width: 250, height: 250,
        borderRadius: "50%", background: "rgba(5,150,105,.08)",
        filter: "blur(60px)", pointerEvents: "none", zIndex: 0,
      }} />

      {/* ── Login Card ── */}
      <div style={{
        position: "relative", zIndex: 1,
        width: "100%", maxWidth: 380,
        background: "rgba(10,31,21,.85)",
        backdropFilter: "blur(20px)",
        border: "1px solid rgba(16,185,129,.2)",
        borderRadius: 20,
        padding: "36px 28px",
        boxShadow: "0 24px 80px rgba(0,0,0,.6), 0 0 0 1px rgba(16,185,129,.08)",
      }}>

        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ fontSize: 48, lineHeight: 1 }}>📈</div>
          <div style={{
            fontSize: 26, fontWeight: 900, marginTop: 10,
            background: "linear-gradient(90deg,#10B981,#34D399,#6EE7B7)",
            WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
            backgroundClip: "text",
          }}>TradePilot</div>
          <div style={{ fontSize: 12, color: "rgba(16,185,129,.6)", marginTop: 4, letterSpacing: 1 }}>
            AI TRADING DASHBOARD
          </div>
        </div>

        {/* Title */}
        <div style={{
          textAlign: "center", marginBottom: 22,
          fontSize: 14, color: "rgba(226,255,246,.55)",
        }}>
          {isFirstTime
            ? "👋 First time? Create your login credentials."
            : "Welcome back. Sign in to continue."}
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit}>

          {/* Username */}
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 12, color: "rgba(16,185,129,.7)", display: "block", marginBottom: 6, fontWeight: 600 }}>
              USERNAME
            </label>
            <input
              type="text"
              placeholder="Enter username"
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoComplete="username"
              style={INPUT}
            />
          </div>

          {/* Password */}
          <div style={{ marginBottom: isFirstTime ? 14 : 6, position: "relative" }}>
            <label style={{ fontSize: 12, color: "rgba(16,185,129,.7)", display: "block", marginBottom: 6, fontWeight: 600 }}>
              PASSWORD
            </label>
            <div style={{ position: "relative" }}>
              <input
                type={showPass ? "text" : "password"}
                placeholder={isFirstTime ? "Create a strong password" : "Enter password"}
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete={isFirstTime ? "new-password" : "current-password"}
                style={{ ...INPUT, paddingRight: 44 }}
              />
              <button
                type="button"
                onClick={() => setShowPass(s => !s)}
                style={{
                  position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
                  background: "none", border: "none", cursor: "pointer",
                  color: "rgba(16,185,129,.5)", fontSize: 16, padding: 4,
                }}
              >
                {showPass ? "🙈" : "👁️"}
              </button>
            </div>
          </div>

          {/* Confirm password (first time only) */}
          {isFirstTime && (
            <div style={{ marginBottom: 6 }}>
              <label style={{ fontSize: 12, color: "rgba(16,185,129,.7)", display: "block", marginBottom: 6, fontWeight: 600 }}>
                CONFIRM PASSWORD
              </label>
              <input
                type="password"
                placeholder="Repeat password"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                autoComplete="new-password"
                style={INPUT}
              />
            </div>
          )}

          {/* Error */}
          {error && (
            <div style={{
              marginTop: 10, padding: "10px 12px",
              background: "rgba(239,68,68,.12)",
              border: "1px solid rgba(239,68,68,.3)",
              borderRadius: 8, fontSize: 13,
              color: "#FCA5A5", fontWeight: 600,
            }}>
              ⚠️ {error}
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={loading}
            style={{
              width: "100%", marginTop: 20,
              background: loading
                ? "rgba(16,185,129,.3)"
                : "linear-gradient(135deg,#059669,#10B981)",
              border: "none", borderRadius: 12,
              color: "#fff", fontWeight: 900,
              fontSize: 15, padding: "14px",
              cursor: loading ? "not-allowed" : "pointer",
              boxShadow: loading ? "none" : "0 4px 24px rgba(16,185,129,.35)",
              transition: "all .2s",
              letterSpacing: ".5px",
            }}
          >
            {loading ? "⏳ Verifying..." : (isFirstTime ? "🚀 Create Account & Login" : "🔐 Sign In")}
          </button>
        </form>

        {/* Footer */}
        <div style={{
          marginTop: 20, textAlign: "center",
          fontSize: 11, color: "rgba(16,185,129,.3)",
        }}>
          🔒 Credentials stored locally on this device
        </div>
      </div>
    </div>
  );
}
