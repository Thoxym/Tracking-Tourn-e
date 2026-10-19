// Progression : journal d'événements dans IndexedDB (base « neyron-tournees »).
// L'état courant est dérivé du journal ; rien n'est jamais effacé : « Annuler » ajoute des événements.
//
// events : {dev, seq, t, tour, ids[], st, grp, undoOf?}  clé [dev, seq]
// tours  : {id, name, createdAt, archived}
// meta   : {key, value}  deviceId, seq, activeTour, dataVersion, persistAsked, persist

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

  static async open(dataVersion) {
    const s = new Store();
    await s._init(dataVersion);
    return s;
  }

  async _init(dataVersion) {
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
    if (!this.tours.length) this.tours.push({ id: DEFAULT_TOUR, name: 'Tournée', createdAt: Date.now(), archived: false });
    this.tour = m.activeTour && this.tours.some((t) => t.id === m.activeTour) ? m.activeTour : this.tours[0].id;
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
