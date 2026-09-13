/**
 * Emits `dist/styles.css` from the single source of truth for HUD styling
 * (`HUD_CSS` in src/ui/Hud.ts), so apps that prefer to bundle CSS themselves
 * can import '@kg3d/core/styles.css' and disable the runtime <style> injection.
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const distIndex = resolve(here, '../dist/index.js');

const { HUD_CSS } = await import(distIndex);
const banner = `/* kg3d HUD styles — generated from src/ui/Hud.ts, do not edit by hand. */\n`;
await writeFile(resolve(here, '../dist/styles.css'), banner + HUD_CSS, 'utf8');
console.log('wrote dist/styles.css');
