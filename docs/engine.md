# The paper trading engine (single bot, superseded)

> This is the original single-bot loop and the direct ancestor of the JevKnows
> platform. It still runs, and its dashboard is still served at `/engine.html`,
> but it has one global configuration and one record. The multi-bot platform in
> `platform/` replaced it: independent bots, three interchangeable decision
> engines with a weighted quorum, per-bot append-only configuration history, and
> on-demand local engines. Start from the top-level README instead. Keep reading
> here for how the original loop worked, which is still the shape of the scan
> and settle cycle underneath.

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

## What goes into the state

This matters more than anything else in the engine. Jev reads what you hand it and
nothing else, so the state is the experiment.

Current fields:

| field | what it is |
| --- | --- |
| `question_asked` | the market question |
| `resolution_rules` | the full resolution criteria, usually the most useful field |
| `window` | today's date and when the market resolves |
| `subject_area` | at most three tags, for framing |
| `recent_reporting` | dated news headlines via ddgs, filtered for relevance |
| `trader_notes` | comments that look like someone reporting a fact |

Two filters do real work here.

**Comments are filtered hard.** Most Polymarket comments are cheering, spam, or
people talking about the price. Price chatter is the dangerous kind: the whole design
keeps the market price out of the state, and a comment saying "15% underpriced"
smuggles it straight back in. On the NATO market the filter cut 239 comments to 8,
and what survived was cited reporting (Reuters quoting the Romanian president, a
Politico correction, the Lithuania shootdown) rather than "Памп памп".

**News is filtered for relevance.** Search backends sometimes ignore the query
outright: a search about Brazil and Lula returned six TASS articles about Russia,
Iran and Slovakia. Irrelevant news is worse than none, because it drags Jev's
evidence score down while costing tokens. A result now has to share a distinctive
word with the query or it is dropped.

## Testing what the context is worth

```bash
bun run scripts/experiment.js <slug...> [--variants rules,notes,news,full]
```

Same markets, same questions, four different states. The number to watch is not the
probability but `evidence_sufficient`. If adding context does not raise it, the
context was noise.

Measured across three markets:

| variant | mean evidence | mean gap vs crowd | mean tokens |
| --- | --- | --- | --- |
| rules only | 12% | 38.2pt | 1011 |
| + trader notes | 12% | 37.8pt | 1423 |
| + news | 13% | 39.8pt | 1458 |
| everything | 17% | 34.2pt | 1870 |

Full context wins on both axes: evidence rises and the gap to the crowd narrows.
The F1 market was the clearest case, where news alone lifted evidence from 12% to
19% and pulled an 80 point miss in to 67.5 points. Brazil was the counter-example
that produced the relevance filter.

None of this says Jev is right. It says the state is better than it was, which is
the only part we control.

## A note on ddgs

`pip install ddgs`. It rate-limits aggressively under repeated calls and its `auto`
backend returns nothing, so the module tries bing, then duckduckgo, then yahoo, and
caches every query for thirty minutes. If ddgs is missing or throttled the engine
still runs and simply records lower evidence scores. Nothing depends on it.

## Other networks

Polymarket is Polygon. If Solana or another chain matters later, the venue is
isolated behind three functions in `scripts/polymarket.js` (`fetchEvent`,
`pickMarket`, `toJevRequest`), so a second venue implements those rather than
forking the engine. Solana devnet is healthy, so a genuine testnet flow may be
possible on a Solana-native market, which Polymarket cannot offer.
