// Applique le thème choisi avant le premier affichage (script classique, bloquant, sans inline : CSP).
try {
  var t = localStorage.getItem('neyron-tournees.theme');
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
} catch (e) { /* stockage indisponible : thème automatique */ }
