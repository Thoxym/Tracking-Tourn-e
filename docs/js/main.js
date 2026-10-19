// Démarrage : chargement des données, stockage de la progression, plan, interface.

import { GpsController } from './gps.js';
import { MapView } from './map.js';
import { Store } from './store.js';
import { UI } from './ui.js';
import { WakeLockController } from './wakelock.js';

async function loadJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} : HTTP ${res.status}`);
  return res.json();
}

async function start() {
  const splash = document.getElementById('loading');
  try {
    const [data, plan] = await Promise.all([loadJSON('./data/addresses.json'), loadJSON('./data/plan.json')]);
    const store = await Store.open(data.version);
    const map = new MapView(document.getElementById('map'), data, plan);
    const ui = new UI(map, data, store);
    const gps = new GpsController({ map, ui, store, data });
    ui.onSheet(() => gps.refresh());
    const wake = new WakeLockController({ ui });
    gps.wake = wake;
    window.neyronApp = { map, ui, data, store, gps, wake };  // accès pour le panneau debug et les tests
    splash.hidden = true;
    if (store.error) ui.toast(`Stockage indisponible (${store.error.message}) : la progression ne sera pas conservée`, { ms: 8000 });
    store.requestPersist();
  } catch (err) {
    splash.classList.add('error');
    document.getElementById('loading-msg').textContent = `Impossible de charger le plan : ${err.message}`;
    throw err;
  }
}

start();
