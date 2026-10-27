// Préparer (branche facteur, phase L4) : charge estimée, ordre de passage, vérifications avant départ,
// import d'un secteur CSV. Les attendus sont recalculés depuis addresses.json, indépendamment de l'app.
const { test, expect } = require('@playwright/test');
const { STREET, addressData, tourIds, tourStreets, trackErrors, openApp, waitReady, openLegend, openPage } = require('./helpers');

const tab = (page, name) => page.locator(`#tabbar [data-tab="${name}"]`);
const num = (a) => `${a.n}${a.rep ? ` ${a.rep}` : ''}`;
const label = (a) => `${num(a)} ${addressData().streets[a.s].label || addressData().streets[a.s].name}`;

function prim(pts) {  // arbre couvrant (même définition que l'app et le pipeline)
  const n = pts.length;
  if (n < 2) return 0;
  const best = new Array(n).fill(Infinity);
  const used = new Array(n).fill(false);
  best[0] = 0;
  let total = 0;
  for (let k = 0; k < n; k++) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!used[i] && (u < 0 || best[i] < best[u])) u = i;
    used[u] = true;
    total += best[u];
    for (let i = 0; i < n; i++) if (!used[i]) best[i] = Math.min(best[i], Math.hypot(pts[i].x - pts[u].x, pts[i].y - pts[u].y));
  }
  return total;
}
const km = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`);
const duration = (s) => {
  const min = s > 0 ? Math.max(5, Math.round(s / 300) * 5) : 0;
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
};

// adresses par rue dans l'ordre de passage (order : noms de rues ; reverse : rues en numéros décroissants)
function groups(ids, order = null, reverse = []) {
  const { addresses, streets } = addressData();
  const inside = addresses.filter((a) => ids.has(a.id));
  const present = [...new Set(inside.map((a) => a.s))];
  const seq = order ? order.map((n) => streets.findIndex((st) => (st.label || st.name) === n)) : present;
  return seq.map((s) => {
    const addrs = inside.filter((a) => a.s === s);
    return reverse.includes(streets[s].label || streets[s].name) ? addrs.reverse() : addrs;
  });
}
function load(gs, sec = 20, kmh = 4) {
  let m = 0;
  let n = 0;
  gs.filter((g) => g.length).forEach((g, k, all) => {
    n += g.length;
    m += prim(g);
    if (k) m += Math.hypot(g[0].x - all[k - 1].at(-1).x, g[0].y - all[k - 1].at(-1).y);
  });
  return { dist: km(m), time: duration(n * sec + m / (kmh / 3.6)), m, n };
}

// écart en pixels entre un point du plan et le centre de la zone visible de la carte
const centerError = (page, x, y) => page.evaluate(([x, y]) => {
  const { map } = window.neyronApp;
  const r = map.container.getBoundingClientRect();
  const p = map.padding;
  const [sx, sy] = map.toScreen(x, y);
  return Math.hypot(sx - (r.left + (r.width + p.left - p.right) / 2), sy - (r.top + (r.height + p.top - p.bottom) / 2));
}, [x, y]);

const orderNames = (page) => page.locator('#prep-order .order-row .vrow-name');
const numbered = (names) => names.map((n, k) => `${k + 1}. ${n}`);

test('charge estimée : distance, durée, réglages mémorisés, reste à faire dans Contrôler', async ({ page }) => {
  const errors = trackErrors(page);
  await openApp(page);
  await tab(page, 'prepare').click();
  const full = load(groups(tourIds()));
  await expect(page.locator('#prep-summary')).toHaveText(`${full.n} adresses · ${tourStreets().length} rues`);
  await expect(page.locator('#prep-load-dist')).toHaveText(`≈ ${full.dist}`);
  await expect(page.locator('#prep-load-time')).toHaveText(`≈ ${full.time}`);

  // l'arbre couvrant de l'app (Prim) retrouve la longueur des rues calculée par le pipeline (scipy)
  const gap = await page.evaluate(async () => {
    const { mstLength } = await import('./js/tourplan.js');
    const { data, map } = window.neyronApp;
    return Math.max(...data.streets.map((st) => Math.abs(mstLength(map.pointable.filter((a) => a.s === st.i)) - st.len)));
  });
  expect(gap).toBeLessThanOrEqual(1);

  // réglages : virgule décimale acceptée, valeur invalide signalée puis abandonnée
  await openPage(page, 'prepare', '#prep-settings-row');
  await expect(page.locator('#set-sec')).toHaveValue('20');
  await expect(page.locator('#set-kmh')).toHaveValue('4');
  await page.locator('#set-sec').fill('0');
  await page.locator('#set-kmh').fill('4,5');
  const tuned = load(groups(tourIds()), 0, 4.5);
  await expect(page.locator('#prep-load-time')).toHaveText(`≈ ${tuned.time}`);
  await page.locator('#set-sec').fill('abc');
  await expect(page.locator('#set-sec')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#prep-load-time')).toHaveText(`≈ ${tuned.time}`);
  await page.locator('#set-kmh').focus();
  await expect(page.locator('#set-sec')).toHaveValue('0');

  await page.reload();
  await waitReady(page);
  await tab(page, 'prepare').click();
  await expect(page.locator('#set-kmh')).toHaveValue('4,5');
  await expect(page.locator('#prep-load-time')).toHaveText(`≈ ${tuned.time}`);

  // Contrôler : reste estimé sur les adresses non faites
  await tab(page, 'control').click();
  await expect(page.locator('#ctl-left')).toHaveText(`Reste ≈ ${tuned.time} · ${tuned.dist} (estimation)`);
  const gare = addressData().addresses.filter((a) => a.s === STREET.gare).map((a) => a.id);
  await page.evaluate((ids) => window.neyronApp.store.setStatus(ids, 'fait'), gare);
  const left = load(groups(new Set([...tourIds()].filter((id) => !gare.includes(id)))), 0, 4.5);
  await expect(page.locator('#ctl-left')).toHaveText(`Reste ≈ ${left.time} · ${left.dist} (estimation)`);
  expect(errors).toEqual([]);
});

test('ordre de passage : monter, descendre, sens ; suivi par la légende et Contrôler, conservé', async ({ page }) => {
  const errors = trackErrors(page);
  await openApp(page);
  await openPage(page, 'prepare', '#prep-order-row');
  const alpha = tourStreets().map((st) => st.label || st.name);
  await expect(orderNames(page)).toHaveText(numbered(alpha));
  await expect(page.locator('#prep-order-n')).toHaveText(`${alpha.length} rues`);
  await expect(page.locator('#btn-order-reset')).toBeDisabled();

  const [a, b] = alpha;
  await page.click(`[aria-label="Descendre : ${a}"]`);
  const order = [b, a, ...alpha.slice(2)];
  await expect(orderNames(page)).toHaveText(numbered(order));
  // le focus suit le bouton utilisé (clavier, VoiceOver)
  expect(await page.evaluate(() => document.activeElement.getAttribute('aria-label'))).toBe(`Descendre : ${a}`);
  await page.click('[aria-label="Monter : Rue de la Gare"]');
  const last = order.length - 1;
  [order[last - 1], order[last]] = [order[last], order[last - 1]];
  await expect(orderNames(page)).toHaveText(numbered(order));

  // sens inversé : numéros décroissants ; la distance suit l'ordre et le sens
  const rev = page.locator('[aria-label="Inverser le sens : Rue de la Gare"]');
  await rev.click();
  await expect(rev).toHaveAttribute('aria-pressed', 'true');
  const gare = addressData().addresses.filter((x) => x.s === STREET.gare);
  await expect(page.locator(`#prep-order .order-row[data-s="${STREET.gare}"] .vrow-sub`))
    .toContainText(`n° ${num(gare.at(-1))} → ${num(gare[0])}`);
  await expect(page.locator('#prep-load-dist')).toHaveText(`≈ ${load(groups(tourIds(), order, ['Rue de la Gare'])).dist}`);

  await openLegend(page);
  await expect(page.locator('.lg-row:not([hidden]) .lg-name')).toHaveText(order);
  await tab(page, 'control').click();
  await expect(page.locator('#ctl-streets .vrow-name')).toHaveText(order);

  await page.reload();
  await waitReady(page);
  await openPage(page, 'prepare', '#prep-order-row');
  await expect(orderNames(page)).toHaveText(numbered(order));
  await expect(rev).toHaveAttribute('aria-pressed', 'true');

  await page.click('#btn-order-reset');
  await page.click('#confirm-ok');
  await expect(orderNames(page)).toHaveText(numbered(alpha));
  await expect(rev).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#btn-order-reset')).toBeDisabled();
  expect(errors).toEqual([]);
});

test('vérifications : numéros sans bâtiment, bâtiments sans adresse, numéro oublié ajouté', async ({ page }) => {
  const errors = trackErrors(page);
  await openApp(page);
  const { addresses, unaddressed } = addressData();
  const inTour = addresses.filter((a) => tourIds().has(a.id));
  const noBld = inTour.filter((a) => !a.bat);
  const near = unaddressed.map((u) => ({ u, d: Math.min(...inTour.map((a) => Math.hypot(a.x - u.x, a.y - u.y))) }))
    .filter((x) => x.d <= 60).sort((p, q) => p.d - q.d);
  expect(noBld.length).toBeGreaterThan(0);
  expect(near.length).toBeGreaterThan(0);

  await openPage(page, 'prepare', '#prep-checks-row');
  await expect(page.locator('#prep-checks-n')).toHaveText(`${noBld.length + near.length} points`);
  await expect(page.locator('[data-check="gaps"] .check-none')).toBeVisible();
  await expect(page.locator('[data-check="nobld"] .vrow-name')).toHaveText(noBld.map(label));
  await expect(page.locator('[data-check="unaddressed"] .vrow-name')).toHaveText(near.map(({ u }) => `Bâtiment de ${u.a} m²`));

  // bâtiment sans adresse : la feuille se réduit, le plan se centre dessus, avec un repère
  await page.locator('[data-check="unaddressed"] .vrow').first().click();
  await expect(page.locator('#app')).toHaveAttribute('data-tab', 'prepare');
  await expect(page.locator('#map .mark-ring')).toHaveAttribute('display', 'inline');
  await expect.poll(() => centerError(page, near[0].u.x, near[0].u.y)).toBeLessThan(3);
  // numéro sans bâtiment : fiche d'adresse ouverte
  await openPage(page, 'prepare', '#prep-checks-row');
  await expect(page.locator('#map .mark-ring')).toHaveAttribute('display', 'none');
  await page.locator('[data-check="nobld"] .vrow').first().click();
  await expect(page.locator('#sheet')).toBeVisible();
  await expect(page.locator('#sheet-title')).toHaveText(label(noBld[0]));

  // Rue de la Gare sans un numéro pair du milieu : signalé entre ses voisins du même côté, ajouté en un geste
  const gare = addresses.filter((a) => a.s === STREET.gare);
  const pairs = gare.filter((a) => a.side === 'pair');
  const k = Math.floor(pairs.length / 2);
  const hole = pairs[k];
  await page.evaluate((ids) => window.neyronApp.store.createTour('Trous', ids), gare.filter((a) => a !== hole).map((a) => a.id));
  await tab(page, 'prepare').click();
  await expect(page.locator('[data-check="gaps"] .vrow-name')).toHaveText([label(hole)]);
  await expect(page.locator('[data-check="gaps"] .vrow-sub')).toHaveText(`entre le ${num(pairs[k - 1])} et le ${num(pairs[k + 1])}`);
  await page.locator('[data-check="gaps"] .btn').click();
  await expect(page.locator('#toast-msg')).toHaveText('1 numéro ajouté à la tournée');
  await expect(page.locator('[data-check="gaps"] .check-none')).toBeVisible();
  expect(await page.evaluate((id) => window.neyronApp.store.activeTour.ids.includes(id), hole.id)).toBe(true);
  expect(errors).toEqual([]);
});

test('import d\'un secteur CSV : ordre, sens, lignes invalides signalées, Windows-1252', async ({ page }) => {
  const errors = trackErrors(page);
  await openApp(page);
  await tab(page, 'prepare').click();
  // fichier enregistré par Excel en français : Windows-1252, séparateur « ; », en-tête, commentaire
  const csv = [
    'voie;début;fin;côté',
    '# secteur de test',
    'Route de Genève;193;58;pairs',
    'Rue de la Garre;;;',
    'Chemin du Barry',
    'Montée Neuve;1;20;IMPAIRS',
    'Impasse des Pêcheurs;x;;',
    '"Rue de la Gare";;;les deux',
  ].join('\r\n');
  await page.setInputFiles('#sector-file', { name: 'secteur-test.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'latin1') });

  const { addresses, streets } = addressData();
  const s = (name) => streets.findIndex((st) => st.name === name);
  const pick = (name, f = () => true) => addresses.filter((a) => a.s === s(name) && f(a));
  const geneve = pick('Route de Genève', (a) => a.side === 'pair' && a.n >= 58 && a.n <= 193);
  const ids = [...geneve, ...pick('Chemin du Barry'), ...pick('Montée Neuve', (a) => a.side === 'impair' && a.n <= 20), ...pick('Rue de la Gare')];
  await expect(page.locator('#prompt')).toHaveJSProperty('open', true);
  await expect(page.locator('#prompt-input')).toHaveValue('secteur-test');
  const detail = page.locator('#prompt-detail');
  await expect(detail).toContainText(`Secteur : ${ids.length} adresses sur 4 rues, dans l'ordre du fichier.`);
  await expect(detail).toContainText('2 lignes ignorées (ligne 4 : voie inconnue « Rue de la Garre » (« Rue de la Gare » ?) ; ligne 7 : début invalide « x »).');
  await page.locator('#prompt-input').fill('Secteur test');
  await page.click('#prompt-ok');
  await expect(page.locator('#toast-msg')).toHaveText(`« Secteur test » créée : ${ids.length} adresses sur 4 rues`);
  await expect(page.locator('#prep-tour-name')).toHaveText('Secteur test');
  expect(await page.evaluate(() => window.neyronApp.store.activeTour.ids.length)).toBe(ids.length);

  // ordre du fichier ; Route de Genève en numéros décroissants (193 → 58)
  await openPage(page, 'prepare', '#prep-order-row');
  await expect(orderNames(page)).toHaveText(numbered(['Route de Genève (Neyron)', 'Chemin du Barry', 'Montée Neuve', 'Rue de la Gare']));
  await expect(page.locator('[aria-label="Inverser le sens : Route de Genève (Neyron)"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(`#prep-order .order-row[data-s="${s('Route de Genève')}"] .vrow-sub`))
    .toContainText(`n° ${num(geneve.at(-1))} → ${num(geneve[0])}`);

  // aucune ligne valide : rien n'est créé
  await page.setInputFiles('#sector-file', { name: 'faux.csv', mimeType: 'text/csv', buffer: Buffer.from('Rue Inexistante du Pont;;;\n') });
  await expect(page.locator('#toast-msg')).toContainText('Import impossible : aucune ligne valide. 1 ligne ignorée (ligne 1 : voie inconnue');
  // UTF-8 avec BOM, puis Annuler : rien n'est créé
  await page.setInputFiles('#sector-file', { name: 'gare.csv', mimeType: 'text/csv', buffer: Buffer.from('﻿Rue de la Gare\n', 'utf-8') });
  await expect(page.locator('#prompt-detail')).toHaveText(`Secteur : ${pick('Rue de la Gare').length} adresses sur 1 rue, dans l'ordre du fichier.`);
  await page.click('#prompt button[value="cancel"]');
  await expect(page.locator('#tour-list .tour-row')).toHaveCount(2);

  // nom porté par plusieurs communes : seul, il faut préciser ; avec la commune, il est reconnu
  await page.setInputFiles('#sector-file', { name: 'geneve.csv', mimeType: 'text/csv', buffer: Buffer.from('Route de Genève;;;\n', 'utf-8') });
  await expect(page.locator('#toast-msg')).toContainText('ligne 1 : voie présente dans plusieurs communes : précisez « Route de Genève (Neyron) », « Route de Genève (Beynost) »');
  const beynost = streets.findIndex((st) => st.label === 'Route de Genève (Beynost)');
  await page.setInputFiles('#sector-file', { name: 'geneve.csv', mimeType: 'text/csv', buffer: Buffer.from('Route de Genève (Beynost);;;\n', 'utf-8') });
  await expect(page.locator('#prompt-detail')).toHaveText(`Secteur : ${addresses.filter((x) => x.s === beynost).length} adresses sur 1 rue, dans l'ordre du fichier.`);
  await page.click('#prompt button[value="cancel"]');
  expect(errors).toEqual([]);
});
