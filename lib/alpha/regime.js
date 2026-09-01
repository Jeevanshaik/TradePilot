// ─────────────────────────────────────────────────────────────────────────────
// lib/alpha/regime.js — market regime classifier + regime-conditional weights
//
// Regimes:
//   STORM      — VIX blown out or realized vol spiking → NO new trades
//   TREND_UP   — directional, momentum strategies get full weight
//   TREND_DOWN — directional short side
//   RANGE      — chop; only exceptional breakout + flow evidence trades
// ─────────────────────────────────────────────────────────────────────────────

export function classifyRegime({ adx, slope, vix, rv }) {
  if (vix !== null && vix > 22)
    return { regime: "STORM", why: `VIX ${vix.toFixed(1)} > 22` };
  if (rv !== null && rv > 0.45)
    return { regime: "STORM", why: `Realized vol ${rv.toFixed(2)}%/bar spiking` };

  if (adx !== null && adx >= 20 && slope !== null) {
    if (slope > 0.04)  return { regime: "TREND_UP",   why: `ADX ${adx.toFixed(0)}, EMA21 slope +${slope.toFixed(2)}%` };
    if (slope < -0.04) return { regime: "TREND_DOWN", why: `ADX ${adx.toFixed(0)}, EMA21 slope ${slope.toFixed(2)}%` };
  }
  return { regime: "RANGE", why: `ADX ${adx?.toFixed(0) ?? "?"} / flat slope — chop` };
}

// Component weights per regime (sum = 1). In RANGE, breakout + real order
// flow dominate; trend-following components are muted.
export function regimeWeights(regime) {
  if (regime === "RANGE") {
    return { ema: 0.10, mom: 0.10, vwap: 0.10, orb: 0.30, obi: 0.20, flow: 0.10, vol: 0.10 };
  }
  // TREND_UP / TREND_DOWN
  return { ema: 0.25, mom: 0.15, vwap: 0.15, orb: 0.10, obi: 0.15, flow: 0.10, vol: 0.10 };
}

// Entry threshold on |ensemble score| — RANGE demands stronger evidence
export function regimeThreshold(regime) {
  return regime === "RANGE" ? 0.45 : 0.32;
}
