// Alerte des repères pendant la tournée : bandeau en haut de l'écran quand la tournée arrive à une adresse repérée,
// soit parce qu'elle devient la prochaine adresse (ou l'arrêt courant), soit parce que la position GPS passe à moins de
// NEAR_M. Une même adresse n'est pas réannoncée avant REPEAT_MS. D'autres modules (voix, navigation) s'abonnent.

import { isTreated } from './store.js';
import { addressLabel } from './ui.js';

const $ = (id) => document.getElementById(id);
const NEAR_M = 50;
const MAX_ACC_M = 30;          // position trop imprécise : pas d'alerte de proximité
const REPEAT_MS = 15 * 60_000;
const SHOW_MS = 8000;

export class TagAlerts {
  constructor(app) {
    this.app = app;
    this.last = new Map();   // adresse -> heure de la dernière alerte
    this.listeners = [];
    $('tag-alert-close').addEventListener('click', () => this.hide());
    app.gps.tracker.on('position', (pos) => this.onPosition(pos));
  }

  onAlert(fn) {
    this.listeners.push(fn);
  }

  // alerte pour une adresse repérée (sauf si elle vient d'être annoncée) ; renvoie true si elle s'affiche
  alert(a, { force = false } = {}) {
    const { ui } = this.app;
    const text = ui.tagText(a.id);
    if (!text) return false;
    const t = this.last.get(a.id);
    if (!force && t && Date.now() - t < REPEAT_MS) return false;
    this.last.set(a.id, Date.now());
    const label = addressLabel(a, ui.streets);
    $('tag-alert-msg').textContent = `${label} : ${text}`;
    $('tag-alert').hidden = false;
    $('app').classList.add('has-tag-alert');
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.hide(), SHOW_MS);
    for (const fn of this.listeners) fn({ a, label, text });
    return true;
  }

  hide() {
    clearTimeout(this._timer);
    $('tag-alert').hidden = true;
    $('app').classList.remove('has-tag-alert');
  }

  // proximité : adresse repérée de la tournée, non traitée, la plus proche à moins de NEAR_M
  onPosition(pos) {
    if (!pos || pos.out > 0 || !(pos.acc <= MAX_ACC_M)) return;
    const { store, map } = this.app;
    let best = null;
    let bd = NEAR_M;
    for (const id of Object.keys(store.tags)) {
      const a = map.byId.get(id);
      if (!a || !map.inScope(a) || isTreated(store.status(id))) continue;
      const d = Math.hypot(a.x - pos.x, a.y - pos.y);
      if (d <= bd) {
        bd = d;
        best = a;
      }
    }
    if (best) this.alert(best);
  }
}
