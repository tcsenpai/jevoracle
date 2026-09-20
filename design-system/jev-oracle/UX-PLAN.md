# Jev Oracle — UX Plan

## Core insight

A newcomer's first 30 seconds decide whether this reads as "a chatbot that
answers slower" or "an instrument that does something chat cannot". The plan
optimises that window without turning the tool into a tutorial.

## First run — Vibe's entry, Polymarket's answer

Land on ONE centred ask-box with 3 example chips. No visible controls, no
empty factor panels. Chatbot-familiar, zero learning cost.

Picking a chip fills question AND context together — so the first ask
succeeds. A first run that returns "add some context" teaches nothing.

## The reveal

On first verdict the layout resolves into two columns: evidence left, verdict
right. Controls appear *after* the first answer, when the user knows what they
would be modifying.

Sequence, each step earning the next:
1. Verdict lands (~300ms) — the speed is the first surprise
2. Speed badge reads `312ms · 5 judgments · 1 call` — the second
3. A one-line nudge: "Untick a source and ask again" — the third
4. Ablation delta `▲26pt` — the moment it stops being a chatbot

## Progressive disclosure

Three tiers. Tier 1 always visible; 2 and 3 revealed after first verdict.

| Tier | Contains | Why here |
|---|---|---|
| 1 Ask | Question, chips, context, Ask | Minimum to get an answer |
| 2 Shape | Yes-No / Pick / Rate, sources | Only meaningful once you've seen a verdict |
| 3 Deepen | Factors, consistency, gate, raw | Costs time or calls — opt-in, never default-on |

"Break into factors" states its cost inline (`~15s, local model`). No surprise waits.

## Empty, loading, error

- **Empty** — ask-box + chips. Never a blank panel.
- **Jev thinking (~300ms)** — button label changes. No spinner.
- **Local model (~14s)** — named row with what it's doing and why it's slow,
  and the Jev verdict still arrives independently if it fails.
- **Decompose fails** — inline note with the reason; verdict unaffected.
  A failed optional step must never look like a failed answer.
- **No context** — inline hint next to Ask, not a modal.

## Reading order of a verdict

Strict visual hierarchy, top to bottom:

1. **Word** (`Probably yes`) — the answer, largest thing on screen
2. **Probability + bar** — the magnitude
3. **Delta** — only if it changed, only if ≥2pt
4. **Consistency** — only if run 3×
5. **Speed badge** — the differentiator
6. **Factors** — the decomposition, weakest link named in prose
7. **Why** — support / obstacles / evidence-sufficiency / shelf-life
8. **Ablation footer** — what was excluded

A user reading only line 1 gets a correct answer. Reading all 8 gets the
reasoning. Nothing below line 1 is required to act.

## Honesty rules (non-negotiable)

- Near 0.5 always says "genuinely undecided, not a middling yes"
- "Context thin — answer is a guess" surfaces whenever evidence is insufficient
- Factors labelled `proposed locally · judged by Jev` — never imply Jev wrote them
- Measured latency only, never a rounded marketing number

## Mobile

Single column: Ask → Verdict → Evidence. Verdict outranks the controls that
produced it. Chips scroll horizontally. Targets ≥44px. Sticky Ask bar respecting
`env(safe-area-inset-bottom)`.

## Success test

A newcomer, unprompted, within 60s: asks a question, gets a verdict, unticks a
source, sees the delta, and says "wait, it actually read my stuff." That moment
is the product.
