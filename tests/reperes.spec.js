// Repères d'adresse : saisie (liste fermée + note courte), affichage (fiche, plan, prochaine adresse, page Repères),
// alerte pendant la tournée, sauvegarde, jamais dans le rapport.
const { test, expect } = require('@playwright/test');
const { ID, GPS, trackErrors, openApp, waitReady, tapAddress, openPage } = require('./helpers');

const tags = (page) => page.evaluate(() => window.neyronApp.store.tags);
const opt = (page, label) => page.locator('#tag-options .tag-opt', { hasText: label });

async function tagAddress(page, id, labels, note = '') {
  await tapAddress(page, id);
  await page.click('#btn-sheet-tag');
  await expect(page.locator('#tag-dialog')).toBeVisible();
  for (const l of labels) await opt(page, l).click();
  if (note) await page.fill('#tag-note', note);
  await page.click('#tag-save');
  await expect(page.locator('#tag-dialog')).toBeHidden();
}

test('saisie depuis la fiche : codes, note, affichage sur la fiche, le plan et la page Repères, conservé', async ({ page }) => {
  const errors = trackErrors(page);
  await openApp(page);
  await tagAddress(page, ID.gare28, ['Chien', 'Portail ou sonnette'], 'Boîte derrière le garage');
  expect((await tags(page))[ID.gare28]).toMatchObject({ c: ['chien', 'portail'], note: 'Boîte derrière le garage' });
  await expect(page.locator('#sheet-tags')).toHaveText('Chien · Portail ou sonnette — Boîte derrière le garage');
  await expect(page.locator('#btn-sheet-tag')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.l-tags .tag-dot')).toHaveAttribute('d', /^M[\d.]+ [\d.]+h0\.01$/);
  await page.click('#btn-sheet-close');

  await openPage(page, 'prepare', '#prep-tags-row');
  await expect(page.locator('#prep-tags-n')).toHaveText('1');
  await expect(page.locator('#tags-list .vrow')).toHaveCount(1);
  await expect(page.locator('#tags-list .vrow-name')).toHaveText('28 Rue de la Gare');
  await expect(page.locator('#tags-list .vrow-sub')).toContainText('Chien · Portail ou sonnette — Boîte derrière le garage');

  // modifier depuis la liste : décocher un code ; note nettoyée et bornée à 60 caractères
  await page.click('#tags-list .vrow');
  await expect(opt(page, 'Chien').locator('input')).toBeChecked();
  await opt(page, 'Portail ou sonnette').click();
  await page.fill('#tag-note', '');
  await page.locator('#tag-note').pressSequentially(`${'x'.repeat(70)}`);
  await page.press('#tag-note', 'Enter');  // Entrée enregistre (ne supprime pas)
  await expect(page.locator('#tag-dialog')).toBeHidden();
  const t = (await tags(page))[ID.gare28];
  expect(t.c).toEqual(['chien']);
  expect(t.note.length).toBe(60);

  await page.reload();
  await waitReady(page);
  expect((await tags(page))[ID.gare28].c).toEqual(['chien']);
  // supprimer le repère depuis la fenêtre
  await tapAddress(page, ID.gare28);
  await page.click('#btn-sheet-tag');
  await page.click('#tag-remove');
  await expect(page.locator('#sheet-tags')).toBeHidden();
  expect(await tags(page)).toEqual({});
  await expect(page.locator('.l-tags .tag-dot')).toHaveAttribute('d', '');
  expect(errors).toEqual([]);
});

test('alerte : la prochaine adresse est repérée ; tout supprimer', async ({ page }) => {
  await openApp(page);
  // repère sur la deuxième adresse de l'ordre de passage, puis distribution de la première
  const [first, second] = await page.evaluate(() => window.neyronApp.ui.visitOrder().slice(0, 2).map((a) => a.id));
  await page.evaluate((id) => window.neyronApp.store.setTags(id, ['danger'], 'Virage sans visibilité'), second);
  await expect(page.locator('#tag-alert')).toBeHidden();
  await page.evaluate((id) => window.neyronApp.store.setStatus([id], 'fait'), first);
  await expect(page.locator('#tag-alert')).toBeVisible();
  await expect(page.locator('#tag-alert-msg')).toContainText('Danger — Virage sans visibilité');
  await expect(page.locator('#next-tags')).toHaveText('Danger — Virage sans visibilité');
  await page.click('#tag-alert-close');
  await expect(page.locator('#tag-alert')).toBeHidden();

  await openPage(page, 'prepare', '#prep-tags-row');
  await page.click('#tags-clear');
  await page.click('#confirm-ok');
  await expect(page.locator('#tags-empty')).toBeVisible();
  expect(await tags(page)).toEqual({});
});

test.describe('proximité GPS', () => {
  test.use({ permissions: ['geolocation'], geolocation: GPS.gare9 });

  test('à moins de 50 m d\'une adresse repérée de la tournée : alerte, une seule fois', async ({ page }) => {
    await openApp(page);
    await page.evaluate((id) => window.neyronApp.store.setTags(id, ['chien']), ID.gare9);
    await page.click('#btn-locate');
    await expect(page.locator('#tag-alert-msg')).toHaveText('9 Rue de la Gare : Chien');
    await page.click('#tag-alert-close');
    // nouvelle position au même endroit : pas de nouvelle alerte avant 15 min
    await page.context().setGeolocation({ ...GPS.gare9, latitude: GPS.gare9.latitude + 0.00001 });
    await page.waitForTimeout(500);
    await expect(page.locator('#tag-alert')).toBeHidden();
  });
});

test('sauvegarde : les repères voyagent, validés ; jamais dans le rapport', async ({ page, browser }) => {
  await openApp(page);
  await page.evaluate((id) => window.neyronApp.store.setTags(id, ['chien'], 'Grand chien noir'), ID.gare28);
  await page.evaluate(() => { navigator.canShare = () => false; });
  await page.click('#btn-menu');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
  const backup = JSON.parse(require('fs').readFileSync(await download.path(), 'utf-8'));
  expect(backup.tags[ID.gare28]).toMatchObject({ c: ['chien'], note: 'Grand chien noir' });

  // rapport CSV : aucune trace du repère
  await page.click('#tabbar [data-tab="control"]');
  const [csv] = await Promise.all([page.waitForEvent('download'), page.click('#ctl-csv')]);
  const text = require('fs').readFileSync(await csv.path(), 'utf-8');
  expect(text).not.toContain('chien');
  expect(text).not.toContain('Grand chien noir');

  // autre appareil : import, avec des repères piégés écartés ou nettoyés
  backup.tags.evil = { c: ['chien', 'pirate'], note: '<img src=x onerror=alert(1)>\u0007' + 'y'.repeat(100), at: Date.now() };
  backup.tags.vide = { c: ['pirate'], at: Date.now() };
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await openApp(page2);
  await page2.setInputFiles('#import-file', { name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await expect(page2.locator('#confirm-msg')).toContainText('repère');
  await page2.click('#confirm-ok');
  const t2 = await page2.evaluate(() => window.neyronApp.store.tags);
  expect(t2[ID.gare28]).toMatchObject({ c: ['chien'], note: 'Grand chien noir' });
  expect(t2.evil.c).toEqual(['chien']);
  expect(t2.evil.note.length).toBe(60);
  expect(t2.evil.note).not.toMatch(/[\u0000-\u001f]/);
  expect(t2.vide).toBeUndefined();
  await ctx2.close();
});
