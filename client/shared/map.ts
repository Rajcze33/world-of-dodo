// World of DODO, issue #16: the world of the real Karlín, the same on the client and the server. The city comes from karlin.json
// (made by tools/karlin from OpenStreetMap + IPR Praha, never edited by hand); this module turns it into what the game asks of it:
// the solids (buildings, the Negrelli viaduct, the construction site, the depot hall) and the collisions against them, the height of
// the ground, the street graph with routes, the pedestrians' loops, the parked cars' spots, the tanks' spawn points, the tram's loop.
// It replaces the invented 7 × 7 street grid of the original (client/src/world/grid.ts) and the server's hand-kept copy of it
// (server/city.js is now a thin wrapper over this file).
//
// Units: 1 unit = 1.5 m (UNIT_M), heights already scaled (karlin.json's frame). x east, z south. Polygons as in geom.ts.
// Everything is computed once, at import, from the data alone and in a fixed order: the client and the server derive the same
// spawn points, kerb spots and loops (only + - * / sqrt decide anything, see geom.ts).
import RAW from './karlin.json' with { type: 'json' };
import {
  pointInPoly, closestOnPoly, segSeg, polyArea, polyBox, polyReverse, polylineCum, polylineAt, insetPoly, simplify,
  distSeg2, Hash, astar, type Box, type Near, type At,
} from './geom.ts';
import { makeSite, type Site, type SiteSolid } from './site.ts';

// ---------- the data file (client/shared/karlin.json; its schema: client/shared/KARLIN-DATA.md and the issue #16 brief) ----------
export interface Building {
  p: number[]; h: number; y0?: number; r: 0 | 1 | 2; rh: number; f: number; c: number; k?: string; far?: 1;
}
export interface Edge { a: number; b: number; pts: number[]; w: number; c: 0 | 1 | 2 | 3 | 4; n?: string; tram?: 1 }
export interface KarlinData {
  v: 1;
  attribution: string[];
  osmDate: string;
  frame: { lat0: number; lon0: number; rotDeg: number; unitM: number; hScale: number; cx: number; cz: number };
  arena: [number, number, number, number];
  outer: [number, number, number, number];
  buildings: Building[];
  roads: { nodes: number[]; edges: Edge[] };
  blocks: number[][];
  plazas: number[][];
  tram: { loop: number[]; stops: number[]; tracks: number[][] };
  rail: { pts: number[]; deck: number; bridge: 0 | 1 }[];
  farRoads?: { pts: number[]; w: number; y?: number }[];   // the streets outside the arena, drawn only (y: a bridge's deck)
  water: number[][];
  parks: number[][];
  trees: number[];
  lots: number[][];
  landmarks: Record<string, { x: number; z: number; rot: number; b: number }>;
  terrain: { x0: number; z0: number; step: number; nx: number; nz: number; h: number[] };
}
export const DATA = RAW as unknown as KarlinData;
// how long each stage of building the city took at import, in ms (tools/test-map.ts reports it; it must stay quick on both sides)
export const BUILD_MS: Record<string, number> = {};
let lapT = Date.now();
const lap = (k: string) => { const t = Date.now(); BUILD_MS[k] = t - lapT; lapT = t; };

// squared length of (x, z) by plain products (x ** 2 is Math.pow, which engines need not round alike)
const dd = (x: number, z: number) => x * x + z * z;
const sq = Math.sqrt, r2 = (v: number) => Math.round(v * 100) / 100, r4 = (v: number) => Math.round(v * 1e4) / 1e4;
// polygons with the interior on the right (karlin.json promises it; one turned the other way would push tanks INTO buildings)
const ccw = (p: number[]) => polyArea(p) < 0 ? polyReverse(p) : p;

export const UNIT_M = 1.5;
// tanks, bots and cars stay inside ARENA (replaces the old WORLD_LIM square); the planes fly within ±AIR_LIM of the middle
export const ARENA = { x0: DATA.arena[0], z0: DATA.arena[1], x1: DATA.arena[2], z1: DATA.arena[3] };
export const OUTER = { x0: DATA.outer[0], z0: DATA.outer[1], x1: DATA.outer[2], z1: DATA.outer[3] };
export const AIR_LIM = Math.min(-OUTER.x0, -OUTER.z0, OUTER.x1, OUTER.z1) - 50;
export const inArena = (x: number, z: number, m = 0) => x >= ARENA.x0 + m && x <= ARENA.x1 - m && z >= ARENA.z0 + m && z <= ARENA.z1 - m;

// ---------- the terrain ----------
// bilinear over DATA.terrain (clamped at its border): 0 in and round the arena, the river bed, Vítkov, Letná
export function terrainH(x: number, z: number): number {
  const T = DATA.terrain; if (T.nx < 2 || T.nz < 2) return T.h[0] || 0;
  let fx = (x - T.x0) / T.step, fz = (z - T.z0) / T.step;
  fx = fx < 0 ? 0 : fx > T.nx - 1 ? T.nx - 1 : fx; fz = fz < 0 ? 0 : fz > T.nz - 1 ? T.nz - 1 : fz;
  const ix = Math.min(T.nx - 2, Math.floor(fx)), iz = Math.min(T.nz - 2, Math.floor(fz)), tx = fx - ix, tz = fz - iz, H = T.h, k = iz * T.nx + ix;
  return (H[k] * (1 - tx) + H[k + 1] * tx) * (1 - tz) + (H[k + T.nx] * (1 - tx) + H[k + T.nx + 1] * tx) * tz;
}

// ---------- the street graph ----------
// r = junction radius: a car leaves the edge's polyline r before the node and crosses the junction on a curve
export interface RNode { i: number; x: number; z: number; e: number[]; r: number }
// pts from node a to node b, cum the cumulative lengths, nv the right-hand normals at the points (mitred), for edgePos's offsets
export interface REdge { i: number; a: number; b: number; pts: [number, number][]; cum: number[]; len: number; w: number; c: number; n?: string; tram?: boolean; nv: number[] }
export const NODES: RNode[] = [];
export const EDGES: REdge[] = [];
{
  const N = DATA.roads.nodes;
  for (let i = 0; i < N.length / 2; i++) NODES.push({ i, x: N[2 * i], z: N[2 * i + 1], e: [], r: 0 });
  for (const d of DATA.roads.edges) {
    let pts: [number, number][] = []; for (let k = 0; k < d.pts.length; k += 2) pts.push([d.pts[k], d.pts[k + 1]]);
    const A = NODES[d.a], d2 = (p: [number, number], n: RNode) => dd(p[0] - n.x, p[1] - n.z);
    if (pts.length > 1 && d2(pts[0], A) > d2(pts[pts.length - 1], A)) pts = pts.reverse();   // the polyline runs from a to b
    const cum = polylineCum(pts), nv: number[] = [], n = pts.length;
    for (let k = 0; k < n; k++) {                                     // mitred normals: the offset lane keeps its width round bends
      const nr = (j: number) => { const dx = pts[j + 1][0] - pts[j][0], dz = pts[j + 1][1] - pts[j][1], l = sq(dx * dx + dz * dz) || 1; return [-dz / l, dx / l]; };
      const a = nr(Math.max(0, k - 1)), b = nr(Math.min(n - 2, k)), mx = a[0] + b[0], mz = a[1] + b[1], c = Math.max(0.25, (1 + a[0] * b[0] + a[1] * b[1]) / 2);
      nv.push(mx / (2 * c), mz / (2 * c));
    }
    const e: REdge = { i: EDGES.length, a: d.a, b: d.b, pts, cum, len: cum[n - 1], w: d.w, c: d.c, nv };
    if (d.n) e.n = d.n; if (d.tram) e.tram = true;
    EDGES.push(e); NODES[d.a].e.push(e.i); if (d.b !== d.a) NODES[d.b].e.push(e.i);
  }
  for (const n of NODES) {                                            // junctions get the half width of their widest street + a corner
    if (n.e.length < 2) continue;
    let w = 0, sh = Infinity; for (const k of n.e) { w = Math.max(w, EDGES[k].w); sh = Math.min(sh, EDGES[k].len); }
    n.r = Math.min(n.e.length >= 3 ? w / 2 + 1.5 : w / 4, 0.4 * sh);
  }
}
lap('graph');
// the point s along edge e (from node a), off to the right of the a→b direction: x, z, and hx, hz the direction a→b there
export function edgePos(e: REdge, s: number, off: number, out?: { x: number; z: number; hx: number; hz: number }) {
  const o = out || { x: 0, z: 0, hx: 0, hz: 1 }, at = polylineAt(e.pts, e.cum, s, AT), k = at.k, j = Math.min(k + 1, e.pts.length - 1);
  const sl = e.cum[j] - e.cum[k], t = sl > 0 ? Math.min(1, Math.max(0, (Math.min(Math.max(s, 0), e.len) - e.cum[k]) / sl)) : 0;
  const nx = e.nv[2 * k] * (1 - t) + e.nv[2 * j] * t, nz = e.nv[2 * k + 1] * (1 - t) + e.nv[2 * j + 1] * t;
  o.x = at.x + nx * off; o.z = at.z + nz * off; o.hx = at.hx; o.hz = at.hz; return o;
}
const AT: At = { x: 0, z: 0, hx: 1, hz: 0, k: 0 };
const SEGS = new Hash<[number, number]>(OUTER.x0, OUTER.z0, OUTER.x1, OUTER.z1, 16);   // every segment of every edge: [edge, k]
for (const e of EDGES) for (let k = 0; k + 1 < e.pts.length; k++) {
  const [ax, az] = e.pts[k], [bx, bz] = e.pts[k + 1]; SEGS.add([Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz)], [e.i, k]);
}
const SEGQ: [number, number][] = [];
// the street centre line nearest to (x,z): the edge, s along it from node a, d the distance, off the side (+ right of a→b);
// null only when there are no streets at all
export function nearestEdge(x: number, z: number): { e: REdge; s: number; d: number; off: number } | null {
  if (!EDGES.length) return null;
  for (let R = 8; ; R *= 3) {
    let bd = Infinity, be = -1, bk = 0;
    for (const [ei, k] of SEGS.query(x - R, z - R, x + R, z + R, SEGQ)) {
      const [ax, az] = EDGES[ei].pts[k], [bx, bz] = EDGES[ei].pts[k + 1], d = distSeg2(x, z, ax, az, bx, bz);
      if (d < bd) { bd = d; be = ei; bk = k; }
    }
    if (be >= 0 && bd <= R * R || R > 4 * (OUTER.x1 - OUTER.x0)) {
      if (be < 0) return null;
      const e = EDGES[be], [ax, az] = e.pts[bk], [bx, bz] = e.pts[bk + 1], dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
      const t = l2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / l2)) : 0, side = dx * (z - az) - dz * (x - ax);
      return { e, s: e.cum[bk] + t * sq(l2), d: sq(bd), off: side >= 0 ? sq(bd) : -sq(bd) };
    }
  }
}
const NODEH = new Hash<RNode>(OUTER.x0, OUTER.z0, OUTER.x1, OUTER.z1, 32), NODEQ: RNode[] = [];
for (const n of NODES) NODEH.add([n.x, n.z, n.x, n.z], n);
// the node nearest to (x,z) (-1 if there are none)
export function nearestNode(x: number, z: number): number {
  for (let R = 32; R < 8 * (OUTER.x1 - OUTER.x0); R *= 3) {
    let bd = Infinity, bi = -1;
    for (const n of NODEH.query(x - R, z - R, x + R, z + R, NODEQ)) { const d = dd(n.x - x, n.z - z); if (d < bd) { bd = d; bi = n.i; } }
    if (bi >= 0 && bd <= R * R) return bi;
  }
  return -1;
}
// the shortest edge between two nodes (null if they are not neighbours)
export function edgeBetween(a: number, b: number): REdge | null {
  let best: REdge | null = null;
  for (const k of NODES[a].e) { const e = EDGES[k]; if ((e.a === a && e.b === b || e.a === b && e.b === a) && (!best || e.len < best.len)) best = e; }
  return best;
}
// the shortest way along the streets from node to node (A* by length): the nodes, from and to included; [] if there is none.
// Every street is two-way here (the brief: one-way streets cut by the arena's edge would trap the cars).
export function route(from: number, to: number): number[] {
  const T = NODES[to]; if (!T || !NODES[from]) return [];
  return astar(NODES.length, from, to, (i, visit) => { for (const k of NODES[i].e) { const e = EDGES[k]; visit(e.a === i ? e.b : e.a, e.len); } },
    i => sq(dd(NODES[i].x - T.x, NODES[i].z - T.z)));
}

// ---------- the ground: blocks (pavements, courtyards) and plazas are 0.3 up, the carriageway 0 ----------
// A raster of 1-unit cells over the arena says road (0), paved (1) or "a kerb runs through it" (2); only the last asks the
// polygons. Built once (scanlines for the inside, a walk along every edge for the kerb cells).
const GROUND: number[][] = [...DATA.blocks.map(ccw), ...DATA.plazas.map(ccw)];
const GBOX = GROUND.map(polyBox), GH = new Hash<number>(ARENA.x0, ARENA.z0, ARENA.x1, ARENA.z1, 16), GQ: number[] = [];
GROUND.forEach((p, i) => GH.add(GBOX[i], i));
const GC = 1, GX = ARENA.x0, GZ = ARENA.z0, GNX = Math.max(1, Math.ceil((ARENA.x1 - ARENA.x0) / GC)), GNZ = Math.max(1, Math.ceil((ARENA.z1 - ARENA.z0) / GC));
const GCLS = new Uint8Array(GNX * GNZ);
{
  const xs: number[] = [];
  for (const p of GROUND) {
    const n = p.length, b = polyBox(p);
    for (let j = Math.max(0, Math.floor((b[1] - GZ) / GC)), j1 = Math.min(GNZ - 1, Math.floor((b[3] - GZ) / GC)); j <= j1; j++) {
      const zc = GZ + (j + 0.5) * GC; xs.length = 0;
      for (let i = 0, k = n - 2; i < n; k = i, i += 2) { const zi = p[i + 1], zk = p[k + 1]; if ((zi > zc) !== (zk > zc)) xs.push(p[i] + (zc - zi) * (p[k] - p[i]) / (zk - zi)); }
      xs.sort((a, c) => a - c);
      for (let m = 0; m + 1 < xs.length; m += 2) {
        for (let i = Math.max(0, Math.ceil((xs[m] - GX) / GC - 0.5)), i1 = Math.min(GNX - 1, Math.floor((xs[m + 1] - GX) / GC - 0.5)); i <= i1; i++) {
          if (GCLS[j * GNX + i] === 0) GCLS[j * GNX + i] = 1;
        }
      }
    }
    for (let i = 0; i < n; i += 2) {                                  // the kerb: every cell its edges pass through (a grid walk)
      const k = i + 2 < n ? i + 2 : 0, x = (p[i] - GX) / GC, z = (p[i + 1] - GZ) / GC; const ex = (p[k] - GX) / GC, ez = (p[k + 1] - GZ) / GC;
      let cx = Math.floor(x), cz = Math.floor(z); const tx = Math.floor(ex), tz = Math.floor(ez), dx = ex - x, dz = ez - z;
      const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1, ddx = dx !== 0 ? Math.abs(1 / dx) : Infinity, ddz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
      let mx = dx !== 0 ? (dx > 0 ? cx + 1 - x : x - cx) * ddx : Infinity, mz = dz !== 0 ? (dz > 0 ? cz + 1 - z : z - cz) * ddz : Infinity;
      for (let guard = 0; guard < 4 * (GNX + GNZ); guard++) {
        if (cx >= 0 && cx < GNX && cz >= 0 && cz < GNZ) GCLS[cz * GNX + cx] = 2;
        if (cx === tx && cz === tz) break;
        if (mx < mz) { if (mx > 1) break; mx += ddx; cx += sx; } else { if (mz > 1) break; mz += ddz; cz += sz; }
      }
    }
  }
  // the carriageways win over the polygons: a street the block faces left out (a dead end into a block, a lane through one) is road
  const FULL = new Uint8Array(GNX * GNZ), PART = new Uint8Array(GNX * GNZ), HD = 0.7072 * GC;   // HD: half a cell's diagonal
  for (const e of EDGES) for (let k = 0; k + 1 < e.pts.length; k++) {
    const [ax, az] = e.pts[k], [bx, bz] = e.pts[k + 1], hw = e.w / 2;
    for (let j = Math.max(0, Math.floor((Math.min(az, bz) - hw - GZ) / GC)), j1 = Math.min(GNZ - 1, Math.floor((Math.max(az, bz) + hw - GZ) / GC)); j <= j1; j++) {
      for (let i = Math.max(0, Math.floor((Math.min(ax, bx) - hw - GX) / GC)), i1 = Math.min(GNX - 1, Math.floor((Math.max(ax, bx) + hw - GX) / GC)); i <= i1; i++) {
        const d = sq(distSeg2(GX + (i + 0.5) * GC, GZ + (j + 0.5) * GC, ax, az, bx, bz));
        if (d + HD <= hw) FULL[j * GNX + i] = 1; else if (d - HD < hw) PART[j * GNX + i] = 1;
      }
    }
  }
  for (let c = 0; c < GCLS.length; c++) if (FULL[c]) GCLS[c] = 0; else if (PART[c] && GCLS[c]) GCLS[c] = 2;
}
const MAXHW = EDGES.reduce((m, e) => Math.max(m, e.w / 2), 0);
// within a street's carriageway (half its width from its centre line)?
function inStreet(x: number, z: number): boolean {
  for (const [ei, k] of SEGS.query(x - MAXHW, z - MAXHW, x + MAXHW, z + MAXHW, SEGQ)) {
    const e = EDGES[ei], [ax, az] = e.pts[k], [bx, bz] = e.pts[k + 1];
    if (distSeg2(x, z, ax, az, bx, bz) <= e.w * e.w / 4) return true;
  }
  return false;
}
lap('ground');
// paved: inside a block (pavement, courtyard) or a plaza, and not on a street; outside the arena nothing is
export function paved(x: number, z: number): boolean {
  const i = Math.floor((x - GX) / GC), j = Math.floor((z - GZ) / GC);
  if (i < 0 || j < 0 || i >= GNX || j >= GNZ) return false;
  const c = GCLS[j * GNX + i]; if (c < 2) return c === 1;
  for (const k of GH.query(x, z, x, z, GQ)) { const b = GBOX[k]; if (x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3] && pointInPoly(GROUND[k], x, z)) return !inStreet(x, z); }
  return false;
}
// the height of the ground: 0 on the carriageway, 0.3 on blocks and plazas, the terrain outside the arena
export function groundH(x: number, z: number): number {
  if (x < ARENA.x0 || x > ARENA.x1 || z < ARENA.z0 || z > ARENA.z1) return terrainH(x, z);
  return paved(x, z) ? 0.3 : 0;
}
// on a carriageway: inside the arena by m, on no block or plaza, and near a street's centre line (m away from its kerbs too)
const NR: Near = { x: 0, z: 0, d2: 0, nx: 0, nz: 0, e: 0, t: 0 };
export function onRoad(x: number, z: number, m = 0): boolean {
  if (!inArena(x, z, m) || paved(x, z)) return false;
  const ne = nearestEdge(x, z); if (!ne || ne.d > ne.e.w / 2 + 1 - m) return false;
  if (m > 0) for (const k of GH.query(x - m, z - m, x + m, z + m, GQ)) if (closestOnPoly(GROUND[k], x, z, NR).d2 < m * m) return false;
  return true;
}

// ---------- the solids ----------
// A solid is a footprint polygon extruded from y0 to h. b: the building's index in DATA.buildings; top: the roof's ridge (a pitched
// roof counts half its height in h, as a box would average it); site: a construction-site box; road: a road bridge's pier (issue #20).
export interface Solid { i: number; p: number[]; y0: number; h: number; box: Box; kind?: string; far?: boolean; b?: number; top?: number; site?: boolean; road?: boolean }
export const LOW_Y = 2.5;                                             // solids reaching below this stop tanks and cars
export const VIADUCT_W = 6.5, PIER_STEP = 11, PIER_L = 2;             // the Negrelli viaduct: deck width, arch spacing, pier length
export const SOLIDS: Solid[] = [];
const addSolid = (p: number[], y0: number, h: number, more: Partial<Solid>) => {
  const q = ccw(p), s: Solid = Object.assign({ i: SOLIDS.length, p: q, y0, h, box: polyBox(q) }, more); SOLIDS.push(s); return s;
};
const rect = (x0: number, z0: number, x1: number, z1: number) => [x0, z0, x1, z0, x1, z1, x0, z1];
// a w-wide strip along a→b (a quad, interior on the right)
const strip = (ax: number, az: number, bx: number, bz: number, w: number) => {
  const dx = bx - ax, dz = bz - az, l = sq(dx * dx + dz * dz) || 1, nx = -dz / l * w / 2, nz = dx / l * w / 2;
  return [ax - nx, az - nz, bx - nx, bz - nz, bx + nx, bz + nz, ax + nx, az + nz];
};
DATA.buildings.forEach((b, k) => {
  if (b.p.length < 6) return;
  const y0 = b.y0 || 0, h = b.h > y0 ? b.h : y0 + b.h, rh = b.rh || 0;   // h is the cornice's height; a smaller one is taken as above y0
  const s = addSolid(b.p, y0, h + rh / 2, { b: k }); if (rh) s.top = h + rh;
  if (b.k) s.kind = b.k; if (b.far) s.far = true;
});
// how far (x,z) is from the nearest carriageway's edge (negative: on it)
const roadGap = (x: number, z: number) => { const n = nearestEdge(x, z); return n ? n.d - n.e.w / 2 : Infinity; };
// World of DODO, issue #20 (warships): where a bridge crosses the Vltava, its piers stand in the river every SPAN at most (real spans,
// a ship passes between them), from the river bed (client/shared/naval.ts BED_Y) up to the deck. crossings(): the stretches of a
// bridge's line over the water (a sample every half unit), joined across dry gaps under GAP_MAX: such a gap inside the river is a pier
// the data maps as a hole in the riverbank (the Negrelli viaduct's) or a lock's wall, and gets a pier of ours on it. pierSpots(): where
// the piers of one crossing go: on every such gap, and evenly between them (and the banks) where the open water runs longer than SPAN.
export const SPAN = 30, RIVER_BED = -8;
const GAP_MAX = 8, WATERS = DATA.water.map(ccw), WBOX = WATERS.map(polyBox), WH = new Hash<number>(OUTER.x0, OUTER.z0, OUTER.x1, OUTER.z1, 32), WQ: number[] = [];
WATERS.forEach((p, i) => WH.add(WBOX[i], i));
const wet = (x: number, z: number) => { for (const i of WH.query(x, z, x, z, WQ)) { const b = WBOX[i]; if (x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3] && pointInPoly(WATERS[i], x, z)) return true; } return false; };
interface Crossing { s0: number; s1: number; gaps: [number, number][] }
function crossings(P: number[], cum: number[], L: number): Crossing[] {
  const out: Crossing[] = [], at: At = { x: 0, z: 0, hx: 1, hz: 0, k: 0 }; let cur: Crossing | null = null, dry0 = -1;
  for (let s = 0.25; s < L; s += 0.5) {
    polylineAt(P, cum, s, at);
    if (wet(at.x, at.z)) {
      if (cur && dry0 >= 0) { if (s - dry0 <= GAP_MAX) cur.gaps.push([dry0, s]); else { out.push(cur); cur = null; } }
      if (!cur) cur = { s0: s, s1: s, gaps: [] };
      cur.s1 = s; dry0 = -1;
    } else if (cur && dry0 < 0) dry0 = s;
  }
  if (cur) out.push(cur);
  return out;
}
function pierSpots(c: Crossing): number[] {
  const fixed = c.gaps.map(g => (g[0] + g[1]) / 2), stops = [c.s0, ...fixed, c.s1], o: number[] = [];
  for (let k = 0; k + 1 < stops.length; k++) {
    const a = stops[k], b = stops[k + 1], n = Math.ceil((b - a) / SPAN);
    if (k > 0) o.push(a);
    for (let j = 1; j < n; j++) o.push(a + (b - a) * j / n);
  }
  return o;
}
// The viaduct (rail parts marked bridge): its deck as a slab from deck - 1 to deck, in pieces of at most 12 units (small boxes for the
// hashes), and piers every PIER_STEP from the ground (the river bed in the river) to the deck's underside, except where a street
// passes: there it is an arch a tank drives through. Railway on the ground (bridge 0) is drawn, not solid.
for (const r of DATA.rail) {
  if (!r.bridge) continue;
  const P = r.pts, cum = polylineCum(P), L = cum[cum.length - 1], X = crossings(P, cum, L);   // X: over the Vltava (issue #20)
  for (let k = 0; k + 3 < P.length; k += 2) {
    const ax = P[k], az = P[k + 1], bx = P[k + 2], bz = P[k + 3], sl = cum[(k >> 1) + 1] - cum[k >> 1], n = Math.max(1, Math.ceil(sl / 12));
    for (let j = 0; j < n; j++) {
      const t0 = j / n, t1 = (j + 1) / n;
      addSolid(strip(ax + (bx - ax) * t0, az + (bz - az) * t0, ax + (bx - ax) * t1, az + (bz - az) * t1, VIADUCT_W), r.deck - 1, r.deck, { kind: 'deck' });
    }
  }
  const at: At = { x: 0, z: 0, hx: 1, hz: 0, k: 0 };
  for (let s = PIER_STEP / 2; s < L; s += PIER_STEP) {
    if (X.some(c => s > c.s0 - 1 && s < c.s1 + 1)) continue;          // over the river: its own piers, below
    polylineAt(P, cum, s, at);
    const hx = at.hx * PIER_L / 2, hz = at.hz * PIER_L / 2, ax = at.x - hx, az = at.z - hz, bx = at.x + hx, bz = at.z + hz;
    // the full width first, then narrower (Prvního pluku runs right beside the viaduct: a full pier would stand in it, a slim one
    // still carries the arches); none fits: a street passes under here, the arch stays open
    for (const w of [VIADUCT_W, 4, 2.6]) {
      const q = strip(ax, az, bx, bz, w);
      let gap = roadGap(at.x, at.z); for (let i = 0; i < 8; i += 2) gap = Math.min(gap, roadGap(q[i], q[i + 1]));
      if (gap < (w === VIADUCT_W ? 1 : 0.6)) continue;
      addSolid(q, Math.min(0, terrainH(at.x, at.z)), r.deck - 1, { kind: 'pier' }); break;
    }
  }
  for (const c of X) for (const s of pierSpots(c)) {                  // issue #20: in the river every SPAN at most, the full width
    polylineAt(P, cum, s, at);
    const hx = at.hx * PIER_L / 2, hz = at.hz * PIER_L / 2;
    addSolid(strip(at.x - hx, at.z - hz, at.x + hx, at.z + hz, VIADUCT_W), RIVER_BED, r.deck - 1, { kind: 'pier' });
  }
}
// the empty lots: the biggest is kept for the construction site, the depot takes the next that fits its hall
const LOTS = DATA.lots.length ? DATA.lots : [[ARENA.x1 + 20, ARENA.z1 + 20, ARENA.x1 + 320, ARENA.z1 + 90]];   // no lot: outside, out of reach
const towards = (x: number, z: number): [number, number] => { const n = nearestEdge(x, z); if (!n) return [0, -1]; const p = edgePos(n.e, n.s, 0); return [p.x - x, p.z - z]; };
// World of DODO, issue #16: the construction site is OFF for now. Karlín's biggest empty lot is too small for it (58 × 31 u: no house,
// no containers), and the maintainer (4. 11.) would rather have none than a made-up one until a real building site in Karlín is
// chosen (issue #17). SITE_LOT = that lot [x0, z0, x1, z1] (or LOTS[0]) brings it back, drawn, solid and on the minimap (client/shared/site.ts).
const SITE_LOT = null as number[] | null;
export const SITE: Site | null = SITE_LOT ? (() => {
  const [x0, z0, x1, z1] = SITE_LOT, [fx, fz] = towards((x0 + x1) / 2, (z0 + z1) / 2);
  return makeSite(x0, z0, x1, z1, fx, fz);
})() : null;
if (SITE) for (const b of SITE.solids) addSolid(rect(b.x0, b.z0, b.x1, b.z1), 0, b.h, { kind: b.kind, site: true });
// The DODO depot hall (22 deep × 32 long × 10.5, as in the original) on a lot: its long side along the lot's, its docks (the front,
// direction (sin rot, cos rot)) towards the nearest street, with a yard of up to 14 in front. park: where a tank starts when no
// spawn point is free (the old depot.park), in the yard or else on the street in front.
export interface Depot { x: number; z: number; rot: number; fx: number; fz: number; w: number; d: number; h: number; p: number[] | null; park: { x: number; z: number; h: number } }
export const DEPOT: Depot = (() => {
  const HW = 22, HD = 32, A = SITE && SITE.area, over = (l: number[]) => !!A && l[0] < A.x1 + 1 && l[2] > A.x0 - 1 && l[1] < A.z1 + 1 && l[3] > A.z0 - 1;
  const cand = LOTS.slice(1).filter(l => !over(l)), fit = (l: number[]) => Math.min(l[2] - l[0], l[3] - l[1]) >= HW + 3 && Math.max(l[2] - l[0], l[3] - l[1]) >= HD + 3;
  let lot = cand.find(fit) || null;
  if (!lot && cand.length) lot = cand.reduce((a, b) => Math.min(a[2] - a[0], a[3] - a[1]) >= Math.min(b[2] - b[0], b[3] - b[1]) ? a : b);
  if (lot && Math.min(lot[2] - lot[0], lot[3] - lot[1]) >= 10) {    // a smaller hall on a smaller lot, but not a shed
    const [x0, z0, x1, z1] = lot, lx = x1 - x0 >= z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, [tx, tz] = towards(cx, cz);
    const sh = lx ? z1 - z0 : x1 - x0, lg = lx ? x1 - x0 : z1 - z0, w = Math.min(HW, sh - 2), d = Math.min(HD, lg - 2);
    const fx = lx ? 0 : tx >= 0 ? 1 : -1, fz = lx ? (tz >= 0 ? 1 : -1) : 0;
    const back = lx ? (fz > 0 ? z0 : z1) : (fx > 0 ? x0 : x1), front = lx ? (fz > 0 ? z1 : z0) : (fx > 0 ? x1 : x0), f = fx + fz;   // f = ±1
    const bw = f > 0 ? Math.max(back + 1, front - w - 14) : Math.min(back - 1, front + w + 14), mid = bw + f * w / 2;   // back wall, centre across
    const x = lx ? cx : mid, z = lx ? mid : cz, p = lx ? rect(x - d / 2, z - w / 2, x + d / 2, z + w / 2) : rect(x - w / 2, z - d / 2, x + w / 2, z + d / 2);
    addSolid(p, 0, 10.5, { kind: 'depot' });
    return { x, z, rot: r4(Math.atan2(fx, fz)), fx, fz, w, d, h: 10.5, p, park: { x: x + fx * (w / 2 + 6), z: z + fz * (w / 2 + 6), h: r4(Math.atan2(fx, fz)) } };
  }
  return { x: 0, z: 0, rot: 0, fx: 0, fz: 1, w: 0, d: 0, h: 0, p: null, park: { x: 0, z: 0, h: 0 } };   // no lot: placed on a spawn below
})();

// World of DODO, issue #20: the road bridges over the Vltava (DATA.farRoads pieces with a deck height y that cross the river; the
// generator keeps their decks at least 3.5, the underside 2 over the water): the deck as a slab from y - 1 to y in pieces of at most
// 12 (kind 'roaddeck': shells and planes hit it; out of the tanks' reach, never in the low hash) and piers in the river as the
// railway's, ROAD_PIER_L long along the road and a unit wider than it.
export const ROAD_PIER_L = 2.2;
for (const r of DATA.farRoads || []) {
  if (r.y === undefined) continue;
  const P = r.pts, cum = polylineCum(P), L = cum[cum.length - 1], X = crossings(P, cum, L); if (!X.length) continue;
  for (let k = 0; k + 3 < P.length; k += 2) {
    const ax = P[k], az = P[k + 1], bx = P[k + 2], bz = P[k + 3], sl = cum[(k >> 1) + 1] - cum[k >> 1], n = Math.max(1, Math.ceil(sl / 12));
    for (let j = 0; j < n; j++) {
      const t0 = j / n, t1 = (j + 1) / n;
      addSolid(strip(ax + (bx - ax) * t0, az + (bz - az) * t0, ax + (bx - ax) * t1, az + (bz - az) * t1, r.w), r.y - 1, r.y, { kind: 'roaddeck' });
    }
  }
  const at: At = { x: 0, z: 0, hx: 1, hz: 0, k: 0 };
  for (const c of X) for (const s of pierSpots(c)) {
    polylineAt(P, cum, s, at);
    const hx = at.hx * ROAD_PIER_L / 2, hz = at.hz * ROAD_PIER_L / 2;
    addSolid(strip(at.x - hx, at.z - hz, at.x + hx, at.z + hz, r.w + 1), RIVER_BED, r.y - 1, { kind: 'pier', road: true });
  }
}

// the two hashes: every solid (rays, planes, parcels), and the low ones (tanks, cars, free ground)
const HALL = new Hash<Solid>(OUTER.x0, OUTER.z0, OUTER.x1, OUTER.z1, 16), HLOW = new Hash<Solid>(OUTER.x0, OUTER.z0, OUTER.x1, OUTER.z1, 16);
for (const s of SOLIDS) { HALL.add(s.box, s); if (s.y0 < LOW_Y) HLOW.add(s.box, s); }
lap('solids');
const Q1: Solid[] = [], Q2: Solid[] = [], STAMP = new Int32Array(SOLIDS.length); let stampN = 0;
const NB: Near = { x: 0, z: 0, d2: 0, nx: 0, nz: 0, e: 0, t: 0 };
const inBox = (b: Box, x: number, z: number) => x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3];

// every solid whose box overlaps x0..x1 × z0..z1 (into out, cleared first)
export function solidsIn(x0: number, z0: number, x1: number, z1: number, out: Solid[] = []): Solid[] { return HALL.query(x0, z0, x1, z1, out); }
// a circle (centre px, pz, radius r) against the solids a tank hits (y0 below LOW_Y) and the edge of the arena: the deepest overlap
// {nx, nz, pen}, the normal pointing away from the obstacle, or null. Same contract as the original grid.ts: a centre inside a
// building (concave ones too) goes out through the nearest wall.
export function solidPush(px: number, pz: number, r: number): { nx: number; nz: number; pen: number } | null {
  let bn = 0, bx = 0, bz = 0;
  const take = (nx: number, nz: number, pen: number) => { if (pen > 0 && pen > bn) { bn = pen; bx = nx; bz = nz; } };
  take(-1, 0, px - (ARENA.x1 - r)); take(1, 0, ARENA.x0 + r - px); take(0, -1, pz - (ARENA.z1 - r)); take(0, 1, ARENA.z0 + r - pz);
  for (const s of HLOW.query(px - r, pz - r, px + r, pz + r, Q1)) {
    const inside = inBox(s.box, px, pz) && pointInPoly(s.p, px, pz), q = closestOnPoly(s.p, px, pz, NB);
    if (!inside && q.d2 >= r * r) continue;
    const d = sq(q.d2);
    if (d < 1e-6) take(q.nx, q.nz, r);                                // on the wall: out along its normal
    else if (inside) { exitOf(s, px, pz, r); take(EX[0], EX[1], EX[2]); }
    else take((px - q.x) / d, (pz - q.z) / d, r - d);
  }
  return bn > 0 ? { nx: bx, nz: bz, pen: bn } : null;
}
// The way out of solid s for a circle centre inside it: through the nearest wall behind which the circle lands free, else one where
// it at least lands outside every other solid, else simply the nearest. (Karlín's houses share their walls and leave gaps narrower
// than a tank: out through those the neighbour would push it straight back, and the two would toss it to and fro.) A tank never
// gets this deep on its own (it moves in steps of 0.4); this is for a spawn or a teleport gone wrong. Into EX: direction, depth.
const EX = [0, 0, 0], Q3: Solid[] = [], NX: Near = { x: 0, z: 0, d2: 0, nx: 0, nz: 0, e: 0, t: 0 };
function exitOf(s: Solid, px: number, pz: number, r: number) {
  const p = s.p, n = p.length; let bt = -1, bd = Infinity;
  for (let i = 0; i < n; i += 2) {
    const j = i + 2 < n ? i + 2 : 0, ax = p[i], az = p[i + 1], dx = p[j] - ax, dz = p[j + 1] - az, l2 = dx * dx + dz * dz; if (l2 === 0) continue;
    let t = ((px - ax) * dx + (pz - az) * dz) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = ax + dx * t, qz = az + dz * t, d2 = (qx - px) * (qx - px) + (qz - pz) * (qz - pz); if (d2 === 0) continue;
    const d = sq(d2), ux = (qx - px) / d, uz = (qz - pz) / d, tx = qx + ux * (r + 0.01), tz = qz + uz * (r + 0.01);   // where it lands
    let tier = inArena(tx, tz, r) ? 2 : 0;
    if (tier) for (const o of HLOW.query(tx - r, tz - r, tx + r, tz + r, Q3)) {   // s itself too: a concave house's other wing
      if (inBox(o.box, tx, tz) && pointInPoly(o.p, tx, tz)) { tier = 0; break; }
      if (closestOnPoly(o.p, tx, tz, NX).d2 < r * r) tier = 1;
    }
    if (tier > bt || tier === bt && d2 < bd) { bt = tier; bd = d2; EX[0] = ux; EX[1] = uz; EX[2] = d + r + 0.001; }   // a hair more: clean
  }
}
// is (x,z) inside the arena by m and at least m from every low solid? (the props are the client's business: grid.ts adds them)
export function freeAt(x: number, z: number, m: number): boolean { return inArena(x, z, m) && clearOfLow(x, z, m); }
function clearOfLow(x: number, z: number, m: number): boolean {
  for (const s of HLOW.query(x - m, z - m, x + m, z + m, Q1)) {
    if (inBox(s.box, x, z) && pointInPoly(s.p, x, z)) return false;
    if (m > 0 && closestOnPoly(s.p, x, z, NB).d2 < m * m) return false;
  }
  return true;
}
// the solid (x,y,z) is in, or null
export function solidAt(x: number, y: number, z: number): Solid | null {
  for (const s of HALL.query(x, z, x, z, Q1)) if (y >= s.y0 && y < s.h && pointInPoly(s.p, x, z)) return s;
  return null;
}
// a solid within m of (x,y,z) sideways and mt above its top (or below its base), or null: the planes' crash test
export function solidNear(x: number, y: number, z: number, m: number, mt = m): Solid | null {
  for (const s of HALL.query(x - m, z - m, x + m, z + m, Q1)) {
    if (y >= s.h + mt || y < s.y0 - mt) continue;
    if (inBox(s.box, x, z) && pointInPoly(s.p, x, z) || closestOnPoly(s.p, x, z, NB).d2 < m * m) return s;
  }
  return null;
}
// what a parcel now at (x,y,z), a moment ago at (px,py,pz), hit: the solid, the normal n, and top when it came down on the roof
export function solidHit(x: number, y: number, z: number, px: number, py: number, pz: number): { s: Solid; n: [number, number, number]; top?: number } | null {
  const s = solidAt(x, y, z); if (!s) return null;
  if (py >= s.h) return { s, n: [0, 1, 0], top: s.h };
  if (py < s.y0) return { s, n: [0, -1, 0] };
  const q = closestOnPoly(s.p, x, z, NB); return { s, n: [q.nx, 0, q.nz] };
}
// where the 3D segment a→b first enters solid s, at t ≥ t0 (as 0..1 along it), or 2
function prismT(s: Solid, ax: number, ay: number, az: number, dx: number, dy: number, dz: number, tmax: number): number {
  let t0 = 0, t1 = tmax;
  if (dy === 0) { if (ay < s.y0 || ay > s.h) return 2; }
  else { let u = (s.y0 - ay) / dy, v = (s.h - ay) / dy; if (u > v) { const w = u; u = v; v = w; } if (u > t0) t0 = u; if (v < t1) t1 = v; if (t0 > t1) return 2; }
  const b = s.box;                                                    // the box first: most solids end here
  if (dx === 0) { if (ax < b[0] || ax > b[2]) return 2; }
  else { let u = (b[0] - ax) / dx, v = (b[2] - ax) / dx; if (u > v) { const w = u; u = v; v = w; } if (u > t0) t0 = u; if (v < t1) t1 = v; if (t0 > t1) return 2; }
  if (dz === 0) { if (az < b[1] || az > b[3]) return 2; }
  else { let u = (b[1] - az) / dz, v = (b[3] - az) / dz; if (u > v) { const w = u; u = v; v = w; } if (u > t0) t0 = u; if (v < t1) t1 = v; if (t0 > t1) return 2; }
  const x0 = ax + dx * t0, z0 = az + dz * t0, x1 = ax + dx * t1, z1 = az + dz * t1;
  if (pointInPoly(s.p, x0, z0)) return t0;
  const p = s.p, n = p.length; let best = 2;
  for (let i = 0; i < n; i += 2) {
    const j = i + 2 < n ? i + 2 : 0, u = segSeg(x0, z0, x1, z1, p[i], p[i + 1], p[j], p[j + 1]);
    if (u >= 0) { const t = t0 + u * (t1 - t0); if (t < best) best = t; }
  }
  return best;
}
// walk the segment's ground track in pieces of 16 (in order, so the first hit ends the walk) and ask each solid once
function walk(H: Hash<Solid>, ax: number, az: number, bx: number, bz: number, test: (s: Solid, best: number) => number): number {
  const dx = bx - ax, dz = bz - az, n = Math.max(1, Math.ceil(sq(dx * dx + dz * dz) / 16)), q = ++stampN; let best = 1;
  if (q > 1e9) { STAMP.fill(0); stampN = 1; }
  for (let k = 0; k < n && k / n < best; k++) {
    const t0 = k / n, t1 = (k + 1) / n, x0 = ax + dx * t0, z0 = az + dz * t0, x1 = ax + dx * t1, z1 = az + dz * t1;
    for (const s of H.query(Math.min(x0, x1), Math.min(z0, z1), Math.max(x0, x1), Math.max(z0, z1), Q2)) {
      if (STAMP[s.i] === stampN) continue; STAMP[s.i] = stampN;
      const t = test(s, best); if (t < best) best = t;
    }
  }
  return best;
}
// the first solid on the 3D segment from a to b, as 0..1 along it; 1 if none (camera pull-in, line of sight, bullets). Same contract
// as the original grid.ts.
export function segHit(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  return walk(HALL, ax, az, bx, bz, (s, best) => prismT(s, ax, ay, az, dx, dy, dz, best));
}
// the first low solid taller than minH on the ground line from a to b, 0..1, 1 if none (the bots: can a parcel get there?)
export function lineHit(ax: number, az: number, bx: number, bz: number, minH = 1.5): number {
  const dx = bx - ax, dz = bz - az;
  return walk(HLOW, ax, az, bx, bz, (s, best) => s.h <= minH ? 2 : prismT(s, ax, 0.5 * (s.y0 + s.h), az, dx, 0, dz, best));
}

// ---------- the blocks and their pedestrians ----------
// ped: the pedestrians' walking loop, PED_IN inside the kerb, closed (pedCum has one entry more than the loop has points, the last
// is pedLen). Where a building stands closer to the kerb than that, the loop steps aside towards the kerb, and where one stands on the
// kerb (OSM's houses against the street widths the data guess) round it in the road, up to PED_OUT past the kerb. A block cut by the
// arena's edge gets an out-and-back loop along its streets (the walkers turn round at the edge). A block too thin for a loop keeps
// ped = [] and pedLen 0 (BLOCKS[i] is DATA.blocks[i]).
export interface Block { p: number[]; ped: number[]; pedCum: number[]; pedLen: number }
export const PED_IN = 1.4, PED_OUT = 4;                             // PED_OUT: how far past the kerb a loop may step round a house
export const BLOCKS: Block[] = DATA.blocks.map(b => {
  const p = ccw(b); let ped = insetPoly(p, PED_IN, 4) || [];
  if (ped.length) {
    // every half unit along the loop, clear of the low solids by 0.35: a blocked point goes out towards the kerb (and past it round a
    // house standing on it), else in behind. Stepping out and back in goes square (the point before at the new offset), so the loop
    // does not cut the house's corner. Along the arena's edge there is no street, only houses the edge cuts through: the loop walks
    // the block's streets and turns back there (out and back along the same line: still a closed loop for the walkers).
    const q: number[] = [], edge: boolean[] = []; let moved = false, ox = 0, oz = 0;   // ox, oz: the offset of the last point
    const nearEdge = (x: number, z: number) => Math.min(x - ARENA.x0, ARENA.x1 - x, z - ARENA.z0, ARENA.z1 - z) < PED_IN + 0.6;
    for (let i = 0, n = ped.length; i < n; i += 2) {
      const j = i + 2 < n ? i + 2 : 0, ax = ped[i], az = ped[i + 1], dx = ped[j] - ax, dz = ped[j + 1] - az, m = Math.max(1, Math.ceil(2 * sq(dx * dx + dz * dz)));
      for (let k = 0; k < m; k++) {
        const x = ax + dx * k / m, z = az + dz * k / m, eg = nearEdge(x, z); let fx = 0, fz = 0;
        if (!eg && !clearOfLow(x, z, 0.35)) {
          const kb = closestOnPoly(p, x, z, NB), l = sq(kb.d2);
          if (l > 0) {
            const ux = (kb.x - x) / l, uz = (kb.z - z) / l;
            search: for (const [sg, lim] of [[1, l + PED_OUT], [-1, 12]]) for (let t = 0.2; t <= lim; t += 0.2) {
              if (clearOfLow(x + sg * ux * t, z + sg * uz * t, 0.35)) { fx = sg * ux * t; fz = sg * uz * t; break search; }
            }
          }
          moved = true;
        }
        if ((fx !== ox || fz !== oz) && q.length) {                   // the offset changes: square, via the old point at the new
          const lx = q[q.length - 2] - ox, lz = q[q.length - 1] - oz;   // offset or this one at the old
          if (fx || fz) { if (clearOfLow(lx + fx, lz + fz, 0.35)) { q.push(lx + fx, lz + fz); edge.push(eg); } }
          else if (clearOfLow(x + ox, z + oz, 0.35)) { q.push(x + ox, z + oz); edge.push(eg); }
        }
        q.push(x + fx, z + fz); edge.push(eg); ox = fx; oz = fz;
      }
    }
    const ne = edge.length;
    if (edge.some(e => e)) {                                          // the longest run of street-side points, out and back
      let bs = -1, bl = 0;
      for (let s0 = 0; s0 < ne; s0++) {
        if (edge[s0] || !edge[(s0 - 1 + ne) % ne]) continue;          // runs start right after an edge point
        let l = 0; while (l < ne && !edge[(s0 + l) % ne]) l++;
        if (l > bl) { bl = l; bs = s0; }
      }
      const path: number[] = []; for (let k = 0; k < bl; k++) { const i = (bs + k) % ne; path.push(q[2 * i], q[2 * i + 1]); }
      const sp = bl >= 2 ? simplify(path, 0.05, false) : [];
      ped = sp.length >= 4 ? sp.slice() : [];
      for (let i = sp.length - 4; i >= 2 && ped.length; i -= 2) ped.push(sp[i], sp[i + 1]);
    } else if (moved) ped = simplify(q, 0.05);
  }
  const cum = ped.length ? polylineCum(ped, true) : [0];
  return { p, ped, pedCum: cum, pedLen: cum[cum.length - 1] };
});

lap('blocks');

// ---------- the tram ----------
// one closed loop (pts not repeating the first point; cum has one entry more, the last is len), the stops as arc lengths along it
export const TRAM_LOOP: { pts: [number, number][]; cum: number[]; len: number; stops: number[] } = (() => {
  const L = DATA.tram.loop, pts: [number, number][] = [];
  for (let k = 0; k + 1 < L.length; k += 2) pts.push([L[k], L[k + 1]]);
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  const cum = pts.length > 1 ? polylineCum(pts, true) : [0, 0];
  return { pts, cum, len: cum[cum.length - 1], stops: DATA.tram.stops.slice() };
})();

// ---------- where things may stand ----------
const JUNC = NODES.filter(n => n.e.length >= 2),   // junctions, and the rare corner that stayed a node
  JH = new Hash<RNode>(ARENA.x0, ARENA.z0, ARENA.x1, ARENA.z1, 32), JQ: RNode[] = [];
let JR = 0; for (const n of JUNC) { JH.add([n.x, n.z, n.x, n.z], n); JR = Math.max(JR, n.r); }
// how far (x,z) is from the nearest junction's corner (its node minus its radius)
const juncGap = (x: number, z: number, m: number) => {
  let g = Infinity; for (const n of JH.query(x - m - JR, z - m - JR, x + m + JR, z + m + JR, JQ)) g = Math.min(g, sq(dd(n.x - x, n.z - z)) - n.r);
  return g;
};
// Parked cars: along the kerbs every KERB_STEP, facing along the kerb (the block on their right: right-hand traffic), their middle
// KERB_OUT out in the road; not within 8 of a junction, not on a tram street or one too narrow to pass a parked car, not touching a
// solid (two circles of 1.0 at ±1.2, the car's collision shape) or another spot. e: the street's edge. In the order of the blocks
// and their kerbs: the traffic module picks from them with the city's seed.
export const KERB_STEP = 6.5, KERB_OUT = 1.1;
export const KERB_SPOTS: { x: number; z: number; h: number; e: number }[] = [];
{
  const H = new Hash<number>(ARENA.x0, ARENA.z0, ARENA.x1, ARENA.z1, 16), HQ: number[] = [];
  for (const B of BLOCKS) {
    const p = B.p, n = p.length;
    for (let i = 0; i < n; i += 2) {
      const j = i + 2 < n ? i + 2 : 0, ax = p[i], az = p[i + 1], dx = p[j] - ax, dz = p[j + 1] - az, l = sq(dx * dx + dz * dz);
      if (l < KERB_STEP) continue;
      const ux = dx / l, uz = dz / l, ox = uz * KERB_OUT, oz = -ux * KERB_OUT, cnt = Math.floor(l / KERB_STEP), s0 = (l - (cnt - 1) * KERB_STEP) / 2;
      for (let k = 0; k < cnt; k++) {
        const s = s0 + k * KERB_STEP, x = ax + ux * s + ox, z = az + uz * s + oz;
        if (!inArena(x, z, 3) || juncGap(x, z, 8) < 8) continue;
        const ne = nearestEdge(x, z); if (!ne || ne.e.tram || ne.e.w < 4.5 || ne.d > ne.e.w / 2) continue;
        if (paved(x, z) || paved(x + ux * 1.9, z + uz * 1.9) || paved(x - ux * 1.9, z - uz * 1.9)) continue;
        if (!clearOfLow(x + ux * 1.2, z + uz * 1.2, 1.0) || !clearOfLow(x - ux * 1.2, z - uz * 1.2, 1.0)) continue;
        let near = false; for (const o of H.query(x - 3, z - 3, x + 3, z + 3, HQ)) { const c = KERB_SPOTS[o]; if (dd(c.x - x, c.z - z) < 9) { near = true; break; } }
        if (near) continue;
        H.add([x, z, x, z], KERB_SPOTS.length); KERB_SPOTS.push({ x: r2(x), z: r2(z), h: r4(Math.atan2(ux, uz)), e: ne.e.i });
      }
    }
  }
}
lap('kerb');
// Spawn points for the tanks: on the carriageways' centre lines, at least 10 from junctions and 3 from solids, spread over the
// arena (farthest-point picking from the spot nearest the middle), facing along the street towards the middle. Tram streets only
// when the others do not give enough.
export const SPAWN_N = 40;
export const SPAWNS: { x: number; z: number; h: number }[] = [];
{
  const cand: { x: number; z: number; h: number; t: boolean }[] = [], at = { x: 0, z: 0, hx: 0, hz: 1 }, mx = (ARENA.x0 + ARENA.x1) / 2, mz = (ARENA.z0 + ARENA.z1) / 2;
  for (const e of EDGES) for (let s = 2; s < e.len - 2; s += 4) {
    edgePos(e, s, 0, at); const x = at.x, z = at.z;
    if (juncGap(x, z, 10) < 10) continue;
    if (!freeAt(x, z, 3) || paved(x, z)) continue;
    const f = (mx - x) * at.hx + (mz - z) * at.hz >= 0 ? 1 : -1;
    cand.push({ x: r2(x), z: r2(z), h: r4(Math.atan2(at.hx * f, at.hz * f)), t: !!e.tram });
  }
  let pool = cand.filter(c => !c.t); if (pool.length < SPAWN_N) pool = cand;
  if (pool.length) {
    let first = 0, fd = Infinity; pool.forEach((c, i) => { const d = dd(c.x - mx, c.z - mz); if (d < fd) { fd = d; first = i; } });
    const dist = pool.map(c => dd(c.x - pool[first].x, c.z - pool[first].z));
    SPAWNS.push(pool[first]);
    while (SPAWNS.length < Math.min(SPAWN_N, pool.length)) {
      let bi = -1, bd = -1; for (let i = 0; i < pool.length; i++) if (dist[i] > bd) { bd = dist[i]; bi = i; }
      if (bd <= 0) break;
      const c = pool[bi]; SPAWNS.push(c);
      for (let i = 0; i < pool.length; i++) dist[i] = Math.min(dist[i], dd(pool[i].x - c.x, pool[i].z - c.z));
    }
    for (let i = 0; i < SPAWNS.length; i++) { const { x, z, h } = SPAWNS[i]; SPAWNS[i] = { x, z, h }; }
  }
}
// the depot's start point must be free; else (or with no depot lot) the first spawn point
if (!freeAt(DEPOT.park.x, DEPOT.park.z, 2.5) && SPAWNS.length) {
  const c = DEPOT.p ? nearestEdge(DEPOT.x + DEPOT.fx * (DEPOT.w / 2 + 2), DEPOT.z + DEPOT.fz * (DEPOT.w / 2 + 2)) : null, at = c ? edgePos(c.e, c.s, 0) : null;
  if (at && freeAt(at.x, at.z, 2.5)) DEPOT.park = { x: r2(at.x), z: r2(at.z), h: r4(Math.atan2(at.hx, at.hz)) };
  else {
    let b = SPAWNS[0], bd = Infinity; for (const s of SPAWNS) { const d = dd(s.x - DEPOT.x, s.z - DEPOT.z); if (d < bd) { bd = d; b = s; } }
    DEPOT.park = { x: b.x, z: b.z, h: b.h };
    if (!DEPOT.p) { DEPOT.x = b.x; DEPOT.z = b.z; }
  }
}
export type { Site, SiteSolid };
lap('spawns');
