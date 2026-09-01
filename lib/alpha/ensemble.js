// ─────────────────────────────────────────────────────────────────────────────
// lib/alpha/ensemble.js — weighted ensemble alpha score
//
// Every component emits a score in [-1..+1] (+ = bullish). The regime picks
// the weights; the weighted sum is the alpha score. A trade needs BOTH:
//   • |score| ≥ regime threshold
//   • ≥ 3 components agreeing with the score's direction (|c| > 0.15)
// This is meta-labeling in spirit: the crossover says "maybe", the ensemble
// decides "yes/no + how much confidence".
// ─────────────────────────────────────────────────────────────────────────────

const clip = (x, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));

export function componentScores({ closes, e7, e21, e7prev, e21prev, rsiV, vwapV,
                                  last, orbHi, orbLo, micro, vpin, volRatio, lastCandleDir }) {
  const c = {};

  // 1. EMA structure: gap between EMA7/EMA21 scaled by price, cross bonus
  if (e7 !== null && e21 !== null) {
    const gap = ((e7 - e21) / last) * 1000;             // ~[-3..3] on indices
    let s = clip(Math.tanh(gap));
    const bullCross = e7prev !== null && e21prev !== null && e7prev <= e21prev && e7 > e21;
    const bearCross = e7prev !== null && e21prev !== null && e7prev >= e21prev && e7 < e21;
    if (bullCross) s = clip(s + 0.35);
    if (bearCross) s = clip(s - 0.35);
    c.ema = s;
  } else c.ema = 0;

  // 2. Momentum: RSI centered at 50; fade the extremes (mean-reversion risk)
  if (rsiV !== null) {
    if (rsiV >= 80)      c.mom = 0.1;    // overbought — don't chase
    else if (rsiV <= 20) c.mom = -0.1;   // oversold — don't chase
    else                 c.mom = clip((rsiV - 50) / 30);
  } else c.mom = 0;

  // 3. VWAP position: above = institutional support, below = ceiling
  c.vwap = (vwapV && last)
    ? clip(Math.tanh(((last - vwapV) / vwapV) * 500))
    : 0;

  // 4. Opening-range breakout
  c.orb = 0;
  if (orbHi !== null && orbLo !== null) {
    if (last > orbHi) c.orb = clip(0.5 + ((last - orbHi) / orbHi) * 300);
    else if (last < orbLo) c.orb = clip(-0.5 - ((orbLo - last) / orbLo) * 300);
  }

  // 5. Order-book imbalance (futures 5-level depth)
  c.obi = micro ? micro.obi : 0;

  // 6. Pending-flow imbalance (futures total buy vs sell qty)
  c.flow = micro ? micro.flowImb : 0;

  // 7. Volume surge in the direction of the last candle
  c.vol = (volRatio && lastCandleDir)
    ? clip(lastCandleDir * Math.min(volRatio / 2, 1)) * (volRatio > 1.2 ? 1 : 0.3)
    : 0;

  return c;
}

export function ensembleScore(components, weights) {
  let score = 0;
  for (const k of Object.keys(weights)) score += (components[k] ?? 0) * weights[k];
  return clip(score);
}

export function agreement(components, direction) {
  return Object.values(components)
    .filter(v => Math.sign(v) === direction && Math.abs(v) > 0.15).length;
}

// Decide: returns null or { action, score, confidence, agreeing }
export function decide(components, weights, threshold, bayesFactor = 1, toxicity = null) {
  let score = ensembleScore(components, weights) * bayesFactor;

  // Toxic one-sided flow AGAINST the signal is a veto amplifier; WITH it, a boost
  if (toxicity && toxicity.toxicity > 0.55) {
    const dir = Math.sign(score);
    score = dir === toxicity.direction ? clip(score * 1.15) : score * 0.7;
  }

  const dir = Math.sign(score);
  if (Math.abs(score) < threshold) return null;

  const agreeing = agreement(components, dir);
  if (agreeing < 3) return null;

  return {
    action:     dir > 0 ? "BUY" : "SELL",
    score:      Math.round(score * 100) / 100,
    confidence: Math.min(99, Math.round(Math.abs(score) * 100)),
    agreeing,
  };
}
