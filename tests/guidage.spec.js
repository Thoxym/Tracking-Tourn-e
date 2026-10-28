// Navigation de tournée (Distribuer › Démarrer) : choix de la tournée, démarrage avec ou sans itinéraire, arrêt en
// cours, consignes, arrivée, arrêt suivant automatique, hors itinéraire, repère annoncé, fin.
const { test, expect } = require('@playwright/test');
const { trackErrors, openApp, waitReady, tourIds } = require('./helpers');

const nav = (page) => page.evaluate(() => {
  const n = window.neyronApp.nav;
  return { active: n.active, k: n.k, n: n.stops?.length, total: n.leg?.total ?? null };
});

// itinéraire calculé (budget court), puis Démarrer
async function startNav(page, settings = { mode: 'car' }) {
  await page.evaluate(async (settings) => {
    const { route } = window.neyronApp;
    await route.saveSettings(settings);
    await route.compute(300);
  }, settings);
  await expect.poll(() => page.evaluate(() => window.neyronApp.store.activeTour.route?.stops?.length || 0), { timeout: 30_000 }).toBeGreaterThan(0);
  await page.click('#tabbar [data-tab="distribute"]');
  await page.click('#nav-start');
  await expect.poll(async () => (await nav(page)).active).toBe(true);
}

const simulate = (page, x, y) => page.evaluate(([x, y]) => window.neyronApp.gps.simulate(x, y, 5), [x, y]);
const stopPoint = (page, k = null) => page.evaluate((k) => {
  const n = window.neyronApp.nav;
  const s = n.stops[k ?? n.k];
  return [s.x, s.y];
}, k);

test('démarrer, consignes, arrivée, arrêt suivant automatique, annuler, sauter, terminer', async ({ page }) => {
  const errors = trackErrors(page);
  await openApp(page);
  await startNav(page);
  const { n } = await nav(page);
  await expect(page.locator('#tabbar')).toBeHidden();   // capsule d'onglets masquée pendant la navigation
  await expect(page.locator('#view-navigate')).toBeVisible();
  await expect(page.locator('#nav-banner')).toBeVisible();
  await expect(page.locator('#nav-title')).toHaveText(`Arrêt 1/${n}`);
  await expect(page.locator('.l-route-stops .route-stop.current')).toHaveCount(1);
  // feuille compacte : arrêt et temps restant en petit, la rue, puis les deux actions au petit cran ; adresses dessous,
  // « Quitter la tournée » tout en bas
  await expect(page.locator('#nav-left')).toHaveText(/^≈ .+ restantes$/);
  const lay = await page.evaluate(() => {
    const panel = document.getElementById('panel').getBoundingClientRect();
    const acts = document.querySelector('.nav-acts').getBoundingClientRect();
    const body = document.querySelector('#view-navigate .page-body');
    const last = [...body.children].filter((el) => !el.hidden).pop();
    return { panelTop: panel.top, panelH: panel.height, H: innerHeight, actsBottom: acts.bottom, actsTop: acts.top,
      addrsTop: document.getElementById('nav-addrs').getBoundingClientRect().top, last: last.id };
  });
  expect(lay.actsTop).toBeGreaterThan(lay.panelTop);
  expect(lay.actsBottom).toBeLessThanOrEqual(lay.panelTop + lay.panelH);
  expect(lay.addrsTop).toBeGreaterThan(lay.actsBottom);
  expect(lay.last).toBe('nav-stop');
  if (test.info().project.name === 'webkit-iphone') expect(lay.panelH / lay.H).toBeLessThan(0.3);
  await expect(page.locator('#nav-all')).toBeVisible();
  // pas encore de position : rejoindre l'arrêt, avec Plans / Waze
  await expect(page.locator('#nav-instr')).toContainText('Rejoignez l\'arrêt 1');
  await expect(page.locator('#nav-join')).toBeVisible();
  await expect(page.locator('#nav-plans')).toHaveAttribute('href', /^https:\/\/maps\.apple\.com\/\?daddr=45\.8\d+,4\.9\d+&dirflg=d$/);
  await expect(page.locator('#nav-waze')).toHaveAttribute('href', /^https:\/\/waze\.com\/ul\?ll=45\.8\d+,4\.9\d+&navigate=yes$/);

  // position à 150 m : trajet calculé jusqu'à l'arrêt, consigne avec une distance
  const [x, y] = await stopPoint(page);
  await simulate(page, x + 120, y + 90);
  await expect.poll(async () => (await nav(page)).total).not.toBeNull();
  await expect(page.locator('#nav-dist')).toHaveText(/^\d+ m$|^\d+,\d km$/);
  await expect(page.locator('#nav-instr')).not.toBeEmpty();
  // à l'arrêt : arrivée, numéros et côtés
  await simulate(page, x + 2, y + 2);
  await expect(page.locator('#nav-dist')).toHaveText('Arrêt 1');
  const ids = await page.evaluate(() => window.neyronApp.nav.stops[0].ids);
  await expect(page.locator('#nav-addrs .nav-addr')).toHaveCount(ids.length);

  // tout distribuer : l'arrêt suivant vient seul
  for (const id of ids) {
    // protection contre le double toucher : un toucher moins de 500 ms après le précédent est ignoré
    await page.waitForTimeout(550);
    await page.click(`#nav-addrs [data-id="${id}"] [data-act="done"]`);
    await expect.poll(() => page.evaluate((id) => window.neyronApp.store.status(id), id)).toBe('fait');
  }
  await expect(page.locator('#nav-title')).toHaveText(`Arrêt 2/${n}`);
  const st = await page.evaluate((ids) => ids.map((id) => window.neyronApp.store.status(id)), ids);
  expect(st.every((s) => s === 'fait')).toBe(true);

  // Annuler (bouton du plan) : l'adresse redevient à faire, la navigation reste sur l'arrêt en cours
  await page.click('#btn-undo');
  await expect.poll(() => page.evaluate((id) => window.neyronApp.store.status(id), ids[ids.length - 1])).toBe('a_faire');
  await expect(page.locator('#nav-title')).toHaveText(`Arrêt 2/${n}`);

  // arrêt suivant à la main
  await page.click('#nav-skip');
  await expect(page.locator('#nav-title')).toHaveText(`Arrêt 3/${n}`);

  // Quitter › Terminer la tournée : retour à Distribuer, plus de reprise proposée
  await page.click('#nav-stop');
  await page.locator('#as-list .as-btn', { hasText: 'Terminer la tournée' }).click();
  await expect(page.locator('#nav-start-label')).toHaveText('Démarrer');
  await expect(page.locator('#tabbar')).toBeVisible();
  await expect(page.locator('#nav-banner')).toBeHidden();
  await expect(page.locator('#view-distribute')).toBeVisible();
  await expect(page.locator('.l-route-stops .route-stop')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('hors itinéraire : nouveau trajet jusqu\'à l\'arrêt', async ({ page }) => {
  await openApp(page);
  await startNav(page);
  await page.evaluate(() => {
    window.neyronApp.nav.offRouteMs = 0;
    // toasts émis : le refus du vrai GPS (WebKit, sans autorisation) peut remplacer « Itinéraire recalculé » à l'écran
    const ui = window.neyronApp.ui;
    const toast = ui.toast.bind(ui);
    window.__toasts = [];
    ui.toast = (msg, opts) => (window.__toasts.push(msg), toast(msg, opts));
  });
  const [x, y] = await stopPoint(page);
  await simulate(page, x + 120, y + 90);
  await expect.poll(async () => (await nav(page)).total).not.toBeNull();
  const before = (await nav(page)).total;
  // à mi-chemin sur le tracé, puis 80 m à côté, perpendiculairement au tracé (le trajet dépend du budget de calcul :
  // un décalage fixe peut retomber près d'une autre partie du tracé)
  const [mx, my, nx, ny] = await page.evaluate(() => {
    const pts = window.neyronApp.nav.leg.pts;
    const i = Math.floor(pts.length / 2);
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return [pts[i].x, pts[i].y, -(b.y - a.y) / l, (b.x - a.x) / l];
  });
  await simulate(page, mx, my);
  await simulate(page, mx + 80 * nx, my + 80 * ny);
  await expect.poll(() => page.evaluate(() => window.__toasts.includes('Itinéraire recalculé'))).toBe(true);
  expect((await nav(page)).total).not.toBe(before);
});

test('choix de la tournée ; démarrer sans itinéraire propose le calcul', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => window.neyronApp.store.createTour('Mardi', ['01275_0420_00028', '01275_0420_00026']));
  await page.evaluate(() => window.neyronApp.store.setActiveTour('default'));
  await page.click('#tabbar [data-tab="distribute"]');
  await page.click('#dist-tour');
  await expect(page.locator('#as-list .as-btn')).toHaveCount(2);
  await page.locator('#as-list .as-btn', { hasText: 'Mardi' }).click();
  await expect(page.locator('#dist-title')).toHaveText('Mardi');

  await page.click('#nav-start');
  await expect(page.locator('#as-msg')).toContainText('Aucun itinéraire calculé');
  await page.locator('#as-list .as-btn', { hasText: 'Calculer l\'itinéraire' }).click();
  await expect(page.locator('#route-result')).toBeVisible({ timeout: 30_000 });  // Préparer › Itinéraire, calculé
  await page.click('#tabbar [data-tab="distribute"]');
  await page.click('#nav-start');
  await expect.poll(async () => (await nav(page)).active).toBe(true);
  await expect(page.locator('#nav-title')).toHaveText(/^Arrêt 1\/\d+$/);
});

test('repère sur un arrêt : annoncé quand il devient l\'arrêt en cours', async ({ page }) => {
  await openApp(page);
  await startNav(page);
  const ids = await page.evaluate(() => window.neyronApp.nav.stops.map((s) => s.ids));
  await page.evaluate((id) => window.neyronApp.store.setTags(id, ['chien'], 'Grand chien'), ids[1][0]);
  await page.evaluate((list) => window.neyronApp.store.setStatus(list, 'fait'), ids[0]);
  await expect(page.locator('#nav-title')).toHaveText(/^Arrêt 2\//);
  await expect(page.locator('#tag-alert-msg')).toContainText('Chien — Grand chien');
  await expect(page.locator(`#nav-addrs [data-id="${ids[1][0]}"] .tag-line`)).toHaveText('Chien — Grand chien');
  expect(ids.flat().length).toBe(tourIds().size);
});

test('quitter en pause puis reprendre à l\'arrêt en cours, même après une relance', async ({ page }) => {
  await openApp(page);
  await startNav(page);
  const ids = await page.evaluate(() => window.neyronApp.nav.stops.map((s) => s.ids));
  await page.evaluate((list) => window.neyronApp.store.setStatus(list, 'fait'), ids[0]);
  await expect(page.locator('#nav-title')).toHaveText(/^Arrêt 2\//);
  await page.click('#nav-skip');
  await expect(page.locator('#nav-title')).toHaveText(/^Arrêt 3\//);
  await page.click('#nav-stop');
  await expect(page.locator('#as-msg')).toContainText('l\'arrêt 3');
  await page.locator('#as-list .as-btn', { hasText: 'Mettre en pause' }).click();
  await expect(page.locator('#tabbar')).toBeVisible();
  await expect(page.locator('#nav-start-label')).toHaveText('Reprendre · arrêt 3');
  await page.reload();
  await waitReady(page);
  await page.click('#tabbar [data-tab="distribute"]');
  await expect(page.locator('#nav-start-label')).toHaveText('Reprendre · arrêt 3');
  await page.click('#nav-start');
  await expect.poll(async () => (await nav(page)).active).toBe(true);
  await expect(page.locator('#nav-title')).toHaveText(/^Arrêt 3\//);
  // l'arrêt sauté (2) revient après la fin de l'itinéraire, pas avant
  await page.click('#nav-stop');
  await page.locator('#as-list .as-btn', { hasText: 'Terminer la tournée' }).click();
  await expect(page.locator('#nav-start-label')).toHaveText('Démarrer');
  await page.reload();
  await waitReady(page);
  await expect(page.locator('#nav-start-label')).toHaveText('Démarrer');
});

test('simulation : la position avance seule, pause, vitesse, arrêt suivant et précédent, rien d\'enregistré', async ({ page }) => {
  const errors = trackErrors(page);
  await openApp(page);
  await page.evaluate(async () => { await window.neyronApp.route.compute(300); });
  await expect.poll(() => page.evaluate(() => window.neyronApp.store.activeTour.route?.stops?.length || 0), { timeout: 30_000 }).toBeGreaterThan(0);
  await page.click('#tabbar [data-tab="distribute"]');
  await expect(page.locator('#nav-sim')).toBeVisible();
  await page.click('#nav-sim');
  await expect.poll(async () => (await nav(page)).active).toBe(true);
  await expect(page.locator('#sim-bar')).toBeVisible();
  await expect(page.locator('#nav-title')).toHaveText(/^Simulation · Arrêt 1\//);
  await expect(page.locator('#btn-undo')).toBeHidden();  // rien à annuler en simulation
  // vitesse : ×1 -> ×2 -> ×4 -> ×8
  for (const v of ['×2', '×4', '×8']) {
    await page.click('#sim-speed');
    await expect(page.locator('#sim-speed')).toHaveText(v);
  }
  // accélération de test : les arrêts défilent seuls
  await page.evaluate(() => { window.neyronApp.nav.simulator.factor = 40; });
  await expect.poll(async () => (await nav(page)).k, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  // pause : la position ne bouge plus
  await page.click('#sim-play');
  await expect(page.locator('#sim-play')).toHaveAttribute('aria-label', 'Lecture');
  const p1 = await page.evaluate(() => window.neyronApp.gps.tracker.last);
  await page.waitForTimeout(600);
  const p2 = await page.evaluate(() => window.neyronApp.gps.tracker.last);
  expect([p2.x, p2.y]).toEqual([p1.x, p1.y]);
  const k = (await nav(page)).k;
  await page.click('#sim-next');
  await expect.poll(async () => (await nav(page)).k).toBe(k + 1);
  await page.click('#sim-prev');
  await expect.poll(async () => (await nav(page)).k).toBe(k);
  // statuts simulés sur le plan, mais pas dans le journal
  const r = await page.evaluate(() => ({ events: window.neyronApp.store.events.length, sim: window.neyronApp.nav.simState.size }));
  expect(r.events).toBe(0);
  expect(r.sim).toBeGreaterThan(0);
  await expect(page.locator('.l-numbers .num.st-fait').first()).toBeAttached();
  await page.click('#sim-quit');
  await expect(page.locator('#sim-bar')).toBeHidden();
  await expect(page.locator('#tabbar')).toBeVisible();
  await expect(page.locator('.l-numbers .num.st-fait')).toHaveCount(0);  // plan rendu aux statuts réels
  expect(await page.evaluate(() => window.neyronApp.store.events.length)).toBe(0);
  await expect(page.locator('#nav-start-label')).toHaveText('Démarrer');  // une simulation ne laisse pas de reprise
  expect(errors).toEqual([]);
});

// ------------------------------------------------------------- voix et carte orientée (I6)

const spoken = (page) => page.evaluate(() => window.neyronApp.voice.spoken.slice());

test('consignes vocales : démarrage, virage annoncé à l\'approche, arrivée, repère, sourdine', async ({ page }) => {
  await openApp(page);
  // synthèse vocale simulée (le navigateur de test n'a pas de voix) : on garde le journal des annonces de l'app
  // seule une voix française locale est utilisée : une voix synthétisée sur un serveur recevrait adresses et repères
  const support = await page.evaluate(() => {
    const v = window.neyronApp.voice;
    window.SpeechSynthesisUtterance ??= class { constructor(t) { this.text = t; } };
    const remote = { lang: 'fr-FR', localService: false, name: 'Google français' };
    v.synth = { speak() {}, cancel() {}, getVoices: () => [remote] };
    v.pick();
    const onlyRemote = v.supported;
    v.synth.getVoices = () => [remote, { lang: 'fr-FR', localService: true, name: 'Amélie' }];
    v.pick();
    const local = v.voice?.name;
    v.synth.getVoices = () => [];  // le navigateur de test n'a pas de voix : on garde le journal des annonces de l'app
    v.pick();
    return { onlyRemote, local, unlisted: v.supported };
  });
  expect(support).toEqual({ onlyRemote: false, local: 'Amélie', unlisted: true });
  await startNav(page);
  expect((await spoken(page))[0]).toMatch(/^Tournée démarrée\. Arrêt 1, /);
  const [x, y] = await stopPoint(page);
  await simulate(page, x + 120, y + 90);
  await expect.poll(async () => (await nav(page)).total).not.toBeNull();
  // juste avant la première consigne du trajet : annoncée une seule fois
  const m = await page.evaluate(() => {
    const { nav } = window.neyronApp;
    const man = nav.leg.maneuvers[0];
    return man ? { at: man.at, total: nav.leg.total } : null;
  });
  if (m) {
    const [px, py] = await page.evaluate((d) => {
      const leg = window.neyronApp.nav.leg;
      let k = 1;
      while (k < leg.cum.length - 1 && leg.cum[k] < d) k += 1;
      const f = (d - leg.cum[k - 1]) / (leg.cum[k] - leg.cum[k - 1] || 1);
      return [leg.pts[k - 1].x + f * (leg.pts[k].x - leg.pts[k - 1].x), leg.pts[k - 1].y + f * (leg.pts[k].y - leg.pts[k - 1].y)];
    }, Math.max(0, m.at - 12));
    await simulate(page, px, py);
    await expect.poll(async () => (await spoken(page)).some((t) => /^(Tournez|Légèrement|Continuez|Au rond-point|Faites|Dans)/.test(t))).toBe(true);
    const n = (await spoken(page)).length;
    await simulate(page, px + 0.5, py + 0.5);
    expect((await spoken(page)).length).toBe(n);
  }
  await simulate(page, x + 2, y + 2);
  await expect.poll(async () => (await spoken(page)).some((t) => t.startsWith('Arrêt 1. '))).toBe(true);

  // repère sur l'arrêt suivant : annoncé à voix haute
  const ids = await page.evaluate(() => window.neyronApp.nav.stops.map((s) => s.ids));
  await page.evaluate((id) => window.neyronApp.store.setTags(id, ['chien']), ids[1][0]);
  await page.evaluate((list) => window.neyronApp.store.setStatus(list, 'fait'), ids[0]);
  await expect.poll(async () => (await spoken(page)).some((t) => t.startsWith('Attention, ') && t.endsWith(' : Chien'))).toBe(true);

  // sourdine : plus aucune annonce
  await page.click('#nav-voice');
  await expect(page.locator('#nav-voice')).toHaveAttribute('aria-pressed', 'false');
  const n2 = (await spoken(page)).length;
  await page.evaluate((list) => window.neyronApp.store.setStatus(list, 'fait'), ids[1]);
  await page.waitForTimeout(700);
  expect((await spoken(page)).length).toBe(n2);
});

test('carte orientée : le trajet pointe vers le haut, numéros droits, tap juste ; boussole ; nord à la fin', async ({ page }) => {
  await openApp(page);
  await startNav(page);
  const [x, y] = await stopPoint(page);
  await simulate(page, x + 120, y + 90);
  await expect.poll(async () => (await nav(page)).total).not.toBeNull();
  await expect(page.locator('#btn-north')).toBeVisible();
  // le cap du trajet à venir pointe vers le haut de l'écran
  const r = await page.evaluate(() => {
    const { map, nav } = window.neyronApp;
    const h = nav._heading();
    const a = map.toScreen(0, 0);
    const b = map.toScreen(Math.cos(h) * 100, Math.sin(h) * 100);
    const num = map.addrEls.values().next().value.num.getAttribute('transform');
    return { rot: map.rotDeg, dx: b[0] - a[0], dy: b[1] - a[1], num };
  });
  expect(r.dy).toBeLessThan(-0.9 * Math.hypot(r.dx, r.dy));  // vers le haut, à 25° près
  if (Math.abs(r.rot) > 3) expect(r.num).toMatch(/^rotate\(/);
  // un toucher sur un numéro ouvre toujours la bonne adresse, plan tourné
  const id = await page.evaluate(() => window.neyronApp.nav.stops[0].ids[0]);
  const [sx, sy] = await page.evaluate((id) => {
    const { map } = window.neyronApp;
    const a = map.byId.get(id);
    map._stopAnim();
    map.setView(a.x, a.y, 3);
    map.centerOn(a.x, a.y, { minK: 3, animate: false });
    return map.toScreen(a.x, a.y);
  }, id);
  await page.mouse.click(sx, sy);
  await expect(page.locator('#sheet')).toBeVisible();
  expect(await page.evaluate(() => window.neyronApp.ui.sheetAddress?.id)).toBe(id);
  await page.click('#btn-sheet-close');
  // boussole : nord en haut, numéros sans rotation
  await page.click('#btn-north');
  await expect(page.locator('#btn-north')).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => window.neyronApp.map.rotDeg)).toBe(0);
  expect(await page.evaluate(() => window.neyronApp.map.addrEls.values().next().value.num.getAttribute('transform'))).toBeNull();
  await page.click('#btn-north');
  await expect(page.locator('#btn-north')).toHaveAttribute('aria-pressed', 'true');
  // fin de la navigation : nord en haut, boussole masquée
  await page.click('#nav-stop');
  await page.locator('#as-list .as-btn', { hasText: 'Terminer la tournée' }).click();
  expect(await page.evaluate(() => window.neyronApp.map.rotDeg)).toBe(0);
  await expect(page.locator('#btn-north')).toBeHidden();
});
