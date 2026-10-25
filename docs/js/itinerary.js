// Calcul d'un itinéraire de tournée, sans DOM (exécuté dans js/route-worker.js).
//
// 1. Chaque adresse a un point de remise et une position sur un tronçon (data/roads.json, `snap`).
// 2. Unités de visite :
//    - voiture et vélo : des **arrêts**. Le véhicule s'arrête sur un tronçon ; on dessert à pied les points de remise à
//      moins de `walkMax`, des deux côtés si la rue est tissée, d'un seul sinon (ce côté à droite du véhicule) ;
//    - à pied : des **portions de rue** servies d'un trait, les deux côtés à la fois si la rue est tissée, sinon un côté
//      par portion (un côté à l'aller, l'autre au retour).
//    Chaque unité a une ou deux orientations (sens de parcours), selon les sens uniques et le côté à servir.
// 3. Temps entre unités : Dijkstra (routing.js) depuis la sortie de chaque orientation.
// 4. Ordre : plus proche voisin et ordre par rues, puis recherche locale (déplacement de 1 à 3 unités, inversion de
//    portion, changement d'orientation) et perturbations jusqu'au budget de temps. Générateur à graine : même
//    entrée, même résultat.
// 5. Dans une unité : ordre le long du sens de parcours ; si la rue est tissée, les deux côtés alternent selon la
//    position (142, 125, 144, 129…).

import { CAR, RoadGraph } from './routing.js';

export { RoadGraph };

export const MODES = ['car', 'bike', 'foot'];
export const DEFAULTS = {
  car: { walkMax: 40, stopSec: 20, boxSec: 15, crossSec: 10, walkKmh: 4.5, fromVehicle: false },
  bike: { walkMax: 25, stopSec: 8, boxSec: 15, crossSec: 10, walkKmh: 4.5, bikeKmh: 15 },
  foot: { boxSec: 15, crossSec: 10, walkKmh: 4.5 },
};
export const LIMITS = {
  walkMax: [5, 150], stopSec: [0, 300], boxSec: [0, 600], crossSec: [0, 120], walkKmh: [1, 10], bikeKmh: [5, 40],
};
export const WEAVE = ['auto', 'always', 'never'];
const WINDOW_MAX_OFF = 3;      // dépôt depuis le véhicule : boîte en bord de route
const FOOT_RUN_GAP_M = 200;    // à pied, une portion de rue est coupée au-delà de 200 m sans adresse

export const streetKeyOf = (id) => id.split('_').slice(0, 2).join('_');

// réglages complets d'une tournée : valeurs par défaut du mode, puis réglages enregistrés. Les valeurs chiffrées
// sont propres à chaque mode (`custom.car`, `custom.bike`, `custom.foot`) ; une valeur hors bornes est ignorée.
const isPoint = (p) => Boolean(p) && Number.isFinite(p.x) && Number.isFinite(p.y);

export function settingsFor(saved = {}) {
  const mode = MODES.includes(saved.mode) ? saved.mode : 'car';
  const out = { mode, weave: 'auto', weaveBy: {}, start: null, end: null, seed: 1, fromVehicle: false, ...DEFAULTS[mode] };
  const custom = saved.custom && typeof saved.custom === 'object' && saved.custom[mode] ? saved.custom[mode] : {};
  const nums = { ...saved, ...custom };
  for (const k of Object.keys(LIMITS)) {
    const v = nums[k];
    if (k in DEFAULTS[mode] && Number.isFinite(v) && v >= LIMITS[k][0] && v <= LIMITS[k][1]) out[k] = v;
  }
  if (WEAVE.includes(saved.weave)) out.weave = saved.weave;
  if (saved.weaveBy && typeof saved.weaveBy === 'object') {
    for (const [k, v] of Object.entries(saved.weaveBy)) if (v === 'weave' || v === 'sides') out.weaveBy[k] = v;
  }
  out.fromVehicle = mode === 'car' && Boolean(saved.fromVehicle);
  if (isPoint(saved.start)) out.start = { x: saved.start.x, y: saved.start.y };
  if (saved.end === 'start' && out.start) out.end = 'start';
  else if (isPoint(saved.end)) out.end = { x: saved.end.x, y: saved.end.y };
  if (Number.isInteger(saved.seed)) out.seed = saved.seed;
  return out;
}

function rng(seed) {  // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ----------------------------------------------------------------- unités

class Ctx {
  constructor(graph, data, snap, settings) {
    this.g = graph;
    this.data = data;
    this.snap = snap;
    this.st = settings;
    this.mode = settings.mode;
    this.walkMps = settings.walkKmh / 3.6;
    // clé de voie de chaque rue (le réglage de tissage par rue est enregistré par clé, comme l'ordre de passage)
    this.keyOfStreet = [];
    for (const a of data.addresses) this.keyOfStreet[a.s] ??= streetKeyOf(a.id);
    this.byId = new Map(data.addresses.map((a) => [a.id, a]));
  }

  weave(e) {
    const s = this.g.es[e];
    const forced = s >= 0 ? this.st.weaveBy[this.keyOfStreet[s]] : undefined;
    if (forced === 'weave') return true;
    if (forced === 'sides') return false;
    if (this.st.weave === 'always') return true;
    if (this.st.weave === 'never') return false;
    return !this.g.enw[e];
  }

  // position d'accès d'une adresse pour le mode : tronçon, abscisse, côté, distance route - point de remise
  delivery(id) {
    const a = this.byId.get(id);
    const sn = this.snap[id];
    if (!a || !sn) return null;
    const [e, t, sd, off, px, py] = sn;
    const g = this.g;
    let d = { id, a, e, t, sd, off, px, py };
    const main = g.main(this.mode);
    const ok = main[e] && (this.mode !== 'car' || sn.length <= 6);
    if (!ok) {
      if (sn.length > 6 && main[sn[6]]) {
        const p = g.project(sn[6], px, py);
        d = { ...d, e: sn[6], t: sn[7], sd: p.side, off: sn[8] };
      } else {
        const p = g.nearest(px, py, this.mode);
        if (!p) return null;
        d = { ...d, e: p.e, t: p.t, sd: p.side, off: p.d };
      }
    }
    return d;
  }
}

// côté (+1 droite, -1 gauche) d'un point par rapport au sens a -> b du tronçon e
function sideOn(g, e, d) {
  return d.e === e ? d.sd : g.project(e, d.px, d.py).side;
}

// orientations possibles (arcs) d'une unité sur le tronçon e : sens permis par les sens uniques ; si un seul côté
// est servi, celui qui le met à droite (s'il est permis)
function arcsFor(ctx, e, side) {
  const allowed = [2 * e, 2 * e + 1].filter((arc) => ctx.g.arcAllowed(arc, ctx.mode));
  if (side === 0 || allowed.length < 2) return allowed;
  return [side > 0 ? 2 * e : 2 * e + 1];
}

// unité « arrêt » du véhicule en (e, t) avec ses adresses ; une orientation par arc
function stopUnit(ctx, e, t, members, mixed, forceArcs = null) {
  const { g, st } = ctx;
  const len = g.elen[e];
  const ms = members.map((d) => {
    const p = d.e === e ? { t: d.t, d: d.off, side: d.sd } : g.project(e, d.px, d.py);
    return { d, tp: p.t, perp: p.d, side: p.side };
  });
  const tps = ms.map((m) => m.tp);
  const span = Math.max(...tps) - Math.min(...tps);
  const walk = 2 * span + ms.reduce((s, m) => s + 2 * m.perp, 0);
  const side = mixed ? 0 : ms[0].side;
  const opts = (forceArcs || arcsFor(ctx, e, side)).map((arc) => {
    const fwd = !(arc & 1);
    const order = [...ms].sort((p, q) => (fwd ? p.tp - q.tp : q.tp - p.tp));
    // traversées : le véhicule est garé à droite ; chaque changement de côté, et le retour, en est une
    let cur = 1;
    let crossings = 0;
    for (const m of order) {
      const rel = fwd ? m.side : -m.side;
      if (rel !== cur) {
        crossings += 1;
        cur = rel;
      }
    }
    if (cur !== 1) crossings += 1;
    const s = g.arcOffset(arc, t);
    return {
      arc, sIn: s, sOut: s, order: order.map((m) => m.d.id), sides: order.map((m) => (fwd ? m.side : -m.side)),
      service: (st.stopSec || 0) + ms.length * st.boxSec + walk / ctx.walkMps + crossings * st.crossSec,
    };
  });
  const p = g.pointAt(e, t);
  return { kind: 'stop', e, t: Math.max(0, Math.min(len, t)), x: p.x, y: p.y, walk, mixed, ids: ms.map((m) => m.d.id), opts };
}

// unité « portion de rue » parcourue de bout en bout (à pied, ou dépôt depuis le véhicule)
function runUnit(ctx, kind, e, members, side, perBox, speedMps) {
  const { g, st } = ctx;
  const len = g.elen[e];
  const ms = [...members].sort((p, q) => p.t - q.t);
  const t0 = ms[0].t;
  const t1 = ms[ms.length - 1].t;
  const walk = kind === 'run' ? (t1 - t0) + ms.reduce((s, m) => s + 2 * m.off, 0) : ms.reduce((s, m) => s + 2 * m.off, 0);
  const opts = arcsFor(ctx, e, side).map((arc) => {
    const fwd = !(arc & 1);
    const order = fwd ? ms : [...ms].reverse();
    let crossings = 0;
    for (let k = 1; k < order.length; k++) if (order[k].sd !== order[k - 1].sd) crossings += 1;
    return {
      arc, sIn: fwd ? t0 : len - t1, sOut: fwd ? t1 : len - t0, order: order.map((m) => m.id),
      path: [{ arc, s0: fwd ? t0 : len - t1, s1: fwd ? t1 : len - t0 }],
      sides: order.map((m) => (fwd ? m.sd : -m.sd)),
      service: ms.length * perBox + (kind === 'run' ? ms.reduce((s, m) => s + 2 * m.off, 0) / ctx.walkMps : 0)
        + crossings * st.crossSec + (t1 - t0) / speedMps,
    };
  });
  const p = g.pointAt(e, (t0 + t1) / 2);
  return { kind, e, t: t0, tEnd: t1, x: p.x, y: p.y, walk, mixed: side === 0, ids: ms.map((m) => m.id), opts };
}

// Chaînes de tronçons par rue : les tronçons de la rue (praticables dans le mode) mis bout à bout, coupés là où la
// rue se ramifie. Un tronçon sans rue forme une chaîne à lui seul. Renvoie tronçon -> {chain, k}.
function streetChains(ctx, dels) {
  const { g, mode } = ctx;
  const out = new Map();
  const single = (e) => ({ chain: { arcs: [2 * e], off: [0], len: g.elen[e] }, k: 0 });
  const streets = new Set();
  for (const d of dels) {
    if (g.es[d.e] >= 0) streets.add(g.es[d.e]);
    else if (!out.has(d.e)) out.set(d.e, single(d.e));
  }
  for (const s of streets) {
    const edges = [];
    for (let e = 0; e < g.E; e++) if (g.es[e] === s && g.allowed(e, mode)) edges.push(e);
    const at = new Map();  // nœud -> tronçons de la rue
    for (const e of edges) {
      for (const n of [g.ea[e], g.eb[e]]) {
        if (!at.has(n)) at.set(n, []);
        at.get(n).push(e);
      }
    }
    const used = new Set();
    const walk = (node, e0) => {
      const arcs = [];
      let n = node;
      let e = e0;
      while (e !== undefined && !used.has(e)) {
        used.add(e);
        const arc = g.ea[e] === n ? 2 * e : 2 * e + 1;
        arcs.push(arc);
        n = g.arcEnd(arc);
        const next = at.get(n) || [];
        e = next.length === 2 ? next.find((x) => x !== e) : undefined;
      }
      return arcs;
    };
    const found = [];
    for (const [n, list] of at) if (list.length !== 2) for (const e of list) if (!used.has(e)) found.push(walk(n, e));
    for (const e of edges) if (!used.has(e)) found.push(walk(g.ea[e], e));  // boucles
    for (const arcs of found) {
      const off = [];
      let len = 0;
      for (const arc of arcs) {
        off.push(len);
        len += g.elen[arc >> 1];
      }
      const chain = { arcs, off, len };
      arcs.forEach((arc, k) => out.set(arc >> 1, { chain, k }));
    }
  }
  for (const d of dels) if (!out.has(d.e)) out.set(d.e, single(d.e));  // tronçon hors des chaînes de sa rue
  return out;
}

// abscisse le long d'une chaîne -> position sur un arc ; reverse : dans l'autre sens de parcours
function locate(g, chain, pos, reverse) {
  let k = chain.off.length - 1;
  while (k > 0 && chain.off[k] > pos) k -= 1;
  const arc = chain.arcs[k];
  const s = Math.min(g.elen[arc >> 1], Math.max(0, pos - chain.off[k]));
  return reverse ? { arc: arc ^ 1, s: g.elen[arc >> 1] - s } : { arc, s };
}

// morceaux d'arcs couvrant [p0, p1] le long de la chaîne, dans le sens de parcours
function chainPath(g, chain, p0, p1, reverse) {
  const out = [];
  chain.arcs.forEach((arc, k) => {
    const a = Math.max(p0, chain.off[k]);
    const b = Math.min(p1, chain.off[k] + g.elen[arc >> 1]);
    if (b < a || (b === a && p1 > p0)) return;
    out.push({ arc, s0: a - chain.off[k], s1: b - chain.off[k] });
  });
  if (!reverse) return out;
  return out.reverse().map((p) => {
    const len = g.elen[p.arc >> 1];
    return { arc: p.arc ^ 1, s0: len - p.s1, s1: len - p.s0 };
  });
}

// portion de rue à pied : servie d'un bout à l'autre, dans un sens ou dans l'autre
function chainRun(ctx, chain, ms, side) {
  const { g, st } = ctx;
  const p0 = ms[0].pos;
  const p1 = ms[ms.length - 1].pos;
  const perp = ms.reduce((s, m) => s + 2 * m.off, 0);
  const opts = [false, true].map((reverse) => {
    const order = reverse ? [...ms].reverse() : ms;
    let crossings = 0;
    for (let k = 1; k < order.length; k++) if (order[k].rel !== order[k - 1].rel) crossings += 1;
    const a = locate(g, chain, reverse ? p1 : p0, reverse);
    const b = locate(g, chain, reverse ? p0 : p1, reverse);
    return {
      arc: a.arc, sIn: a.s, arcOut: b.arc, sOut: b.s, order: order.map((m) => m.id),
      sides: order.map((m) => (reverse ? -m.rel : m.rel)), path: chainPath(g, chain, p0, p1, reverse),
      service: ms.length * st.boxSec + perp / ctx.walkMps + crossings * st.crossSec + (p1 - p0) / ctx.walkMps,
    };
  });
  const mid = locate(g, chain, (p0 + p1) / 2, false);
  const e = mid.arc >> 1;
  const p = g.pointAt(e, mid.arc & 1 ? g.elen[e] - mid.s : mid.s);
  return { kind: 'run', e, x: p.x, y: p.y, walk: (p1 - p0) + perp, mixed: side === 0, ids: ms.map((m) => m.id), opts };
}

function grid(items, cell) {
  const map = new Map();
  for (const it of items) {
    const k = `${Math.floor(it.px / cell)},${Math.floor(it.py / cell)}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(it);
  }
  return (x, y, r) => {
    const out = [];
    for (let i = Math.floor((x - r) / cell); i <= Math.floor((x + r) / cell); i++) {
      for (let j = Math.floor((y - r) / cell); j <= Math.floor((y + r) / cell); j++) out.push(...(map.get(`${i},${j}`) || []));
    }
    return out;
  };
}

export function buildUnits(ctx, ids) {
  const { g, st, mode } = ctx;
  const units = [];
  const missing = [];
  let dels = [];
  for (const id of ids) {
    const d = ctx.delivery(id);
    if (d) dels.push(d);
    else missing.push(id);
  }
  dels.sort((p, q) => p.e - q.e || p.t - q.t);

  if (mode === 'foot') {
    // portions de rue : tronçons d'une même rue mis bout à bout, un côté (ou les deux si tissée) servi d'un trait
    const located = new Map();  // chaîne -> côté -> adresses avec leur abscisse le long de la chaîne
    const chainOf = streetChains(ctx, dels);
    for (const d of dels) {
      const { chain, k } = chainOf.get(d.e);
      const arc = chain.arcs[k];
      const pos = chain.off[k] + g.arcOffset(arc, d.t);
      const rel = arc & 1 ? -d.sd : d.sd;
      const key = ctx.weave(d.e) ? 0 : rel;
      if (!located.has(chain)) located.set(chain, new Map());
      const bySide = located.get(chain);
      if (!bySide.has(key)) bySide.set(key, []);
      bySide.get(key).push({ ...d, pos, rel });
    }
    for (const [chain, bySide] of located) {
      for (const [side, list] of bySide) {
        list.sort((p, q) => p.pos - q.pos);
        let run = [list[0]];
        for (let i = 1; i <= list.length; i++) {
          if (i === list.length || list[i].pos - list[i - 1].pos > FOOT_RUN_GAP_M) {
            units.push(chainRun(ctx, chain, run, side));
            run = [];
          }
          if (i < list.length) run.push(list[i]);
        }
      }
    }
    return { units, missing };
  }

  // dépôt depuis le véhicule : boîtes en bord de route, servies en roulant, par côté
  if (st.fromVehicle && mode === 'car') {
    const groups = new Map();
    const rest = [];
    for (const d of dels) {
      if (d.off <= WINDOW_MAX_OFF && g.em[d.e] & CAR) {
        const k = `${d.e}|${d.sd}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(d);
      } else rest.push(d);
    }
    for (const [k, list] of groups) {
      const side = Number(k.split('|')[1]);
      units.push(runUnit(ctx, 'window', list[0].e, list, side, st.boxSec * 0.6 + 4, 12 / 3.6));
    }
    dels = rest;
  }

  // arrêts : glouton le long de chaque tronçon
  const near = grid(dels, 50);
  const taken = new Set();
  const W = st.walkMax;
  for (const seed of dels) {
    if (taken.has(seed.id)) continue;
    const e = seed.e;
    if (seed.off > W) {  // long accès : arrêt à part, au plus près
      taken.add(seed.id);
      units.push(stopUnit(ctx, e, seed.t, [seed], false));
      continue;
    }
    const sameStreet = (d) => d.e === e || (g.es[e] >= 0 && g.es[d.e] === g.es[e]);
    const collect = (t) => {
      const p = g.pointAt(e, t);
      const out = [];
      for (const d of near(p.x, p.y, W)) {
        if (taken.has(d.id) || d.off > W || !sameStreet(d)) continue;
        if (Math.hypot(d.px - p.x, d.py - p.y) > W) continue;
        const mixOk = ctx.weave(e) && ctx.weave(d.e);
        if (!mixOk && sideOn(g, e, d) !== seed.sd) continue;
        out.push(d);
      }
      return out;
    };
    const len = g.elen[e];
    let t = Math.min(len, seed.t + 0.8 * W);
    let ms = collect(t);
    if (!ms.includes(seed)) {
      t = seed.t;
      ms = collect(t);
      if (!ms.includes(seed)) ms = [seed];
    }
    // recentrage sur l'étendue des adresses retenues
    const tps = ms.map((d) => (d.e === e ? d.t : g.project(e, d.px, d.py).t));
    const t2 = (Math.min(...tps) + Math.max(...tps)) / 2;
    const ms2 = collect(t2);
    if (ms2.includes(seed) && ms2.length >= ms.length) {
      t = t2;
      ms = ms2;
    }
    for (const d of ms) taken.add(d.id);
    const sides = new Set(ms.map((d) => sideOn(g, e, d)));
    units.push(stopUnit(ctx, e, t, ms, sides.size > 1));
  }
  return { units, missing };
}

// --------------------------------------------------------------- matrice

function positionOf(ctx, pt) {
  if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return null;
  const p = ctx.g.nearest(pt.x, pt.y, ctx.mode);
  if (!p) return null;
  const arcs = [2 * p.e, 2 * p.e + 1].filter((arc) => ctx.g.arcAllowed(arc, ctx.mode));
  return arcs.map((arc) => ({ arc, sIn: ctx.g.arcOffset(arc, p.t), sOut: ctx.g.arcOffset(arc, p.t) }));
}

function matrix(ctx, opts, start, end, onProgress) {
  const { g } = ctx;
  const C = g.costs(ctx.mode, ctx.st);
  const K = opts.length;
  const M = new Float64Array(K * K);
  const toEnd = new Float64Array(K);
  for (let i = 0; i < K; i++) {
    const o = opts[i];
    const res = g.search(C, { arc: o.arcOut ?? o.arc, s: o.sOut });
    for (let j = 0; j < K; j++) M[i * K + j] = i === j ? 0 : g.costTo(res, { arc: opts[j].arc, s: opts[j].sIn });
    toEnd[i] = end ? Math.min(...end.map((p) => g.costTo(res, { arc: p.arc, s: p.sIn }))) : 0;
    if (onProgress && i % 20 === 0) onProgress('matrice', i / K);
  }
  const fromStart = new Float64Array(K);
  if (start) {
    fromStart.fill(Infinity);
    for (const p of start) {
      const res = g.search(C, { arc: p.arc, s: p.sOut });
      for (let j = 0; j < K; j++) fromStart[j] = Math.min(fromStart[j], g.costTo(res, { arc: opts[j].arc, s: opts[j].sIn }));
    }
  }
  return { M, K, toEnd, fromStart, C };
}

// ---------------------------------------------------------- optimisation

class Tour {
  constructor(pb) {
    this.pb = pb;
  }

  cost(seq) {
    const { M, K, fromStart, toEnd, service } = this.pb;
    if (!seq.length) return 0;
    let c = fromStart[seq[0]] + toEnd[seq[seq.length - 1]];
    for (let k = 0; k < seq.length; k++) {
      c += service[seq[k]];
      if (k) c += M[seq[k - 1] * K + seq[k]];
    }
    return c;
  }
}

// orientation la meilleure pour un ordre d'unités imposé (programmation dynamique)
function bestOrientation(pb, unitOrder) {
  const { M, K, fromStart, toEnd, service, unitOpts } = pb;
  if (!unitOrder.length) return [];
  let prev = unitOpts[unitOrder[0]].map((o) => ({ o, c: fromStart[o] + service[o], back: null }));
  const layers = [prev];
  for (let k = 1; k < unitOrder.length; k++) {
    const cur = unitOpts[unitOrder[k]].map((o) => {
      let best = null;
      for (const p of prev) {
        const c = p.c + M[p.o * K + o] + service[o];
        if (!best || c < best.c) best = { o, c, back: p };
      }
      return best;
    });
    layers.push(cur);
    prev = cur;
  }
  let end = null;
  for (const p of prev) if (!end || p.c + toEnd[p.o] < end.c + toEnd[end.o]) end = p;
  const seq = [];
  for (let p = end; p; p = p.back) seq.push(p.o);
  return seq.reverse();
}

function nearestNeighbor(pb) {
  const { M, K, fromStart, unitOpts, unitOf } = pb;
  const left = new Set(unitOpts.keys());
  const seq = [];
  let cur = -1;
  while (left.size) {
    let best = -1;
    let bc = Infinity;
    for (const u of left) {
      for (const o of unitOpts[u]) {
        const c = cur < 0 ? fromStart[o] : M[cur * K + o];
        if (c < bc || best < 0) {
          bc = c;
          best = o;
        }
      }
    }
    seq.push(best);
    left.delete(unitOf[best]);
    cur = best;
  }
  return seq;
}

// recherche locale jusqu'à un optimum : changement d'orientation, déplacement de 1 à 3 unités (éventuellement
// inversées), inversion de portion (2-opt asymétrique : chaque unité prend son orientation inverse)
function localSearch(pb, seq, deadline) {
  const { M, K, fromStart, toEnd, service, partner, unitOpts, unitOf } = pb;
  const n = seq.length;
  const arc = (a, b) => (a < 0 ? (b < 0 ? 0 : fromStart[b]) : b < 0 ? toEnd[a] : M[a * K + b]);
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 200) {
    improved = false;
    if (performance.now() > deadline) break;
    // orientation
    for (let i = 0; i < n; i++) {
      const prev = i ? seq[i - 1] : -1;
      const next = i < n - 1 ? seq[i + 1] : -1;
      const o = seq[i];
      const base = arc(prev, o) + service[o] + arc(o, next);
      for (const alt of unitOpts[unitOf[o]]) {
        if (alt === o) continue;
        if (arc(prev, alt) + service[alt] + arc(alt, next) < base - 1e-9) {
          seq[i] = alt;
          improved = true;
          break;
        }
      }
    }
    // 2-opt asymétrique
    for (let i = 0; i < n - 1 && performance.now() <= deadline; i++) {
      const prev = i ? seq[i - 1] : -1;
      let oldIn = 0;   // coût interne de seq[i..j]
      let newIn = 0;   // coût interne de la portion inversée
      let dServ = service[partner[seq[i]]] - service[seq[i]];
      for (let j = i + 1; j < n; j++) {
        oldIn += M[seq[j - 1] * K + seq[j]];
        newIn += M[partner[seq[j]] * K + partner[seq[j - 1]]];
        dServ += service[partner[seq[j]]] - service[seq[j]];
        const next = j < n - 1 ? seq[j + 1] : -1;
        const before = arc(prev, seq[i]) + oldIn + arc(seq[j], next);
        const after = arc(prev, partner[seq[j]]) + newIn + arc(partner[seq[i]], next) + dServ;
        if (after < before - 1e-6) {
          const rev = seq.slice(i, j + 1).reverse().map((o) => partner[o]);
          seq.splice(i, j - i + 1, ...rev);
          improved = true;
          break;
        }
      }
    }
    // déplacement de 1 à 3 unités, à l'endroit ou inversées
    for (let L = 1; L <= 3 && performance.now() <= deadline; L++) {
      for (let i = 0; i + L <= n; i++) {
        const prev = i ? seq[i - 1] : -1;
        const next = i + L < n ? seq[i + L] : -1;
        const first = seq[i];
        const last = seq[i + L - 1];
        let inner = 0;
        let innerRev = 0;
        let dServ = 0;
        for (let k = i; k < i + L; k++) {
          if (k > i) {
            inner += M[seq[k - 1] * K + seq[k]];
            innerRev += M[partner[seq[k]] * K + partner[seq[k - 1]]];
          }
          dServ += service[partner[seq[k]]] - service[seq[k]];
        }
        const gain = arc(prev, first) + inner + arc(last, next) - arc(prev, next);
        const rest = seq.slice(0, i).concat(seq.slice(i + L));
        let best = null;
        for (let k = -1; k < rest.length; k++) {  // insertion entre rest[k] et rest[k + 1]
          if (k === i - 1) continue;
          const a = k >= 0 ? rest[k] : -1;
          const b = k + 1 < rest.length ? rest[k + 1] : -1;
          const base = arc(a, b);
          const fwd = arc(a, first) + inner + arc(last, b) - base;
          const rev = arc(a, partner[last]) + innerRev + arc(partner[first], b) - base + dServ;
          if (fwd < gain - 1e-6 && (!best || fwd < best.d)) best = { k, d: fwd, rev: false };
          if (rev < gain - 1e-6 && (!best || rev < best.d)) best = { k, d: rev, rev: true };
        }
        if (best) {
          let seg = seq.slice(i, i + L);
          if (best.rev) seg = seg.reverse().map((o) => partner[o]);
          rest.splice(best.k + 1, 0, ...seg);
          seq.splice(0, n, ...rest);
          improved = true;
        }
      }
    }
  }
  return seq;
}

function perturb(seq, rand) {
  const n = seq.length;
  if (n < 8) return seq.slice();
  // double pont : A B C D -> A C B D
  const cut = [1 + Math.floor(rand() * (n - 3))];
  cut.push(cut[0] + 1 + Math.floor(rand() * (n - cut[0] - 2)));
  cut.push(cut[1] + 1 + Math.floor(rand() * (n - cut[1] - 1)));
  const [p, q, r] = cut;
  return [...seq.slice(0, p), ...seq.slice(q, r), ...seq.slice(p, q), ...seq.slice(r)];
}

// --------------------------------------------------------------- calcul

// ids : adresses de la tournée ; order : ids dans l'ordre de passage actuel (comparaison et départ possible)
export function computeRoute({ graph, data, snap, ids, settings: saved, order = [], budgetMs = 2000, onProgress }) {
  const t0 = performance.now();
  const settings = settingsFor(saved);
  const ctx = new Ctx(graph, data, snap, settings);
  const { units: all, missing } = buildUnits(ctx, ids);
  onProgress?.('arrets', 1);
  const start = positionOf(ctx, settings.start);
  const endPt = settings.end === 'start' ? settings.start : settings.end;
  const end = positionOf(ctx, endPt);

  let units = all;
  let opts = [];
  const build = () => {
    opts = [];
    units.forEach((u, ui) => u.opts.forEach((o) => opts.push({ ...o, unit: ui })));
  };
  build();
  let mx = matrix(ctx, opts, start, end, onProgress);
  // unités injoignables (îlot du réseau) : écartées et signalées
  const unreachable = [];
  const reach = units.map((_, ui) => {
    const mine = opts.map((o, i) => (o.unit === ui ? i : -1)).filter((i) => i >= 0);
    const others = opts.map((o, i) => (o.unit !== ui ? i : -1)).filter((i) => i >= 0);
    if (!others.length) return mine.some((i) => Number.isFinite(mx.fromStart[i]) && Number.isFinite(mx.toEnd[i]));
    const inOk = mine.some((i) => others.some((j) => Number.isFinite(mx.M[j * mx.K + i])));
    const outOk = mine.some((i) => others.some((j) => Number.isFinite(mx.M[i * mx.K + j])));
    return inOk && outOk && mine.some((i) => Number.isFinite(mx.fromStart[i]));
  });
  if (reach.some((r) => !r)) {
    units.forEach((u, ui) => { if (!reach[ui]) unreachable.push(...u.ids); });
    units = units.filter((_, ui) => reach[ui]);
    build();
    mx = matrix(ctx, opts, start, end, onProgress);
  }

  const K = opts.length;
  const unitOpts = units.map(() => []);
  const unitOf = new Int32Array(K);
  opts.forEach((o, i) => {
    unitOpts[o.unit].push(i);
    unitOf[i] = o.unit;
  });
  // orientation inverse de chaque orientation (même unité, autre sens), sinon elle-même
  const partner = new Int32Array(K);
  opts.forEach((o, i) => {
    const out = o.arcOut ?? o.arc;
    const alt = unitOpts[o.unit].find((j) => j !== i && opts[j].arc === (out ^ 1));
    partner[i] = alt ?? i;
  });
  const service = Float64Array.from(opts, (o) => o.service);
  const pb = { ...mx, service, unitOpts, unitOf, partner };
  const tour = new Tour(pb);

  // ordre par rues (comparaison) : unités rangées selon leur première adresse dans l'ordre de passage actuel
  const rank = new Map(order.map((id, k) => [id, k]));
  const unitRank = units.map((u) => Math.min(...u.ids.map((id) => rank.get(id) ?? 1e9)));
  const byStreets = units.map((_, ui) => ui).sort((p, q) => unitRank[p] - unitRank[q]);
  const baseSeq = bestOrientation(pb, byStreets);
  const baseline = tour.cost(baseSeq);

  const rand = rng(settings.seed);
  const deadline = t0 + budgetMs;
  let best = localSearch(pb, nearestNeighbor(pb), deadline);
  let bestCost = tour.cost(best);
  const fromBase = localSearch(pb, baseSeq.slice(), deadline);
  if (tour.cost(fromBase) < bestCost) {
    best = fromBase;
    bestCost = tour.cost(fromBase);
  }
  let cur = best.slice();
  let curCost = bestCost;
  let rounds = 0;
  while (performance.now() < deadline && units.length >= 8) {
    rounds += 1;
    const cand = localSearch(pb, perturb(cur, rand), deadline);
    const c = tour.cost(cand);
    if (c < curCost - 1e-6 || rand() < 0.05) {
      cur = cand;
      curCost = c;
    }
    if (c < bestCost - 1e-6) {
      best = cand.slice();
      bestCost = c;
    }
    if (rounds % 10 === 0) onProgress?.('optimisation', Math.min(1, (performance.now() - t0) / budgetMs));
  }
  return describe(ctx, pb, opts, units, best, { start, end, baseline, missing, unreachable, rounds, ms: performance.now() - t0 });
}

// itinéraire détaillé d'une séquence d'orientations : arrêts, trajets, totaux
function describe(ctx, pb, opts, units, seq, extra) {
  const { g } = ctx;
  const stops = seq.map((o) => {
    const u = units[opts[o].unit];
    const op = opts[o];
    return {
      kind: u.kind, ids: op.order, sides: op.sides, arc: op.arc, sIn: op.sIn, arcOut: op.arcOut ?? op.arc, sOut: op.sOut,
      path: op.path || null, x: u.x, y: u.y, street: g.es[u.e], walk: u.walk, service: op.service, mixed: u.mixed,
    };
  });
  return {
    ...evaluate(ctx, stops, extra.start, extra.end),
    baseline: { sec: extra.baseline },
    missing: extra.missing,
    unreachable: extra.unreachable,
    rounds: extra.rounds,
    ms: Math.round(extra.ms),
  };
}

// trajets et totaux d'une suite d'arrêts (calculée, ou retouchée à la main) ; chaque arrêt reçoit le temps et la
// distance du trajet qui y mène (legSec, legM)
function evaluate(ctx, stops, start, end) {
  const { g } = ctx;
  const C = g.costs(ctx.mode, ctx.st);
  const legOf = (from, toPos) => {
    const res = g.search(C, from, { pred: true });
    const path = g.pathTo(res, toPos) || [];
    const m = path.reduce((s, p) => s + Math.max(0, p.s1 - p.s0), 0);
    return { arcs: path, sec: g.costTo(res, toPos), m };
  };
  const best = (froms, to) => {
    let out = null;
    for (const f of froms) {
      const leg = legOf(f, to);
      if (!out || leg.sec < out.sec) out = leg;
    }
    return out;
  };
  const legs = stops.map((st, k) => {
    if (k === 0) return start ? best(start.map((q) => ({ arc: q.arc, s: q.sOut })), { arc: st.arc, s: st.sIn }) : null;
    const prev = stops[k - 1];
    return legOf({ arc: prev.arcOut, s: prev.sOut }, { arc: st.arc, s: st.sIn });
  });
  let endLeg = null;
  if (end && stops.length) {
    const last = stops[stops.length - 1];
    for (const q of end) {
      const leg = legOf({ arc: last.arcOut, s: last.sOut }, { arc: q.arc, s: q.sIn });
      if (!endLeg || leg.sec < endLeg.sec) endLeg = leg;
    }
  }
  stops.forEach((st, k) => {
    st.legSec = legs[k] ? legs[k].sec : 0;
    st.legM = legs[k] ? legs[k].m : 0;
  });
  let travel = 0;
  let meters = 0;
  for (const l of [...legs, endLeg]) {
    if (!l) continue;
    travel += l.sec;
    meters += l.m;
  }
  const serviceSec = stops.reduce((s, x) => s + x.service, 0);
  const pathM = (x) => (x.path || []).reduce((s, p) => s + p.s1 - p.s0, 0);
  const runM = stops.reduce((s, x) => s + (x.kind === 'window' ? pathM(x) : 0), 0);
  return {
    mode: ctx.mode,
    settings: ctx.st,
    roadsVersion: g.version,
    stops,
    legs,
    endLeg,
    totals: {
      sec: travel + serviceSec,
      travelSec: travel,
      serviceSec,
      // à pied, trajets et portions de rue sont de la marche ; en véhicule, les trajets sont roulés
      driveM: ctx.mode === 'foot' ? 0 : meters + runM,
      walkM: (ctx.mode === 'foot' ? meters : 0) + stops.reduce((s, x) => s + x.walk, 0),
      stops: stops.length,
      addresses: stops.reduce((s, x) => s + x.ids.length, 0),
    },
  };
}

// ------------------------------------------------------ côté page : retouches

// contexte de calcul pour une tournée (fil principal) : réglages complétés, positions de départ et d'arrivée
export function planContext({ graph, data, snap, settings }) {
  const ctx = new Ctx(graph, data, snap, settingsFor(settings));
  const endPt = ctx.st.end === 'start' ? ctx.st.start : ctx.st.end;
  return { ctx, start: positionOf(ctx, ctx.st.start), end: positionOf(ctx, endPt) };
}

// itinéraire enregistré -> trajets et totaux à jour (après une retouche, ou pour l'afficher)
export function evaluateStops(plan, stops) {
  return evaluate(plan.ctx, stops.map((s) => ({ ...s })), plan.start, plan.end);
}

// arrêt du véhicule recalculé à une position imposée (arc, abscisse s depuis le début de l'arc) avec ces adresses
export function restop(plan, arc, s, ids) {
  const { ctx } = plan;
  const { g } = ctx;
  const e = arc >> 1;
  const t = arc & 1 ? g.elen[e] - s : s;
  const members = ids.map((id) => ctx.delivery(id)).filter(Boolean);
  if (!members.length) return null;
  const sides = new Set(members.map((d) => sideOn(g, e, d)));
  const u = stopUnit(ctx, e, t, members, sides.size > 1, [arc]);
  const o = u.opts[0];
  return {
    kind: 'stop', ids: o.order, sides: o.sides, arc, sIn: o.sIn, arcOut: arc, sOut: o.sOut, path: null,
    x: u.x, y: u.y, street: g.es[e], walk: u.walk, service: o.service, mixed: u.mixed,
  };
}

// fusionner l'arrêt k avec le suivant : le véhicule reste au premier, on dessert les deux à pied
export function mergeStops(plan, stops, k) {
  const a = stops[k];
  const b = stops[k + 1];
  if (!a || !b || a.kind !== 'stop' || b.kind !== 'stop') return null;
  const m = restop(plan, a.arc, a.sIn, [...a.ids, ...b.ids]);
  if (!m) return null;
  return [...stops.slice(0, k), m, ...stops.slice(k + 2)];
}

// séparer l'arrêt k en deux : la seconde moitié (dans le sens de parcours) devient un arrêt au droit de sa
// première adresse
export function splitStop(plan, stops, k) {
  const a = stops[k];
  if (!a || a.kind !== 'stop' || a.ids.length < 2) return null;
  const { ctx } = plan;
  const { g } = ctx;
  const half = Math.ceil(a.ids.length / 2);
  const first = restop(plan, a.arc, a.sIn, a.ids.slice(0, half));
  const d = ctx.delivery(a.ids[half]);
  const e = a.arc >> 1;
  const p = g.project(e, d.px, d.py);
  const second = restop(plan, a.arc, g.arcOffset(a.arc, p.t), a.ids.slice(half));
  if (!first || !second) return null;
  return [...stops.slice(0, k), first, second, ...stops.slice(k + 1)];
}

// composition changée : adresses retirées enlevées des arrêts ; adresses ajoutées rangées dans l'arrêt le plus
// proche (à moins de la marche max) ou dans un nouvel arrêt placé après lui. Les retouches sont gardées.
export function updateComposition(plan, stops, ids) {
  const { ctx } = plan;
  const { g, st } = ctx;
  const keep = new Set(ids);
  const out = stops.map((s) => {
    const kept = s.ids.map((id, k) => (keep.has(id) ? k : -1)).filter((k) => k >= 0);
    if (!kept.length) return null;
    if (kept.length === s.ids.length) return s;
    const ids2 = kept.map((k) => s.ids[k]);
    if (s.kind === 'stop') return restop(plan, s.arc, s.sIn, ids2) || { ...s, ids: ids2 };
    return { ...s, ids: ids2, sides: kept.map((k) => s.sides[k]) };
  }).filter(Boolean);
  const present = new Set(out.flatMap((s) => s.ids));
  const W = st.walkMax || 0;
  for (const id of ids) {
    if (present.has(id)) continue;
    const d = ctx.delivery(id);
    if (!d) continue;
    let bestK = -1;
    let bestD = Infinity;
    out.forEach((s, k) => {
      const dist = Math.hypot(s.x - d.px, s.y - d.py);
      if (dist < bestD) {
        bestD = dist;
        bestK = k;
      }
    });
    const near = out[bestK];
    if (near && near.kind === 'stop' && bestD <= W) {
      out[bestK] = restop(plan, near.arc, near.sIn, [...near.ids, id]) || near;
    } else {
      const arcs = [2 * d.e, 2 * d.e + 1].filter((a) => g.arcAllowed(a, ctx.mode));
      const arc = arcs.find((a) => (a & 1 ? -d.sd : d.sd) > 0) ?? arcs[0];
      const s = restop(plan, arc, g.arcOffset(arc, d.t), [id]);
      if (s) out.splice(bestK + 1, 0, s);
    }
    present.add(id);
  }
  return out;
}

// tracé d'un itinéraire pour la carte : trajets entre arrêts et portions parcourues, en polylignes
export function routeLines(graph, evaluated) {
  const lines = [];
  const add = (pieces) => {
    const pts = [];
    for (const p of pieces || []) {
      if (p.s1 - p.s0 < 0.05 && pieces.length > 1) continue;
      const seg = graph.arcPolyline(p.arc, p.s0, p.s1);
      if (pts.length) seg.shift();
      pts.push(...seg);
    }
    if (pts.length > 1) lines.push(pts);
  };
  evaluated.stops.forEach((s, k) => {
    if (evaluated.legs[k]) add(evaluated.legs[k].arcs);
    if (s.path) add(s.path);
  });
  if (evaluated.endLeg) add(evaluated.endLeg.arcs);
  return lines;
}
