// Onglet Préparer (squelette, phase L1) : la tournée en cours et ses rues ; une rue s'ouvre sur la carte.
// À venir : choix des rues de la commune, composition et ordre de la tournée, charge, adresses manquantes.

import { fold, plural, showStreet, streetRow } from './common.js';

const $ = (id) => document.getElementById(id);

export class PrepareView {
  constructor(app) {
    this.app = app;
    this.query = '';
    $('prep-search').addEventListener('input', (e) => { this.query = fold(e.target.value.trim()); this.render(); });
    app.tabs.onChange((tab) => { if (tab === 'prepare') this.render(); });
    if (app.tabs.current === 'prepare') this.render();
  }

  render() {
    const { ui, store } = this.app;
    const dark = ui.isDark();
    const total = ui.byStreet.reduce((n, addrs) => n + addrs.length, 0);
    const tour = store.tours.find((t) => t.id === store.tour);
    $('prep-summary').textContent = `${tour ? tour.name : 'Tournée'} · ${plural(ui.streets.length, 'rue')} · ${plural(total, 'adresse')}`;
    const rows = [];
    ui.byStreet.forEach((addrs, i) => {
      if (this.query && !fold(ui.streets[i].name).includes(this.query)) return;
      const even = addrs.filter((a) => a.side === 'pair').length;
      rows.push(streetRow({
        color: ui.streets[i].colors[dark ? 1 : 0],
        name: ui.streets[i].name,
        sub: `${even} pair${even > 1 ? 's' : ''} · ${addrs.length - even} impair${addrs.length - even > 1 ? 's' : ''}`,
        count: plural(addrs.length, 'numéro'),
        onClick: () => showStreet(this.app, i),
      }));
    });
    $('prep-streets').replaceChildren(...rows);
    $('prep-empty').hidden = rows.length > 0;
  }
}
