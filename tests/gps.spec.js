// Cas 4 : position simulée sur la Rue de la Gare, encart des adresses les plus proches.
const { test, expect } = require('@playwright/test');
const { ID, GPS, addressData, trackErrors, openApp, statusOf } = require('./helpers');

// les n adresses pointables les plus proches d'une adresse, calculées sur les données du pipeline
function nearestIds(id, n = 3, exclude = []) {
  const { addresses } = addressData();
  const o = addresses.find((a) => a.id === id);
  return addresses.filter((a) => !a.ctx && !exclude.includes(a.id))
    .map((a) => ({ id: a.id, d: Math.hypot(a.x - o.x, a.y - o.y) }))
    .sort((p, q) => p.d - q.d).slice(0, n).map((p) => p.id);
}
const rowIds = (page) => page.evaluate(() => [...document.querySelectorAll('#nearby-list .nb-row')]
  .filter((r) => !r.hidden).map((r) => r.dataset.id));
const firstRow = (page) => page.locator('#nearby-list .nb-row').first();
// écart en pixels entre une adresse et le centre de la zone visible de la carte
const centerError = (page, id) => page.evaluate((id) => {
  const { map } = window.neyronApp;
  const a = map.byId.get(id);
  const r = map.container.getBoundingClientRect();
  const p = map.padding;
  const [sx, sy] = map.toScreen(a.x, a.y);
  return Math.hypot(sx - (r.left + (r.width + p.left - p.right) / 2), sy - (r.top + (r.height + p.top - p.bottom) / 2));
}, id);

test.describe('GPS autorisé', () => {
  test.use({ permissions: ['geolocation'], geolocation: GPS.gare28 });

  test('position sur le 28 Rue de la Gare : l\'encart propose les bons numéros', async ({ page }) => {
    const errors = trackErrors(page);
    await openApp(page);
    await page.click('#btn-locate');
    await expect(page.locator('#btn-locate')).toHaveAttribute('data-mode', 'on');
    await expect(page.locator('#nearby')).toBeVisible();
    await expect(page.locator('#gps-status')).toHaveText('Précision ± 6 m');
    await expect(page.locator('#gps-indicator')).toHaveClass('gps-ind q-good');

    const expected = nearestIds(ID.gare28);
    await expect.poll(() => rowIds(page)).toEqual(expected);
    await expect(firstRow(page).locator('.nb-label')).toHaveText('28 Rue de la Gare');
    await expect(firstRow(page).locator('.nb-dist')).toHaveText('0 m');
    await expect.poll(() => centerError(page, ID.gare28), 'carte centrée sur la position').toBeLessThan(3);

    // « Fait » depuis l'encart : le 28 sort de la liste, remplacé par le suivant
    await firstRow(page).locator('.nb-done').click();
    await expect.poll(() => statusOf(page, ID.gare28)).toBe('fait');
    await expect.poll(() => rowIds(page)).toEqual(nearestIds(ID.gare28, 3, [ID.gare28]));
    await expect(page.locator('#toast-msg')).toContainText('28 Rue de la Gare : fait');

    // nom de l'adresse : ouvre le panneau, l'encart s'efface pendant ce temps
    await firstRow(page).locator('.nb-name').click();
    await expect(page.locator('#sheet')).toBeVisible();
    await expect(page.locator('#nearby')).toBeHidden();
    await page.click('#btn-sheet-close');
    await expect(page.locator('#nearby')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('suivre la position, puis glisser la carte coupe le suivi', async ({ page, context }) => {
    await openApp(page);
    await page.click('#btn-locate');
    await expect(page.locator('#btn-locate')).toHaveAttribute('data-mode', 'on');
    await page.click('#btn-locate');
    await expect(page.locator('#btn-locate')).toHaveAttribute('aria-pressed', 'true');

    await context.setGeolocation(GPS.gare9);
    await expect.poll(() => rowIds(page)).toEqual(nearestIds(ID.gare9));
    await expect.poll(() => centerError(page, ID.gare9), 'carte recentrée sur la nouvelle position').toBeLessThan(3);

    const box = await page.locator('#map').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 250);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + 290, { steps: 5 });
    await page.mouse.up();
    await expect(page.locator('#btn-locate')).toHaveAttribute('data-mode', 'on');

    // troisième tap : arrêt, encart et point masqués
    await page.click('#btn-locate');
    await expect(page.locator('#btn-locate')).toHaveAttribute('data-mode', 'follow');
    await page.click('#btn-locate');
    await expect(page.locator('#btn-locate')).toHaveAttribute('data-mode', 'off');
    await expect(page.locator('#nearby')).toBeHidden();
    await expect(page.locator('#map .l-gps')).toHaveAttribute('display', 'none');
  });

  test('précision médiocre, hors du plan, position ancienne et relance', async ({ page, context }) => {
    await openApp(page);
    await page.click('#btn-locate');
    await expect(page.locator('#gps-status')).toHaveText('Précision ± 6 m');

    // (position légèrement décalée : Chromium ignore une position identique, cf. CLAUDE.md §10)
    await context.setGeolocation({ ...GPS.gare28, latitude: GPS.gare28.latitude + 0.00002, accuracy: 45 });
    await expect(page.locator('#gps-indicator')).toHaveClass(/q-bad/);
    await expect(page.locator('#map .l-gps')).toHaveClass(/q-bad/);

    await context.setGeolocation(GPS.lyon);
    await expect(page.locator('#gps-status')).toHaveText(/^Hors du plan \(\d+,\d km\)$/);
    await expect(page.locator('#nearby-list')).toBeHidden();

    await context.setGeolocation(GPS.gare28);
    await expect(page.locator('#gps-status')).toHaveText('Précision ± 6 m');
    await page.evaluate(() => { const g = window.neyronApp.gps; g.tracker.lastFixAt -= 20_000; g.refresh(); });
    await expect(page.locator('#gps-status')).toHaveText(/^Position ancienne/);
    await expect(page.locator('#map .l-gps')).toHaveClass(/q-stale/);

    // retour au premier plan après plus de 10 s sans position : watchPosition relancé
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => page.evaluate(() => window.neyronApp.gps.tracker.restarts)).toBe(1);
    await expect(page.locator('#gps-status')).not.toHaveText(/^Position ancienne/);
  });
});

test('GPS refusé : message et retour à l\'arrêt', async ({ page }) => {
  await openApp(page);
  await page.click('#btn-locate');
  await expect(page.locator('#toast-msg')).toContainText('Localisation refusée');
  await expect(page.locator('#toast-msg')).toContainText('Sites web Safari');
  await expect(page.locator('#btn-locate')).toHaveAttribute('data-mode', 'off');
});

test('page en HTTP (ex. adresse IP du Wi-Fi) : le message parle de HTTPS, pas des réglages', async ({ page, context }) => {
  await context.addInitScript(() => Object.defineProperty(window, 'isSecureContext', { get: () => false }));
  await openApp(page);
  await page.click('#btn-locate');
  await expect(page.locator('#toast-msg')).toContainText('exige une connexion HTTPS');
  await expect(page.locator('#btn-locate')).toHaveAttribute('data-mode', 'off');
});
