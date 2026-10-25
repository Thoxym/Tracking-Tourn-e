// Onglet Préparer : la tournée active et sa charge estimée, puis des pages de la feuille : les tournées (créer,
// importer un secteur, choisir, archiver, restaurer), les rues de la commune et l'éditeur de rue (toute la rue,
// côté pair / impair, plage de numéros), l'ordre de passage, les vérifications avant départ, les réglages de
// l'estimation. « Choisir sur la carte » réduit la feuille à une barre : un toucher ajoute ou retire un numéro.

import { ST_DONE } from '../store.js';
import {
  SECTOR_MAX_BYTES, UNADDRESSED_NEAR_M, findGaps, formatDistance, formatDuration, isReversed, mstLength,
  nearUnaddressed, parseSector, saveWorkloadSettings, validSetting, workload, workloadSettings,
} from '../tourplan.js';
import { addressLabel } from '../ui.js';
import { fold, guard, num, plural, showAddress, showPoint, showStreet, streetRow } from './common.js';

const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';
const agree = (n, word) => `${word}${n > 1 ? 's' : ''}`;  // accord : « 3 numéros ajoutés »

function icon(cls, ...paths) {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', `ico ${cls}`.trim());
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

// ligne de tournée : nom, détail, coche si active
function tourRow({ name, sub, active = false, label, onClick }) {
  const li = document.createElement('li');
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `vrow tour-row${active ? ' active' : ''}`;
  if (active) b.setAttribute('aria-current', 'true');
  b.setAttribute('aria-label', label);
  const main = span('vrow-main', '');
  main.append(span('vrow-name', name), span('vrow-sub', sub));
  b.append(main);
  if (active) b.append(icon('vrow-check', 'M5 12.5l4.5 4.5L19 7.5'));
  b.addEventListener('click', onClick);
  li.append(b);
  return li;
}

function smallButton({ cls, label, paths, disabled = false, onClick, data = {} }) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `order-btn ${cls}`;
  b.setAttribute('aria-label', label);
  b.title = label;
  b.disabled = disabled;
  for (const [k, v] of Object.entries(data)) b.dataset[k] = v;
  b.append(icon('', ...paths));
  b.addEventListener('click', onClick);
  return b;
}

// fichier texte en UTF-8, sinon Windows-1252 (CSV enregistré par Excel en français)
async function readText(file) {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

export class PrepareView {
  constructor(app) {
    this.app = app;
    this.query = '';
    this.editing = null;     // rue ouverte dans l'éditeur
    this.selecting = false;  // composition sur la carte
    this.allByStreet = app.ui.streets.map((_, i) => app.map.pointable.filter((a) => a.s === i));
    this.rank = new Map(app.map.pointable.map((a, k) => [a.id, k]));  // ordre des données : rue, numéro
    guard(this, ['activate', 'newTour', 'renameTour', 'archiveTour', 'restore', 'moveStreet', 'toggleReverse',
      'resetOrder', 'addGaps', 'toggle', '_applyEditor']);

    $('prep-search').addEventListener('input', (e) => { this.query = fold(e.target.value.trim()); this.renderStreets(); });
    $('btn-tour-new').addEventListener('click', () => this.newTour());
    $('btn-tour-rename').addEventListener('click', () => this.renameTour());
    $('btn-tour-archive').addEventListener('click', () => this.archiveTour());
    $('btn-tour-select').addEventListener('click', () => this.startSelect());
    $('btn-select-done').addEventListener('click', () => this.stopSelect());
    $('btn-order-reset').addEventListener('click', () => this.resetOrder());
    $('sector-file').addEventListener('change', (e) => this.importSector(e.target));
    $('btn-sector').addEventListener('keydown', (e) => {  // le <label> ne s'active pas au clavier
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        $('sector-file').click();
      }
    });
    this._bindEditor();
    this._bindSettings();
    app.tabs.onChange((tab, prev) => {
      if (this.selecting && (tab !== 'prepare' || tab === prev)) this.stopSelect(tab === 'prepare');
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

  // ids dans l'ordre des données (adresses inconnues du plan écartées)
  _sorted(ids) {
    return [...ids].filter((id) => this.rank.has(id)).sort((a, b) => this.rank.get(a) - this.rank.get(b));
  }

  async setIds(ids) {
    await this.app.store.updateTour(this.tour.id, { ids: this._sorted(ids) });
  }

  // --------------------------------------------------------------- rendu

  render() {
    this.renderTours();
    this.renderActive();
    this.renderOrder();
    this.renderChecks();
    this.renderStreets();
  }

  renderTours() {
    const { store } = this.app;
    const sub = (t) => {
      const st = store.stateOf(t.id);
      const ids = t.ids.filter((id) => this.rank.has(id));
      const done = ids.filter((id) => st.get(id) === ST_DONE).length;
      return ids.length ? `${plural(ids.length, 'adresse')} · ${done} ${agree(done, 'distribuée')}` : 'vide';
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
    const w = workload(ui.sequence(), workloadSettings());
    $('prep-tour-name').textContent = t.name;
    $('prep-summary').textContent = w.addresses
      ? `${plural(w.addresses, 'adresse')} · ${plural(w.streets, 'rue')}`
      : 'Tournée vide : ajoutez des rues ci-dessous ou choisissez les numéros sur la carte.';
    $('prep-load').hidden = !w.addresses;
    $('prep-load-dist').textContent = `≈ ${formatDistance(w.meters)}`;
    $('prep-load-time').textContent = `≈ ${formatDuration(w.seconds)}`;
    $('btn-tour-archive').disabled = store.liveTours().length < 2;  // la dernière tournée en cours reste
    $('prep-tour-row').setAttribute('aria-label', `Tournée active : ${t.name}. Changer de tournée`);
  }

  // rues de la tournée dans l'ordre de passage : monter, descendre, inverser le sens
  renderOrder() {
    const { ui } = this.app;
    const t = this.tour;
    const dark = ui.isDark();
    const order = ui.order;
    $('prep-order-n').textContent = order.length ? plural(order.length, 'rue') : 'tournée vide';
    $('prep-order').replaceChildren(...order.map((s, k) => {
      const addrs = ui.byStreet[s];
      const rev = isReversed(t, s, ui.keys);
      const [first, last] = rev ? [addrs[addrs.length - 1], addrs[0]] : [addrs[0], addrs[addrs.length - 1]];
      const name = ui.streets[s].name;
      const li = document.createElement('li');
      li.className = 'order-row';
      li.dataset.s = s;
      li.style.setProperty('--sc', ui.streets[s].colors[dark ? 1 : 0]);
      const main = span('vrow-main', '');
      main.append(span('vrow-name', `${k + 1}. ${name}`),
        span('vrow-sub', `${plural(addrs.length, 'numéro')} · n° ${num(first)} → ${num(last)} · ${formatDistance(mstLength(addrs))}`));
      li.append(span('order-dot', ''), main,
        smallButton({ cls: `order-rev${rev ? ' on' : ''}`, label: `Inverser le sens : ${name}`, data: { s, act: 'rev' },
          paths: ['M7 4v16M3.5 16.5L7 20l3.5-3.5', 'M17 20V4M13.5 7.5L17 4l3.5 3.5'], onClick: () => this.toggleReverse(s) }),
        smallButton({ cls: 'order-up', label: `Monter : ${name}`, disabled: k === 0, data: { s, act: 'up' },
          paths: ['M6 14l6-6 6 6'], onClick: () => this.moveStreet(k, -1) }),
        smallButton({ cls: 'order-down', label: `Descendre : ${name}`, disabled: k === order.length - 1, data: { s, act: 'down' },
          paths: ['M6 10l6 6 6-6'], onClick: () => this.moveStreet(k, 1) }));
      li.querySelector('.order-rev').setAttribute('aria-pressed', String(rev));
      return li;
    }));
    $('btn-order-reset').disabled = !(t.order?.length || t.reverse?.length);
    if (this._focus) {  // garder le focus sur le bouton utilisé (clavier, VoiceOver)
      const { s, act } = this._focus;
      this._focus = null;
      const b = $('prep-order').querySelector(`[data-s="${s}"][data-act="${act}"]`);
      const alt = $('prep-order').querySelector(`[data-s="${s}"][data-act="${act === 'up' ? 'down' : 'up'}"]`);
      (b && !b.disabled ? b : alt)?.focus();
    }
  }

  // vérifications avant départ : numéros oubliés, numéros sans bâtiment, bâtiments sans adresse
  renderChecks() {
    const { ui, data } = this.app;
    const tourAddrs = ui.order.flatMap((s) => ui.byStreet[s]);
    const box = $('prep-checks');
    if (!tourAddrs.length) {
      $('prep-checks-n').textContent = 'tournée vide';
      const p = document.createElement('p');
      p.className = 'foot first';
      p.textContent = 'Composez la tournée pour lancer les vérifications.';
      box.replaceChildren(p);
      return;
    }
    const color = (a) => ui.streets[a.s].colors[ui.isDark() ? 1 : 0];
    const gaps = findGaps(this.allByStreet, new Set(this.tour.ids));
    const noBld = tourAddrs.filter((a) => !a.bat);
    const near = nearUnaddressed(data.unaddressed || [], tourAddrs);
    const n = gaps.length + noBld.length + near.length;
    $('prep-checks-n').textContent = n ? plural(n, 'point', 'points') : 'rien à signaler';
    box.replaceChildren(
      this._checkGroup({
        id: 'gaps',
        title: 'Numéros oubliés ?',
        none: 'Aucun numéro oublié entre deux numéros de la tournée.',
        help: 'Hors tournée, mais entre deux numéros de la tournée du même côté de la rue.',
        rows: gaps.map(({ a, prev, next }) => ({
          color: color(a), name: addressLabel(a, ui.streets), sub: `entre le ${num(prev)} et le ${num(next)}`,
          onClick: () => showPoint(this.app, a.x, a.y),
        })),
        action: gaps.length ? {
          label: gaps.length > 1 ? `Ajouter ces ${gaps.length} numéros à la tournée` : 'Ajouter ce numéro à la tournée',
          run: () => this.addGaps(gaps.map((g) => g.a.id)),
        } : null,
      }),
      this._checkGroup({
        id: 'nobld',
        title: 'Numéros sans bâtiment',
        none: 'Tous les numéros de la tournée ont un bâtiment sur le plan.',
        help: 'Le point d\'adresse ne touche aucun bâtiment du cadastre : construction récente, ou point mal placé. À vérifier sur place.',
        rows: noBld.map((a) => ({
          color: color(a), name: addressLabel(a, ui.streets), sub: a.ld || `côté ${a.side}`,
          onClick: () => showAddress(this.app, a),
        })),
      }),
      this._checkGroup({
        id: 'unaddressed',
        title: 'Bâtiments sans adresse',
        none: `Aucun bâtiment sans adresse à moins de ${UNADDRESSED_NEAR_M} m de la tournée.`,
        help: 'Bâti de 50 m² ou plus, sur une parcelle sans adresse : peut-être une boîte absente de la base. À vérifier sur place.',
        rows: near.map(({ u, a, d }) => ({
          color: 'var(--text-2)', name: `Bâtiment de ${u.a} m²`, sub: `à ${Math.round(d)} m du ${addressLabel(a, ui.streets)}`,
          onClick: () => showPoint(this.app, u.x, u.y),
        })),
      }),
    );
  }

  // groupe de vérification : titre, lignes (un toucher montre le point), explication, action éventuelle
  _checkGroup({ id, title, none, help, rows, action = null }) {
    const g = document.createElement('section');
    g.className = 'check-group';
    g.dataset.check = id;
    const h = document.createElement('h4');
    h.textContent = rows.length ? `${title} (${rows.length})` : title;
    const p = document.createElement('p');
    p.className = 'foot';
    if (!rows.length) {
      const ok = document.createElement('div');
      ok.className = 'group';
      const line = span('row check-none', none);
      ok.append(line);
      g.append(h, ok);
      return g;
    }
    p.textContent = help;
    const ul = document.createElement('ul');
    ul.className = 'group';
    ul.append(...rows.map((r) => streetRow(r)));
    g.append(h, ul, p);
    if (action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn tinted wide';
      b.textContent = action.label;
      b.addEventListener('click', action.run);
      g.append(b);
    }
    return g;
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
        sub: k ? `${k}/${addrs.length} dans la tournée`
          : `${plural(addrs.length, 'numéro')} · ${formatDistance(ui.streets[i].len || 0)} · hors tournée`,
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
    if (!(await ui.confirm(`Archiver « ${t.name} » ? Sa progression est conservée et vous pourrez la restaurer.`, 'Archiver', { destructive: true }))) return;
    if (await store.archiveTour(t.id)) ui.toast(`« ${t.name} » archivée · tournée active : ${store.activeTour.name}`, { ms: 4000 });
    else ui.toast('C\'est la seule tournée en cours : créez-en une autre avant d\'archiver celle-ci.', { ms: 5000 });
  }

  async restore(t) {
    await this.app.store.archiveTour(t.id, false);
    this.app.ui.toast(`« ${t.name} » restaurée`);
  }

  // Secteur CSV (voie;début;fin;côté) : nouvelle tournée, ordre de passage = ordre des lignes.
  // Fichier non fiable : taille bornée, lignes validées, affichage par textContent uniquement.
  async importSector(input) {
    const { store, ui } = this.app;
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      if (file.size > SECTOR_MAX_BYTES) throw new Error('fichier trop volumineux (512 Ko au plus)');
      const r = parseSector(await readText(file), ui.streets, this.allByStreet, ui.keys);
      const shown = r.errors.slice(0, 3).map((e) => `ligne ${e.line} : ${e.msg}`).join(' ; ');
      const errs = r.errors.length
        ? ` ${plural(r.errors.length, 'ligne ignorée', 'lignes ignorées')} (${shown}${r.errors.length > 3 ? ' ; …' : ''}).`
        : '';
      if (!r.ids.length) {
        ui.toast(`Import impossible : aucune ligne valide.${errs}`, { ms: 8000 });
        return;
      }
      const base = file.name.replace(/\.[^.]*$/, '').replace(/[_]+/g, ' ').trim().slice(0, 60) || 'Secteur importé';
      const name = await ui.prompt('Nom de la nouvelle tournée', base, 'Créer',
        `Secteur : ${plural(r.ids.length, 'adresse')} sur ${plural(r.streets, 'rue')}, dans l'ordre du fichier.${errs}`);
      if (!name) return;
      await store.createTour(name, this._sorted(r.ids), { order: r.order, reverse: r.reverse });
      ui.toast(`« ${name} » créée : ${plural(r.ids.length, 'adresse')} sur ${plural(r.streets, 'rue')}`, { ms: 5000 });
    } catch (err) {
      ui.toast(`Import impossible : ${err.message}`, { ms: 6000 });
    } finally {
      input.value = '';  // permet de réimporter le même fichier
    }
  }

  // ------------------------------------------------------- ordre de passage

  async moveStreet(k, dir) {
    const { ui, store } = this.app;
    const order = [...ui.order];
    const j = k + dir;
    if (j < 0 || j >= order.length) return;
    [order[k], order[j]] = [order[j], order[k]];
    this._focus = { s: order[j], act: dir < 0 ? 'up' : 'down' };
    await store.updateTour(this.tour.id, { order: order.map((s) => ui.keys.key[s]) });
  }

  async toggleReverse(s) {
    const { ui, store } = this.app;
    const key = ui.keys.key[s];
    const rev = new Set(this.tour.reverse || []);
    if (rev.has(key)) rev.delete(key);
    else rev.add(key);
    this._focus = { s, act: 'rev' };
    await store.updateTour(this.tour.id, { reverse: [...rev] });
  }

  async resetOrder() {
    const { ui, store } = this.app;
    if (!(await ui.confirm('Remettre les rues dans l\'ordre alphabétique, numéros croissants ?', 'Réinitialiser'))) return;
    await store.updateTour(this.tour.id, { order: [], reverse: [] });
  }

  async addGaps(ids) {
    await this.setIds([...this.tour.ids, ...ids]);
    this.app.ui.toast(`${plural(ids.length, 'numéro ajouté', 'numéros ajoutés')} à la tournée`);
  }

  // ------------------------------------------------ réglages de l'estimation

  _bindSettings() {
    const fields = { sec: $('set-sec'), kmh: $('set-kmh') };
    const show = (v) => String(v).replace('.', ',');
    const w = workloadSettings();
    for (const [k, input] of Object.entries(fields)) {
      input.value = show(w[k]);
      input.addEventListener('input', () => {
        const raw = input.value.trim().replace(',', '.');
        const v = raw === '' ? NaN : Number(raw);
        const ok = validSetting(k, v);
        input.setAttribute('aria-invalid', String(!ok));
        if (!ok) return;
        saveWorkloadSettings({ ...workloadSettings(), [k]: v });
        this.renderActive();
      });
      input.addEventListener('blur', () => {  // valeur invalide abandonnée : on réaffiche la valeur en vigueur
        input.value = show(workloadSettings()[k]);
        input.removeAttribute('aria-invalid');
      });
    }
  }

  // ------------------------------------------------- éditeur de rue

  _bindEditor() {
    const page = $('street-editor');
    const update = () => this._preview();
    for (const r of page.querySelectorAll('input[name="se-side"]')) r.addEventListener('change', update);
    $('se-from').addEventListener('input', update);
    $('se-to').addEventListener('input', update);
    $('se-add').addEventListener('click', () => this._applyEditor(true));
    $('se-remove').addEventListener('click', () => this._applyEditor(false));
    $('se-map').addEventListener('click', () => showStreet(this.app, this.editing));
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
    this.app.panel.push($('view-prepare'), 'street');
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
    if (!n) return;
    await this.setIds(ids);
    this._preview();
    this.app.ui.toast(`${name} : ${n} ${agree(n, 'numéro')} ${agree(n, add ? 'ajouté' : 'retiré')}`);
  }

  // ------------------------------------------------ composition sur la carte

  startSelect() {
    const { map, ui, panel } = this.app;
    this.selecting = true;
    $('app').dataset.mode = 'select';
    ui.closeSheet();
    map.selectAddress(null);
    map.selecting = true;
    ui.tapOverride = (a) => this.toggle(a);
    this._updateSelectCount();
    panel.push($('view-prepare'), 'select');
    panel.setDetent('peek');
    ui.updatePadding();
    map.fitAll();
  }

  // showView : revenir à la page principale de Préparer (false : l'onglet a changé)
  stopSelect(showView = true) {
    const { map, ui, panel } = this.app;
    this.selecting = false;
    delete $('app').dataset.mode;
    map.selecting = false;
    ui.tapOverride = null;
    panel.reset($('view-prepare'));
    if (showView && this.app.tabs.current === 'prepare') {
      panel.setDetent('medium');
      this.render();
    }
    this.app.distribute?.render();
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
