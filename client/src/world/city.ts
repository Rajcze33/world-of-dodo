// The city: the ground and the streets (pavements, lane dashes, zebra crossings, tram tracks), the trees and street lamps (props,
// world/props.ts), the Karlín perimeter blocks, the church, the tram shelter, the forest, the construction site with its crane, the
// DODO depot hall, the REDLINE hall, the plaza with the city tree, and at the end the merged buckets baked into meshes.
//
// Built in two steps, because the traffic (world/traffic.ts) sat between them in the original and draws from the city's random
// numbers (the parked cars). main.ts calls buildCity(), then buildTraffic(), then finishCity(). So the random numbers go out in the
// original's order and every client draws the same city, with the same forest: its trees are props, and the server knows the props
// by their index. (The original's traffic also added the tram's loops and second shelter to the buckets; traffic.ts bakes those itself.)
import { Vector3, Quaternion, TransformNode, type DynamicTexture, type StandardMaterial } from '@babylonjs/core';
import { scene } from '../core/engine';
import {
  BK, Bucket, tri, quad, ring, cap, offsetPoly, rectPoly, boxB, centroid, addGeo, mergeGeos, bake, geoMesh, box, Inst, Dummy, compose,
  applyMatrix, boxGeo, cylGeo, coneGeo, sphereGeo, planeGeo, circleGeo, octaGeo, translate, rotateX, rotateY, rotateZ,
  type P2, type P3, type Geo,
} from '../core/geo';
import { M, lambert, basic, VC_MAT, VC_GLOW } from '../core/mat';
import { canvasTex, poolTex, logoTex } from '../core/tex';
import { COL } from '../core/colors';
import { R } from '../core/util';
import { HALF, ROAD, roadC, blockC, RC, TRAM_K, DEPOT_B, PARK_B, PLAZA_B, RIVAL_B } from './grid';
import { registerProp, applyGroup } from './props';
import type { Prop } from '../game/types';

// World of DODO: the construction site's crane top, turned slowly by the main loop (null without the site)
export let CRANE_TOP: TransformNode | null = null;

// the facade textures (buildCity draws them, finishCity bakes the facades with them)
let facMap: DynamicTexture, facEm: DynamicTexture;
// the little green lights of the path motif (depot roof edge, the plaza's stalls): one instanced mesh at the end
const dotPositions: number[][] = [];
// scratch for the props' matrices (three's Object3D of the original)
const AXIS_Y = new Vector3(0, 1, 0), PQ1 = new Quaternion(), PQ2 = new Quaternion(), PAX = new Vector3(), PO = new Dummy();

// ---------- the first part: the original up to the traffic ----------
export function buildCity() {
  // ---------- ground, roads, blocks with rounded corners ----------
  const ground = geoMesh('ground', rotateX(planeGeo(2400, 2400), -Math.PI / 2), M.snow); ground.position.y = -0.05; ground.freezeWorldMatrix();
  geoMesh('roads', rotateX(planeGeo(2 * HALF + ROAD, 2 * HALF + ROAD), -Math.PI / 2), M.road).freezeWorldMatrix();
  pavements();
  // lane dashes (not on the tram avenue, not inside junctions)
  {
    const pts: [number, number, number][] = [];
    for (let k = 0; k <= 6; k++) {
      const c = roadC(k);
      for (let v = -HALF; v <= HALF; v += 6) {
        let near = false; for (let q = 0; q <= 6; q++) if (Math.abs(v - roadC(q)) < 16) near = true; if (near) continue;
        pts.push([c, v, 0]); if (k !== TRAM_K) pts.push([v, c, 1]);
      }
    }
    const im = new Inst('laneDashes', boxGeo(0.3, 0.04, 2.4), M.dash, pts.length, { receive: true }), o = new Dummy();
    pts.forEach((p, i) => { o.position.set(p[0], 0.03, p[1]); o.rotation.set(0, p[2] ? Math.PI / 2 : 0, 0); im.setMatrixAt(i, o.updateMatrix()); });
    im.update();
  }
  // zebra crossings at every junction approach
  for (let a = 0; a <= 6; a++) for (let b = 0; b <= 6; b++) {
    const cx = roadC(a), cz = roadC(b);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const px = cx + dx * 14.8, pz = cz + dz * 14.8; if (Math.abs(px) > HALF || Math.abs(pz) > HALF) continue;
      for (let s = -5; s <= 5.01; s += 2) {
        const x = dx ? px : cx + s, z = dz ? pz : cz + s, w = dx ? 3 : 0.9, d = dx ? 0.9 : 3, y = 0.035;
        quad(BK.road, [x - w / 2, y, z + d / 2], [x + w / 2, y, z + d / 2], [x + w / 2, y, z - d / 2], [x - w / 2, y, z - d / 2], COL.c20);
      }
    }
  }
  // tram tracks on the avenue (like Sokolovská in Karlín)
  {
    const z0 = roadC(TRAM_K);
    for (const zc of [-2.2, 2.2]) for (const o of [-0.72, 0.72]) {
      const z = z0 + zc + o, y = 0.04;
      quad(BK.road, [-149, y, z + 0.09], [149, y, z + 0.09], [149, y, z - 0.09], [-149, y, z - 0.09], COL.grey);
    }
  }

  // ---------- Karlín-style perimeter blocks ----------
  // facade tile: 8 bays (3 u) × 6 floors (3.5 u); tall windows; lit pattern in a separate emissive map
  const facLit: (string | null)[] = []; for (let i = 0; i < 48; i++) facLit.push(R() < 0.34 ? (R() < 0.55 ? '#b2dcd6' : '#eaebeb') : null);
  facMap = canvasTex(256, 224, (g, w, h) => {
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
    for (let y = 0; y < 6; y++) for (let x = 0; x < 8; x++) {
      const X = x * 32, Y = y * 37.33;
      g.fillStyle = '#e3e5e4'; g.fillRect(X + 8, Y + 29, 16, 3); g.fillStyle = '#3d4543'; g.fillRect(X + 10, Y + 7, 12, 22); g.fillStyle = '#d6d8d7'; g.fillRect(X + 15, Y + 7, 2, 22);
    }
  }, { repeat: true });
  facEm = canvasTex(256, 224, (g, w, h) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
    for (let y = 0; y < 6; y++) for (let x = 0; x < 8; x++) { const c = facLit[y * 8 + x]; if (!c) continue; g.fillStyle = c; g.fillRect(x * 32 + 10, y * 37.33 + 7, 12, 22); }
  }, { repeat: true });
  // the facades' u and v are world units (ring() below): one tile per 24 × 21 units, starting above the 4.3 high ground floor
  for (const t of [facMap, facEm]) { t.uScale = 1 / 24; t.vScale = 1 / 21; t.uOffset = 0; t.vOffset = -4.3 / 21; }

  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
    const k = i + ',' + j, bx = blockC(i), bz = blockC(j);
    if (k === DEPOT_B.join(',') || k === PLAZA_B.join(',')) continue;
    if (k === RIVAL_B.join(',')) { keepRandom(bx, bz); continue; }
    if (k === PARK_B.join(',')) { church(bx, bz); continue; }
    perimeterBlock(bx, bz);
  }

  lamps();

  // tram stop shelter by the square
  {
    const x = blockC(PLAZA_B[0]) - 6, z = blockC(PLAZA_B[1]) - 17.6;
    boxB(BK.trim, x, 0.3, z, 6, 0.15, 1.8, COL.charcoal); boxB(BK.trim, x, 2.9, z, 6.4, 0.18, 2, COL.charcoal, 0, COL.paper);
    boxB(BK.glow, x, 0.6, z - 0.8, 5.8, 2.2, 0.06, COL.light); boxB(BK.trim, x - 3.05, 0.3, z, 0.12, 2.6, 0.12, COL.charcoal); boxB(BK.trim, x + 3.05, 0.3, z, 0.12, 2.6, 0.12, COL.charcoal);
  }
}

// The pavements of the 36 blocks, 0.3 high: squares of half width 19 with rounded corners (radius RC). The original extruded
// three.js Shapes whose corners were quadratic curves (the control point on the square's corner) in 8 segments; here the same
// outline becomes walls and a top in the walk material (the bottom lies on the road and is never seen).
function pavements() {
  const bk = Bucket(), hw = 19, r = RC, SEG = 8;
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
    const x = blockC(i), z = blockC(j), P: P2[] = [];
    // a corner: from a (where the straight edge before it ends) along the curve around the control point c to e
    const corner = (a: P2, c: P2, e: P2) => {
      P.push(a);
      for (let s = 1; s <= SEG; s++) { const t = s / SEG, u = 1 - t; P.push([u * u * a[0] + 2 * u * t * c[0] + t * t * e[0], u * u * a[1] + 2 * u * t * c[1] + t * t * e[1]]); }
    };
    corner([x + hw - r, z - hw], [x + hw, z - hw], [x + hw, z - hw + r]);
    corner([x + hw, z + hw - r], [x + hw, z + hw], [x + hw - r, z + hw]);
    corner([x - hw + r, z + hw], [x - hw, z + hw], [x - hw, z + hw - r]);
    corner([x - hw, z - hw + r], [x - hw, z - hw], [x - hw + r, z - hw]);
    ring(bk, P, 0, P, 0.3, 0xffffff); cap(bk, P, 0.3, 0xffffff);   // white vertex colours: the material gives the grey
  }
  bake('pavements', bk, M.walk, false);
}

// ---------- trees ----------
// one tree as its own group: only the big tree on the plaza, which carries its lights and star (World of DODO; see tree below).
// The original's 7 meshes (trunk, 3 cones, 3 snow caps) are merged here into 3, one per material: the same shapes, fewer draw calls.
function treeGroup(x: number, z: number, s: number): TransformNode {
  const g = new TransformNode('cityTree', scene); g.position.set(x, 0, z);
  const cones: Geo[] = [], caps: Geo[] = [];
  for (let i = 0; i < 3; i++) {
    const r = (2.2 - i * 0.55) * s, h = (2.6 - i * 0.4) * s, y = (1.4 + i * 1.5) * s;
    cones.push(translate(coneGeo(r, h, 8), 0, y + h / 2, 0)); caps.push(translate(coneGeo(r * 0.55, h * 0.4, 8), 0, y + h * 0.8, 0));
  }
  geoMesh('cityTreeTrunk', translate(cylGeo(0.25 * s, 0.3 * s, 1.2 * s, 6), 0, 0.6 * s, 0), M.trunk, true, false).parent = g;
  geoMesh('cityTreeCones', mergeGeos(cones), M.tree, true, false).parent = g;
  geoMesh('cityTreeSnow', mergeGeos(caps), M.snow, false, false).parent = g;
  registerProp({ kind: 'tree', g, x, z, r: 0.4 * s + 0.3, breakV: 2 + 3 * s, minMass: 6, slow: 0.82, th0: 1.5, acc: 2.4, w0: 0.5, lift: 1.7 * s, y0: 0, q0: Quaternion.Identity(), apply: applyGroup });
  return g;
}
// World of DODO: every other tree is one instance in three instanced meshes (trunks, green cones, snow caps): 3 draw calls for all
// of them. As groups, the 152 trees were 1064 meshes, over half of the scene, and the main reason the game stuttered. The parts are
// built at scale 1 with their offsets baked in, so the three parts of a tree share one matrix: base at (x,0,z), scale s, tilt when it
// is knocked down (the same motion applyGroup gives a group).
const TREE_MAX = 220; let TREE_IM: Inst[] | null = null;
function treeMeshes(): Inst[] {
  const cones: Geo[] = [], caps: Geo[] = [];
  for (let i = 0; i < 3; i++) {
    const r = 2.2 - i * 0.55, h = 2.6 - i * 0.4, y = 1.4 + i * 1.5;
    cones.push(translate(coneGeo(r, h, 8), 0, y + h / 2, 0)); caps.push(translate(coneGeo(r * 0.55, h * 0.4, 8), 0, y + h * 0.8, 0));
  }
  const mk = (name: string, geo: Geo, mat: StandardMaterial, cast: boolean) => { const m = new Inst(name, geo, mat.clone(name), TREE_MAX, { cast, receive: false }); m.count = 0; return m; };
  return [mk('treeTrunks', translate(cylGeo(0.25, 0.3, 1.2, 6), 0, 0.6, 0), M.trunk, true), mk('treeCones', mergeGeos(cones), M.tree, true), mk('treeCaps', mergeGeos(caps), M.snow, false)];
}
function applyTree(p: Prop) {
  if (p.th > 0) { PAX.set(p.fz, 0, -p.fx); Quaternion.RotationAxisToRef(PAX, p.th, PO.quaternion); } else PO.quaternion.copyFromFloats(0, 0, 0, 1);
  PO.position.set(p.x, p.y0 + p.lift * Math.sin(p.th), p.z); PO.scale.setAll(p.s); PO.updateMatrix();
  for (const m of TREE_IM!) { m.setMatrixAt(p.idx, PO.matrix); m.update(); }
}
// (the original's tree() and treeGroup() also took a number of lights to hang on the tree; every call passed 0, so it is gone)
function tree(x: number, z: number, s: number) {
  if (!TREE_IM) TREE_IM = treeMeshes();
  if (TREE_IM[0].count >= TREE_MAX) return;
  const idx = TREE_IM[0].count; for (const m of TREE_IM) m.count = idx + 1;
  const p = registerProp({ kind: 'tree', idx, s, x, z, r: 0.4 * s + 0.3, breakV: 2 + 3 * s, minMass: 6, slow: 0.82, th0: 1.5, acc: 2.4, w0: 0.5, lift: 1.7 * s, y0: 0, apply: applyTree });
  applyTree(p);
}

// ---------- Karlín-style perimeter blocks ----------
const FACADE_COLS = [COL.white, COL.white, COL.paper, COL.lgrey, COL.c20, COL.light, COL.grey];
function house(P: P2[], floors: number, col: number) {
  const h = 4.3 + floors * 3.5, u0 = R() * 24;
  ring(BK.fac, P, 0.3, P, h, col, u0);                                                                   // facade with windows
  const pl = offsetPoly(P, 0.14); ring(BK.trim, pl, 0.3, pl, 4.3, COL.c60); cap(BK.trim, pl, 4.3, COL.c60);   // ground-floor plinth
  const co = offsetPoly(P, 0.38); ring(BK.trim, co, h - 0.55, co, h, COL.white); cap(BK.trim, co, h, COL.white); // cornice
  const mb = offsetPoly(P, -0.15), mt = offsetPoly(P, -1.7); ring(BK.trim, mb, h, mt, h + 2.5, COL.charcoal); cap(BK.roof, mt, h + 2.5, COL.paper); // mansard + snowy top
  // chimneys (the loop's bound draws a new random number on every pass, as in the original: keep it, the city depends on it)
  const c = centroid(P); for (let k = 0; k < 1 + (R() * 2 | 0); k++) boxB(BK.trim, c[0] + (R() - 0.5) * 3, h + 2.2, c[1] + (R() - 0.5) * 3, 0.8, 1.6, 0.8, COL.charcoal, 0, COL.paper);
}
// build a block into throw-away buckets: nothing is drawn, but the random numbers are used up exactly as before (the rest of the city stays the same)
function keepRandom(bx: number, bz: number) {
  const keys = Object.keys(BK) as (keyof typeof BK)[], keep = { ...BK };
  for (const k of keys) BK[k] = Bucket();
  perimeterBlock(bx, bz);
  for (const k of keys) BK[k] = keep[k];
}
function perimeterBlock(bx: number, bz: number) {
  const F = 16, ch = 4.5;
  const fl = () => 3 + (R() * 3 | 0), col = () => FACADE_COLS[(R() * FACADE_COLS.length) | 0];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {                                                // chamfered corner houses (zkosená nároží)
    house([[bx + sx * 6, bz + sz * F], [bx + sx * (F - ch), bz + sz * F], [bx + sx * F, bz + sz * (F - ch)], [bx + sx * F, bz + sz * 6], [bx + sx * 6, bz + sz * 6]], fl(), col());
  }
  for (const sz of [-1, 1]) {                                                                          // north / south middle houses
    const cut = R() < 0.6;
    if (cut) { house(rectPoly(bx - 3, bz + sz * 11.5, 6, 9), fl(), col()); house(rectPoly(bx + 3, bz + sz * 11.5, 6, 9), fl(), col()); }
    else house(rectPoly(bx, bz + sz * 11.5, 12, 9), fl(), col());
  }
  for (const sx of [-1, 1]) house(rectPoly(bx + sx * 11.5, bz, 9, 12), fl(), col());                   // east / west middle houses
}
// church square (Karlínské náměstí stand-in): twin-tower basilica
// The roof slopes, the gables and the spires are wound to face outwards here (the original's faced inwards: three.js lit the back
// of a double-sided surface with the flipped normal, Babylon lights it with the normal as it is, so the roof would come out dark).
function church(bx: number, bz: number) {
  const W = COL.white, G = COL.lgrey, C = COL.charcoal, S = COL.paper;
  boxB(BK.trim, bx, 0.3, bz - 2, 10, 10, 20, W, 0, S);
  // gable roof over the nave
  const y0 = 10.3, y1 = 15, x0 = bx - 5.2, x1 = bx + 5.2, zf = bz + 8, zb = bz - 12;
  quad(BK.roof, [x0, y0, zf], [bx, y1, zf], [bx, y1, zb], [x0, y0, zb], S); quad(BK.roof, [x1, y0, zb], [bx, y1, zb], [bx, y1, zf], [x1, y0, zf], S);
  tri(BK.trim, [x0, y0, zf], [x1, y0, zf], [bx, y1, zf], W); tri(BK.trim, [x1, y0, zb], [x0, y0, zb], [bx, y1, zb], W);
  for (const sx of [-1, 1]) {
    const tx = bx + sx * 5.6, tz = bz + 9.5;
    boxB(BK.trim, tx, 0.3, tz, 4, 24, 4, G, 0, G); boxB(BK.trim, tx, 24.3, tz, 4.6, 0.6, 4.6, W, 0, W);
    const t: P3 = [tx, 31, tz], c4: P3[] = [[tx - 2, 24.9, tz - 2], [tx + 2, 24.9, tz - 2], [tx + 2, 24.9, tz + 2], [tx - 2, 24.9, tz + 2]];
    for (let k = 0; k < 4; k++) tri(BK.trim, c4[k], t, c4[(k + 1) % 4], C);
    for (let y = 8; y < 22; y += 5) quad(BK.glow, [tx - 0.5, y, tz + 2.02], [tx + 0.5, y, tz + 2.02], [tx + 0.5, y + 2.4, tz + 2.02], [tx - 0.5, y + 2.4, tz + 2.02], COL.light);
  }
  // rose window + nave windows
  const rz = bz + 8.03;
  for (let k = 0; k < 16; k++) { const a = k / 16 * Math.PI * 2, b = (k + 1) / 16 * Math.PI * 2; tri(BK.glow, [bx, 7.4, rz], [bx + Math.cos(a) * 1.4, 7.4 + Math.sin(a) * 1.4, rz], [bx + Math.cos(b) * 1.4, 7.4 + Math.sin(b) * 1.4, rz], COL.light); }
  for (let z = -9; z <= 5; z += 3.5) for (const sx of [-1, 1]) { const x = bx + sx * 5.02; quad(BK.glow, [x, 4, z + bz], [x, 4, z + bz + 1], [x, 8, z + bz + 1], [x, 8, z + bz], COL.light); }
  quad(BK.trim, [bx - 1.4, 0.3, bz + 8.04], [bx + 1.4, 0.3, bz + 8.04], [bx + 1.4, 4.6, bz + 8.04], [bx - 1.4, 4.6, bz + 8.04], COL.charcoal);
  boxB(BK.trim, bx, 0.3, bz + 9.6, 6, 0.3, 2.4, COL.c20); boxB(BK.trim, bx, 0.6, bz + 9.1, 4.6, 0.3, 1.4, COL.c20);
  for (const [dx, dz] of [[-13, -13], [13, -13], [-13, 13], [13, 13]]) tree(bx + dx, bz + dz, 0.8);
}

// street lamps on the pavement (one per block side, mid-block): instanced, so each one can be knocked over (they are props)
function lamps() {
  const specs: { x: number; z: number; phi: number }[] = [];
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
    const bx = blockC(i), bz = blockC(j);
    for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { if (i === PARK_B[0] && j === PARK_B[1] && nz === 1) continue; specs.push({ x: bx + nx * 18.1, z: bz + nz * 18.1, phi: Math.atan2(-nz, nx) }); }
  }
  const n = specs.length;
  // shared lamp in local coordinates: base at the origin (pavement), arm and head towards local +x (= over the street), light pool on the road
  const poleG = Bucket(); boxB(poleG, 0, 0, 0, 0.22, 6.6, 0.22, COL.charcoal); boxB(poleG, 0.6, 6.3, 0, 1.4, 0.16, 0.2, COL.charcoal);
  const headG = Bucket(); boxB(headG, 0.9, 5.95, 0, 0.55, 0.35, 0.55, 0xffffff);
  const poolG = translate(rotateX(planeGeo(16, 16), -Math.PI / 2), 2.5, -0.24, 0);
  const LPOLE = new Inst('lampPoles', poleG, lambert(0xffffff, { double: true }), n, { cast: true, receive: false }),
    LHEAD = new Inst('lampHeads', headG, basic(0xffffff, { double: true }), n, { receive: false }),
    LPOOL = new Inst('lampPools', poolG, basic(COL.light, { map: poolTex, transparent: true, opacity: 0.2, depthWrite: false, additive: true, double: true }), n, { receive: false });
  const applyLamp = (p: Prop) => {
    Quaternion.RotationAxisToRef(AXIS_Y, p.phi, PQ1);
    if (p.th > 0) { PAX.set(p.fz, 0, -p.fx); Quaternion.RotationAxisToRef(PAX, p.th, PQ2); PQ2.multiplyToRef(PQ1, PQ1); }   // three's PQ1.premultiply(PQ2)
    PO.position.set(p.x, p.y0 + p.lift * Math.sin(p.th), p.z); PO.quaternion.copyFrom(PQ1); PO.scale.set(1, 1, 1); PO.updateMatrix();
    LPOLE.setMatrixAt(p.idx, PO.matrix); LHEAD.setMatrixAt(p.idx, PO.matrix);
    if (p.th > 0) PO.scale.set(0, 0, 0); PO.updateMatrix(); LPOOL.setMatrixAt(p.idx, PO.matrix);         // a fallen lamp has no light pool
    LPOLE.update(); LHEAD.update(); LPOOL.update();
  };
  specs.forEach((sp, idx) => {
    const p = registerProp({ kind: 'lamp', x: sp.x, z: sp.z, phi: sp.phi, idx, r: 0.45, breakV: 3.5, minMass: 0, slow: 0.95, th0: 1.5, acc: 4.5, w0: 1.0, lift: 0.12, y0: 0.3, apply: applyLamp });
    applyLamp(p);
  });
}

// ---------- the second part: the original after the traffic, up to baking the buckets ----------
export function finishCity() {
  const SITE_A = window.WOD_SITE ? window.WOD_SITE.area : null;   // World of DODO: the construction site's ground (client/shared/site.js)
  // forest around the city — only outside the outer ring road
  for (let t = 0; t < 220; t++) {
    const x = (R() - 0.5) * 620, z = (R() - 0.5) * 620; if (Math.max(Math.abs(x), Math.abs(z)) < 180) continue; const sc = 1 + R() * 1.4; if (Math.abs(z) < 26 && Math.abs(x) < 215) continue;
    if (SITE_A && x > SITE_A.x0 - 12 && x < SITE_A.x1 + 12 && z > SITE_A.z0 - 10 && z < SITE_A.z1 + 12) continue; tree(x, z, sc);   // World of DODO: the construction site
  }
  site();
  depotHall();
  redlineHall();
  plaza();
  // path-motif light dots (instanced)
  {
    const im = new Inst('lightDots', sphereGeo(1, 8, 6), M.dot, dotPositions.length, { receive: false }), o = new Dummy();
    dotPositions.forEach((p, i) => { o.position.set(p[0], p[1], p[2]); o.scale.setAll(p[3]); im.setMatrixAt(i, o.updateMatrix()); });
    im.update();
  }
  // ---------- finalize merged meshes ----------
  bake('facades', BK.fac, lambert(0xffffff, { map: facMap, emissive: 0xffffff, emissiveMap: facEm, emissiveIntensity: 0.85 }), true);
  bake('trim', BK.trim, lambert(0xffffff, { double: true }), true);
  bake('roofs', BK.roof, lambert(0xffffff, { double: true }), false);
  bake('glow', BK.glow, basic(0xffffff, { double: true }), false);
  bake('roadMarks', BK.road, lambert(0xffffff), false);
  bake('carBucket', BK.car, lambert(0xffffff, { double: true }), true);   // nothing goes into it any more (null), kept as in the original
  bake('pools', BK.pool, basic(COL.light, { map: poolTex, transparent: true, opacity: 0.2, depthWrite: false, additive: true, double: true }), false);
}

// ---------- World of DODO: the construction site on the snow south of the city ----------
// The layout (and its solids, which the server shares) is client/shared/site.js. Everything that stands still goes into the merged
// buckets (no extra draw calls); only the crane's top turns, as its own two meshes (CRANE_TOP, turned in the main loop).
const BQ = new Quaternion(), BV = new Vector3(), BZ = new Vector3(0, 0, 1), BP = new Vector3(), B1 = new Vector3(1, 1, 1), BM = new Float32Array(16);
// a square beam of thickness t from one point to another
function beam(bk: Bucket, x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, t: number, col: number) {
  BV.set(x2 - x1, y2 - y1, z2 - z1); const L = BV.length(); Quaternion.FromUnitVectorsToRef(BZ, BV.normalize(), BQ, 1e-6);   // three's epsilon
  compose(BP.set((x1 + x2) / 2, (y1 + y2) / 2, (z1 + z2) / 2), BQ, B1, BM); addGeo(bk, applyMatrix(boxGeo(t, t, L), BM), null, col);
}
const shade = (c: number, k: number) => (Math.min(255, ((c >> 16) & 255) * k) << 16) | (Math.min(255, ((c >> 8) & 255) * k) << 8) | Math.min(255, (c & 255) * k);
function site() {
  const S = window.WOD_SITE; if (!S) return;
  const A = S.area, trim = BK.trim, glow = BK.glow;
  // dirt instead of snow (vertices in this order face up), and darker tracks from the three gates
  const dirt = (x0: number, z0: number, x1: number, z1: number, col: number) => quad(BK.road, [x0, 0.03, z0], [x0, 0.03, z1], [x1, 0.03, z1], [x1, 0.03, z0], col);
  dirt(A.x0 - 3, A.z0 - 3, A.x1 + 3, A.z1 + 3, 0x6e5c48);
  for (const gx of [-104, 0, 104]) dirt(gx - 4, A.z0 - 11, gx + 4, A.z0 + 24, 0x5a4a3a);
  for (const b of S.solids) {
    const w = b.x1 - b.x0, d = b.z1 - b.z0, cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2, c = b.color ?? 0, along = w >= d;
    if (b.kind === 'fence') {                                                                          // green mesh panels between white posts
      boxB(trim, cx, 0, cz, w, b.h, d, c); const L = along ? w : d;
      for (let s = 0; s <= L; s += 3) boxB(trim, along ? b.x0 + s : cx, 0, along ? cz : b.z0 + s, 0.14, b.h + 0.15, 0.14, 0xd6d8d7);
    } else if (b.kind === 'wall' || b.kind === 'column') {                                              // concrete, rebar sticking out of the top
      boxB(trim, cx, 0, cz, w, b.h, d, c, 0, shade(c, 1.08));
      const L = Math.max(w, d); for (let s = 0.4; s < L; s += 1.2) boxB(trim, along ? b.x0 + s : cx, b.h, along ? cz : b.z0 + s, 0.06, 0.9, 0.06, 0x5a3a2a);
    } else if (b.kind === 'container' || b.kind === 'office') {
      const lev = b.h > 3 ? 2 : 1, lh = b.h / lev;
      for (let k = 0; k < lev; k++) {
        const col = k ? shade(c, 0.88) : c; boxB(trim, cx, k * lh, cz, w, lh - 0.04, d, col, 0, shade(col, 1.1));
        if (b.kind === 'container') for (const e of [-1, 1]) boxB(trim, along ? cx + e * (w / 2 - 0.06) : cx, k * lh, along ? cz : cz + e * (d / 2 - 0.06), along ? 0.14 : w + 0.06, lh - 0.04, along ? d + 0.06 : 0.14, shade(col, 0.7));   // door ends
        else boxB(glow, cx, k * lh + 1.1, b.z0 - 0.03, w - 1, 0.7, 0.04, 0xb2dcd6);                     // lit cabin windows towards the city
      }
    } else if (b.kind === 'toilet') {
      boxB(trim, cx, 0, cz, w, b.h, d, c, 0, 0xeaebeb);
    } else if (b.kind === 'pile') {                                                                    // a sand pile: its radius and height are in the layout
      const r = b.r as number, ph = b.ph as number;
      addGeo(trim, translate(coneGeo(r, ph, 12), cx, ph / 2, cz), null, c);
      addGeo(trim, translate(coneGeo(r * 0.6, ph * 0.6, 10), cx + r * 0.7, ph * 0.3, cz - r * 0.3), null, shade(c, 0.9));
    } else if (b.kind === 'pipes') {
      for (const [py, pz] of [[0.85, -0.95], [0.85, 0.95], [2.3, 0]]) {
        addGeo(trim, translate(rotateZ(cylGeo(0.85, 0.85, w, 14), Math.PI / 2), cx, py, cz + pz), null, c);
        for (const e of [-1, 1]) addGeo(trim, translate(rotateY(circleGeo(0.55, 14), e * Math.PI / 2), cx + e * (w / 2 + 0.01), py, cz + pz), null, 0x3d4543);
      }
    } else if (b.kind === 'barrier') {                                                                 // jersey barrier: wide foot, narrow top
      boxB(trim, cx, 0, cz, w, 0.45, d, c); boxB(trim, cx, 0.45, cz, along ? w : d * 0.5, 0.95, along ? d * 0.5 : d, c, 0, shade(c, 1.05));
      boxB(trim, cx, 1.12, cz, along ? w + 0.02 : d * 0.5 + 0.02, 0.14, along ? d * 0.5 + 0.02 : d + 0.02, 0xc0524a);
    } else if (b.kind === 'pallet') {
      boxB(trim, cx, 0, cz, w, 0.15, d, 0x8a6a44); boxB(trim, cx, 0.15, cz, w - 0.2, b.h - 0.15, d - 0.2, c);
    } else if (b.kind === 'excavator') {                                                               // tracks, body, cab, the arm reaching for the sand
      for (const s of [-1, 1]) boxB(trim, cx + s * 1.2, 0, cz, 0.8, 0.9, d, 0x2b2b2b);
      boxB(trim, cx, 0.9, cz, 2.8, 1.2, 3, c); boxB(trim, cx + 0.6, 2.1, cz - 0.4, 1.3, 1.3, 1.4, c); boxB(glow, cx + 0.6, 2.5, cz - 1.12, 1.1, 0.7, 0.04, 0x9fd3ff);
      beam(trim, cx - 0.6, 2.3, cz + 1.2, cx - 3.8, 5.4, cz + 4.6, 0.5, c); beam(trim, cx - 3.8, 5.4, cz + 4.6, cx - 6, 2.2, cz + 7, 0.4, c);
      addGeo(trim, translate(boxGeo(1.2, 0.8, 1), cx - 6.1, 1.8, cz + 7.1), null, 0x3d4543);
    } else if (b.kind === 'dozer') {
      for (const s of [-1, 1]) boxB(trim, cx + s * 1.1, 0, cz, 0.8, 0.9, d - 0.6, 0x2b2b2b);
      boxB(trim, cx, 0.9, cz + 0.3, 2.4, 1, 3, c); boxB(trim, cx, 1.9, cz + 0.8, 1.4, 0.9, 1.4, c); boxB(glow, cx, 2.2, cz + 0.08, 1.2, 0.5, 0.04, 0x9fd3ff);
      boxB(trim, cx, 0.1, b.z0 + 0.1, w + 0.6, 1.2, 0.3, shade(c, 0.85));
    } else if (b.kind === 'mast') {                                                                    // floodlights facing into the site
      boxB(trim, cx, 0, cz, w, b.h, d, c); const ix = -Math.sign(cx), iz = -Math.sign(cz - (A.z0 + A.z1) / 2);
      boxB(trim, cx, b.h, cz, 1.8, 0.2, 0.3, c); for (const s of [-0.6, 0.6]) boxB(glow, cx + s, b.h + 0.2, cz, 0.5, 0.4, 0.5, 0xffffff);
      const px = cx + ix * 12, pz = cz + iz * 12; quad(BK.pool, [px - 12, 0.06, pz - 12], [px + 12, 0.06, pz - 12], [px + 12, 0.06, pz + 12], [px - 12, 0.06, pz + 12], 0xffffff, [[0, 0], [1, 0], [1, 1], [0, 1]]);
    } else if (b.kind === 'crane') boxB(trim, cx, 0, cz, w, 1.5, d, c);                                 // its base block; the mast is drawn below
  }
  // the tower crane: a lattice mast, and on top the part that turns (jib, counter-jib with its weights, cab, trolley, hook and load)
  const cr = S.crane as { x: number; z: number; h: number; jib: number; back: number; color: number }, mw = 1.1, Y = cr.color;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) beam(trim, cr.x + sx * mw, 1.5, cr.z + sz * mw, cr.x + sx * mw, cr.h, cr.z + sz * mw, 0.24, Y);
  for (let y = 1.5; y < cr.h - 0.5; y += 3) {
    const y2 = y + 3;
    for (const s of [-1, 1]) {
      beam(trim, cr.x - mw, y, cr.z + s * mw, cr.x + mw, y, cr.z + s * mw, 0.12, Y); beam(trim, cr.x + s * mw, y, cr.z - mw, cr.x + s * mw, y, cr.z + mw, 0.12, Y);
      beam(trim, cr.x - mw, y, cr.z + s * mw, cr.x + mw, y2, cr.z + s * mw, 0.09, Y); beam(trim, cr.x + s * mw, y, cr.z - mw, cr.x + s * mw, y2, cr.z + mw, 0.09, Y);
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
  const g = new TransformNode('craneTop', scene); g.position.set(cr.x, cr.h, cr.z);
  geoMesh('craneTopBody', top, VC_MAT, true, false).parent = g; geoMesh('craneTopLights', lit, VC_GLOW, false, false).parent = g;
  CRANE_TOP = g;
}

// depot (the single-player game's parking marker in front of it is gone)
function depotHall() {
  const bx = blockC(0), bz = blockC(0);
  box(22, 10, 32, M.charcoal, bx - 6, 5.3, bz).name = 'depotHall';
  box(22.2, 1.2, 32.2, lambert(COL.teal), bx - 6, 9.6, bz).name = 'depotEaves';
  box(22, 0.3, 32, M.roof, bx - 6, 10.4, bz, false).name = 'depotRoof';
  const lg = geoMesh('depotLogo', rotateY(planeGeo(13, 4.37), Math.PI / 2), basic(0xffffff, { map: logoTex, transparent: true }), false, false); lg.position.set(bx + 5.06, 6.6, bz);
  for (const z of [-10, -3.5, 3]) { const dock = geoMesh('depotDock', rotateY(planeGeo(5, 3.6), Math.PI / 2), M.walk, false, false); dock.position.set(bx + 5.05, 2.1, bz + z + 10); }
  for (let a = -15; a <= 15.01; a += 1) dotPositions.push([bx + 5.3, 10.9, bz + a, 0.16]);
}

// REDLINE depot: red hall in the south-east corner, mirror image of the DODO depot (its sign, without the rival tanks)
function redlineHall() {
  const signTex = canvasTex(1024, 320, (g, w, h) => {
    g.clearRect(0, 0, w, h); g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = '700 190px Poppins, system-ui, sans-serif'; g.fillText('REDLINE', w / 2, h * 0.45); g.font = '600 60px "IBM Plex Mono", monospace'; g.fillText('E X P R E S S', w / 2, h * 0.86);
  }, { alpha: true });
  const bx = blockC(RIVAL_B[0]), bz = blockC(RIVAL_B[1]);
  const red = lambert(0xb3201f), dark = lambert(0x6e1212);
  box(22, 10, 32, red, bx + 6, 5.3, bz).name = 'redlineHall';
  box(22.2, 1.2, 32.2, dark, bx + 6, 9.6, bz).name = 'redlineEaves';
  box(22, 0.3, 32, M.roof, bx + 6, 10.4, bz, false).name = 'redlineRoof';
  const sg = geoMesh('redlineSign', rotateY(planeGeo(13, 4.1), -Math.PI / 2), basic(0xffffff, { map: signTex, transparent: true }), false, false); sg.position.set(bx - 5.06, 6.6, bz);
  for (const z of [-10, -3.5, 3]) { const dock = geoMesh('redlineDock', rotateY(planeGeo(5, 3.6), -Math.PI / 2), dark, false, false); dock.position.set(bx - 5.05, 2.1, bz + z + 10); }
  const neon = geoMesh('redlineNeon', boxGeo(0.2, 0.35, 30), basic(0xff3b30), false, false); neon.position.set(bx - 5.3, 10.9, bz);
  const pool = geoMesh('redlinePool', rotateX(planeGeo(26, 26), -Math.PI / 2), basic(0xff4a3a, { map: poolTex, transparent: true, opacity: 0.35, depthWrite: false, additive: true }), false, false);
  pool.position.set(bx - 14, 0.34, bz);
}

// plaza with the city tree
function plaza() {
  const bx = blockC(PLAZA_B[0]), bz = blockC(PLAZA_B[1]);
  const disc = geoMesh('plaza', cylGeo(12, 12, 0.2, 48), M.snow); disc.position.set(bx, 0.4, bz);
  const big = treeGroup(bx, bz, 2.7);                  // a prop: its lights and star are children, so they fall with it
  {
    const sc = 2.7, n = 140, top = 6.2 * sc, im = new Inst('cityTreeLights', sphereGeo(1, 8, 6), M.dot, n, { receive: false }), o = new Dummy();
    for (let i = 0; i < n; i++) {
      const t = i / n, a = t * Math.PI * 10, y = 1.6 * sc + t * (top - 1.8 * sc), rr = (2.3 * sc) * (1 - t * 0.82) + 0.15;
      o.position.set(Math.cos(a) * rr, y, Math.sin(a) * rr); o.scale.setAll(0.13 * sc); im.setMatrixAt(i, o.updateMatrix());
    }
    im.update(); im.mesh.parent = big;
  }
  const star = geoMesh('cityTreeStar', octaGeo(1.1), basic(0xffffff), false, false); star.position.set(0, 18.6, 0); star.parent = big;
  for (let k = 0; k < 6; k++) {
    const a = k / 6 * Math.PI * 2 + 0.3, x = bx + Math.cos(a) * 15.5, z = bz + Math.sin(a) * 15.5;
    const st = new TransformNode('stall', scene); st.position.set(x, 0.3, z); st.rotation.y = -a + Math.PI / 2;
    box(3, 2, 2, M.white, 0, 1, 0).parent = st; box(3.4, 0.3, 2.6, M.awning, 0, 2.3, 0).parent = st;
    for (let q = -1.5; q <= 1.51; q += 0.5) dotPositions.push([x + Math.cos(-a + Math.PI / 2) * q, 2.7, z - Math.sin(-a + Math.PI / 2) * q, 0.09]);
  }
  for (let t = 0; t < 6; t++) { const a = t / 6 * Math.PI * 2; tree(bx + Math.cos(a) * 9, bz + Math.sin(a) * 9, 0.55); }
}
