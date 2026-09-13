/**
 * Headless render smoke test.
 *
 * Loads the built demo in Chromium with software rendering and asserts the
 * engine actually drew something: a WebGL canvas exists, the analytics pass
 * produced the expected node count, and nothing threw. Shader compilation
 * failures and WebGL wiring regressions are invisible to unit tests and very
 * visible here.
 *
 * Usage: node scripts/smoke-render.mjs
 * Assumes `npm run build && npm run build:demo` has already run.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', 'apps/demo/dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let file = join(root, normalize(decodeURIComponent(url.pathname)));
    if (!file.startsWith(root)) throw new Error('path traversal');
    const info = await stat(file).catch(() => null);
    if (!info || info.isDirectory()) file = join(root, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

await new Promise((done) => server.listen(4180, done));

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  // Escape hatch for sandboxes and images that already carry a Chromium build
  // rather than Playwright's own download. Unset in CI, where `npx playwright
  // install chromium` provides the matching binary.
  ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
    : {}),
});

const failures = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    // Font CDNs and GPU driver notes are noise on a runner; genuine engine
    // errors are not.
    const text = message.text();
    if (message.type() === 'error' && !/ERR_|favicon|GL Driver/.test(text)) errors.push(text);
  });

  await page.goto('http://localhost:4180/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 30_000 });
  // Give the layout time to settle and the analytics pass time to publish.
  await page.waitForTimeout(8000);

  const state = await page.evaluate(() => ({
    canvases: document.querySelectorAll('canvas').length,
    hudPanels: document.querySelectorAll('.kg3d-panel').length,
    footer: document.querySelector('.app__footer')?.textContent ?? '',
    // A blank frame and a rendered frame differ in how much non-background
    // pixel data the canvas holds; `toDataURL` length is a crude but reliable
    // proxy that needs no image decoding.
    pixels: (() => {
      const canvas = document.querySelector('canvas');
      try {
        return canvas ? canvas.toDataURL().length : 0;
      } catch {
        return -1;
      }
    })(),
  }));

  console.log(JSON.stringify(state, null, 2));
  await page.screenshot({ path: resolve(here, '..', 'smoke-render.png') });

  if (state.canvases < 2) failures.push(`expected 2 canvases, saw ${state.canvases}`);
  if (state.hudPanels < 3) failures.push(`HUD did not render (${state.hudPanels} panels)`);
  if (!/\d+\s*nodes/.test(state.footer))
    failures.push(`analytics never reported: "${state.footer}"`);
  if (state.pixels < 5000)
    failures.push(`canvas looks blank (${state.pixels} bytes of image data)`);
  if (errors.length) failures.push(`console/page errors: ${errors.slice(0, 5).join(' | ')}`);
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  console.error('\nSmoke test failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\nRender smoke test passed.');
