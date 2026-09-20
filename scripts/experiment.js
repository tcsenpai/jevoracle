#!/usr/bin/env bun
/* A/B the state we send Jev.
 *
 *   bun run scripts/experiment.js <slug...> [--variants a,b,c]
 *
 * Same markets, same questions, different context. The number that matters is not
 * the probability but `evidence_sufficient`: if adding reporting does not raise it,
 * the reporting was not worth fetching.
 */
import { fetchEvent, pickMarket, toJevRequest } from "./polymarket.js";
import { newsFor } from "../engine/news.js";

const argv = process.argv.slice(2);
const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
const slugs = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--variants");
if (!slugs.length) { console.error("usage: bun run scripts/experiment.js <slug...> [--variants rules,notes,news,full]"); process.exit(1); }

const envText = await Bun.file(".env").text().catch(() => "");
const KEY = process.env.TYPESAFE_API_KEY ?? envText.match(/^TYPESAFE_API_KEY=(.+)$/m)?.[1]?.trim();
if (!KEY) { console.error("TYPESAFE_API_KEY not set"); process.exit(1); }

const VARIANTS = (opt("variants") ?? "rules,notes,news,full").split(",");
const strip = (req, keep) => {
  const s = { ...req.state };
  if (!keep.notes) delete s.trader_notes;
  if (!keep.news) delete s.recent_reporting;
  return { ...req, state: s };
};

async function ask(request) {
  const t0 = Date.now();
  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(request), signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 160)}`);
  const d = await res.json();
  return { a: d.answers, ms: d._ms ?? Date.now() - t0, tokens: d.usage?.input_tokens };
}

const pc = v => v == null ? "  n/a" : `${(v * 100).toFixed(0).padStart(3)}%`;
const rows = [];

for (const slug of slugs) {
  const ev = await fetchEvent(slug, { comments: 60 });
  const m = pickMarket(ev);
  if (!m) { console.log(`${slug}: no priceable market`); continue; }
  const news = await newsFor(ev, m, { max: 6 });
  const full = toJevRequest(ev, { market: m, news: news.items }).request;

  console.log(`\n\x1b[1m${ev.title}\x1b[0m  ${m.label}`);
  console.log(`crowd ${pc(m.yes)} · ${ev.notes.length} notes kept of ${ev.commentCount} · ${news.count} news items`);
  console.log(`\n  variant   tokens   jev   evidence   gap vs crowd`);

  for (const v of VARIANTS) {
    const keep = { notes: v === "notes" || v === "full", news: v === "news" || v === "full" };
    const req = strip(full, keep);
    try {
      const { a, tokens } = await ask(req);
      const p = a.verdict.noul, e = a.evidence_sufficient?.noul;
      rows.push({ slug, variant: v, p, e, tokens, crowd: m.yes });
      console.log(`  ${v.padEnd(9)}${String(tokens ?? "?").padStart(6)}  ${pc(p)}   ${pc(e)}      ${
        ((p - m.yes) * 100 >= 0 ? "+" : "") + ((p - m.yes) * 100).toFixed(1)}pt`);
    } catch (err) { console.log(`  ${v.padEnd(9)} error: ${err.message}`); }
  }
}

if (rows.length > 1) {
  console.log(`\n\x1b[1mAcross ${slugs.length} market(s)\x1b[0m`);
  const mean = (f, v) => {
    const xs = rows.filter(r => r.variant === v).map(f).filter(x => x != null);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  console.log(`  variant   mean evidence   mean |gap|   mean tokens`);
  for (const v of VARIANTS) {
    const e = mean(r => r.e, v), g = mean(r => Math.abs(r.p - r.crowd), v), t = mean(r => r.tokens, v);
    if (e == null) continue;
    console.log(`  ${v.padEnd(9)}${pc(e).padStart(13)}${(g * 100).toFixed(1).padStart(12)}pt${String(Math.round(t)).padStart(13)}`);
  }
  console.log(`\n  If evidence does not rise with more context, the extra context is noise.`);
}
