// GPS : suivi de position (watchPosition), conversion GPS -> plan par la transformation affine
// calculée par le pipeline, bouton localiser / suivre, encart des adresses non faites les plus proches.

import { ST_AGAIN, ST_DONE } from './store.js';
import { addressLabel, STATUS_LABELS } from './ui.js';

const $ = (id) => document.getElementById(id);
const WATCH_OPTIONS = { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 };
const STALE_S = 10;            // au-delà, la position est grisée et relancée au retour au premier plan
const FOLLOW_MIN_K = 2.2;      // zoom minimal quand on centre sur la position (numéros lisibles)
const NEARBY_COUNT = 3;
const MODE_LABELS = { off: 'Localiser', on: 'Suivre ma position', follow: 'Arrêter le GPS' };

export function formatDistance(m) {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km`;
}

// adresses les plus proches de (x, y) parmi celles que `keep` retient
export function nearest(addresses, x, y, keep, n = NEARBY_COUNT) {
  return addresses
    .filter(keep)
    .map((a) => ({ a, d: Math.hypot(a.x - x, a.y - y) }))
    .sort((p, q) => p.d - q.d)
    .slice(0, n);
}

export class GpsTracker {
  constructor(affine, frame) {
    this.affine = affine;
    this.frame = frame;
    this.watchId = null;
    this.last = null;
    this.lastFixAt = 0;
    this.handlers = {};
    this.restarts = 0;
    this._onVisibility = () => {
      if (document.visibilityState === 'visible' && this.watching && this.age() > STALE_S) {
        this._watch();
        this.restarts += 1;
        this.emit('restart');
      }
    };
  }

  on(type, fn) {
    (this.handlers[type] ||= []).push(fn);
    return this;
  }

  emit(type, detail) {
    for (const fn of this.handlers[type] || []) fn(detail);
  }

  get watching() {
    return this.watchId !== null;
  }

  start() {
    // en HTTP (ex. http://192.168.x.x sur le Wi-Fi), Safari refuse la localisation sans rien demander :
    // le dire, plutôt que d'envoyer l'utilisateur chercher dans des réglages qui n'y sont pour rien
    if (!window.isSecureContext) {
      this.emit('error', { code: 0, message: 'la localisation exige une connexion HTTPS. Ouvrez l\'app depuis son adresse https://' });
      return false;
    }
    if (!navigator.geolocation) {
      this.emit('error', { code: 0, message: 'géolocalisation non disponible sur cet appareil' });
      return false;
    }
    this._watch();
    document.addEventListener('visibilitychange', this._onVisibility);
    return true;
  }

  _watch() {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = navigator.geolocation.watchPosition((p) => this._onPosition(p), (e) => this._onError(e), WATCH_OPTIONS);
  }

  stop() {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    this.last = null;
    document.removeEventListener('visibilitychange', this._onVisibility);
  }

  // GPS (WGS84) -> coordonnées du plan (mètres, nord en haut)
  toPlan(lon, lat) {
    const { x: [a, b, c], y: [d, e, f] } = this.affine;
    return [a * lon + b * lat + c - this.frame.x0, this.frame.y1 - (d * lon + e * lat + f)];
  }

  _onPosition(p) {
    const { longitude: lon, latitude: lat, accuracy } = p.coords;
    const [x, y] = this.toPlan(lon, lat);
    this._set({ x, y, acc: accuracy, lon, lat, source: 'gps' });
  }

  // position simulée (panneau debug, tests)
  inject(x, y, acc = 5) {
    this._set({ x, y, acc, source: 'simulation' });
  }

  _set(pos) {
    const { W, H } = this.frame;
    pos.out = Math.hypot(Math.max(0, -pos.x, pos.x - W), Math.max(0, -pos.y, pos.y - H));
    this.last = pos;
    this.lastFixAt = Date.now();
    this.emit('position', pos);
  }

  _onError(e) {
    if (e.code === 1) this.stop();  // PERMISSION_DENIED : inutile d'insister
    this.emit('error', { code: e.code, message: e.message });
  }

  age() {
    return this.last ? (Date.now() - this.lastFixAt) / 1000 : Infinity;
  }

  quality() {
    if (!this.last) return null;
    if (this.last.source !== 'simulation' && this.age() > STALE_S) return 'stale';  // une simulation ne vieillit pas
    return this.last.acc <= 10 ? 'good' : this.last.acc <= 30 ? 'mid' : 'bad';
  }
}

// bouton localiser (off -> on -> follow -> off) et encart des plus proches
export class GpsController {
  constructor({ map, ui, store, data }) {
    this.map = map;
    this.ui = ui;
    this.store = store;
    this.streets = data.streets;
    this.tracker = new GpsTracker(data.affine, data.frame);
    this.mode = 'off';
    this.frozenUntil = 0;
    this.remindedBackground = false;
    this._buildRows();
    this._bind();
    this._applyMode();
  }

  _bind() {
    $('btn-locate').addEventListener('click', () => this.onButton());
    this.tracker.on('position', (pos) => this._onPosition(pos));
    this.tracker.on('error', (e) => this._onError(e));
    this.tracker.on('restart', () => this.ui.toast('GPS relancé. Il ne fonctionne pas écran verrouillé : gardez l\'écran allumé.', { ms: 5000 }));
    this.map.on('userpan', () => {
      if (this.mode === 'follow') this.setMode('on');
    });
    this.store.onChange(() => this.refresh(undefined, true));  // conséquence du geste lui-même : sans danger
    // liste figée pendant un appui : une mise à jour de position ne doit pas déplacer la ligne sous le doigt
    const card = $('nearby');
    card.addEventListener('pointerdown', () => { this.frozenUntil = Infinity; });
    const release = () => {
      this.frozenUntil = Date.now() + 400;
      clearTimeout(this._thaw);
      this._thaw = setTimeout(() => this.refresh(), 450);
    };
    card.addEventListener('pointerup', release);
    card.addEventListener('pointercancel', release);
    this.timer = setInterval(() => this.tracker.last && this.refresh(), 2000);
  }

  onButton() {
    if (this.mode === 'off') this.start();
    else if (this.mode === 'on') {
      this.setMode('follow');
      this._recenter();
    } else this.stop();
  }

  start() {
    if (!this.tracker.start()) return;
    this.centerOnNextFix = true;
    this.setMode('on');
    const wake = this.wake;  // WakeLockController, branché par main.js
    if (wake && wake.supported && !wake.wanted) {
      this.ui.toast('Le GPS s\'arrête quand l\'écran est verrouillé.', {
        action: { label: 'Garder l\'écran allumé', run: () => wake.enable() },
        ms: 8000,
      });
    } else if (!this.remindedBackground && !(wake && wake.wanted)) {
      this.ui.toast('Le GPS s\'arrête quand l\'écran est verrouillé : gardez l\'écran allumé pendant la tournée.', { ms: 5000 });
    }
    this.remindedBackground = true;
  }

  stop() {
    this.tracker.stop();
    this.setMode('off');
  }

  // position simulée (panneau debug : appui long) ; le vrai GPS est coupé pour ne pas l'écraser
  simulate(x, y, acc = 5) {
    if (this.tracker.watching) this.tracker.stop();
    if (this.mode === 'off') this.setMode('on');
    this.tracker.inject(x, y, acc);
  }

  setMode(mode) {
    this.mode = mode;
    this._applyMode();
  }

  _applyMode() {
    const btn = $('btn-locate');
    btn.dataset.mode = this.mode;
    btn.setAttribute('aria-pressed', String(this.mode === 'follow'));
    btn.setAttribute('aria-label', MODE_LABELS[this.mode]);
    btn.title = MODE_LABELS[this.mode];
    this.refresh();
  }

  _recenter() {
    const pos = this.tracker.last;
    if (pos && pos.out === 0 && !this.map.isGesturing()) this.map.centerOn(pos.x, pos.y, { minK: FOLLOW_MIN_K });
  }

  _onPosition(pos) {
    if (this.centerOnNextFix || this.mode === 'follow') {
      this.centerOnNextFix = false;
      this._recenter();
    }
    this.refresh();
  }

  _onError(e) {
    this.lastError = { code: e.code, message: e.message, at: Date.now() };
    if (e.code === 1) {
      this.setMode('off');
      this.ui.toast('Localisation refusée. iPhone : Réglages › Confidentialité et sécurité › Service de localisation › '
        + 'Sites web Safari › « Lorsque l\'app est active », Position exacte activée.', { ms: 10000 });
    } else if (e.code === 0) {
      this.setMode('off');
      this.ui.toast(`GPS : ${e.message}`, { ms: 8000 });
    } else if (e.code === 2) {
      this.refresh('Position indisponible');
    } else {
      this.refresh('Recherche du signal GPS…');  // TIMEOUT : watchPosition continue
    }
  }

  // ----------------------------------------------------------------- encart

  _buildRows() {
    const list = $('nearby-list');
    this.rows = Array.from({ length: NEARBY_COUNT }, () => {
      const li = document.createElement('li');
      li.className = 'nb-row';
      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'nb-name';
      const label = document.createElement('span');
      label.className = 'nb-label';
      const badge = document.createElement('span');
      badge.className = 'badge st-a_repasser';
      badge.textContent = STATUS_LABELS[ST_AGAIN];
      name.append(label, badge);
      const dist = document.createElement('span');
      dist.className = 'nb-dist';
      const done = document.createElement('button');
      done.type = 'button';
      done.className = 'nb-done';
      done.textContent = 'Fait';
      li.append(name, dist, done);
      list.append(li);
      name.addEventListener('click', () => {
        const a = this.map.byId.get(li.dataset.id);
        if (a) this.ui.openSheet(a);
      });
      done.addEventListener('click', () => {
        const a = this.map.byId.get(li.dataset.id);
        if (a) this.ui.markAddress(a, ST_DONE);
      });
      return { li, label, badge, dist, done };
    });
  }

  refresh(message, force = false) {
    const card = $('nearby');
    const show = this.mode !== 'off' && !this.ui.sheetAddress;
    if (card.hidden === show) {
      card.hidden = !show;
      this.ui.updatePadding();
    }
    const pos = this.tracker.last;
    const q = this.tracker.quality();
    this.map.setGps(this.mode !== 'off' && pos ? { ...pos, quality: q } : null);
    if (!show || (!force && Date.now() < this.frozenUntil)) return;

    let text;
    if (message && !pos) text = message;
    else if (!pos) text = 'Recherche du signal GPS…';
    else if (q === 'stale') text = `Position ancienne (il y a ${Math.round(this.tracker.age())} s)`;
    else if (pos.out > 0) text = `Hors du plan (${formatDistance(pos.out)})`;
    else text = `Précision ± ${Math.round(pos.acc)} m${pos.source === 'simulation' ? ' (simulée)' : ''}`;
    $('gps-status').textContent = text;
    $('gps-indicator').className = `gps-ind q-${q || 'none'}`;

    const items = pos && pos.out === 0
      ? nearest(this.map.pointable, pos.x, pos.y, (a) => !this.map.hidden.has(a.s) && this.store.status(a.id) !== ST_DONE)
      : [];
    const dark = this.ui.isDark();
    this.rows.forEach((row, i) => {
      const it = items[i];
      row.li.hidden = !it;
      if (!it) return;
      row.li.dataset.id = it.a.id;
      row.li.style.setProperty('--sc', this.streets[it.a.s].colors[dark ? 1 : 0]);
      row.label.textContent = addressLabel(it.a, this.streets);
      row.badge.hidden = this.store.status(it.a.id) !== ST_AGAIN;
      row.dist.textContent = formatDistance(it.d);
      row.done.setAttribute('aria-label', `Fait : ${addressLabel(it.a, this.streets)}`);
    });
    $('nearby-list').hidden = !items.length;
  }
}
