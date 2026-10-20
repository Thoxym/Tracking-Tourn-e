// Onglet Contrôler (squelette, phase L1) : bilan de la tournée (faites, restantes, à repasser), détail par rue,
// export. À venir : motifs d'anomalie, adresses non traitées, clôture de tournée, rapport CSV.

import { ST_AGAIN, ST_DONE } from '../store.js';
import { showStreet, streetRow } from './common.js';

const $ = (id) => document.getElementById(id);

export class ControlView {
  constructor(app) {
    this.app = app;
    app.tabs.onChange((tab) => { if (tab === 'control') this.render(); });
    app.store.onChange(() => { if (app.tabs.current === 'control') this.render(); });
    // export synchrone jusqu'à la feuille de partage : appelé directement dans le geste
    $('ctl-export').addEventListener('click', () => app.backup.exportNow());
    if (app.tabs.current === 'control') this.render();
  }

  render() {
    const { ui, store } = this.app;
    const dark = ui.isDark();
    let done = 0;
    let again = 0;
    let total = 0;
    const rows = ui.byStreet.map((addrs, i) => {
      const d = addrs.filter((a) => store.status(a.id) === ST_DONE).length;
      const ag = addrs.filter((a) => store.status(a.id) === ST_AGAIN).length;
      done += d;
      again += ag;
      total += addrs.length;
      const left = addrs.length - d - ag;
      return streetRow({
        color: ui.streets[i].colors[dark ? 1 : 0],
        name: ui.streets[i].name,
        sub: d === addrs.length ? 'rue entière faite' : `${left} restante${left > 1 ? 's' : ''}`,
        count: `${d}/${addrs.length}`,
        again: ag,
        complete: d === addrs.length,
        onClick: () => showStreet(this.app, i),
      });
    });
    $('ctl-streets').replaceChildren(...rows);
    $('ctl-done').textContent = String(done);
    $('ctl-todo').textContent = String(total - done - again);
    $('ctl-again').textContent = String(again);
    const pct = total ? Math.round((100 * done) / total) : 0;
    $('ctl-bar').style.width = `${pct}%`;
    $('ctl-summary').textContent = `${done} / ${total} adresses faites · ${pct} %`;
  }
}
