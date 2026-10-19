// Panneau debug : activation (?debug=1, 5 taps sur la version), diagnostic, position simulée, erreurs.
const { test, expect } = require('@playwright/test');
const { ID, GPS, addressData, trackErrors, openApp } = require('./helpers');

const panel = (page) => page.locator('#debug');
const body = (page) => page.locator('#debug .debug-body');

// appui long (750 ms sans bouger) sur un numéro
async function longPressOn(page, id) {
  const [x, y] = await page.evaluate((id) => {
    const { map } = window.neyronApp;
    const a = map.byId.get(id);
    map.setView(a.x, a.y, 3);
    return map.toScreen(a.x, a.y);
  }, id);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(750);
  await page.mouse.up();
}

test('sans debug : pas de panneau, l\'appui long ne simule rien', async ({ page }) => {
  await openApp(page);
  await expect(panel(page)).toHaveCount(0);
  await longPressOn(page, ID.gare28);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.neyronApp.gps.mode)).toBe('off');
});

test('?debug=1 : diagnostic affiché, choix mémorisé, ?debug=0 désactive', async ({ page }) => {
  const errors = trackErrors(page);
  await openApp(page, './?debug=1');
  await expect(panel(page)).toBeVisible();
  await expect(body(page)).toContainText(`version données : ${addressData().version}`);
  await expect(body(page)).toContainText(/version app : [0-9a-f]{8}/);
  await expect(body(page)).toContainText(/persist\(\) : (true|false)/);
  await expect(body(page)).toContainText(/occupation : [\d,\s  ]+ Mo \/ [\d,\s  ]+ Mo/);
  await expect(body(page)).toContainText('affichage : navigateur');
  await expect(body(page)).toContainText(/\[Service worker\]\nétat : (active|installing|waiting): \w+/);
  await expect(body(page)).toContainText(/état : (non supporté|inactif)/);  // écran allumé

  await openApp(page, './');
  await expect(panel(page)).toBeVisible();
  await openApp(page, './?debug=0');
  await expect(panel(page)).toHaveCount(0);
  await openApp(page, './');
  await expect(panel(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('appui long = position simulée exactement sur le numéro', async ({ page }) => {
  await openApp(page, './?debug=1');
  await page.click('#debug .debug-toggle');  // panneau réduit, comme sur le téléphone
  await longPressOn(page, ID.gare28);
  await expect(page.locator('#gps-status')).toContainText('(simulée)');
  expect(await page.evaluate(() => window.neyronApp.gps.mode)).toBe('on');
  const first = page.locator('#nearby-list .nb-row').first();
  await expect(first.locator('.nb-label')).toHaveText('28 Rue de la Gare');
  await expect(first.locator('.nb-dist')).toHaveText('0 m');
  await page.click('#debug .debug-toggle');
  await expect(body(page)).toContainText('position : simulation');

  // une position simulée ne vieillit pas
  await page.evaluate(() => { window.neyronApp.gps.tracker.lastFixAt -= 30_000; window.neyronApp.gps.refresh(); });
  await expect(page.locator('#gps-status')).not.toHaveText(/^Position ancienne/);
});

test('erreurs JS reprises dans le panneau, diagnostic copié sans la position', async ({ page, context, browserName }) => {
  if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation(GPS.gare28);
  await openApp(page, './?debug=1');
  await expect(body(page)).toContainText('contexte sécurisé : oui');
  await page.click('#btn-locate');
  await expect(body(page)).toContainText(`lat / lon : ${GPS.gare28.latitude.toFixed(6)}`);  // visible sur l'appareil
  await page.evaluate(() => {
    setTimeout(() => { throw new Error('erreur-de-test'); }, 0);
    Promise.reject(new Error('rejet-de-test'));
  });
  await expect(body(page)).toContainText('erreur-de-test');
  await expect(body(page)).toContainText('promesse rejetée : rejet-de-test');

  await page.click('#debug .debug-copy');
  await expect(page.locator('#toast-msg')).not.toBeEmpty();
  if (browserName === 'chromium') {  // presse-papiers lisible seulement dans Chromium
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toMatch(/^Tournées de Neyron — diagnostic/);
    expect(clip).toContain('[GPS]');
    expect(clip).toContain('erreur-de-test');
    expect(clip).toContain('lat / lon : masqué dans la copie');
    expect(clip).toContain('plan x / y : masqué dans la copie');
    expect(clip).not.toContain('45.81');
  }
  // texte préparé pour la copie, dans les deux moteurs (presse-papiers illisible sous WebKit)
  const copied = await page.evaluate(() => window.neyronApp.debug.text(true));
  expect(copied).toContain('lat / lon : masqué dans la copie');
  expect(copied).not.toContain('45.81');

  await page.click('#debug .debug-toggle');
  await expect(body(page)).toBeHidden();
  await page.click('#debug .debug-toggle');
  await expect(body(page)).toBeVisible();
});

test('5 taps sur la version du menu : debug activé puis désactivé (app installée)', async ({ page }) => {
  await openApp(page);
  await page.click('#btn-menu');
  const version = page.locator('#menu-version');
  await version.click({ clickCount: 5 });  // 5 taps rapides (fenêtre de 3 s)
  await expect(panel(page)).toBeVisible();
  await expect(page.locator('#toast-msg')).toHaveText('Mode debug activé');
  await version.click({ clickCount: 5 });
  await expect(panel(page)).toHaveCount(0);
});
