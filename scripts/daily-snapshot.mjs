#!/usr/bin/env node
/* ============================================================
   TGVmax Radar — snapshot quotidien des disponibilités
   ------------------------------------------------------------
   Exécuté chaque nuit par GitHub Actions (.github/workflows/daily-snapshot.yml)
   ou manuellement : `node scripts/daily-snapshot.mjs`

   Pour CHAQUE date de voyage de la fenêtre de réservation (~31 jours),
   relève le dataset open data SNCF « tgvmax » (od_happy_card = OUI) et
   compte les trains directs réservables pour chaque tronçon listé dans
   data/watched.json. Résultat fusionné dans data/history/<tronçon>.json :
     { updated, segment: {from, to}, days: { "AAAA-MM-JJ":
       { ts, perDate: { "AAAA-MM-JJ": nb_directs, ... } } } }
   Le site (onglet Suivi) lit ces fichiers pour tracer les courbes.
   ============================================================ */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://data.sncf.com/api/records/1.0/search/';
const DATASET = 'tgvmax';
const WINDOW_DAYS = 30;    // dates de voyage couvertes (J à J+30)
const KEEP_DAYS = 180;     // historique conservé dans les fichiers du dépôt
const PAGE = 10000;

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
const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

/* ---------- API ---------- */
async function fetchJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} sur ${url.slice(0, 90)}…`);
  return r.json();
}
/** Toutes les lignes OUI d'une date de voyage (paginate au cas où > 10 000) */
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

/* ---------- Programme principal ---------- */
async function main() {
  const watchedPath = join(ROOT, 'data', 'watched.json');
  const watched = JSON.parse(readFileSync(watchedPath, 'utf8'));
  if (!Array.isArray(watched) || !watched.length) {
    console.log('data/watched.json est vide — rien à relever.');
    return;
  }
  const segs = watched
    .filter(w => w && w.from && w.to)
    .map(w => ({ from: String(w.from).trim(), to: String(w.to).trim(), fromSet: expandLabel(w.from), toSet: expandLabel(w.to) }));
  const today = todayUTC();
  const dates = Array.from({ length: WINDOW_DAYS + 1 }, (_, i) => addDaysISO(today, i));

  console.log(`Relevé du ${today} : ${segs.length} tronçon(s) × ${dates.length} dates de voyage…`);
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

  const ts = Date.now();
  const summary = [];
  for (const seg of segs) {
    const hist = loadHistory(seg.from, seg.to);
    hist.segment = { from: seg.from, to: seg.to };
    const perDate = {};
    for (const d of dates) {
      const rows = rowsByDate.get(d);
      if (!rows) continue;
      let n = 0;
      for (const f of rows) {
        if (seg.fromSet.has(norm(f.origine)) && seg.toSet.has(norm(f.destination))) n++;
      }
      perDate[d] = n;
    }
    // Le relevé du jour est canonique : on remplace l'entrée du jour
    hist.days[today] = { ts, perDate };
    pruneDays(hist.days);
    hist.updated = new Date(ts).toISOString();
    const file = join(ROOT, 'data', 'history', slugOf(seg.from, seg.to) + '.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(hist, null, 1) + '\n');
    const total = Object.values(perDate).reduce((a, b) => a + b, 0);
    summary.push(`  • ${seg.from} → ${seg.to} : ${total} trains directs sur la fenêtre (jour J : ${perDate[today]})`);
  }

  const metaFile = join(ROOT, 'data', 'history', '_meta.json');
  writeFileSync(metaFile, JSON.stringify({
    lastRun: new Date(ts).toISOString(),
    windowDays: WINDOW_DAYS,
    segments: segs.map(s => ({ from: s.from, to: s.to }))
  }, null, 1) + '\n');

  console.log('Résumé :');
  for (const l of summary) console.log(l);
  console.log('OK — data/history/ à jour.');
}

main().catch(e => { console.error('ÉCHEC :', e.message); process.exit(1); });
