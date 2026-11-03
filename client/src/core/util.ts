// Small helpers shared by every part of the game.

// deterministic RNG (mulberry32): the city is built from one seed, so every player gets the same city
export function rng(seed: number): () => number {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
// the city's random looks (facades, trees, parked cars); the order of the calls matters, so every client draws the same city
export const R = rng(2026);

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
// smoothstep, 0 below 0 and 1 above 1
export const ease = (t: number) => t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t);
// the shorter way from angle a to angle b
export function angLerp(a: number, b: number, k: number) { const d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI; return a + d * k; }
// the page's clock in ms (game time: flashes, claims, spotting)
export const now = () => performance.now();
// rounded for the network: two decimals
export const r2 = (v: number) => Math.round(v * 100) / 100;
export const hexCss = (h: number) => '#' + (h >>> 0).toString(16).padStart(6, '0');
