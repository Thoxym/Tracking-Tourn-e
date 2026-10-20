// Démarrage : chargement des données, stockage de la progression, plan, interface.

import { DebugPanel } from './debug.js';
import { GpsController } from './gps.js';
import { BackupController } from './io.js';
import { MapView } from './map.js';
import { registerServiceWorker } from './pwa.js';
import { Store } from './store.js';
import { TabBar } from './tabs.js';
import { UI } from './ui.js';
import { ControlView } from './views/control.js';
import { DistributeView } from './views/distribute.js';
import { PrepareView } from './views/prepare.js';
import { WakeLockController } from './wakelock.js';

async function loadJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} : HTTP ${res.status}`);
  return res.json();
}

registerServiceWorker();  // au plus tôt, indépendamment du chargement du plan

async function start() {
  const splash = document.getElementById('loading');
  try {
    const [data, plan] = await Promise.all([loadJSON('./data/addresses.json'), loadJSON('./data/plan.json')]);
    const store = await Store.open(data.version, data.presets || []);
    const map = new MapView(document.getElementById('map'), data, plan);
    const ui = new UI(map, data, store);
    const gps = new GpsController({ map, ui, store, data });
    ui.onSheet(() => gps.refresh());
    const wake = new WakeLockController({ ui });
    gps.wake = wake;
    const backup = new BackupController({ ui, store, map });
    const versions = { app: null, data: data.version };
    const tabs = new TabBar({ ui });
    const app = { map, ui, data, store, gps, wake, backup, versions, tabs };
    app.prepare = new PrepareView(app);
    app.distribute = new DistributeView(app);
    app.control = new ControlView(app);
    app.debug = new DebugPanel(app);
    window.neyronApp = app;  // accès pour les tests
    splash.hidden = true;
    ui.setVersions(versions);
    loadJSON('./data/version.json')
      .then((v) => { versions.app = v.app; versions.builtAt = v.builtAt; ui.setVersions(versions); })
      .catch(() => {});
    if (store.error) ui.toast(`Stockage indisponible (${store.error.message}) : la progression ne sera pas conservée`, { ms: 8000 });
    store.requestPersist();
  } catch (err) {
    splash.classList.add('error');
    document.getElementById('loading-msg').textContent = `Impossible de charger le plan : ${err.message}`;
    throw err;
  }
}

start();
