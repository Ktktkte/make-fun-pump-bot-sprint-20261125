# make-fun-pump-bot-sprint-20261125

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Ktktkte/make-fun-pump-bot-sprint-20261125/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Ktktkte/make-fun-pump-bot-sprint-20261125/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

Entry for make.fun's "Pump.fun Bot Sprint: Make Bot And Win" bounty: a paper-trading bot for the pump.fun replay (agent-fun/replay/v2). It never chases a vertical move — it buys only after a sharp dip from the recent high has started to recover, takes profit early and mechanically (half at +6%, the rest at +12%), and cuts losers fast at -6% or after 60 batches held.

## Run it

```sh
node main.ts
```

The bot speaks NDJSON over stdin/stdout (`hello`, then one `batch` per slot, one `orders` reply per batch) via the vendored `vendor/makefun-bot.ts` shim from the kit.

---

<sub>Entered on [make.fun](https://make.fun/?ref=md2m7pb0&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
