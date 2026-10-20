// Onglet Préparer : les tournées (créer, choisir, renommer, archiver, restaurer) et la composition de la
// tournée active, par rue (toute la rue, côté pair / impair, plage de numéros) ou numéro par numéro sur la
// carte. À venir (L4) : ordre des rues, charge de travail, adresses manquantes, import d'un secteur.

import { ST_DONE } from '../store.js';
import { addressLabel } from '../ui.js';
import { fold, plural, showStreet, streetRow } from './common.js';

const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';
const agree = (n, word) => `${word}${n > 1 ? 's' : ''}`;  // accord : « 3 numéros ajoutés »

function checkIcon() {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'ico vrow-check');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVGNS, 'path');
  p.setAttribute('d', 'M5 12.5l4.5 4.5L19 7.5');
  svg.append(p);
  return svg;
}

// ligne de tournée : nom, détail, coche si active
function tourRow({ name, sub, active = false, label, onClick }) {
  const li = document.createElement('li');
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `vrow tour-row${active ? ' active' : ''}`;
  if (active) b.setAttribute('aria-current', 'true');
  b.setAttribute('aria-label', label);
  const main = document.createElement('span');
  main.className = 'vrow-main';
  const n = document.createElement('span');
  n.className = 'vrow-name';
  n.textContent = name;
  const s = document.createElement('span');
  s.className = 'vrow-sub';
  s.textContent = sub;
  main.append(n, s);
  b.append(main);
  if (active) b.append(checkIcon());
  b.addEventListener('click', onClick);
  li.append(b);
  return li;
}

export class PrepareView {
  constructor(app) {
    this.app = app;
    this.query = '';
    this.editing = null;     // rue ouverte dans l'éditeur
    this.selecting = false;  // composition sur la carte
    this.allByStreet = app.ui.streets.map((_, i) => app.map.pointable.filter((a) => a.s === i));
    this.order = new Map(app.map.pointable.map((a, k) => [a.id, k]));  // ordre des données : rue, numéro

    $('prep-search').addEventListener('input', (e) => { this.query = fold(e.target.value.trim()); this.renderStreets(); });
    $('btn-tour-new').addEventListener('click', () => this.newTour());
    $('btn-tour-rename').addEventListener('click', () => this.renameTour());
    $('btn-tour-archive').addEventListener('click', () => this.archiveTour());
    $('btn-tour-select').addEventListener('click', () => this.startSelect());
    $('btn-select-done').addEventListener('click', () => this.stopSelect());
    this._bindEditor();
    app.tabs.onChange((tab) => {
      if (this.selecting && tab !== 'prepare') this.stopSelect(false);
      if (tab === 'prepare') this.render();
    });
    app.store.onChange(() => {
      if (this.selecting) this._updateSelectCount();
      else if (app.tabs.current === 'prepare') this.render();
    });
    if (app.tabs.current === 'prepare') this.render();
  }

  get tour() {
    return this.app.store.activeTour;
  }

  // composition enregistrée dans l'ordre des données (adresses inconnues du plan écartées)
  async setIds(ids) {
    const sorted = [...ids].filter((id) => this.order.has(id)).sort((a, b) => this.order.get(a) - this.order.get(b));
    await this.app.store.updateTour(this.tour.id, { ids: sorted });
  }

  // --------------------------------------------------------------- rendu

  render() {
    this.renderTours();
    this.renderActive();
    this.renderStreets();
  }

  renderTours() {
    const { store } = this.app;
    const sub = (t) => {
      const st = store.stateOf(t.id);
      const ids = t.ids.filter((id) => this.order.has(id));
      const done = ids.filter((id) => st.get(id) === ST_DONE).length;
      return ids.length ? `${plural(ids.length, 'adresse')} · ${done} ${agree(done, 'faite')}` : 'vide';
    };
    $('tour-list').replaceChildren(...store.liveTours().map((t) => tourRow({
      name: t.name,
      sub: sub(t),
      active: t.id === store.tour,
      label: t.id === store.tour ? `${t.name} (tournée active)` : `Choisir la tournée ${t.name}`,
      onClick: () => this.activate(t),
    })));
    const archived = store.archivedTours();
    $('tour-archived').hidden = !archived.length;
    $('tour-archived-n').textContent = String(archived.length);
    $('tour-archived-list').replaceChildren(...archived.map((t) => tourRow({
      name: t.name,
      sub: `${sub(t)} · toucher pour restaurer`,
      label: `Restaurer la tournée ${t.name}`,
      onClick: () => this.restore(t),
    })));
  }

  renderActive() {
    const { store, ui } = this.app;
    const t = this.tour;
    const n = ui.byStreet.reduce((k, addrs) => k + addrs.length, 0);
    const streets = ui.byStreet.filter((addrs) => addrs.length).length;
    $('prep-tour-name').textContent = t.name;
    $('prep-summary').textContent = n
      ? `${plural(n, 'adresse')} · ${plural(streets, 'rue')}`
      : 'Tournée vide : ajoutez des rues ci-dessous ou choisissez les numéros sur la carte.';
    $('btn-tour-archive').disabled = store.liveTours().length < 2;  // la dernière tournée en cours reste
  }

  renderStreets() {
    const { ui } = this.app;
    const dark = ui.isDark();
    const rows = [];
    this.allByStreet.forEach((addrs, i) => {
      if (this.query && !fold(ui.streets[i].name).includes(this.query)) return;
      const k = ui.byStreet[i].length;
      rows.push(streetRow({
        color: k ? ui.streets[i].colors[dark ? 1 : 0] : 'var(--ctx)',
        name: ui.streets[i].name,
        sub: k ? `${k}/${addrs.length} dans la tournée` : `${plural(addrs.length, 'numéro')} · hors tournée`,
        count: `${k}/${addrs.length}`,
        complete: k === addrs.length,
        onClick: () => this.openEditor(i),
      }));
    });
    $('prep-streets').replaceChildren(...rows);
    $('prep-empty').hidden = rows.length > 0;
  }

  // ------------------------------------------------------------ tournées

  async activate(t) {
    if (t.id === this.app.store.tour) return;
    await this.app.store.setActiveTour(t.id);
    this.app.ui.toast(`Tournée active : ${t.name}`);
  }

  async newTour() {
    const { store, ui } = this.app;
    const day = new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
    const name = await ui.prompt('Nom de la nouvelle tournée', `Tournée du ${day}`, 'Créer');
    if (!name) return;
    await store.createTour(name);
    ui.toast(`« ${name} » créée : ajoutez des rues ou choisissez les numéros sur la carte`, { ms: 5000 });
  }

  async renameTour() {
    const t = this.tour;
    const name = await this.app.ui.prompt('Nouveau nom de la tournée', t.name, 'Renommer');
    if (name && name !== t.name) await this.app.store.updateTour(t.id, { name });
  }

  async archiveTour() {
    const { store, ui } = this.app;
    const t = this.tour;
    if (!(await ui.confirm(`Archiver « ${t.name} » ? Sa progression est conservée et vous pourrez la restaurer.`, 'Archiver'))) return;
    if (await store.archiveTour(t.id)) ui.toast(`« ${t.name} » archivée · tournée active : ${store.activeTour.name}`, { ms: 4000 });
    else ui.toast('C\'est la seule tournée en cours : créez-en une autre avant d\'archiver celle-ci.', { ms: 5000 });
  }

  async restore(t) {
    await this.app.store.archiveTour(t.id, false);
    this.app.ui.toast(`« ${t.name} » restaurée`);
  }

  // ------------------------------------------------- éditeur de rue

  _bindEditor() {
    const dlg = $('street-editor');
    const update = () => this._preview();
    for (const r of dlg.querySelectorAll('input[name="se-side"]')) r.addEventListener('change', update);
    $('se-from').addEventListener('input', update);
    $('se-to').addEventListener('input', update);
    $('se-add').addEventListener('click', () => this._applyEditor(true));
    $('se-remove').addEventListener('click', () => this._applyEditor(false));
    $('se-map').addEventListener('click', () => {
      const i = this.editing;
      dlg.close();
      showStreet(this.app, i);
    });
  }

  openEditor(i) {
    this.editing = i;
    const addrs = this.allByStreet[i];
    const even = addrs.filter((a) => a.side === 'pair').length;
    $('se-title').textContent = this.app.ui.streets[i].name;
    $('se-sub').textContent = `${plural(addrs.length, 'numéro')} (${even} ${agree(even, 'pair')}, `
      + `${addrs.length - even} ${agree(addrs.length - even, 'impair')}) · n° ${addrs[0].n} à ${addrs[addrs.length - 1].n}`;
    $('street-editor').querySelector('input[name="se-side"][value="all"]').checked = true;
    $('se-from').value = '';
    $('se-to').value = '';
    this._preview();
    $('street-editor').showModal();
  }

  // numéros de la rue retenus par le côté et la plage
  _matching() {
    const side = $('street-editor').querySelector('input[name="se-side"]:checked').value;
    const from = parseInt($('se-from').value, 10);
    const to = parseInt($('se-to').value, 10);
    return this.allByStreet[this.editing].filter((a) => (side === 'all' || a.side === side)
      && (Number.isNaN(from) || a.n >= from) && (Number.isNaN(to) || a.n <= to));
  }

  _preview() {
    const m = this._matching();
    const ids = new Set(this.tour.ids);
    const inTour = m.filter((a) => ids.has(a.id)).length;
    $('se-preview').textContent = m.length
      ? `${plural(m.length, 'numéro')} ${agree(m.length, 'concerné')} · ${inTour} déjà dans la tournée`
      : 'Aucun numéro ne correspond.';
    $('se-add').disabled = !m.length || inTour === m.length;
    $('se-remove').disabled = !inTour;
  }

  async _applyEditor(add) {
    const m = this._matching();
    const ids = new Set(this.tour.ids);
    let n = 0;
    for (const a of m) {
      if (add !== ids.has(a.id)) {
        if (add) ids.add(a.id);
        else ids.delete(a.id);
        n += 1;
      }
    }
    const name = this.app.ui.streets[this.editing].name;
    $('street-editor').close();
    if (!n) return;
    await this.setIds(ids);
    this.app.ui.toast(`${name} : ${n} ${agree(n, 'numéro')} ${agree(n, add ? 'ajouté' : 'retiré')}`);
  }

  // ------------------------------------------------ composition sur la carte

  startSelect() {
    const { map, ui } = this.app;
    this.selecting = true;
    $('app').dataset.mode = 'select';
    $('view-prepare').hidden = true;
    $('select-bar').hidden = false;
    map.selecting = true;
    ui.tapOverride = (a) => this.toggle(a);
    this._updateSelectCount();
    map.fitAll();
  }

  stopSelect(showView = true) {
    const { map, ui } = this.app;
    this.selecting = false;
    delete $('app').dataset.mode;
    $('select-bar').hidden = true;
    map.selecting = false;
    ui.tapOverride = null;
    if (showView && this.app.tabs.current === 'prepare') {
      $('view-prepare').hidden = false;
      this.render();
    }
  }

  async toggle(a) {
    const ids = new Set(this.tour.ids);
    const add = !ids.has(a.id);
    if (add) ids.add(a.id);
    else ids.delete(a.id);
    await this.setIds(ids);
    this.app.ui.toast(`${addressLabel(a, this.app.ui.streets)} : ${add ? 'ajouté à' : 'retiré de'} la tournée`, { ms: 1800 });
  }

  _updateSelectCount() {
    const n = this.app.ui.byStreet.reduce((k, addrs) => k + addrs.length, 0);
    $('select-count').textContent = `${this.tour.name} : ${plural(n, 'adresse')}`;
  }
}
