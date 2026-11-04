// World of DODO: the land around the city, for the planes (issue #14). Forests, villages with lit windows, farms, fields with
// hedgerows, country roads out of the city, a frozen river with a lake, a wind farm, a power line, an airfield, and low hills on the
// horizon beyond ±LAND_FLAT (inside it the ground stays flat at y = 0, the city's snow plane). Seen mostly from the air; the tanks
// (±250, fog to 300) only see its near edge through the fog.
//
// It draws from its own random numbers (rng(LAND_SEED)), never from R(): the order of R's calls fixes the city's props, which the
// server knows by index. Built last (main.ts), after everything else.
//
// Few draw calls on purpose (weak integrated GPUs): the static land is merged per material into four meshes (ground marks and hills,
// buildings, lights, light pools), the trees are thin instances (near and far, each culled by its own box), the hangar's logo is one
// more, and only the wind turbines' rotors and the warning lights move (onBeforeRender). Nothing casts a shadow.
// landHit() tells the planes whether a point is inside something solid: a coarse grid of buckets, cheap enough for every frame.
import { Vector3, Quaternion, type StandardMaterial } from '@babylonjs/core';
import { scene } from '../core/engine';
import {
  Bucket, tri, quad, ring, rectPoly, boxB, addGeo, bake, geoMesh, Inst, Dummy, compose, applyMatrix, cloneGeo, boxGeo, cylGeo, coneGeo,
  planeGeo, translate, rotateX, rotateZ, type P2, type P3, type Geo,
} from '../core/geo';
import { lambert, basic } from '../core/mat';
import { poolTex, logoTex } from '../core/tex';
import { COL, rgbInto } from '../core/colors';
import { rng } from '../core/util';

// ---------- what the rest of the game may want to know ----------
export const LAND_SEED = 1414;
export const LAND_FLAT = 560;                         // inside ±560 the ground is flat (y = 0); the hills rise beyond it
// the airfield: runway centre, heading of the runway (a heading h faces (sin h, cos h): east), its length and width
export const AIRFIELD = { x: -365, z: 400, h: Math.PI / 2, len: 170, w: 11 };
export const ROTOR_W = 0.75;                          // the wind turbines' rotors, rad/s (landHit checks the blades where they are)

// ---------- colours (the DODO palette, a few muted ones for wood and soil) ----------
const SNOW = COL.paper, ROOF = 0xe6ebe9, DARK = COL.charcoal, ROAD = COL.c80, ICE = 0x8fb9b4, BANK = 0x9aa3a0, HEDGE = 0x35594f,
  HEDGE_TOP = 0x8fa7a0, WOOD = 0x6b5d50, FURROW = 0xc3cac7, YARD = 0xdde2e0, RUNWAY = 0x4b5250, MARK = COL.c20, APRON = 0x6f7573,
  STEEL = COL.c60, WIRE = 0x2a302e, TEAL = COL.teal;
const WALLS = [COL.white, COL.white, COL.paper, COL.lgrey, COL.c20, COL.light, COL.grey];
const LIT = [COL.light, COL.lgrey];
const UP: P3 = [0, 1, 0];

// ---------- noise (hashed, so it needs no random numbers and does not depend on the build order) ----------
function hash(i: number, j: number) {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + LAND_SEED) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x: number, z: number) {
  const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j, u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm = (x: number, z: number) => vnoise(x / 230, z / 230) * 0.55 + vnoise(x / 97 + 31.7, z / 97 - 17.3) * 0.3 + vnoise(x / 41 - 7.1, z / 41 + 3.9) * 0.15;
const forestN = (x: number, z: number) => vnoise(x / 85 + 5.3, z / 85 - 2.1) * 0.75 + vnoise(x / 31, z / 31 + 9) * 0.25;
const sstep = (t: number) => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
const shade = (c: number, k: number) => (Math.min(255, ((c >> 16) & 255) * k) << 16) | (Math.min(255, ((c >> 8) & 255) * k) << 8) | Math.min(255, (c & 255) * k);

// ---------- the ground's height: 0 inside ±LAND_FLAT, the hills' grid outside (the same triangles the mesh is made of) ----------
const HSTEP = 20, HHALF = 1200, HN = HHALF * 2 / HSTEP + 1, HBASE = 0.15;   // HBASE: the hills sit just above the snow plane (-0.05)
const HGT = new Float32Array(HN * HN);
export function landH(x: number, z: number): number {
  if (Math.abs(x) <= LAND_FLAT && Math.abs(z) <= LAND_FLAT) return 0;
  const gx = (x + HHALF) / HSTEP, gz = (z + HHALF) / HSTEP; if (gx < 0 || gz < 0 || gx >= HN - 1 || gz >= HN - 1) return 0;
  const i = gx | 0, j = gz | 0, fx = gx - i, fz = gz - j, k = j * HN + i;
  const h00 = HGT[k], h10 = HGT[k + 1], h01 = HGT[k + HN], h11 = HGT[k + HN + 1];
  return fx > fz ? h00 + (h10 - h00) * fx + (h11 - h10) * fz : h00 + (h11 - h01) * fx + (h01 - h00) * fz;
}

// ---------- the solids for landHit, in a coarse grid ----------
// k 0: a box (centre x, z, turned by c = cos, s = sin as rectPoly, half sizes a × b, from y0 up to h, plus a gable roof rg high along
// its local x); 1: a cone (a tree, a spire: base radius a, h high); 2: an upright cylinder (radius a); 3: a turbine's rotor (hub at
// x, y0, z, facing c = cos yaw, s = sin yaw, blades a long and h half wide, phase b)
interface Sol { k: number; x: number; z: number; y0: number; h: number; a: number; b: number; c: number; s: number; rg: number }
const HC = 25, HH = 800, HNC = HH * 2 / HC;
const HIT: (Sol[] | null)[] = new Array(HNC * HNC).fill(null);
let HIT_TOP = 0;
function solid(o: Sol, rad: number) {
  HIT_TOP = Math.max(HIT_TOP, o.y0 + o.h + o.rg + (o.k === 3 ? o.a : 0));
  const i0 = Math.max(0, Math.floor((o.x - rad + HH) / HC)), i1 = Math.min(HNC - 1, Math.floor((o.x + rad + HH) / HC));
  const j0 = Math.max(0, Math.floor((o.z - rad + HH) / HC)), j1 = Math.min(HNC - 1, Math.floor((o.z + rad + HH) / HC));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) (HIT[j * HNC + i] ??= []).push(o);
}
const solBox = (x: number, z: number, rot: number, a: number, b: number, y0: number, h: number, rg = 0) =>
  solid({ k: 0, x, z, y0, h, a, b, c: Math.cos(rot), s: Math.sin(rot), rg }, Math.hypot(a, b));
const solCone = (x: number, z: number, y0: number, a: number, h: number) => solid({ k: 1, x, z, y0, h, a, b: 0, c: 0, s: 0, rg: 0 }, a);
const solCyl = (x: number, z: number, y0: number, a: number, h: number) => solid({ k: 2, x, z, y0, h, a, b: 0, c: 0, s: 0, rg: 0 }, a);
const rotorAng = (t: number, ph: number) => t * ROTOR_W + ph;

// For the planes, every frame: is the point (x, y, z) under the ground or a hill, or inside a house, a hangar, a pylon, a turbine
// (its blades where they are now), or a tree's canopy (a cone as high as the tree)? The city's own buildings are not in here.
export function landHit(x: number, y: number, z: number): boolean {
  if (y < landH(x, z)) return true;
  if (y > HIT_TOP) return false;
  const i = Math.floor((x + HH) / HC), j = Math.floor((z + HH) / HC);
  if (i < 0 || j < 0 || i >= HNC || j >= HNC) return false;
  const L = HIT[j * HNC + i]; if (!L) return false;
  for (const o of L) {
    const dx = x - o.x, dz = z - o.z, dy = y - o.y0;
    if (o.k === 0) {
      if (dy < 0) continue;
      const lx = Math.abs(dx * o.c - dz * o.s), lz = Math.abs(dx * o.s + dz * o.c);
      if (lx < o.a && lz < o.b && dy < o.h + o.rg * (1 - lz / o.b)) return true;
    } else if (o.k === 1) {
      if (dy >= 0 && dy < o.h) { const rr = o.a * (1 - dy / o.h); if (dx * dx + dz * dz < rr * rr) return true; }
    } else if (o.k === 2) {
      if (dy >= 0 && dy < o.h && dx * dx + dz * dz < o.a * o.a) return true;
    } else {
      const ax = dx * o.s + dz * o.c; if (Math.abs(ax) > 1.6) continue;              // along the rotor's axis
      const u = dx * o.c - dz * o.s, rr = Math.hypot(u, dy); if (rr > o.a) continue;
      if (rr < 1.6) return true;                                                     // the hub
      const th = rotorAng(performance.now() / 1000, o.b), ph = Math.atan2(dy, u);
      for (let k = 0; k < 3; k++) {
        let d = ph - (Math.PI / 2 + th + k * Math.PI * 2 / 3); d = Math.atan2(Math.sin(d), Math.cos(d));
        if (Math.abs(d) * rr < o.h + 0.5) return true;
      }
    }
  }
  return false;
}

// ---------- what is taken, for placing things while building (roads, water, buildings, the airfield) ----------
// capsules (a segment with a radius) in a coarse grid, padded so that one cell answers a query with a margin up to BPAD
const BCELL = 40, BHALF = 1240, BN = BHALF * 2 / BCELL, BPAD = 16;
let BUSY: (number[][] | null)[] = [];
function take(ax: number, az: number, bx: number, bz: number, r: number) {
  const p = r + BPAD, c = [ax, az, bx, bz, r];
  const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - p + BHALF) / BCELL)), i1 = Math.min(BN - 1, Math.floor((Math.max(ax, bx) + p + BHALF) / BCELL));
  const j0 = Math.max(0, Math.floor((Math.min(az, bz) - p + BHALF) / BCELL)), j1 = Math.min(BN - 1, Math.floor((Math.max(az, bz) + p + BHALF) / BCELL));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) (BUSY[j * BN + i] ??= []).push(c);
}
const takeLine = (pts: P2[], r: number) => { for (let i = 0; i < pts.length - 1; i++) take(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], r); };
function segD(x: number, z: number, c: number[]) {
  const dx = c[2] - c[0], dz = c[3] - c[1], l2 = dx * dx + dz * dz;
  const t = l2 ? Math.max(0, Math.min(1, ((x - c[0]) * dx + (z - c[1]) * dz) / l2)) : 0;
  return Math.hypot(x - c[0] - dx * t, z - c[1] - dz * t);
}
// true where something stands within m of (x, z), or inside the city with its forest (±325)
function busy(x: number, z: number, m: number) {
  if (Math.abs(x) < 325 && Math.abs(z) < 325) return true;
  const i = Math.floor((x + BHALF) / BCELL), j = Math.floor((z + BHALF) / BCELL);
  if (i < 0 || j < 0 || i >= BN || j >= BN) return true;
  const L = BUSY[j * BN + i]; if (!L) return false;
  for (const c of L) if (segD(x, z, c) < c[4] + m) return true;
  return false;
}
const sq = (x: number, z: number) => Math.max(Math.abs(x), Math.abs(z));

// ---------- the layout (x east, z south, 1 unit = 5 m) ----------
// country roads, from the city's edge (±163) out to the villages and on into the hills (valleys are cut for them there)
const ROADS: { p: P2[]; w: number }[] = [
  { w: 3.4, p: [[0, -163], [0, -230], [6, -300], [20, -360], [34, -410], [52, -466], [70, -530], [95, -640], [130, -850], [160, -1215]] },          // north
  { w: 3.4, p: [[163, -104], [230, -104], [300, -92], [370, -66], [430, -48], [500, -46], [570, -30], [680, 10], [900, 30], [1215, 50]] },            // east
  { w: 3.4, p: [[-163, 52], [-230, 52], [-300, 46], [-370, 38], [-430, 32], [-500, 26], [-570, 10], [-660, -6], [-850, -30], [-1215, -50]] },        // west
  { w: 3.4, p: [[156, 163], [168, 240], [172, 300], [160, 360], [135, 415], [118, 470], [112, 540], [100, 700], [80, 900], [60, 1215]] },             // south
  { w: 2.8, p: [[-156, 163], [-166, 230], [-196, 290], [-240, 330], [-282, 358], [-296, 368]] },                                                 // to the airfield
];
// the river: from the north-east hills along the north into the lake, and out of it south-west into the western hills
const LAKE = { x: -420, z: -385, rx: 78, rz: 52 };
const RIVER_IN: P2[] = [[1215, -760], [900, -640], [700, -560], [540, -492], [380, -462], [220, -474], [52, -468], [-100, -452], [-240, -430], [-340, -405], [-420, -385]];
const RIVER_OUT: P2[] = [[-420, -385], [-490, -330], [-530, -250], [-560, -160], [-600, -70], [-640, 0], [-700, 60], [-850, 120], [-1215, 180]];
const VILLAGES = [
  { x: 28, z: -390, r: 62, road: 0, church: true },
  { x: -430, z: 32, r: 70, road: 2, church: true },
  { x: 132, z: 420, r: 62, road: 3, church: true },
  { x: 425, z: -50, r: 40, road: 1, church: false },
];
const FARMS: [number, number, number][] = [[-480, 225, 0.3], [185, -385, -0.2], [385, 185, 0.6], [-225, -392, 0.1], [245, 478, -0.4], [-128, 440, 0.2], [-515, -60, 1.3]];
const FORESTS: [number, number, number, number][] = [   // x, z, radius x, radius z
  [430, -395, 95, 60], [295, -362, 48, 30], [-505, -470, 75, 55], [-290, -480, 60, 28], [-415, -205, 72, 58], [-205, 478, 72, 52],
  [25, 482, 85, 55], [440, 472, 95, 72], [375, 95, 42, 30], [-85, -385, 58, 34], [-520, 125, 40, 55], [255, -500, 70, 30],
];
const TURBINES: P2[] = [[468, -300], [486, -220], [500, -140], [505, 40], [512, 120], [515, 200], [500, 282]];
const SUBSTATION: P2 = [340, 372];
const LINES: P2[][] = [
  [[1215, 322], [900, 342], [700, 352], [560, 360], [432, 368], [358, 372]],
  [[340, 386], [334, 470], [320, 560], [300, 760], [282, 1000], [270, 1215]],
];

// ---------- building helpers ----------
let G = Bucket(), B = Bucket(), L = Bucket(), P = Bucket();   // ground marks and hills, buildings, lights, light pools
let r = rng(LAND_SEED);
let TREES: number[] = [];                                   // x, y, z, scale, height scale, yaw per tree
const ROT_SPEC: { x: number; y: number; z: number; yaw: number; ph: number }[] = [];
const BEACONS: { x: number; y: number; z: number; col: number }[] = [];

// a triangle or a quad facing along n (its winding turned to match: core/geo builds counter-clockwise fronts)
function face(bk: Bucket, v: P3[], n: P3, col: number) {
  const [a, b, c] = v, ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
  const d = (uy * wz - uz * wy) * n[0] + (uz * wx - ux * wz) * n[1] + (ux * wy - uy * wx) * n[2];
  if (v.length === 3) { if (d >= 0) tri(bk, a, b, c, col); else tri(bk, a, c, b, col); return; }
  if (d >= 0) quad(bk, v[0], v[1], v[2], v[3], col); else quad(bk, v[0], v[3], v[2], v[1], col);
}
// an axis-aligned flat patch at height y, facing up
const flat = (bk: Bucket, x0: number, z0: number, x1: number, z1: number, y: number, col: number) => quad(bk, [x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0], col);
// a local frame: origin x, z (ground y), turned by rot the way rectPoly turns (local x → (cos, -sin), local z → (sin, cos))
class Fr {
  c: number; s: number;
  constructor(public x: number, public z: number, public rot: number, public y = 0) { this.c = Math.cos(rot); this.s = Math.sin(rot); }
  p(lx: number, ly: number, lz: number): P3 { return [this.x + lx * this.c + lz * this.s, this.y + ly, this.z - lx * this.s + lz * this.c]; }
  n(nx: number, ny: number, nz: number): P3 { return [nx * this.c + nz * this.s, ny, -nx * this.s + nz * this.c]; }
}
// a square beam of thickness t from one point to another (as the crane's in world/city.ts)
const BQ = new Quaternion(), BV = new Vector3(), BZ = new Vector3(0, 0, 1), BP = new Vector3(), B1 = new Vector3(1, 1, 1), BM = new Float32Array(16);
function beam(bk: Bucket, x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, t: number, col: number) {
  BV.set(x2 - x1, y2 - y1, z2 - z1); const len = BV.length(); Quaternion.FromUnitVectorsToRef(BZ, BV.normalize(), BQ, 1e-6);
  compose(BP.set((x1 + x2) / 2, (y1 + y2) / 2, (z1 + z2) / 2), BQ, B1, BM); addGeo(bk, applyMatrix(boxGeo(t, t, len), BM), null, col);
}
// a rod: the same without its end caps (8 triangles instead of 12), for the pylons' lattice, the wires and the fence posts
const ROD: Geo = (() => { const g = boxGeo(1, 1, 1), k = 24; return { p: g.p.slice(0, k * 3), n: g.n.slice(0, k * 3), u: g.u.slice(0, k * 2), c: [] }; })();
const BS = new Vector3();
function rod(bk: Bucket, a: P3, b: P3, t: number, col: number) {
  BV.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]); const len = BV.length(); Quaternion.FromUnitVectorsToRef(BZ, BV.normalize(), BQ, 1e-6);
  compose(BP.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), BQ, BS.set(t, t, len), BM); addGeo(bk, applyMatrix(cloneGeo(ROD), BM), null, col);
}
// a smooth line through the points (Catmull-Rom), about step apart
function spline(Pts: P2[], step: number): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < Pts.length - 1; i++) {
    const p0 = Pts[Math.max(0, i - 1)], p1 = Pts[i], p2 = Pts[i + 1], p3 = Pts[Math.min(Pts.length - 1, i + 2)];
    const n = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t, f = (c: number) => 0.5 * (2 * p1[c] + (p2[c] - p0[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (3 * p1[c] - p0[c] - 3 * p2[c] + p3[c]) * t3);
      out.push([f(0), f(1)]);
    }
  }
  out.push(Pts[Pts.length - 1]); return out;
}
// a flat band along a line of points, from offset w0 to w1 across it, lying on the ground (the hills too) dy above it
function strip(bk: Bucket, pts: P2[], w: (i: number) => [number, number], dy: number, col: number) {
  const n = pts.length, N: P2[] = [];
  for (let i = 0; i < n; i++) { const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)], dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1; N.push([-dz / l, dx / l]); }
  const at = (i: number, o: number): P3 => { const x = pts[i][0] + N[i][0] * o, z = pts[i][1] + N[i][1] * o, h = landH(x, z); return [x, h + dy + (h > 0 ? 0.18 : 0), z]; };   // on the hills a little higher: the hills' triangles are coarser
  for (let i = 0; i < n - 1; i++) { const [a0, a1] = w(i), [b0, b1] = w(i + 1); face(bk, [at(i, a0), at(i, a1), at(i + 1, b1), at(i + 1, b0)], UP, col); }
}
// a soft pool of light on the ground (the city's lamps have the same)
function pool(x: number, z: number, s: number, y = 0.16) {
  quad(P, [x - s, y, z - s], [x - s, y, z + s], [x + s, y, z + s], [x + s, y, z - s], 0xffffff, [[0, 0], [0, 1], [1, 1], [1, 0]]);
}
// a street lamp at x, z, its head reaching towards (dx, dz), with its pool of light
function lamp(x: number, z: number, dx: number, dz: number, h = 5.2, ps = 7.5) {
  const hx = x + dx * 0.9, hz = z + dz * 0.9;
  boxB(B, x, 0, z, 0.22, h, 0.22, DARK); beam(B, x, h - 0.1, z, hx, h - 0.1, hz, 0.14, DARK);
  boxB(L, hx, h - 0.45, hz, 0.5, 0.3, 0.5, 0xffffff); pool(hx + dx * 1.5, hz + dz * 1.5, ps);
}
function tree(x: number, z: number, s: number, y = 0) {
  const sy = s * (0.88 + r() * 0.28); TREES.push(x, y, z, s, sy, r() * Math.PI * 2); solCone(x, z, y, 2.3 * s, 6.4 * sy);
}

// a house: walls w (along the ridge, local x) × d and h high, a gable roof rh high with snow on it, dark eaves, a chimney, windows
// (lit with the chance lit, in the city's two window colours), a door. Its solid goes to landHit, its ground to BUSY.
function house(x: number, z: number, rot: number, w: number, d: number, h: number, rh: number, wall: number, lit = 0.45, opt: { chimney?: boolean; roof?: number; door?: number; win?: boolean } = {}) {
  const f = new Fr(x, z, rot), hw = w / 2, hd = d / 2, o = 0.7, ye = h - o * rh / hd, top = h + rh, roof = opt.roof ?? ROOF;
  const Pl = rectPoly(x, z, w, d, rot); ring(B, Pl, -0.1, Pl, h, wall);
  for (const sg of [-1, 1]) {
    const e = sg * (hd + o);
    face(B, [f.p(-hw - o, ye, e), f.p(hw + o, ye, e), f.p(hw + o, top, 0), f.p(-hw - o, top, 0)], f.n(0, hd, sg * rh), roof);          // slope
    face(B, [f.p(sg * hw, h, -hd), f.p(sg * hw, h, hd), f.p(sg * hw, top, 0)], f.n(sg, 0, 0), wall);                                     // gable
    face(B, [f.p(-hw - o, ye - 0.35, e), f.p(hw + o, ye - 0.35, e), f.p(hw + o, ye, e), f.p(-hw - o, ye, e)], f.n(0, 0, sg), DARK);       // eaves
    for (const ex of [-1, 1]) face(B, [f.p(ex * (hw + o), ye - 0.35, e), f.p(ex * (hw + o), ye, e), f.p(ex * (hw + o), top, 0), f.p(ex * (hw + o), top - 0.35, 0)], f.n(ex, 0, 0), DARK);   // verges
  }
  if (opt.chimney !== false) { const lz = hd * 0.4 * (r() < 0.5 ? -1 : 1), lx = hw * (r() - 0.5) * 0.9, c = f.p(lx, top - rh * Math.abs(lz) / hd - 0.6, lz); boxB(B, c[0], c[1], c[2], 0.8, 2.1, 0.8, DARK, rot, SNOW); }
  if (opt.win !== false) {
    const win = (bk: Bucket, v: P3[], n: P3) => face(bk, v, n, bk === L ? LIT[(r() * 2) | 0] : DARK);
    const nw = Math.max(1, Math.floor(w / 3.4)), floors = h > 6.4 ? 2 : 1;
    for (const sg of [-1, 1]) for (let fl = 0; fl < floors; fl++) for (let k = 0; k < nw; k++) {
      const lx = -hw + (k + 0.5) * w / nw, y0 = 1.3 + fl * 3, lz = sg * (hd + 0.04);
      if (sg === 1 && k === 0 && fl === 0) { face(B, [f.p(lx - 0.6, 0, lz), f.p(lx + 0.6, 0, lz), f.p(lx + 0.6, 2.3, lz), f.p(lx - 0.6, 2.3, lz)], f.n(0, 0, 1), opt.door ?? TEAL); continue; }
      win(r() < lit ? L : B, [f.p(lx - 0.55, y0, lz), f.p(lx + 0.55, y0, lz), f.p(lx + 0.55, y0 + 1.4, lz), f.p(lx - 0.55, y0 + 1.4, lz)], f.n(0, 0, sg));
    }
    for (const sg of [-1, 1]) {
      const lx = sg * (hw + 0.04);
      for (const lz of d > 7 ? [-hd * 0.45, hd * 0.45] : [0]) win(r() < lit ? L : B, [f.p(lx, 1.3, lz - 0.55), f.p(lx, 1.3, lz + 0.55), f.p(lx, 2.7, lz + 0.55), f.p(lx, 2.7, lz - 0.55)], f.n(sg, 0, 0));
      if (rh > 2.8) win(r() < lit * 0.7 ? L : B, [f.p(lx, h + 0.5, -0.5), f.p(lx, h + 0.5, 0.5), f.p(lx, h + 1.6, 0.5), f.p(lx, h + 1.6, -0.5)], f.n(sg, 0, 0));
    }
  }
  solBox(x, z, rot, hw + o, hd + o, 0, ye, top - ye);
  take(x, z, x, z, Math.hypot(hw, hd) + 1);
}
// a village church: a nave with tall lit windows, a white tower with a clock and a copper-green spire
function church(x: number, z: number, rot: number) {
  const f = new Fr(x, z, rot);
  house(x, z, rot, 18, 9.5, 8, 5, COL.white, 0, { chimney: false, win: false });
  for (const sg of [-1, 1]) for (let k = 0; k < 4; k++) { const lx = -6 + k * 4, lz = sg * 4.79; face(L, [f.p(lx - 0.6, 2, lz), f.p(lx + 0.6, 2, lz), f.p(lx + 0.6, 5.6, lz), f.p(lx - 0.6, 5.6, lz)], f.n(0, 0, sg), COL.light); }
  const t = f.p(-11.6, 0, 0), th = 21;
  boxB(B, t[0], -0.1, t[2], 5.2, th + 0.1, 5.2, COL.lgrey, rot, COL.white);
  boxB(B, t[0], th, t[2], 5.8, 0.6, 5.8, COL.white, rot, COL.white);
  const tf = new Fr(t[0], t[2], rot), apex = tf.p(0, th + 10, 0), c4 = [tf.p(-2.6, th + 0.6, -2.6), tf.p(2.6, th + 0.6, -2.6), tf.p(2.6, th + 0.6, 2.6), tf.p(-2.6, th + 0.6, 2.6)];
  for (let k = 0; k < 4; k++) { const a = c4[k], b = c4[(k + 1) % 4]; face(B, [a, b, apex], [(a[0] + b[0]) / 2 - t[0], 1, (a[2] + b[2]) / 2 - t[2]], COL.green); }
  for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const q = (lx: number, ly: number, lz: number) => tf.p(nx * 2.62 + lx * nz, ly, nz * 2.62 + lz * nx);
    face(L, [q(-0.75, 15, -0.75), q(0.75, 15, 0.75), q(0.75, 16.5, 0.75), q(-0.75, 16.5, -0.75)], tf.n(nx, 0, nz), COL.lgrey);       // the clock
    face(B, [q(-0.6, 18, -0.6), q(0.6, 18, 0.6), q(0.6, 20.2, 0.6), q(-0.6, 20.2, -0.6)], tf.n(nx, 0, nz), DARK);                      // belfry
  }
  solBox(t[0], t[2], rot, 2.9, 2.9, 0, th + 0.6); solCone(t[0], t[2], th + 0.6, 3.7, 10);
  take(t[0], t[2], t[0], t[2], 5);
}

// ---------- the parts of the land ----------
function roads(all: P2[][]) {
  all.forEach((pts, k) => { const w = ROADS[k].w; strip(G, pts, () => [-w, w], 0.04, ROAD); takeLine(pts, w + 1.5); });
}
function water(): P2[][] {
  const inLake = (x: number, z: number, k: number) => ((x - LAKE.x) / LAKE.rx) ** 2 + ((z - LAKE.z) / LAKE.rz) ** 2 < k * k;
  const out: P2[][] = [];
  for (const raw of [RIVER_IN, RIVER_OUT]) {
    let pts = spline(raw, 6);
    // cut where the lake begins: the inflow ends at its shore, the outflow starts there
    if (raw === RIVER_IN) { const e = pts.findIndex(p => inLake(p[0], p[1], 0.9)); pts = pts.slice(0, e + 1); }
    else { let s = 0; while (s < pts.length - 1 && inLake(pts[s + 1][0], pts[s + 1][1], 0.9)) s++; pts = pts.slice(s); }
    const hw = (i: number) => 6.5 + 3 * vnoise(i * 0.04, raw === RIVER_IN ? 3.3 : 8.1);
    strip(G, pts, i => [-hw(i), hw(i)], 0.06, ICE);
    strip(G, pts, i => [hw(i), hw(i) + 2.4], 0.045, BANK); strip(G, pts, i => [-hw(i) - 2.4, -hw(i)], 0.045, BANK);
    takeLine(pts, 12.5); out.push(pts);
    // trees along the banks, here and there
    for (let i = 2; i < pts.length - 2; i += 2) for (const sg of [-1, 1]) {
      if (r() > 0.2) continue;
      const a = pts[i - 1], b = pts[i + 1], dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1, o = sg * (hw(i) + 6 + r() * 4);
      const x = pts[i][0] - dz / l * o, z = pts[i][1] + dx / l * o; if (!busy(x, z, 1.5)) tree(x, z, 0.8 + r() * 0.6, landH(x, z) - 0.2);
    }
  }
  // the lake: ice with a ragged shore, and a few ice-fishing huts on it
  const n = 48, Pl: P2[] = [], Ob: P2[] = [];
  for (let k = 0; k < n; k++) {
    const a = k / n * Math.PI * 2, f = 1 + 0.22 * (vnoise(k * 0.35, 7.7) - 0.5), x = LAKE.x + Math.cos(a) * LAKE.rx * f, z = LAKE.z + Math.sin(a) * LAKE.rz * f;
    Pl.push([x, z]); Ob.push([x + Math.cos(a) * 2.6, z + Math.sin(a) * 2.6]);
  }
  for (let k = 0; k < n; k++) {
    const a = Pl[k], b = Pl[(k + 1) % n], c = Ob[(k + 1) % n], d = Ob[k];
    face(G, [[LAKE.x, 0.065, LAKE.z], [a[0], 0.065, a[1]], [b[0], 0.065, b[1]]], UP, ICE);
    face(G, [[a[0], 0.045, a[1]], [b[0], 0.045, b[1]], [c[0], 0.045, c[1]], [d[0], 0.045, d[1]]], UP, BANK);
    if (r() < 0.25 && !busy(d[0] * 1.06 - LAKE.x * 0.06, d[1] * 1.06 - LAKE.z * 0.06, 1)) tree(d[0] * 1.06 - LAKE.x * 0.06, d[1] * 1.06 - LAKE.z * 0.06, 0.8 + r() * 0.7);
  }
  take(LAKE.x - LAKE.rx + LAKE.rz, LAKE.z, LAKE.x + LAKE.rx - LAKE.rz, LAKE.z, LAKE.rz * 1.15);
  for (const [dx, dz, c] of [[-22, -8, TEAL], [-14, 4, COL.c60], [10, -14, DARK], [26, 10, COL.light]] as [number, number, number][]) {
    const x = LAKE.x + dx, z = LAKE.z + dz, rot = r() * 3;
    house(x, z, rot, 2.6, 2, 1.8, 0.9, c, 0.6, { chimney: false });
  }
  return out;
}
// a low bridge where a road crosses the river: a deck a little above the ice with parapets and a lamp at each end
function bridges(roadPts: P2[][], riverPts: P2[][]) {
  for (const wp of riverPts) for (let j0 = 0; j0 < wp.length - 1; j0 += 10) {
    // the river in pieces of ten segments, each with its box: only the road segments in that box are tried
    const j1 = Math.min(wp.length - 1, j0 + 10); let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (let j = j0; j <= j1; j++) { x0 = Math.min(x0, wp[j][0]); x1 = Math.max(x1, wp[j][0]); z0 = Math.min(z0, wp[j][1]); z1 = Math.max(z1, wp[j][1]); }
    for (const rp of roadPts) for (let i = 0; i < rp.length - 1; i++) {
      const a = rp[i], b = rp[i + 1];
      if (Math.max(a[0], b[0]) < x0 || Math.min(a[0], b[0]) > x1 || Math.max(a[1], b[1]) < z0 || Math.min(a[1], b[1]) > z1) continue;
      for (let j = j0; j < j1; j++) {
        const c = wp[j], d = wp[j + 1], den = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]); if (Math.abs(den) < 1e-9) continue;
        const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / den, u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / den;
        if (t < 0 || t > 1 || u < 0 || u > 1) continue;
        const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t, rot = Math.atan2(-(b[1] - a[1]), b[0] - a[0]), y = landH(x, z) + 0.12, f = new Fr(x, z, rot, y);
        boxB(B, x, y, z, 30, 0.45, 8.4, COL.c60, rot, ROAD);
        for (const sg of [-1, 1]) { const q = f.p(0, 0.45, sg * 4); boxB(B, q[0], q[1], q[2], 30, 0.75, 0.4, COL.c20, rot, COL.white); }
        for (const e of [-1, 1]) { const sg = -e, q = f.p(e * 15.5, 0, sg * 5.5); lamp(q[0], q[2], -sg * f.s, -sg * f.c, 5.2, 6); }
      }
    }
  }
}
function villages(roadPts: P2[][]) {
  for (const V of VILLAGES) {
    const pts = roadPts[V.road], w = ROADS[V.road].w, placed: [number, number, number][] = [];
    const free = (x: number, z: number, rad: number) => !busy(x, z, rad - 4) && placed.every(([px, pz, pr]) => Math.hypot(x - px, z - pz) > rad + pr + 1.5);
    // the church first, set back from the road at the middle of the village
    let ci = 0, cd = 1e9; pts.forEach((p, i) => { const d = Math.hypot(p[0] - V.x, p[1] - V.z); if (d < cd) { cd = d; ci = i; } });
    const dir = (i: number): P2 => { const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
    if (V.church) {
      const [dx, dz] = dir(ci), x = pts[ci][0] + dz * 17, z = pts[ci][1] - dx * 17, rot = Math.atan2(-dz, dx);
      church(x, z, rot); placed.push([x, z, 13]);
      flat(G, Math.min(x, pts[ci][0]) - 4, Math.min(z, pts[ci][1]) - 4, Math.max(x, pts[ci][0]) + 4, Math.max(z, pts[ci][1]) + 4, 0.03, YARD);
    }
    let acc = 0, side = 1;
    for (let i = 1; i < pts.length; i++) {
      const [x, z] = pts[i]; acc += Math.hypot(x - pts[i - 1][0], z - pts[i - 1][1]);
      if (Math.hypot(x - V.x, z - V.z) > V.r) continue;
      if (acc < 7) continue; acc = 0;
      const [dx, dz] = dir(i), nx = dz, nz = -dx;
      // a lamp on alternate sides, every other step
      side = -side; if (side > 0) lamp(x + nx * side * (w + 1), z + nz * side * (w + 1), -nx * side, -nz * side);
      for (const sg of [-1, 1]) for (let row = 0; row < 2; row++) {
        if (r() < (row ? 0.6 : 0.2)) continue;
        const gable = r() < 0.6, hw = 4.5 + r() * 2, hd = 3.3 + r() * 0.8, across = gable ? hw : hd;
        const off = w + 3.5 + across + row * 22 + r() * 3, hx = x + nx * sg * off, hz = z + nz * sg * off, rad = Math.hypot(hw, hd) + 1;
        if (!free(hx, hz, rad)) continue;
        const rot = Math.atan2(-dz, dx) + (gable ? Math.PI / 2 : 0) + (r() - 0.5) * 0.1;
        house(hx, hz, rot, hw * 2, hd * 2, 4.2 + r() * 1.4 + (r() < 0.15 ? 2.6 : 0), 3 + r() * 1.3, WALLS[(r() * WALLS.length) | 0], 0.5);
        placed.push([hx, hz, rad]);
        // a garden tree or two behind it
        for (let t = 0; t < 2; t++) if (r() < 0.55) { const gx = hx + nx * sg * (across + 5 + r() * 4) + dx * (r() - 0.5) * 10, gz = hz + nz * sg * (across + 5 + r() * 4) + dz * (r() - 0.5) * 10; if (!busy(gx, gz, 1)) tree(gx, gz, 0.6 + r() * 0.5); }
      }
    }
    take(V.x, V.z, V.x, V.z, V.r * 0.75);
  }
}
// the nearest point of any road to (x, z)
function nearestRoad(roadPts: P2[][], x: number, z: number): P2 {
  let best: P2 = [x, z], bd = 1e9;
  for (const pts of roadPts) for (const p of pts) { const d = Math.hypot(p[0] - x, p[1] - z); if (d < bd) { bd = d; best = p; } }
  return best;
}
function farms(roadPts: P2[][]) {
  for (const [x, z, rot] of FARMS) {
    const f = new Fr(x, z, rot), yard = [f.p(-26, 0.03, -19), f.p(26, 0.03, -19), f.p(26, 0.03, 19), f.p(-26, 0.03, 19)];
    face(G, yard, UP, YARD);
    // the lane to the nearest road
    const rp = nearestRoad(roadPts, x, z), lane = spline([[x, z], [(x + rp[0]) / 2 + (r() - 0.5) * 20, (z + rp[1]) / 2 + (r() - 0.5) * 20], rp], 6).filter(p => Math.hypot(p[0] - x, p[1] - z) > 18);
    if (lane.length > 1 && Math.hypot(rp[0] - x, rp[1] - z) < 240) { strip(G, lane, () => [-2, 2], 0.05, COL.c60); takeLine(lane, 3.5); }
    let p = f.p(-12, 0, -7); house(p[0], p[2], rot, 12, 8, 5, 4, WALLS[(r() * 4) | 0], 0.5);
    p = f.p(9, 0, 4); house(p[0], p[2], rot + Math.PI / 2, 24, 12, 6.5, 5, WOOD, 0.06, { chimney: false, door: DARK });
    p = f.p(-15, 0, 10); house(p[0], p[2], rot, 10, 6, 3.4, 2, COL.c60, 0.1, { chimney: false });
    if (r() < 0.7) {                                                                          // a silo
      p = f.p(19, 0, -12); addGeo(B, translate(cylGeo(2.6, 2.6, 13, 10), p[0], 6.5, p[2]), null, COL.c20);
      addGeo(B, translate(coneGeo(2.9, 2.4, 10), p[0], 14.2, p[2]), null, COL.c60); solCyl(p[0], p[2], 0, 2.9, 15.4);
    }
    // a fence round the yard (a gap towards the lane), a lamp, trees
    const cs: P2[] = [[-26, -19], [26, -19], [26, 19], [-26, 19]];
    for (let e = 0; e < 4; e++) {
      const [ax, az] = cs[e], [bx, bz] = cs[(e + 1) % 4], len = Math.hypot(bx - ax, bz - az), n = Math.round(len / 3.5);
      for (let k = 0; k <= n; k++) { if (e === 2 && Math.abs(k - n / 2) < 2) continue; const q = f.p(ax + (bx - ax) * k / n, 0, az + (bz - az) * k / n); rod(B, q, [q[0], 1.3, q[2]], 0.18, WOOD); }
      rod(B, f.p(ax, 1.0, az), f.p(bx, 1.0, bz), 0.1, WOOD);
    }
    p = f.p(0, 0, 0); lamp(p[0], p[2], 0, 1, 5.5, 9);
    for (let t = 0; t < 6; t++) { const a = r() * Math.PI * 2, d = 30 + r() * 12, tx = x + Math.cos(a) * d, tz = z + Math.sin(a) * d; if (!busy(tx, tz, 1)) tree(tx, tz, 0.8 + r() * 0.7); }
    take(x, z, x, z, 33);
  }
}
function airfield() {
  const { x: ax, z: az, len, w } = AIRFIELD, x0 = ax - len / 2, x1 = ax + len / 2, hw = w / 2;
  flat(G, x0, az - hw, x1, az + hw, 0.05, RUNWAY);
  for (let x = x0 + 16; x < x1 - 16; x += 10) flat(G, x, az - 0.25, x + 5, az + 0.25, 0.1, MARK);                         // centre line
  for (const e of [x0 + 2, x1 - 9]) for (let k = 0; k < 8; k++) { if (k === 3 || k === 4) continue; const zz = az - hw + 0.8 + k * 1.22; flat(G, e, zz, e + 7, zz + 0.62, 0.1, MARK); }   // threshold bars
  flat(G, -347, 361, -293, 387, 0.05, APRON); flat(G, -327, 387, -317, az - hw, 0.05, APRON);                               // apron and taxiway
  take(x0 - 50, az, x1 + 8, az, 14); take(-345, 370, -293, 370, 22);
  // lights: white along the edges, green across the ends, a row of approach lights out west
  for (let x = x0; x <= x1 + 0.1; x += len / 14) for (const sg of [-1, 1]) boxB(L, x, 0, az + sg * (hw + 0.7), 0.45, 0.35, 0.45, COL.lgrey);
  for (const e of [x0 - 0.8, x1 + 0.8]) for (let k = -2.5; k <= 2.5; k++) boxB(L, e, 0, az + k * 1.9, 0.45, 0.35, 0.45, 0x5fe0b8);
  for (let x = x0 - 10; x > x0 - 60; x -= 9) for (const dz of [-2, 0, 2]) { boxB(B, x, 0, az + dz, 0.16, 0.6, 0.16, DARK); boxB(L, x, 0.6, az + dz, 0.5, 0.3, 0.5, COL.lgrey); }
  // the hangar: DODO teal, a dark roof with the white logo (seen from the air), the door half open with the light on inside
  const hx = -330, hz = 351, HW = 32, HD = 19, HT = 10;
  boxB(B, hx, -0.1, hz, HW, HT + 0.1, HD, TEAL, 0, DARK); boxB(B, hx, HT - 1.3, hz, HW + 0.4, 1.3, HD + 0.4, 0x005a52, 0, DARK);
  const zf = hz + HD / 2 + 0.05;
  face(B, [[hx - 12, 0, zf], [hx + 12, 0, zf], [hx + 12, 7.6, zf], [hx - 12, 7.6, zf]], [0, 0, 1], 0x4a5250);
  face(L, [[hx - 2, 0, zf + 0.02], [hx + 3.5, 0, zf + 0.02], [hx + 3.5, 7.6, zf + 0.02], [hx - 2, 7.6, zf + 0.02]], [0, 0, 1], COL.light);
  face(L, [[hx - 12, 7.75, zf], [hx + 12, 7.75, zf], [hx + 12, 8.15, zf], [hx - 12, 8.15, zf]], [0, 0, 1], COL.lgrey);
  pool(hx + 0.7, zf + 6, 9, 0.12);
  solBox(hx, hz, 0, HW / 2 + 0.2, HD / 2 + 0.2, 0, HT);
  const logo = geoMesh('landHangarLogo', translate(rotateX(planeGeo(22, 22 / 2.97), -Math.PI / 2), hx, HT + 0.06, hz), basic(0xffffff, { map: logoTex, transparent: true }), false, false);
  logo.freezeWorldMatrix();
  // the control tower with its lit cab and the beacon on top
  const tx = -300, tz = 349;
  boxB(B, tx, -0.1, tz, 4.2, 9.1, 4.2, COL.c20, 0, COL.c60); boxB(L, tx, 9, tz, 5, 2.6, 5, COL.light); boxB(B, tx, 11.6, tz, 5.8, 0.5, 5.8, DARK, 0, SNOW);
  beam(B, tx + 1.5, 12, tz + 1.5, tx + 1.5, 15, tz + 1.5, 0.12, DARK);
  BEACONS.push({ x: tx, y: 12.5, z: tz, col: 0x5fe0b8 }); solBox(tx, tz, 0, 2.9, 2.9, 0, 12.1);
  // floodlights over the apron, a windsock by the western end
  for (const fx of [-345, -296]) { boxB(B, fx, 0, 386.5, 0.35, 12, 0.35, DARK); boxB(L, fx, 12, 386.5, 1.6, 0.5, 0.6, 0xffffff); pool(fx + (fx < -320 ? 9 : -9), 374, 17, 0.12); solCyl(fx, 386.5, 0, 0.6, 12.5); }
  beam(B, x0 + 14, 0, az - hw - 9, x0 + 14, 6, az - hw - 9, 0.15, COL.c20);
  addGeo(B, translate(rotateZ(coneGeo(0.75, 3.6, 8), -Math.PI / 2), x0 + 15.9, 5.6, az - hw - 9), null, 0xf08a32);
}
function windFarm() {
  const HUB = 42;
  for (const [x, z] of TURBINES) {
    const yaw = -Math.PI / 2 + (r() - 0.5) * 0.12, sx = Math.sin(yaw), cz = Math.cos(yaw);
    addGeo(B, translate(cylGeo(0.75, 1.5, HUB, 10), x, HUB / 2, z), null, COL.lgrey);
    const nac = applyMatrix(boxGeo(2.2, 2.4, 6.5), compose(new Vector3(x - sx * 0.6, HUB + 0.9, z - cz * 0.6), Quaternion.RotationAxis(new Vector3(0, 1, 0), yaw), new Vector3(1, 1, 1)));
    addGeo(B, nac, null, COL.white);
    ROT_SPEC.push({ x: x + sx * 3.2, y: HUB + 0.9, z: z + cz * 3.2, yaw, ph: r() * 6 });
    BEACONS.push({ x: x - sx * 2.5, y: HUB + 2.4, z: z - cz * 2.5, col: 0xff3a30 });
    solCyl(x, z, 0, 1.7, HUB + 2.2);
    solid({ k: 3, x: x + sx * 3.2, z: z + cz * 3.2, y0: HUB + 0.9, h: 0.9, a: 19.8, b: ROT_SPEC[ROT_SPEC.length - 1].ph, c: Math.cos(yaw), s: Math.sin(yaw), rg: 0 }, 20);
    take(x, z, x, z, 6);
  }
}
// pylons along the lines, the wires between them, and the substation the lines run into
function power() {
  const [sx, sz] = SUBSTATION, f = new Fr(sx, sz, 0);
  flat(G, sx - 17, sz - 13, sx + 17, sz + 13, 0.035, 0xa3aaa7);
  for (const [px, pz] of [[-8, -4], [0, -4], [8, -4]]) {                                     // transformers with their fins
    boxB(B, sx + px, 0, sz + pz, 3.6, 3.4, 3, COL.c60, 0, COL.c80); for (const e of [-1, 1]) boxB(B, sx + px + e * 2, 0.4, sz + pz, 0.4, 2.6, 2.6, COL.c80);
    beam(B, sx + px, 3.4, sz + pz, sx + px, 5.4, sz + pz, 0.3, COL.c20);
  }
  for (const gx of [-12, 12]) for (const gz of [6, -10]) beam(B, sx + gx, 0, sz + gz, sx + gx, 11, sz + gz, 0.4, STEEL);   // the gantries
  for (const gz of [6, -10]) beam(B, sx - 12, 10.8, sz + gz, sx + 12, 10.8, sz + gz, 0.4, STEEL);
  for (const [ax, az, bx, bz] of [[-15, -13, 15, -13], [15, -13, 15, 13], [15, 13, -15, 13], [-15, 13, -15, -13]]) {   // the fence
    for (let k = 0; k < 6; k++) { const q = f.p(ax + (bx - ax) * k / 6, 0, az + (bz - az) * k / 6); rod(B, q, [q[0], 2.3, q[2]], 0.14, COL.c20); }
    rod(B, f.p(ax, 2.2, az), f.p(bx, 2.2, bz), 0.08, COL.c20); rod(B, f.p(ax, 1.1, az), f.p(bx, 1.1, bz), 0.08, COL.c20);
  }
  lamp(sx - 16, sz + 12, 1, 0, 6, 10); lamp(sx + 16, sz - 12, -1, 0, 6, 10);
  solBox(sx, sz, 0, 13, 11, 0, 11); take(sx, sz, sx, sz, 22);
  // the lines: pylons about 62 apart, across their line; four conductors and an earth wire
  const ARMS: [number, number][] = [[-7.2, 16.4], [7.2, 16.4], [-5.2, 21.4], [5.2, 21.4], [0, 28.6]];
  for (const route of LINES) {
    const pts = spline(route, 4), cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = cum[cum.length - 1], n = Math.round(total / 62), tops: P3[][] = [];
    takeLine(pts, 9);
    for (let k = 0; k <= n; k++) {
      const s = k / n * total; let i = 1; while (i < cum.length - 1 && cum[i] < s) i++;
      const t = (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1), x = pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, z = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t;
      if (sq(x, z) > 940) continue;                                                       // farther out the fog hides them
      const a = pts[Math.max(0, i - 2)], b = pts[Math.min(pts.length - 1, i + 1)], rot = Math.atan2(b[0] - a[0], b[1] - a[1]), y0 = landH(x, z) - 0.2;
      pylon(new Fr(x, z, rot, y0));
      const pf = new Fr(x, z, rot, y0); tops.push(ARMS.map(([lx, ly]) => pf.p(lx, ly, 0)));
      solBox(x, z, rot, 2.5, 2.5, y0, 29 - 0.2); solBox(x, z, rot, 7.6, 0.5, y0 + 17.5, 1.2); solBox(x, z, rot, 5.6, 0.5, y0 + 22.5, 1.2);
    }
    for (let k = 0; k < tops.length - 1; k++) for (let c = 0; c < ARMS.length; c++) {
      const a = tops[k][c], b = tops[k + 1][c], span = Math.hypot(b[0] - a[0], b[2] - a[2]), sag = 1.6 + span * 0.02, S = 4;
      if (span > 140) continue;
      const at = (t: number): P3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t];
      for (let q = 0; q < S; q++) rod(B, at(q / S), at((q + 1) / S), c === 4 ? 0.09 : 0.13, WIRE);
    }
  }
}
// a lattice pylon in its frame (local x across the line): four legs narrowing upwards, braces, two cross arms with insulators
function pylon(f: Fr) {
  const lv: [number, number][] = [[0, 2.5], [6, 2.0], [12, 1.5], [17.4, 1.0], [24, 0.75], [28, 0.5]];
  const C = (y: number, w: number, sx: number, sz: number) => f.p(sx * w, y, sz * w);
  for (let k = 0; k < lv.length - 1; k++) {
    const [y0, w0] = lv[k], [y1, w1] = lv[k + 1];
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) rod(B, C(y0, w0, sx, sz), C(y1, w1, sx, sz), 0.26, STEEL);
    for (const [ax, az, bx, bz] of [[-1, -1, 1, -1], [1, -1, 1, 1], [1, 1, -1, 1], [-1, 1, -1, -1]]) {
      if (k === 1 || k === 3) rod(B, C(y1, w1, ax, az), C(y1, w1, bx, bz), 0.14, STEEL);
      if (k < 3) rod(B, C(y0, w0, ax, az), C(y1, w1, bx, bz), 0.1, STEEL);
    }
  }
  for (const [y, span] of [[17.4, 7.4], [22.4, 5.4]]) {
    rod(B, f.p(-span, y, 0), f.p(span, y, 0), 0.32, STEEL);
    for (const sg of [-1, 1]) { rod(B, f.p(sg * span, y, 0), f.p(sg * 0.9, y + 2.4, 0), 0.12, STEEL); rod(B, f.p(sg * (span - 0.2), y, 0), f.p(sg * (span - 0.2), y - 1.0, 0), 0.22, COL.c20); }
  }
  rod(B, f.p(0, 28, 0), f.p(0, 28.8, 0), 0.2, STEEL);
}
// forests: patches of trees with ragged edges, about 7.5 apart
function forests() {
  for (const [fx, fz, rx, rz] of FORESTS) {
    for (let x = fx - rx; x <= fx + rx; x += 7.5) for (let z = fz - rz; z <= fz + rz; z += 7.5) {
      const tx = x + (r() - 0.5) * 6, tz = z + (r() - 0.5) * 6, e = ((tx - fx) / rx) ** 2 + ((tz - fz) / rz) ** 2;
      if (e > 0.72 + 0.4 * vnoise(tx / 25, tz / 25)) continue;
      if (busy(tx, tz, 2.5) || sq(tx, tz) > LAND_FLAT - 4) continue;
      tree(tx, tz, 1 + r() * 1.1 - e * 0.3);
    }
  }
}
const inForest = (x: number, z: number, m: number) => FORESTS.some(([fx, fz, rx, rz]) => ((x - fx) / (rx + m)) ** 2 + ((z - fz) / (rz + m)) ** 2 < 1.15);
// the fields: four patchworks (one per side of the city, each laid at its own angle), with hedgerows, tree rows and furrows
function fields() {
  const ANG = [0.17, -0.12, 0.3, -0.22];                      // east, south, west, north
  const side = (x: number, z: number) => Math.abs(x) > Math.abs(z) ? (x > 0 ? 0 : 2) : (z > 0 ? 1 : 3);
  const ok = (x: number, z: number, si: number) => side(x, z) === si && sq(x, z) > 332 && sq(x, z) < LAND_FLAT - 6 && !busy(x, z, 1.5) && !inForest(x, z, 4);
  for (let si = 0; si < 4; si++) {
    const c = Math.cos(ANG[si]), s = Math.sin(ANG[si]), W = (u: number, v: number): P2 => [u * c + v * s, -u * s + v * c];
    for (let u = -590; u < 590;) {
      const sw = 34 + r() * 30;
      for (let v = -590; v < 590;) {
        const fl = 45 + r() * 55, C4 = [W(u, v), W(u + sw, v), W(u + sw, v + fl), W(u, v + fl)], mid = W(u + sw / 2, v + fl / 2);
        v += fl;
        const okC = C4.filter(p => ok(p[0], p[1], si)).length;
        if (okC < 3 || !ok(mid[0], mid[1], si)) continue;
        // hedgerows (or a row of trees) along two of its edges, broken where a road, a house or the water is in the way
        for (const [a, b] of [[C4[0], C4[1]], [C4[3], C4[0]]] as [P2, P2][]) {
          const kind = r(); if (kind > 0.62) continue;
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.round(len / 5)), rot = Math.atan2(-(b[1] - a[1]), b[0] - a[0]);
          if (kind < 0.14) { for (let k = 1; k < n; k += 1 + (r() * 2 | 0)) { const x = a[0] + (b[0] - a[0]) * k / n, z = a[1] + (b[1] - a[1]) * k / n; if (!busy(x, z, 2)) tree(x, z, 0.65 + r() * 0.45); } continue; }
          let run = -1;
          for (let k = 0; k <= n; k++) {
            const x = a[0] + (b[0] - a[0]) * k / n, z = a[1] + (b[1] - a[1]) * k / n, good = k < n && !busy(x, z, 2) && sq(x, z) > 330;
            if (good && run < 0) run = k;
            if (!good && run >= 0) {
              const k1 = k, x0 = a[0] + (b[0] - a[0]) * run / n, z0 = a[1] + (b[1] - a[1]) * run / n, x1 = a[0] + (b[0] - a[0]) * k1 / n, z1 = a[1] + (b[1] - a[1]) * k1 / n;
              const hl = Math.hypot(x1 - x0, z1 - z0), ux = (x1 - x0) / (hl || 1), uz = (z1 - z0) / (hl || 1);
              for (let q = 0; q < hl - 2;) {                                               // bushes of uneven size, now and then a gap
                const bl = Math.min(hl - q, 5 + r() * 8), m = q + bl / 2;
                boxB(B, x0 + ux * m, -0.05, z0 + uz * m, bl, 0.8 + r() * 0.6, 1.2 + r() * 0.5, HEDGE, rot, HEDGE_TOP);
                q += bl + (r() < 0.3 ? 1 + r() * 3 : 0);
              }
              run = -1;
            }
          }
        }
        // ploughed furrows showing through the snow
        if (okC === 4 && r() < 0.32) for (let k = u + 3; k < u + sw - 3; k += 3.4) { const a = W(k, v - fl + 3), b = W(k + 1, v - fl + 3), cc = W(k + 1, v - 3), d = W(k, v - 3); face(G, [[a[0], 0.035, a[1]], [b[0], 0.035, b[1]], [cc[0], 0.035, cc[1]], [d[0], 0.035, d[1]]], UP, FURROW); }
        if (r() < 0.12) tree(C4[2][0], C4[2][1], 1 + r() * 0.8);                             // a lone tree in the corner
      }
      u += sw;
    }
  }
}
// the hills beyond ±LAND_FLAT: first their height grid (valleys cut where the roads and the river run), before anything is placed
// out there; at the end their mesh, flat-shaded snow with soft dark forest patches (vertex colours, so their edges blend) and grey
// rock on the steep faces
const WF = new Float32Array(HN * HN);                         // how much forest at each vertex
function heights(corridors: P2[][]) {
  // the corridors' segments out there, in a coarse grid padded by the valleys' reach: each vertex looks only at its own cell
  const VC = 60, VR = 125, VN = Math.ceil(HHALF * 2 / VC), VG: number[][][] = Array.from({ length: VN * VN }, () => []);
  for (const pts of corridors) for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1]; if (Math.max(sq(ax, az), sq(bx, bz)) < LAND_FLAT - VR) continue;
    const c = [ax, az, bx, bz, 0], cl = (v: number) => Math.max(0, Math.min(VN - 1, Math.floor((v + HHALF) / VC)));
    for (let j = cl(Math.min(az, bz) - VR); j <= cl(Math.max(az, bz) + VR); j++) for (let i2 = cl(Math.min(ax, bx) - VR); i2 <= cl(Math.max(ax, bx) + VR); i2++) VG[j * VN + i2].push(c);
  }
  for (let j = 0; j < HN; j++) for (let i = 0; i < HN; i++) {
    const x = -HHALF + i * HSTEP, z = -HHALF + j * HSTEP, d = sq(x, z), k = j * HN + i;
    if (d <= LAND_FLAT) { HGT[k] = 0; continue; }
    const t = sstep((d - LAND_FLAT) / 240), n = fbm(x, z);
    let h = t * (8 + 150 * n * n * (0.6 + 0.4 * sstep((d - 700) / 400)));
    let dm = 1e9; for (const c of VG[Math.min(VN - 1, Math.floor((z + HHALF) / VC)) * VN + Math.min(VN - 1, Math.floor((x + HHALF) / VC))]) { const q = segD(x, z, c); if (q < dm) dm = q; }
    h *= sstep((dm - 12) / 110);
    HGT[k] = HBASE + h;
    WF[k] = sstep((forestN(x, z) - 0.55) / 0.1) * sstep((h - 1) / 4) * (1 - sstep((h - 75) / 25));
  }
}
function hills() {
  const vcol = (k: number) => mixC(SNOW, 0x5f857e, WF[k]);
  for (let j = 0; j < HN - 1; j++) for (let i = 0; i < HN - 1; i++) {
    const x = -HHALF + i * HSTEP, z = -HHALF + j * HSTEP;
    if (Math.max(Math.abs(x + HSTEP / 2), Math.abs(z + HSTEP / 2)) < LAND_FLAT) continue;
    const k = j * HN + i, K = [k, k + 1, k + HN + 1, k + HN], V: P3[] = [[x, HGT[k], z], [x + HSTEP, HGT[k + 1], z], [x + HSTEP, HGT[k + HN + 1], z + HSTEP], [x, HGT[k + HN], z + HSTEP]];
    for (const [a, b, c] of [[0, 1, 2], [0, 2, 3]]) {
      const T = [V[a], V[b], V[c]], ux = T[1][0] - T[0][0], uy = T[1][1] - T[0][1], uz = T[1][2] - T[0][2], wx = T[2][0] - T[0][0], wy = T[2][1] - T[0][1], wz = T[2][2] - T[0][2];
      const ny = uz * wx - ux * wz, slope = Math.abs(ny) / (Math.hypot(uy * wz - uz * wy, ny, ux * wy - uy * wx) || 1);
      const jit = 1 - hash(i * 2 + (c === 3 ? 1 : 0), j) * 0.05 * Math.min(1, (1 - slope) * 25);   // facets only where it slopes: no seam at ±LAND_FLAT
      const cv = [K[a], K[b], K[c]].map(q => shade(slope < 0.74 ? mixC(vcol(q), 0xa2a8a6, 0.85) : vcol(q), jit));
      triV(G, T[0], T[1], T[2], cv[0], cv[1], cv[2]);
    }
  }
  // real trees on the hills' feet where their forest is; farther out the dark ground stands for it
  for (let x = -HHALF; x <= HHALF; x += 13) for (let z = -HHALF; z <= HHALF; z += 13) {
    const tx = x + (r() - 0.5) * 9, tz = z + (r() - 0.5) * 9, d = sq(tx, tz);
    if (d <= LAND_FLAT + 4 || d > 720 || forestN(tx, tz) < 0.6) continue;
    const y = landH(tx, tz); if (y < 1 || y > 80 || busy(tx, tz, 3)) continue;
    tree(tx, tz, 1.1 + r() * 0.9, y - 0.3);
  }
}
const mixC = (a: number, b: number, t: number) => {
  const m = (sh: number) => Math.round(((a >> sh) & 255) * (1 - t) + ((b >> sh) & 255) * t);
  return (m(16) << 16) | (m(8) << 8) | m(0);
};
// a triangle facing up with its own colour at each corner (the hills' soft patches); flat normal
const TC = [0, 0, 0];
function triV(bk: Bucket, a: P3, b: P3, c: P3, ca: number, cb: number, cc: number) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
  let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
  if (ny < 0) { [b, c] = [c, b]; [cb, cc] = [cc, cb]; nx = -nx; ny = -ny; nz = -nz; }
  const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
  for (const [v, col] of [[a, ca], [b, cb], [c, cc]] as [P3, number][]) {
    rgbInto(col, TC, 0); bk.p.push(v[0], v[1], v[2]); bk.n.push(nx, ny, nz); bk.u.push(0, 0); bk.c.push(TC[0], TC[1], TC[2]);
  }
}

// ---------- the meshes ----------
function treeGeo(): Geo {
  const g = Bucket();
  for (let i = 0; i < 3; i++) {
    const rr = 2.2 - i * 0.55, h = 2.6 - i * 0.4, y = 1.4 + i * 1.5;    // the city's tree (world/city.ts), five-sided and open below
    addGeo(g, translate(cylGeo(0, rr, h, 5, true), 0, y + h / 2, 0), null, TEAL);
    addGeo(g, translate(cylGeo(0, rr * 0.55, h * 0.4, 5, true), 0, y + h * 0.8, 0), null, SNOW);
  }
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
  r = rng(LAND_SEED); G = Bucket(); B = Bucket(); L = Bucket(); P = Bucket(); TREES = []; BUSY = new Array(BN * BN).fill(null);
  const roadPts = ROADS.map(rd => spline(rd.p, 6));
  heights([...roadPts, spline(RIVER_IN, 6), spline(RIVER_OUT, 6)]);
  roads(roadPts); const riverPts = water();
  bridges(roadPts, riverPts);
  airfield(); windFarm(); power();
  villages(roadPts); farms(roadPts);
  forests(); fields();
  hills();

  const gm = lambert(0xffffff); gm.zOffset = -1; gm.zOffsetUnits = -4;                   // drawn just in front of the city's snow plane, even far off
  bake('landGround', G, gm, false);                                                       // lies on the ground: takes the tanks' shadows
  geoMesh('landBuildings', B, lambert(0xffffff), false, false).freezeWorldMatrix();
  geoMesh('landLights', L, basic(0xffffff), false, false).freezeWorldMatrix();
  geoMesh('landPools', P, basic(COL.light, { map: poolTex, transparent: true, opacity: 0.2, depthWrite: false, additive: true }), false, false).freezeWorldMatrix();
  const near: number[] = [], far: number[] = [];
  for (let t = 0; t < TREES.length; t += 6) (sq(TREES[t], TREES[t + 2]) < LAND_FLAT ? near : far).push(t);
  const treeMat = lambert(0xffffff);
  treeInst('landTrees', near, treeMat); treeInst('landTreesFar', far, treeMat);
  // the rotors (turned every frame) and the warning lights (blinking together)
  const rg = Bucket();
  for (let k = 0; k < 3; k++) { const b = translate(boxGeo(1.1, 19, 0.35), 0, 10.3, 0); addGeo(rg, rotateZ(b, k * Math.PI * 2 / 3), null, COL.white); }
  addGeo(rg, translate(rotateX(coneGeo(1.2, 2.4, 8), Math.PI / 2), 0, 0, 0.9), null, COL.white);
  const rotors = new Inst('landRotors', rg, lambert(0xffffff), ROT_SPEC.length, { receive: false }), ro = new Dummy();
  const beacons = new Inst('landBeacons', boxGeo(0.75, 0.75, 0.75), basic(0xffffff), BEACONS.length, { receive: false, colors: true });
  BEACONS.forEach((b, i) => { ro.position.set(b.x, b.y, b.z); ro.rotation.set(0, 0, 0); ro.scale.setAll(1); beacons.setMatrixAt(i, ro.updateMatrix()); beacons.setColorAt(i, b.col); });
  beacons.update();
  const spin = () => {
    const t = performance.now() / 1000;
    ROT_SPEC.forEach((s, i) => { ro.position.set(s.x, s.y, s.z); ro.rotation.set(0, s.yaw, rotorAng(t, s.ph)); rotors.setMatrixAt(i, ro.updateMatrix()); });
    rotors.update(false); beacons.mesh.isVisible = t % 1.6 < 0.8;
  };
  spin(); scene.onBeforeRenderObservable.add(spin);
  G = Bucket(); B = Bucket(); L = Bucket(); P = Bucket(); BUSY = [];
}
