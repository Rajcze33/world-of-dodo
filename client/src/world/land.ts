// World of DODO: the land around the city, for the planes (issue #14). World of DODO, issue #16: the real surroundings of Karlín
// instead of the invented countryside (villages, farms, the wind farm, the airfield): the terrain of DATA.terrain (ČÚZK's DMR 5G:
// Vítkov in the south, the river banks, Letná and Holešovice behind the Vltava), the Vltava itself (frozen: snow drifts and dark
// cracks on the ice), the woods of the parks (Vítkov's slopes, Štvanice) as instanced trees, and beyond the outer square the land
// fading into the fog over a snowy plain. The far houses are drawn by world/buildings.ts with the city's.
//
// It draws from no random numbers (hashes only). Built last (main.ts), after everything else. Few draw calls: the terrain is one
// mesh, the ice one, the woods two instanced meshes (near and far, each culled by its own box), the plain one.
// landHit() tells the planes whether a point is under the ground or the ice, or inside a tree of the woods or something a landmark
// raises above its footprint's solid (the church's towers, Žižka's statue: world/landmarks.ts EXTRA). The buildings themselves are
// map.ts's solids (solidNear), the planes ask those separately.
import type { StandardMaterial } from '@babylonjs/core';
import { DATA, ARENA, OUTER, terrainH, solidAt } from '../../shared/map.ts';
import { Hash, pointInPoly, polyBox } from '../../shared/geom.ts';
import { Bucket, tri, quad, cylGeo, translate, addGeo, bake, geoMesh, Inst, Dummy, type P3, type Geo } from '../core/geo';
import { lambert } from '../core/mat';
import { canvasTex } from '../core/tex';
import { COL } from '../core/colors';
import { earClip, orient, hash01 } from './poly';
import { EXTRA } from './landmarks';
import { mix, shade } from './buildings';

export const WATER_Y = -0.8;                          // the ice: above the river bed (-2), below all land (never under -0.6)
// the ground's height around the city (the planes' crash test; inside the arena it is 0, the streets' level)
export const landH = (x: number, z: number) => terrainH(x, z);

// ---------- what the planes can hit out here: trees (cones) and the landmarks' extra boxes, in a coarse grid ----------
interface Sol { k: number; x: number; z: number; y0: number; h: number; a: number; b: number; ux: number; uz: number }
const HC = 25, HH = 750, HNC = HH * 2 / HC, HIT: (Sol[] | null)[] = new Array(HNC * HNC).fill(null);
let HIT_TOP = 0;
function solid(o: Sol, rad: number) {
  HIT_TOP = Math.max(HIT_TOP, o.h);
  const i0 = Math.max(0, Math.floor((o.x - rad + HH) / HC)), i1 = Math.min(HNC - 1, Math.floor((o.x + rad + HH) / HC));
  const j0 = Math.max(0, Math.floor((o.z - rad + HH) / HC)), j1 = Math.min(HNC - 1, Math.floor((o.z + rad + HH) / HC));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) (HIT[j * HNC + i] ??= []).push(o);
}
// For the planes, every frame: is (x, y, z) under the terrain or the ice, inside a tree of the woods, or inside something a landmark
// raises above its solid? (The houses, the viaduct and the site are map.ts's solids: solidNear.)
export function landHit(x: number, y: number, z: number): boolean {
  if (y < Math.max(terrainH(x, z), WATER_Y)) return true;
  if (y > HIT_TOP) return false;
  const i = Math.floor((x + HH) / HC), j = Math.floor((z + HH) / HC);
  if (i < 0 || j < 0 || i >= HNC || j >= HNC) return false;
  const L = HIT[j * HNC + i]; if (!L) return false;
  for (const o of L) {
    const dx = x - o.x, dz = z - o.z, dy = y - o.y0;
    if (dy < 0 || y > o.h) continue;
    if (o.k === 0) { if (Math.abs(dx * o.ux + dz * o.uz) < o.a && Math.abs(-dx * o.uz + dz * o.ux) < o.b) return true; }
    else { const rr = o.a * (1 - dy / (o.h - o.y0)); if (dx * dx + dz * dz < rr * rr) return true; }
  }
  return false;
}

// ---------- the terrain ----------
const SNOW = COL.paper, ROCK = 0xa2a8a6, BANK = 0x8e9592, BED = 0x4f5a58, WOOD = 0x6f8f88;
// is (x, z) in a park (the woods, gardens)? A box hash over the parks, built once
let PARKS: Hash<number> | null = null; const PQ: number[] = [];
const PB: number[][] = [];
function inPark(x: number, z: number) {
  if (!PARKS) { PARKS = new Hash<number>(OUTER.x0, OUTER.z0, OUTER.x1, OUTER.z1, 40); DATA.parks.forEach((q, i) => { PB[i] = polyBox(q); PARKS!.add(PB[i] as [number, number, number, number], i); }); }
  for (const i of PARKS.query(x, z, x, z, PQ)) { const b = PB[i]; if (x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3] && pointInPoly(DATA.parks[i], x, z)) return true; }
  return false;
}
let WATERS: Hash<number> | null = null; const WQ: number[] = [];
function inWater(x: number, z: number) {
  if (!WATERS) { WATERS = new Hash<number>(OUTER.x0, OUTER.z0, OUTER.x1, OUTER.z1, 40); DATA.water.forEach((q, i) => WATERS!.add(polyBox(q), i)); }
  for (const i of WATERS.query(x, z, x, z, WQ)) if (pointInPoly(DATA.water[i], x, z)) return true;
  return false;
}
// a flat-shaded triangle facing up with a colour at each corner (soft patches between the vertices)
const TC = [0, 0, 0];
function triV(bk: Bucket, a: P3, b: P3, c: P3, ca: number, cb: number, cc: number) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
  let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
  if (ny < 0) { [b, c] = [c, b]; [cb, cc] = [cc, cb]; nx = -nx; ny = -ny; nz = -nz; }
  const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
  for (const [v, col] of [[a, ca], [b, cb], [c, cc]] as [P3, number][]) {
    TC[0] = ((col >> 16) & 255) / 255; TC[1] = ((col >> 8) & 255) / 255; TC[2] = (col & 255) / 255;
    bk.p.push(v[0], v[1], v[2]); bk.n.push(nx, ny, nz); bk.u.push(0, 0); bk.c.push(TC[0], TC[1], TC[2]);
  }
}
function terrain(G: Bucket) {
  const T = DATA.terrain, N = T.nx, H = T.h, at = (i: number, j: number) => H[j * N + i];
  // the colour of each vertex: snow; the river bed and its banks darker; the woods a little darker and greener; rock where it is steep
  const C = new Array(N * T.nz);
  for (let j = 0; j < T.nz; j++) for (let i = 0; i < N; i++) {
    const h = at(i, j), x = T.x0 + i * T.step, z = T.z0 + j * T.step;
    const sl = Math.max(Math.abs(at(Math.min(N - 1, i + 1), j) - at(Math.max(0, i - 1), j)), Math.abs(at(i, Math.min(T.nz - 1, j + 1)) - at(i, Math.max(0, j - 1)))) / (2 * T.step);
    let c = h < -1.2 ? BED : h < -0.25 ? BANK : inPark(x, z) ? mix(SNOW, WOOD, 0.45) : SNOW;
    if (sl > 0.45 && h > 0) c = mix(c, ROCK, Math.min(1, (sl - 0.45) * 2.5));
    C[j * N + i] = shade(c, 0.97 + 0.05 * hash01(i, j));
  }
  for (let j = 0; j + 1 < T.nz; j++) for (let i = 0; i + 1 < N; i++) {
    const x = T.x0 + i * T.step, z = T.z0 + j * T.step, x1 = x + T.step, z1 = z + T.step;
    if (x >= ARENA.x0 && x1 <= ARENA.x1 && z >= ARENA.z0 && z1 <= ARENA.z1) continue;   // the streets' plane covers it
    const k = j * N + i; if (H[k] < -1.5 && H[k + 1] < -1.5 && H[k + N] < -1.5 && H[k + N + 1] < -1.5) continue;   // the river bed, under the ice
    const V: P3[] = [[x, H[k] - 0.02, z], [x1, H[k + 1] - 0.02, z], [x1, H[k + N + 1] - 0.02, z1], [x, H[k + N] - 0.02, z1]], K = [k, k + 1, k + N + 1, k + N];
    triV(G, V[0], V[1], V[2], C[K[0]], C[K[1]], C[K[2]]); triV(G, V[0], V[2], V[3], C[K[0]], C[K[2]], C[K[3]]);
  }
  // the skirt: from the outer square's edge 450 further out, sinking to a fifth of the edge's height, into the fog
  const X0 = T.x0, Z0 = T.z0, X1 = T.x0 + (N - 1) * T.step, Z1 = T.z0 + (T.nz - 1) * T.step, S = 450;
  const edge = (i0: number, j0: number, di: number, dj: number, n: number, ox: number, oz: number) => {
    for (let k = 0; k + 1 < n; k++) {
      const ia = i0 + di * k, ja = j0 + dj * k, ib = ia + di, jb = ja + dj, ha = at(ia, ja), hb = at(ib, jb);
      const A: P3 = [T.x0 + ia * T.step, ha - 0.02, T.z0 + ja * T.step], B: P3 = [T.x0 + ib * T.step, hb - 0.02, T.z0 + jb * T.step];
      triV(G, A, B, [B[0] + ox * S, hb * 0.2 - 0.3, B[2] + oz * S], C[ja * N + ia], C[jb * N + ib], SNOW);
      triV(G, A, [B[0] + ox * S, hb * 0.2 - 0.3, B[2] + oz * S], [A[0] + ox * S, ha * 0.2 - 0.3, A[2] + oz * S], C[ja * N + ia], SNOW, SNOW);
    }
  };
  edge(0, 0, 1, 0, N, 0, -1); edge(0, T.nz - 1, 1, 0, N, 0, 1); edge(0, 0, 0, 1, T.nz, -1, 0); edge(N - 1, 0, 0, 1, T.nz, 1, 0);
  for (const [cx, cz, ox, oz, i, j] of [[X0, Z0, -1, -1, 0, 0], [X1, Z0, 1, -1, N - 1, 0], [X1, Z1, 1, 1, N - 1, T.nz - 1], [X0, Z1, -1, 1, 0, T.nz - 1]]) {
    const h = at(i, j), y = h * 0.2 - 0.3, A: P3 = [cx, h - 0.02, cz];
    triV(G, A, [cx + ox * S, y, cz], [cx + ox * S, y, cz + oz * S], C[j * N + i], SNOW, SNOW); triV(G, A, [cx + ox * S, y, cz + oz * S], [cx, y, cz + oz * S], C[j * N + i], SNOW, SNOW);
  }
  // and beyond the skirt a snowy plain round it (a ring: inside, the river would show it through the ice)
  const R0 = X1 + S, R1 = 4000, y = -0.3;
  for (const [a0, b0, a1, b1] of [[-R1, -R1, R1, -R0], [-R1, R0, R1, R1], [-R1, -R0, -R0, R0], [R0, -R0, R1, R0]]) quad(G, [a0, y, b0], [a0, y, b1], [a1, y, b1], [a1, y, b0], SNOW);
}

// ---------- the Vltava: ice with snow drifts and dark cracks (a texture tiled in world units) ----------
function iceTex() {
  return canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#a9c9c6'; g.fillRect(0, 0, w, h);
    for (let k = 0; k < 26; k++) {                                                  // snow drifts
      const x = hash01(k, 1) * w, y = hash01(k, 2) * h, r = 10 + hash01(k, 3) * 34, grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, 'rgba(245,247,246,0.85)'); grd.addColorStop(1, 'rgba(245,247,246,0)'); g.fillStyle = grd;
      for (const [dx, dy] of [[0, 0], [w, 0], [-w, 0], [0, h], [0, -h]]) { g.save(); g.translate(dx, dy); g.fillRect(x - r, y - r, 2 * r, 2 * r); g.restore(); }
    }
    g.strokeStyle = 'rgba(40,64,68,0.75)'; g.lineWidth = 1.4;                       // cracks: a few jagged lines, wrapping round the tile
    for (let k = 0; k < 9; k++) {
      let x = hash01(k, 11) * w, y = hash01(k, 12) * h, a = hash01(k, 13) * Math.PI * 2;
      g.beginPath(); g.moveTo(x, y);
      for (let s = 0; s < 9; s++) { a += (hash01(k * 17 + s, 14) - 0.5) * 1.6; x += Math.cos(a) * 14; y += Math.sin(a) * 14; g.lineTo(x, y); }
      g.stroke();
    }
  }, { repeat: true });
}
function water(): Bucket {
  const W = Bucket(), U = 60;
  for (const q0 of DATA.water) {
    const q = orient(q0), t = earClip(q);
    for (let i = 0; i < t.length; i += 3) {
      const a = t[i], b = t[i + 2], c = t[i + 1];                                    // turned to face up
      const P = (k: number): P3 => [q[2 * k], WATER_Y, q[2 * k + 1]], UV = (k: number): [number, number] => [q[2 * k] / U, q[2 * k + 1] / U];
      tri(W, P(a), P(b), P(c), 0xffffff, UV(a), UV(b), UV(c));
    }
  }
  return W;
}

// ---------- the woods: trees in the parks of the outer zone (Vítkov's slopes, Štvanice, Letná's edge), a jittered grid ----------
const TREES: number[] = [];                                    // x, y, z, scale, height scale, yaw per tree
function woods() {
  TREES.length = 0;
  const STEP = 15, MAX = 2200;
  for (let z = OUTER.z0 + 5; z < OUTER.z1 && TREES.length < MAX * 6; z += STEP) for (let x = OUTER.x0 + 5; x < OUTER.x1; x += STEP) {
    const i = Math.round(x), j = Math.round(z), tx = x + (hash01(i, j) - 0.5) * 12, tz = z + (hash01(j, i + 7) - 0.5) * 12;
    if (tx > ARENA.x0 - 20 && tx < ARENA.x1 + 20 && tz > ARENA.z0 - 20 && tz < ARENA.z1 + 20) continue;
    if (!inPark(tx, tz) || inWater(tx, tz)) continue;
    const y = terrainH(tx, tz); if (y < -0.3) continue;
    if (solidAt(tx, y + 1, tz)) continue;                                          // not in a house
    const s = 0.9 + hash01(i * 3, j * 5) * 0.8, sy = s * (0.85 + hash01(i, j * 3) * 0.35);
    TREES.push(tx, y - 0.2, tz, s, sy, hash01(j, i) * Math.PI * 2);
    solid({ k: 1, x: tx, z: tz, y0: y - 0.2, h: y - 0.2 + 6.4 * sy, a: 2.3 * s, b: 0, ux: 0, uz: 0 }, 2.3 * s);
  }
}
// the city's tree (world/city.ts) made cheaper for the woods, seen from afar: two tiers, five-sided, open below, snow on the top one
function treeGeo(): Geo {
  const g = Bucket();
  for (let i = 0; i < 2; i++) {
    const rr = 2.3 - i * 0.75, h = 3.4 - i * 0.6, y = 1.2 + i * 2.4;
    addGeo(g, translate(cylGeo(0, rr, h, 5, true), 0, y + h / 2, 0), null, COL.teal);
  }
  addGeo(g, translate(cylGeo(0, 0.85, 1.2, 5, true), 0, 6.1, 0), null, SNOW);
  return g;
}
function treeInst(name: string, idx: number[], mat: StandardMaterial) {
  if (!idx.length) return;
  const im = new Inst(name, treeGeo(), mat, idx.length, { receive: false }), o = new Dummy();
  idx.forEach((t, i) => { o.position.set(TREES[t], TREES[t + 1], TREES[t + 2]); o.rotation.set(0, TREES[t + 5], 0); o.scale.set(TREES[t + 3], TREES[t + 4], TREES[t + 3]); im.setMatrixAt(i, o.updateMatrix()); });
  im.update();
  im.mesh.alwaysSelectAsActiveMesh = false; im.mesh.thinInstanceRefreshBoundingInfo(false); im.mesh.freezeWorldMatrix();   // culled by its own box
}

export function buildLand() {
  const G = Bucket();
  terrain(G);
  bake('landGround', G, lambert(0xffffff), false);                                  // lies on the ground: takes the tanks' shadows
  const ice = geoMesh('vltava', water(), lambert(0xffffff, { map: iceTex() }), false, true); ice.freezeWorldMatrix();
  woods();
  for (const e of EXTRA) solid({ k: 0, x: e.x, z: e.z, y0: e.y0, h: e.y1, a: e.a, b: e.b, ux: e.ux, uz: e.uz }, Math.hypot(e.a, e.b));
  // the woods in two instanced meshes, the south (Vítkov) and the north, each culled by its own box
  const south: number[] = [], north: number[] = [];
  for (let t = 0; t < TREES.length; t += 6) (TREES[t + 2] > 0 ? south : north).push(t);
  const treeMat = lambert(0xffffff);
  treeInst('landTrees', south, treeMat); treeInst('landTreesNorth', north, treeMat);
}
