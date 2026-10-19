// Panneau debug : activé par ?debug=1 (désactivé par ?debug=0) ou par 5 taps sur la ligne de version du
// menu (indispensable dans l'app installée, qui s'ouvre toujours sur ./ sans paramètre). Affiche l'état du
// GPS, de l'écran allumé, du stockage, du service worker et les versions ; appui long sur la carte =
// position simulée ; journal des dernières erreurs JS (pas de console sur l'iPhone).

const FLAG_KEY = 'neyron-tournees.debug';
const MAX_ERRORS = 15;
const errors = [];

function logError(msg) {
  errors.push(`${new Date().toLocaleTimeString('fr-FR')} ${String(msg).slice(0, 300)}`);
  if (errors.length > MAX_ERRORS) errors.shift();
}

// collecte toujours active : activer le debug après coup montre les erreurs déjà survenues
window.addEventListener('error', (e) => logError(`${e.message} (${String(e.filename || '').split('/').pop()}:${e.lineno || '?'})`));
window.addEventListener('unhandledrejection', (e) => logError(`promesse rejetée : ${e.reason && e.reason.message ? e.reason.message : e.reason}`));

function readFlag() {
  try {
    return localStorage.getItem(FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

function writeFlag(on) {
  try {
    if (on) localStorage.setItem(FLAG_KEY, '1');
    else localStorage.removeItem(FLAG_KEY);
  } catch { /* stockage indisponible : debug pour la session seulement */ }
}

const mb = (n) => (Number.isFinite(n) ? `${(n / 1048576).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo` : '?');
const fmtTime = (t) => (t ? new Date(t).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'medium' }) : 'jamais');

export class DebugPanel {
  constructor(app) {
    this.app = app;
    this.el = null;
    this.collapsed = false;
    this.async = {};
    const q = new URLSearchParams(location.search).get('debug');
    if (q === '1') writeFlag(true);
    else if (q === '0') writeFlag(false);
    this._bindSecretTaps();
    app.map.on('longpress', ({ world }) => {
      if (this.enabled) this.simulate(world);
    });
    if (readFlag()) this.enable(false);
  }

  get enabled() {
    return Boolean(this.el);
  }

  _bindSecretTaps() {
    let taps = [];
    document.getElementById('menu-version').addEventListener('click', () => {
      const now = Date.now();
      taps = taps.filter((t) => now - t < 3000);
      taps.push(now);
      if (taps.length < 5) return;
      taps = [];
      if (this.enabled) this.disable();
      else this.enable(true);
    });
  }

  enable(announce) {
    if (this.el) return;
    writeFlag(true);
    const el = (this.el = document.createElement('section'));
    el.id = 'debug';
    el.className = 'debug panel';
    el.setAttribute('aria-label', 'Panneau debug');
    const head = document.createElement('div');
    head.className = 'debug-head';
    const title = document.createElement('strong');
    title.textContent = 'Debug';
    const btn = (label, cls, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `debug-btn ${cls}`;
      b.textContent = label;
      b.addEventListener('click', fn);
      return b;
    };
    this.toggleBtn = btn('Réduire', 'debug-toggle', () => this.setCollapsed(!this.collapsed));
    head.append(title, btn('Copier', 'debug-copy', () => this.copy()), this.toggleBtn, btn('Quitter', 'debug-quit', () => this.disable()));
    this.body = document.createElement('pre');
    this.body.className = 'debug-body';
    const hint = document.createElement('p');
    hint.className = 'debug-hint';
    hint.textContent = 'Appui long sur la carte : position simulée.';
    el.append(head, this.body, hint);
    document.getElementById('app').append(el);
    this.setCollapsed(false);
    this.timer = setInterval(() => this.render(), 1000);
    this.asyncTimer = setInterval(() => this.refreshAsync(), 5000);
    this.refreshAsync();
    if (announce) this.app.ui.toast('Mode debug activé');
  }

  disable() {
    if (!this.el) return;
    writeFlag(false);
    clearInterval(this.timer);
    clearInterval(this.asyncTimer);
    this.el.remove();
    this.el = null;
    this.app.ui.toast('Mode debug désactivé');
  }

  setCollapsed(c) {
    this.collapsed = c;
    this.el.classList.toggle('collapsed', c);
    this.toggleBtn.textContent = c ? 'Ouvrir' : 'Réduire';
    this.render();
  }

  simulate([x, y]) {
    this.app.gps.simulate(x, y);
    this.app.ui.toast(`Position simulée : x ${Math.round(x)} m, y ${Math.round(y)} m`);
    this.render();
  }

  async refreshAsync() {
    const a = {};
    const st = navigator.storage;
    try {
      if (st && st.estimate) a.estimate = await st.estimate();
      if (st && st.persisted) a.persisted = await st.persisted();
    } catch (err) {
      a.storageError = err.message;
    }
    try {
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.getRegistration();
        a.sw = !reg ? 'aucun service worker enregistré'
          : ['active', 'waiting', 'installing'].filter((k) => reg[k]).map((k) => `${k}: ${reg[k].state}`).join(', ') || 'enregistré, aucun worker';
        a.swControlled = Boolean(navigator.serviceWorker.controller);
      } else {
        a.sw = 'non pris en charge';
      }
    } catch (err) {
      a.sw = `erreur : ${err.message}`;
    }
    this.async = a;
    this.render();
  }

  // forCopy : le diagnostic copié peut être collé n'importe où (message, ticket) : la position n'y figure pas
  sections(forCopy = false) {
    const { map, store, gps, wake, versions } = this.app;
    const a = this.async;
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    const t = gps.tracker;
    const pos = t.last;
    const where = (v) => (forCopy ? 'masqué dans la copie' : v);
    const gpsLines = [
      ['mode', `${gps.mode}${t.watching ? ' (watchPosition actif)' : ''}`],
      ['position', !pos ? 'aucune' : `${pos.source}, ± ${Math.round(pos.acc)} m, qualité ${t.quality()}, âge ${Math.round(t.age())} s`],
    ];
    if (pos && pos.lat !== undefined) gpsLines.push(['lat / lon', where(`${pos.lat.toFixed(6)} / ${pos.lon.toFixed(6)}`)]);
    if (pos) {
      const out = pos.out ? ` (hors du plan : ${Math.round(pos.out)} m)` : '';
      gpsLines.push(['plan x / y', where(`${pos.x.toFixed(1)} / ${pos.y.toFixed(1)} m${out}`)]);
    }
    gpsLines.push(['relances', String(t.restarts)]);
    if (gps.lastError) gpsLines.push(['dernière erreur', `code ${gps.lastError.code} ${gps.lastError.message} (${fmtTime(gps.lastError.at)})`]);
    return [
      ['Application', [
        ['version app', versions.app || '?'],
        ['version données', versions.data || '?'],
        ['build', versions.builtAt || '?'],
        ['affichage', standalone ? 'app installée (standalone)' : 'navigateur'],
        ['contexte sécurisé', window.isSecureContext ? 'oui' : 'NON (HTTP) : GPS, service worker et écran allumé indisponibles'],
        ['écran', `${innerWidth} × ${innerHeight} px, DPR ${devicePixelRatio}`],
        ['réseau', navigator.onLine ? 'en ligne' : 'hors ligne'],
      ]],
      ['Service worker', [
        ['état', a.sw || '…'],
        ['page contrôlée', a.swControlled === undefined ? '…' : a.swControlled ? 'oui' : 'non'],
      ]],
      ['Stockage', [
        ['persist()', String(store.persistent)],
        ['persisted()', a.persisted === undefined ? '…' : String(a.persisted)],
        ['occupation', a.estimate ? `${mb(a.estimate.usage)} / ${mb(a.estimate.quota)}` : (a.storageError || '…')],
        ['IndexedDB', store.error ? `indisponible (${store.error.message}) : mémoire seule` : 'ok'],
        ['journal', `${store.allEvents.length} événements, tournée « ${store.tour} »`],
        ['appareil', `${store.deviceId}, seq ${store.seq}`],
        ['dernier export', fmtTime(store.meta.lastExportAt)],
      ]],
      ['GPS', gpsLines],
      ['Écran allumé', [
        ['état', wake.state],
        ['acquisitions', String(wake.acquisitions)],
      ]],
      ['Carte', [
        ['zoom', `${map.k.toFixed(2)} px/m`],
        ['centre', where(`${map.cx.toFixed(0)} / ${map.cy.toFixed(0)} m`)],  // suit la position en mode suivre
      ]],
      ['Erreurs JS', errors.length ? errors.map((e, i) => [String(i + 1), e]) : [['', 'aucune']]],
    ];
  }

  text(forCopy = false) {
    const out = ['Tournées de Neyron — diagnostic', `${new Date().toISOString()} · ${navigator.userAgent}`];
    for (const [title, lines] of this.sections(forCopy)) {
      out.push('', `[${title}]`);
      for (const [k, v] of lines) out.push(k ? `${k} : ${v}` : v);
    }
    return out.join('\n');
  }

  render() {
    if (!this.el || this.collapsed) return;
    this.body.textContent = this.text().split('\n').slice(2).join('\n').trim();
  }

  async copy() {
    const text = this.text(true);
    try {
      await navigator.clipboard.writeText(text);
      this.app.ui.toast('Diagnostic copié');
      return;
    } catch { /* presse-papiers refusé : repli ci-dessous */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.className = 'vh';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch { /* non pris en charge */ }
    ta.remove();
    this.app.ui.toast(ok ? 'Diagnostic copié' : 'Copie impossible : sélectionnez le texte du panneau', { ms: 4000 });
  }
}
