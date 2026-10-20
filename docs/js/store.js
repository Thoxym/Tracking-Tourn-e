// Progression : journal d'événements dans IndexedDB (base « neyron-tournees »).
// L'état courant est dérivé du journal ; rien n'est jamais effacé : « Annuler » ajoute des événements.
//
// events : {dev, seq, t, tour, ids[], st, grp, undoOf?}  clé [dev, seq]
// tours  : {id, name, createdAt, updatedAt, archived, ids[], order?, reverse?}
//          ids = composition (adresses de la tournée) ; order / reverse = ordre de passage et rues parcourues
//          en numéros décroissants, par clé de voie BAN (tourplan.js)
// meta   : {key, value}  deviceId, seq, activeTour, dataVersion, persistAsked, persist
//
// La progression est propre à chaque tournée (champ `tour` des événements). Changer la composition
// n'efface rien : une adresse retirée puis remise retrouve son statut.

const DB_NAME = 'neyron-tournees';
const DB_VERSION = 1;
export const DEFAULT_TOUR = 'default';  // même id sur tous les appareils : les exports fusionnent sur la même tournée
export const ST_TODO = 'a_faire';
export const ST_DONE = 'fait';
export const ST_AGAIN = 'a_repasser';
export const STATUSES = [ST_TODO, ST_DONE, ST_AGAIN];

// ordre total du journal : heure, puis appareil, puis numéro de séquence
export function compareEvents(a, b) {
  return a.t - b.t || (a.dev < b.dev ? -1 : a.dev > b.dev ? 1 : 0) || a.seq - b.seq;
}

function randomId(bytes = 6) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

function newTour(id, name, ids = []) {
  const now = Date.now();
  return { id, name, createdAt: now, updatedAt: now, archived: false, ids: [...ids] };
}

function openDB() {
  return new Promise((resolve, reject) => {
    if (!self.indexedDB) {
      reject(new Error('IndexedDB indisponible'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('events', { keyPath: ['dev', 'seq'] }).createIndex('tour', 'tour');
      db.createObjectStore('tours', { keyPath: 'id' });
      db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('base ouverte dans un autre onglet'));
  });
}

// transaction dont toutes les requêtes sont émises de façon synchrone dans fn (pas d'await au milieu :
// certains Safari valident la transaction dès qu'on rend la main)
function transact(db, stores, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const out = {};
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction annulée'));
    fn(tx, out);
  });
}

export class Store {
  constructor() {
    this.db = null;
    this.error = null;
    this.meta = {};
    this.tours = [];
    this.allEvents = [];
    this.events = [];       // événements de la tournée active, triés
    this.state = new Map(); // id -> statut (absent = à faire)
    this.listeners = new Set();
    this.persistent = null;
  }

  // presets : tournées prédéfinies des données ({id, name, ids}) ; « default » complète la tournée de la v0.1
  static async open(dataVersion, presets = []) {
    const s = new Store();
    await s._init(dataVersion, presets);
    return s;
  }

  async _init(dataVersion, presets) {
    try {
      this.db = await openDB();
      const r = await transact(this.db, ['meta', 'tours', 'events'], 'readonly', (tx, out) => {
        tx.objectStore('meta').getAll().onsuccess = (e) => { out.meta = e.target.result; };
        tx.objectStore('tours').getAll().onsuccess = (e) => { out.tours = e.target.result; };
        tx.objectStore('events').getAll().onsuccess = (e) => { out.events = e.target.result; };
      });
      for (const { key, value } of r.meta) this.meta[key] = value;
      this.tours = r.tours;
      this.allEvents = r.events;
    } catch (err) {
      this.error = err;  // mode dégradé : tout reste en mémoire pour la session
      this.db = null;
    }
    const m = this.meta;
    this.deviceId = m.deviceId || randomId();
    const ownMax = Math.max(0, ...this.allEvents.filter((e) => e.dev === this.deviceId).map((e) => e.seq));
    this.seq = Math.max(m.seq || 0, ownMax);
    // migration v0.1 : la tournée « default » n'avait pas de composition, elle reçoit celle du preset
    // de même id (les 10 rues) ; sa progression, rattachée à l'id, est conservée
    for (const pr of presets) {
      const t = this.tours.find((x) => x.id === pr.id);
      if (!t) this.tours.push(newTour(pr.id, pr.name, pr.ids));
      else if (!Array.isArray(t.ids)) Object.assign(t, { ids: [...pr.ids], name: t.name === 'Tournée' ? pr.name : t.name, updatedAt: Date.now() });
    }
    if (!this.tours.length) this.tours.push(newTour(DEFAULT_TOUR, 'Tournée'));
    for (const t of this.tours) {
      if (!Array.isArray(t.ids)) t.ids = [];
      t.updatedAt ||= t.createdAt || 0;
    }
    const usable = (id) => this.tours.some((t) => t.id === id && !t.archived);
    this.tour = usable(m.activeTour) ? m.activeTour : (this.liveTours()[0] || this.tours[0]).id;
    await this._save({ deviceId: this.deviceId, seq: this.seq, activeTour: this.tour, dataVersion }, this.tours);
    this._reload();
  }

  async _save(meta, tours = []) {
    Object.assign(this.meta, meta);
    if (!this.db) return;
    await transact(this.db, ['meta', 'tours'], 'readwrite', (tx) => {
      for (const [key, value] of Object.entries(meta)) tx.objectStore('meta').put({ key, value });
      for (const t of tours) tx.objectStore('tours').put(t);
    });
  }

  _reload() {
    this.events = this.allEvents.filter((e) => e.tour === this.tour).sort(compareEvents);
    this.state = new Map();
    for (const e of this.events) {
      for (const id of e.ids) {
        if (e.st === ST_TODO) this.state.delete(id);
        else this.state.set(id, e.st);
      }
    }
  }

  // ------------------------------------------------------------- tournées

  get activeTour() {
    return this.tours.find((t) => t.id === this.tour);
  }

  liveTours() {
    return this.tours.filter((t) => !t.archived).sort((a, b) => a.createdAt - b.createdAt);
  }

  archivedTours() {
    return this.tours.filter((t) => t.archived).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // statuts d'une tournée quelconque (la tournée active a déjà les siens dans this.state)
  stateOf(tourId) {
    if (tourId === this.tour) return this.state;
    const st = new Map();
    for (const e of this.allEvents.filter((x) => x.tour === tourId).sort(compareEvents)) {
      for (const id of e.ids) {
        if (e.st === ST_TODO) st.delete(id);
        else st.set(id, e.st);
      }
    }
    return st;
  }

  // extra : ordre de passage d'un secteur importé ({order, reverse})
  async createTour(name, ids = [], extra = {}) {
    const t = Object.assign(newTour(`t-${randomId(5)}`, name, ids), extra);
    this.tours.push(t);
    await this._save({}, [t]);
    await this.setActiveTour(t.id);
    return t;
  }

  async updateTour(id, patch) {
    const t = this.tours.find((x) => x.id === id);
    if (!t) return null;
    Object.assign(t, patch, { updatedAt: Date.now() });
    await this._save({}, [t]);
    this._emit({ type: 'tour', tour: t, change: Object.keys(patch) });
    return t;
  }

  async setActiveTour(id) {
    if (!this.tours.some((t) => t.id === id)) return;
    this.tour = id;
    await this._save({ activeTour: id });
    this._reload();
    this._emit({ type: 'tour', tour: this.activeTour, change: ['active'] });
  }

  // archiver la tournée active fait passer à la plus récente des autres ; la dernière tournée en cours
  // ne s'archive pas (false). Rien n'est supprimé : une tournée archivée se restaure avec sa progression.
  async archiveTour(id, archived = true) {
    if (archived && id === this.tour) {
      const other = this.liveTours().filter((t) => t.id !== id).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (!other) return false;
      await this.updateTour(id, { archived: true });
      await this.setActiveTour(other.id);
      return true;
    }
    await this.updateTour(id, { archived });
    return true;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(detail) {
    for (const fn of this.listeners) fn(detail);
  }

  status(id) {
    return this.state.get(id) || ST_TODO;
  }

  // ajoute les événements d'une action (même grp, même heure) dans une seule transaction
  async _append(items, extra = {}) {
    const t = Date.now();
    const evs = items.map(({ ids, st }) => ({ dev: this.deviceId, seq: ++this.seq, t, tour: this.tour, ids, st }));
    const grp = `${this.deviceId}:${evs[0].seq}`;
    for (const e of evs) Object.assign(e, { grp }, extra);
    if (this.db) {
      await transact(this.db, ['events', 'meta'], 'readwrite', (tx) => {
        for (const e of evs) tx.objectStore('events').add(e);  // add : ne jamais écraser un événement
        tx.objectStore('meta').put({ key: 'seq', value: this.seq });
      });
    }
    this.meta.seq = this.seq;
    this.allEvents.push(...evs);
    this._reload();
    return { grp, events: evs };
  }

  // change le statut des ids qui ne l'ont pas déjà ; null si rien ne change
  async setStatus(ids, st) {
    if (!STATUSES.includes(st)) throw new Error(`statut inconnu : ${st}`);
    const changed = [...new Set(ids)].filter((id) => this.status(id) !== st);
    if (!changed.length) return null;
    const { grp } = await this._append([{ ids: changed, st }]);
    const action = { type: 'set', grp, ids: changed, st };
    this._emit(action);
    return action;
  }

  // dernière action de cet appareil (tournée active) qui n'a pas encore été annulée
  lastUndoable() {
    const undone = new Set();
    for (const e of this.events) if (e.undoOf) undone.add(e.undoOf);
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.dev === this.deviceId && !e.undoOf && !undone.has(e.grp)) return e.grp;
    }
    return null;
  }

  canUndo() {
    return this.lastUndoable() !== null;
  }

  // rétablit, pour chaque id de l'action, son statut juste avant elle (un événement par statut rétabli)
  async undo() {
    const grp = this.lastUndoable();
    if (!grp) return null;
    const target = this.events.filter((e) => e.grp === grp);
    const first = target[0];
    const before = new Map();
    for (const e of this.events) {
      if (compareEvents(e, first) >= 0) break;
      for (const id of e.ids) before.set(id, e.st);
    }
    const byStatus = new Map();
    for (const id of new Set(target.flatMap((e) => e.ids))) {
      const st = before.get(id) || ST_TODO;
      if (!byStatus.has(st)) byStatus.set(st, []);
      byStatus.get(st).push(id);
    }
    await this._append([...byStatus].map(([st, ids]) => ({ ids, st })), { undoOf: grp });
    const action = { type: 'undo', grp, ids: target.flatMap((e) => e.ids), st: target[0].st };
    this._emit(action);
    return action;
  }

  // ------------------------------------------------------------ export / import

  exportData() {
    return {
      app: 'neyron-tournees',
      schema: 1,
      exportedAt: new Date().toISOString(),
      deviceId: this.deviceId,
      dataVersion: this.meta.dataVersion || null,
      tours: this.tours,
      events: this.allEvents,
    };
  }

  async markExported() {
    await this._save({ lastExportAt: Date.now() });
  }

  // événements absents du journal (clé [dev, seq]) ; ne modifie rien
  newEvents(events) {
    const known = new Set(this.allEvents.map((e) => `${e.dev}\u0000${e.seq}`));
    const out = [];
    for (const e of events) {
      const k = `${e.dev}\u0000${e.seq}`;
      if (!known.has(k)) {
        known.add(k);
        out.push(e);
      }
    }
    return out;
  }

  // fusion d'événements et de tournées déjà validés : événements en ajout seul (dédoublonnage sur
  // [dev, seq]) ; une tournée connue est remplacée si la version importée est plus récente (updatedAt)
  async merge(events, tours = []) {
    const added = this.newEvents(events);
    const newTours = tours.filter((t) => !this.tours.some((x) => x.id === t.id));
    const updated = tours.filter((t) => {
      const local = this.tours.find((x) => x.id === t.id);
      return local && (t.updatedAt || 0) > (local.updatedAt || 0);
    });
    const ownMax = Math.max(0, ...added.filter((e) => e.dev === this.deviceId).map((e) => e.seq));
    if (this.db && (added.length || newTours.length || updated.length)) {
      await transact(this.db, ['events', 'tours', 'meta'], 'readwrite', (tx) => {
        for (const e of added) tx.objectStore('events').add(e);
        for (const t of newTours) tx.objectStore('tours').add(t);
        for (const t of updated) tx.objectStore('tours').put(t);
        // sauvegarde de cet appareil réimportée : ne jamais réutiliser un seq déjà pris
        if (ownMax > this.seq) tx.objectStore('meta').put({ key: 'seq', value: ownMax });
      });
    }
    if (ownMax > this.seq) this.seq = this.meta.seq = ownMax;
    this.allEvents.push(...added);
    this.tours.push(...newTours);
    for (const t of updated) Object.assign(this.tours.find((x) => x.id === t.id), t);
    this._reload();
    const result = { type: 'import', added: added.length, duplicates: events.length - added.length,
      tours: newTours.length + updated.length };
    this._emit(result);
    return result;
  }

  // navigator.storage.persist() au premier lancement, persisted() ensuite (affiché par le debug)
  async requestPersist() {
    const s = navigator.storage;
    if (!s || !s.persist) {
      this.persistent = 'non supporté';
      return this.persistent;
    }
    try {
      let granted = s.persisted ? await s.persisted() : false;
      if (!granted && !this.meta.persistAsked) {
        granted = await s.persist();
        await this._save({ persistAsked: Date.now() });
      }
      this.persistent = granted;
      await this._save({ persist: granted });
    } catch (err) {
      this.persistent = `erreur : ${err.message}`;
    }
    return this.persistent;
  }
}
