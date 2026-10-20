// Onglet Distribuer : reprise de la tournée. « Reprendre » mène à la prochaine adresse non traitée dans
// l'ordre de passage (les « à faire » d'abord, puis les « à repasser »). La carte « prochaine adresse », en bas
// de l'écran, la propose avec de gros boutons utilisables d'une main : Distribué (un toucher), Anomalie et son
// motif (deux touchers), À repasser, Toute la rue. Elle avance d'elle-même après chaque action.

import { ST_AGAIN, ST_ANOMALY, ST_DONE, ST_TODO, isTreated } from '../store.js';
import { addressLabel } from '../ui.js';
import { plural } from './common.js';

const $ = (id) => document.getElementById(id);
const GUIDED_KEY = 'neyron-tournees.guided';  // reprise en cours : retrouvée après une relance de l'app
const LOCK_MS = 500;  // après une action, la carte change d'adresse : un second toucher trop rapide est ignoré

export class DistributeView {
  constructor(app) {
    this.app = app;
    this.guided = false;
    this.current = null;  // adresse proposée
    this.lockUntil = 0;
    $('btn-resume').addEventListener('click', () => this.start());
    $('btn-next-close').addEventListener('click', () => this.stop());
    $('next-done').addEventListener('click', () => this.act(ST_DONE));
    $('next-anomaly').addEventListener('click', () => this.act(ST_ANOMALY));
    $('next-later').addEventListener('click', () => this.act(ST_AGAIN));
    $('next-street').addEventListener('click', () => this.act('street'));
    $('next-report').addEventListener('click', () => app.tabs.select('control'));
    app.store.onChange(() => this.render());
    app.ui.onSheet(() => this.render());
    app.tabs.onChange(() => this.render());
    let saved = false;
    try {
      saved = localStorage.getItem(GUIDED_KEY) === '1';
    } catch { /* stockage indisponible : pas de reprise automatique */ }
    if (saved) this.start();
    else this.render();
  }

  // prochaine adresse non traitée dans l'ordre de passage : à faire, sinon à repasser ; null si tout est traité
  next() {
    const { ui, store } = this.app;
    const seq = ui.sequence().flatMap((g) => g.addrs);
    return seq.find((a) => store.status(a.id) === ST_TODO) || seq.find((a) => store.status(a.id) === ST_AGAIN) || null;
  }

  _save(on) {
    try {
      if (on) localStorage.setItem(GUIDED_KEY, '1');
      else localStorage.removeItem(GUIDED_KEY);
    } catch { /* idem */ }
  }

  start() {
    const { ui, map, gps } = this.app;
    this.guided = ui.guided = true;
    this._save(true);
    gps.refresh();  // l'encart GPS laisse la place
    this.render();
    const go = () => this.current && map.centerOn(this.current.x, this.current.y, { minK: 3 });
    if (map._ready) go();
    else map.on('ready', go);
  }

  stop() {
    const { ui, map, gps } = this.app;
    this.guided = ui.guided = false;
    this._save(false);
    $('next-card').hidden = true;
    if (!ui.sheetAddress) map.selectAddress(null);
    gps.refresh();
    this.render();
  }

  async act(what) {
    const { ui } = this.app;
    const a = this.current;
    if (!a || Date.now() < this.lockUntil) return;
    this.lockUntil = Date.now() + LOCK_MS;
    $('next-card').classList.add('busy');
    setTimeout(() => $('next-card').classList.remove('busy'), LOCK_MS);
    if (what === ST_ANOMALY) await ui.markAnomaly(a);
    else if (what === 'street') await ui.markStreet(a.s);
    else await ui.markAddress(a, what);
  }

  render() {
    const { ui, map } = this.app;
    const a = this.next();
    const moved = (a && a.id) !== (this.current && this.current.id);
    this.current = a;
    const sheetOpen = Boolean(ui.sheetAddress);
    $('btn-resume').hidden = this.guided || sheetOpen || !a;
    if (a) $('resume-next').textContent = addressLabel(a, ui.streets);
    $('next-card').hidden = !this.guided || sheetOpen;
    if (this.guided) this._fill(a);
    ui.updatePadding();
    if (!this.guided || sheetOpen) return;
    map.selectAddress(a ? a.id : null);
    if (moved && a) this._reveal(a);
  }

  // nouvelle adresse proposée : la garder visible au-dessus de la carte, sans recentrer à chaque pas
  _reveal(a) {
    const { map, gps, tabs } = this.app;
    if (tabs.current !== 'distribute' || gps.mode === 'follow' || !map._ready) return;  // le suivi GPS garde la main
    if (map.k < 2) map.centerOn(a.x, a.y, { minK: 3 });
    else map.ensureVisible(a.x, a.y);
  }

  _fill(a) {
    const { ui, store } = this.app;
    const card = $('next-card');
    $('next-body').hidden = !a;
    $('next-end').hidden = Boolean(a);
    $('next-pos').hidden = !a;
    if (!a) {
      const all = ui.order.flatMap((s) => ui.byStreet[s]);
      const done = all.filter((x) => store.status(x.id) === ST_DONE).length;
      const anom = all.filter((x) => store.status(x.id) === ST_ANOMALY).length;
      card.style.removeProperty('--sc');
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
    $('next-pos').textContent = `Rue ${ui.order.indexOf(a.s) + 1}/${ui.order.length} · ${plural(left, 'numéro restant', 'numéros restants')}`;
    $('next-title').textContent = addressLabel(a, ui.streets);
    $('next-sub').textContent = [st === ST_AGAIN ? 'à repasser' : '', `côté ${a.side}`, a.ld].filter(Boolean).join(' · ');
    $('next-later').hidden = st === ST_AGAIN;
    $('next-street').hidden = left < 2;
    $('next-street').textContent = `Toute la rue (${left})`;
  }
}
