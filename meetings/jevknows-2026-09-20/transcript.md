# Production meeting — JevKnows

**Data:** 2026-09-20
**Topic:** Strutturare JevKnows, piattaforma di command-and-control per bot di
prediction-market basati su Jev (TypeSafe System One).

**Partecipanti:** Product/Strategy Lead, Architecture Lead, Senior Engineer
(Builder), Senior Engineer (Skeptic). Moderatore: sintesi finale.

**Domande aperte portate al tavolo:**
1. Come schedulare le run dei bot senza far esplodere la spesa API Jev
2. Quanto deve essere profonda la personalizzazione per bot
3. Quali metriche dicono se un bot sta funzionando, dato il lag di settimane
4. Come strutturare il backrun evitando risultati ottimisti per contaminazione
5. Che schema dati regge bot multipli senza diventare ingestibile

---

## ROUND 1 — Posizioni di apertura

### Product/Strategy Lead

Posizione iniziale, in tre punti.

**Le domande che contano: (3) e (2). Le altre sono premature o addirittura mal poste.**

**(3) è la vera domanda del prodotto.** Se non so dire in 20 secondi se un bot "sta
andando bene" con settimane di lag sui risultati, JevKnows non serve a niente —
diventa un log che nessuno riapre. La metrica non può essere P&L nudo. Deve essere
calibrazione leading: evidence_sufficient medio, gap dalla folla, quante volte il bot
si è astenuto correttamente (il caso F1 all'80pt sbagliato ma 12% evidence è
ESATTAMENTE il segnale che vale oro — un bot che sa di non sapere è un bot fidato
anche prima che il mercato si risolva). Costruite la dashboard attorno a "questo bot
si sta comportando in modo coerente con la sua evidence", non attorno a "ha vinto o
perso".

**(2) è la seconda decisione vera, e la risposta è: NO ai bot con domande diverse,
almeno in v1.** Un solo schema di domanda tipizzata, contesto e soglie
personalizzabili per bot. Il momento in cui due bot rispondono a domande diverse, hai
perso la comparabilità che è l'unico motivo per cui un dashboard multi-bot ha senso —
altrimenti sono N esperimenti scollegati con una skin comune. Se in futuro serve una
domanda diversa, è un bot-tipo nuovo, non un parametro.

**(1), (4), (5) sono domande di ingegneria, non di prodotto — si risolvono mentre si
costruisce, non prima.** Non bloccatemi lo scoping su quello.

### Architecture Lead

Rispondo prima al Product Lead: sono d'accordo su (2) ma per ragioni diverse dalle
sue — e non è solo una domanda di prodotto, è la domanda di schema che decide se lo
schema sopravvive o no.

**Sul (2):** stesso schema di domanda tipizzata per tutti i bot, ma questo va scritto
come vincolo del database, non come convenzione. La `predictions` attuale ha già
`request_json`/`answers_json` come blob liberi — questo È il punto di flessibilità. Il
typed question schema vive nel codice applicativo (uno per ora), non nella tabella. Se
domani serve un bot-tipo nuovo con domande diverse, è uno *schema_version* nuovo dentro
lo stesso blob, non una tabella nuova. Questo mi porta dritto alla (5).

**Sulla (5), la vera domanda di oggi:**

```
bots            (id, name, bankroll, status, schema_version, created_at)
bot_configs     (bot_id, version, context_json, thresholds_json, valid_from, valid_to)
runs            (id, bot_id, bot_config_version, started_at, mode: live|backrun|experiment)
predictions     (id, run_id, bot_id, bot_config_version, market_id, ...)
experiments     (id, bot_id, description, results_json)
```

Due decisioni non negoziabili:

1. **`bot_configs` è append-only, mai UPDATE.** La `config` attuale è "singola riga
JSON" — questo è il difetto originale del progetto, portato a scala N bot è un
disastro: cambi soglia di un bot e retroattivamente non sai più con quale config è
stata presa una predizione vecchia. Ogni predizione fissa `bot_config_version`, così
puoi ricostruire "con che regole ha deciso questo" a distanza di mesi. Costa una
tabella in più, non un microservizio.

2. **`runs.mode` distingue live/backrun/experiment nello stesso schema**, non tabelle
parallele — altrimenti la (4) diventa strutturalmente impossibile da isolare (serve
poter filtrare "solo live" ovunque con un WHERE, non con JOIN diversi per tipo).

Il Product Lead ha ragione che (1)(4)(5) si "risolvono costruendo" — falso per la (5)
sullo specifico punto della config immutabile: quella è l'unica decisione che, se
sbagliata al giorno 1, produce una migrazione dolorosa il giorno 90 quando avrai già
centinaia di predizioni con FK verso una config che nel frattempo è cambiata sotto i
piedi.

### Senior Engineer (Builder)

**Ok, allora — cosa si butta davvero: niente.** engine.js, store.js, scoring.js,
news.js, l'adapter Polymarket, la dashboard: 1300 righe funzionanti, testate, non si
toccano nella logica. Il refactor è *aggiungere un livello sopra*, non riscrivere. Chi
propone di buttare qualcosa qui sta proponendo un mese di lavoro per ricreare quello
che già gira.

**Sullo schema dell'Architecture Lead: proporzionato, ci sto, con un taglio.** 5
tabelle vanno bene, ma `experiments` esiste già (experiment.js scrive su
`experiments`) — non è tabella nuova, è riuso. E il `bot_configs` append-only lo
scrivo in due ore: è letteralmente `config.js` con un `bot_id` e un `version` in più
invece di riga singola. Non è over-engineering, è il minimo che ti evita un casino a
runtime. Difendo l'AL su questo.

**Sulla (1), scheduling — nessuno l'ha toccata e non si può saltare.** 300ms per call
Jev con parallelismo 10 non è il collo di bottiglia, è la spesa: se N bot fanno
polling autonomo sugli stessi mercati Polymarket sprechi chiamate duplicate.
Soluzione pragmatica, non elegante: **un solo scheduler globale (loop di engine.js
esteso) che itera i bot in coda, non N loop paralleli.** Cron-style, un bot alla volta
o batch limitato, salvo priorità per bankroll/soglie. Stima: 1 giorno, riuso quasi
totale di engine.js.

**Stima complessiva realistica: 4-5 giorni** per schema multi-bot + scheduler +
adattare dashboard a lista bot invece di 3-tab singolo. Backrun (4) è la parte più
nuova, ne parliamo dopo — ma anche lì riuso `runs.mode` e basta.

### Senior Engineer (Skeptic)

**Sul (4) — il backrun mal fatto non è "meno utile", è attivamente ingannevole, e
nessuno l'ha ancora detto chiaro.**

L'ultimo punto misurato lo dice da solo: "il knowledge cutoff del modello che giudica"
potrebbe includere mercati passati. Se Jev è stato addestrato su dati che coprono
l'esito di un mercato geopolitico da $7M già risolto, il backrun non misura *capacità
predittiva*, misura *memoria*. E la metrica di calibrazione che il PM vuole costruire
— evidence_sufficient, gap dalla folla — su un backrun contaminato diventa un
generatore di falsa fiducia: il bot sembrerà calibrato PROPRIO sui casi dove in realtà
ha barato per data leakage. È peggio di non testare, perché il dashboard dirà "guarda
come si comporta bene" mentre misura la cosa sbagliata.

**Il check specifico:** prima di fidarsi di un solo backrun, va segmentato per data di
risoluzione rispetto al cutoff dichiarato del modello, e va aggiunto un canary set —
mercati risolti DOPO il cutoff, o sinteticamente alterati (stesso schema, esito
invertito rispetto al reale) per verificare che il giudizio non stia recuperando
l'esito a memoria invece che ragionare sulle regole.

**Sul (3):** evidence_sufficient auto-dichiarata dal modello stesso è un self-report,
non una misura indipendente — un modello può essere sicuro e sbagliato in modo
sistematico. Serve un secondo segnale non correlato (es. calibrazione storica
evidence-vs-errore su un set pulito) prima di trattarla come leading indicator.

---

## ROUND 2 — Rebuttal

*Nota del moderatore, introdotta dal proprietario del progetto tra i due round:*
**Jev è stateless e fire-and-forget.** Una volta presa una decisione su un mercato,
per quella posizione non serve richiamarlo. Questo ha conseguenze dirette sia sullo
scheduling (la spesa è per decisione, non per bot-ora) sia su cosa ha senso passare
come contesto. L'Architecture Lead è stato incaricato di verificare sui docs TypeSafe.

### Architecture Lead

**1. Cosa dicono davvero i docs**

Ho letto `system-one.md`, `state.md`, `how-to-build-with-system-one.md`,
`confidence.md`. Confermano lo stateless, ma indirettamente, non con una frase
esplicita su "quando rivalutare": *"Each request evaluates one state against one or
more questions. All questions see the same state and are evaluated independently"* —
nessuna menzione di stato persistente tra chiamate, nessun conversation-id, nessuna
sessione. `how-to-build-with-system-one.md` rincara: *"Questions are evaluated
independently and in parallel. One primitive's result does not become hidden context
that changes another primitive's result."* Jev è puramente funzionale: state → answer.

Nessuna riga dei docs dice "richiama quando lo stato del mondo cambia" — è
un'assenza, non una conferma. La cosa sfumante: `confidence.md` parla di "route on
uncertainty", non di rivalutazione temporale. L'intuizione del proprietario regge sui
docs, ma i docs non ci dicono NULLA su freshness: dobbiamo inferirla noi.

**2. Conseguenze architetturali**

Questo rovescia lo scheduling (Q1): non serve un cron che ripolla mercati con
posizione aperta — lo scheduler serve solo per scoprire NUOVI mercati o rivalutare
mercati NON ancora decisi. Una `prediction` diventa evento immutabile, punto:
`created_at`, `bot_config_version`, `state_snapshot` (il JSON esatto mandato a Jev,
altrimenti non potremo mai fare audit di "cosa sapeva quando"), risposta,
`confidence`. Nessun campo mutabile dopo l'insert.

Quando il contesto del mondo cambia con posizione già aperta, NON tocchiamo la
prediction: se vogliamo reagire, creiamo una seconda prediction linkata
(`supersedes_prediction_id`) sullo stesso mercato — mai un update in-place. La UI
"exchange-style" deve mostrare la sequenza di giudizi nel tempo, non un valore che
muta sotto i piedi.

**3. Sul backrun contaminato — rispondo allo Skeptic**

`runs.mode` isola l'esecuzione ma non basta da solo: senza un `model_cutoff_date` per
riga in `predictions` (o meglio congelato per `run`), non possiamo segmentare
"risolto prima/dopo cutoff" in query. Aggiungo `runs.model_cutoff_date` —
obbligatorio quando `mode='backrun'`, null altrimenti — così il canary set è una
query, non un'ipotesi.

---

**Verifica del moderatore, interposta qui perché contraddice due proposte sul tavolo:**

1. **Nessun knowledge cutoff è dichiarato da TypeSafe.** `GET /v1/models` restituisce
   solo una `release_date` (jev-latest = 2026-09-10). I docs non menzionano un
   training cutoff da nessuna parte. Quindi sia il "segmenta per data vs cutoff" dello
   Skeptic sia il `runs.model_cutoff_date` dell'Architecture Lead **non sono
   applicabili**: non esiste un valore vero da metterci.
2. **`jev-latest` è un alias mobile.** Docs: *"An alias moves when a new release
   ships, so the answers behind it can change without a change on your side. The
   response's model field reports the versioned ID that answered, so you can log which
   model produced each result."*
3. **Gap reale nel codice:** la tabella `predictions` non ha una colonna `model`
   (verificato con PRAGMA). Oggi non sappiamo quale versione ha prodotto una
   predizione.
4. Context budget: 64k per state + tutte le domande insieme.

### Senior Engineer (Skeptic)

**Punto 1:** prendo atto, il cutoff dichiarato non esiste, quindi segmentare per data
di risoluzione vs cutoff è morto, ritiro la proposta così com'era. Ma il canary set
non dipende dal cutoff, dipende solo da avere mercati a esito noto e mercati aperti
nello stesso batch: resta valido, anzi diventa l'unico ancoraggio che abbiamo.
Versione praticabile: fissare un set fisso di 20-30 mercati già risolti (qualunque
data, non serve saperne il cutoff) e ripassarli periodicamente come **controllo di
deriva del modello**, non come prova di generalizzazione. Se le risposte cambiano nel
tempo su domande identiche, è l'alias che si muove sotto di noi, non rumore.

**Punto 2:** qui l'Architecture Lead mi dà l'arma che mi mancava. Alias mobile +
`predictions` senza colonna `model` è peggio di quanto pensassi: non è solo "non
sappiamo chi ha risposto", è che un esperimento a cavallo di un cambio di release
diventa silenziosamente un esperimento su DUE modelli diversi, mischiati, senza modo
di separarli a posteriori. Nessun canary regge se non sappiamo quale versione ha
risposto quando. Non discutibile: la colonna `model` (il versioned ID dalla response,
non l'alias) va aggiunta a `predictions` prima di qualsiasi run sperimentale, punto,
non "nice to have" del prossimo sprint.

**Punto 3:** `supersedes_prediction_id` mi convince come modello di audit, ma è anche
l'esatto meccanismo per barare: se non c'è una regola ferrea che una supersede scatta
SOLO su un evento di stato oggettivo e loggato (non su "non mi piaceva il risultato"),
diventa rigioca-finché-vince. Serve un trigger esplicito e vincolato, non
discrezionale, per aprire una nuova prediction.

---

*Convergenza raggiunta alla fine del round 2 sui punti strutturali: schema
versionato, immutabilità delle predizioni, scheduling rovesciato dal fire-and-forget,
colonna model obbligatoria, canary come controllo di deriva. Il moderatore chiude qui
e passa alla sintesi.*
