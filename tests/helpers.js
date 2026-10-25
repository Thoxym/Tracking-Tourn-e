// Outils partagés des tests : ouverture de l'app, tap sur un numéro, données de référence.
const fs = require('fs');
const path = require('path');
const { expect } = require('@playwright/test');

const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const DOCS = path.join(__dirname, '..', 'docs');
const SERVE = path.join(__dirname, 'serve.py');  // serveur statique des tests

// identifiants BAN (clés de progression) et positions utilisées par plusieurs tests
const ID = {
  gare28: '01275_0420_00028',
  gare26: '01275_0420_00026',
  gare21: '01275_0420_00021',
  gare14: '01275_0420_00014',
  gare9: '01275_0420_00009',
};
// rues : index dans l'ordre alphabétique des données (recherchés par nom, stables d'un build à l'autre)
const streetIndex = (name) => addressData().streets.findIndex((s) => s.name === name);
const STREET = {
  get gare() { return streetIndex('Rue de la Gare'); },
  get barry() { return streetIndex('Chemin du Barry'); },
};
// nombre d'adresses de la commune (toutes affichées sur le plan)
const total = () => addressData().addresses.filter((a) => !a.ctx).length;
// tournée active au premier lancement : preset « default » (les 10 rues de la v0.1)
const tourIds = () => new Set(addressData().presets.find((p) => p.id === 'default').ids);
const tourTotal = () => tourIds().size;
// rues ayant au moins une adresse dans la tournée par défaut, et leur compte
const tourStreets = () => {
  const ids = tourIds();
  return addressData().streets.map((st) => ({ ...st, inTour: addressData().addresses.filter((a) => a.s === st.i && ids.has(a.id)).length }))
    .filter((st) => st.inTour > 0);
};
const GPS = {
  gare28: { latitude: 45.81218, longitude: 4.929406, accuracy: 6 },  // point BAN du 28 Rue de la Gare
  gare9: { latitude: 45.814024, longitude: 4.932176, accuracy: 6 },   // point BAN du 9 Rue de la Gare
  lyon: { latitude: 45.764, longitude: 4.8357, accuracy: 8 },
};

let data = null;
// données générées par le pipeline, pour calculer les attendus indépendamment de l'app
function addressData() {
  data ??= JSON.parse(fs.readFileSync(path.join(DOCS, 'data', 'addresses.json'), 'utf-8'));
  return data;
}

// erreurs JS et console.error de la page : vérifiées en fin de test
function trackErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return errors;
}

async function waitReady(page) {
  await page.waitForFunction(
    () => window.neyronApp?.map?._ready && document.getElementById('loading').hidden,
    null, { timeout: 30_000 });  // machine chargée : un démarrage WebKit peut dépasser 15 s (CLAUDE.md §10)
}

async function openApp(page, url = './') {
  await page.goto(url);
  await waitReady(page);
}

// Tape un numéro comme un doigt : zoom dessus, centré dans la partie visible du plan (hors feuille), puis tap à
// sa position écran calculée par la carte (le boundingBox() des <text> SVG est faux sous WebKit, cf. CLAUDE.md §10).
async function tapAddress(page, id, { sheet = true } = {}) {
  const [x, y] = await page.evaluate((id) => {
    const { map, panel } = window.neyronApp;
    if (panel.detent === 'large') panel.setDetent('medium');  // le grand cran recouvre le plan
    const a = map.byId.get(id);
    map._stopAnim();  // une animation en cours (recentrage) déplacerait la carte sous le doigt
    map.setView(a.x, a.y, 3);
    map.centerOn(a.x, a.y, { minK: 3, animate: false });
    return map.toScreen(a.x, a.y);
  }, id);
  await page.mouse.click(x, y);
  if (sheet) await expect(page.locator('#sheet')).toBeVisible();
}

// feuille posée sur la carte : cran (peek, medium, large)
const setDetent = (page, d) => page.evaluate((d) => window.neyronApp.panel.setDetent(d), d);

const statusOf = (page, id) => page.evaluate((id) => window.neyronApp.store.status(id), id);
const stateOf = (page) => page.evaluate(() => JSON.stringify([...window.neyronApp.store.state].sort()));
// « 1/15 » suivi de « 1 ↻ » (à repasser) s'il y en a
const legendCount = (page, s) => page.locator(`.lg-row[data-s="${s}"] .lg-count`);

// rues de la tournée (ancienne légende) : section de l'onglet Distribuer, feuille au grand cran
async function openLegend(page) {
  await page.evaluate(() => {
    const { tabs, ui, panel } = window.neyronApp;
    ui.closeSheet();
    tabs.select('distribute');
    panel.setDetent('large');
  });
  await expect(page.locator('#legend')).toBeVisible();
}

// ouvre une page de la feuille par sa ligne (bouton data-push), dans l'onglet donné
async function openPage(page, tab, row) {
  const button = page.locator(`#tabbar [data-tab="${tab}"]`);
  await button.click();
  // l'onglet retrouve la page où on l'avait laissé : le toucher à nouveau ramène à sa page principale
  const root = () => page.evaluate(() => {
    const { panel, tabs, ui } = window.neyronApp;
    return !ui.sheetAddress && panel.page(tabs.view()).dataset.page === 'root';
  });
  if (!(await root())) await button.click();
  if (!(await root())) await button.click();  // fiche d'adresse fermée, puis page principale
  await setDetent(page, 'large');
  await page.click(row);
}

module.exports = {
  PYTHON, DOCS, SERVE, ID, STREET, GPS, total, tourIds, tourTotal, tourStreets, streetIndex,
  addressData, trackErrors, waitReady, openApp, tapAddress, statusOf, stateOf, legendCount, openLegend, setDetent, openPage,
};
