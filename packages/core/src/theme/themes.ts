import type { Theme, ThemeName } from '../types.js';

/**
 * Four calibrated themes. The palettes are chosen for hue separation at low
 * saturation so a dense graph reads as one system rather than confetti — the
 * categorical colours sit within a narrow lightness band, which keeps every
 * class equally legible against the background.
 */

const OBSIDIAN: Theme = {
  name: 'obsidian',
  background: '#070910',
  backgroundDeep: '#03040a',
  fogNear: 900,
  fogFar: 3400,
  palette: [
    '#4a7df0', // azure
    '#2ec5ad', // teal
    '#9d6ff0', // violet
    '#e89a45', // amber
    '#ec6076', // rose
    '#5fc978', // mint
    '#d9b84e', // gold
    '#48b9ef', // sky
    '#b072e8', // orchid
    '#7a8aa8', // steel
  ],
  nodeDefault: '#8fa2c4',
  edgeColor: '#2a3a5c',
  edgeHighlight: '#8fd0ff',
  labelColor: '#dbe4f5',
  labelHaloColor: 'rgba(5,8,16,0.85)',
  selectionColor: '#ffffff',
  hoverColor: '#a9d4ff',
  gridColor: '#101a2e',
  ambientParticles: 2600,
  bloomStrength: 0.52,
  bloomRadius: 0.58,
  bloomThreshold: 0.62,
};

const NEBULA: Theme = {
  ...OBSIDIAN,
  name: 'nebula',
  background: '#0a0714',
  backgroundDeep: '#050310',
  palette: [
    '#7c6bff',
    '#38d6ff',
    '#ff6fb1',
    '#ffc46b',
    '#5ef2c4',
    '#c47bff',
    '#ff8f6b',
    '#6fa8ff',
    '#e46bff',
    '#9aa6d4',
  ],
  edgeColor: '#332a5e',
  edgeHighlight: '#c0a8ff',
  gridColor: '#171029',
  bloomStrength: 0.66,
  bloomThreshold: 0.55,
};

const SLATE: Theme = {
  ...OBSIDIAN,
  name: 'slate',
  background: '#121417',
  backgroundDeep: '#0b0d0f',
  palette: [
    '#4f9df7',
    '#2fbfa4',
    '#a67bf0',
    '#e0a85e',
    '#e8748c',
    '#6fc97d',
    '#d8bd63',
    '#5cc0e8',
    '#b184e8',
    '#8a95a6',
  ],
  edgeColor: '#2b3138',
  edgeHighlight: '#7fb6e8',
  gridColor: '#1b1f24',
  ambientParticles: 1400,
  bloomStrength: 0.3,
  bloomThreshold: 0.7,
};

const DAYLIGHT: Theme = {
  name: 'daylight',
  background: '#f4f6fa',
  backgroundDeep: '#e6ebf3',
  fogNear: 1100,
  fogFar: 3600,
  palette: [
    '#2f6fd0',
    '#118c7a',
    '#7a4fd0',
    '#c2701a',
    '#c93f5c',
    '#3f8f4e',
    '#a08315',
    '#1f87ad',
    '#8f4fb0',
    '#5d6b80',
  ],
  nodeDefault: '#5d6b80',
  edgeColor: '#c3ccdb',
  edgeHighlight: '#2f6fd0',
  labelColor: '#1d2431',
  labelHaloColor: 'rgba(255,255,255,0.9)',
  selectionColor: '#101722',
  hoverColor: '#2f6fd0',
  gridColor: '#dde3ec',
  ambientParticles: 0,
  bloomStrength: 0,
  bloomRadius: 0,
  bloomThreshold: 1,
};

export const THEMES: Record<ThemeName, Theme> = {
  obsidian: OBSIDIAN,
  nebula: NEBULA,
  slate: SLATE,
  daylight: DAYLIGHT,
};

/** Sequential ramp used when colouring by a continuous metric. */
export const METRIC_SCHEME_DARK = [
  '#1e3a6e',
  '#2f6fb5',
  '#3fb0c8',
  '#7fe0a8',
  '#f2e06b',
  '#ffb45e',
];

export const METRIC_SCHEME_LIGHT = [
  '#dfe9f6',
  '#9fc0e6',
  '#5f97cf',
  '#3f78b0',
  '#2a5488',
  '#16325c',
];

export function resolveTheme(theme?: ThemeName | Partial<Theme>): Theme {
  if (!theme) return { ...OBSIDIAN };
  if (typeof theme === 'string') return { ...(THEMES[theme] ?? OBSIDIAN) };
  const base =
    theme.name && THEMES[theme.name as ThemeName] ? THEMES[theme.name as ThemeName] : OBSIDIAN;
  return { ...base, ...theme };
}

/** True when the theme is light, so labels/edges flip contrast. */
export function isLightTheme(theme: Theme): boolean {
  return theme.name === 'daylight';
}
