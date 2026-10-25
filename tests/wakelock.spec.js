// Garder l'écran allumé : API Wake Lock simulée (un navigateur sans interface ne tient pas de vrai verrou)
// et visibilité de la page pilotable.
const { test, expect } = require('@playwright/test');
const { GPS, trackErrors, openApp } = require('./helpers');

function mockWakeLock(mode) {
  window.__wl = { requests: 0, releases: 0, failNext: 0, held: new Set() };
  let vis = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => vis });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => vis !== 'visible' });
  window.__setVis = (v) => {
    vis = v;
    if (v === 'hidden') for (const s of [...window.__wl.held]) s.release();  // le système relâche le verrou
    document.dispatchEvent(new Event('visibilitychange'));
  };
  if (mode === 'none') {
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, get: () => undefined });
    return;
  }
  const wakeLock = {
    request: async (type) => {
      window.__wl.requests += 1;
      if (mode === 'deny' || window.__wl.failNext > 0) {
        window.__wl.failNext -= 1;
        const e = new Error('refusé');
        e.name = 'NotAllowedError';
        throw e;
      }
      const s = new EventTarget();
      s.type = type;
      s.released = false;
      s.release = async () => {
        if (s.released) return;
        s.released = true;
        window.__wl.releases += 1;
        window.__wl.held.delete(s);
        s.dispatchEvent(new Event('release'));
      };
      window.__wl.held.add(s);
      return s;
    },
  };
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, get: () => wakeLock });
}

const wake = (page) => page.evaluate(() => ({
  state: window.neyronApp.wake.state,
  pressed: document.getElementById('btn-wake').getAttribute('aria-pressed'),
  pending: document.getElementById('btn-wake').classList.contains('pending'),
  requests: window.__wl.requests,
  releases: window.__wl.releases,
}));

test.use({ permissions: ['geolocation'], geolocation: GPS.gare28 });

test('verrou pris, relâché quand la page est masquée, repris au retour', async ({ page, context }) => {
  await context.addInitScript(mockWakeLock, 'ok');
  const errors = trackErrors(page);
  await openApp(page);

  await page.click('#btn-wake');
  await expect.poll(() => wake(page)).toMatchObject({ state: 'actif', pressed: 'true', requests: 1 });

  await page.evaluate(() => window.__setVis('hidden'));
  await expect.poll(() => wake(page)).toMatchObject({ pending: true });
  expect((await wake(page)).state).toMatch(/^demandé, non tenu/);

  await page.evaluate(() => window.__setVis('visible'));
  await expect.poll(() => wake(page)).toMatchObject({ state: 'actif', requests: 2, pending: false });

  // reprise refusée hors geste (fréquent sur iOS) : en attente, nouvel essai au prochain toucher
  await page.evaluate(() => { window.__wl.failNext = 1; window.__setVis('hidden'); window.__setVis('visible'); });
  await expect.poll(() => wake(page)).toMatchObject({ pending: true });
  expect((await wake(page)).state).toContain('NotAllowedError');
  const box = await page.locator('#map').boundingBox();
  await page.mouse.click(box.x + 120, box.y + 150);  // dans le plan, au-dessus de la feuille
  await expect.poll(() => wake(page)).toMatchObject({ state: 'actif', requests: 4 });

  await page.click('#btn-wake');
  await expect.poll(() => wake(page)).toMatchObject({ state: 'inactif', pressed: 'false' });

  // démarrage du GPS : le toast propose de garder l'écran allumé
  await page.click('#btn-locate');
  await expect(page.locator('#toast-action')).toHaveText('Garder l\'écran allumé');
  await page.click('#toast-action');
  await expect.poll(() => wake(page)).toMatchObject({ state: 'actif' });
  expect(errors).toEqual([]);
});

test('verrou refusé : message de repli', async ({ page, context }) => {
  await context.addInitScript(mockWakeLock, 'deny');
  await openApp(page);
  await page.click('#btn-wake');
  await expect(page.locator('#toast-msg')).toContainText('Verrouillage auto sur Jamais');
  await expect(page.locator('#btn-wake')).toHaveAttribute('aria-pressed', 'false');
});

test('API absente : message de repli, rappel simple au démarrage du GPS', async ({ page, context }) => {
  await context.addInitScript(mockWakeLock, 'none');
  const errors = trackErrors(page);
  await openApp(page);
  await page.click('#btn-wake');
  await expect(page.locator('#toast-msg')).toContainText('Verrouillage auto sur Jamais');
  expect((await wake(page)).state).toBe('non supporté');
  await page.click('#btn-locate');
  await expect(page.locator('#toast-msg')).toContainText('gardez l\'écran allumé');
  await expect(page.locator('#toast-action')).toBeHidden();
  expect(errors).toEqual([]);
});
