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
function findByOrigin(trains, from) { return trains.filter(t => norm(t.origine) === norm(from)); }
function findByDest(trains, to) { return trains.filter(t => norm(t.destination) === norm(to)); }

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
/** Toutes les destinations atteignables depuis une gare (hors trains intramuros→intramuros) */
function searchClassic(trains, from) {
  return groupBySorted(
    findByOrigin(trains, from).filter(t => norm(t.destination) !== norm(t.origine)),
    t => t.destination
  );
}
/** Toutes les origines qui desservent une destination (hors trains intramuros→intramuros) */
function searchReverse(trains, to) {
  return groupBySorted(
    findByDest(trains, to).filter(t => norm(t.destination) !== norm(t.origine)),
    t => t.origine
  );
}
/** Trains directs entre deux gares */
function searchDirect(trains, from, to) {
  return findByOrigin(trains, from)
    .filter(t => norm(t.destination) === norm(to))
    .sort((a, b) => String(a.heure_depart || '').localeCompare(String(b.heure_depart || '')));
}
/**
 * Découpage à 1 correspondance : A -> hub -> B, même journée,
 * correspondance entre MIN et MAX minutes, hub différent de A et B.
 * Retourne [{hub, wait, t1, t2, totalMin}] trié par départ.
 */
function searchSplit(trains, from, to, minConn = MIN_CONNECTION_MIN, maxConn = MAX_CONNECTION_MIN) {
  const legs1 = findByOrigin(trains, from);
  const byOrigin = new Map();
  for (const t of trains) {
    const k = norm(t.origine);
    if (!byOrigin.has(k)) byOrigin.set(k, []);
    byOrigin.get(k).push(t);
  }
  const options = [];
  for (const t1 of legs1) {
    const hub = t1.destination;
    if (!hub || norm(hub) === norm(from) || norm(hub) === norm(to)) continue;
    const arr1 = arrivalMinutes(t1.heure_depart, t1.heure_arrivee);
    if (arr1 == null) continue;
    const dep1 = parseHM(t1.heure_depart);
    if (dep1 == null) continue;
    const leg2s = (byOrigin.get(norm(hub)) || [])
      .filter(t2 => norm(t2.destination) === norm(to))
      .map(t2 => {
        const dep2 = parseHM(t2.heure_depart);
        if (dep2 == null) return null;
        const wait = dep2 - arr1;
        if (wait < minConn || wait > maxConn) return null;
        const arr2 = arrivalMinutes(t2.heure_depart, t2.heure_arrivee);
        if (arr2 == null) return null;
        const total = arr2 - dep1; // peut dépasser 24h (nuit) — OK
        return { hub, wait, t1, t2, total };
      })
      .filter(Boolean);
    options.push(...leg2s);
  }
  return options
    .sort((a, b) => String(a.t1.heure_depart).localeCompare(String(b.t1.heure_depart))
      || String(a.t2.heure_depart).localeCompare(String(b.t2.heure_depart)))
    .slice(0, 24);
}

/* ---------------- EXPORTS (tests Node) ---------------- */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    norm, parseHM, arrivalMinutes, todayISO, addDaysISO, fmtDateFR,
    fetchDay, fetchStationNames,
    searchClassic, searchReverse, searchDirect, searchSplit
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
  function plotPoints(points) {
    const el = document.getElementById('map');
    if (!points.length) { el.hidden = true; return; }
    el.hidden = false;
    ensureMap();
    markersLayer.clearLayers();
    const bounds = [];
    points.forEach(p => {
      if (!p.coord) return;
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
  const prettyStation = s => String(s || '').replace(/\s*\(intramuros\)\s*/i, ' (toutes gares) ');
  const sncfConnectLink = (from, to, date) =>
    `https://www.sncf-connect.com/train/search?dep=${encodeURIComponent(prettyStation(from).trim())}&arr=${encodeURIComponent(prettyStation(to).trim())}&outboundDate=${date}`;

  function setStatus(msg, isError) {
    const el = $('#status');
    el.hidden = !msg;
    el.classList.toggle('error', !!isError);
    el.innerHTML = msg || '';
  }

  function trainRow(t) {
    const axe = t.axe ? ` <span class="axe">· ${escapeHtml(t.axe)}</span>` : '';
    return `<div class="train-row">🕐 ${escapeHtml(t.heure_depart || '?')} → ${escapeHtml(t.heure_arrivee || '?')}${axe}</div>`;
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
        <a class="book-link" target="_blank" rel="noopener" href="${sncfConnectLink(otherStation, g.station, date)}">Vérifier sur SNCF Connect ↗</a>
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
      <a class="book-link" target="_blank" rel="noopener" href="${sncfConnectLink(from, to, date)}">Réserver sur SNCF Connect ↗</a>
    </div></div>`;
    return html;
  }

  function renderSplit(options, from, to, date) {
    let html = `<h2 class="res-section-title">✂️ Découpages possibles — <strong>${options.length}</strong> option(s)</h2>`;
    if (!options.length) return html;
    html += '<div class="cards">';
    for (const o of options.slice(0, 12)) {
      const h = Math.floor(o.total / 60), m = o.total % 60;
      html += `<div class="card">
        <div class="card-head">
          <span class="card-station">via ${escapeHtml(prettyStation(o.hub))}</span>
          <span class="badge">corresp. ${o.wait} min</span>
        </div>
        ${trainRow(o.t1)}
        <div class="conn">↳ changement à ${escapeHtml(prettyStation(o.hub))} (${o.wait} min d'attente)</div>
        ${trainRow(o.t2)}
        <div class="conn">⏱ Total : ${h}h${String(m).padStart(2, '0')}</div>
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

  /* ---------- Autocomplétion gares ---------- */
  const stationList = new Set();
  function refreshDatalist() {
    $('#stations').innerHTML = [...stationList].sort((a, b) => a.localeCompare(b, 'fr'))
      .map(s => `<option value="${escapeHtml(s)}">`).join('');
  }
  fetchStationNames().then(names => { names.forEach(n => stationList.add(n)); refreshDatalist(); })
    .catch(() => {});

  /* ---------- Soumission des formulaires ---------- */
  async function doSearch(mode, params) {
    const date = params.date;
    try {
      setStatus('⏳ Interrogation des données SNCF…');
      const trains = await fetchDay(date);
      stationList.add(params.from, params.to, params.station);
      trains.forEach(t => { stationList.add(t.origine); stationList.add(t.destination); });
      refreshDatalist();

      if (!trains.length) {
        document.getElementById('map').hidden = true;
        $('#results').innerHTML = '';
        setStatus(`Aucune place TGVmax trouvée pour le <strong>${fmtDateFR(date)}</strong>. Soit tout est complet, soit la date est hors fenêtre de réservation (${BOOKING_WINDOW_DAYS} jours).`, true);
        return;
      }

      let html = '';
      const points = [];

      if (mode === 'classic') {
        const groups = searchClassic(trains, params.station);
        if (!groups.length) {
          $('#results').innerHTML = '';
          setStatus(`Aucune place depuis « ${escapeHtml(params.station)} » le ${fmtDateFR(date)}. Vérifie l'orthographe de la gare (les gares parisiennes = « PARIS (intramuros) »).`, true);
          return;
        }
        setStatus(`✅ <strong>${trains.length}</strong> trains réservables en France le ${fmtDateFR(date)} — destinations depuis <strong>${escapeHtml(prettyStation(params.station))}</strong> :`);
        html = renderGroups('🎯 Depuis ' + escapeHtml(prettyStation(params.station)), groups, params.station, date);
        points.push({ coord: getKnownCoord(params.station), label: prettyStation(params.station), info: 'Départ', color: '#2563eb', major: true });
        groups.forEach(g => points.push({ coord: getKnownCoord(g.station), label: prettyStation(g.station), info: `${g.trains.length} train(s) TGVmax` }));
      }

      if (mode === 'reverse') {
        const groups = searchReverse(trains, params.station);
        if (!groups.length) {
          $('#results').innerHTML = '';
          setStatus(`Aucune place vers « ${escapeHtml(params.station)} » le ${fmtDateFR(date)}. Vérifie l'orthographe (ex. « NICE VILLE »).`, true);
          return;
        }
        setStatus(`✅ <strong>${trains.length}</strong> trains réservables en France le ${fmtDateFR(date)} — origines pour arriver à <strong>${escapeHtml(prettyStation(params.station))}</strong> :`);
        html = renderGroups('🔄 Vers ' + escapeHtml(prettyStation(params.station)), groups, params.station, date);
        points.push({ coord: getKnownCoord(params.station), label: prettyStation(params.station), info: 'Arrivée', color: '#2563eb', major: true });
        groups.forEach(g => points.push({ coord: getKnownCoord(g.station), label: prettyStation(g.station), info: `${g.trains.length} train(s) TGVmax` }));
      }

      if (mode === 'split') {
        const directs = searchDirect(trains, params.from, params.to);
        const options = searchSplit(trains, params.from, params.to);
        if (!directs.length && !options.length) {
          $('#results').innerHTML = '';
          setStatus(`Ni direct ni découpage simple trouvé entre « ${escapeHtml(params.from)} » et « ${escapeHtml(params.to)} » le ${fmtDateFR(date)}. Essaie une autre date ou une gare voisine.`, true);
          return;
        }
        setStatus(`✅ ${fmtDateFR(date)} : <strong>${directs.length}</strong> direct(s), <strong>${options.length}</strong> découpage(s) à 1 correspondance.`);
        html = renderDirect('🚄 Directs', directs, params.from, params.to, date);
        html += renderSplit(options, params.from, params.to, date);
        points.push({ coord: getKnownCoord(params.from), label: prettyStation(params.from), info: 'Départ', color: '#2563eb', major: true });
        points.push({ coord: getKnownCoord(params.to), label: prettyStation(params.to), info: 'Arrivée', color: '#0e9f6e', major: true });
        options.slice(0, 12).forEach(o => points.push({ coord: getKnownCoord(o.hub), label: 'via ' + prettyStation(o.hub), info: `${o.t1.heure_depart} → ${o.t2.heure_arrivee}`, color: '#a1006b' }));
      }

      window.__lastPoints = points;   // référence pour le re-tracé après géocodage différé
      $('#results').innerHTML = html;
      plotPoints(points.filter(p => p.coord));
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
      const pts = window.__lastPoints || [];
      if (pts.length) plotPoints(pts.filter(p => p.coord));
    });
    return null;
  }

  document.querySelectorAll('.search-form').forEach(form => {
    form.addEventListener('submit', ev => {
      ev.preventDefault();
      const fd = new FormData(form);
      const mode = form.dataset.mode;
      const params = {
        date: fd.get('date'),
        station: (fd.get('station') || '').trim(),
        from: (fd.get('from') || '').trim(),
        to: (fd.get('to') || '').trim()
      };
      if ((mode === 'split' && (!params.from || !params.to)) || (mode !== 'split' && !params.station)) return;
      doSearch(mode, params);
    });
  });
}
