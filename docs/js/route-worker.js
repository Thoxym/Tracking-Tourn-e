// Calcul d'itinéraire hors du fil principal : l'interface reste fluide pendant les quelques secondes d'optimisation.
// Messages reçus : {id, ids, settings, order, budgetMs} ; envoyés : {id, type: 'progress' | 'done' | 'error', …}.

import { RoadGraph, computeRoute } from './itinerary.js';

let ready = null;

async function load() {
  ready ??= (async () => {
    const get = async (url) => {
      const res = await fetch(new URL(url, import.meta.url));
      if (!res.ok) throw new Error(`${url} : HTTP ${res.status}`);
      return res.json();
    };
    const [roads, data] = await Promise.all([get('../data/roads.json'), get('../data/addresses.json')]);
    return { graph: new RoadGraph(roads), snap: roads.snap, data };
  })();
  return ready;
}

self.onmessage = async (ev) => {
  const { id, ids, settings, order, budgetMs } = ev.data || {};
  try {
    const { graph, snap, data } = await load();
    const result = computeRoute({
      graph, data, snap, ids, settings, order, budgetMs,
      onProgress: (phase, f) => self.postMessage({ id, type: 'progress', phase, f }),
    });
    self.postMessage({ id, type: 'done', result });
  } catch (err) {
    ready = null;
    self.postMessage({ id, type: 'error', message: err.message || String(err) });
  }
};
