// Robustesse (branche facteur, phase L7) : parcours complet des 3 vues hors ligne, sauvegarde au format 2 d'un
// appareil à l'autre, sauvegardes de la v0.1 (format 1), format futur refusé, écriture impossible signalée,
// cibles tactiles et noms accessibles dans toutes les vues.
const fs = require('fs');
const { test, expect } = require('@playwright/test');
const { ID, GPS, STREET, addressData, tourIds, tourTotal, trackErrors, openApp, waitReady, tapAddress, statusOf } = require('./helpers');

const tab = (page, name) => page.locator(`#tabbar [data-tab="${name}"]`);
const num = (a) => `${a.n}${a.rep ? ` ${a.rep}` : ''}`;
const label = (a) => `${num(a)} ${addressData().streets[a.s].name}`;
const streetAddrs = (name) => {
  const { streets, addresses } = addressData();
  const s = streets.findIndex((st) => st.name === name);
  return addresses.filter((a) => a.s === s);
};
const waitControlled = (page) => page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 15_000 });

async function download(page, click, testInfo, name) {
  const [dl] = await Promise.all([page.waitForEvent('download'), click()]);
  const file = testInfo.outputPath(name);
  await dl.saveAs(file);
  return file;
}

test('parcours complet hors ligne : préparer un secteur, distribuer, contrôler, clôturer', async ({ page, context }, testInfo) => {
  const errors = trackErrors(page);
  await openApp(page);
  await waitControlled(page);
  await context.setOffline(true);
  await page.reload();
  await waitReady(page);
  await page.evaluate(() => { navigator.canShare = () => false; });

  // Préparer : secteur importé, puis Chemin du Barry placé en tête
  await tab(page, 'prepare').click();
  await page.setInputFiles('#sector-file', { name: 'mardi.csv', mimeType: 'text/csv',
    buffer: Buffer.from('voie;début;fin;côté\nRue de la Gare;;;pairs\nChemin du Barry;;;\n') });
  await page.locator('#prompt-input').fill('Mardi');
  await page.click('#prompt-ok');
  await expect(page.locator('#prep-tour-name')).toHaveText('Mardi');
  await page.click('#prep-order-box summary');
  await page.click('[aria-label="Monter : Chemin du Barry"]');
  await expect(page.locator('#prep-order .order-row .vrow-name')).toHaveText(['1. Chemin du Barry', '2. Rue de la Gare']);

  // Distribuer : reprise dans l'ordre de passage, une anomalie, puis toute la Rue de la Gare
  const barry = streetAddrs('Chemin du Barry');
  const gare = streetAddrs('Rue de la Gare').filter((a) => a.side === 'pair');
  await tab(page, 'distribute').click();
  await page.click('#btn-resume');
  const title = page.locator('#next-title');
  const settle = () => expect(page.locator('#next-card')).not.toHaveClass(/busy/);
  await expect(title).toHaveText(label(barry[0]));
  await page.click('#next-done');
  await settle();
  await page.click('#next-anomaly');
  await page.click('#reason-list .reason[value="inaccessible"]');
  await settle();
  await page.click('#next-done');
  await settle();
  await expect(title).toHaveText(label(gare[0]));
  await page.click('#next-street');
  await page.click('#confirm-ok');
  await expect(title).toHaveText('Tournée terminée');

  // Contrôler : bilan, rapport hors ligne, clôture
  await tab(page, 'control').click();
  await expect(page.locator('#ctl-done')).toHaveText(String(barry.length - 1 + gare.length));
  await expect(page.locator('#ctl-anom')).toHaveText('1');
  const csv = fs.readFileSync(await download(page, () => page.click('#ctl-csv'), testInfo, 'mardi.csv'), 'utf-8');
  expect(csv).toContain(`Chemin du Barry;${barry[1].n};${barry[1].rep};${barry[1].side};anomalie;Boîte inaccessible`);
  await page.click('#ctl-close');
  await page.click('#confirm-ok');
  await expect(page.locator('#ctl-done')).toHaveText('0');

  // relance hors ligne : passage clôturé et historique conservés
  await page.reload();
  await waitReady(page);
  await tab(page, 'control').click();
  await expect(page.locator('#ctl-title')).toHaveText('Bilan · Mardi');
  await expect(page.locator('#ctl-history-n')).toHaveText('1');
  await page.click('#ctl-history summary');
  await expect(page.locator('#ctl-history-list .vrow-sub')).toHaveText(`${barry.length - 1 + gare.length} distribuées · 1 anomalie · 0 non traitée`);
  expect(errors).toEqual([]);
});

test('sauvegarde au format 2 : composition, ordre, sens, passages et anomalies suivent sur un autre appareil', async ({ page, browser }, testInfo) => {
  await openApp(page);
  const gare = streetAddrs('Rue de la Gare');
  await page.evaluate(async ({ ids, s }) => {
    const { store, ui } = window.neyronApp;
    await store.createTour('Jeudi', ids, { order: [ui.keys.key[s]], reverse: [ui.keys.key[s]] });
    await store.setStatus(ids.slice(0, 4), 'fait');
    await store.setStatus(ids.slice(4, 5), 'anomalie', 'pleine');
    await store.closePassage(ids);
    await store.setStatus(ids.slice(0, 2), 'fait');
    await store.setStatus(ids.slice(2, 3), 'anomalie', 'introuvable');
  }, { ids: gare.map((a) => a.id), s: STREET.gare });
  await page.evaluate(() => { navigator.canShare = () => false; });
  await page.click('#btn-menu');
  const file = await download(page, () => page.click('#btn-export'), testInfo, 'v2.json');
  const backup = JSON.parse(fs.readFileSync(file, 'utf-8'));
  expect(backup.schema).toBe(2);
  const snapshot = (p) => p.evaluate(() => {
    const { store } = window.neyronApp;
    const t = store.tours.find((x) => x.name === 'Jeudi');
    const d = store.derive(t.id);
    return { ids: t.ids, order: t.order, reverse: t.reverse, closures: t.closures,
      state: [...d.state].sort(), reasons: [...d.reasons].sort() };
  });
  const before = await snapshot(page);
  expect(before.closures).toHaveLength(1);
  expect(before.reasons).toEqual([[gare[2].id, 'introuvable']]);

  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await openApp(pageB);
  await pageB.setInputFiles('#import-file', file);
  await expect(pageB.locator('#confirm-msg')).toContainText('1 tournée (« Jeudi »)');
  await pageB.click('#confirm-ok');
  await expect.poll(() => pageB.evaluate(() => window.neyronApp.store.tours.length)).toBe(2);
  expect(await snapshot(pageB)).toEqual(before);
  await ctxB.close();
});

test('sauvegardes de la v0.1 (format 1) acceptées, format futur refusé', async ({ page }) => {
  const errors = trackErrors(page);
  await openApp(page);
  const t = Date.now();
  const v01 = {
    app: 'neyron-tournees', schema: 1, exportedAt: new Date().toISOString(), deviceId: 'oldphone', dataVersion: '442a0fd1',
    tours: [{ id: 'default', name: 'Tournée', createdAt: 1, archived: false }],
    events: [
      { dev: 'oldphone', seq: 1, t: t - 3000, tour: 'default', ids: [ID.gare28], st: 'fait', grp: 'oldphone:1' },
      { dev: 'oldphone', seq: 2, t: t - 2000, tour: 'default', ids: [ID.gare26], st: 'a_repasser', grp: 'oldphone:2' },
      { dev: 'oldphone', seq: 3, t: t - 1000, tour: 'default', ids: [ID.gare21], st: 'fait', grp: 'oldphone:3' },
      { dev: 'oldphone', seq: 4, t: t - 500, tour: 'default', ids: [ID.gare21], st: 'a_faire', grp: 'oldphone:4', undoOf: 'oldphone:3' },
    ],
  };
  const importJson = async (name, obj) => page.setInputFiles('#import-file', { name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(obj)) });
  await importJson('v01.json', v01);
  await expect(page.locator('#confirm-msg')).toContainText('Fusionner 4 événements');
  await page.click('#confirm-ok');
  await expect.poll(() => statusOf(page, ID.gare28)).toBe('fait');
  expect(await statusOf(page, ID.gare26)).toBe('a_repasser');
  expect(await statusOf(page, ID.gare21)).toBe('a_faire');  // annulation de la v0.1 rejouée
  // la tournée de l'appareil (preset « 10 rues ») n'est pas remplacée par l'ancienne, sans composition
  expect(await page.evaluate(() => {
    const t = window.neyronApp.store.activeTour;
    return { name: t.name, n: t.ids.length };
  })).toEqual({ name: 'Neyron — 10 rues', n: tourTotal() });

  // une tournée v0.1 inconnue de l'appareil reçoit la composition du preset de même id
  const preset = addressData().addresses.filter((a) => a.s === STREET.barry).map((a) => a.id);
  await page.evaluate((ids) => window.neyronApp.store.presets.push({ id: 'p-barry', name: 'Barry', ids }), preset);
  await importJson('v01b.json', { ...v01, tours: [{ id: 'p-barry', name: 'Tournée', createdAt: 2 }], events: [] });
  await page.click('#confirm-ok');
  await expect.poll(() => page.evaluate(() => window.neyronApp.store.tours.find((x) => x.id === 'p-barry')))
    .toMatchObject({ name: 'Barry', ids: preset });

  // sauvegarde d'une version plus récente de l'app : refusée avec une consigne
  await importJson('v3.json', { ...v01, schema: 3 });
  await expect(page.locator('#toast-msg')).toHaveText('Import impossible : sauvegarde faite par une version plus récente de l\'app (format 3) : mettez l\'app à jour');
  expect(errors).toEqual([]);
});

test('écriture impossible (stockage plein) : un message, pas un échec silencieux', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    const { store } = window.neyronApp;
    const fail = async () => { throw new Error('quota dépassé'); };
    store._save = fail;
    store._append = fail;
  });
  await tapAddress(page, ID.gare28);
  await page.click('#sheet-actions [data-st="fait"]');
  await expect(page.locator('#toast-msg')).toHaveText('Enregistrement impossible : quota dépassé');
  await tab(page, 'prepare').click();
  await page.click('#btn-tour-new');
  await page.click('#prompt-ok');
  await expect(page.locator('#toast-msg')).toHaveText('Enregistrement impossible : quota dépassé');
  await tab(page, 'control').click();
  await page.evaluate(() => { window.neyronApp.store.events.push({ t: 1 }); window.neyronApp.control.render(); });  // un pointage à clôturer
  await page.click('#ctl-close');
  await page.click('#confirm-ok');
  await expect(page.locator('#toast-msg')).toHaveText('Enregistrement impossible : quota dépassé');
});

test.describe('ergonomie', () => {
  test.use({ permissions: ['geolocation'], geolocation: GPS.gare28 });

  test('cibles tactiles d\'au moins 44 px et boutons nommés, dans les 3 vues et les dialogues', async ({ page }) => {
    await openApp(page);
    // éléments touchables visibles trop petits ; une case à cocher compte par son libellé (la cible réelle)
    const audit = () => page.evaluate(() => {
      const bad = [];
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden], #debug');
      };
      const sel = 'button, [role="button"], summary, input[type="text"], input[type="search"], input[type="number"], input[type="checkbox"], input[type="radio"]';
      for (const el of document.querySelectorAll(sel)) {
        const target = el.matches('input[type="checkbox"], input[type="radio"]') ? el.closest('label') : el;
        if (!target || !visible(target)) continue;
        const r = target.getBoundingClientRect();
        const name = el.getAttribute('aria-label') || target.textContent.trim().replace(/\s+/g, ' ').slice(0, 30) || el.id;
        if (Math.min(r.width, r.height) < 43.5) bad.push(`${name} (${Math.round(r.width)}×${Math.round(r.height)})`);
        if (el.tagName === 'BUTTON' && !(el.getAttribute('aria-label') || el.textContent.trim())) bad.push(`bouton sans nom : ${el.id || el.className}`);
      }
      return bad;
    });
    const tapAt = async (id) => {
      const [x, y] = await page.evaluate((id) => {
        const { map } = window.neyronApp;
        const a = map.byId.get(id);
        map._stopAnim();
        map.setView(a.x, a.y, 3);
        return map.toScreen(a.x, a.y);
      }, id);
      await page.mouse.click(x, y);
    };

    await page.click('#btn-locate');
    await expect(page.locator('#nearby-list .nb-row').first()).toBeVisible();
    if (await page.locator('#legend').isHidden()) await page.click('#btn-legend');  // ouverte d'office sur grand écran
    expect(await audit(), 'Distribuer : légende et encart GPS').toEqual([]);
    await page.click('#btn-legend');  // refermée : elle couvre la carte sur téléphone
    await tapAt(ID.gare28);
    await expect(page.locator('#sheet')).toBeVisible();
    expect(await audit(), 'panneau d\'adresse').toEqual([]);
    await page.click('#sheet-actions [data-st="anomalie"]');
    expect(await audit(), 'choix du motif').toEqual([]);
    await page.click('#reason-dialog button[value="cancel"]');
    await page.click('#btn-sheet-close');
    await page.click('#btn-locate');
    await page.click('#btn-locate');  // GPS arrêté
    await page.click('#btn-resume');
    expect(await audit(), 'reprise').toEqual([]);
    await page.click('#btn-menu');
    expect(await audit(), 'menu').toEqual([]);
    await page.click('#btn-menu');

    await tab(page, 'prepare').click();
    for (const s of ['#prep-order-box', '#prep-checks-box', '#prep-settings']) await page.click(`${s} summary`);
    expect(await audit(), 'Préparer').toEqual([]);
    await page.locator('#prep-streets .vrow').first().click();
    expect(await audit(), 'éditeur de rue').toEqual([]);
    await page.click('#street-editor button[value="close"]');

    await tab(page, 'control').click();
    for (const s of ['#ctl-anom-box', '#ctl-untreated-box']) await page.click(`${s} summary`);
    expect(await audit(), 'Contrôler').toEqual([]);
  });
});
