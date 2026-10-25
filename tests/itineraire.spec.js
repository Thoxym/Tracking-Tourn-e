// Itinéraire : réseau routier généré par le pipeline (roads.json) et rattachement des adresses.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { addressData, tourIds, openApp } = require('./helpers');

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
      expect(off).toBeLessThan(120);
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
