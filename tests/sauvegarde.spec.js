// Cas 5 : export puis import sur un autre appareil (état identique) ; import d'un fichier non fiable.
const fs = require('fs');
const { test, expect } = require('@playwright/test');
const { ID, STREET, tourTotal, trackErrors, openApp, waitReady, stateOf } = require('./helpers');

// progression variée : fait, à repasser, une rue entière annulée, une action groupée
async function makeProgress(page) {
  await page.evaluate(async ({ ID, barry }) => {
    const { store, map } = window.neyronApp;
    await store.setStatus([ID.gare28], 'fait');
    await store.setStatus([ID.gare26], 'a_repasser');
    await store.setStatus(map.pointable.filter((a) => a.s === barry).map((a) => a.id), 'fait');
    await store.undo();
    await store.setStatus([ID.gare9, ID.gare14], 'fait');
  }, { ID, barry: STREET.barry });
}

async function exportByDownload(page, testInfo) {
  await page.evaluate(() => { navigator.canShare = () => false; });  // pas de feuille de partage : repli téléchargement
  await page.click('#btn-menu');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
  const file = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(file);
  return { file, name: download.suggestedFilename() };
}

const importFile = (page, name, content) => page.setInputFiles('#import-file', {
  name, mimeType: 'application/json', buffer: Buffer.from(content),
});

test('export puis import sur un autre appareil : état identique', async ({ page, browser }, testInfo) => {
  const errorsA = trackErrors(page);
  await openApp(page);
  await makeProgress(page);
  const stateA = await stateOf(page);
  const progressA = await page.textContent('#total-progress');
  expect(progressA).toBe(`3/${tourTotal()}`);

  const { file, name } = await exportByDownload(page, testInfo);
  expect(name).toMatch(/^neyron-tournees-export-\d{8}-\d{4}\.json$/);
  await expect(page.locator('#menu')).toBeHidden();
  await expect(page.locator('#toast-msg')).toHaveText(/^Sauvegarde téléchargée/);
  const backup = JSON.parse(fs.readFileSync(file, 'utf-8'));
  expect(backup).toMatchObject({ app: 'neyron-tournees', schema: 2 });
  expect(backup.events).toHaveLength(5);
  expect(backup.tours).toHaveLength(1);
  expect(await page.evaluate(() => Boolean(window.neyronApp.store.meta.lastExportAt))).toBe(true);

  // appareil B : contexte neuf (autre IndexedDB)
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  expect(pageB.viewportSize(), 'même profil d\'appareil que A').toEqual(page.viewportSize());
  const errorsB = trackErrors(pageB);
  await openApp(pageB);
  await expect(pageB.locator('#total-progress')).toHaveText(`0/${tourTotal()}`);
  await pageB.setInputFiles('#import-file', file);
  await expect(pageB.locator('#confirm')).toHaveJSProperty('open', true);
  await expect(pageB.locator('#confirm-msg')).toContainText('Fusionner 5 événements');
  await expect(pageB.locator('#confirm-msg')).toContainText('Rien n\'est supprimé');
  await pageB.click('#confirm-ok');
  await expect(pageB.locator('#total-progress')).toHaveText(progressA);
  expect(await stateOf(pageB)).toBe(stateA);
  await expect(pageB.locator('#btn-undo')).toBeDisabled();  // les actions d'un autre appareil ne s'annulent pas ici

  await pageB.reload();
  await waitReady(pageB);
  expect(await stateOf(pageB)).toBe(stateA);

  // réimport : aucun doublon
  await pageB.setInputFiles('#import-file', file);
  await expect(pageB.locator('#toast-msg')).toHaveText(/^Rien à importer : 5 événements déjà présents/);

  // réimport sur l'appareil d'origine
  await page.setInputFiles('#import-file', file);
  await expect(page.locator('#toast-msg')).toHaveText(/^Rien à importer/);
  expect([...errorsA, ...errorsB]).toEqual([]);
  await ctxB.close();
});

test('export par la feuille de partage, partage annulé', async ({ page }) => {
  await openApp(page);
  await makeProgress(page);
  await page.evaluate(() => {
    navigator.canShare = () => true;
    navigator.share = async (d) => {
      window.__shared = { name: d.files[0].name, type: d.files[0].type, text: await d.files[0].text() };
    };
  });
  await page.click('#btn-menu');
  await page.click('#btn-export');
  await expect(page.locator('#toast-msg')).toHaveText('Sauvegarde partagée');
  const shared = await page.evaluate(() => window.__shared);
  expect(shared.type).toBe('application/json');
  expect(shared.name).toMatch(/^neyron-tournees-export-\d{8}-\d{4}\.json$/);
  expect(JSON.parse(shared.text).events).toHaveLength(5);

  await page.evaluate(() => {
    navigator.share = async () => { const e = new Error('annulé'); e.name = 'AbortError'; throw e; };
  });
  await page.click('#btn-menu');
  await page.click('#btn-export');
  await expect(page.locator('#toast-msg')).toHaveText(/^Partage annulé/);
});

test('import non fiable : fichiers invalides refusés, entrées piégées ignorées', async ({ page }) => {
  const errors = trackErrors(page);
  await openApp(page);

  await importFile(page, 'bad.json', '{ pas du json');
  await expect(page.locator('#toast-msg')).toHaveText('Import impossible : fichier illisible (JSON invalide)');
  await importFile(page, 'other.json', JSON.stringify({ app: 'autre', schema: 1, events: [] }));
  await expect(page.locator('#toast-msg')).toContainText('n\'est pas une sauvegarde');

  const t = Date.now();
  const evil = {
    app: 'neyron-tournees', schema: 1, deviceId: 'zz9', exportedAt: new Date().toISOString(),
    tours: [{ id: 'default', name: 'x' }],
    events: [
      { dev: 'zz9', seq: 1, t, tour: 'default', ids: [ID.gare21], st: 'fait', grp: 'zz9:1', evil: '<img src=x onerror=alert(1)>' },
      { dev: 'zz9', seq: 2, t: t + 1, tour: 'default', ids: ['XXX_inconnu'], st: 'fait', grp: 'zz9:2' },
      { dev: 'zz9', seq: 3, t, tour: 'default', ids: [ID.gare9], st: 'supprimé', grp: 'zz9:3' },  // statut inconnu
      { dev: 'zz9', seq: 0, t, tour: 'default', ids: [ID.gare9], st: 'fait', grp: 'zz9:0' },     // seq invalide
      { dev: 'zz9', seq: 4, t, tour: 'default', ids: [], st: 'fait', grp: 'zz9:4' },             // aucune adresse
      { dev: 'x'.repeat(500), seq: 5, t, tour: 'default', ids: [ID.gare9], st: 'fait', grp: 'g' }, // trop long
      'pas un objet',
    ],
  };
  await importFile(page, 'evil.json', JSON.stringify(evil));
  const msg = page.locator('#confirm-msg');
  await expect(msg).toContainText('Fusionner 2 événements');
  await expect(msg).toContainText('5 entrées invalides ignorées');
  await expect(msg).toContainText('1 adresse inconnue');

  // refus : rien ne change
  await page.click('#confirm button[value="cancel"]');
  await expect(page.locator('#confirm')).toHaveJSProperty('open', false);
  expect(await page.evaluate(() => window.neyronApp.store.allEvents.length)).toBe(0);

  await importFile(page, 'evil.json', JSON.stringify(evil));
  await page.click('#confirm-ok');
  await expect(page.locator('#total-progress')).toHaveText(`1/${tourTotal()}`);
  const stored = await page.evaluate(() => {
    const e = window.neyronApp.store.allEvents.find((x) => x.dev === 'zz9' && x.seq === 1);
    return Object.keys(e).sort();
  });
  expect(stored, 'champ inconnu retiré').toEqual(['dev', 'grp', 'ids', 'seq', 'st', 't', 'tour']);
  expect(await page.evaluate(() => document.querySelectorAll('img').length), 'rien d\'injecté dans la page').toBe(0);
  expect(errors).toEqual([]);
});
