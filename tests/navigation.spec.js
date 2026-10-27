// Coquille (refonte Liquid Glass) : capsule d'onglets Préparer / Distribuer / Contrôler qui change le contenu
// d'une feuille à crans posée sur la carte, pages de la feuille, fiche d'adresse par-dessus l'onglet.
const { test, expect } = require('@playwright/test');
const { ID, GPS, STREET, tourTotal, tourStreets, trackErrors, openApp, waitReady, tapAddress, addressData, setDetent, openPage } = require('./helpers');

const tab = (page, name) => page.locator(`#tabbar [data-tab="${name}"]`);
const current = (page) => page.evaluate(() => window.neyronApp.tabs.current);
const detent = (page) => page.evaluate(() => window.neyronApp.panel.detent);
const panelHeight = (page) => page.evaluate(() => document.getElementById('panel').getBoundingClientRect().height);

async function mark(page, id, st) {
  await tapAddress(page, id);
  await page.click(`#sheet-actions [data-st="${st}"]`);
  await expect(page.locator('#sheet')).toBeHidden();
}

test('Distribuer par défaut, vues exclusives, carte et commandes toujours là, onglet mémorisé', async ({ page }) => {
  const errors = trackErrors(page);
  await openApp(page);
  await expect(tab(page, 'distribute')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#view-distribute')).toBeVisible();
  await expect(page.locator('#view-prepare')).toBeHidden();
  await expect(page.locator('#view-control')).toBeHidden();
  await expect(page.locator('#btn-locate')).toBeVisible();

  await tab(page, 'prepare').click();
  await expect(tab(page, 'prepare')).toHaveAttribute('aria-current', 'page');
  await expect(tab(page, 'distribute')).not.toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#view-prepare')).toBeVisible();
  await expect(page.locator('#view-distribute')).toBeHidden();
  await expect(page.locator('#btn-locate')).toBeVisible();  // la carte reste manipulable dans tous les onglets

  await tab(page, 'control').click();
  await expect(page.locator('#view-control')).toBeVisible();
  await expect(page.locator('#view-prepare')).toBeHidden();

  await page.reload();
  await waitReady(page);
  expect(await current(page)).toBe('control');
  await expect(page.locator('#view-control')).toBeVisible();
  expect(errors).toEqual([]);
});

test('feuille à crans : chaque onglet garde son cran, pages et retour, onglet touché à nouveau', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'grand écran : panneau latéral sans crans');
  await openApp(page);
  expect(await detent(page)).toBe('peek');
  const peek = await panelHeight(page);
  await setDetent(page, 'large');
  expect(await panelHeight(page)).toBeGreaterThan(peek + 200);
  await expect(page.locator('#btn-locate')).toBeHidden();  // grand cran : les boutons de la carte s'effacent
  await tab(page, 'prepare').click();
  expect(await detent(page)).toBe('medium');  // cran par défaut de Préparer
  await tab(page, 'distribute').click();
  expect(await detent(page)).toBe('large');   // Distribuer retrouve le sien

  // la poignée fait passer au cran suivant
  await setDetent(page, 'peek');
  await page.click('#panel .grabber');
  expect(await detent(page)).toBe('medium');

  // pages : ouvrir, revenir ; toucher l'onglet courant ramène à la page principale
  await openPage(page, 'prepare', '#prep-order-row');
  await expect(page.locator('#prep-order')).toBeVisible();
  await page.click('#view-prepare [data-page="order"] [data-back]');
  await expect(page.locator('#route-compute')).toBeVisible();  // retour à la page Itinéraire, d'où l'on venait
  await page.click('#view-prepare [data-page="route"] [data-back]');
  await expect(page.locator('#prep-tour-row')).toBeVisible();
  await page.click('#prep-checks-row');
  await expect(page.locator('#prep-checks')).toBeVisible();
  await tab(page, 'prepare').click();
  await expect(page.locator('#prep-tour-row')).toBeVisible();
});

test('glisser la feuille au doigt : la hauteur suit, puis se cale sur un cran', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'grand écran : panneau latéral sans crans');
  await openApp(page);
  const box = await page.locator('#panel .grabber').boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 120, { steps: 6 });
  await page.mouse.move(x, y - 400, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => detent(page)).toBe('large');
  // tiré vers le bas depuis l'en-tête : retour au petit cran ; le toucher qui suit un glisser ne compte pas
  const head = await page.locator('#view-distribute .nav').boundingBox();
  await page.mouse.move(head.x + 40, head.y + 20);
  await page.mouse.down();
  await page.mouse.move(head.x + 40, head.y + 600, { steps: 15 });
  await page.mouse.up();
  await expect.poll(() => detent(page)).toBe('peek');
});

test('Préparer : tournée active, rues de la commune, une rue s\'ouvre dans l\'éditeur', async ({ page }) => {
  await openApp(page);
  const { streets } = addressData();
  await tab(page, 'prepare').click();
  await expect(page.locator('#prep-tour-name')).toHaveText('Neyron — 10 rues');
  await expect(page.locator('#prep-summary')).toHaveText(`${tourTotal()} adresses · ${tourStreets().length} rues`);
  await expect(page.locator('#btn-tour-archive')).toBeDisabled();  // seule tournée en cours

  await openPage(page, 'prepare', '#prep-tour-row');
  await expect(page.locator('#tour-list .tour-row')).toHaveCount(1);
  await expect(page.locator('#tour-list .tour-row.active .vrow-name')).toHaveText('Neyron — 10 rues');
  await expect(page.locator('#tour-list .tour-row.active .vrow-sub')).toHaveText(`${tourTotal()} adresses · 0 distribuée`);

  await openPage(page, 'prepare', '#prep-streets-row');
  const rows = page.locator('#prep-streets .vrow');
  await expect(rows).toHaveCount(streets.length);
  const gare = rows.nth(STREET.gare);
  await expect(gare.locator('.vrow-name')).toHaveText('Rue de la Gare');
  await expect(gare.locator('.vrow-sub')).toHaveText('Neyron · 15/15 dans la tournée');
  await gare.click();
  await expect(page.locator('#street-editor')).toBeVisible();
  await expect(page.locator('#se-title')).toHaveText('Rue de la Gare');
  await page.click('#se-map');
  expect(await current(page)).toBe('prepare');  // la rue se montre sur le plan, sans quitter l'onglet
  expect(await page.evaluate(() => window.neyronApp.map.selectedStreet)).toBe(STREET.gare);
});

test('Contrôler : bilan et détail par rue, à jour en direct', async ({ page }) => {
  const errors = trackErrors(page);
  await openApp(page);
  await mark(page, ID.gare28, 'fait');
  await mark(page, ID.gare26, 'a_repasser');

  await tab(page, 'control').click();
  await expect(page.locator('#ctl-done')).toHaveText('1');
  await expect(page.locator('#ctl-again')).toHaveText('1');
  await expect(page.locator('#ctl-todo')).toHaveText(String(tourTotal() - 2));
  await expect(page.locator('#ctl-summary')).toHaveText(`1 / ${tourTotal()} adresses traitées`);
  await expect(page.locator('#ctl-pct')).toHaveText('0 %');
  await openPage(page, 'control', '#ctl-streets-row');
  const gare = page.locator('#ctl-streets .vrow', { hasText: 'Rue de la Gare' });
  await expect(gare.locator('.vrow-count')).toHaveText('1/151 ↻');
  await expect(gare.locator('.vrow-sub')).toHaveText('13 restantes');

  // Annuler (bouton posé sur la carte) : le bilan suit sans changer d'onglet
  await setDetent(page, 'medium');
  await page.click('#btn-undo');
  await expect(page.locator('#ctl-again')).toHaveText('0');
  await expect(page.locator('#ctl-todo')).toHaveText(String(tourTotal() - 1));

  // rue entière distribuée
  await page.evaluate(async (s) => {
    const { store, map } = window.neyronApp;
    await store.setStatus(map.pointable.filter((a) => a.s === s).map((a) => a.id), 'fait');
  }, STREET.barry);
  const barry = page.locator('#ctl-streets .vrow', { hasText: 'Chemin du Barry' });
  await expect(barry).toHaveClass(/complete/);
  await expect(barry.locator('.vrow-sub')).toHaveText('rue entière traitée');
  await expect(page.locator('#ctl-done')).toHaveText('4');
  expect(errors).toEqual([]);
});

test('menu ⋯ : sauvegarder la progression', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => { navigator.canShare = () => false; });
  await tab(page, 'control').click();
  await page.click('#btn-menu');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
  expect(download.suggestedFilename()).toMatch(/^neyron-tournees-export-\d{8}-\d{4}\.json$/);
});

test('fiche d\'adresse par-dessus l\'onglet, fermée en changeant d\'onglet ; le menu aussi', async ({ page }) => {
  await openApp(page);
  await tab(page, 'control').click();
  await tapAddress(page, ID.gare28);  // la carte reste touchable depuis Contrôler
  await expect(page.locator('#view-control')).toBeHidden();
  await page.click('#btn-sheet-close');
  await expect(page.locator('#view-control')).toBeVisible();  // retour à l'onglet d'où la fiche a été ouverte

  await tapAddress(page, ID.gare28);
  await tab(page, 'distribute').click();
  await expect(page.locator('#sheet')).toBeHidden();
  await expect(page.locator('#view-distribute')).toBeVisible();

  await page.click('#btn-menu');
  await expect(page.locator('#menu')).toBeVisible();
  await tab(page, 'prepare').click();
  await expect(page.locator('#menu')).toBeHidden();
});

test.describe('mise en page', () => {
  test.use({ permissions: ['geolocation'], geolocation: GPS.gare28 });

  test('la capsule d\'onglets ne recouvre ni le contenu de la feuille, ni les commandes', async ({ page }) => {
    await openApp(page);
    await page.click('#btn-locate');
    await expect(page.locator('#nearby')).toBeAttached();
    const bar = await page.locator('#tabbar').boundingBox();
    const bottom = async (sel) => { const b = await page.locator(sel).boundingBox(); return b.y + b.height; };
    expect(await bottom('.mapctl')).toBeLessThanOrEqual(bar.y);
    // le contenu qui défile s'arrête au-dessus de la capsule
    expect(await bottom('#view-distribute .page-body')).toBeLessThanOrEqual(bar.y + 0.5);
    await tapAddress(page, ID.gare28);
    expect(await bottom('#sheet .page-body')).toBeLessThanOrEqual(bar.y + 0.5);
    expect(await bottom('#sheet-actions')).toBeLessThanOrEqual(bar.y);
    // cibles tactiles d'au moins 44 px
    for (const name of ['prepare', 'distribute', 'control']) {
      const b = await tab(page, name).boundingBox();
      expect(Math.min(b.width, b.height)).toBeGreaterThanOrEqual(44);
    }
  });
});
