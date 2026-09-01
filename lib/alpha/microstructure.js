// ─────────────────────────────────────────────────────────────────────────────
// lib/alpha/microstructure.js — order-flow features from the futures book
//
// The spot index (NIFTY 50 / NIFTY BANK) has NO order book — it's not
// tradeable. Real flow lives in the current-month futures contract, so we
// derive microstructure there:
//   • orderBookImbalance  — 5-level bid vs ask depth, [-1..+1]
//   • flowImbalance       — total pending buy vs sell qty, [-1..+1]
//   • spreadBps           — execution cost gate
//   • liquidityVacuum     — dangerously thin top-of-book
//   • vpinLite(candles)   — flow toxicity proxy from signed candle volume [0..1]
// ─────────────────────────────────────────────────────────────────────────────

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN",
                "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// Current-month futures tradingsymbol, e.g. NIFTY26SEPFUT.
// monthOffset=1 → next month (used as fallback right after expiry).
export function futuresSymbol(symbol, istNow, monthOffset = 0) {
  const d = new Date(istNow);
  d.setMonth(d.getMonth() + monthOffset);
  const yy = String(d.getFullYear()).slice(2);
  return `${symbol}${yy}${MONTHS[d.getMonth()]}FUT`;
}

async function kiteQuote(instrument, apiKey, accessToken) {
  const r = await fetch(
    `https://api.kite.trade/quote?i=${encodeURIComponent(instrument)}`,
    { headers: { "X-Kite-Version": "3", Authorization: `token ${apiKey}:${accessToken}` } },
  );
  const data = await r.json();
  if (data.status !== "success") throw new Error(data.message || "quote failed");
  const key = Object.keys(data.data || {})[0];
  if (!key) throw new Error(`no quote data for ${instrument}`);
  return data.data[key];
}

// Fetch futures microstructure. Tries current month, rolls to next month
// after expiry. Returns null on total failure (engine degrades gracefully).
export async function fetchMicro(symbol, istNow, apiKey, accessToken) {
  for (const offset of [0, 1]) {
    const fut = futuresSymbol(symbol, istNow, offset);
    try {
      const q = await kiteQuote(`NFO:${fut}`, apiKey, accessToken);
      const bids = (q.depth?.buy  || []).filter(d => d.quantity > 0);
      const asks = (q.depth?.sell || []).filter(d => d.quantity > 0);
      if (!bids.length || !asks.length) continue;

      const bidQty = bids.reduce((s, d) => s + d.quantity, 0);
      const askQty = asks.reduce((s, d) => s + d.quantity, 0);
      const obi    = (bidQty - askQty) / (bidQty + askQty);

      const totBuy  = q.buy_quantity  || 0;
      const totSell = q.sell_quantity || 0;
      const flowImb = (totBuy + totSell) > 0
        ? (totBuy - totSell) / (totBuy + totSell) : 0;

      const bestBid = bids[0].price, bestAsk = asks[0].price;
      const mid       = (bestBid + bestAsk) / 2;
      const spreadBps = mid > 0 ? ((bestAsk - bestBid) / mid) * 10000 : 999;

      // Thin book = both sides' visible 5-level depth unusually small
      const liquidityVacuum = (bidQty + askQty) < 500;

      return {
        contract: fut,
        futPrice: q.last_price,
        obi:      Math.max(-1, Math.min(1, obi)),
        flowImb:  Math.max(-1, Math.min(1, flowImb)),
        spreadBps: Math.round(spreadBps * 10) / 10,
        liquidityVacuum,
        bidQty, askQty,
      };
    } catch (e) {
      console.warn(`[micro] ${fut}: ${e.message}`);
    }
  }
  return null;
}

// VPIN-lite: |signed volume| / total volume over the last N candles.
// High value ⇒ one-sided (toxic) flow — informed traders pushing price.
export function vpinLite(candles, lookback = 20) {
  const recent = candles.slice(-lookback);
  if (recent.length < 5) return null;
  let signed = 0, total = 0;
  for (const [, o,,, c, v] of recent) {
    const dir = c > o ? 1 : c < o ? -1 : 0;
    signed += dir * v;
    total  += v;
  }
  if (total === 0) return null;
  return { toxicity: Math.abs(signed) / total, direction: Math.sign(signed) };
}
