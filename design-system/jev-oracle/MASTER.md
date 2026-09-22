# Jev Oracle: Design Language

> **Note (2026-09-20):** the palette below (cyan-toned accent on `#0D0E12`) is
> the original design record and is kept as-is for history. The live palette
> has since changed to a gold-on-near-black scheme (`--acc:#F0B90B`,
> `--ink:#F2E8D5`, `--bg:#0B0906`, with `--on-acc:#1A1206` for text on a solid
> gold fill), and the base font size moved from 14px to 17.5px. See
> `public/app.css` for the current source of truth.

## 1. Positioning

An **instrument**, not a chatbot. The user brings a question and evidence;
the product returns a calibrated, typed verdict. Every visual decision serves
one goal: make a probability legible and trustworthy at a glance.

Anti-goal: looking like an LLM chat. No message bubbles, no streaming text,
no assistant persona, no "thinking…" prose.

## 2. References and what we took

| Source | Taken | Rejected |
|---|---|---|
| Polymarket | Probability AS the hero. Huge %, sources cited under it, dark sober ground, ONE accent. Restraint. | Gambling framing, ticker urgency, red/green P&L |
| Mistral Vibe | Single centred ask-box, suggestion chips, hard-edged blocking, generous type scale | Full-bleed saturated orange, mascot |
| Chatbots | Familiar entry (one input, chips, ⌘⏎), progressive disclosure of controls | Conversation transcript, bubbles, persona |

**Harness uniqueness: the part no chatbot has.** These are the differentiators
and they get the visual budget:
1. **Latency as a feature.** ~300ms for N parallel judgments, shown, not hidden.
2. **Ablation.** Mute a source, watch the number move. Delta is a first-class element.
3. **Consistency.** Same question 3×, tight spread. Calibration you can see.
4. **Two-speed pipeline.** Local LLM proposes (~14s), Jev judges (~300ms). The
   asymmetry is the argument, show both timings side by side.

## 3. Palette: sober instrument, one accent

The generated system proposed HUD/Sci-Fi neon (#00FFFF / #FF00FF), flagged
`accessibility risk:high`. REJECTED: a calibration tool must not look like a
toy, and neon-on-near-black fails sustained-reading contrast. We keep its
typography and motion tier, not its colour.

```css
--bg:#0D0E12; --panel:#15171E; --panel-2:#1B1E27; --line:#282C39;
--ink:#E7E9F0;        /* 14.8:1 on --bg */
--dim:#8B92A8;        /*  6.1:1 on --bg, passes AA for small text */
--acc:#7C9CFF;        /* single accent: interactive + neutral data */
--ok:#4ADE80; --warn:#FBBF24; --bad:#F87171;
```

**Semantic rule: colour never means "good news".** ok/warn/bad encode
*probability position*, never approval. A 95% "yes" to a bad question is still
green, because green = confident, not = desirable. Colour is never the sole
carrier: every state also has a word (`Yes`, `Too close to call`) and a bar.

## 4. Type

Inter, 4 weights. One scale, no decorative faces.

| Token | Size / weight | Use |
|---|---|---|
| verdict | 34px / 700, -1px | The answer word. One per screen. |
| metric | 17px / 700 mono | Latency, counts, deltas |
| body | 14px / 400 | Everything |
| label | 11px / 500, .5px caps | Section headers, axis |

`text-wrap: balance` + `max-inline-size: 20ch` on the verdict line (per the
Heading Line Balance rule), never hardcoded `<br>`.

## 5. Layout

Two columns ≥940px, stacked below. **Left = you compose, right = oracle answers.**
The verdict column never scrolls out of reach on desktop.

Density 6/10: 8/12/16/24 spacing. Evidence is dense, the verdict is spacious,
the contrast is what makes the verdict read as the conclusion.

## 6. Motion: Standard tier (4/10)

- State change 150ms, bar fill 350ms `back.out(1.4)`, stagger 60ms on factors
- **Count-up on the probability** (~400ms). The one indulgence: it makes a
  number feel measured rather than asserted.
- Delta arrow: 200ms slide+fade. It is the payoff of an ablation, it earns motion.
- `prefers-reduced-motion` → final state immediately, no count-up, no stagger.

## 7. Loading: two speeds, two treatments

Per the Loading Indicators rule ("match the expected wait, avoid flashing for
near-instant work"):

| Wait | Treatment |
|---|---|
| Jev ~300ms | **No spinner.** Button label only. A spinner that flashes for 300ms is noise. |
| Local LLM ~14s | Named, explained, progress-bearing: "Local model proposing factors… ~15s". Long waits must be *explained*, not merely animated. |

`aria-busy` on the verdict region throughout; layout space reserved so nothing
shifts (CLS).

## 8. Component rules

- **Verdict block:** word, then %, then bar, then caveat. Never % alone.
- **Speed badge:** segmented, monospace. Jev's ms sits next to the local model's
  seconds so the reader draws the conclusion unaided.
- **Source row:** checkbox is the ablation control. Muted = 40% opacity, still
  readable. Muting is reversible and never destroys text.
- **Factor row:** label, %, bar, sub-question. Weakest link called out in prose.
- **Delta chip:** only rendered when |Δ| ≥ 2pt, so it means something when it appears.

## 9. Accessibility floor

- Contrast ≥4.5:1 for all text, ≥3:1 for bars/borders
- Focus ring: 2px `--acc`, never removed
- Touch targets ≥44×44
- Every chart value also present as text
- No emoji as icons, inline SVG only
- Verdict region `aria-live="polite"`

## 10. AVOID

- Chat bubbles, streaming text, assistant persona
- Neon/HUD cyberpunk ("generic tech design")
- Red/green as approval
- A spinner for a 300ms call
- Hiding latency: it's the best number in the product
