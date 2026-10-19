// Interface autour du plan : légende et progression, pointage, annulation, barre d'échelle, thème,
// panneau d'adresse, toasts, confirmations.

import { ST_AGAIN, ST_DONE, ST_TODO } from './store.js';

const $ = (id) => document.getElementById(id);
const THEME_KEY = 'neyron-tournees.theme';  // préférence par appareil (lue avant affichage par theme-init.js)
const THEMES = ['auto', 'light', 'dark'];
const THEME_LABELS = { auto: 'automatique', light: 'clair', dark: 'sombre' };
export const STATUS_LABELS = { [ST_TODO]: 'à faire', [ST_DONE]: 'fait', [ST_AGAIN]: 'à repasser' };
const desktop = window.matchMedia('(min-width: 900px)');
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
const SVGNS = 'http://www.w3.org/2000/svg';

export function addressLabel(a, streets) {
  return `${a.n}${a.rep ? ` ${a.rep}` : ''} ${streets[a.s].name}`;
}

function icon(paths) {
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

export class UI {
  constructor(map, data, store) {
    this.map = map;
    this.data = data;
    this.store = store;
    this.streets = data.streets;
    this.byStreet = this.streets.map((_, i) => map.pointable.filter((a) => a.s === i));
    this.sheetListeners = [];
    this._buildLegend();
    this._initTheme();
    this._bindControls();
    this._bindMap();
    this.setLegendOpen(desktop.matches);
    store.onChange(() => this.refresh());
    this.refresh();
  }

  // ------------------------------------------------------- progression

  refresh() {
    const status = (id) => this.store.status(id);
    this.map.applyStatuses(status);
    let done = 0;
    let total = 0;
    this.byStreet.forEach((addrs, i) => {
      const n = addrs.length;
      const d = addrs.filter((a) => status(a.id) === ST_DONE).length;
      const again = addrs.filter((a) => status(a.id) === ST_AGAIN).length;
      done += d;
      total += n;
      const row = this.legendRows[i];
      row.querySelector('.lg-count').firstChild.textContent = `${d}/${n}`;
      const ag = row.querySelector('.lg-again');
      ag.textContent = again ? `${again} ↻` : '';
      ag.title = again ? `${again} à repasser` : '';
      row.querySelector('.lg-bar > span').style.width = `${n ? (100 * d) / n : 0}%`;
      row.classList.toggle('complete', n > 0 && d === n);
      row.querySelector('.lg-all').disabled = d === n;
    });
    $('total-progress').textContent = `${done}/${total}`;
    $('btn-undo').disabled = !this.store.canUndo();
    if (this.sheetAddress) this._fillSheet(this.sheetAddress);
  }

  async setStatus(ids, st) {
    try {
      return await this.store.setStatus(ids, st);
    } catch (err) {
      this.toast(`Enregistrement impossible : ${err.message}`, { ms: 6000 });
      return null;
    }
  }

  async markAddress(a, st) {
    const action = await this.setStatus([a.id], st);
    this.closeSheet();
    if (action) this.toast(`${addressLabel(a, this.streets)} : ${STATUS_LABELS[st]}`, { undo: true });
  }

  async markStreet(i) {
    const todo = this.byStreet[i].filter((a) => this.store.status(a.id) !== ST_DONE);
    if (!todo.length) return;
    const again = todo.filter((a) => this.store.status(a.id) === ST_AGAIN).length;
    const name = this.streets[i].name;
    const msg = `Marquer ${todo.length === 1 ? 'le numéro restant' : `les ${todo.length} numéros restants`} de « ${name} » comme faits ?`
      + (again ? ` (dont ${again} à repasser)` : '');
    if (!(await this.confirm(msg, 'Toute la rue faite'))) return;
    const action = await this.setStatus(todo.map((a) => a.id), ST_DONE);
    if (action) this.toast(`${name} : ${action.ids.length} numéro${action.ids.length > 1 ? 's' : ''} fait${action.ids.length > 1 ? 's' : ''}`, { undo: true });
  }

  describe(action) {
    const addrs = action.ids.map((id) => this.map.byId.get(id)).filter(Boolean);
    const what = addrs.length === 1
      ? addressLabel(addrs[0], this.streets)
      : `${[...new Set(addrs.map((a) => this.streets[a.s].name))].join(', ')}, ${addrs.length} numéros`;
    return `${what} (${STATUS_LABELS[action.st]})`;
  }

  async undo() {
    try {
      const action = await this.store.undo();
      this.toast(action ? `Annulé : ${this.describe(action)}` : 'Rien à annuler');
    } catch (err) {
      this.toast(`Annulation impossible : ${err.message}`, { ms: 6000 });
    }
  }

  // -------------------------------------------------------------- thème

  get themePref() {
    try {
      const t = localStorage.getItem(THEME_KEY);
      return THEMES.includes(t) ? t : 'auto';
    } catch {
      return 'auto';
    }
  }

  _initTheme() {
    for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.dataset.default = m.content;
    this.applyTheme(this.themePref);
    prefersDark.addEventListener('change', () => this.applyTheme(this.themePref));
  }

  isDark(pref = this.themePref) {
    return pref === 'dark' || (pref === 'auto' && prefersDark.matches);
  }

  applyTheme(pref) {
    const root = document.documentElement;
    if (pref === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', pref);
    const dark = this.isDark(pref);
    this.map.applyColors(dark);
    this.legendRows.forEach((row, i) => row.style.setProperty('--sc', this.streets[i].colors[dark ? 1 : 0]));
    const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
    for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
      m.content = pref === 'auto' ? m.dataset.default : bg;
    }
    const btn = $('btn-theme');
    btn.setAttribute('aria-label', `Thème : ${THEME_LABELS[pref]}`);
    btn.title = `Thème : ${THEME_LABELS[pref]}`;
  }

  cycleTheme() {
    const next = THEMES[(THEMES.indexOf(this.themePref) + 1) % THEMES.length];
    try {
      if (next === 'auto') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, next);
    } catch { /* stockage indisponible : le thème vaut pour la session */ }
    this.applyTheme(next);
    this.toast(`Thème ${THEME_LABELS[next]}`);
  }

  // ------------------------------------------------------------- légende

  _buildLegend() {
    const list = $('legend-list');
    this.legendRows = this.streets.map((st, i) => {
      const li = document.createElement('li');
      li.className = 'lg-row';
      li.dataset.s = i;

      const check = document.createElement('label');
      check.className = 'lg-check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = true;
      input.setAttribute('aria-label', `Afficher ${st.name}`);
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      check.append(input, swatch);
      input.addEventListener('change', () => {
        this.map.setStreetVisible(i, input.checked);
        if (!input.checked && this.map.selectedStreet === i) this.selectStreet(null);
      });

      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'lg-name';
      name.textContent = st.name;
      name.addEventListener('click', () => this.selectStreet(this.map.selectedStreet === i ? null : i));

      const count = document.createElement('span');
      count.className = 'lg-count';
      count.append(document.createTextNode(''));
      const again = document.createElement('span');
      again.className = 'lg-again';
      count.append(again);

      const bar = document.createElement('div');
      bar.className = 'lg-bar';
      bar.append(document.createElement('span'));

      const all = document.createElement('button');
      all.type = 'button';
      all.className = 'lg-all';
      all.title = 'Toute la rue faite';
      all.setAttribute('aria-label', `Toute la rue faite : ${st.name}`);
      all.append(icon(['M2 12.5l4.5 4.5L16 7.5', 'M9 16.5l.5.5L19 7.5']));
      all.addEventListener('click', () => this.markStreet(i));

      li.append(check, name, count, bar, all);
      list.append(li);
      return li;
    });
  }

  setLegendOpen(open) {
    $('legend').hidden = !open;
    $('btn-legend').setAttribute('aria-expanded', String(open));
    this.updatePadding();
  }

  // zones couvertes par l'interface, pour que les cadrages ne passent pas dessous
  updatePadding() {
    const r = this.map.container.getBoundingClientRect();
    const top = $('btn-legend').getBoundingClientRect().bottom - r.top;
    const legend = $('legend');
    const left = desktop.matches && !legend.hidden ? legend.getBoundingClientRect().right - r.left : 0;
    const nearby = $('nearby');
    const bottom = nearby.hidden ? 0 : r.bottom - nearby.getBoundingClientRect().top;
    document.getElementById('app').style.setProperty('--nearby-h', `${Math.max(0, bottom)}px`);
    this.map.setPadding({ top, left, right: 0, bottom });
  }

  onSheet(fn) {
    this.sheetListeners.push(fn);
  }

  selectStreet(i) {
    if (i != null) {
      const input = this.legendRows[i].querySelector('input');
      if (!input.checked) {
        input.checked = true;
        this.map.setStreetVisible(i, true);
      }
      if (!desktop.matches) this.setLegendOpen(false);  // mobile : la légende couvre la carte
    }
    this.updatePadding();
    this.map.selectStreet(i);
    this.legendRows.forEach((row, j) => row.classList.toggle('sel', j === i));
  }

  // ----------------------------------------------------------- contrôles

  _bindControls() {
    $('btn-legend').addEventListener('click', () => this.setLegendOpen($('legend').hidden));
    $('btn-legend-close').addEventListener('click', () => this.setLegendOpen(false));
    $('btn-theme').addEventListener('click', () => this.cycleTheme());
    $('btn-undo').addEventListener('click', () => this.undo());
    $('btn-zoom-in').addEventListener('click', () => this.map.zoomBy(1.6));
    $('btn-zoom-out').addEventListener('click', () => this.map.zoomBy(1 / 1.6));
    $('btn-fit').addEventListener('click', () => {
      this.selectStreet(null);
      this.updatePadding();
      this.map.fitAll();
    });
    $('btn-sheet-close').addEventListener('click', () => this.closeSheet());
    for (const b of $('sheet-actions').querySelectorAll('.act')) {
      b.addEventListener('click', () => this.sheetAddress && this.markAddress(this.sheetAddress, b.dataset.st));
    }
    $('toast-action').addEventListener('click', () => {
      $('toast').hidden = true;
      const action = this._toastAction;
      this._toastAction = null;
      if (action) action.run();
    });
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        this.undo();
        return;
      }
      if (e.key !== 'Escape' || $('confirm').open) return;
      if (!$('sheet').hidden) this.closeSheet();
      else if (!$('legend').hidden && !desktop.matches) this.setLegendOpen(false);
      else if (this.map.selectedStreet != null) this.selectStreet(null);
    });
    desktop.addEventListener('change', () => this.setLegendOpen(desktop.matches));
    window.addEventListener('resize', () => this.updatePadding());
  }

  _bindMap() {
    this.map.on('view', () => this._updateScale());
    this.map.on('tap', ({ address }) => {
      if (address) this.openSheet(address);
      else this.closeSheet();
    });
    this.map.on('ready', () => this.updatePadding());
  }

  _updateScale() {
    const k = this.map.k;
    const maxM = 110 / k;
    const p = 10 ** Math.floor(Math.log10(maxM));
    const nice = [5, 2, 1].map((f) => f * p).find((v) => v <= maxM) || p;
    const bar = document.querySelector('.scalebar-bar');
    bar.style.width = `${Math.round(nice * k)}px`;
    document.querySelector('.scalebar-label').textContent = nice >= 1000 ? `${nice / 1000} km` : `${nice} m`;
  }

  // ------------------------------------------------------ panneau adresse

  _fillSheet(a) {
    const st = this.store.status(a.id);
    $('sheet-title').textContent = addressLabel(a, this.streets);
    $('sheet-sub').textContent = [a.ld, `côté ${a.side}`].filter(Boolean).join(' · ');
    const badge = $('sheet-status');
    badge.textContent = STATUS_LABELS[st];
    badge.className = `badge st-${st}`;
    // seules les actions qui changent le statut sont proposées
    for (const b of $('sheet-actions').querySelectorAll('.act')) b.hidden = b.dataset.st === st;
  }

  openSheet(a) {
    this.map.selectAddress(a.id);
    this.sheetAddress = a;
    this._fillSheet(a);
    const sheet = $('sheet');
    sheet.hidden = false;
    const covered = this.map.container.clientHeight - sheet.offsetTop;  // offsetTop : hors animation d'entrée
    this.map.ensureVisible(a.x, a.y, { bottom: covered });
    for (const fn of this.sheetListeners) fn(a);
  }

  closeSheet() {
    const wasOpen = !$('sheet').hidden;
    $('sheet').hidden = true;
    this.map.selectAddress(null);
    this.sheetAddress = null;
    if (wasOpen) for (const fn of this.sheetListeners) fn(null);
  }

  // ---------------------------------------------------- toast, confirmation

  // action : {label, run} ; undo: true est un raccourci pour l'action « Annuler »
  toast(msg, { undo = false, action = null, ms } = {}) {
    if (undo) action = { label: 'Annuler', run: () => this.undo() };
    const t = $('toast');
    $('toast-msg').textContent = msg;
    const btn = $('toast-action');
    btn.hidden = !action;
    if (action) btn.textContent = action.label;
    this._toastAction = action;
    ms ??= action ? 5000 : 2200;
    t.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  confirm(message, okLabel = 'Confirmer') {
    const dlg = $('confirm');
    $('confirm-msg').textContent = message;
    $('confirm-ok').textContent = okLabel;
    dlg.returnValue = '';
    return new Promise((resolve) => {
      dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
      dlg.showModal();
    });
  }
}
