const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');
const AdmZip = require('adm-zip');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => [
    'FatturaElettronicaBody', 'DettaglioLinee', 'DatiRiepilogo', 'DettaglioPagamento'
  ].includes(name)
});

const n = (v) => {
  if (v === undefined || v === null || v === '') return 0;
  const x = Number(String(v).replace(',', '.'));
  return Number.isFinite(x) ? x : 0;
};
const t = (v) => (v === undefined || v === null ? null : String(v).trim() || null);
const arr = (v) => (v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]));

/**
 * Estrae i dati anagrafici di una delle due parti della fattura.
 */
function leggiSoggetto(blocco, versione) {
  if (!blocco) return null;
  const a = blocco.DatiAnagrafici || {};
  const ana = a.Anagrafica || {};
  const sede = blocco.Sede || {};

  const denominazione = t(ana.Denominazione)
    || [t(ana.Nome), t(ana.Cognome)].filter(Boolean).join(' ')
    || null;

  return {
    denominazione,
    nome: t(ana.Nome),
    cognome: t(ana.Cognome),
    piva: t(a.IdFiscaleIVA && a.IdFiscaleIVA.IdCodice),
    paese: t(a.IdFiscaleIVA && a.IdFiscaleIVA.IdPaese) || 'IT',
    codice_fiscale: t(a.CodiceFiscale),
    regime_fiscale: t(a.RegimeFiscale),
    // FPA12 identifica le fatture verso la pubblica amministrazione
    tipo: String(versione || '').startsWith('FPA') ? 'pa' : 'privato',
    indirizzo: t(sede.Indirizzo),
    civico: t(sede.NumeroCivico),
    cap: t(sede.CAP),
    comune: t(sede.Comune),
    provincia: t(sede.Provincia)
  };
}

/**
 * Legge un singolo file XML FatturaPA.
 * Un file puo' contenere piu' documenti (piu' FatturaElettronicaBody).
 */
function leggiXml(contenuto, nomeFile, direzione) {
  const testo = Buffer.isBuffer(contenuto) ? contenuto.toString('utf8') : String(contenuto);
  const radice = parser.parse(testo);

  const chiave = Object.keys(radice).find((k) => k.includes('FatturaElettronica'));
  if (!chiave) throw new Error('Non sembra una fattura elettronica');
  const f = radice[chiave];

  const versione = f['@versione'] || '';
  const header = f.FatturaElettronicaHeader || {};
  const cedente = leggiSoggetto(header.CedentePrestatore, versione);
  const cessionario = leggiSoggetto(header.CessionarioCommittente, versione);

  // Nelle fatture emesse la controparte e' il cliente, in quelle ricevute il fornitore.
  const controparte = direzione === 'passiva' ? cedente : cessionario;
  const proprio = direzione === 'passiva' ? cessionario : cedente;

  const corpi = arr(f.FatturaElettronicaBody);
  const documenti = corpi.map((b, idx) => {
    const dg = (b.DatiGenerali && b.DatiGenerali.DatiGeneraliDocumento) || {};
    const contratto = (b.DatiGenerali && b.DatiGenerali.DatiContratto) || {};
    const beni = b.DatiBeniServizi || {};
    const linee = arr(beni.DettaglioLinee);
    const riepiloghi = arr(beni.DatiRiepilogo);
    const pagamenti = arr(b.DatiPagamento && b.DatiPagamento.DettaglioPagamento);

    const rit = dg.DatiRitenuta || null;
    const cassa = dg.DatiCassaPrevidenziale || null;

    const imponibile = riepiloghi.reduce((s, r) => s + n(r.ImponibileImporto), 0);
    const imposta = riepiloghi.reduce((s, r) => s + n(r.Imposta), 0);
    const tipoDoc = t(dg.TipoDocumento) || 'TD01';

    const descrizione = linee
      .map((l) => t(l.Descrizione))
      .filter(Boolean)
      .join(' · ')
      .slice(0, 500);

    const contenutoHash = crypto.createHash('sha256')
      .update(testo + '|' + idx).digest('hex');

    return {
      xml_hash: contenutoHash,
      xml_nome_file: nomeFile,
      direzione,
      versione,
      tipo_documento: tipoDoc,
      numero: t(dg.Numero) || '',
      data: t(dg.Data),
      totale_documento: Math.abs(n(dg.ImportoTotaleDocumento)) || Math.abs(imponibile + imposta),
      imponibile: Math.abs(imponibile),
      imposta: Math.abs(imposta),

      prestazione: cassa ? Math.abs(n(cassa.ImponibileCassa)) : null,
      cassa_importo: cassa ? Math.abs(n(cassa.ImportoContributoCassa)) : 0,
      cassa_aliquota: cassa ? n(cassa.AlCassa) : 0,

      ritenuta_importo: rit ? Math.abs(n(rit.ImportoRitenuta)) : 0,
      ritenuta_aliquota: rit ? n(rit.AliquotaRitenuta) : 0,

      // TD17 e' l'autofattura per acquisti esteri: IVA a debito e a credito insieme
      reverse_charge: tipoDoc === 'TD17',
      // RF19 e' il regime forfettario: nessuna IVA esposta
      fornitore_forfettario: direzione === 'passiva'
        && (cedente && cedente.regime_fiscale === 'RF19'),

      data_scadenza: pagamenti.length ? t(pagamenti[0].DataScadenzaPagamento) : null,
      importo_pagamento: pagamenti.length ? n(pagamenti[0].ImportoPagamento) : null,

      cig: t(contratto.CodiceCIG),
      codice_commessa: t(contratto.CodiceCommessaConvenzione),
      descrizione,

      riepiloghi: riepiloghi.map((r) => ({
        aliquota: n(r.AliquotaIVA),
        imponibile: Math.abs(n(r.ImponibileImporto)),
        imposta: Math.abs(n(r.Imposta)),
        natura: t(r.Natura),
        esigibilita: t(r.EsigibilitaIVA)
      })),

      controparte,
      proprio
    };
  });

  return documenti;
}

/**
 * Accetta un file .xml singolo oppure uno .zip che ne contiene molti.
 * Restituisce { documenti, errori }.
 */
function leggiArchivio(buffer, nomeFile, direzione) {
  const documenti = [];
  const errori = [];
  const nome = String(nomeFile || '').toLowerCase();

  if (nome.endsWith('.zip')) {
    let zip;
    try {
      zip = new AdmZip(buffer);
    } catch (e) {
      throw new Error('Archivio zip illeggibile');
    }
    zip.getEntries().forEach((entry) => {
      if (entry.isDirectory) return;
      const en = entry.entryName;
      if (!en.toLowerCase().endsWith('.xml')) return;
      if (en.split('/').pop().startsWith('.')) return; // scarti dei sistemi Mac
      try {
        leggiXml(entry.getData(), en.split('/').pop(), direzione)
          .forEach((d) => documenti.push(d));
      } catch (e) {
        errori.push({ file: en, errore: e.message });
      }
    });
  } else if (nome.endsWith('.xml')) {
    try {
      leggiXml(buffer, nomeFile, direzione).forEach((d) => documenti.push(d));
    } catch (e) {
      errori.push({ file: nomeFile, errore: e.message });
    }
  } else {
    throw new Error('Formato non supportato: carica un file .xml o uno .zip');
  }

  return { documenti, errori };
}

/**
 * Riduce una descrizione a una chiave stabile, per raggruppare fatture
 * ricorrenti dello stesso cliente sotto un'unica commessa: si tolgono
 * mesi, numeri, date e parole di servizio.
 */
const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio',
  'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const STOP = ['mese', 'di', 'del', 'della', 'dello', 'dei', 'delle', 'per', 'il', 'la',
  'lo', 'gli', 'le', 'e', 'ed', 'a', 'al', 'alla', 'da', 'dal', 'in', 'con', 'su',
  'anno', 'periodo', 'acconto', 'saldo', 'rata', 'fattura', 'nr', 'n'];

function chiaveDescrizione(desc) {
  return String(desc || '')
    .toLowerCase()
    .replace(/[0-9]+([.,/-][0-9]+)*/g, ' ')
    .replace(/[^a-zàèéìòùç\s]/g, ' ')
    .split(/\s+/)
    .filter((p) => p.length > 2 && !MESI.includes(p) && !STOP.includes(p))
    .slice(0, 6)
    .sort()
    .join(' ')
    .trim();
}

/**
 * Titolo leggibile proposto per una commessa nuova.
 */
function titoloProposto(desc) {
  const pulita = String(desc || '').split('·')[0].trim();
  if (!pulita) return 'Commessa senza titolo';
  const senzaMesi = pulita.replace(
    new RegExp('\\b(mese di\\s+)?(' + MESI.join('|') + ')\\b\\s*[0-9]{0,4}', 'gi'), ''
  ).replace(/\s{2,}/g, ' ').replace(/[\s\-–—,]+$/, '').trim();
  const finale = senzaMesi || pulita;
  return finale.charAt(0).toUpperCase() + finale.slice(1, 120);
}

module.exports = { leggiXml, leggiArchivio, chiaveDescrizione, titoloProposto };
