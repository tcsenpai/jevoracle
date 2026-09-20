# The paper trading engine

A loop that asks Jev about live Polymarket markets, records what it said next to
what the crowd said at that moment, and scores the result when the market resolves.

Dashboard at `/engine.html`.

## There is no Polymarket testnet

This is worth stating plainly because it shapes everything below. Checked three ways:

- `clob-testnet`, `clob-amoy` and `clob-staging` do not resolve in DNS
- across all 102 pages of Polymarket's docs there is not one mention of a testnet,
  sandbox, staging or Amoy environment
- the pUSD docs say "Polygon mainnet", backed by USDC, enforced onchain

So there is no safe place to practise with fake money against real markets. The
answer is paper trading: real prices, real resolutions, no money at risk.

That is arguably better than a testnet anyway. A testnet would have fake liquidity
and no genuine resolution, so it could not tell you whether an edge is real either.

## What a scan does

1. Pull the most active open events from Polymarket's free API
2. Skip anything thin, already settled, or priced at the rails (below 3% or above 97%),
   where a disagreement cannot mean much
3. Build a Jev request from the resolution rules and the comment thread
4. Freeze the crowd price into the row. A prediction you can silently re-price later
   is not a prediction.
5. Record what Jev said, under both edge rules

Nothing is bet. Nothing is sent anywhere.

## The two rules, and why both are recorded

Every prediction is evaluated under two rules at once:

- **ungated**: bet whenever the gap between Jev and the crowd exceeds the threshold
- **gated**: the same, but only when Jev's own `evidence_sufficient` is also high

The gated rule exists because of a result from the earlier experiment. On an F1
championship market Jev was 80 points away from the crowd, and its own evidence
signal came back at 12 percent. It knew it was guessing. The gate is the bet that
this signal is worth obeying.

Recording both on the same rows is the only way to find out. If the gate never
helps, the data will say so.

The first live scan was already suggestive: five markets, mean self-reported
evidence 11 percent, ungated staked $200 across four sports and election markets,
gated staked nothing.

## Staking

Quarter Kelly, capped at 5 percent of bankroll per position. Full Kelly on a belief
that might be miscalibrated is a good way to go broke, and these beliefs are exactly
the thing under test.

## Reading the dashboard

**Brier score** is mean squared error of a probability forecast. Lower is better,
0.25 is a coin flip. The number that matters is not Jev's Brier on its own but Jev's
Brier against the crowd's Brier on the same markets. Beating the crowd is the claim.

**Calibration** buckets predictions and compares predicted frequency against what
actually happened. If Jev says 30 percent on a hundred things, roughly thirty should
happen. The two bars per row should match.

**P&L** is virtual. Treat it as a sanity check on the Brier scores, not a result.
A handful of lucky bets can show a profit while the underlying forecasts are poor.

One honest caveat: none of these numbers mean anything until a decent number of
markets have actually resolved. A dozen rows is an anecdote.

## Going live, if the record ever justifies it

Execution is deliberately unfinished. `engine/execute.js` ships the guard, not the
trigger: it validates and then throws, because order signing belongs in Polymarket's
official SDK rather than hand-rolled in a public repo.

Four independent locks have to be open:

1. `LIVE_TRADING=i-understand-this-spends-real-money` exactly
2. `POLYMARKET_PRIVATE_KEY` set
3. `MAX_ORDER_USD` above zero
4. the caller passes `{ confirm: true }`

The dashboard banner turns red when all of them are open.

Do not open them on the strength of a good week.

## Other networks

Polymarket is Polygon. If Solana or another chain matters later, the venue is
isolated behind three functions in `scripts/polymarket.js` (`fetchEvent`,
`pickMarket`, `toJevRequest`), so a second venue implements those rather than
forking the engine. Solana devnet is healthy, so a genuine testnet flow may be
possible on a Solana-native market, which Polymarket cannot offer.
