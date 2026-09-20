/* JevKnows — schema multi-bot.
 *
 * Deciso nel production meeting del 2026-09-20 (meetings/jevknows-2026-09-20/verbale.md).
 * Tre invarianti che NON si negoziano a runtime:
 *   1. bot_configs e' append-only. Un cambio di config e' una riga nuova, mai un UPDATE.
 *      Senza questo, cambiare una soglia riscrive retroattivamente il senso di tutto
 *      lo storico gia' registrato.
 *   2. predictions e' immutabile dopo l'insert, tranne il settlement (che e' un fatto
 *      esterno, non una revisione del giudizio).
 *   3. model contiene il versioned id dalla response, mai l'alias. jev-latest si muove.
 */
import { Database } from "bun:sqlite";

export function openDB(path = "data/jevknows.db") {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS bots (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT NOT NULL UNIQUE,
      blurb          TEXT,
      bankroll       REAL NOT NULL DEFAULT 1000,
      status         TEXT NOT NULL DEFAULT 'paused'
                     CHECK (status IN ('active','paused','archived')),
      schema_version INTEGER NOT NULL DEFAULT 1,
      created_at     TEXT NOT NULL
    );

    -- APPEND ONLY. Nessun path in questo file emette UPDATE su questa tabella.
    CREATE TABLE IF NOT EXISTS bot_configs (
      bot_id          INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
      version         INTEGER NOT NULL,
      context_json    TEXT NOT NULL,   -- quali campi di state, news, note
      thresholds_json TEXT NOT NULL,   -- minEdge, minEvidence, kelly, universo mercati
      valid_from      TEXT NOT NULL,
      valid_to        TEXT,            -- NULL = config corrente
      note            TEXT,
      PRIMARY KEY (bot_id, version)
    );

    CREATE TABLE IF NOT EXISTS runs (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id             INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
      bot_config_version INTEGER NOT NULL,
      mode               TEXT NOT NULL
                         CHECK (mode IN ('live','backrun','experiment','canary')),
      started_at         TEXT NOT NULL,
      finished_at        TEXT,
      scanned            INTEGER DEFAULT 0,
      asked              INTEGER DEFAULT 0,
      recorded           INTEGER DEFAULT 0,
      error              TEXT,
      note               TEXT
    );

    CREATE TABLE IF NOT EXISTS predictions (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id             INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      bot_id             INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
      bot_config_version INTEGER NOT NULL,
      created_at         TEXT NOT NULL,

      venue              TEXT NOT NULL DEFAULT 'polymarket',
      event_slug         TEXT NOT NULL,
      event_title        TEXT NOT NULL,
      market_label       TEXT NOT NULL,
      condition_id       TEXT,
      token_id           TEXT,
      end_date           TEXT,

      crowd              REAL NOT NULL,   -- prezzo congelato al momento della decisione
      jev                REAL NOT NULL,
      edge               REAL NOT NULL,
      evidence           REAL,
      confidence         REAL,
      rules_strict       REAL,
      ambiguity          TEXT,

      gated              INTEGER NOT NULL DEFAULT 0,
      ungated            INTEGER NOT NULL DEFAULT 0,
      side               TEXT,
      stake_gated        REAL DEFAULT 0,
      stake_ungated      REAL DEFAULT 0,

      -- il versioned id dalla response, MAI l'alias
      model              TEXT NOT NULL,
      state_snapshot     TEXT NOT NULL,   -- il JSON esatto mandato a Jev
      answers_json       TEXT NOT NULL,
      latency_ms         INTEGER,
      news_count         INTEGER DEFAULT 0,

      -- una nuova valutazione non riscrive la vecchia, la supersede
      supersedes_prediction_id INTEGER REFERENCES predictions(id),
      supersede_reason   TEXT,

      -- il settlement e' un fatto esterno, non una revisione del giudizio
      settled_at         TEXT,
      outcome            INTEGER,
      pnl_gated          REAL,
      pnl_ungated        REAL
    );

    CREATE INDEX IF NOT EXISTS idx_pred_bot  ON predictions(bot_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pred_open ON predictions(outcome) WHERE outcome IS NULL;
    CREATE INDEX IF NOT EXISTS idx_pred_run  ON predictions(run_id);
    CREATE INDEX IF NOT EXISTS idx_runs_bot  ON runs(bot_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS experiments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id     INTEGER REFERENCES bots(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      slugs      TEXT NOT NULL,
      variants   TEXT NOT NULL,
      results    TEXT NOT NULL,
      note       TEXT
    );
  `);
  return db;
}

const now = () => new Date().toISOString();

/* ---------- bots ---------- */
export function createBot(db, { name, blurb, bankroll = 1000, context, thresholds }) {
  const r = db.prepare(
    `INSERT INTO bots (name, blurb, bankroll, status, schema_version, created_at)
     VALUES (?,?,?,'paused',1,?)`).run(name, blurb ?? null, bankroll, now());
  const botId = Number(r.lastInsertRowid);
  putConfig(db, botId, { context, thresholds, note: "config iniziale" });
  return botId;
}

export const listBots = db => db.prepare(`
  SELECT b.*,
    (SELECT MAX(version) FROM bot_configs WHERE bot_id = b.id)          AS config_version,
    (SELECT COUNT(*) FROM predictions WHERE bot_id = b.id)              AS n_predictions,
    (SELECT COUNT(*) FROM predictions WHERE bot_id = b.id AND outcome IS NULL) AS n_open,
    (SELECT MAX(started_at) FROM runs WHERE bot_id = b.id)              AS last_run
  FROM bots b ORDER BY b.created_at`).all();

export const getBot = (db, id) => db.prepare("SELECT * FROM bots WHERE id=?").get(id);

/** Solo questi campi sono mutabili su un bot. Non la sua storia. */
export function setBotStatus(db, id, status) {
  db.prepare("UPDATE bots SET status=? WHERE id=?").run(status, id);
}
export function setBankroll(db, id, bankroll) {
  db.prepare("UPDATE bots SET bankroll=? WHERE id=?").run(bankroll, id);
}

/* ---------- configs: append only ---------- */
export function currentConfig(db, botId) {
  const row = db.prepare(
    `SELECT * FROM bot_configs WHERE bot_id=? AND valid_to IS NULL
     ORDER BY version DESC LIMIT 1`).get(botId);
  if (!row) return null;
  return { ...row, context: JSON.parse(row.context_json), thresholds: JSON.parse(row.thresholds_json) };
}

/** Chiude la config corrente e ne apre una nuova. Mai un UPDATE sui valori. */
export function putConfig(db, botId, { context, thresholds, note }) {
  const prev = db.prepare(
    "SELECT MAX(version) v FROM bot_configs WHERE bot_id=?").get(botId)?.v ?? 0;
  const version = prev + 1;
  const ts = now();
  db.transaction(() => {
    if (prev) db.prepare(
      "UPDATE bot_configs SET valid_to=? WHERE bot_id=? AND version=?").run(ts, botId, prev);
    db.prepare(`INSERT INTO bot_configs
      (bot_id,version,context_json,thresholds_json,valid_from,note) VALUES (?,?,?,?,?,?)`)
      .run(botId, version, JSON.stringify(context ?? {}), JSON.stringify(thresholds ?? {}), ts, note ?? null);
  })();
  return version;
}

export const configHistory = (db, botId) => db.prepare(
  "SELECT version, valid_from, valid_to, note FROM bot_configs WHERE bot_id=? ORDER BY version DESC").all(botId);

/* ---------- runs ---------- */
export function startRun(db, { botId, configVersion, mode, note }) {
  return Number(db.prepare(
    `INSERT INTO runs (bot_id,bot_config_version,mode,started_at,note) VALUES (?,?,?,?,?)`)
    .run(botId, configVersion, mode, now(), note ?? null).lastInsertRowid);
}
export function finishRun(db, runId, { scanned = 0, asked = 0, recorded = 0, error = null }) {
  db.prepare(`UPDATE runs SET finished_at=?, scanned=?, asked=?, recorded=?, error=? WHERE id=?`)
    .run(now(), scanned, asked, recorded, error, runId);
}
export const listRuns = (db, botId, limit = 50) => db.prepare(
  "SELECT * FROM runs WHERE bot_id=? ORDER BY id DESC LIMIT ?").all(botId, limit);

/* ---------- predictions ---------- */
export function insertPrediction(db, p) {
  return Number(db.prepare(`INSERT INTO predictions
    (run_id,bot_id,bot_config_version,created_at,venue,event_slug,event_title,market_label,
     condition_id,token_id,end_date,crowd,jev,edge,evidence,confidence,rules_strict,ambiguity,
     gated,ungated,side,stake_gated,stake_ungated,model,state_snapshot,answers_json,
     latency_ms,news_count,supersedes_prediction_id,supersede_reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    p.run_id, p.bot_id, p.bot_config_version, now(), p.venue ?? "polymarket",
    p.event_slug, p.event_title, p.market_label, p.condition_id ?? null, p.token_id ?? null,
    p.end_date ?? null, p.crowd, p.jev, p.edge, p.evidence ?? null, p.confidence ?? null,
    p.rules_strict ?? null, p.ambiguity ?? null, p.gated ? 1 : 0, p.ungated ? 1 : 0,
    p.side ?? null, p.stake_gated ?? 0, p.stake_ungated ?? 0,
    p.model, JSON.stringify(p.state_snapshot), JSON.stringify(p.answers),
    p.latency_ms ?? null, p.news_count ?? 0,
    p.supersedes_prediction_id ?? null, p.supersede_reason ?? null).lastInsertRowid);
}

export const botPredictions = (db, botId, limit = 200) => db.prepare(
  "SELECT * FROM predictions WHERE bot_id=? ORDER BY id DESC LIMIT ?").all(botId, limit);

export const openPredictions = (db, botId = null) => botId
  ? db.prepare("SELECT * FROM predictions WHERE outcome IS NULL AND bot_id=?").all(botId)
  : db.prepare("SELECT * FROM predictions WHERE outcome IS NULL").all();

export function settlePrediction(db, id, outcome, pnlGated, pnlUngated) {
  db.prepare(`UPDATE predictions SET settled_at=?, outcome=?, pnl_gated=?, pnl_ungated=?
              WHERE id=? AND outcome IS NULL`).run(now(), outcome, pnlGated, pnlUngated, id);
}
