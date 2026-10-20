// Onglet Contrôler : bilan de la tournée (distribuées, restantes, à repasser, anomalies, temps restant estimé),
// détail par rue dans l'ordre de passage, export. À venir (L6) : anomalies par motif, adresses non traitées,
// clôture, rapport CSV.

import { ST_AGAIN, ST_ANOMALY, ST_DONE, isTreated } from '../store.js';
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
    let anom = 0;
    let total = 0;
    const rows = [];
    for (const i of ui.order) {  // rues de la tournée active, dans l'ordre de passage
      const addrs = ui.byStreet[i];
      const by = (st) => addrs.filter((a) => store.status(a.id) === st).length;
      const d = by(ST_DONE);
      const ag = by(ST_AGAIN);
      const an = by(ST_ANOMALY);
      done += d;
      again += ag;
      anom += an;
      total += addrs.length;
      const todo = addrs.length - d - ag - an;
      rows.push(streetRow({
        color: ui.streets[i].colors[dark ? 1 : 0],
        name: ui.streets[i].name,
        sub: d + an === addrs.length ? 'rue entière traitée' : `${todo} restante${todo > 1 ? 's' : ''}`,
        count: `${d}/${addrs.length}`,
        again: ag,
        anomalies: an,
        complete: d + an === addrs.length,
        onClick: () => showStreet(this.app, i),
      }));
    }
    $('ctl-streets').replaceChildren(...rows);
    $('ctl-empty').hidden = rows.length > 0;
    $('ctl-done').textContent = String(done);
    $('ctl-todo').textContent = String(total - done - again - anom);
    $('ctl-again').textContent = String(again);
    $('ctl-anom').textContent = String(anom);
    const treated = done + anom;
    const pct = total ? Math.round((100 * treated) / total) : 0;
    $('ctl-bar').style.width = `${pct}%`;
    $('ctl-summary').textContent = `${treated} / ${total} adresses traitées · ${pct} %`;
    // reste : adresses non traitées (à repasser comprises), dans l'ordre de passage
    const left = workload(ui.sequence().map((g) => ({ ...g, addrs: g.addrs.filter((a) => !isTreated(store.status(a.id))) })),
      workloadSettings());
    $('ctl-left').hidden = !total;
    $('ctl-left').textContent = left.addresses
      ? `Reste ≈ ${formatDuration(left.seconds)} · ${formatDistance(left.meters)} (estimation)`
      : 'Toutes les adresses sont traitées.';
  }
}
