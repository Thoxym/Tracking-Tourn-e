// Service worker : précache de toute l'app et des données, stratégie cache d'abord, aucun appel réseau
// bloquant (l'app doit s'ouvrir en mode avion). VERSION et PRECACHE sont écrits par
// `python pipeline/build.py --stamp` : après toute modification de docs/, relancer le stamp.

// @build:start (généré par pipeline/build.py --stamp, ne pas éditer)
const VERSION = '6fd47a96';
const PRECACHE = [
  './',
  './css/app.css',
  './data/addresses.json',
  './data/plan.json',
  './data/version.json',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './index.html',
  './js/debug.js',
  './js/gps.js',
  './js/io.js',
  './js/main.js',
  './js/map.js',
  './js/pwa.js',
  './js/store.js',
  './js/theme-init.js',
  './js/ui.js',
  './js/wakelock.js',
  './manifest.webmanifest',
];
// @build:end

const PREFIX = 'neyron-tournees-';  // origine partagée <user>.github.io : ne toucher qu'à nos caches
const CACHE = PREFIX + VERSION;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache: 'reload' : contourne le cache HTTP (Pages renvoie max-age=600) pour ne pas précacher un fichier périmé
    await Promise.all(PRECACHE.map(async (url) => {
      const res = await fetch(new Request(url, { cache: 'reload' }));
      if (!res.ok) throw new Error(`précache ${url} : HTTP ${res.status}`);
      await cache.put(url, res);
    }));
  })());
  // pas de skipWaiting ici : une mise à jour attend que l'utilisateur touche « Recharger »
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();  // première installation : la page courante passe hors ligne sans rechargement
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (req.mode === 'navigate') {  // toute navigation (y compris ?debug=1) sert l'index du cache
      const page = await cache.match('./index.html');
      if (page) return page;
    } else {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
    }
    return fetch(req);  // hors précache uniquement (ne devrait pas arriver)
  })());
});
