// The city's traffic: the cars on the streets, the tram on Sokolovská, the parked cars along the kerbs, and the body physics that lets
// a tank shove them about (the original's "moving traffic", "tram", "car physics", the parked cars of its WANTED section and
// updateTraffic).
//
// World of DODO, issue #16: how the cars and the tram move is written once, in client/shared/traffic.ts and tram.ts, and the server
// (server/world.js) runs the very same code for the shared city: the same N_CARS cars in the same order, the same track, the same
// parked cars (traffic.ts's PARK) and the same rejoin. This module draws them (the meshes, the instances), runs the shared simulation
// for this browser's own city (the intro, before you join), and keeps the client-only body physics of the cars a tank pushes. Once you
// play, net/world.ts draws the server's city and runs only the cars your tank pushes (updateDyn).
//
// World of DODO: TRAFFIC holds the traffic cars only. The original's delivery tanks, REDLINE's tanks and the police (the last
// three traffic cars, with a light bar and their own driver) are gone, and so are their branches in the code below.
import { TransformNode, type AbstractMesh, type Mesh } from '@babylonjs/core';
import { scene } from '../core/engine';
import { Bucket, boxB, quad, ring, cap, offsetPoly, rectPoly, addGeo, cylGeo, rotateZ, geoMesh, Inst, Dummy } from '../core/geo';
import { lambert, VC_MAT, VC_GLOW } from '../core/mat';
import { COL } from '../core/colors';
import { rng, now } from '../core/util';
import { freeAt, solidPush, groundH, terrainH, inArena, nearestEdge } from '../../shared/map.ts';
import { N_CARS, VMAX_CAR, PARK, newCar, seedTraffic as seedCars, stepTraffic, placeCar, rejoin as rejoinCar, type SimCar, type Tank, type Mover } from '../../shared/traffic.ts';
import {
  TRAM_L, TRAM_W, TRAM_N, TRAM_VMAX, TRAM_PATH, TRAM_STOPS, placeTram as placeTramSim, stepTram, seedTram as seedTramSim,
  tramNear as tramNearSim,
} from '../../shared/tram.ts';
import { propsNear, propsClear, knockProp } from './props';
import { car } from '../game/state';
import type { Car, Row } from '../game/types';
import { WORLD, letGo } from '../net/world';

export { N_CARS, VMAX_CAR, TRAM_L, TRAM_W, TRAM_PATH, TRAM_STOPS };
type V2 = [number, number];

// a car of the traffic: its route and its manners come from the shared simulation (SimCar: phase 'edge' along a street, 'turn' through
// a junction, 'dyn' a free body), the mesh and the body physics from here
export interface TrafficCar extends Car, SimCar {
  g: TransformNode;
  wheels: AbstractMesh[];                 // spun by the speed (also in g.metadata.wheels)
  parked: false;
  hold: number;                           // waits after a parcel hit it (game/shots.ts)
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

// where a body may stand: inside the arena, clear of the solids (map.ts) and of the standing trees and lamps (props.ts)
const free = (x: number, z: number, m: number) => freeAt(x, z, m) && propsClear(x, z, m);

// ---------- moving traffic: cars roam the whole street graph, turn at junctions, turn back at dead ends ----------
export const TRAFFIC: TrafficCar[] = [];
// this browser's tank as the shared simulation sees one (the intro's city gives way to it as the server's gives way to every tank)
const SELF: Tank = { x: 0, z: 0, h: 0, v: 0 }, TANKS: Tank[] = [];
function selfTank() { TANKS.length = 0; if (car.k === 0) { SELF.x = car.x; SELF.z = car.z; SELF.h = car.h; SELF.v = car.v; TANKS.push(SELF); } }
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
// the mesh where the simulation put the car (plus the glide back into the lane after a push)
function placeTraffic(c: TrafficCar) {
  placeCar(c);
  c.g.position.set(c.x + (c.ox || 0), 0, c.z + (c.oz || 0)); c.g.rotation.y = Math.atan2(c.hx, c.hz) + (c.oa || 0);
}

// ---------- tram: three cars along Sokolovská, turning loops just outside the arena at both ends (client/shared/tram.ts) ----------
// s: its front's distance along the track; hold: waits after a bump (game/tank.ts); dwell/atStop: at a stop; pts: points along the cars
// (tramNear); nb: the server's rows, its place along the track in x (net/world.ts)
export const TRAM = { s: 0, v: TRAM_VMAX, hold: 0, dwell: 0, atStop: -1, yieldT: 0, vag: [] as TramCar[], pts: [] as V2[], nb: [] as Row[] };
// the height of the track: the street inside the arena, the land on the loops outside it
const trackY = (x: number, z: number) => inArena(x, z) ? 0 : Math.max(0, terrainH(x, z));
export function placeTram() {
  placeTramSim(TRAM);
  for (const v of TRAM.vag) { v.g.position.set(v.x, trackY(v.x, v.z), v.z); v.g.rotation.y = Math.atan2(v.hx, v.hz); }
}
export const tramNear = (x: number, z: number, r: number) => tramNearSim(TRAM, x, z, r);
const MOVERS: Mover[] = [];
// the tram of the intro's own city: wait for anything on the track, give way to the tank, stop at the stops
export function updateTram(dt: number) {
  MOVERS.length = 0; for (const c of TRAFFIC) MOVERS.push(c); for (const c of PARKED) if (c.dyn || c.moved) MOVERS.push(c);
  stepTram(TRAM, dt, TANKS, MOVERS);
  placeTram();
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

// spread the cars over the streets: never near the tank's start in front of the depot, never on top of each other or the tram (the
// shared seedTraffic; seed: the dice for the places and for each car's junctions)
export function seedTraffic(seed: number) {
  seedCars(TRAFFIC, rng(seed), TRAM);
  for (const c of TRAFFIC) { c.dyn = false; c.ox = c.oz = c.oa = 0; placeTraffic(c); }
}
export function seedTram(s: number) { seedTramSim(TRAM, s); placeTram(); }

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
  c.vx = c.hx * c.v; c.vz = c.hz * c.v; c.w = 0; c.v = 0; c.dyn = true; c.phase = 'dyn'; c.dynT = 0; c.calm = 0; c.waitJ = false; c.pe = -1; c.rsv = -1;
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
// how far the vehicle is from the nearest street's centre line (World of DODO, issue #16: the street graph's, was the grid's line it
// pointed along)
function roadOff(c: Car) { const n = nearestEdge(c.x, c.z); return n ? n.d : Infinity; }
// back onto the street: the nearest street, the lane going the way it points, gliding there from where it stands (the server's
// rejoin is the same shared function)
export function rejoin(c0: Car) {
  const c = c0 as TrafficCar, ax = c.x, az = c.z, aang = c.ang;
  c.dyn = false; c.gy = 0;
  rejoinCar(c, ax, az, aang);
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
const OBST: Mover[] = [];
export function updateTraffic(dt: number) {
  selfTank();
  updateTram(dt);
  OBST.length = 0;
  for (const c of PARKED) {
    if (c.dyn) updateDyn(c, dt);
    else if (c.moved) { c.awayT += dt; if (c.awayT > 12 && Math.hypot(c.x - car.x, c.z - car.z) > 70) towHome(c); } // a displaced car does not block the street forever
    if (c.dyn || c.moved) OBST.push(c);
  }
  for (const c of TRAFFIC) if (c.dyn) updateDyn(c, dt);
  stepTraffic(TRAFFIC, dt, TANKS, TRAM, OBST);
  for (const c of TRAFFIC) { if (c.dyn) continue; placeTraffic(c); for (const w of c.wheels) w.rotation.x += c.v * dt / 0.34; }
}

// ---------- parked cars along the kerbs: physical bodies (see "car physics"), drawn as instanced meshes ----------
// (one per paint colour + cabins + wheels). World of DODO, issue #16: their spots and paint come from the shared traffic.ts (PARK,
// picked from the map's kerb spots with the city's seed), so every client parks the same cars in the same order and the server's index
// N_CARS + k is the k-th of PARKED (net/world.ts). They no longer draw from the city's random numbers (core/util.ts R).
export const PARKED: ParkedCar[] = [];
const PBODY: Inst[] = [];
let PD: Dummy | null = null, PCABIN: Inst | null = null, PWHEEL: Inst | null = null;
// every body a car can bump into: the traffic, then the parked cars
export const ALLCARS: Car[] = [];
function parkedCars() {
  const cols = [COL.white, COL.lgrey, COL.grey, COL.charcoal, COL.c80, COL.light, COL.c20];   // traffic.ts PARK_COLS of them
  PARK.forEach((p, gi) => {
    const rot = p.h, ci = p.ci % cols.length;
    PARKED.push({
      parked: true, x: p.x, z: p.z, ang: rot, hx: Math.sin(rot), hz: Math.cos(rot), v: 0, vx: 0, vz: 0, w: 0, gy: 0, g: null, dyn: false, moved: false, awayT: 0, hold: 0, dynT: 0, calm: 0,
      home: [p.x, p.z, rot], ci, li: 0, gi,
      ni: N_CARS + gi, nb: [], net: 0, mine: false, rel: false,                      // World of DODO: the shared city (net/world.ts)
    });
  });
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

// Builds the tram, the traffic and the parked cars. (World of DODO, issue #16: none of it draws from the city's random numbers any
// more, so where main.ts calls it no longer changes the city. The tram's rails, its gravel bed on the loops and the stops' shelters
// are the city's to draw now, world/roads.ts, along client/shared/tram.ts's TRAM_PATH, the track the tram runs on.)
export function buildTraffic() {
  PD = new Dummy();
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
    const c: TrafficCar = Object.assign(newCar(k, Math.random), {
      g, wheels, parked: false as const, ang: 0, vx: 0, vz: 0, w: 0, gy: 0, dyn: false, dynT: 0,
      ni: k, nb: [], net: 0, mine: false, rel: false, calm: 0,                         // World of DODO: the shared city (net/world.ts)
    });
    TRAFFIC.push(c);
  }
  seedTram(TRAM_STOPS[1] - 60); seedTraffic(77);
  parkedCars();
  ALLCARS.push(...TRAFFIC, ...PARKED);
}
