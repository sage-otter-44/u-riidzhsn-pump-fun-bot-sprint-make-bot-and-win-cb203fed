# Completion Rider — Pump.fun Bot Sprint

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/sage-otter-44/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/sage-otter-44/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A trading bot for the make.fun Pump.fun Bot Sprint. It trades paper money on a
replay of pump.fun bonding-curve data, buying only deep, liquid curves that are
approaching completion (migration), with buy-side flow still confirming.

## How it works

- **Entry:** a curve holding 50–85 SOL of real reserves, with at least 5 buys
  from at least 3 distinct wallets in its last 8 trades, net SOL flow >= 0, and
  no single sell of 2 SOL or more in the window. One fixed 0.1 SOL buy per
  position, no adds.
- **Exits:** tight 10% stop-loss; half the position banked at +30%; a wide
  trailing stop (arms at +80%, trails 50% behind the peak) so a completing
  runner is not sold on a normal pullback; a far +300% take-profit; 1500-slot
  time limit. Stale/flow exits are off by default — runners consolidate for
  hundreds of slots before their last leg.
- **Guardrails:** pace-based probe round trips (0.01 SOL) keep the run above
  20 coins traded in round trips of at least 0.01 SOL.
- **Determinism:** no clock, no randomness, no I/O — the two graded executions
  produce byte-identical action logs.

## Backtest (dev window, local replay engine)

Settings were chosen for the best aggregate across all three dev-window parts,
not the best cell on any single part:

| part | net PnL | fills | coins | max drawdown |
|------|---------|-------|-------|--------------|
| part-00000 | +0.0025 SOL | 135 | 37 | 0.6% |
| part-00001 | -0.1169 SOL | 128 | 43 | 1.7% |
| part-00002 | -0.0270 SOL | 123 | 39 | 1.2% |

No strategy family tested was robustly positive on this tape — every house
pilot loses on it too — so this one is picked for the smallest, most
consistent losses with positive skew: a completing runner can pay multiples
of the 0.1 SOL stake.

## Layout

- `main.ts` — entrypoint (runs `node main.ts` under the grader)
- `strategy.ts` — the strategy
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored byte for byte
- `LICENSE` — MIT
