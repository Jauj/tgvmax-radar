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
function todayISO() { return new Date().toISOString().slice(0, 10); }
function addDaysISO(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
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

/* ---------------- API SNCF ---------------- */
const dayCache = new Map();
async function fetchDay(dateISO) {
  if (dayCache.has(dateISO)) return dayCache.get(dateISO);
  const url = `${API_BASE}?dataset=${DATASET}&rows=10000`
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
/** Toutes les destinations atteignables depuis une gare/ville (hors trains intra-gare) */
function searchClassic(trains, from, cityIndex) {
  const fromSet = expandStationLabel(from, cityIndex);
  return groupBySorted(
    findByOrigin(trains, fromSet).filter(t => !fromSet.has(norm(t.destination))),
    t => t.destination
  );
}
/** Toutes les origines qui desservent une gare/ville (hors trains intra-gare) */
function searchReverse(trains, to, cityIndex) {
  const toSet = expandStationLabel(to, cityIndex);
  return groupBySorted(
    findByDest(trains, toSet).filter(t => !toSet.has(norm(t.origine))),
    t => t.origine
  );
}
/** Trains directs entre deux gares/villes */
function searchDirect(trains, from, to, cityIndex) {
  const fromSet = expandStationLabel(from, cityIndex), toSet = expandStationLabel(to, cityIndex);
  return findByOrigin(trains, fromSet)
    .filter(t => toSet.has(norm(t.destination)) && norm(t.origine) !== norm(t.destination))
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
        // Clôture : p.hub → B
        for (const t of outs) {
          if (!toSet.has(norm(t.destination))) continue;
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
    buildCityIndex, expandStationLabel
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
  function plotPoints(points, lines) {
    const el = document.getElementById('map');
    const pts = points.filter(p => p.coord);
    const lns = (lines || [])
      .map(l => ({ ...l, coords: (l.coords || []).filter(Boolean) }))
      .filter(l => l.coords.length >= 2);
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
    if (bounds.length === 1) map.setView(bounds[0], 6);
    else map.fitBounds(bounds, { padding: [40, 40] });
    setTimeout(() => map.invalidateSize(), 50);
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

  function setStatus(msg, isError) {
    const el = $('#status');
    el.hidden = !msg;
    el.classList.toggle('error', !!isError);
    el.innerHTML = msg || '';
  }

  function trainRow(t) {
    const axe = t.axe ? ` <span class="axe">· ${escapeHtml(t.axe)}</span>` : '';
    const det = t.train_no
      ? `<span class="train-details" hidden>🚆 n° ${escapeHtml(t.train_no)} · ${escapeHtml(t.origine_iata || '?')} → ${escapeHtml(t.destination_iata || '?')}${t.axe ? ' · ' + escapeHtml(t.axe) : ''}</span>`
      : '';
    return `<div class="train-row"${t.train_no ? ' title="Cliquer pour voir le n° de train"' : ''}>🕐 ${escapeHtml(t.heure_depart || '?')} → ${escapeHtml(t.heure_arrivee || '?')}${axe}${det}</div>`;
  }
  function legRow(t) {
    const axe = t.axe ? ` <span class="axe">· ${escapeHtml(t.axe)}</span>` : '';
    const det = t.train_no
      ? `<span class="train-details" hidden>🚆 n° ${escapeHtml(t.train_no)} · ${escapeHtml(t.origine_iata || '?')} → ${escapeHtml(t.destination_iata || '?')}</span>`
      : '';
    return `<div class="train-row"${t.train_no ? ' title="Cliquer pour voir le n° de train"' : ''}>🕐 ${escapeHtml(t.heure_depart)} → ${escapeHtml(t.heure_arrivee)} · ${escapeHtml(prettyStation(t.origine))} → ${escapeHtml(prettyStation(t.destination))}${axe}${det}</div>`;
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
      setStatus('⏳ Interrogation des données SNCF…');
      const allTrains = await fetchDay(date);
      // Enrichit le pool de gares + reconstruit l'index villes si besoin
      let stationsChanged = false;
      const addName = n => { if (n && !allStations.includes(n)) { allStations.push(n); stationsChanged = true; } };
      addName(params.from); addName(params.to); addName(params.station);
      allTrains.forEach(t => { addName(t.origine); addName(t.destination); });
      if (stationsChanged || !cityIndex) { cityIndex = buildCityIndex(allStations); rebuildSuggestions(); }

      const trains = axeFilter ? allTrains.filter(t => axeCategory(t.axe) === axeFilter) : allTrains;

      if (!trains.length) {
        document.getElementById('map').hidden = true;
        $('#results').innerHTML = '';
        setStatus(allTrains.length && axeFilter
          ? `Aucun train « ${escapeHtml(axeFilter)} » réservable le ${fmtDateFR(date)} (il y a ${allTrains.length} places sur d'autres types de trains — change de filtre).`
          : `Aucune place Max Jeunes trouvée pour le <strong>${fmtDateFR(date)}</strong>. Soit tout est complet, soit la date est hors fenêtre de réservation (${BOOKING_WINDOW_DAYS} jours).`, true);
        return;
      }
      const filterTag = axeFilter ? ` · filtre : <strong>${escapeHtml(axeFilter)}</strong>` : '';

      let html = '';
      const points = [];
      const lines = [];

      if (mode === 'classic') {
        const groups = searchClassic(trains, params.station, cityIndex);
        if (!groups.length) {
          $('#results').innerHTML = '';
          setStatus(`Aucune place depuis « ${escapeHtml(params.station)} » le ${fmtDateFR(date)}. Vérifie l'orthographe de la gare (les gares parisiennes = « PARIS (intramuros) »).`, true);
          return;
        }
        setStatus(`✅ <strong>${trains.length}</strong> trains réservables le ${fmtDateFR(date)} — destinations depuis <strong>${escapeHtml(prettyStation(params.station))}</strong>${filterTag} :`);
        html = renderGroups('🎯 Depuis ' + escapeHtml(prettyStation(params.station)), groups, params.station, date);
        const originCoord = getKnownCoord(params.station);
        points.push({ coord: originCoord, label: prettyStation(params.station), info: 'Départ', color: '#2563eb', major: true });
        groups.forEach(g => {
          const c = getKnownCoord(g.station);
          points.push({ coord: c, label: prettyStation(g.station), info: `${g.trains.length} train(s) TGVmax` });
          if (originCoord && c) lines.push({ coords: [originCoord, c] });
        });
      }

      if (mode === 'reverse') {
        const groups = searchReverse(trains, params.station, cityIndex);
        if (!groups.length) {
          $('#results').innerHTML = '';
          setStatus(`Aucune place vers « ${escapeHtml(params.station)} » le ${fmtDateFR(date)}. Vérifie l'orthographe (ex. « NICE VILLE »).`, true);
          return;
        }
        setStatus(`✅ <strong>${trains.length}</strong> trains réservables le ${fmtDateFR(date)} — origines pour arriver à <strong>${escapeHtml(prettyStation(params.station))}</strong>${filterTag} :`);
        html = renderGroups('🔄 Vers ' + escapeHtml(prettyStation(params.station)), groups, params.station, date);
        const destCoord = getKnownCoord(params.station);
        points.push({ coord: destCoord, label: prettyStation(params.station), info: 'Arrivée', color: '#2563eb', major: true });
        groups.forEach(g => {
          const c = getKnownCoord(g.station);
          points.push({ coord: c, label: prettyStation(g.station), info: `${g.trains.length} train(s) TGVmax` });
          if (destCoord && c) lines.push({ coords: [c, destCoord] });
        });
      }

      if (mode === 'split') {
        const directs = searchDirect(trains, params.from, params.to, cityIndex);
        const itins = searchMultiSplit(trains, params.from, params.to, {
          maxHops: params.hops,
          maxConn: params.maxwait,
          cityIndex
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
        points.push({ coord: getKnownCoord(params.from), label: prettyStation(params.from), info: 'Départ', color: '#2563eb', major: true });
        points.push({ coord: getKnownCoord(params.to), label: prettyStation(params.to), info: 'Arrivée', color: '#0e9f6e', major: true });
        const hubCount = {};
        itins.slice(0, 15).forEach(it => it.hubs.forEach(hh => { hubCount[hh] = (hubCount[hh] || 0) + 1; }));
        Object.entries(hubCount).slice(0, 20).forEach(([hh, n]) =>
          points.push({ coord: getKnownCoord(hh), label: prettyStation(hh), info: `${n} itinéraire(s) via cette gare`, color: '#a1006b' }));
        // Une ligne par itinéraire (chaîne complète départ → hubs → arrivée)
        itins.slice(0, 8).forEach(it => {
          const chain = [params.from, ...it.hubs, params.to].map(getKnownCoord);
          if (chain.every(Boolean)) lines.push({ coords: chain, weight: 2.5 });
        });
      }

      window.__lastRender = { points, lines };   // référence pour le re-tracé après géocodage différé
      $('#results').innerHTML = html;
      plotPoints(points, lines);
      window.scrollTo({ top: 260, behavior: 'smooth' });
    } catch (err) {
      setStatus('❌ ' + escapeHtml(err.message || err), true);
    }
  }

  function getKnownCoord(station) {
    const key = norm(station);
    if (COORDS[key]) return COORDS[key];
    if (geoCache[key]) return geoCache[key];
    // géocodage en tâche de fond : re-trace la carte quand la coordonnée arrive
    getCoord(station, () => {
      const r = window.__lastRender;
      if (r && (r.points.length || r.lines.length)) plotPoints(r.points, r.lines);
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
            doSearch(mode, params);
    });
  });
}
