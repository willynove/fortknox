const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('[db] DATABASE_URL non impostata. Aggiungila alle variabili del servizio su Railway.');
}

// La rete interna di Railway non usa SSL; gli URL pubblici si'.
const isInternal = /railway\.internal/.test(connectionString || '');

const pool = new Pool({
  connectionString,
  ssl: isInternal ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on('error', (err) => {
  console.error('[db] errore sul client inattivo:', err.message);
});

async function query(text, params) {
  return pool.query(text, params);
}

// Attende che il database sia raggiungibile: al primo deploy
// il servizio Postgres puo' non essere ancora pronto.
async function waitForDatabase(tentativi = 10) {
  for (let i = 1; i <= tentativi; i++) {
    try {
      await pool.query('SELECT 1');
      return true;
    } catch (err) {
      console.log(`[db] database non pronto (tentativo ${i}/${tentativi}): ${err.message}`);
      if (i === tentativi) throw err;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// Esegue schema.sql. E' idempotente (CREATE TABLE IF NOT EXISTS +
// ON CONFLICT DO NOTHING) quindi puo' girare a ogni avvio.
async function applySchema() {
  const file = path.join(__dirname, 'schema.sql');
  if (!fs.existsSync(file)) {
    throw new Error('schema.sql non trovato nella root del progetto');
  }
  const sql = fs.readFileSync(file, 'utf8');
  await pool.query(sql);
  console.log('[db] schema applicato');
}

// Tabella delle sessioni usata da connect-pg-simple.
async function createSessionTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      sid    VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
      sess   JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_session_expire ON user_sessions (expire)');
}

// Crea l'utente admin al primo avvio, se non esiste gia'.
async function ensureAdmin() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';

  if (!email || !password) {
    console.warn('[db] ADMIN_EMAIL o ADMIN_PASSWORD mancanti: nessun utente creato');
    return;
  }

  const esistente = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (esistente.rowCount > 0) {
    console.log('[db] utente admin gia\' presente');
    return;
  }

  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    'INSERT INTO users (email, password_hash, nome, ruolo) VALUES ($1, $2, $3, $4)',
    [email, hash, 'Amministratore', 'admin']
  );
  console.log(`[db] utente admin creato: ${email}`);
}

async function init() {
  await waitForDatabase();
  await applySchema();
  await createSessionTable();
  await ensureAdmin();
  console.log('[db] inizializzazione completata');
}

module.exports = { pool, query, init };
