export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Smooth, C1-continuous easing used for camera flights and fades. */
export const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

export const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;

/** Deterministic PRNG so layouts are reproducible across reloads. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Evenly distributed points on a sphere — the Fibonacci lattice. */
export function fibonacciSphere(count: number, radius: number): Float32Array {
  const out = new Float32Array(count * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = count === 1 ? 0 : 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    out[i * 3] = Math.cos(theta) * r * radius;
    out[i * 3 + 1] = y * radius;
    out[i * 3 + 2] = Math.sin(theta) * r * radius;
  }
  return out;
}

/** Normalise an array to 0..1 using percentile clipping to resist outliers. */
export function normalize(values: Float64Array | number[], clipPercentile = 0.99): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  const sorted = Float64Array.from(values as ArrayLike<number>).sort();
  const lo = sorted[0];
  // Index into the sorted array by (n - 1), not n: `floor(n * 0.99)` on 100
  // values lands on element 99 — the outlier itself — so the clipping silently
  // does nothing and one hub flattens every other node to the bottom of the
  // scale. Interpolating over (n - 1) is the standard nearest-rank convention.
  const hi = sorted[clamp(Math.floor((n - 1) * clipPercentile), 0, n - 1)];
  const span = hi - lo || 1;
  for (let i = 0; i < n; i++) out[i] = clamp((values[i] - lo) / span, 0, 1);
  return out;
}
