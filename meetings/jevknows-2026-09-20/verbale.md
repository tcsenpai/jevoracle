# Verbale, production meeting JevKnows

**Data:** 2026-09-20
**Partecipanti:** Product/Strategy Lead, Architecture Lead, Senior Engineer (Builder), Senior Engineer (Skeptic), Moderatore (sintesi e verifiche sui fatti), Proprietario del progetto (intervento tra Round 1 e Round 2).

**Oggetto:** Strutturare JevKnows, piattaforma di command-and-control per bot di prediction-market basati su Jev (TypeSafe System One), rifattorizzando il repo jevoracle da engine monolitico a piattaforma multi-bot. Utente singolo (il proprietario), paper trading, nessuna esecuzione reale, UI stile exchange, console attuale declassata a pagina di svago. Vincoli tecnici: Bun piu' SQLite piu' vanilla JS, nessun build step, nessuna dipendenza npm.

---

## Decisioni prese

Solo punti su cui c'e' stato consenso esplicito o nessuna obiezione residua a fine Round 2.

1. **Un solo schema di domanda tipizzata per tutti i bot in v1.** Product Lead e Architecture Lead convergono per ragioni diverse (comparabilita' di prodotto il primo, sopravvivenza dello schema il secondo). Motivazione: se due bot rispondono a domande diverse cade la comparabilita', che e' l'unico motivo per cui una dashboard multi-bot ha senso.

2. **Il typed question schema vive nel codice applicativo, non nella tabella.** `request_json` / `answers_json` restano blob liberi e sono il punto di flessibilita'. Un bot-tipo futuro con domande diverse e' uno `schema_version` nuovo dentro lo stesso blob, non una tabella nuova.

3. **`bot_configs` e' append-only, mai UPDATE.** Ogni predizione fissa `bot_config_version`. Motivazione: senza questo, cambiare una soglia riscrive retroattivamente il significato di centinaia di predizioni gia' registrate, e la migrazione al giorno 90 e' dolorosa. Il Builder ha confermato la fattibilita' (due ore di lavoro, e' `config.js` con `bot_id` e `version` in piu').

4. **`runs.mode` (`live` | `backrun` | `experiment`) nello stesso schema, non tabelle parallele.** Motivazione: l'isolamento del backrun deve essere ottenibile con un `WHERE` ovunque, non con JOIN diversi per tipo.

5. **Le predizioni sono eventi immutabili.** Nessun campo mutabile dopo l'insert. Per reagire a un cambio di contesto si crea una seconda prediction linkata via `supersedes_prediction_id`, mai un UPDATE in-place. La UI exchange-style mostra la sequenza di giudizi nel tempo.

6. **Lo scheduling e' rovesciato dal fire-and-forget.** Conseguenza diretta dell'intervento del proprietario ("Jev e' stateless e fire-and-forget, una volta presa una decisione su un mercato, per quella posizione non serve richiamarlo"), verificata dall'Architecture Lead sui docs TypeSafe. Non serve un cron che ripolla mercati con posizione aperta: lo scheduler serve solo per scoprire mercati NUOVI o rivalutare mercati NON ancora decisi. La spesa e' per decisione, non per bot-ora.

7. **Un solo scheduler globale, non N loop paralleli.** Loop di `engine.js` esteso, che itera i bot in coda cron-style, un bot alla volta o batch limitato, con priorita' per bankroll e soglie. Motivazione: N bot in polling autonomo sugli stessi mercati Polymarket duplicano chiamate. Stima Builder: 1 giorno, riuso quasi totale di `engine.js`.

8. **La colonna `model` in `predictions` e' obbligatoria prima di qualsiasi run sperimentale.** Deve contenere il versioned ID restituito nel campo `model` della response, non l'alias. Motivazione (Skeptic, non contestata): `jev-latest` e' un alias mobile, quindi un esperimento a cavallo di un cambio release diventa silenziosamente un esperimento su due modelli diversi mischiati, non separabili a posteriori.

9. **`state_snapshot` obbligatorio su ogni prediction.** Il JSON esatto inviato a Jev, altrimenti non e' possibile l'audit di "cosa sapeva quando".

10. **Il canary set sopravvive, ma cambia natura.** Non e' piu' prova di generalizzazione (proposta caduta, vedi sotto): e' un **controllo di deriva del modello**. Set fisso di 20-30 mercati gia' risolti, qualunque data di risoluzione, ripassati periodicamente. Se le risposte cambiano nel tempo su domande identiche, e' l'alias che si muove, non rumore.

11. **Nessun codice esistente viene buttato.** `engine.js`, `store.js`, `scoring.js`, `news.js`, l'adapter Polymarket e la dashboard (circa 1300 righe funzionanti e testate) non si toccano nella logica. Il refactor aggiunge un livello sopra. La tabella `experiments` esiste gia' (`experiment.js` ci scrive) ed e' riuso, non tabella nuova.

12. **Stima complessiva accettata: 4-5 giorni** per schema multi-bot piu' scheduler piu' adattamento della dashboard a lista bot (invece del layout a 3 tab singolo).

---

## Schema dati concordato

Cinque tabelle. `experiments` esiste gia' nel repo. Le altre nascono dal refactor.

```sql
CREATE TABLE bots (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  bankroll        REAL NOT NULL,
  status          TEXT NOT NULL,          -- active | paused | archived
  schema_version  INTEGER NOT NULL,       -- versione del typed question schema applicativo
  created_at      TEXT NOT NULL
);

-- APPEND-ONLY. Mai UPDATE, mai DELETE. Un cambio di config = nuova riga.
CREATE TABLE bot_configs (
  bot_id          INTEGER NOT NULL REFERENCES bots(id),
  version         INTEGER NOT NULL,
  context_json    TEXT NOT NULL,          -- contesto personalizzato per bot
  thresholds_json TEXT NOT NULL,          -- soglie personalizzate per bot
  valid_from      TEXT NOT NULL,
  valid_to        TEXT,                   -- NULL = config corrente
  PRIMARY KEY (bot_id, version)
);

CREATE TABLE runs (
  id                  INTEGER PRIMARY KEY,
  bot_id              INTEGER NOT NULL REFERENCES bots(id),
  bot_config_version  INTEGER NOT NULL,
  started_at          TEXT NOT NULL,
  mode                TEXT NOT NULL       -- live | backrun | experiment
                      CHECK (mode IN ('live','backrun','experiment'))
  -- NOTA: model_cutoff_date NON esiste. Proposta caduta, vedi "Cosa e' stato smentito".
);

-- EVENTO IMMUTABILE. Nessun campo mutabile dopo l'insert.
CREATE TABLE predictions (
  id                        INTEGER PRIMARY KEY,
  run_id                    INTEGER NOT NULL REFERENCES runs(id),
  bot_id                    INTEGER NOT NULL REFERENCES bots(id),
  bot_config_version        INTEGER NOT NULL,
  market_id                 TEXT NOT NULL,
  model                     TEXT NOT NULL,   -- versioned ID dal campo `model` della response
                                             -- MAI l'alias 'jev-latest'. Obbligatorio.
  state_snapshot            TEXT NOT NULL,   -- JSON esatto inviato a Jev (audit "cosa sapeva quando")
  request_json              TEXT NOT NULL,   -- blob libero, punto di flessibilita'
  answers_json              TEXT NOT NULL,   -- blob libero
  confidence                REAL,
  supersedes_prediction_id  INTEGER REFERENCES predictions(id),  -- NULL = primo giudizio sul mercato
  created_at                TEXT NOT NULL
);

CREATE TABLE experiments (   -- GIA' ESISTENTE, scritta da experiment.js
  id           INTEGER PRIMARY KEY,
  bot_id       INTEGER REFERENCES bots(id),
  description  TEXT,
  results_json TEXT
);
```

Vincoli operativi che accompagnano lo schema:

- `bot_configs`: append-only applicato a livello di codice (`store.js`), nessun path che emetta UPDATE.
- `predictions.model`: popolato leggendo il campo `model` della response TypeSafe, non l'alias richiesto.
- `supersedes_prediction_id`: vedi disaccordi aperti, il trigger che autorizza una supersede non e' stato definito.
- Context budget Jev: **64k per state piu' tutte le domande insieme**. Il contenuto di `state_snapshot` va dimensionato su questo tetto.

---

## Disaccordi aperti

**1. `supersedes_prediction_id`: serve un trigger vincolato, non definito.**
Lo Skeptic, verbatim: *"`supersedes_prediction_id` mi convince come modello di audit, ma e' anche l'esatto meccanismo per barare: se non c'e' una regola ferrea che una supersede scatta SOLO su un evento di stato oggettivo e loggato (non su 'non mi piaceva il risultato'), diventa rigioca-finche-vince. Serve un trigger esplicito e vincolato, non discrezionale, per aprire una nuova prediction."*
L'Architecture Lead aveva proposto il meccanismo come puro modello di audit (*"Quando il contesto del mondo cambia con posizione gia' aperta, NON tocchiamo la prediction"*) senza specificare cosa qualifica come "il contesto cambia". Il meccanismo e' approvato, la **regola di attivazione non esiste ancora**. Aperto.

**2. `evidence_sufficient` come leading indicator: self-report contro misura indipendente.**
Il Product Lead lo vuole al centro della dashboard: *"Costruite la dashboard attorno a 'questo bot si sta comportando in modo coerente con la sua evidence', non attorno a 'ha vinto o perso'"*, e cita come segnale d'oro il caso F1 all'80pt sbagliato ma con 12% evidence.
Lo Skeptic obietta: *"evidence_sufficient auto-dichiarata dal modello stesso e' un self-report, non una misura indipendente, un modello puo' essere sicuro e sbagliato in modo sistematico. Serve un secondo segnale non correlato (es. calibrazione storica evidence-vs-errore su un set pulito) prima di trattarla come leading indicator."*
Non c'e' stata replica del Product Lead nel Round 2. **Nessuna convergenza.** Qual e' il secondo segnale non correlato, e se serve davvero prima della v1, resta indeciso.

**3. Se le domande di ingegneria siano bloccanti per lo scoping.**
Product Lead: *"(1), (4), (5) sono domande di ingegneria, non di prodotto, si risolvono mentre si costruisce, non prima. Non bloccatemi lo scoping su quello."*
Architecture Lead: *"Il Product Lead ha ragione che (1)(4)(5) si 'risolvono costruendo', falso per la (5) sullo specifico punto della config immutabile."*
Il merito (config immutabile) e' stato risolto a favore dell'Architecture Lead, il **principio generale su cosa blocchi lo scoping non e' stato ricomposto**.

**4. Che valore abbia davvero un backrun, ora che il controllo per cutoff e' impossibile.**
Lo Skeptic ha ritirato la segmentazione per cutoff e ha ripiegato sul canary come controllo di deriva, che per sua stessa ammissione **non e' prova di generalizzazione**. Nessuno al tavolo ha ripreso la domanda di fondo: la posizione iniziale dello Skeptic era *"il backrun mal fatto non e' 'meno utile', e' attivamente ingannevole"* e *"e' peggio di non testare"*. Con il cutoff indisponibile, resta senza risposta se il backrun in `runs.mode='backrun'` produca un numero su cui si possa costruire una metrica, o solo un artefatto da guardare con sospetto. Aperto.

---

## Cosa e' stato smentito dai fatti

Verifiche condotte dal moderatore durante il meeting, che hanno fatto cadere proposte gia' sul tavolo.

1. **TypeSafe non dichiara alcun knowledge cutoff.** `GET /v1/models` restituisce solo una `release_date` (`jev-latest` = 2026-09-10). I docs non menzionano un training cutoff da nessuna parte. Cadono due proposte:
   - la segmentazione del backrun per data di risoluzione rispetto al cutoff dichiarato (Senior Engineer Skeptic), ritirata dall'autore: *"prendo atto, il cutoff dichiarato non esiste, quindi segmentare per data di risoluzione vs cutoff e' morto, ritiro la proposta cosi' com'era"*;
   - il campo `runs.model_cutoff_date` obbligatorio con `mode='backrun'` (Architecture Lead), **non applicabile**: non esiste un valore vero da metterci. Non entra nello schema.

2. **`jev-latest` e' un alias mobile.** Docs: *"An alias moves when a new release ships, so the answers behind it can change without a change on your side. The response's model field reports the versioned ID that answered, so you can log which model produced each result."* Questo ha trasformato la colonna `model` da nice-to-have a requisito bloccante (decisione 8) e ha ridefinito il canary da prova di generalizzazione a controllo di deriva (decisione 10).

3. **La tabella `predictions` attuale non ha una colonna `model`.** Verificato con `PRAGMA table_info`. Oggi non e' possibile sapere quale versione del modello ha prodotto una predizione esistente: lo storico pre-refactor resta non attribuibile.

4. **Polymarket e' Polygon-only e non ha testnet.** Verificato. Nessuna via di test on-chain, il paper trading resta l'unico ambiente possibile.

5. **I docs non dicono nulla su freshness.** L'Architecture Lead ha verificato `system-one.md`, `state.md`, `how-to-build-with-system-one.md`, `confidence.md`: lo stateless e' confermato solo indirettamente (*"Each request evaluates one state against one or more questions"*, nessun conversation-id, nessuna sessione) e *"Nessuna riga dei docs dice 'richiama quando lo stato del mondo cambia', e' un'assenza, non una conferma"*. L'intuizione del proprietario regge, ma la politica di freshness e' inferita da noi, non documentata. Non e' una smentita, e' un fondamento piu' debole di quanto sembri, e va registrato come tale.

6. **Context budget: 64k per state piu' tutte le domande insieme.** Verificato. Vincolo dimensionale su `state_snapshot` e sul contesto personalizzato per bot.

---

## Action item

| Cosa | Owner (ruolo) | Priorita' |
|---|---|---|
| Aggiungere la colonna `model` a `predictions`, popolata dal versioned ID della response. Bloccante per qualsiasi run sperimentale | Senior Engineer (Builder) | P0, bloccante |
| Implementare `bot_configs` append-only partendo da `config.js` (aggiunta `bot_id` e `version`, rimozione di ogni path di UPDATE). Stima 2 ore | Senior Engineer (Builder) | P0 |
| Migrazione schema multi-bot: `bots`, `bot_configs`, `runs` con `mode`, `predictions` con `state_snapshot` e `supersedes_prediction_id`. Riuso di `experiments` | Architecture Lead con Senior Engineer (Builder) | P0 |
| Scheduler globale singolo sul loop di `engine.js`, cron-style, coda bot con priorita' per bankroll e soglie. Solo discovery di mercati nuovi e mercati non ancora decisi. Stima 1 giorno | Senior Engineer (Builder) | P1 |
| Definire la regola ferrea di attivazione di una supersede (evento di stato oggettivo e loggato), prima che il meccanismo sia usabile | Senior Engineer (Skeptic) con Architecture Lead | P1, blocca l'uso di `supersedes_prediction_id` |
| Costruire il canary set: 20-30 mercati risolti fissi, ripassati periodicamente come controllo di deriva del modello. Presuppone la colonna `model` | Senior Engineer (Skeptic) | P1 |
| Adattare la dashboard da layout a 3 tab singolo a lista bot, stile exchange, con sequenza dei giudizi nel tempo invece di valore mutabile | Senior Engineer (Builder) | P1 |
| Declassare la console esistente a pagina di svago, senza toccarne la logica | Senior Engineer (Builder) | P2 |
| Individuare il secondo segnale non correlato a `evidence_sufficient` (calibrazione storica evidence-vs-errore su set pulito), o dichiarare che si procede senza | Product/Strategy Lead con Senior Engineer (Skeptic) | P2, vedi decisione del proprietario |
| Verificare che `state_snapshot` piu' contesto per bot piu' domande stiano entro i 64k di context budget | Architecture Lead | P2 |

---

## Richiede decisione del proprietario

Punti che gli agenti non hanno risolto e che non possono risolvere al posto suo.

1. **Il backrun resta nel piano oppure no.** Con il cutoff indisponibile, non esiste alcun modo di dimostrare che un backrun misuri capacita' predittiva e non memoria. Lo Skeptic sostiene che un backrun mal fatto e' *"peggio di non testare"*. Il canary di deriva non colma questo vuoto. Il proprietario deve decidere se: (a) costruire il backrun accettando esplicitamente che i suoi numeri non sono evidenza di generalizzazione e marcandoli come tali in UI, (b) rimandarlo, (c) abbandonarlo. `runs.mode='backrun'` resta nello schema in ogni caso, il costo di tenerlo e' nullo.

2. **Se `evidence_sufficient` possa essere la metrica principale della dashboard in v1 senza un secondo segnale indipendente.** E' l'unico disaccordo di prodotto rimasto aperto, e la scelta determina l'intera forma della dashboard. Product Lead a favore, Skeptic contrario. Serve una chiamata del proprietario, non un altro round di dibattito.

3. **Politica di freshness: quando il mondo cambia, si apre una nuova prediction o no.** I docs TypeSafe non dicono nulla in merito, e' un'inferenza nostra. Il proprietario ha introdotto il principio fire-and-forget e deve stabilirne il limite: cosa qualifica come "evento di stato oggettivo" che giustifica una supersede. Senza questa regola il meccanismo e' inutilizzabile (vedi action item P1). E' una decisione di dominio sui prediction market, non di ingegneria.

4. **Se pinnare un versioned ID invece di usare `jev-latest`.** Usare l'alias significa accettare che le risposte cambino sotto i piedi senza preavviso; pinnare significa gestire a mano gli aggiornamenti. La colonna `model` rende il problema visibile e auditabile ma non lo risolve. Trade-off di gestione, non tecnico.

5. **Se lo storico di predizioni pre-refactor (senza colonna `model`) vada conservato, marcato come non attribuibile, o scartato.** Nessuno al tavolo ha proposto una linea.

6. **Budget di spesa API accettabile per ciclo di scheduling.** Il Builder ha risolto la duplicazione di chiamate (scheduler singolo) e il fire-and-forget ha ridotto la spesa a "per decisione", ma nessun tetto numerico e' stato fissato. Serve un numero dal proprietario per tarare la frequenza di discovery e la dimensione del batch.
