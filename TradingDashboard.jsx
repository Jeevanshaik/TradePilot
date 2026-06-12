import React, { useState, useEffect, useRef, useCallback } from "react";

// ─────────────────────────────────────────────────
// TradingView Advanced Chart (free embed widget)
// ─────────────────────────────────────────────────
function TradingViewChart({ symbol, interval }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.innerHTML = "";

    const wrap = document.createElement("div");
    wrap.className = "tradingview-widget-container";
    wrap.style.cssText = "height:100%;width:100%;";

    const inner = document.createElement("div");
    inner.className = "tradingview-widget-container__widget";
    inner.style.cssText = "height:calc(100% - 32px);width:100%;";

    const script = document.createElement("script");
    script.type = "text/javascript";
    script.src =
      "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.async = true;
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol,
      interval,
      timezone: "Asia/Kolkata",
      theme: "dark",
      style: "1",
      locale: "en",
      enable_publishing: false,
      withdateranges: true,
      hide_side_toolbar: false,
      allow_symbol_change: true,
      studies: ["RSI@tv-basicstudies", "MACD@tv-basicstudies"],
      support_host: "https://www.tradingview.com",
    });

    wrap.appendChild(inner);
    wrap.appendChild(script);
    ref.current.appendChild(wrap);

    return () => { if (ref.current) ref.current.innerHTML = ""; };
  }, [symbol, interval]);

  return <div ref={ref} style={{ height: "100%", width: "100%" }} />;
}

// ─────────────────────────────────────────────────
// Stat Card
// ─────────────────────────────────────────────────
function StatCard({ icon, label, value, sub, valueColor }) {
  return (
    <div style={{
      background: "#1E1035",
      borderRadius: 14,
      padding: "14px 12px",
      border: "1px solid rgba(124,58,237,.22)",
    }}>
      <div style={{ fontSize: 10, opacity: 0.55, marginBottom: 4 }}>{icon} {label}</div>
      <div style={{ fontSize: 19, fontWeight: 900, color: valueColor || "#E2D9F3", lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, opacity: 0.45, marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

// ─────────────────────────────────────────────────
// Pipeline Row
// ─────────────────────────────────────────────────
function PipelineRow({ icon, label, status }) {
  const ok = status === "ready";
  return (
    <div style={{
      display: "flex", alignItems: "center",
      justifyContent: "space-between",
      padding: "9px 0",
      borderBottom: "1px solid rgba(124,58,237,.1)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 17 }}>{icon}</span>
        <span style={{ fontSize: 12 }}>{label}</span>
      </div>
      <span style={{
        fontSize: 11, fontWeight: 700, padding: "3px 9px",
        borderRadius: 10,
        background: ok ? "rgba(16,185,129,.15)" : "rgba(245,158,11,.14)",
        color: ok ? "#10B981" : "#F59E0B",
      }}>
        {ok ? "✅ Ready" : "⏳ Setup needed"}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────
// Main Dashboard
// ─────────────────────────────────────────────────
export default function TradingDashboard({ user, onLogout }) {
  const [agentActive, setAgentActive]     = useState(false);
  const [symbol, setSymbol]               = useState("NSE:NIFTY");
  const [interval, setIntervalVal]        = useState("5");
  const [tab, setTab]                     = useState("chart");
  const [capital, setCapital]             = useState(100000);

  // ── Live data from API ──────────────────────────────────────────────────
  const [liveStatus, setLiveStatus]       = useState(null);
  const [statusLoading, setStatusLoading] = useState(true);

  // ── Kite connect fields ─────────────────────────────────────────────────
  const [kiteKey, setKiteKey]             = useState("");
  const [kiteSecret, setKiteSecret]       = useState("");

  // ── Kite OAuth callback: detect ?request_token in URL ───────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestToken = params.get("request_token");
    if (!requestToken) return;

    // Remove from URL immediately
    window.history.replaceState({}, "", window.location.pathname);

    // Exchange for access_token
    const stored = (() => { try { return JSON.parse(localStorage.getItem("tp_kite_keys") || "{}"); } catch { return {}; } })();
    if (!stored.api_key || !stored.api_secret) {
      alert("⚠️ Enter your Zerodha API Key & Secret in Setup tab first, then connect again.");
      return;
    }

    fetch("/api/kite/connect", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        request_token:  requestToken,
        api_key:        stored.api_key,
        api_secret:     stored.api_secret,
      }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.ok) {
          alert(`✅ Zerodha connected! Welcome ${d.user_name}`);
          pollStatus();
        } else {
          alert("❌ Zerodha connect failed: " + d.error);
        }
      })
      .catch(e => alert("❌ Network error: " + e.message));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Poll live status every 15 s ─────────────────────────────────────────
  const pollStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/trade/status");
      const d = await r.json();
      if (d.ok) setLiveStatus(d);
    } catch (_) {}
    finally { setStatusLoading(false); }
  }, []);

  useEffect(() => {
    pollStatus();
    const iv = setInterval(pollStatus, 15000);
    return () => clearInterval(iv);
  }, [pollStatus]);

  // ── Today's strategy (from morning scan) ───────────────────────────────
  const [dayStrategy,  setDayStrategy]  = useState(null);

  useEffect(() => {
    fetch("/api/trade/day-strategy")
      .then(r => r.json())
      .then(d => { if (d.ok && d.hasData) setDayStrategy(d); })
      .catch(() => {});
  }, []);

  // ── Live positions (poll every 10s when connected) ──────────────────────
  const [positions,    setPositions]    = useState([]);
  const [livePnl,      setLivePnl]      = useState(0);
  const [exitLoading,  setExitLoading]  = useState(false);

  const pollPositions = useCallback(async () => {
    try {
      const r = await fetch("/api/trade/positions");
      const d = await r.json();
      if (d.ok) { setPositions(d.positions || []); setLivePnl(d.livePnl || 0); }
    } catch (_) {}
  }, []);

  useEffect(() => {
    if (!kiteConnected) return;
    pollPositions();
    const iv = setInterval(pollPositions, 10000);
    return () => clearInterval(iv);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kiteConnected, pollPositions]);

  // ── Emergency exit all positions ────────────────────────────────────────
  const emergencyExit = async () => {
    if (!window.confirm("⚠️ EMERGENCY EXIT\n\nThis will IMMEDIATELY close ALL open positions at market price.\n\nAre you sure?")) return;
    setExitLoading(true);
    try {
      const r = await fetch(`/api/trade/autoexit?secret=${encodeURIComponent(process.env.VITE_CRON_SECRET || "")}`);
      const d = await r.json();
      if (d.ok) {
        alert(`✅ ${d.message}\nP&L: ₹${d.totalPnl}`);
        pollStatus();
        pollPositions();
      } else {
        alert("❌ Exit failed: " + (d.error || d.message));
      }
    } catch (e) {
      alert("❌ Network error: " + e.message);
    }
    setExitLoading(false);
  };

  // ── Derived stats (live > fallback to 0) ────────────────────────────────
  const todayPnl      = liveStatus?.todayPnl  ?? 0;
  const trades        = liveStatus?.trades    ?? [];
  const winRate       = liveStatus?.winRate   ?? 0;
  const kiteConnected = liveStatus?.kiteConnected ?? false;
  const pnlColor      = todayPnl >= 0 ? "#10B981" : "#EF4444";

  const CARD = {
    background: "#1E1035",
    borderRadius: 14,
    padding: "14px 12px",
    border: "1px solid rgba(124,58,237,.22)",
  };

  const INPUT = {
    width: "100%",
    background: "rgba(0,0,0,.35)",
    border: "1px solid rgba(124,58,237,.4)",
    borderRadius: 8,
    color: "#E2D9F3",
    padding: "10px 12px",
    fontSize: 13,
    boxSizing: "border-box",
    outline: "none",
  };

  const tabs = [
    { id: "chart",    label: "📊 Chart"  },
    { id: "trades",   label: "📋 Trades" },
    { id: "agent",    label: "🤖 Agent"  },
    { id: "settings", label: "⚙️ Setup"  },
  ];

  return (
    <div style={{
      background: "#0F0720",
      minHeight: "100vh",
      maxWidth: 480,
      margin: "0 auto",
      fontFamily: "'Segoe UI', system-ui, sans-serif",
      color: "#E2D9F3",
    }}>

      {/* ── Header ── */}
      <div style={{
        display: "flex", alignItems: "center",
        justifyContent: "space-between",
        padding: "13px 16px",
        background: "linear-gradient(90deg,#1E1035,#2D1B69)",
        borderBottom: "1px solid rgba(124,58,237,.3)",
        position: "sticky", top: 0, zIndex: 100,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span style={{ fontSize: 22 }}>📈</span>
          <div>
            <div style={{ fontWeight: 900, fontSize: 15, color: "#A78BFA" }}>TradePilot</div>
            <div style={{ fontSize: 10, opacity: 0.6 }}>
              Hi {user?.name || user?.phone?.slice(-4)} 👋
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{
            background: agentActive ? "rgba(16,185,129,.14)" : "rgba(239,68,68,.14)",
            border: `1px solid ${agentActive ? "#10B981" : "#EF4444"}`,
            borderRadius: 20, padding: "3px 9px",
            fontSize: 11, fontWeight: 700,
            color: agentActive ? "#10B981" : "#EF4444",
          }}>
            {agentActive ? "🟢 LIVE" : "🔴 OFF"}
          </div>
          <button onClick={onLogout} style={{
            background: "rgba(124,58,237,.18)",
            border: "1px solid rgba(124,58,237,.35)",
            borderRadius: 8, color: "#A78BFA",
            fontSize: 11, padding: "4px 10px",
            cursor: "pointer", fontWeight: 700,
          }}>Logout</button>
        </div>
      </div>

      {/* ── Today's Strategy Banner ── */}
      {dayStrategy && (
        <div style={{
          margin: "10px 16px 0",
          background: `linear-gradient(135deg, ${dayStrategy.meta?.color}18, ${dayStrategy.meta?.color}08)`,
          border:     `1px solid ${dayStrategy.meta?.color}40`,
          borderRadius: 12,
          padding: "12px 14px",
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <div>
            <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 2 }}>🧠 Today's Strategy</div>
            <div style={{ fontWeight: 900, fontSize: 16, color: dayStrategy.meta?.color }}>
              {dayStrategy.meta?.emoji} {dayStrategy.meta?.label}
            </div>
            <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>{dayStrategy.meta?.desc}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 11, opacity: 0.5 }}>VIX</div>
            <div style={{ fontWeight: 900, fontSize: 20,
              color: dayStrategy.vix < 13 ? "#10B981" : dayStrategy.vix > 17 ? "#EF4444" : "#F59E0B",
            }}>
              {dayStrategy.vix?.toFixed(1) ?? "--"}
            </div>
            <div style={{ fontSize: 10, opacity: 0.5 }}>Win {dayStrategy.meta?.winRate}</div>
          </div>
        </div>
      )}

      {/* ── Stats Grid ── */}
      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr",
        gap: 10, padding: "12px 16px",
      }}>
        <StatCard icon="💰" label="Capital"
          value={`₹${capital.toLocaleString("en-IN")}`}
          sub="Available"
          valueColor="#A78BFA"
        />
        <StatCard icon="📊" label="Today P&L"
          value={`${todayPnl >= 0 ? "+" : ""}₹${Math.abs(todayPnl).toLocaleString("en-IN")}`}
          sub={`${todayPnl >= 0 ? "▲" : "▼"} ${capital > 0 ? ((Math.abs(todayPnl) / capital) * 100).toFixed(2) : 0}%`}
          valueColor={pnlColor}
        />
        <StatCard icon="🎯" label="Win Rate"
          value={trades.length ? `${winRate}%` : "--"}
          sub={`${trades.length} trades today`}
          valueColor="#F59E0B"
        />
        <StatCard icon="🛡️" label="Max Loss/Day"
          value={`₹${liveStatus?.maxDailyLoss?.toLocaleString("en-IN") ?? "3,000"}`}
          sub="Hard stop active"
          valueColor="#EF4444"
        />
      </div>

      {/* ── Tab Bar ── */}
      <div style={{
        display: "flex", background: "#1E1035",
        borderBottom: "1px solid rgba(124,58,237,.2)",
      }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            flex: 1, background: "none", border: "none",
            borderBottom: tab === t.id ? "2px solid #7C3AED" : "2px solid transparent",
            color: tab === t.id ? "#A78BFA" : "rgba(226,217,243,.45)",
            padding: "10px 2px", fontSize: 11,
            fontWeight: tab === t.id ? 800 : 600, cursor: "pointer",
          }}>{t.label}</button>
        ))}
      </div>

      {/* ══════════════ CHART TAB ══════════════ */}
      {tab === "chart" && (
        <div>
          {/* Symbol + Interval pickers */}
          <div style={{ display: "flex", gap: 8, padding: "12px 16px 8px" }}>
            <select value={symbol} onChange={e => setSymbol(e.target.value)} style={{
              flex: 1, background: "#1E1035",
              border: "1px solid rgba(124,58,237,.4)", color: "#E2D9F3",
              borderRadius: 8, padding: "8px 10px", fontSize: 12, fontWeight: 700,
            }}>
              <option value="NSE:NIFTY">NIFTY 50</option>
              <option value="NSE:BANKNIFTY">BANK NIFTY</option>
              <option value="NSE:FINNIFTY">FIN NIFTY</option>
              <option value="NSE:RELIANCE">RELIANCE</option>
              <option value="NSE:HDFCBANK">HDFC BANK</option>
              <option value="NSE:TATAMOTORS">TATA MOTORS</option>
              <option value="NSE:INFY">INFOSYS</option>
              <option value="NSE:TCS">TCS</option>
            </select>
            <select value={interval} onChange={e => setIntervalVal(e.target.value)} style={{
              background: "#1E1035",
              border: "1px solid rgba(124,58,237,.4)", color: "#E2D9F3",
              borderRadius: 8, padding: "8px 10px", fontSize: 12, fontWeight: 700,
            }}>
              {[["1","1m"],["3","3m"],["5","5m"],["15","15m"],["30","30m"],["60","1H"],["D","1D"]].map(([v,l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>

          {/* TradingView Chart */}
          <div style={{ height: 430, padding: "0 8px 12px" }}>
            <TradingViewChart symbol={symbol} interval={interval} />
          </div>

          {/* Quick signal strip */}
          <div style={{ padding: "0 16px 16px" }}>
            <div style={{ ...CARD, display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#A78BFA" }}>📡 Last Signal</div>
                <div style={{ fontSize: 12, opacity: 0.5, marginTop: 3 }}>No signal yet — awaiting TradingView alert</div>
              </div>
              <div style={{
                background: "rgba(245,158,11,.12)",
                border: "1px solid rgba(245,158,11,.3)",
                borderRadius: 10, padding: "4px 10px",
                fontSize: 11, fontWeight: 700, color: "#F59E0B",
              }}>⏳ Idle</div>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════ TRADES TAB ══════════════ */}
      {tab === "trades" && (
        <div style={{ padding: 16 }}>
          {trades.length === 0 ? (
            <div style={{ ...CARD, textAlign: "center", padding: "40px 20px", marginBottom: 14 }}>
              <div style={{ fontSize: 44 }}>📋</div>
              <div style={{ marginTop: 10, opacity: 0.6, fontSize: 14, fontWeight: 700 }}>No trades today</div>
              <div style={{ marginTop: 6, opacity: 0.4, fontSize: 12 }}>
                Trades will appear here once the agent starts executing
              </div>
            </div>
          ) : trades.map((tr, i) => (
            <div key={i} style={{
              ...CARD, marginBottom: 10,
              display: "flex", justifyContent: "space-between", alignItems: "center",
            }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 13 }}>{tr.symbol}</div>
                <div style={{ fontSize: 11, opacity: 0.5, marginTop: 2 }}>
                  {tr.type} · {tr.qty} qty · {tr.time}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{
                  fontWeight: 900, fontSize: 15,
                  color: tr.pnl >= 0 ? "#10B981" : "#EF4444",
                }}>
                  {tr.pnl >= 0 ? "+" : ""}₹{tr.pnl}
                </div>
                <div style={{ fontSize: 11, opacity: 0.5 }}>{tr.status}</div>
              </div>
            </div>
          ))}

          {/* Weekly summary card */}
          <div style={{ ...CARD }}>
            <div style={{ fontWeight: 800, fontSize: 13, color: "#A78BFA", marginBottom: 12 }}>📅 Weekly Summary</div>
            {[
              ["Total Trades", trades.length],
              ["Win / Loss",   `${winTrades} / ${trades.length - winTrades}`],
              ["Win Rate",     trades.length ? `${winRate}%` : "--"],
              ["Net P&L",      `${todayPnl >= 0 ? "+" : ""}₹${Math.abs(todayPnl).toLocaleString("en-IN")}`],
            ].map(([label, val]) => (
              <div key={label} style={{
                display: "flex", justifyContent: "space-between",
                padding: "8px 0", borderBottom: "1px solid rgba(124,58,237,.1)",
              }}>
                <span style={{ fontSize: 12, opacity: 0.65 }}>{label}</span>
                <span style={{ fontSize: 12, fontWeight: 800 }}>{val}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ══════════════ AGENT TAB ══════════════ */}
      {tab === "agent" && (
        <div style={{ padding: 16 }}>

          {/* Agent Status Card */}
          <div style={{
            ...CARD,
            background: agentActive
              ? "linear-gradient(135deg,rgba(16,185,129,.14),rgba(5,150,105,.09))"
              : "linear-gradient(135deg,rgba(239,68,68,.12),rgba(185,28,28,.07))",
            border: `1px solid ${agentActive ? "rgba(16,185,129,.35)" : "rgba(239,68,68,.3)"}`,
            textAlign: "center", marginBottom: 14,
          }}>
            <div style={{ fontSize: 48, marginBottom: 8 }}>{agentActive ? "🤖" : "😴"}</div>
            <div style={{ fontWeight: 900, fontSize: 20, color: agentActive ? "#10B981" : "#EF4444" }}>
              Agent is {agentActive ? "ACTIVE" : "STOPPED"}
            </div>
            <div style={{ fontSize: 12, opacity: 0.55, marginTop: 6, lineHeight: 1.5 }}>
              {agentActive
                ? "Monitoring TradingView signals\nand auto-executing trades"
                : "Start agent to begin automated trading\nwith Zerodha Kite API"}
            </div>
            <button
              onClick={() => {
                if (agentActive) {
                  if (window.confirm("Stop the trading agent?\nAny open positions will NOT be auto-closed.")) {
                    setAgentActive(false);
                  }
                } else {
                  if (!kiteConnected) {
                    setTab("settings");
                    setTimeout(() => alert("⚠️ Please connect your Zerodha Kite API first in Setup tab!"), 200);
                    return;
                  }
                  setAgentActive(true);
                }
              }}
              style={{
                marginTop: 16,
                background: agentActive
                  ? "linear-gradient(135deg,#EF4444,#DC2626)"
                  : "linear-gradient(135deg,#7C3AED,#5B21B6)",
                border: "none", borderRadius: 12,
                color: "#fff", fontWeight: 900, fontSize: 15,
                padding: "12px 32px", cursor: "pointer",
                boxShadow: agentActive
                  ? "0 4px 20px rgba(239,68,68,.35)"
                  : "0 4px 20px rgba(124,58,237,.35)",
              }}
            >
              {agentActive ? "⏹ Stop Agent" : "▶ Start Agent"}
            </button>
          </div>

          {/* Pipeline Status */}
          <div style={{ ...CARD, marginBottom: 14 }}>
            <div style={{ fontWeight: 800, fontSize: 13, color: "#A78BFA", marginBottom: 12 }}>
              🔗 System Pipeline
            </div>
            <PipelineRow icon="📊" label="TradingView Strategy (Pine Script)" status="pending" />
            <PipelineRow icon="📡" label="Webhook Receiver"                   status="pending" />
            <PipelineRow icon="🧠" label="Claude AI Agent (Decision Engine)"  status="ready"  />
            <PipelineRow icon="🔌" label="Zerodha Kite API"                   status={kiteConnected ? "ready" : "pending"} />
            <PipelineRow icon="🛡️" label="Risk Manager"                       status="ready"  />
          </div>

          {/* Webhook URL */}
          <div style={{ ...CARD, marginBottom: 14 }}>
            <div style={{ fontWeight: 800, fontSize: 13, color: "#A78BFA", marginBottom: 10 }}>
              📡 TradingView Webhook URL
            </div>
            <div style={{
              background: "rgba(0,0,0,.3)", borderRadius: 8,
              padding: "10px 12px", fontSize: 11,
              fontFamily: "monospace", color: "#10B981", wordBreak: "break-all",
            }}>
              {window.location.origin}/api/webhook/trading
            </div>
            <div style={{ fontSize: 11, opacity: 0.45, marginTop: 8 }}>
              Paste this URL in TradingView → Alert → Webhook URL
            </div>
          </div>

          {/* Live Positions */}
          {positions.length > 0 && (
            <div style={{ ...CARD, marginBottom: 14,
              background: "linear-gradient(135deg,rgba(16,185,129,.1),rgba(5,150,105,.06))",
              border: "1px solid rgba(16,185,129,.3)",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <div style={{ fontWeight: 800, fontSize: 13, color: "#10B981" }}>
                  📡 Live Positions ({positions.length})
                </div>
                <div style={{
                  fontWeight: 900, fontSize: 14,
                  color: livePnl >= 0 ? "#10B981" : "#EF4444",
                }}>
                  {livePnl >= 0 ? "+" : ""}₹{livePnl.toLocaleString("en-IN")}
                </div>
              </div>
              {positions.map((p, i) => (
                <div key={i} style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "8px 0", borderBottom: i < positions.length - 1 ? "1px solid rgba(16,185,129,.1)" : "none",
                }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700 }}>{p.symbol}</div>
                    <div style={{ fontSize: 10, opacity: 0.5, marginTop: 1 }}>
                      Qty: {p.quantity} · Entry: ₹{p.buyPrice?.toFixed(2)}
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{
                      fontWeight: 900, fontSize: 13,
                      color: p.pnl >= 0 ? "#10B981" : "#EF4444",
                    }}>
                      {p.pnl >= 0 ? "+" : ""}₹{p.pnl}
                    </div>
                    <div style={{ fontSize: 10, opacity: 0.5 }}>{p.pnlPct}%</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Emergency Exit */}
          <div style={{ ...CARD, marginBottom: 14,
            border: "1px solid rgba(239,68,68,.3)",
            background: "rgba(239,68,68,.06)",
          }}>
            <div style={{ fontWeight: 800, fontSize: 13, color: "#EF4444", marginBottom: 8 }}>
              🚨 Emergency Exit
            </div>
            <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 12 }}>
              Instantly close ALL open positions at market price.
              Auto-triggered at 3:15 PM IST daily.
            </div>
            <button
              onClick={emergencyExit}
              disabled={exitLoading || positions.length === 0}
              style={{
                width: "100%",
                background: positions.length > 0
                  ? "linear-gradient(135deg,#EF4444,#DC2626)"
                  : "rgba(239,68,68,.2)",
                border: "none", borderRadius: 10, color: "#fff",
                fontWeight: 900, fontSize: 14, padding: "12px",
                cursor: positions.length > 0 ? "pointer" : "not-allowed",
                opacity: exitLoading ? 0.6 : 1,
              }}
            >
              {exitLoading
                ? "⏳ Closing positions..."
                : positions.length > 0
                  ? `🚨 EXIT ALL (${positions.length} open)`
                  : "✅ No open positions"}
            </button>
          </div>

          {/* How it works */}
          <div style={{ ...CARD }}>
            <div style={{ fontWeight: 800, fontSize: 13, color: "#A78BFA", marginBottom: 12 }}>
              ⚙️ How It Works
            </div>
            {[
              ["1", "TradingView signal fires (BUY/SELL)"],
              ["2", "Webhook hits our server instantly"],
              ["3", "Risk check: time, daily loss, trade count"],
              ["4", "Zerodha Kite places MARKET order"],
              ["5", "Stop-loss order auto-placed (40% SL)"],
              ["6", "Auto-exit at 3:15 PM if not closed"],
            ].map(([n, txt]) => (
              <div key={n} style={{ display: "flex", gap: 10, marginBottom: 10 }}>
                <div style={{
                  minWidth: 22, height: 22, borderRadius: "50%",
                  background: "rgba(124,58,237,.25)",
                  border: "1px solid rgba(124,58,237,.5)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 10, fontWeight: 900, color: "#A78BFA",
                }}>{n}</div>
                <span style={{ fontSize: 12, opacity: 0.8, lineHeight: 1.5 }}>{txt}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ══════════════ SETTINGS TAB ══════════════ */}
      {tab === "settings" && (
        <div style={{ padding: 16 }}>

          {/* Capital */}
          <div style={{ ...CARD, marginBottom: 14 }}>
            <div style={{ fontWeight: 800, fontSize: 13, color: "#A78BFA", marginBottom: 14 }}>
              💰 Capital Settings
            </div>
            <label style={{ fontSize: 12, opacity: 0.65, display: "block", marginBottom: 6 }}>
              Trading Capital (₹)
            </label>
            <input
              type="number"
              value={capital}
              onChange={e => setCapital(Number(e.target.value))}
              style={{ ...INPUT, fontSize: 16, fontWeight: 700 }}
            />
            <div style={{ fontSize: 11, opacity: 0.4, marginTop: 6 }}>
              Max loss per day = 3% = ₹{Math.round(capital * 0.03).toLocaleString("en-IN")}
            </div>
          </div>

          {/* Risk Rules */}
          <div style={{ ...CARD, marginBottom: 14 }}>
            <div style={{ fontWeight: 800, fontSize: 13, color: "#A78BFA", marginBottom: 12 }}>
              🛡️ Risk Rules (Auto-enforced)
            </div>
            {[
              { label: "Max loss per trade",  value: `₹${Math.round(capital * 0.02).toLocaleString("en-IN")}`, desc: "2% of capital" },
              { label: "Max loss per day",    value: `₹${Math.round(capital * 0.03).toLocaleString("en-IN")}`, desc: "3% → agent stops" },
              { label: "Max trades per day",  value: "3",     desc: "No overtrading" },
              { label: "Min Risk : Reward",   value: "1 : 2", desc: "Required for entry" },
              { label: "No-trade window",     value: "9:15–9:30", desc: "Skip opening volatility" },
            ].map(({ label, value, desc }) => (
              <div key={label} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "9px 0", borderBottom: "1px solid rgba(124,58,237,.1)",
              }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700 }}>{label}</div>
                  <div style={{ fontSize: 10, opacity: 0.45, marginTop: 1 }}>{desc}</div>
                </div>
                <div style={{
                  background: "rgba(124,58,237,.18)",
                  border: "1px solid rgba(124,58,237,.3)",
                  borderRadius: 7, padding: "4px 11px",
                  fontSize: 12, fontWeight: 900, color: "#A78BFA",
                }}>{value}</div>
              </div>
            ))}
          </div>

          {/* Zerodha Kite API */}
          <div style={{ ...CARD, marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div style={{ fontWeight: 800, fontSize: 13, color: "#A78BFA" }}>
                🔑 Zerodha Kite API
              </div>
              {kiteConnected && (
                <span style={{
                  background: "rgba(16,185,129,.14)", border: "1px solid rgba(16,185,129,.35)",
                  borderRadius: 10, padding: "3px 9px", fontSize: 11, fontWeight: 700, color: "#10B981",
                }}>✅ Connected</span>
              )}
            </div>
            <label style={{ fontSize: 12, opacity: 0.65, display: "block", marginBottom: 5 }}>API Key</label>
            <input
              type="password"
              placeholder="Enter Kite API Key"
              value={kiteKey}
              onChange={e => setKiteKey(e.target.value)}
              style={{ ...INPUT, marginBottom: 10 }}
            />
            <label style={{ fontSize: 12, opacity: 0.65, display: "block", marginBottom: 5 }}>API Secret</label>
            <input
              type="password"
              placeholder="Enter Kite API Secret"
              value={kiteSecret}
              onChange={e => setKiteSecret(e.target.value)}
              style={{ ...INPUT, marginBottom: 14 }}
            />
            <button
              onClick={async () => {
                if (!kiteKey || !kiteSecret) {
                  alert("Please enter both API Key and Secret.");
                  return;
                }
                // Save keys locally — OAuth callback will read them
                localStorage.setItem("tp_kite_keys", JSON.stringify({
                  api_key:    kiteKey.trim(),
                  api_secret: kiteSecret.trim(),
                }));
                try {
                  const r = await fetch(`/api/kite/connect?api_key=${encodeURIComponent(kiteKey.trim())}`);
                  const d = await r.json();
                  if (d.ok && d.loginUrl) {
                    window.location.href = d.loginUrl; // redirect to Zerodha
                  } else {
                    alert("❌ " + (d.error || "Could not get login URL"));
                  }
                } catch (e) {
                  alert("❌ Network error: " + e.message);
                }
              }}
              style={{
                width: "100%",
                background: kiteConnected
                  ? "linear-gradient(135deg,#10B981,#059669)"
                  : "linear-gradient(135deg,#7C3AED,#5B21B6)",
                border: "none", borderRadius: 10, color: "#fff",
                fontWeight: 800, fontSize: 14, padding: "12px", cursor: "pointer",
                boxShadow: "0 4px 16px rgba(124,58,237,.3)",
              }}
            >
              {kiteConnected
                ? `✅ Connected (${liveStatus?.kiteUser || "Zerodha"})`
                : "🔗 Connect Zerodha"}
            </button>
            {kiteConnected && (
              <button
                onClick={async () => {
                  if (!confirm("Disconnect Zerodha?")) return;
                  await fetch("/api/kite/connect", { method: "DELETE" });
                  pollStatus();
                }}
                style={{
                  width: "100%", marginTop: 8, background: "transparent",
                  border: "1px solid rgba(239,68,68,.35)", borderRadius: 10,
                  color: "#EF4444", fontWeight: 700, fontSize: 12,
                  padding: "8px", cursor: "pointer",
                }}
              >
                Disconnect
              </button>
            )}
            <div style={{ fontSize: 10, opacity: 0.4, marginTop: 8, textAlign: "center" }}>
              Keys saved locally only • Get API from kite.zerodha.com/apps
            </div>
          </div>

          {/* Strategy Symbols */}
          <div style={{ ...CARD }}>
            <div style={{ fontWeight: 800, fontSize: 13, color: "#A78BFA", marginBottom: 12 }}>
              📊 Trading Instruments
            </div>
            {[
              { label: "Primary",   value: "Nifty Weekly Options", status: "active"   },
              { label: "Secondary", value: "BankNifty Options",    status: "inactive" },
              { label: "Type",      value: "Options Buying (MIS)", status: "active"   },
            ].map(({ label, value, status }) => (
              <div key={label} style={{
                display: "flex", justifyContent: "space-between",
                padding: "8px 0", borderBottom: "1px solid rgba(124,58,237,.1)",
              }}>
                <span style={{ fontSize: 12, opacity: 0.6 }}>{label}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: status === "active" ? "#10B981" : "#E2D9F3" }}>
                  {value}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Bottom spacer */}
      <div style={{ height: 36 }} />
    </div>
  );
}
