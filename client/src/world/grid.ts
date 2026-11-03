// The city's grid: 6 × 6 blocks between 7 × 7 streets, the solid buildings, the height of the ground, where a vehicle may be.
// The server keeps a copy of the solids and the streets (server/city.js); keep the two in step (CONTRIBUTING.md).
import { propsNear } from './props';

export const CELL = 52, ROAD = 14, HALF = 156, UNIT_M = 5;   // 1 world unit = 5 m
export const roadC = (k: number) => -HALF + CELL * k;        // road centre lines, k = 0..6
export const blockC = (i: number) => -130 + CELL * i;        // block centres, i = 0..5
export function nearLine(v: number, m: number) { const k = Math.round((v + HALF) / CELL); return k >= 0 && k <= 6 && Math.abs(v - roadC(k)) < ROAD / 2 - m; }
export const RC = 6, TRAM_K = 3;                             // block corner radius, the tram avenue (horizontal road index)
export const DEPOT_B = [0, 0], PARK_B = [1, 2], PLAZA_B = [3, 3], RIVAL_B = [5, 5];   // RIVAL_B: the REDLINE hall, in the opposite corner
export const RIVAL_PARK: [number, number] = [roadC(5) + 3.5, blockC(5)];
// the DODO depot's yard: the tram's loop and the fallback spawn point
export const depot = { park: [-107.5, -130] as [number, number] };

// Solid things, as boxes standing on the ground: the block buildings, the depot hall, the REDLINE hall, the church nave and towers,
// and the construction site (client/shared/site.js). Parcels, tanks and the camera hit them.
export interface Solid { x0: number; x1: number; z0: number; z1: number; h: number }
export const SOLIDS: Solid[] = (function () {
  const s: Solid[] = [];
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
    const k = i + ',' + j; if (k === DEPOT_B.join(',') || k === PLAZA_B.join(',') || k === PARK_B.join(',') || k === RIVAL_B.join(',')) continue;
    const bx = blockC(i), bz = blockC(j); s.push({ x0: bx - 16, x1: bx + 16, z0: bz - 16, z1: bz + 16, h: 17 });
  }
  let bx = blockC(DEPOT_B[0]), bz = blockC(DEPOT_B[1]); s.push({ x0: bx - 17, x1: bx + 5, z0: bz - 16, z1: bz + 16, h: 10.5 });
  bx = blockC(RIVAL_B[0]); bz = blockC(RIVAL_B[1]); s.push({ x0: bx - 5, x1: bx + 17, z0: bz - 16, z1: bz + 16, h: 10.5 });   // REDLINE hall (mirror image of the DODO depot)
  bx = blockC(PARK_B[0]); bz = blockC(PARK_B[1]); s.push({ x0: bx - 5, x1: bx + 5, z0: bz - 12, z1: bz + 8, h: 15 });
  for (const sx of [-1, 1]) s.push({ x0: bx + sx * 5.6 - 2, x1: bx + sx * 5.6 + 2, z0: bz + 7.5, z1: bz + 11.5, h: 31 });
  if (window.WOD_SITE) for (const b of window.WOD_SITE.solids) s.push(b);                    // World of DODO: the construction site
  return s;
})();

// World of DODO, issue #14: the planes' airspace, a square of ±AIR_LIM (they are turned back at its edge); above AIR_TOP the engine
// loses power. The tanks stay inside WORLD_LIM.
export const AIR_LIM = 450, AIR_TOP = 220;

// Drivable space: everywhere inside a big square around the city (streets, pavements, snow, the depot yard) except inside the
// solids and the standing props. m = how far from them the point must stay.
export const WORLD_LIM = 250;
export function free(x: number, z: number, m: number) {
  if (Math.abs(x) > WORLD_LIM - m || Math.abs(z) > WORLD_LIM - m) return false;
  for (const b of SOLIDS) if (x > b.x0 - m && x < b.x1 + m && z > b.z0 - m && z < b.z1 + m) return false;
  for (const p of propsNear(x, z)) if (p.state === 'up' && Math.hypot(x - p.x, z - p.z) < p.r + m) return false;   // trees and lamps, until they are knocked down
  return true;
}
// a circle (centre px, pz, radius r) against the solids and the edge of the world: the deepest overlap {nx, nz, pen}, the normal
// pointing away from the obstacle, or null
export function solidPush(px: number, pz: number, r: number) {
  const L = WORLD_LIM; let best: { nx: number; nz: number; pen: number } | null = null;
  const take = (nx: number, nz: number, pen: number) => { if (pen > 0 && (!best || pen > best.pen)) best = { nx, nz, pen }; };
  take(-1, 0, px - (L - r)); take(1, 0, -L + r - px); take(0, -1, pz - (L - r)); take(0, 1, -L + r - pz);
  for (const b of SOLIDS) {
    if (px < b.x0 - r || px > b.x1 + r || pz < b.z0 - r || pz > b.z1 + r) continue;
    const qx = Math.max(b.x0, Math.min(b.x1, px)), qz = Math.max(b.z0, Math.min(b.z1, pz)), dx = px - qx, dz = pz - qz, d = Math.hypot(dx, dz);
    if (d > 1e-6) { if (d < r) take(dx / d, dz / d, r - d); }
    else {
      const l = px - b.x0, rr = b.x1 - px, t = pz - b.z0, bt = b.z1 - pz, mn = Math.min(l, rr, t, bt);   // centre inside the box: out through the nearest face
      if (mn === l) take(-1, 0, mn + r); else if (mn === rr) take(1, 0, mn + r); else if (mn === t) take(0, -1, mn + r); else take(0, 1, mn + r);
    }
  }
  return best as { nx: number; nz: number; pen: number } | null;
}
// height of the ground: 0.3 on the pavement of a city block (rounded corners), 0 on the streets and the open snow
export function groundH(x: number, z: number) {
  const i = Math.max(0, Math.min(5, Math.round((x + 130) / 52))), j = Math.max(0, Math.min(5, Math.round((z + 130) / 52)));
  const dx = Math.abs(x - blockC(i)), dz = Math.abs(z - blockC(j)), hw = 19;
  if (dx >= hw || dz >= hw) return 0; const ax = dx - (hw - RC), az = dz - (hw - RC); if (ax > 0 && az > 0 && Math.hypot(ax, az) > RC) return 0; return 0.3;
}
// the first solid on the segment from a to b, as 0..1 along it; 1 if none (camera pull-in, spotting the other players)
export function segHit(ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
  const dx = bx - ax, dy = by - ay, dz = bz - az; let best = 1;
  for (const b of SOLIDS) {
    let t0 = 0, t1 = best, hit = true;
    for (const [p, d, lo, hi] of [[ax, dx, b.x0, b.x1], [ay, dy, 0, b.h], [az, dz, b.z0, b.z1]]) {
      if (Math.abs(d) < 1e-9) { if (p < lo || p > hi) { hit = false; break; } continue; }
      let u = (lo - p) / d, v = (hi - p) / d; if (u > v) { const w = u; u = v; v = w; } t0 = Math.max(t0, u); t1 = Math.min(t1, v); if (t0 > t1) { hit = false; break; }
    }
    if (hit) best = t0;
  }
  return best;
}
