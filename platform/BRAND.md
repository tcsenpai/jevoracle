# JevKnows

## Name

The pun is the point: "Jev knows" and "who knows?". A system whose most
useful signal is how much it declares it does NOT know deserves an ambiguous
name.

## What it is

A control room for judgment experiments, not a trading bot. The question it
answers is not "how much did I make" but "does this bot know what it claims
to know?".

The fact that generated it: on an F1 market Jev was off by 80 points and at
the same time declared evidence_sufficient at 12 percent. It knew that it did
not know. That is the product.

## Page hierarchy

| Page | Role |
| --- | --- |
| `/` | Bot list, exchange-style. The center of the platform. |
| `/bot/:id` | Detail of a single bot: runs, predictions, calibration, config |
| `/console` | The typed-questions playground. Demoted, it is there to play with. |

## Tone

A tool, not a casino. No green and red as approval, no urgency, no
gamification, no confetti when a bot guesses right. The numbers are
measurements, not scores.

Green on a verdict means "concentrated distribution", not "good news". A 95
percent on a terrible question stays green.

## Rules the brand imposes on the product

1. The market price never enters the state sent to Jev. Otherwise you measure
   whether it can read a number, not whether it can judge.
2. The evidence declared by the model is always shown next to the verdict,
   never hidden in a secondary panel.
3. A prediction is an immutable event. History is not rewritten.
4. If a piece of data is missing, it is written as missing. Nothing is
   estimated, nothing is rounded.
