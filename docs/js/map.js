// Plan SVG métrique (1 unité = 1 m, nord en haut) : couches, zoom et déplacement par le viewBox,
// gestes (glisser, pincer, molette, clavier) et résolution des taps sur les numéros.

const SVGNS = 'http://www.w3.org/2000/svg';
const K_MAX = 40;              // zoom maximal, en pixels par mètre
const K_NUMBERS = 0.9;         // en dessous : points à la place des numéros, un tap rapproche
const K_LABELS = 0.4;          // en dessous : pas d'étiquettes de rues
const TAP_RADIUS_PX = 22;
const DRAG_THRESHOLD_PX = 4;   // pointer capture seulement au-delà (sinon le click part sur le <svg>)
const LONG_PRESS_MS = 600;
const DOUBLE_TAP_MS = 300;
const VIEW_MARGIN_M = 200;     // le centre de la vue reste à moins de 200 m du cadre

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function el(name, attrs, parent) {
  const e = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

export class MapView {
  constructor(container, data, plan) {
    this.container = container;
    this.data = data;
    this.W = data.frame.W;
    this.H = data.frame.H;
    this.k = 1;
    this.cx = this.W / 2;
    this.cy = this.H / 2;
    this.kMin = 0.05;
    this.padding = { top: 0, right: 0, bottom: 0, left: 0 };
    this.hidden = new Set();
    this.selectedStreet = null;
    this.selectedId = null;
    this.byId = new Map(data.addresses.map((a) => [a.id, a]));
    this.pointable = data.addresses.filter((a) => !a.ctx);
    this.scope = null;       // ids de la tournée active (null : tout) ; hors tournée = gris, non pointable
    this.selecting = false;  // composition sur la carte (Préparer) : toutes les adresses sont pointables
    this.picking = false;    // point à placer (itinéraire) : un tap donne sa position, à tout zoom
    this.handlers = {};
    this.pointers = new Map();
    this.gesture = null;
    this._build(plan);
    this._bindGestures();
    new ResizeObserver(() => this._onResize()).observe(container);
  }

  on(type, fn) {
    (this.handlers[type] ||= []).push(fn);
    return this;
  }

  emit(type, detail) {
    for (const fn of this.handlers[type] || []) fn(detail);
  }

  // ------------------------------------------------------------- rendu

  _build(plan) {
    const svg = (this.svg = el('svg', { class: 'map', 'aria-hidden': 'true' }, this.container));
    const layer = (cls) => el('g', { class: cls }, svg);
    const lParcels = layer('l-parcels');
    const lTraces = layer('l-traces');
    const lBuildings = layer('l-buildings');
    this.lRoute = layer('l-route');
    this.lLabels = layer('l-labels');
    const lDots = layer('l-dots');
    this.lNumbers = layer('l-numbers');
    this.lTags = layer('l-tags');
    this.tagRing = el('path', { class: 'tag-ring' }, this.lTags);
    this.tagDot = el('path', { class: 'tag-dot' }, this.lTags);
    this.tagged = [];
    this.lRouteStops = layer('l-route-stops');
    this.lSelect = layer('l-select');
    this.lGps = layer('l-gps');

    const streets = this.data.streets;
    this.streetGroups = streets.map(() => []);
    const groups = (parent) => streets.map((_, i) => {
      const g = el('g', { class: 's', 'data-s': i }, parent);
      this.streetGroups[i].push(g);
      return g;
    });

    el('path', { class: 'parcels', d: plan.parcels }, lParcels);
    groups(lTraces).forEach((g, i) => el('path', { class: 'trace', d: plan.traces[i] || '' }, g));

    // bâtiments liés : couleur de la rue de leurs adresses pointables
    el('path', { class: 'bld-other', d: plan.buildingsOther }, lBuildings);
    const gBld = groups(lBuildings);
    const owners = new Map();
    for (const a of this.data.addresses) {
      if (!a.bat) continue;
      if (!owners.has(a.bat)) owners.set(a.bat, []);
      owners.get(a.bat).push(a);
    }
    this.buildingEls = new Map();
    for (const [bat, addrs] of owners) {
      const main = addrs.find((a) => !a.ctx);
      const parent = main ? gBld[main.s] : lBuildings;
      const path = el('path', { class: main ? 'bld' : 'bld-other', d: plan.buildings[bat] || '' }, parent);
      this.buildingEls.set(bat, { path, ids: addrs.filter((a) => !a.ctx).map((a) => a.id) });
    }

    groups(this.lLabels).forEach((g, i) => {
      for (const lb of streets[i].labels || []) {
        const t = el('text', { class: 'slabel', transform: `translate(${lb.x} ${lb.y}) rotate(${lb.a})` }, g);
        t.textContent = streets[i].name;
      }
    });

    const gDots = groups(lDots);
    const gNums = groups(this.lNumbers);
    this.addrEls = new Map();
    for (const a of this.data.addresses) {
      const cls = a.ctx ? ' ctx' : '';
      // trait de longueur nulle à bout rond + non-scaling-stroke = point de taille constante à l'écran
      const dot = el('path', { class: 'dot' + cls, d: `M${a.x} ${a.y}h0.01` }, gDots[a.s]);
      const num = el('text', { class: 'num' + cls, x: a.x, y: a.y, 'data-id': a.id }, gNums[a.s]);
      num.textContent = String(a.n);
      if (a.rep) el('tspan', { class: 'rep' }, num).textContent = a.rep;
      this.addrEls.set(a.id, { num, dot });
    }

    this.ring = el('circle', { class: 'sel-ring', r: 1, display: 'none' }, this.lSelect);
    this.markEl = el('circle', { class: 'mark-ring', r: 1, display: 'none' }, this.lSelect);

    this.lGps.setAttribute('display', 'none');
    this.gpsAcc = el('circle', { class: 'gps-acc', r: 1 }, this.lGps);
    this.gpsHalo = el('path', { class: 'gps-halo' }, this.lGps);
    this.gpsDot = el('path', { class: 'gps-dot' }, this.lGps);
  }

  // position GPS : {x, y, acc, quality: good|mid|bad|stale} ou null pour masquer
  setGps(pos) {
    if (!pos) {
      this.lGps.setAttribute('display', 'none');
      return;
    }
    this.lGps.setAttribute('display', 'inline');
    this.lGps.setAttribute('class', `l-gps q-${pos.quality}`);
    this.gpsAcc.setAttribute('cx', pos.x);
    this.gpsAcc.setAttribute('cy', pos.y);
    this.gpsAcc.setAttribute('r', Math.max(pos.acc, 0.5));
    const d = `M${pos.x} ${pos.y}h0.01`;  // point de taille constante (non-scaling-stroke)
    this.gpsHalo.setAttribute('d', d);
    this.gpsDot.setAttribute('d', d);
  }

  inScope(a) {
    return !this.scope || this.scope.has(a.id);
  }

  // périmètre de la tournée active : numéros, points et bâtiments hors tournée en gris, rues sans adresse
  // de la tournée atténuées
  setScope(ids) {
    this.scope = ids ? new Set(ids) : null;
    const used = new Set();
    for (const a of this.pointable) {
      const inside = this.inScope(a);
      if (inside) used.add(a.s);
      const { num, dot } = this.addrEls.get(a.id);
      num.classList.toggle('out', !inside);
      dot.classList.toggle('out', !inside);
    }
    for (const { path, ids: bids } of this.buildingEls.values()) {
      if (bids.length) path.classList.toggle('out', !bids.some((id) => this.inScope(this.byId.get(id))));
    }
    this.streetGroups.forEach((gs, i) => gs.forEach((g) => g.classList.toggle('dim', !used.has(i))));
  }

  // statut de chaque adresse de la tournée ; un bâtiment est « à repasser » si l'une de ses adresses l'est,
  // sinon « anomalie » si l'une l'est, « fait » (distribué) si toutes le sont
  applyStatuses(statusOf) {
    for (const a of this.pointable) {
      const st = this.inScope(a) ? statusOf(a.id) : null;
      const { num, dot } = this.addrEls.get(a.id);
      for (const e of [num, dot]) {
        e.classList.toggle('st-fait', st === 'fait');
        e.classList.toggle('st-a_repasser', st === 'a_repasser');
        e.classList.toggle('st-anomalie', st === 'anomalie');
      }
    }
    for (const { path, ids: all } of this.buildingEls.values()) {
      const ids = all.filter((id) => this.inScope(this.byId.get(id)));
      if (!ids.length) {
        path.classList.remove('st-fait', 'st-a_repasser', 'st-anomalie');
        continue;
      }
      const sts = ids.map(statusOf);
      const st = sts.includes('a_repasser') ? 'a_repasser' : sts.includes('anomalie') ? 'anomalie'
        : sts.every((s) => s === 'fait') ? 'fait' : '';
      path.classList.toggle('st-fait', st === 'fait');
      path.classList.toggle('st-a_repasser', st === 'a_repasser');
      path.classList.toggle('st-anomalie', st === 'anomalie');
    }
  }

  applyColors(dark) {
    this.data.streets.forEach((st, i) => {
      const c = st.colors[dark ? 1 : 0];
      for (const g of this.streetGroups[i]) g.style.setProperty('--sc', c);
    });
  }

  // ---------------------------------------------------------------- vue

  _rect() {
    return this.container.getBoundingClientRect();
  }

  toWorld(clientX, clientY) {
    const r = this._rect();
    return [this.cx + (clientX - r.left - r.width / 2) / this.k, this.cy + (clientY - r.top - r.height / 2) / this.k];
  }

  toScreen(x, y) {
    const r = this._rect();
    return [r.left + r.width / 2 + (x - this.cx) * this.k, r.top + r.height / 2 + (y - this.cy) * this.k];
  }

  _set(cx, cy, k) {
    this.k = clamp(k, this.kMin, K_MAX);
    this.cx = clamp(cx, -VIEW_MARGIN_M, this.W + VIEW_MARGIN_M);
    this.cy = clamp(cy, -VIEW_MARGIN_M, this.H + VIEW_MARGIN_M);
  }

  setView(cx, cy, k) {
    this._set(cx, cy, k);
    if (!this._raf) {
      this._raf = requestAnimationFrame(() => {
        this._raf = 0;
        this._render();
      });
    }
  }

  _render() {
    const r = this._rect();
    const w = r.width / this.k;
    const h = r.height / this.k;
    this.svg.setAttribute('viewBox', `${this.cx - w / 2} ${this.cy - h / 2} ${w} ${h}`);
    if (this.k !== this._lastK) {
      this._lastK = this.k;
      this._applyScale();
    }
    this.emit('view', { k: this.k, cx: this.cx, cy: this.cy });
  }

  // tailles constantes à l'écran : texte recalculé (halos en em dans le CSS), traits en non-scaling-stroke
  _applyScale() {
    const k = this.k;
    const fs = clamp(13 / k, 2.2, 14);
    this.lNumbers.style.fontSize = `${fs}px`;
    const ls = clamp(12 / k, 2.6, 22);
    this.lLabels.style.fontSize = `${ls}px`;
    this.lRouteStops.style.fontSize = `${11 / k}px`;
    this._updateTags();
    this.svg.classList.toggle('z-low', k < K_NUMBERS);
    this.svg.classList.toggle('z-min', k < K_LABELS);
    this._updateRing();
    this._updateMark();
  }

  setPadding(p) {
    this.padding = { top: 0, right: 0, bottom: 0, left: 0, ...p };
  }

  zoomAt(factor, clientX, clientY, animate = false) {
    const r = this._rect();
    const ox = clientX - r.left - r.width / 2;
    const oy = clientY - r.top - r.height / 2;
    const mx = this.cx + ox / this.k;
    const my = this.cy + oy / this.k;
    const k = clamp(this.k * factor, this.kMin, K_MAX);
    if (animate) this.animateTo(mx - ox / k, my - oy / k, k);
    else this.setView(mx - ox / k, my - oy / k, k);
  }

  // zoom centré sur la zone visible (hors panneaux)
  zoomBy(factor) {
    const r = this._rect();
    const p = this.padding;
    this.zoomAt(factor, r.left + (r.width + p.left - p.right) / 2, r.top + (r.height + p.top - p.bottom) / 2, true);
  }

  fitBounds(minx, miny, maxx, maxy, { animate = true, minSize = 0, margin = 24 } = {}) {
    const bw = Math.max(maxx - minx, minSize, 1);
    const bh = Math.max(maxy - miny, minSize, 1);
    const r = this._rect();
    const p = this.padding;
    const aw = Math.max(60, r.width - p.left - p.right - 2 * margin);
    const ah = Math.max(60, r.height - p.top - p.bottom - 2 * margin);
    const k = clamp(Math.min(aw / bw, ah / bh), this.kMin, K_MAX);
    const cx = (minx + maxx) / 2 - (p.left - p.right) / 2 / k;
    const cy = (miny + maxy) / 2 - (p.top - p.bottom) / 2 / k;
    if (animate) this.animateTo(cx, cy, k);
    else this.setView(cx, cy, k);
  }

  // décale la vue pour que le point (x, y) reste visible hors des zones couvertes par l'interface
  ensureVisible(x, y, { bottom = 0, margin = 48 } = {}) {
    const r = this._rect();
    const p = this.padding;
    const [sx, sy] = this.toScreen(x, y);
    const minX = r.left + p.left + margin;
    const maxX = r.right - p.right - margin;
    const minY = r.top + p.top + margin;
    const maxY = r.bottom - Math.max(p.bottom, bottom) - margin;
    const dx = sx < minX ? sx - minX : sx > maxX ? sx - maxX : 0;
    const dy = sy < minY ? sy - minY : sy > maxY ? sy - maxY : 0;
    if (dx || dy) this.animateTo(this.cx + dx / this.k, this.cy + dy / this.k, this.k, 250);
  }

  // centre (x, y) dans la zone visible ; zoom porté au moins à minK
  centerOn(x, y, { minK = 0, animate = true, ms = 300 } = {}) {
    const k = Math.max(this.k, minK);
    const p = this.padding;
    const cx = x - (p.left - p.right) / 2 / k;
    const cy = y - (p.top - p.bottom) / 2 / k;
    if (animate) this.animateTo(cx, cy, k, ms);
    else this.setView(cx, cy, k);
  }

  isGesturing() {
    return this.pointers.size > 0;
  }

  // toute la tournée active (tout le plan si elle est vide ou s'il n'y en a pas)
  fitAll(animate = true) {
    const pts = this.scope ? this.pointable.filter((a) => this.scope.has(a.id)) : [];
    if (!pts.length) {
      this.fitBounds(0, 0, this.W, this.H, { animate, margin: 8 });
      return;
    }
    this.fitBounds(...this._bounds(pts, 40), { animate, minSize: 220 });
  }

  _bounds(pts, m) {
    const xs = pts.map((a) => a.x);
    const ys = pts.map((a) => a.y);
    return [Math.min(...xs) - m, Math.min(...ys) - m, Math.max(...xs) + m, Math.max(...ys) + m];
  }

  animateTo(cx, cy, k, ms = 380) {
    this._stopAnim();
    if (reducedMotion.matches) ms = 0;
    const from = [this.cx, this.cy, Math.log(this.k)];
    const lk = Math.log(clamp(k, this.kMin, K_MAX));
    const t0 = performance.now();
    const step = (now) => {
      const t = ms ? Math.min(1, (now - t0) / ms) : 1;
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      this._set(from[0] + (cx - from[0]) * e, from[1] + (cy - from[1]) * e, Math.exp(from[2] + (lk - from[2]) * e));
      this._render();
      this._anim = t < 1 ? requestAnimationFrame(step) : 0;
    };
    this._anim = requestAnimationFrame(step);
  }

  _stopAnim() {
    if (this._anim) cancelAnimationFrame(this._anim);
    this._anim = 0;
  }

  _onResize() {
    const r = this._rect();
    if (!r.width || !r.height) return;
    this.kMin = 0.6 * Math.min(r.width / this.W, r.height / this.H);
    if (!this._ready) {
      this._ready = true;
      this.fitAll(false);
      this.emit('ready');
    } else {
      this.setView(this.cx, this.cy, this.k);
    }
  }

  // -------------------------------------------------------- rues, sélection

  setStreetVisible(i, visible) {
    if (visible) this.hidden.delete(i);
    else this.hidden.add(i);
    for (const g of this.streetGroups[i]) g.classList.toggle('off', !visible);
    if (!visible && this.selectedId && this.byId.get(this.selectedId)?.s === i) this.selectAddress(null);
  }

  // adresses de la rue dans la tournée active, sinon toute la rue
  streetBounds(i) {
    const all = this.pointable.filter((a) => a.s === i);
    const inside = all.filter((a) => this.inScope(a));
    return this._bounds(inside.length ? inside : all, 15);
  }

  selectStreet(i, { zoom = true } = {}) {
    this.selectedStreet = i;
    this.svg.classList.toggle('has-sel', i != null);
    this.streetGroups.forEach((gs, j) => gs.forEach((g) => g.classList.toggle('sel', j === i)));
    if (i != null && zoom) this.fitBounds(...this.streetBounds(i), { minSize: 220 });
  }

  selectAddress(id) {
    this.selectedId = id;
    this._updateRing();
  }

  _updateRing() {
    const a = this.selectedId && this.byId.get(this.selectedId);
    if (!a) {
      this.ring.setAttribute('display', 'none');
      return;
    }
    this.ring.setAttribute('display', 'inline');
    this.ring.setAttribute('cx', a.x);
    this.ring.setAttribute('cy', a.y);
    this.ring.setAttribute('r', 17 / this.k);
  }

  // Itinéraire : tracé (polylignes) et arrêts numérotés, départ et arrivée ; null pour l'effacer.
  // route = {lines: [[{x, y}, …], …], ahead?: [[{x, y}, …]], stops: [{x, y, label, cls?}]}
  setRoute(route) {
    this.lRoute.replaceChildren();
    this.lRouteStops.replaceChildren();
    if (!route) return;
    const path = (lines) => lines.map((pts) => `M${pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('L')}`).join('');
    const d = path(route.lines);
    el('path', { class: 'route-casing', d }, this.lRoute);
    el('path', { class: 'route-line', d }, this.lRoute);
    if (route.ahead?.length) {  // navigation : trajet jusqu'au prochain arrêt, en gras
      const da = path(route.ahead);
      el('path', { class: 'route-casing ahead', d: da }, this.lRoute);
      el('path', { class: 'route-line ahead', d: da }, this.lRoute);
    }
    for (const s of route.stops) {
      const g = el('g', { class: `route-stop${s.cls ? ` ${s.cls}` : ''}` }, this.lRouteStops);
      const dot = `M${s.x} ${s.y}h0.01`;
      el('path', { class: 'route-stop-ring', d: dot }, g);
      el('path', { class: 'route-stop-dot', d: dot }, g);
      el('text', { class: 'route-stop-num', x: s.x, y: s.y }, g).textContent = s.label;
    }
  }

  // repères d'adresse : pastille à côté du numéro (décalage constant à l'écran, recalculé au zoom)
  setTags(points) {
    this.tagged = points;
    this._updateTags();
  }

  _updateTags() {
    const off = 10 / this.k;
    const d = this.tagged.map((p) => `M${(p.x + off).toFixed(2)} ${(p.y - off).toFixed(2)}h0.01`).join('');
    this.tagRing.setAttribute('d', d);
    this.tagDot.setAttribute('d', d);
  }

  // repère sur un point à vérifier (bâtiment sans adresse, numéro hors tournée) ; null pour l'effacer
  mark(x, y) {
    this.marked = x == null ? null : { x, y };
    this._updateMark();
  }

  _updateMark() {
    const m = this.marked;
    this.markEl.setAttribute('display', m ? 'inline' : 'none');
    if (!m) return;
    this.markEl.setAttribute('cx', m.x);
    this.markEl.setAttribute('cy', m.y);
    this.markEl.setAttribute('r', 22 / this.k);
  }

  // numéro pointable visible le plus proche, à 22 px maximum
  hitTest(clientX, clientY) {
    const [wx, wy] = this.toWorld(clientX, clientY);
    let best = null;
    let bestD = TAP_RADIUS_PX;
    for (const a of this.pointable) {
      if (this.hidden.has(a.s) || (!this.selecting && !this.inScope(a))) continue;
      const d = Math.hypot(a.x - wx, a.y - wy) * this.k;
      if (d <= bestD) {
        bestD = d;
        best = a;
      }
    }
    return best;
  }

  // -------------------------------------------------------------- gestes

  _bindGestures() {
    const c = this.container;
    c.addEventListener('pointerdown', (e) => this._down(e));
    c.addEventListener('pointermove', (e) => this._move(e));
    c.addEventListener('pointerup', (e) => this._up(e, false));
    c.addEventListener('pointercancel', (e) => this._up(e, true));
    c.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    // Safari : bloquer le zoom de la page (iOS ignore user-scalable) ; pincement trackpad sur macOS
    document.addEventListener('gesturestart', (e) => {
      e.preventDefault();
      this._gestureScale = 1;
    }, { passive: false });
    document.addEventListener('gesturechange', (e) => {
      e.preventDefault();
      if (this.pointers.size || !c.contains(e.target)) return;  // tactile : déjà géré par les pointer events
      this.zoomAt(e.scale / (this._gestureScale || 1), e.clientX, e.clientY);
      this._gestureScale = e.scale;
    }, { passive: false });
    document.addEventListener('gestureend', (e) => e.preventDefault(), { passive: false });
    window.addEventListener('keydown', (e) => this._key(e));
  }

  _down(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this._stopAnim();
    const p = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY };
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 1) {
      this.gesture = { moved: false, multi: false, long: false };
      clearTimeout(this._lpTimer);
      this._lpTimer = setTimeout(() => {
        const g = this.gesture;
        if (g && !g.moved && !g.multi && this.pointers.size === 1) {
          g.long = true;
          this.emit('longpress', { world: this.toWorld(p.x, p.y), clientX: p.x, clientY: p.y });
        }
      }, LONG_PRESS_MS);
    } else {
      this.gesture.multi = true;
      clearTimeout(this._lpTimer);
      this._startPinch();
    }
  }

  _startPinch() {
    const [a, b] = this.pointers.values();
    for (const id of this.pointers.keys()) {
      try { this.container.setPointerCapture(id); } catch { /* pointeur déjà relâché */ }
    }
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const [ax, ay] = this.toWorld(mx, my);
    this.pinch = { d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), k0: this.k, ax, ay };
    this._setMoving(true);
    this.emit('userzoom');  // un pincement est un zoom : il ne coupe pas le mode suivre
  }

  _move(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const px = p.x;
    const py = p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (this.pointers.size >= 2) {
      this._pinchMove();
      return;
    }
    const g = this.gesture;
    if (!g.moved) {
      if (Math.hypot(p.x - p.x0, p.y - p.y0) <= DRAG_THRESHOLD_PX) return;
      g.moved = true;
      clearTimeout(this._lpTimer);
      try { this.container.setPointerCapture(e.pointerId); } catch { /* idem */ }
      this.container.classList.add('dragging');
      this._setMoving(true);
      this.emit('userpan');
      this._pan(p.x - p.x0, p.y - p.y0);
      return;
    }
    this._pan(p.x - px, p.y - py);
  }

  _pan(dx, dy) {
    this.setView(this.cx - dx / this.k, this.cy - dy / this.k, this.k);
  }

  _pinchMove() {
    const [a, b] = this.pointers.values();
    const d = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
    const r = this._rect();
    const ox = (a.x + b.x) / 2 - r.left - r.width / 2;
    const oy = (a.y + b.y) / 2 - r.top - r.height / 2;
    const k = clamp(this.pinch.k0 * (d / this.pinch.d0), this.kMin, K_MAX);
    this.setView(this.pinch.ax - ox / k, this.pinch.ay - oy / k, k);
  }

  _up(e, cancelled) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);
    try { this.container.releasePointerCapture(e.pointerId); } catch { /* idem */ }
    clearTimeout(this._lpTimer);
    const g = this.gesture;
    if (this.pointers.size >= 2) {
      this._startPinch();
      return;
    }
    if (this.pointers.size === 1) {  // fin de pincement : le doigt restant continue en glisser, sans saut
      this.pinch = null;
      if (g) g.moved = true;
      return;
    }
    this.pinch = null;
    this.gesture = null;
    this.container.classList.remove('dragging');
    this._setMoving(false);
    if (!cancelled && g && !g.moved && !g.multi && !g.long) this._tap(e.clientX, e.clientY);
  }

  _tap(x, y) {
    if (this.k < K_NUMBERS && !this.picking) {  // vue d'ensemble : un tap rapproche au lieu de pointer au hasard
      this.zoomAt(2.5, x, y, true);
      return;
    }
    const world = this.toWorld(x, y);
    const address = this.hitTest(x, y);
    const now = performance.now();
    const last = this._lastTap;
    this._lastTap = null;
    if (address) {
      this.emit('tap', { address, world });
      return;
    }
    if (last && now - last.t < DOUBLE_TAP_MS && Math.hypot(x - last.x, y - last.y) < 30) {
      this.zoomAt(2, x, y, true);
      return;
    }
    this._lastTap = { t: now, x, y };
    this.emit('tap', { address: null, world });
  }

  _wheel(e) {
    e.preventDefault();
    this._stopAnim();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= 400;
    this.zoomAt(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX, e.clientY);
    this._setMoving(true);
    clearTimeout(this._wheelTimer);
    this._wheelTimer = setTimeout(() => this._setMoving(false), 160);
  }

  _key(e) {
    if (e.target.closest?.('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
    const step = 80;
    const actions = {
      '+': () => this.zoomBy(1.6),
      '=': () => this.zoomBy(1.6),
      '-': () => this.zoomBy(1 / 1.6),
      0: () => this.fitAll(),
      ArrowLeft: () => this._pan(step, 0),
      ArrowRight: () => this._pan(-step, 0),
      ArrowUp: () => this._pan(0, step),
      ArrowDown: () => this._pan(0, -step),
    };
    const fn = actions[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    }
  }

  _setMoving(on) {
    this.svg.classList.toggle('moving', on);
  }
}
