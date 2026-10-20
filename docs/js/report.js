// Rapport de tournée, sans DOM : détail par adresse (statut, motif) en CSV (Excel, en français) ou JSON.
// RGPD (CLAUDE.md §2 bis) : sans heure par défaut. Les heures de pointage, qui retracent l'activité de la
// personne, ne sont ajoutées que sur demande.

import { ST_AGAIN, ST_ANOMALY, ST_DONE, ST_TODO, reasonLabel } from './store.js';

export const REPORT_STATUS = { [ST_DONE]: 'distribuée', [ST_ANOMALY]: 'anomalie', [ST_AGAIN]: 'à repasser', [ST_TODO]: 'non traitée' };
const pad = (n) => String(n).padStart(2, '0');
const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const stamp = (t) => {
  const d = new Date(t);
  return `${day(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// cellule CSV : guillemets si besoin ; une valeur commençant par = + - @ est neutralisée (injection de
// formule dans le tableur)
export function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function reportFileName(tourName, ext, d = new Date()) {
  const slug = tourName.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'tournee';
  return `rapport-${slug}-${day(d).replace(/-/g, '')}.${ext}`;
}

// lignes du rapport : une par adresse, dans l'ordre de passage.
// groups : [{s, addrs}] ; passage : {state, reasons, times} (store.derive)
function rows(groups, streets, passage, hours) {
  return groups.flatMap(({ addrs }) => addrs.map((a) => {
    const st = passage.state.get(a.id) || ST_TODO;
    const r = {
      id: a.id, rue: streets[a.s].name, numero: a.n, complement: a.rep, cote: a.side,
      statut: REPORT_STATUS[st], motif: st === ST_ANOMALY ? reasonLabel(passage.reasons.get(a.id)) : '',
    };
    if (hours) r.heure = st !== ST_TODO && passage.times.has(a.id) ? stamp(passage.times.get(a.id)) : '';
    return r;
  }));
}

function totals(list) {
  const t = { adresses: list.length, distribuees: 0, anomalies: 0, a_repasser: 0, non_traitees: 0 };
  for (const r of list) {
    if (r.statut === REPORT_STATUS[ST_DONE]) t.distribuees += 1;
    else if (r.statut === REPORT_STATUS[ST_ANOMALY]) t.anomalies += 1;
    else t.non_traitees += 1;
    if (r.statut === REPORT_STATUS[ST_AGAIN]) t.a_repasser += 1;
  }
  return t;
}

// CSV : séparateur « ; », BOM UTF-8 et fins de ligne CRLF (ouverture directe dans Excel en français)
export function reportCsv({ groups, streets, passage, hours = false }) {
  const cols = ['rue', 'numero', 'complement', 'cote', 'statut', 'motif', ...(hours ? ['heure'] : [])];
  const lines = rows(groups, streets, passage, hours).map((r) => cols.map((c) => csvCell(r[c])).join(';'));
  return `﻿${[cols.join(';'), ...lines].join('\r\n')}\r\n`;
}

// JSON : totaux, anomalies par motif, bilan par rue, détail par adresse. Sans heures : seulement la date.
export function reportJson({ tour, groups, streets, passage, hours = false, from = 0, to = Date.now() }) {
  const list = rows(groups, streets, passage, hours);
  const reasons = {};
  for (const r of list) if (r.motif) reasons[r.motif] = (reasons[r.motif] || 0) + 1;
  const byStreet = groups.map(({ s }) => {
    const t = totals(list.filter((r) => r.rue === streets[s].name));
    return { rue: streets[s].name, ...t };
  });
  const out = {
    app: 'neyron-tournees',
    kind: 'rapport',
    schema: 1,
    tournee: tour.name,
    date: day(new Date(to)),
    totaux: totals(list),
    anomalies_par_motif: reasons,
    rues: byStreet,
    adresses: list,
  };
  if (hours) out.passage = { debut: from ? stamp(from) : null, fin: stamp(to) };
  return out;
}
