// Tests de bout en bout : `npx playwright test`. La config lance son propre serveur statique sur le
// port 8100 (tests/serve.py), distinct du serveur de développement (8000). Chaque test part d'un
// contexte neuf : IndexedDB, caches et service worker vides.
const { defineConfig, devices } = require('@playwright/test');
const { PYTHON, SERVE } = require('./tests/helpers');

const PORT = 8100;
const BASE_URL = `http://127.0.0.1:${PORT}/`;

module.exports = defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 7_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    // moteur de Safari, profil iPhone (écran, tactile, user agent) : la cible réelle
    { name: 'webkit-iphone', use: { ...devices['iPhone 13'] } },
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    // http.server avec une file d'attente plus longue, sur la boucle locale uniquement
    command: `${PYTHON} "${SERVE}" docs ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
  },
});
