// World of DODO, issue #20: the Vltava for the warships, the same on the client and the server. The river is the union of the
// karlin.json water pieces that make up the Vltava (the generator cut its polygon, with Štvanice and the smaller islands as holes,
// into simple pieces along vertical lines: they share those cut edges); its bank is every piece edge that has no water on its other
// side. The bridge piers standing in it are map.ts's solids of kind 'pier'. This module answers what the ships ask: am I on the
// water (by a margin: inWater), push me off the bank and the piers (waterPush), how far is the bank (bankDist), where may I start
// (SHIP_SPAWNS), which way does the river run here (riverDir); and what a shell, a parcel or a plane meets out there (surfaceY: the
// water's surface WATER_Y on the river, the land as drawn, landY, elsewhere). world/land.ts draws the river, its banks and the land
// from the same answers.
//
// Everything is computed once, at import, from the data alone and in a fixed order; what decides anything (on the water? which
// spawn?) uses only + - * / and sqrt (see geom.ts), so the client and the server agree. riverDir is an output only (a heading).
// Units as map.ts: x east, z south, headings as the game's (direction (sin h, cos h)).
import { DATA, SOLIDS, OUTER, ARENA, RIVER_BED, groundH, inArena } from './map.ts';
import { pointInPoly, closestOnPoly, polyArea, polyBox, polyReverse, polyCentroid, distSeg2, Hash, type Box, type Near } from './geom.ts';

export const WATER_Y = -4.5;                         // the water's surface (Prague's embankments stand some 5-7 m over it)
export const BED_Y = RIVER_BED;                       // the river bed, -8 (karlin.json's terrain under the open water; map.ts's piers stand on it)
export const LAND_MIN = -0.6;                        // the land never lies lower than this (KARLIN-DATA.md, terrain)

const sq = Math.sqrt, r2 = (v: number) => Math.round(v * 100) / 100, r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const ccw = (p: number[]) => polyArea(p) < 0 ? polyReverse(p) : p;

// ---------- the river: the water pieces connected to the biggest one ----------
// Two pieces belong together when a vertex of one lies on (within 0.5 of) the other's outline: the cut edges are shared, though
// the generator's simplification may have moved a corner a little. The ponds (one a small pool in the arena) are not the Vltava.
const ALLW = DATA.water.map(ccw), ALLB = ALLW.map(polyBox);
export const RIVER: number[][] = [];
{
  const n = ALLW.length, NR: Near = { x: 0, z: 0, d2: 0, nx: 0, nz: 0, e: 0, t: 0 };
  const touch = (a: number, b: number) => {
    const A = ALLB[a], B = ALLB[b]; if (A[0] > B[2] + 0.5 || B[0] > A[2] + 0.5 || A[1] > B[3] + 0.5 || B[1] > A[3] + 0.5) return false;
    for (const [p, q] of [[a, b], [b, a]]) { const P = ALLW[p]; for (let i = 0; i < P.length; i += 2) if (closestOnPoly(ALLW[q], P[i], P[i + 1], NR).d2 < 0.25) return true; }
    return false;
  };
  let big = 0; for (let i = 1; i < n; i++) if (polyArea(ALLW[i]) > polyArea(ALLW[big])) big = i;
  const seen = new Uint8Array(n), st = n ? [big] : []; if (n) seen[big] = 1;
  while (st.length) { const a = st.pop() as number; for (let b = 0; b < n; b++) if (!seen[b] && touch(a, b)) { seen[b] = 1; st.push(b); } }
  for (let i = 0; i < n; i++) if (seen[i]) RIVER.push(ALLW[i]);   // in the data's order
}
const RB = RIVER.map(polyBox), RH = new Hash<number>(OUTER.x0, OUTER.z0, OUTER.x1, OUTER.z1, 32), RQ: number[] = [];
RIVER.forEach((p, i) => RH.add(RB[i], i));
// inside one of the river's pieces (its outline counts: the bank itself is still water)
export function inRiver(x: number, z: number): boolean {
  for (const i of RH.query(x, z, x, z, RQ)) { const b = RB[i]; if (x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3] && pointInPoly(RIVER[i], x, z)) return true; }
  return false;
}

// ---------- the banks: the piece edges with no water behind them ----------
// Every edge is tested in pieces of at most 2: a point 0.6 outside its middle (outside = to the left: the interior is on the right)
// in another piece makes that part a shared cut, else it is bank. The bank parts are joined along the edge and cut again into pieces
// of at most 8 (small boxes for the hash). BANK holds per segment ax, az, bx, bz, nx, nz (the unit normal pointing into the water)
// and BANK_RIM marks the ones on the outer square's border (the river is cut off there: a wall for the ships, nothing to draw).
const SEG = 8, TEST = 2, OUT = 0.6;
const bk: number[] = [], rim: number[] = [];
for (const P of RIVER) {
  const n = P.length;
  for (let i = 0; i < n; i += 2) {
    const j = i + 2 < n ? i + 2 : 0, ax = P[i], az = P[i + 1], dx = P[j] - ax, dz = P[j + 1] - az, l = sq(dx * dx + dz * dz); if (l < 1e-9) continue;
    const ox = dz / l * OUT, oz = -dx / l * OUT, m = Math.max(1, Math.ceil(l / TEST)), wet: boolean[] = [];
    for (let k = 0; k < m; k++) { const t = (k + 0.5) / m; wet.push(inRiver(ax + dx * t + ox, az + dz * t + oz)); }
    const onRim = (ax === OUTER.x0 && P[j] === OUTER.x0) || (ax === OUTER.x1 && P[j] === OUTER.x1) || (az === OUTER.z0 && P[j + 1] === OUTER.z0) || (az === OUTER.z1 && P[j + 1] === OUTER.z1);
    for (let k = 0; k < m;) {
      if (wet[k]) { k++; continue; }
      let e = k; while (e < m && !wet[e]) e++;                       // the dry run k..e-1
      const t0 = k / m, t1 = e / m, L = (t1 - t0) * l, c = Math.max(1, Math.ceil(L / SEG));
      for (let s = 0; s < c; s++) {
        const u0 = t0 + (t1 - t0) * s / c, u1 = t0 + (t1 - t0) * (s + 1) / c;
        bk.push(ax + dx * u0, az + dz * u0, ax + dx * u1, az + dz * u1, -dz / l, dx / l); rim.push(onRim ? 1 : 0);
      }
      k = e;
    }
  }
}
export const BANK = Float64Array.from(bk), BANK_N = rim.length, BANK_RIM = Uint8Array.from(rim);
const BH = new Hash<number>(OUTER.x0, OUTER.z0, OUTER.x1, OUTER.z1, 16), BQ: number[] = [];
for (let k = 0; k < BANK_N; k++) {
  const o = 6 * k, ax = BANK[o], az = BANK[o + 1], bx = BANK[o + 2], bz = BANK[o + 3];
  BH.add([Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz)], k);
}
const segD2 = (k: number, x: number, z: number) => { const o = 6 * k; return distSeg2(x, z, BANK[o], BANK[o + 1], BANK[o + 2], BANK[o + 3]); };

// ---------- the piers in the water (map.ts SOLIDS of kind 'pier' standing on the river bed, or whose footprint touches the river) ----------
export interface WPier { p: number[]; box: Box; y0: number; h: number }
export const PIERS: WPier[] = [];
for (const s of SOLIDS) {
  if (s.kind !== 'pier') continue;
  const [cx, cz] = polyCentroid(s.p); let wet = s.y0 <= BED_Y + 0.01 || inRiver(cx, cz);   // on the bed: map.ts put it in the river
  for (let i = 0; !wet && i < s.p.length; i += 2) wet = inRiver(s.p[i], s.p[i + 1]);
  if (wet) PIERS.push({ p: s.p, box: s.box, y0: s.y0, h: s.h });
}
const PH = new Hash<WPier>(OUTER.x0, OUTER.z0, OUTER.x1, OUTER.z1, 16), PQ: WPier[] = [];
for (const p of PIERS) PH.add(p.box, p);
const NP: Near = { x: 0, z: 0, d2: 0, nx: 0, nz: 0, e: 0, t: 0 };
const inBox = (b: Box, x: number, z: number) => x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3];
function pierAt(x: number, z: number): WPier | null {
  for (const p of PH.query(x, z, x, z, PQ)) if (inBox(p.box, x, z) && pointInPoly(p.p, x, z)) return p;
  return null;
}

// ---------- the queries ----------
// on the navigable river: in a piece of it, in no pier, and at least m from every bank and pier
export function inWater(x: number, z: number, m = 0): boolean {
  if (!inRiver(x, z) || pierAt(x, z)) return false;
  if (m > 0) {
    const m2 = m * m;
    for (const k of BH.query(x - m, z - m, x + m, z + m, BQ)) if (segD2(k, x, z) < m2) return false;
    for (const p of PH.query(x - m, z - m, x + m, z + m, PQ)) if (closestOnPoly(p.p, x, z, NP).d2 < m2) return false;
  }
  return true;
}
// the nearest bank segment to (x, z) within R growing from 16 (-1 if the river has no bank at all): into NB_K / NB_D2
let NB_K = -1, NB_D2 = Infinity;
function nearestBank(x: number, z: number) {
  NB_K = -1; NB_D2 = Infinity; if (!BANK_N) return;
  for (let R = 16; ; R *= 3) {
    for (const k of BH.query(x - R, z - R, x + R, z + R, BQ)) { const d = segD2(k, x, z); if (d < NB_D2) { NB_D2 = d; NB_K = k; } }
    if (NB_K >= 0 && NB_D2 <= R * R || R > 4 * (OUTER.x1 - OUTER.x0)) return;
  }
}
// the distance to the nearest bank: positive on the river, negative on land (the piers do not count: see inWater for them)
export function bankDist(x: number, z: number): number {
  nearestBank(x, z); if (NB_K < 0) return -Infinity;
  const d = sq(NB_D2); return inRiver(x, z) ? d : -d;
}
// A circle (centre px, pz, radius r) against the banks and the piers: the deepest overlap {nx, nz, pen}, the normal pointing back
// into the water, or null (the contract of map.ts solidPush). A centre on land goes back to the nearest bank and r past it; a centre
// inside a pier goes out through its nearest side.
export function waterPush(px: number, pz: number, r: number): { nx: number; nz: number; pen: number } | null {
  let bn = 0, bx = 0, bz = 0;
  const take = (nx: number, nz: number, pen: number) => { if (pen > bn) { bn = pen; bx = nx; bz = nz; } };
  const pi = pierAt(px, pz);
  if (pi) { const q = closestOnPoly(pi.p, px, pz, NP); return { nx: q.nx, nz: q.nz, pen: sq(q.d2) + r }; }
  if (!inRiver(px, pz)) {
    nearestBank(px, pz); if (NB_K < 0) return null;
    const o = 6 * NB_K, ax = BANK[o], az = BANK[o + 1], dx = BANK[o + 2] - ax, dz = BANK[o + 3] - az, l2 = dx * dx + dz * dz;
    let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = ax + dx * t - px, qz = az + dz * t - pz, d = sq(qx * qx + qz * qz);
    return d > 1e-6 ? { nx: qx / d, nz: qz / d, pen: d + r } : { nx: BANK[o + 4], nz: BANK[o + 5], pen: r };
  }
  const r2_ = r * r;
  for (const k of BH.query(px - r, pz - r, px + r, pz + r, BQ)) {
    const o = 6 * k, ax = BANK[o], az = BANK[o + 1], dx = BANK[o + 2] - ax, dz = BANK[o + 3] - az, l2 = dx * dx + dz * dz;
    let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = px - ax - dx * t, qz = pz - az - dz * t, d2 = qx * qx + qz * qz; if (d2 >= r2_) continue;
    const d = sq(d2);
    if (d > 1e-6) take(qx / d, qz / d, r - d); else take(BANK[o + 4], BANK[o + 5], r);
  }
  for (const p of PH.query(px - r, pz - r, px + r, pz + r, PQ)) {
    const q = closestOnPoly(p.p, px, pz, NP); if (q.d2 >= r2_) continue;
    const d = sq(q.d2);
    if (d > 1e-6) take((px - q.x) / d, (pz - q.z) / d, r - d); else take(q.nx, q.nz, r);
  }
  return bn > 0 ? { nx: bx, nz: bz, pen: bn } : null;
}
// The land's height out of the arena as the game draws it (world/land.ts): map.ts terrainH, except that the terrain grid is coarse
// (10 u) and near a bank it slopes towards the river bed, so here the grid's points on the river take the mean of their land
// neighbours (four rounds outwards; farther out LAND_MIN): the land keeps its own level right up to the bank, where the embankment
// wall drops into the water. Never under LAND_MIN.
const LG = (() => {
  const T = DATA.terrain, N = T.nx, M = T.nz, h = Float64Array.from(T.h), wet = new Uint8Array(N * M);
  for (let j = 0; j < M; j++) for (let i = 0; i < N; i++) if (inRiver(T.x0 + i * T.step, T.z0 + j * T.step)) wet[j * N + i] = 1;
  for (let round = 0; round < 4; round++) {
    const fill: number[] = [];
    for (let j = 0; j < M; j++) for (let i = 0; i < N; i++) {
      if (wet[j * N + i] !== 1) continue;
      let s = 0, c = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= N || b >= M || wet[b * N + a] === 1) continue;
        s += h[b * N + a]; c++;
      }
      if (c) fill.push(j * N + i, s / c);
    }
    for (let k = 0; k < fill.length; k += 2) { h[fill[k]] = fill[k + 1]; wet[fill[k]] = 2; }   // 2: filled this round, land from now on
  }
  for (let k = 0; k < N * M; k++) if (wet[k] === 1 || wet[k] === 2 && h[k] < LAND_MIN) h[k] = LAND_MIN;
  return h;
})();
export function landY(x: number, z: number): number {
  const T = DATA.terrain; let fx = (x - T.x0) / T.step, fz = (z - T.z0) / T.step;
  fx = fx < 0 ? 0 : fx > T.nx - 1 ? T.nx - 1 : fx; fz = fz < 0 ? 0 : fz > T.nz - 1 ? T.nz - 1 : fz;
  const ix = Math.min(T.nx - 2, Math.floor(fx)), iz = Math.min(T.nz - 2, Math.floor(fz)), tx = fx - ix, tz = fz - iz, k = iz * T.nx + ix;
  const h = (LG[k] * (1 - tx) + LG[k + 1] * tx) * (1 - tz) + (LG[k + T.nx] * (1 - tx) + LG[k + T.nx + 1] * tx) * tz;
  return h > LAND_MIN ? h : LAND_MIN;
}
// What is there at (x, z): the water's surface on the river, else the ground (map.ts groundH in the arena, landY out of it). For
// shells, parcels and planes.
export function surfaceY(x: number, z: number): number {
  if (inArena(x, z)) return groundH(x, z);
  if (inRiver(x, z) && !pierAt(x, z)) return WATER_Y;
  return landY(x, z);
}

// ---------- which way the river runs ----------
// A field on a 20-unit grid: the axis of the banks within 60 (each bank segment's direction, doubled-angle averaged so that the two
// banks, whose segments run opposite ways, agree), then turned to run downstream: the Vltava flows east past Karlín, so from its
// westernmost cell (oriented east) every neighbour is oriented like the cell it was reached from. riverDir blends the four cells
// round the point. (Only + - * / sqrt here too, though nothing but a heading depends on it.)
const FC = 20, FX0 = OUTER.x0, FZ0 = OUTER.z0, FNX = Math.ceil((OUTER.x1 - OUTER.x0) / FC) + 1, FNZ = Math.ceil((OUTER.z1 - OUTER.z0) / FC) + 1;
const FV = new Float64Array(FNX * FNZ * 2);                         // the unit direction per cell (0, 0: none)
{
  const R = 60, has = new Uint8Array(FNX * FNZ);
  for (let j = 0; j < FNZ; j++) for (let i = 0; i < FNX; i++) {
    const x = FX0 + i * FC, z = FZ0 + j * FC; let C = 0, S = 0;
    for (const k of BH.query(x - R, z - R, x + R, z + R, BQ)) {
      if (BANK_RIM[k]) continue;
      const o = 6 * k, ux = BANK[o + 2] - BANK[o], uz = BANK[o + 3] - BANK[o + 1], l = sq(ux * ux + uz * uz); if (l < 1e-9) continue;
      const w = l / (sq(segD2(k, x, z)) + 10) / (l * l);              // the length over the distance; / l² normalises the doubled vector
      C += w * (ux * ux - uz * uz); S += w * 2 * ux * uz;
    }
    const L = sq(C * C + S * S); if (L < 1e-9) continue;
    const c = C / L, ax = sq(Math.max(0, (1 + c) / 2)), az = (S < 0 ? -1 : 1) * sq(Math.max(0, (1 - c) / 2));   // the half angle
    FV[2 * (j * FNX + i)] = ax; FV[2 * (j * FNX + i) + 1] = az; has[j * FNX + i] = 1;
  }
  // orient: breadth first from the westernmost cell on the river, pointing east
  let seed = -1;
  for (let i = 0; i < FNX && seed < 0; i++) for (let j = 0; j < FNZ; j++) if (has[j * FNX + i] && inRiver(FX0 + i * FC, FZ0 + j * FC)) { seed = j * FNX + i; break; }
  const done = new Uint8Array(FNX * FNZ), q: number[] = [];
  if (seed >= 0) { if (FV[2 * seed] < 0) { FV[2 * seed] = -FV[2 * seed]; FV[2 * seed + 1] = -FV[2 * seed + 1]; } done[seed] = 1; q.push(seed); }
  for (let h = 0; h < q.length; h++) {
    const c = q[h], ci = c % FNX, cj = (c - ci) / FNX;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const i = ci + di, j = cj + dj; if (i < 0 || j < 0 || i >= FNX || j >= FNZ) continue;
      const k = j * FNX + i; if (done[k] || !has[k]) continue;
      if (FV[2 * k] * FV[2 * c] + FV[2 * k + 1] * FV[2 * c + 1] < 0) { FV[2 * k] = -FV[2 * k]; FV[2 * k + 1] = -FV[2 * k + 1]; }
      done[k] = 1; q.push(k);
    }
  }
  for (let k = 0; k < FNX * FNZ; k++) if (!done[k]) { FV[2 * k] = 0; FV[2 * k + 1] = 0; }   // cut off from the river: none
}
// the river's direction near (x, z), downstream, as a unit vector into RV (the four cells round the point blended; far from the river
// the nearest cell that has one; no river at all: east)
const RV = [1, 0];
function riverVec(x: number, z: number) {
  let fx = (x - FX0) / FC, fz = (z - FZ0) / FC;
  fx = fx < 0 ? 0 : fx > FNX - 1.001 ? FNX - 1.001 : fx; fz = fz < 0 ? 0 : fz > FNZ - 1.001 ? FNZ - 1.001 : fz;
  const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j, k = j * FNX + i;
  const w00 = (1 - tx) * (1 - tz), w10 = tx * (1 - tz), w01 = (1 - tx) * tz, w11 = tx * tz;
  let vx = FV[2 * k] * w00 + FV[2 * k + 2] * w10 + FV[2 * (k + FNX)] * w01 + FV[2 * (k + FNX) + 2] * w11;
  let vz = FV[2 * k + 1] * w00 + FV[2 * k + 3] * w10 + FV[2 * (k + FNX) + 1] * w01 + FV[2 * (k + FNX) + 3] * w11;
  if (vx * vx + vz * vz < 1e-6) {
    let bd = Infinity; vx = 1; vz = 0;
    for (let c = 0; c < FNX * FNZ; c++) {
      if (FV[2 * c] === 0 && FV[2 * c + 1] === 0) continue;
      const ci = c % FNX, cj = (c - ci) / FNX, d = (ci - fx) * (ci - fx) + (cj - fz) * (cj - fz); if (d < bd) { bd = d; vx = FV[2 * c]; vz = FV[2 * c + 1]; }
    }
  }
  const l = sq(vx * vx + vz * vz); RV[0] = vx / l; RV[1] = vz / l;
}
// the river's direction near (x, z), downstream, as a heading (radians; direction (sin h, cos h))
export function riverDir(x: number, z: number): number { riverVec(x, z); return Math.atan2(RV[0], RV[1]); }

// ---------- where the ships start ----------
// Spots on a 5-unit grid at least SPAWN_M from every bank and pier, farthest-point picked from the one nearest to the river just north
// of the arena's middle, SHIP_SPAWN_N of them, each facing along the river towards the river's middle (no one starts with the outer
// square's edge ahead of it).
export const SHIP_SPAWN_N = 16, SHIP_SPAWN_M = 25;
export const SHIP_SPAWNS: { x: number; z: number; h: number }[] = [];
{
  const cand: number[] = []; let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const b of RB) { x0 = Math.min(x0, b[0]); z0 = Math.min(z0, b[1]); x1 = Math.max(x1, b[2]); z1 = Math.max(z1, b[3]); }
  for (let z = Math.ceil(z0 / 5) * 5; z <= z1; z += 5) for (let x = Math.ceil(x0 / 5) * 5; x <= x1; x += 5) if (inWater(x, z, SHIP_SPAWN_M)) cand.push(x, z);
  const n = cand.length >> 1;
  if (n) {
    const mx = (ARENA.x0 + ARENA.x1) / 2, mz = ARENA.z0; let first = 0, fd = Infinity;
    for (let i = 0; i < n; i++) { const d = (cand[2 * i] - mx) * (cand[2 * i] - mx) + (cand[2 * i + 1] - mz) * (cand[2 * i + 1] - mz); if (d < fd) { fd = d; first = i; } }
    const dist = new Float64Array(n), pick = [first];
    for (let i = 0; i < n; i++) dist[i] = (cand[2 * i] - cand[2 * first]) * (cand[2 * i] - cand[2 * first]) + (cand[2 * i + 1] - cand[2 * first + 1]) * (cand[2 * i + 1] - cand[2 * first + 1]);
    while (pick.length < Math.min(SHIP_SPAWN_N, n)) {
      let bi = -1, bd = 0; for (let i = 0; i < n; i++) if (dist[i] > bd) { bd = dist[i]; bi = i; }
      if (bi < 0) break;
      pick.push(bi);
      for (let i = 0; i < n; i++) { const d = (cand[2 * i] - cand[2 * bi]) * (cand[2 * i] - cand[2 * bi]) + (cand[2 * i + 1] - cand[2 * bi + 1]) * (cand[2 * i + 1] - cand[2 * bi + 1]); if (d < dist[i]) dist[i] = d; }
    }
    const midX = (x0 + x1) / 2;
    for (const i of pick) {
      const x = cand[2 * i], z = cand[2 * i + 1]; riverVec(x, z);
      const f = (midX - x) * RV[0] >= 0 ? 1 : -1;
      SHIP_SPAWNS.push({ x: r2(x), z: r2(z), h: r4(Math.atan2(RV[0] * f, RV[1] * f)) });
    }
  }
}
