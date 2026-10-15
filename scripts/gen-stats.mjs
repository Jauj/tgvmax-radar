#!/usr/bin/env node
/* ============================================================
   TGVmax Radar — statistiques des « remises en vente »
   ------------------------------------------------------------
   Exécuté par GitHub Actions juste après le snapshot quotidien
   ou manuellement : `node scripts/gen-stats.mjs`

   Lit tout data/history/*.json et compare chaque relevé au relevé
   précédent du même tronçon, date de voyage par date de voyage :
     - « remise »    : le nombre de trains directs AUGMENTE (place
                       revenue / train ajouté) → +Δ trains ;
     - « ouverture » : une date de voyage entre dans la fenêtre de
                       réservation (J+30) → nb de trains à l'ouverture.
   Les remises sont ventilées par délai avant le départ (J-x), par
   jour de la semaine du relevé et par jour de la semaine du voyage.
   Résultat : data/stats.json (classement de tous les tronçons +
   agrégat réseau), lu par l'onglet Suivi → 📊 Ouvertures.
   La logique de openingStats() est dupliquée dans app.js (même nom).
   ============================================================ */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HIST_DIR = join(ROOT, 'data', 'history');
const LEADS = 31;     // J-0 … J-30
const MAX_GAP = 3;    // au-delà (relevés manqués), la paire n'est pas comptée

function dayDiff(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}
/** Lundi = 0 … dimanche = 6 */
function dowOf(iso) { return (new Date(iso + 'T00:00:00Z').getUTCDay() + 6) % 7; }

/** Statistiques de remises/ouvertures d'un tronçon à partir de ses relevés { jour: { perDate } } */
export function openingStats(days) {
  const keys = Object.keys(days || {}).sort();
  const st = {
    snaps: keys.length, pairs: 0, obs: 0, events: 0, gains: 0, losses: 0,
    opens: 0, openTrains: 0,
    byLead: new Array(LEADS).fill(0), evLead: new Array(LEADS).fill(0), obsLead: new Array(LEADS).fill(0),
    bySnapDow: new Array(7).fill(0), pairsSnapDow: new Array(7).fill(0),
    byTravelDow: new Array(7).fill(0),
    timeline: {}
  };
  for (let i = 1; i < keys.length; i++) {
    const p = keys[i - 1], d = keys[i];
    const gap = dayDiff(p, d);
    if (gap < 1 || gap > MAX_GAP) continue;
    const prev = days[p].perDate || {}, cur = days[d].perDate || {};
    const prevMax = Object.keys(prev).sort().pop() || p;
    st.pairs++;
    st.pairsSnapDow[dowOf(d)]++;
    let dayGain = 0;
    for (const [t, nRaw] of Object.entries(cur)) {
      if (t < d) continue;
      const n = Number(nRaw) || 0;
      const lead = dayDiff(d, t);
      if (!(t in prev)) {
        if (t > prevMax) { st.opens++; st.openTrains += n; continue; }  // date nouvellement ouverte
      }
      const delta = n - (Number(prev[t]) || 0);
      st.obs++;
      if (lead < LEADS) st.obsLead[lead]++;
      if (delta > 0) {
        st.events++; st.gains += delta; dayGain += delta;
        if (lead < LEADS) { st.byLead[lead] += delta; st.evLead[lead]++; }
        st.bySnapDow[dowOf(d)] += delta;
        st.byTravelDow[dowOf(t)] += delta;
      } else if (delta < 0) st.losses -= delta;
    }
    st.timeline[d] = dayGain;
  }
  return st;
}

function addInto(acc, st) {
  for (const k of ['snaps', 'pairs', 'obs', 'events', 'gains', 'losses', 'opens', 'openTrains']) acc[k] += st[k];
  for (const k of ['byLead', 'evLead', 'obsLead', 'bySnapDow', 'pairsSnapDow', 'byTravelDow']) st[k].forEach((v, i) => { acc[k][i] += v; });
  for (const [d, v] of Object.entries(st.timeline)) acc.timeline[d] = (acc.timeline[d] || 0) + v;
}

function main() {
  const files = readdirSync(HIST_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
  const network = openingStats({});
  let first = null, last = null;
  const segs = [];
  for (const f of files) {
    let j;
    try { j = JSON.parse(readFileSync(join(HIST_DIR, f), 'utf8')); } catch { continue; }
    if (!j || !j.segment || !j.days) continue;
    const ks = Object.keys(j.days).sort();
    if (ks.length) {
      if (!first || ks[0] < first) first = ks[0];
      if (!last || ks[ks.length - 1] > last) last = ks[ks.length - 1];
    }
    const st = openingStats(j.days);
    addInto(network, st);
    if (!st.pairs) continue;
    // Format compact : tableaux omis quand le tronçon n'a jamais eu de remise
    const row = { f: j.segment.from, t: j.segment.to, p: st.pairs, o: st.obs, e: st.events, g: st.gains, l: st.losses, n: st.opens, nt: st.openTrains };
    if (st.gains) { row.bl = st.byLead; row.bs = st.bySnapDow; row.bt = st.byTravelDow; }
    segs.push(row);
  }
  segs.sort((a, b) => b.g - a.g);
  delete network.snaps;
  const out = { generated: new Date().toISOString(), first, last, maxGap: MAX_GAP, network, segs };
  writeFileSync(join(HIST_DIR, '..', 'stats.json'), JSON.stringify(out));
  console.log(`stats.json : ${segs.length} tronçons, relevés du ${first} au ${last}, ${network.gains} trains remis en vente (${network.events} hausses).`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
