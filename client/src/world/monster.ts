// ---------- World of DODO, issue #26: Velemlok, the model, its animation and its effects ----------
// Velemlok is our own monster: a colossal, ancient river salamander (Czech velemlok, the giant salamander; a nod to Karel Čapek's
// Válka s mloky), drawn in the game's low-poly style: a broad flat head with small beady eyes on top and a wide mouth, three feathery
// external gill stalks either side behind the head that glow a pale cyan in the night, a long body flattened top to bottom with a
// wrinkled skin fold along each flank, warty dark olive-brown skin mottled lighter over a paler belly, four short splayed legs with
// stubby toes, and a long tail flattened side to side into a paddle. It lies in the water (its back MON_BACK over the surface) and
// only ever lifts its front half; no plates on its back, nothing that glows out of its mouth: it spits water.
//
// How it is drawn (one skinned mesh and a few rigid parts; nothing is rebuilt per frame):
// - the body from the neck to the tail's tip is one mesh skinned to a chain of 8 bones along the spine (Babylon's skeleton, each bone
//   driven by a transform node): the hips (the root), the front half, which turns up round the hips when it rears exactly as the
//   hitbox's spheres do (client/shared/monster.ts monSpheres: the player aims at what he sees), the chest, the neck, and four bones
//   down the tail. A vertex follows the two bones whose parts' middles are nearest to it along the spine, so the body bends smoothly;
// - the head (the skull, the jaw on its hinge, the eyes' glints, the gills on a node either side) rides the neck's node, the legs the
//   chest's and the hips' nodes;
// - every frame (drawMonster, from game/monster.ts): where it is (snap.g), a swimming wave down the spine (quicker the faster it
//   swims), how far it rears up (rear), the tail raised for a slam and brought down the moment it lands, the jaw open for a jet, the
//   gills flaring when it rears, a flinch when something hits it; killed, it rolls over belly up and sinks.
// Its effects: the wake and the bow wave while it swims (world/water.ts), spray and foam when it surfaces, dives or rolls over, a big
// final splash; its attacks (game/monster.ts hands each over as the mon message announced it): the slam's ring of water, the jet's
// arc of water, the geyser's warning ring and its column; the sparks of a hit. The spray is a pool of soft sprites of its own (the
// columns of world/water.ts stand on the river only, and a jet may land on an embankment).
import { TransformNode, Mesh, VertexData, Skeleton, Bone, Matrix, Vector3, Quaternion, StandardMaterial, Color3 } from '@babylonjs/core';
import { scene, camera, addCaster } from '../core/engine';
import { Bucket, Inst, Dummy, addGeo, cylGeo, planeGeo, ringGeo, rotateX, scaleGeo, sphereGeo, translate, geoMesh, tri, type Geo, type P3 } from '../core/geo';
import { VC_GLOW, basic } from '../core/mat';
import { c3 } from '../core/colors';
import { canvasTex } from '../core/tex';
import { WATER_Y, surfaceY } from '../../shared/naval.ts';
import { MON_REAR_A, MON_DEEP, MON_GEY_TOP, MON_SLAM_WARN, MON_JET_G, monJetAt, type MonAtk } from '../../shared/monster.ts';
import { splash, wake } from './water';
import { glow, puff } from '../game/shells';
import { fx } from '../game/fx';
import { hash01 } from './poly';

// ---------- the colours ----------
const DARK = 0x3a3220, BASE = 0x564b31, LIGHT = 0x82754f, SPOT = 0x9c8b5e, FOLD = 0x625836, BELLY = 0xa29679, BELLY2 = 0x8a7f62;
const MOUTH = 0x5e2c2b, LIP = 0x6d6646, LEG = 0x433e29, TOE = 0x8a8261, EYE = 0x0b0d0b;
const STALK = 0x3fa49a, FROND = 0x9ef3e9, FROND2 = 0x6fded3, GLINT = 0xe9f2cf;

// ---------- the spine: the bones ----------
// Model space: the waterline is y 0, the spine runs along z (the snout at +26, the tail's tip at -34.5, as the hitbox's spheres),
// (0, 0) is the pose's point, the middle of the body (client/shared/monster.ts). Every joint lies JY under the waterline, the height
// of the hips' sphere the front half turns round, so that rearing turns the model as it turns the hitbox.
const JY = -2.5;
// a bone: its parent, its joint along the spine, and the middle of the part of the body it carries (the skin's weights)
const BONES: { n: string; p: number; z: number; mid: number }[] = [
  { n: 'hips', p: -1, z: -7, mid: -10.5 },   // 0: the root, it stays
  { n: 'front', p: 0, z: -7, mid: -2 },      // 1: the front half, turned up round the hips when it rears
  { n: 'chest', p: 1, z: 3, mid: 7.5 },      // 2
  { n: 'neck', p: 2, z: 12, mid: 14 },       // 3: carries the head
  { n: 'tail0', p: 0, z: -14, mid: -17 },    // 4: the tail, base to tip
  { n: 'tail1', p: 4, z: -20, mid: -23 },
  { n: 'tail2', p: 5, z: -26, mid: -28.5 },
  { n: 'tail3', p: 6, z: -31, mid: -32.5 },
];
const B_HIPS = 0, B_FRONT = 1, B_CHEST = 2, B_NECK = 3, B_TAIL = 4;
// the parts' middles in order along the spine, for the weights
const MIDS = BONES.map((b, i) => [b.mid, i]).sort((a, b) => a[0] - b[0]);
// the two bones a point at z along the spine follows, and how much: [i, j, wi, wj]
function weights(z: number): [number, number, number, number] {
  if (z <= MIDS[0][0]) return [MIDS[0][1], 0, 1, 0];
  for (let k = 0; k + 1 < MIDS.length; k++) {
    const a = MIDS[k], b = MIDS[k + 1];
    if (z <= b[0]) { const t = (z - a[0]) / (b[0] - a[0]); return [a[1], b[1], 1 - t, t]; }
  }
  return [MIDS[MIDS.length - 1][1], 0, 1, 0];
}

// ---------- noise for the mottling and the warts ----------
const smooth = (t: number) => t * t * (3 - 2 * t);
function vnoise(x: number, y: number, s: number): number {
  const i = Math.floor(x), j = Math.floor(y), u = smooth(x - i), v = smooth(y - j);
  const h = (a: number, b: number) => hash01(a * 7919 + s, b * 104729 + s * 31);
  return (h(i, j) * (1 - u) + h(i + 1, j) * u) * (1 - v) + (h(i, j + 1) * (1 - u) + h(i + 1, j + 1) * u) * v;
}
const mix = (a: number, b: number, t: number) => {
  const k = t < 0 ? 0 : t > 1 ? 1 : t, f = (s: number) => Math.round(((a >> s) & 255) * (1 - k) + ((b >> s) & 255) * k);
  return (f(16) << 16) | (f(8) << 8) | f(0);
};

// ---------- the body's shape ----------
// stations along the spine: z, half width, top and bottom (over the waterline). Flat and broad in the body, a paddle in the tail.
const BODY: [number, number, number, number][] = [
  [-34.4, 0.25, 0.9, -0.7], [-32.6, 0.6, 2.2, -1.7], [-30, 0.95, 3.0, -2.5], [-27, 1.3, 3.5, -3.0], [-24, 1.75, 3.8, -3.3],
  [-21, 2.3, 4.0, -3.45], [-18, 3.1, 4.2, -3.55], [-15.5, 4.2, 4.5, -3.65], [-13, 5.5, 4.85, -3.8], [-10, 6.6, 5.15, -4.0],
  [-6, 7.3, 5.35, -4.1], [-2, 7.7, 5.5, -4.2], [2, 7.75, 5.5, -4.2], [6, 7.45, 5.4, -4.1], [9.5, 6.9, 5.1, -3.8],
  [12.5, 6.3, 4.6, -3.3], [15.6, 5.9, 4.1, -2.8],
];
const RING = 18;
// the body's cross-section at station st, angle th (0 the left flank, π/2 the back): [x, y]. The body boxy-round with a wrinkled
// skin fold along the flank just under the middle; the tail narrower, a keel on top
function section(st: number[], th: number, wart: number): [number, number] {
  const [z, w, top, bot] = st, tail = Math.max(0, Math.min(1, (-13 - z) / 6));
  const c = Math.cos(th), s = Math.sin(th), yc = (top + bot) / 2, hh = (top - bot) / 2;
  const ex = 0.62 + 0.33 * tail, ey = s > 0 ? 0.72 + 0.95 * tail : 0.85 + 0.15 * tail;
  let x = w * Math.sign(c) * Math.pow(Math.abs(c), ex), y = yc + hh * Math.sign(s) * Math.pow(Math.abs(s), ey);
  const fold = 1 + 0.075 * (1 - tail) * Math.exp(-(((s + 0.12) / 0.2) ** 2)) * (0.75 + 0.5 * vnoise(z * 0.8, 0.5, 3));
  x *= fold;
  if (s > 0) { x *= 1 + wart; y = yc + (y - yc) * (1 + wart); }              // the warty back
  return [x, y];
}
function skinColour(z: number, th: number): number {
  const s = Math.sin(th), n = vnoise(z * 0.32, th * 2.4, 1), n2 = vnoise(z * 0.85 + 5, th * 5.5 + 2, 2);
  if (s < -0.42) return mix(BELLY2, BELLY, vnoise(z * 0.5, th * 3, 4));        // the belly, paler
  if (Math.abs(s + 0.12) < 0.22) return mix(FOLD, LIGHT, n2 * 0.55);           // the flank's fold
  let col = mix(DARK, BASE, n * 1.5 - 0.15);
  if (n2 > 0.6) col = mix(col, n2 > 0.76 ? SPOT : LIGHT, Math.min(1, (n2 - 0.6) * 5));   // the lighter mottling
  else if (n2 < 0.22) col = mix(col, 0x2a2618, (0.22 - n2) * 4);              // and darker blotches
  return col;
}

// ---------- the skinned mesh's buffers ----------
interface Skin { p: number[]; n: number[]; c: number[]; mi: number[]; mw: number[] }
const RGB = [0, 0, 0];
const rgb = (h: number) => { RGB[0] = ((h >> 16) & 255) / 255; RGB[1] = ((h >> 8) & 255) / 255; RGB[2] = (h & 255) / 255; return RGB; };
// a flat triangle (counter-clockwise seen from outside, as core/geo.ts builds them), each corner its colour and its spine z (weights)
function stri(g: Skin, a: P3, b: P3, c: P3, ca: number, cb: number, cc: number, za: number, zb: number, zc: number) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
  for (const [v, col, z] of [[a, ca, za], [b, cb, zb], [c, cc, zc]] as [P3, number, number][]) {
    g.p.push(v[0], v[1], v[2]); g.n.push(nx, ny, nz); const k = rgb(col); g.c.push(k[0], k[1], k[2], 1);
    const w = weights(z); g.mi.push(w[0], w[1], 0, 0); g.mw.push(w[2], w[3], 0, 0);
  }
}
// a triangle a b c of one colour at spine z, turned to face away from the point o
function otriS(g: Skin, a: P3, b: P3, c: P3, col: number, z: number, o: P3) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const mx = (a[0] + b[0] + c[0]) / 3 - o[0], my = (a[1] + b[1] + c[1]) / 3 - o[1], mz = (a[2] + b[2] + c[2]) / 3 - o[2];
  if (nx * mx + ny * my + nz * mz >= 0) stri(g, a, b, c, col, col, col, z, z, z); else stri(g, a, c, b, col, col, col, z, z, z);
}
// a quad a b c d, turned to face away from the point o (the spine)
function squad(g: Skin, a: P3, b: P3, c: P3, d: P3, cols: number[], zs: number[], o: P3) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const mx = (a[0] + c[0]) / 2 - o[0], my = (a[1] + c[1]) / 2 - o[1], mz = (a[2] + c[2]) / 2 - o[2];
  if (nx * mx + ny * my + nz * mz >= 0) { stri(g, a, b, c, cols[0], cols[1], cols[2], zs[0], zs[1], zs[2]); stri(g, a, c, d, cols[0], cols[2], cols[3], zs[0], zs[2], zs[3]); }
  else { stri(g, a, c, b, cols[0], cols[2], cols[1], zs[0], zs[2], zs[1]); stri(g, a, d, c, cols[0], cols[3], cols[2], zs[0], zs[3], zs[2]); }
}
function bodyGeo(): Skin {
  const g: Skin = { p: [], n: [], c: [], mi: [], mw: [] };
  const P: P3[][] = [], C: number[][] = [];
  BODY.forEach(st => {
    const row: P3[] = [], col: number[] = [];
    for (let j = 0; j < RING; j++) {
      const th = j / RING * Math.PI * 2, wart = Math.sin(th) > 0 ? (vnoise(st[0] * 1.3, th * 7, 9) - 0.5) * 0.07 : 0;
      const [x, y] = section(st, th, wart); row.push([x, y, st[0]]); col.push(skinColour(st[0], th));
    }
    P.push(row); C.push(col);
  });
  for (let i = 0; i + 1 < BODY.length; i++) {
    const za = BODY[i][0], zb = BODY[i + 1][0], o: P3 = [0, (BODY[i][2] + BODY[i][3]) / 2, (za + zb) / 2];
    for (let j = 0; j < RING; j++) {
      const k = (j + 1) % RING;
      squad(g, P[i][j], P[i][k], P[i + 1][k], P[i + 1][j], [C[i][j], C[i][k], C[i + 1][k], C[i + 1][j]], [za, za, zb, zb], o);
    }
  }
  // the tail's tip and the neck's end closed (the neck's end is inside the head)
  for (const [i, dz] of [[0, -1], [BODY.length - 1, 1]] as [number, number][]) {
    const st = BODY[i], c: P3 = [0, (st[2] + st[3]) / 2, st[0] + dz * 0.15], o: P3 = [0, c[1], st[0] - dz * 2];
    for (let j = 0; j < RING; j++) otriS(g, P[i][j], P[i][(j + 1) % RING], c, C[i][j], st[0], o);
  }
  // the warts: small three-sided bumps over the back and the top of the tail, darker or lighter than the skin round them
  const st = (z: number) => {                                                  // the station at z (interpolated)
    let k = 0; while (k + 2 < BODY.length && BODY[k + 1][0] < z) k++;
    const a = BODY[k], b = BODY[k + 1], t = (z - a[0]) / (b[0] - a[0]);
    return a.map((v, q) => v + (b[q] - v) * t);
  };
  for (let n = 0; n < 120; n++) {
    const z = -30 + hash01(n, 11) * 44, th = Math.PI * (0.16 + 0.68 * hash01(n, 12)), S = st(z);
    const [x, y] = section(S, th, 0), [x1, y1] = section(S, th + 0.02, 0);
    let tx = x1 - x, ty = y1 - y; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    const nx = ty, ny = -tx, out = nx * x + ny * (y - (S[2] + S[3]) / 2) >= 0 ? 1 : -1;   // the outward normal in the section's plane
    const r = 0.3 + 0.45 * hash01(n, 13), hgt = 0.1 + 0.16 * hash01(n, 14), col = mix(skinColour(z, th), hash01(n, 15) < 0.5 ? DARK : SPOT, 0.55);
    const ox = nx * out, oy = ny * out, pt = (a: number, k: number, up: number): P3 => [x + tx * Math.cos(a) * r * k + ox * up, y + ty * Math.cos(a) * r * k + oy * up, z + Math.sin(a) * r * k];
    const top: P3 = [x + ox * hgt, y + oy * hgt, z], o: P3 = [x - ox, y - oy, z];
    for (let q = 0; q < 5; q++) {                                             // a low dome: a ring at half its height, a cap
      const a0 = q / 5 * 6.283, a1 = (q + 1) / 5 * 6.283;
      squad(g, pt(a0, 1, -0.04), pt(a1, 1, -0.04), pt(a1, 0.6, hgt * 0.75), pt(a0, 0.6, hgt * 0.75), [col, col, col, col], [z, z, z, z], o);
      otriS(g, pt(a0, 0.6, hgt * 0.75), pt(a1, 0.6, hgt * 0.75), top, col, z, o);
    }
  }
  return g;
}

// ---------- the rigid parts ----------
// a quad into a bucket, turned to face away from o
function oquad(bk: Geo, a: P3, b: P3, c: P3, d: P3, col: number, o: P3) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const mx = (a[0] + c[0]) / 2 - o[0], my = (a[1] + c[1]) / 2 - o[1], mz = (a[2] + c[2]) / 2 - o[2];
  if (nx * mx + ny * my + nz * mz >= 0) { tri(bk, a, b, c, col); tri(bk, a, c, d, col); } else { tri(bk, a, c, b, col); tri(bk, a, d, c, col); }
}
// a triangle into a bucket, turned to face away from o
function otri(bk: Geo, a: P3, b: P3, c: P3, col: number, o: P3) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const mx = (a[0] + b[0] + c[0]) / 3 - o[0], my = (a[1] + b[1] + c[1]) / 3 - o[1], mz = (a[2] + b[2] + c[2]) / 3 - o[2];
  if (nx * mx + ny * my + nz * mz >= 0) tri(bk, a, b, c, col); else tri(bk, a, c, b, col);
}
// a loft of half rings (the upper half of a section for the skull, the lower for the jaw): stations [z, half width, lip, far] (far:
// the top of the skull or the bottom of the jaw), closed flat at the lip (the palate, the mouth's floor) and at both ends
function halfLoft(bk: Geo, S: number[][], up: boolean, colOf: (z: number, a: number) => number, inside: number, shift: P3) {
  const M = 12, P: P3[][] = [];
  for (const [z, w, lip, far] of S) {
    const row: P3[] = [];
    for (let j = 0; j <= M; j++) {
      const a = j / M * Math.PI, c = Math.cos(a), s = Math.sin(a);
      const x = w * Math.sign(c) * Math.pow(Math.abs(c), 0.55), y = lip + (far - lip) * Math.pow(s, up ? 0.8 : 0.9);
      row.push([x - shift[0], y - shift[1], z - shift[2]]);
    }
    P.push(row);
  }
  for (let i = 0; i + 1 < S.length; i++) {
    const o: P3 = [-shift[0], (S[i][2] + S[i][3]) / 2 - shift[1], (S[i][0] + S[i + 1][0]) / 2 - shift[2]];
    for (let j = 0; j < M; j++) oquad(bk, P[i][j], P[i][j + 1], P[i + 1][j + 1], P[i + 1][j], colOf(S[i][0], j / M), o);
    // the palate or the mouth's floor
    const L = (k: number, sx: number): P3 => [sx * S[k][1] - shift[0], S[k][2] - shift[1], S[k][0] - shift[2]];
    oquad(bk, L(i, 1), L(i, -1), L(i + 1, -1), L(i + 1, 1), inside, [-shift[0], S[i][2] + (up ? 1 : -1) - shift[1], (S[i][0] + S[i + 1][0]) / 2 - shift[2]]);
  }
  // both ends closed: a fan to the middle of the lip
  for (const [k, dz] of [[0, 1], [S.length - 1, -1]] as [number, number][]) {
    const c: P3 = [-shift[0], S[k][2] - shift[1], S[k][0] - shift[2]], o: P3 = [-shift[0], (S[k][2] + S[k][3]) / 2 - shift[1], S[k][0] + dz * 2 - shift[2]];
    for (let j = 0; j < M; j++) otri(bk, P[k][j], P[k][j + 1], c, colOf(S[k][0], 0.5), o);
  }
}
// a tube from a to b (radius ra at a, rb at b), seg sides, into a bucket
function tube(bk: Geo, a: P3, b: P3, ra: number, rb: number, seg: number, col: number) {
  let dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2]; const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
  let sx = dy * 0 - dz * 1, sy = dz * 0 - dx * 0, sz = dx * 1 - dy * 0;                  // d × up
  if (Math.hypot(sx, sy, sz) < 1e-3) { sx = 1; sy = 0; sz = 0; }
  const sl = Math.hypot(sx, sy, sz); sx /= sl; sy /= sl; sz /= sl;
  const ux = dy * sz - dz * sy, uy = dz * sx - dx * sz, uz = dx * sy - dy * sx;           // d × s: (s, u, d) right-handed
  const at = (p: P3, r: number, k: number): P3 => { const f = k / seg * Math.PI * 2, c = Math.cos(f) * r, s = Math.sin(f) * r; return [p[0] + sx * c + ux * s, p[1] + sy * c + uy * s, p[2] + sz * c + uz * s]; };
  for (let k = 0; k < seg; k++) {
    const A = at(a, ra, k), B = at(a, ra, k + 1), C = at(b, rb, k + 1), D = at(b, rb, k);
    tri(bk, A, B, C, col); tri(bk, A, C, D, col);
  }
  if (rb > 0.02) for (let k = 0; k < seg; k++) tri(bk, at(b, rb, k), at(b, rb, k + 1), b, col);
}
// the skull and its parts, in the neck node's space (shift: the neck's joint in model space)
const NECK_J: P3 = [0, JY, 12];
const SKULL = [[12.8, 5.9, 0.8, 5.3], [15, 7.2, 1.0, 5.5], [17.5, 8.0, 1.15, 5.4], [20, 8.1, 1.25, 5.0], [22.5, 7.4, 1.35, 4.4],
  [24.3, 5.9, 1.45, 3.7], [25.5, 3.6, 1.55, 3.0], [26.1, 1.2, 1.6, 2.3]];
// the jaw on its hinge (model space), its stations the skull's a little narrower, down to its chin
const HINGE: P3 = [0, 0.8, 14];
const JAW = [[13.2, 5.6, 0.78, -1.4], [15, 6.95, 0.98, -1.7], [17.5, 7.75, 1.13, -1.5], [20, 7.85, 1.23, -1.1], [22.5, 7.15, 1.33, -0.6],
  [24.3, 5.7, 1.43, 0.0], [25.5, 3.45, 1.53, 0.5], [26.0, 1.15, 1.58, 0.9]];
// the skull's top surface at (x, z) (its stations interpolated, the section's dome as halfLoft builds it)
function skullY(x: number, z: number): number {
  let k = 0; while (k + 2 < SKULL.length && SKULL[k + 1][0] < z) k++;
  const a = SKULL[k], b = SKULL[k + 1], t = Math.max(0, Math.min(1, (z - a[0]) / (b[0] - a[0]))), w = a[1] + (b[1] - a[1]) * t;
  const lip = a[2] + (b[2] - a[2]) * t, top = a[3] + (b[3] - a[3]) * t, c = Math.min(1, Math.pow(Math.min(1, Math.abs(x) / w), 1 / 0.55));
  return lip + (top - lip) * Math.pow(Math.sqrt(1 - c * c), 0.8);
}
function headGeo(): { skull: Geo; jaw: Geo; glint: Geo } {
  const skull = Bucket(), jaw = Bucket(), glint = Bucket();
  halfLoft(skull, SKULL, true, (z, a) => {
    if (a < 0.06 || a > 0.94) return 0x241e14;                                 // the wide mouth's line, dark,
    if (a < 0.14 || a > 0.86) return LIP;                                      // the lip over it lighter
    const n = vnoise(z * 0.5, a * 6, 21), n2 = vnoise(z * 1.2, a * 11, 22);
    return n2 > 0.7 ? mix(BASE, SPOT, (n2 - 0.7) * 3) : mix(DARK, BASE, n * 1.3);
  }, MOUTH, NECK_J);
  const jshift: P3 = [HINGE[0], HINGE[1], HINGE[2]];
  halfLoft(jaw, JAW, false, (z, a) => a < 0.1 || a > 0.9 ? 0x241e14 : mix(BELLY2, BASE, vnoise(z * 0.6, a * 5, 23)), MOUTH, jshift);
  // small beady eyes on top of the head, a glint in each; the nostrils at the snout
  for (const sx of [-1, 1]) {
    const ey = skullY(sx * 5.0, 19);
    addGeo(skull, translate(sphereGeo(0.62, 8, 6), sx * 5.0 - NECK_J[0], ey + 0.05 - NECK_J[1], 19 - NECK_J[2]), null, EYE);
    addGeo(skull, translate(sphereGeo(0.95, 8, 4, Math.PI / 2), sx * 5.0 - NECK_J[0], ey - 0.35 - NECK_J[1], 19 - NECK_J[2]), null, BASE);   // the lid's rim
    addGeo(glint, translate(sphereGeo(0.17, 5, 4), sx * 5.2 - NECK_J[0], ey + 0.52 - NECK_J[1], 19.25 - NECK_J[2]), null, GLINT);
    addGeo(skull, translate(sphereGeo(0.22, 6, 4), sx * 1.25 - NECK_J[0], skullY(sx * 1.25, 25.4) - 0.1 - NECK_J[1], 25.4 - NECK_J[2]), null, 0x1e190f);
  }
  // a few warts on the head too
  for (let n = 0; n < 22; n++) {
    const z = 14 + hash01(n, 31) * 9, x = (hash01(n, 32) - 0.5) * 11, y = skullY(x, z) - 0.1;
    if (Math.abs(Math.abs(x) - 5) < 1.4 && Math.abs(z - 19) < 1.6) continue;   // not on an eye
    addGeo(skull, translate(scaleGeo(sphereGeo(0.28 + 0.3 * hash01(n, 33), 5, 3, Math.PI / 2), 1, 0.6, 1), x - NECK_J[0], y - NECK_J[1], z - NECK_J[2]), null, mix(BASE, hash01(n, 34) < 0.5 ? DARK : SPOT, 0.6));
  }
  return { skull, jaw, glint };
}
// the gills of one side (sx: +1 the left, -1 the right) round their node at the back of the head: three stalks reaching back, out
// and up, each with feathery fronds along it; unlit, a pale cyan glow
const GILL_AT: P3 = [6.1, 3.0, 13.7];
function gillGeo(sx: number): Geo {
  const g = Bucket();
  for (const [dx, dy, dz, L] of [[0.45, 0.72, -0.6, 4.8], [0.8, 0.2, -0.6, 5.3], [0.74, -0.3, -0.62, 4.4]]) {
    const l = Math.hypot(dx, dy, dz), d: P3 = [sx * dx / l, dy / l, dz / l], tip: P3 = [d[0] * L, d[1] * L, d[2] * L];
    tube(g, [0, 0, 0], tip, 0.42, 0.12, 6, STALK);
    // the fronds: thin blades either side of the stalk, swept back, longer in the middle
    let px = d[1] * 0 - d[2] * 1, py = d[2] * 0 - d[0] * 0, pz = d[0] * 1 - d[1] * 0; const pl = Math.hypot(px, py, pz) || 1; px /= pl; py /= pl; pz /= pl;
    const qx = d[1] * pz - d[2] * py, qy = d[2] * px - d[0] * pz, qz = d[0] * py - d[1] * px;   // the stalk's own up
    for (let k = 1; k <= 12; k++) {
      const t = 0.1 + k * 0.074, b: P3 = [d[0] * L * t, d[1] * L * t, d[2] * L * t], fl = 0.55 + 0.75 * Math.sin(t * Math.PI), col = k % 2 ? FROND : FROND2;
      for (const side of [-1, 1]) {
        const up = k % 3 === 0 ? 0.75 : k % 3 === 1 ? 0.2 : -0.35;
        const ox = (px * side * 0.8 + qx * up - d[0] * 0.55) * fl, oy = (py * side * 0.8 + qy * up - d[1] * 0.55) * fl, oz = (pz * side * 0.8 + qz * up - d[2] * 0.55) * fl;
        const w = 0.09;
        tri(g, [b[0] - d[0] * w, b[1] - d[1] * w, b[2] - d[2] * w], [b[0] + d[0] * w, b[1] + d[1] * w, b[2] + d[2] * w], [b[0] + ox, b[1] + oy, b[2] + oz], col);
      }
    }
  }
  return g;
}
// a leg of one side: shoulder (or hip) at its node, out, down and forward (back for a hind leg), a flat foot with stubby toes
function legGeo(bk: Geo, sx: number, at: P3, fwd: number, toes: number, s = 1) {
  const k: P3 = [at[0] + sx * 3.5 * s, at[1] - 1.4 * s, at[2] + fwd * 1.5 * s], w: P3 = [at[0] + sx * 4.8 * s, at[1] - 3.9 * s, at[2] + fwd * 3.0 * s];
  tube(bk, at, k, 1.55 * s, 1.15 * s, 7, LEG); tube(bk, k, w, 1.1 * s, 0.8 * s, 7, LEG);
  const f: P3 = [w[0] + sx * 0.4 * s, w[1] - 0.45 * s, w[2] + fwd * 0.6 * s];
  addGeo(bk, translate(scaleGeo(sphereGeo(s, 7, 5), 1.7, 0.42, 1.5), f[0], f[1], f[2]), null, LEG);
  for (let t = 0; t < toes; t++) {
    const a = (t - (toes - 1) / 2) * 0.42, dx = sx * Math.sin(a + sx * 0.35 * fwd) * s, dz = fwd * Math.cos(a) * s;
    tube(bk, [f[0] + dx * 0.9, f[1], f[2] + dz * 0.9], [f[0] + dx * 2.3, f[1] - 0.15 * s, f[2] + dz * 2.3], 0.36 * s, 0.22 * s, 5, TOE);
  }
}

// ---------- the model ----------
interface View {
  root: TransformNode; nodes: TransformNode[]; jaw: TransformNode; gills: TransformNode[]; legs: TransformNode[]; skin: StandardMaterial; body: Mesh;
}
let V: View | null = null;
const SKIN_E = c3(0x1a1810), SKIN_FLASH = c3(0x6a5a3a);
function buildModel(): View {
  const root = new TransformNode('velemlok', scene);
  const skin = new StandardMaterial('velemlokSkin', scene);
  skin.diffuseColor = Color3.White(); skin.specularColor = new Color3(0.2, 0.22, 0.18); skin.specularPower = 26; skin.emissiveColor = SKIN_E.clone();
  // the skeleton: a bone per spine node, each driven by its transform node (linkTransformNode), in the root's space
  const skel = new Skeleton('velemlok', 'velemlok', scene), bones: Bone[] = [], nodes: TransformNode[] = [];
  BONES.forEach((b, i) => {
    const par = b.p >= 0 ? BONES[b.p] : null, y = par ? 0 : JY, z = b.z - (par ? par.z : 0);
    const bone = new Bone(b.n, skel, par ? bones[b.p] : null, Matrix.Translation(0, y, z));
    const n = new TransformNode('velemlok_' + b.n, scene); n.parent = par ? nodes[b.p] : root; n.position.set(0, y, z);
    bone.linkTransformNode(n); bones.push(bone); nodes.push(n); void i;
  });
  const g = bodyGeo(), body = new Mesh('velemlokBody', scene), vd = new VertexData(), nv = g.p.length / 3;
  const idx = new Uint32Array(nv); for (let i = 0; i < nv; i += 3) { idx[i] = i; idx[i + 1] = i + 2; idx[i + 2] = i + 1; }   // (core/geo.ts geoMesh: Babylon's front face)
  vd.positions = g.p; vd.normals = g.n; vd.colors = g.c; vd.indices = idx; vd.matricesIndices = g.mi; vd.matricesWeights = g.mw;
  vd.applyToMesh(body, false);
  body.parent = root; body.skeleton = skel; body.material = skin; body.isPickable = false; body.receiveShadows = true;
  body.alwaysSelectAsActiveMesh = true;                // the bones move it far out of its resting box (rearing): never culled by it
  addCaster(body);
  // the head on the neck's node: the skull, the jaw on its hinge, the glints, the gills either side
  const neck = nodes[B_NECK], h = headGeo();
  const skull = geoMesh('velemlokSkull', h.skull, skin, true, true); skull.parent = neck;
  const jaw = new TransformNode('velemlokJawNode', scene); jaw.parent = neck; jaw.position.set(HINGE[0] - NECK_J[0], HINGE[1] - NECK_J[1], HINGE[2] - NECK_J[2]);
  geoMesh('velemlokJaw', h.jaw, skin, true, true).parent = jaw;
  geoMesh('velemlokGlint', h.glint, VC_GLOW, false, false).parent = neck;
  const gills = [1, -1].map(sx => {
    const n = new TransformNode('velemlokGills', scene); n.parent = neck; n.position.set(sx * GILL_AT[0] - NECK_J[0], GILL_AT[1] - NECK_J[1], GILL_AT[2] - NECK_J[2]);
    geoMesh('velemlokGill', gillGeo(sx), VC_GLOW, false, false).parent = n;
    return n;
  });
  // the legs: the front ones each on a node of its own at its shoulder on the chest's node (they paddle, and tuck back along the flanks
  // when it rears: no arms held up), the hind ones on the hips' node
  const hl = Bucket(), CH = BONES[B_CHEST].z, HP = BONES[B_HIPS].z;
  const legs = [1, -1].map(sx => {
    const n = new TransformNode('velemlokLeg', scene); n.parent = nodes[B_CHEST]; n.position.set(sx * 6.4, -2.3 - JY, 9 - CH);
    const b = Bucket(); legGeo(b, sx, [0, 0, 0], 1, 4, 0.8); geoMesh('velemlokLegF', b, skin, true, true).parent = n;
    return n;
  });
  for (const sx of [-1, 1]) legGeo(hl, sx, [sx * 6.0, -2.5 - JY, -9 - HP], -1, 5);
  geoMesh('velemlokLegsH', hl, skin, true, true).parent = nodes[B_HIPS];
  root.setEnabled(false);
  return { root, nodes, jaw, gills, legs, skin, body };
}

// ---------- the effects' meshes ----------
// the spray: soft round sprites that fly and fall (gravity g), grow and fade; sparks of a hit go to game/shells.ts's fire
interface Drop { on: boolean; x: number; y: number; z: number; vx: number; vy: number; vz: number; age: number; life: number; s0: number; s1: number; g: number }
const DROP_N = 480, DROPS: Drop[] = [];
let drops: Inst | null = null, dNext = 0, dLive = 0;
const D = new Dummy(), DQ = new Quaternion(), HIDDEN = new Float32Array(16); HIDDEN[13] = -1000; HIDDEN[15] = 1;
export function drop(x: number, y: number, z: number, vx: number, vy: number, vz: number, s: number, life: number, g = 20, grow = 1.6) {
  const d = DROPS[dNext]; dNext = (dNext + 1) % DROP_N;
  if (!d.on) dLive++;
  Object.assign(d, { on: true, x, y, z, vx, vy, vz, age: 0, life, s0: s, s1: s * grow, g });
}
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
// a burst of spray at (x, y, z): n drops thrown up and out at speed sp from a circle of radius s (the drops at most a few units big)
function sprayBurst(x: number, y: number, z: number, n: number, sp: number, up: number, s = 1) {
  const ds = Math.min(s, 1.8);
  for (let k = 0; k < n; k++) {
    const a = Math.random() * 6.283, o = rnd(0.3, 1) * sp;
    drop(x + Math.sin(a) * s, y, z + Math.cos(a) * s, Math.sin(a) * o, rnd(0.5, 1) * up, Math.cos(a) * o, rnd(0.7, 1.4) * ds, rnd(0.8, 1.4));
  }
}
// rings lying on the water (the slam's wave, the geyser's warning), each with its own material for its own fading
interface Ring { m: Mesh; mat: StandardMaterial; busy: boolean }
const RINGS: Ring[] = [];
// the geysers' columns: a node with two open cylinders of streaming water (their own materials), the jets' balls of water
interface Col { n: TransformNode; a: Mesh; b: Mesh; ma: StandardMaterial; mb: StandardMaterial; busy: boolean }
const COLS: Col[] = [];
interface Ball { m: Mesh; busy: boolean }
const BALLS: Ball[] = [];
function buildFx() {
  const q = Bucket(); addGeo(q, planeGeo(2, 2), null, 0xffffff);
  // the spray's sprite: a faint soft haze with a scatter of small bright droplets in it (each sprite turned its own way): water
  // flying apart, where one soft spot (core/tex.ts poolTex) read as puffs of steam or cotton
  const sprayTex = canvasTex(64, 64, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,0.5)'); g.addColorStop(0.55, 'rgba(255,255,255,0.16)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    for (let k = 0; k < 18; k++) {
      const a = hash01(k, 51) * 6.283, r = Math.sqrt(hash01(k, 52)) * w * 0.4, s = 1 + hash01(k, 53) * 2.4;
      c.fillStyle = `rgba(255,255,255,${(0.6 + 0.4 * hash01(k, 54)).toFixed(2)})`;
      c.beginPath(); c.arc(w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r, s, 0, 6.283); c.fill();
    }
  }, { alpha: true });
  drops = new Inst('velemlokSpray', q, basic(0xe4f6f3, { map: sprayTex, transparent: true, depthWrite: false, opacity: 0.9 }), DROP_N, { receive: false });
  for (let i = 0; i < DROP_N; i++) { DROPS.push({ on: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: 1, s0: 1, s1: 1, g: 20 }); drops.setMatrixAt(i, HIDDEN); }
  drops.update();
  const rg = rotateX(ringGeo(0.76, 1, 56), -Math.PI / 2);
  for (let i = 0; i < 4; i++) {
    const mat = basic(0xffffff, { transparent: true, opacity: 0.8, depthWrite: false, double: true });
    const m = geoMesh('velemlokRing', rg, mat, false, false); m.setEnabled(false); m.alwaysSelectAsActiveMesh = true;
    RINGS.push({ m, mat, busy: false });
  }
  // the column's water: streaks running up it, thinning out to the top (the texture's v runs up the cylinder)
  const tex = canvasTex(128, 256, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    for (let k = 0; k < 70; k++) {
      const x = hash01(k, 41) * w, sw = 3 + hash01(k, 42) * 9, y0 = hash01(k, 43) * h * 0.4, a = 0.25 + 0.5 * hash01(k, 44);
      const gr = c.createLinearGradient(0, y0, 0, h);
      gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.25, `rgba(255,255,255,${a})`); gr.addColorStop(1, `rgba(255,255,255,${a})`);
      c.fillStyle = gr; c.fillRect(x - sw / 2, y0, sw, h - y0); c.fillRect(x - sw / 2 - w, y0, sw, h - y0); c.fillRect(x - sw / 2 + w, y0, sw, h - y0);
    }
  }, { alpha: true, repeat: true });
  const cyl = (r0: number, r1: number) => translate(cylGeo(r1, r0, 1, 20, true), 0, 0.5, 0);
  for (let i = 0; i < 2; i++) {
    const n = new TransformNode('velemlokGeyser', scene);
    const ma = basic(0xe8f8f6, { map: tex, transparent: true, depthWrite: false, double: true, opacity: 0.8 });
    const mb = basic(0xcdeeea, { map: tex, transparent: true, depthWrite: false, double: true, opacity: 0.7 });
    const a = geoMesh('velemlokGeyserA', cyl(1, 0.82), ma, false, false), b = geoMesh('velemlokGeyserB', cyl(0.62, 0.7), mb, false, false);
    a.parent = n; b.parent = n; a.alwaysSelectAsActiveMesh = b.alwaysSelectAsActiveMesh = true; n.setEnabled(false);
    COLS.push({ n, a, b, ma, mb, busy: false });
  }
  const bm = basic(0xcdeeea, { transparent: true, opacity: 0.6, depthWrite: false });
  for (let i = 0; i < 3; i++) { const m = geoMesh('velemlokJet', sphereGeo(1.5, 10, 7), bm, false, false); m.setEnabled(false); BALLS.push({ m, busy: false }); }
}
const take = <T extends { busy: boolean }>(l: T[]): T | null => { const x = l.find(e => !e.busy) || null; if (x) x.busy = true; return x; };

// main.ts calls this once at boot, after the objectives (no random numbers of the city's)
export function buildMonster() { V = buildModel(); buildFx(); }

// ---------- the animation ----------
// what game/monster.ts draws: the pose (as snap.g gives it, interpolated), its state and hit points, its speed; sn the server's clock
export interface MonDraw { x: number; z: number; h: number; y: number; rear: number; st: number; hp: number; v: number }
// the animation's own state: the swimming wave's phase, the death roll (deadT < 0 alive; side: which way it rolls), what was done once
// (the slap of the roll, the final splash, the back breaking the surface), a flinch, the gape after it surfaced
const A = {
  ph: 0, deadT: -1, side: 1, rear0: 0, slap: false, final: false, broke: false, flinch: 0, fx: 0, fz: 0, gape: 0, wasSt: 0, sprayT: 0, rearWas: 0,
  boil: 0, boilX: 0, boilZ: 0,
};
// the attacks that move it: the slam that raises its tail (aimed at the ring), the jet that opens its jaw
let SLAM: MonAtk | null = null, JET: MonAtk | null = null;
const W = new Vector3();
// a point of the model (model space) in the world, at the node it rides on
function worldOf(n: TransformNode, x: number, y: number, z: number): Vector3 {
  Vector3.TransformCoordinatesFromFloatsToRef(x, y, z, n.computeWorldMatrix(true), W); return W;
}
const ease = (t: number) => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
// the wave down the spine: each node's share of the swing (rad) and how far behind the head it runs
const SWAY: [number, number, number][] = [[B_NECK, 0.035, 0], [B_CHEST, 0.045, 0.5], [B_FRONT, 0.05, 1.0], [B_HIPS, 0.05, 1.6],
  [B_TAIL, 0.11, 2.2], [B_TAIL + 1, 0.15, 2.8], [B_TAIL + 2, 0.19, 3.4], [B_TAIL + 3, 0.22, 4.0]];
export function drawMonster(d: MonDraw | null, dt: number, sn: number) {
  if (!V) return;
  if (!d || d.y < MON_DEEP + 1) {
    if (V.root.isEnabled()) V.root.setEnabled(false);
    if (!d) { A.deadT = -1; A.slap = A.final = A.broke = false; A.wasSt = 0; SLAM = JET = null; }
    boilOn(dt);
    return;
  }
  V.root.setEnabled(true);
  const N = V.nodes, killed = d.hp <= 0 && d.st === 3, hx = Math.sin(d.h), hz = Math.cos(d.h);
  // killed, it floats belly up a moment before it goes down: the server sinks it evenly (snap.g y from 0 to MON_DEEP in MON_SINK_S),
  // drawn here on the square of that (at the end of its 1.7 s roll it is only some 1.3 under, the final splash comes at 3.7 s). Only
  // the drawing: it can no longer be hurt, and a shell bursts on its hitbox a little lower
  if (killed) d = { ...d, y: MON_DEEP * Math.min(1, d.y / MON_DEEP) ** 2 };
  V.root.position.set(d.x, WATER_Y + d.y, d.z);
  // killed: it rolls over to either side, belly up, as it starts to sink (a rear it was in comes down first)
  if (killed && A.deadT < 0) { A.deadT = 0; A.side = Math.random() < 0.5 ? 1 : -1; A.rear0 = A.rearWas; }
  if (killed) A.deadT += dt;
  const roll = killed ? ease(A.deadT / 1.7) * Math.PI * A.side : 0;
  // the swimming wave: quicker and wider the faster it swims; it dies down when it is killed, and the front keeps still when it rears
  const life = killed ? Math.max(0, 1 - A.deadT / 1.2) : 1, sp = Math.min(1, d.v / 6);
  A.ph += dt * (1.1 + 1.6 * sp) * (0.3 + 0.7 * life);
  const amp = (0.45 + 0.55 * sp) * life, rear = killed ? A.rear0 * (1 - ease(A.deadT / 0.7)) : d.rear;
  for (const [i, a, lag] of SWAY) N[i].rotation.y = amp * a * Math.sin(A.ph - lag) * (i <= B_NECK && i !== B_HIPS ? 1 - rear : 1);
  // the flinch of a hit: a jolt that dies away
  A.flinch = Math.max(0, A.flinch - dt);
  const fl = A.flinch > 0 ? Math.sin(A.flinch * 60) * A.flinch * 0.5 : 0;
  V.skin.emissiveColor.copyFrom(A.flinch > 0.12 ? SKIN_FLASH : SKIN_E);
  V.root.rotation.set(fl * 0.3, d.h, roll + fl * 0.5);
  // rearing: the front half turns up round the hips by rear · MON_REAR_A (the hitbox's own turn), the neck bends the head a little
  // forward again so it looks ahead; diving, it noses down; surfacing, up. The tail: a slam lifts it (aimed at the ring) and brings it
  // down when the slam lands
  const diving = d.st === 3 && !killed ? Math.min(1, -d.y / 5) : 0, surfacing = d.st === 1 ? Math.min(1, -d.y / 8) : 0;
  N[B_FRONT].rotation.x = -rear * MON_REAR_A + diving * 0.22 - surfacing * 0.12;
  // (at full rear the head's middle stays within about 2.5 of the hitbox's head sphere's: the front half turns as the spheres do, the
  // chest and the neck bend it forward again, a lunge rather than standing up)
  N[B_CHEST].rotation.x = rear * 0.12;
  N[B_NECK].rotation.x = rear * 0.32 + diving * 0.1;
  const tuck = Math.max(rear, diving, surfacing * 0.6);
  V.legs.forEach((n, i) => {
    const sx = i ? -1 : 1, pad = Math.sin(A.ph * 0.7 + i * Math.PI) * 0.22 * amp * (1 - tuck);
    n.rotation.set(0, sx * (tuck * 1.8 + pad), 0); n.scaling.setAll(1 - 0.45 * tuck);   // folded back along the flank, drawn in
  });
  let tl = 0, ty = 0;
  if (SLAM) {
    const t = (sn - (SLAM.at - MON_SLAM_WARN * 1000)) / 1000, up = MON_SLAM_WARN * 0.78;
    if (t > MON_SLAM_WARN + 1.2) SLAM = null;
    else {
      tl = t < up ? ease(t / up) : t < MON_SLAM_WARN ? 1 - ease((t - up) / (MON_SLAM_WARN - up)) * 1.15 : -0.15 * (1 - ease((t - MON_SLAM_WARN) / 0.8));
      // swing the tail towards the ring (the tail rests along -z): the ring in model space from the tail's base
      const dx = SLAM.x - d.x, dz = SLAM.z - d.z, lx = dx * hz - dz * hx, lz = dx * hx + dz * hz + 14;
      const want = Math.atan2(-lx, -lz), k = t < MON_SLAM_WARN ? ease(t / 0.5) : 1 - ease((t - MON_SLAM_WARN) / 1.2);
      ty = Math.max(-1.6, Math.min(1.6, want)) * k;
    }
  }
  N[B_TAIL].rotation.x = tl * 0.28 - diving * 0.15; N[B_TAIL + 1].rotation.x = tl * 0.36; N[B_TAIL + 2].rotation.x = tl * 0.36; N[B_TAIL + 3].rotation.x = tl * 0.26;
  N[B_TAIL].rotation.y += ty * 0.6; N[B_TAIL + 1].rotation.y += ty * 0.4;
  // the jaw: open for a jet (wide at t0, when the water leaves it), a gape after it surfaced, a little open once dead
  let open = 0;
  if (JET) {
    const t = (sn - (JET.t0 ?? JET.at)) / 1000;
    if (t > 1.2) JET = null; else open = t < 0 ? ease((t + 0.55) / 0.5) : 1 - ease((t - 0.25) / 0.6);
  }
  if (A.wasSt === 1 && d.st === 2) A.gape = 1.6;
  if (A.gape > 0) { A.gape -= dt; open = Math.max(open, Math.sin(Math.min(1, A.gape / 1.6) * Math.PI) * 0.75); }
  if (killed) open = Math.max(open, 0.3 * ease(A.deadT));
  V.jaw.rotation.x = open * 0.5;
  // the gills: a slow wave; flared out, up and bigger while it rears (and as it comes up); limp once dead
  const flare = Math.max(rear, surfacing * 0.5, open * 0.6) * (killed ? 0 : 1), t = sn / 1000;
  V.gills.forEach((g, i) => {
    const sx = i ? -1 : 1, wv = Math.sin(t * 2.1 + i * 1.3) * 0.07 * (killed ? 0.2 : 1);
    // (the stalks reach back along -z: a turn about y by -sx swings them out, about z by sx lifts them, about x by + lifts them too)
    g.rotation.set(flare * 0.08 - (killed ? 0.4 : 0), -sx * (0.05 + flare * 0.5 + wv), sx * (flare * 0.1 + wv * 0.5));
    g.scaling.setAll(1 + 0.28 * flare);
  });
  effects(d, dt, killed, hx, hz);
  A.wasSt = d.st; A.rearWas = rear;
}
// its spray and foam, by what it does
function effects(d: MonDraw, dt: number, killed: boolean, hx: number, hz: number) {
  const N = V!.nodes, X = (al: number, side = 0) => d.x + hx * al + hz * side, Z = (al: number, side = 0) => d.z + hz * al - hx * side;
  const top = WATER_Y + d.y + 5;
  // swimming: its wake and bow wave (world/water.ts, as a ship's: 15 its beam, so the bow wave starts at its snout)
  if (d.st === 2 && !killed && d.y > -3) wake(d.x, d.z, hx, hz, d.v, 15);
  // surfacing: the back breaks the surface (a ring of foam, a burst of spray), water pours off it while it comes up
  if (d.st === 1 && d.y > -6.5 && !A.broke) {
    A.broke = true;
    for (let k = 0; k < 7; k++) { const al = -30 + k * 9; splash(X(al, rnd(-4, 4)), Z(al, rnd(-4, 4)), rnd(0.8, 1.3)); }
    for (let k = 0; k < 40; k++) { const al = rnd(-30, 24); sprayBurst(X(al), WATER_Y + 0.5, Z(al), 1, 4, 9, 1.3); }
  }
  if (d.st !== 1 && d.st !== 3) A.broke = d.st === 2;
  A.sprayT -= dt;
  if ((d.st === 1 && d.y > -6) || (d.st === 3 && !killed && d.y > -7 && d.y < -0.5)) {
    if (A.sprayT <= 0) { A.sprayT = 0.16; const al = rnd(-30, 22); splash(X(al, rnd(-5, 5)), Z(al, rnd(-5, 5)), rnd(0.45, 0.9)); }
    for (let k = 0; k < 3; k++) { const al = rnd(-30, 24), s = rnd(-6, 6); drop(X(al, s), top, Z(al, s), hz * s * 0.25, rnd(-1, 2), -hx * s * 0.25, rnd(0.8, 1.4), rnd(0.6, 1.1)); }
  }
  // rearing: water streams off its front half; coming down, a splash where its chest hits the water
  if (d.rear > 0.25 && !killed) {
    const chest = worldOf(N[B_CHEST], rnd(-6, 6), rnd(-3, 5), rnd(0, 9));
    drop(chest.x, chest.y, chest.z, rnd(-1, 1), rnd(-2, 0), rnd(-1, 1), rnd(0.7, 1.2), 1.2, 22);
  }
  if (A.rearWas > 0.5 && d.rear <= 0.5 && !killed) for (let k = 0; k < 3; k++) splash(X(2 + k * 4, rnd(-4, 4)), Z(2 + k * 4, rnd(-4, 4)), 1.2);
  // killed: its side slaps the water as it rolls over, then the big final splash when it goes under, bubbles for a while after
  if (killed) {
    if (!A.slap && A.deadT > 1.2) {
      A.slap = true;
      for (let k = 0; k < 6; k++) { const al = -26 + k * 9; splash(X(al, A.side * 7), Z(al, A.side * 7), 1.3); sprayBurst(X(al, A.side * 7), WATER_Y + 0.5, Z(al, A.side * 7), 5, 6, 10, 1.4); }
      shake(d.x, d.z, 0.5);
    }
    if (!A.final && d.y < -6) {
      A.final = true;
      splash(d.x, d.z, 2.6);
      for (let k = 0; k < 8; k++) { const a = k / 8 * 6.283, r = rnd(8, 16); splash(d.x + Math.sin(a) * r, d.z + Math.cos(a) * r, rnd(1.2, 1.8)); }
      sprayBurst(d.x, WATER_Y + 0.5, d.z, 60, 12, 16, 3);
      A.boil = 5; A.boilX = d.x; A.boilZ = d.z;
      shake(d.x, d.z, 0.8);
    }
  }
  boilOn(dt);
}
// bubbles where it sank: small spouts round the spot for a few seconds
function boilOn(dt: number) {
  if (A.boil <= 0) return;
  A.boil -= dt;
  if (Math.random() < dt * 14) { const a = Math.random() * 6.283, r = Math.sqrt(Math.random()) * 14; splash(A.boilX + Math.sin(a) * r, A.boilZ + Math.cos(a) * r, rnd(0.1, 0.25)); }
}
function shake(x: number, z: number, s: number) {
  const dd = Math.hypot(x - camera.position.x, z - camera.position.z);
  if (dd < 160) fx.shakeT = Math.max(fx.shakeT, s * (1 - dd / 160));
}
// a hit on it at (x, y, z): sparks (game/shells.ts's fire), a puff of spray, the flinch and a flash of its skin; big: a parcel, a
// shell or a torpedo (a bullet: a small spark)
export function monSparkFx(x: number, y: number, z: number, big: boolean) {
  glow(x, y, z, big ? 2.2 : 0.7, big ? 0.22 : 0.12);
  if (big) { for (let k = 0; k < 6; k++) drop(x, y, z, rnd(-5, 5), rnd(2, 7), rnd(-5, 5), rnd(0.4, 0.8), rnd(0.4, 0.7), 20); A.flinch = Math.max(A.flinch, 0.2); }
  else A.flinch = Math.max(A.flinch, 0.08);
}

// ---------- the attacks ----------
interface AtkFx { A: MonAtk; ring: Ring | null; col: Col | null; ball: Ball | null; landed: boolean; until: number; bub: number }
const AFX: AtkFx[] = [];
// game/monster.ts hands over every attack the server announced (the mon message)
export function monAtkFx(A: MonAtk) {
  if (A.a === 'slam') SLAM = A; else if (A.a === 'jet') JET = A;
  AFX.push({ A, ring: null, col: null, ball: null, landed: false, until: A.at + (A.a === 'geyser' ? 2600 : 1600), bub: 0 });
}
export function clearMonFx() {
  for (const f of AFX) free(f);
  AFX.length = 0; SLAM = JET = null; A.boil = 0;
  for (const d of DROPS) d.on = false; dLive = 0; if (drops) { for (let i = 0; i < DROP_N; i++) drops.setMatrixAt(i, HIDDEN); drops.update(); }
}
function free(f: AtkFx) {
  if (f.ring) { f.ring.busy = false; f.ring.m.setEnabled(false); f.ring = null; }
  if (f.col) { f.col.busy = false; f.col.n.setEnabled(false); f.col = null; }
  if (f.ball) { f.ball.busy = false; f.ball.m.setEnabled(false); f.ball = null; }
}
const JP = [0, 0, 0], JS = [0, 0, 0];
// every frame: the attacks drawn (sn: the server's clock, ms), then the spray
export function updateMonFx(dt: number, sn: number) {
  for (let i = AFX.length - 1; i >= 0; i--) {
    const f = AFX[i], a = f.A;
    if (sn > f.until) { free(f); AFX.splice(i, 1); continue; }
    if (a.a === 'slam') slamFx(f, sn);
    else if (a.a === 'jet') jetFx(f, sn, dt);
    else geyserFx(f, sn, dt);
  }
  sprayStep(dt);
}
// the slam: when it lands, a wave of water runs out from the ring's middle, white columns round it, the tail's own splash
function slamFx(f: AtkFx, sn: number) {
  const a = f.A;
  if (sn < a.at) return;
  if (!f.landed) {
    f.landed = true; f.ring = take(RINGS);
    splash(a.x, a.z, 1.8);
    for (let k = 0; k < 9; k++) { const t = k / 9 * 6.283, r = a.r * rnd(0.55, 0.95); splash(a.x + Math.sin(t) * r, a.z + Math.cos(t) * r, rnd(0.8, 1.2)); }
    sprayBurst(a.x, WATER_Y + 0.5, a.z, 40, 9, 13, a.r * 0.4);
    if (V && V.root.isEnabled()) { const tip = worldOf(V.nodes[B_TAIL + 3], 0, 0, -3); splash(tip.x, tip.z, 1.4); }
    shake(a.x, a.z, 0.5);
  }
  const k = (sn - a.at) / 900;
  if (f.ring) {
    if (k >= 1) { f.ring.busy = false; f.ring.m.setEnabled(false); f.ring = null; return; }
    const r = a.r * (0.35 + 0.9 * ease(k));
    f.ring.m.setEnabled(true); f.ring.m.position.set(a.x, WATER_Y + 0.2, a.z); f.ring.m.scaling.set(r, 1, r);
    f.ring.mat.emissiveColor.set(1, 1, 1); f.ring.mat.alpha = 0.85 * Math.pow(1 - k, 1.3);
  }
}
// the jet: a ball of water flies its arc (client/shared/monster.ts monJetAt) from t0, shedding spray, and bursts where it lands
function jetFx(f: AtkFx, sn: number, dt: number) {
  const a = f.A, t0 = a.t0 ?? a.at;
  if (sn < t0) return;
  if (sn < a.at) {
    if (!f.ball) {
      f.ball = take(BALLS);
      sprayBurst(a.sx ?? a.x, a.sy ?? a.y, a.sz ?? a.z, 14, 5, 4, 1.2);         // it leaves the mouth
    }
    monJetAt(a, sn, JP);
    if (f.ball) {                                                              // a slug of water stretched along its flight, wobbling
      const s = (sn - t0) / 1000, w = 1 + 0.12 * Math.sin(sn * 0.03);
      f.ball.m.setEnabled(true); f.ball.m.position.set(JP[0], JP[1], JP[2]); f.ball.m.scaling.set(w, 1 / w, 2.6);
      W.set(JP[0] + (a.vx ?? 0), JP[1] + (a.vy ?? 0) - MON_JET_G * s, JP[2] + (a.vz ?? 0)); f.ball.m.lookAt(W);
    }
    const n = Math.min(8, 2 + Math.ceil(dt * 120));
    for (let k = 0; k < n; k++) drop(JP[0] + rnd(-1.2, 1.2), JP[1] + rnd(-1.2, 1.2), JP[2] + rnd(-1.2, 1.2), (a.vx ?? 0) * 0.3 + rnd(-2, 2), (a.vy ?? 0) * 0.15 + rnd(-2, 2), (a.vz ?? 0) * 0.3 + rnd(-2, 2), rnd(0.8, 1.5), rnd(0.4, 0.7), 26);
    for (let k = 0; k < n; k++) {                                              // the stream along the arc behind it
      monJetAt(a, t0 + Math.random() * (sn - t0), JS);
      drop(JS[0] + rnd(-0.6, 0.6), JS[1] + rnd(-0.6, 0.6), JS[2] + rnd(-0.6, 0.6), rnd(-1, 1), rnd(-1, 0.5), rnd(-1, 1), rnd(0.6, 1.1), rnd(0.3, 0.5), 14, 1.3);
    }
    return;
  }
  if (!f.landed) {
    f.landed = true;
    if (f.ball) { f.ball.busy = false; f.ball.m.setEnabled(false); f.ball = null; }
    const wet = surfaceY(a.x, a.z) <= WATER_Y + 0.01;
    if (wet) splash(a.x, a.z, 1.7);
    else { for (let k = 0; k < 3; k++) puff(a.x + rnd(-2, 2), a.y + 1, a.z + rnd(-2, 2), 2.4, 1.4, 1.2); }
    sprayBurst(a.x, a.y + 0.4, a.z, wet ? 30 : 46, 8, wet ? 10 : 8, a.r * 0.5);
    shake(a.x, a.z, 0.45);
  }
}
// the geyser: a ring on the water and bubbles while it warns, then the column shoots up to MON_GEY_TOP, holds, and falls back as rain
function geyserFx(f: AtkFx, sn: number, dt: number) {
  const a = f.A, warn = a.at - sn;
  if (!f.ring) f.ring = take(RINGS);
  if (f.ring) {
    const k = warn > 0 ? 1 : Math.max(0, 1 + warn / 400);
    if (k <= 0) { f.ring.busy = false; f.ring.m.setEnabled(false); f.ring = null; }
    else {
      const p = 0.5 + 0.5 * Math.sin(sn * 0.02);
      f.ring.m.setEnabled(true); f.ring.m.position.set(a.x, a.y + 0.2, a.z); f.ring.m.scaling.set(a.r * (1 + 0.05 * p), 1, a.r * (1 + 0.05 * p));
      f.ring.mat.emissiveColor.set(0.6 + 0.4 * p, 1, 0.95); f.ring.mat.alpha = (0.55 + 0.4 * p) * k;
    }
  }
  if (warn > 0) {                                                       // it boils under the ring
    f.bub -= dt;
    if (f.bub <= 0) { f.bub = 0.07; const t = Math.random() * 6.283, r = Math.sqrt(Math.random()) * a.r * 0.8; splash(a.x + Math.sin(t) * r, a.z + Math.cos(t) * r, rnd(0.12, 0.3)); }
    return;
  }
  if (!f.landed) {
    f.landed = true; f.col = take(COLS);
    if (a.y <= WATER_Y + 0.01) splash(a.x, a.z, 2.3);
    sprayBurst(a.x, a.y + 1, a.z, 30, 7, 14, a.r * 0.5);
  }
  const k = -warn / 1000, H = Math.max(4, MON_GEY_TOP - a.y);
  if (f.col) {
    const up = ease(k / 0.28), down = k > 0.85 ? ease((k - 0.85) / 0.9) : 0, h = H * up * (1 - 0.85 * down);
    if (k > 1.9) { f.col.busy = false; f.col.n.setEnabled(false); f.col = null; return; }
    f.col.n.setEnabled(true); f.col.n.position.set(a.x, a.y - 0.3, a.z);
    const r = a.r * (0.7 + 0.25 * up + 0.3 * down);
    f.col.n.scaling.set(r, Math.max(0.1, h), r); f.col.n.rotation.y = sn * 0.0012;
    f.col.b.rotation.y = -sn * 0.003;
    f.col.ma.alpha = 0.78 * (1 - down); f.col.mb.alpha = 0.62 * (1 - down);
    // spray off its top, rain falling back once it collapses
    const tp = a.y + h;
    for (let q = 0; q < (down > 0 ? 5 : 3); q++) { const t = Math.random() * 6.283, rr = r * rnd(0.3, 1); drop(a.x + Math.sin(t) * rr, tp - rnd(0, 6), a.z + Math.cos(t) * rr, Math.sin(t) * rnd(1, 5), rnd(down > 0 ? -4 : 2, down > 0 ? 2 : 10), Math.cos(t) * rnd(1, 5), rnd(1, 2), rnd(1.2, 2.2), 22, 1.6); }
  }
}
// the spray: every live drop moves, falls (not below the surface under it), grows and fades; one instanced mesh
const SURF = (x: number, z: number) => surfaceY(x, z);
function sprayStep(dt: number) {
  if (!drops || !dLive) return;
  const c = camera.position;
  for (let i = 0; i < DROP_N; i++) {
    const d = DROPS[i]; if (!d.on) continue;
    d.age += dt;
    if (d.age >= d.life || d.y < WATER_Y - 2) { d.on = false; dLive--; drops.setMatrixAt(i, HIDDEN); continue; }
    d.vy -= d.g * dt; d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
    if (d.vy < 0 && d.y < WATER_Y + 12 && d.y < SURF(d.x, d.z)) { d.on = false; dLive--; drops.setMatrixAt(i, HIDDEN); continue; }
    const dx = c.x - d.x, dy = c.y - d.y, dz = c.z - d.z, l = Math.hypot(dx, dy, dz) || 1;
    // a drop close to the camera shrinks away (one flying past the lens would cover the screen as a white blot: a geyser under the
    // plane, a jet landing on my ship)
    const k = d.age / d.life, s = (d.s0 + (d.s1 - d.s0) * k) * (k < 0.75 ? 1 : (1 - k) / 0.25) * (l < 16 ? Math.max(0, (l - 4) / 12) : 1);
    if (s < 0.02) { drops.setMatrixAt(i, HIDDEN); continue; }
    Quaternion.RotationYawPitchRollToRef(Math.atan2(dx, dz), -Math.asin(dy / l), i, DQ);
    D.quaternion.copyFrom(DQ); D.position.set(d.x, d.y, d.z); D.scale.setAll(s); drops.setMatrixAt(i, D.updateMatrix());
  }
  drops.update();
}
// for the tests: how many drops fly, whether the model is drawn
export const monFxCount = () => dLive;
export const monModel = () => V;
