# Comparing Jev against a prediction market

A paper experiment. Polymarket publishes a crowd probability for a question and
also publishes the resolution rules that define it. That makes it a convenient
test rig: feed Jev the same written material a careful reader would have, and see
where its judgment lands relative to thousands of people betting real money.

## Running it

```bash
bun run scripts/ask-polymarket.js <event url or slug> [options]

  --market NAME     judge a specific sub-market instead of the auto-picked one
  --news FILE       add your own reporting; paragraphs separated by blank lines
  --no-comments     skip the public discussion
  --print           show the exact request before sending it
  --json            machine readable output
```

Polymarket has a free read-only API at `gamma-api.polymarket.com`, so this reads
that rather than scraping the page. No key, no browser.

## The one rule that makes it meaningful

**The market price is never put in the state.** If Jev could see that the crowd
says 28%, the comparison would measure whether it can read a number, not whether
it can weigh evidence. The price is only used afterwards, to score the answer.

## What Jev is asked

Four questions in a single call:

| id | type | what it gets at |
| --- | --- | --- |
| `verdict` | Noul | Probability the market resolves YES under its own rules |
| `rules_are_strict` | Score | How much the fine print narrows the plain reading |
| `evidence_sufficient` | Noul | Whether the state is enough to judge at all |
| `ambiguity` | Choice | What would most likely cause a resolution dispute |

`evidence_sufficient` is the one that matters most, and the reason is below.

## Results

### NATO x Russia military clash, December 31 window

$7M volume, 239 comments. Crowd sat at 28.5%.

| State given to Jev | Jev | Crowd | Gap | Jev's evidence rating |
| --- | --- | --- | --- | --- |
| Rules and comments only | 31.0% | 28.5% | +2.5pt | 19%, thin |
| Plus five real news items | 30.0% | 28.5% | +1.5pt | 50%, borderline |

Two things stand out.

First, reading only the resolution rules and the public discussion, Jev landed
within 2.5 points of a seven-figure market. Adding genuine reporting moved it
closer and roughly tripled its own confidence that it had enough to go on.

Second, it picked `attribution` as the likeliest dispute at 81% confidence. The
comment thread contains a trader asking, unprompted, "how likely is it to be 100%
identified as operated by Russia? if lithuanian authority claims 'most likely
russian' is that enough to qualify?" Jev found the same fault line the humans
were arguing about, from the rules.

### The control that matters

On the shorter October 31 window, Jev said 27.0% against a crowd price of 15.5%,
an 11.5 point disagreement. This is the useful check: it is not quietly anchoring
to whatever the market thinks, because it cannot see it. It simply discounts the
shorter window less aggressively than the crowd does.

### Where it fails, and says so

On the 2026 F1 Drivers' Champion market, the crowd had Kimi Antonelli at 92.5%.
Jev said 12.0%, off by 80 points.

That is the correct outcome, not a bug. Jev's own `evidence_sufficient` came back
at **12%**, meaning "judging this would mostly rely on facts not present in the
state". The rules explain how a championship is decided; they say nothing about
who is currently leading it. The crowd knows the standings. Jev was handed a
rulebook and asked to guess a score.

The takeaway is not that Jev is bad at sport. It is that Jev flagged the problem
itself, in the same call, without being asked whether it was confident. A model
that returns a number and no uncertainty would have returned 12% and looked
simply wrong.

## Reading a result honestly

- A small gap on a liquid market is interesting but is one sample, not a track
  record. Calibration is a property of many predictions, not any single one.
- If `evidence_sufficient` is low, the number is a reading of the rules and not a
  forecast. Add reporting with `--news` or discard it.
- Jev is judging a written document. The crowd is pricing everything its members
  know. These are different tasks, and the comparison is only fair when you have
  actually given Jev the relevant facts.

## Reproducing

```bash
bun run scripts/ask-polymarket.js nato-x-russia-military-clash-in-2025
bun run scripts/ask-polymarket.js nato-x-russia-military-clash-in-2025 --news my-news.txt
bun run scripts/ask-polymarket.js 2026-f1-drivers-champion --market "Antonelli"
```

Prices move, so your numbers will not match the table above.
