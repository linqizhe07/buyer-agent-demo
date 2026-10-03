/** mulberry32: a tiny seeded PRNG so every sim price is the same on every run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A price path: `base` nudged by a bounded random walk, rounded to `decimals`. */
export function priceWalk(seed: number, base: number, stepPct = 0.002, decimals = 2): () => number {
  const rnd = mulberry32(seed);
  let px = base;
  return () => {
    px = px * (1 + (rnd() - 0.5) * 2 * stepPct);
    return Number(px.toFixed(decimals));
  };
}
