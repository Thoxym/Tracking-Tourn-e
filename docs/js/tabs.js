// Capsule d'onglets Préparer / Distribuer / Contrôler : chaque onglet change le contenu de la feuille posée sur la
// carte (sheet.js), qui garde son cran par onglet. La carte reste visible et manipulable dans les trois.

const $ = (id) => document.getElementById(id);
const KEY = 'neyron-tournees.tab';  // origine partagée : clé préfixée
export const TABS = ['prepare', 'distribute', 'control'];
const VIEWS = { prepare: 'view-prepare', distribute: 'view-distribute', control: 'view-control' };
const DEFAULT_DETENT = { prepare: 'medium', distribute: 'peek', control: 'medium' };

function readTab() {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;  // stockage bloqué : onglet par défaut
  }
}

function saveTab(tab) {
  try {
    localStorage.setItem(KEY, tab);
  } catch { /* sans importance */ }
}

export class TabBar {
  constructor({ ui, panel }) {
    this.ui = ui;
    this.panel = panel;
    this.current = null;
    this.listeners = [];
    this.buttons = [...document.querySelectorAll('#tabbar [data-tab]')];
    for (const [tab, id] of Object.entries(VIEWS)) $(id).dataset.detent = DEFAULT_DETENT[tab];
    for (const b of this.buttons) {
      b.addEventListener('click', () => {
        if (b.dataset.tab === this.current) this._again();
        else this.select(b.dataset.tab);
      });
    }
    this.select(readTab());
  }

  view(tab = this.current) {
    return $(VIEWS[tab]);
  }

  select(tab, { detent = null } = {}) {
    if (!TABS.includes(tab)) tab = 'distribute';
    if (tab === this.current) {
      if (this.ui.sheetAddress) this.ui.closeSheet();
      if (detent) this.panel.setDetent(detent);
      return;
    }
    const prev = this.current;
    this.current = tab;
    $('app').dataset.tab = tab;
    for (const b of this.buttons) {
      if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    this.ui.setMenuOpen(false);
    if (prev) {
      this.ui.closeSheet(false);  // la fiche d'adresse appartient à l'onglet quitté
      this.ui.map.mark(null);
    }
    this.panel.show(this.view(tab), detent);
    saveTab(tab);
    for (const fn of this.listeners) fn(tab, prev);
  }

  // onglet déjà choisi touché à nouveau : retour à sa page principale (comme iOS)
  _again() {
    if (this.ui.sheetAddress) {
      this.ui.closeSheet();
      return;
    }
    this.panel.reset(this.view());
    this.ui.map.mark(null);
    for (const fn of this.listeners) fn(this.current, this.current);
  }

  onChange(fn) {
    this.listeners.push(fn);
  }
}
