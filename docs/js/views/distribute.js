// Onglet Distribuer : la prochaine adresse non traitée dans l'ordre de passage (les « à faire » d'abord, puis
// les « à repasser ») est toujours proposée en haut de la feuille, avec de gros boutons utilisables d'une main :
// Distribué (un toucher), Anomalie et son motif (deux touchers), À repasser, Toute la rue. Elle avance d'elle-même
// après chaque action, et le plan garde l'adresse suivante en vue. Reprendre une tournée interrompue ne demande
// donc aucun geste. Dessous : les adresses à proximité (GPS) et les rues de la tournée.

import { ST_AGAIN, ST_ANOMALY, ST_DONE, ST_TODO, isTreated } from '../store.js';
import { addressLabel } from '../ui.js';
import { plural } from './common.js';

const $ = (id) => document.getElementById(id);
const LOCK_MS = 500;  // après une action, la carte change d'adresse : un second toucher trop rapide est ignoré

export class DistributeView {
  constructor(app) {
    this.app = app;
    this.current = null;  // adresse proposée
    this.lockUntil = 0;
    this.follow = false;  // action faite depuis la carte « prochaine » : montrer la suivante sur le plan
    $('next-done').addEventListener('click', () => this.act(ST_DONE));
    $('next-anomaly').addEventListener('click', () => this.act(ST_ANOMALY));
    $('next-later').addEventListener('click', () => this.act(ST_AGAIN));
    $('next-street').addEventListener('click', () => this.act('street'));
    $('next-report').addEventListener('click', () => app.tabs.select('control'));
    app.store.onChange(() => this.render());
    app.ui.onSheet(() => this.render());
    app.tabs.onChange(() => this.render());
    this.render();
    // tournée commencée : le plan s'ouvre sur l'adresse où l'on s'était arrêté
    const resume = () => {
      const { store } = app;
      if (this.current && store.events.length) app.map.centerOn(this.current.x, this.current.y, { minK: 3, animate: false });
    };
    if (app.map._ready) resume();
    else app.map.on('ready', resume);
  }

  // prochaine adresse non traitée dans l'ordre de passage : à faire, sinon à repasser ; null si tout est traité
  next() {
    const { ui, store } = this.app;
    const seq = ui.visitOrder();
    return seq.find((a) => store.status(a.id) === ST_TODO) || seq.find((a) => store.status(a.id) === ST_AGAIN) || null;
  }

  async act(what) {
    const { ui } = this.app;
    const a = this.current;
    if (!a || Date.now() < this.lockUntil) return;
    this.lockUntil = Date.now() + LOCK_MS;
    $('next-card').classList.add('busy');
    setTimeout(() => $('next-card').classList.remove('busy'), LOCK_MS);
    this.follow = true;
    if (what === ST_ANOMALY) await ui.markAnomaly(a);
    else if (what === 'street') await ui.markStreet(a.s);
    else await ui.markAddress(a, what);
    this.follow = false;
  }

  render() {
    const { ui, map, panel } = this.app;
    const a = this.next();
    const moved = (a && a.id) !== (this.current && this.current.id);
    this.current = a;
    this._fill(a);
    if (panel) panel.layout();
    if (ui.sheetAddress || this.app.prepare?.selecting) return;
    map.selectAddress(a ? a.id : null);
    if (moved && a && this.follow) this._reveal(a);
  }

  // adresse suivante : la garder visible au-dessus de la feuille, sans recentrer à chaque pas
  _reveal(a) {
    const { map, gps } = this.app;
    if (gps.mode === 'follow' || !map._ready) return;  // le suivi GPS garde la main
    if (map.k < 2) map.centerOn(a.x, a.y, { minK: 3 });
    else map.ensureVisible(a.x, a.y);
  }

  _fill(a) {
    const { ui, store } = this.app;
    const card = $('next-card');
    $('next-body').hidden = !a;
    $('next-end').hidden = Boolean(a);
    if (!a) {
      const all = ui.order.flatMap((s) => ui.byStreet[s]);
      const done = all.filter((x) => store.status(x.id) === ST_DONE).length;
      const anom = all.filter((x) => store.status(x.id) === ST_ANOMALY).length;
      card.style.removeProperty('--sc');
      $('next-pos').textContent = all.length ? 'Bravo' : 'Rien à distribuer';
      $('next-title').textContent = all.length ? 'Tournée terminée' : 'Tournée vide';
      $('next-sub').textContent = all.length
        ? `${plural(done, 'adresse distribuée', 'adresses distribuées')}, ${plural(anom, 'anomalie')}.`
        : 'Composez-la dans l\'onglet Préparer.';
      $('next-report').hidden = !all.length;
      return;
    }
    const st = store.status(a.id);
    const left = ui.byStreet[a.s].filter((x) => !isTreated(store.status(x.id))).length;
    card.style.setProperty('--sc', ui.streets[a.s].colors[ui.isDark() ? 1 : 0]);
    const stops = store.activeTour?.route?.stops;
    const k = stops?.length ? stops.findIndex((st) => st.ids.includes(a.id)) : -1;
    const where = k >= 0 ? `Arrêt ${k + 1}/${stops.length}` : `Rue ${ui.order.indexOf(a.s) + 1}/${ui.order.length}`;
    $('next-pos').textContent = `Prochaine adresse · ${where} · ${plural(left, 'numéro restant', 'numéros restants')}`;
    $('next-title').textContent = addressLabel(a, ui.streets);
    $('next-sub').textContent = [st === ST_AGAIN ? 'À repasser' : '', `côté ${a.side}`, a.ld].filter(Boolean).join(' · ');
    $('next-later').hidden = st === ST_AGAIN;
    $('next-street').hidden = left < 2;
    $('next-street').textContent = `Toute la rue (${left})`;
  }
}
