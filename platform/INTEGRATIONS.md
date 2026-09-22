# External integrations: verified or assumed

Practice adopted after analyzing `marianimatteo-lexroom/poly-jev`, which uses
it in its own README and is the only thing in that repo worth copying. That
is how they discovered they had built on an SDK that was already deprecated.

It is the principle of "a green can mean it holds up or it means I ran
nothing", applied to external dependencies instead of tests.

**VERIFIED-LIVE** = executed against the real service, with output observed
and pasted below. **ASSUMED** = built by reading the documentation, never
executed. An ASSUMED is not a defect, it is an honest label: it becomes a
defect when someone reads it as verified.

| Integration | Status | Verified when | How |
| --- | --- | --- | --- |
| TypeSafe `POST /v1/systemone` | VERIFIED-LIVE | 2026-09-20 | Real responses with typed answers, ~300ms, 10 judgments in one call |
| TypeSafe `GET /v1/models` | VERIFIED-LIVE | 2026-09-20 | Returns only alias plus release_date. **No declared knowledge cutoff** |
| `model` field in the response | VERIFIED-LIVE | 2026-09-20 | Returns `jev-1.13.0` when asking for `jev-latest`. The alias moves, the versioned id does not |
| Polymarket Gamma `/events?slug=` | VERIFIED-LIVE | 2026-09-20 | Real event with 6 markets, resolution rules, 239 comments |
| Polymarket Gamma `/comments` | VERIFIED-LIVE | 2026-09-20 | 90 comments on one event, with profile and reactions |
| Polymarket `clobTokenIds` | ASSUMED | never | Extracted and saved, but never used for an order. Only needed for real execution, which is out of scope |
| Polymarket CLOB `/markets` | ASSUMED | partial | Responds 200, but we have never placed anything |
| ddgs CLI, news search | VERIFIED-LIVE | 2026-09-20 | Works, but `-o json` writes a file in the cwd instead of stdout, the `auto` backend returns nothing, and it rate-limits aggressively. Falls back to three backends plus cache |
| Real execution on Polygon | ASSUMED, and deliberately not implemented | never | `engine/execute.js` validates and then throws. The repo ships the guard, not the trigger |
| Polymarket testnet | VERIFIED NOT TO EXIST | 2026-09-20 | `clob-testnet`, `clob-amoy`, `clob-staging` do not resolve in DNS. Zero mentions across 102 pages of documentation. pUSD is an ERC-20 on Polygon mainnet |

## Rule

When a gap is found between what the documentation says and what the service
actually does, this table is updated in the same commit as the fix. The ddgs
row exists precisely because we ran into it.
