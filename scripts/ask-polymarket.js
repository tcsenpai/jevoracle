#!/usr/bin/env bun
/* Compare Jev's judgment against a Polymarket crowd price.
 *
 *   bun run scripts/ask-polymarket.js <event url or slug> [--market "December 31"]
 *                                     [--no-comments] [--json] [--print]
 *
 * Jev never sees the market price. That is the whole point.
 */
import { fetchEvent, pickMarket, toJevRequest } from "./polymarket.js";

const argv = process.argv.slice(2);
const flag = n => argv.includes(`--${n}`);
const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
const target = argv.find(a => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--market");

if (!target) {
  console.error("usage: bun run scripts/ask-polymarket.js <polymarket event url or slug> [--market NAME] [--json] [--print] [--no-comments]");
  process.exit(1);
}

const envText = await Bun.file(".env").text().catch(() => "");
const KEY = process.env.TYPESAFE_API_KEY ?? envText.match(/^TYPESAFE_API_KEY=(.+)$/m)?.[1]?.trim();

const pctFmt = v => v == null ? "  n/a" : `${(v * 100).toFixed(1).padStart(5)}%`;
const bar = (v, w = 28) => {
  const n = Math.round((v ?? 0) * w);
  return "█".repeat(n) + "·".repeat(w - n);
};

const ev = await fetchEvent(target, { comments: flag("no-comments") ? 0 : 25 });
const market = pickMarket(ev, opt("market"));
const { request } = toJevRequest(ev, { market });

/* --news FILE adds your own reporting to the state. Without it Jev is judging the
   rules alone, which it will tell you (evidence_sufficient goes low). */
const newsPath = opt("news");
if (newsPath) {
  const txt = await Bun.file(newsPath).text();
  const items = txt.split(/\n\s*\n/).map(t => t.trim()).filter(Boolean);
  request.state.reporting = items;
  console.log(`\x1b[2mloaded ${items.length} reporting item(s) from ${newsPath}\x1b[0m`);
}

console.log(`\n\x1b[1m${ev.title}\x1b[0m`);
console.log(`${ev.markets.length} markets · $${Math.round(ev.volume ?? 0).toLocaleString()} volume · ${ev.commentCount ?? 0} comments · ${ev.notes.length} usable notes\n`);
console.log("  market                    crowd   7d");
for (const m of ev.markets) {
  const star = m === market ? "\x1b[36m▸\x1b[0m" : " ";
  const chg = m.weekChange == null ? "" : `${m.weekChange > 0 ? "+" : ""}${(m.weekChange * 100).toFixed(1)}pt`;
  console.log(` ${star} ${m.label.padEnd(24)}${pctFmt(m.yes)}  ${chg}`);
}

if (flag("print")) {
  console.log("\n\x1b[2m--- request sent to Jev ---\x1b[0m");
  console.log(JSON.stringify(request, null, 2));
}
if (!KEY) { console.error("\nTYPESAFE_API_KEY not set; printed the request only."); process.exit(0); }

const t0 = Date.now();
const res = await fetch("https://api.typesafe.ai/v1/systemone", {
  method: "POST",
  headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify(request),
});
const ms = Date.now() - t0;
if (!res.ok) { console.error(`\nTypeSafe error ${res.status}: ${(await res.text()).slice(0, 300)}`); process.exit(1); }
const data = await res.json();
const a = data.answers;

if (flag("json")) { console.log(JSON.stringify({ event: ev.slug, market: market.label, crowd: market.yes, answers: a }, null, 2)); process.exit(0); }

const jev = a.verdict.noul, crowd = market.yes, gap = jev - crowd;
const lvl = x => (x.legend ?? {})[Math.round(x.score)] ?? `level ${Math.round(x.score)}`;

console.log(`\n\x1b[1mJudging:\x1b[0m ${market.label}   \x1b[2m(${Object.keys(request.questions).length} judgments, one call, ${ms}ms)\x1b[0m\n`);
console.log(`  crowd  ${bar(crowd)} ${pctFmt(crowd)}`);
console.log(`  jev    ${bar(jev)} ${pctFmt(jev)}`);
const dir = gap > 0 ? "more" : "less";
console.log(`\n  Jev is \x1b[1m${Math.abs(gap * 100).toFixed(1)}pt ${dir}\x1b[0m confident than the market.`);
if (Math.abs(jev - 0.5) < 0.1) console.log("  (near 0.50: genuinely undecided, not a soft yes)");

console.log(`\n  rules narrow it   ${lvl(a.rules_are_strict)}  \x1b[2m(conf ${pctFmt(a.rules_are_strict.confidence)})\x1b[0m`);
console.log(`  dispute risk      ${a.ambiguity.choice}  \x1b[2m(conf ${pctFmt(a.ambiguity.confidence)})\x1b[0m`);
console.log(`  evidence          ${a.evidence_sufficient.noul >= 0.6 ? "sufficient in-state"
  : a.evidence_sufficient.noul <= 0.4 ? "thin, leans on outside knowledge" : "borderline"}  \x1b[2m(${pctFmt(a.evidence_sufficient.noul)})\x1b[0m`);

if (a.evidence_sufficient.noul <= 0.4)
  console.log(`\n  \x1b[33mNote:\x1b[0m Jev says the state alone is not enough to judge this. Treat the number\n  as a read of the RULES, not a forecast. Add news sources for a fair comparison.`);
console.log();
