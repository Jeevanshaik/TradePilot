// ─────────────────────────────────────────────────────────────────────────────
// lib/alpha/risk.js — position management, Bayesian strategy weighting,
// intraday stop/target exits, daily kill-switch.
//
// Stops are FIXED % of entry price so they are deterministic across runs
// (paper_trades has no sl/target columns — no schema change needed):
//   NIFTY:      SL 0.35%  target 0.60%
//   BANKNIFTY:  SL 0.45%  target 0.80%
// P&L model matches autoexit.js: delta-0.3 credit-spread approximation, capped.
// ─────────────────────────────────────────────────────────────────────────────

const STOPS = {
  NIFTY:     { sl: 0.35, tgt: 0.60 },
  BANKNIFTY: { sl: 0.45, tgt: 0.80 },
  DEFAULT:   { sl: 0.40, tgt: 0.70 },
};

export function stopsFor(symbol) { return STOPS[symbol] || STOPS.DEFAULT; }

function paperPnl(trade, exitPrice) {
  const lotSize   = trade.lot_size || 75;
  const direction = trade.action === "BUY" ? 1 : -1;
  const rawPnl    = direction * (exitPrice - trade.entry_price) * lotSize * 0.3;
  return Math.round(Math.max(Math.min(rawPnl, 50 * lotSize * 0.3), -80 * lotSize * 0.3));
}

// Bayesian-lite strategy weighting: Laplace-smoothed win rate over the last
// 40 closed paper trades → score multiplier in [0.6 .. 1.4]. A strategy that
// keeps losing gets muted automatically; a winner gets amplified.
export async function bayesFactor(sb, symbol) {
  try {
    const { data } = await sb
      .from("paper_trades")
      .select("pnl")
      .eq("symbol", symbol)
      .eq("status", "closed")
      .order("entry_time", { ascending: false })
      .limit(40);
    const trades = data || [];
    if (trades.length < 5) return 1; // not enough evidence — neutral prior
    const wins    = trades.filter(t => (t.pnl || 0) > 0).length;
    const winRate = (wins + 1) / (trades.length + 2); // Laplace smoothing
    return Math.round((0.6 + 0.8 * winRate) * 100) / 100;
  } catch (e) {
    console.warn(`[risk] bayesFactor(${symbol}): ${e.message}`);
    return 1;
  }
}

// Daily kill-switch: stop opening new trades after heavy drawdown or a
// losing streak. Evidence-based circuit breaker — protects the day.
export async function killSwitch(sb, todayISO, maxDailyLoss = 3000) {
  try {
    const { data } = await sb
      .from("paper_trades")
      .select("pnl, exit_time")
      .eq("status", "closed")
      .gte("entry_time", todayISO)
      .order("exit_time", { ascending: true });
    const closed = data || [];
    const dayPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
    if (dayPnl <= -maxDailyLoss)
      return { blocked: true, why: `Daily loss ₹${Math.abs(dayPnl)} ≥ ₹${maxDailyLoss} — done for today` };
    let streak = 0;
    for (let i = closed.length - 1; i >= 0; i--) {
      if ((closed[i].pnl || 0) < 0) streak++; else break;
    }
    if (streak >= 3)
      return { blocked: true, why: `${streak} consecutive losses — cooling off` };
    return { blocked: false, dayPnl };
  } catch (e) {
    console.warn(`[risk] killSwitch: ${e.message}`);
    return { blocked: false };
  }
}

// Intraday exit management — runs BEFORE new-entry logic every cycle.
// Closes open paper trades on: stop-loss, target, or a strong opposite
// ensemble score (signal flip). Returns list of exits performed.
export async function manageOpenTrades(sb, symbol, lastPrice, ensembleScoreNow) {
  const exits = [];
  try {
    const { data: open } = await sb
      .from("paper_trades")
      .select("*")
      .eq("symbol", symbol)
      .eq("status", "open");

    for (const t of open || []) {
      const dir     = t.action === "BUY" ? 1 : -1;
      const movePct = dir * ((lastPrice - t.entry_price) / t.entry_price) * 100;
      const { sl, tgt } = stopsFor(symbol);

      let exitReason = null;
      if (movePct <= -sl)      exitReason = `Stop-loss ${sl}% hit (${movePct.toFixed(2)}%)`;
      else if (movePct >= tgt) exitReason = `Target ${tgt}% hit (+${movePct.toFixed(2)}%)`;
      else if (ensembleScoreNow !== null && Math.sign(ensembleScoreNow) === -dir
               && Math.abs(ensembleScoreNow) >= 0.40)
        exitReason = `Signal flip (ensemble ${ensembleScoreNow.toFixed(2)} against position)`;

      if (!exitReason) continue;

      const pnl = paperPnl(t, lastPrice);
      const { error } = await sb.from("paper_trades").update({
        status:     "closed",
        exit_price: lastPrice,
        pnl,
        exit_time:  new Date().toISOString(),
      }).eq("id", t.id).eq("status", "open"); // guard vs double-close

      if (error) { console.warn(`[risk] exit update failed: ${error.message}`); continue; }
      exits.push({ id: t.id, action: t.action, entry: t.entry_price, exit: lastPrice, pnl, why: exitReason });
      console.log(`[risk] ${symbol} ${t.action} closed: ${exitReason} | P&L ₹${pnl}`);
    }
  } catch (e) {
    console.warn(`[risk] manageOpenTrades(${symbol}): ${e.message}`);
  }
  return exits;
}
