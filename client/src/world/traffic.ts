// The city's traffic: the cars on the streets, the tram on the avenue, the parked cars along the kerbs, and the body physics
// that lets a tank shove them about (the original's "moving traffic", "tram", "car physics", the parked cars of its WANTED
// section and updateTraffic).
//
// The server runs a copy of the traffic and the tram (server/world.js): the same N_CARS cars in the same order, the same tram
// track and the same rejoin. Keep the two in step (CONTRIBUTING.md). Before you join, updateTraffic drives this browser's
// own city (the intro); once you play, net/world.ts draws the server's and runs only the cars your tank pushes (updateDyn).
//
// World of DODO: TRAFFIC holds the traffic cars only. The original's delivery tanks, REDLINE's tanks and the police (the last
// three traffic cars, with a light bar and their own driver) are gone, and so are their branches in the code below.
import { TransformNode, type AbstractMesh, type Mesh } from '@babylonjs/core';
import { scene } from '../core/engine';
import { Bucket, boxB, quad, ring, cap, offsetPoly, rectPoly, addGeo, cylGeo, rotateZ, geoMesh, bake, Inst, Dummy, type P3 } from '../core/geo';
import { lambert, VC_MAT, VC_GLOW } from '../core/mat';
import { COL } from '../core/colors';
import { rng, R, now } from '../core/util';
import { CELL, HALF, roadC, blockC, TRAM_K, depot, free, solidPush, groundH } from './grid';
import { propsNear, knockProp } from './props';
import { CatmullRomCurve3 } from './catmull';
import { car } from '../game/state';
import type { Car, Row } from '../game/types';
import { WORLD, letGo } from '../net/world';

type V2 = [number, number];

// a car of the traffic: on its route (phase 'edge' along a street, 'turn' through a junction) or a free body ('dyn')
export interface TrafficCar extends Car {
  id: number;
  g: TransformNode;
  wheels: AbstractMesh[];                 // spun by the speed (also in g.metadata.wheels)
  parked: false;
  phase: 'edge' | 'turn' | 'dyn';
  from: V2; to: V2;                       // the street: from junction to junction (grid indexes 0..6)
  next: V2;                               // the street it turns into (phase 'turn')
  plan: V2 | null;                        // the exit it has picked for the next junction
  dir: V2; S: V2; E: V2; len: number; u: number;   // along a street: direction, start, end, length, distance driven
  A: V2; B: V2; C: V2;                    // through a junction: a quadratic Bézier A → B with the control point C
  ox: number; oz: number; oa: number;     // back from a push: offset from the lane, fading out (glides back into it)
  yieldT: number; hurry: number; hold: number; stuck: number; ghost: number; waitJ: boolean;
  rnd: () => number;                      // its dice for the junctions (seeded, see seedTraffic)
  dynT: number;
}
// a parked car: a body at rest at its spot (home), drawn as instances (ci: paint colour, li: its index in that colour, gi: overall)
export interface ParkedCar extends Car {
  g: null;
  parked: true;
  home: [number, number, number];
  ci: number; li: number; gi: number;
  moved: boolean; awayT: number; hold: number; dynT: number;
}
// a tram car
export interface TramCar { g: TransformNode; x: number; z: number; hx: number; hz: number }

// ---------- moving traffic: cars roam the whole street grid, turn at junctions, never leave the map ----------
export const LANE = 2.6, JT = 9, N_CARS = 33, VMAX_CAR = 9; // right-hand lane offset (parked cars sit at 5.5), junction turn radius
export const TRAFFIC: TrafficCar[] = [];
const nodeP = (i: number, j: number): V2 => [roadC(i), roadC(j)];
const nbrs = (i: number, j: number) => ([[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]] as V2[]).filter(([a, b]) => a >= 0 && a <= 6 && b >= 0 && b <= 6);
const unit = (a: V2, b: V2): V2 => { const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1; return [dx / l, dz / l]; };
const rightOf = (d: V2): V2 => [-d[1], d[0]];
// one merged wheel (tyre + hub) shared by all moving cars: one mesh, drawn as an instance under every car
let wheelSrc: Mesh | null = null;
// each car = 1 body mesh + 1 lights mesh + 4 wheels (few draw calls, so there can be more cars)
// World of DODO: no police look (stripe, light bar)
function trafficCar(col: number) {
  const g = new TransformNode('trafficCar', scene), b = Bucket(), l = Bucket();
  boxB(b, 0, 0.36, 0, 1.8, 0.72, 4.1, col); boxB(b, 0, 1.08, -0.2, 1.6, 0.7, 2.2, COL.charcoal); boxB(b, 0, 1.78, -0.2, 1.62, 0.08, 2.0, col);
  for (const sx of [-0.6, 0.6]) { boxB(l, sx, 0.78, 2.06, 0.36, 0.16, 0.06, 0xffffff); boxB(l, sx, 0.78, -2.06, 0.36, 0.16, 0.06, 0xc0524a); }
  geoMesh('trafficCarBody', b, VC_MAT, true, true).parent = g;
  geoMesh('trafficCarLights', l, VC_GLOW, false, false).parent = g;
  const wheels: AbstractMesh[] = [];
  for (const sx of [-0.86, 0.86]) for (const sz of [-1.35, 1.35]) { const w = wheelSrc!.createInstance('trafficCarWheel'); w.parent = g; w.position.set(sx, 0.34, sz); wheels.push(w); }
  g.metadata = { wheels };
  return { g, wheels };
}
function bez(a: V2, c: V2, b: V2, t: number): V2 { const s = 1 - t; return [s * s * a[0] + 2 * s * t * c[0] + t * t * b[0], s * s * a[1] + 2 * s * t * c[1] + t * t * b[1]]; }
function bezD(a: V2, c: V2, b: V2, t: number): V2 { return unit([0, 0], [2 * (1 - t) * (c[0] - a[0]) + 2 * t * (b[0] - c[0]), 2 * (1 - t) * (c[1] - a[1]) + 2 * t * (b[1] - c[1])]); }
function startEdge(c: TrafficCar) {
  const f = nodeP(...c.from), t = nodeP(...c.to);
  c.dir = unit(f, t); c.S = [f[0] + c.dir[0] * JT, f[1] + c.dir[1] * JT]; c.E = [t[0] - c.dir[0] * JT, t[1] - c.dir[1] * JT];
  c.len = Math.hypot(c.E[0] - c.S[0], c.E[1] - c.S[1]); c.phase = 'edge'; c.u = 0;
}
function pickExit(c: TrafficCar): V2 {
  const rnd = c.rnd, opts = nbrs(...c.to).filter(([a, b]) => a !== c.from[0] || b !== c.from[1]);
  // prefer going straight a bit more often, like real traffic
  let n = opts[(rnd() * opts.length) | 0];
  const st = opts.find(([a, b]) => a - c.to[0] === c.to[0] - c.from[0] && b - c.to[1] === c.to[1] - c.from[1]);
  if (st && rnd() < 0.35) n = st;
  return n;
}
// junction right of way: a car enters only when no car already in that junction crosses its path
function turnKind(dir: V2, node: V2, n: V2) {
  const d2 = unit(nodeP(...node), nodeP(...n)), r = rightOf(dir);
  return d2[0] * dir[0] + d2[1] * dir[1] > 0.5 ? 'S' : d2[0] * r[0] + d2[1] * r[1] > 0.5 ? 'R' : 'L';
}
function junctionBusy(c: TrafficCar) {
  const kc = turnKind(c.dir, c.to, c.plan!);
  for (const o of TRAFFIC) {
    if (o === c || o.phase !== 'turn' || o.to[0] !== c.to[0] || o.to[1] !== c.to[1]) continue;
    if (o.next[0] === c.plan![0] && o.next[1] === c.plan![1]) return true;
    const ko = turnKind(o.dir, o.to, o.next);
    if (kc === 'R' || ko === 'R') continue;
    if (kc === 'S' && ko === 'S' && o.dir[0] * c.dir[0] + o.dir[1] * c.dir[1] < -0.5) continue;
    return true;
  }
  return false;
}
function startTurn(c: TrafficCar) {
  const n = c.plan || pickExit(c); c.plan = null;
  const t = nodeP(...c.to), d2 = unit(t, nodeP(...n));
  c.A = [t[0] - c.dir[0] * JT, t[1] - c.dir[1] * JT]; c.C = t; c.B = [t[0] + d2[0] * JT, t[1] + d2[1] * JT];
  let L = 0, p = c.A;
  for (let k = 1; k <= 8; k++) { const q = bez(c.A, c.C, c.B, k / 8); L += Math.hypot(q[0] - p[0], q[1] - p[1]); p = q; }
  c.len = L; c.u = 0; c.phase = 'turn'; c.next = n;
}
function placeTraffic(c: TrafficCar) {
  let p: V2, d: V2;
  if (c.phase === 'edge') { const k = c.u / c.len; p = [c.S[0] + (c.E[0] - c.S[0]) * k, c.S[1] + (c.E[1] - c.S[1]) * k]; d = c.dir; }
  else { const k = Math.min(1, c.u / c.len); p = bez(c.A, c.C, c.B, k); d = bezD(c.A, c.C, c.B, k); }
  const r = rightOf(d); c.x = p[0] + r[0] * LANE; c.z = p[1] + r[1] * LANE; c.hx = d[0]; c.hz = d[1];
  c.g.position.set(c.x + (c.ox || 0), 0, c.z + (c.oz || 0)); c.g.rotation.y = Math.atan2(d[0], d[1]) + (c.oa || 0);
}

// ---------- tram: three cars on the avenue, balloon loops just outside the city at both ends ----------
export const TRAM_L = 8.6, TRAM_W = 2.4;
const TRAM_GAP = 0.7, TRAM_VMAX = 8, TRAM_N = 3;
// s: its front's distance along the track; hold: waits after a bump; dwell/atStop: at a shelter; pts: points along the cars (tramNear);
// nb: the server's rows, its place along the track in x (net/world.ts)
export const TRAM = { s: 0, v: TRAM_VMAX, hold: 0, dwell: 0, atStop: -1, yieldT: 0, vag: [] as TramCar[], pts: [] as V2[], nb: [] as Row[] };
// The track: a closed centripetal Catmull-Rom curve (three.js's CatmullRomCurve3, ported in world/catmull.ts so that it is the
// server's to the last bit) through the avenue's two tracks and the two loops, as N points evenly spaced along its length len.
// Filled in by buildTraffic.
export const TRAM_PATH: { pts: V2[]; N: number; len: number } = { pts: [], N: 0, len: 0 };
function tramPath() {
  const z0 = roadC(TRAM_K), P: V2[] = [], a = 2.2, loop: V2[] = [[162, 2.6], [170, 5], [177, 9.5], [185, 11], [192, 8], [195, 0], [192, -8], [185, -11], [177, -9.5], [170, -5], [162, -2.6]];
  for (let x = -150; x <= 150; x += 25) P.push([x, z0 + a]);
  loop.forEach(([x, z]) => P.push([x, z0 + z]));
  for (let x = 150; x >= -150; x -= 25) P.push([x, z0 - a]);
  loop.forEach(([x, z]) => P.push([-x, z0 - z]));
  const curve = new CatmullRomCurve3(P.map(p => ({ x: p[0], y: 0, z: p[1] })), true, 'centripetal');
  const N = 1600, pts = curve.getSpacedPoints(N).map(v => [v.x, v.z] as V2); pts.pop();
  TRAM_PATH.pts.length = 0; TRAM_PATH.pts.push(...pts); TRAM_PATH.N = pts.length; TRAM_PATH.len = curve.getLength();
}
function tramAt(s: number): V2 {
  const L = TRAM_PATH.len; s = ((s % L) + L) % L;
  const f = s / L * TRAM_PATH.N, i = Math.floor(f), t = f - i, a = TRAM_PATH.pts[i % TRAM_PATH.N], b = TRAM_PATH.pts[(i + 1) % TRAM_PATH.N];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
// stops: tram centred on the shelter (north side = eastbound, south side = westbound). Filled in by buildTraffic.
export const TRAM_STOPS: number[] = [];
function tramStops() {
  const z0 = roadC(TRAM_K);
  TRAM_STOPS.length = 0;
  for (const [x, z, dx] of [[26, z0 + 2.2, 1], [-26, z0 - 2.2, -1]]) {
    let best = 0, bd = 1e9;
    TRAM_PATH.pts.forEach((p, i) => { const q = TRAM_PATH.pts[(i + 1) % TRAM_PATH.N]; if ((q[0] - p[0]) * dx <= 0) return; const d = Math.hypot(p[0] - x, p[1] - z); if (d < bd) { bd = d; best = i; } });
    TRAM_STOPS.push(best / TRAM_PATH.N * TRAM_PATH.len + (TRAM_N * TRAM_L + (TRAM_N - 1) * TRAM_GAP) / 2);
  }
}
// rails + gravel bed on the loops (the straight part is drawn with the avenue), and the second shelter on the south side of the
// avenue (the first one, by the square, is the city's). The original put them into the city's merged buckets; here they are baked
// on their own (3 meshes), so they do not depend on when world/city.ts bakes its buckets.
function tramScenery() {
  const road = Bucket(), trim = Bucket(), glow = Bucket();
  const pts = TRAM_PATH.pts, n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n]; if (Math.abs(a[0]) < 149 && Math.abs(b[0]) < 149) continue;
    const d = unit(a, b), r = rightOf(d);
    const strip = (o: number, w: number, y: number, col: number) => { const p = (q: V2, s: number): P3 => [q[0] + r[0] * (o + s), y, q[1] + r[1] * (o + s)]; quad(road, p(a, -w), p(a, w), p(b, w), p(b, -w), col); };
    if (Math.abs(a[0]) > 162) strip(0, 1.7, 0.015, COL.c60); strip(-0.72, 0.09, 0.04, COL.grey); strip(0.72, 0.09, 0.04, COL.grey);
  }
  const x = -26, z = roadC(TRAM_K) - 8.4;
  boxB(trim, x, 0.3, z, 6, 0.15, 1.8, COL.charcoal); boxB(trim, x, 2.9, z, 6.4, 0.18, 2, COL.charcoal, 0, COL.paper);
  boxB(glow, x, 0.6, z + 0.8, 5.8, 2.2, 0.06, COL.light); boxB(trim, x - 3.05, 0.3, z, 0.12, 2.6, 0.12, COL.charcoal); boxB(trim, x + 3.05, 0.3, z, 0.12, 2.6, 0.12, COL.charcoal);
  bake('tramLoopTrack', road, lambert(0xffffff), false);        // as the city's road bucket: lit, one-sided, no shadow
  bake('tramShelterTrim', trim, VC_MAT, true);
  bake('tramShelterGlow', glow, VC_GLOW, false);
}
function tramCar(k: number) {
  const g = new TransformNode('tramCar', scene), b = Bucket(), l = Bucket(), L = TRAM_L, W = TRAM_W, front = k === 0;
  boxB(b, 0, 0.25, 0, W * 0.92, 0.35, L - 0.4, COL.c80);                     // skirt / bogies
  boxB(b, 0, 0.6, 0, W, 2.7, L, COL.white, 0, COL.c20);                      // body
  boxB(b, 0, 0.6, 0, W + 0.02, 0.5, L + 0.02, COL.charcoal);                 // dark lower band
  boxB(b, 0, 3.3, 0, W * 0.6, 0.35, L * 0.5, COL.c20);                       // roof equipment
  // windows (lit) along both sides, door panes on the right
  for (let z = -L / 2 + 0.7; z < L / 2 - 0.9; z += 1.55) for (const sx of [-1, 1]) {
    const x = sx * (W / 2 + 0.015), q = (y0: number, y1: number, z0: number, z1: number) => quad(l, [x, y0, z0], [x, y0, z1], [x, y1, z1], [x, y1, z0], COL.light);
    q(1.75, 2.95, z, z + 1.25);
  }
  for (const z of [-L / 4, L / 4]) { const x = W / 2 + 0.02; quad(l, [x, 1.15, z - 0.6], [x, 1.15, z + 0.6], [x, 2.95, z + 0.6], [x, 2.95, z - 0.6], COL.c20); }
  if (front) {
    const zf = L / 2 + 0.015; quad(l, [-W / 2 + 0.15, 1.7, zf], [W / 2 - 0.15, 1.7, zf], [W / 2 - 0.15, 3.0, zf], [-W / 2 + 0.15, 3.0, zf], COL.light);
    for (const sx of [-0.8, 0.8]) boxB(l, sx, 0.95, L / 2, 0.32, 0.18, 0.06, 0xffffff);
  }
  if (k === TRAM_N - 1) for (const sx of [-0.8, 0.8]) boxB(l, sx, 0.95, -L / 2, 0.32, 0.18, 0.06, 0xc0524a);
  if (k === 1) { boxB(b, 0, 3.65, 0, 0.1, 0.9, 0.1, COL.charcoal); boxB(b, 0, 4.5, 0.6, 0.08, 0.08, 1.4, COL.charcoal); boxB(b, 0, 4.55, 1.2, 1.2, 0.06, 0.12, COL.charcoal); } // pantograph
  geoMesh('tramBody', b, VC_MAT, true, true).parent = g;
  geoMesh('tramLights', l, VC_GLOW, false, false).parent = g;
  return g;
}
export function placeTram() {
  TRAM.pts.length = 0;
  TRAM.vag.forEach((v, k) => {
    const c = TRAM.s - k * (TRAM_L + TRAM_GAP) - TRAM_L / 2, f = tramAt(c + TRAM_L * 0.35), r = tramAt(c - TRAM_L * 0.35), d = unit(r, f);
    v.x = (f[0] + r[0]) / 2; v.z = (f[1] + r[1]) / 2; v.hx = d[0]; v.hz = d[1]; v.g.position.set(v.x, 0, v.z); v.g.rotation.y = Math.atan2(d[0], d[1]);
    for (const a of [-0.5, 0, 0.5]) TRAM.pts.push([v.x + d[0] * TRAM_L * a, v.z + d[1] * TRAM_L * a]);
  });
}
export const tramNear = (x: number, z: number, r: number) => TRAM.pts.some(p => Math.abs(p[0] - x) < r && Math.abs(p[1] - z) < r);
export function updateTram(dt: number) {
  let target = TRAM_VMAX;
  const f = TRAM.vag[0], fx = f.x + f.hx * TRAM_L / 2, fz = f.z + f.hz * TRAM_L / 2;
  // wait for anything on the track in front: the van or a car
  const inFront = (x: number, z: number) => { const wx = x - fx, wz = z - fz, a = wx * f.hx + wz * f.hz, l = Math.abs(wx * f.hz - wz * f.hx); return a > -1 && a < 11 && l < 2.5; };
  const vf = [Math.sin(car.h) * 1.55, Math.cos(car.h) * 1.55];
  if (inFront(car.x, car.z) || inFront(car.x + vf[0], car.z + vf[1]) || inFront(car.x - vf[0], car.z - vf[1])) target = 0;
  {
    const pos = (ds: number) => { const a = tramAt(TRAM.s + ds), b = tramAt(TRAM.s + ds - 1), d = unit(b, a); return [a[0], a[1], d[0], d[1]]; };
    if (vanConflict(pos, TRAM_VMAX, [0, -TRAM_L * 0.25, -TRAM_L / 2], 3.5, 2.9) || vanConflict(pos, Math.max(TRAM.v, 2), [0, -TRAM_L * 0.25, -TRAM_L / 2], 3.5, 2.9)) TRAM.yieldT = 0.8;
  }
  if (TRAM.yieldT > 0) { TRAM.yieldT -= dt; target = 0; }
  for (const c of TRAFFIC) { if (Math.abs(c.x - fx) > 14 || Math.abs(c.z - fz) > 14) continue; if (inFront(c.x, c.z) || inFront(c.x + c.hx * 1.9, c.z + c.hz * 1.9) || inFront(c.x - c.hx * 1.9, c.z - c.hz * 1.9)) target = 0; }
  for (const c of PARKED) { if (!(c.dyn || c.moved) || Math.abs(c.x - fx) > 14 || Math.abs(c.z - fz) > 14) continue; if (inFront(c.x, c.z) || inFront(c.x + c.hx * 1.9, c.z + c.hz * 1.9) || inFront(c.x - c.hx * 1.9, c.z - c.hz * 1.9)) target = 0; }
  if (TRAM.hold > 0) { TRAM.hold -= dt; target = 0; }
  // stop at the shelters
  const Lp = TRAM_PATH.len;
  if (TRAM.dwell > 0) { TRAM.dwell -= dt; target = 0; }
  else TRAM_STOPS.forEach((S, i) => { const ds = ((S - TRAM.s) % Lp + Lp) % Lp; if (ds < 40 && TRAM.atStop !== i) { target = Math.min(target, Math.sqrt(2 * 2.2 * ds) + 0.3); if (ds < 0.4) { TRAM.dwell = 6; TRAM.atStop = i; } } });
  TRAM.v += Math.max(-(TRAM.yieldT > 0 ? 14 : 10) * dt, Math.min(2.5 * dt, target - TRAM.v)); if (TRAM.v < 0) TRAM.v = 0;
  TRAM.s = (TRAM.s + TRAM.v * dt) % Lp;
  if (TRAM.atStop >= 0 && TRAM.dwell <= 0) { const ds = ((TRAM.s - TRAM_STOPS[TRAM.atStop]) % Lp + Lp) % Lp; if (ds > 5 && ds < Lp - 50) TRAM.atStop = -1; }
  placeTram();
}

// spread the cars over the grid — never near the van's start in front of the depot, never on top of each other or the tram
export function seedTraffic(seed: number) {
  const rr = rng(seed), used = new Set<string>();
  let placed = 0, tries = 0;
  while (placed < N_CARS && tries < 8000) {
    tries++;
    const i = (rr() * 7) | 0, j = (rr() * 7) | 0, ns = nbrs(i, j), n = ns[(rr() * ns.length) | 0], key = [i, j, n].join();
    if (used.has(key)) continue;
    const c = TRAFFIC[placed]; c.from = [i, j]; c.to = n; startEdge(c); c.u = c.len * (0.15 + rr() * 0.7); placeTraffic(c);
    if (Math.hypot(c.x - depot.park[0], c.z - depot.park[1]) < 50) continue;
    if (TRAFFIC.slice(0, placed).some(o => Math.hypot(o.x - c.x, o.z - c.z) < 16)) continue;
    if (tramNear(c.x, c.z, 18)) continue;
    used.add(key);
    Object.assign(c, { v: VMAX_CAR * 0.7, yieldT: 0, hurry: 0, hold: 0, stuck: 0, ghost: 0, rnd: rr, plan: null, waitJ: false, dyn: false, ox: 0, oz: 0, oa: 0 });
    placed++;
  }
}
export function seedTram(s: number) { TRAM.s = s; TRAM.yieldT = 0; TRAM.v = TRAM_VMAX; TRAM.hold = 0; TRAM.dwell = 0; TRAM.atStop = -1; placeTram(); }
// where will car c be after driving du further along its real route (edge → junction turn → next street)?
function pathAt(c: TrafficCar, du: number) {
  let u = c.u + du, p: V2, d: V2;
  const turnPt = (A: V2, C: V2, B: V2, L: number, uu: number, d2: V2): [V2, V2] => uu <= L ? [bez(A, C, B, uu / L), bezD(A, C, B, uu / L)] : [[B[0] + d2[0] * (uu - L), B[1] + d2[1] * (uu - L)], d2];
  if (c.phase === 'edge') {
    if (u <= c.len) { p = [c.S[0] + c.dir[0] * u, c.S[1] + c.dir[1] * u]; d = c.dir; }
    else if (!c.plan) { u -= c.len; p = [c.E[0] + c.dir[0] * u, c.E[1] + c.dir[1] * u]; d = c.dir; }
    else {
      u -= c.len;
      const t = nodeP(...c.to), d2 = unit(t, nodeP(...c.plan)), B: V2 = [t[0] + d2[0] * JT, t[1] + d2[1] * JT], st = d2[0] * c.dir[0] + d2[1] * c.dir[1] > 0.5;
      [p, d] = turnPt(c.E, t, B, st ? 18 : 14.6, u, d2);
    }
  } else { const d2 = unit(c.C, c.B); [p, d] = turnPt(c.A, c.C, c.B, c.len, u, d2); }
  const r = rightOf(d); return [p[0] + r[0] * LANE, p[1] + r[1] * LANE, d[0], d[1]];
}
// look ahead: will this vehicle (following its route at speed sp) and the van (on its current heading and speed) meet within T seconds?
// if so, the vehicle gives way — the van always has right of way. Only a van already following right behind it in the same direction is left alone.
function vanConflict(pos: (du: number) => number[], sp: number, offs: number[], T: number, rad: number) {
  const p0 = pos(0); if (Math.abs(car.x - p0[0]) > 80 || Math.abs(car.z - p0[1]) > 80) return false;
  const vhx = Math.sin(car.h), vhz = Math.cos(car.h);
  if ((car.x - p0[0]) * p0[2] + (car.z - p0[1]) * p0[3] < -1.5 && vhx * p0[2] + vhz * p0[3] > 0.7) return false;
  const vx = vhx * car.v, vz = vhz * car.v, fx = vhx * 1.55, fz = vhz * 1.55;
  for (let t = 0; t <= T; t += 0.2) {
    const q = pos(sp * t), px = car.x + vx * t, pz = car.z + vz * t;
    for (const a of offs) for (const b of [-1, 0, 1]) if (Math.hypot(q[0] + q[2] * a - px - fx * b, q[1] + q[3] * a - pz - fz * b) < rad) return true;
  }
  return false;
}
// is point (x,z) in the strip right in front of car c? (forward 0..fa, sideways ±fl) — oncoming cars in the other lane don't count
function ahead(c: Car, x: number, z: number, fa: number, fl: number) {
  const wx = x - c.x, wz = z - c.z; if (Math.abs(wx) > fa + 3 || Math.abs(wz) > fa + 3) return false;
  const a = wx * c.hx + wz * c.hz; if (a <= 0.3 || a > fa) return false;
  return Math.abs(wx * c.hz - wz * c.hx) < fl;
}

// ---------- car physics: the tank can shove traffic around ----------
// A car drives on rails (its route) until something hits it. Then it becomes a free rigid body (position, heading, velocity,
// spin) with sliding friction. It bounces off kerbs, parked cars, the tram and other cars (which it sets in motion too),
// and when it has come to rest it rejoins the nearest street. The tram stays immovable; parked cars are bodies too (see below).
export const CAR_M = 2.5, CAR_I = 4.2, TANK_M = 8, CAR_E = 0.25, PARCEL_M = 0.15;
// a body for impulse(): centre, velocity, spin, inverse mass and inverse moment of inertia (0: immovable)
export interface Body { cx: number; cz: number; vx: number; vz: number; w: number; im: number; iI: number }
export function carBody(c: Car): Body { return { cx: c.x, cz: c.z, vx: c.vx, vz: c.vz, w: c.w, im: 1 / (c.m || CAR_M), iI: 1 / (c.mi || CAR_I) }; }
export function wallBody(vx?: number, vz?: number): Body { return { cx: 0, cz: 0, vx: vx || 0, vz: vz || 0, w: 0, im: 0, iI: 0 }; }
export function putBody(c: Car, B: Body) { c.vx = B.vx; c.vz = B.vz; c.w = B.w; }
// 2D impulse between bodies A and B at contact point (px,pz); n points from A to B. w is the turn rate of the heading angle (z towards x).
export function impulse(A: Body, B: Body, px: number, pz: number, nx: number, nz: number, e: number) {
  const rax = px - A.cx, raz = pz - A.cz, rbx = px - B.cx, rbz = pz - B.cz;
  const vax = A.vx + A.w * raz, vaz = A.vz - A.w * rax, vbx = B.vx + B.w * rbz, vbz = B.vz - B.w * rbx;
  const vn = (vbx - vax) * nx + (vbz - vaz) * nz; if (vn >= 0) return 0;
  const ca = raz * nx - rax * nz, cb = rbz * nx - rbx * nz;
  const J = -(1 + e) * vn / (A.im + B.im + A.iI * ca * ca + B.iI * cb * cb);
  A.vx -= A.im * J * nx; A.vz -= A.im * J * nz; A.w -= A.iI * ca * J;
  B.vx += B.im * J * nx; B.vz += B.im * J * nz; B.w += B.iI * cb * J;
  return J;
}
// parked cars: write the instance matrices of one car (body, cabin, 4 wheels), then upload them
export function placeParked(c: Car) {
  writeParked(c as ParkedCar);
  PBODY[c.ci].update(); PCABIN!.update(); PWHEEL!.update();
}
function writeParked(c: ParkedCar) {
  const cs = Math.cos(c.ang), sn = Math.sin(c.ang), D = PD!;
  D.position.set(c.x, c.gy || 0, c.z); D.rotation.set(0, c.ang, 0); const m = D.updateMatrix();
  PBODY[c.ci].setMatrixAt(c.li, m); PCABIN!.setMatrixAt(c.gi, m);
  let k = 0;
  for (const a of [-1.35, 1.35]) for (const b of [-0.82, 0.82]) { D.position.set(c.x + sn * a + cs * b, 0.62 + (c.gy || 0), c.z + cs * a - sn * b); PWHEEL!.setMatrixAt(c.gi * 4 + k++, D.updateMatrix()); }
}
export function towHome(c: Car) {
  c.x = c.home[0]; c.z = c.home[1]; c.ang = c.home[2]; c.hx = Math.sin(c.ang); c.hz = Math.cos(c.ang); c.vx = c.vz = c.w = 0; c.gy = 0;
  c.dyn = false; c.moved = false; c.awayT = 0; placeParked(c);
}
export function resetParked() { PARKED.forEach(c => { if (c.dyn || c.moved || c.x !== c.home[0] || c.z !== c.home[1]) towHome(c); }); }
export function toDyn(c: Car) {
  if (c.dyn) return;
  if (WORLD.on) { c.mine = true; c.rel = false; c.claimAt = now(); c.ackAt = 0; }  // World of DODO: a car of the shared city is yours while you shove it (see the shared city)
  if (c.parked) { c.dyn = true; c.vx = c.vz = c.w = 0; c.dynT = 0; c.calm = 0; return; }  // wake a parked car up
  c.x += c.ox || 0; c.z += c.oz || 0; c.ang = Math.atan2(c.hx, c.hz) + (c.oa || 0); c.ox = c.oz = c.oa = 0; c.hx = Math.sin(c.ang); c.hz = Math.cos(c.ang);
  c.vx = c.hx * c.v; c.vz = c.hz * c.v; c.w = 0; c.v = 0; c.dyn = true; c.phase = 'dyn'; c.dynT = 0; c.calm = 0; c.waitJ = false; c.plan = null;
}
// would the vehicle (as a body at c.x,c.z,c.ang) sit on a kerb? (cl = offset of its two collision circles, cr = their radius)
export function dynBlocked(c: Car) {
  const hx = Math.sin(c.ang), hz = Math.cos(c.ang), cl = c.cl || 1.2, mg = (c.cr || 1.05) - 0.05;
  for (const k of [cl, -cl]) { const px = c.x + hx * k, pz = c.z + hz * k; if (!free(px, pz, mg)) return true; }
  return false;
}
// static collisions of a free vehicle: kerbs and buildings, the props, the tram, other vehicles (parked and driving)
function dynStatics(c: Car) {
  const hx = c.hx, hz = c.hz, cl = c.cl || 1.2, cr = c.cr || 1.05, mg = cr - 0.05;
  for (const k of [cl, -cl]) {
    let px = c.x + hx * k, pz = c.z + hz * k;
    for (const q of propsNear(px, pz)) {
      if (q.state !== 'up') continue;
      const dx = px - q.x, dz = pz - q.z, d = Math.hypot(dx, dz), rr = cr + q.r; if (d >= rr || d < 0.001) continue;
      const nx = dx / d, nz = dz / d, vin = -(c.vx * nx + c.vz * nz);                                              // speed into the prop
      if ((c.m || CAR_M) >= q.minMass && vin >= q.breakV) { knockProp(q, -nx, -nz); c.vx *= q.slow; c.vz *= q.slow; continue; }
      c.x += nx * (rr - d); c.z += nz * (rr - d); const B = carBody(c); impulse(wallBody(), B, px, pz, nx, nz, CAR_E); putBody(c, B); px = c.x + hx * k; pz = c.z + hz * k;
    }
    const hit = solidPush(px, pz, cr);
    if (hit) { c.x += hit.nx * (hit.pen + 0.02); c.z += hit.nz * (hit.pen + 0.02); const B = carBody(c); impulse(wallBody(), B, px, pz, hit.nx, hit.nz, CAR_E); putBody(c, B); px = c.x + hx * k; pz = c.z + hz * k; }
    for (const v of TRAM.vag) {
      if (Math.abs(v.x - px) > 7 || Math.abs(v.z - pz) > 7) continue;
      const a = (px - v.x) * v.hx + (pz - v.z) * v.hz, b = (px - v.x) * v.hz - (pz - v.z) * v.hx, A = TRAM_L / 2 + mg, Bw = TRAM_W / 2 + mg;
      if (Math.abs(a) >= A || Math.abs(b) >= Bw) continue;
      const pa = A - Math.abs(a), pb = Bw - Math.abs(b); let nx: number, nz: number, pen: number;
      if (pb < pa) { const sg = b < 0 ? -1 : 1; nx = v.hz * sg; nz = -v.hx * sg; pen = pb; } else { const sg = a < 0 ? -1 : 1; nx = v.hx * sg; nz = v.hz * sg; pen = pa; }
      c.x += nx * pen; c.z += nz * pen; const B = carBody(c); impulse(wallBody(TRAM.v * v.hx, TRAM.v * v.hz), B, px, pz, nx, nz, CAR_E); putBody(c, B); px = c.x + hx * k; pz = c.z + hz * k;
    }
    for (const o of ALLCARS) {
      if (o === c || Math.abs(o.x - px) > 5 || Math.abs(o.z - pz) > 5) continue;
      const ol = o.cl || 1.2, thr = cr + (o.cr || 1.05);
      for (const m of [ol, -ol]) {
        const qx = o.x + o.hx * m, qz = o.z + o.hz * m, dx = qx - px, dz = qz - pz, d = Math.hypot(dx, dz); if (d >= thr) continue;
        const nx = d > 0.01 ? dx / d : o.hx, nz = d > 0.01 ? dz / d : o.hz, pen = thr - d, mx = (px + qx) / 2, mz = (pz + qz) / 2;
        if (WORLD.on && o.net) { const A = carBody(c); impulse(wallBody(), A, mx, mz, -nx, -nz, CAR_E); putBody(c, A); c.x -= nx * pen; c.z -= nz * pen; } // a car another player is pushing is immovable
        else {
          if (!o.dyn) toDyn(o);
          const A = carBody(c), B = carBody(o); impulse(A, B, mx, mz, nx, nz, CAR_E); putBody(c, A); putBody(o, B);
          c.x -= nx * pen * 0.5; c.z -= nz * pen * 0.5; o.x += nx * pen * 0.5; o.z += nz * pen * 0.5;
        }
        px = c.x + hx * k; pz = c.z + hz * k;
      }
    }
  }
}
// how far the vehicle is from the centre line of the street it points along
function roadOff(c: Car) {
  const hx = Math.sin(c.ang), hz = Math.cos(c.ang), cl = (v: number) => Math.max(0, Math.min(6, Math.round((v + HALF) / CELL)));
  return Math.abs(hx) >= Math.abs(hz) ? Math.abs(c.z - roadC(cl(c.z))) : Math.abs(c.x - roadC(cl(c.x)));
}
// back onto the street: the lane nearest to where it points, gliding there from where it stands (the server's rejoin is the same)
export function rejoin(c0: Car) {
  const c = c0 as TrafficCar;
  const hx = Math.sin(c.ang), hz = Math.cos(c.ang), ax = c.x, az = c.z, aang = c.ang, cl = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
  let from: V2, to: V2;
  if (Math.abs(hx) >= Math.abs(hz)) { const j = cl(Math.round((az + HALF) / CELL), 0, 6), i0 = cl(Math.floor((ax + HALF) / CELL), 0, 5); from = hx > 0 ? [i0, j] : [i0 + 1, j]; to = hx > 0 ? [i0 + 1, j] : [i0, j]; }
  else { const i = cl(Math.round((ax + HALF) / CELL), 0, 6), j0 = cl(Math.floor((az + HALF) / CELL), 0, 5); from = hz > 0 ? [i, j0] : [i, j0 + 1]; to = hz > 0 ? [i, j0 + 1] : [i, j0]; }
  c.dyn = false; c.gy = 0; c.from = from; c.to = to; startEdge(c);
  c.u = cl((ax - c.S[0]) * c.dir[0] + (az - c.S[1]) * c.dir[1], 0, c.len);
  c.v = 0; c.plan = null; c.waitJ = false; c.yieldT = 0; c.hurry = 0; c.hold = 0; c.stuck = 0; c.ghost = 0; c.ox = c.oz = c.oa = 0;
  placeTraffic(c);
  c.ox = ax - c.x; c.oz = az - c.z; const da = aang - Math.atan2(c.dir[0], c.dir[1]); c.oa = Math.atan2(Math.sin(da), Math.cos(da)); // glide back into the lane
  c.g.position.set(ax, 0, az); c.g.rotation.y = aang;
}
// one step of a free body (a shoved car, or a parked car woken up)
export function updateDyn(c: Car, dt: number) {
  c.dynT += dt;
  let hx = Math.sin(c.ang), hz = Math.cos(c.ang);
  let vf = c.vx * hx + c.vz * hz, vl = c.vx * hz - c.vz * hx;                 // tyres: sideways slip is damped hard, rolling forward much less
  vf *= Math.exp(-1.0 * dt); vl *= Math.exp(-6 * dt);
  const sp = Math.hypot(vf, vl); if (sp > 0) { const d = Math.min(sp, 4 * dt); vf -= vf / sp * d; vl -= vl / sp * d; } // plus a little constant sliding friction
  c.vx = vf * hx + vl * hz; c.vz = vf * hz - vl * hx; c.w *= Math.exp(-2.5 * dt);
  const sp2 = Math.hypot(c.vx, c.vz); if (sp2 > 40) { c.vx *= 40 / sp2; c.vz *= 40 / sp2; } c.w = Math.max(-12, Math.min(12, c.w));
  const n = Math.max(1, Math.ceil(Math.max(sp2, Math.abs(c.w) * 2) * dt / 0.4)), h = dt / n;
  for (let i = 0; i < n; i++) { c.x += c.vx * h; c.z += c.vz * h; c.ang += c.w * h; c.hx = Math.sin(c.ang); c.hz = Math.cos(c.ang); dynStatics(c); }
  hx = c.hx; hz = c.hz;
  c.gy = (c.gy || 0) + (groundH(c.x, c.z) - (c.gy || 0)) * Math.min(1, dt * 12);
  if (c.parked) placeParked(c);
  else { const g = c.g!; g.position.set(c.x, c.gy, c.z); g.rotation.y = c.ang; const vfw = c.vx * hx + c.vz * hz; for (const w of c.wheels as AbstractMesh[]) w.rotation.x += vfw * dt / 0.34; }
  const slow = Math.hypot(c.vx, c.vz) < 0.8 && Math.abs(c.w) < 0.4; c.calm = slow ? c.calm + dt : 0;
  if (c.parked) { // it stays where it ended up
    if (c.calm > 0.6 || c.dynT > 25) {
      c.dyn = false; c.vx = c.vz = c.w = 0; const da = Math.atan2(Math.sin(c.ang - c.home[2]), Math.cos(c.ang - c.home[2]));
      c.moved = Math.hypot(c.x - c.home[0], c.z - c.home[1]) > 0.8 || Math.abs(da) > 0.5; c.awayT = 0; if (c.mine) letGo(c);
    }
    return;
  }
  // back onto the street once it has settled and the tank is not on top of it (World of DODO: the server does that for a shared car)
  if (c.calm > 0.8 || c.dynT > 25) { const dT = Math.hypot(c.x - car.x, c.z - car.z); if (dT > 5 && (roadOff(c) < 9 || dT > 70)) { if (c.mine) letGo(c); else rejoin(c); } }
}

// the browser's own city (the intro, before you join): the tram, the parked cars knocked out of their spots, the traffic
export function updateTraffic(dt: number) {
  const VMAX = VMAX_CAR;
  updateTram(dt);
  for (const c of PARKED) {
    if (c.dyn) { updateDyn(c, dt); continue; }
    if (c.moved) { c.awayT += dt; if (c.awayT > 12 && Math.hypot(c.x - car.x, c.z - car.z) > 70) towHome(c); } // a displaced car does not block the street forever
  }
  const vf = [Math.sin(car.h) * 1.55, Math.cos(car.h) * 1.55];
  for (const c of TRAFFIC) {
    if (c.dyn) { updateDyn(c, dt); continue; }
    if (c.ox || c.oz || c.oa) { const f = Math.exp(-3 * dt); c.ox *= f; c.oz *= f; c.oa *= f; if (Math.abs(c.ox) + Math.abs(c.oz) + Math.abs(c.oa) < 0.01) c.ox = c.oz = c.oa = 0; }
    let target = VMAX, byCar = false;
    if (c.ghost > 0) c.ghost -= dt;
    // keep distance to whatever is ahead: other cars, the player's van, the tram
    for (const o of TRAFFIC) {
      if (o === c || (c.phase === 'turn' && o.waitJ)) continue;
      if (!(ahead(c, o.x, o.z, 8, 2.1) || ahead(c, o.x - o.hx * 1.9, o.z - o.hz * 1.9, 8, 2.1) || ahead(c, o.x + o.hx * 1.9, o.z + o.hz * 1.9, 8, 2.1))) continue;
      // a car resolving a deadlock passes crossing cars, but never drives into the car ahead in its own lane
      if (c.ghost > 0 && o.hx * c.hx + o.hz * c.hz < 0.7) continue;
      target = 0; byCar = true;
    }
    for (const o of PARKED) { if (!(o.dyn || o.moved)) continue; if (ahead(c, o.x, o.z, 8, 2.1) || ahead(c, o.x - o.hx * 1.9, o.z - o.hz * 1.9, 8, 2.1) || ahead(c, o.x + o.hx * 1.9, o.z + o.hz * 1.9, 8, 2.1)) { target = 0; byCar = true; } }
    // give way to the van early: check both 'if I keep my speed' and 'if I speed up', and keep yielding a moment so the car doesn't creep into it
    {
      const pos = (du: number) => pathAt(c, du), O = [-1.4, 0, 1.4];
      if (c.phase === 'edge') { if (vanConflict(pos, VMAX, O, 2.6, 2.6) || vanConflict(pos, Math.max(c.v, 3), O, 2.6, 2.6)) c.yieldT = 0.6; }
      // already inside the junction: clear it if that avoids the van, stop only if stopping is the safe option
      else if (vanConflict(pos, Math.max(c.v, 6), O, 2.6, 2.6)) { if (!vanConflict(pos, 0, O, 2.6, 2.6)) c.yieldT = 0.6; else { c.yieldT = 0; c.hurry = 0.8; } }
    }
    if (c.hurry > 0) { c.hurry -= dt; c.yieldT = 0; }
    if (c.yieldT > 0) { c.yieldT -= dt; target = 0; }
    if (ahead(c, car.x, car.z, 9, 2.6) || ahead(c, car.x + vf[0], car.z + vf[1], 9, 2.6) || ahead(c, car.x - vf[0], car.z - vf[1], 9, 2.6)) target = 0;
    // behind the tram in its lane (a car already inside a junction is committed and drives on — the tram waits for it)
    if (c.phase === 'edge') for (const p of TRAM.pts) if (ahead(c, p[0], p[1], 9, 2.2)) target = 0;
    // entering or crossing the avenue (anything but going straight on / turning right off it): give way to the tram
    if (c.phase === 'edge' && c.to[1] === TRAM_K && c.len - c.u < 6 && c.plan) {
      const k = turnKind(c.dir, c.to, c.plan);
      if (!(c.from[1] === TRAM_K && k !== 'L')) { const t = nodeP(...c.to); if (tramNear(t[0], t[1], 22)) target = 0; }
    }
    // approaching a junction: slow down and wait if a crossing car is inside it
    c.waitJ = false;
    if (c.phase === 'edge' && !c.plan && c.len - c.u < 30) c.plan = pickExit(c);
    if (c.phase === 'edge' && c.len - c.u < 8) { if (!c.plan) c.plan = pickExit(c); if (junctionBusy(c)) { c.waitJ = true; target = Math.min(target, Math.sqrt(2 * 12 * Math.max(0, c.len - c.u - 0.3))); } }
    if (c.hold > 0) { c.hold -= dt; target = 0; }
    // two cars waiting for each other inside a junction: after a moment one of them simply goes
    if (byCar && c.v < 0.5) { c.stuck += dt; if (c.stuck > 4 + (c.id % 4) * 0.5 && !TRAFFIC.some(o => o !== c && o.ghost > 0 && Math.abs(o.x - c.x) < 16 && Math.abs(o.z - c.z) < 16)) { c.ghost = 1.6; c.stuck = 0; } } else c.stuck = 0;
    c.v += Math.max(-14 * dt, Math.min(6 * dt, target - c.v));
    if (c.phase === 'turn' && c.v > 6 && !(c.hurry > 0)) c.v = Math.max(6, c.v - 10 * dt); // slow down in turns
    c.u += c.v * dt;
    if (c.waitJ && c.u >= c.len) { c.u = c.len - 0.01; c.v = 0; }
    if (c.u >= c.len) { const over = c.u - c.len; if (c.phase === 'edge') startTurn(c); else { c.from = c.to; c.to = c.next; startEdge(c); } c.u = over; }
    if (c.u < 0) c.u = 0;
    placeTraffic(c); for (const w of c.wheels) w.rotation.x += c.v * dt / 0.34;
  }
}

// ---------- parked cars along the kerbs: physical bodies (see "car physics"), drawn as instanced meshes ----------
// (one per paint colour + cabins + wheels). The original kept them in its WANTED section, after the city's facades: they take
// their spots and colours from the city's random numbers (R), so every client parks the same cars in the same order, and the
// server's index N_CARS + k is the k-th of PARKED (net/world.ts). The original's static obstacles (OBST) were always empty: gone.
export const PARKED: ParkedCar[] = [];
const PBODY: Inst[] = [];
let PD: Dummy | null = null, PCABIN: Inst | null = null, PWHEEL: Inst | null = null;
// every body a car can bump into: the traffic, then the parked cars
export const ALLCARS: Car[] = [];
function parkedCars() {
  const cols = [COL.white, COL.lgrey, COL.grey, COL.charcoal, COL.c80, COL.light, COL.c20];
  const avoid: V2[] = [depot.park];   // World of DODO: the customers' parking spots (stops) are gone; only the depot's yard stays clear
  for (let k = 0; k <= 6; k++) for (let j = 0; j < 6; j++) {
    const c = roadC(k), mid = blockC(j);
    for (const o of [-1, 1]) for (const al of [-9, 0, 9]) {
      // vertical road (x=c, along z) and horizontal road (z=c, along x)
      for (const vert of [true, false]) {
        if (R() > 0.3) continue;
        const x = vert ? c + o * 5.5 : mid + al, z = vert ? mid + al : c + o * 5.5;
        if (!vert && k === TRAM_K) continue;
        if (Math.abs(x) > HALF + 1 || Math.abs(z) > HALF + 1) continue; if (avoid.some(p => Math.hypot(p[0] - x, p[1] - z) < 11)) continue;
        const rot = vert ? 0 : Math.PI / 2, ci = (R() * cols.length) | 0;
        if (x > 96 && x < 128 && z > 104 && z < 150) continue;                        // keep the REDLINE yard and its exit clear
        const gi = PARKED.length;
        PARKED.push({
          parked: true, x, z, ang: rot, hx: Math.sin(rot), hz: Math.cos(rot), v: 0, vx: 0, vz: 0, w: 0, gy: 0, g: null, dyn: false, moved: false, awayT: 0, hold: 0, dynT: 0, calm: 0,
          home: [x, z, rot], ci, li: 0, gi,
          ni: N_CARS + gi, nb: [], net: 0, mine: false, rel: false,                    // World of DODO: the shared city (net/world.ts)
        });
      }
    }
  }
  // shared geometry in car-local coordinates (forward = +z): body box + cabin roof, cabin sides
  const bodyG = (() => { const b = Bucket(); boxB(b, 0, 0.3, 0, 1.8, 0.75, 4.1, 0xffffff); const Pc = rectPoly(0, -0.2, 1.7, 2.3, 0), Pt = offsetPoly(Pc, -0.18); cap(b, Pt, 1.75, 0xffffff); return b; })();
  const cabG = (() => { const b = Bucket(), Pc = rectPoly(0, -0.2, 1.7, 2.3, 0), Pt = offsetPoly(Pc, -0.18); ring(b, Pc, 1.05, Pt, 1.75, COL.charcoal); return b; })();
  const cnt = cols.map(() => 0); PARKED.forEach(c => { c.li = cnt[c.ci]++; });
  cols.forEach((col, ci) => { if (!cnt[ci]) return; PBODY[ci] = new Inst('parkedBody', bodyG, lambert(col, { double: true }), cnt[ci], { cast: true, receive: true }); });
  const n = PARKED.length;
  if (n) {
    PCABIN = new Inst('parkedCabin', cabG, lambert(0xffffff, { double: true }), n, { cast: true, receive: true });
    PWHEEL = new Inst('parkedWheel', rotateZ(cylGeo(0.32, 0.32, 0.26, 12), Math.PI / 2), lambert(0x1a1d1c), n * 4, { cast: true, receive: false });
  }
  // every matrix written first, then each buffer uploaded once
  PARKED.forEach(writeParked);
  PBODY.forEach(m => m?.update()); PCABIN?.update(); PWHEEL?.update();
}

// Builds the tram, the traffic and the parked cars (after the city: the parked cars draw from R after the city's facades).
export function buildTraffic() {
  PD = new Dummy();
  tramPath(); tramStops(); tramScenery();
  for (let k = 0; k < TRAM_N; k++) TRAM.vag.push({ g: tramCar(k), x: 0, z: 0, hx: 0, hz: 1 });
  {
    const wb = Bucket();
    addGeo(wb, rotateZ(cylGeo(0.34, 0.34, 0.26, 14), Math.PI / 2), null, 0x1a1d1c); addGeo(wb, rotateZ(cylGeo(0.17, 0.17, 0.28, 10), Math.PI / 2), null, COL.c20);
    wheelSrc = geoMesh('trafficCarWheel', wb, VC_MAT, false, false); wheelSrc.isVisible = false;   // only its instances are drawn
  }
  const cols = [COL.white, COL.grey, COL.charcoal, COL.c20, COL.light, COL.c80, COL.white, COL.grey, COL.c60, COL.lgrey];
  for (let k = 0; k < N_CARS; k++) {
    // World of DODO: the original's last three cars were police patrols (white, with a light bar); now they are cars like the others
    const { g, wheels } = trafficCar(cols[k % cols.length]);
    const c: TrafficCar = {
      id: k, from: [0, 0], to: [1, 0], v: VMAX_CAR, g, wheels, hold: 0, stuck: 0, ghost: 0,
      x: 0, z: 0, ang: 0, hx: 0, hz: 1, vx: 0, vz: 0, w: 0, gy: 0, dyn: false, parked: false, dynT: 0,
      phase: 'edge', next: [0, 0], plan: null, dir: [1, 0], S: [0, 0], E: [0, 0], len: 0, u: 0, A: [0, 0], B: [0, 0], C: [0, 0],
      ox: 0, oz: 0, oa: 0, yieldT: 0, hurry: 0, waitJ: false, rnd: Math.random,
      ni: k, nb: [], net: 0, mine: false, rel: false, calm: 0,                         // World of DODO: the shared city (net/world.ts)
    };
    startEdge(c); TRAFFIC.push(c);
  }
  seedTram(TRAM_STOPS[1] - 60); seedTraffic(77);
  parkedCars();
  ALLCARS.push(...TRAFFIC, ...PARKED);
}
