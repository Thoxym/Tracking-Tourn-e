// Onglet Contrôler : bilan de la tournée (faites, restantes, à repasser, temps restant estimé), détail par rue
// dans l'ordre de passage, export. À venir (L6) : motifs d'anomalie, adresses non traitées, clôture, rapport CSV.

import { ST_AGAIN, ST_DONE } from '../store.js';
import { formatDistance, formatDuration, workload, workloadSettings } from '../tourplan.js';
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
    $('ctl-title').textContent = `Bilan · ${store.activeTour.name}`;
    let done = 0;
    let again = 0;
    let total = 0;
    const rows = [];
    for (const i of ui.order) {  // rues de la tournée active, dans l'ordre de passage
      const addrs = ui.byStreet[i];
      const d = addrs.filter((a) => store.status(a.id) === ST_DONE).length;
      const ag = addrs.filter((a) => store.status(a.id) === ST_AGAIN).length;
      done += d;
      again += ag;
      total += addrs.length;
      const left = addrs.length - d - ag;
      rows.push(streetRow({
        color: ui.streets[i].colors[dark ? 1 : 0],
        name: ui.streets[i].name,
        sub: d === addrs.length ? 'rue entière faite' : `${left} restante${left > 1 ? 's' : ''}`,
        count: `${d}/${addrs.length}`,
        again: ag,
        complete: d === addrs.length,
        onClick: () => showStreet(this.app, i),
      }));
    }
    $('ctl-streets').replaceChildren(...rows);
    $('ctl-empty').hidden = rows.length > 0;
    $('ctl-done').textContent = String(done);
    $('ctl-todo').textContent = String(total - done - again);
    $('ctl-again').textContent = String(again);
    const pct = total ? Math.round((100 * done) / total) : 0;
    $('ctl-bar').style.width = `${pct}%`;
    $('ctl-summary').textContent = `${done} / ${total} adresses faites · ${pct} %`;
    // reste : adresses non faites (à repasser comprises), dans l'ordre de passage
    const left = workload(ui.sequence().map((g) => ({ ...g, addrs: g.addrs.filter((a) => store.status(a.id) !== ST_DONE) })),
      workloadSettings());
    $('ctl-left').hidden = !total;
    $('ctl-left').textContent = left.addresses
      ? `Reste ≈ ${formatDuration(left.seconds)} · ${formatDistance(left.meters)} (estimation)`
      : 'Toutes les adresses sont faites.';
  }
}
