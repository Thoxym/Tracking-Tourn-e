// Réseau routier (data/roads.json) et plus courts chemins, sans DOM (utilisable dans un worker).
//
// Dijkstra sur les **arcs orientés** : un état = un tronçon parcouru dans un sens (arc 2e : de a vers b,
// arc 2e+1 : de b vers a). On peut ainsi pénaliser les demi-tours et les virages serrés, et une position
// « garée sur ce tronçon, dans ce sens » est un point de départ ou d'arrivée exact (sens uniques, côté de la route).
// Les coûts sont des secondes, selon le mode (voiture, vélo, pied). Coordonnées : repère SVG du plan (y vers le bas).

export const CAR = 1;
export const BIKE = 2;
export const FOOT = 4;
export const PRIVATE = 8;
export const MODE_BIT = { car: CAR, bike: BIKE, foot: FOOT };

const CLS_ROAD = 0;
const CLS_EMPIERREE = 5;
const CLS_CHEMIN = 6;
const CLS_SENTIER = 7;
const CLS_ESCALIER = 8;
const CLS_DESSERTE = 11;

// coûts propres aux modes (secondes, facteurs)
export const MODE_COSTS = {
  car: { privateFactor: 1.5, uTurn: 60, uTurnDeadEnd: 20, sharpTurn: 6, turn: 2, reverse: Infinity },
  bike: { privateFactor: 1.2, uTurn: 8, uTurnDeadEnd: 4, sharpTurn: 1, turn: 0, reverse: 5 },
  foot: { privateFactor: 1, uTurn: 0, uTurnDeadEnd: 0, sharpTurn: 0, turn: 0, reverse: 0 },
};

const angleDiff = (a, b) => {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
};

// file de priorité (tas binaire) sur des paires (coût, arc), suppression paresseuse
class Heap {
  constructor(n) {
    this.k = new Float64Array(n);
    this.v = new Int32Array(n);
    this.n = 0;
  }

  push(k, v) {
    if (this.n === this.k.length) {
      const k2 = new Float64Array(this.n * 2);
      const v2 = new Int32Array(this.n * 2);
      k2.set(this.k);
      v2.set(this.v);
      this.k = k2;
      this.v = v2;
    }
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= k) break;
      this.k[i] = this.k[p];
      this.v[i] = this.v[p];
      i = p;
    }
    this.k[i] = k;
    this.v[i] = v;
  }

  pop() {  // renvoie l'arc ; le coût est dans this.top
    const v = this.v[0];
    this.top = this.k[0];
    const k = this.k[--this.n];
    const x = this.v[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && this.k[c + 1] < this.k[c]) c += 1;
      if (this.k[c] >= k) break;
      this.k[i] = this.k[c];
      this.v[i] = this.v[c];
      i = c;
    }
    this.k[i] = k;
    this.v[i] = x;
    return v;
  }
}

export class RoadGraph {
  constructor(roads) {
    this.version = roads.version;
    this.names = roads.names;
    const n = roads.nodes.length / 2;
    this.nx = new Float64Array(n);
    this.ny = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.nx[i] = roads.nodes[2 * i];
      this.ny[i] = roads.nodes[2 * i + 1];
    }
    const E = roads.edges.length;
    this.E = E;
    this.ea = new Int32Array(E);
    this.eb = new Int32Array(E);
    this.elen = new Float64Array(E);
    this.em = new Uint8Array(E);
    this.eow = new Int8Array(E);
    this.ev = new Float64Array(E);
    this.es = new Int32Array(E);
    this.ename = new Int32Array(E);
    this.enw = new Uint8Array(E);
    this.ecls = new Uint8Array(E);
    this.geom = new Array(E);  // [x0, y0, x1, y1, …] extrémités comprises
    this.cum = new Array(E);   // abscisses cumulées des sommets
    for (let e = 0; e < E; e++) {
      const [a, b, , m, ow, v, s, name, nw, cls, mid] = roads.edges[e];
      this.ea[e] = a;
      this.eb[e] = b;
      this.em[e] = m;
      this.eow[e] = ow;
      this.ev[e] = v;
      this.es[e] = s;
      this.ename[e] = name;
      this.enw[e] = nw;
      this.ecls[e] = cls;
      const g = [this.nx[a], this.ny[a], ...mid, this.nx[b], this.ny[b]];
      const cum = new Float64Array(g.length / 2);
      for (let k = 1; k < cum.length; k++) {
        cum[k] = cum[k - 1] + Math.hypot(g[2 * k] - g[2 * k - 2], g[2 * k + 1] - g[2 * k - 1]);
      }
      this.geom[e] = g;
      this.cum[e] = cum;
      this.elen[e] = cum[cum.length - 1] || 0.01;
    }
    // arcs sortants de chaque nœud (arc 2e part de a, arc 2e+1 part de b)
    const deg = new Int32Array(n + 1);
    for (let e = 0; e < E; e++) {
      deg[this.ea[e] + 1] += 1;
      deg[this.eb[e] + 1] += 1;
    }
    for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
    this.outStart = deg;
    this.out = new Int32Array(2 * E);
    const fill = deg.slice(0, n);
    for (let e = 0; e < E; e++) {
      this.out[fill[this.ea[e]]++] = 2 * e;
      this.out[fill[this.eb[e]]++] = 2 * e + 1;
    }
    // caps de départ et d'arrivée de chaque arc (virages)
    this.capIn = new Float64Array(2 * E);
    this.capOut = new Float64Array(2 * E);
    for (let e = 0; e < E; e++) {
      const g = this.geom[e];
      const L = g.length;
      const c0 = Math.atan2(g[3] - g[1], g[2] - g[0]);           // au départ de a
      const c1 = Math.atan2(g[L - 1] - g[L - 3], g[L - 2] - g[L - 4]);  // à l'arrivée en b
      this.capOut[2 * e] = c0;
      this.capIn[2 * e] = c1;
      this.capOut[2 * e + 1] = c1 + Math.PI;
      this.capIn[2 * e + 1] = c0 + Math.PI;
    }
    this._costs = {};
  }

  arcStart(arc) { return arc & 1 ? this.eb[arc >> 1] : this.ea[arc >> 1]; }
  arcEnd(arc) { return arc & 1 ? this.ea[arc >> 1] : this.eb[arc >> 1]; }

  // abscisse depuis le début de l'arc d'un point d'abscisse t (depuis a) sur le tronçon
  arcOffset(arc, t) { return arc & 1 ? this.elen[arc >> 1] - t : t; }

  allowed(e, mode) {
    return Boolean(this.em[e] & MODE_BIT[mode]);
  }

  // l'arc est-il praticable dans ce mode (accès et sens unique ; le piéton ignore les sens uniques)
  arcAllowed(arc, mode) {
    const e = arc >> 1;
    if (!(this.em[e] & MODE_BIT[mode])) return false;
    if (mode === 'foot' || !this.eow[e]) return true;
    return this.eow[e] === (arc & 1 ? -1 : 1);
  }

  // coût (s) de chaque arc, par mode et réglages de vitesse
  costs(mode, { walkKmh = 4.5, bikeKmh = 15 } = {}) {
    const key = `${mode}|${walkKmh}|${bikeKmh}`;
    if (this._costs[key]) return this._costs[key];
    const p = MODE_COSTS[mode];
    const c = new Float64Array(2 * this.E);
    for (let arc = 0; arc < 2 * this.E; arc++) {
      const e = arc >> 1;
      if (!this.arcAllowed(arc, mode)) {
        c[arc] = Infinity;
        continue;
      }
      let mps;
      const cls = this.ecls[e];
      if (mode === 'car') mps = this.ev[e] / 3.6;
      else if (mode === 'bike') {
        mps = ([CLS_CHEMIN, CLS_EMPIERREE, CLS_SENTIER, CLS_DESSERTE].includes(cls) ? bikeKmh * 0.66 : bikeKmh) / 3.6;
      } else mps = (cls === CLS_ESCALIER ? walkKmh * 0.5 : walkKmh) / 3.6;
      c[arc] = (this.elen[e] / mps) * (this.em[e] & PRIVATE ? p.privateFactor : 1);
    }
    // impasses (un seul tronçon praticable au nœud) : demi-tour obligatoire, moins pénalisé
    const dead = new Uint8Array(this.nx.length);
    for (let i = 0; i < this.nx.length; i++) {
      let k = 0;
      for (let j = this.outStart[i]; j < this.outStart[i + 1]; j++) if (this.em[this.out[j] >> 1] & MODE_BIT[mode]) k += 1;
      dead[i] = k <= 1 ? 1 : 0;
    }
    this._costs[key] = { arc: c, dead, p, mode };
    return this._costs[key];
  }

  turnCost(C, inArc, outArc, node) {
    const { p } = C;
    if ((inArc ^ 1) === outArc) return C.dead[node] ? p.uTurnDeadEnd : p.uTurn;
    if (!p.turn && !p.sharpTurn) return 0;
    const d = Math.abs(angleDiff(this.capIn[inArc], this.capOut[outArc]));
    if (d > 2.1) return p.sharpTurn;
    return d > 0.8 ? p.turn : 0;
  }

  // Plus courts chemins depuis une position {arc, s} (s : abscisse depuis le début de l'arc). Renvoie les coûts
  // pour **entrer** dans chaque arc par son début (label), et les prédécesseurs si demandé.
  search(C, src, { pred = false } = {}) {
    const n = 2 * this.E;
    const label = new Float64Array(n).fill(Infinity);
    const prev = pred ? new Int32Array(n).fill(-1) : null;  // -1 : inconnu ; <= -2 : depuis l'arc source -(arc + 2)
    const heap = new Heap(256);
    const seed = (arc, s, base) => {
      const e = arc >> 1;
      const rate = C.arc[arc] / this.elen[e];
      if (!Number.isFinite(rate)) return;
      const toEnd = base + (this.elen[e] - s) * rate;
      const node = this.arcEnd(arc);
      for (let j = this.outStart[node]; j < this.outStart[node + 1]; j++) {
        const o = this.out[j];
        if (!Number.isFinite(C.arc[o])) continue;
        const k = toEnd + this.turnCost(C, arc, o, node);
        if (k < label[o]) {
          label[o] = k;
          if (prev) prev[o] = -(arc + 2);
          heap.push(k, o);
        }
      }
    };
    seed(src.arc, src.s, 0);
    // demi-tour sur place (piéton gratuit, vélo léger, voiture interdit)
    const rev = C.p.reverse;
    if (Number.isFinite(rev)) {
      const e = src.arc >> 1;
      const back = src.arc ^ 1;
      if (Number.isFinite(C.arc[back])) {
        seed(back, this.elen[e] - src.s, rev);
      }
    }
    while (heap.n) {
      const arc = heap.pop();
      const k = heap.top;
      if (k > label[arc]) continue;
      const node = this.arcEnd(arc);
      const kEnd = k + C.arc[arc];
      for (let j = this.outStart[node]; j < this.outStart[node + 1]; j++) {
        const o = this.out[j];
        if (!Number.isFinite(C.arc[o])) continue;
        const k2 = kEnd + this.turnCost(C, arc, o, node);
        if (k2 < label[o]) {
          label[o] = k2;
          if (prev) prev[o] = arc;
          heap.push(k2, o);
        }
      }
    }
    return { label, prev, src, C };
  }

  // coût du chemin d'une recherche jusqu'à une position {arc, s} ; si le mode permet le demi-tour sur place
  // (piéton, vélo), la position peut aussi être atteinte dans l'autre sens
  costTo(res, dst) {
    const direct = this._costTo(res, dst);
    const rev = res.C.p.reverse;
    if (!Number.isFinite(rev)) return direct;
    return Math.min(direct, rev + this._costTo(res, this._flip(dst)));
  }

  _flip(dst) {
    return { arc: dst.arc ^ 1, s: this.elen[dst.arc >> 1] - dst.s };
  }

  _costTo(res, dst) {
    const { C, src } = res;
    const e = dst.arc >> 1;
    const rate = C.arc[dst.arc] / this.elen[e];
    if (!Number.isFinite(rate)) return Infinity;
    let best = res.label[dst.arc] + dst.s * rate;
    if (dst.arc === src.arc && dst.s >= src.s - 1e-6) best = Math.min(best, (dst.s - src.s) * rate);
    const rev = C.p.reverse;
    if (Number.isFinite(rev) && dst.arc === (src.arc ^ 1)) {
      const s0 = this.elen[e] - src.s;
      if (dst.s >= s0 - 1e-6) best = Math.min(best, rev + (dst.s - s0) * rate);
    }
    return best;
  }

  // chemin (suite d'arcs avec leurs abscisses de début et de fin) d'une recherche avec prédécesseurs
  pathTo(res, dst) {
    const rev = res.C.p.reverse;
    if (Number.isFinite(rev) && rev + this._costTo(res, this._flip(dst)) < this._costTo(res, dst)) {
      return this._pathTo(res, this._flip(dst));
    }
    return this._pathTo(res, dst);
  }

  _pathTo(res, dst) {
    const { C, src } = res;
    const e = dst.arc >> 1;
    const rate = C.arc[dst.arc] / this.elen[e];
    const via = res.label[dst.arc] + dst.s * rate;
    if (dst.arc === src.arc && dst.s >= src.s - 1e-6 && (dst.s - src.s) * rate <= via) {
      return [{ arc: src.arc, s0: src.s, s1: dst.s }];
    }
    const rev = C.p.reverse;
    if (Number.isFinite(rev) && dst.arc === (src.arc ^ 1)) {
      const s0 = this.elen[e] - src.s;
      if (dst.s >= s0 - 1e-6 && rev + (dst.s - s0) * rate <= via) return [{ arc: dst.arc, s0, s1: dst.s }];
    }
    const arcs = [];
    let a = dst.arc;
    let guard = 0;
    while (a >= 0 && guard++ < 100000) {
      arcs.push(a);
      const p = res.prev[a];
      if (p === -1) return null;  // inaccessible
      if (p < -1) {  // arc source (ou son demi-tour)
        const from = -p - 2;
        arcs.push(from);
        break;
      }
      a = p;
    }
    arcs.reverse();
    return arcs.map((arc, k) => {
      const len = this.elen[arc >> 1];
      let s0 = 0;
      let s1 = len;
      if (k === 0) s0 = arc === src.arc ? src.s : len - src.s;
      if (k === arcs.length - 1) s1 = dst.s;
      return { arc, s0, s1 };
    });
  }

  // ---------------------------------------------------------------- géométrie

  // point d'abscisse t (depuis a) sur le tronçon e
  pointAt(e, t) {
    const g = this.geom[e];
    const cum = this.cum[e];
    const tt = Math.max(0, Math.min(this.elen[e], t));
    let k = 1;
    while (k < cum.length - 1 && cum[k] < tt) k += 1;
    const seg = cum[k] - cum[k - 1] || 1;
    const f = (tt - cum[k - 1]) / seg;
    return { x: g[2 * k - 2] + f * (g[2 * k] - g[2 * k - 2]), y: g[2 * k - 1] + f * (g[2 * k + 1] - g[2 * k - 1]) };
  }

  // cap (radians, repère SVG) du tronçon e au point t, dans le sens a -> b
  bearingAt(e, t) {
    const a = this.pointAt(e, Math.max(0, t - 1));
    const b = this.pointAt(e, Math.min(this.elen[e], t + 1));
    return Math.atan2(b.y - a.y, b.x - a.x);
  }

  // projection d'un point sur le tronçon : abscisse, distance, côté (+1 à droite dans le sens a -> b)
  project(e, x, y) {
    const g = this.geom[e];
    const cum = this.cum[e];
    let best = { t: 0, d: Infinity, side: 1 };
    for (let k = 1; k < cum.length; k++) {
      const x0 = g[2 * k - 2];
      const y0 = g[2 * k - 1];
      const dx = g[2 * k] - x0;
      const dy = g[2 * k + 1] - y0;
      const L2 = dx * dx + dy * dy || 1e-9;
      const f = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / L2));
      const px = x0 + f * dx;
      const py = y0 + f * dy;
      const d = Math.hypot(x - px, y - py);
      if (d < best.d) {
        // y vers le bas : à droite du sens de marche si le produit vectoriel est positif
        const cross = dx * (y - py) - dy * (x - px);
        best = { t: cum[k - 1] + f * Math.sqrt(L2), d, side: cross >= 0 ? 1 : -1 };
      }
    }
    return best;
  }

  // tronçons de la plus grande composante connexe du mode (sans tenir compte des sens uniques) : un îlot du réseau
  // (parking, sentier isolé) ne doit pas recevoir une adresse injoignable
  main(mode) {
    this._main ??= {};
    if (this._main[mode]) return this._main[mode];
    const n = this.nx.length;
    const up = Int32Array.from({ length: n }, (_, i) => i);
    const find = (i) => {
      while (up[i] !== i) {
        up[i] = up[up[i]];
        i = up[i];
      }
      return i;
    };
    for (let e = 0; e < this.E; e++) if (this.em[e] & MODE_BIT[mode]) up[find(this.ea[e])] = find(this.eb[e]);
    const size = new Map();
    for (let e = 0; e < this.E; e++) {
      if (!(this.em[e] & MODE_BIT[mode])) continue;
      const r = find(this.ea[e]);
      size.set(r, (size.get(r) || 0) + this.elen[e]);
    }
    let root = -1;
    for (const [r, len] of size) if (root < 0 || len > size.get(root)) root = r;
    const out = new Uint8Array(this.E);
    for (let e = 0; e < this.E; e++) out[e] = this.em[e] & MODE_BIT[mode] && find(this.ea[e]) === root ? 1 : 0;
    this._main[mode] = out;
    return out;
  }

  // tronçon praticable le plus proche d'un point, pour un mode (dans sa composante principale)
  nearest(x, y, mode) {
    const main = this.main(mode);
    let best = null;
    for (let e = 0; e < this.E; e++) {
      if (!main[e]) continue;
      const g = this.geom[e];
      // rejet rapide sur la boîte englobante
      let minx = Infinity;
      let miny = Infinity;
      let maxx = -Infinity;
      let maxy = -Infinity;
      for (let k = 0; k < g.length; k += 2) {
        if (g[k] < minx) minx = g[k];
        if (g[k] > maxx) maxx = g[k];
        if (g[k + 1] < miny) miny = g[k + 1];
        if (g[k + 1] > maxy) maxy = g[k + 1];
      }
      const bd = Math.hypot(Math.max(0, minx - x, x - maxx), Math.max(0, miny - y, y - maxy));
      if (best && bd >= best.d) continue;
      const p = this.project(e, x, y);
      if (!best || p.d < best.d) best = { e, ...p };
    }
    return best;
  }

  // points d'un morceau d'arc (abscisses depuis le début de l'arc), dans le sens de l'arc
  arcPolyline(arc, s0, s1) {
    const e = arc >> 1;
    const len = this.elen[e];
    const t0 = arc & 1 ? len - s0 : s0;
    const t1 = arc & 1 ? len - s1 : s1;
    const lo = Math.min(t0, t1);
    const hi = Math.max(t0, t1);
    const g = this.geom[e];
    const cum = this.cum[e];
    const pts = [this.pointAt(e, lo)];
    for (let k = 1; k < cum.length - 1; k++) if (cum[k] > lo && cum[k] < hi) pts.push({ x: g[2 * k], y: g[2 * k + 1] });
    pts.push(this.pointAt(e, hi));
    if (t0 > t1) pts.reverse();
    return pts;
  }
}
