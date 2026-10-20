// Barre d'onglets Préparer / Distribuer / Contrôler : un seul niveau de navigation, au pouce.
// La carte reste en place sous les vues Préparer et Contrôler (taille, position GPS, suivi).

const $ = (id) => document.getElementById(id);
const KEY = 'neyron-tournees.tab';  // origine partagée : clé préfixée
export const TABS = ['prepare', 'distribute', 'control'];
const VIEWS = { prepare: 'view-prepare', control: 'view-control' };

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
  constructor({ ui }) {
    this.ui = ui;
    this.current = null;
    this.listeners = [];
    this.buttons = [...document.querySelectorAll('#tabbar [data-tab]')];
    for (const b of this.buttons) b.addEventListener('click', () => this.select(b.dataset.tab));
    // « Rues » (barre du haut) depuis un autre onglet : retour à la carte, légende ouverte
    document.addEventListener('click', (e) => {
      if (this.current === 'distribute' || !e.target.closest?.('#btn-legend')) return;
      e.stopPropagation();
      this.select('distribute');
      ui.setLegendOpen(true);
    }, true);
    this.select(readTab());
  }

  select(tab) {
    if (!TABS.includes(tab)) tab = 'distribute';
    if (tab === this.current) return;
    const prev = this.current;
    this.current = tab;
    $('app').dataset.tab = tab;
    for (const b of this.buttons) {
      if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    for (const [t, id] of Object.entries(VIEWS)) $(id).hidden = t !== tab;
    this.ui.setMenuOpen(false);
    if (prev === 'distribute') {
      this.ui.closeSheet();
      this.ui.map.mark(null);
    }
    if (tab === 'distribute') this.ui.updatePadding();
    saveTab(tab);
    for (const fn of this.listeners) fn(tab, prev);
  }

  onChange(fn) {
    this.listeners.push(fn);
  }
}
