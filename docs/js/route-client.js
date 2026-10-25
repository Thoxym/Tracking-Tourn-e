// Côté page : calcul d'itinéraire dans le worker (js/route-worker.js), une demande à la fois.
// Une nouvelle demande annule la précédente (le worker est relancé).

export class RouteClient {
  constructor() {
    this.worker = null;
    this.seq = 0;
    this.pending = null;
  }

  _spawn() {
    this.worker = new Worker(new URL('./route-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev) => {
      const m = ev.data;
      const p = this.pending;
      if (!p || m.id !== p.id) return;
      if (m.type === 'progress') p.onProgress?.(m.phase, m.f);
      else {
        this.pending = null;
        if (m.type === 'done') p.resolve(m.result);
        else p.reject(new Error(m.message));
      }
    };
    this.worker.onerror = (ev) => {
      const p = this.pending;
      this.pending = null;
      this.worker = null;
      p?.reject(new Error(ev.message || 'calcul interrompu'));
    };
  }

  // ids : adresses de la tournée ; order : ordre de passage actuel ; settings : réglages de la tournée
  compute({ ids, order, settings, budgetMs = 2000, onProgress }) {
    this.cancel();
    if (!this.worker) this._spawn();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending = { id, resolve, reject, onProgress };
      this.worker.postMessage({ id, ids: [...ids], order: [...order], settings, budgetMs });
    });
  }

  cancel() {
    if (!this.pending) return;
    const p = this.pending;
    this.pending = null;
    this.worker?.terminate();
    this.worker = null;
    p.reject(Object.assign(new Error('calcul annulé'), { cancelled: true }));
  }
}
