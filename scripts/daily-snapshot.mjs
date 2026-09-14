#!/usr/bin/env node
/* ============================================================
   TGVmax Radar — snapshot quotidien des disponibilités
   ------------------------------------------------------------
   Exécuté par GitHub Actions (.github/workflows/daily-snapshot.yml)
   ou manuellement : `node scripts/daily-snapshot.mjs`

   Pour CHAQUE date de voyage de la fenêtre glissante (J à J+30),
   relève le dataset open data SNCF « tgvmax » (od_happy_card = OUI)
   et DÉCOUVRE automatiquement toutes les paires origine→destination
   qui ont au moins un train direct (dans les deux sens), en plus des
   tronçons déjà suivis (data/watched.json + _meta.json, libellés
   intacts). Résultat fusionné dans data/history/<tronçon>.json :
     { updated, segment: {from, to}, days: { "AAAA-MM-JJ":
       { ts, perDate: { "AAAA-MM-JJ": nb_directs, ... } } } }
   La fenêtre avance d'un jour chaque jour : le « mois suivant » est
   couvert en continu, les nouvelles liaisons sont capturées sans
   intervention. Le site (onglet Suivi) lit ces fichiers.
   ============================================================ */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { collectPairs, buildWatched } from './gen-watched.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://data.sncf.com/api/records/1.0/search/';
const DATASET = 'tgvmax';
const WINDOW_DAYS = 30;    // dates de voyage couvertes (J à J+30) — mois glissant
const KEEP_DAYS = 180;     // historique conservé dans les fichiers du dépôt
const PAGE = 10000;
const MIN_ROWS = 500;      // garde-fou : en dessous, le dataset est suspect → on n'écrit rien

/* ---------- Normalisation (alignée sur app.js) ---------- */
function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['’`´]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim().toLowerCase();
}
const CITY_GROUPS = {
  'avignon': ['avignon tgv', 'avignon centre'],
  'aix en provence': ['aix en provence tgv', 'aix en provence centre'],
  'montpellier': ['montpellier saint roch', 'montpellier sud de france'],
  'nimes': ['nimes centre', 'nimes pont du gard'],
  'macon': ['macon ville', 'macon loche tgv'],
  'tours': ['tours', 'st pierre des corps'],
  'orleans': ['les aubrais orleans', 'orleans'],
  'besancon': ['besancon franche comte tgv', 'besancon viotte'],
  'valence': ['valence tgv auvergne rhone alpes', 'valence ville'],
  'strasbourg': ['strasbourg', 'strasbourg ville']
};
/** « X (toutes gares) » / « X (intramuros) » / gare simple -> ensemble de gares normalisées */
function expandLabel(label) {
  const raw = String(label || '').trim();
  const mCity = raw.match(/\((?:toutes les gares|toutes gares)\)\s*$/i);
  if (mCity) {
    const city = norm(raw.slice(0, mCity.index).trim());
    if (CITY_GROUPS[city]) return new Set(CITY_GROUPS[city].map(norm));
    return new Set([city]);
  }
  const n = norm(raw);
  if (/\(intramuros\)\s*$/i.test(raw) && CITY_GROUPS[n]) return new Set(CITY_GROUPS[n].map(norm));
  return new Set([n]);
}
function segKeyOf(from, to) { return norm(from) + '>' + norm(to); }
function slugOf(from, to) {
  const part = s => norm(s).replace(/\s+/g, '-') || 'x';
  return part(from) + '__' + part(to);
}
const todayUTC = () => new Date().toISOString().slice(0, 10);
function addDaysISO(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/* ---------- API ---------- */
async function fetchJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} sur ${url.slice(0, 90)}…`);
  return r.json();
}
/** Toutes les lignes OUI d'une date de voyage (paginé au cas où > 10 000) */
async function fetchOuiRows(dateISO) {
  const out = [];
  let start = 0;
  for (;;) {
    const url = `${API}?dataset=${DATASET}&rows=${PAGE}&start=${start}`
      + `&select=${encodeURIComponent('date,origine,destination')}`
      + `&refine.date=${encodeURIComponent(dateISO)}`
      + `&refine.od_happy_card=OUI`;
    const j = await fetchJson(url);
    for (const rec of j.records || []) {
      const f = rec.fields || {};
      if (f.origine && f.destination) out.push(f);
    }
    start += PAGE;
    if (!j.records || j.records.length < PAGE || start >= (j.nhits || 0)) break;
  }
  return out;
}

/* ---------- Fichiers d'historique ---------- */
function loadHistory(from, to) {
  const file = join(ROOT, 'data', 'history', slugOf(from, to) + '.json');
  if (existsSync(file)) {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { /* fichier corrompu : on repart propre */ }
  }
  return { updated: null, segment: { from, to }, days: {} };
}
function pruneDays(days) {
  const min = addDaysISO(todayUTC(), -KEEP_DAYS);
  for (const d of Object.keys(days)) if (d < min) delete days[d];
}

/* ---------- Fusion des sources de tronçons (pur, testable) ---------- */
/** watched.json ∪ _meta.json — sans doublon (clé normalisée), watched prioritaire */
export function mergeExisting(watched, metaSegs) {
  const out = [];
  const seen = new Set();
  const push = (w) => {
    if (!w || !w.from || !w.to) return;
    const k = segKeyOf(w.from, w.to);
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ from: String(w.from).trim(), to: String(w.to).trim() });
  };
  for (const w of watched || []) push(w);
  for (const s of metaSegs || []) push(s);
  return out;
}

/* ---------- Programme principal ---------- */
async function main() {
  const watchedPath = join(ROOT, 'data', 'watched.json');
  const metaPath = join(ROOT, 'data', 'history', '_meta.json');
  let watched = [], metaSegs = [];
  try { const j = JSON.parse(readFileSync(watchedPath, 'utf8')); if (Array.isArray(j)) watched = j; } catch { /* absent/corrompu */ }
  try { const j = JSON.parse(readFileSync(metaPath, 'utf8')); if (Array.isArray(j && j.segments)) metaSegs = j.segments; } catch { /* absent/corrompu */ }
  const existing = mergeExisting(watched, metaSegs);

  const today = todayUTC();
  const dates = Array.from({ length: WINDOW_DAYS + 1 }, (_, i) => addDaysISO(today, i));

  console.log(`Relevé du ${today} : fenêtre glissante ${dates[0]} → ${dates[dates.length - 1]} (${dates.length} dates de voyage)…`);
  const rowsByDate = new Map();
  let failed = 0;
  for (const d of dates) {
    try {
      rowsByDate.set(d, await fetchOuiRows(d));
      process.stdout.write(`  ✓ ${d} : ${rowsByDate.get(d).length} train(s) OUI\n`);
    } catch (e) {
      failed++;
      console.warn(`  ✗ ${d} : ${e.message}`);
    }
  }
  if (failed === dates.length) throw new Error('Aucune date n\'a pu être relevée — API injoignable ?');
  if (failed) console.warn(`${failed} date(s) en échec (ignorées, réessayées demain).`);

  const totalRows = [...rowsByDate.values()].reduce((a, r) => a + (r ? r.length : 0), 0);
  if (totalRows < MIN_ROWS) throw new Error(`Dataset suspect (${totalRows} ligne(s) sur la fenêtre < ${MIN_ROWS}) — relevé annulé pour ne pas polluer l'historique.`);

  const ts = Date.now();
  const summary = [];
  /* Index par date : « o|d » (normalisés) -> nb de trains — évite de re-normaliser
     chaque ligne pour chaque tronçon (indispensable avec des milliers de tronçons). */
  const dateIndex = new Map();
  for (const d of dates) {
    const rows = rowsByDate.get(d);
    if (!rows) continue;
    const idx = new Map();
    for (const f of rows) {
      const k = norm(f.origine) + '|' + norm(f.destination);
      idx.set(k, (idx.get(k) || 0) + 1);
    }
    dateIndex.set(d, idx);
  }

  /* Découverte automatique : toutes les paires observées dans le mois glissant,
     + leur sens inverse, en UNION avec les tronçons déjà suivis (libellés intacts).
     Aucun plafond : la couverture suit le dataset, jour après jour. */
  const { pairs, rawOf } = collectPairs([...rowsByDate.values()].filter(Boolean));
  const { list, total: totalPaires } = buildWatched(pairs, rawOf, existing, { cap: Number.MAX_SAFE_INTEGER, min: 1 });
  const segs = list.map(w => ({ from: w.from, to: w.to, fromSet: expandLabel(w.from), toSet: expandLabel(w.to) }));
  const nouveaux = Math.max(0, segs.length - existing.length);

  console.log(`Découverte : ${pairs.size} paire(s) observée(s) dans la fenêtre, ${totalPaires} avec sens inverse → ${segs.length} tronçon(s) suivi(s) (+${nouveaux} nouveau(x)).`);

  for (const seg of segs) {
    const hist = loadHistory(seg.from, seg.to);
    hist.segment = { from: seg.from, to: seg.to };
    const perDate = {};
    for (const d of dates) {
      const idx = dateIndex.get(d);
      if (!idx) continue;
      let n = 0;
      for (const o of seg.fromSet) for (const dd of seg.toSet) n += idx.get(o + '|' + dd) || 0;
      perDate[d] = n;
    }
    // Le relevé du jour est canonique : on remplace l'entrée du jour
    hist.days[today] = { ts, perDate };
    pruneDays(hist.days);
    hist.updated = new Date(ts).toISOString();
    const file = join(ROOT, 'data', 'history', slugOf(seg.from, seg.to) + '.json');
    mkdirSync(dirname(file), { recursive: true });
    // JSON compact : des milliers de fichiers × 180 jours — l'indentation coûterait trop cher
    writeFileSync(file, JSON.stringify(hist) + '\n');
    const tot = Object.values(perDate).reduce((a, b) => a + b, 0);
    summary.push(`  • ${seg.from} → ${seg.to} : ${tot} trains directs sur la fenêtre (jour J : ${perDate[today]})`);
  }

  /* _meta.json compact : source de vérité des tronçons pour le site et le robot */
  writeFileSync(metaPath, JSON.stringify({
    lastRun: new Date(ts).toISOString(),
    windowDays: WINDOW_DAYS,
    discovery: true,
    segments: segs.map(s => ({ from: s.from, to: s.to }))
  }) + '\n');

  /* watched.json resynchronisé : lisible par l'humain, repris par gen-watched.mjs
     et par le bouton « Préparer watched.json » comme base existante. */
  writeFileSync(watchedPath, JSON.stringify(segs.map(s => ({ from: s.from, to: s.to })), null, 1) + '\n');

  console.log('Résumé :');
  for (const l of summary.slice(0, 12)) console.log(l);
  if (summary.length > 12) console.log(`  … et ${summary.length - 12} autre(s) tronçon(s).`);
  console.log(`OK — data/history/ à jour (${segs.length} tronçons, dont ${nouveaux} découvert(s) ce jour).`);
}

/* --- exécution directe uniquement (l'import des fonctions pures ne lance rien) --- */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch(e => { console.error('ÉCHEC :', e.message); process.exit(1); });
