// Cas 1 : chargement du plan (toute la commune, toutes les adresses pointables), recherche de rue, gestes.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { DOCS, ID, addressData, total, trackErrors, openApp, statusOf, openLegend } = require('./helpers');

const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

test('toute la commune : 941 adresses sur 90 voies, toutes pointables', async ({ page }) => {
  const errors = trackErrors(page);
  await openApp(page);
  const { streets, addresses, presets } = addressData();
  expect([addresses.length, streets.length]).toEqual([941, 90]);

  await expect(page.locator('#map text.num')).toHaveCount(addresses.length);
  await expect(page.locator('#map text.num.ctx')).toHaveCount(0);
  expect(await page.evaluate(() => window.neyronApp.map.pointable.length)).toBe(total());
  await expect(page.locator('#total-progress')).toHaveText(`0/${total()}`);

  // une ligne de légende par rue, dans l'ordre alphabétique (sans accents), comptes conformes aux données
  await expect(page.locator('.lg-row')).toHaveCount(streets.length);
  for (const st of streets) {
    await expect(page.locator(`.lg-row[data-s="${st.i}"] .lg-count`)).toHaveText(`0/${st.count}`);
  }
  expect(streets.reduce((sum, st) => sum + st.count, 0)).toBe(total());
  const keys = streets.map((st) => fold(st.name));
  expect(keys).toEqual([...keys].sort());

  // tournée prédéfinie « 10 rues » (id de la tournée par défaut : la progression déjà saisie s'y rattache)
  expect(presets.map((pr) => pr.id)).toEqual(['default']);
  expect(presets[0].ids).toHaveLength(229);
  const ids = new Set(addresses.map((a) => a.id));
  expect(presets[0].ids.every((id) => ids.has(id))).toBe(true);
  expect(errors).toEqual([]);
});

test('couleurs des rues : palette sans les couleurs de statut', async ({ page }) => {
  await openApp(page);
  const { streets } = addressData();
  const status = await page.evaluate(() => {
    const css = getComputedStyle(document.documentElement);
    return ['--fait', '--repasser'].map((v) => css.getPropertyValue(v).trim().toLowerCase());
  });
  const used = new Set(streets.map((st) => st.colors[0].toLowerCase()));
  expect(used.size).toBeGreaterThanOrEqual(6);
  for (const c of status) expect(used.has(c), `couleur de statut ${c} utilisée par une rue`).toBe(false);
  for (const st of streets) {
    expect(st.colors.every((c) => /^#[0-9a-f]{6}$/i.test(c)), st.name).toBe(true);
    expect(st.len, st.name).toBeGreaterThanOrEqual(0);
  }
});

test('légende : recherche de rue sans accents ni casse', async ({ page }) => {
  await openApp(page);
  await openLegend(page);
  const { streets } = addressData();
  const search = page.locator('#legend-search');
  await search.fill('ecoles');
  const expected = streets.filter((st) => fold(st.name).includes('ecoles')).map((st) => st.name);
  expect(expected).toContain('Montée des Écoles');
  await expect(page.locator('.lg-row:not([hidden]) .lg-name')).toHaveText(expected);
  await search.fill('zzzz');
  await expect(page.locator('.lg-row:not([hidden])')).toHaveCount(0);
  await expect(page.locator('#legend-empty')).toBeVisible();
  await search.fill('');
  await expect(page.locator('.lg-row:not([hidden])')).toHaveCount(streets.length);
  await expect(page.locator('#legend-empty')).toBeHidden();

  // Ctrl+Z dans le champ de recherche annule la saisie, pas la progression
  await page.evaluate(async (id) => { await window.neyronApp.store.setStatus([id], 'fait'); }, ID.gare28);
  await search.fill('gare');
  await search.press('Control+z');
  await page.waitForTimeout(200);
  expect(await statusOf(page, ID.gare28)).toBe('fait');
});

test('Préparer : recherche de rue', async ({ page }) => {
  await openApp(page);
  await page.click('#tabbar [data-tab="prepare"]');
  const { streets } = addressData();
  await page.locator('#prep-search').fill('GENEVE');
  await expect(page.locator('#prep-streets .vrow-name')).toHaveText(
    streets.filter((st) => fold(st.name).includes('geneve')).map((st) => st.name));
  await page.locator('#prep-search').fill('zzzz');
  await expect(page.locator('#prep-streets .vrow')).toHaveCount(0);
  await expect(page.locator('#prep-empty')).toBeVisible();
});

test('versions de l\'app et des données dans le menu', async ({ page }) => {
  await openApp(page);
  const app = fs.readFileSync(path.join(DOCS, 'sw.js'), 'utf-8').match(/const VERSION = '(\w+)'/)[1];
  const { data } = JSON.parse(fs.readFileSync(path.join(DOCS, 'data', 'version.json'), 'utf-8'));
  expect(data).toBe(addressData().version);
  await page.click('#btn-menu');
  await expect(page.locator('#menu-version')).toHaveText(`Tournées de Neyron v0.1 · app ${app} · données ${data}`);
});

test('gestes : glisser, pincement, double tap, appui long, tap en vue d\'ensemble', async ({ page }) => {
  await openApp(page);
  // événements Pointer synthétiques (tactile) envoyés directement à la carte
  const r = await page.evaluate(async () => {
    const { map } = window.neyronApp;
    const c = map.container;
    const box = c.getBoundingClientRect();
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const frame = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    const ev = (type, id, x, y) => c.dispatchEvent(new PointerEvent(type, {
      pointerId: id, clientX: x, clientY: y, pointerType: 'touch', isPrimary: id === 1, bubbles: true, button: 0,
    }));
    const sheetHidden = () => document.getElementById('sheet').hidden;
    // fin d'un zoom animé (le tap simple attend d'abord un éventuel second tap)
    const zoomed = async (k0) => {
      const t0 = performance.now();
      while (performance.now() - t0 < 3000 && (map._anim || map.k === k0)) await frame();
    };
    const mx = box.left + box.width / 2;
    const my = box.top + box.height / 2;
    // zone vide du plan : aucun numéro pointable à moins de 60 m
    let empty = null;
    for (let x = 100; x < map.W && !empty; x += 40) {
      for (let y = 100; y < map.H && !empty; y += 40) {
        if (map.pointable.every((a) => Math.hypot(a.x - x, a.y - y) > 60)) empty = [x, y];
      }
    }
    const out = {};

    // glisser : rien sous 4 px, puis 100 px de déplacement = 100 px de carte
    map.setView(empty[0], empty[1], 2); await frame();
    const cx0 = map.cx;
    ev('pointerdown', 1, mx, my); ev('pointermove', 1, mx + 3, my); await frame();
    out.drag3 = map.cx - cx0;
    ev('pointermove', 1, mx + 100, my); ev('pointerup', 1, mx + 100, my); await frame();
    out.drag100 = (cx0 - map.cx) * map.k;

    // pincement ×2 : k double, le point sous les doigts ne bouge pas, aucun tap
    map.setView(empty[0], empty[1], 1.5); await frame();
    const k0 = map.k;
    const [wx, wy] = map.toWorld(mx, my);
    ev('pointerdown', 1, mx - 50, my); ev('pointerdown', 2, mx + 50, my);
    ev('pointermove', 1, mx - 100, my); ev('pointermove', 2, mx + 100, my); await frame();
    out.pinchRatio = map.k / k0;
    const [wx2, wy2] = map.toWorld(mx, my);
    out.pinchAnchorErr = Math.hypot(wx2 - wx, wy2 - wy);
    ev('pointerup', 2, mx + 100, my); ev('pointermove', 1, mx - 90, my); ev('pointerup', 1, mx - 90, my);
    await wait(400);
    out.pinchNoSheet = sheetHidden();

    // double tap sur une zone vide : zoom ×2
    map.setView(empty[0], empty[1], 2); await frame();
    const kd = map.k;
    ev('pointerdown', 1, mx, my); ev('pointerup', 1, mx, my); await wait(80);
    ev('pointerdown', 1, mx, my); ev('pointerup', 1, mx, my); await zoomed(kd);
    out.doubleTapRatio = map.k / kd;

    // appui long : événement longpress
    let lp = null;
    map.on('longpress', (d) => { lp = d; });
    ev('pointerdown', 1, mx, my); await wait(700); ev('pointerup', 1, mx, my); await frame();
    out.longpress = Boolean(lp);

    // vue d'ensemble (points) : un tap rapproche au lieu de pointer
    map.fitAll(false); await frame();
    const kf = map.k;
    out.overviewK = kf;
    ev('pointerdown', 1, mx, my); ev('pointerup', 1, mx, my); await zoomed(kf);
    out.overviewRatio = map.k / kf;
    out.overviewNoSheet = sheetHidden();

    // tap sur un numéro en bas d'écran : panneau ouvert, la carte remonte l'adresse au-dessus
    const a = map.pointable.find((p) => p.s === 2);
    map.setView(a.x, a.y - (box.height * 0.38) / 2.5, 2.5); await frame();
    const [sx, sy] = map.toScreen(a.x, a.y);
    ev('pointerdown', 1, sx, sy); ev('pointerup', 1, sx, sy); await wait(700);
    while (map._anim) await frame();  // décalage animé de la carte
    out.sheetOpen = !sheetHidden();
    out.sheetTitleOk = document.getElementById('sheet-title').textContent.startsWith(`${a.n}`);
    out.addrY = map.toScreen(a.x, a.y)[1];
    out.sheetTop = document.getElementById('sheet').getBoundingClientRect().top;
    return out;
  });

  expect(r.drag3, 'pas de déplacement sous 4 px').toBe(0);
  expect(r.drag100).toBeCloseTo(100, 0);
  expect(r.pinchRatio).toBeCloseTo(2, 2);
  expect(r.pinchAnchorErr, 'point sous les doigts fixe (m)').toBeLessThan(0.05);
  expect(r.pinchNoSheet, 'un pincement ne pointe rien').toBe(true);
  expect(r.doubleTapRatio).toBeCloseTo(2, 1);
  expect(r.longpress).toBe(true);
  expect(r.overviewK).toBeLessThan(0.9);
  expect(r.overviewRatio).toBeCloseTo(2.5, 1);
  expect(r.overviewNoSheet, 'en vue d\'ensemble, un tap ne pointe rien').toBe(true);
  expect(r.sheetOpen && r.sheetTitleOk).toBe(true);
  expect(r.addrY, 'adresse visible au-dessus du panneau').toBeLessThan(r.sheetTop);
});
