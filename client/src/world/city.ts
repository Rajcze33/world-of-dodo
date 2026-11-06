// The city: World of DODO, issue #16: the real Karlín from client/shared/map.ts (karlin.json, made from OpenStreetMap, IPR Praha and
// ČÚZK data). The ground and the streets (world/roads.ts), every house (world/buildings.ts), the landmarks (world/landmarks.ts),
// the trees and street lamps (props, world/props.ts), the construction site with its crane on its lot (map.ts SITE), the DODO depot
// hall on another (map.ts DEPOT), the city's Christmas tree on Karlínské náměstí, and at the end the merged meshes, in tiles
// (world/tiles.ts). This replaces the original's invented 7 × 7 grid of perimeter blocks, its church, plaza and REDLINE hall.
//
// main.ts calls buildCity, then buildTraffic, then finishCity (the original's order; the traffic no longer depends on it, nothing
// here draws random numbers). buildCity makes the ground, the houses and the props; finishCity the site, the depot, the market and
// the merged meshes. The looks come from hashes of the data, and the props (trees, lamps) are registered in an order that follows
// only the data, so every client counts them alike (the server knows a prop by its index).
import { Vector3, Quaternion, TransformNode } from '@babylonjs/core';
import { scene } from '../core/engine';
import {
  Bucket, quad, boxB, addGeo, mergeGeos, bake, geoMesh, Inst, Dummy, compose, applyMatrix, boxGeo, cylGeo, coneGeo, planeGeo,
  circleGeo, octaGeo, translate, rotateX, rotateY, rotateZ, type Geo,
} from '../core/geo';
import { M, lambert, basic, VC_MAT, VC_GLOW } from '../core/mat';
import { weatherMat } from '../core/matlib';
import { poolTex, logoTex, canvasTex } from '../core/tex';
import { COL } from '../core/colors';
import { DATA, ARENA, BLOCKS, NODES, SITE, DEPOT, SOLIDS, groundH, freeAt, inArena, nearestEdge, edgePos } from '../../shared/map.ts';
import { pointInPoly, polyArea, polyCentroid, polyBox } from '../../shared/geom.ts';
import { registerProp, applyGroup } from './props';
import type { Prop } from '../game/types';
import { bakeTiles, tileB } from './tiles';
import { prepareBuildings, buildBuildings, facadeMat } from './buildings';
import { buildLandmarks, FLOOD } from './landmarks';
import { buildRoads, SHELTERS } from './roads';
import { hash01 } from './poly';

// World of DODO: the construction site's crane top, turned slowly by the main loop (null without the site)
export let CRANE_TOP: TransformNode | null = null;

// the little green lights of the path motif (depot roof edge, the Christmas market's stalls): one instanced mesh at the end
const dotPositions: number[][] = [];
// scratch for the props' matrices (three's Object3D of the original)
const AXIS_Y = new Vector3(0, 1, 0), PQ1 = new Quaternion(), PQ2 = new Quaternion(), PAX = new Vector3(), PO = new Dummy();
// where props must not stand: the site's lot, the depot hall and its yard, the shelters (boxes x0, z0, x1, z1)
const KEEP_OFF: number[][] = [];
const keptOff = (x: number, z: number, m: number) => KEEP_OFF.some(b => x > b[0] - m && x < b[2] + m && z > b[1] - m && z < b[3] + m);

// ---------- the first part: up to the traffic ----------
export function buildCity() {
  const { bs, P } = prepareBuildings();
  const skip = buildLandmarks(bs, P);
  buildBuildings(bs, P, skip);
  buildRoads();
  // the props stay off the site, the depot and its yard, and the tram shelters
  if (SITE) { const A = SITE.area; KEEP_OFF.push([A.x0 - 1, A.z0 - 1, A.x1 + 1, A.z1 + 1]); }
  if (DEPOT.p) {                                                    // the hall and its yard in front (15 towards the street)
    const b = polyBox(DEPOT.p), Y = 15;
    KEEP_OFF.push([b[0] - (DEPOT.fx < 0 ? Y : 0), b[1] - (DEPOT.fz < 0 ? Y : 0), b[2] + (DEPOT.fx > 0 ? Y : 0), b[3] + (DEPOT.fz > 0 ? Y : 0)]);
  }
  for (const s of SHELTERS) KEEP_OFF.push([s.x - 3.6, s.z - 3.6, s.x + 3.6, s.z + 3.6]);
  trees();
  lamps();
}

// ---------- trees ----------
// one tree as its own group: only the big Christmas tree on Karlínské náměstí, which carries its lights and star. The original's 7
// meshes (trunk, 3 cones, 3 snow caps) are merged here into 3, one per material: the same shapes, fewer draw calls.
function treeGroup(x: number, z: number, s: number): TransformNode {
  const y = groundH(x, z), g = new TransformNode('cityTree', scene); g.position.set(x, y, z);
  const cones: Geo[] = [], caps: Geo[] = [];
  for (let i = 0; i < 3; i++) {
    const r = (2.2 - i * 0.55) * s, h = (2.6 - i * 0.4) * s, yy = (1.4 + i * 1.5) * s;
    cones.push(translate(coneGeo(r, h, 8), 0, yy + h / 2, 0)); caps.push(translate(coneGeo(r * 0.55, h * 0.4, 8), 0, yy + h * 0.8, 0));
  }
  geoMesh('cityTreeTrunk', translate(cylGeo(0.25 * s, 0.3 * s, 1.2 * s, 6), 0, 0.6 * s, 0), M.trunk, true, false).parent = g;
  geoMesh('cityTreeCones', mergeGeos(cones), M.tree, true, false).parent = g;
  geoMesh('cityTreeSnow', mergeGeos(caps), M.snow, false, false).parent = g;
  registerProp({ kind: 'tree', g, x, z, r: 0.4 * s + 0.3, breakV: 2 + 3 * s, minMass: 6, slow: 0.82, th0: 1.5, acc: 2.4, w0: 0.5, lift: 1.7 * s, y0: y, q0: Quaternion.Identity(), apply: applyGroup });
  return g;
}
// World of DODO: every other tree is one instance in three instanced meshes (trunks, green cones, snow caps). The parts are built at
// scale 1 with their offsets baked in, so the three parts of a tree share one matrix: base at (x, ground, z), scale s, tilt when it
// is knocked down (the same motion applyGroup gives a group). Issue #16: Karlín has some 600 trees and as many lamps, so the
// instanced meshes come in chunks of the arena (CH_NX x CH_NZ), each culled by its own box, in the view and in the shadow map: in
// one mesh each, every tree and lamp of the city was drawn in every frame and into the shadow map wherever the camera looked.
const CH_NX = 3, CH_NZ = 2;
const chunkOf = (x: number, z: number) => {
  const i = Math.max(0, Math.min(CH_NX - 1, Math.floor((x - ARENA.x0) / (ARENA.x1 - ARENA.x0) * CH_NX)));
  return i + CH_NX * Math.max(0, Math.min(CH_NZ - 1, Math.floor((z - ARENA.z0) / (ARENA.z1 - ARENA.z0) * CH_NZ)));
};
// once a chunk's instances stand: its box from them, grown for a toppled one, and culled by it from now on
function cullByBox(ims: Inst[]) {
  for (const im of ims) {
    const m = im.mesh; m.thinInstanceRefreshBoundingInfo(false);
    const bi = m.getBoundingInfo(), lo = bi.minimum.clone(), hi = bi.maximum.clone();
    lo.x -= 10; lo.z -= 10; hi.x += 10; hi.z += 10; hi.y += 2; bi.reConstruct(lo, hi);
    m.alwaysSelectAsActiveMesh = false;
  }
}
const TREE_CH: Inst[][] = [];
function treeMeshes(counts: number[]) {
  const cones: Geo[] = [], caps: Geo[] = [];
  for (let i = 0; i < 3; i++) {
    const r = 2.2 - i * 0.55, h = 2.6 - i * 0.4, y = 1.4 + i * 1.5;
    cones.push(translate(cylGeo(0, r, h, 7, true), 0, y + h / 2, 0)); caps.push(translate(cylGeo(0, r * 0.55, h * 0.4, 7, true), 0, y + h * 0.8, 0));   // open below: never seen
  }
  const trunk = translate(cylGeo(0.25, 0.3, 1.2, 5, true), 0, 0.6, 0), cone = mergeGeos(cones), cap = mergeGeos(caps);
  const mats = [M.trunk.clone('treeTrunk'), M.tree.clone('treeCone'), M.snow.clone('treeCap')];
  for (const n of counts) {
    if (!n) { TREE_CH.push([]); continue; }
    const mk = (name: string, geo: Geo, k: number, cast: boolean) => { const m = new Inst(name, geo, mats[k], n, { cast, receive: false }); m.count = 0; return m; };
    TREE_CH.push([mk('treeTrunks', trunk, 0, true), mk('treeCones', cone, 1, true), mk('treeCaps', cap, 2, false)]);
  }
}
function applyTree(p: Prop) {
  if (p.th > 0) { PAX.set(p.fz, 0, -p.fx); Quaternion.RotationAxisToRef(PAX, p.th, PO.quaternion); } else PO.quaternion.copyFromFloats(0, 0, 0, 1);
  PO.position.set(p.x, p.y0 + p.lift * Math.sin(p.th), p.z); PO.scale.setAll(p.s); PO.updateMatrix();
  for (const m of TREE_CH[p.ch]) { m.setMatrixAt(p.idx, PO.matrix); m.update(); }
}
function tree(x: number, z: number, s: number) {
  const ch = chunkOf(x, z), ims = TREE_CH[ch], idx = ims[0].count; if (idx >= ims[0].max) return;
  for (const m of ims) m.count = idx + 1;
  const p = registerProp({ kind: 'tree', ch, idx, s, x, z, r: 0.4 * s + 0.3, breakV: 2 + 3 * s, minMass: 6, slow: 0.82, th0: 1.5, acc: 2.4, w0: 0.5, lift: 1.7 * s, y0: groundH(x, z), apply: applyTree });
  applyTree(p);
}
// The trees, in this order: karlin.json's (OpenStreetMap's trees and tree rows), then a few more in the parks lying on the blocks
// (a jittered grid, hashed), then the Christmas tree with its little ring of trees. Each only where it stands free of the houses.
const XMAS = { x: 0, z: 0, on: false }; let XMAS_G: TransformNode | null = null;
function trees() {
  const spots: number[] = [];
  const ok = (x: number, z: number, m: number) => freeAt(x, z, m) && !keptOff(x, z, 1.5);
  const T = DATA.trees;
  for (let i = 0; i + 2 < T.length; i += 3) if (ok(T[i], T[i + 1], 0.4)) spots.push(T[i], T[i + 1], T[i + 2]);
  const near = (x: number, z: number, r: number) => { for (let k = 0; k < spots.length; k += 3) if (Math.abs(spots[k] - x) < r && Math.abs(spots[k + 1] - z) < r && Math.hypot(spots[k] - x, spots[k + 1] - z) < r) return true; return false; };
  let extra = 0;
  DATA.parks.forEach((q, pi) => {
    if (extra > 140 || polyArea(q) < 60) return;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < q.length; i += 2) { x0 = Math.min(x0, q[i]); x1 = Math.max(x1, q[i]); z0 = Math.min(z0, q[i + 1]); z1 = Math.max(z1, q[i + 1]); }
    if (!inArena(x0, z0) || !inArena(x1, z1)) return;
    for (let x = x0 + 4; x < x1 - 2; x += 12) for (let z = z0 + 4; z < z1 - 2; z += 12) {
      const jx = x + (hash01(pi * 977 + Math.round(x), Math.round(z)) - 0.5) * 5, jz = z + (hash01(Math.round(z) * 31 + pi, Math.round(x)) - 0.5) * 5;
      if (!pointInPoly(q, jx, jz) || groundH(jx, jz) < 0.29 || !ok(jx, jz, 1.2) || near(jx, jz, 6) || DATA.plazas.some(pz => pointInPoly(pz, jx, jz))) continue;   // the squares stay open
      spots.push(jx, jz, 0.8 + 0.4 * hash01(Math.round(jx * 10), Math.round(jz * 10))); extra++;
    }
  });
  // the Christmas tree: in the biggest square, where it has room
  let big = -1, ba = 0; DATA.plazas.forEach((q, i) => { const a = Math.abs(polyArea(q)); if (a > ba) { ba = a; big = i; } });
  if (big >= 0) {
    const q = DATA.plazas[big], [cx, cz] = polyCentroid(q);
    for (let r = 0; r < 40 && !XMAS.on; r += 3) for (let k = 0; k < 8 && !XMAS.on; k++) {
      const x = cx + r * Math.cos(k * Math.PI / 4), z = cz + r * Math.sin(k * Math.PI / 4);
      if (pointInPoly(q, x, z) && ok(x, z, 7) && !near(x, z, 6)) Object.assign(XMAS, { x, z, on: true });
    }
  }
  const ring: number[] = [];
  if (XMAS.on) for (let t = 0; t < 6; t++) { const a = t / 6 * Math.PI * 2, x = XMAS.x + Math.cos(a) * 7.5, z = XMAS.z + Math.sin(a) * 7.5; if (ok(x, z, 0.6)) ring.push(x, z, 0.5); }
  const counts = new Array(CH_NX * CH_NZ).fill(0), all = [...spots, ...ring];
  for (let k = 0; k < all.length; k += 3) counts[chunkOf(all[k], all[k + 1])]++;
  treeMeshes(counts);
  for (let k = 0; k < spots.length; k += 3) tree(spots[k], spots[k + 1], spots[k + 2]);
  if (XMAS.on) XMAS_G = treeGroup(XMAS.x, XMAS.z, 2.2);
  for (let k = 0; k < ring.length; k += 3) tree(ring[k], ring[k + 1], ring[k + 2]);
  for (const ims of TREE_CH) if (ims.length) cullByBox(ims);
  TREE_SPOTS = all;
}
let TREE_SPOTS: number[] = [];

// ---------- street lamps ----------
// Along every block's kerb, every LAMP_STEP, half a unit in from the kerb, the arm over the street; not at the junctions' corners,
// not where the kerb is the arena's edge (no street there), not on a house, a tree, the site or the depot. Instanced, so each can
// be knocked over (they are props).
const LAMP_STEP = 18;
function lamps() {
  const specs: { x: number; z: number; phi: number }[] = [], juncs = NODES.filter(n => n.e.length >= 3);
  const nearJunc = (x: number, z: number) => juncs.some(n => Math.hypot(n.x - x, n.z - z) < n.r + 4.5);
  for (const B of BLOCKS) {
    const p = B.p, n = p.length;
    for (let i = 0; i < n; i += 2) {
      const j = (i + 2) % n, ax = p[i], az = p[i + 1], dx = p[j] - ax, dz = p[j + 1] - az, L = Math.hypot(dx, dz); if (L < 6) continue;
      const ux = dx / L, uz = dz / L, ox = uz, oz = -ux, cnt = Math.max(1, Math.floor(L / LAMP_STEP)), s0 = (L - (cnt - 1) * LAMP_STEP) / 2;
      for (let k = 0; k < cnt; k++) {
        const s = s0 + k * LAMP_STEP, x = ax + ux * s - ox * 0.55, z = az + uz * s - oz * 0.55;
        if (!inArena(x + ox * 4, z + oz * 4, 1) || nearJunc(x, z) || !freeAt(x, z, 0.6) || keptOff(x, z, 1)) continue;
        const ne = nearestEdge(x + ox * 1.5, z + oz * 1.5); if (!ne || ne.d > ne.e.w / 2 + 2.5) continue;   // a street in front of it
        if (specs.some(q => Math.abs(q.x - x) < 7 && Math.abs(q.z - z) < 7)) continue;
        if (treeNear(x, z, 2)) continue;
        specs.push({ x, z, phi: Math.atan2(-oz, ox) });
      }
    }
  }
  // shared lamp in local coordinates: base at the origin (pavement), arm and head towards local +x (= over the street), light pool on the road
  const poleG = Bucket(); boxB(poleG, 0, 0, 0, 0.22, 6.6, 0.22, COL.charcoal); boxB(poleG, 0.6, 6.3, 0, 1.4, 0.16, 0.2, COL.charcoal);
  const headG = Bucket(); boxB(headG, 0.9, 5.95, 0, 0.55, 0.35, 0.55, 0xffffff);
  const poolG = translate(rotateX(planeGeo(14, 14), -Math.PI / 2), 2.5, -0.24, 0);
  const mPole = lambert(0xffffff, { double: true }), mHead = basic(0xffffff, { double: true });
  const mPool = basic(COL.light, { map: poolTex, transparent: true, opacity: 0.2, depthWrite: false, additive: true, double: true });
  const counts = new Array(CH_NX * CH_NZ).fill(0); for (const sp of specs) counts[chunkOf(sp.x, sp.z)]++;
  const CH = counts.map(n => n ? [new Inst('lampPoles', poleG, mPole, n, { cast: true, receive: false }), new Inst('lampHeads', headG, mHead, n, { receive: false }), new Inst('lampPools', poolG, mPool, n, { receive: false })] : []);
  for (const ims of CH) for (const m of ims) m.count = 0;
  const applyLamp = (p: Prop) => {
    const [LPOLE, LHEAD, LPOOL] = CH[p.ch];
    Quaternion.RotationAxisToRef(AXIS_Y, p.phi, PQ1);
    if (p.th > 0) { PAX.set(p.fz, 0, -p.fx); Quaternion.RotationAxisToRef(PAX, p.th, PQ2); PQ2.multiplyToRef(PQ1, PQ1); }   // three's PQ1.premultiply(PQ2)
    PO.position.set(p.x, p.y0 + p.lift * Math.sin(p.th), p.z); PO.quaternion.copyFrom(PQ1); PO.scale.set(1, 1, 1); PO.updateMatrix();
    LPOLE.setMatrixAt(p.idx, PO.matrix); LHEAD.setMatrixAt(p.idx, PO.matrix);
    if (p.th > 0) PO.scale.set(0, 0, 0); PO.updateMatrix(); LPOOL.setMatrixAt(p.idx, PO.matrix);         // a fallen lamp has no light pool
    LPOLE.update(); LHEAD.update(); LPOOL.update();
  };
  for (const sp of specs) {
    const ch = chunkOf(sp.x, sp.z), ims = CH[ch], idx = ims[0].count; for (const m of ims) m.count = idx + 1;
    const p = registerProp({ kind: 'lamp', x: sp.x, z: sp.z, phi: sp.phi, ch, idx, r: 0.45, breakV: 3.5, minMass: 0, slow: 0.95, th0: 1.5, acc: 4.5, w0: 1.0, lift: 0.12, y0: groundH(sp.x, sp.z), apply: applyLamp });
    applyLamp(p);
  }
  for (const ims of CH) if (ims.length) cullByBox(ims);
}
// a tree (registered so far) within r of (x, z)?
function treeNear(x: number, z: number, r: number) {
  for (let k = 0; k < TREE_SPOTS.length; k += 3) if (Math.abs(TREE_SPOTS[k] - x) < r && Math.abs(TREE_SPOTS[k + 1] - z) < r) return true;
  return false;
}

// ---------- the second part: after the traffic, up to baking the meshes ----------
let DIRT = Bucket(), POOLS = Bucket();
export function finishCity() {
  DIRT = Bucket(); POOLS = Bucket();
  site();
  depotHall();
  redlineHall();
  if (XMAS.on) market();
  // path-motif light dots (instanced)
  if (dotPositions.length) {
    const im = new Inst('lightDots', octaGeo(1), M.dot, dotPositions.length, { receive: false }), o = new Dummy();   // tiny: 8 faces do
    dotPositions.forEach((p, i) => { o.position.set(p[0], p[1], p[2]); o.scale.setAll(p[3]); im.setMatrixAt(i, o.updateMatrix()); });
    im.update();
  }
  // ---------- finalize merged meshes ----------
  // World of DODO, issue #27: the lit tiles follow the weather (core/matlib.ts setWeatherLook): their vertex colours already show today's
  // snowy night, so the library's 'baked' mode adds no snow layer (no change at the default weather) but thaws what is snow-white and
  // faces up (the snow on the far roofs, on cornices, ledges and shelters) to a bare grey as the snow goes, and the rain darkens all of
  // it (cornices, the shop band, frames, pediments) with a sheen. The glow tiles stay as they are: they are lights (lit windows, shop
  // windows, signs, the clocks), which neither snow nor rain changes.
  bakeTiles({ fac: facadeMat(), vc: weatherMat({ tint: 0xffffff, double: true, baked: true, snow: 1, wet: 0.6 }), glow: basic(0xffffff, { double: true }) });
  bake('floodlit', FLOOD, lambert(0xffffff, { emissive: 0x3e4240, emissiveIntensity: 1 }), true);   // the church and the memorial
  const dm = lambert(0xffffff); dm.zOffset = -1; dm.zOffsetUnits = -6;
  bake('siteDirt', DIRT, dm, false);
  bake('pools', POOLS, basic(COL.light, { map: poolTex, transparent: true, opacity: 0.2, depthWrite: false, additive: true, double: true }), false);
  DIRT = Bucket(); POOLS = Bucket();
}

// ---------- World of DODO: the construction site on its lot (map.ts SITE, client/shared/site.ts) ----------
// Everything that stands still goes into the merged buckets (no extra draw calls); only the crane's top turns, as its own two meshes
// (CRANE_TOP, turned in the main loop). Issue #16: the lot is on a block, so all of it stands on the pavement's height.
const BQ = new Quaternion(), BV = new Vector3(), BZ = new Vector3(0, 0, 1), BP = new Vector3(), B1 = new Vector3(1, 1, 1), BM = new Float32Array(16);
// a square beam of thickness t from one point to another
function beam(bk: Bucket, x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, t: number, col: number) {
  BV.set(x2 - x1, y2 - y1, z2 - z1); const L = BV.length(); Quaternion.FromUnitVectorsToRef(BZ, BV.normalize(), BQ, 1e-6);   // three's epsilon
  compose(BP.set((x1 + x2) / 2, (y1 + y2) / 2, (z1 + z2) / 2), BQ, B1, BM); addGeo(bk, applyMatrix(boxGeo(t, t, L), BM), null, col);
}
const shade = (c: number, k: number) => (Math.min(255, ((c >> 16) & 255) * k) << 16) | (Math.min(255, ((c >> 8) & 255) * k) << 8) | Math.min(255, (c & 255) * k);
function site() {
  if (!SITE) return;                                                // off until a real site in Karlín is chosen (map.ts SITE_LOT)
  const S = SITE, A = S.area, [ox, oz] = S.origin, Y0 = groundH(ox, oz), trim = tileB('vc', ox, oz), glow = tileB('glow', ox, oz);
  const [outx, outz] = S.out;
  // dirt instead of snow (vertices in this order face up), and darker tracks from the gates out to the street
  const dirt = (x0: number, z0: number, x1: number, z1: number, col: number, dy = 0) => quad(DIRT, [x0, Y0 + 0.02 + dy, z0], [x0, Y0 + 0.02 + dy, z1], [x1, Y0 + 0.02 + dy, z1], [x1, Y0 + 0.02 + dy, z0], col);
  dirt(A.x0 - 1, A.z0 - 1, A.x1 + 1, A.z1 + 1, 0x6e5c48);
  for (const g of S.gates) {
    const ax = g.x - outx * 16, az = g.z - outz * 16, bx = g.x + outx * 2.2, bz = g.z + outz * 2.2, hw = outx ? 0 : 4, hd = outx ? 4 : 0;
    dirt(Math.min(ax, bx) - hw, Math.min(az, bz) - hd, Math.max(ax, bx) + hw, Math.max(az, bz) + hd, 0x5a4a3a, 0.005);
  }
  for (const b of S.solids) {
    const w = b.x1 - b.x0, d = b.z1 - b.z0, cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2, c = b.color ?? 0, along = w >= d;
    // the machines' models are drawn for the layout's long side along x; a box turned the other way turns the model with it
    const turn = (b.kind === 'excavator' || b.kind === 'dozer') && w > d, R = turn ? Math.PI / 2 : 0;
    const P = (lx: number, lz: number): [number, number] => turn ? [cx + lz, cz - lx] : [cx + lx, cz + lz];
    const lb = (bk: Bucket, lx: number, y: number, lz: number, bw: number, bh: number, bd: number, col: number, top?: number) => { const [x, z] = P(lx, lz); boxB(bk, x, Y0 + y, z, bw, bh, bd, col, R, top); };
    const md = turn ? w : d;
    if (b.kind === 'fence') {                                                                          // green mesh panels between white posts
      boxB(trim, cx, Y0, cz, w, b.h, d, c); const L = along ? w : d;
      for (let s = 0; s <= L; s += 3) boxB(trim, along ? b.x0 + s : cx, Y0, along ? cz : b.z0 + s, 0.14, b.h + 0.15, 0.14, 0xd6d8d7);
    } else if (b.kind === 'wall' || b.kind === 'column') {                                              // concrete, rebar sticking out of the top
      boxB(trim, cx, Y0, cz, w, b.h, d, c, 0, shade(c, 1.08));
      const L = Math.max(w, d); for (let s = 0.4; s < L; s += 1.2) boxB(trim, along ? b.x0 + s : cx, Y0 + b.h, along ? cz : b.z0 + s, 0.06, 0.9, 0.06, 0x5a3a2a);
    } else if (b.kind === 'container' || b.kind === 'office') {
      const lev = b.h > 3 ? 2 : 1, lh = b.h / lev;
      for (let k = 0; k < lev; k++) {
        const col = k ? shade(c, 0.88) : c; boxB(trim, cx, Y0 + k * lh, cz, w, lh - 0.04, d, col, 0, shade(col, 1.1));
        if (b.kind === 'container') for (const e of [-1, 1]) boxB(trim, along ? cx + e * (w / 2 - 0.06) : cx, Y0 + k * lh, along ? cz : cz + e * (d / 2 - 0.06), along ? 0.14 : w + 0.06, lh - 0.04, along ? d + 0.06 : 0.14, shade(col, 0.7));   // door ends
        else {                                                                                         // lit cabin windows towards the gates' side
          const fx = cx + outx * (w / 2 + 0.03), fz = cz + outz * (d / 2 + 0.03);
          boxB(glow, fx, Y0 + k * lh + 1.1, fz, outx ? 0.04 : w - 1, 0.7, outx ? d - 1 : 0.04, 0xb2dcd6);
        }
      }
    } else if (b.kind === 'toilet') {
      boxB(trim, cx, Y0, cz, w, b.h, d, c, 0, 0xeaebeb);
    } else if (b.kind === 'pile') {                                                                    // a sand pile: its radius and height are in the layout
      const r = b.r as number, ph = b.ph as number;
      addGeo(trim, translate(coneGeo(r, ph, 12), cx, Y0 + ph / 2, cz), null, c);
      addGeo(trim, translate(coneGeo(r * 0.6, ph * 0.6, 10), cx + r * 0.7, Y0 + ph * 0.3, cz - r * 0.3), null, shade(c, 0.9));
    } else if (b.kind === 'pipes') {
      const ax = b.axis === 'z', L = ax ? d : w;
      for (const [py, pz] of [[0.85, -0.95], [0.85, 0.95], [2.3, 0]]) {
        const cyl = rotateZ(cylGeo(0.85, 0.85, L, 14), Math.PI / 2);
        addGeo(trim, ax ? translate(rotateY(cyl, Math.PI / 2), cx + pz, Y0 + py, cz) : translate(cyl, cx, Y0 + py, cz + pz), null, c);
        for (const e of [-1, 1]) {
          const end = rotateY(circleGeo(0.55, 14), e * Math.PI / 2);
          addGeo(trim, ax ? translate(rotateY(end, Math.PI / 2), cx + pz, Y0 + py, cz + e * (L / 2 + 0.01)) : translate(end, cx + e * (L / 2 + 0.01), Y0 + py, cz + pz), null, 0x3d4543);
        }
      }
    } else if (b.kind === 'barrier') {                                                                 // jersey barrier: wide foot, narrow top
      boxB(trim, cx, Y0, cz, w, 0.45, d, c); boxB(trim, cx, Y0 + 0.45, cz, along ? w : d * 0.5, 0.95, along ? d * 0.5 : d, c, 0, shade(c, 1.05));
      boxB(trim, cx, Y0 + 1.12, cz, along ? w + 0.02 : d * 0.5 + 0.02, 0.14, along ? d * 0.5 + 0.02 : d + 0.02, 0xc0524a);
    } else if (b.kind === 'pallet') {
      boxB(trim, cx, Y0, cz, w, 0.15, d, 0x8a6a44); boxB(trim, cx, Y0 + 0.15, cz, w - 0.2, b.h - 0.15, d - 0.2, c);
    } else if (b.kind === 'excavator') {                                                               // tracks, body, cab, the arm reaching for the sand
      for (const s of [-1, 1]) lb(trim, s * 1.2, 0, 0, 0.8, 0.9, md, 0x2b2b2b);
      lb(trim, 0, 0.9, 0, 2.8, 1.2, 3, c); lb(trim, 0.6, 2.1, -0.4, 1.3, 1.3, 1.4, c); lb(glow, 0.6, 2.5, -1.12, 1.1, 0.7, 0.04, 0x9fd3ff);
      const a = P(-0.6, 1.2), e1 = P(-3.8, 4.6), e2 = P(-6, 7), e3 = P(-6.1, 7.1);
      beam(trim, a[0], Y0 + 2.3, a[1], e1[0], Y0 + 5.4, e1[1], 0.5, c); beam(trim, e1[0], Y0 + 5.4, e1[1], e2[0], Y0 + 2.2, e2[1], 0.4, c);
      addGeo(trim, translate(boxGeo(1.2, 0.8, 1), e3[0], Y0 + 1.8, e3[1]), null, 0x3d4543);
    } else if (b.kind === 'dozer') {
      for (const s of [-1, 1]) lb(trim, s * 1.1, 0, 0, 0.8, 0.9, md - 0.6, 0x2b2b2b);
      lb(trim, 0, 0.9, 0.3, 2.4, 1, 3, c); lb(trim, 0, 1.9, 0.8, 1.4, 0.9, 1.4, c); lb(glow, 0, 2.2, 0.08, 1.2, 0.5, 0.04, 0x9fd3ff);
      lb(trim, 0, 0.1, -md / 2 + 0.1, (turn ? d : w) + 0.6, 1.2, 0.3, shade(c, 0.85));
    } else if (b.kind === 'mast') {                                                                    // floodlights facing into the site
      boxB(trim, cx, Y0, cz, w, b.h, d, c); const ix = -Math.sign(cx - ox), iz = -Math.sign(cz - oz);
      boxB(trim, cx, Y0 + b.h, cz, 1.8, 0.2, 0.3, c); for (const s of [-0.6, 0.6]) boxB(glow, cx + s, Y0 + b.h + 0.2, cz, 0.5, 0.4, 0.5, 0xffffff);
      const px = cx + ix * 9, pz = cz + iz * 7; quad(POOLS, [px - 10, Y0 + 0.06, pz - 10], [px + 10, Y0 + 0.06, pz - 10], [px + 10, Y0 + 0.06, pz + 10], [px - 10, Y0 + 0.06, pz + 10], 0xffffff, [[0, 0], [1, 0], [1, 1], [0, 1]]);
    } else if (b.kind === 'crane') boxB(trim, cx, Y0, cz, w, 1.5, d, c);                                // its base block; the mast is drawn below
  }
  // the tower crane: a lattice mast, and on top the part that turns (jib, counter-jib with its weights, cab, trolley, hook and load)
  const cr = S.crane, mw = 1.1, Y = cr.color;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) beam(trim, cr.x + sx * mw, Y0 + 1.5, cr.z + sz * mw, cr.x + sx * mw, Y0 + cr.h, cr.z + sz * mw, 0.24, Y);
  for (let y = 1.5; y < cr.h - 0.5; y += 3) {
    const y1 = Y0 + y, y2 = Y0 + y + 3;
    for (const s of [-1, 1]) {
      beam(trim, cr.x - mw, y1, cr.z + s * mw, cr.x + mw, y1, cr.z + s * mw, 0.12, Y); beam(trim, cr.x + s * mw, y1, cr.z - mw, cr.x + s * mw, y1, cr.z + mw, 0.12, Y);
      beam(trim, cr.x - mw, y1, cr.z + s * mw, cr.x + mw, y2, cr.z + s * mw, 0.09, Y); beam(trim, cr.x + s * mw, y1, cr.z - mw, cr.x + s * mw, y2, cr.z + mw, 0.09, Y);
    }
  }
  const top = Bucket(), lit = Bucket(), L = cr.jib, Bk = cr.back, tx = L * 0.55, hook = -(cr.h - 15);
  boxB(top, 0, 0, 0, 3.2, 1, 3.2, Y); boxB(top, 1.6, 0.2, 1.7, 1.7, 1.9, 1.8, 0xeaebeb); boxB(lit, 1.6, 1.1, 2.62, 1.5, 0.9, 0.04, 0x9fd3ff);   // turntable, cab and its window
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) beam(top, sx * mw, 1, sz * mw, 0, 7.5, 0, 0.2, Y);                                      // the peak
  for (const s of [-1, 1]) { beam(top, 1.5, 1, s * 0.9, L, 1, s * 0.9, 0.2, Y); beam(top, -1.5, 1, s * 0.9, -Bk, 1, s * 0.9, 0.2, Y); }        // jib and counter-jib chords
  beam(top, 1.5, 2.7, 0, L - 2, 2.7, 0, 0.18, Y);
  for (let x = 3; x < L - 2; x += 3) for (const s of [-1, 1]) { beam(top, x, 1, s * 0.9, x, 2.7, 0, 0.08, Y); beam(top, x, 1, s * 0.9, x + 3, 2.7, 0, 0.08, Y); }
  for (let x = -3; x > -Bk; x -= 3) beam(top, x, 1, -0.9, x, 1, 0.9, 0.1, Y);
  boxB(top, -Bk / 2 - 1, 0.8, 0, Bk - 3, 0.2, 2, 0x8d8d86); for (let k = 0; k < 3; k++) boxB(top, -Bk + 1.6 + k * 1.3, 0.9, 0, 1.2, 2.2, 2.2, 0xa9a9a2);   // walkway, counterweights
  for (const [x, y] of [[L * 0.62, 2.7], [-Bk, 1.2]]) beam(top, 0, 7.5, 0, x, y, 0, 0.06, 0x3d4543);                                              // tie cables
  boxB(top, tx, 0.2, 0, 1.4, 0.6, 1.6, 0x3d4543); beam(top, tx, 0.4, 0, tx, hook + 0.6, 0, 0.06, 0x1a1d1c);                                     // trolley and its cable
  boxB(top, tx, hook - 0.4, 0, 0.7, 1, 0.7, Y); for (const [a, b] of [[-1, -0.5], [1, -0.5], [-1, 0.5], [1, 0.5]]) beam(top, tx, hook - 0.4, 0, tx + a * 1.4, hook - 2.4, b, 0.04, 0x1a1d1c);
  boxB(top, tx, hook - 3, 0, 3.2, 0.6, 1.3, 0x7a4a2a);                                                                                          // the load: a bundle of rebar
  for (const [x, y] of [[0, 7.6], [L, 1.3], [-Bk, 1.3]]) boxB(lit, x, y, 0, 0.35, 0.35, 0.35, 0xff3030);                                          // aviation lights
  const g = new TransformNode('craneTop', scene); g.position.set(cr.x, Y0 + cr.h, cr.z);
  geoMesh('craneTopBody', top, VC_MAT, true, false).parent = g; geoMesh('craneTopLights', lit, VC_GLOW, false, false).parent = g;
  CRANE_TOP = g;
}

// ---------- the DODO depot hall on its lot (map.ts DEPOT): the docks and the logo face the street (fx, fz) ----------
// (the single-player game's parking marker in front of it is gone)
function depotHall() {
  if (!DEPOT.p) return;
  const { x, z, fx, fz, w, d } = DEPOT, Y0 = groundH(x, z), R = Math.atan2(-fz, fx), VC = tileB('vc', x, z), sx = -fz, sz = fx;   // s: along the front
  boxB(VC, x, Y0, z, w, 10, d, COL.charcoal, R);
  boxB(VC, x, Y0 + 9, z, w + 0.2, 1.2, d + 0.2, COL.teal, R, COL.teal);
  boxB(VC, x, Y0 + 10.2, z, w, 0.3, d, COL.paper, R);
  const a = Math.atan2(fx, fz), fx0 = x + fx * (w / 2 + 0.06), fz0 = z + fz * (w / 2 + 0.06);
  const lg = geoMesh('depotLogo', rotateY(planeGeo(13, 4.37), a), basic(0xffffff, { map: logoTex, transparent: true }), false, false); lg.position.set(fx0, Y0 + 6.3, fz0); lg.freezeWorldMatrix();
  for (const o of [-9, 0, 9]) {                                                                      // the docks
    const cx = fx0 + sx * o + fx * 0.01, cz = fz0 + sz * o + fz * 0.01, hx = sx * 2.5, hz = sz * 2.5;
    quad(VC, [cx - hx, Y0, cz - hz], [cx + hx, Y0, cz + hz], [cx + hx, Y0 + 3.6, cz + hz], [cx - hx, Y0 + 3.6, cz - hz], COL.lgrey);
    quad(VC, [cx - hx, Y0, cz - hz], [cx - hx, Y0 + 3.6, cz - hz], [cx + hx, Y0 + 3.6, cz + hz], [cx + hx, Y0, cz + hz], COL.lgrey);
  }
  for (let s = -d / 2 + 1; s <= d / 2 - 1 + 0.01; s += 1) dotPositions.push([x + fx * (w / 2 + 0.3) + sx * s, Y0 + 10.6, z + fz * (w / 2 + 0.3) + sz * s, 0.16]);
}

// The REDLINE hall of the original: Karlín's lots leave no room the map gives it (map.ts makes no solid for it), so it is drawn only
// if a solid of kind 'redline' appears there one day: a red hall on that footprint, its sign towards the nearest street.
function redlineHall() {
  const s = SOLIDS.find(o => o.kind === 'redline'); if (!s) return;
  const [x0, z0, x1, z1] = s.box, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, ne = nearestEdge(cx, cz), at = ne ? edgePos(ne.e, ne.s, 0) : { x: cx, z: cz - 1 };
  const dx = at.x - cx, dz = at.z - cz, fxx = Math.abs(dx) > Math.abs(dz) ? Math.sign(dx) : 0, fzz = fxx ? 0 : Math.sign(dz) || 1;
  const Y0 = groundH(cx, cz), VC = tileB('vc', cx, cz), w = fxx ? x1 - x0 : z1 - z0, d = fxx ? z1 - z0 : x1 - x0, R = Math.atan2(-fzz, fxx);
  boxB(VC, cx, Y0, cz, w, s.h - 0.5, d, 0xb3201f, R); boxB(VC, cx, Y0 + s.h - 1.6, cz, w + 0.2, 1.2, d + 0.2, 0x6e1212, R, 0x6e1212); boxB(VC, cx, Y0 + s.h - 0.4, cz, w, 0.3, d, COL.paper, R);
  const signTex = canvasTex(1024, 320, (g, W, H) => {
    g.clearRect(0, 0, W, H); g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = '700 190px Poppins, system-ui, sans-serif'; g.fillText('REDLINE', W / 2, H * 0.45); g.font = '600 60px "IBM Plex Mono", monospace'; g.fillText('E X P R E S S', W / 2, H * 0.86);
  }, { alpha: true });
  const sg = geoMesh('redlineSign', rotateY(planeGeo(13, 4.1), Math.atan2(fxx, fzz)), basic(0xffffff, { map: signTex, transparent: true }), false, false);
  sg.position.set(cx + fxx * (w / 2 + 0.06), Y0 + 6.6, cz + fzz * (w / 2 + 0.06)); sg.freezeWorldMatrix();
}

// the Christmas market round the city's tree on Karlínské náměstí (it has one in real winters too): the tree's lights and star, and stalls
function market() {
  const big = XMAS_G; if (!big) return;
  const sc = 2.2, n = 120, top = 6.2 * sc, im = new Inst('cityTreeLights', octaGeo(1), M.dot, n, { receive: false }), o = new Dummy();
  for (let i = 0; i < n; i++) {
    const t = i / n, a = t * Math.PI * 10, y = 1.6 * sc + t * (top - 1.8 * sc), rr = (2.3 * sc) * (1 - t * 0.82) + 0.15;
    o.position.set(Math.cos(a) * rr, y, Math.sin(a) * rr); o.scale.setAll(0.13 * sc); im.setMatrixAt(i, o.updateMatrix());
  }
  im.update(); im.mesh.parent = big;
  const star = geoMesh('cityTreeStar', octaGeo(0.95), basic(0xffffff), false, false); star.position.set(0, 15.2, 0); star.parent = big;
  for (let k = 0; k < 6; k++) {
    const a = k / 6 * Math.PI * 2 + 0.3, x = XMAS.x + Math.cos(a) * 13, z = XMAS.z + Math.sin(a) * 13;
    if (!freeAt(x, z, 2) || groundH(x, z) < 0.29) continue;
    const y = groundH(x, z), r = a - Math.PI / 2, VC = tileB('vc', x, z);              // a stall: its long side along the ring (into the buckets)
    boxB(VC, x, y, z, 3, 2, 2, COL.white, r); boxB(VC, x, y + 2.15, z, 3.4, 0.3, 2.6, COL.teal, r);
    for (let q = -1.5; q <= 1.51; q += 0.5) dotPositions.push([x + Math.cos(-a + Math.PI / 2) * q, y + 2.6, z - Math.sin(-a + Math.PI / 2) * q, 0.09]);
  }
}
