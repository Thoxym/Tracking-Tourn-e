// Interface autour du plan : rues de la tournée et progression, pointage, annulation, barre d'échelle, thème,
// fiche d'adresse (page de la feuille), toasts, alertes, choix du motif (feuille d'actions).

import {
  REASONS, ST_AGAIN, ST_ANOMALY, ST_DONE, ST_TODO, TAGS, TAG_NOTE_MAX, isTreated, reasonLabel, tagLabel,
} from './store.js';
import { sequence, streetKeys, streetOrder } from './tourplan.js';
import { anomalyCount, fold, setAnomalyCount } from './views/common.js';

const $ = (id) => document.getElementById(id);
const THEME_KEY = 'neyron-tournees.theme';  // préférence par appareil (lue avant affichage par theme-init.js)
const THEMES = ['auto', 'light', 'dark'];
const THEME_LABELS = { auto: 'automatique', light: 'clair', dark: 'sombre' };
export const STATUS_LABELS = { [ST_TODO]: 'à faire', [ST_DONE]: 'distribué', [ST_AGAIN]: 'à repasser', [ST_ANOMALY]: 'anomalie' };
// « distribué », « anomalie (boîte absente) »
export const statusText = (st, why) => (st === ST_ANOMALY ? `anomalie (${reasonLabel(why).toLowerCase()})` : STATUS_LABELS[st]);
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
const SVGNS = 'http://www.w3.org/2000/svg';

export function addressLabel(a, streets) {
  return `${a.n}${a.rep ? ` ${a.rep}` : ''} ${streets[a.s].label}`;
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
  constructor(map, data, store, panel) {
    this.map = map;
    this.data = data;
    this.store = store;
    this.panel = panel;
    this.streets = data.streets;
    this.byStreet = this.streets.map(() => []);  // adresses de la tournée active, par rue (_applyTour)
    this.keys = streetKeys(data.addresses, this.streets.length);
    this.order = [];  // rues de la tournée active dans l'ordre de passage
    this.sheetListeners = [];
    this.tapOverride = null;  // composition sur la carte (Préparer) : le tap ajoute / retire au lieu de pointer
    this.pointOverride = null;  // point à placer sur le plan (itinéraire) : le tap donne la position
    this._buildLegend();
    this._applyTour();
    this._initTheme();
    this._bindControls();
    this._bindMap();
    panel.onChange(() => this.updatePadding());
    store.onChange((d) => {
      if (d && (d.type === 'tour' || d.type === 'import')) this._applyTour(d.change?.includes('active'));
      this.refresh();
    });
    this.refresh();
  }

  // tournée active : périmètre de la carte, rues de la légende dans l'ordre de passage, comptes
  // (refit à chaque changement de tournée)
  _applyTour(refit = false) {
    const tour = this.store.activeTour;
    this.map.setScope(tour ? tour.ids : []);
    this.byStreet = this.streets.map((_, i) => this.map.pointable.filter((a) => a.s === i && this.map.inScope(a)));
    this.order = tour ? streetOrder(tour, this.byStreet, this.keys) : [];
    $('dist-title').textContent = tour ? tour.name : 'Tournée';
    $('legend-list').append(...this.order.map((i) => this.legendRows[i]),
      ...this.legendRows.filter((_, i) => !this.byStreet[i].length));
    this.filterLegend($('legend-search').value);
    if (refit && this.map._ready) {
      this.selectStreet(null);
      this.map.fitAll();
    }
  }

  // adresses de la tournée active dans l'ordre de passage, par rue : [{s, addrs}]
  sequence() {
    return sequence(this.store.activeTour, this.byStreet, this.keys);
  }

  // adresses de la tournée active dans l'ordre de visite : l'itinéraire s'il est calculé, sinon l'ordre des rues.
  // Une adresse ajoutée depuis le calcul suit, dans l'ordre des rues ; une adresse retirée est ignorée.
  visitOrder() {
    const seq = this.sequence().flatMap((g) => g.addrs);
    const stops = this.store.activeTour?.route?.stops;
    if (!stops?.length) return seq;
    const inTour = new Map(seq.map((a) => [a.id, a]));
    const seen = new Set();
    const out = [];
    for (const st of stops) {
      for (const id of st.ids) {
        const a = inTour.get(id);
        if (a && !seen.has(id)) {
          seen.add(id);
          out.push(a);
        }
      }
    }
    for (const a of seq) if (!seen.has(a.id)) out.push(a);
    return out;
  }

  // ordre de visite regroupé par rue consécutive : [{s, addrs}] (rapport, estimation)
  visitGroups() {
    const out = [];
    for (const a of this.visitOrder()) {
      const last = out[out.length - 1];
      if (last && last.s === a.s) last.addrs.push(a);
      else out.push({ s: a.s, addrs: [a] });
    }
    return out;
  }

  // ------------------------------------------------------- progression

  refresh() {
    const status = (id) => this.store.status(id);
    this.map.applyStatuses(status);
    let treated = 0;
    let total = 0;
    this.byStreet.forEach((addrs, i) => {
      const n = addrs.length;
      const d = addrs.filter((a) => status(a.id) === ST_DONE).length;
      const again = addrs.filter((a) => status(a.id) === ST_AGAIN).length;
      const anom = addrs.filter((a) => status(a.id) === ST_ANOMALY).length;
      treated += d + anom;
      total += n;
      const row = this.legendRows[i];
      row.querySelector('.lg-count').firstChild.textContent = `${d}/${n}`;
      const ag = row.querySelector('.lg-again');
      ag.textContent = again ? `${again} ↻` : '';
      ag.title = again ? `${again} à repasser` : '';
      setAnomalyCount(row.querySelector('.lg-anom'), anom);
      row.querySelector('.lg-bar > span').style.width = `${n ? (100 * d) / n : 0}%`;
      row.classList.toggle('complete', n > 0 && d + anom === n);  // rue entièrement traitée
      row.querySelector('.lg-all').disabled = d + anom === n;
    });
    $('total-progress').textContent = `${treated}/${total}`;
    $('btn-undo').disabled = !this.store.canUndo();
    if (this.sheetAddress) {
      this._fillSheet(this.sheetAddress);
      this.panel.layout();
    }
  }

  async setStatus(ids, st, why = null) {
    try {
      return await this.store.setStatus(ids, st, why);
    } catch (err) {
      this.toast(`Enregistrement impossible : ${err.message}`, { ms: 6000 });
      return null;
    }
  }

  async markAddress(a, st, why = null) {
    const action = await this.setStatus([a.id], st, why);
    this.closeSheet();
    if (action) this.toast(`${addressLabel(a, this.streets)} : ${statusText(st, why)}`, { undo: true });
    return action;
  }

  // anomalie : motif choisi dans la liste fermée (un toucher), puis enregistrée
  async markAnomaly(a) {
    const why = await this.pickReason(a);
    return why ? this.markAddress(a, ST_ANOMALY, why) : null;
  }

  // numéros restants de la rue (à faire, à repasser) distribués ; les anomalies restent
  async markStreet(i) {
    const left = this.byStreet[i].filter((a) => !isTreated(this.store.status(a.id)));
    if (!left.length) return null;
    const again = left.filter((a) => this.store.status(a.id) === ST_AGAIN).length;
    const anom = this.byStreet[i].filter((a) => this.store.status(a.id) === ST_ANOMALY).length;
    const name = this.streets[i].label;
    const msg = `Marquer ${left.length === 1 ? 'le numéro restant' : `les ${left.length} numéros restants`} de « ${name} » comme distribués ?`
      + (again ? ` (dont ${again} à repasser)` : '')
      + (anom ? ` ${anom === 1 ? 'L\'anomalie signalée est conservée' : `Les ${anom} anomalies signalées sont conservées`}.` : '');
    if (!(await this.confirm(msg, 'Toute la rue distribuée'))) return null;
    const action = await this.setStatus(left.map((a) => a.id), ST_DONE);
    const k = action ? action.ids.length : 0;
    if (action) this.toast(`${name} : ${k} numéro${k > 1 ? 's' : ''} distribué${k > 1 ? 's' : ''}`, { undo: true });
    return action;
  }

  describe(action) {
    const addrs = action.ids.map((id) => this.map.byId.get(id)).filter(Boolean);
    const what = addrs.length === 1
      ? addressLabel(addrs[0], this.streets)
      : `${[...new Set(addrs.map((a) => this.streets[a.s].label))].join(', ')}, ${addrs.length} numéros`;
    return `${what} (${statusText(action.st, action.why)})`;
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
    $('theme-label').textContent = THEME_LABELS[pref];
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
      input.setAttribute('aria-label', `Afficher ${st.label}`);
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
      name.textContent = st.label;
      name.addEventListener('click', () => this.selectStreet(this.map.selectedStreet === i ? null : i));

      const count = document.createElement('span');
      count.className = 'lg-count';
      count.append(document.createTextNode(''));
      const again = document.createElement('span');
      again.className = 'lg-again';
      count.append(again, anomalyCount('lg-anom'));

      const bar = document.createElement('div');
      bar.className = 'lg-bar';
      bar.append(document.createElement('span'));

      const all = document.createElement('button');
      all.type = 'button';
      all.className = 'lg-all';
      all.title = 'Toute la rue distribuée';
      all.setAttribute('aria-label', `Toute la rue distribuée : ${st.label}`);
      all.append(icon(['M2 12.5l4.5 4.5L16 7.5', 'M9 16.5l.5.5L19 7.5']));
      all.addEventListener('click', () => this.markStreet(i));

      li.append(check, name, count, bar, all);
      li.dataset.key = fold(st.label);
      list.append(li);
      return li;
    });
    $('legend-search').addEventListener('input', (e) => this.filterLegend(e.target.value));
  }

  // rues de la tournée active correspondant à la recherche
  filterLegend(query) {
    const q = fold(query.trim());
    let shown = 0;
    this.legendRows.forEach((li, i) => {
      li.hidden = !this.byStreet[i].length || (Boolean(q) && !li.dataset.key.includes(q));
      shown += li.hidden ? 0 : 1;
    });
    const empty = !this.byStreet.some((addrs) => addrs.length);
    $('legend-empty').textContent = empty ? 'Tournée vide : composez-la dans l\'onglet Préparer.' : 'Aucune rue ne correspond.';
    $('legend-empty').hidden = shown > 0;
  }

  setMenuOpen(open) {
    $('menu').hidden = !open;
    $('btn-menu').setAttribute('aria-expanded', String(open));
  }

  setVersions({ app, data }) {
    $('menu-version').textContent = `Tournées de Neyron v0.1 · app ${app || '?'} · données ${data || '?'}`;
  }

  // zones couvertes par l'interface, pour que les cadrages ne passent pas dessous : les boutons du haut, la
  // feuille (en bas au téléphone, à gauche sur grand écran)
  updatePadding() {
    const r = this.map.container.getBoundingClientRect();
    // navigation : sous le bandeau de consigne (et la capsule de simulation), sinon sous le bouton Annuler
    const bottoms = ['btn-undo', 'nav-banner', 'sim-bar'].map((id) => $(id))
      .filter((el) => !el.hidden && el.offsetParent !== null).map((el) => el.getBoundingClientRect().bottom);
    const top = Math.max(0, Math.max(...bottoms) - r.top);
    this.map.setPadding({ top, left: this.panel.coveredLeft(), right: 0, bottom: this.panel.covered() });
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
      if (!this.panel.desktop && this.panel.detent !== 'peek') this.panel.setDetent('peek');  // dégager la carte
    }
    this.updatePadding();
    this.map.selectStreet(i);
    this.legendRows.forEach((row, j) => row.classList.toggle('sel', j === i));
  }

  // ----------------------------------------------------------- contrôles

  _bindControls() {
    $('btn-theme').addEventListener('click', () => this.cycleTheme());
    $('btn-menu').addEventListener('click', () => this.setMenuOpen($('menu').hidden));
    $('menu').addEventListener('click', (e) => {
      if (e.target.closest('.menu-item') && e.target.closest('.menu-item').id !== 'btn-theme') this.setMenuOpen(false);
    });
    $('import-file').addEventListener('change', () => this.setMenuOpen(false));
    document.addEventListener('pointerdown', (e) => {
      if (!$('menu').hidden && !e.target.closest('#menu, #btn-menu')) this.setMenuOpen(false);
    }, true);
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
      b.addEventListener('click', () => {
        const a = this.sheetAddress;
        if (!a) return;
        if (b.dataset.st === ST_ANOMALY) this.markAnomaly(a);
        else this.markAddress(a, b.dataset.st);
      });
    }
    this._buildReasons();
    this._buildTags();
    $('btn-sheet-tag').addEventListener('click', () => { if (this.sheetAddress) this.editTags(this.sheetAddress); });
    this.store.onChange((d) => { if (d?.type === 'tags' && this.sheetAddress) this._fillSheet(this.sheetAddress); });
    $('toast-action').addEventListener('click', () => {
      $('toast').hidden = true;
      const action = this._toastAction;
      this._toastAction = null;
      if (action) action.run();
    });
    window.addEventListener('keydown', (e) => {
      const typing = e.target.closest?.('input, textarea');  // Ctrl+Z dans la recherche : annule la saisie
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey && !typing) {
        e.preventDefault();
        this.undo();
        return;
      }
      if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;  // un dialogue gère Échap lui-même
      const page = this.panel.view && this.panel.page();
      if (!$('menu').hidden) this.setMenuOpen(false);
      else if (!$('sheet').hidden) this.closeSheet();
      else if (page && page.querySelector('[data-back]')) this.panel.back(this.panel.view);
      else if (this.map.selectedStreet != null) this.selectStreet(null);
    });
    window.addEventListener('resize', () => this.updatePadding());
  }

  _bindMap() {
    this.map.on('view', () => {
      this._updateScale();
      // échelle affichée pendant et juste après un changement de vue, comme dans Plans
      const bar = $('scalebar');
      bar.classList.add('show');
      clearTimeout(this._scaleTimer);
      this._scaleTimer = setTimeout(() => bar.classList.remove('show'), 1600);
    });
    this.map.on('tap', ({ address, world }) => {
      if (this.pointOverride) {  // point à placer sur le plan (départ, arrivée de l'itinéraire)
        if (world) this.pointOverride({ x: world[0] ?? world.x, y: world[1] ?? world.y });
        return;
      }
      if (this.tapOverride) {
        if (address) this.tapOverride(address);
        return;
      }
      this.map.mark(null);
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
    $('sheet-sub').textContent = [this.streets[a.s].commune, a.ld, `côté ${a.side}`].filter(Boolean).join(' · ');
    const badge = $('sheet-status');
    badge.textContent = st === ST_ANOMALY ? `anomalie : ${reasonLabel(this.store.reason(a.id)).toLowerCase()}` : STATUS_LABELS[st];
    badge.className = `badge st-${st}`;
    // seules les actions qui changent le statut sont proposées (anomalie : toujours, pour changer de motif)
    for (const b of $('sheet-actions').querySelectorAll('.act')) b.hidden = b.dataset.st === st && st !== ST_ANOMALY;
    const tags = this.tagText(a.id);
    $('sheet-tags').hidden = !tags;
    $('sheet-tags').textContent = tags;
    $('btn-sheet-tag').setAttribute('aria-pressed', String(Boolean(tags)));
    $('btn-sheet-tag').setAttribute('aria-label', tags ? 'Modifier le repère' : 'Ajouter un repère');
  }

  // ------------------------------------------------------------ repères

  // « Chien · Portail ou sonnette — boîte derrière le garage », ou '' sans repère
  tagText(id) {
    const t = this.store.tagsOf(id);
    if (!t) return '';
    const labels = t.c.map(tagLabel).join(' · ');
    return [labels, t.note].filter(Boolean).join(labels && t.note ? ' — ' : '');
  }

  _buildTags() {
    const SVGNS = 'http://www.w3.org/2000/svg';
    $('tag-options').replaceChildren(...TAGS.map(({ code, label }) => {
      const l = document.createElement('label');
      l.className = 'tag-opt';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = code;
      const span = document.createElement('span');
      span.textContent = label;
      const svg = document.createElementNS(SVGNS, 'svg');
      svg.setAttribute('class', 'ico');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      const p = document.createElementNS(SVGNS, 'path');
      p.setAttribute('d', 'M5 12.5l4.5 4.5L19 7.5');
      svg.append(p);
      l.append(input, span, svg);
      return l;
    }));
    $('tag-note').maxLength = TAG_NOTE_MAX;
    // Entrée dans la note : enregistrer (sinon le premier bouton du formulaire, « Supprimer », serait déclenché)
    $('tag-note').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        $('tag-dialog').close('save');
      }
    });
  }

  // saisie du repère d'une adresse ; renvoie true s'il a changé
  editTags(a) {
    const dlg = $('tag-dialog');
    const cur = this.store.tagsOf(a.id);
    $('tag-title').textContent = addressLabel(a, this.streets);
    for (const input of $('tag-options').querySelectorAll('input')) input.checked = Boolean(cur?.c.includes(input.value));
    $('tag-note').value = cur?.note || '';
    $('tag-remove').hidden = !cur;
    dlg.returnValue = '';
    return new Promise((resolve) => {
      dlg.addEventListener('close', async () => {
        const v = dlg.returnValue;
        try {
          if (v === 'save') {
            const codes = [...$('tag-options').querySelectorAll('input:checked')].map((i) => i.value);
            await this.store.setTags(a.id, codes, $('tag-note').value);
            const now = this.tagText(a.id);
            this.toast(now ? `Repère enregistré : ${now}` : 'Repère supprimé');
            resolve(true);
          } else if (v === 'remove') {
            await this.store.setTags(a.id, [], '');
            this.toast('Repère supprimé');
            resolve(true);
          } else resolve(false);
        } catch (err) {
          this.toast(`Enregistrement impossible : ${err.message}`, { ms: 6000 });
          resolve(false);
        }
      }, { once: true });
      dlg.showModal();
    });
  }

  // ------------------------------------------------------ motif d'anomalie

  _buildReasons() {
    $('reason-list').replaceChildren(...REASONS.map(({ code, label }) => {
      const b = document.createElement('button');
      b.type = 'submit';
      b.className = 'as-btn reason';
      b.value = code;
      b.textContent = label;
      return b;
    }));
  }

  // Feuille d'actions : items [{label, value, destructive?, checked?}] ; renvoie la valeur choisie, ou null
  actionSheet(title, items, { message = '' } = {}) {
    const dlg = $('action-sheet');
    $('as-title').textContent = title;
    $('as-msg').textContent = message;
    $('as-msg').hidden = !message;
    $('as-list').replaceChildren(...items.map((it, k) => {
      const b = document.createElement('button');
      b.type = 'submit';
      b.className = `as-btn${it.destructive ? ' destructive' : ''}`;
      b.value = String(k);
      if (it.checked) b.setAttribute('aria-pressed', 'true');
      b.textContent = it.label;
      return b;
    }));
    dlg.returnValue = '';
    return new Promise((resolve) => {
      dlg.addEventListener('close', () => {
        const k = Number(dlg.returnValue);
        resolve(dlg.returnValue !== '' && Number.isInteger(k) && items[k] ? items[k].value : null);
      }, { once: true });
      dlg.showModal();
    });
  }

  // motif choisi (code) ou null si annulé ; le motif actuel est mis en avant
  pickReason(a) {
    const dlg = $('reason-dialog');
    const current = this.store.status(a.id) === ST_ANOMALY ? this.store.reason(a.id) : null;
    $('reason-title').textContent = `Anomalie · ${addressLabel(a, this.streets)}`;
    for (const b of $('reason-list').querySelectorAll('.reason')) b.setAttribute('aria-pressed', String(b.value === current));
    dlg.returnValue = '';
    return new Promise((resolve) => {
      dlg.addEventListener('close', () => {
        const v = dlg.returnValue;
        resolve(REASONS.some((r) => r.code === v) ? v : null);
      }, { once: true });
      dlg.showModal();
    });
  }

  // fiche d'adresse : page de la feuille, au petit cran, par-dessus l'onglet courant (retrouvé à la fermeture)
  openSheet(a) {
    this.map.selectAddress(a.id);
    this.sheetAddress = a;
    this._fillSheet(a);
    const sheet = $('sheet');
    if (sheet.hidden) this._sheetReturn = this.panel.view;
    this.panel.show(sheet, 'peek');
    this.updatePadding();
    this.map.ensureVisible(a.x, a.y, { bottom: this.panel.covered() });
    for (const fn of this.sheetListeners) fn(a);
  }

  // restore : revenir à l'onglet d'où la fiche a été ouverte (false : l'appelant affiche une autre vue)
  closeSheet(restore = true) {
    const sheet = $('sheet');
    const wasOpen = !sheet.hidden;
    this.map.selectAddress(null);
    this.sheetAddress = null;
    if (!wasOpen) return;
    if (restore && this._sheetReturn) this.panel.show(this._sheetReturn);
    else sheet.hidden = true;
    this._sheetReturn = null;
    for (const fn of this.sheetListeners) fn(null);
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

  // saisie d'un texte court (nom de tournée) ; null si annulé ou vide. detail : explication sous le champ
  prompt(label, value = '', okLabel = 'OK', detail = '') {
    const dlg = $('prompt');
    const input = $('prompt-input');
    $('prompt-label').textContent = label;
    $('prompt-detail').textContent = detail;
    $('prompt-detail').hidden = !detail;
    $('prompt-ok').textContent = okLabel;
    input.value = value;
    dlg.returnValue = '';
    return new Promise((resolve) => {
      const onKey = (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();  // Entrée : valider (le premier bouton du formulaire est « Annuler »)
        dlg.close('ok');
      };
      input.addEventListener('keydown', onKey);
      dlg.addEventListener('close', () => {
        input.removeEventListener('keydown', onKey);
        const v = input.value.trim();
        resolve(dlg.returnValue === 'ok' && v ? v : null);
      }, { once: true });
      dlg.showModal();
      input.select();
    });
  }

  // destructive : action irréversible (bouton rouge, comme les alertes iOS)
  confirm(message, okLabel = 'Confirmer', { destructive = false } = {}) {
    const dlg = $('confirm');
    $('confirm-msg').textContent = message;
    $('confirm-ok').textContent = okLabel;
    $('confirm-ok').classList.toggle('destructive', destructive);
    dlg.returnValue = '';
    return new Promise((resolve) => {
      dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
      dlg.showModal();
    });
  }
}
