// Cas 6 : hors ligne après une première visite ; mise à jour par le bandeau « Recharger ».
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { test, expect } = require('@playwright/test');
const { PYTHON, DOCS, SERVE, ID, total, trackErrors, openApp, openPage, waitReady, statusOf } = require('./helpers');

const swVersion = (file) => fs.readFileSync(file, 'utf-8').match(/const VERSION = '(\w+)'/)[1];
const precacheSize = () => fs.readFileSync(path.join(DOCS, 'sw.js'), 'utf-8')
  .match(/const PRECACHE = \[([^\]]*)\]/)[1].split(',').filter((s) => s.trim()).length;
const waitControlled = (page) => page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 15_000 });
const caches = (page) => page.evaluate(async () => {
  const out = {};
  for (const k of await window.caches.keys()) out[k] = (await (await window.caches.open(k)).keys()).length;
  return out;
});

test('hors ligne après une première visite : l\'app se charge et le pointage est conservé', async ({ page, context }) => {
  const errors = trackErrors(page);
  await openApp(page);
  await page.evaluate(() => { window.__marker = 1; });
  await waitControlled(page);

  // tout est précaché, la page passe sous contrôle sans rechargement ni bandeau
  const version = swVersion(path.join(DOCS, 'sw.js'));
  await expect.poll(() => caches(page)).toEqual({ [`neyron-tournees-${version}`]: precacheSize() });
  expect(await page.evaluate(() => window.__marker)).toBe(1);
  await expect(page.locator('#update-banner')).toBeHidden();

  await context.setOffline(true);
  await page.reload();
  await waitReady(page);
  await expect(page.locator('#map text.num')).toHaveCount(total());

  // tout ce que la page a chargé est dans le précache (Chromium pourrait sinon se rabattre sur son
  // cache HTTP et masquer un fichier oublié ; l'iPhone, lui, ne garantit pas ce cache)
  const missing = await page.evaluate(async (name) => {
    const cache = await window.caches.open(name);
    const urls = [location.href, ...performance.getEntriesByType('resource').map((e) => e.name)]
      .filter((u) => u.startsWith(location.origin));
    const out = [];
    for (const u of urls) if (!(await cache.match(u, { ignoreSearch: true }))) out.push(u);
    return out;
  }, `neyron-tournees-${version}`);
  expect(missing, 'fichiers chargés absents du précache').toEqual([]);

  // navigation avec paramètre : servie par le cache aussi
  await openApp(page, './?debug=1');
  await expect(page.locator('#debug .debug-body')).toContainText('réseau : hors ligne');
  await expect(page.locator('#debug .debug-body')).toContainText('page contrôlée : oui');
  await expect(page.locator('#debug .debug-body')).toContainText(`version app : ${version}`);

  await page.evaluate(async (id) => { await window.neyronApp.store.setStatus([id], 'fait'); }, ID.gare28);
  await page.reload();
  await waitReady(page);
  expect(await statusOf(page, ID.gare28)).toBe('fait');
  expect(errors).toEqual([]);
});

test('hors ligne : itinéraire calculé dans le worker, puis simulation de la tournée', async ({ page, context }) => {
  const errors = trackErrors(page);
  await openApp(page);
  await waitControlled(page);
  const version = swVersion(path.join(DOCS, 'sw.js'));
  await expect.poll(() => caches(page)).toEqual({ [`neyron-tournees-${version}`]: precacheSize() });
  await context.setOffline(true);
  await page.reload();
  await waitReady(page);

  // le worker, ses modules et le réseau routier viennent du cache du service worker
  await openPage(page, 'prepare', '#prep-route-row');
  await page.click('#route-compute');
  await expect(page.locator('#route-result')).toBeVisible({ timeout: 30_000 });
  const stops = await page.evaluate(() => window.neyronApp.store.activeTour.route.stops.length);
  expect(stops).toBeGreaterThan(10);
  const fromCache = await page.evaluate(async (name) => {
    const cache = await window.caches.open(name);
    const out = {};
    for (const f of ['js/route-worker.js', 'js/route-client.js', 'js/routing.js', 'js/itinerary.js', 'js/guidance.js', 'data/roads.json']) {
      out[f] = Boolean(await cache.match(new URL(f, location.href).href));
    }
    return out;
  }, `neyron-tournees-${version}`);
  expect(Object.values(fromCache).every(Boolean), JSON.stringify(fromCache)).toBe(true);

  // simulation hors ligne : la position avance, les arrêts sont servis
  await page.click('#tabbar [data-tab="distribute"]');
  await page.click('#nav-sim');
  await expect(page.locator('#sim-bar')).toBeVisible();
  await expect(page.locator('#nav-banner')).toBeVisible();
  await page.evaluate(() => { window.neyronApp.nav.simulator.factor = 40; });
  await expect.poll(() => page.evaluate(() => window.neyronApp.nav.k), { timeout: 30_000 }).toBeGreaterThan(0);
  await page.click('#sim-quit');
  await expect(page.locator('#tabbar')).toBeVisible();
  expect(errors).toEqual([]);
});

test('le stamp de sw.js est à jour (sinon l\'iPhone ne voit pas la nouvelle version)', async ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'indépendant du navigateur : un seul passage');
  const r = spawnSync(PYTHON, [path.join('pipeline', 'build.py'), '--check'], {
    cwd: path.join(DOCS, '..'), encoding: 'utf-8',
  });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
});

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

// copie du site servie sur un autre port : on peut y « publier » une nouvelle version sans toucher à docs/
async function startCopy(dir) {
  fs.cpSync(DOCS, dir, { recursive: true });
  const port = await freePort();
  const server = spawn(PYTHON, [SERVE, dir, String(port)], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) return { server, url }; } catch { /* pas encore prêt */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  server.kill();
  throw new Error(`serveur de test injoignable : ${url}`);
}

test('nouvelle version : bandeau, rechargement à la demande, ancien cache purgé', async ({ page }, testInfo) => {
  const dir = testInfo.outputPath('site');
  const { server, url } = await startCopy(dir);
  try {
    await openApp(page, url);
    await waitControlled(page);
    const swFile = path.join(dir, 'sw.js');
    const v1 = swVersion(swFile);
    await expect.poll(() => caches(page)).toHaveProperty(`neyron-tournees-${v1}`, precacheSize());
    // cache d'un autre site de la même origine (<user>.github.io) : ne doit pas être touché
    await page.evaluate(async () => { await (await window.caches.open('autre-site-v1')).put('/autre', new Response('x')); });

    // « push » d'une nouvelle version : seul le bloc VERSION de sw.js change
    const v2 = `${v1.slice(0, -1)}${v1.endsWith('0') ? '1' : '0'}`;
    fs.writeFileSync(swFile, fs.readFileSync(swFile, 'utf-8').replace(`const VERSION = '${v1}'`, `const VERSION = '${v2}'`));
    await page.evaluate(() => { window.__marker = 2; });
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration()).update(); });

    await expect(page.locator('#update-banner')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.__marker), 'aucun rechargement imposé').toBe(2);

    await Promise.all([page.waitForEvent('load', { timeout: 15_000 }), page.click('#btn-update')]);
    await waitReady(page);
    expect(await page.evaluate(() => window.__marker)).toBeUndefined();
    await expect(page.locator('#update-banner')).toBeHidden();
    const after = await caches(page);
    expect(after).toEqual({ [`neyron-tournees-${v2}`]: precacheSize(), 'autre-site-v1': 1 });
  } finally {
    server.kill();
  }
});
