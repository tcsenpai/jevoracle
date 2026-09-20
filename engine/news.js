import { tmpdir } from "os";
/* Fetch recent reporting for a market via the ddgs CLI.
 *
 * Jev reads what you give it and nothing else, so a market with no news in its
 * state is being judged on its rulebook alone. That is exactly what the first
 * live scan showed: five markets, mean self-reported evidence 11%.
 *
 * Requires `pip install ddgs`. Optional: if ddgs is missing the engine still runs,
 * it just records lower evidence scores.
 */

const isoDay = d => new Date(d).toISOString().slice(0, 10);

/** Build a search query from the market, stripped of Polymarket phrasing. */
export function queryFor(event, market) {
  // Use the EVENT title for subject and the market label for the specific outcome.
  // Market questions are written for traders ("Will X by December 31?"), which is
  // not how reporting is phrased, so strip the market scaffolding.
  const subject = (event.title || market.question || "")
    .replace(/^(will|which|who|what|how many)\s+/i, "")
    .replace(/\bby\.\.\.\?|\?+$/g, "")
    .replace(/\b(by|before|on|in)\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*\d*,?\s*\d{0,4}\b/gi, "")
    .replace(/\bx\b/gi, " ")            // "NATO x Russia" reads as a literal x to a search engine
    .replace(/[^\w\s'-]/g, " ")
    .replace(/\s+/g, " ").trim();

  // A date-like label ("December 31") adds nothing to a news query.
  const label = String(market.label ?? "");
  const labelUseful = label && !/^\w+ \d{1,2}(,? \d{4})?$/.test(label)
    && !subject.toLowerCase().includes(label.toLowerCase());

  return `${subject}${labelUseful ? " " + label : ""}`
    .replace(/\s+/g, " ").trim().split(/\s+/).slice(0, 10).join(" ");
}

const CACHE = new Map();
const TTL = 30 * 60 * 1000;

export async function searchNews(query, { max = 6, timelimit = "w", backends = ["bing", "duckduckgo", "yahoo"] } = {}) {
  // `-o json` writes a timestamped file into the CWD rather than stdout, so run in
  // a scratch dir and read the file back. `auto` as a backend returns nothing in
  // practice, and any single backend rate-limits, so try them in turn.
  const hit = CACHE.get(query);
  if (hit && Date.now() - hit.at < TTL) return hit.rows;

  for (const backend of backends) {
    const dir = `${tmpdir()}/jevnews-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    await Bun.$`mkdir -p ${dir}`.quiet().nothrow();
    try {
      const proc = Bun.spawn(
        ["ddgs", "news", "-q", query, "-m", String(max), "-t", timelimit, "-b", backend, "-o", "json"],
        { cwd: dir, stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => proc.kill(), 25000);
      await proc.exited;
      clearTimeout(timer);

      const glob = new Bun.Glob("*.json");
      let rows = null;
      for await (const f of glob.scan(dir)) {
        try { rows = JSON.parse(await Bun.file(`${dir}/${f}`).text()); } catch {}
        break;
      }
      if (Array.isArray(rows) && rows.length) {
        const mapped = rows.map(r => ({
          date: r.date ? isoDay(r.date) : null,
          title: String(r.title ?? "").trim(),
          body: String(r.body ?? "").trim(),
          source: r.source ?? (() => {
            try { return new URL(r.url).hostname.replace(/^www\./, ""); } catch { return null; }
          })(),
        })).filter(r => r.title);
        CACHE.set(query, { at: Date.now(), rows: mapped });
        return mapped;
      }
    } catch { /* try the next backend */ }
    finally { await Bun.$`rm -rf ${dir}`.quiet().nothrow(); }
  }
  return [];
}

/** One line per item, dated and attributed, so Jev can weigh recency and source. */
export const formatNews = items => items.map(n =>
  `${n.date ?? "undated"} (${n.source ?? "unknown"}): ${n.title}. ${n.body}`.slice(0, 420));

/* Search backends sometimes return whatever they feel like: a query about Brazil
 * came back as six TASS articles on Russia and Iran. Irrelevant news is worse than
 * none, because it pushes Jev's evidence score DOWN while costing tokens. Require
 * a result to share a distinctive word with the query. */
const STOP = new Set(["will","the","a","an","of","in","on","by","for","to","and","or","be",
  "is","are","win","won","wins","most","next","who","what","which","election","president",
  "presidential","champion","market","party","seats","vs","before","after","new"]);

export function relevant(items, query) {
  const keys = query.toLowerCase().split(/\W+/)
    .filter(w => w.length > 3 && !STOP.has(w));
  if (!keys.length) return items;
  return items.filter(n => {
    const hay = `${n.title} ${n.body}`.toLowerCase();
    return keys.some(k => hay.includes(k));
  });
}

export async function newsFor(event, market, opts = {}) {
  const q = queryFor(event, market);
  try {
    const raw = await searchNews(q, opts);
    const items = relevant(raw, q);
    return { query: q, items: formatNews(items), count: items.length, dropped: raw.length - items.length };
  } catch {
    return { query: q, items: [], count: 0, dropped: 0 };
  }
}
