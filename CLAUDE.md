# Fort Knox

Gestionale commesse per libero professionista della comunicazione (William Novelli, P.IVA 01223440072, regime ordinario RF01 con cassa 4% e ritenuta d'acconto).

**Repo:** `willynove/fortknox` · **Deploy:** Railway, push su `main` → deploy automatico · **URL:** fortknox.up.railway.app
**Versione corrente:** 1.3 — Bronson

---

## Perché esiste

Non è un archivio fatture: per quello basta Aruba. Serve a rispondere a quattro domande:

1. **Questa commessa è andata bene?** → compenso orario finale, non margine assoluto. Una commessa da 8.000 € con 120 ore vale meno di una da 2.000 € con 15.
2. **Dove spendo troppo?** → incidenza costi per settore (tag), per fornitore, per tipologia.
3. **Vale la pena tenere questo cliente?** → €/h medio, giorni medi di incasso, incidenza costi, andamento negli anni.
4. **Quanto pagherò di tasse?** → accantonamento progressivo e IVA trimestrale, accostati a quanto si è davvero incassato.

Ogni scelta di interfaccia va misurata su queste quattro domande. Se una schermata non aiuta a risponderne almeno una, non serve.

---

## Stack e deploy

Node 20+ · Express 4 · PostgreSQL · frontend vanilla in un unico file, nessun framework, nessun build step.

```
package.json      dipendenze (8) + start script
railway.json      forza NIXPACKS — senza questo Railway serve public/ con Caddy e le API non rispondono
schema.sql        19 tabelle, eseguito a ogni avvio
db.js             pool Postgres, attesa del DB, applicazione schema, creazione admin
xmlParser.js      parser FatturaPA (XML singoli o zip)
server.js         64 endpoint, ~2.480 righe
public/index.html frontend completo, ~3.000 righe
```

**Dipendenze:** `express`, `express-session`, `connect-pg-simple`, `pg`, `bcryptjs`, `multer`, `fast-xml-parser`, `adm-zip`.

**Variabili d'ambiente su Railway:** `DATABASE_URL` (riferimento interno `${{Postgres.DATABASE_URL}}`, non l'URL pubblico), `SESSION_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `NODE_ENV=production`, `ANTHROPIC_API_KEY` (per la chat), opzionale `CHAT_MODEL`.

**Porta:** assegnata da Railway via `PORT`. Il dominio pubblico va puntato su quella porta, non su 3000.

### Migrazioni

`schema.sql` gira a ogni avvio ed è interamente idempotente (`CREATE TABLE IF NOT EXISTS`, `ON CONFLICT DO NOTHING`). **Aggiungere una colonna a una tabella esistente richiede sia il `CREATE TABLE` aggiornato sia un `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`**: il `CREATE` non fa nulla su una tabella che esiste già, quindi senza `ALTER` la colonna non compare in produzione. Al boot i log devono mostrare `[db] schema applicato`.

---

## Modello dati

19 tabelle. Le centrali:

**`documenti`** — fatture attive e passive nella stessa tabella, distinte da `direzione` (`attiva`/`passiva`). Campi chiave: `segno` (colonna generata: `-1` se `tipo_documento = 'TD04'`, altrimenti `1`), `imponibile`, `imposta`, `prestazione` (numeric 12,**3**), `cassa_importo`, `ritenuta_importo`, `reverse_charge`, `fornitore_forfettario`, `costo_generale`, `incarico_id` (nullable), `data_incasso` (null = non incassata), `xml_hash` (unique), `origine` (`manuale`/`import`). Vincolo `UNIQUE (direzione, soggetto_id, numero, data)`.

**`soggetti`** — clienti e fornitori insieme, con `is_cliente` / `is_fornitore` (uno può essere entrambi). `sostituto_imposta` decide se le fatture a quel cliente nascono con ritenuta.

**`incarichi`** — commesse. `ore_previste`, `costi_previsti`, `importo_previsto`, `ricorrente`, stato (`in_corso`/`concluso`/`sospeso`/`annullato`). Tipologie multiple via `incarico_tipologie`, **senza tipologia principale** (scelta esplicita: nelle viste per tipologia i totali si sovrappongono e va dichiarato).

**`interventi`** — ore lavorate: data, oggetto (testo libero con autocompletamento), ore decimali. Il totale ore di una commessa è sempre una somma, mai un campo da aggiornare.

**`costi_extra`** — spese non deducibili e senza fattura (ricariche, acquisti minori, pagamenti in nero). Tabella separata **apposta** perché non possano finire nelle query dei documenti. `incarico_id` nullable.

**`commesse_future`** — importi previsti non ancora fatturati. Fuori da ogni calcolo fiscale o di margine.

Altre: `impostazioni` (aliquote storicizzate per anno), `tipologie`, `tags`, `documento_tags`, `documento_riepiloghi` (una riga per aliquota IVA, gestisce le fatture ad aliquote miste), `documento_ripartizioni` (quota % di un costo su una commessa), `preventivi` + `preventivo_tipologie` (**non usate**: il preventivatore è una calcolatrice che non salva), `chat_conversazioni`, `chat_messaggi`, `import_log`, `users`.

---

## Regole fiscali — la parte che non si può sbagliare

Tutta la matematica dei documenti vive in **una sola funzione**, `calcolaDocumento()` in `server.js`. Creazione, modifica e ricalcolo passano da lì. Non duplicarla.

### Catena di calcolo, fattura attiva

L'utente inserisce il **totale lordo** (o l'imponibile, con spunta "IVA inclusa"). Tutto il resto si ricava a ritroso:

```
imponibile  = totale / 1,22              (se iva_inclusa)
prestazione = imponibile / 1,04          (3 decimali)
cassa       = imponibile − prestazione
IVA         = imponibile × 0,22
totale      = imponibile + IVA
ritenuta    = imponibile × 0,20          (se il cliente è sostituto d'imposta)
bonifico    = totale − ritenuta
```

La rivalsa cassa 4% **non si aggiunge sopra**: è compresa nell'imponibile, quindi la prestazione si ottiene dividendo. L'utente assorbe la cassa, non la carica al cliente: se preventiva 100 €, fattura 100 € di imponibile.

Verifica di riferimento (FPA 3/26, Comune di Aosta): totale 2.000 → imponibile 1.639,35 → prestazione 1.576,295 → cassa 63,05 → ritenuta 327,87 → bonifico **1.672,13**, identico all'`ImportoPagamento` scritto nell'XML. `prestazione` ha tre decimali proprio perché con due la catena non riquadra.

### Le cinque regole che si sbagliano sempre

1. **La ritenuta non è una tassa**: è anticipo IRPEF, già compreso nella stima del 42%. Sposta *quando* si incassa, non *quanto* si guadagna. **Non va mai sottratta dal margine.** Si scala invece dall'accantonamento imposte.
2. **Il 42% si applica al margine, non ai ricavi.** Applicarlo al fatturato fa risultare in perdita le commesse con molti costi esterni.
3. **Reverse charge (TD17)**: l'IVA è autofatturata, va a debito *e* a credito, effetto netto zero. Va esclusa dall'IVA a credito, altrimenti il saldo trimestrale sbaglia (sui dati 2026 di circa 400 €).
4. **Fornitore forfettario (RF19, natura N2.2)**: nessuna IVA esposta, il costo è l'importo pieno. Si riconosce dal `RegimeFiscale` nell'XML, non va inserito a mano.
5. **Note di credito (TD04)**: importi salvati **positivi**, il segno arriva dalla colonna generata `segno`. Nelle query si moltiplica per `segno`. Salvarle negative sporca tutti gli aggregati.

Altro: IVA **per competenza** (data di emissione, non di incasso); i versamenti trimestrali dei primi tre periodi scontano l'1% di interessi, il quarto no; la ritenuta si applica su prestazione + rivalsa, cioè sull'imponibile pieno.

---

## Gerarchia dei margini

Due monti si ripartiscono sulle commesse in proporzione ai ricavi dell'anno, ma **in due punti diversi** della catena, perché hanno natura fiscale opposta:

```
ricavi
− costi diretti                 (fatture passive legate alla commessa)
− quota costi generali          ← deducibili, PRIMA delle tasse
= margine lordo
− imposte stimate (42%)
= margine netto
− costi extra diretti           ← non deducibili, DOPO le tasse
− quota costi extra
= margine finale
```

Un costo deducibile da 100 € ne costa davvero 58; uno non deducibile 100 pieni. Sommarli allo stesso livello falsa il risultato di un quinto.

**`contestoAnno(anno)`** calcola i due monti e il totale ricavi dell'anno. **Tutte** le viste che ripartiscono devono usarla: elenco commesse, dettaglio commessa, scheda cliente, snapshot chat.

> **Bug già corretto, da non reintrodurre.** L'elenco commesse calcolava il denominatore sommando le righe mostrate. Con un filtro cliente attivo il totale ricavi diventava quello del singolo cliente, e la commessa si prendeva il 100% dei costi generali invece dello 0,4% (margine −7.268 € invece di +173 €). **Il denominatore viene sempre dal database, mai dalle righe filtrate.**

I costi extra attribuiti a una commessa escono dal monte da ripartire, altrimenti quella commessa li pagherebbe due volte. Di un costo ripartito parzialmente (30% su una commessa), il 70% residuo rientra nel monte generale.

### I quattro compensi orari

`€/h fatturato` (ricavi / ore) serve a confrontarsi col mercato. `€/h lordo` e `€/h netto` sono passaggi intermedi. **`€/h finale`** è il numero da guardare: è quello che resta davvero, ed è il valore mostrato in evidenza nelle schede e usato per ordinare le classifiche.

---

## API

64 endpoint, tutti sotto `/api`, tutti protetti da sessione tranne `/login`, `/logout`, `/me`, `/health`.

| Area | Endpoint principali |
|---|---|
| Auth | `POST /login` `/logout` · `GET /me` (restituisce anche `versione`) · `POST /password` |
| Anagrafica | `GET/POST /soggetti` · `GET/PUT/DELETE /soggetti/:id` |
| Commesse | `GET/POST /incarichi` · `GET/PUT/DELETE /incarichi/:id` · `POST /incarichi/massivo` |
| Interventi | `POST/PUT/DELETE /interventi[/:id]` · `GET /interventi/oggetti` (autocompletamento) |
| Documenti | `GET/POST /documenti` · `GET/PUT/DELETE /documenti/:id` · `POST /documenti/:id/incasso` · `POST /documenti/massivo` |
| Costi extra | `GET/POST /costi-extra` · `PUT/DELETE /costi-extra/:id` · `POST /costi-extra/:id/duplica` · `POST /costi-extra/massivo` · `GET /costi-extra/categorie` |
| Future | `GET/POST /future` · `PUT/DELETE /future/:id` · `POST /future/:id/duplica` |
| Analisi | `GET /riepilogo` · `GET /costi` · `GET /clienti` · `GET /clienti/:id` · `GET /fisco` |
| Import | `POST /import/anteprima` · `POST /import/conferma` · `GET /import/storico` |
| Chat | `POST /chat` · `GET /chat/snapshot` · `GET/DELETE /chat/conversazioni[/:id]` |
| Config | `GET/PUT /impostazioni` · `GET/POST/PUT/DELETE /tipologie` · `/tags` |

**Convenzioni:** le rotte `/massivo` precedono quelle `/:id` (segmento letterale, nessuna collisione ma l'ordine resta esplicito). Le azioni di massa girano in transazione. Nei payload, `incarico_id` **assente** significa "non toccare", **stringa vuota** significa "scollega". Tutti gli errori passano da `wrap()`, che risponde `{ error: messaggio }`.

---

## Import FatturaPA

`xmlParser.js` legge XML singoli o zip, attive e passive. Testato su 178 documenti reali (54 attive, 124 passive), zero errori.

Il flusso è in due fasi: **anteprima** (non scrive nulla, restituisce soggetti, commesse proposte e documenti) → **conferma** (scrive tutto in una transazione). L'utente può correggere titoli, destinazione e tag prima di confermare.

**Cosa deduce da solo:** soggetti completi di anagrafica e indirizzo; `tipo` PA/privato dal formato FPA12/FPR12; `sostituto_imposta = false` per i clienti che emettono solo fatture senza ritenuta; `fornitore_forfettario` dal regime RF19; `reverse_charge` dal TD17; note di credito dal TD04.

**Importi presi dall'XML, non ricalcolati.** Le formule servono solo all'inserimento manuale.

**Raggruppamento in commesse:** chiave = P.IVA + descrizione normalizzata (si tolgono mesi, numeri, date, parole di servizio). Sui dati reali 54 fatture → 35 commesse proposte, con le 8 mensilità dell'Ordine degli Psicologi correttamente in una sola.

**Duplicati:** doppio controllo, hash del contenuto XML e combinazione numero+data+P.IVA (quest'ultimo intercetta anche le fatture inserite a mano). Più il vincolo unique come rete finale. Si può ricaricare lo zip completo dell'anno ogni volta: entrano solo le nuove.

---

## Frontend

File unico, nessun framework. Stato globale in `S`, routing con `S.vista`, dodici viste: riepilogo, commesse, fatture, costi, extra, future, preventivo, fisco, chat, importa, anagrafica, impostazioni.

**Design:** Manrope, accento `#A7F175` con variante scura `#3F6B15` per i testi (il verde chiaro su bianco non si legge). Riquadri bianchi, bordi sottili, riquadro scuro `#1B2430` per il dato principale di ogni schermata.

**Componenti riutilizzabili da usare, non riscrivere:**
- `comboHTML(id, voci, sel, segnaposto)` + `legaCombo(id, voci, vuoto)` — campo con ricerca, usato per commesse, clienti e fornitori. I menu a tendina lunghi sono stati eliminati tutti. Le voci si selezionano con `onmousedown`, non `onclick`: con `onclick` il campo perde il focus prima che il click registri.
- `attivaSelezione(m, cfg)` — selezione multipla con barra fissa in basso. Usata in fatture, commesse ed extra; cambiano solo i comandi al centro.
- `esportaCsv(nome, intestazioni, righe)` — separatore `;`, virgola decimale, BOM: Excel italiano apre senza chiedere nulla.
- `modal(titolo, corpo, azioni)`, `toast(msg, err)`, `intestazioneStampa(titolo)`.

**Stampa:** CSS `@media print` nasconde menu, pulsanti e filtri, converte il riquadro scuro in bianco e nero, ripete le intestazioni di tabella. La classe `.riservato` + `body.per-cliente` produce la versione da mandare al cliente, senza margini, costi e compensi orari.

**Dettaglio da ricordare:** nelle tabelle con caselle di selezione, il gestore di click sulla riga deve avere la guardia `if(ev.target.closest('.sel')) return;` — altrimenti spuntare apre anche il dettaglio.

---

## Protocollo di lavoro

Collaudato su un centinaio di iterazioni, da mantenere.

**Un file alla volta.** Si consegna un file completo, si aspetta conferma del caricamento, si passa al successivo. Mai due file insieme senza conferma in mezzo.

**Validazione prima della consegna.** Ogni file passa da controlli automatici, non solo dalla lettura:
- `node --check` su ogni JS, incluso lo script estratto dall'HTML
- bilanciamento graffe CSS
- id referenziati con `$('#x')` ma mai definiti
- funzioni richiamate da `onclick` inline ma non dichiarate
- voci di menu senza vista corrispondente nel router
- **copertura dipendenze**: ogni `require` non-core deve stare in `package.json` (un `express-session` mancante ha causato undici riavvii falliti)
- escape sospetti (`\\'` dentro template string — un apostrofo in "sostituto d'imposta" ha rotto il file una volta)

**Le modifiche per corrispondenza esatta falliscono in silenzio.** Una sostituzione che non trova il testo non dà errore: va verificato che abbia davvero agito. È successo con la guardia sulle caselle di selezione, applicata a una tabella e non all'altra per uno spazio di differenza.

**Verifica numerica, non solo sintattica.** Dove c'è matematica si simula il calcolo e si confronta con un valore noto. La catena di calcolo è stata verificata contro l'`ImportoPagamento` degli XML reali; la ripartizione dei costi contro la somma delle quote.

**Versioning:** numero + nome in codice, attori di film d'azione in ordine alfabetico di cognome. Dopo Bronson: Chan, Diesel, Eastwood, Ford, Gibson, Hamilton, Johnson, Lee. La costante `VERSIONE` sta in `server.js` ed è l'unico punto di verità; il frontend la legge da `GET /me`.

---

## Stato e cose aperte

**Fatto:** tutte e sei le fasi previste, più le aggiunte successive. CRUD completo, import XML, scheda commessa con interventi e margini, pagina costi, costi extra, scheda cliente, fisco con IVA trimestrale, preventivatore, commesse future, chat, stampa e PDF, export CSV, selezione multipla su tre schermate.

**Il problema principale non è codice.** L'import ha attribuito molti costi generali a commesse singole: Meta, Flyeralarm, Pixartprinting e simili sono finiti sulle commesse invece che tra le spese di struttura. Finché non è sistemato, i margini per commessa e i €/h restano falsati — alcune commesse risultano in forte perdita solo per questo. Gli strumenti ci sono (filtro "Da classificare", pulsante "Segna generali", selezione multipla); serve la passata di pulizia.

**Idee non implementate, in ordine di utilità:**
- Grafico andamento ricavi e margini nel tempo (oggi c'è solo il mensile di riepilogo e costi)
- Detraibilità IVA parziale sui costi — oggi è 100% fisso, ma auto e telefonia per legge detraggono al 40-50%: su circa 1.900 € di carburante e noleggio il credito reale è più basso di quello mostrato
- Alert sul monte ore prima dello sforamento (oggi c'è solo l'indicatore passivo in lista)
- Beni pluriennali: oggi un acquisto da 2.540 € pesa tutto sull'anno, deprimendo il margine di quell'anno e gonfiando i successivi
- Scadenzario incassi — **esplicitamente scartato**, non serve

**Dati di riferimento 2026** (per verificare che i calcoli non derivino): ricavi 86.964 €, costi 19.282 €, margine lordo 67.683 €, IVA a debito 19.132 €, a credito 3.491 €, ritenute subite 17.206 €.

---

## Convenzioni di scrittura

Codice, commenti, interfaccia e messaggi d'errore sono **in italiano**. I commenti spiegano il perché di una scelta non ovvia, non cosa fa la riga sotto.

I testi dell'interfaccia dicono cosa succede davvero: non "sei sicuro?" ma "Eliminare 12 fatture per 3.400 € di imponibile? Spariscono da ricavi, costi, saldo IVA e margini." Dove un numero può sembrare sbagliato, una riga sotto spiega da dove viene — è il caso della quota costi generali nella scheda commessa, che cambia ogni volta che si aggiunge una spesa.
