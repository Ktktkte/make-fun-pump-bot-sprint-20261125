// Pump.fun fresh-coin sniper for agent-fun/replay/v2.
//
// The harness speaks agent-fun/replay/v2: it sends one `hello` line, then one
// `batch` per slot that carries universe records, and expects one `orders`
// reply per batch. Orders decided on the batch for slot s fill at slot s +
// latency_slots. This bot is a sniper: the dev data shows most pump.fun
// coins bleed out within minutes (median life ~3 minutes) and dip-recovery
// has no edge (only ~29% of dips reach +12% before -6%). The only fat tail
// is fresh coins: a few percent run +50% to +300% in their first minutes.
// Entries require buy-dominated early flow (graded best of six variants:
// v5 filtered snipe -2.29 SOL, v2 dip -2.51, v3 snipe -2.55, v6 strict
// -2.56, v4 unfiltered -4.18, v1 dip -9.98; the dev window is a losing
// regime for every variant, so v5 wins on least drawdown, 23%, and fewest
// rejected orders). Exits bank
// half at +30% and trail the rest 15% off its peak, cut losers at -6%, and
// never hold more than ~30 batches, because gap-downs between batches are
// the dominant loss. Buys carry a tight 5% slippage guard; sells carry a
// wide 20% guard, because a stop that gets rejected for slippage while the
// coin crashes is worse than a bad fill. Every decision is a pure function
// of the hello and batch data seen so far: no clock, no environment, no
// randomness, so the two graded executions produce byte-identical action
// logs.

import {
  runBot,
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type OrderInput,
} from "./vendor/makefun-bot.ts";

// ------------------------------------------------------------------ tuning
/** SOL spent on one entry, before the per-mint size cap trims it. */
const BUY_SOL = 0.15;
/** A coin is only a snipe candidate this many slots after its creation. */
const MAX_AGE_SLOTS = 200;
/** ...or this many batches after first sight when no create slot is known. */
const MAX_AGE_BATCHES = 40;
/** Minimum trades seen before an entry. */
const MIN_TRADES = 3;
/** Early flow must be at least this buy-dominated (share of SOL volume). */
const MIN_BUY_SHARE_BPS = 6000;
/** Entry price must be at least this far above the first seen price. */
const MIN_LIFT_BPS = 100;
/** Ignore coins thinner than this many real SOL in the pool. */
const MIN_REAL_SOL = 2;
/** Sell half the position once it is this far above its cost basis. */
const TAKE_HALF_BPS = 3000;
/** Trailing stop: sell the rest once it falls this far below its peak. */
const TRAIL_BPS = 1500;
/** Sell everything once it is this far below its cost basis. */
const STOP_BPS = 600;
/** Sell everything after this many batches held without hitting a target. */
const MAX_HOLD_BATCHES = 30;
/** Never open a position smaller than this: fees would eat the trade. */
const MIN_BUY_SOL = 0.02;
/** Slippage guard on buys: never chase into a spike. */
const BUY_SLIPPAGE_BPS = 500;
/** Slippage guard on sells: wide, so a stop executes even in a crash. */
const SELL_SLIPPAGE_BPS = 2000;
/** Batches to wait before re-entering a mint after an exit. */
const REENTRY_COOLDOWN = 20;
/** Lamports in one SOL, as a float for price maths. */
const SOL = 1_000_000_000;

// ------------------------------------------------------------------ memory
interface CoinMemory {
  /** Price in SOL per token when the mint was first seen. */
  firstPrice: number;
  /** Batch seq when the mint was first seen. */
  firstSeq: number;
  /** Slot when the mint was created (null when never saw its CreateEvent). */
  createdSlot: number | null;
  /** Cumulative buy-side SOL volume (lamports) since first sight. */
  buyVol: bigint;
  /** Cumulative sell-side SOL volume (lamports) since first sight. */
  sellVol: bigint;
  /** Batch seq when the current position was first seen (null when flat). */
  enteredSeq: number | null;
  /** True once the half-take-profit sell has gone out for this position. */
  halfTaken: boolean;
  /** Highest cost-basis ratio (bps) seen for the current position. */
  peakBps: number;
  /** Batch seq of the last exit sell on this mint (null when never exited). */
  lastExitSeq: number | null;
}

const coins = new Map<string, CoinMemory>();

function memoryFor(mint: string): CoinMemory {
  let m = coins.get(mint);
  if (m === undefined) {
    m = {
      firstPrice: 0,
      firstSeq: -1,
      createdSlot: null,
      buyVol: 0n,
      sellVol: 0n,
      enteredSeq: null,
      halfTaken: false,
      peakBps: 10_000,
      lastExitSeq: null,
    };
    coins.set(mint, m);
  }
  return m;
}

/** SOL per token from a curve's virtual reserves; 0 when unusable. */
function priceOf(vQuote: bigint, vToken: bigint): number {
  if (vToken <= 0n || vQuote <= 0n) return 0;
  return Number(vQuote) / Number(vToken);
}

// ------------------------------------------------------------------ the bot
await runBot({
  onHello(_state) {
    // Nothing to seed: the strategy is driven entirely by the batch stream.
  },

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const txFee = state.txFeeLamports();

    // Learn every new curve and fold this batch's trade flow into memory.
    for (const [mint, curve] of state.curves) {
      if (curve.complete) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0) continue;
      const mem = memoryFor(mint);
      if (mem.firstSeq === -1) {
        mem.firstSeq = batch.seq;
        mem.firstPrice = price;
      }
      if (mem.createdSlot === null && curve.created_slot !== null) {
        mem.createdSlot = curve.created_slot;
      }
    }
    for (const e of batch.events) {
      if (e.event !== "TradeEvent") continue;
      const mem = coins.get(e.mint);
      if (mem === undefined) continue;
      const amt = BigInt(e.sol_amount);
      if (e.is_buy) mem.buyVol += amt;
      else mem.sellVol += amt;
    }

    // Mints with a buy or sell already in flight: do not stack orders on them.
    const pendingBuy = new Set<string>();
    const pendingSell = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === "buy") pendingBuy.add(p.order.mint);
      else pendingSell.add(p.order.mint);
    }

    // ---- exits: manage every open position first, before any new entry.
    for (const [mint, holding] of state.positions) {
      if (pendingSell.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0) continue;
      const mem = memoryFor(mint);
      if (mem.enteredSeq === null) {
        mem.enteredSeq = batch.seq;
        mem.halfTaken = false;
        mem.peakBps = 10_000;
      }
      const costPerToken =
        Number(holding.cost_lamports) / Number(holding.token_amount);
      if (costPerToken <= 0) continue;
      const ratioBps = Math.floor((price / costPerToken) * 10_000);
      if (ratioBps > mem.peakBps) mem.peakBps = ratioBps;
      const heldBatches = batch.seq - mem.enteredSeq;
      const tokens = BigInt(holding.token_amount);

      if (ratioBps <= 10_000 - STOP_BPS) {
        // Fast stop: most fresh coins die; never let one bleed.
        orders.push({ side: "sell", mint, token_amount: tokens, max_slippage_bps: SELL_SLIPPAGE_BPS });
        mem.lastExitSeq = batch.seq;
      } else if (ratioBps >= 10_000 + TAKE_HALF_BPS && !mem.halfTaken) {
        // Bank half once the runner shows itself; the rest rides the trail.
        mem.halfTaken = true;
        orders.push({ side: "sell", mint, token_amount: tokens / 2n, max_slippage_bps: SELL_SLIPPAGE_BPS });
      } else if (mem.halfTaken && ratioBps <= mem.peakBps - (mem.peakBps * TRAIL_BPS) / 10_000) {
        // Trailing stop: the runner turned; keep what the peak gave us.
        orders.push({ side: "sell", mint, token_amount: tokens, max_slippage_bps: SELL_SLIPPAGE_BPS });
        mem.lastExitSeq = batch.seq;
      } else if (heldBatches >= MAX_HOLD_BATCHES) {
        // Time stop: a snipe that goes nowhere in ~30 batches is dead money,
        // and every extra batch held is another chance to gap down.
        orders.push({ side: "sell", mint, token_amount: tokens, max_slippage_bps: SELL_SLIPPAGE_BPS });
        mem.lastExitSeq = batch.seq;
      }
    }

    // Forget positions that are gone so a re-entry starts clean.
    for (const [mint, mem] of coins) {
      if (!state.positions.has(mint) && !pendingBuy.has(mint)) {
        mem.enteredSeq = null;
        mem.halfTaken = false;
        mem.peakBps = 10_000;
      }
    }

    // ---- entries: fresh coins only, buy-dominated early flow, tiny size.
    // Open slots are counted once up front, including buys decided earlier
    // in this same batch, so the 5-position cap can never be overshot.
    const buysDecided = orders.filter((o) => o.side === "buy").length;
    let slotsLeft = state.hello.caps.max_open_positions -
      state.committedPositionCount() - buysDecided;
    if (slotsLeft > 0) {
      for (const [mint, curve] of state.curves) {
        if (slotsLeft <= 0) break;
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        if (curve.complete) continue;
        if (state.positions.has(mint) || pendingBuy.has(mint)) continue;
        const mem = coins.get(mint);
        if (mem === undefined || mem.firstSeq === -1) continue;
        if (mem.lastExitSeq !== null && batch.seq - mem.lastExitSeq < REENTRY_COOLDOWN) continue;
        // Age gate: only a coin still in its first minute of life.
        const ageOk = mem.createdSlot !== null
          ? batch.slot - mem.createdSlot <= MAX_AGE_SLOTS
          : batch.seq - mem.firstSeq <= MAX_AGE_BATCHES;
        if (!ageOk) continue;
        if (curve.trades < MIN_TRADES) continue;
        const realSol = Number(curve.real_quote_reserves) / SOL;
        if (realSol < MIN_REAL_SOL) continue;
        // Early flow must be buy-dominated.
        const totalVol = mem.buyVol + mem.sellVol;
        if (totalVol <= 0n) continue;
        if ((mem.buyVol * 10_000n) / totalVol < BigInt(MIN_BUY_SHARE_BPS)) continue;
        // And the price must already be lifting off its first print.
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (price <= 0) continue;
        if (price < (mem.firstPrice * (10_000 + MIN_LIFT_BPS)) / 10_000) continue;

        const cap = state.maxBuyLamports(mint);
        let size = BigInt(Math.floor(BUY_SOL * SOL));
        if (size > cap) size = cap;
        const free = state.freeCashLamports() - 2n * txFee;
        if (size > free) size = free;
        if (size < BigInt(Math.floor(MIN_BUY_SOL * SOL))) continue;

        orders.push({
          side: "buy",
          mint,
          quote_lamports: size,
          max_slippage_bps: BUY_SLIPPAGE_BPS,
        });
        slotsLeft--;
      }
    }

    return orders;
  },

  onDone(state: BotState, _done) {
    // Final account: positions already flattened by the harness. Report the
    // outcome to stderr only; stdout carries replies and must stay clean.
    const cashSol = Number(state.cash) / SOL;
    console.error(`done: final cash ${cashSol.toFixed(4)} SOL over ${state.seq + 1} batches`);
  },
});
