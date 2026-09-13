/**
 * Builds `dist/kg3d.global.js` — the single-`<script>` browser bundle.
 *
 * This is the one artefact that embeds three.js rather than treating it as a
 * peer dependency, so that a plain HTML page needs no import map and no module
 * plumbing: one script tag, then `kg3d.KnowledgeGraph3D`.
 *
 * Because it redistributes three.js, MIT obliges us to carry three's copyright
 * notice with it. That is handled explicitly below rather than left to
 * esbuild's legal-comment extraction, which depends on the upstream build
 * happening to carry a banner — writing the notice ourselves is deterministic.
 */
import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outfile = resolve(root, 'dist/kg3d.global.js');

const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const threePkg = JSON.parse(
  await readFile(resolve(root, '../../node_modules/three/package.json'), 'utf8'),
);

const banner = `/*! kg3d v${pkg.version} | MIT | https://github.com/pavan1586/kg3d
 * Bundles three.js v${threePkg.version} (MIT, © 2010-2024 three.js authors).
 * Full notices: kg3d.global.js.LICENSE.txt */`;

const result = await build({
  entryPoints: [resolve(root, 'src/index.ts')],
  outfile,
  bundle: true,
  format: 'iife',
  globalName: 'kg3d',
  platform: 'browser',
  target: ['es2020', 'chrome90', 'firefox90', 'safari15'],
  minify: true,
  sourcemap: true,
  // Dynamic imports (the bloom composer) are inlined rather than split, which
  // is what keeps this a single self-contained file.
  splitting: false,
  legalComments: 'none',
  // There is no module context in an IIFE, so the layout worker cannot be
  // located from here. Defining this makes the engine's capability check fail
  // deterministically and fall back to its time-boxed main-thread simulation,
  // instead of relying on `new URL()` throwing.
  define: { 'import.meta.url': 'undefined' },
  banner: { js: banner },
  logLevel: 'warning',
  metafile: true,
});

const kg3dLicense = await readFile(resolve(root, 'LICENSE'), 'utf8');
const threeLicense = await readFile(resolve(root, '../../node_modules/three/LICENSE'), 'utf8');

await writeFile(
  `${outfile}.LICENSE.txt`,
  [
    'kg3d browser bundle — third-party licence notices',
    '='.repeat(58),
    '',
    `This file accompanies kg3d.global.js (kg3d v${pkg.version}).`,
    'Keep it alongside the bundle if you redistribute or re-minify it.',
    '',
    '-'.repeat(58),
    `kg3d v${pkg.version}`,
    '-'.repeat(58),
    '',
    kg3dLicense.trim(),
    '',
    '-'.repeat(58),
    `three.js v${threePkg.version} (bundled)`,
    '-'.repeat(58),
    '',
    threeLicense.trim(),
    '',
  ].join('\n'),
  'utf8',
);

const bytes = result.metafile.outputs['dist/kg3d.global.js']?.bytes ?? 0;
console.log(
  `wrote dist/kg3d.global.js (${(bytes / 1024).toFixed(0)} kB minified, three ${threePkg.version} bundled)`,
);
console.log('wrote dist/kg3d.global.js.LICENSE.txt');
