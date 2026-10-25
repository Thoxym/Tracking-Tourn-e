// Réseau routier côté page (data/roads.json), chargé à la première demande : aperçu de l'itinéraire, navigation.
// Le calcul lui-même se fait dans le worker (js/route-worker.js), qui charge sa propre copie.

import { RoadGraph } from './routing.js';

let promise = null;

export function loadRoads() {
  promise ??= fetch('./data/roads.json')
    .then((res) => {
      if (!res.ok) throw new Error(`roads.json : HTTP ${res.status}`);
      return res.json();
    })
    .then((roads) => ({ graph: new RoadGraph(roads), snap: roads.snap, version: roads.version }))
    .catch((err) => {
      promise = null;
      throw err;
    });
  return promise;
}
