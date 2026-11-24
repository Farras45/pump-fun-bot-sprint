// Swift Exit — an original pump.fun replay scalper.
//
// Idea: pump.fun coins live fast and mostly die young. A small minority spike
// hard in their first minutes. This bot buys a small, fixed stake in a young
// coin only while fresh buying still outweighs selling, then gets out quickly:
// a tight stop-loss caps every loser, a trailing stop rides any spike, a hard
// take-profit banks the rare moonshot, and a time exit closes anything that
// goes nowhere. Breadth is the edge: many small, short trades, never a big
// bet on one coin, so the losers are cheap and the spikes pay for them.
//
// v11 (final candidate): bank small wins fast, cut losers faster — v9 proved
// the opposite wrong: this window's winners peak small (+8-18%), so a +12%
// trail arm turned them into losers. Stop -3%, trailing arms at +5% and gives
// back only 4% (a +10% peak banks +6%), take-profit +40%, max hold ~4 min.
// Entry is v6's survivor entry (age 1500-6000 slots, 0.50 SOL buy flow,
// 5+ big buys, +10..+100% rise). The v10 whale filter and the v12 near-peak
// filter were both tried and reverted: whale changed nothing on dev
// (every entry already had one), near-peak removed winners.
//
// Determinism: every decision is a pure function of the replay events seen so
// far (slots, reserves, trade amounts). No clock, no randomness, no network,
// no environment reads. Per-coin state is pruned so memory stays bounded.

import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ tunables

/** Fixed stake per entry (0.05 SOL). */
const STAKE_LAMPORTS = 50_000_000n;
/** Smallest buy worth placing (0.02 SOL). */
const MIN_BUY_LAMPORTS = 20_000_000n;
/** Minimum total buy flow a coin must show before we enter (0.50 SOL). */
const MIN_BUY_FLOW_LAMPORTS = 500_000_000n;
/** A coin must show at least this many buys bigger than 0.03 SOL. */
const MIN_BIG_BUYS = 5;
/** A single buy counts as "big" at 0.03 SOL and up. */
const BIG_BUY_LAMPORTS = 30_000_000n;
/** A single buy counts as "whale" at 0.50 SOL and up. */
const WHALE_BUY_LAMPORTS = 500_000_000n;
/** Only coins at least this old (slots since creation) may be entered. */
const MIN_ENTRY_AGE_SLOTS = 1500;
/** Only coins at most this old (slots since creation) may be entered. */
const MAX_ENTRY_AGE_SLOTS = 6000;
/** Trades a coin must have printed before we trust its flow. */
const MIN_TRADES_TO_ENTER = 10;
/** Buys must outweigh sells by at least this factor. */
const MIN_BUY_SELL_NUM = 2;
const MIN_BUY_SELL_DEN = 1;
/** Entry price band vs the coin's first traded price, in bps: a real rise. */
const ENTRY_MIN_RISE_BPS = 1000;
const ENTRY_MAX_RISE_BPS = 10000;
/** Buy slippage guard: a 2-slot move beyond this rejects the fill. */
const BUY_SLIPPAGE_BPS = 1000;
/** Sell slippage is wide open: an exit must never be refused for price. */
const SELL_SLIPPAGE_BPS = 10_000;

/** Stop-loss vs entry price, in bps. */
const STOP_LOSS_BPS = -300;
/** Hard take-profit vs entry price, in bps. */
const TAKE_PROFIT_BPS = 4000;
/** Trailing stop arms once the peak gain reaches this, in bps. */
const TRAIL_ARM_BPS = 500;
/** Trailing stop gives back this much from the peak, in bps. */
const TRAIL_GIVEBACK_BPS = 400;
/** Max hold after the buy fill, in slots (~4 min). */
const MAX_HOLD_SLOTS = 600;

/** Prune per-coin state older than this (slots) when it holds no position. */
const PRUNE_AFTER_SLOTS = 3000;
/** Hard cap on tracked coins; oldest non-position entries are dropped first. */
const MAX_TRACKED_COINS = 4000;
/** Pruning runs once every this many batches, to keep it cheap. */
const PRUNE_EVERY_BATCHES = 512;

// ------------------------------------------------------------------ price math

/** A price as a rational: virtual quote reserves over virtual token reserves. */
interface Price {
  q: bigint;
  t: bigint;
}

/** Change from `from` to `to`, in basis points, exact bigint arithmetic. */
function changeBps(from: Price, to: Price): number {
  if (from.q <= 0n || from.t <= 0n || to.q <= 0n || to.t <= 0n) return 0;
  const num = (to.q * from.t - from.q * to.t) * 10_000n;
  const den = from.q * to.t;
  return Number(num / den);
}

/** Current price of a curve from its latest reserves; null when unknown. */
function curvePrice(state: BotState, mint: string): Price | null {
  const c = state.curves.get(mint);
  if (c === undefined) return null;
  if (c.virtual_quote_reserves <= 0n || c.virtual_token_reserves <= 0n) return null;
  return { q: c.virtual_quote_reserves, t: c.virtual_token_reserves };
}

// ------------------------------------------------------------------ per-coin state

interface CoinTrack {
  /** Slot the coin was first seen (creation slot when known). */
  createdSlot: number;
  /** Price at the first trade seen on this coin. */
  firstPrice: Price | null;
  /** Cumulative SOL flow since first seen, in lamports. */
  buyVol: bigint;
  sellVol: bigint;
  /** Buys of at least BIG_BUY_LAMPORTS seen so far (conviction, not dust). */
  bigBuys: number;
  /** True once a single buy of at least WHALE_BUY_LAMPORTS has landed. */
  whaleSeen: boolean;
  /** TradeEvents seen on this coin. */
  trades: number;
  /** True once a buy has filled on this coin: never enter twice. */
  entered: boolean;
  /** True once the position has fully exited: never re-enter. */
  done: boolean;
  /** Entry price from the buy fill (SOL spent per token). */
  entryPrice: Price | null;
  /** Slot the buy filled. */
  entrySlot: number;
  /** Best gain since entry, in bps. */
  peakBps: number;
  /** Last slot this coin was seen, for pruning. */
  lastSeenSlot: number;
}

const tracks = new Map<string, CoinTrack>();

function trackFor(mint: string, slot: number, createdSlot: number | null): CoinTrack {
  let t = tracks.get(mint);
  if (t === undefined) {
    t = {
      createdSlot: createdSlot ?? slot,
      firstPrice: null,
      buyVol: 0n,
      sellVol: 0n,
      bigBuys: 0,
      whaleSeen: false,
      trades: 0,
      entered: false,
      done: false,
      entryPrice: null,
      entrySlot: 0,
      peakBps: 0,
      lastSeenSlot: slot,
    };
    tracks.set(mint, t);
  }
  return t;
}

function pruneStale(state: BotState): void {
  if (tracks.size <= MAX_TRACKED_COINS) {
    // Cheap pass: drop only clearly dead coins.
    if (state.seq % PRUNE_EVERY_BATCHES !== 0) return;
    for (const [mint, t] of tracks) {
      if (t.done || state.slot - t.lastSeenSlot > PRUNE_AFTER_SLOTS) {
        if (!state.positions.has(mint)) tracks.delete(mint);
      }
    }
    return;
  }
  // Over the hard cap: drop the oldest non-position coins first.
  for (const [mint, t] of tracks) {
    if (tracks.size <= MAX_TRACKED_COINS) break;
    if (!state.positions.has(mint) && !t.entered) tracks.delete(mint);
  }
}

// ------------------------------------------------------------------ the batch

export function decideOrders(state: BotState, batch: Batch): OrderInput[] {
  const orders: OrderInput[] = [];
  const caps = state.hello.caps;
  const txFee = state.txFeeLamports();

  // --- 1. Fold this batch's fills into per-coin state ---------------------
  for (const f of batch.fills) {
    const t = tracks.get(f.mint);
    if (t === undefined) continue;
    if (f.side === 'buy' && f.status === 'filled') {
      const spent = BigInt(f.quote_lamports);
      const tokens = BigInt(f.token_amount);
      if (spent > 0n && tokens > 0n) {
        t.entered = true;
        t.entryPrice = { q: spent, t: tokens };
        t.entrySlot = f.slot;
        t.peakBps = 0;
      }
    } else if (f.side === 'sell' && f.status === 'filled') {
      // A full exit: this coin is finished for us.
      if (!state.positions.has(f.mint)) {
        t.done = true;
        t.entryPrice = null;
      }
    }
  }

  // --- 2. Fold this batch's events into per-coin flow ---------------------
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      const t = trackFor(e.mint, e.slot, e.slot);
      t.lastSeenSlot = e.slot;
    } else if (e.event === 'TradeEvent') {
      const t = trackFor(e.mint, e.slot, null);
      t.lastSeenSlot = e.slot;
      t.trades += 1;
      const amount = BigInt(e.sol_amount);
      if (e.is_buy) {
        t.buyVol += amount;
        if (amount >= BIG_BUY_LAMPORTS) t.bigBuys += 1;
        if (amount >= WHALE_BUY_LAMPORTS) t.whaleSeen = true;
      } else t.sellVol += amount;
      if (t.firstPrice === null) {
        const q = BigInt(e.virtual_quote_reserves);
        const tk = BigInt(e.virtual_token_reserves);
        if (q > 0n && tk > 0n) t.firstPrice = { q, t: tk };
      }
    } else {
      // CompleteEvent: the curve is done; drop its track once flat.
      const t = tracks.get(e.mint);
      if (t !== undefined) {
        t.lastSeenSlot = e.slot;
        if (!state.positions.has(e.mint)) tracks.delete(e.mint);
      }
    }
  }

  // --- 3. Exits first: every held position is re-priced every batch ------
  const pendingSell = new Set<string>();
  const pendingBuy = new Set<string>();
  for (const p of state.pending.values()) {
    if (p.order.side === 'sell') pendingSell.add(p.order.mint);
    else pendingBuy.add(p.order.mint);
  }

  for (const [mint, pos] of state.positions) {
    if (pendingSell.has(mint)) continue;
    const t = tracks.get(mint);
    const price = curvePrice(state, mint);
    if (t === undefined || t.entryPrice === null || price === null) continue;
    const pnlBps = changeBps(t.entryPrice, price);
    if (pnlBps > t.peakBps) t.peakBps = pnlBps;
    const heldSlots = state.slot - t.entrySlot;
    const stopHit = pnlBps <= STOP_LOSS_BPS;
    const profitHit = pnlBps >= TAKE_PROFIT_BPS;
    const trailHit = t.peakBps >= TRAIL_ARM_BPS && pnlBps <= t.peakBps - TRAIL_GIVEBACK_BPS;
    // Time exit only closes a position that never got going; a live winner
    // stays under the trailing stop instead of being sold on the clock.
    const timeHit = heldSlots >= MAX_HOLD_SLOTS && t.peakBps < TRAIL_ARM_BPS;
    if (stopHit || profitHit || trailHit || timeHit) {
      orders.push({
        side: 'sell',
        mint,
        token_amount: pos.token_amount,
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      });
    }
  }

  // --- 4. Entries: young coins with fresh net buying, in event order ------
  let free = state.freeCashLamports();
  let openSlots = caps.max_open_positions - state.committedPositionCount();
  // Exits in this reply free a slot only after they fill, so count sells
  // decided above as freeing room for a replacement entry next batch, not
  // this one: openSlots already reflects positions held now.
  const seenThisBatch = new Set<string>();
  for (const e of batch.events) {
    if (orders.length >= caps.max_orders_per_batch) break;
    if (e.event !== 'TradeEvent' && e.event !== 'CreateEvent') continue;
    if (seenThisBatch.has(e.mint)) continue;
    seenThisBatch.add(e.mint);
    const t = tracks.get(e.mint);
    if (t === undefined || t.entered || t.done) continue;
    if (state.positions.has(e.mint) || pendingBuy.has(e.mint)) continue;
    const curve = state.curves.get(e.mint);
    if (curve === undefined || curve.complete) continue;
    if (state.slot - t.createdSlot > MAX_ENTRY_AGE_SLOTS) continue;
    if (state.slot - t.createdSlot < MIN_ENTRY_AGE_SLOTS) continue;
    if (t.trades < MIN_TRADES_TO_ENTER) continue;
    if (t.buyVol < MIN_BUY_FLOW_LAMPORTS) continue;
    if (t.bigBuys < MIN_BIG_BUYS) continue;
    if (t.buyVol * BigInt(MIN_BUY_SELL_DEN) <= t.sellVol * BigInt(MIN_BUY_SELL_NUM)) continue;
    if (t.firstPrice === null) continue;
    const price = curvePrice(state, e.mint);
    if (price === null) continue;
    const riseBps = changeBps(t.firstPrice, price);
    if (riseBps < ENTRY_MIN_RISE_BPS || riseBps > ENTRY_MAX_RISE_BPS) continue;
    const cap = state.maxBuyLamports(e.mint);
    if (cap < MIN_BUY_LAMPORTS) continue;
    const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
    if (openSlots <= 0 || free < amount + txFee) continue;
    orders.push({
      side: 'buy',
      mint: e.mint,
      quote_lamports: amount,
      max_slippage_bps: BUY_SLIPPAGE_BPS,
    });
    free -= amount + txFee;
    openSlots -= 1;
  }

  pruneStale(state);
  return orders;
}
