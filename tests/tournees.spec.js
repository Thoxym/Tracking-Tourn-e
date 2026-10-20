// Tournées (branche facteur, phase L3) : migration de la v0.1, création, composition par rue ou sur la carte,
// progression propre à chaque tournée, renommer / archiver / restaurer, export et import.
const fs = require('fs');
const { test, expect } = require('@playwright/test');
const { ID, STREET, addressData, total, tourTotal, trackErrors, openApp, waitReady, tapAddress, statusOf } = require('./helpers');

const tab = (page, name) => page.locator(`#tabbar [data-tab="${name}"]`);
const activeTour = (page) => page.evaluate(() => {
  const t = window.neyronApp.store.activeTour;
  return { id: t.id, name: t.name, n: t.ids.length };
});
const streetRow = (page, i) => page.locator('#prep-streets .vrow').nth(i);

// tap à la position d'une adresse, sans attendre le panneau (composition sur la carte)
async function tapAt(page, id) {
  const [x, y] = await page.evaluate((id) => {
    const { map } = window.neyronApp;
    const a = map.byId.get(id);
    map._stopAnim();  // une animation en cours (recentrage) déplacerait la carte sous le doigt
    map.setView(a.x, a.y, 3);
    return map.toScreen(a.x, a.y);
  }, id);
  await page.mouse.click(x, y);
}

async function newTour(page, name) {
  await tab(page, 'prepare').click();
  await page.click('#btn-tour-new');
  await expect(page.locator('#prompt')).toHaveJSProperty('open', true);
  await expect(page.locator('#prompt-input')).toHaveValue(/^Tournée du \d\d\/\d\d$/);
  await page.locator('#prompt-input').fill(name);
  await page.click('#prompt-ok');
  await expect(page.locator('#prep-tour-name')).toHaveText(name);
}

// éditeur de rue : côté, plage, puis Ajouter ou Retirer
async function editStreet(page, i, { side = 'all', from = '', to = '' } = {}, action = 'add') {
  await tab(page, 'prepare').click();
  await streetRow(page, i).click();
  await expect(page.locator('#street-editor')).toHaveJSProperty('open', true);
  await page.click(`#street-editor .seg input[value="${side}"] + span`);
  await page.locator('#se-from').fill(String(from));
  await page.locator('#se-to').fill(String(to));
  await page.click(action === 'add' ? '#se-add' : '#se-remove');
  await expect(page.locator('#street-editor')).toHaveJSProperty('open', false);
}

const streetAddrs = (i, { side = 'all', from = -Infinity, to = Infinity } = {}) => addressData().addresses
  .filter((a) => a.s === i && (side === 'all' || a.side === side) && a.n >= from && a.n <= to);

test('migration v0.1 : la tournée « default » reçoit les 10 rues, sa progression est conservée', async ({ page }) => {
  // base IndexedDB telle que la v0.1 la laisse : tournée sans composition, deux pointages
  await page.goto('./manifest.webmanifest');
  await page.evaluate(({ gare28, gare26 }) => new Promise((resolve, reject) => {
    const req = indexedDB.open('neyron-tournees', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('events', { keyPath: ['dev', 'seq'] }).createIndex('tour', 'tour');
      db.createObjectStore('tours', { keyPath: 'id' });
      db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(['events', 'tours', 'meta'], 'readwrite');
      tx.objectStore('tours').put({ id: 'default', name: 'Tournée', createdAt: 1, archived: false });
      for (const [key, value] of [['deviceId', 'olddev'], ['seq', 2], ['activeTour', 'default']]) tx.objectStore('meta').put({ key, value });
      const t = Date.now();
      tx.objectStore('events').add({ dev: 'olddev', seq: 1, t: t - 2000, tour: 'default', ids: [gare28], st: 'fait', grp: 'olddev:1' });
      tx.objectStore('events').add({ dev: 'olddev', seq: 2, t: t - 1000, tour: 'default', ids: [gare26], st: 'a_repasser', grp: 'olddev:2' });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  }), { gare28: ID.gare28, gare26: ID.gare26 });

  const errors = trackErrors(page);
  await openApp(page);
  expect(await activeTour(page)).toEqual({ id: 'default', name: 'Neyron — 10 rues', n: tourTotal() });
  expect(await statusOf(page, ID.gare28)).toBe('fait');
  expect(await statusOf(page, ID.gare26)).toBe('a_repasser');
  await expect(page.locator('#total-progress')).toHaveText(`1/${tourTotal()}`);
  await expect(page.locator('#btn-undo')).toBeEnabled();  // même appareil : la pile d'annulation suit
  await expect(page.locator('#map text.num.out')).toHaveCount(total() - tourTotal());
  // la migration est enregistrée : relance sans repasser par le preset
  await page.reload();
  await waitReady(page);
  expect(await activeTour(page)).toEqual({ id: 'default', name: 'Neyron — 10 rues', n: tourTotal() });
  expect(errors).toEqual([]);
});

test('hors de la tournée active : en gris et non pointable', async ({ page }) => {
  await openApp(page);
  // adresse hors tournée sans adresse de la tournée à moins de 15 m (rayon de tap : 7 m à ce zoom)
  const id = await page.evaluate(() => {
    const { map } = window.neyronApp;
    const inside = map.pointable.filter((a) => map.inScope(a));
    return map.pointable.find((o) => !map.inScope(o) && inside.every((a) => Math.hypot(a.x - o.x, a.y - o.y) > 15)).id;
  });
  expect(await page.evaluate((id) => window.neyronApp.map.addrEls.get(id).num.getAttribute('class'), id)).toContain('out');
  await tapAt(page, id);
  await page.waitForTimeout(500);
  await expect(page.locator('#sheet')).toBeHidden();
});

test('nouvelle tournée composée par rue : côté, plage, retrait', async ({ page }) => {
  const errors = trackErrors(page);
  await openApp(page);
  await newTour(page, 'Mardi');
  expect(await activeTour(page)).toMatchObject({ name: 'Mardi', n: 0 });
  await expect(page.locator('#tour-list .tour-row')).toHaveCount(2);
  await expect(page.locator('#prep-summary')).toHaveText(/^Tournée vide/);
  await expect(page.locator('#total-progress')).toHaveText('0/0');

  // carte : tout est hors tournée ; légende : message de tournée vide
  await tab(page, 'distribute').click();
  await expect(page.locator('#map text.num.out')).toHaveCount(total());
  if (await page.locator('#legend').isHidden()) await page.click('#btn-legend');
  await expect(page.locator('#legend-empty')).toHaveText('Tournée vide : composez-la dans l\'onglet Préparer.');

  // Rue de la Gare, côté pair
  const pairs = streetAddrs(STREET.gare, { side: 'pair' });
  await tab(page, 'prepare').click();
  await streetRow(page, STREET.gare).click();
  await page.click('#street-editor .seg input[value="pair"] + span');
  await expect(page.locator('#se-preview')).toHaveText(`${pairs.length} numéros concernés · 0 déjà dans la tournée`);
  await page.click('#se-add');
  await expect(page.locator('#toast-msg')).toHaveText(`Rue de la Gare : ${pairs.length} numéros ajoutés`);
  await expect(page.locator('#prep-summary')).toHaveText(`${pairs.length} adresses · 1 rue`);
  await expect(streetRow(page, STREET.gare).locator('.vrow-sub')).toHaveText(`${pairs.length}/15 dans la tournée`);

  // côté impair, n° 1 à 9 seulement
  const odd = streetAddrs(STREET.gare, { side: 'impair', from: 1, to: 9 });
  await editStreet(page, STREET.gare, { side: 'impair', from: 1, to: 9 });
  expect(await activeTour(page)).toMatchObject({ n: pairs.length + odd.length });
  await expect(page.locator('#total-progress')).toHaveText(`0/${pairs.length + odd.length}`);
  await tab(page, 'distribute').click();
  await expect(page.locator('#map text.num:not(.out)')).toHaveCount(pairs.length + odd.length);

  // retirer toute la rue
  await editStreet(page, STREET.gare, {}, 'remove');
  expect(await activeTour(page)).toMatchObject({ n: 0 });
  expect(errors).toEqual([]);
});

test('progression propre à chaque tournée', async ({ page }) => {
  await openApp(page);
  await newTour(page, 'Mardi');
  await editStreet(page, STREET.gare);
  await tab(page, 'distribute').click();
  await tapAddress(page, ID.gare28);
  await page.click('#sheet-actions [data-st="fait"]');
  expect(await statusOf(page, ID.gare28)).toBe('fait');

  // la tournée « Neyron — 10 rues » contient aussi le 28 : à faire dans celle-là
  await tab(page, 'prepare').click();
  await page.locator('#tour-list .tour-row', { hasText: 'Neyron — 10 rues' }).click();
  expect(await activeTour(page)).toMatchObject({ id: 'default' });
  expect(await statusOf(page, ID.gare28)).toBe('a_faire');
  await expect(page.locator('#btn-undo')).toBeDisabled();  // pile d'annulation de la tournée active
  await expect(page.locator('#tour-list .tour-row', { hasText: 'Mardi' }).locator('.vrow-sub')).toHaveText('15 adresses · 1 distribuée');

  await page.locator('#tour-list .tour-row', { hasText: 'Mardi' }).click();
  expect(await statusOf(page, ID.gare28)).toBe('fait');
  await page.reload();
  await waitReady(page);
  expect(await activeTour(page)).toMatchObject({ name: 'Mardi' });  // tournée active mémorisée
  expect(await statusOf(page, ID.gare28)).toBe('fait');
});

test('renommer, archiver, restaurer', async ({ page }) => {
  await openApp(page);
  await newTour(page, 'Mardi');
  await page.click('#btn-tour-rename');
  await page.locator('#prompt-input').fill('Mardi matin');
  await page.locator('#prompt-input').press('Enter');  // Entrée valide
  await expect(page.locator('#prep-tour-name')).toHaveText('Mardi matin');
  await expect(page.locator('#tour-list .tour-row.active .vrow-name')).toHaveText('Mardi matin');

  await page.click('#btn-tour-archive');
  await expect(page.locator('#confirm-msg')).toContainText('Archiver « Mardi matin »');
  await page.click('#confirm-ok');
  await expect(page.locator('#prep-tour-name')).toHaveText('Neyron — 10 rues');
  await expect(page.locator('#tour-list .tour-row')).toHaveCount(1);
  await expect(page.locator('#tour-archived')).toBeVisible();
  await expect(page.locator('#tour-archived-n')).toHaveText('1');
  await expect(page.locator('#btn-tour-archive')).toBeDisabled();  // dernière tournée en cours

  await page.click('#tour-archived summary');
  await page.locator('#tour-archived-list .tour-row').click();
  await expect(page.locator('#tour-list .tour-row')).toHaveCount(2);
  await expect(page.locator('#tour-archived')).toBeHidden();
});

test('composition sur la carte : un tap ajoute, un second retire', async ({ page }) => {
  const errors = trackErrors(page);
  await openApp(page);
  await newTour(page, 'Mardi');
  await page.click('#btn-tour-select');
  await expect(page.locator('#select-bar')).toBeVisible();
  await expect(page.locator('#view-prepare')).toBeHidden();
  await expect(page.locator('#btn-zoom-in')).toBeVisible();
  await expect(page.locator('#select-count')).toHaveText('Mardi : 0 adresse');

  await tapAt(page, ID.gare28);
  await expect(page.locator('#select-count')).toHaveText('Mardi : 1 adresse');
  await expect(page.locator('#toast-msg')).toHaveText('28 Rue de la Gare : ajouté à la tournée');
  await expect(page.locator('#sheet')).toBeHidden();  // pas de pointage pendant la composition
  expect(await page.evaluate((id) => window.neyronApp.map.addrEls.get(id).num.getAttribute('class'), ID.gare28)).not.toContain('out');
  await page.waitForTimeout(400);  // pas de double tap
  await tapAt(page, ID.gare28);
  await expect(page.locator('#select-count')).toHaveText('Mardi : 0 adresse');

  await tapAt(page, ID.gare26);
  await page.click('#btn-select-done');
  await expect(page.locator('#select-bar')).toBeHidden();
  await expect(page.locator('#view-prepare')).toBeVisible();
  await expect(page.locator('#prep-summary')).toHaveText('1 adresse · 1 rue');

  // changer d'onglet pendant la composition la termine
  await page.click('#btn-tour-select');
  await tab(page, 'distribute').click();
  await expect(page.locator('#select-bar')).toBeHidden();
  await tapAddress(page, ID.gare26);  // pointage normal de retour
  expect(errors).toEqual([]);
});

test('export puis import : les tournées et leur composition suivent', async ({ page, browser }, testInfo) => {
  await openApp(page);
  await newTour(page, 'Mardi');
  await editStreet(page, STREET.gare, { side: 'pair' });
  // ordre de passage et sens (L4), par clé de voie BAN
  await page.evaluate((s) => {
    const { store, ui } = window.neyronApp;
    return store.updateTour(store.tour, { order: [ui.keys.key[s]], reverse: [ui.keys.key[s]] });
  }, STREET.gare);
  await page.evaluate(() => { navigator.canShare = () => false; });
  await page.click('#btn-menu');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
  const file = testInfo.outputPath('backup.json');
  await download.saveAs(file);
  const backup = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const mardi = backup.tours.find((t) => t.name === 'Mardi');
  expect(mardi.ids).toHaveLength(streetAddrs(STREET.gare, { side: 'pair' }).length);

  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await openApp(pageB);
  await pageB.setInputFiles('#import-file', file);
  await expect(pageB.locator('#confirm-msg')).toContainText('Fusionner 0 événement et 1 tournée (« Mardi »)');
  await pageB.click('#confirm-ok');
  await expect(pageB.locator('#toast-msg')).toHaveText('0 événement ajouté, 1 tournée ajoutée ou mise à jour');
  await expect.poll(() => pageB.evaluate(() => window.neyronApp.store.tours.length)).toBe(2);
  const imported = await pageB.evaluate((id) => window.neyronApp.store.tours.find((t) => t.id === id), mardi.id);
  expect(imported.ids).toEqual(mardi.ids);
  expect(mardi.reverse).toEqual(['01275_0420']);  // clé de voie de la Rue de la Gare (ids 01275_0420_…)
  expect(imported.order).toEqual(mardi.order);
  expect(imported.reverse).toEqual(mardi.reverse);
  expect(await activeTour(pageB)).toMatchObject({ id: 'default' });  // l'import ne change pas la tournée active
  await ctxB.close();
});
