// Distribuer (branche facteur, phase L5 ; refonte) : anomalie et motif en deux touchers, prochaine adresse
// toujours proposée dans l'ordre de passage, anomalies dans les comptes, la section « À proximité » et l'import.
const { test, expect } = require('@playwright/test');
const { ID, GPS, STREET, addressData, tourTotal, trackErrors, openApp, waitReady, tapAddress, statusOf, openLegend, openPage } = require('./helpers');

const reasonOf = (page, id) => page.evaluate((id) => window.neyronApp.store.reason(id), id);
const visibleActions = (page) => page.evaluate(() => [...document.querySelectorAll('#sheet-actions .act')]
  .filter((b) => !b.hidden).map((b) => b.dataset.st));
const num = (a) => `${a.n}${a.rep ? ` ${a.rep}` : ''}`;
const label = (a) => `${num(a)} ${addressData().streets[a.s].label || addressData().streets[a.s].name}`;
const streetAddrs = (name) => {
  const { streets, addresses } = addressData();
  const s = streets.findIndex((st) => st.name === name);
  return addresses.filter((a) => a.s === s);
};

test('anomalie en deux touchers depuis le panneau : motif, changement de motif, annulation', async ({ page }) => {
  const errors = trackErrors(page);
  await openApp(page);
  await tapAddress(page, ID.gare28);
  expect(await visibleActions(page)).toEqual(['fait', 'anomalie', 'a_repasser']);
  await page.click('#sheet-actions [data-st="anomalie"]');
  const dlg = page.locator('#reason-dialog');
  await expect(dlg).toHaveJSProperty('open', true);
  await expect(page.locator('#reason-title')).toHaveText('Anomalie · 28 Rue de la Gare');
  await expect(page.locator('#reason-list .reason')).toHaveText(['Boîte absente', 'Boîte inaccessible',
    'Boîte pleine ou abîmée', 'Numéro introuvable', 'Destinataire inconnu', 'Autre']);
  await expect(page.locator('#reason-dialog button[value="cancel"]')).toBeFocused();  // Entrée par erreur : sans effet
  await page.click('#reason-list .reason[value="inaccessible"]');
  await expect(dlg).toHaveJSProperty('open', false);
  expect(await statusOf(page, ID.gare28)).toBe('anomalie');
  expect(await reasonOf(page, ID.gare28)).toBe('inaccessible');
  await expect(page.locator('#toast-msg')).toHaveText('28 Rue de la Gare : anomalie (boîte inaccessible)');
  expect(await page.evaluate((id) => window.neyronApp.map.addrEls.get(id).num.getAttribute('class'), ID.gare28)).toContain('st-anomalie');
  await expect(page.locator(`.lg-row[data-s="${STREET.gare}"] .lg-anom`)).toHaveText('1');
  await expect(page.locator('#total-progress')).toHaveText(`1/${tourTotal()}`);  // anomalie = adresse traitée

  // changer de motif : le motif actuel est mis en avant ; Annuler rétablit l'ancien motif
  await tapAddress(page, ID.gare28);
  await expect(page.locator('#sheet-status')).toHaveText('anomalie : boîte inaccessible');
  expect(await visibleActions(page)).toEqual(['fait', 'anomalie', 'a_repasser', 'a_faire']);
  await page.click('#sheet-actions [data-st="anomalie"]');
  await expect(page.locator('#reason-list .reason[value="inaccessible"]')).toHaveAttribute('aria-pressed', 'true');
  await page.click('#reason-list .reason[value="absente"]');
  await expect.poll(() => reasonOf(page, ID.gare28)).toBe('absente');
  await page.click('#toast-action');
  await expect.poll(() => reasonOf(page, ID.gare28)).toBe('inaccessible');
  expect(await statusOf(page, ID.gare28)).toBe('anomalie');

  // Échap ferme le choix du motif sans rien changer, le panneau reste ouvert
  await tapAddress(page, ID.gare28);
  await page.click('#sheet-actions [data-st="anomalie"]');
  await expect(dlg).toHaveJSProperty('open', true);
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveJSProperty('open', false);
  await expect(page.locator('#sheet')).toBeVisible();
  expect(await reasonOf(page, ID.gare28)).toBe('inaccessible');

  await page.reload();
  await waitReady(page);
  expect(await statusOf(page, ID.gare28)).toBe('anomalie');
  expect(await reasonOf(page, ID.gare28)).toBe('inaccessible');
  await page.click('#btn-undo');  // pile d'annulation après relance : retour à « à faire »
  await expect.poll(() => statusOf(page, ID.gare28)).toBe('a_faire');
  expect(await reasonOf(page, ID.gare28)).toBe(null);
  expect(errors).toEqual([]);
});

test('prochaine adresse toujours proposée dans l\'ordre de passage, elle avance seule', async ({ page }) => {
  const errors = trackErrors(page);
  await openApp(page);
  const molliet = streetAddrs('Chemin du Molliet');
  const barry = streetAddrs('Chemin du Barry');
  // tournée de deux rues, Molliet d'abord (ordre de passage choisi)
  await page.evaluate(({ ids, m, b }) => {
    const { store, ui } = window.neyronApp;
    return store.createTour('Petite', ids, { order: [ui.keys.key[m], ui.keys.key[b]] });
  }, { ids: [...barry, ...molliet].map((a) => a.id), m: molliet[0].s, b: barry[0].s });

  const card = page.locator('#next-card');
  const title = page.locator('#next-title');
  const settle = () => expect(card).not.toHaveClass(/busy/);  // fin de la protection contre le double toucher
  await expect(card).toBeVisible();  // aucun geste pour reprendre
  await expect(title).toHaveText(label(molliet[0]));
  await expect(page.locator('#next-pos')).toHaveText(`Prochaine adresse · Rue 1/2 · ${molliet.length} numéros restants`);
  expect(await page.evaluate(() => window.neyronApp.map.selectedId)).toBe(molliet[0].id);
  const box = await page.locator('#next-done').boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(56);  // gros bouton, à une main

  // Distribué : un toucher ; un double toucher ne distribue pas l'adresse suivante par erreur
  await page.locator('#next-done').dblclick();
  await expect(title).toHaveText(label(molliet[1]));
  expect(await statusOf(page, molliet[0].id)).toBe('fait');
  expect(await statusOf(page, molliet[1].id)).toBe('a_faire');
  await settle();

  // Annuler (toast) : la carte revient à l'adresse précédente
  await page.click('#toast-action');
  await expect(title).toHaveText(label(molliet[0]));
  await page.click('#next-done');
  await expect(title).toHaveText(label(molliet[1]));
  await settle();

  // À repasser : reportée après les adresses à faire
  await page.click('#next-later');
  await expect(title).toHaveText(label(molliet[2]));
  await settle();
  // Anomalie : deux touchers
  await page.click('#next-anomaly');
  await page.click('#reason-list .reason[value="absente"]');
  await expect(title).toHaveText(label(molliet[3]));
  expect(await reasonOf(page, molliet[2].id)).toBe('absente');
  await settle();
  // Toute la rue : les restantes (à faire et à repasser), pas l'anomalie
  await expect(page.locator('#next-street')).toHaveText('Toute la rue (2)');
  await page.click('#next-street');
  await expect(page.locator('#confirm-msg')).toContainText('les 2 numéros restants de « Chemin du Molliet »');
  await expect(page.locator('#confirm-msg')).toContainText('L\'anomalie signalée est conservée');
  await page.click('#confirm-ok');
  await expect(title).toHaveText(label(barry[0]));
  await expect(page.locator('#next-pos')).toHaveText(`Prochaine adresse · Rue 2/2 · ${barry.length} numéros restants`);
  expect(await statusOf(page, molliet[1].id)).toBe('fait');
  expect(await statusOf(page, molliet[2].id)).toBe('anomalie');
  await settle();

  for (const a of barry) {
    await expect(title).toHaveText(label(a));
    await page.click('#next-done');
    await settle();
  }
  await expect(title).toHaveText('Tournée terminée');
  await expect(page.locator('#next-sub')).toHaveText(`${molliet.length - 1 + barry.length} adresses distribuées, 1 anomalie.`);
  await expect(page.locator('#next-body')).toBeHidden();

  // retrouvée après une relance ; « Voir le bilan » mène à Contrôler
  await page.reload();
  await waitReady(page);
  await expect(title).toHaveText('Tournée terminée');
  await page.click('#next-report');
  expect(await page.evaluate(() => window.neyronApp.tabs.current)).toBe('control');
  expect(errors).toEqual([]);
});

test('tournée commencée : le plan s\'ouvre sur la prochaine adresse', async ({ page }) => {
  await openApp(page);
  const first = await page.evaluate(() => window.neyronApp.distribute.current);
  await page.evaluate((id) => window.neyronApp.store.setStatus([id], 'fait'), first.id);
  await page.reload();
  await waitReady(page);
  const view = await page.evaluate(() => {
    const { map, distribute } = window.neyronApp;
    const a = distribute.current;
    const [x, y] = map.toScreen(a.x, a.y);
    const r = document.getElementById('panel').getBoundingClientRect();
    return { k: map.k, x, y, panelTop: r.top, left: r.left, right: r.right, desktop: window.neyronApp.panel.desktop };
  });
  expect(view.k).toBeGreaterThanOrEqual(3);
  if (view.desktop) expect(view.x).toBeGreaterThan(view.right);  // à droite du panneau latéral
  else expect(view.y).toBeLessThan(view.panelTop);              // au-dessus de la feuille
});

test('fiche d\'adresse : la prochaine adresse s\'efface pendant un pointage libre', async ({ page }) => {
  await openApp(page);
  const first = await page.locator('#next-title').textContent();
  await tapAddress(page, ID.gare28);  // pointage hors de l'ordre
  await expect(page.locator('#next-card')).toBeHidden();
  await page.click('#sheet-actions [data-st="fait"]');
  await expect(page.locator('#next-card')).toBeVisible();
  await expect(page.locator('#next-title')).toHaveText(first);  // la prochaine adresse n'a pas changé
  expect(await page.evaluate(() => window.neyronApp.map.selectedId)).toBe(await page.evaluate(() => window.neyronApp.distribute.current.id));
});

test.describe('anomalies dans les comptes', () => {
  test.use({ permissions: ['geolocation'], geolocation: GPS.gare28 });

  test('Contrôler, encart GPS, toute la rue et import', async ({ page }) => {
    const errors = trackErrors(page);
    await openApp(page);
    await page.evaluate(async ({ a, b }) => {
      const { store } = window.neyronApp;
      await store.setStatus([a], 'anomalie', 'pleine');
      await store.setStatus([b], 'fait');
    }, { a: ID.gare28, b: ID.gare26 });

    // à proximité : l'anomalie est traitée, elle n'est plus proposée
    await page.click('#btn-locate');
    await expect(page.locator('#nearby-list .nb-row').first()).toBeVisible();
    const rows = await page.evaluate(() => [...document.querySelectorAll('#nearby-list .nb-row')].filter((r) => !r.hidden).map((r) => r.dataset.id));
    expect(rows).not.toContain(ID.gare28);
    expect(rows).not.toContain(ID.gare26);
    await page.click('#btn-locate');
    await page.click('#btn-locate');  // arrêt

    await page.locator('#tabbar [data-tab="control"]').click();
    await expect(page.locator('#ctl-done')).toHaveText('1');
    await expect(page.locator('#ctl-anom')).toHaveText('1');
    await expect(page.locator('#ctl-todo')).toHaveText(String(tourTotal() - 2));
    await expect(page.locator('#ctl-summary')).toHaveText(`2 / ${tourTotal()} adresses traitées`);
    await expect(page.locator('#ctl-pct')).toHaveText('1 %');
    await openPage(page, 'control', '#ctl-streets-row');
    const gare = page.locator('#ctl-streets .vrow', { hasText: 'Rue de la Gare' });
    await expect(gare.locator('.vrow-count')).toHaveText('1/151');
    await expect(gare.locator('.vrow-sub')).toHaveText('13 restantes');

    // toute la rue distribuée : l'anomalie est conservée, la rue est traitée
    await openLegend(page);
    await page.click(`.lg-row[data-s="${STREET.gare}"] .lg-all`);
    await expect(page.locator('#confirm-msg')).toContainText('les 13 numéros restants de « Rue de la Gare » comme distribués');
    await expect(page.locator('#confirm-msg')).toContainText('L\'anomalie signalée est conservée');
    await page.click('#confirm-ok');
    await expect(page.locator(`.lg-row[data-s="${STREET.gare}"]`)).toHaveClass(/complete/);
    expect(await statusOf(page, ID.gare28)).toBe('anomalie');

    // import : le motif d'une anomalie est vérifié (liste fermée), il est retiré des autres statuts
    const checked = await page.evaluate(async () => {
      const { validEvent } = await import('./js/io.js');
      const e = { dev: 'd1', seq: 1, t: 1, tour: 'default', ids: ['x'], grp: 'd1:1' };
      return [
        validEvent({ ...e, st: 'anomalie', why: 'pleine' }),
        validEvent({ ...e, st: 'anomalie', why: '<img src=x>' }),
        validEvent({ ...e, st: 'anomalie' }),
        validEvent({ ...e, st: 'fait', why: 'pleine' }),
      ].map((v) => v && { st: v.st, why: v.why });
    });
    expect(checked).toEqual([{ st: 'anomalie', why: 'pleine' }, null, null, { st: 'fait', why: undefined }]);
    expect(errors).toEqual([]);
  });
});
