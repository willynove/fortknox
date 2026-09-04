const path = require('path');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');

const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: new pgSession({ pool: db.pool, tableName: 'user_sessions' }),
  secret: process.env.SESSION_SECRET || 'cambiami-subito',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 30,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  }
}));

// ============================================================
// HELPER
// ============================================================

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const num = (v, d = 0) => (v === null || v === undefined || v === '' ? d : Number(v));

function annoDi(data) {
  if (!data) return new Date().getFullYear();
  return new Date(data).getFullYear();
}

// Aliquote dell'anno, con fallback ai valori standard.
async function aliquote(anno) {
  const def = {
    aliquota_tasse: 42,
    aliquota_ritenuta: 20,
    aliquota_cassa: 4,
    aliquota_iva: 22
  };
  const { rows } = await db.query(
    'SELECT chiave, valore FROM impostazioni WHERE anno = $1',
    [anno]
  );
  rows.forEach((r) => { def[r.chiave] = Number(r.valore); });
  return def;
}

/**
 * Catena di calcolo di un documento.
 *
 * Attiva: si parte dall'importo concordato col cliente. Se iva_inclusa
 * e' true quell'importo comprende gia' l'IVA, altrimenti e' l'imponibile.
 * La rivalsa cassa non si aggiunge sopra: e' compresa nell'imponibile,
 * quindi la prestazione si ricava dividendo.
 *
 * Passiva: l'importo e' sempre l'imponibile del fornitore.
 */
function calcolaDocumento(input, al) {
  const direzione = input.direzione === 'passiva' ? 'passiva' : 'attiva';
  const importo = num(input.importo);
  const aliqIva = num(input.iva_aliquota, al.aliquota_iva);
  const forfettario = !!input.fornitore_forfettario;
  const reverse = !!input.reverse_charge;

  if (direzione === 'passiva') {
    const imponibile = r2(importo);
    const imposta = forfettario ? 0 : r2(imponibile * aliqIva / 100);
    // Nel reverse charge l'IVA e' autofatturata: va a debito e a credito,
    // quindi il totale del documento resta l'imponibile.
    const totale = reverse ? imponibile : r2(imponibile + imposta);
    return {
      imponibile,
      imposta,
      totale_documento: totale,
      prestazione: null,
      cassa_importo: 0,
      cassa_aliquota: 0,
      ritenuta_importo: 0,
      ritenuta_aliquota: 0,
      iva_aliquota: forfettario ? 0 : aliqIva
    };
  }

  const aliqCassa = num(input.cassa_aliquota, al.aliquota_cassa);
  const aliqRit = num(input.ritenuta_aliquota, al.aliquota_ritenuta);
  const conRitenuta = input.con_ritenuta !== false;

  const imponibile = input.iva_inclusa
    ? r2(importo / (1 + aliqIva / 100))
    : r2(importo);

  const prestazione = r3(imponibile / (1 + aliqCassa / 100));
  const cassa = r2(imponibile - prestazione);
  const imposta = r2(imponibile * aliqIva / 100);
  const totale = r2(imponibile + imposta);
  const ritenuta = conRitenuta ? r2(imponibile * aliqRit / 100) : 0;

  return {
    imponibile,
    imposta,
    totale_documento: totale,
    prestazione,
    cassa_importo: cassa,
    cassa_aliquota: aliqCassa,
    ritenuta_importo: ritenuta,
    ritenuta_aliquota: conRitenuta ? aliqRit : 0,
    iva_aliquota: aliqIva
  };
}

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.status(401).json({ error: 'Non autenticato' });
}

function wrap(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error('[api]', err.message);
      res.status(500).json({ error: err.message });
    });
  };
}

// ============================================================
// AUTENTICAZIONE
// ============================================================

app.post('/api/login', wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  const { rows } = await db.query(
    'SELECT id, email, nome, password_hash, attivo FROM users WHERE email = $1',
    [email]
  );
  const u = rows[0];
  if (!u || !u.attivo) return res.status(401).json({ error: 'Credenziali non valide' });

  const ok = await bcrypt.compare(password, u.password_hash);
  if (!ok) return res.status(401).json({ error: 'Credenziali non valide' });

  req.session.userId = u.id;
  res.json({ id: u.id, email: u.email, nome: u.nome });
}));

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', wrap(async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Non autenticato' });
  const { rows } = await db.query(
    'SELECT id, email, nome FROM users WHERE id = $1',
    [req.session.userId]
  );
  if (!rows[0]) return res.status(401).json({ error: 'Non autenticato' });
  res.json(rows[0]);
}));

app.post('/api/password', requireAuth, wrap(async (req, res) => {
  const attuale = String(req.body.attuale || '');
  const nuova = String(req.body.nuova || '');
  if (nuova.length < 8) return res.status(400).json({ error: 'La nuova password deve avere almeno 8 caratteri' });

  const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.session.userId]);
  const ok = await bcrypt.compare(attuale, rows[0].password_hash);
  if (!ok) return res.status(400).json({ error: 'Password attuale errata' });

  const hash = await bcrypt.hash(nuova, 10);
  await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.session.userId]);
  res.json({ ok: true });
}));

app.use('/api', (req, res, next) => {
  const aperte = ['/login', '/logout', '/me', '/health'];
  if (aperte.includes(req.path)) return next();
  return requireAuth(req, res, next);
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ============================================================
// IMPOSTAZIONI
// ============================================================

app.get('/api/impostazioni', wrap(async (req, res) => {
  const anno = Number(req.query.anno) || new Date().getFullYear();
  res.json({ anno, ...(await aliquote(anno)) });
}));

app.put('/api/impostazioni', wrap(async (req, res) => {
  const anno = Number(req.body.anno) || new Date().getFullYear();
  const chiavi = ['aliquota_tasse', 'aliquota_ritenuta', 'aliquota_cassa', 'aliquota_iva'];
  for (const k of chiavi) {
    if (req.body[k] === undefined) continue;
    await db.query(
      `INSERT INTO impostazioni (chiave, valore, anno) VALUES ($1, $2, $3)
       ON CONFLICT (chiave, anno) DO UPDATE SET valore = EXCLUDED.valore`,
      [k, num(req.body[k]), anno]
    );
  }
  res.json({ anno, ...(await aliquote(anno)) });
}));

// ============================================================
// SOGGETTI
// ============================================================

app.get('/api/soggetti', wrap(async (req, res) => {
  const cond = [];
  const par = [];
  if (req.query.ruolo === 'cliente') cond.push('is_cliente = TRUE');
  if (req.query.ruolo === 'fornitore') cond.push('is_fornitore = TRUE');
  if (req.query.q) {
    par.push('%' + String(req.query.q).toLowerCase() + '%');
    cond.push(`(lower(denominazione) LIKE $${par.length} OR piva LIKE $${par.length})`);
  }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const { rows } = await db.query(
    `SELECT * FROM soggetti ${where} ORDER BY denominazione`, par
  );
  res.json(rows);
}));

app.get('/api/soggetti/:id', wrap(async (req, res) => {
  const { rows } = await db.query('SELECT * FROM soggetti WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Soggetto non trovato' });
  res.json(rows[0]);
}));

const CAMPI_SOGGETTO = [
  'denominazione', 'nome', 'cognome', 'piva', 'paese', 'codice_fiscale',
  'is_cliente', 'is_fornitore', 'sostituto_imposta', 'regime_fiscale', 'tipo',
  'indirizzo', 'civico', 'cap', 'comune', 'provincia',
  'codice_destinatario', 'pec', 'email', 'telefono', 'note'
];

app.post('/api/soggetti', wrap(async (req, res) => {
  const b = req.body;
  if (!b.denominazione) return res.status(400).json({ error: 'Denominazione obbligatoria' });
  const valori = CAMPI_SOGGETTO.map((c) => (b[c] === undefined ? null : b[c]));
  const ph = CAMPI_SOGGETTO.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await db.query(
    `INSERT INTO soggetti (${CAMPI_SOGGETTO.join(', ')}) VALUES (${ph}) RETURNING *`,
    valori
  );
  res.json(rows[0]);
}));

app.put('/api/soggetti/:id', wrap(async (req, res) => {
  const b = req.body;
  const set = [];
  const par = [];
  CAMPI_SOGGETTO.forEach((c) => {
    if (b[c] === undefined) return;
    par.push(b[c]);
    set.push(`${c} = $${par.length}`);
  });
  if (!set.length) return res.status(400).json({ error: 'Nessun campo da aggiornare' });
  par.push(req.params.id);
  const { rows } = await db.query(
    `UPDATE soggetti SET ${set.join(', ')}, updated_at = NOW() WHERE id = $${par.length} RETURNING *`,
    par
  );
  if (!rows[0]) return res.status(404).json({ error: 'Soggetto non trovato' });
  res.json(rows[0]);
}));

app.delete('/api/soggetti/:id', wrap(async (req, res) => {
  const uso = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM documenti WHERE soggetto_id = $1) AS documenti,
       (SELECT COUNT(*) FROM incarichi WHERE soggetto_id = $1) AS incarichi`,
    [req.params.id]
  );
  const u = uso.rows[0];
  if (Number(u.documenti) || Number(u.incarichi)) {
    return res.status(400).json({
      error: `Non eliminabile: ha ${u.documenti} documenti e ${u.incarichi} incarichi collegati`
    });
  }
  await db.query('DELETE FROM soggetti WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ============================================================
// TIPOLOGIE
// ============================================================

app.get('/api/tipologie', wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT t.*, (SELECT COUNT(*) FROM incarico_tipologie it WHERE it.tipologia_id = t.id) AS usi
     FROM tipologie t ORDER BY t.ordine, t.nome`
  );
  res.json(rows);
}));

app.post('/api/tipologie', wrap(async (req, res) => {
  const nome = String(req.body.nome || '').trim();
  if (!nome) return res.status(400).json({ error: 'Nome obbligatorio' });
  const { rows } = await db.query(
    `INSERT INTO tipologie (nome, colore, ordine) VALUES ($1, $2, $3)
     ON CONFLICT (nome) DO NOTHING RETURNING *`,
    [nome, req.body.colore || '#2C3947', num(req.body.ordine, 99)]
  );
  if (!rows[0]) return res.status(400).json({ error: 'Tipologia gia\' esistente' });
  res.json(rows[0]);
}));

app.put('/api/tipologie/:id', wrap(async (req, res) => {
  const { rows } = await db.query(
    `UPDATE tipologie SET
       nome = COALESCE($1, nome),
       colore = COALESCE($2, colore),
       ordine = COALESCE($3, ordine),
       attiva = COALESCE($4, attiva)
     WHERE id = $5 RETURNING *`,
    [req.body.nome || null, req.body.colore || null,
      req.body.ordine === undefined ? null : num(req.body.ordine),
      req.body.attiva === undefined ? null : !!req.body.attiva,
      req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Tipologia non trovata' });
  res.json(rows[0]);
}));

app.delete('/api/tipologie/:id', wrap(async (req, res) => {
  await db.query('DELETE FROM tipologie WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ============================================================
// TAG
// ============================================================

function normalizzaTag(s) {
  return String(s || '').trim().replace(/^#/, '').toLowerCase();
}

app.get('/api/tags', wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT t.*, (SELECT COUNT(*) FROM documento_tags dt WHERE dt.tag_id = t.id) AS usi
     FROM tags t ORDER BY t.nome`
  );
  res.json(rows);
}));

app.post('/api/tags', wrap(async (req, res) => {
  const nome = normalizzaTag(req.body.nome);
  if (!nome) return res.status(400).json({ error: 'Nome obbligatorio' });
  const { rows } = await db.query(
    `INSERT INTO tags (nome, colore) VALUES ($1, $2)
     ON CONFLICT (nome) DO UPDATE SET nome = EXCLUDED.nome RETURNING *`,
    [nome, req.body.colore || '#2C3947']
  );
  res.json(rows[0]);
}));

app.put('/api/tags/:id', wrap(async (req, res) => {
  const { rows } = await db.query(
    `UPDATE tags SET nome = COALESCE($1, nome), colore = COALESCE($2, colore)
     WHERE id = $3 RETURNING *`,
    [req.body.nome ? normalizzaTag(req.body.nome) : null, req.body.colore || null, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Tag non trovato' });
  res.json(rows[0]);
}));

app.delete('/api/tags/:id', wrap(async (req, res) => {
  await db.query('DELETE FROM tags WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// Associa una lista di nomi tag a un documento, creando quelli mancanti.
async function applicaTag(documentoId, nomi) {
  if (!Array.isArray(nomi)) return;
  await db.query('DELETE FROM documento_tags WHERE documento_id = $1', [documentoId]);
  for (const raw of nomi) {
    const nome = normalizzaTag(raw);
    if (!nome) continue;
    const { rows } = await db.query(
      `INSERT INTO tags (nome) VALUES ($1)
       ON CONFLICT (nome) DO UPDATE SET nome = EXCLUDED.nome RETURNING id`,
      [nome]
    );
    await db.query(
      `INSERT INTO documento_tags (documento_id, tag_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [documentoId, rows[0].id]
    );
  }
}

// ============================================================
// INCARICHI
// ============================================================

app.get('/api/incarichi', wrap(async (req, res) => {
  const cond = [];
  const par = [];
  if (req.query.soggetto_id) { par.push(req.query.soggetto_id); cond.push(`i.soggetto_id = $${par.length}`); }
  if (req.query.stato) { par.push(req.query.stato); cond.push(`i.stato = $${par.length}`); }
  if (req.query.anno) {
    par.push(Number(req.query.anno));
    cond.push(`(EXTRACT(YEAR FROM i.data_inizio) = $${par.length} OR EXTRACT(YEAR FROM i.data_fine) = $${par.length})`);
  }
  if (req.query.tipologia_id) {
    par.push(req.query.tipologia_id);
    cond.push(`EXISTS (SELECT 1 FROM incarico_tipologie it WHERE it.incarico_id = i.id AND it.tipologia_id = $${par.length})`);
  }
  if (req.query.q) {
    par.push('%' + String(req.query.q).toLowerCase() + '%');
    cond.push(`(lower(i.titolo) LIKE $${par.length} OR lower(s.denominazione) LIKE $${par.length})`);
  }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';

  const { rows } = await db.query(`
    SELECT i.*, s.denominazione AS cliente,
      COALESCE((SELECT SUM(d.imponibile * d.segno) FROM documenti d
                WHERE d.incarico_id = i.id AND d.direzione = 'attiva'), 0) AS ricavi,
      COALESCE((SELECT SUM(d.imponibile * d.segno) FROM documenti d
                WHERE d.incarico_id = i.id AND d.direzione = 'passiva'), 0) AS costi_diretti,
      COALESCE((SELECT SUM(d.imponibile * d.segno * dr.percentuale / 100)
                FROM documento_ripartizioni dr
                JOIN documenti d ON d.id = dr.documento_id
                WHERE dr.incarico_id = i.id AND d.direzione = 'passiva'), 0) AS costi_ripartiti,
      COALESCE((SELECT SUM(v.ore) FROM interventi v WHERE v.incarico_id = i.id), 0) AS ore,
      COALESCE((SELECT json_agg(json_build_object('id', t.id, 'nome', t.nome, 'colore', t.colore))
                FROM incarico_tipologie it JOIN tipologie t ON t.id = it.tipologia_id
                WHERE it.incarico_id = i.id), '[]') AS tipologie
    FROM incarichi i
    JOIN soggetti s ON s.id = i.soggetto_id
    ${where}
    ORDER BY i.data_inizio DESC NULLS LAST, i.id DESC
  `, par);

  const anno = Number(req.query.anno) || new Date().getFullYear();
  const al = await aliquote(anno);

  res.json(rows.map((r) => {
    const ricavi = Number(r.ricavi);
    const costi = Number(r.costi_diretti) + Number(r.costi_ripartiti);
    const ore = Number(r.ore);
    const lordo = r2(ricavi - costi);
    const netto = r2(lordo * (1 - al.aliquota_tasse / 100));
    return {
      ...r,
      ricavi: r2(ricavi),
      costi: r2(costi),
      margine_lordo: lordo,
      margine_netto: netto,
      ore,
      orario_lordo: ore > 0 ? r2(lordo / ore) : null,
      orario_netto: ore > 0 ? r2(netto / ore) : null,
      orario_fatturato: ore > 0 ? r2(ricavi / ore) : null
    };
  }));
}));

app.get('/api/incarichi/:id', wrap(async (req, res) => {
  const id = req.params.id;
  const inc = await db.query(
    `SELECT i.*, s.denominazione AS cliente, s.id AS cliente_id
     FROM incarichi i JOIN soggetti s ON s.id = i.soggetto_id WHERE i.id = $1`, [id]
  );
  if (!inc.rows[0]) return res.status(404).json({ error: 'Incarico non trovato' });

  const tip = await db.query(
    `SELECT t.* FROM incarico_tipologie it JOIN tipologie t ON t.id = it.tipologia_id
     WHERE it.incarico_id = $1 ORDER BY t.ordine`, [id]
  );
  const doc = await db.query(
    `SELECT d.*, s.denominazione AS controparte
     FROM documenti d JOIN soggetti s ON s.id = d.soggetto_id
     WHERE d.incarico_id = $1 ORDER BY d.data`, [id]
  );
  const rip = await db.query(
    `SELECT d.*, s.denominazione AS controparte, dr.percentuale
     FROM documento_ripartizioni dr
     JOIN documenti d ON d.id = dr.documento_id
     JOIN soggetti s ON s.id = d.soggetto_id
     WHERE dr.incarico_id = $1 ORDER BY d.data`, [id]
  );
  const int = await db.query(
    'SELECT * FROM interventi WHERE incarico_id = $1 ORDER BY data DESC, id DESC', [id]
  );

  const ricavi = doc.rows.filter((d) => d.direzione === 'attiva')
    .reduce((s, d) => s + Number(d.imponibile) * d.segno, 0);
  const costiDiretti = doc.rows.filter((d) => d.direzione === 'passiva')
    .reduce((s, d) => s + Number(d.imponibile) * d.segno, 0);
  const costiRip = rip.rows
    .reduce((s, d) => s + Number(d.imponibile) * d.segno * Number(d.percentuale) / 100, 0);

  const ore = int.rows.reduce((s, v) => s + Number(v.ore), 0);
  const al = await aliquote(annoDi(inc.rows[0].data_inizio));
  const costi = costiDiretti + costiRip;
  const lordo = r2(ricavi - costi);
  const netto = r2(lordo * (1 - al.aliquota_tasse / 100));

  res.json({
    ...inc.rows[0],
    tipologie: tip.rows,
    documenti: doc.rows,
    costi_ripartiti: rip.rows,
    interventi: int.rows,
    metriche: {
      ricavi: r2(ricavi),
      costi: r2(costi),
      costi_diretti: r2(costiDiretti),
      costi_ripartiti: r2(costiRip),
      margine_lordo: lordo,
      margine_netto: netto,
      tasse_stimate: r2(lordo - netto),
      aliquota_tasse: al.aliquota_tasse,
      ore: r2(ore),
      ore_previste: inc.rows[0].ore_previste ? Number(inc.rows[0].ore_previste) : null,
      orario_fatturato: ore > 0 ? r2(ricavi / ore) : null,
      orario_lordo: ore > 0 ? r2(lordo / ore) : null,
      orario_netto: ore > 0 ? r2(netto / ore) : null
    }
  });
}));

const CAMPI_INCARICO = [
  'soggetto_id', 'titolo', 'descrizione', 'data_inizio', 'data_fine',
  'stato', 'importo_previsto', 'costi_previsti', 'ore_previste', 'ricorrente', 'note'
];

async function applicaTipologie(incaricoId, ids) {
  if (!Array.isArray(ids)) return;
  await db.query('DELETE FROM incarico_tipologie WHERE incarico_id = $1', [incaricoId]);
  for (const t of ids) {
    await db.query(
      'INSERT INTO incarico_tipologie (incarico_id, tipologia_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [incaricoId, t]
    );
  }
}

app.post('/api/incarichi', wrap(async (req, res) => {
  const b = req.body;
  if (!b.soggetto_id || !b.titolo) {
    return res.status(400).json({ error: 'Cliente e titolo sono obbligatori' });
  }
  const valori = CAMPI_INCARICO.map((c) => (b[c] === undefined || b[c] === '' ? null : b[c]));
  const ph = CAMPI_INCARICO.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await db.query(
    `INSERT INTO incarichi (${CAMPI_INCARICO.join(', ')}) VALUES (${ph}) RETURNING *`,
    valori
  );
  await applicaTipologie(rows[0].id, b.tipologie);
  res.json(rows[0]);
}));

app.put('/api/incarichi/:id', wrap(async (req, res) => {
  const b = req.body;
  const set = [];
  const par = [];
  CAMPI_INCARICO.forEach((c) => {
    if (b[c] === undefined) return;
    par.push(b[c] === '' ? null : b[c]);
    set.push(`${c} = $${par.length}`);
  });
  if (set.length) {
    par.push(req.params.id);
    await db.query(
      `UPDATE incarichi SET ${set.join(', ')}, updated_at = NOW() WHERE id = $${par.length}`,
      par
    );
  }
  await applicaTipologie(req.params.id, b.tipologie);
  const { rows } = await db.query('SELECT * FROM incarichi WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Incarico non trovato' });
  res.json(rows[0]);
}));

app.delete('/api/incarichi/:id', wrap(async (req, res) => {
  const { rows } = await db.query(
    'SELECT COUNT(*) AS n FROM documenti WHERE incarico_id = $1', [req.params.id]
  );
  if (Number(rows[0].n)) {
    return res.status(400).json({
      error: `Non eliminabile: ha ${rows[0].n} documenti collegati. Scollegali prima.`
    });
  }
  await db.query('DELETE FROM incarichi WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ============================================================
// INTERVENTI
// ============================================================

app.get('/api/interventi/oggetti', wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT oggetto, COUNT(*) AS usi FROM interventi
     GROUP BY oggetto ORDER BY usi DESC, oggetto LIMIT 50`
  );
  res.json(rows.map((r) => r.oggetto));
}));

app.post('/api/interventi', wrap(async (req, res) => {
  const b = req.body;
  if (!b.incarico_id || !b.oggetto || !num(b.ore)) {
    return res.status(400).json({ error: 'Incarico, oggetto e ore sono obbligatori' });
  }
  const { rows } = await db.query(
    `INSERT INTO interventi (incarico_id, data, oggetto, ore, note)
     VALUES ($1, COALESCE($2, CURRENT_DATE), $3, $4, $5) RETURNING *`,
    [b.incarico_id, b.data || null, String(b.oggetto).trim(), num(b.ore), b.note || null]
  );
  res.json(rows[0]);
}));

app.put('/api/interventi/:id', wrap(async (req, res) => {
  const b = req.body;
  const { rows } = await db.query(
    `UPDATE interventi SET
       data = COALESCE($1, data),
       oggetto = COALESCE($2, oggetto),
       ore = COALESCE($3, ore),
       note = COALESCE($4, note)
     WHERE id = $5 RETURNING *`,
    [b.data || null, b.oggetto || null, b.ore === undefined ? null : num(b.ore),
      b.note === undefined ? null : b.note, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Intervento non trovato' });
  res.json(rows[0]);
}));

app.delete('/api/interventi/:id', wrap(async (req, res) => {
  await db.query('DELETE FROM interventi WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ============================================================
// DOCUMENTI
// ============================================================

app.get('/api/documenti', wrap(async (req, res) => {
  const cond = [];
  const par = [];
  if (req.query.direzione) { par.push(req.query.direzione); cond.push(`d.direzione = $${par.length}`); }
  if (req.query.soggetto_id) { par.push(req.query.soggetto_id); cond.push(`d.soggetto_id = $${par.length}`); }
  if (req.query.incarico_id) { par.push(req.query.incarico_id); cond.push(`d.incarico_id = $${par.length}`); }
  if (req.query.dal) { par.push(req.query.dal); cond.push(`d.data >= $${par.length}`); }
  if (req.query.al) { par.push(req.query.al); cond.push(`d.data <= $${par.length}`); }
  if (req.query.anno) { par.push(Number(req.query.anno)); cond.push(`EXTRACT(YEAR FROM d.data) = $${par.length}`); }
  if (req.query.incassato === 'si') cond.push('d.data_incasso IS NOT NULL');
  if (req.query.incassato === 'no') cond.push('d.data_incasso IS NULL');
  if (req.query.tag) {
    par.push(normalizzaTag(req.query.tag));
    cond.push(`EXISTS (SELECT 1 FROM documento_tags dt JOIN tags t ON t.id = dt.tag_id
                       WHERE dt.documento_id = d.id AND t.nome = $${par.length})`);
  }
  if (req.query.q) {
    par.push('%' + String(req.query.q).toLowerCase() + '%');
    cond.push(`(lower(d.descrizione) LIKE $${par.length} OR lower(s.denominazione) LIKE $${par.length} OR d.numero ILIKE $${par.length})`);
  }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';

  const { rows } = await db.query(`
    SELECT d.*, s.denominazione AS controparte, i.titolo AS incarico,
      COALESCE((SELECT json_agg(t.nome ORDER BY t.nome)
                FROM documento_tags dt JOIN tags t ON t.id = dt.tag_id
                WHERE dt.documento_id = d.id), '[]') AS tags
    FROM documenti d
    JOIN soggetti s ON s.id = d.soggetto_id
    LEFT JOIN incarichi i ON i.id = d.incarico_id
    ${where}
    ORDER BY d.data DESC, d.id DESC
  `, par);
  res.json(rows);
}));

app.get('/api/documenti/:id', wrap(async (req, res) => {
  const { rows } = await db.query(`
    SELECT d.*, s.denominazione AS controparte,
      COALESCE((SELECT json_agg(t.nome ORDER BY t.nome)
                FROM documento_tags dt JOIN tags t ON t.id = dt.tag_id
                WHERE dt.documento_id = d.id), '[]') AS tags,
      COALESCE((SELECT json_agg(json_build_object('incarico_id', dr.incarico_id, 'percentuale', dr.percentuale))
                FROM documento_ripartizioni dr WHERE dr.documento_id = d.id), '[]') AS ripartizioni
    FROM documenti d JOIN soggetti s ON s.id = d.soggetto_id WHERE d.id = $1
  `, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Documento non trovato' });
  res.json(rows[0]);
}));

async function applicaRipartizioni(documentoId, lista) {
  if (!Array.isArray(lista)) return;
  await db.query('DELETE FROM documento_ripartizioni WHERE documento_id = $1', [documentoId]);
  for (const r of lista) {
    if (!r.incarico_id || !num(r.percentuale)) continue;
    await db.query(
      `INSERT INTO documento_ripartizioni (documento_id, incarico_id, percentuale)
       VALUES ($1, $2, $3) ON CONFLICT (documento_id, incarico_id) DO UPDATE SET percentuale = EXCLUDED.percentuale`,
      [documentoId, r.incarico_id, num(r.percentuale)]
    );
  }
}

app.post('/api/documenti', wrap(async (req, res) => {
  const b = req.body;
  if (!b.soggetto_id || !b.numero || !b.data) {
    return res.status(400).json({ error: 'Controparte, numero e data sono obbligatori' });
  }
  const al = await aliquote(annoDi(b.data));
  const c = calcolaDocumento(b, al);

  const { rows } = await db.query(`
    INSERT INTO documenti (
      direzione, soggetto_id, incarico_id, tipo_documento, numero, data,
      totale_documento, imponibile, imposta, prestazione,
      cassa_importo, cassa_aliquota, ritenuta_importo, ritenuta_aliquota,
      reverse_charge, fornitore_forfettario,
      data_scadenza, data_incasso, documento_riferimento_id,
      cig, codice_commessa, descrizione, origine, note
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,'manuale',$23)
    RETURNING *`,
  [
    b.direzione === 'passiva' ? 'passiva' : 'attiva',
    b.soggetto_id, b.incarico_id || null, b.tipo_documento || 'TD01', String(b.numero), b.data,
    c.totale_documento, c.imponibile, c.imposta, c.prestazione,
    c.cassa_importo, c.cassa_aliquota, c.ritenuta_importo, c.ritenuta_aliquota,
    !!b.reverse_charge, !!b.fornitore_forfettario,
    b.data_scadenza || null, b.data_incasso || null, b.documento_riferimento_id || null,
    b.cig || null, b.codice_commessa || null, b.descrizione || null, b.note || null
  ]);

  const doc = rows[0];
  await db.query(
    `INSERT INTO documento_riepiloghi (documento_id, aliquota, imponibile, imposta, esigibilita)
     VALUES ($1, $2, $3, $4, 'I')`,
    [doc.id, c.iva_aliquota, c.imponibile, c.imposta]
  );
  await applicaTag(doc.id, b.tags);
  await applicaRipartizioni(doc.id, b.ripartizioni);

  res.json(doc);
}));

app.put('/api/documenti/:id', wrap(async (req, res) => {
  const b = req.body;
  const esistente = await db.query('SELECT * FROM documenti WHERE id = $1', [req.params.id]);
  if (!esistente.rows[0]) return res.status(404).json({ error: 'Documento non trovato' });
  const d = esistente.rows[0];

  // Se e' cambiato un valore che entra nel calcolo, si ricalcola tutta la catena.
  const ricalcola = ['importo', 'iva_inclusa', 'iva_aliquota', 'cassa_aliquota',
    'ritenuta_aliquota', 'con_ritenuta', 'reverse_charge', 'fornitore_forfettario']
    .some((k) => b[k] !== undefined);

  let c = null;
  if (ricalcola) {
    const al = await aliquote(annoDi(b.data || d.data));
    c = calcolaDocumento({
      direzione: b.direzione || d.direzione,
      importo: b.importo !== undefined ? b.importo : d.imponibile,
      iva_inclusa: !!b.iva_inclusa,
      iva_aliquota: b.iva_aliquota,
      cassa_aliquota: b.cassa_aliquota,
      ritenuta_aliquota: b.ritenuta_aliquota,
      con_ritenuta: b.con_ritenuta,
      reverse_charge: b.reverse_charge !== undefined ? b.reverse_charge : d.reverse_charge,
      fornitore_forfettario: b.fornitore_forfettario !== undefined ? b.fornitore_forfettario : d.fornitore_forfettario
    }, al);
  }

  const set = [];
  const par = [];
  const push = (col, val) => { par.push(val); set.push(`${col} = $${par.length}`); };

  ['incarico_id', 'tipo_documento', 'numero', 'data', 'data_scadenza', 'data_incasso',
    'cig', 'codice_commessa', 'descrizione', 'note', 'soggetto_id'].forEach((k) => {
    if (b[k] !== undefined) push(k, b[k] === '' ? null : b[k]);
  });
  if (b.reverse_charge !== undefined) push('reverse_charge', !!b.reverse_charge);
  if (b.fornitore_forfettario !== undefined) push('fornitore_forfettario', !!b.fornitore_forfettario);

  if (c) {
    push('totale_documento', c.totale_documento);
    push('imponibile', c.imponibile);
    push('imposta', c.imposta);
    push('prestazione', c.prestazione);
    push('cassa_importo', c.cassa_importo);
    push('cassa_aliquota', c.cassa_aliquota);
    push('ritenuta_importo', c.ritenuta_importo);
    push('ritenuta_aliquota', c.ritenuta_aliquota);
  }

  if (set.length) {
    par.push(req.params.id);
    await db.query(
      `UPDATE documenti SET ${set.join(', ')}, updated_at = NOW() WHERE id = $${par.length}`,
      par
    );
  }

  if (c) {
    await db.query('DELETE FROM documento_riepiloghi WHERE documento_id = $1', [req.params.id]);
    await db.query(
      `INSERT INTO documento_riepiloghi (documento_id, aliquota, imponibile, imposta, esigibilita)
       VALUES ($1, $2, $3, $4, 'I')`,
      [req.params.id, c.iva_aliquota, c.imponibile, c.imposta]
    );
  }
  if (b.tags !== undefined) await applicaTag(req.params.id, b.tags);
  if (b.ripartizioni !== undefined) await applicaRipartizioni(req.params.id, b.ripartizioni);

  const { rows } = await db.query('SELECT * FROM documenti WHERE id = $1', [req.params.id]);
  res.json(rows[0]);
}));

app.post('/api/documenti/:id/incasso', wrap(async (req, res) => {
  const data = req.body.data_incasso === null ? null : (req.body.data_incasso || new Date().toISOString().slice(0, 10));
  const { rows } = await db.query(
    'UPDATE documenti SET data_incasso = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
    [data, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Documento non trovato' });
  res.json(rows[0]);
}));

// Tagging massivo: serve per le spese ricorrenti (hosting, cancelleria).
app.post('/api/documenti/tag-massivo', wrap(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  const nomi = Array.isArray(req.body.tags) ? req.body.tags : [];
  if (!ids.length || !nomi.length) {
    return res.status(400).json({ error: 'Servono almeno un documento e un tag' });
  }
  const tagIds = [];
  for (const raw of nomi) {
    const nome = normalizzaTag(raw);
    if (!nome) continue;
    const { rows } = await db.query(
      `INSERT INTO tags (nome) VALUES ($1)
       ON CONFLICT (nome) DO UPDATE SET nome = EXCLUDED.nome RETURNING id`, [nome]
    );
    tagIds.push(rows[0].id);
  }
  for (const docId of ids) {
    for (const tagId of tagIds) {
      await db.query(
        'INSERT INTO documento_tags (documento_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [docId, tagId]
      );
    }
  }
  res.json({ ok: true, documenti: ids.length, tags: tagIds.length });
}));

app.delete('/api/documenti/:id', wrap(async (req, res) => {
  await db.query('DELETE FROM documenti WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ============================================================
// RIEPILOGO GENERALE
// ============================================================

app.get('/api/riepilogo', wrap(async (req, res) => {
  const anno = Number(req.query.anno) || new Date().getFullYear();
  const al = await aliquote(anno);

  const { rows } = await db.query(`
    SELECT
      COALESCE(SUM(CASE WHEN direzione = 'attiva' THEN imponibile * segno END), 0) AS ricavi,
      COALESCE(SUM(CASE WHEN direzione = 'attiva' THEN imposta * segno END), 0) AS iva_debito,
      COALESCE(SUM(CASE WHEN direzione = 'attiva' THEN ritenuta_importo * segno END), 0) AS ritenute,
      COALESCE(SUM(CASE WHEN direzione = 'passiva' THEN imponibile * segno END), 0) AS costi,
      COALESCE(SUM(CASE WHEN direzione = 'passiva' AND reverse_charge = FALSE
                        THEN imposta * segno END), 0) AS iva_credito,
      COALESCE(SUM(CASE WHEN direzione = 'attiva' AND data_incasso IS NULL
                        THEN (totale_documento - ritenuta_importo) * segno END), 0) AS da_incassare
    FROM documenti WHERE EXTRACT(YEAR FROM data) = $1
  `, [anno]);

  const d = rows[0];
  const ricavi = Number(d.ricavi);
  const costi = Number(d.costi);
  const lordo = r2(ricavi - costi);
  const tasse = r2(lordo * al.aliquota_tasse / 100);

  res.json({
    anno,
    ricavi: r2(ricavi),
    costi: r2(costi),
    margine_lordo: lordo,
    margine_netto: r2(lordo - tasse),
    tasse_stimate: tasse,
    ritenute_subite: r2(Number(d.ritenute)),
    da_accantonare: r2(tasse - Number(d.ritenute)),
    iva_debito: r2(Number(d.iva_debito)),
    iva_credito: r2(Number(d.iva_credito)),
    iva_saldo: r2(Number(d.iva_debito) - Number(d.iva_credito)),
    da_incassare: r2(Number(d.da_incassare)),
    aliquota_tasse: al.aliquota_tasse
  });
}));

// ============================================================
// STATICI E AVVIO
// ============================================================

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

db.init()
  .then(() => {
    app.listen(PORT, () => console.log(`[server] Fort Knox in ascolto sulla porta ${PORT}`));
  })
  .catch((err) => {
    console.error('[server] avvio fallito:', err.message);
    process.exit(1);
  });
