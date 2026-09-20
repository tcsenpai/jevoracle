/* A/B the state, from the dashboard.
 *
 * Runs the same markets through several context variants and stores the result, so
 * the comparison survives the page reload that produced it.
 */
import { fetchEvent, pickMarket, toJevRequest } from "../scripts/polymarket.js";
import { newsFor } from "./news.js";
import { applyFields, getConfig } from "./config.js";

export const VARIANTS = {
  rules: { label: "Rules only", fields: { recent_reporting: false, trader_notes: false, subject_area: false } },
  notes: { label: "+ trader notes", fields: { recent_reporting: false } },
  news:  { label: "+ reporting",    fields: { trader_notes: false } },
  full:  { label: "Everything",     fields: {} },
};

export function initExperiments(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS experiments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      slugs TEXT NOT NULL,
      variants TEXT NOT NULL,
      results TEXT NOT NULL,
      note TEXT
    )`);
}

async function ask(request, key) {
  const t0 = Date.now();
  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(request), signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`TypeSafe ${res.status}`);
  const d = await res.json();
  return { answers: d.answers, ms: d._ms ?? Date.now() - t0, tokens: d.usage?.input_tokens ?? null };
}

export async function runExperiment({ db, apiKey, slugs, variants = Object.keys(VARIANTS), note }) {
  initExperiments(db);
  const cfg = getConfig(db);
  const markets = [];

  for (const slug of slugs) {
    let ev, m;
    try {
      ev = await fetchEvent(slug, { comments: 60 });
      m = pickMarket(ev);
      if (!m) { markets.push({ slug, error: "no priceable market" }); continue; }
    } catch (err) { markets.push({ slug, error: String(err.message ?? err) }); continue; }

    let news = { items: [], count: 0, query: null, dropped: 0 };
    if (variants.some(v => VARIANTS[v]?.fields.recent_reporting !== false)) {
      try { news = await newsFor(ev, m, { max: cfg.newsMax, timelimit: cfg.newsWindow }); } catch {}
    }
    const base = toJevRequest(ev, { market: m, news: news.items }).request;

    const runs = [];
    for (const v of variants) {
      const spec = VARIANTS[v]; if (!spec) continue;
      const req = applyFields(base, { ...cfg.fields, ...spec.fields });
      try {
        const { answers, tokens } = await ask(req, apiKey);
        runs.push({
          variant: v, label: spec.label, tokens,
          jev: answers.verdict.noul,
          evidence: answers.evidence_sufficient?.noul ?? null,
          gap: answers.verdict.noul - m.yes,
          fields: Object.keys(req.state),
        });
      } catch (err) { runs.push({ variant: v, label: spec.label, error: String(err.message ?? err) }); }
    }

    markets.push({
      slug, title: ev.title, market: m.label, crowd: m.yes,
      notesKept: ev.notes.length, commentTotal: ev.commentCount,
      newsCount: news.count, newsDropped: news.dropped, newsQuery: news.query,
      runs,
    });
  }

  // Averages per variant, which is the only way a handful of markets says anything.
  const summary = variants.map(v => {
    const rs = markets.flatMap(m => (m.runs ?? []).filter(r => r.variant === v && !r.error)
      .map(r => ({ ...r, crowd: m.crowd })));
    const mean = f => rs.length ? rs.reduce((a, r) => a + f(r), 0) / rs.length : null;
    return {
      variant: v, label: VARIANTS[v]?.label ?? v, n: rs.length,
      evidence: mean(r => r.evidence ?? 0),
      absGap: mean(r => Math.abs(r.gap)),
      tokens: mean(r => r.tokens ?? 0),
    };
  }).filter(s => s.n > 0);

  const row = { created_at: new Date().toISOString(), slugs, variants, markets, summary, note };
  db.prepare("INSERT INTO experiments (created_at,slugs,variants,results,note) VALUES (?,?,?,?,?)")
    .run(row.created_at, JSON.stringify(slugs), JSON.stringify(variants),
         JSON.stringify({ markets, summary }), note ?? null);
  return row;
}

export function listExperiments(db, limit = 20) {
  initExperiments(db);
  return db.prepare("SELECT * FROM experiments ORDER BY id DESC LIMIT ?").all(limit)
    .map(r => ({ ...r, slugs: JSON.parse(r.slugs), variants: JSON.parse(r.variants),
                 ...JSON.parse(r.results) }));
}
