// Cas 2 et 3 : pointage d'un numéro (persistant), « Toute la rue faite » puis Annuler.
const { test, expect } = require('@playwright/test');
const { ID, STREET, tourTotal, trackErrors, openApp, waitReady, tapAddress, statusOf, legendCount, openLegend } = require('./helpers');

const visibleActions = (page) => page.evaluate(() => [...document.querySelectorAll('#sheet-actions .act')]
  .filter((b) => !b.hidden).map((b) => b.dataset.st));
const numClass = (page, id) => page.evaluate((id) => window.neyronApp.map.addrEls.get(id).num.getAttribute('class'), id);

async function mark(page, id, st) {
  await tapAddress(page, id);
  await page.click(`#sheet-actions [data-st="${st}"]`);
  await expect(page.locator('#sheet')).toBeHidden();
}

test('tap sur un numéro, Fait : l\'état persiste après rechargement', async ({ page }) => {
  const errors = trackErrors(page);
  await openApp(page);

  await tapAddress(page, ID.gare28);
  await expect(page.locator('#sheet-title')).toHaveText('28 Rue de la Gare');
  await expect(page.locator('#sheet-status')).toHaveText('à faire');
  expect(await visibleActions(page)).toEqual(['fait', 'a_repasser']);

  await page.click('#sheet-actions [data-st="fait"]');
  await expect(page.locator('#sheet')).toBeHidden();
  await expect(page.locator('#toast-msg')).toContainText('28 Rue de la Gare : fait');
  await expect(page.locator('#toast-action')).toBeVisible();
  expect(await numClass(page, ID.gare28)).toContain('st-fait');
  await expect(legendCount(page, STREET.gare)).toHaveText('1/15');
  await expect(page.locator('#total-progress')).toHaveText(`1/${tourTotal()}`);
  await expect(page.locator('#btn-undo')).toBeEnabled();

  // seules les actions qui changent le statut sont proposées
  await tapAddress(page, ID.gare28);
  await expect(page.locator('#sheet-status')).toHaveText('fait');
  expect(await visibleActions(page)).toEqual(['a_repasser', 'a_faire']);
  await page.click('#btn-sheet-close');

  await mark(page, ID.gare26, 'a_repasser');
  expect(await numClass(page, ID.gare26)).toContain('st-a_repasser');
  await expect(legendCount(page, STREET.gare)).toHaveText('1/151 ↻');

  await page.reload();
  await waitReady(page);
  expect(await statusOf(page, ID.gare28)).toBe('fait');
  expect(await statusOf(page, ID.gare26)).toBe('a_repasser');
  expect(await numClass(page, ID.gare28)).toContain('st-fait');
  expect(await numClass(page, ID.gare26)).toContain('st-a_repasser');
  await expect(page.locator('#total-progress')).toHaveText(`1/${tourTotal()}`);
  await expect(page.locator('#btn-undo')).toBeEnabled();  // la pile d'annulation survit à la relance

  // Remettre à faire
  await mark(page, ID.gare28, 'a_faire');
  expect(await statusOf(page, ID.gare28)).toBe('a_faire');
  await expect(page.locator('#total-progress')).toHaveText(`0/${tourTotal()}`);
  expect(errors).toEqual([]);
});

test('« Toute la rue faite » puis Annuler : états précédents restaurés', async ({ page }) => {
  const errors = trackErrors(page);
  await openApp(page);
  await mark(page, ID.gare28, 'fait');
  await mark(page, ID.gare26, 'a_repasser');
  await expect(legendCount(page, STREET.gare)).toHaveText('1/151 ↻');

  // refus de la confirmation : rien ne change
  await openLegend(page);
  const all = page.locator(`.lg-row[data-s="${STREET.gare}"] .lg-all`);
  await all.click();
  await expect(page.locator('#confirm')).toHaveJSProperty('open', true);
  await expect(page.locator('#confirm-msg')).toContainText('les 14 numéros restants de « Rue de la Gare »');
  await expect(page.locator('#confirm-msg')).toContainText('dont 1 à repasser');
  await page.click('#confirm button[value="cancel"]');
  await expect(page.locator('#confirm')).toHaveJSProperty('open', false);
  await expect(legendCount(page, STREET.gare)).toHaveText('1/151 ↻');

  // acceptation : toute la rue faite
  await all.click();
  await page.click('#confirm-ok');
  await expect(legendCount(page, STREET.gare)).toHaveText('15/15');
  await expect(page.locator(`.lg-row[data-s="${STREET.gare}"]`)).toHaveClass(/complete/);
  await expect(all).toBeDisabled();
  await expect(page.locator('#total-progress')).toHaveText(`15/${tourTotal()}`);
  if (await page.locator('#btn-legend-close').isVisible()) await page.click('#btn-legend-close');

  // Annuler 1 : la rue revient à l'état précédent, « à repasser » compris
  await page.click('#btn-undo');
  await expect(legendCount(page, STREET.gare)).toHaveText('1/151 ↻');
  expect(await statusOf(page, ID.gare26)).toBe('a_repasser');
  expect(await statusOf(page, ID.gare28)).toBe('fait');
  await expect(page.locator('#toast-msg')).toContainText('Annulé');

  // Annuler 2 et 3, puis plus rien
  await page.click('#btn-undo');
  await expect(legendCount(page, STREET.gare)).toHaveText('1/15');
  expect(await statusOf(page, ID.gare26)).toBe('a_faire');
  await page.click('#btn-undo');
  await expect(legendCount(page, STREET.gare)).toHaveText('0/15');
  await expect(page.locator('#btn-undo')).toBeDisabled();

  // rien n'est effacé du journal : 3 actions + 4 événements d'annulation (la rue en compte 2)
  await page.reload();
  await waitReady(page);
  await expect(page.locator('#total-progress')).toHaveText(`0/${tourTotal()}`);
  await expect(page.locator('#btn-undo')).toBeDisabled();
  const journal = await page.evaluate(() => {
    const events = window.neyronApp.store.allEvents;
    return { n: events.length, undo: events.filter((e) => e.undoOf).length };
  });
  expect(journal).toEqual({ n: 7, undo: 4 });
  expect(errors).toEqual([]);
});

test('Annuler au clavier (Ctrl+Z) et depuis le toast', async ({ page }) => {
  await openApp(page);
  await mark(page, ID.gare28, 'fait');
  await page.click('#toast-action');
  await expect.poll(() => statusOf(page, ID.gare28)).toBe('a_faire');
  await mark(page, ID.gare28, 'fait');
  await page.keyboard.press('Control+z');
  await expect.poll(() => statusOf(page, ID.gare28)).toBe('a_faire');
});
