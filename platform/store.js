/* JevKnows — multi-bot schema.
 *
 * Decided in the production meeting of 2026-09-20 (meetings/jevknows-2026-09-20/verbale.md).
 * Three invariants that are NOT negotiable at runtime:
 *   1. bot_configs is append-only. A config change is a new row, never an UPDATE.
 *      Without this, changing a threshold would retroactively rewrite the meaning of
 *      all the history already recorded.
 *   2. predictions is immutable after insert, except for settlement (which is an
 *      external fact, not a revision of the judgment).
 *   3. model holds the versioned id from the response, never the alias. jev-latest moves.
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

    -- APPEND ONLY. No path in this file issues an UPDATE on this table.
    CREATE TABLE IF NOT EXISTS bot_configs (
      bot_id          INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
      version         INTEGER NOT NULL,
      context_json    TEXT NOT NULL,   -- which state fields, news, note
      thresholds_json TEXT NOT NULL,   -- minEdge, minEvidence, kelly, market universe
      valid_from      TEXT NOT NULL,
      valid_to        TEXT,            -- NULL = current config
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

      crowd              REAL NOT NULL,   -- price frozen at decision time
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

      -- the versioned id from the response, NEVER the alias
      model              TEXT NOT NULL,
      state_snapshot     TEXT NOT NULL,   -- the exact JSON sent to Jev
      answers_json       TEXT NOT NULL,
      latency_ms         INTEGER,
      news_count         INTEGER DEFAULT 0,

      -- a new evaluation does not overwrite the old one, it supersedes it
      supersedes_prediction_id INTEGER REFERENCES predictions(id),
      supersede_reason   TEXT,

      -- settlement is an external fact, not a revision of the judgment
      settled_at         TEXT,
      outcome            INTEGER,
      pnl_gated          REAL,
      pnl_ungated        REAL,

      -- populated only when engine.name = 'quorum'. 'model' alone is not
      -- enough to reconstruct who answered what: engine_votes is the JSON
      -- { engineName: { model, ms, answers } } of EVERY engine queried,
      -- so months later it is still possible to read each one's vote,
      -- not just the combined outcome. NULL for single-engine runs.
      engine_votes        TEXT,
      engine_warning       TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_pred_bot  ON predictions(bot_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pred_open ON predictions(outcome) WHERE outcome IS NULL;
    CREATE INDEX IF NOT EXISTS idx_pred_run  ON predictions(run_id);
    CREATE INDEX IF NOT EXISTS idx_runs_bot  ON runs(bot_id, started_at DESC);

    /* Side assistant opinions. Separate table, not columns on predictions:
     * in blind mode the opinion is born BEFORE the prediction, in review mode AFTER.
     * Putting it inside predictions would require an UPDATE on a row declared
     * immutable, opening the door to retroactive rewrites of the judgment. */
    CREATE TABLE IF NOT EXISTS assistant_opinions (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id             INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
      bot_config_version INTEGER NOT NULL,
      mode               TEXT NOT NULL CHECK (mode IN ('pre','blind','review')),
      created_at         TEXT NOT NULL,
      event_slug         TEXT NOT NULL,
      market_label       TEXT NOT NULL,
      -- NULL until the prediction exists (blind and pre modes)
      prediction_id      INTEGER REFERENCES predictions(id) ON DELETE SET NULL,
      probability        REAL,
      comment            TEXT,
      gaps_json          TEXT,
      enriched_json      TEXT,
      host               TEXT,
      model              TEXT,
      latency_ms         INTEGER,
      attempts           INTEGER,
      ok                 INTEGER NOT NULL DEFAULT 1,
      error              TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_op_pred ON assistant_opinions(prediction_id);
    CREATE INDEX IF NOT EXISTS idx_op_bot  ON assistant_opinions(bot_id, created_at DESC);

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

  // Additive migration: engine_votes/engine_warning arrived after the
  // initial schema was created. CREATE TABLE IF NOT EXISTS does not touch
  // tables that already exist, so on an old db the columns are missing until
  // explicitly added. ALTER TABLE ADD COLUMN is additive: existing rows stay
  // intact, the new field starts out NULL.
  // The migration below assumes the tables already exist. On a fresh db that
  // is not guaranteed: if the schema above failed to create predictions, the
  // ALTER TABLE fails and the server does not start at all. Better to notice
  // that with a clear message than with a raw SQLiteError at startup.
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
  if (!tables.includes("predictions")) {
    throw new Error(
      "The schema was not created: the predictions table is missing. " +
      `Tables present: ${tables.join(", ") || "none"}. ` +
      "Check that every CREATE TABLE actually runs, not just the first one in the block.");
  }

  const predCols = db.prepare("PRAGMA table_info(predictions)").all().map(c => c.name);
  if (!predCols.includes("engine_votes")) {
    db.exec("ALTER TABLE predictions ADD COLUMN engine_votes TEXT");
  }
  if (!predCols.includes("engine_warning")) {
    db.exec("ALTER TABLE predictions ADD COLUMN engine_warning TEXT");
  }

  return db;
}

const now = () => new Date().toISOString();

/* ---------- bots ---------- */
export function createBot(db, { name, blurb, bankroll = 1000, context, thresholds }) {
  const r = db.prepare(
    `INSERT INTO bots (name, blurb, bankroll, status, schema_version, created_at)
     VALUES (?,?,?,'paused',1,?)`).run(name, blurb ?? null, bankroll, now());
  const botId = Number(r.lastInsertRowid);
  putConfig(db, botId, { context, thresholds, note: "initial config" });
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

/** Only these fields are mutable on a bot. Not its history. */
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

/** Closes the current config and opens a new one. Never an UPDATE on the values. */
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
     latency_ms,news_count,supersedes_prediction_id,supersede_reason,engine_votes,engine_warning)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    p.run_id, p.bot_id, p.bot_config_version, now(), p.venue ?? "polymarket",
    p.event_slug, p.event_title, p.market_label, p.condition_id ?? null, p.token_id ?? null,
    p.end_date ?? null, p.crowd, p.jev, p.edge, p.evidence ?? null, p.confidence ?? null,
    p.rules_strict ?? null, p.ambiguity ?? null, p.gated ? 1 : 0, p.ungated ? 1 : 0,
    p.side ?? null, p.stake_gated ?? 0, p.stake_ungated ?? 0,
    p.model, JSON.stringify(p.state_snapshot), JSON.stringify(p.answers),
    p.latency_ms ?? null, p.news_count ?? 0,
    p.supersedes_prediction_id ?? null, p.supersede_reason ?? null,
    p.engine_votes ? JSON.stringify(p.engine_votes) : null, p.engine_warning ?? null).lastInsertRowid);
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

/* ---------- side assistant opinions ---------- */

export function insertOpinion(db, o) {
  return Number(db.prepare(`INSERT INTO assistant_opinions
    (bot_id,bot_config_version,mode,created_at,event_slug,market_label,prediction_id,
     probability,comment,gaps_json,enriched_json,host,model,latency_ms,attempts,ok,error)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    o.bot_id, o.bot_config_version, o.mode, now(), o.event_slug, o.market_label,
    o.prediction_id ?? null, o.probability ?? null, o.comment ?? null,
    JSON.stringify(o.gaps ?? []), o.enriched ? JSON.stringify(o.enriched) : null,
    o.host ?? null, o.model ?? null, o.latency_ms ?? null, o.attempts ?? null,
    o.ok ? 1 : 0, o.error ?? null).lastInsertRowid);
}

/** Only permitted update: linking an opinion born earlier to its prediction.
 *  Does not touch the values, only the link. */
export function linkOpinion(db, opinionId, predictionId) {
  db.prepare("UPDATE assistant_opinions SET prediction_id=? WHERE id=? AND prediction_id IS NULL")
    .run(predictionId, opinionId);
}

export const opinionsFor = (db, predictionId) => db.prepare(
  "SELECT * FROM assistant_opinions WHERE prediction_id=? ORDER BY id").all(predictionId);

export const botOpinions = (db, botId, limit = 100) => db.prepare(
  "SELECT * FROM assistant_opinions WHERE bot_id=? ORDER BY id DESC LIMIT ?").all(botId, limit);
