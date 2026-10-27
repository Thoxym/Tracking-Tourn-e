// Itinéraire : réseau routier généré par le pipeline (roads.json) et rattachement des adresses.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { addressData, tourIds, openApp, waitReady, openPage, trackErrors } = require('./helpers');

const CAR = 1;
let roads = null;
const roadsData = () => {
  roads ??= JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'data', 'roads.json'), 'utf-8'));
  return roads;
};

test.describe('réseau routier', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'données seules : un passage suffit');

  test('graphe cohérent et chaque adresse rattachée à un tronçon', () => {
    const r = roadsData();
    const { addresses, streets } = addressData();
    const nNodes = r.nodes.length / 2;
    expect(r.attribution).toContain('OpenStreetMap');
    for (const e of r.edges) {
      const [a, b, len, m, ow, v, s, name, nw, cls, mid] = e;
      expect(a).toBeLessThan(nNodes);
      expect(b).toBeLessThan(nNodes);
      expect(len).toBeGreaterThan(0);
      expect(m & 7).toBeGreaterThan(0);  // au moins un mode
      expect([-1, 0, 1]).toContain(ow);
      expect(s).toBeLessThan(streets.length);
      expect(name).toBeLessThan(r.names.length);
      expect([0, 1]).toContain(nw);
      expect(cls).toBeLessThan(r.classes.length);
      expect(mid.length % 2).toBe(0);
      if (m & CAR) expect(v).toBeGreaterThan(0);
    }
    for (const a of addresses) {
      const sn = r.snap[a.id];
      expect(sn, a.id).toBeTruthy();
      const [ei, t, sd, off, px, py] = sn;
      const e = r.edges[ei];
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(e[2] + 0.1);
      expect([-1, 1]).toContain(sd);
      expect(off).toBeLessThan(150);
      expect(Math.hypot(px - a.x, py - a.y)).toBeLessThan(400);  // point de remise près de l'adresse
      // adresse sur un chemin non carrossable : accès voiture donné à part
      if (!(e[3] & CAR)) {
        expect(sn.length).toBe(9);
        expect(r.edges[sn[6]][3] & CAR).toBeTruthy();
      }
    }
  });

  test('tournée par défaut : chaque rue a ses tronçons, pairs et impairs de part et d\'autre', () => {
    const r = roadsData();
    const { addresses, streets } = addressData();
    const ids = tourIds();
    const gare = streets.findIndex((s) => s.name === 'Rue de la Gare');
    const gareAddrs = addresses.filter((a) => a.s === gare && ids.has(a.id));
    // Rue de la Gare : un même tronçon porte les deux côtés, pairs d'un côté, impairs de l'autre (en majorité)
    const byEdge = new Map();
    for (const a of gareAddrs) {
      const [ei, , sd] = r.snap[a.id];
      expect(r.edges[ei][6], `${a.n} Rue de la Gare`).toBe(gare);
      if (!byEdge.has(ei)) byEdge.set(ei, []);
      byEdge.get(ei).push({ side: a.side, sd });
    }
    let agree = 0;
    let all = 0;
    for (const list of byEdge.values()) {
      const pairSide = Math.sign(list.filter((x) => x.side === 'pair').reduce((s, x) => s + x.sd, 0));
      for (const x of list) {
        all += 1;
        if (!pairSide || (x.side === 'pair' ? x.sd === pairSide : x.sd === -pairSide)) agree += 1;
      }
    }
    expect(agree / all).toBeGreaterThan(0.85);
  });
});

test('menu ⋯ : sources des données et du réseau routier', async ({ page }) => {
  await openApp(page);
  await page.click('#btn-menu');
  await expect(page.locator('#menu')).toContainText('BD TOPO');
  await expect(page.locator('#menu')).toContainText('OpenStreetMap');
});

// ------------------------------------------------------------------ moteur (dans la page, WebKit et Chromium)

// charge le moteur dans la page et calcule un itinéraire ; renvoie un résumé sérialisable
async function route(page, { ids = null, settings = {}, budgetMs = 400, street = null } = {}) {
  return page.evaluate(async ({ ids, settings, budgetMs, street }) => {
    const { RoadGraph, computeRoute } = await import('./js/itinerary.js');
    const [roads, data] = await Promise.all([fetch('./data/roads.json').then((r) => r.json()), fetch('./data/addresses.json').then((r) => r.json())]);
    const graph = new RoadGraph(roads);
    let list = ids || data.presets.find((p) => p.id === 'default').ids;
    if (street) {
      const s = data.streets.findIndex((x) => x.name === street);
      list = list.filter((id) => data.addresses.find((a) => a.id === id).s === s);
      const key = list[0].split('_').slice(0, 2).join('_');
      if (settings.weaveBy === 'weave' || settings.weaveBy === 'sides') settings = { ...settings, weaveBy: { [key]: settings.weaveBy } };
    }
    const order = data.addresses.filter((a) => list.includes(a.id)).map((a) => a.id);
    const r = computeRoute({ graph, data, snap: roads.snap, ids: list, settings, order, budgetMs });
    const W = settings.walkMax ?? 40;
    const byId = new Map(data.addresses.map((a) => [a.id, a]));
    // distance du point d'arrêt à chaque point de remise de l'arrêt (hors adresses à long accès, arrêt à part)
    const farthest = r.stops.filter((s) => s.kind === 'stop' && s.ids.length > 1)
      .map((s) => Math.max(...s.ids.map((id) => Math.hypot(roads.snap[id][4] - s.x, roads.snap[id][5] - s.y))));
    return {
      n: list.length, ids: r.stops.flatMap((s) => s.ids), sec: r.totals.sec, baseline: r.baseline.sec,
      stops: r.stops.map((s) => ({ kind: s.kind, mixed: s.mixed, sides: s.sides, nums: s.ids.map((id) => byId.get(id).n) })),
      farthest: farthest.length ? Math.max(...farthest) : 0, W, missing: r.missing, unreachable: r.unreachable,
      legsOk: r.legs.slice(1).every((l) => l && l.arcs.length && Number.isFinite(l.sec)),
    };
  }, { ids, settings, budgetMs, street });
}

test.describe('moteur d\'itinéraire', () => {
  test('sens uniques : la voiture fait le tour, le piéton revient sur ses pas', async ({ page }) => {
    await openApp(page);
    const r = await page.evaluate(async () => {
      const { RoadGraph } = await import('./js/routing.js');
      const roads = await fetch('./data/roads.json').then((x) => x.json());
      const g = new RoadGraph(roads);
      const main = g.main('car');
      let e = -1;
      for (let i = 0; i < g.E; i++) if (g.eow[i] === 1 && main[i] && g.elen[i] > 40 && g.em[i] & 1) { e = i; break; }
      const len = g.elen[e];
      const out = {};
      for (const mode of ['car', 'foot']) {
        const C = g.costs(mode);
        const res = g.search(C, { arc: 2 * e, s: len * 0.8 }, { pred: true });
        const dst = { arc: 2 * e, s: len * 0.2 };  // en arrière sur le même sens unique
        const path = g.pathTo(res, dst) || [];
        out[mode] = { sec: g.costTo(res, dst), reverse: path.some((p) => p.arc === 2 * e + 1), steps: path.length };
      }
      out.direct = len * 0.6 / (g.ev[e] / 3.6);
      out.walk = len * 0.6 / (4.5 / 3.6);
      return out;
    });
    expect(r.car.reverse).toBe(false);     // jamais à contresens
    expect(r.car.steps).toBeGreaterThan(2); // il faut faire le tour
    expect(r.car.sec).toBeGreaterThan(r.direct);
    expect(r.foot.reverse).toBe(true);     // à pied : demi-tour sur place, retour direct
    expect(r.foot.steps).toBe(1);
    expect(r.foot.sec).toBeCloseTo(r.walk, 0);  // 60 % du tronçon à 4,5 km/h
  });

  test('tournée par défaut en voiture : chaque adresse une fois, marche max, mieux que l\'ordre par rues, reproductible', async ({ page }) => {
    await openApp(page);
    const a = await route(page, { settings: { mode: 'car' } });
    expect(a.missing).toEqual([]);
    expect(a.unreachable).toEqual([]);
    expect(a.ids.length).toBe(a.n);
    expect(new Set(a.ids).size).toBe(a.n);
    expect(a.farthest).toBeLessThanOrEqual(a.W + 0.5);
    expect(a.sec).toBeLessThanOrEqual(a.baseline);
    expect(a.legsOk).toBe(true);
    // même graine, même budget atteint par un optimum local : mêmes arrêts au premier passage de recherche
    const b = await route(page, { settings: { mode: 'car', seed: 7 }, budgetMs: 1 });
    const c = await route(page, { settings: { mode: 'car', seed: 7 }, budgetMs: 1 });
    expect(c.ids).toEqual(b.ids);
  });

  test('Route de Genève : tissée, les deux côtés alternent dans un arrêt ; non tissée, un seul côté, à droite', async ({ page }) => {
    await openApp(page);
    const woven = await route(page, { street: 'Route de Genève', settings: { mode: 'car', weaveBy: 'weave' } });
    const mixed = woven.stops.filter((s) => s.mixed);
    expect(mixed.length).toBeGreaterThan(3);
    // dans un arrêt tissé, pairs et impairs se suivent selon la position (zigzag)
    expect(mixed.some((s) => new Set(s.nums.map((n) => n % 2)).size === 2)).toBe(true);
    const sides = await route(page, { street: 'Route de Genève', settings: { mode: 'car', weaveBy: 'sides' } });
    expect(sides.stops.every((s) => !s.mixed)).toBe(true);
    expect(sides.stops.every((s) => s.sides.every((x) => x === 1))).toBe(true);  // toujours côté droit
    // à pied, non tissée : de longues portions d'un seul côté (un côté à l'aller, l'autre au retour)
    const foot = await route(page, { street: 'Route de Genève', settings: { mode: 'foot', weaveBy: 'sides' } });
    expect(foot.stops.every((s) => !s.mixed && new Set(s.sides).size === 1)).toBe(true);
    expect(foot.stops.length).toBeLessThan(16);
    expect(foot.ids.length).toBe(foot.n);
  });

  test('calcul dans le worker, sans figer la page', async ({ page }) => {
    await openApp(page);
    const r = await page.evaluate(async () => {
      const { RouteClient } = await import('./js/route-client.js');
      const data = window.neyronApp.data;
      const ids = data.presets.find((p) => p.id === 'default').ids;
      const client = new RouteClient();
      const phases = new Set();
      const first = client.compute({ ids, order: ids, settings: { mode: 'foot' }, budgetMs: 3000 });
      const cancelled = await Promise.race([first.then(() => false, (e) => Boolean(e.cancelled)),
        new Promise((ok) => setTimeout(() => { client.cancel(); ok(null); }, 50))]);
      const res = await client.compute({ ids, order: ids, settings: { mode: 'bike' }, budgetMs: 300, onProgress: (p) => phases.add(p) });
      return { cancelled: cancelled ?? await first.catch((e) => Boolean(e.cancelled)), n: res.totals.addresses, mode: res.mode, phases: [...phases] };
    });
    expect(r.cancelled).toBe(true);
    expect(r.n).toBe(tourIds().size);
    expect(r.mode).toBe('bike');
    expect(r.phases).toContain('matrice');
  });
});

// --------------------------------------------------------------- Préparer › Itinéraire

const routeOf = (page) => page.evaluate(() => window.neyronApp.store.activeTour.route || null);
const stopRows = (page) => page.locator('#route-stops .stop-row');

test.describe('page Itinéraire', () => {
  test('calcul, résultat, arrêts retouchés, ordre de visite, composition modifiée, conservé', async ({ page }) => {
    const errors = trackErrors(page);
    await openApp(page);
    await openPage(page, 'prepare', '#prep-route-row');
    await expect(page.locator('#route-result')).toBeHidden();
    await page.click('#route-compute');
    await expect(page.locator('#route-result')).toBeVisible({ timeout: 30_000 });
    const r = await routeOf(page);
    const n = r.stops.length;
    expect(r.stops.flatMap((st) => st.ids).length).toBe(tourIds().size);
    await expect(page.locator('#route-count')).toHaveText(String(n));
    await expect(page.locator('#route-count-l')).toHaveText('Arrêts');
    await expect(page.locator('#prep-route-n')).toHaveText(/^≈ /);
    // tracé et arrêts numérotés sur le plan pendant que la page est ouverte
    await expect(page.locator('.l-route-stops .route-stop')).toHaveCount(n);
    await expect(page.locator('.l-route .route-line')).toHaveAttribute('d', /^M/);

    // retouches : descendre le premier arrêt, fusionner, séparer
    await page.click('#route-stops-row');
    await expect(stopRows(page)).toHaveCount(n);
    const first = r.stops[0].ids;
    await page.click('#route-stops [data-k="0"] [data-act="down"]');
    await expect.poll(async () => (await routeOf(page)).stops[1].ids).toEqual(first);
    expect((await routeOf(page)).manual).toBe(true);
    const cur = await routeOf(page);
    const k = cur.stops.findIndex((st, i, all) => st.kind === 'stop' && all[i + 1]?.kind === 'stop');
    const merged = [...cur.stops[k].ids, ...cur.stops[k + 1].ids].sort();
    await page.click(`#route-stops [data-k="${k}"] [data-act="more"]`);
    await page.locator('#as-list .as-btn', { hasText: 'Fusionner' }).click();
    await expect(stopRows(page)).toHaveCount(n - 1);
    expect([...(await routeOf(page)).stops[k].ids].sort()).toEqual(merged);
    await page.click(`#route-stops [data-k="${k}"] [data-act="more"]`);
    await page.locator('#as-list .as-btn', { hasText: 'Séparer' }).click();
    await expect(stopRows(page)).toHaveCount(n);
    await page.click('#view-prepare [data-page="route-stops"] [data-back]');
    await expect(page.locator('#route-gain')).toContainText('retouché');

    // Distribuer suit l'itinéraire : la prochaine adresse est la première du premier arrêt
    const route = await routeOf(page);
    await page.click('#tabbar [data-tab="distribute"]');
    await expect(page.locator('.l-route-stops .route-stop')).toHaveCount(0);  // tracé seulement dans l'itinéraire
    await expect(page.locator('#next-pos')).toContainText(`Arrêt 1/${route.stops.length}`);
    const label = await page.evaluate((id) => {
      const { map, ui } = window.neyronApp;
      const a = map.byId.get(id);
      return `${a.n}${a.rep ? ` ${a.rep}` : ''} ${ui.streets[a.s].label}`;
    }, route.stops[0].ids[0]);
    await expect(page.locator('#next-title')).toHaveText(label);

    // composition modifiée : avis, puis mise à jour qui garde les retouches
    const gone = route.stops[2].ids[0];
    await page.evaluate((id) => window.neyronApp.prepare.setIds(window.neyronApp.store.activeTour.ids.filter((x) => x !== id)), gone);
    await openPage(page, 'prepare', '#prep-route-row');
    await expect(page.locator('#route-stale-msg')).toHaveText('Itinéraire à revoir : 1 adresse retirée.');
    await page.click('#route-update');
    await expect(page.locator('#route-stale')).toBeHidden();
    const after = await routeOf(page);
    expect(after.manual).toBe(true);
    expect(after.stops.flatMap((st) => st.ids)).not.toContain(gone);
    expect(after.stops.flatMap((st) => st.ids).length).toBe(tourIds().size - 1);

    await page.reload();
    await waitReady(page);
    expect((await routeOf(page)).stops.length).toBe(after.stops.length);
    expect(errors).toEqual([]);
  });

  test('à pied, tissage par rue, départ choisi sur le plan, réglages avancés', async ({ page }) => {
    const errors = trackErrors(page);
    await openApp(page);
    await openPage(page, 'prepare', '#prep-route-row');
    await page.locator('label', { has: page.locator('input[name="route-mode"][value="foot"]') }).click();
    await expect.poll(async () => (await routeOf(page))?.settings.mode).toBe('foot');
    await page.locator('label', { has: page.locator('input[name="route-weave"][value="never"]') }).click();
    await expect.poll(async () => (await routeOf(page)).settings.weave).toBe('never');

    // réglages avancés : propres au mode, valeur invalide refusée
    await page.click('#route-settings-row');
    await expect(page.locator('#rs-walkMax')).toBeHidden();  // pas d'arrêt à pied
    await page.fill('#rs-boxSec', '20');
    await expect.poll(async () => (await routeOf(page)).settings.custom?.foot?.boxSec).toBe(20);
    await page.fill('#rs-boxSec', '9999');
    await expect(page.locator('#rs-boxSec')).toHaveAttribute('aria-invalid', 'true');
    expect((await routeOf(page)).settings.custom.foot.boxSec).toBe(20);
    await page.click('#view-prepare [data-page="route-settings"] [data-back]');

    // départ : un toucher sur le plan
    await page.click('#route-start-row');
    await page.locator('#as-list .as-btn', { hasText: 'Choisir sur le plan' }).click();
    await expect(page.locator('#route-pick-title')).toHaveText('Point de départ');
    const box = await page.locator('#map').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + 120);
    await expect(page.locator('#route-start')).toHaveText(/^Près du /);
    const start = (await routeOf(page)).settings.start;
    expect(Number.isFinite(start.x) && Number.isFinite(start.y)).toBe(true);
    await expect(page.locator('.route-stop.start')).toHaveCount(1);
    await page.click('#route-end-row');
    await page.locator('#as-list .as-btn', { hasText: 'Retour au point de départ' }).click();
    await expect(page.locator('#route-end')).toHaveText('Retour au départ');

    // tissage forcé d'une rue depuis l'éditeur de rue
    await openPage(page, 'prepare', '#prep-streets-row');
    await page.locator('#prep-streets .vrow', { hasText: 'Rue de la Gare' }).click();
    await page.locator('label', { has: page.locator('input[name="se-weave"][value="weave"]') }).click();
    await expect.poll(async () => (await routeOf(page)).settings.weaveBy?.['01275_0420']).toBe('weave');

    await openPage(page, 'prepare', '#prep-route-row');
    await page.click('#route-compute');
    await expect(page.locator('#route-result')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#route-count-l')).toHaveText('Portions');
    const r = await routeOf(page);
    expect(r.stops.every((st) => st.kind === 'run')).toBe(true);
    // Rue de la Gare tissée : une portion couvre les deux côtés ; ailleurs, jamais tissé : un seul côté
    const gare = new Set(addressData().addresses.filter((a) => a.id.startsWith('01275_0420_')).map((a) => a.id));
    expect(r.stops.some((st) => st.ids.some((id) => gare.has(id)) && new Set(st.sides).size === 2)).toBe(true);
    expect(r.stops.filter((st) => !st.ids.some((id) => gare.has(id))).every((st) => new Set(st.sides).size === 1)).toBe(true);
    expect(errors).toEqual([]);
  });

  test('sauvegarde : un itinéraire importé est validé champ par champ', async ({ page }) => {
    await openApp(page);
    const r = await page.evaluate(async () => {
      const { validTour } = await import('./js/io.js');
      const t = validTour({
        id: 'x', name: 'X', ids: ['01275_0420_00028'],
        route: {
          settings: { mode: 'bike', weave: 'evil', weaveBy: { '01275_0420': 'weave', bad: 'x' }, custom: { bike: { walkMax: 30, stopSec: -5 } }, start: { x: 1, y: 2 }, end: 'start', hack: 1 },
          stops: [{ kind: 'stop', ids: ['01275_0420_00028'], sides: [1], arc: 4, sIn: 1, arcOut: 4, sOut: 1, x: 1, y: 1, walk: 2, service: 30, path: null, legSec: 3, legM: 4, extra: '<script>' }],
          totals: { sec: 10 }, roadsVersion: 'abc', computedAt: 5,
        },
      });
      const bad = validTour({ id: 'y', route: { stops: [{ kind: 'boom', ids: [] }] } });
      return { t, bad };
    });
    expect(r.t.route.settings).toEqual({ mode: 'bike', weaveBy: { '01275_0420': 'weave' }, custom: { bike: { walkMax: 30 } }, start: { x: 1, y: 2 }, end: 'start' });
    expect(r.t.route.stops[0].extra).toBeUndefined();
    expect(r.t.route.stops.length).toBe(1);
    expect(r.bad.route.stops).toBeUndefined();  // arrêt invalide : itinéraire ignoré, réglages gardés
  });
});
