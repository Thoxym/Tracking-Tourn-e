// Cas 1 : chargement du plan (229 numéros pointables, contexte en gris), gestes de la carte.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { DOCS, addressData, trackErrors, openApp } = require('./helpers');

test('le plan se charge : 229 numéros pointables, 11 de contexte en gris', async ({ page }) => {
  const errors = trackErrors(page);
  await openApp(page);

  await expect(page.locator('#map text.num')).toHaveCount(240);
  await expect(page.locator('#map text.num.ctx')).toHaveCount(11);
  expect(await page.evaluate(() => window.neyronApp.map.pointable.length)).toBe(229);
  await expect(page.locator('#total-progress')).toHaveText('0/229');

  // une ligne de légende par rue, comptes conformes aux données
  const { streets } = addressData();
  await expect(page.locator('.lg-row')).toHaveCount(streets.length);
  for (const st of streets) {
    await expect(page.locator(`.lg-row[data-s="${st.i}"] .lg-count`)).toHaveText(`0/${st.count}`);
  }
  expect(streets.reduce((sum, st) => sum + st.count, 0)).toBe(229);

  // contexte : gris (et non la couleur de la rue)
  const fills = await page.evaluate(() => {
    const ctx = document.querySelector('#map text.num.ctx');
    const s = window.neyronApp.map.byId.get(ctx.dataset.id).s;
    const own = [...document.querySelectorAll('#map text.num:not(.ctx)')]
      .find((t) => window.neyronApp.map.byId.get(t.dataset.id).s === s);
    return { ctx: getComputedStyle(ctx).fill, street: getComputedStyle(own).fill };
  });
  const [r, g, b] = fills.ctx.match(/\d+/g).map(Number);
  expect(Math.max(r, g, b) - Math.min(r, g, b), `gris attendu, obtenu ${fills.ctx}`).toBeLessThan(20);
  expect(fills.ctx).not.toBe(fills.street);

  expect(errors).toEqual([]);
});

test('un numéro de contexte n\'est pas pointable', async ({ page }) => {
  await openApp(page);
  // numéro de contexte isolé : aucun numéro pointable à moins de 15 m (rayon de tap : 22 px = 7 m à ce zoom)
  const [x, y] = await page.evaluate(() => {
    const { map } = window.neyronApp;
    const ctx = map.data.addresses.filter((a) => a.ctx);
    const far = ctx.find((c) => map.pointable.every((a) => Math.hypot(a.x - c.x, a.y - c.y) > 15));
    map.setView(far.x, far.y, 3);
    return map.toScreen(far.x, far.y);
  });
  await page.mouse.click(x, y);
  await page.waitForTimeout(500);
  await expect(page.locator('#sheet')).toBeHidden();
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
    for (let x = 100; x < map.W && !empty; x += 20) {
      for (let y = 100; y < map.H && !empty; y += 20) {
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
