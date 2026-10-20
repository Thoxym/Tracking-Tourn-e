// Calculs sur une tournée, sans DOM : ordre de passage, charge de travail, vérifications avant départ,
// import d'un secteur (CSV voie;début;fin;côté).
//
// L'ordre des rues (tour.order) et leur sens (tour.reverse) sont enregistrés par clé de voie BAN
// (« 01275_0420 », début de l'id des adresses) : stable d'un millésime à l'autre, contrairement au rang
// alphabétique `s`, qui se décale si une voie apparaît.

import { fold } from './views/common.js';

export const WORKLOAD_DEFAULTS = { sec: 20, kmh: 4 };  // secondes par adresse, vitesse de marche
export const WORKLOAD_LIMITS = { sec: [0, 600], kmh: [1, 30] };
const WORKLOAD_KEY = 'neyron-tournees.workload';  // préférence d'appareil, comme le thème
export const UNADDRESSED_NEAR_M = 60;   // bâtiment sans adresse signalé à moins de 60 m de la tournée
export const SECTOR_MAX_BYTES = 512 * 1024;
const SECTOR_MAX_LINES = 5000;

export const streetKeyOf = (id) => id.split('_').slice(0, 2).join('_');

// clé de voie de chaque rue, et rue de chaque clé
export function streetKeys(addresses, nStreets) {
  const key = new Array(nStreets).fill(null);
  const byKey = new Map();
  for (const a of addresses) {
    const k = streetKeyOf(a.id);
    byKey.set(k, a.s);
    key[a.s] ??= k;
  }
  return { key, byKey };
}

// rues de la tournée (au moins une adresse) dans l'ordre de passage : l'ordre choisi, puis les autres
// rues dans l'ordre alphabétique des données (une rue ajoutée après coup arrive donc en fin d'ordre)
export function streetOrder(tour, byStreet, keys) {
  const out = [];
  const seen = new Set();
  for (const k of tour.order || []) {
    const s = keys.byKey.get(k);
    if (s !== undefined && byStreet[s].length && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  byStreet.forEach((addrs, s) => { if (addrs.length && !seen.has(s)) out.push(s); });
  return out;
}

export function isReversed(tour, s, keys) {
  return (tour.reverse || []).includes(keys.key[s]);
}

// adresses dans l'ordre de passage, par rue : numéros croissants (pairs et impairs mêlés), ou décroissants
// si le sens de la rue est inversé
export function sequence(tour, byStreet, keys) {
  return streetOrder(tour, byStreet, keys).map((s) => ({
    s,
    addrs: isReversed(tour, s, keys) ? [...byStreet[s]].reverse() : byStreet[s],
  }));
}

// longueur de l'arbre couvrant des points (Prim, O(n²)) : approximation du chemin parcouru dans une rue
export function mstLength(pts) {
  const n = pts.length;
  if (n < 2) return 0;
  const best = new Float64Array(n).fill(Infinity);
  const used = new Uint8Array(n);
  best[0] = 0;
  let total = 0;
  for (let k = 0; k < n; k++) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!used[i] && (u < 0 || best[i] < best[u])) u = i;
    used[u] = 1;
    total += best[u];
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      const d = Math.hypot(pts[i].x - pts[u].x, pts[i].y - pts[u].y);
      if (d < best[i]) best[i] = d;
    }
  }
  return total;
}

// charge de travail d'une séquence [{s, addrs}] : mètres = arbre couvrant de chaque rue + liaisons à vol
// d'oiseau de la fin d'une rue au début de la suivante ; durée = temps par adresse + marche
export function workload(groups, { sec, kmh }) {
  let addresses = 0;
  let streets = 0;
  let meters = 0;
  let prev = null;
  for (const { addrs } of groups) {
    if (!addrs.length) continue;
    addresses += addrs.length;
    streets += 1;
    meters += mstLength(addrs);
    if (prev) meters += Math.hypot(addrs[0].x - prev.x, addrs[0].y - prev.y);
    prev = addrs[addrs.length - 1];
  }
  return { addresses, streets, meters, seconds: addresses * sec + meters / (kmh / 3.6) };
}

export const validSetting = (k, v) => Number.isFinite(v) && v >= WORKLOAD_LIMITS[k][0] && v <= WORKLOAD_LIMITS[k][1];

let memo = null;  // derniers réglages (valables pour la session si le stockage est indisponible)

// réglages de l'estimation (stockage indisponible ou valeur invalide : valeurs par défaut)
export function workloadSettings() {
  if (memo) return { ...memo };
  const out = { ...WORKLOAD_DEFAULTS };
  try {
    const v = JSON.parse(localStorage.getItem(WORKLOAD_KEY) || '{}');
    for (const k of Object.keys(out)) if (validSetting(k, v[k])) out[k] = v[k];
  } catch { /* valeurs par défaut */ }
  return out;
}

export function saveWorkloadSettings(v) {
  memo = { ...v };
  try {
    localStorage.setItem(WORKLOAD_KEY, JSON.stringify(v));
  } catch { /* stockage indisponible : réglage valable pour la session */ }
}

export function formatDistance(m) {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`;
}

// arrondi à 5 minutes : « 45 min », « 2 h 05 »
export function formatDuration(seconds) {
  const min = seconds > 0 ? Math.max(5, Math.round(seconds / 300) * 5) : 0;
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
}

// ------------------------------------------------------------ vérifications

// numéros hors tournée entre deux numéros de la tournée, du même côté de la rue : sans doute oubliés
export function findGaps(allByStreet, inTour) {
  const out = [];
  allByStreet.forEach((addrs) => {
    for (const side of ['pair', 'impair']) {
      const list = addrs.filter((a) => a.side === side);
      const inside = list.map((a, k) => (inTour.has(a.id) ? k : -1)).filter((k) => k >= 0);
      if (inside.length < 2) continue;
      let prev = list[inside[0]];
      for (let k = inside[0] + 1; k < inside[inside.length - 1]; k++) {
        if (inTour.has(list[k].id)) {
          prev = list[k];
          continue;
        }
        let j = k + 1;
        while (!inTour.has(list[j].id)) j += 1;
        out.push({ a: list[k], prev, next: list[j] });
      }
    }
  });
  return out;
}

// bâtiments sans adresse (repérés par le pipeline) à moins de maxDist d'une adresse de la tournée,
// avec l'adresse la plus proche
export function nearUnaddressed(unaddressed, tourAddrs, maxDist = UNADDRESSED_NEAR_M) {
  const out = [];
  for (const u of unaddressed) {
    let best = null;
    let bestD = maxDist;
    for (const a of tourAddrs) {
      const d = Math.hypot(a.x - u.x, a.y - u.y);
      if (d <= bestD) {
        bestD = d;
        best = a;
      }
    }
    if (best) out.push({ u, a: best, d: bestD });
  }
  return out.sort((p, q) => p.d - q.d);
}

// --------------------------------------------------------- import de secteur

const norm = (s) => fold(String(s)).replace(/[’‘`´]/g, '\'').replace(/[-‐–]/g, ' ').replace(/\s+/g, ' ').trim();
const SIDES = new Map([
  ['', 'all'], ['tous', 'all'], ['toutes', 'all'], ['les deux', 'all'], ['deux', 'all'], ['2', 'all'],
  ['pair', 'pair'], ['pairs', 'pair'], ['p', 'pair'],
  ['impair', 'impair'], ['impairs', 'impair'], ['i', 'impair'],
]);
const HEADERS = new Set(['voie', 'rue', 'nom voie', 'nom_voie', 'nom de la voie', 'adresse']);

// une ligne CSV : séparateur choisi, champs entre guillemets ("" = guillemet)
function splitLine(line, sep) {
  const cells = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"' && !cur.trim()) {
      quoted = true;
      cur = '';
    } else if (c === sep) {
      cells.push(cur);
      cur = '';
    } else cur += c;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

// numéro de début ou de fin : vide = sans borne (undefined), « 58 » ou « 58 bis » = 58, sinon null
function parseNum(v) {
  if (!v) return undefined;
  const m = /^(\d{1,5})\s*(bis|ter|quater|[a-z])?$/i.exec(v);
  return m ? Number(m[1]) : null;
}

function distance(a, b) {  // Levenshtein, pour suggérer la voie la plus proche d'un nom mal saisi
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

const clip = (s, n = 50) => (s.length > n ? `${s.slice(0, n)}…` : s);

// Secteur au format CSV, une ligne par tronçon : voie;début;fin;côté (début, fin et côté facultatifs).
// Début > fin : rue parcourue dans le sens des numéros décroissants. L'ordre des lignes donne l'ordre de
// passage. Donnée non fiable : chaque ligne est validée, les lignes invalides sont signalées et ignorées.
export function parseSector(text, streets, allByStreet, keys) {
  const lines = String(text).replace(/^﻿/, '').split(/\r\n|\n|\r/);
  if (lines.length > SECTOR_MAX_LINES) throw new Error(`fichier trop long (plus de ${SECTOR_MAX_LINES} lignes)`);
  const firstIdx = lines.findIndex((l) => l.trim() && !l.trim().startsWith('#'));
  const first = firstIdx >= 0 ? lines[firstIdx] : '';
  const sep = [';', '\t', ','].map((c) => [c, first.split(c).length]).sort((p, q) => q[1] - p[1])[0][0];
  const names = streets.map((st) => norm(st.name));
  const byName = new Map(names.map((n, s) => [n, s]));
  const segments = [];
  const errors = [];
  lines.forEach((raw, k) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const [name = '', fromS = '', toS = '', sideS = ''] = splitLine(raw, sep);
    if (k === firstIdx && HEADERS.has(norm(name))) return;  // ligne d'en-tête
    const no = k + 1;
    const fail = (msg) => errors.push({ line: no, msg });
    if (!name) return fail('voie manquante');
    const s = byName.get(norm(name));
    if (s === undefined) {
      const q = norm(name);
      let best = -1;
      let bestD = Math.max(2, Math.round(q.length / 4));
      names.forEach((n, j) => {
        const d = distance(q, n);
        if (d <= bestD) {
          bestD = d;
          best = j;
        }
      });
      return fail(`voie inconnue « ${clip(name)} »${best >= 0 ? ` (« ${streets[best].name} » ?)` : ''}`);
    }
    const from = parseNum(fromS);
    const to = parseNum(toS);
    if (from === null) return fail(`début invalide « ${clip(fromS, 12)} »`);
    if (to === null) return fail(`fin invalide « ${clip(toS, 12)} »`);
    const side = SIDES.get(norm(sideS));
    if (!side) return fail(`côté invalide « ${clip(sideS, 12)} » (tous, pairs ou impairs)`);
    const reverse = from !== undefined && to !== undefined && from > to;
    const lo = reverse ? to : from;
    const hi = reverse ? from : to;
    const ids = allByStreet[s].filter((a) => (side === 'all' || a.side === side)
      && (lo === undefined || a.n >= lo) && (hi === undefined || a.n <= hi)).map((a) => a.id);
    if (!ids.length) return fail(`aucun numéro ne correspond (${streets[s].name})`);
    segments.push({ line: no, s, side, from: lo, to: hi, reverse, ids });
    return undefined;
  });
  const order = [...new Set(segments.map((g) => g.s))];
  // sens d'une rue : celui de son premier tronçon
  const reverse = order.filter((s) => segments.find((g) => g.s === s).reverse);
  return {
    segments,
    errors,
    ids: [...new Set(segments.flatMap((g) => g.ids))],
    order: order.map((s) => keys.key[s]),
    reverse: reverse.map((s) => keys.key[s]),
    streets: order.length,
  };
}
