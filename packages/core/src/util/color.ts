/** Colour helpers that avoid pulling in a colour library. */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

const HEX_SHORT = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX_LONG = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const RGB_FN = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i;

/** Parse #rgb, #rrggbb or rgb()/rgba() into 0..1 components. */
export function parseColor(input: string): RGB {
  const value = input.trim();
  let m = HEX_LONG.exec(value);
  if (m) {
    return {
      r: parseInt(m[1], 16) / 255,
      g: parseInt(m[2], 16) / 255,
      b: parseInt(m[3], 16) / 255,
    };
  }
  m = HEX_SHORT.exec(value);
  if (m) {
    return {
      r: parseInt(m[1] + m[1], 16) / 255,
      g: parseInt(m[2] + m[2], 16) / 255,
      b: parseInt(m[3] + m[3], 16) / 255,
    };
  }
  m = RGB_FN.exec(value);
  if (m) {
    return { r: +m[1] / 255, g: +m[2] / 255, b: +m[3] / 255 };
  }
  return { r: 1, g: 1, b: 1 };
}

export function toHex({ r, g, b }: RGB): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

export function lighten(c: RGB, amount: number): RGB {
  return mix(c, { r: 1, g: 1, b: 1 }, amount);
}

export function darken(c: RGB, amount: number): RGB {
  return mix(c, { r: 0, g: 0, b: 0 }, amount);
}

/**
 * Sample a colour ramp at t (0..1). Used for metric-driven colouring, where a
 * continuous scale reads far better than categorical hues.
 */
export function sampleScheme(scheme: string[], t: number): RGB {
  if (scheme.length === 0) return { r: 1, g: 1, b: 1 };
  if (scheme.length === 1) return parseColor(scheme[0]);
  const clamped = Math.max(0, Math.min(1, t));
  const scaled = clamped * (scheme.length - 1);
  const i = Math.min(scheme.length - 2, Math.floor(scaled));
  return mix(parseColor(scheme[i]), parseColor(scheme[i + 1]), scaled - i);
}

/**
 * Deterministic palette pick. The same key always lands on the same colour,
 * which keeps legends stable between reloads.
 */
export function paletteFor(key: string, palette: string[]): string {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return palette[Math.abs(hash) % palette.length];
}

/** Perceptual luminance, used to decide label contrast. */
export function luminance({ r, g, b }: RGB): number {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
