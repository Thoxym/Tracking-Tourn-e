// Navigation de tournée (onglet Distribuer › Démarrer) : l'itinéraire calculé arrêt par arrêt.
// - Bandeau en haut : prochaine consigne (flèche, distance, rue), puis l'arrivée à l'arrêt.
// - Feuille au petit cran : l'arrêt en cours, ses numéros et leur côté, Distribué par adresse ou pour tout l'arrêt,
//   anomalie et « à repasser » par le menu ⋯ ; l'arrêt suivant vient seul quand tout est traité.
// - Plan : suivi de la position (GPS), trajet jusqu'à l'arrêt en gras, suite de l'itinéraire, arrêts numérotés.
// - Hors itinéraire (écart au tracé pendant quelques secondes, position précise) : nouveau trajet jusqu'à l'arrêt.
// La source de position est le GPS (ou une position simulée : panneau debug, simulation de tournée).
// Voix (js/voice.js) : consignes à l'approche des virages (seuils selon le mode), arrivée à l'arrêt, repères.
// Carte orientée : le plan tourne pour que le trajet à venir pointe vers le haut ; la boussole revient au nord.
// Quitter : mettre en pause (l'arrêt en cours est mémorisé, « Reprendre » dans Distribuer, même après une relance)
// ou terminer. Simulation : même vue, position qui avance seule le long de l'itinéraire (js/simulator.js), statuts
// gardés en mémoire seulement : le journal, l'annulation et le rapport ne sont pas touchés.

import { evaluateStops, planContext, routeLines } from '../itinerary.js';
import { buildLeg, formatDist, instruction, locate, nextManeuver, pointAlong, reroute } from '../guidance.js';
import { loadRoads } from '../roads.js';
import { ST_AGAIN, ST_ANOMALY, ST_DONE, isTreated } from '../store.js';
import { formatDuration } from '../tourplan.js';
import { Simulator } from '../simulator.js';
import { addressLabel } from '../ui.js';
import { guard, num, plural, showAddress } from './common.js';

const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';
const OFF_ROUTE_M = { car: 30, bike: 25, foot: 20 };
const ARRIVE_M = { car: 30, bike: 25, foot: 20 };
const MAX_ACC_M = 25;
const LOCK_MS = 500;
const STATUS_TEXT = { [ST_DONE]: 'distribuée', [ST_ANOMALY]: 'anomalie', [ST_AGAIN]: 'à repasser' };
const VOICE_AT = { car: [300, 100, 25], bike: [150, 40, 15], foot: [40, 10] };  // annonces avant un virage (m)
const HEADUP_KEY = 'neyron-tournees.headup';
const SESSION_KEY = 'neyron-tournees.nav';  // tournée en cours de guidage : {tour, k, at} (préférence d'appareil)

function readSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    return s && typeof s.tour === 'string' && Number.isInteger(s.k) ? s : null;
  } catch {
    return null;
  }
}

function writeSession(s) {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* stockage indisponible : pas de reprise après relance */ }
}

// flèches du bandeau (repère 24 × 24, trait)
const ARROWS = {
  straight: 'M12 20V5M6.5 10.5L12 5l5.5 5.5',
  'turn-right': 'M7 20v-7a4 4 0 0 1 4-4h8M15 5l4 4-4 4',
  'turn-left': 'M17 20v-7a4 4 0 0 0-4-4H5M9 5L5 9l4 4',
  'slight-right': 'M9 20v-6l7-7M11 6h6v6',
  'slight-left': 'M15 20v-6L8 7M13 6H7v6',
  'sharp-right': 'M8 4v10l7 6M15 14v6H9',
  'sharp-left': 'M16 4v10l-7 6M9 14v6h6',
  uturn: 'M8 20V9a4 4 0 0 1 8 0v4M12.5 10.5L16 14l3.5-3.5',
  roundabout: 'M12 21v-5M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM14.8 9.2L19 5M15 5h4v4',
  arrive: 'M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11zM12 12.3a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6z',
};
const arrowOf = (m) => ARROWS[m.dir ? `${m.type}-${m.dir}` : m.type] || ARROWS.straight;

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

// plan (repère SVG du cadre) -> GPS, par inversion de la transformation affine des données
function toLonLat(data, x, y) {
  const { x: [a, b, c], y: [d, e, f] } = data.affine;
  const X = x + data.frame.x0;
  const Y = data.frame.y1 - y;
  const det = a * e - b * d;
  return { lon: ((X - c) * e - b * (Y - f)) / det, lat: (a * (Y - f) - d * (X - c)) / det };
}

export class NavigateView {
  constructor(app) {
    this.app = app;
    this.view = $('view-navigate');
    this.active = false;
    this.offRouteMs = 5000;  // écart au tracé toléré avant recalcul (réglable pour les tests)
    this.lockUntil = 0;
    this.sim = false;         // simulation en cours
    this.simState = new Map(); // statuts simulés (mémoire seulement)
    this.session = readSession();
    this.voice = app.voice;
    let headUp = null;
    try { headUp = localStorage.getItem(HEADUP_KEY); } catch { /* stockage indisponible */ }
    this.headUp = headUp !== 'off';
    guard(this, ['startFlow', 'pickTour', 'start', 'stopFlow', 'skip', 'allDone', 'act', 'more', 'simulate']);
    $('nav-start').addEventListener('click', () => this.startFlow());
    $('nav-sim').addEventListener('click', () => this.simulate());
    $('sim-play').addEventListener('click', () => this.simulator?.toggle());
    $('sim-next').addEventListener('click', () => this.simNext());
    $('sim-prev').addEventListener('click', () => this.simPrev());
    $('sim-speed').addEventListener('click', () => this.simulator?.cycleSpeed());
    $('sim-quit').addEventListener('click', () => this.stop('sim'));
    $('nav-voice').addEventListener('click', () => this.toggleVoice());
    $('btn-north').addEventListener('click', () => this.toggleHeadUp());
    app.map.on('rotate', ({ deg }) => { $('btn-north').querySelector('.ico').style.transform = `rotate(${deg}deg)`; });
    app.alerts?.onAlert(({ label, text }) => { if (this.active) this.voice?.say(`Attention, ${label} : ${text}`); });
    $('dist-tour').addEventListener('click', () => this.pickTour());
    $('nav-stop').addEventListener('click', () => this.stopFlow());
    $('nav-skip').addEventListener('click', () => this.skip());
    $('nav-all').addEventListener('click', () => this.allDone());
    app.store.onChange((d) => this.onStore(d));
    app.gps.tracker.on('position', (pos) => this.onPosition(pos));
    // le plan suit la position pendant la navigation ; un glisser à la main suspend le suivi (Localiser le reprend)
    app.map.on('userpan', () => { this.follow = false; });
    $('btn-locate').addEventListener('click', () => { this.follow = true; });
    app.store.onChange((d) => { if (d?.type === 'tour' || d?.type === 'import') this.updateStartButton(); });
    this.updateStartButton();
  }

  get tour() { return this.app.store.activeTour; }

  // statut d'une adresse : réel, ou simulé pendant une simulation
  status(id) {
    return this.sim && this.simState.has(id) ? this.simState.get(id) : this.app.store.status(id);
  }

  // tournée mise en pause (ou interrompue) pour la tournée active, avec un itinéraire : « Reprendre »
  resumable() {
    const s = this.session;
    return s && s.tour === this.tour?.id && this.tour.route?.stops?.length ? s : null;
  }

  updateStartButton() {
    const s = this.resumable();
    $('nav-start-label').textContent = s ? 'Reprendre' : 'Démarrer';
    $('nav-start-label').textContent = s ? `Reprendre · arrêt ${s.k + 1}` : 'Démarrer';
    $('nav-start').setAttribute('aria-label', s ? `Reprendre la tournée à l'arrêt ${s.k + 1}` : 'Démarrer la tournée');
    $('nav-sim').hidden = !this.tour?.route?.stops?.length;
  }

  _saveSession() {
    this.session = this.sim ? this.session : { tour: this.tour.id, k: this.k, at: Date.now() };
    if (!this.sim) writeSession(this.session);
  }

  _clearSession() {
    this.session = null;
    writeSession(null);
  }

  // ----------------------------------------------------- tournée, démarrage

  async pickTour() {
    const { store, ui } = this.app;
    const tours = store.liveTours();
    const v = await ui.actionSheet('Tournée à distribuer', tours.map((t) => ({ label: t.name, value: t.id, checked: t.id === store.tour })));
    if (v && v !== store.tour) {
      await store.setActiveTour(v);
      ui.toast(`Tournée active : ${store.activeTour.name}`);
    }
  }

  async startFlow() {
    const { ui, tabs, panel, route } = this.app;
    if (!this.tour.route?.stops?.length) {
      const v = await ui.actionSheet('Démarrer la tournée', [
        { label: 'Calculer l\'itinéraire', value: 'compute' },
        { label: 'Démarrer sans itinéraire', value: 'plain' },
      ], { message: 'Aucun itinéraire calculé : sans lui, la tournée suit l\'ordre des rues, sans guidage.' });
      if (v === 'compute') {
        tabs.select('prepare');
        panel.push($('view-prepare'), 'route');
        route.compute(2000);
      } else if (v === 'plain') this.startPlain();
      return;
    }
    const s = this.resumable();
    await this.start(s ? { resumeK: s.k } : {});
  }

  // simulation : même vue que la navigation, position simulée qui avance seule
  async simulate() {
    if (!this.tour.route?.stops?.length) {
      this.app.ui.toast('Calculez d\'abord l\'itinéraire dans Préparer.');
      return;
    }
    await this.start({ sim: true });
  }

  // sans itinéraire : écran allumé et suivi de la position, la prochaine adresse reste proposée dans Distribuer
  startPlain() {
    const { gps, wake, ui } = this.app;
    if (wake.supported && !wake.wanted) wake.enable();
    if (gps.mode === 'off') gps.start();
    gps.setMode('follow');
    ui.toast('Tournée démarrée : suivez la prochaine adresse proposée.', { ms: 4000 });
  }

  async start({ sim = false, resumeK = null } = {}) {
    const { gps, wake, panel, ui } = this.app;
    if (this.active) this.stop(this.sim ? 'sim' : 'pause');
    const route = this.tour.route;
    const { graph, snap } = await loadRoads();
    if (route.roadsVersion !== graph.version) {
      ui.toast('Le réseau routier a changé : recalculez l\'itinéraire dans Préparer.', { ms: 6000 });
      return;
    }
    const known = new Set(this.app.ui.byStreet.flat().map((a) => a.id));
    this.plan = planContext({ graph, data: this.app.data, snap, settings: route.settings });
    this.g = graph;
    this.mode = this.plan.ctx.mode;
    // arrêts de la composition actuelle (une adresse retirée depuis le calcul est ignorée)
    this.stops = route.stops.map((s) => {
      const keep = s.ids.map((id, k) => (known.has(id) ? k : -1)).filter((k) => k >= 0);
      return { ...s, ids: keep.map((k) => s.ids[k]), sides: keep.map((k) => s.sides[k]) };
    }).filter((s) => s.ids.length);
    this.ev = evaluateStops(this.plan, this.stops);
    this.sim = sim;
    this.simState = new Map();
    const open = (j) => j >= 0 && j < this.stops.length && this.stops[j].ids.some((id) => !isTreated(this.status(id)));
    const k = resumeK !== null && open(resumeK) ? resumeK : this._firstOpen(resumeK ?? 0);
    if (k < 0) {
      this.sim = false;
      if (!sim) this._clearSession();
      this.updateStartButton();
      ui.toast('Toutes les adresses de la tournée sont déjà traitées.');
      return;
    }
    this.active = true;
    if (this.app.route) this.app.route._shown = null;  // l'aperçu de Préparer sera redessiné au retour
    this.startK = k;
    this.pos = null;
    this.heading = null;
    this.follow = true;
    $('app').dataset.mode = 'nav';
    if (sim) $('app').dataset.sim = '';
    $('nav-banner').hidden = false;
    $('sim-bar').hidden = !sim;
    ui.closeSheet();
    this.gpsBefore = gps.mode;
    if (sim) {
      this.simulator = new Simulator(this);
    } else {
      if (wake.supported && !wake.wanted) wake.enable();  // geste de l'utilisateur : la demande peut aboutir
      if (gps.mode === 'off') gps.start();
      gps.setMode('follow');
    }
    this.spokenStop = -1;
    $('btn-north').hidden = false;
    ui.updatePadding();
    $('nav-voice').hidden = !this.voice?.supported;
    this._renderToggles();
    panel.show(this.view, 'peek');
    this._goto(k, { fromRoute: true });
    this.voice?.say(`${sim ? 'Simulation' : 'Tournée'} démarrée. Arrêt ${k + 1}, ${this._streetName(this.stops[k])}.`, { interrupt: true });
    if (sim) {
      this.simulator.start(k);
      ui.toast('Simulation : rien n\'est enregistré dans la tournée.', { ms: 3000 });
    } else if (resumeK !== null) ui.toast(`Tournée reprise à l'arrêt ${k + 1}`, { ms: 3000 });
  }

  // Quitter : mettre en pause (reprise plus tard, à cet arrêt) ou terminer la tournée ; simulation : quitter
  async stopFlow() {
    if (this.sim) {
      this.stop('sim');
      return;
    }
    const left = this.stops.flatMap((s) => s.ids).filter((id) => !isTreated(this.status(id))).length;
    const v = await this.app.ui.actionSheet('Quitter la tournée', [
      { label: 'Mettre en pause', value: 'pause' },
      { label: 'Terminer la tournée', value: 'end', destructive: true },
    ], { message: `${plural(left, 'adresse reste', 'adresses restent')} à traiter. En pause, « Reprendre » vous ramène à l'arrêt ${this.k + 1}, même après avoir fermé l'app. La progression est conservée dans les deux cas.` });
    if (v === 'pause') {
      this.stop('pause');
      this.app.ui.toast(`Tournée en pause à l'arrêt ${this.k + 1} : « Reprendre » pour continuer`, { ms: 4000 });
    } else if (v === 'end') this.stop('end');
  }

  // why : 'pause' (reprise possible), 'end' (terminée), 'sim' (fin de simulation)
  stop(why = 'pause') {
    if (!this.active) return;
    const { map, gps, panel, tabs, ui } = this.app;
    this.active = false;
    clearTimeout(this._advance);
    if (why === 'end') this._clearSession();
    if (this.sim) {
      this.simulator?.stop();
      this.simulator = null;
      this.sim = false;
      this.simState = new Map();
      if (this.gpsBefore === 'off') gps.stop();  // position simulée retirée
      ui.refresh();  // statuts réels sur le plan
    }
    delete $('app').dataset.mode;
    delete $('app').dataset.sim;
    $('nav-banner').hidden = true;
    $('sim-bar').hidden = true;
    $('btn-north').hidden = true;
    map.setRotation(0);
    this.voice?.stop();
    map.setRoute(null);
    if (gps.mode === 'follow') gps.setMode('on');
    panel.show(tabs.view());
    ui.updatePadding();
    this.updateStartButton();
    this.app.distribute?.render();
  }

  // ------------------------------------------------------------ arrêts

  // premier arrêt à partir de `from` qui a une adresse non traitée ; puis ceux sautés avant ; -1 : tout est traité
  _firstOpen(from) {
    const open = (s) => s.ids.some((id) => !isTreated(this.status(id)));
    for (let k = from; k < this.stops.length; k++) if (open(this.stops[k])) return k;
    for (let k = 0; k < from && k < this.stops.length; k++) if (open(this.stops[k])) return k;
    return -1;
  }

  // arrêt k : trajet calculé depuis l'arrêt précédent, ou depuis la position si on arrive d'ailleurs
  _goto(k, { fromRoute = false } = {}) {
    this.k = k;
    this.arrived = false;
    const contiguous = fromRoute || k === this.prevK + 1;
    if (this.pos && !contiguous) this._reroute();
    else this._setLeg(this.ev.legs[k]?.arcs);
    this.prevK = k;
    this._saveSession();
    this.render();
    this._drawMap();
    this.renderBanner();
    this.app.ui.updatePadding();
    // sans position : le plan montre l'arrêt
    if (!this.pos) this.app.map.centerOn(this.stops[k].x, this.stops[k].y, { minK: 2.5 });
    // repère à cet arrêt : alerte
    const tagged = this.stops[k].ids.find((id) => this.app.store.tagsOf(id) && !isTreated(this.status(id)));
    if (tagged) this.app.alerts?.alert(this.app.map.byId.get(tagged));
  }

  _target() {
    const s = this.stops[this.k];
    return { arc: s.arc, s: s.sIn };
  }

  _setLeg(arcs) {
    this.leg = arcs?.length ? buildLeg(this.g, arcs, this.mode) : null;
    this.along = null;
    this.offSince = 0;
    this.legId = (this.legId || 0) + 1;
    this.spoken = new Set();
    this._updateRotation();
  }

  // ------------------------------------------------- voix, carte orientée

  toggleVoice() {
    this.voice.setEnabled(!this.voice.enabled);
    this._renderToggles();
    this.app.ui.toast(this.voice.enabled ? 'Consignes vocales activées' : 'Consignes vocales coupées', { ms: 1800 });
  }

  toggleHeadUp() {
    this.headUp = !this.headUp;
    try { localStorage.setItem(HEADUP_KEY, this.headUp ? 'on' : 'off'); } catch { /* préférence de session */ }
    if (this.headUp) this._updateRotation(true);
    else this.app.map.setRotation(0);
    this._renderToggles();
  }

  _renderToggles() {
    $('nav-voice').setAttribute('aria-pressed', String(Boolean(this.voice?.enabled)));
    $('nav-voice').setAttribute('aria-label', this.voice?.enabled ? 'Couper les consignes vocales' : 'Activer les consignes vocales');
    $('nav-voice').classList.toggle('off', !this.voice?.enabled);
    $('btn-north').setAttribute('aria-pressed', String(this.headUp));
    $('btn-north').setAttribute('aria-label', this.headUp ? 'Carte orientée : revenir au nord en haut' : 'Orienter la carte dans le sens de la marche');
  }

  // cap du trajet à venir (20 m devant la position sur le trajet), sinon cap de marche ; radians, repère SVG
  _heading() {
    const leg = this.leg;
    if (leg && leg.pts.length > 1) {
      const d0 = this.along ?? 0;
      const a = pointAlong(leg, d0);
      const b = pointAlong(leg, Math.min(leg.total, d0 + 20));
      if (Math.hypot(b.x - a.x, b.y - a.y) > 2) return Math.atan2(b.y - a.y, b.x - a.x);
    }
    return this.heading;
  }

  // le trajet à venir pointe vers le haut de l'écran (rotation mise à jour au-delà de 8° d'écart)
  _updateRotation(force = false) {
    if (!this.active || !this.headUp) return;
    const h = this._heading();
    if (h === null || h === undefined) return;
    const target = -90 - (h * 180) / Math.PI;
    const diff = Math.abs((((target - this.app.map.rotDeg) % 360) + 540) % 360 - 180);
    if (force || diff >= 8) this.app.map.setRotation(target);
  }

  // annonce vocale de la consigne : à chaque seuil franchi (une fois), la plus proche seulement
  _speakManeuver(m) {
    if (!this.voice?.enabled || m.type === 'arrive') return;
    const at = VOICE_AT[this.mode] || VOICE_AT.car;
    const band = [...at].reverse().find((t) => m.dist <= t);
    if (band === undefined) return;
    const key = `${this.legId}|${Math.round(m.at)}|${band}`;
    if (this.spoken.has(key)) return;
    // seuils plus lointains de la même consigne : déjà dépassés, pas d'annonce en retard
    for (const t of at) if (t >= band) this.spoken.add(`${this.legId}|${Math.round(m.at)}|${t}`);
    const text = instruction(m);
    const closest = band === at[at.length - 1];
    this.voice.say(closest ? text : `Dans ${formatDist(m.dist)}, ${text.charAt(0).toLowerCase()}${text.slice(1)}`, { interrupt: true });
  }

  _reroute() {
    if (!this.pos) return false;
    const arcs = reroute(this.g, this.mode, this.plan.ctx.st, this.pos.x, this.pos.y, this.heading, this._target());
    if (!arcs) return false;
    this._setLeg(arcs);
    return true;
  }

  async skip() {
    const k = this._firstOpen(this.k + 1);
    if (k < 0 || k === this.k) {
      this.app.ui.toast('Pas d\'autre arrêt à faire.');
      return;
    }
    this.prevK = -2;  // on n'arrive pas de l'arrêt précédent : trajet depuis la position
    this._goto(k);
  }

  async allDone() {
    const { ui } = this.app;
    if (Date.now() < this.lockUntil) return;
    this.lockUntil = Date.now() + LOCK_MS;
    const left = this.stops[this.k].ids.filter((id) => !isTreated(this.status(id)));
    if (!left.length) return;
    if (this.sim) {
      this.simMark(left, ST_DONE);
      return;
    }
    const action = await ui.setStatus(left, ST_DONE);
    if (action) ui.toast(`Arrêt ${this.k + 1} : ${plural(left.length, 'adresse distribuée', 'adresses distribuées')}`, { undo: true });
  }

  async act(a, st) {
    if (Date.now() < this.lockUntil) return;
    this.lockUntil = Date.now() + LOCK_MS;
    if (this.sim) this.simMark([a.id], st);
    else await this.app.ui.markAddress(a, st);
  }

  async more(a) {
    const { ui } = this.app;
    const st = this.status(a.id);
    const items = [{ label: 'Anomalie…', value: 'anomaly' }];
    if (st !== ST_AGAIN) items.push({ label: 'À repasser', value: 'again' });
    if (st === ST_DONE || st === ST_ANOMALY) items.push({ label: 'Remettre à faire', value: 'todo' });
    items.push({ label: 'Fiche de l\'adresse', value: 'sheet' });
    const v = await ui.actionSheet(addressLabel(a, ui.streets), items);
    if (this.sim && v && v !== 'sheet') {
      if (v === 'anomaly') {
        const why = await ui.pickReason(a);
        if (why) this.simMark([a.id], ST_ANOMALY);
      } else this.simMark([a.id], v === 'again' ? ST_AGAIN : 'a_faire');
      return;
    }
    if (v === 'anomaly') await ui.markAnomaly(a);
    else if (v === 'again') await ui.markAddress(a, ST_AGAIN);
    else if (v === 'todo') await ui.markAddress(a, 'a_faire');
    else if (v === 'sheet') showAddress(this.app, a);
  }

  // ---------------------------------------------------------- simulation

  // statuts simulés (mémoire) : plan et arrêt mis à jour, arrêt suivant si celui-ci est fini
  simMark(ids, st) {
    for (const id of ids) {
      if (st === 'a_faire') this.simState.delete(id);
      else this.simState.set(id, st);
    }
    this.app.map.applyStatuses((id) => this.status(id));
    this._afterChange();
  }

  // arrêt en cours servi d'un coup (fin de l'arrêt simulé, ou « arrêt suivant »)
  simServe() {
    const left = this.stops[this.k].ids.filter((id) => !isTreated(this.status(id)));
    if (left.length) this.simMark(left, ST_DONE);
    else this._afterChange();
  }

  simNext() {
    if (!this.sim) return;
    this.simulator.resetLeg();
    this.simServe();
  }

  // arrêt précédent : ses adresses (et celles de l'arrêt en cours) redeviennent à faire, on y retourne
  simPrev() {
    if (!this.sim) return;
    const k2 = Math.max(0, this.k - 1);
    for (const j of [k2, this.k]) for (const id of this.stops[j].ids) this.simState.delete(id);
    this.app.map.applyStatuses((id) => this.status(id));
    clearTimeout(this._advance);
    const from = this.stops[k2 - 1] || this.stops[k2];
    this.pos = null;
    this.prevK = k2 - 1;  // trajet de l'itinéraire depuis l'arrêt d'avant
    this.simulator.jump(from.x, from.y);
    this._goto(k2);
  }

  onStore(d) {
    if (!this.active) return;
    if (d?.type === 'tour' && d.change?.includes('active')) {
      this.stop(this.sim ? 'sim' : 'pause');
      return;
    }
    if (!this.sim) this._afterChange();
  }

  _afterChange() {
    const done = this.stops[this.k].ids.every((id) => isTreated(this.status(id)));
    if (!done) {
      this.render();
      return;
    }
    // arrêt fini : le suivant (après un instant, pour voir la coche)
    clearTimeout(this._advance);
    this.render();
    this._advance = setTimeout(() => {
      if (!this.active) return;
      const k = this._firstOpen(this.k + 1);
      if (k < 0) {
        this.app.ui.toast(this.sim ? 'Simulation terminée : tous les arrêts sont servis.'
          : 'Tournée terminée : toutes les adresses sont traitées.', { ms: 5000 });
        this.stop(this.sim ? 'sim' : 'end');
      } else this._goto(k);
    }, 400);
  }

  // ---------------------------------------------------------- position

  onPosition(pos) {
    if (!this.active || !pos || pos.out > 0) return;
    const prev = this.pos;
    if (prev && Math.hypot(pos.x - prev.x, pos.y - prev.y) > 3) this.heading = Math.atan2(pos.y - prev.y, pos.x - prev.x);
    this.pos = pos;
    const { map, gps } = this.app;
    if (this.follow && gps.mode !== 'follow' && !map.isGesturing()) map.centerOn(pos.x, pos.y, { minK: 2.5 });
    const precise = pos.acc <= MAX_ACC_M;
    if (!this.leg) {
      if (precise) this._reroute() && this._drawMap();
    } else {
      const loc = locate(this.leg, pos.x, pos.y, this.along);
      if (loc.perp > OFF_ROUTE_M[this.mode] && precise) {
        this.offSince ||= Date.now();
        if (Date.now() - this.offSince >= this.offRouteMs && this._reroute()) {
          this.app.ui.toast('Itinéraire recalculé', { ms: 2000 });
          this._drawMap();
        }
      } else {
        this.offSince = 0;
        this.along = loc.along;
      }
    }
    const s = this.stops[this.k];
    if (Math.hypot(s.x - pos.x, s.y - pos.y) <= ARRIVE_M[this.mode]) this.arrived = true;
    this._updateRotation();
    this.renderBanner();
    this._renderSub();
  }

  // ----------------------------------------------------------------- rendu

  _stopSummary(s) {
    const { map } = this.app;
    const label = (ids) => ids.map((id) => map.byId.get(id)).filter(Boolean).map(num).join(', ');
    const right = s.ids.filter((_, k) => s.sides[k] > 0);
    const left = s.ids.filter((_, k) => s.sides[k] < 0);
    return [right.length ? `${label(right)} à droite` : '', left.length ? `${label(left)} à gauche` : ''].filter(Boolean).join(' · ');
  }

  _streetName(s) {
    const { map, ui } = this.app;
    const a = map.byId.get(s.ids[0]);
    return a ? ui.streets[a.s].name : '';
  }

  renderBanner() {
    if (!this.active) return;
    const s = this.stops[this.k];
    let m;
    let dist;
    let text;
    if (this.arrived || (this.leg && this.along !== null && this.leg.total - this.along <= ARRIVE_M[this.mode])) {
      m = { type: 'arrive' };
      dist = `Arrêt ${this.k + 1}`;
      text = this._stopSummary(s);
    } else if (!this.leg) {
      m = { type: 'arrive' };
      dist = this.pos ? formatDist(Math.hypot(s.x - this.pos.x, s.y - this.pos.y)) : `Arrêt ${this.k + 1}`;
      text = this.pos ? `Rejoignez l'arrêt ${this.k + 1} · ${this._streetName(s)}` : `Rejoignez l'arrêt ${this.k + 1} · ${this._streetName(s)} (en attente du GPS)`;
    } else {
      m = nextManeuver(this.leg, this.along ?? 0);
      dist = formatDist(m.dist);
      text = instruction(m, `arrêt ${this.k + 1}`);
    }
    $('nav-arrow-path').setAttribute('d', arrowOf(m));
    $('nav-dist').textContent = dist;
    $('nav-instr').textContent = text;
    this.maneuver = m;
    if (m.type === 'arrive' && dist === `Arrêt ${this.k + 1}` && this.spokenStop !== this.k && (this.arrived || this.leg)) {
      this.spokenStop = this.k;
      this.voice?.say(`Arrêt ${this.k + 1}. ${this._stopSummary(s).replace(' · ', ', puis ')}.`, { interrupt: true });
    } else if (m.type !== 'arrive') this._speakManeuver(m);
  }

  // temps restant : arrêts encore à servir (trajet + part du service)
  remaining() {
    let sec = 0;
    this.stops.forEach((s, k) => {
      if (k < this.k) return;
      const n = s.ids.filter((id) => !isTreated(this.status(id))).length;
      if (n) sec += s.legSec + (s.service * n) / s.ids.length;
    });
    return sec;
  }

  _renderSub() {
    const s = this.stops[this.k];
    const far = this.pos ? Math.hypot(s.x - this.pos.x, s.y - this.pos.y) : null;
    const sub = [this._streetName(s), far === null ? '' : far < ARRIVE_M[this.mode] ? 'sur place' : formatDist(far)].filter(Boolean).join(' · ');
    $('nav-left').textContent = `≈ ${formatDuration(this.remaining())} restantes`;
    if ($('nav-sub').textContent !== sub) {
      $('nav-sub').textContent = sub;
      this.app.panel.layout();  // la rue peut changer de nombre de lignes : petit cran recalculé
    }
    // rejoindre le premier arrêt avec une autre app (loin, ou position inconnue)
    const join = !this.sim && this.k === this.startK && (far === null || far > 300);
    $('nav-join').hidden = !join;
    if (join) {
      const { lat, lon } = toLonLat(this.app.data, s.x, s.y);
      const ll = `${lat.toFixed(6)},${lon.toFixed(6)}`;
      $('nav-plans').href = `https://maps.apple.com/?daddr=${ll}&dirflg=${this.mode === 'foot' ? 'w' : 'd'}`;
      $('nav-waze').href = `https://waze.com/ul?ll=${ll}&navigate=yes`;
    }
  }

  render() {
    if (!this.active) return;
    const { map, ui } = this.app;
    const s = this.stops[this.k];
    $('nav-title').textContent = `${this.sim ? 'Simulation · ' : ''}Arrêt ${this.k + 1}/${this.stops.length}`;
    this._renderSub();
    $('nav-addrs').replaceChildren(...s.ids.map((id, i) => {
      const a = map.byId.get(id);
      const st = this.status(id);
      const treated = isTreated(st);
      const li = document.createElement('li');
      li.className = `nav-addr${treated ? ' treated' : ''}`;
      li.dataset.id = id;
      const main = span('nav-addr-main', '');
      main.append(span('nav-addr-name', num(a)), span('nav-addr-sub', `${s.sides[i] > 0 ? 'à droite' : 'à gauche'} · ${ui.streets[a.s].name}`));
      const tags = ui.tagText(id);
      if (tags) main.append(span('tag-line', tags));
      li.append(main);
      if (treated || st === ST_AGAIN) {
        const badge = span(`badge st-${st}`, STATUS_TEXT[st]);
        li.append(badge);
      }
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'round-act';
      more.setAttribute('aria-label', `Autres actions : ${addressLabel(a, ui.streets)}`);
      more.append(icon('M6 12h.01M12 12h.01M18 12h.01'));
      more.addEventListener('click', () => this.more(a));
      li.append(more);
      if (!treated) {
        const done = document.createElement('button');
        done.type = 'button';
        done.className = 'round-act done';
        done.dataset.act = 'done';
        done.setAttribute('aria-label', `Distribué : ${addressLabel(a, ui.streets)}`);
        done.append(icon('M5 12.5l4.5 4.5L19 7.5'));
        done.addEventListener('click', () => this.act(a, ST_DONE));
        li.append(done);
      }
      return li;
    }));
    const left = s.ids.filter((id) => !isTreated(this.status(id))).length;
    $('nav-all').disabled = !left;
    $('nav-all').setAttribute('aria-label', left ? `Tout l'arrêt distribué (${left} adresse${left > 1 ? 's' : ''})` : "Tout l'arrêt distribué");
    // arrêts suivants
    const next = [];
    for (let k = this.k + 1; k < this.stops.length && next.length < 3; k++) {
      if (!this.stops[k].ids.some((id) => !isTreated(this.status(id)))) continue;
      const li = document.createElement('li');
      li.className = 'nav-next-row';
      const main = span('vrow-main', '');
      main.append(span('vrow-name', `Arrêt ${k + 1} · ${this._streetName(this.stops[k])}`), span('vrow-sub', this._stopSummary(this.stops[k])));
      li.append(main);
      next.push(li);
    }
    $('nav-next').replaceChildren(...next);
    $('nav-next').closest('.sec').hidden = !next.length;
    this.app.panel.layout();
  }

  // trajet jusqu'à l'arrêt en gras, puis la suite de l'itinéraire ; arrêts passés retirés
  _drawMap() {
    if (!this.active) return;
    const { map } = this.app;
    const rest = { ...this.ev, stops: this.ev.stops.slice(this.k + 1), legs: this.ev.legs.slice(this.k + 1) };
    const lines = routeLines(this.g, rest);
    const cur = this.stops[this.k];
    if (cur.path) lines.push(...routeLines(this.g, { stops: [cur], legs: [null], endLeg: null }));
    const ahead = this.leg ? [this.leg.pts] : [];
    const marks = [];
    this.stops.forEach((s, k) => {
      if (k < this.k) return;
      marks.push({ x: s.x, y: s.y, label: String(k + 1), cls: k === this.k ? 'current' : '' });
    });
    map.setRoute({ lines, ahead, stops: marks.reverse() });  // l'arrêt en cours dessiné en dernier, au-dessus
  }
}
