// ─────────────────────────────────────────────────────────────────────────────
// lib/alpha/indicators.js — pure technical indicator math (no I/O)
// Candle format (Kite): [timestamp, open, high, low, close, volume]
// ─────────────────────────────────────────────────────────────────────────────

export function ema(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let v = prices.slice(0, period).reduce((s, p) => s + p, 0) / period;
  for (let i = period; i < prices.length; i++) v = prices[i] * k + v * (1 - k);
  return v;
}

export function rsi(prices, period = 7) {
  if (prices.length < period + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = prices[i] - prices[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  let ag = g / period, al = l / period;
  for (let i = period + 1; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

export function adx(candles, period = 14) {
  if (candles.length < period * 2 + 1) return null;
  const tr = [], pdm = [], mdm = [];
  for (let i = 1; i < candles.length; i++) {
    const [,, h, l] = candles[i];
    const [,, ph, pl, pc] = candles[i - 1];
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = h - ph, dn = pl - l;
    pdm.push(up > dn && up > 0 ? up : 0);
    mdm.push(dn > up && dn > 0 ? dn : 0);
  }
  const smooth = arr => {
    let s = arr.slice(0, period).reduce((a, b) => a + b, 0);
    const out = [s];
    for (let i = period; i < arr.length; i++) { s = s - s / period + arr[i]; out.push(s); }
    return out;
  };
  const sTR = smooth(tr), sP = smooth(pdm), sM = smooth(mdm);
  const dx = sTR.map((t, i) => {
    if (t === 0) return 0;
    const p = 100 * sP[i] / t, m = 100 * sM[i] / t;
    return p + m === 0 ? 0 : 100 * Math.abs(p - m) / (p + m);
  });
  if (dx.length < period) return null;
  return dx.slice(-period).reduce((a, b) => a + b, 0) / period;
}

export function vwap(candles) {
  let tpv = 0, vol = 0;
  for (const [,, h, l, c, v] of candles) { const tp = (h + l + c) / 3; tpv += tp * v; vol += v; }
  return vol > 0 ? tpv / vol : null;
}

// Average True Range — sizing stops relative to actual volatility
export function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const [,, h, l] = candles[i];
    const pc = candles[i - 1][4];
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// Normalized EMA slope: %-change of EMA over the last `bars` bars
export function emaSlope(prices, period = 21, bars = 5) {
  const now  = ema(prices, period);
  const then = ema(prices.slice(0, -bars), period);
  if (now === null || then === null || then === 0) return null;
  return ((now - then) / then) * 100;
}

// Realized volatility of 15-min returns, annualized-ish (relative measure only)
export function realizedVol(prices, lookback = 26) {
  if (prices.length < lookback + 1) return null;
  const rets = [];
  for (let i = prices.length - lookback; i < prices.length; i++) {
    rets.push(Math.log(prices[i] / prices[i - 1]));
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varc = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length;
  return Math.sqrt(varc) * 100; // % per 15-min bar
}
