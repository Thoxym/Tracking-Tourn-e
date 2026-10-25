// Guidage sur un trajet entre deux arrêts, sans DOM : polyligne, consignes de virage (angles aux nœuds, ronds-points),
// position sur le trajet (abscisse, écart), recalcul depuis une position hors itinéraire. Repère SVG (y vers le bas) :
// un angle positif entre deux caps est un virage à droite.

const CLS_ROUNDABOUT = 1;
const DEG = 180 / Math.PI;

const angleDiff = (a, b) => {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
};

// nom affiché d'un tronçon (voie BAN de la commune, nom BAN ou numéro de route), '' sinon
export const edgeName = (g, e) => (g.ename[e] >= 0 ? g.names[g.ename[e]] : '');

function classify(g, inArc, outArc) {
  if ((inArc ^ 1) === outArc) return { type: 'uturn', dir: null };
  const d = angleDiff(g.capIn[inArc], g.capOut[outArc]) * DEG;
  const a = Math.abs(d);
  const dir = d > 0 ? 'right' : 'left';
  if (a < 25) return { type: 'straight', dir: null };
  if (a < 55) return { type: 'slight', dir };
  if (a < 135) return { type: 'turn', dir };
  if (a < 170) return { type: 'sharp', dir };
  return { type: 'uturn', dir: null };
}

// trajet : morceaux d'arcs [{arc, s0, s1}] -> {pts, cum, total, maneuvers: [{at, type, dir, name, exit?}]}
export function buildLeg(g, arcs, mode = 'car') {
  const pts = [];
  const cum = [];
  let total = 0;
  const raw = [];
  (arcs || []).forEach((p, i) => {
    if (i > 0) {
      const prev = arcs[i - 1].arc;
      raw.push({ at: total, ...classify(g, prev, p.arc), name: edgeName(g, p.arc >> 1), arc: p.arc, prev, node: g.arcStart(p.arc) });
    }
    for (const pt of g.arcPolyline(p.arc, p.s0, p.s1)) {
      if (pts.length) {
        const last = pts[pts.length - 1];
        const d = Math.hypot(pt.x - last.x, pt.y - last.y);
        if (d < 0.01) continue;
        total += d;
      }
      pts.push(pt);
      cum.push(total);
    }
  });
  // ronds-points : une seule consigne à l'entrée, avec le numéro de la sortie
  const isRb = (arc) => g.ecls[arc >> 1] === CLS_ROUNDABOUT;
  const maneuvers = [];
  let lastName = arcs?.length ? edgeName(g, arcs[0].arc >> 1) : '';
  for (let k = 0; k < raw.length; k++) {
    const m = raw[k];
    if (isRb(m.arc) && !isRb(m.prev)) {
      let exits = 0;
      let j = k + 1;
      for (; j < raw.length && isRb(raw[j].arc); j++) {
        // nœud intérieur : une sortie s'il y a une autre route praticable (hors rond-point)
        const node = raw[j].node;
        for (let q = g.outStart[node]; q < g.outStart[node + 1]; q++) {
          const o = g.out[q];
          if (!isRb(o) && g.arcAllowed(o, mode) && o !== (raw[j].prev ^ 1)) {
            exits += 1;
            break;
          }
        }
      }
      const exit = raw[j];  // consigne de sortie (premier arc hors du rond-point)
      maneuvers.push({ at: m.at, type: 'roundabout', dir: null, exit: exits + 1, name: exit ? exit.name : '' });
      if (exit) lastName = exit.name;
      k = exit ? j : raw.length;
      continue;
    }
    if (m.type === 'straight' && (!m.name || m.name === lastName)) {
      if (m.name) lastName = m.name;
      continue;
    }
    maneuvers.push({ at: m.at, type: m.type, dir: m.dir, name: m.name });
    if (m.name) lastName = m.name;
  }
  return { pts, cum, total, maneuvers };
}

// position sur le trajet : abscisse le long du trajet et écart au tracé ; près de l'abscisse précédente si connue
// (un trajet qui revient sur ses pas ne doit pas faire sauter la position d'un passage à l'autre)
export function locate(leg, x, y, prev = null) {
  let best = null;
  for (let k = 1; k < leg.pts.length; k++) {
    const a = leg.pts[k - 1];
    const b = leg.pts[k];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L2 = dx * dx + dy * dy || 1e-9;
    const f = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / L2));
    const perp = Math.hypot(x - (a.x + f * dx), y - (a.y + f * dy));
    const along = leg.cum[k - 1] + f * Math.sqrt(L2);
    const score = perp + (prev !== null && Math.abs(along - prev) > 200 ? 100 : 0);
    if (!best || score < best.score) best = { along, perp, score };
  }
  return best ? { along: best.along, perp: best.perp } : { along: 0, perp: Infinity };
}

// prochaine consigne après l'abscisse `along` (ou l'arrivée), et la distance qui reste jusqu'à elle
export function nextManeuver(leg, along) {
  const m = leg.maneuvers.find((x) => x.at > along + 3);
  if (m) return { ...m, dist: m.at - along };
  return { type: 'arrive', dir: null, name: '', at: leg.total, dist: Math.max(0, leg.total - along) };
}

const ORD = (n) => (n === 1 ? '1re' : `${n}e`);
const DIR = { right: 'à droite', left: 'à gauche' };

// consigne en français ; `stop` : libellé de l'arrêt pour l'arrivée
export function instruction(m, stop = '') {
  const on = m.name ? ` sur ${m.name}` : '';
  switch (m.type) {
    case 'straight': return m.name ? `Continuez sur ${m.name}` : 'Continuez tout droit';
    case 'slight': return `Légèrement ${DIR[m.dir]}${on}`;
    case 'turn': return `Tournez ${DIR[m.dir]}${on}`;
    case 'sharp': return `Tournez franchement ${DIR[m.dir]}${on}`;
    case 'uturn': return 'Faites demi-tour';
    case 'roundabout': return `Au rond-point, prenez la ${ORD(m.exit)} sortie${m.name ? ` vers ${m.name}` : ''}`;
    default: return stop ? `Arrivée : ${stop}` : 'Arrivée';
  }
}

// distance arrondie pour l'affichage : « 80 m », « 1,2 km »
export function formatDist(m) {
  if (m < 1000) return `${Math.max(0, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km`;
}

// Nouveau trajet depuis une position (hors itinéraire) jusqu'à une position {arc, s}. `heading` : cap de marche
// (radians, repère SVG) pour choisir le sens sur le tronçon de départ, ou null.
export function reroute(g, mode, costOpts, x, y, heading, dst) {
  const p = g.nearest(x, y, mode);
  if (!p) return null;
  const C = g.costs(mode, costOpts);
  let best = null;
  for (const arc of [2 * p.e, 2 * p.e + 1]) {
    if (!g.arcAllowed(arc, mode)) continue;
    const s = g.arcOffset(arc, p.t);
    let penalty = 0;
    if (heading !== null && mode !== 'foot') {
      const cap = g.bearingAt(p.e, p.t) + (arc & 1 ? Math.PI : 0);
      if (Math.abs(angleDiff(cap, heading)) > Math.PI / 2) penalty = 120;  // contre le sens de marche : demi-tour
    }
    const res = g.search(C, { arc, s }, { pred: true });
    const cost = g.costTo(res, dst) + penalty;
    if (Number.isFinite(cost) && (!best || cost < best.cost)) best = { cost, arcs: g.pathTo(res, dst) };
  }
  return best && best.arcs ? best.arcs : null;
}
