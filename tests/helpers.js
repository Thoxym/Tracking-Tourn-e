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
const STREET = { gare: 2, barry: 7 };
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
    null, { timeout: 15_000 });
}

async function openApp(page, url = './') {
  await page.goto(url);
  await waitReady(page);
}

// Tape un numéro comme un doigt : zoom dessus, puis tap à sa position écran calculée par la carte
// (le boundingBox() des <text> SVG est faux sous WebKit, cf. CLAUDE.md §10).
async function tapAddress(page, id) {
  const [x, y] = await page.evaluate((id) => {
    const { map } = window.neyronApp;
    const a = map.byId.get(id);
    map.setView(a.x, a.y, 3);
    return map.toScreen(a.x, a.y);
  }, id);
  await page.mouse.click(x, y);
  await expect(page.locator('#sheet')).toBeVisible();
}

const statusOf = (page, id) => page.evaluate((id) => window.neyronApp.store.status(id), id);
const stateOf = (page) => page.evaluate(() => JSON.stringify([...window.neyronApp.store.state].sort()));
// « 1/15 » suivi de « 1 ↻ » (à repasser) s'il y en a
const legendCount = (page, s) => page.locator(`.lg-row[data-s="${s}"] .lg-count`);

async function openLegend(page) {
  if (await page.locator('#legend').isHidden()) await page.click('#btn-legend');
  await expect(page.locator('#legend')).toBeVisible();
}

module.exports = {
  PYTHON, DOCS, SERVE, ID, STREET, GPS,
  addressData, trackErrors, waitReady, openApp, tapAddress, statusOf, stateOf, legendCount, openLegend,
};
