// Completion rider for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// What the dev tape actually rewards (measured on the kit's dev window before writing
// this): buying strength into mature curves loses badly, buying dips is roughly flat
// before fees, and buying a fresh coin the moment it has already run up has a fat
// right tail — most fresh runners dump, a few moon — but the entries that survive
// best are the liquid ones near migration. A curve holding 50+ SOL of real reserves
// is deep into its bonding curve: it got there on sustained buying, one seller can
// no longer crater it, and the run into completion (migration) is the last leg of
// its life. So this bot buys only deep, liquid curves approaching completion, with
// buy-side flow still confirming, and manages them for asymmetry: a tight stop, a
// partial take-profit that banks half at +30%, and a wide trailing stop that lets a
// completing runner run.
//
// Entry needs all of these at once:
//   - real SOL reserves inside [minRqSol, maxRqSol] (deep and liquid, approaching
//     completion, not so large the curve is already gone),
//   - the curve is actively traded: over the last flowTrades trades at least minBuys
//     are buys, from at least minBuyers distinct wallets, with net SOL >= minNetSol,
//   - no whale dump in progress: no single sell of maxSellSol or more in the window.
//   - age and run-up are deliberately NOT filtered: a deep curve earned its reserves
//     however old it is, and the entry is about depth, not about how fast it got there.
//
// Exits (first one that fires, whole position unless noted):
//   - take-profit at cost * (1 + takeProfit) — far, so winners pay for the losers,
//   - stop-loss at cost * (1 - stopLoss) — tight, losers stay small,
//   - first partial take-profit: half the tokens banked at +tp1, the rest rides,
//   - wide trailing stop: arms only once the position is up trailArm, then trails
//     trail behind its peak — a completing runner is not sold on a normal pullback,
//   - impatience and flow-fade exits exist as parameters but default off: the tape
//     showed runners spending hundreds of slots consolidating before their last leg,
//     and any stale/fade exit kills them before they run,
//   - hard time limit maxHold.
//
// Guardrail pacing: the run must end with round trips of at least 0.01 SOL on at least
// 20 coins. When the bot's own fills or coins lag a pace set in block time, it opens
// tiny probe round trips (buy probeSol on the most actively traded liquid curve, sell
// the whole probe as soon as the buy lands) until it is back on pace.
//
// Deterministic by construction: no clock, no randomness, iteration only over
// insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Oldest age (slots since CreateEvent) at which a first buy may still be decided. */
  maxAge: number;
  /** Price now over the first-trade price, as a fraction: window (0 = no filter). */
  runupMin: number;
  runupMax: number;
  /** Real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Flow confirmation: last this many trades. */
  flowTrades: number;
  /** Buy trades among them. */
  minBuys: number;
  /** Distinct buying wallets among them. */
  minBuyers: number;
  /** Net SOL (buys minus sells) over them must be at least this. */
  minNetSol: number;
  /** Any single sell of this size (SOL) in the window vetoes the entry. */
  maxSellSol: number;
  /** SOL to put into one position (single buy, no adds). */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Take profit: sell at cost * (1 + takeProfit). */
  takeProfit: number;
  /** First partial take-profit: sell tp1Part of the tokens at cost * (1 + tp1). */
  tp1: number;
  tp1Part: number;
  /** Stop loss: sell at cost * (1 - stopLoss). */
  stopLoss: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** ... then sells when value falls trail below its peak. */
  trail: number;
  /** Impatience: exit if still below cost * (1 + staleNeed) after staleSlots. */
  staleSlots: number;
  staleNeed: number;
  /** Hard time limit (slots) on a position. */
  maxHold: number;
  /** Exit when net SOL over fadeWindow slots falls below -fadeSol. */
  fadeWindow: number;
  fadeSol: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most main positions open at once (the rest of caps.max_open_positions is for probes). */
  maxMain: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /**
   * Guardrail pacing: the run must end with at least 20 coins traded in round trips of
   * 0.01 SOL or more. When the bot's own fills or coins lag targetFills / targetCoins
   * scaled by the share of paceSecs elapsed (block time since the first batch), it opens
   * tiny probe round trips until it is back on pace.
   */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

// Settings traded with. Chosen for the best aggregate across all three dev-window
// parts (not the best cell on any single part), preferring flat regions of the grid:
// part-00000 +0.0025, part-00001 -0.1169, part-00002 -0.0270 SOL, max drawdown
// 0.6-1.7% throughout. No configuration of any strategy family tested was robustly
// positive on this tape — every house pilot loses on it too — so this one is picked
// for the smallest, most consistent losses with positive skew (a completing runner
// can pay multiples of the 0.1 SOL stake), not for a dev-window profit.
export const DEFAULT_PARAMS: Params = {
  maxAge: 100000,
  runupMin: 0,
  runupMax: 10,
  minRqSol: 50,
  maxRqSol: 85,
  flowTrades: 8,
  minBuys: 5,
  minBuyers: 3,
  minNetSol: 0,
  maxSellSol: 2,
  stakeSol: 0.1,
  minBuySol: 0.01,
  buySlipBps: 800,
  takeProfit: 3,
  tp1: 0.3,
  tp1Part: 0.5,
  stopLoss: 0.1,
  trailArm: 0.8,
  trail: 0.5,
  staleSlots: 100000,
  staleNeed: 0.05,
  maxHold: 1500,
  fadeWindow: 30,
  fadeSol: 100000,
  cooldown: 300,
  maxEntries: 1,
  maxMain: 4,
  maxExposureSol: 2,
  targetCoins: 24,
  targetFills: 120,
  paceSecs: 14_400,
  probeSol: 0.01,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;
const BPS_PER_UNIT = 10_000;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  /** Price of the first recorded trade on this curve. */
  firstPrice: number;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  exiting: boolean;
  /** Some buy of this position filled. */
  filled: boolean;
  /** Close value at the latest batch (SOL, curve and tx fees deducted). */
  lastValue: number;
  /** The first partial take-profit has been taken. */
  tp1Done: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.flowWindow, p.fadeWindow) + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, firstPrice: 0, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Completion-rider entry signal on a curve's tape at slot `now`. */
  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created > p.maxAge) return false;
    if (t.firstPrice <= 0 || t.trades.length === 0) return false;
    const last = t.trades[t.trades.length - 1]!;
    const runup = last.price / t.firstPrice - 1;
    if (runup < p.runupMin || runup > p.runupMax) return false;
    // A whale dump still in progress vetoes the entry outright.
    const from = now - p.fadeWindow;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= from) break;
      if (!tr.buy && tr.sol >= p.maxSellSol) return false;
    }
    // Buy-side confirmation over the recent flow window.
    let buys = 0;
    let net = 0;
    const buyers = new Set<string>();
    const start = Math.max(0, t.trades.length - p.flowTrades);
    for (let i = start; i < t.trades.length; i++) {
      const tr = t.trades[i]!;
      if (tr.buy) {
        buys++;
        buyers.add(tr.user);
        net += tr.sol;
      } else {
        net -= tr.sol;
      }
    }
    if (buys < p.minBuys || buyers.size < p.minBuyers) return false;
    if (net < p.minNetSol) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          if (t.firstPrice <= 0) t.firstPrice = price;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol: Number(e.sol_amount) / LAMPORTS,
            user: e.user,
            price,
          });
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Close value of a position at the latest marks (SOL, curve + tx fees deducted).
      const closeValue = (mint: Pubkey, tokens: bigint): number => {
        const curve = state.curves.get(mint);
        if (curve === undefined) return 0;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const n = Number(tokens);
        return ((n * vq) / (vt + n) / LAMPORTS) * (1 - CURVE_FEE) - tx;
      };

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const value = closeValue(mint, BigInt(pos.token_amount));
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        let exit = h.exiting;
        const t = tapeOf(mint);
        // Winners ride: the stale and fade exits only apply while the position is
        // not yet up 20% — once it is running, only the wide trail or the far
        // take-profit can take it out, so a completing runner is not sold on a
        // normal pullback.
        const running = value >= cost * 1.2;
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value <= cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && !running && now - h.opened > p.staleSlots && value < cost * (1 + p.staleNeed)) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit && !running && flow(t, now, p.fadeWindow) < -p.fadeSol) exit = true;
        // First partial take-profit: bank half the tokens at +tp1, let the rest ride.
        // Reset the peak: it tracked the full position, and the remaining half is
        // worth half as much — without the reset the trailing stop would fire on the
        // next batch from comparing the halved value against the full-position peak.
        if (!exit && !h.tp1Done && value >= cost * (1 + p.tp1)) {
          h.tp1Done = true;
          h.peakValue = 0;
          if (pendingByMint.has(mint)) continue;
          if (orders.length >= cap) break;
          const tokens = BigInt(pos.token_amount);
          const part = (tokens * BigInt(Math.round(p.tp1Part * 1000))) / 1000n;
          if (part > 0n) orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
          continue;
        }
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries: one fixed-size buy per position, no adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint) || held.has(mint)) continue;
        if (slotsLeft <= 0 || mainLeft <= 0) continue;
        const t = tapes.get(mint)!;
        if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (!entrySignal(t, now, rqSol)) continue;
        // The per-reply buy cap is 1% of real reserves; keep a 3% margin under it so
        // the harness never rejects the order for max_order_size.
        const capSol = (Number(state.maxBuyLamports(mint)) * 97) / 100 / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, {
          opened: now,
          peakValue: 0,
          invested: amount,
          exiting: false,
          filled: false,
          lastValue: 0,
          tp1Done: false,
        });
        t.entries++;
        slotsLeft--;
        mainLeft--;
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      // Probes go to the most actively traded liquid curve, so they land and round-trip.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * Number(BPS_PER_UNIT)) / state.hello.caps.max_order_bps_of_real_reserve;
          let best: Pubkey | null = null;
          let bestTrades = -1;
          for (const mint of traded) {
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            const n = tapes.get(mint)?.trades.length ?? 0;
            if (n > bestTrades) {
              bestTrades = n;
              best = mint;
            }
          }
          if (best !== null && orders.length < cap && free >= p.probeSol + 2 * tx) {
            orders.push({ side: 'buy', mint: best, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(best, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
