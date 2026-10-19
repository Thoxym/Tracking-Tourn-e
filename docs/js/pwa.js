// Enregistrement du service worker et mise à jour : une nouvelle version installée attend ; le bandeau
// « Nouvelle version disponible — Recharger » envoie SKIP_WAITING, puis la page se recharge sur controllerchange.

const $ = (id) => document.getElementById(id);
const UPDATE_CHECK_MS = 30 * 60 * 1000;  // app installée iOS : souvent reprise sans navigation, donc sans contrôle

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  let userAsked = false;
  let reloading = false;
  // page déjà contrôlée par une version précédente (au chargement, ou depuis la fin de la première installation)
  let controlled = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // la première installation prend aussi le contrôle (clients.claim) : ne recharger que sur demande
    if (!userAsked) {
      controlled = true;
      return;
    }
    if (reloading) return;
    reloading = true;
    location.reload();
  });

  const showBanner = (worker) => {
    const banner = $('update-banner');
    banner.hidden = false;
    document.getElementById('app').classList.add('has-banner');
    $('btn-update').onclick = () => {
      userAsked = true;
      $('btn-update').disabled = true;
      worker.postMessage({ type: 'SKIP_WAITING' });
    };
  };

  const ready = navigator.serviceWorker.register('./sw.js', { scope: './' }).then((reg) => {
    // mise à jour = un worker en attente alors que la page était déjà contrôlée par une version précédente.
    // `navigator.serviceWorker.controller` ne suffit pas : à la première installation, WebKit rattache la page
    // au nouveau worker (clients.claim) avant même de signaler « installed », worker encore en attente.
    const check = () => {
      const w = reg.waiting;
      if (w && controlled && w !== navigator.serviceWorker.controller) showBanner(w);
    };
    check();
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      if (worker) worker.addEventListener('statechange', check);
    });
    let lastCheck = Date.now();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || Date.now() - lastCheck < UPDATE_CHECK_MS) return;
      lastCheck = Date.now();
      reg.update().catch(() => {});  // hors ligne : sans importance
    });
    return reg;
  });
  ready.catch((err) => console.warn('service worker :', err));
  return ready;
}
