#!/usr/bin/env node
/* ============================================================
   TGVmax Radar — génération de data/watched.json « au maximum »
   ------------------------------------------------------------
   Scanne TOUTE la fenêtre de réservation (31 jours) du dataset
   SNCF « tgvmax » (od_happy_card = OUI) et retient chaque paire
   origine→destination qui a au moins un train direct, AINSI QUE
   son sens inverse. Résultat trié par trafic décroissant, plafonné.

   Usage :
     node scripts/gen-watched.mjs [--cap=1200] [--min=1] [--dry]

   Coût : ~31 requêtes API (1 par date de voyage), comme une nuit
   de snapshot. À relancer de temps en temps (nouveaux horaires,
   nouvelles gares) — les tronçons déjà suivis sont toujours gardés.
   ============================================================ */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://data.sncf.com/api/records/1.0/search/';
const DATASET = 'tgvmax';
const WINDOW_DAYS = 30;
const PAGE = 10000;

/* ---------- args ---------- */
let CAP = 3000, MIN = 1, DRY = false, DUMP = '', FROM_DUMP = '';
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--cap=')) CAP = Math.max(1, Number(a.slice(6)) || 3000);
  else if (a.startsWith('--min=')) MIN = Math.max(1, Number(a.slice(6)) || 1);
  else if (a.startsWith('--dump=')) DUMP = a.slice(7);
  else if (a.startsWith('--from-dump=')) FROM_DUMP = a.slice(12);
  else if (a === '--dry') DRY = true;
}

/* ---------- normalisation (alignée sur app.js / daily-snapshot.mjs) ---------- */
export function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['’`´]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim().toLowerCase();
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
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
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

/* ---------- cœur pur (testable) ---------- */
/** rows -> Map « o|d » (normalisés) -> { count, from, to (labels bruts) } */
export function collectPairs(rowsByDate) {
  const pairs = new Map();
  const rawOf = new Map(); // normé -> label brut le plus fréquent
  const rawHits = new Map();
  const noteRaw = (value) => {
    const n = norm(value);
    rawHits.set(n, (rawHits.get(n) || 0) + 1);
    if (!rawOf.has(n) || rawHits.get(n) === 1) rawOf.set(n, String(value).trim());
    else if (rawOf.get(n) !== String(value).trim()) {
      // garde le libellé le plus long (souvent le plus explicite)
      if (String(value).trim().length > rawOf.get(n).length) rawOf.set(n, String(value).trim());
    }
  };
  for (const rows of rowsByDate) {
    for (const f of rows) {
      noteRaw(f.origine);
      noteRaw(f.destination);
      const k = norm(f.origine) + '|' + norm(f.destination);
      const cur = pairs.get(k);
      if (cur) cur.count++;
      else pairs.set(k, { count: 1, from: String(f.origine).trim(), to: String(f.destination).trim() });
    }
  }
  return { pairs, rawOf };
}

/** paires observées + sens inverse, sans boucles A→A, triées par poids, plafonnées */
export function buildWatched(pairs, rawOf, existing = [], { cap = CAP, min = MIN } = {}) {
  const out = [];
  const seen = new Set();
  const weight = k => {
    const [o, d] = k.split('|');
    return (pairs.get(k)?.count || 0) + (pairs.get(d + '|' + o)?.count || 0);
  };
  const keep = (fromN, toN, fromRaw, toRaw) => {
    if (fromN === toN) return;
    const key = fromN + '>' + toN;
    if (seen.has(key)) return;
    seen.add(key);
    const from = fromRaw || rawOf.get(fromN) || fromN;
    const to = toRaw || rawOf.get(toN) || toN;
    out.push({ from, to, _w: weight(fromN + '|' + toN) });
  };
  // 1) tronçons déjà suivis : toujours conservés, libellés d'origine intacts
  for (const w of existing) {
    if (w && w.from && w.to) keep(norm(w.from), norm(w.to), String(w.from).trim(), String(w.to).trim());
  }
  // 2) paires observées (≥ min) + leur sens inverse
  const keys = [...pairs.keys()].filter(k => pairs.get(k).count >= min);
  for (const k of keys) {
    const [o, d] = k.split('|');
    keep(o, d);
    keep(d, o);
  }
  out.sort((a, b) => (b._w - a._w) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const total = out.length;
  return { list: out.slice(0, cap).map(({ from, to }) => ({ from, to })), total };
}

/* ---------- programme principal ---------- */
export async function main() {
  const watchedPath = join(ROOT, 'data', 'watched.json');
  let existing = [];
  try { existing = JSON.parse(readFileSync(watchedPath, 'utf8')); } catch { /* rien */ }
  if (!Array.isArray(existing)) existing = [];

  const today = todayUTC();
  let pairs, rawOf;
  if (FROM_DUMP) {
    const saved = JSON.parse(readFileSync(FROM_DUMP, 'utf8'));
    pairs = new Map(saved.pairs);
    rawOf = new Map(saved.rawOf);
    console.log(`Scan rechargé depuis ${FROM_DUMP} (${pairs.size} paires).`);
  } else {
    const dates = Array.from({ length: WINDOW_DAYS + 1 }, (_, i) => addDaysISO(today, i));
    const rowsByDate = [];
    let failed = 0;
    console.log(`Scan de la fenêtre : ${dates.length} dates de voyage (${dates[0]} → ${dates[dates.length - 1]})…`);
    for (const d of dates) {
      try {
        const rows = await fetchOuiRows(d);
        rowsByDate.push(rows);
        process.stdout.write(`  ✓ ${d} : ${rows.length} train(s) OUI\n`);
      } catch (e) {
        failed++;
        console.warn(`  ✗ ${d} : ${e.message}`);
      }
    }
    if (!rowsByDate.length) throw new Error('Aucune date relevée — API injoignable ?');
    if (failed) console.warn(`${failed} date(s) ignorée(s).`);
    ({ pairs, rawOf } = collectPairs(rowsByDate));
    if (DUMP) {
      writeFileSync(DUMP, JSON.stringify({ pairs: [...pairs], rawOf: [...rawOf] }));
      console.log(`Scan sauvegardé : ${DUMP}`);
    }
  }
  const { list, total } = buildWatched(pairs, rawOf, existing);
  console.log(`\nPaires observées (≥${MIN} train(s)) : ${keysCount(pairs, MIN)} — avec sens inverse : ${total}`);
  console.log(`Plafond : ${CAP} → data/watched.json gardera ${list.length} tronçon(s).`);
  console.log(`Gardés d'office (déjà suivis) : ${existing.length}`);

  if (DRY) { console.log('\n[--dry] aucun fichier écrit.'); return; }
  writeFileSync(watchedPath, JSON.stringify(list, null, 1) + '\n');
  console.log(`\nOK — data/watched.json : ${list.length} tronçons (2 sens inclus).`);
}
function keysCount(pairs, min) {
  let n = 0;
  for (const v of pairs.values()) if (v.count >= min) n++;
  return n;
}

/* --- exécution directe uniquement --- */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch(e => { console.error('ÉCHEC :', e.message); process.exit(1); });
