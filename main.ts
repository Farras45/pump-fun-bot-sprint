// Swift Exit — pump.fun replay scalper (agent-fun/replay/v2).
//
// The strategy lives in strategy.ts; this file only wires it to the kit SDK
// (vendor/makefun-bot.ts), which owns the stdin/stdout wire protocol. One
// reply per batch, carrying the batch of orders decided for that slot.
//
// Run it: node main.ts

import { runBot } from './vendor/makefun-bot.ts';
import { decideOrders } from './strategy.ts';

await runBot({
  onBatch(state, batch) {
    return decideOrders(state, batch);
  },
});
