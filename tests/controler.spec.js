// Contrôler (branche facteur, phase L6) : synthèse (anomalies par motif, adresses non traitées), rapport CSV / JSON
// (sans heure par défaut), clôture du passage, historique et réouverture, validation des passages importés.
const fs = require('fs');
const { test, expect } = require('@playwright/test');
const { addressData, tourIds, tourTotal, tourStreets, trackErrors, openApp, waitReady, statusOf } = require('./helpers');

const tab = (page, name) => page.locator(`#tabbar [data-tab="${name}"]`);
const num = (a) => `${a.n}${a.rep ? ` ${a.rep}` : ''}`;
const label = (a) => `${num(a)} ${addressData().streets[a.s].name}`;
// tournée par défaut, dans l'ordre de passage (ordre alphabétique des rues = ordre des données)
const tourAddrs = () => addressData().addresses.filter((a) => tourIds().has(a.id));

// 3 distribuées, 2 « boîte absente », 1 « destinataire inconnu », 1 à repasser : les 7 premières adresses
async function seed(page) {
  const a = tourAddrs();
  await page.evaluate(async (ids) => {
    const { store } = window.neyronApp;
    await store.setStatus(ids.slice(0, 3), 'fait');
    await store.setStatus(ids.slice(3, 5), 'anomalie', 'absente');
    await store.setStatus(ids.slice(5, 6), 'anomalie', 'inconnu');
    await store.setStatus(ids.slice(6, 7), 'a_repasser');
  }, a.slice(0, 7).map((x) => x.id));
  return a;
}

async function download(page, click, testInfo, name) {
  const [dl] = await Promise.all([page.waitForEvent('download'), click()]);
  const file = testInfo.outputPath(name);
  await dl.saveAs(file);
  return { name: dl.suggestedFilename(), buf: fs.readFileSync(file) };
}
const csvLine = (a, statut, motif = '') => [addressData().streets[a.s].name, a.n, a.rep, a.side, statut, motif].join(';');

test('synthèse : anomalies par motif, non traitées dans l\'ordre de passage, un toucher montre l\'adresse', async ({ page }) => {
  const errors = trackErrors(page);
  await openApp(page);
  const a = await seed(page);
  await tab(page, 'control').click();
  await expect(page.locator('#ctl-anom-n')).toHaveText('3');
  await page.click('#ctl-anom-box summary');
  await expect(page.locator('#ctl-reasons .rbar-label')).toHaveText(['Boîte absente', 'Destinataire inconnu']);
  await expect(page.locator('#ctl-reasons .rbar-n')).toHaveText(['2', '1']);
  await expect(page.locator('#ctl-anom-list .vrow-name')).toHaveText(a.slice(3, 6).map(label));
  await expect(page.locator('#ctl-anom-list .vrow-sub')).toHaveText(['Boîte absente', 'Boîte absente', 'Destinataire inconnu']);

  await expect(page.locator('#ctl-untreated-n')).toHaveText(String(tourTotal() - 6));
  await page.click('#ctl-untreated-box summary');
  const rows = page.locator('#ctl-untreated-list .vrow');
  await expect(rows).toHaveCount(tourTotal() - 6);
  await expect(rows.first().locator('.vrow-name')).toHaveText(label(a[6]));
  await expect(rows.first().locator('.vrow-sub')).toHaveText('à repasser');
  await expect(rows.nth(1).locator('.vrow-sub')).toHaveText('à faire');
  await rows.first().click();
  await expect(page.locator('#app')).toHaveAttribute('data-tab', 'distribute');
  await expect(page.locator('#sheet-title')).toHaveText(label(a[6]));
  expect(errors).toEqual([]);
});

test('rapport CSV et JSON : une ligne par adresse, motifs, sans heure par défaut', async ({ page }, testInfo) => {
  const errors = trackErrors(page);
  await openApp(page);
  const a = await seed(page);
  await tab(page, 'control').click();
  await page.evaluate(() => { navigator.canShare = () => false; });

  const csv = await download(page, () => page.click('#ctl-csv'), testInfo, 'r.csv');
  expect(csv.name).toMatch(/^rapport-neyron-10-rues-\d{8}\.csv$/);
  expect([...csv.buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);  // BOM : Excel lit l'UTF-8
  const lines = csv.buf.toString('utf-8').slice(1).split('\r\n');
  expect(lines[0]).toBe('rue;numero;complement;cote;statut;motif');
  expect(lines).toHaveLength(tourTotal() + 2);  // en-tête, une ligne par adresse, fin de ligne finale
  expect(lines[1]).toBe(csvLine(a[0], 'distribuée'));
  expect(lines[4]).toBe(csvLine(a[3], 'anomalie', 'Boîte absente'));
  expect(lines[6]).toBe(csvLine(a[5], 'anomalie', 'Destinataire inconnu'));
  expect(lines[7]).toBe(csvLine(a[6], 'à repasser'));
  expect(lines[8]).toBe(csvLine(a[7], 'non traitée'));
  await expect(page.locator('#toast-msg')).toHaveText(`Rapport téléchargé : ${csv.name}`);

  // heures de pointage sur demande, préférence mémorisée
  await page.click('label.check');
  const timed = (await download(page, () => page.click('#ctl-csv'), testInfo, 'h.csv')).buf.toString('utf-8').slice(1).split('\r\n');
  expect(timed[0]).toBe('rue;numero;complement;cote;statut;motif;heure');
  expect(timed[1]).toMatch(/;distribuée;;\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  expect(timed[8]).toMatch(/;non traitée;;$/);
  await page.reload();
  await waitReady(page);
  await tab(page, 'control').click();
  await expect(page.locator('#ctl-hours')).toBeChecked();
  await page.click('label.check');

  const json = JSON.parse((await download(page, () => page.click('#ctl-json'), testInfo, 'r.json')).buf.toString('utf-8'));
  expect(json).toMatchObject({
    app: 'neyron-tournees', kind: 'rapport', tournee: 'Neyron — 10 rues',
    totaux: { adresses: tourTotal(), distribuees: 3, anomalies: 3, a_repasser: 1, non_traitees: tourTotal() - 6 },
    anomalies_par_motif: { 'Boîte absente': 2, 'Destinataire inconnu': 1 },
  });
  expect(json.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(json.passage).toBeUndefined();
  expect(json.rues.map((r) => r.rue)).toEqual(tourStreets().map((st) => st.name));
  expect(json.adresses).toHaveLength(tourTotal());
  expect(json.adresses[3]).toEqual({ id: a[3].id, rue: addressData().streets[a[3].s].name, numero: a[3].n,
    complement: a[3].rep, cote: a[3].side, statut: 'anomalie', motif: 'Boîte absente' });

  // un rapport n'est pas une sauvegarde : refusé à l'import, avec un message clair
  await page.setInputFiles('#import-file', testInfo.outputPath('r.json'));
  await expect(page.locator('#toast-msg')).toHaveText('Import impossible : ce fichier est un rapport de tournée, pas une sauvegarde');

  // feuille de partage quand elle accepte le fichier
  await page.evaluate(() => {
    navigator.canShare = () => true;
    navigator.share = (d) => { window.sharedName = d.files[0].name; return Promise.resolve(); };
  });
  await page.click('#ctl-csv');
  await expect(page.locator('#toast-msg')).toHaveText('Rapport partagé');
  expect(await page.evaluate(() => window.sharedName)).toMatch(/^rapport-neyron-10-rues-\d{8}\.csv$/);

  // tableur : une cellule qui commence par = + - @ est neutralisée, ; et " sont protégés
  const cells = await page.evaluate(async () => {
    const { csvCell } = await import('./js/report.js');
    return ['=HYPERLINK("x")', '+1', 'a;b', 'Rue de l\'Église', '-'].map(csvCell);
  });
  expect(cells).toEqual(['"\'=HYPERLINK(""x"")"', '\'+1', '"a;b"', 'Rue de l\'Église', '\'-']);
  expect(errors).toEqual([]);
});

test('clôture du passage : bilan dans l\'historique, tournée à zéro, rapport du passage clos, réouverture', async ({ page }, testInfo) => {
  const errors = trackErrors(page);
  await openApp(page);
  const a = await seed(page);
  await tab(page, 'control').click();
  await page.evaluate(() => { navigator.canShare = () => false; });
  await expect(page.locator('#ctl-passage')).toHaveText('Premier passage');
  await page.click('#ctl-close');
  await expect(page.locator('#confirm-msg')).toContainText(`${tourTotal() - 6} adresses non traitées (dont 1 à repasser) le resteront dans le bilan`);
  await page.click('#confirm-ok');
  // rapport du passage clôturé depuis le toast (geste de l'utilisateur), tant qu'il est affiché (8 s)
  const closed = await download(page, () => page.click('#toast-action'), testInfo, 'clos.csv');
  expect(closed.buf.toString('utf-8').slice(1).split('\r\n')[4]).toBe(csvLine(a[3], 'anomalie', 'Boîte absente'));

  await expect(page.locator('#ctl-done')).toHaveText('0');
  await expect(page.locator('#ctl-anom')).toHaveText('0');
  await expect(page.locator('#ctl-todo')).toHaveText(String(tourTotal()));
  await expect(page.locator('#total-progress')).toHaveText(`0/${tourTotal()}`);
  await expect(page.locator('#btn-undo')).toBeDisabled();  // les actions du passage clos ne s'annulent plus
  await expect(page.locator('#ctl-close')).toBeDisabled();
  await expect(page.locator('#ctl-passage')).toHaveText(/^Passage en cours depuis le \d\d\/\d\d\/\d{4}$/);
  await expect(page.locator('#ctl-history-n')).toHaveText('1');
  await page.click('#ctl-history summary');
  await expect(page.locator('#ctl-history-list .vrow-name')).toHaveText(/^Passage du \d\d\/\d\d\/\d{4}$/);
  await expect(page.locator('#ctl-history-list .vrow-sub')).toHaveText(`3 distribuées · 3 anomalies · ${tourTotal() - 6} non traitées`);

  await tab(page, 'prepare').click();
  await expect(page.locator('#tour-list .tour-row.active .vrow-sub')).toHaveText(`${tourTotal()} adresses · 0 distribuée`);

  // réouverture : possible tant que rien n'a été pointé
  await tab(page, 'control').click();
  await page.click('#ctl-reopen');
  await expect(page.locator('#toast-msg')).toHaveText('Dernier passage rouvert');
  await expect(page.locator('#ctl-done')).toHaveText('3');
  await expect(page.locator('#ctl-history')).toBeHidden();
  expect(await statusOf(page, a[3].id)).toBe('anomalie');

  // nouvelle clôture, puis un pointage : plus de réouverture ; tout survit à une relance
  await page.click('#ctl-close');
  await page.click('#confirm-ok');
  await expect(page.locator('#ctl-done')).toHaveText('0');
  await page.evaluate((id) => window.neyronApp.store.setStatus([id], 'fait'), a[10].id);
  await expect(page.locator('#ctl-done')).toHaveText('1');
  await expect(page.locator('#ctl-reopen')).toHaveCount(0);
  await page.reload();
  await waitReady(page);
  await tab(page, 'control').click();
  await expect(page.locator('#ctl-done')).toHaveText('1');
  await expect(page.locator('#ctl-history-n')).toHaveText('1');
  expect(await statusOf(page, a[3].id)).toBe('a_faire');  // passage précédent : dans l'historique, pas dans le passage
  expect(await page.evaluate(() => window.neyronApp.store.allEvents.length)).toBe(5);  // le journal reste entier
  expect(errors).toEqual([]);
});

test('passages : horloge revenue en arrière, passages importés validés', async ({ page }) => {
  await openApp(page);
  const a = await seed(page);
  const id = a[20].id;
  const r = await page.evaluate(async (id) => {
    const { store, ui } = window.neyronApp;
    const ids = ui.order.flatMap((s) => ui.byStreet[s]).map((x) => x.id);
    const entry = await store.closePassage(ids);
    // l'horloge du téléphone recule (changement d'heure manuel) : le pointage reste dans le passage en cours
    const now = Date.now;
    Date.now = () => entry.at - 60_000;
    await store.setStatus([id], 'fait');
    Date.now = now;
    const { validTour } = await import('./js/io.js');
    const t = validTour({ id: 'x', closures: [
      { at: 2000, start: 1000, n: 5, done: 2, again: 1, todo: 2, anomalies: { absente: 1, pirate: 9 } },
      { at: 500, start: 0, n: 1, done: 1, again: 0, todo: 0, anomalies: {} },
      { at: 3000, start: 4000, n: 1, done: 0, again: 0, todo: 1 },          // début après la fin
      { at: 5000, start: 3000, n: -1, done: 0, again: 0, todo: 0 },          // compte négatif
      '<script>',
    ] });
    return { status: store.status(id), closures: t.closures };
  }, id);
  expect(r.status).toBe('fait');
  expect(r.closures).toEqual([
    { at: 500, start: 0, n: 1, done: 1, again: 0, todo: 0, anomalies: {} },
    { at: 2000, start: 1000, n: 5, done: 2, again: 1, todo: 2, anomalies: { absente: 1 } },
  ]);
});
