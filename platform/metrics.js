/* Metriche di un bot.
 *
 * Il problema che queste funzioni risolvono: il P&L su poche predizioni e'
 * rumore, e i mercati ci mettono settimane a risolversi. Servono numeri
 * leggibili PRIMA che i risultati arrivino, senza spacciarli per prove.
 *
 * Regola che attraversa tutto il file: se un numero non e' ancora calcolabile
 * si restituisce null, non zero. Uno zero finto in dashboard e' peggio di un
 * "non lo so".
 */
import { brier, calibration, kelly, pnl } from "../engine/scoring.js";
export { brier, calibration, kelly, pnl };

const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

/**
 * Quanto spesso il bot si e' astenuto, e se lo ha fatto quando era poco informato.
 *
 * `rule` decide quale delle due regole si sta misurando. Contare come "ha puntato"
 * qualsiasi riga con gated OR ungated rende l'astensione del gate invisibile, che
 * e' esattamente la cosa che vogliamo misurare.
 */
export function abstention(rows, rule = "gated") {
  if (!rows.length) return null;
  const took = r => rule === "ungated" ? !!r.ungated : !!r.gated;
  const bet = rows.filter(took);
  const passed = rows.filter(r => !took(r));
  return {
    rule,
    seen: rows.length,
    bet: bet.length,
    passed: passed.length,
    rate: passed.length / rows.length,
    // il punto: quando si e' astenuto, era davvero meno informato?
    evidenceWhenBet: mean(bet.map(r => r.evidence).filter(x => x != null)),
    evidenceWhenPassed: mean(passed.map(r => r.evidence).filter(x => x != null)),
  };
}

/**
 * Il segnale indipendente che lo Skeptic ha chiesto: l'evidence auto-dichiarata
 * predice davvero l'errore?
 *
 * Confronta l'errore assoluto (|jev - esito|) sulle predizioni ad alta evidence
 * contro quelle a bassa evidence. Se la differenza e' circa zero, evidence e'
 * rumore e non va usata come gate. Richiede predizioni SETTLED: prima di quelle
 * restituisce null, perche' non c'e' niente contro cui misurare.
 */
export function evidenceValidity(rows, split = 0.5) {
  const settled = rows.filter(r => r.outcome === 0 || r.outcome === 1);
  const withEv = settled.filter(r => r.evidence != null);
  if (withEv.length < 8) return { usable: false, n: withEv.length, need: 8 };

  const err = r => Math.abs(r.jev - r.outcome);
  const hi = withEv.filter(r => r.evidence >= split);
  const lo = withEv.filter(r => r.evidence < split);
  if (!hi.length || !lo.length) return { usable: false, n: withEv.length, reason: "tutte le righe da un lato della soglia" };

  const errHi = mean(hi.map(err)), errLo = mean(lo.map(err));
  return {
    usable: true, n: withEv.length, split,
    hi: { n: hi.length, meanError: errHi },
    lo: { n: lo.length, meanError: errLo },
    // positivo = l'evidence alta sbaglia meno, cioe' il segnale vale qualcosa
    separation: errLo - errHi,
  };
}

/** Jev contro la folla sugli stessi mercati. L'unica domanda che conta davvero. */
export function versusCrowd(rows) {
  const settled = rows.filter(r => r.outcome === 0 || r.outcome === 1);
  if (!settled.length) return null;
  const bJev = brier(settled.map(r => ({ p: r.jev, outcome: r.outcome })));
  const bCrowd = brier(settled.map(r => ({ p: r.crowd, outcome: r.outcome })));
  return {
    n: settled.length, brierJev: bJev, brierCrowd: bCrowd,
    // negativo = Jev batte la folla
    delta: bJev - bCrowd,
    beats: bJev < bCrowd,
  };
}

/**
 * Riepilogo di un bot, diviso in due blocchi espliciti:
 *   leading  = leggibile subito, NON e' evidenza di performance
 *   settled  = richiede mercati risolti, e' l'unica cosa che prova qualcosa
 */
export function botSummary(rows) {
  const settled = rows.filter(r => r.outcome === 0 || r.outcome === 1);
  const sum = f => rows.reduce((a, r) => a + (f(r) ?? 0), 0);

  return {
    leading: {
      predictions: rows.length,
      open: rows.length - settled.length,
      meanEvidence: mean(rows.map(r => r.evidence).filter(x => x != null)),
      meanAbsEdge: mean(rows.map(r => Math.abs(r.edge))),
      abstention: abstention(rows, "gated"),
      abstentionUngated: abstention(rows, "ungated"),
      models: [...new Set(rows.map(r => r.model).filter(Boolean))],
    },
    settled: {
      n: settled.length,
      versusCrowd: versusCrowd(rows),
      calibration: settled.length ? calibration(settled.map(r => ({ p: r.jev, outcome: r.outcome }))) : null,
      evidenceValidity: evidenceValidity(rows),
      pnlGated: settled.length ? sum(r => r.pnl_gated) : null,
      pnlUngated: settled.length ? sum(r => r.pnl_ungated) : null,
    },
    // quanto sono affidabili i numeri sopra, detto esplicitamente
    maturity: settled.length === 0 ? "nessun mercato risolto, solo indicatori anticipati"
            : settled.length < 20 ? "troppo pochi risultati per concludere qualcosa"
            : settled.length < 50 ? "indicativo, non conclusivo"
            : "sufficiente per una prima lettura",
  };
}
