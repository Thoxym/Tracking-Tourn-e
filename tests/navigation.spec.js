// Barre d'onglets Préparer / Distribuer / Contrôler (branche facteur, phase L1).
const { test, expect } = require('@playwright/test');
const { ID, GPS, STREET, trackErrors, openApp, waitReady, tapAddress, addressData } = require('./helpers');

const tab = (page, name) => page.locator(`#tabbar [data-tab="${name}"]`);
const current = (page) => page.evaluate(() => window.neyronApp.tabs.current);

async function mark(page, id, st) {
  await tapAddress(page, id);
  await page.click(`#sheet-actions [data-st="${st}"]`);
  await expect(page.locator('#sheet')).toBeHidden();
}

test('Distribuer par défaut, vues exclusives, onglet mémorisé', async ({ page }) => {
  const errors = trackErrors(page);
  await openApp(page);
  await expect(tab(page, 'distribute')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#view-prepare')).toBeHidden();
  await expect(page.locator('#view-control')).toBeHidden();
  await expect(page.locator('#btn-locate')).toBeVisible();

  await tab(page, 'prepare').click();
  await expect(tab(page, 'prepare')).toHaveAttribute('aria-current', 'page');
  await expect(tab(page, 'distribute')).not.toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#view-prepare')).toBeVisible();
  await expect(page.locator('#view-control')).toBeHidden();
  await expect(page.locator('#btn-locate')).toBeHidden();  // commandes de la carte masquées hors Distribuer

  await tab(page, 'control').click();
  await expect(page.locator('#view-control')).toBeVisible();
  await expect(page.locator('#view-prepare')).toBeHidden();

  await page.reload();
  await waitReady(page);
  expect(await current(page)).toBe('control');
  await expect(page.locator('#view-control')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Préparer : les rues de la tournée, une rue s\'ouvre sur la carte', async ({ page }) => {
  await openApp(page);
  await tab(page, 'prepare').click();
  const { streets } = addressData();
  await expect(page.locator('#prep-summary')).toHaveText(`Tournée · ${streets.length} rues · 229 adresses`);
  const rows = page.locator('#prep-streets .vrow');
  await expect(rows).toHaveCount(streets.length);
  const gare = rows.nth(STREET.gare);
  await expect(gare.locator('.vrow-name')).toHaveText('Rue de la Gare');
  await expect(gare.locator('.vrow-sub')).toHaveText('10 pairs · 5 impairs');
  await expect(gare.locator('.vrow-count')).toHaveText('15 numéros');

  await gare.click();
  expect(await current(page)).toBe('distribute');
  await expect(page.locator('#view-prepare')).toBeHidden();
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
  await expect(page.locator('#ctl-todo')).toHaveText('227');
  await expect(page.locator('#ctl-summary')).toHaveText('1 / 229 adresses faites · 0 %');
  const gare = page.locator('#ctl-streets .vrow').nth(STREET.gare);
  await expect(gare.locator('.vrow-count')).toHaveText('1/151 ↻');
  await expect(gare.locator('.vrow-sub')).toHaveText('13 restantes');

  // Annuler depuis la barre du haut : le bilan suit sans changer d'onglet
  await page.click('#btn-undo');
  await expect(page.locator('#ctl-again')).toHaveText('0');
  await expect(page.locator('#ctl-todo')).toHaveText('228');

  // rue entière faite
  await page.evaluate(async (s) => {
    const { store, map } = window.neyronApp;
    await store.setStatus(map.pointable.filter((a) => a.s === s).map((a) => a.id), 'fait');
  }, STREET.barry);
  const barry = page.locator('#ctl-streets .vrow').nth(STREET.barry);
  await expect(barry).toHaveClass(/complete/);
  await expect(barry.locator('.vrow-sub')).toHaveText('rue entière faite');
  await expect(page.locator('#ctl-done')).toHaveText('4');
  expect(errors).toEqual([]);
});

test('Contrôler : exporter la progression', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => { navigator.canShare = () => false; });
  await tab(page, 'control').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#ctl-export')]);
  expect(download.suggestedFilename()).toMatch(/^neyron-tournees-export-\d{8}-\d{4}\.json$/);
});

test('changer d\'onglet ferme le panneau d\'adresse et le menu', async ({ page }) => {
  await openApp(page);
  await tapAddress(page, ID.gare28);
  await tab(page, 'control').click();
  await expect(page.locator('#sheet')).toBeHidden();
  await tab(page, 'distribute').click();
  await expect(page.locator('#sheet')).toBeHidden();

  await page.click('#btn-menu');
  await expect(page.locator('#menu')).toBeVisible();
  await tab(page, 'prepare').click();
  await expect(page.locator('#menu')).toBeHidden();
});

test('« Rues » depuis un autre onglet : retour à la carte, légende ouverte', async ({ page }) => {
  await openApp(page);
  await tab(page, 'control').click();
  await page.click('#btn-legend');
  expect(await current(page)).toBe('distribute');
  await expect(page.locator('#legend')).toBeVisible();
});

test.describe('mise en page', () => {
  test.use({ permissions: ['geolocation'], geolocation: GPS.gare28 });

  test('la barre ne recouvre ni la carte, ni ses commandes, ni les panneaux', async ({ page }) => {
    await openApp(page);
    await page.click('#btn-locate');
    await expect(page.locator('#nearby')).toBeVisible();
    const bar = await page.locator('#tabbar').boundingBox();
    const bottom = async (sel) => { const b = await page.locator(sel).boundingBox(); return b.y + b.height; };
    expect(await bottom('#map')).toBeLessThanOrEqual(bar.y + 0.5);
    expect(await bottom('.mapctl')).toBeLessThanOrEqual(bar.y);
    expect(await bottom('#nearby')).toBeLessThanOrEqual(bar.y);
    await tapAddress(page, ID.gare28);
    await expect.poll(() => bottom('#sheet'), 'fin de l\'animation d\'entrée').toBeLessThanOrEqual(bar.y);
    // cibles tactiles d'au moins 44 px
    for (const name of ['prepare', 'distribute', 'control']) {
      const b = await tab(page, name).boundingBox();
      expect(Math.min(b.width, b.height)).toBeGreaterThanOrEqual(44);
    }
  });
});
