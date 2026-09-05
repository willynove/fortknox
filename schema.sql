-- ============================================================
-- GESTIONALE COMMESSE - Schema PostgreSQL
-- Fase 1: fondamenta
-- ============================================================

-- ------------------------------------------------------------
-- UTENTI
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  nome          TEXT,
  ruolo         TEXT NOT NULL DEFAULT 'admin',
  attivo        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------
-- IMPOSTAZIONI (storicizzate per anno)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS impostazioni (
  id      SERIAL PRIMARY KEY,
  chiave  TEXT NOT NULL,
  valore  NUMERIC(10,4) NOT NULL,
  anno    INTEGER NOT NULL,
  UNIQUE (chiave, anno)
);

-- ------------------------------------------------------------
-- SOGGETTI (clienti e fornitori nella stessa tabella)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS soggetti (
  id                 SERIAL PRIMARY KEY,
  denominazione      TEXT NOT NULL,
  nome               TEXT,
  cognome            TEXT,
  piva               TEXT,
  paese              TEXT NOT NULL DEFAULT 'IT',
  codice_fiscale     TEXT,
  is_cliente         BOOLEAN NOT NULL DEFAULT FALSE,
  is_fornitore       BOOLEAN NOT NULL DEFAULT FALSE,
  -- se FALSE la fattura attiva nasce senza ritenuta d'acconto
  sostituto_imposta  BOOLEAN NOT NULL DEFAULT TRUE,
  -- RF01 ordinario, RF19 forfettario, ecc. (dal tag RegimeFiscale dell'XML)
  regime_fiscale     TEXT,
  tipo               TEXT NOT NULL DEFAULT 'privato'
                     CHECK (tipo IN ('privato','pa')),
  indirizzo          TEXT,
  civico             TEXT,
  cap                TEXT,
  comune             TEXT,
  provincia          TEXT,
  codice_destinatario TEXT,
  pec                TEXT,
  email              TEXT,
  telefono           TEXT,
  note               TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_soggetti_piva ON soggetti (piva);
CREATE INDEX IF NOT EXISTS idx_soggetti_cf   ON soggetti (codice_fiscale);
CREATE INDEX IF NOT EXISTS idx_soggetti_den  ON soggetti (lower(denominazione));

-- ------------------------------------------------------------
-- TIPOLOGIE DI INCARICO
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tipologie (
  id         SERIAL PRIMARY KEY,
  nome       TEXT NOT NULL UNIQUE,
  colore     TEXT NOT NULL DEFAULT '#2C3947',
  ordine     INTEGER NOT NULL DEFAULT 0,
  attiva     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------
-- TAG (hashtag condivisi tra documenti attivi e passivi)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tags (
  id         SERIAL PRIMARY KEY,
  nome       TEXT NOT NULL UNIQUE,
  colore     TEXT NOT NULL DEFAULT '#2C3947',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------
-- INCARICHI (commesse)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incarichi (
  id              SERIAL PRIMARY KEY,
  soggetto_id     INTEGER NOT NULL REFERENCES soggetti(id) ON DELETE RESTRICT,
  titolo          TEXT NOT NULL,
  descrizione     TEXT,
  data_inizio     DATE,
  data_fine       DATE,
  stato           TEXT NOT NULL DEFAULT 'in_corso'
                  CHECK (stato IN ('in_corso','concluso','sospeso','annullato')),
  importo_previsto NUMERIC(14,2),
  costi_previsti   NUMERIC(14,2),
  ore_previste     NUMERIC(8,2),
  ricorrente       BOOLEAN NOT NULL DEFAULT FALSE,
  note             TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_incarichi_soggetto ON incarichi (soggetto_id);
CREATE INDEX IF NOT EXISTS idx_incarichi_stato    ON incarichi (stato);

CREATE TABLE IF NOT EXISTS incarico_tipologie (
  incarico_id  INTEGER NOT NULL REFERENCES incarichi(id) ON DELETE CASCADE,
  tipologia_id INTEGER NOT NULL REFERENCES tipologie(id) ON DELETE CASCADE,
  PRIMARY KEY (incarico_id, tipologia_id)
);

-- ------------------------------------------------------------
-- DOCUMENTI (fatture attive e passive)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documenti (
  id              SERIAL PRIMARY KEY,
  direzione       TEXT NOT NULL CHECK (direzione IN ('attiva','passiva')),
  soggetto_id     INTEGER NOT NULL REFERENCES soggetti(id) ON DELETE RESTRICT,
  incarico_id     INTEGER REFERENCES incarichi(id) ON DELETE SET NULL,

  tipo_documento  TEXT NOT NULL DEFAULT 'TD01',
  numero          TEXT NOT NULL,
  data            DATE NOT NULL,

  -- segno contabile: le note di credito si salvano con importi POSITIVI
  segno           SMALLINT GENERATED ALWAYS AS
                  (CASE WHEN tipo_documento = 'TD04' THEN -1 ELSE 1 END) STORED,

  -- catena di calcolo (importi sempre positivi)
  totale_documento  NUMERIC(14,2) NOT NULL DEFAULT 0,
  imponibile        NUMERIC(14,2) NOT NULL DEFAULT 0,
  imposta           NUMERIC(14,2) NOT NULL DEFAULT 0,
  prestazione       NUMERIC(14,3),
  cassa_importo     NUMERIC(14,2) NOT NULL DEFAULT 0,
  cassa_aliquota    NUMERIC(6,2)  NOT NULL DEFAULT 0,
  ritenuta_importo  NUMERIC(14,2) NOT NULL DEFAULT 0,
  ritenuta_aliquota NUMERIC(6,2)  NOT NULL DEFAULT 0,

  -- TD17: IVA autofatturata, va a debito E a credito -> effetto netto zero
  reverse_charge      BOOLEAN NOT NULL DEFAULT FALSE,
  -- fornitore in regime forfettario: nessuna IVA, costo = importo pieno
  fornitore_forfettario BOOLEAN NOT NULL DEFAULT FALSE,

  data_scadenza   DATE,
  data_incasso    DATE,

  documento_riferimento_id INTEGER REFERENCES documenti(id) ON DELETE SET NULL,

  cig             TEXT,
  codice_commessa TEXT,
  descrizione     TEXT,

  origine         TEXT NOT NULL DEFAULT 'manuale'
                  CHECK (origine IN ('manuale','import')),
  xml_hash        TEXT UNIQUE,
  xml_nome_file   TEXT,

  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (direzione, soggetto_id, numero, data)
);

CREATE INDEX IF NOT EXISTS idx_doc_direzione ON documenti (direzione);
CREATE INDEX IF NOT EXISTS idx_doc_data      ON documenti (data);
CREATE INDEX IF NOT EXISTS idx_doc_soggetto  ON documenti (soggetto_id);
CREATE INDEX IF NOT EXISTS idx_doc_incarico  ON documenti (incarico_id);
CREATE INDEX IF NOT EXISTS idx_doc_incasso   ON documenti (data_incasso);

-- Riepiloghi IVA: una riga per aliquota (gestisce le fatture ad aliquote miste)
CREATE TABLE IF NOT EXISTS documento_riepiloghi (
  id           SERIAL PRIMARY KEY,
  documento_id INTEGER NOT NULL REFERENCES documenti(id) ON DELETE CASCADE,
  aliquota     NUMERIC(6,2) NOT NULL DEFAULT 0,
  imponibile   NUMERIC(14,2) NOT NULL DEFAULT 0,
  imposta      NUMERIC(14,2) NOT NULL DEFAULT 0,
  natura       TEXT,
  esigibilita  TEXT
);

CREATE INDEX IF NOT EXISTS idx_riep_documento ON documento_riepiloghi (documento_id);

-- Tag sui documenti
CREATE TABLE IF NOT EXISTS documento_tags (
  documento_id INTEGER NOT NULL REFERENCES documenti(id) ON DELETE CASCADE,
  tag_id       INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (documento_id, tag_id)
);

-- Ripartizione facoltativa di un costo su piu' commesse.
-- Se la somma delle percentuali e' < 100, il resto resta costo generale.
CREATE TABLE IF NOT EXISTS documento_ripartizioni (
  id           SERIAL PRIMARY KEY,
  documento_id INTEGER NOT NULL REFERENCES documenti(id) ON DELETE CASCADE,
  incarico_id  INTEGER NOT NULL REFERENCES incarichi(id) ON DELETE CASCADE,
  percentuale  NUMERIC(6,2) NOT NULL CHECK (percentuale > 0 AND percentuale <= 100),
  UNIQUE (documento_id, incarico_id)
);

-- ------------------------------------------------------------
-- INTERVENTI (ore lavorate)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS interventi (
  id          SERIAL PRIMARY KEY,
  incarico_id INTEGER NOT NULL REFERENCES incarichi(id) ON DELETE CASCADE,
  data        DATE NOT NULL DEFAULT CURRENT_DATE,
  oggetto     TEXT NOT NULL,
  ore         NUMERIC(6,2) NOT NULL CHECK (ore > 0),
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_interventi_incarico ON interventi (incarico_id);
CREATE INDEX IF NOT EXISTS idx_interventi_data     ON interventi (data);
CREATE INDEX IF NOT EXISTS idx_interventi_oggetto  ON interventi (lower(oggetto));

-- ------------------------------------------------------------
-- PREVENTIVI
-- Il cliente puo' essere un soggetto in anagrafica oppure solo
-- un nome libero: un preventivo si fa spesso prima di avere il cliente.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS preventivi (
  id              SERIAL PRIMARY KEY,
  soggetto_id     INTEGER REFERENCES soggetti(id) ON DELETE SET NULL,
  cliente_nome    TEXT,
  titolo          TEXT NOT NULL,
  data            DATE NOT NULL DEFAULT CURRENT_DATE,

  importo         NUMERIC(14,2) NOT NULL DEFAULT 0,
  -- TRUE se l'importo inserito comprende gia' l'IVA
  iva_inclusa     BOOLEAN NOT NULL DEFAULT FALSE,
  costi_previsti  NUMERIC(14,2) NOT NULL DEFAULT 0,
  ore_stimate     NUMERIC(8,2),

  -- aliquote congelate al momento del preventivo
  aliquota_tasse    NUMERIC(6,2) NOT NULL DEFAULT 42.00,
  aliquota_cassa    NUMERIC(6,2) NOT NULL DEFAULT 4.00,
  aliquota_iva      NUMERIC(6,2) NOT NULL DEFAULT 22.00,
  aliquota_ritenuta NUMERIC(6,2) NOT NULL DEFAULT 20.00,
  con_ritenuta      BOOLEAN NOT NULL DEFAULT TRUE,

  stato           TEXT NOT NULL DEFAULT 'bozza'
                  CHECK (stato IN ('bozza','inviato','accettato','rifiutato')),

  -- valorizzato alla conversione in commessa
  incarico_id     INTEGER REFERENCES incarichi(id) ON DELETE SET NULL,
  data_conversione DATE,

  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CHECK (soggetto_id IS NOT NULL OR cliente_nome IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_preventivi_stato    ON preventivi (stato);
CREATE INDEX IF NOT EXISTS idx_preventivi_soggetto ON preventivi (soggetto_id);
CREATE INDEX IF NOT EXISTS idx_preventivi_incarico ON preventivi (incarico_id);

CREATE TABLE IF NOT EXISTS preventivo_tipologie (
  preventivo_id INTEGER NOT NULL REFERENCES preventivi(id) ON DELETE CASCADE,
  tipologia_id  INTEGER NOT NULL REFERENCES tipologie(id) ON DELETE CASCADE,
  PRIMARY KEY (preventivo_id, tipologia_id)
);

-- ------------------------------------------------------------
-- LOG IMPORT
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS import_log (
  id           SERIAL PRIMARY KEY,
  nome_file    TEXT NOT NULL,
  direzione    TEXT CHECK (direzione IN ('attiva','passiva')),
  totale_file  INTEGER NOT NULL DEFAULT 0,
  creati       INTEGER NOT NULL DEFAULT 0,
  aggiornati   INTEGER NOT NULL DEFAULT 0,
  saltati      INTEGER NOT NULL DEFAULT 0,
  errori       JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- SEED
-- ============================================================

INSERT INTO tipologie (nome, ordine) VALUES
  ('Assistenza e manutenzione sito', 1),
  ('Social media management',        2),
  ('Sviluppo sito web',              3),
  ('Grafica e comunicazione visiva', 4),
  ('Piano editoriale e contenuti',   5),
  ('Docenza e formazione',           6),
  ('Foto e video',                   7),
  ('Sviluppo piattaforme e software',8),
  ('Consulenza IT e migrazioni',     9),
  ('Licenze e servizi di terzi',    10)
ON CONFLICT (nome) DO NOTHING;

INSERT INTO impostazioni (chiave, valore, anno) VALUES
  ('aliquota_tasse',    42.00, 2026),
  ('aliquota_ritenuta', 20.00, 2026),
  ('aliquota_cassa',     4.00, 2026),
  ('aliquota_iva',      22.00, 2026)
ON CONFLICT (chiave, anno) DO NOTHING;
