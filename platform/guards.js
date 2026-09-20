/* Invarianti sullo stato mandato a Jev.
 *
 * Nasce da un difetto trovato in un repo concorrente (marianimatteo-lexroom/poly-jev):
 * il loro build_state passa `market_yes_price` a Jev e contemporaneamente la domanda
 * dice "Ignore the current market price". Chiedono al modello di ignorare un dato che
 * gli hanno messo davanti. Se il modello ci guarda, e non c'e' modo di saperlo, il
 * numero non misura giudizio ma lettura, e tutto cio' che ci si costruisce sopra
 * e' invalidato in silenzio.
 *
 * Noi non lo passiamo. Ma "non lo passiamo" e' una proprieta' del codice di oggi,
 * non un invariante. Questo file lo rende un invariante: se un prezzo entra nello
 * stato, la chiamata fallisce prima di partire.
 */

/** Campi il cui nome tradisce un prezzo o una probabilita' di mercato. */
const PRICE_KEY = /(^|_)(price|yes_price|no_price|odds|implied|mid|bid|ask|spread|last_trade|market_prob)($|_)/i;

/** Un numero fra 0 e 1 in un campo dal nome sospetto e' quasi certamente il prezzo. */
const looksLikeProbability = v => typeof v === "number" && v > 0 && v < 1;

/**
 * Cerca ricorsivamente un prezzo di mercato dentro lo stato.
 * Ritorna la lista dei percorsi incriminati, vuota se pulito.
 */
export function findLeakedPrice(state, path = "state") {
  const hits = [];
  if (state == null) return hits;

  if (Array.isArray(state)) {
    state.forEach((v, i) => hits.push(...findLeakedPrice(v, `${path}[${i}]`)));
    return hits;
  }
  if (typeof state !== "object") return hits;

  for (const [k, v] of Object.entries(state)) {
    const here = `${path}.${k}`;
    if (PRICE_KEY.test(k)) {
      // un nome sospetto con dentro un numero da probabilita' e' una fuga
      if (looksLikeProbability(v)) hits.push(here);
      else if (typeof v === "string" && /^0?\.\d+$|^\d{1,3}\s?%$/.test(v.trim())) hits.push(here);
      else hits.push(here);   // nome sospetto: si segnala comunque, si decide a monte
    }
    if (v && typeof v === "object") hits.push(...findLeakedPrice(v, here));
  }
  return hits;
}

/**
 * Da chiamare prima di ogni richiesta a Jev.
 * Solleva se lo stato contiene il prezzo di mercato.
 */
export function assertNoPriceLeak(state) {
  const hits = findLeakedPrice(state);
  if (hits.length) {
    throw new Error(
      `Il prezzo di mercato non puo' entrare nello stato mandato a Jev. ` +
      `Campi sospetti: ${hits.join(", ")}. ` +
      `Se Jev vede il prezzo, il confronto misura se sa leggere un numero, non se sa giudicare.`);
  }
  return true;
}

/** Il budget di contesto di Jev, verificato sui docs: 64k per stato piu' domande. */
export const CONTEXT_BUDGET = 64_000;

export function assertWithinBudget(request) {
  const size = JSON.stringify(request).length;
  // stima prudente a 4 caratteri per token
  const tokens = Math.ceil(size / 4);
  if (tokens > CONTEXT_BUDGET) {
    throw new Error(`Richiesta di circa ${tokens} token, oltre il budget di ${CONTEXT_BUDGET}.`);
  }
  return { chars: size, approxTokens: tokens };
}

/** Controllo unico prima di spedire. */
export function assertSafeRequest(request) {
  assertNoPriceLeak(request.state);
  return assertWithinBudget(request);
}
