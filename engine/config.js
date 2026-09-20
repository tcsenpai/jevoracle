/* Which fields go into the state, and the thresholds that decide a bet.
 *
 * Stored in the same SQLite file as the predictions, because a prediction is only
 * interpretable next to the settings that produced it.
 */

export const FIELDS = [
  { key: "resolution_rules", label: "Resolution rules",
    help: "The full criteria. Usually the single most useful field.", locked: true },
  { key: "window", label: "Dates",
    help: "Today's date and when the market resolves." },
  { key: "subject_area", label: "Subject tags",
    help: "At most three tags for framing. Polymarket repeats itself here." },
  { key: "resolution_source", label: "Resolution source",
    help: "Where the market says it will look to settle. Often absent." },
  { key: "recent_reporting", label: "Recent reporting",
    help: "Dated news via ddgs, filtered for relevance. Slow and rate-limited." },
  { key: "trader_notes", label: "Trader notes",
    help: "Comments that look like someone reporting a fact. Price chatter is stripped." },
];

export const DEFAULT_CONFIG = {
  fields: {
    resolution_rules: true,
    window: true,
    subject_area: true,
    resolution_source: true,
    recent_reporting: true,
    trader_notes: true,
  },
  newsMax: 6,
  newsWindow: "w",      // d, w, m, y
  noteMax: 8,
  minEdge: 0.08,
  minEvidence: 0.5,
  minVolume: 50000,
  bankroll: 1000,
  kellyFraction: 0.25,
  maxStakeFraction: 0.05,
};

export function initConfig(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`);
}

export function getConfig(db) {
  initConfig(db);
  const row = db.prepare("SELECT value FROM config WHERE key='engine'").get();
  if (!row) return { ...DEFAULT_CONFIG };
  try {
    const saved = JSON.parse(row.value);
    return { ...DEFAULT_CONFIG, ...saved, fields: { ...DEFAULT_CONFIG.fields, ...(saved.fields ?? {}) } };
  } catch { return { ...DEFAULT_CONFIG }; }
}

export function saveConfig(db, patch) {
  initConfig(db);
  const next = { ...getConfig(db), ...patch };
  if (patch.fields) next.fields = { ...getConfig(db).fields, ...patch.fields };
  next.fields.resolution_rules = true;   // without the rules there is no question
  db.prepare(`INSERT INTO config (key,value,updated_at) VALUES ('engine',?,?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(JSON.stringify(next), new Date().toISOString());
  return next;
}

/** Drop the state fields this config turns off. */
export function applyFields(request, fields) {
  const state = { ...request.state };
  for (const { key, locked } of FIELDS)
    if (!locked && fields[key] === false) delete state[key];
  return { ...request, state };
}
