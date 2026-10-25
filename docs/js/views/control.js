// Onglet Contrôler : bilan du passage en cours (anneau de progression, distribuées, restantes, à repasser,
// anomalies, temps restant estimé), puis des pages de la feuille : détail par rue dans l'ordre de passage,
// anomalies par motif, adresses non traitées, passages clôturés. Rapport CSV / JSON, clôture du passage.

import { REASONS, ST_AGAIN, ST_ANOMALY, ST_DONE, isTreated, reasonLabel } from '../store.js';
import { reportCsv, reportJson } from '../report.js';
import { formatDistance, formatDuration, workload, workloadSettings } from '../tourplan.js';
import { STATUS_LABELS, addressLabel } from '../ui.js';
import { guard, plural, showAddress, showStreet, streetRow } from './common.js';

const $ = (id) => document.getElementById(id);
const HOURS_KEY = 'neyron-tournees.report-hours';  // préférence d'appareil : heures dans le rapport
const date = (t) => new Date(t).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const agree = (n, word) => `${word}${n > 1 ? 's' : ''}`;
const RING = 2 * Math.PI * 27;  // circonférence de l'anneau (r = 27 dans le SVG)

export class ControlView {
  constructor(app) {
    this.app = app;
    guard(this, ['closePassage', 'reopen']);
    app.tabs.onChange((tab) => { if (tab === 'control') this.render(); });
    app.store.onChange(() => { if (app.tabs.current === 'control') this.render(); });
    // exports synchrones jusqu'à la feuille de partage : appelés directement dans le geste
    $('ctl-csv').addEventListener('click', () => this.exportReport('csv'));
    $('ctl-json').addEventListener('click', () => this.exportReport('json'));
    $('ctl-close').addEventListener('click', () => this.closePassage());
    let hours = false;
    try {
      hours = localStorage.getItem(HOURS_KEY) === '1';
    } catch { /* stockage indisponible : sans heures */ }
    $('ctl-hours').checked = hours;
    $('ctl-hours').addEventListener('change', (e) => {
      try {
        if (e.target.checked) localStorage.setItem(HOURS_KEY, '1');
        else localStorage.removeItem(HOURS_KEY);
      } catch { /* idem */ }
    });
    if (app.tabs.current === 'control') this.render();
  }

  render() {
    const { ui, store } = this.app;
    const dark = ui.isDark();
    const tour = store.activeTour;
    const start = store.passageStart();
    $('ctl-title').textContent = `Bilan · ${tour.name}`;
    $('ctl-passage').textContent = start ? `Passage en cours depuis le ${date(start)}` : 'Premier passage';
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
    $('ctl-ring').style.strokeDashoffset = String(RING * (1 - (total ? treated / total : 0)));
    $('ctl-pct').textContent = `${pct} %`;
    $('ctl-summary').textContent = `${treated} / ${total} adresses traitées`;
    // reste : adresses non traitées (à repasser comprises), dans l'ordre de passage
    const seq = ui.sequence();
    const left = workload(seq.map((g) => ({ ...g, addrs: g.addrs.filter((a) => !isTreated(store.status(a.id))) })),
      workloadSettings());
    // itinéraire calculé : reste = arrêts qui ont encore une adresse non traitée (trajet + part du service)
    const stops = tour.route?.stops;
    let routeLeft = null;
    if (stops?.length) {
      routeLeft = 0;
      for (const st of stops) {
        const n = st.ids.filter((id) => !isTreated(store.status(id))).length;
        if (n) routeLeft += st.legSec + (st.service * n) / st.ids.length;
      }
    }
    $('ctl-left').hidden = !total;
    $('ctl-left').textContent = !left.addresses ? 'Toutes les adresses sont traitées.'
      : routeLeft !== null ? `Reste ≈ ${formatDuration(routeLeft)} (itinéraire)`
        : `Reste ≈ ${formatDuration(left.seconds)} · ${formatDistance(left.meters)} (estimation)`;
    const all = ui.visitOrder();
    this.renderAnomalies(all);
    this.renderUntreated(all);
    this.renderHistory(tour);
    $('ctl-csv').disabled = $('ctl-json').disabled = !total;
    $('ctl-close').disabled = !store.events.length;  // rien de pointé dans ce passage : rien à clôturer
  }

  // anomalies par motif (barres), puis la liste des adresses concernées
  renderAnomalies(all) {
    const { ui, store } = this.app;
    const list = all.filter((a) => store.status(a.id) === ST_ANOMALY);
    $('ctl-anom-n').textContent = list.length ? String(list.length) : 'aucune';
    const counts = REASONS.map((r) => ({ ...r, n: list.filter((a) => store.reason(a.id) === r.code).length }))
      .filter((r) => r.n).sort((p, q) => q.n - p.n);
    $('ctl-reasons').replaceChildren(...counts.map((r) => {
      const li = document.createElement('li');
      li.className = 'rbar';
      li.dataset.reason = r.code;
      const name = document.createElement('span');
      name.className = 'rbar-label';
      name.textContent = r.label;
      const n = document.createElement('span');
      n.className = 'rbar-n';
      n.textContent = String(r.n);
      const track = document.createElement('span');
      track.className = 'rbar-track';
      const fill = document.createElement('span');
      fill.style.width = `${(100 * r.n) / counts[0].n}%`;
      track.append(fill);
      li.append(name, n, track);
      return li;
    }));
    $('ctl-anom-list').replaceChildren(...list.map((a) => streetRow({
      color: 'var(--anomalie)', name: addressLabel(a, ui.streets), sub: reasonLabel(store.reason(a.id)),
      onClick: () => showAddress(this.app, a),
    })));
    $('ctl-anom-none').hidden = list.length > 0;
  }

  // adresses non traitées (à faire, à repasser), dans l'ordre de passage
  renderUntreated(all) {
    const { ui, store } = this.app;
    const dark = ui.isDark();
    const list = all.filter((a) => !isTreated(store.status(a.id)));
    $('ctl-untreated-n').textContent = list.length ? String(list.length) : 'aucune';
    $('ctl-untreated-list').replaceChildren(...list.map((a) => streetRow({
      color: ui.streets[a.s].colors[dark ? 1 : 0],
      name: addressLabel(a, ui.streets),
      sub: STATUS_LABELS[store.status(a.id)],
      again: store.status(a.id) === ST_AGAIN ? 1 : 0,
      onClick: () => showAddress(this.app, a),
    })));
    $('ctl-untreated-none').hidden = list.length > 0;
  }

  // passages clôturés, du plus récent au plus ancien (bilan agrégé) ; le dernier peut être rouvert
  renderHistory(tour) {
    const { store } = this.app;
    const closures = tour.closures || [];
    $('ctl-history').hidden = !closures.length;
    $('ctl-history-n').textContent = String(closures.length);
    $('ctl-history-list').replaceChildren(...closures.map((c, k) => {
      const li = document.createElement('li');
      li.className = 'hist-row';
      const main = document.createElement('span');
      main.className = 'vrow-main';
      const name = document.createElement('span');
      name.className = 'vrow-name';
      name.textContent = `Passage du ${date(c.at)}`;
      const sub = document.createElement('span');
      sub.className = 'vrow-sub';
      const an = Object.values(c.anomalies).reduce((s, v) => s + v, 0);
      sub.textContent = `${c.done} ${agree(c.done, 'distribuée')} · ${plural(an, 'anomalie')} · ${c.todo} non ${agree(c.todo, 'traitée')}`;
      main.append(name, sub);
      li.append(main);
      if (k === closures.length - 1 && store.canReopen()) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn tinted small';
        b.id = 'ctl-reopen';
        b.textContent = 'Rouvrir';
        b.addEventListener('click', () => this.reopen());
        li.append(b);
      }
      return li;
    }).reverse());
  }

  // rapport du passage en cours, ou d'un passage qui vient d'être clôturé ({from, to})
  exportReport(ext, { from, to } = {}) {
    const { ui, store, backup } = this.app;
    const tour = store.activeTour;
    const passage = from === undefined ? store.derive(tour.id) : store.derive(tour.id, from, to);
    const hours = $('ctl-hours').checked;
    const args = { tour, groups: ui.visitGroups(), streets: ui.streets, passage, hours,
      from: from ?? store.passageStart(), to: to ?? Date.now() };
    if (ext === 'csv') return backup.shareReport(reportCsv(args), { tourName: tour.name, ext, type: 'text/csv' });
    return backup.shareReport(JSON.stringify(reportJson(args), null, 1), { tourName: tour.name, ext, type: 'application/json' });
  }

  async closePassage() {
    const { ui, store } = this.app;
    const tour = store.activeTour;
    const ids = ui.order.flatMap((s) => ui.byStreet[s]).map((a) => a.id);
    const left = ids.filter((id) => !isTreated(store.status(id))).length;
    const again = ids.filter((id) => store.status(id) === ST_AGAIN).length;
    const msg = `Clôturer le passage de « ${tour.name} » ?`
      + (left ? ` ${plural(left, 'adresse non traitée', 'adresses non traitées')}${again ? ` (dont ${again} à repasser)` : ''} le resteront dans le bilan.` : ' Toutes les adresses sont traitées.')
      + ' Le bilan est gardé dans l\'historique et la tournée repart à zéro pour le prochain passage. Exportez le rapport détaillé avant : ensuite, seul le bilan reste affiché.';
    if (!(await ui.confirm(msg, 'Clôturer', { destructive: true }))) return;
    const entry = await store.closePassage(ids);
    // le rapport du passage clôturé reste disponible juste après (toucher = geste pour la feuille de partage)
    ui.toast(`Passage clôturé : ${entry.done} ${agree(entry.done, 'distribuée')}, ${entry.todo} non ${agree(entry.todo, 'traitée')}`, {
      ms: 8000,
      action: { label: 'Rapport CSV', run: () => this.exportReport('csv', { from: entry.start, to: entry.at }) },
    });
  }

  async reopen() {
    if (await this.app.store.reopenPassage()) this.app.ui.toast('Dernier passage rouvert');
  }
}
