# Integrazioni esterne: verificate o assunte

Pratica adottata dopo aver analizzato `marianimatteo-lexroom/poly-jev`, che la usa
nel proprio README ed e' l'unica cosa di quel repo che vale la pena copiare. Loro
hanno scoperto cosi' di aver costruito su un SDK gia' deprecato.

E' il principio del "un verde puo' significare regge oppure non ho eseguito
nulla", applicato alle dipendenze esterne invece che ai test.

**VERIFIED-LIVE** = eseguito contro il servizio reale, con output osservato e
incollato qui sotto. **ASSUMED** = costruito leggendo la documentazione, mai
eseguito. Un ASSUMED non e' un difetto, e' un'etichetta onesta: diventa un
difetto quando qualcuno lo legge come verificato.

| Integrazione | Stato | Verificato quando | Come |
| --- | --- | --- | --- |
| TypeSafe `POST /v1/systemone` | VERIFIED-LIVE | 2026-09-20 | Risposte reali con answers tipizzate, ~300ms, 10 giudizi in una call |
| TypeSafe `GET /v1/models` | VERIFIED-LIVE | 2026-09-20 | Restituisce solo alias piu' release_date. **Nessun knowledge cutoff dichiarato** |
| Campo `model` nella response | VERIFIED-LIVE | 2026-09-20 | Restituisce `jev-1.13.0` quando si chiede `jev-latest`. L'alias si muove, il versioned id no |
| Polymarket Gamma `/events?slug=` | VERIFIED-LIVE | 2026-09-20 | Evento reale con 6 mercati, regole di risoluzione, 239 commenti |
| Polymarket Gamma `/comments` | VERIFIED-LIVE | 2026-09-20 | 90 commenti su un evento, con profilo e reazioni |
| Polymarket `clobTokenIds` | ASSUMED | mai | Estratti e salvati, ma mai usati per un ordine. Servono solo all'esecuzione reale, che e' fuori scope |
| Polymarket CLOB `/markets` | ASSUMED | parziale | Risponde 200, ma non abbiamo mai piazzato nulla |
| ddgs CLI, ricerca news | VERIFIED-LIVE | 2026-09-20 | Funziona, ma `-o json` scrive un file nella cwd invece che su stdout, il backend `auto` non restituisce niente, e limita aggressivamente. Fallback a tre backend piu' cache |
| Esecuzione reale su Polygon | ASSUMED, e volutamente non implementato | mai | `engine/execute.js` valida e poi solleva. Il repo spedisce la guardia, non il grilletto |
| Polymarket testnet | VERIFICATO INESISTENTE | 2026-09-20 | `clob-testnet`, `clob-amoy`, `clob-staging` non risolvono in DNS. Zero menzioni su 102 pagine di documentazione. pUSD e' un ERC-20 su Polygon mainnet |

## Regola

Quando si scopre uno scarto fra quello che la documentazione dice e quello che il
servizio fa, si aggiorna questa tabella nello stesso commit del fix. La riga su
ddgs esiste proprio perche' ci siamo sbattuti contro.
