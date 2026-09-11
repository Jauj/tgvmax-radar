'use strict';
/* ============================================================
   TGVmax Radar — outil local & gratuit inspiré du principe de Trainquille.
   Source : dataset open data SNCF « tgvmax » (od_happy_card = OUI).
   100 % client, sans compte, sans tracker, sans clé API.
   ============================================================ */

/* ---------------- CONFIG ---------------- */
const API_BASE = 'https://data.sncf.com/api/records/1.0/search/';
const DATASET = 'tgvmax';
const BOOKING_WINDOW_DAYS = 31;
const MIN_CONNECTION_MIN = 5;
const MAX_CONNECTION_MIN = 360;
/** Formulaire de recherche SNCF Connect — vérifié empiriquement :
 *  /train/search répond 404 et /home/shop/results/outward ne porte AUCUN paramètre
 *  dans l'URL (l'état de recherche vit en mémoire côté SPA) : aucun lien ne peut
 *  pré-remplir une recherche. On ouvre donc leur vrai formulaire. */
const SNCF_SEARCH_URL = 'https://www.sncf-connect.com/home/search/od';

/* ---------------- UTILS (purs, testables) ---------------- */
function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['’`´]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim().toLowerCase();
}
function parseHM(hm) {
  if (!hm || !/^\d{1,2}:\d{2}/.test(hm)) return null;
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}
function todayISO() {
  // date LOCALE (l’utilisateur raisonne en date locale, même tard le soir)
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDaysISO(iso, n) {
  // arithmétique 100 % UTC pour éviter tout décalage fuseau (bug Paris +2 corrigé)
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}
function fmtDateFR(iso) {
  return new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })
    .format(new Date(iso + 'T00:00:00'));
}
/** "08:56" -> minutes ; gère le passage de minuit (arrivée < départ => +24h) */
function arrivalMinutes(depHM, arrHM) {
  const dep = parseHM(depHM), arr = parseHM(arrHM);
  if (dep == null || arr == null) return null;
  return arr < dep ? arr + 1440 : arr;
}
/** Durée lisible : 95 -> "1h35", 45 -> "45 min" */
function fmtDur(min) {
  if (min == null || !isFinite(min)) return '?';
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${m} min`;
}

/* ---------------- TYPES DE TRAINS (champ « axe » du dataset) ---------------- */
const AXE_CATEGORIES = ['TGV INOUI', 'TGV international', 'OUIGO', 'Intercités de jour', 'Intercités de nuit', 'Autocar SNCF'];
/**
 * Catégorise une valeur « axe » du dataset tgvmax :
 *  - axes TGV : ATLANTIQUE, SUD EST, EST, NORD → TGV INOUI
 *  - INTERNATIONAL → TGV international (Lyria, Italie, Allemagne, Luxembourg…)
 *  - OUIGO_nord / OUIGO_atlantique / OUIGO_sud-est / OUIGO_est / OUIGO_TC → OUIGO
 *  - IC ARO / IC SRO → Intercités de jour
 *  - IC NUIT → Intercités de nuit
 *  - AUTOCAR SNCF → Autocar SNCF
 */
function axeCategory(axe) {
  const a = String(axe || '').toUpperCase();
  if (a.startsWith('OUIGO')) return 'OUIGO';
  if (a === 'IC NUIT') return 'Intercités de nuit';
  if (a.startsWith('IC')) return 'Intercités de jour';
  if (a === 'INTERNATIONAL') return 'TGV international';
  if (a === 'AUTOCAR SNCF') return 'Autocar SNCF';
  return 'TGV INOUI';
}

/* ---------------- VILLES multi-gares ---------------- */
/** Groupes de gares desservant la même ville (noms du dataset).
 *  Paris/Lyon/Lille sont déjà groupés par la SNCF (« X (intramuros) »). */
const CITY_GROUPS = {
  'AVIGNON': ['AVIGNON TGV', 'AVIGNON CENTRE'],
  'AIX EN PROVENCE': ['AIX EN PROVENCE TGV', 'AIX EN PROVENCE CENTRE'],
  'MONTPELLIER': ['MONTPELLIER SAINT ROCH', 'MONTPELLIER SUD DE FRANCE'],
  'NIMES': ['NIMES CENTRE', 'NIMES PONT DU GARD'],
  'MACON': ['MACON VILLE', 'MACON LOCHE TGV'],
  'TOURS': ['TOURS', 'ST PIERRE DES CORPS'],
  'ORLEANS': ['LES AUBRAIS ORLEANS', 'ORLEANS'],
  'BESANCON': ['BESANCON FRANCHE COMTE TGV', 'BESANCON VIOTTE'],
  'VALENCE': ['VALENCE TGV AUVERGNE RHONE ALPES', 'VALENCE VILLE'],
  'STRASBOURG': ['STRASBOURG', 'STRASBOURG VILLE']
};
/** Construit l'index ville → gares. Clés : norm(ville) ET norm(« X (intramuros) »).
 *  NB : la facette ne rend que le top 100 des gares ; les gares secondaires des
 *  groupes connus (AVIGNON CENTRE, MACON LOCHE TGV…) existent bien dans les
 *  enregistrements — on garde donc la liste complète du groupe. */
function buildCityIndex(stationNames) {
  const present = new Set(stationNames.map(norm));
  const idx = new Map();
  for (const [city, stations] of Object.entries(CITY_GROUPS)) {
    if (stations.some(s => present.has(norm(s)))) idx.set(norm(city), { city, stations });
  }
  for (const name of stationNames) {
    if (/\(intramuros\)/i.test(name)) {
      idx.set(norm(name), { city: name.replace(/\s*\(intramuros\)\s*/i, '').trim(), stations: [name] });
    }
  }
  return idx;
}
/** Étend un libellé saisi en ensemble de gares normalisées :
 *  « AVIGNON (toutes gares) » → {avignon tgv, avignon centre} ;
 *  « PARIS (intramuros) » → {paris intramuros} ; gare simple → {elle-même}. */
function expandStationLabel(label, cityIndex) {
  const raw = String(label || '');
  // Suffixe ville-groupé, cherché sur le libellé BRUT (les parenthèses disparaissent au norm)
  const m = raw.match(/\((?:toutes les gares|toutes gares)\)\s*$/i);
  if (m && cityIndex) {
    const cityKey = norm(raw.slice(0, m.index).trim());
    if (cityIndex.has(cityKey)) return new Set(cityIndex.get(cityKey).stations.map(norm));
  }
  const n = norm(raw);
  if (cityIndex && cityIndex.has(n)) {
    return new Set(cityIndex.get(n).stations.map(norm));
  }
  return new Set([n]);
}

/* ---------------- HISTORIQUE DES DISPONIBILITÉS (purs, testables) ----------------
   Modèle : par tronçon, un relevé par jour => { ts, perDate: { date_voyage: nb_directs } }.
   Sources fusionnées : localStorage (visites), data/history/*.json (robot GitHub Actions
   nocturne), Supabase (optionnel). */
const HIST_MAX_DAYS = 120;      // relevés conservés par tronçon
const HIST_MAX_SEGS = 32;       // tronçons conservés
const HIST_WINDOW_PERDATE = 45; // dates de voyage retenues par relevé
/** Clé stable d'un tronçon : norm(A) + '>' + norm(B) ('>' ne peut pas sortir de norm) */
function segKeyOf(from, to) { return norm(from) + '>' + norm(to); }
/** Nom de fichier dépôt : « paris-intramuros__lyon-intramuros.json » */
function slugOf(from, to) {
  const part = s => norm(s).replace(/\s+/g, '-') || 'x';
  return part(from) + '__' + part(to);
}
/** Date locale -> ISO (YYYY-MM-DD) */
function dateToISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** Écart en jours entre deux dates ISO (100 % UTC) */
function dayDiff(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}
/** Plus beau maximum d'axe Y (1/2/5 × 10^n) */
function niceMax(v) {
  v = Math.max(1, Number(v) || 1);
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}
/** Fusionne un relevé { ts, perDate } dans days[jour] : le plus récent gagne ;
 *  le plus ancien ne fait que compléter les dates de voyage absentes. */
function histMergeDay(days, day, rec) {
  if (!days || !day || !rec) return days || {};
  const cur = days[day];
  const recTs = Number(rec.ts) || 0;
  if (!cur) {
    days[day] = { ts: recTs, perDate: Object.assign({}, rec.perDate || {}) };
  } else if (recTs >= (Number(cur.ts) || 0)) {
    days[day] = { ts: Math.max(recTs, Number(cur.ts) || 0), perDate: Object.assign({}, cur.perDate, rec.perDate || {}) };
  } else {
    for (const [t, n] of Object.entries(rec.perDate || {})) if (!(t in cur.perDate)) cur.perDate[t] = n;
  }
  return days;
}
/** Dernier ts connu d'un tronçon (pour prioriser les tronçons actifs) */
function segLastTs(seg) {
  let m = 0;
  for (const r of Object.values((seg && seg.days) || {})) if ((Number(r.ts) || 0) > m) m = Number(r.ts) || 0;
  return m;
}
/** Nettoie : relevés trop vieux, dates de voyage hors fenêtre, trop de tronçons */
function histPrune(hist, todayIso) {
  if (!hist || !hist.segs) return hist;
  const minDay = addDaysISO(todayIso, -HIST_MAX_DAYS);
  const entries = Object.entries(hist.segs)
    .sort((a, b) => segLastTs(b[1]) - segLastTs(a[1]))
    .slice(0, HIST_MAX_SEGS);
  const segs = {};
  for (const [k, seg] of entries) {
    const days = {};
    for (const [d, rec] of Object.entries(seg.days || {})) {
      if (d < minDay) continue;
      const perDate = {};
      for (const [t, n] of Object.entries(rec.perDate || {})) {
        if (t >= d && dayDiff(d, t) <= HIST_WINDOW_PERDATE) perDate[t] = n;
      }
      if (Object.keys(perDate).length) days[d] = { ts: Number(rec.ts) || 0, perDate };
    }
    if (Object.keys(days).length) segs[k] = { from: seg.from || k.split('>')[0], to: seg.to || k.split('>')[1], days };
  }
  hist.segs = segs;
  return hist;
}
/** Relevés triés par jour, avec total par relevé */
function histSeries(days) {
  return Object.entries(days || {})
    .map(([day, rec]) => ({
      day,
      ts: Number(rec.ts) || 0,
      perDate: rec.perDate || {},
      total: Object.values(rec.perDate || {}).reduce((a, n) => a + (Number(n) || 0), 0)
    }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));
}
/** Classe de couleur heatmap selon le nombre de places */
function hmClass(n) {
  if (n == null || n === '') return 'hm-x';
  if (n <= 0) return 'hm-0';
  if (n <= 2) return 'hm-1';
  if (n <= 5) return 'hm-2';
  if (n <= 9) return 'hm-3';
  return 'hm-4';
}

/* ---------------- API SNCF ---------------- */
const dayCache = new Map();
async function fetchDay(dateISO) {
  if (dayCache.has(dateISO)) return dayCache.get(dateISO);
  const url = `${API_BASE}?dataset=${DATASET}&rows=10000`
    + `&select=${encodeURIComponent('origine,destination,heure_depart,heure_arrivee,axe,train_no,origine_iata,destination_iata')}`
    + `&refine.date=${encodeURIComponent(dateISO)}`
    + `&refine.od_happy_card=OUI`;
  const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!resp.ok) throw new Error('API SNCF indisponible (HTTP ' + resp.status + ')');
  const json = await resp.json();
  const trains = (json.records || [])
    .map(r => r.fields)
    .filter(f => f && f.origine && f.destination);
  dayCache.set(dateISO, trains);
  return trains;
}
/** Liste des gares (facettes) — pour l'autocomplétion */
async function fetchStationNames() {
  const url = `${API_BASE}?dataset=${DATASET}&rows=0&facet=origine&facet=destination`;
  const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
  const json = await resp.json();
  const set = new Set();
  (json.facet_groups || []).forEach(g => (g.facets || []).forEach(f => set.add(f.name)));
  return [...set].sort((a, b) => a.localeCompare(b, 'fr'));
}

/* ---------------- RECHERCHES (pures) ---------------- */
function findByOrigin(trains, fromSet) { return trains.filter(t => fromSet.has(norm(t.origine))); }
function findByDest(trains, toSet) { return trains.filter(t => toSet.has(norm(t.destination))); }

function groupBySorted(trains, keyFn) {
  const m = new Map();
  for (const t of trains) {
    const k = keyFn(t);
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(t);
  }
  return [...m.entries()]
    .map(([station, list]) => ({
      station,
      trains: list.slice().sort((a, b) => String(a.heure_depart || '').localeCompare(String(b.heure_depart || '')))
    }))
    .sort((a, b) => b.trains.length - a.trains.length || a.station.localeCompare(b.station, 'fr'));
}
/** Filtre une liste de trains sur le créneau demandé : départ ≥ depMin, arrivée ≤ arrMax.
 *  Les trains de nuit (arrivée le lendemain) sont exclus quand une heure d’arrivée max est fixée. */
function inWindow(t, depMin, arrMax) {
  const dep = String(t.heure_depart || '');
  const arr = String(t.heure_arrivee || '');
  if (depMin && dep < depMin) return false;
  if (arrMax) {
    if (!arr || arr < dep) return false;
    if (arr > arrMax) return false;
  }
  return true;
}
/** Prochain samedi (format ISO) — pour le bouton « Week-end » */
function nextSaturdayISO() {
  let iso = todayISO();
  for (let i = 0; i < 8; i++) {
    if (new Date(iso + 'T00:00:00Z').getUTCDay() === 6) return iso;
    iso = addDaysISO(iso, 1);
  }
  return iso;
}
/** Toutes les destinations atteignables depuis une gare/ville (hors trains intra-gare) */
function searchClassic(trains, from, cityIndex, opts = {}) {
  const fromSet = expandStationLabel(from, cityIndex);
  const groups = groupBySorted(
    findByOrigin(trains, fromSet)
      .filter(t => !fromSet.has(norm(t.destination)) && inWindow(t, opts.depMin, opts.arrMax)),
    t => t.destination
  );
  if (opts.sortMode === 'heure') groups.sort((a, b) => String(a.trains[0]?.heure_depart || '').localeCompare(String(b.trains[0]?.heure_depart || '')));
  else if (opts.sortMode === 'az') groups.sort((a, b) => a.station.localeCompare(b.station, 'fr'));
  return groups;
}
/** Toutes les origines qui desservent une gare/ville (hors trains intra-gare) */
function searchReverse(trains, to, cityIndex, opts = {}) {
  const toSet = expandStationLabel(to, cityIndex);
  const groups = groupBySorted(
    findByDest(trains, toSet)
      .filter(t => !toSet.has(norm(t.origine)) && inWindow(t, opts.depMin, opts.arrMax)),
    t => t.origine
  );
  if (opts.sortMode === 'heure') groups.sort((a, b) => String(a.trains[0]?.heure_depart || '').localeCompare(String(b.trains[0]?.heure_depart || '')));
  else if (opts.sortMode === 'az') groups.sort((a, b) => a.station.localeCompare(b.station, 'fr'));
  return groups;
}
/** Trains directs entre deux gares/villes */
function searchDirect(trains, from, to, cityIndex, opts = {}) {
  const fromSet = expandStationLabel(from, cityIndex), toSet = expandStationLabel(to, cityIndex);
  return findByOrigin(trains, fromSet)
    .filter(t => toSet.has(norm(t.destination)) && norm(t.origine) !== norm(t.destination) && inWindow(t, opts.depMin, opts.arrMax))
    .sort((a, b) => String(a.heure_depart || '').localeCompare(String(b.heure_depart || '')));
}
/**
 * Recherche multi-correspondances A → B, même journée.
 * opts : { minConn, maxConn, maxHops (1-4), maxResults }
 * BFS par niveaux : à chaque gare intermédiaire on tente de fermer vers B,
 * sinon on étend vers un nouveau hub (jamais visité — anti-boucles).
 * Élagage par gare : arrivées les plus précoces + les plus tardives
 * (pour couvrir les longues attentes). Caps stricts pour rester rapide.
 * Retour : [{ legs, waits, hubs, total }] trié par nb de correspondances puis durée.
 * NB : les directs ne sont PAS inclus (utiliser searchDirect).
 */
function searchMultiSplit(trains, from, to, opts = {}) {
  const minConn = opts.minConn ?? MIN_CONNECTION_MIN;
  const maxConn = opts.maxConn ?? MAX_CONNECTION_MIN;
  const maxHops = Math.max(1, Math.min(4, opts.maxHops ?? 1));
  const maxResults = opts.maxResults ?? 60;
  const cityIndex = opts.cityIndex || null;
  const depMin = opts.depMin || '', arrMax = opts.arrMax || '';
  const fromSet = expandStationLabel(from, cityIndex);
  const toSet = expandStationLabel(to, cityIndex);
  if ([...fromSet].some(x => toSet.has(x))) return [];

  const byOrigin = new Map();
  for (const t of trains) {
    const k = norm(t.origine);
    if (!byOrigin.has(k)) byOrigin.set(k, []);
    byOrigin.get(k).push(t);
  }
  const depM = t => parseHM(t.heure_depart);
  const arrM = t => arrivalMinutes(t.heure_depart, t.heure_arrivee);
  const waitOk = (pArr, dep) => pArr == null ? true : (dep - pArr >= minConn && dep - pArr <= maxConn);

  const results = [];
  const LEVEL_CAP = 300;
  let partials = [{ legs: [], hub: from, arrival: null, visited: fromSet }];

  for (let level = 0; level <= maxHops; level++) {
    const next = [];
    let levelCount = 0;
    for (const p of partials) {
      const outs = byOrigin.get(norm(p.hub)) || [];
      if (level > 0) {
        // Clôture : p.hub → B (arrivée ≤ arrMax si fixé ; trains de nuit exclus alors)
        for (const t of outs) {
          if (!toSet.has(norm(t.destination))) continue;
          if (arrMax && !inWindow(t, '', arrMax)) continue;
          const d = depM(t);
          if (d == null || !waitOk(p.arrival, d)) continue;
          results.push({ legs: [...p.legs, t] });
          levelCount++;
          if (levelCount >= LEVEL_CAP) break;
        }
      }
      if (level < maxHops) {
        // Extension vers un nouveau hub (jamais la gare d'arrivée, jamais une gare déjà visitée)
        for (const t of outs) {
          const nd = norm(t.destination);
          if (toSet.has(nd) || p.visited.has(nd)) continue;
          if (level === 0 && depMin && String(t.heure_depart || '') < depMin) continue; // le voyage démarre après depMin
          const d = depM(t), a = arrM(t);
          if (d == null || a == null || !waitOk(p.arrival, d)) continue;
          const visited = new Set(p.visited); visited.add(nd);
          next.push({ legs: [...p.legs, t], hub: t.destination, arrival: a, visited });
        }
      }
    }
    if (level >= maxHops) break;
    // Élagage : par hub, garder les arrivées les plus précoces (+ les plus tardives)
    const byHub = new Map();
    for (const p of next) {
      const k = norm(p.hub);
      if (!byHub.has(k)) byHub.set(k, []);
      byHub.get(k).push(p);
    }
    partials = [];
    for (const list of byHub.values()) {
      list.sort((a, b) => a.arrival - b.arrival);
      const kept = list.slice(0, 25);
      for (const p of list.slice(-15)) if (!kept.includes(p)) kept.push(p);
      partials.push(...kept);
    }
    if (partials.length > 2500) partials.length = 2500;
  }

  // Finalisation : attentes, durée totale, dédoublonnage, tri
  const seen = new Set();
  const out = [];
  for (const r of results) {
    const firstDep = depM(r.legs[0]);
    const lastArr = arrM(r.legs[r.legs.length - 1]);
    if (firstDep == null || lastArr == null) continue;
    const waits = [];
    let ok = true;
    for (let i = 0; i + 1 < r.legs.length; i++) {
      const w = depM(r.legs[i + 1]) - arrM(r.legs[i]);
      if (w == null || w < minConn || w > maxConn) { ok = false; break; }
      waits.push(w);
    }
    if (!ok) continue;
    const sig = r.legs.map(t => `${t.origine}|${t.destination}|${t.heure_depart}|${t.heure_arrivee}`).join('§');
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push({
      legs: r.legs,
      waits,
      hubs: r.legs.slice(0, -1).map(t => t.destination),
      total: lastArr - firstDep
    });
  }
  // Représentation équilibrée : meilleurs itinéraires PAR nombre de correspondances,
  // pour que les options à 3-4 corresp. ne soient pas noyées par les 1 corresp.
  const maxPerLevel = opts.maxPerLevel ?? 12;
  const byLevel = new Map();
  for (const it of out) {
    const c = it.legs.length - 1;
    if (!byLevel.has(c)) byLevel.set(c, []);
    byLevel.get(c).push(it);
  }
  const final = [];
  for (const c of [...byLevel.keys()].sort((a, b) => a - b)) {
    byLevel.get(c).sort((a, b) => a.total - b.total);
    final.push(...byLevel.get(c).slice(0, maxPerLevel));
  }
  return final.slice(0, maxResults);
}

/* ---------------- EXPORTS (tests Node) ---------------- */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    norm, parseHM, arrivalMinutes, todayISO, addDaysISO, fmtDateFR,
    fetchDay, fetchStationNames,
    searchClassic, searchReverse, searchDirect, searchMultiSplit, fmtDur, axeCategory, AXE_CATEGORIES,
    buildCityIndex, expandStationLabel, inWindow, nextSaturdayISO,
    segKeyOf, slugOf, dateToISO, dayDiff, niceMax, histMergeDay, histPrune, histSeries, hmClass, segLastTs,
    HIST_MAX_DAYS, HIST_MAX_SEGS, HIST_WINDOW_PERDATE
  };
}

/* ============================================================
   CÂBLAGE NAVIGATEUR (ignoré sous Node)
   ============================================================ */
if (typeof document !== 'undefined') {

  /* ---------- Coordonnées intégrées (clés normalisées) ---------- */
  const COORDS_RAW = {
    'PARIS (intramuros)': [48.8566, 2.3522],
    'LYON (intramuros)': [45.7530, 4.8530],
    'LILLE (intramuros)': [50.6330, 3.0660],
    'MARSEILLE ST CHARLES': [43.303, 5.382],
    'BORDEAUX ST JEAN': [44.826, -0.557],
    'TOULOUSE MATABIAU': [43.611, 1.455],
    'NANTES': [47.218, -1.553],
    'RENNES': [48.104, -1.672],
    'STRASBOURG': [48.585, 7.734],
    'NICE VILLE': [43.703, 7.265],
    'MONTPELLIER SAINT ROCH': [43.604, 3.879],
    'MONTPELLIER SUD DE FRANCE': [43.605, 3.932],
    'ST PIERRE DES CORPS': [47.393, 0.721],
    'TOURS': [47.394, 0.688],
    'ANGERS SAINT LAUD': [47.474, -0.552],
    'LE MANS': [48.002, 0.199],
    'POITIERS': [46.581, 0.337],
    'LA ROCHELLE VILLE': [46.155, -1.152],
    'LIMOGES BENEDICTINS': [45.827, 1.256],
    'BRIVE LA GAILLARDE': [45.152, 1.528],
    'CHATEAUROUX': [46.810, 1.692],
    'LA SOUTERRAINE': [46.240, 1.489],
    'ARGENTON SUR CREUSE': [46.587, 1.518],
    'VIERZON': [47.221, 2.067],
    'NEVERS': [46.992, 3.160],
    'MOULINS SUR ALLIER': [46.566, 3.331],
    'CLERMONT FERRAND': [45.772, 3.086],
    'RIOM CHATEL GUYON': [45.894, 3.103],
    'VICHY': [46.128, 3.427],
    'DIJON VILLE': [47.324, 5.045],
    'BEAUNE': [47.026, 4.840],
    'CHALON SUR SAONE': [46.781, 4.855],
    'MACON VILLE': [46.307, 4.828],
    'BESANCON FRANCHE COMTE TGV': [47.247, 6.018],
    'BELFORT MONTBELIARD TGV': [47.596, 6.842],
    'MULHOUSE VILLE': [47.750, 7.340],
    'COLMAR': [48.073, 7.357],
    'METZ VILLE': [49.111, 6.176],
    'NANCY': [48.688, 6.190],
    'LORRAINE TGV': [48.986, 6.211],
    'THIONVILLE': [49.358, 6.170],
    'MEUSE TGV': [48.960, 5.294],
    'CHAMPAGNE ARDENNE TGV': [49.353, 4.096],
    'REIMS': [49.258, 4.031],
    'TGV HAUTE PICARDIE': [49.850, 2.940],
    'ARRAS': [50.291, 2.777],
    'LES AUBRAIS ORLEANS': [47.910, 1.910],
    'VENDOME VILLIERS SUR LOIR': [47.794, 0.937],
    'LAVAL': [48.074, -0.768],
    'LE CREUSOT MONTCEAU MONTCHANIN TGV': [46.850, 4.480],
    'MACON LOCHE TGV': [46.302, 4.742],
    'VALENCE TGV AUVERGNE RHONE ALPES': [44.964, 4.904],
    'AVIGNON TGV': [43.908, 4.807],
    'AVIGNON CENTRE': [43.949, 4.806],
    'AIX EN PROVENCE TGV': [43.427, 5.235],
    'AIX EN PROVENCE CENTRE': [43.530, 5.445],
    'TOULON': [43.127, 5.933],
    'ST RAPHAEL VALESCURE': [43.425, 6.763],
    'LES ARCS DRAGUIGNAN': [43.470, 6.680],
    'CANNES': [43.553, 7.016],
    'ANTIBES': [43.580, 7.121],
    'ARLES': [43.677, 4.628],
    'NIMES CENTRE': [43.837, 4.360],
    'NIMES PONT DU GARD': [43.860, 4.431],
    'SETE': [43.401, 3.697],
    'AGDE': [43.311, 3.469],
    'BEZIERS': [43.342, 3.216],
    'NARBONNE': [43.184, 3.004],
    'CARCASSONNE': [43.210, 2.347],
    'PERPIGNAN': [42.698, 2.903],
    'MONTAUBAN VILLE BOURBON': [43.999, 1.354],
    'AGEN': [44.198, 0.617],
    'MARMANDE': [44.500, 0.166],
    'CAHORS': [44.449, 1.438],
    'SOUILLAC': [44.869, 1.504],
    'GOURDON': [44.744, 1.387],
    'ANGOULEME': [45.649, 0.156],
    'PAU': [43.312, -0.371],
    'LOURDES': [43.091, -0.055],
    'TARBES': [43.232, 0.071],
    'DAX': [43.710, -1.048],
    'ORTHEZ': [43.485, -0.776],
    'BAYONNE': [43.493, -1.476],
    'BIARRITZ': [43.483, -1.559],
    'ST JEAN DE LUZ CIBOURE': [43.394, -1.663],
    'HENDAYE': [43.363, -1.776],
    'ST BRIEUC': [48.514, -2.765],
    'GUINGAMP': [48.562, -3.151],
    'MORLAIX': [48.577, -3.829],
    'BREST': [48.388, -4.486],
    'LORIENT': [47.747, -3.371],
    'VANNES': [47.659, -2.760],
    'AURAY': [47.670, -2.989],
    'QUIMPER': [47.996, -4.098],
    'LA ROCHE SUR YON': [46.670, -1.427],
    'SAUMUR': [47.259, -0.080],
    'MASSY TGV': [48.727, 2.262],
    'MARNE LA VALLEE CHESSY': [48.873, 2.777],
    'AEROPORT ROISSY CDG 2 TGV': [49.004, 2.557],
    'LYON ST EXUPERY TGV.': [45.720, 5.080],
    'BRUXELLES MIDI': [50.840, 4.361],
    'LUXEMBOURG': [49.600, 6.133],
    'FRANKFURT AM MAIN HBF': [50.107, 8.663],
    'MANNHEIM HBF': [49.479, 8.470],
    'KARLSRUHE HBF': [48.994, 8.402],
    'STUTTGART HBF': [48.785, 9.182],
    'GENEVE': [46.204, 6.142],
    'LAUSANNE': [46.516, 6.629],
    'BASEL SBB': [47.547, 7.590],
    'ZURICH HB': [47.378, 8.539],
    'TURIN PORTA SUSA': [45.068, 7.683],
    'MILANO PORTA GARIBALDI': [45.486, 9.206],
    'OULX': [45.057, 6.968],
    'MODANE': [45.196, 6.671],
    'CHAMBERY CHALLES LES EAUX': [45.565, 5.921],
    'AIX LES BAINS LE REVARD': [45.690, 5.909],
    'ANNECY': [45.899, 6.129],
    'GRENOBLE': [45.191, 5.714],
    'GAP': [44.561, 6.079],
    'MONTDAUPHIN GUILLESTRE': [44.799, 6.714],
    'BRIANCON': [44.900, 6.648],
    'EMBRUN': [44.564, 6.495],
    'VEYNES DEVOLUY': [44.710, 5.969]
  };
  const COORDS = {};
  for (const [k, v] of Object.entries(COORDS_RAW)) COORDS[norm(k)] = v;

  /* ---------- Géocodage de secours (Nominatim) + cache local ---------- */
  const GEO_CACHE_KEY = 'tgvradar_geocode_v1';
  let geoCache = {};
  try { geoCache = JSON.parse(localStorage.getItem(GEO_CACHE_KEY) || '{}'); } catch (e) { geoCache = {}; }
  function saveGeoCache() { try { localStorage.setItem(GEO_CACHE_KEY, JSON.stringify(geoCache)); } catch (e) {} }

  const geoQueue = [];
  let geoRunning = false;
  function getCoord(station, cb) {
    const key = norm(station);
    if (COORDS[key]) return cb(COORDS[key]);
    if (geoCache[key]) return cb(geoCache[key]);
    if (!geoQueue.some(item => item.key === key)) {
      geoQueue.push({ key, label: station, cb });
      runGeoQueue();
    }
  }
  function runGeoQueue() {
    if (geoRunning || !geoQueue.length) return;
    geoRunning = true;
    const item = geoQueue.shift();
    const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q='
      + encodeURIComponent(item.label + ' gare France');
    fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(r => r.json())
      .then(list => {
        if (list && list[0] && list[0].lat) {
          const c = [parseFloat(list[0].lat), parseFloat(list[0].lon)];
          geoCache[item.key] = c; saveGeoCache(); item.cb(c);
        }
      })
      .catch(() => {})
      .finally(() => {
        geoRunning = false;
        setTimeout(runGeoQueue, 1100); // politesse Nominatim
      });
  }

  /* ---------- Carte ---------- */
  let map = null;
  let markersLayer = null;
  function ensureMap() {
    if (map) return map;
    map = L.map('map', { scrollWheelZoom: true });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap &copy; CARTO'
    }).addTo(map);
    markersLayer = L.layerGroup().addTo(map);
    return map;
  }
  function plotPoints(points, lines, opts = {}) {
    const fit = opts.fit !== false;
    const el = document.getElementById('map');
    const pts = points.filter(p => p.coord);
    const seenLines = new Set();
    const lns = (lines || [])
      .map(l => ({ ...l, coords: (l.coords || []).filter(Boolean) }))
      .filter(l => {
        if (l.coords.length < 2) return false;
        const sig = JSON.stringify(l.coords.map(c => c.map(x => Math.round(x * 1000))));
        if (seenLines.has(sig)) return false;
        seenLines.add(sig);
        return true;
      });
    if (!pts.length && !lns.length) { el.hidden = true; return; }
    el.hidden = false;
    ensureMap();
    markersLayer.clearLayers();
    // Lignes d'abord (sous les marqueurs) : chaque trajet possible est symbolisé
    lns.forEach(l => {
      L.polyline(l.coords, {
        color: l.color || '#a1006b',
        weight: l.weight || 2.5,
        opacity: 0.65,
        dashArray: l.dashArray || null
      }).addTo(markersLayer);
    });
    const bounds = [];
    lns.forEach(l => l.coords.forEach(c => bounds.push(c)));
    pts.forEach(p => {
      bounds.push(p.coord);
      L.circleMarker(p.coord, {
        radius: p.major ? 8 : 6,
        color: p.color || '#a1006b',
        fillColor: p.color || '#a1006b',
        fillOpacity: 0.85, weight: 2
      }).bindPopup(`<strong>${p.label}</strong><br>${p.info || ''}`).addTo(markersLayer);
    });
    try {
      if (bounds.length === 1) map.setView(bounds[0], 6);
      else if (fit) map.fitBounds(L.latLngBounds(bounds), { padding: [40, 40], maxZoom: 9 });
    } catch (e) {
      map.setView([46.6, 2.4], 5.5); // vue France en cas de bounds invalide
    }
    map.invalidateSize();
    setTimeout(() => map.invalidateSize(), 250);
  }

  /* ---------- UI ---------- */
  const $ = sel => document.querySelector(sel);
  const prettyStation = s => String(s || '').replace(/\s*\(intramuros\)\s*/i, ' (toutes gares)');
  const sncfConnectLink = (from, to, date) => SNCF_SEARCH_URL;

  /* ---------- État de recherche + filtre type de train ---------- */
  let axeFilter = '';
  let lastSearch = null;
  $('#axe-filter').addEventListener('change', ev => {
    axeFilter = ev.target.value;
    if (lastSearch) doSearch(lastSearch.mode, lastSearch.params);
  });

  /* ---------- Clic sur une ligne de train => n° de train ---------- */
  $('#results').addEventListener('click', ev => {
    const row = ev.target.closest('.train-row');
    if (!row) return;
    const det = row.querySelector('.train-details');
    if (det) det.hidden = !det.hidden;
  });

  /* ---------- Blagues & jeux de mots (transitions seulement, jamais dans les résultats) ---------- */
  const LOADING_JOKES = [
    '⏳ Interrogation des données SNCF…',
    '🚂 Le TGV des données fonce à 300 km/h…',
    '🎫 Le contrôleur compte les places libres une par une…',
    '🛤️ On vérifie que la voie est libre près de Châteauroux…',
    '🚉 Annonce en gare : « les résultats arriveront quai 3 »…',
    '🐌 Même le TER met la main à la pâte…',
    '☕ Le conducteur finit son café, deux secondes…',
    '🗺️ On déplie la carte de la France entière…',
    '⏱️ Correspondance assurée en 5 minutes chrono avec l’API…',
    '🧭 Le GPS réapprend la différence entre Montparnasse et Vaugirard…',
    '🔎 On regarde sous les sièges s’il reste des places…',
    '📢 « Mesdames et messieurs, votre recherche arrive en gare »…',
    '🎟️ Les places sont au frais dans la voiture-restaurant…',
    '🚦 Le signal est au vert, la requête part…'
  ];
  let lastJokeIdx = -1;
  function randomJoke() {
    if (LOADING_JOKES.length < 2) return LOADING_JOKES[0];
    let i; do { i = Math.floor(Math.random() * LOADING_JOKES.length); } while (i === lastJokeIdx);
    lastJokeIdx = i;
    return LOADING_JOKES[i];
  }
  const EMPTY_QUIPS = [
    'Les places sont parties plus vite qu’un TGV sans arrêt.',
    'C’est complet — même le bar de la voiture-restaurant a été vidé.',
    'Quelqu’un a réservé avant toi. Un rival, probablement.',
    'Plein comme une rame de métro à 18h, ce train.',
    'Le hasard fait bien les choses… mais pas aujourd’hui.'
  ];
  function randomQuip() { return EMPTY_QUIPS[Math.floor(Math.random() * EMPTY_QUIPS.length)]; }

  function setStatus(msg, isError) {
    const el = $('#status');
    el.hidden = !msg;
    el.classList.toggle('error', !!isError);
    el.innerHTML = msg || '';
  }

  function trainRow(t) {
    const axe = t.axe ? ` <span class="axe">· ${escapeHtml(t.axe)}</span>` : '';
    const dur = arrivalMinutes(t.heure_depart, t.heure_arrivee);
    const durTxt = (dur != null && parseHM(t.heure_depart) != null) ? ` · ${fmtDur(dur - parseHM(t.heure_depart))}` : '';
    const det = t.train_no
      ? `<span class="train-details" hidden>🚆 n° ${escapeHtml(t.train_no)} · ${escapeHtml(t.origine_iata || '?')} → ${escapeHtml(t.destination_iata || '?')}${t.axe ? ' · ' + escapeHtml(t.axe) : ''}</span>`
      : '';
    return `<div class="train-row"${t.train_no ? ' title="Cliquer pour voir le n° de train"' : ''}>🕐 ${escapeHtml(t.heure_depart || '?')} → ${escapeHtml(t.heure_arrivee || '?')}${durTxt}${axe}${det}</div>`;
  }
  function legRow(t) {
    const axe = t.axe ? ` <span class="axe">· ${escapeHtml(t.axe)}</span>` : '';
    const dur = arrivalMinutes(t.heure_depart, t.heure_arrivee);
    const durTxt = (dur != null && parseHM(t.heure_depart) != null) ? ` · ${fmtDur(dur - parseHM(t.heure_depart))}` : '';
    const det = t.train_no
      ? `<span class="train-details" hidden>🚆 n° ${escapeHtml(t.train_no)} · ${escapeHtml(t.origine_iata || '?')} → ${escapeHtml(t.destination_iata || '?')}</span>`
      : '';
    return `<div class="train-row"${t.train_no ? ' title="Cliquer pour voir le n° de train"' : ''}>🕐 ${escapeHtml(t.heure_depart)} → ${escapeHtml(t.heure_arrivee)} · ${escapeHtml(prettyStation(t.origine))} → ${escapeHtml(prettyStation(t.destination))}${durTxt}${axe}${det}</div>`;
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
      m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  function renderGroups(title, groups, otherStation, date, maxGroups = 40) {
    const total = groups.reduce((n, g) => n + g.trains.length, 0);
    let html = `<h2 class="res-section-title">${title} — <strong>${groups.length}</strong> gares, <strong>${total}</strong> trains TGVmax</h2><div class="cards">`;
    for (const g of groups.slice(0, maxGroups)) {
      const rows = g.trains.slice(0, 6).map(trainRow).join('');
      const more = g.trains.length > 6 ? `<div class="conn">+ ${g.trains.length - 6} autre(s) train(s)</div>` : '';
      html += `<div class="card">
        <div class="card-head">
          <span class="card-station">${escapeHtml(prettyStation(g.station))}</span>
          <span class="badge">${g.trains.length} train${g.trains.length > 1 ? 's' : ''}</span>
        </div>
        ${rows}${more}
        <a class="book-link" target="_blank" rel="noopener" href="${sncfConnectLink(otherStation, g.station, date)}" title="À saisir : ${escapeHtml(prettyStation(otherStation))} → ${escapeHtml(prettyStation(g.station))} · ${fmtDateFR(date)}">Vérifier sur SNCF Connect ↗</a>
      </div>`;
    }
    html += '</div>';
    return html;
  }

  function renderDirect(title, trains, from, to, date) {
    let html = `<h2 class="res-section-title">${title} — <strong>${trains.length}</strong> train(s) direct(s)</h2>`;
    if (!trains.length) return html;
    html += `<div class="cards"><div class="card">
      <div class="card-head">
        <span class="card-station">${escapeHtml(prettyStation(from))} → ${escapeHtml(prettyStation(to))}</span>
        <span class="badge">${trains.length}</span>
      </div>
      ${trains.slice(0, 8).map(trainRow).join('')}
      ${trains.length > 8 ? `<div class="conn">+ ${trains.length - 8} autre(s)</div>` : ''}
      <a class="book-link" target="_blank" rel="noopener" href="${sncfConnectLink(from, to, date)}" title="À saisir : ${escapeHtml(prettyStation(from))} → ${escapeHtml(prettyStation(to))} · ${fmtDateFR(date)}">Réserver sur SNCF Connect ↗</a>
    </div></div>`;
    return html;
  }

  function renderSplit(group, hops, date) {
    const label = hops === 1 ? '1 correspondance' : `${hops} correspondances`;
    let html = `<h2 class="res-section-title">✂️ Avec ${label} — <strong>${group.length}</strong> option(s)</h2>`;
    if (!group.length) return html;
    html += `<p class="hint">💡 SNCF Connect ne pré-remplit pas une recherche depuis un lien : chaque bouton ouvre leur formulaire — les gares et la date à saisir sont rappelées au survol.</p>`;
    html += '<div class="cards">';
    for (const it of group.slice(0, 6)) {
      const via = it.hubs.map(prettyStation).join(' · ');
      const legsHtml = it.legs.map((t, i) => {
        const bookTitle = `À saisir : ${prettyStation(t.origine)} → ${prettyStation(t.destination)} · ${fmtDateFR(date)}${t.train_no ? ' · train n° ' + t.train_no : ''}${t.axe ? ' · ' + t.axe : ''}`;
        return legRow(t)
          + (i < it.waits.length
            ? `<div class="conn">↳ ${fmtDur(it.waits[i])} d'attente à ${escapeHtml(prettyStation(it.hubs[i]))}</div>`
            : '')
          + `<a class="book-link leg-book" target="_blank" rel="noopener" href="${SNCF_SEARCH_URL}" title="${escapeHtml(bookTitle)}">🎫 Réserver ce tronçon — ${escapeHtml(prettyStation(t.origine))} → ${escapeHtml(prettyStation(t.destination))} ↗</a>`;
      }).join('');
      html += `<div class="card">
        <div class="card-head">
          <span class="card-station">via ${escapeHtml(via)}</span>
          <span class="badge">⏱ ${fmtDur(it.total)}</span>
        </div>
        ${legsHtml}
      </div>`;
    }
    html += '</div>';
    return html;
  }

  /* ---------- Gestion des onglets ---------- */
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $('#tab-' + btn.dataset.tab).classList.add('active');
    });
  });

  /* ---------- Bouton thème (clair / sombre, mémorisé) ---------- */
  const THEME_KEY = 'tgvmax_radar_theme_v1';
  const THEME_COLORS = { light: '#a1006b', dark: '#0f131d' };
  function effectiveTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }
  function applyTheme(theme, persist) {
    document.documentElement.setAttribute('data-theme', theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_COLORS[theme]);
    const tbtn = document.getElementById('theme-btn');
    if (tbtn) {
      tbtn.textContent = theme === 'dark' ? '☀️' : '🌙';
      tbtn.title = theme === 'dark' ? 'Passer en thème clair' : 'Passer en thème sombre';
    }
    if (persist) { try { localStorage.setItem(THEME_KEY, theme); } catch (e) {} }
  }
  applyTheme(effectiveTheme(), false); // sync icône + couleur navigateur avec l'état posé par le script anti-flash du <head>
  $('#theme-btn').addEventListener('click', () => {
    applyTheme(effectiveTheme() === 'dark' ? 'light' : 'dark', true);
  });
  // Mode auto (aucune préférence mémorisée) : suit les changements du système en direct
  try {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', ev => {
      let pref = 'auto';
      try { pref = localStorage.getItem(THEME_KEY) || 'auto'; } catch (e) {}
      if (pref === 'auto') applyTheme(ev.matches ? 'dark' : 'light', false);
    });
  } catch (e) {}

  /* ---------- Bouton d'échange départ ⇄ arrivée ---------- */
  document.querySelectorAll('.swap-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const form = btn.closest('form');
      if (!form) return;
      // Onglets « Depuis une gare » / « Vers une destination » : bascule du mode
      // en conservant la gare ET la date saisies.
      if (btn.dataset.swap === 'mode') {
        const targetMode = form.dataset.mode === 'classic' ? 'reverse' : 'classic';
        const target = document.querySelector('.search-form[data-mode="' + targetMode + '"]');
        if (!target) return;
        target.querySelector('[name=station]').value = form.querySelector('[name=station]').value;
        target.querySelector('[name=date]').value = form.querySelector('[name=date]').value;
        document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === targetMode));
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + targetMode));
        target.querySelector('[name=station]').focus();
        return;
      }
      // Onglets « Avec correspondances » et « Suivi » : échange simple des deux champs
      const a = form.querySelector('[name=from]');
      const b = form.querySelector('[name=to]');
      if (!a || !b) return;
      const tmp = a.value;
      a.value = b.value;
      b.value = tmp;
    });
  });

  /* ---------- Champs date ---------- */
  document.querySelectorAll('input[type="date"]').forEach(inp => {
    inp.min = todayISO();
    inp.max = addDaysISO(todayISO(), BOOKING_WINDOW_DAYS);
    inp.value = todayISO();
  });

  /* ---------- Gares, villes multi-gares & autocomplétion ---------- */
  let allStations = [];
  let cityIndex = null;
  let suggestions = [];

  function rebuildSuggestions() {
    const list = [];
    if (cityIndex) {
      for (const [, g] of cityIndex) {
        if (g.stations.length >= 2) {
          list.push({ display: `${g.city} — toutes les gares`, value: `${g.city} (toutes gares)`, sub: `${g.stations.length} gares` });
        }
      }
    }
    for (const name of allStations) {
      list.push({ display: prettyStation(name), value: name, sub: null });
    }
    suggestions = list;
  }

  fetchStationNames().then(names => {
    allStations = names;
    cityIndex = buildCityIndex(allStations);
    rebuildSuggestions();
  }).catch(() => {});

  /** Menu déroulant auto (tactile + clavier) branché sur un champ texte */
  function initAutocomplete(input) {
    const wrap = input.closest('.ac-wrap') || input.parentElement;
    let listEl = null, activeIdx = -1, current = [];

    function close() { if (listEl) { listEl.remove(); listEl = null; } activeIdx = -1; }
    function choose(s) { input.value = s.value; close(); }

    function open() {
      close();
      const q = norm(input.value);
      let src = suggestions;
      if (q) {
        const starts = src.filter(s => norm(s.display).startsWith(q) || norm(s.value).startsWith(q));
        const incl = src.filter(s => !starts.includes(s) && norm(s.display).includes(q));
        src = [...starts, ...incl];
      }
      current = src.slice(0, 14);
      if (!current.length) return;
      listEl = document.createElement('div');
      listEl.className = 'ac-list';
      current.forEach((s, i) => {
        const it = document.createElement('div');
        it.className = 'ac-item' + (i === activeIdx ? ' active' : '');
        it.innerHTML = escapeHtml(s.display) + (s.sub ? ` <span class="ac-sub">(${escapeHtml(s.sub)})</span>` : '');
        it.addEventListener('pointerdown', ev => { ev.preventDefault(); choose(s); });
        listEl.appendChild(it);
      });
      wrap.appendChild(listEl);
    }

    input.addEventListener('focus', open);
    input.addEventListener('input', open);
    input.addEventListener('keydown', ev => {
      if (!listEl) return;
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        activeIdx = ev.key === 'ArrowDown' ? Math.min(activeIdx + 1, current.length - 1) : Math.max(activeIdx - 1, 0);
        [...listEl.children].forEach((c, i) => c.classList.toggle('active', i === activeIdx));
      } else if (ev.key === 'Enter') {
        if (activeIdx >= 0 && current[activeIdx]) { ev.preventDefault(); choose(current[activeIdx]); }
        else { close(); }
      } else if (ev.key === 'Escape') { close(); }
    });
    input.addEventListener('blur', () => setTimeout(close, 180));
  }
  document.querySelectorAll('.ac-wrap input[type="text"]').forEach(initAutocomplete);

  /* ---------- Soumission des formulaires ---------- */
  async function doSearch(mode, params) {
    const date = params.date;
    try {
      setStatus(randomJoke());
      const allTrains = await fetchDay(date);
      // Enrichit le pool de gares + reconstruit l'index villes si besoin
      let stationsChanged = false;
      const addName = n => { if (n && !allStations.includes(n)) { allStations.push(n); stationsChanged = true; } };
      addName(params.from); addName(params.to); addName(params.station);
      allTrains.forEach(t => { addName(t.origine); addName(t.destination); });
      if (stationsChanged || !cityIndex) { cityIndex = buildCityIndex(allStations); rebuildSuggestions(); }

      const trains = axeFilter ? allTrains.filter(t => axeCategory(t.axe) === axeFilter) : allTrains;
      updateAxeCounts(allTrains);
      const depMin = $('#dep-min').value || '';
      const arrMax = $('#arr-max').value || '';
      const sortMode = $('#sort-mode').value || 'places';
      const winOpts = { depMin, arrMax, sortMode };

      if (!trains.length) {
        document.getElementById('map').hidden = true;
        $('#results').innerHTML = '';
        setStatus(allTrains.length && axeFilter
          ? `Aucun train « ${escapeHtml(axeFilter)} » réservable le ${fmtDateFR(date)} (il y a ${allTrains.length} places sur d'autres types de trains — change de filtre).`
          : `Aucune place Max Jeunes trouvée pour le <strong>${fmtDateFR(date)}</strong>. Soit tout est complet, soit la date est hors fenêtre de réservation (${BOOKING_WINDOW_DAYS} jours).<br><small>${randomQuip()}</small>`, true);
        return;
      }
      const filterTag = axeFilter ? ` · filtre : <strong>${escapeHtml(axeFilter)}</strong>` : '';

      let html = '';
      const points = [];
      const lines = [];

      if (mode === 'classic') {
        const groups = searchClassic(trains, params.station, cityIndex, winOpts);
        if (!groups.length) {
          $('#results').innerHTML = '';
          const topOrigins = {};
          allTrains.forEach(t => { topOrigins[t.origine] = (topOrigins[t.origine] || 0) + 1; });
          const top5 = Object.entries(topOrigins).sort((a, b) => b[1] - a[1]).slice(0, 5)
            .map(([s, n]) => `${prettyStation(s)} (${n})`).join(' · ');
          setStatus(`Aucune place depuis « ${escapeHtml(params.station)} » le ${fmtDateFR(date)}. Vérifie l'orthographe de la gare (les gares parisiennes = « PARIS (intramuros) »).<br><small>💡 Où ça bouge aujourd'hui : ${escapeHtml(top5)}</small>`, true);
          return;
        }
        setStatus(`✅ <strong>${trains.length}</strong> trains réservables le ${fmtDateFR(date)} — destinations depuis <strong>${escapeHtml(prettyStation(params.station))}</strong>${filterTag} :`);
        html = renderGroups('🎯 Depuis ' + escapeHtml(prettyStation(params.station)), groups, params.station, date);
        const originCoord = coordForLabel(params.station);
        points.push({ coord: originCoord, label: prettyStation(params.station), info: 'Départ', color: '#2563eb', major: true });
        groups.forEach(g => {
          const c = coordForLabel(g.station);
          points.push({ coord: c, label: prettyStation(g.station), info: `${g.trains.length} train(s) TGVmax` });
          if (originCoord && c && lines.length < 60) lines.push({ coords: [originCoord, c] });
        });
      }

      if (mode === 'reverse') {
        const groups = searchReverse(trains, params.station, cityIndex, winOpts);
        if (!groups.length) {
          $('#results').innerHTML = '';
          setStatus(`Aucune place vers « ${escapeHtml(params.station)} » le ${fmtDateFR(date)}. Vérifie l'orthographe (ex. « NICE VILLE »).`, true);
          return;
        }
        setStatus(`✅ <strong>${trains.length}</strong> trains réservables le ${fmtDateFR(date)} — origines pour arriver à <strong>${escapeHtml(prettyStation(params.station))}</strong>${filterTag} :`);
        html = renderGroups('🔄 Vers ' + escapeHtml(prettyStation(params.station)), groups, params.station, date);
        const destCoord = coordForLabel(params.station);
        points.push({ coord: destCoord, label: prettyStation(params.station), info: 'Arrivée', color: '#2563eb', major: true });
        groups.forEach(g => {
          const c = coordForLabel(g.station);
          points.push({ coord: c, label: prettyStation(g.station), info: `${g.trains.length} train(s) TGVmax` });
          if (destCoord && c && lines.length < 60) lines.push({ coords: [c, destCoord] });
        });
      }

      if (mode === 'split') {
        const directs = searchDirect(trains, params.from, params.to, cityIndex, { depMin, arrMax });
        const itins = searchMultiSplit(trains, params.from, params.to, {
          maxHops: params.hops,
          maxConn: params.maxwait,
          cityIndex,
          depMin,
          arrMax
        });
        if (!directs.length && !itins.length) {
          $('#results').innerHTML = '';
          document.getElementById('map').hidden = true;
          setStatus(`Ni direct ni itinéraire à correspondances trouvé entre « ${escapeHtml(params.from)} » et « ${escapeHtml(params.to)} » le ${fmtDateFR(date)}. Essaie plus de correspondances, une attente max plus grande, ou une autre date.`, true);
          return;
        }
        const byHops = {};
        itins.forEach(it => { const c = it.legs.length - 1; (byHops[c] = byHops[c] || []).push(it); });
        const recap = Object.keys(byHops).sort((a, b) => a - b)
          .map(c => `<strong>${byHops[c].length}</strong> × ${c} corresp.`).join(' · ');
        setStatus(`✅ ${fmtDateFR(date)} : <strong>${directs.length}</strong> direct(s)${recap ? ' · ' + recap : ''} — meilleurs itinéraires par catégorie${filterTag} :`);
        html = renderDirect('🚄 Directs', directs, params.from, params.to, date);
        for (const c of Object.keys(byHops).sort((a, b) => a - b)) {
          html += renderSplit(byHops[c], Number(c), date);
        }
        points.push({ coord: coordForLabel(params.from), label: prettyStation(params.from), info: 'Départ', color: '#2563eb', major: true });
        points.push({ coord: coordForLabel(params.to), label: prettyStation(params.to), info: 'Arrivée', color: '#0e9f6e', major: true });
        const hubCount = {};
        itins.slice(0, 15).forEach(it => it.hubs.forEach(hh => { hubCount[hh] = (hubCount[hh] || 0) + 1; }));
        Object.entries(hubCount).slice(0, 20).forEach(([hh, n]) =>
          points.push({ coord: getKnownCoord(hh), label: prettyStation(hh), info: `${n} itinéraire(s) via cette gare`, color: '#a1006b' }));
        // Une ligne par itinéraire (chaîne complète départ → hubs → arrivée)
        itins.slice(0, 8).forEach(it => {
          const chain = [params.from, ...it.hubs, params.to].map(coordForLabel);
          if (chain.every(Boolean)) lines.push({ coords: chain, weight: 2.5 });
        });
      }

      window.__lastRender = { points, lines };   // référence pour le re-tracé après géocodage différé
      $('#results').innerHTML = html;
      plotPoints(points, lines);
      $('#status').insertAdjacentHTML('beforeend', ' <button type="button" class="share-btn" title="Copier un lien qui relance cette recherche à l’identique">🔗 Partager cette recherche</button>');
      const statusEl = document.getElementById('status');
      if (statusEl) statusEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      setStatus('❌ ' + escapeHtml(err.message || err), true);
    }
  }

  /** Retire un éventuel suffixe « (toutes gares) » / « (toutes les gares) » :
   *  « AVIGNON (toutes gares) » → « AVIGNON ». Ces libellés ville ne doivent
   *  JAMAIS partir tels quels vers l'index ou le géocodage. */
  function stripAllStationsSuffix(label) {
    const raw = String(label || '').trim();
    const m = raw.match(/\s*\((?:toutes les gares|toutes gares)\)\s*$/i);
    return m ? raw.slice(0, m.index).trim() : raw;
  }

  /** Coordonnée d'une gare OU d'un libellé ville (« X (toutes gares) » → centroïde du groupe) */
  function coordForLabel(label) {
    const cityLabel = stripAllStationsSuffix(label);
    const key = norm(cityLabel);
    const candidates = key ? [key, key + ' intramuros'] : []; // « paris » → « paris intramuros »
    // 1) Coordonnée directe — gare exacte, ou ville « X (intramuros) » (Paris/Lyon/Lille)
    for (const k of candidates) {
      if (COORDS[k]) return COORDS[k];
      if (geoCache[k]) return geoCache[k];
    }
    // 2) Groupe ville (CITY_GROUPS) → centroïde = moyenne des gares du groupe
    const idxKey = candidates.find(k => cityIndex && cityIndex.has(k));
    if (idxKey) {
      const coords = cityIndex.get(idxKey).stations.map(s => COORDS[norm(s)]).filter(Boolean);
      if (coords.length) {
        return [
          coords.reduce((a, c) => a + c[0], 0) / coords.length,
          coords.reduce((a, c) => a + c[1], 0) / coords.length
        ];
      }
    }
    return getKnownCoord(cityLabel); // géocodage différé éventuel (vraie gare inconnue)
  }

  function getKnownCoord(station) {
    const clean = stripAllStationsSuffix(station); // jamais de géocodage Nominatim sur « X (toutes gares) »
    const key = norm(clean);
    if (COORDS[key]) return COORDS[key];
    if (geoCache[key]) return geoCache[key];
    // géocodage en tâche de fond : re-trace la carte SANS recadrer (l'utilisateur regarde)
    getCoord(clean, () => {
      const r = window.__lastRender;
      if (r && (r.points.length || r.lines.length)) plotPoints(r.points, r.lines, { fit: false });
    });
    return null;
  }

  /* ---------- Compteurs de recherches (perso local + global public) ---------- */
  const COUNTER_KEY = 'tgvmax_radar_searchcount_v1';
  const GLOBAL_COUNTER_API = 'https://abacus.jasoncameron.dev';
  const GLOBAL_COUNTER_NS = 'tgvmax-radar/searches';
  let globalCount = null;
  function getSearchCount() {
    try { return Number(localStorage.getItem(COUNTER_KEY) || 0) || 0; } catch (e) { return 0; }
  }
  function searchRank(n) {
    if (n >= 100) return '🏆 Légende du rail';
    if (n >= 50) return '🚉 Chef de gare';
    if (n >= 25) return '🛤️ Aiguilleur fou';
    if (n >= 10) return '⚡ Chasseur de places';
    if (n >= 5) return '🎟️ Voyageur régulier';
    return '🎫 Touriste du rail';
  }
  function renderSearchCounter() {
    const mine = getSearchCount();
    const el = document.getElementById('search-counter');
    if (!el) return;
    const parts = [];
    if (globalCount != null) parts.push(`🌍 <strong>${globalCount.toLocaleString('fr-FR')}</strong> recherche${globalCount > 1 ? 's' : ''} sur tous les appareils`);
    if (mine >= 1) parts.push(`dont <strong>${mine}</strong> par toi — ${searchRank(mine)}`);
    if (!parts.length) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = '🚄 ' + parts.join(' · ');
  }
  function bumpSearchCount() {
    try { localStorage.setItem(COUNTER_KEY, String(getSearchCount() + 1)); } catch (e) {}
    renderSearchCounter();
  }
  /** Compteur GLOBAL partagé (Abacus, sans clé) — fire-and-forget, jamais bloquant */
  async function refreshGlobalCount() {
    try {
      const r = await fetch(`${GLOBAL_COUNTER_API}/get/${GLOBAL_COUNTER_NS}`, { headers: { Accept: 'application/json' } });
      if (r.ok) {
        const j = await r.json();
        if (j && j.value != null) { globalCount = Number(j.value); renderSearchCounter(); }
      }
    } catch (e) {}
  }
  async function bumpGlobalCount() {
    try {
      const r = await fetch(`${GLOBAL_COUNTER_API}/hit/${GLOBAL_COUNTER_NS}`, { headers: { Accept: 'application/json' } });
      if (r.ok) {
        const j = await r.json();
        if (j && j.value != null) { globalCount = Number(j.value); renderSearchCounter(); }
      }
    } catch (e) {}
  }
  refreshGlobalCount();
  renderSearchCounter();

  /* ---------- Filtres horaires, tri, dates rapides ---------- */
  $('#dep-min').addEventListener('change', () => { if (lastSearch) doSearch(lastSearch.mode, lastSearch.params); });
  $('#arr-max').addEventListener('change', () => { if (lastSearch) doSearch(lastSearch.mode, lastSearch.params); });
  $('#sort-mode').addEventListener('change', () => { if (lastSearch) doSearch(lastSearch.mode, lastSearch.params); });
  document.querySelectorAll('.quick-date').forEach(b => b.addEventListener('click', () => {
    const v = b.dataset.days === 'weekend' ? nextSaturdayISO() : addDaysISO(todayISO(), Number(b.dataset.days));
    document.querySelectorAll('input[type="date"]').forEach(inp => inp.value = v);
    if (lastSearch) doSearch(lastSearch.mode, lastSearch.params);
    else setStatus(`📅 Date réglée sur ${fmtDateFR(v)} — lance une recherche !`);
  }));

  /** Affiche le nombre de trains par type dans le filtre (sur les données du jour) */
  function updateAxeCounts(allTrains) {
    const counts = {};
    allTrains.forEach(t => { const c = axeCategory(t.axe); counts[c] = (counts[c] || 0) + 1; });
    const sel = $('#axe-filter');
    [...sel.options].forEach(o => {
      if (!o.value) { o.textContent = `Tous les trains de l'offre (${allTrains.length})`; return; }
      o.dataset.base = o.dataset.base || o.textContent;
      o.textContent = `${o.dataset.base} (${counts[o.value] || 0})`;
    });
  }

  /* ---------- Favoris (localStorage) ---------- */
  const FAVS_KEY = 'tgvmax_radar_favs_v1';
  function getFavs() { try { return JSON.parse(localStorage.getItem(FAVS_KEY) || '[]'); } catch { return []; } }
  function saveFavs(f) { try { localStorage.setItem(FAVS_KEY, JSON.stringify(f.slice(0, 10))); } catch (e) {} renderFavs(); }
  function favSignature(p) { return `${p.mode}|${(p.station || p.from || '').toUpperCase()}|${(p.to || '').toUpperCase()}`; }
  function renderFavs() {
    const el = $('#favs');
    const favs = getFavs();
    el.hidden = !favs.length;
    el.innerHTML = favs.map((f, i) => {
      const label = f.mode === 'split' ? `✂️ ${prettyStation(f.from)} → ${prettyStation(f.to)}`
        : (f.mode === 'reverse' ? `🔄 vers ${prettyStation(f.station)}` : `🎯 depuis ${prettyStation(f.station)}`);
      return `<span class="fav-chip"><button type="button" data-fav="${i}" class="fav-go" title="Relancer cette recherche">${escapeHtml(label)}</button><button type="button" data-del="${i}" class="fav-del" title="Retirer des favoris">×</button></span>`;
    }).join('');
  }
  $('#favs').addEventListener('click', ev => {
    const favs = getFavs();
    const go = ev.target.closest('[data-fav]');
    const del = ev.target.closest('[data-del]');
    if (go) {
      const f = favs[Number(go.dataset.fav)];
      const form = document.querySelector(`.search-form[data-mode="${f.mode}"]`);
      if (f.mode === 'split') { form.querySelector('[name=from]').value = f.from; form.querySelector('[name=to]').value = f.to; }
      else { form.querySelector('[name=station]').value = f.station; }
      form.querySelector('[name=date]').value = f.date || todayISO();
      form.requestSubmit();
    } else if (del) {
      favs.splice(Number(del.dataset.del), 1);
      saveFavs(favs);
    }
  });
  document.querySelectorAll('.star-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const form = btn.closest('.search-form');
      const mode = form.dataset.mode;
      const fd = new FormData(form);
      const p = { mode, station: (fd.get('station') || '').trim(), from: (fd.get('from') || '').trim(), to: (fd.get('to') || '').trim() };
      if ((mode === 'split' && (!p.from || !p.to)) || (mode !== 'split' && !p.station)) { setStatus('Remplis d’abord ta recherche pour la mettre en favori ⭐', true); return; }
      const favs = getFavs();
      if (favs.some(f => favSignature(f) === favSignature(p))) { setStatus('Déjà dans tes favoris ⭐'); return; }
      favs.unshift(p);
      saveFavs(favs);
      setStatus('⭐ Ajouté à tes favoris ! Retrouve-le au-dessus des onglets.');
    });
  });

  /* ---------- Historique des recherches (8 dernières) ---------- */
  const HIST_KEY = 'tgvmax_radar_history_v1';
  function getHistory() { try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch { return []; } }
  function pushHistory(mode, params) {
    try {
      const h = getHistory().filter(x => !(x.mode === mode && (x.station || '') === (params.station || '') && (x.from || '') === (params.from || '') && (x.to || '') === (params.to || '')));
      h.unshift({ mode, ...params, ts: Date.now() });
      localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(0, 8)));
    } catch (e) {}
    renderHistory();
  }
  function renderHistory() {
    const el = $('#history-list');
    const h = getHistory();
    el.innerHTML = h.length ? h.map((x, i) => {
      const label = x.mode === 'split' ? `✂️ ${prettyStation(x.from)} → ${prettyStation(x.to)}`
        : (x.mode === 'reverse' ? `🔄 vers ${prettyStation(x.station)}` : `🎯 depuis ${prettyStation(x.station)}`);
      return `<button type="button" class="hist-item" data-hist="${i}" title="Relancer">${escapeHtml(label)} <span class="ac-sub">${fmtDateFR(x.date)}</span></button>`;
    }).join('') : '<span class="hint">Aucune recherche encore — l’historique apparaîtra ici.</span>';
  }
  $('#history-list').addEventListener('click', ev => {
    const b = ev.target.closest('[data-hist]');
    if (!b) return;
    const x = getHistory()[Number(b.dataset.hist)];
    const form = document.querySelector(`.search-form[data-mode="${x.mode}"]`);
    if (x.mode === 'split') { form.querySelector('[name=from]').value = x.from; form.querySelector('[name=to]').value = x.to; }
    else { form.querySelector('[name=station]').value = x.station; }
    form.querySelector('[name=date]').value = x.date;
    form.requestSubmit();
  });
  renderHistory();

  /* ---------- Partage d’une recherche (lien pré-rempli) ---------- */
  $('#status').addEventListener('click', async ev => {
    const btn = ev.target.closest('.share-btn');
    if (!btn || !lastSearch) return;
    const p = lastSearch.params;
    const u = new URL(location.href);
    u.search = '';
    u.searchParams.set('mode', lastSearch.mode);
    if (p.station) u.searchParams.set('station', p.station);
    if (p.from) u.searchParams.set('from', p.from);
    if (p.to) u.searchParams.set('to', p.to);
    u.searchParams.set('date', p.date);
    if (lastSearch.mode === 'split') { u.searchParams.set('hops', p.hops); u.searchParams.set('maxwait', p.maxwait); }
    const url = u.toString();
    try {
      if (navigator.share) { await navigator.share({ title: 'TGVmax Radar — ma recherche', url }); return; }
      await navigator.clipboard.writeText(url);
      btn.textContent = '✅ Lien copié !';
      setTimeout(() => { btn.textContent = '🔗 Partager cette recherche'; }, 2500);
    } catch (e) {
      btn.textContent = '⚠️ Copie impossible';
    }
  });

  document.querySelectorAll('.search-form').forEach(form => {
    form.addEventListener('submit', ev => {
      ev.preventDefault();
      const fd = new FormData(form);
      const mode = form.dataset.mode;
      const params = {
        date: fd.get('date'),
        station: (fd.get('station') || '').trim(),
        from: (fd.get('from') || '').trim(),
        to: (fd.get('to') || '').trim(),
        hops: Math.max(1, Math.min(4, Number(fd.get('hops')) || 1)),
        maxwait: Number(fd.get('maxwait')) || 360
      };
      if ((mode === 'split' && (!params.from || !params.to)) || (mode !== 'split' && !params.station)) return;
      lastSearch = { mode, params };
      bumpSearchCount();    // perso : +1 local
      bumpGlobalCount();    // global : +1 partagé entre tous les appareils (fire-and-forget)
      pushHistory(mode, params);
      doSearch(mode, params);
    });
  });

  /* ---------- Lien partagé : pré-remplissage depuis l'URL au chargement ---------- */
  function applySharedSearch() {
    let q;
    try { q = new URLSearchParams(location.search); } catch (e) { return; }
    if (![...q.keys()].length) return;
    const mode = (q.get('mode') || '').toLowerCase();
    if (!['classic', 'reverse', 'split'].includes(mode)) return;
    const form = document.querySelector('.search-form[data-mode="' + mode + '"]');
    if (!form) return;
    // Bascule sur le bon onglet
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === mode));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + mode));
    // Remplit le formulaire
    const station = (q.get('station') || '').trim();
    const from = (q.get('from') || '').trim();
    const to = (q.get('to') || '').trim();
    let date = q.get('date') || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < todayISO()) date = todayISO();
    if (mode === 'split') {
      form.querySelector('[name=from]').value = from;
      form.querySelector('[name=to]').value = to;
      form.querySelector('[name=hops]').value = String(Math.max(1, Math.min(4, Number(q.get('hops')) || 1)));
      form.querySelector('[name=maxwait]').value = String(Number(q.get('maxwait')) || 360);
    } else {
      form.querySelector('[name=station]').value = station;
    }
    form.querySelector('[name=date]').value = date;
    // Nettoie l'URL (le bouton Partager régénère un lien propre si besoin)
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
    // Relance la recherche si la saisie est plausible
    const fillable = mode === 'split' ? (from && to) : station;
    if (fillable) form.requestSubmit();
  }
  applySharedSearch();

  /* ============================================================
     SUIVI & HISTORIQUE DES DISPONIBILITÉS — 3 sources fusionnées :
     1) localStorage  (chaque visite / instantané manuel)
     2) data/history/*.json  (relevé nocturne automatique : GitHub Actions)
     3) Supabase  (sauvegarde en ligne optionnelle, rétro-compatible)
     Vues : 📈 courbes multi-séries · 🗓 calendrier (relevés × dates) · 📋 données.
     ============================================================ */
  const SB_CFG = window.TGV_SUPABASE || {};
  const sbReady = !!(SB_CFG.url && SB_CFG.anonKey && window.supabase);
  const sb = sbReady ? window.supabase.createClient(SB_CFG.url, SB_CFG.anonKey) : null;
  const WATCH_KEY = 'tgvmax_radar_watched_v1';
  const HISTO_KEY = 'tgvmax_radar_hist_v1';
  const REPO_NEW_FILE_URL = 'https://github.com/Jauj/tgvmax-radar/new/main?filename=data/watched.json';
  const SERIE_COLORS = ['#a1006b', '#2563eb', '#0e9f6e', '#d97706', '#7c3aed', '#0891b2', '#dc2626', '#65a30d'];
  const fmtDayShort = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
  const fmtDayFull = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });

  function updateSuiviUI() {
    const setup = document.getElementById('suivi-setup');
    const app = document.getElementById('suivi-app');
    if (app) app.hidden = false;
    if (setup && sbReady) {
      setup.innerHTML = '<p class="hint">☁️ <strong>Sauvegarde Supabase active</strong> — chaque instantané est aussi copié en ligne et fusionné dans les vues ci-dessous.</p>';
    }
  }
  updateSuiviUI();

  function getWatched() {
    try { return JSON.parse(localStorage.getItem(WATCH_KEY) || '[]'); } catch (e) { return []; }
  }
  function saveWatched(w) { try { localStorage.setItem(WATCH_KEY, JSON.stringify(w.slice(0, 8))); } catch (e) {} }

  /* ---------- Stockage local de l'historique ---------- */
  let HIST = (function () {
    try {
      const j = JSON.parse(localStorage.getItem(HISTO_KEY) || '{}');
      if (j && j.segs && typeof j.segs === 'object') return j;
    } catch (e) {}
    return { v: 1, segs: {} };
  })();
  let histSaveTimer = null;
  function histSave() {
    clearTimeout(histSaveTimer);
    histSaveTimer = setTimeout(() => {
      try { histPrune(HIST, todayISO()); localStorage.setItem(HISTO_KEY, JSON.stringify(HIST)); } catch (e) {}
    }, 200);
  }
  /** Enregistre (ou met à jour) le relevé du jour pour un tronçon */
  function histRecord(from, to, forDate, count) {
    if (!from || !to || !forDate) return;
    const key = segKeyOf(from, to);
    const seg = HIST.segs[key] || (HIST.segs[key] = { from, to, days: {} });
    seg.from = from; seg.to = to;
    histMergeDay(seg.days, todayISO(), { ts: Date.now(), perDate: { [forDate]: count } });
    histPrune(HIST, todayISO());
    histSave();
  }
  function histExportJson() { return JSON.stringify({ v: 1, exported: new Date().toISOString(), segs: HIST.segs }, null, 1); }
  function histImportJson(json) {
    if (!json || typeof json !== 'object' || !json.segs || typeof json.segs !== 'object') throw new Error('Fichier non reconnu (structure attendue : { segs: … })');
    for (const [k, seg] of Object.entries(json.segs)) {
      if (!seg || typeof seg !== 'object' || !seg.days) continue;
      const cur = HIST.segs[k] || (HIST.segs[k] = { from: seg.from || k.split('>')[0] || '?', to: seg.to || k.split('>')[1] || '?', days: {} });
      for (const [d, rec] of Object.entries(seg.days)) histMergeDay(cur.days, d, rec);
    }
    histPrune(HIST, todayISO());
    histSave();
  }

  /* ---------- Source 2 : relevés nocturnes du dépôt ---------- */
  let REMOTE_META = { segments: [], lastRun: null };
  const remoteCache = new Map();   // segKey -> { days, at }
  const mergedCache = new Map();   // segKey -> { days, at } (fusion des 3 sources)
  const REMOTE_TTL = 5 * 60 * 1000;

  async function loadRemoteMeta() {
    try {
      const r = await fetch('data/history/_meta.json?_=' + Date.now(), { headers: { Accept: 'application/json' } });
      if (r.ok) {
        const j = await r.json();
        REMOTE_META = { segments: Array.isArray(j.segments) ? j.segments : [], lastRun: j.lastRun || null };
      }
    } catch (e) {}
  }

  async function fetchRemoteDays(from, to) {
    const key = segKeyOf(from, to);
    const c = remoteCache.get(key);
    if (c && Date.now() - c.at < REMOTE_TTL) return c.days;
    try {
      const r = await fetch('data/history/' + slugOf(from, to) + '.json?_=' + Date.now(), { headers: { Accept: 'application/json' } });
      if (!r.ok) return null;
      const j = await r.json();
      const days = (j && j.days) || {};
      remoteCache.set(key, { days, at: Date.now() });
      return days;
    } catch (e) { return null; }
  }

  /* ---------- Source 3 : Supabase (optionnel, rétro-compatible) ---------- */
  async function fetchSupaDays(from, to) {
    if (!sb) return null;
    try {
      const { data, error } = await sb.from('route_snapshots')
        .select('captured_at, for_date, oui_count')
        .eq('route_from', from).eq('route_to', to)
        .order('captured_at', { ascending: true }).limit(2000);
      if (error) return null;
      const days = {};
      for (const r of data || []) {
        const d = new Date(r.captured_at);
        histMergeDay(days, dateToISO(d), { ts: d.getTime(), perDate: { [r.for_date]: r.oui_count } });
      }
      return days;
    } catch (e) { return null; }
  }

  /** Fusion des 3 sources (le local, plus frais, gagne les égalités) */
  async function collectDays(from, to) {
    const key = segKeyOf(from, to);
    const c = mergedCache.get(key);
    if (c && Date.now() - c.at < 60 * 1000) return c.days;
    const [remote, supa] = await Promise.all([fetchRemoteDays(from, to), fetchSupaDays(from, to)]);
    const days = {};
    for (const src of [remote || {}, supa || {}, HIST.segs[key] ? HIST.segs[key].days : {}]) {
      for (const [d, rec] of Object.entries(src || {})) histMergeDay(days, d, rec);
    }
    mergedCache.set(key, { days, at: Date.now() });
    return days;
  }

  /* ---------- Instantané (local d'abord, Supabase en bonus) ---------- */
  async function takeSnapshot(from, to, forDate) {
    const trains = await fetchDay(forDate);
    const directs = searchDirect(trains, from, to, cityIndex);
    const itins = searchMultiSplit(trains, from, to, { maxHops: 4, maxConn: 360, cityIndex });
    const row = { route_from: from, route_to: to, for_date: forDate, oui_count: directs.length, itins_count: itins.length };
    histRecord(from, to, forDate, directs.length); // toujours, même sans Supabase
    if (sb) {
      try { await sb.from('route_snapshots').insert(row); } catch (e) {}
    }
    return row;
  }

  /* ---------- Moteur graphique SVG multi-séries (sans dépendance) ---------- */
  function svgLinesChart(series) {
    const allPts = [];
    for (const s of series) for (const p of s.points) allPts.push({ d: p.d, y: Number(p.y) || 0 });
    if (!allPts.length) return '';
    const dMin = allPts.reduce((m, p) => (p.d < m ? p.d : m), allPts[0].d);
    const dMax = allPts.reduce((m, p) => (p.d > m ? p.d : m), allPts[0].d);
    const span = Math.max(1, dayDiff(dMin, dMax));
    const yMax = niceMax(Math.max(1, ...allPts.map(p => p.y)));
    const W = 680, H = 280, PL = 40, PR = 14, PT = 16, PB = 30;
    const X = d => PL + (Math.max(0, Math.min(span, dayDiff(dMin, d))) / span) * (W - PL - PR);
    const Y = v => H - PB - (v / yMax) * (H - PT - PB);
    let grid = '';
    for (let i = 0; i <= 4; i++) {
      const v = Math.round(yMax * i / 4), y = Y(v).toFixed(1);
      grid += `<line x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}" stroke="var(--border)" stroke-width="1"/>`
        + `<text x="${PL - 6}" y="${Number(y) + 4}" font-size="11" text-anchor="end" fill="var(--muted)">${v}</text>`;
    }
    let xTicks = '';
    for (let i = 0; i <= 4; i++) {
      const d = addDaysISO(dMin, Math.round(span * i / 4));
      const anchor = i === 0 ? 'start' : (i === 4 ? 'end' : 'middle');
      xTicks += `<text x="${X(d).toFixed(1)}" y="${H - 8}" font-size="10.5" text-anchor="${anchor}" fill="var(--muted)">${fmtDayShort.format(new Date(d + 'T00:00:00'))}</text>`;
    }
    const paths = series.map(s => {
      const pts = s.points.slice().sort((a, b) => (a.d < b.d ? -1 : 1));
      if (!pts.length) return '';
      const line = pts.map((p, i) => (i ? 'L' : 'M') + X(p.d).toFixed(1) + ' ' + Y(p.y).toFixed(1)).join(' ');
      const dots = pts.map(p =>
        `<circle cx="${X(p.d).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="3.4" fill="${s.color}" stroke="var(--card)" stroke-width="1"><title>${p.d} : ${p.y} train(s)</title></circle>`).join('');
      return `<path d="${line}" fill="none" stroke="${s.color}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" opacity=".92"/>${dots}`;
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Évolution du nombre de trains disponibles" style="width:100%;height:auto;background:var(--card);border:1px solid var(--border);border-radius:var(--radius-sm)">${grid}${xTicks}${paths}</svg>`;
  }

  function emptyHistHtml() {
    return `<div class="setup-box"><h2>🚉 Aucun relevé pour ce tronçon</h2><p>Choisis un tronçon ci-dessus, une date, puis clique <strong>📸 Instantané</strong>. Reviens demain (ou laisse le snapshot automatique agir) : la courbe se dessine au fil des relevés.</p></div>`;
  }

  /* ---------- Vue calendrier : relevés (colonnes) × dates de voyage (lignes) ---------- */
  function renderHeat(el, days) {
    const today = todayISO();
    const dayKeys = histSeries(days).map(s => s.day);
    if (!dayKeys.length) { el.innerHTML = emptyHistHtml(); return; }
    const tSet = new Set();
    for (const d of dayKeys) for (const t of Object.keys(days[d].perDate || {})) {
      if (t >= today && dayDiff(today, t) <= 31) tSet.add(t);
    }
    let travelDates = [...tSet].sort();
    if (!travelDates.length) {
      // historique ancien uniquement : dates de voyage les plus récentes
      for (const d of dayKeys) for (const t of Object.keys(days[d].perDate || {})) tSet.add(t);
      travelDates = [...tSet].sort().slice(-31);
    }
    if (!travelDates.length) { el.innerHTML = emptyHistHtml(); return; }
    const head = dayKeys.map((d, i) =>
      `<div class="hm-head${i % 2 ? '' : ' show'}" title="Relevé du ${d}">${d.slice(8, 10)}/${d.slice(5, 7)}</div>`).join('');
    const rows = travelDates.map(t => {
      const cells = dayKeys.map(d => {
        const n = days[d].perDate[t];
        const label = escapeHtml(fmtDayFull.format(new Date(t + 'T00:00:00')));
        const title = n == null ? `${d} · ${label} : pas de relevé` : `${d} · ${label} : ${n} train(s) direct(s)`;
        return `<div class="hm-cell ${hmClass(n)}" title="${escapeHtml(title)}">${n == null ? '' : n}</div>`;
      }).join('');
      return `<div class="hm-row"><div class="hm-label" title="${t}">${escapeHtml(fmtDayFull.format(new Date(t + 'T00:00:00')))}</div>${cells}</div>`;
    }).join('');
    el.innerHTML = `
      <div class="hm-scroll">
        <div class="hm-grid" style="grid-template-columns:max-content repeat(${dayKeys.length}, 27px)">
          <div class="hm-head hm-corner"></div>${head}
          ${rows}
        </div>
      </div>
      <div class="hm-legend">Places directes :
        <span class="hm-swatch hm-0"></span>0
        <span class="hm-swatch hm-1"></span>1–2
        <span class="hm-swatch hm-2"></span>3–5
        <span class="hm-swatch hm-3"></span>6–9
        <span class="hm-swatch hm-4"></span>10+
        <span class="hm-swatch hm-x"></span>pas de relevé
      </div>`;
  }

  /* ---------- Vue données : tableau croisé + exports ---------- */
  function download(name, content, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  function histCSV(segsDays) {
    const rows = ['troncon;releve;date_voyage;trains_directs'];
    for (const s of segsDays) {
      const label = prettyStation(s.from) + ' -> ' + prettyStation(s.to);
      for (const day of Object.keys(s.days).sort()) {
        const pd = s.days[day].perDate || {};
        for (const t of Object.keys(pd).sort()) rows.push([label, day, t, pd[t]].join(';'));
      }
    }
    return '\ufeff' + rows.join('\n');
  }
  function renderDataTable(el, segsDays) {
    if (!segsDays.length) { el.innerHTML = emptyHistHtml(); return; }
    if (segsDays.length === 1) {
      const s = segsDays[0];
      const dayKeys = histSeries(s.days).map(x => x.day).reverse().slice(0, 60);
      const today = todayISO();
      const tSet = new Set();
      for (const d of dayKeys) for (const t of Object.keys(s.days[d].perDate || {})) if (t >= today) tSet.add(t);
      let travelDates = [...tSet].sort().slice(0, 14);
      if (!travelDates.length) {
        for (const d of dayKeys) for (const t of Object.keys(s.days[d].perDate || {})) tSet.add(t);
        travelDates = [...tSet].sort().slice(0, 14);
      }
      if (!travelDates.length) { el.innerHTML = emptyHistHtml(); return; }
      let html = '<div class="tbl-scroll"><table class="hist-table"><thead><tr><th>Relevé ↓ · voyage →</th>'
        + travelDates.map(t => `<th title="${t}">${t.slice(8, 10)}/${t.slice(5, 7)}</th>`).join('') + '<th>Σ</th></tr></thead><tbody>';
      for (const d of dayKeys) {
        const pd = s.days[d].perDate || {};
        let sum = 0;
        const cells = travelDates.map(t => { const n = pd[t]; if (n != null) sum += Number(n) || 0; return `<td class="${hmClass(n == null ? '' : n)}">${n == null ? '·' : n}</td>`; }).join('');
        html += `<tr><th>${d.slice(8, 10)}/${d.slice(5, 7)}</th>${cells}<td class="sum">${sum || '·'}</td></tr>`;
      }
      html += '</tbody></table></div>';
      el.innerHTML = html;
      return;
    }
    let html = '<div class="tbl-scroll"><table class="hist-table"><thead><tr><th>Relevé</th>'
      + segsDays.map((s, i) => `<th class="seg-col" style="color:${SERIE_COLORS[i % SERIE_COLORS.length]}">${escapeHtml(prettyStation(s.from))} → ${escapeHtml(prettyStation(s.to))}</th>`).join('') + '</tr></thead><tbody>';
    const allDays = [...new Set(segsDays.flatMap(s => Object.keys(s.days)))].sort().reverse().slice(0, 60);
    for (const d of allDays) {
      html += `<tr><th>${d.slice(8, 10)}/${d.slice(5, 7)}</th>${segsDays.map(s => {
        const rec = s.days[d];
        return `<td>${rec ? rec.total : '·'}</td>`;
      }).join('')}</tr>`;
    }
    html += '</tbody></table></div>';
    el.innerHTML = html;
  }

  /* ---------- État de la vue + rendu d'ensemble ---------- */
  const histState = { sel: [], view: 'curves', range: '30', activeDates: new Set() };

  function allKnownSegments() {
    const map = new Map();
    for (const w of getWatched()) {
      const k = segKeyOf(w.from, w.to);
      if (!map.has(k)) map.set(k, { from: w.from, to: w.to, src: 'suivi' });
    }
    for (const [k, seg] of Object.entries(HIST.segs)) {
      if (!map.has(k)) map.set(k, { from: seg.from, to: seg.to, src: 'local' });
    }
    for (const s of REMOTE_META.segments || []) {
      const k = segKeyOf(s.from, s.to);
      if (!map.has(k)) map.set(k, { from: s.from, to: s.to, src: 'robot' });
    }
    return map;
  }

  function renderSegChips() {
    const el = document.getElementById('hist-segments');
    const segs = [...allKnownSegments().entries()];
    if (!segs.length) { el.innerHTML = '<span class="hint">Aucun tronçon encore — fais ton premier relevé ci-dessus 👆</span>'; return; }
    el.innerHTML = segs.map(([k, s]) => {
      const on = histState.sel.includes(k);
      const icon = s.src === 'robot' ? '🤖' : (s.src === 'suivi' ? '👁️' : '📝');
      return `<button type="button" class="seg-chip${on ? ' active' : ''}" data-seg="${escapeHtml(k)}" title="Comparer / afficher ce tronçon">${icon} ${escapeHtml(prettyStation(s.from))} → ${escapeHtml(prettyStation(s.to))}</button>`;
    }).join('');
  }

  function renderStats(segsDays) {
    const el = document.getElementById('hist-stats');
    if (!el) return;
    if (segsDays.length !== 1) {
      el.innerHTML = segsDays.length ? `<span class="stat-pill">🔀 <b>${segsDays.length}</b> tronçons comparés</span>` : '';
      return;
    }
    const s = segsDays[0];
    const series = histSeries(s.days);
    if (!series.length) { el.innerHTML = ''; return; }
    const last = series[series.length - 1];
    const weekAgo = addDaysISO(last.day, -7);
    let ref = null;
    for (const r of series) if (r.day <= weekAgo) ref = r; // dernier relevé ≤ J-7
    const delta = ref ? last.total - ref.total : null;
    const best = series.reduce((a, b) => (b.total > a.total ? b : a), series[0]);
    const trend = delta == null ? '' : (delta > 0 ? `📈 <b>+${delta}</b> en 7 j` : (delta < 0 ? `📉 <b>${delta}</b> en 7 j` : '➖ stable en 7 j'));
    el.innerHTML = [
      `<span class="stat-pill">📸 dernier relevé : <b>${escapeHtml(fmtDayShort.format(new Date(last.day + 'T00:00:00')))}</b></span>`,
      `<span class="stat-pill">🎫 trains dispo (fenêtre) : <b>${last.total}</b></span>`,
      trend ? `<span class="stat-pill">${trend}</span>` : '',
      `<span class="stat-pill">🏆 record : <b>${best.total}</b> le ${escapeHtml(fmtDayShort.format(new Date(best.day + 'T00:00:00')))}</span>`,
      `<span class="stat-pill">🗂 <b>${series.length}</b> relevé(s)</span>`
    ].join('');
  }

  function renderLegend(items) {
    return `<div class="legend-chips">${items.map(it =>
      `<span class="legend-chip"><span class="dot" style="background:${it.color}"></span>${escapeHtml(it.label)}</span>`).join('')}</div>`;
  }

  /** Courbes : 1 tronçon = séries par date de voyage · plusieurs tronçons = comparaison des totaux */
  function renderCurves(el, segsDays) {
    const note = document.getElementById('hist-note');
    const multi = document.getElementById('hist-multidate');
    if (!segsDays.length) { el.innerHTML = ''; multi.hidden = true; if (note) note.textContent = ''; return; }
    if (segsDays.length > 1) {
      multi.hidden = true;
      const series = segsDays.map((s, i) => ({
        name: prettyStation(s.from) + ' → ' + prettyStation(s.to),
        color: SERIE_COLORS[i % SERIE_COLORS.length],
        points: histSeries(s.days).map(r => ({ d: r.day, y: r.total }))
      })).filter(s => s.points.length);
      el.innerHTML = svgLinesChart(series) + renderLegend(series.map(s => ({ label: s.name, color: s.color })));
      if (note) note.textContent = 'Comparaison : total des trains directs disponibles (toutes dates de voyage de la fenêtre) à chaque relevé.';
      return;
    }
    const s = segsDays[0];
    const today = todayISO();
    const series0 = histSeries(s.days);
    const tCount = new Map(); // date de voyage -> dernier jour où elle a été relevée
    for (const r of series0) for (const t of Object.keys(r.perDate)) tCount.set(t, r.day);
    let candidates = [...tCount.keys()].filter(t => t >= today).sort();
    if (!candidates.length) candidates = [...tCount.keys()].sort().slice(-8);
    if (histState.activeDates.size) {
      histState.activeDates = new Set([...histState.activeDates].filter(t => candidates.includes(t)));
    }
    if (!histState.activeDates.size) candidates.slice(0, 3).forEach(t => histState.activeDates.add(t));
    multi.hidden = false;
    // Les dates actives restent toujours visibles, même au-delà des 10 premières
    const shown = [...new Set([...candidates.slice(0, 10), ...histState.activeDates])]
      .filter(t => candidates.includes(t)).sort().slice(0, 14);
    multi.innerHTML = '<span class="md-title">Dates de voyage :</span>' + shown.map(t =>
      `<button type="button" class="md-chip${histState.activeDates.has(t) ? ' active' : ''}" data-mdate="${t}">${escapeHtml(fmtDayShort.format(new Date(t + 'T00:00:00')))}</button>`).join('');
    const series = candidates.filter(t => histState.activeDates.has(t)).map((t, i) => ({
      name: fmtDayFull.format(new Date(t + 'T00:00:00')),
      color: SERIE_COLORS[i % SERIE_COLORS.length],
      points: series0.filter(r => r.perDate[t] != null).map(r => ({ d: r.day, y: r.perDate[t] }))
    })).filter(x => x.points.length);
    el.innerHTML = series.length
      ? svgLinesChart(series) + renderLegend(series.map(x => ({ label: x.name, color: x.color })))
      : emptyHistHtml();
    if (note) note.textContent = 'Chaque courbe = une date de voyage ; les bosses = des places revenues à la vente. Coche d\u2019autres dates pour superposer.';
  }

  async function renderHistUI() {
    const viz = document.getElementById('hist-viz');
    if (!viz) return;
    const segs = allKnownSegments();
    if (!histState.sel.length) {
      const first = segs.keys().next();
      if (!first.done) histState.sel = [first.value];
    }
    histState.sel = histState.sel.filter(k => segs.has(k));
    renderSegChips();
    if (!histState.sel.length) {
      viz.innerHTML = emptyHistHtml();
      document.getElementById('hist-stats').innerHTML = '';
      document.getElementById('hist-multidate').hidden = true;
      return;
    }
    const segsDays = [];
    for (const k of histState.sel.slice(0, 6)) {
      const s = segs.get(k);
      let days = await collectDays(s.from, s.to);
      if (histState.range !== 'all') {
        const min = addDaysISO(todayISO(), -Number(histState.range));
        days = Object.fromEntries(Object.entries(days).filter(([d]) => d >= min));
      }
      segsDays.push({ from: s.from, to: s.to, days });
    }
    renderStats(segsDays);
    if (histState.view === 'heat') {
      document.getElementById('hist-multidate').hidden = true;
      if (segsDays.length === 1) renderHeat(viz, segsDays[0].days);
      else {
        viz.innerHTML = '<p class="hint">🗓 La vue calendrier s\u2019applique à un seul tronçon — décoche pour n\u2019en garder qu\u2019un, ou compare en vue 📈 Courbes.</p>';
        document.getElementById('hist-note').textContent = '';
      }
    } else if (histState.view === 'data') {
      document.getElementById('hist-multidate').hidden = true;
      renderDataTable(viz, segsDays);
      document.getElementById('hist-note').textContent = 'Σ = total de trains directs disponibles (toutes dates de voyage) à chaque relevé.';
    } else {
      renderCurves(viz, segsDays);
    }
  }
  function refreshHistUI() {
    for (const k of histState.sel) mergedCache.delete(k);
    renderHistUI();
  }

  /* ---------- Interactions de la barre d'outils ---------- */
  document.getElementById('hist-segments').addEventListener('click', ev => {
    const chip = ev.target.closest('[data-seg]');
    if (!chip) return;
    const k = chip.dataset.seg;
    if (histState.sel.includes(k)) {
      histState.sel = histState.sel.filter(x => x !== k);
    } else {
      if (histState.view === 'heat' || !histState.sel.length) histState.sel = [k];
      else histState.sel = [...histState.sel, k].slice(0, 6);
    }
    renderSegChips();
    renderHistUI();
  });
  document.getElementById('hist-range').addEventListener('change', ev => {
    histState.range = ev.target.value;
    renderHistUI();
  });
  document.querySelectorAll('.hist-viewbtn').forEach(b => b.addEventListener('click', () => {
    histState.view = b.dataset.view;
    document.querySelectorAll('.hist-viewbtn').forEach(x => x.classList.toggle('active', x === b));
    renderHistUI();
  }));
  document.getElementById('hist-multidate').addEventListener('click', ev => {
    const chip = ev.target.closest('[data-mdate]');
    if (!chip) return;
    const t = chip.dataset.mdate;
    if (histState.activeDates.has(t)) histState.activeDates.delete(t);
    else histState.activeDates.add(t);
    renderHistUI();
  });

  /* ---------- Formulaire : instantané manuel ---------- */
  document.querySelector('.search-form[data-mode="suivi"]').addEventListener('submit', async ev => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const from = (fd.get('from') || '').trim(), to = (fd.get('to') || '').trim(), forDate = fd.get('date');
    if (!from || !to || !forDate) { setStatus('Remplis le départ, l\u2019arrivée et la date 🙏', true); return; }
    const btn = ev.target.querySelector('.submit-btn');
    btn.disabled = true;
    setStatus(randomJoke());
    try {
      const row = await takeSnapshot(from, to, forDate);
      setStatus(`📸 Instantané enregistré : <strong>${row.oui_count}</strong> direct(s) pour le ${fmtDateFR(forDate)}${sb ? ' · sauvegardé en ligne aussi' : ''}.`);
      histState.sel = [segKeyOf(from, to)];
      histState.activeDates = new Set([forDate]);
      refreshHistUI();
    } catch (e) { setStatus('❌ ' + escapeHtml(e.message || e), true); }
    btn.disabled = false;
  });

  document.getElementById('watch-btn').addEventListener('click', async () => {
    const form = document.querySelector('.search-form[data-mode="suivi"]');
    const fd = new FormData(form);
    const from = (fd.get('from') || '').trim(), to = (fd.get('to') || '').trim(), forDate = fd.get('date');
    if (!from || !to || !forDate) { setStatus('Remplis le trajet et la date à surveiller', true); return; }
    const w = getWatched();
    if (!w.some(x => norm(x.from) === norm(from) && norm(x.to) === norm(to))) { w.unshift({ from, to, forDate }); saveWatched(w); }
    setStatus(`👁️ ${escapeHtml(prettyStation(from))} → ${escapeHtml(prettyStation(to))} est suivi : un instantané sera pris à chaque visite du site (1× par 12 h).`);
    try { await takeSnapshot(from, to, forDate); histState.sel = [segKeyOf(from, to)]; refreshHistUI(); } catch (e) {}
    renderSegChips();
  });

  /* ---------- Auto-instantanés des trajets suivis (1× par 12 h, max 3 par visite) ---------- */
  (async function autoSnapshots() {
    const THROTTLE_KEY = 'tgvmax_radar_throttle_v1';
    let last = {};
    try { last = JSON.parse(localStorage.getItem(THROTTLE_KEY) || '{}'); } catch (e) {}
    const watched = getWatched().slice(0, 3);
    let captured = false;
    for (const route of watched) {
      const sig = `${norm(route.from)}>${norm(route.to)}>${route.forDate}`;
      if (Date.now() - (last[sig] || 0) < 12 * 3600 * 1000) continue;
      try { await takeSnapshot(route.from, route.to, route.forDate); last[sig] = Date.now(); captured = true; } catch (e) {}
    }
    try { localStorage.setItem(THROTTLE_KEY, JSON.stringify(last)); } catch (e) {}
    if (captured) refreshHistUI();
  })();

  /* ---------- Snapshot quotidien : statut + watched.json + export/import/purge ---------- */
  function renderSyncStatus() {
    const el = document.getElementById('hist-sync-status');
    if (!el) return;
    const n = (REMOTE_META.segments || []).length;
    el.innerHTML = REMOTE_META.lastRun
      ? `🤖 <strong>Snapshot automatique actif</strong> — dernier relevé ${escapeHtml(new Date(REMOTE_META.lastRun).toLocaleString('fr-FR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }))}, ${n} tronçon(s) dans <code>data/watched.json</code>.`
      : '🤖 Snapshot automatique : <strong>pas encore actif</strong> — « Préparer watched.json » ci-dessous l\u2019active en 1 minute (un relevé chaque nuit à 6 h 45).';
  }

  async function buildWatchedJson() {
    const list = [];
    const push = (from, to) => {
      if (from && to && !list.some(x => segKeyOf(x.from, x.to) === segKeyOf(from, to))) list.push({ from, to });
    };
    for (const w of getWatched()) push(w.from, w.to);
    for (const seg of Object.values(HIST.segs)) push(seg.from, seg.to);
    for (const s of REMOTE_META.segments || []) push(s.from, s.to);
    return JSON.stringify(list, null, 2);
  }

  document.getElementById('hist-copy-watched').addEventListener('click', async () => {
    const json = await buildWatchedJson();
    try {
      await navigator.clipboard.writeText(json);
      setStatus('📋 <code>watched.json</code> copié ! Colle-le dans le dépôt GitHub (l\u2019onglet d\u2019ajout de fichier s\u2019ouvre : colle puis Commit).');
    } catch (e) {
      download('watched.json', json, 'application/json');
      setStatus('📋 Le fichier <code>watched.json</code> a été téléchargé — dépose-le dans le dossier <code>data/</code> du dépôt.');
    }
    try { window.open(REPO_NEW_FILE_URL, '_blank', 'noopener'); } catch (e) {}
  });

  document.getElementById('hist-export').addEventListener('click', () => {
    if (!Object.keys(HIST.segs).length) { setStatus('Historique local vide — rien à exporter.', true); return; }
    download('tgvmax-radar-historique.json', histExportJson(), 'application/json');
    setStatus('⬇️ Historique local exporté (JSON).');
  });

  document.getElementById('hist-import').addEventListener('click', () => document.getElementById('hist-import-file').click());
  document.getElementById('hist-import-file').addEventListener('change', ev => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        histImportJson(JSON.parse(String(reader.result)));
        setStatus('⬆️ Historique importé et fusionné ✅');
        refreshHistUI();
      } catch (e) { setStatus('❌ Import impossible : ' + escapeHtml(e.message || e), true); }
    };
    reader.readAsText(file);
    ev.target.value = '';
  });

  document.getElementById('hist-clear').addEventListener('click', () => {
    if (!confirm('Effacer tout l\u2019historique local de ce navigateur ? (Les relevés du dépôt et de Supabase ne sont pas touchés.)')) return;
    HIST = { v: 1, segs: {} };
    try { localStorage.removeItem(HISTO_KEY); } catch (e) {}
    refreshHistUI();
    setStatus('🗑 Historique local effacé.');
  });

  /* ---------- Initialisation : meta du dépôt puis premier rendu ---------- */
  loadRemoteMeta().then(() => { renderSyncStatus(); renderHistUI(); });
  renderHistUI();
  // Re-rendu à chaque ouverture de l'onglet Suivi (coût nul grâce aux caches)
  document.querySelector('.tab[data-tab="suivi"]').addEventListener('click', () => { renderHistUI(); renderSyncStatus(); });
}
