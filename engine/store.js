/* SQLite store for the paper-trading record.
 *
 * One row per prediction, written once and never edited except to settle it.
 * The crowd price at decision time is frozen into the row, because a prediction
 * you can silently re-price later is not a prediction.
 */
import { Database } from "bun:sqlite";

export function openStore(path = "data/engine.db") {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS predictions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at    TEXT NOT NULL,
      event_slug    TEXT NOT NULL,
      event_title   TEXT NOT NULL,
      market_label  TEXT NOT NULL,
      condition_id  TEXT,
      token_id      TEXT,
      end_date      TEXT,

      crowd         REAL NOT NULL,   -- price at decision time, frozen
      jev           REAL NOT NULL,
      edge          REAL NOT NULL,   -- jev - crowd
      evidence      REAL,            -- Jev's own evidence_sufficient
      rules_strict  REAL,
      ambiguity     TEXT,

      -- both edge rules, recorded side by side so they can be compared later
      gated         INTEGER NOT NULL DEFAULT 0,
      ungated       INTEGER NOT NULL DEFAULT 0,
      side          TEXT,            -- YES or NO
      stake_gated   REAL DEFAULT 0,
      stake_ungated REAL DEFAULT 0,

      request_json  TEXT NOT NULL,
      answers_json  TEXT NOT NULL,
      latency_ms    INTEGER,
      news_count    INTEGER DEFAULT 0,
      model         TEXT,            -- versioned id from the response, not the alias

      settled_at    TEXT,
      outcome       INTEGER,         -- 1 = YES, 0 = NO, NULL = open
      pnl_gated     REAL,
      pnl_ungated   REAL,
      UNIQUE(event_slug, market_label, created_at)
    );
    CREATE INDEX IF NOT EXISTS idx_open ON predictions(outcome) WHERE outcome IS NULL;
    CREATE INDEX IF NOT EXISTS idx_slug ON predictions(event_slug);

    CREATE TABLE IF NOT EXISTS runs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      scanned    INTEGER DEFAULT 0,
      asked      INTEGER DEFAULT 0,
      recorded   INTEGER DEFAULT 0,
      note       TEXT
    );
  `);
  // added after the first scans; ignore the error when it already exists
  try { db.exec("ALTER TABLE predictions ADD COLUMN news_count INTEGER DEFAULT 0"); } catch {}
  // jev-latest is a MOVING ALIAS: without this, an experiment that straddles a
  // release silently becomes an experiment across two different models.
  try { db.exec("ALTER TABLE predictions ADD COLUMN model TEXT"); } catch {}
  return db;
}

export const insertPrediction = (db, p) => db.prepare(`
  INSERT OR IGNORE INTO predictions
    (created_at,event_slug,event_title,market_label,condition_id,token_id,end_date,
     crowd,jev,edge,evidence,rules_strict,ambiguity,
     gated,ungated,side,stake_gated,stake_ungated,
     request_json,answers_json,latency_ms,news_count,model)
  VALUES (?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?)
`).run(
  p.created_at, p.event_slug, p.event_title, p.market_label, p.condition_id ?? null,
  p.token_id ?? null, p.end_date ?? null,
  p.crowd, p.jev, p.edge, p.evidence ?? null, p.rules_strict ?? null, p.ambiguity ?? null,
  p.gated ? 1 : 0, p.ungated ? 1 : 0, p.side ?? null, p.stake_gated ?? 0, p.stake_ungated ?? 0,
  JSON.stringify(p.request), JSON.stringify(p.answers), p.latency_ms ?? null, p.news_count ?? 0, p.model ?? null);

export const openPredictions = db =>
  db.prepare("SELECT * FROM predictions WHERE outcome IS NULL ORDER BY created_at DESC").all();

export const allPredictions = (db, limit = 500) =>
  db.prepare("SELECT * FROM predictions ORDER BY created_at DESC LIMIT ?").all(limit);

export const settle = (db, id, outcome, pnlGated, pnlUngated) => db.prepare(`
  UPDATE predictions SET settled_at=?, outcome=?, pnl_gated=?, pnl_ungated=? WHERE id=?
`).run(new Date().toISOString(), outcome, pnlGated, pnlUngated, id);
