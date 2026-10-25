// Sauvegarde : export JSON de la progression (feuille de partage iOS, sinon téléchargement) et import
// par fusion. Un fichier importé est une donnée non fiable : validé champ par champ, champs inconnus retirés.

import { BACKUP_SCHEMA, REASON_CODES, STATUSES, ST_ANOMALY } from './store.js';
import { LIMITS, MODES, WEAVE } from './itinerary.js';
import { reportFileName } from './report.js';

const $ = (id) => document.getElementById(id);
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_EVENTS = 200000;
const MAX_IDS = 2000;   // une rue entière tient largement (Route de Genève : 138)
const MAX_TOUR_IDS = 20000;  // composition d'une tournée (Neyron entière : 941 adresses)

const isStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const isSeq = (v) => Number.isSafeInteger(v) && v >= 1;
const isTime = (v) => Number.isFinite(v) && v > 0;
// clés de voie (ordre de passage, sens) : chaînes courtes, sans doublon
const keyList = (v) => (Array.isArray(v) ? [...new Set(v.slice(0, 2000).filter((k) => isStr(k, 64)))] : []);
const isCount = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 1e6;

// passage clôturé : bilan agrégé (comptes, anomalies par motif de la liste fermée)
function validClosure(c) {
  if (!c || typeof c !== 'object' || !isTime(c.at) || !(c.start === 0 || isTime(c.start)) || c.start >= c.at) return null;
  if (!['n', 'done', 'again', 'todo'].every((k) => isCount(c[k]))) return null;
  const anomalies = {};
  for (const [k, v] of Object.entries(c.anomalies && typeof c.anomalies === 'object' ? c.anomalies : {})) {
    if (REASON_CODES.includes(k) && isCount(v)) anomalies[k] = v;
  }
  return { at: c.at, start: c.start, n: c.n, done: c.done, again: c.again, todo: c.todo, anomalies };
}
const plural = (n, one, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;

export function validEvent(e) {
  if (!e || typeof e !== 'object') return null;
  const { dev, seq, t, tour, ids, st, why, grp, undoOf } = e;
  if (!isStr(dev, 64) || !isSeq(seq) || !isTime(t) || !isStr(tour, 64) || !STATUSES.includes(st) || !isStr(grp, 140)) return null;
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_IDS || !ids.every((id) => isStr(id, 64))) return null;
  if (undoOf !== undefined && !isStr(undoOf, 140)) return null;
  if (st === ST_ANOMALY && !REASON_CODES.includes(why)) return null;  // anomalie : motif de la liste fermée
  const out = { dev, seq, t, tour, ids: [...ids], st, grp };
  if (st === ST_ANOMALY) out.why = why;
  if (undoOf !== undefined) out.undoOf = undoOf;
  return out;
}

// itinéraire d'une tournée : réglages et arrêts calculés (champs connus seulement, tailles bornées)
const isNum = (v) => Number.isFinite(v) && Math.abs(v) < 1e7;
const isIdx = (v) => Number.isSafeInteger(v) && v >= 0 && v < 1e7;
const isPt = (p) => p && typeof p === 'object' && isNum(p.x) && isNum(p.y);

function validRouteSettings(o) {
  const st = o && typeof o === 'object' ? o : {};
  const out = {};
  if (MODES.includes(st.mode)) out.mode = st.mode;
  if (WEAVE.includes(st.weave)) out.weave = st.weave;
  if (st.weaveBy && typeof st.weaveBy === 'object') {
    out.weaveBy = {};
    for (const [k, v] of Object.entries(st.weaveBy).slice(0, 2000)) if (isStr(k, 64) && (v === 'weave' || v === 'sides')) out.weaveBy[k] = v;
  }
  if (st.custom && typeof st.custom === 'object') {
    out.custom = {};
    for (const m of MODES) {
      const c = st.custom[m];
      if (!c || typeof c !== 'object') continue;
      out.custom[m] = {};
      for (const [k, [lo, hi]] of Object.entries(LIMITS)) if (Number.isFinite(c[k]) && c[k] >= lo && c[k] <= hi) out.custom[m][k] = c[k];
    }
  }
  if (st.fromVehicle === true) out.fromVehicle = true;
  if (isPt(st.start)) out.start = { x: st.start.x, y: st.start.y };
  if (st.end === 'start' || isPt(st.end)) out.end = st.end === 'start' ? 'start' : { x: st.end.x, y: st.end.y };
  return out;
}

function validStop(s) {
  if (!s || typeof s !== 'object' || !['stop', 'run', 'window'].includes(s.kind)) return null;
  if (!Array.isArray(s.ids) || !s.ids.length || s.ids.length > MAX_IDS || !s.ids.every((id) => isStr(id, 64))) return null;
  if (!Array.isArray(s.sides) || s.sides.length !== s.ids.length || !s.sides.every((v) => v === 1 || v === -1)) return null;
  if (![s.arc, s.arcOut].every(isIdx) || ![s.sIn, s.sOut, s.x, s.y, s.walk, s.service].every(isNum)) return null;
  const path = Array.isArray(s.path) ? s.path.slice(0, 500).filter((p) => p && isIdx(p.arc) && isNum(p.s0) && isNum(p.s1))
    .map((p) => ({ arc: p.arc, s0: p.s0, s1: p.s1 })) : null;
  return {
    kind: s.kind, ids: [...s.ids], sides: [...s.sides], arc: s.arc, sIn: s.sIn, arcOut: s.arcOut, sOut: s.sOut, path,
    x: s.x, y: s.y, street: Number.isSafeInteger(s.street) ? s.street : -1, walk: s.walk, service: s.service,
    mixed: s.mixed === true, legSec: isNum(s.legSec) ? s.legSec : 0, legM: isNum(s.legM) ? s.legM : 0,
  };
}

export function validRoute(r) {
  if (!r || typeof r !== 'object') return null;
  const out = { settings: validRouteSettings(r.settings) };
  if (Array.isArray(r.stops) && r.stops.length <= MAX_TOUR_IDS) {
    const stops = r.stops.map(validStop);
    if (stops.every(Boolean) && stops.length) {
      out.stops = stops;
      out.roadsVersion = isStr(r.roadsVersion, 16) ? r.roadsVersion : null;
      out.computedAt = isTime(r.computedAt) ? r.computedAt : 0;
      out.manual = r.manual === true;
      out.settingsKey = isStr(r.settingsKey, 4000) ? r.settingsKey : null;
      const t = r.totals && typeof r.totals === 'object' ? r.totals : {};
      out.totals = {};
      for (const k of ['sec', 'travelSec', 'serviceSec', 'driveM', 'walkM', 'stops', 'addresses']) out.totals[k] = isNum(t[k]) ? t[k] : 0;
      out.baseline = isNum(r.baseline) ? r.baseline : null;
    }
  }
  return out;
}

export function validTour(t) {
  if (!t || typeof t !== 'object' || !isStr(t.id, 64)) return null;
  const ids = Array.isArray(t.ids) ? t.ids.slice(0, MAX_TOUR_IDS).filter((id) => isStr(id, 64)) : [];
  return {
    id: t.id,
    name: isStr(t.name, 120) ? t.name : 'Tournée',
    createdAt: isTime(t.createdAt) ? t.createdAt : Date.now(),
    updatedAt: isTime(t.updatedAt) ? t.updatedAt : 0,  // ancienne sauvegarde : ne remplace jamais une tournée connue
    archived: t.archived === true,
    ids: [...new Set(ids)],
    order: keyList(t.order),
    reverse: keyList(t.reverse),
    closures: Array.isArray(t.closures) ? t.closures.slice(0, 2000).map(validClosure).filter(Boolean).sort((a, b) => a.at - b.at) : [],
    ...(t.route ? { route: validRoute(t.route) } : {}),
  };
}

export function parseBackup(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error('fichier illisible (JSON invalide)');
  }
  if (!obj || obj.app !== 'neyron-tournees') throw new Error('ce fichier n\'est pas une sauvegarde des tournées de Neyron');
  if (obj.kind === 'rapport') throw new Error('ce fichier est un rapport de tournée, pas une sauvegarde');
  if (Number.isSafeInteger(obj.schema) && obj.schema > BACKUP_SCHEMA) {
    throw new Error(`sauvegarde faite par une version plus récente de l'app (format ${obj.schema}) : mettez l'app à jour`);
  }
  if (obj.schema !== 1 && obj.schema !== 2) throw new Error(`version de sauvegarde non prise en charge (${String(obj.schema).slice(0, 10)})`);
  if (!Array.isArray(obj.events) || obj.events.length > MAX_EVENTS) throw new Error('liste d\'événements absente ou trop longue');
  const events = [];
  let invalid = 0;
  for (const e of obj.events) {
    const v = validEvent(e);
    if (v) events.push(v);
    else invalid += 1;
  }
  // v0.1 (format 1) : une tournée sans liste d'adresses est marquée, le store lui donnera le preset de même id
  const tours = Array.isArray(obj.tours)
    ? obj.tours.slice(0, 1000).map((t) => {
      const v = validTour(t);
      if (v && obj.schema === 1 && !Array.isArray(t.ids)) v.legacy = true;
      return v;
    }).filter(Boolean)
    : [];
  return {
    schema: obj.schema,
    events,
    tours,
    invalid,
    deviceId: isStr(obj.deviceId, 64) ? obj.deviceId : null,
    exportedAt: isStr(obj.exportedAt, 40) ? obj.exportedAt : null,
  };
}

export function backupFileName(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `neyron-tournees-export-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}

// Feuille de partage (iOS) si elle accepte le fichier, sinon téléchargement. Synchrone jusqu'à
// navigator.share : la feuille exige un geste récent, aucun await avant.
export function shareFile(ui, file, { title, what, onDone = () => {} }) {
  let canShare = false;
  try {
    canShare = Boolean(navigator.share && navigator.canShare && navigator.canShare({ files: [file] }));
  } catch { /* canShare peut lever sur certains navigateurs */ }
  if (canShare) {
    navigator.share({ files: [file], title })
      .then(() => {
        onDone();
        ui.toast(`${what} partagé${what === 'Sauvegarde' ? 'e' : ''}`, { ms: 4000 });
      })
      .catch((err) => {
        if (err.name === 'AbortError') ui.toast(`Partage annulé : ${what.toLowerCase()} non envoyé${what === 'Sauvegarde' ? 'e' : ''}`);
        else download(ui, file, what, onDone);
      });
    return 'share';
  }
  download(ui, file, what, onDone);
  return 'download';
}

function download(ui, file, what, onDone) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  onDone();
  ui.toast(`${what} téléchargé${what === 'Sauvegarde' ? 'e' : ''} : ${file.name}`, { ms: 4000 });
}

export class BackupController {
  constructor({ ui, store, map }) {
    this.ui = ui;
    this.store = store;
    this.map = map;
    $('btn-export').addEventListener('click', () => this.exportNow());
    $('import-file').addEventListener('change', (e) => this._onFile(e.target));
    $('btn-import').addEventListener('keydown', (e) => {  // le <label> ne s'active pas au clavier
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        $('import-file').click();
      }
    });
  }

  // synchrone jusqu'à navigator.share : la feuille de partage exige un geste récent (pas d'await avant)
  exportNow() {
    const file = new File([JSON.stringify(this.store.exportData())], backupFileName(), { type: 'application/json' });
    return shareFile(this.ui, file, {
      title: 'Sauvegarde des tournées de Neyron',
      what: 'Sauvegarde',
      onDone: () => this.store.markExported().catch(() => {}),
    });
  }

  // rapport de tournée (report.js) : mêmes canaux que la sauvegarde
  shareReport(content, { tourName, ext, type }) {
    const file = new File([content], reportFileName(tourName, ext), { type });
    return shareFile(this.ui, file, { title: `Rapport · ${tourName}`, what: 'Rapport' });
  }

  async _onFile(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      if (file.size > MAX_FILE_BYTES) throw new Error('fichier trop volumineux');
      const backup = parseBackup(await file.text());
      const fresh = this.store.newEvents(backup.events);
      // tournées nouvelles, ou plus récentes que celles de cet appareil (composition, nom)
      const changedTours = backup.tours.filter((t) => {
        const local = this.store.tours.find((x) => x.id === t.id);
        return !local || (t.updatedAt || 0) > (local.updatedAt || 0);
      });
      const skipped = backup.invalid ? ` ${plural(backup.invalid, 'entrée invalide ignorée', 'entrées invalides ignorées')}.` : '';
      if (!fresh.length && !changedTours.length) {
        this.ui.toast(`Rien à importer : ${plural(backup.events.length, 'événement déjà présent', 'événements déjà présents')}.${skipped}`, { ms: 5000 });
        return;
      }
      const when = backup.exportedAt && !Number.isNaN(Date.parse(backup.exportedAt))
        ? new Date(backup.exportedAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
        : 'date inconnue';
      const from = backup.deviceId === this.store.deviceId ? 'cet appareil' : `appareil ${backup.deviceId ? backup.deviceId.slice(0, 6) : 'inconnu'}`;
      const unknown = new Set(fresh.flatMap((e) => e.ids).filter((id) => !this.map.byId.has(id))).size;
      const names = changedTours.slice(0, 3).map((t) => `« ${t.name} »`).join(', ') + (changedTours.length > 3 ? '…' : '');
      const tours = changedTours.length ? ` et ${plural(changedTours.length, 'tournée')} (${names})` : '';
      const msg = `Fusionner ${plural(fresh.length, 'événement')}${tours} de la sauvegarde du ${when} (${from}) ? Rien n'est supprimé.${skipped}`
        + (unknown ? ` ${plural(unknown, 'adresse inconnue', 'adresses inconnues')} de ce plan (ignorées à l'affichage).` : '');
      if (!(await this.ui.confirm(msg, 'Importer'))) return;
      const r = await this.store.merge(backup.events, backup.tours);
      this.ui.toast(`${plural(r.added, 'événement ajouté', 'événements ajoutés')}${r.duplicates ? `, ${plural(r.duplicates, 'déjà présent', 'déjà présents')}` : ''}`
        + (r.tours ? `, ${plural(r.tours, 'tournée ajoutée ou mise à jour', 'tournées ajoutées ou mises à jour')}` : ''), { ms: 5000 });
    } catch (err) {
      this.ui.toast(`Import impossible : ${err.message}`, { ms: 6000 });
    } finally {
      input.value = '';  // permet de réimporter le même fichier
    }
  }
}
