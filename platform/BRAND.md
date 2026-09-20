# JevKnows

## Nome

Il gioco di parole e' il punto: "Jev knows" e "who knows?". Un sistema il cui
segnale piu' utile e' quanto dichiara di NON sapere merita un nome ambiguo.

## Cosa e'

Una sala controllo per esperimenti di giudizio, non un bot di trading. La domanda
a cui risponde non e' "quanto ho guadagnato" ma "questo bot sa quello che dice di
sapere?".

Il fatto che l'ha generata: su un mercato F1 Jev ha sbagliato di 80 punti e
contemporaneamente ha dichiarato evidence_sufficient al 12 per cento. Sapeva di
non sapere. Quello e' il prodotto.

## Gerarchia delle pagine

| Pagina | Ruolo |
| --- | --- |
| `/` | Lista bot, stile exchange. Il centro della piattaforma. |
| `/bot/:id` | Dettaglio di un singolo bot: run, predizioni, calibrazione, config |
| `/console` | Il playground a domande tipizzate. Declassato, serve per giocare. |

## Tono

Strumento, non casino. Niente verde e rosso come approvazione, niente urgenza,
niente gamification, niente coriandoli quando un bot indovina. I numeri sono
misure, non punteggi.

Il verde su un verdetto significa "distribuzione concentrata", non "buona
notizia". Un 95 per cento su una domanda terribile resta verde.

## Regole che il brand impone al prodotto

1. Il prezzo di mercato non entra mai nello stato mandato a Jev. Altrimenti si
   misura se sa leggere un numero, non se sa giudicare.
2. L'evidence dichiarata dal modello si mostra sempre accanto al verdetto, mai
   nascosta in un pannello secondario.
3. Una predizione e' un evento immutabile. Non si riscrive la storia.
4. Se un dato manca si scrive che manca. Non si stima, non si arrotonda.
