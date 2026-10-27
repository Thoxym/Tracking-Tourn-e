// Préparer › Itinéraire : réglages de la tournée (véhicule, tissage, départ, arrivée, réglages avancés), calcul dans
// le worker, résultat (durée, distance, arrêts, gain sur l'ordre des rues), aperçu sur le plan, liste des arrêts à
// retoucher (monter, descendre, fusionner, séparer, tissage de la rue).
//
// Enregistré dans la tournée : tour.route = {settings, stops?, totals?, baseline?, roadsVersion?, computedAt?, manual?,
// settingsKey?}. Les arrêts gardent ids, côtés et positions (arc, abscisse) : l'ordre de visite (ui.visitOrder) et la
// navigation s'en servent sans recalcul. Les trajets se recalculent à l'affichage (réseau chargé à la demande).

import {
  DEFAULTS, LIMITS, evaluateStops, mergeStops, planContext, routeLines, settingsFor, splitStop, streetKeyOf, updateComposition,
} from '../itinerary.js';
import { RouteClient } from '../route-client.js';
import { loadRoads } from '../roads.js';
import { formatDistance, formatDuration } from '../tourplan.js';
import { addressLabel } from '../ui.js';
import { guard, num, plural, showAddress } from './common.js';

const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';
const ROUTE_PAGES = new Set(['route', 'route-stops', 'route-settings', 'route-pick']);
const MODE_LABEL = { car: 'en voiture', bike: 'à vélo', foot: 'à pied' };
const BUDGET = 2000;
const BUDGET_MORE = 10000;
const r1 = (v) => Math.round(v * 10) / 10;

// arrêt allégé pour l'enregistrement (abscisses et durées au décimètre / à la décimale)
function slim(s) {
  return {
    kind: s.kind, ids: s.ids, sides: s.sides, arc: s.arc, sIn: r1(s.sIn), arcOut: s.arcOut ?? s.arc, sOut: r1(s.sOut),
    path: s.path ? s.path.map((p) => ({ arc: p.arc, s0: r1(p.s0), s1: r1(p.s1) })) : null,
    x: r1(s.x), y: r1(s.y), street: s.street ?? -1, walk: r1(s.walk), service: r1(s.service), mixed: Boolean(s.mixed),
    legSec: r1(s.legSec || 0), legM: r1(s.legM || 0),
  };
}

const settingsKey = (saved) => {
  const { seed, ...st } = settingsFor(saved);  // eslint-disable-line no-unused-vars
  return JSON.stringify(st);
};

function icon(...paths) {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'ico');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

const span = (cls, text) => {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
};

export class RouteView {
  constructor(app) {
    this.app = app;
    this.view = $('view-prepare');
    this.client = new RouteClient();
    this.computing = false;
    this.picking = null;      // 'start' | 'end' : point à placer sur le plan
    this.roadsVersion = null; // version du réseau chargé (itinéraire calculé sur un autre réseau : à recalculer)
    this._shown = null;
    guard(this, ['setMode', 'setWeave', 'compute', 'clear', 'move', 'stopMenu', 'setStreetWeave', 'refresh',
      'chooseStart', 'chooseEnd', 'pickPoint', 'saveField', 'resetFields', 'setFromVehicle']);

    for (const r of document.querySelectorAll('input[name="route-mode"]')) r.addEventListener('change', () => this.setMode(r.value));
    for (const r of document.querySelectorAll('input[name="route-weave"]')) r.addEventListener('change', () => this.setWeave(r.value));
    $('route-start-row').addEventListener('click', () => this.chooseStart());
    $('route-end-row').addEventListener('click', () => this.chooseEnd());
    $('route-compute').addEventListener('click', () => this.compute(BUDGET));
    $('route-more').addEventListener('click', () => this.compute(BUDGET_MORE));
    $('route-clear').addEventListener('click', () => this.clear());
    $('route-show').addEventListener('click', () => this.show());
    $('route-sim').addEventListener('click', () => this.app.nav.simulate());
    $('route-update').addEventListener('click', () => this.refresh());
    $('route-pick-cancel').addEventListener('click', () => this.stopPick());
    $('rs-fromVehicle').addEventListener('change', (e) => this.setFromVehicle(e.target.checked));
    $('rs-reset').addEventListener('click', () => this.resetFields());
    this._bindFields();

    app.panel.onChange(() => this.syncMap());
    app.tabs.onChange((tab) => {
      if (this.picking && tab !== 'prepare') this.stopPick(false);
      this.syncMap();
    });
    app.store.onChange((d) => {
      if (d && d.type !== 'tour' && d.type !== 'import') return;
      if (app.tabs.current === 'prepare') this.render();
      this.syncMap();
    });
    this.render();
  }

  get tour() { return this.app.store.activeTour; }
  get route() { return this.tour?.route || null; }
  get saved() { return this.route?.settings || {}; }
  get stops() { return this.route?.stops?.length ? this.route.stops : null; }

  // adresses de la tournée connues du plan
  tourIds() {
    return this.app.ui.byStreet.flat().map((a) => a.id);
  }

  async _saveRoute(patch) {
    const next = { ...(this.route || {}), ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    await this.app.store.updateTour(this.tour.id, { route: next });
  }

  async saveSettings(patch) {
    await this._saveRoute({ settings: { ...this.saved, ...patch } });
  }

  async plan() {
    const { graph, snap } = await loadRoads();
    this.roadsVersion = graph.version;
    return planContext({ graph, data: this.app.data, snap, settings: this.saved });
  }

  // ------------------------------------------------------------ réglages

  async setMode(mode) {
    await this.saveSettings({ mode });
  }

  async setWeave(weave) {
    await this.saveSettings({ weave });
  }

  async setFromVehicle(on) {
    await this.saveSettings({ fromVehicle: on });
  }

  // tissage d'une rue (clé de voie) : 'weave', 'sides', ou '' (réglage de la tournée)
  async setStreetWeave(key, value) {
    const weaveBy = { ...(this.saved.weaveBy || {}) };
    if (value) weaveBy[key] = value;
    else delete weaveBy[key];
    await this.saveSettings({ weaveBy });
    if (this.stops) this.app.ui.toast('Tissage de la rue enregistré : recalculez l\'itinéraire pour l\'appliquer', { ms: 4000 });
  }

  _bindFields() {
    const show = (v) => String(v).replace('.', ',');
    for (const input of document.querySelectorAll('#route-fields input[data-k]')) {
      const k = input.dataset.k;
      input.addEventListener('input', () => {
        const raw = input.value.trim().replace(',', '.');
        const v = raw === '' ? NaN : Number(raw);
        const ok = Number.isFinite(v) && v >= LIMITS[k][0] && v <= LIMITS[k][1];
        input.setAttribute('aria-invalid', String(!ok));
        if (ok) this.saveField(k, v);
      });
      input.addEventListener('blur', () => {  // valeur invalide abandonnée : la valeur en vigueur revient
        input.value = show(settingsFor(this.saved)[k]);
        input.removeAttribute('aria-invalid');
      });
    }
  }

  async saveField(k, v) {
    const mode = settingsFor(this.saved).mode;
    const custom = { ...(this.saved.custom || {}) };
    custom[mode] = { ...(custom[mode] || {}), [k]: v };
    await this.saveSettings({ custom });
  }

  async resetFields() {
    const mode = settingsFor(this.saved).mode;
    const custom = { ...(this.saved.custom || {}) };
    delete custom[mode];
    await this.saveSettings({ custom, ...(mode === 'car' ? { fromVehicle: false } : {}) });
  }

  // ------------------------------------------------------- départ, arrivée

  // libellé d'un point : l'adresse la plus proche
  placeLabel(p) {
    const { map, ui } = this.app;
    let best = null;
    let bd = Infinity;
    for (const a of map.pointable) {
      const d = Math.hypot(a.x - p.x, a.y - p.y);
      if (d < bd) {
        bd = d;
        best = a;
      }
    }
    return best ? `Près du ${addressLabel(best, ui.streets)}` : 'Point choisi';
  }

  async chooseStart() {
    const st = settingsFor(this.saved);
    const v = await this.app.ui.actionSheet('Départ de la tournée', [
      { label: 'Meilleur premier arrêt', value: 'best', checked: !st.start },
      { label: st.start ? 'Déplacer le point de départ…' : 'Choisir sur le plan…', value: 'pick' },
    ]);
    if (v === 'best') await this.saveSettings({ start: null, ...(this.saved.end === 'start' ? { end: null } : {}) });
    else if (v === 'pick') this.startPick('start');
  }

  async chooseEnd() {
    const st = settingsFor(this.saved);
    const items = [{ label: 'Au dernier arrêt', value: 'last', checked: !st.end }];
    if (st.start) items.push({ label: 'Retour au point de départ', value: 'start', checked: st.end === 'start' });
    items.push({ label: st.end && st.end !== 'start' ? 'Déplacer le point d\'arrivée…' : 'Choisir sur le plan…', value: 'pick' });
    const v = await this.app.ui.actionSheet('Fin de la tournée', items);
    if (v === 'last') await this.saveSettings({ end: null });
    else if (v === 'start') await this.saveSettings({ end: 'start' });
    else if (v === 'pick') this.startPick('end');
  }

  startPick(which) {
    const { map, ui, panel } = this.app;
    this.picking = which;
    map.picking = true;
    ui.closeSheet();
    ui.pointOverride = (p) => this.pickPoint(p);
    $('route-pick-title').textContent = which === 'start' ? 'Point de départ' : 'Point d\'arrivée';
    panel.push(this.view, 'route-pick');
    panel.setDetent('peek');
    ui.updatePadding();
  }

  stopPick(back = true) {
    if (!this.picking) return;
    const { map, ui, panel } = this.app;
    this.picking = null;
    map.picking = false;
    ui.pointOverride = null;
    if (back && panel.page(this.view)?.dataset.page === 'route-pick') {
      panel.back(this.view);
      panel.setDetent('medium');
    }
  }

  async pickPoint(p) {
    const which = this.picking;
    this.stopPick();
    const pt = { x: r1(p.x), y: r1(p.y) };
    await this.saveSettings({ [which]: pt });
    this.app.ui.toast(`${which === 'start' ? 'Départ' : 'Arrivée'} : ${this.placeLabel(pt).toLowerCase()}`);
  }

  // ---------------------------------------------------------------- calcul

  async compute(budgetMs) {
    const { ui } = this.app;
    if (this.computing) return;
    const ids = this.tourIds();
    if (!ids.length) {
      ui.toast('Tournée vide : ajoutez des adresses avant de calculer l\'itinéraire.');
      return;
    }
    if (this.route?.manual && !(await ui.confirm('Recalculer remplace vos retouches de l\'itinéraire. Continuer ?', 'Recalculer'))) return;
    this.computing = true;
    const tourId = this.tour.id;
    this._progress('Préparation…');
    this.render();
    try {
      const order = ui.sequence().flatMap((g) => g.addrs).map((a) => a.id);
      const saved = this.saved;
      const res = await this.client.compute({
        ids, order, settings: saved, budgetMs,
        onProgress: (phase, f) => this._progress(phase === 'matrice' ? `Temps entre les arrêts… ${Math.round(f * 100)} %`
          : phase === 'optimisation' ? `Recherche du meilleur ordre… ${Math.round(f * 100)} %` : 'Arrêts…'),
      });
      if (this.tour.id !== tourId) return;  // tournée changée pendant le calcul
      this.roadsVersion = res.roadsVersion;
      await this._saveRoute({
        stops: res.stops.map(slim), totals: res.totals, baseline: res.baseline.sec, roadsVersion: res.roadsVersion,
        computedAt: Date.now(), manual: false, settingsKey: settingsKey(saved),
      });
      const lost = res.missing.length + res.unreachable.length;
      const unit = res.mode === 'foot' ? 'portion' : 'arrêt';
      ui.toast(`Itinéraire : ${plural(res.stops.length, unit)}, ≈ ${formatDuration(res.totals.sec)}`
        + (lost ? ` · ${plural(lost, 'adresse injoignable', 'adresses injoignables')} par la route, à part` : ''), { ms: 4000 });
      this._fitNext = true;
      this.syncMap();
    } catch (err) {
      if (!err.cancelled) ui.toast(`Calcul impossible : ${err.message}`, { ms: 6000 });
    } finally {
      this.computing = false;
      this._progress(null);
      this.render();
    }
  }

  _progress(text) {
    $('route-progress').hidden = !text;
    $('route-progress').textContent = text || '';
  }

  async clear() {
    const { ui } = this.app;
    if (!(await ui.confirm('Supprimer l\'itinéraire calculé ? La tournée suivra l\'ordre des rues. Les réglages sont conservés.', 'Supprimer', { destructive: true }))) return;
    await this._saveRoute({ stops: undefined, totals: undefined, baseline: undefined, roadsVersion: undefined,
      computedAt: undefined, manual: undefined, settingsKey: undefined });
  }

  // composition, réglages ou réseau changés depuis le calcul
  staleReasons() {
    const stops = this.stops;
    if (!stops) return [];
    const ids = new Set(this.tourIds());
    const inRoute = new Set(stops.flatMap((s) => s.ids));
    const added = [...ids].filter((id) => !inRoute.has(id)).length;
    const removed = [...inRoute].filter((id) => !ids.has(id)).length;
    const out = [];
    if (added) out.push(plural(added, 'adresse ajoutée', 'adresses ajoutées'));
    if (removed) out.push(plural(removed, 'adresse retirée', 'adresses retirées'));
    if (this.roadsVersion && this.route.roadsVersion !== this.roadsVersion) out.push('réseau routier mis à jour');
    else if (this.route.settingsKey && this.route.settingsKey !== settingsKey(this.saved)) out.push('réglages modifiés');
    return out;
  }

  // « Mettre à jour » : itinéraire retouché -> adresses ajoutées insérées au plus près, retouches gardées ;
  // sinon nouveau calcul
  async refresh() {
    const reasons = this.staleReasons();
    const onlyComposition = !reasons.some((r) => r.startsWith('réseau') || r.startsWith('réglages'));
    if (!this.route?.manual || !onlyComposition) {
      if (this.route?.manual) await this._saveRoute({ manual: false });  // la confirmation a eu lieu : on recalcule
      await this.compute(BUDGET);
      return;
    }
    const plan = await this.plan();
    await this._apply(updateComposition(plan, this.stops, this.tourIds()), plan);
    this.app.ui.toast('Itinéraire mis à jour, retouches conservées');
  }

  // retouche : nouvelle suite d'arrêts, trajets et totaux recalculés
  async _apply(stops, plan = null) {
    const p = plan || await this.plan();
    const ev = evaluateStops(p, stops);
    await this._saveRoute({ stops: ev.stops.map(slim), totals: ev.totals, manual: true });
  }

  async move(k, dir) {
    const stops = [...this.stops];
    const j = k + dir;
    if (j < 0 || j >= stops.length) return;
    [stops[k], stops[j]] = [stops[j], stops[k]];
    this._focus = { k: j, act: dir < 0 ? 'up' : 'down' };
    await this._apply(stops);
  }

  async stopMenu(k) {
    const { ui } = this.app;
    const st = this.stops[k];
    const next = this.stops[k + 1];
    const key = streetKeyOf(st.ids[0]);
    const cur = this.saved.weaveBy?.[key] || '';
    const name = this._streetName(st);
    const items = [{ label: 'Voir sur le plan', value: 'show' }];
    if (st.kind === 'stop' && next?.kind === 'stop') items.push({ label: `Fusionner avec l'arrêt ${k + 2}`, value: 'merge' });
    if (st.kind === 'stop' && st.ids.length > 1) items.push({ label: 'Séparer en deux arrêts', value: 'split' });
    items.push(
      { label: `${name} : tissée`, value: 'w:weave', checked: cur === 'weave' },
      { label: `${name} : côté par côté`, value: 'w:sides', checked: cur === 'sides' },
      { label: `${name} : réglage de la tournée`, value: 'w:', checked: !cur },
    );
    const unit = st.kind === 'stop' ? 'Arrêt' : 'Portion';
    const v = await ui.actionSheet(`${unit} ${k + 1} · ${name}`, items, { message: this._summary(st) });
    if (!v) return;
    if (v === 'show') {
      const a = this.app.map.byId.get(st.ids[0]);
      if (a) showAddress(this.app, a);
    } else if (v === 'merge') {
      const plan = await this.plan();
      const m = mergeStops(plan, this.stops, k);
      if (m) await this._apply(m, plan);
    } else if (v === 'split') {
      const plan = await this.plan();
      const m = splitStop(plan, this.stops, k);
      if (m) await this._apply(m, plan);
    } else if (v.startsWith('w:')) await this.setStreetWeave(key, v.slice(2));
  }

  // ----------------------------------------------------------------- rendu

  _streetName(st) {
    const { ui, map } = this.app;
    const a = map.byId.get(st.ids[0]);
    return a ? ui.streets[a.s].label : 'Rue';
  }

  // « 125, 127, 129 à droite · 144 bis, 144 à gauche » ; une portion : « côté droit : 58 → 90 (17) »
  _summary(st) {
    const { map } = this.app;
    const label = (ids) => {
      const as = ids.map((id) => map.byId.get(id)).filter(Boolean);
      if (as.length <= 6) return as.map(num).join(', ');
      return `${num(as[0])} → ${num(as[as.length - 1])} (${as.length})`;
    };
    const right = st.ids.filter((_, k) => st.sides[k] > 0);
    const left = st.ids.filter((_, k) => st.sides[k] < 0);
    if (st.kind === 'stop') {
      return [right.length ? `${label(right)} à droite` : '', left.length ? `${label(left)} à gauche` : ''].filter(Boolean).join(' · ');
    }
    const prefix = st.kind === 'window' ? 'Depuis le véhicule, ' : '';
    if (!left.length || !right.length) return `${prefix}côté ${left.length ? 'gauche' : 'droit'} : ${label(st.ids)}`;
    return `${prefix}les deux côtés : ${label(st.ids)}`;
  }

  render() {
    const { ui } = this.app;
    const st = settingsFor(this.saved);
    const mode = st.mode;
    for (const r of document.querySelectorAll('input[name="route-mode"]')) r.checked = r.value === mode;
    for (const r of document.querySelectorAll('input[name="route-weave"]')) r.checked = r.value === st.weave;
    $('route-start').textContent = st.start ? this.placeLabel(st.start) : 'Meilleur premier arrêt';
    $('route-end').textContent = st.end === 'start' ? 'Retour au départ' : st.end ? this.placeLabel(st.end) : 'Au dernier arrêt';
    for (const el of document.querySelectorAll('#view-prepare [data-modes]')) {
      el.hidden = !el.dataset.modes.split(' ').includes(mode);
    }
    for (const input of document.querySelectorAll('#route-fields input[data-k]')) {
      if (document.activeElement !== input && input.dataset.k in DEFAULTS[mode]) input.value = String(st[input.dataset.k]).replace('.', ',');
    }
    $('rs-fromVehicle').checked = st.fromVehicle;
    $('route-fields-help').textContent = `Réglages de cette tournée ${MODE_LABEL[mode]}. Recalculez l'itinéraire pour les appliquer.`;

    const stops = this.stops;
    const route = this.route;
    $('route-compute').textContent = stops ? 'Recalculer l\'itinéraire' : 'Calculer l\'itinéraire';
    $('route-compute').disabled = this.computing || !this.tourIds().length;
    $('route-more').disabled = this.computing;
    $('route-result').hidden = !stops;
    // petit cran : le résumé s'il y a un itinéraire, sinon le choix du véhicule (premier [data-peek] de la page)
    if (stops) $('route-summary').setAttribute('data-peek', '');
    else $('route-summary').removeAttribute('data-peek');
    const reasons = this.staleReasons();
    $('route-stale').hidden = !reasons.length || this.computing;
    $('route-stale-msg').textContent = `Itinéraire à revoir : ${reasons.join(', ')}.`;
    $('prep-route-n').textContent = stops ? `≈ ${formatDuration(route.totals.sec)}` : 'à calculer';
    if (stops) {
      const t = route.totals;
      const foot = route.stops.every((s) => s.kind !== 'stop');
      $('route-time').textContent = `≈ ${formatDuration(t.sec)}`;
      $('route-dist-l').textContent = t.driveM ? 'Distance roulée' : 'Distance';
      $('route-dist').textContent = formatDistance(t.driveM || t.walkM);
      $('route-count-l').textContent = foot ? 'Portions' : 'Arrêts';
      $('route-count').textContent = String(stops.length);
      $('route-stops-title').textContent = foot ? 'Portions de rue dans l\'ordre' : 'Arrêts dans l\'ordre';
      $('route-stops-n').textContent = String(stops.length);
      const gain = route.baseline != null ? route.baseline - t.sec : 0;
      $('route-gain').textContent = [
        route.manual ? 'Itinéraire retouché à la main.' : '',
        route.baseline != null
          ? (gain >= 300 ? `≈ ${formatDuration(gain)} de moins que l'ordre des rues (≈ ${formatDuration(route.baseline)}).`
            : 'Pas plus rapide que l\'ordre des rues.')
          : '',
        t.driveM ? `Dont ${formatDistance(t.walkM)} à pied autour des arrêts.` : '',
      ].filter(Boolean).join(' ');
      this.renderStops();
    }
    ui.updatePadding?.();
  }

  renderStops() {
    const stops = this.stops;
    const foot = stops.every((s) => s.kind !== 'stop');
    const addrs = stops.reduce((n, s) => n + s.ids.length, 0);
    $('route-stops-sub').textContent = `${plural(stops.length, foot ? 'portion' : 'arrêt')} · ${plural(addrs, 'adresse')}`;
    $('route-stops').replaceChildren(...stops.map((st, k) => {
      const li = document.createElement('li');
      li.className = 'order-row stop-row';
      li.dataset.k = k;
      const main = span('vrow-main', '');
      main.append(span('vrow-name', this._streetName(st)), span('vrow-sub', this._summary(st)));
      const btn = (cls, label, paths, disabled, act, onClick) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `order-btn ${cls}`;
        b.setAttribute('aria-label', label);
        b.title = label;
        b.disabled = disabled;
        b.dataset.act = act;
        b.append(icon(...paths));
        b.addEventListener('click', onClick);
        return b;
      };
      const unit = st.kind === 'stop' ? 'arrêt' : 'portion';
      li.append(span('stop-badge', String(k + 1)), main,
        btn('stop-more', `Actions : ${unit} ${k + 1}`, ['M6 12h.01M12 12h.01M18 12h.01'], false, 'more', () => this.stopMenu(k)),
        btn('order-up', `Monter : ${unit} ${k + 1}`, ['M6 14l6-6 6 6'], k === 0, 'up', () => this.move(k, -1)),
        btn('order-down', `Descendre : ${unit} ${k + 1}`, ['M6 10l6 6 6-6'], k === stops.length - 1, 'down', () => this.move(k, 1)));
      return li;
    }));
    if (this._focus) {  // garder le focus sur le bouton utilisé
      const { k, act } = this._focus;
      this._focus = null;
      const row = $('route-stops').querySelector(`[data-k="${k}"]`);
      const b = row?.querySelector(`[data-act="${act}"]`);
      (b && !b.disabled ? b : row?.querySelector(`[data-act="${act === 'up' ? 'down' : 'up'}"]`))?.focus();
    }
  }

  // ----------------------------------------------------------------- plan

  visible() {
    const { tabs, panel } = this.app;
    return tabs.current === 'prepare' && ROUTE_PAGES.has(panel.page(this.view)?.dataset.page);
  }

  // tracé de l'itinéraire sur le plan pendant qu'une page de l'itinéraire est ouverte
  async syncMap() {
    const { map } = this.app;
    if (this.app.nav?.active) return;  // la navigation dessine son propre tracé
    if (!this.visible()) {
      if (this._shown) {
        map.setRoute(null);
        this._shown = null;
      }
      return;
    }
    const key = `${this.tour.id}|${this.tour.updatedAt}`;
    if (this._shown === key) return;
    this._shown = key;
    let lines = [];
    const marks = [];
    try {
      const plan = await this.plan();
      const stops = this.stops;
      if (stops && this.route.roadsVersion === this.roadsVersion) {
        const ev = evaluateStops(plan, stops);
        lines = routeLines(plan.ctx.g, ev);
        stops.forEach((s, k) => marks.push({ x: s.x, y: s.y, label: String(k + 1) }));
      }
    } catch (err) {
      this.app.ui.toast(`Réseau routier indisponible : ${err.message}`, { ms: 5000 });
    }
    const st = settingsFor(this.saved);
    if (st.start) marks.unshift({ ...st.start, label: 'D', cls: 'start' });
    if (st.end && st.end !== 'start') marks.push({ ...st.end, label: 'A', cls: 'end' });
    if (!this.visible() || this._shown !== key) return;
    map.setRoute({ lines, stops: marks });
    this.render();  // version du réseau connue : avis « à revoir » à jour
    if (this._fitNext) {
      this._fitNext = false;
      this._fit(lines, marks);
    }
  }

  _fit(lines, marks) {
    const pts = [...lines.flat(), ...marks];
    if (!pts.length) return;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    this.app.map.fitBounds(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), { minSize: 200 });
  }

  // « Voir sur le plan » : feuille réduite, plan cadré sur l'itinéraire
  async show() {
    this.view.querySelector('[data-page="route"] .page-body').scrollTo(0, 0);
    this.app.panel.setDetent('peek');
    this.app.ui.updatePadding();
    this._fitNext = true;
    this._shown = null;
    await this.syncMap();
  }
}
