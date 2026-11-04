// ---------- parcel cannon: Space fires delivery parcels from the tank ----------
// Parcels fly on a ballistic arc and collide with: the buildings (issue #16: Karlín's, with the Negrelli viaduct and the depot hall),
// the construction site, parked cars, moving cars, the tram, people, the tanks and the ground. They bounce, then come to rest and
// fade out after a while. World of DODO, issue #20: they hit the ships too, and the river is water now: a parcel that comes down on it
// splashes and sinks (client/shared/naval.ts surfaceY, world/water.ts splash).
// (The original also delivered a stop with a parcel that landed in its ring; World of DODO has no deliveries.)
import { Bucket, Inst, Dummy, addGeo, boxGeo } from '../core/geo';
import { VC_MAT } from '../core/mat';
import { COL } from '../core/colors';
import { T } from '../texts';
import { car } from './state';
import type { Car, Ped } from './types';
import { solidHit, groundH, AIR_LIM } from '../world/grid';
import { WATER_Y, surfaceY } from '../../shared/naval.ts';
import { splash } from '../world/water';
import { ALLCARS, TRAM, TRAM_L, TRAM_W, PARCEL_M, carBody, putBody, impulse, toDyn } from '../world/traffic';
import { PEDS, knockPed } from '../world/peds';
import { NET, netFire, netHit, netName, netThit } from '../net/net';
import { WORLD, netPed } from '../net/world';
import { flash } from '../ui/hud';
import { hitPlayer } from './tank';
import { PLANE_R } from './bullets';
import { shipBox, SHIP_HH, burst } from './shells';
import { friendly, teamOf } from './teams';
import { depotBody, depotHitAt } from '../world/objectives';

export const SHOT_MAX = 64, SHOT_G = 14;
const SHOT_SPEED = 45, SHOT_UP = 4, SHOT_CD = 0.28, SHOT_LIFE = 14, SHOT_E = 0.4;
let shotCd = 0;
export let shotNext = 0;

// a parcel in flight or at rest. owner: 'p' mine, 'r' another player's (or a bot's; net/net.ts netShot), by/sid: who fired it and
// its number in that player's messages, scored: it already counted as a hit on me. ox, oz: World of DODO, another player's parcel is
// drawn this far off its real path and slides onto it. g: where it is drawn (position, rotation as three's XYZ Euler, scale), vis: drawn
export interface Shot {
  i: number;
  g: Dummy; vis: boolean;
  on: boolean; rest: boolean; touched: boolean; owner: string; by: number; sid: number; scored: boolean;
  age: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; wx: number; wy: number; ox: number; oz: number;
}
export const shots: Shot[] = [];
// World of DODO: all parcels are one instanced mesh, the box and its green strap merged with vertex colours (one draw call; three
// drew two meshes per parcel). A parcel that is not drawn gets a matrix that shrinks it to a point far below the city.
let parcels: Inst | null = null;
const HIDDEN = new Float32Array(16); HIDDEN[13] = -1000; HIDDEN[15] = 1;
function drawShot(s: Shot) { parcels?.setMatrixAt(s.i, s.vis ? s.g.updateMatrix() : HIDDEN); }
function drawShots() { if (!parcels) return; for (const s of shots) drawShot(s); parcels.update(); }

// the next parcel of the ring (the oldest one is reused)
export function nextShot(): Shot { const s = shots[shotNext]; shotNext = (shotNext + 1) % SHOT_MAX; return s; }
// show a parcel that was just fired at its place (x + ox, y, z + oz), facing yaw, at full size; net/net.ts calls this for the
// parcels of the other players (three: g.visible, g.scale.setScalar(1), g.rotation.set(0, yaw, 0), g.position.set)
export function showShot(s: Shot, yaw: number) {
  s.vis = true; s.g.scale.setAll(1); s.g.rotation.set(0, yaw, 0); s.g.position.set(s.x + (s.ox || 0), s.y, s.z + (s.oz || 0));
  drawShot(s); parcels?.update();
}

type N3 = [number, number, number];
// what a parcel touched: n the normal, top the height of a roof it lands on, car the vehicle (a car, a tram wagon; null for a tank),
// player: my tank, ped: a person
export interface ShotHit { n: N3; top?: number; car?: unknown; player?: boolean; ped?: Ped }
// oriented box test for a moving vehicle c (centre c.x,c.z, heading hx,hz): half length L, half width W, height H
export function obbHit(x: number, y: number, z: number, px: number, py: number, pz: number, c: { x: number; z: number },
  hx: number, hz: number, L: number, W: number, H: number): ShotHit | null {
  if (y >= H) return null;
  const a = (x - c.x) * hx + (z - c.z) * hz, b = (x - c.x) * hz - (z - c.z) * hx; if (Math.abs(a) >= L || Math.abs(b) >= W) return null;
  const pa = (px - c.x) * hx + (pz - c.z) * hz, pb = (px - c.x) * hz - (pz - c.z) * hx;
  if (py >= H) return { n: [0, 1, 0], car: c };
  if (Math.abs(pa) >= L) { const s = Math.sign(pa); return { n: [hx * s, 0, hz * s], car: c }; }
  const s = Math.sign(pb) || 1; return { n: [hz * s, 0, -hx * s], car: c };
}
// does a parcel now at (x,y,z) — it was at (px,py,pz) a moment ago — touch anything solid? returns {n:normal, top?:surface height, car?:vehicle}
export function shotHit(x: number, y: number, z: number, px: number, py: number, pz: number, owner?: string): ShotHit | null {
  // World of DODO, issue #16: the solids are footprint polygons (map.ts solidHit): from above it lands on the roof (top), else it
  // bounces off the nearest wall (or the underside of the viaduct's deck). They were axis-aligned boxes.
  const sh = solidHit(x, y, z, px, py, pz);
  if (sh) return sh.top !== undefined ? { n: sh.n, top: sh.top } : { n: sh.n };
  for (const c of ALLCARS) { if (Math.abs(c.x - x) > 4 || Math.abs(c.z - z) > 4) continue; const h = obbHit(x, y, z, px, py, pz, c, c.hx, c.hz, c.hl || 2.1, c.hw || 0.95, c.hh || 1.8); if (h) return h; }
  for (const v of TRAM.vag) { if (Math.abs(v.x - x) > 6 || Math.abs(v.z - z) > 6) continue; const h = obbHit(x, y, z, px, py, pz, v, v.hx, v.hz, TRAM_L / 2, TRAM_W / 2, 3.4); if (h) return h; }
  for (const p of PEDS) {
    if (p.state !== 'walk' || Math.abs(p.x - x) > 0.7 || Math.abs(p.z - z) > 0.7) continue;       // a person: a 2-unit-tall cylinder
    const g0 = groundH(p.x, p.z); if (y < g0 || y > g0 + 2.1 || Math.hypot(x - p.x, z - p.z) >= 0.55) continue;
    const dx = px - p.x, dz = pz - p.z, l = Math.hypot(dx, dz) || 1; return { n: [dx / l, 0, dz / l], ped: p };
  }
  if (owner === 'r' && car.topT <= 0) {                                                              // other players' parcels hit YOUR tank, plane or ship
    const h = car.k === 1 ? sphereHit(x, y, z, px, py, pz, car.x, car.y, car.z) : car.k === 2 ? shipHit(x, y, z, px, py, pz, car.x, car.y, car.z, car.h)
      : obbHit(x, y, z, px, py, pz, car, Math.sin(car.h), Math.cos(car.h), 2.4, 1.15, 2.1 + car.gy);
    if (h) { h.car = null; h.player = true; return h; }
  }
  // other players' tanks, planes and ships: every parcel bounces off them here; whether it hit is decided on that player's screen
  for (const o of NET.others.values()) {
    const R = o.k === 2 ? 12 : 4;
    if (!o.on || o.s === 2 && o.k !== 0 || Math.abs(o.x - x) > R || Math.abs(o.z - z) > R) continue;
    const h = o.k === 1 ? sphereHit(x, y, z, px, py, pz, o.x, o.y, o.z) : o.k === 2 ? shipHit(x, y, z, px, py, pz, o.x, o.y, o.z, o.h)
      : obbHit(x, y, z, px, py, pz, o, o.hx, o.hz, 2.4, 1.15, 2.1 + groundH(o.x, o.z));
    if (h) { h.car = null; return h; }
  }
  return null;
}
// World of DODO, issue #20: a ship's hit box (game/shells.ts shipBox); from above a parcel bounces off its top, else off its side
function shipHit(x: number, y: number, z: number, px: number, py: number, pz: number, sx: number, sy: number, sz: number, h: number): ShotHit | null {
  if (!shipBox(x, y, z, sx, sy, sz, h)) return null;
  if (py >= WATER_Y + sy + SHIP_HH) return { n: [0, 1, 0] };
  const hx = Math.sin(h), hz = Math.cos(h), s = Math.sign((px - sx) * hz - (pz - sz) * hx) || 1; return { n: [hz * s, 0, -hx * s] };
}
// World of DODO, issue #14: a plane is a sphere for the parcels (as for the bullets, game/bullets.ts); the normal points from its centre
function sphereHit(x: number, y: number, z: number, px: number, py: number, pz: number, cx: number, cy: number, cz: number): ShotHit | null {
  if (Math.hypot(x - cx, y - cy, z - cz) >= PLANE_R) return null;
  const dx = px - cx, dy = py - cy, dz = pz - cz, l = Math.hypot(dx, dy, dz) || 1; return { n: [dx / l, dy / l, dz / l] };
}
export function fireShot() {
  if (shotCd > 0) return; shotCd = SHOT_CD;
  const s = nextShot();
  const fx = Math.sin(car.h), fz = Math.cos(car.h), sp = SHOT_SPEED + Math.max(0, car.v);
  s.on = true; s.rest = false; s.touched = false; s.owner = 'p'; s.age = 0; s.ox = s.oz = 0; s.x = car.x + fx * 3.1; s.y = 1.5 + car.gy; s.z = car.z + fz * 3.1; s.vx = fx * sp; s.vz = fz * sp; s.vy = SHOT_UP;
  s.wx = (Math.random() - 0.5) * 10; s.wy = (Math.random() - 0.5) * 10;
  // muzzle pushed into a wall or a parked car: drop the parcel at the tank instead of firing it through
  if (shotHit(s.x, s.y, s.z, car.x, 1.5 + car.gy, car.z)) { s.x = car.x; s.z = car.z; s.vx = s.vz = 0; }
  showShot(s, car.h);
  netFire(s);
}
// World of DODO, issue #14: a parcel dropped from a plane at (x, y, z) with the plane's speed; flies and collides like the tank's
export function dropShot(x: number, y: number, z: number, vx: number, vy: number, vz: number) {
  const s = nextShot();
  s.on = true; s.rest = false; s.touched = false; s.owner = 'p'; s.age = 0; s.ox = s.oz = 0; s.x = x; s.y = y; s.z = z; s.vx = vx; s.vy = vy; s.vz = vz;
  s.wx = (Math.random() - 0.5) * 10; s.wy = (Math.random() - 0.5) * 10;
  showShot(s, Math.atan2(vx, vz));
  netFire(s);
}
// a parcel fired from (x,z) along (fx,fz) at speed sp (the original's delivery and REDLINE tanks fired with this; nothing in World of
// DODO does now): flies and collides like yours
export function spawnShot(x: number, z: number, fx: number, fz: number, sp: number, owner: string): Shot {
  const s = nextShot();
  s.on = true; s.rest = false; s.touched = false; s.owner = owner; s.age = 0; s.ox = s.oz = 0; s.x = x + fx * 3.1; s.y = 1.5; s.z = z + fz * 3.1; s.vx = fx * sp; s.vz = fz * sp; s.vy = SHOT_UP;
  s.wx = (Math.random() - 0.5) * 10; s.wy = (Math.random() - 0.5) * 10; showShot(s, Math.atan2(fx, fz)); return s;
}
// World of DODO, issue #24: parcel s bursts at supply depot i (game/shells.ts burst); mine reports the hit (thit, k 0)
function depotBurst(s: Shot, i: number) {
  burst(s.x, s.y, s.z, 0.8); if (s.owner === 'p') netThit(i, 0, s.x, s.y, s.z, s.sid);
  s.on = false; s.vis = false;
}
export function clearShots() { shots.forEach(s => { s.on = false; s.vis = false; }); shotCd = 0; drawShots(); }
export function updateShots(dt: number) {
  shotCd = Math.max(0, shotCd - dt);
  for (const s of shots) {
    if (!s.on) continue; s.age += dt;
    if (s.age > SHOT_LIFE || Math.abs(s.x) > AIR_LIM + 80 || Math.abs(s.z) > AIR_LIM + 80) { s.on = false; s.vis = false; continue; }
    if (s.age > SHOT_LIFE - 1) s.g.scale.setAll(Math.max(0.01, SHOT_LIFE - s.age));
    if (s.rest) continue;
    const sp = Math.hypot(s.vx, s.vy, s.vz), n = Math.max(1, Math.ceil(sp * dt / 0.4)), h = dt / n;
    for (let i = 0; i < n; i++) {
      const px = s.x, py = s.y, pz = s.z;
      s.vy -= SHOT_G * h; s.x += s.vx * h; s.y += s.vy * h; s.z += s.vz * h;
      // World of DODO, issue #24: a parcel that runs into a standing supply depot bursts there, on every screen; mine tells the server,
      // which decides the damage (net/net.ts netThit: not for my own team's depots)
      const di = depotBody(s.x, s.y, s.z);
      if (di >= 0) { depotBurst(s, di); break; }
      const hit = shotHit(s.x, s.y, s.z, px, py, pz, s.owner);
      if (hit) {
        if (hit.top !== undefined) { s.y = hit.top + 0.25; s.vx = s.vy = s.vz = 0; s.rest = true; s.g.rotation.x = s.g.rotation.z = 0; break; } // lands on a roof
        s.x = px; s.y = py; s.z = pz;                                   // step back out of the obstacle, then bounce
        const nx = hit.n[0], ny = hit.n[1], nz = hit.n[2], vn = s.vx * nx + s.vy * ny + s.vz * nz;
        const c = hit.car as Car | null | undefined;
        // parcel vs traffic car: the parcel shoves it. World of DODO: in the shared city only your own parcel shoves a car, and only one
        // nobody else is pushing; the car becomes yours (toDyn claims it). Other parcels bounce off it.
        if (c && c.hold !== undefined && ny === 0 && (!WORLD.on || (s.owner === 'p' && !c.net))) {
          toDyn(c);
          const A = carBody(c), B = { cx: s.x, cz: s.z, vx: s.vx, vz: s.vz, w: 0, im: 1 / PARCEL_M, iI: 0 };
          impulse(A, B, s.x, s.z, nx, nz, 0.35); putBody(c, A); s.vx = B.vx; s.vz = B.vz;
        }
        else if (hit.player) {                                                   // another player's parcel hits you
          const sg = Math.random() < 0.5 ? 1 : -1;
          // a hit that took effect scores for the shooter (World of DODO, issue #24: a teammate's parcel only bounces off)
          if (!s.scored && !friendly(s.by) && hitPlayer('shot', sg, (car.k === 2 ? T.shipHitBy : T.hitBy)(netName(s.by)))) {
            s.scored = true; const kill = car.topT > 0;
            if (kill) flash(T.killedBy(netName(s.by))); netHit(s, kill);
          }
          s.vx *= 0.2; s.vz *= 0.2; s.vy = Math.abs(s.vy) * 0.3 + 1.5;
        }
        else if (hit.ped) {                                                      // parcel hits a person: they go down
          if (!WORLD.on) knockPed(hit.ped, s.vx, s.vz); else if (s.owner === 'p') netPed(hit.ped, s.vx, s.vz);
          s.vx *= 0.3; s.vz *= 0.3; s.vy = Math.abs(s.vy) * 0.3 + 1.5;          // (shared city: your own parcel tells the server; no police in World of DODO)
        }
        else if (vn < 0) { s.vx -= (1 + SHOT_E) * vn * nx; s.vy -= (1 + SHOT_E) * vn * ny; s.vz -= (1 + SHOT_E) * vn * nz; s.vx *= 0.85; s.vz *= 0.85; }
        s.wx = -s.wx * 0.6 + (Math.random() - 0.5) * 4; s.wy = -s.wy * 0.6 + (Math.random() - 0.5) * 4;
      }
      // the street (as the original, a hair above it), the pavement (0.3); issue #16: outside the arena the terrain. Issue #20: the
      // river is water (client/shared/naval.ts surfaceY): the parcel splashes and sinks. server/bots.js flies the parcels aimed at the
      // bots on the same ground (the bots stay in the arena, so it does without the river)
      const g0 = surfaceY(s.x, s.z), gy = g0 > 0 ? g0 : g0 + 0.04;
      if (g0 === WATER_Y && s.y < g0) { splash(s.x, s.z, 0.45); s.on = false; s.vis = false; break; }
      if (s.y < gy + 0.25) {
        s.y = gy + 0.25;
        // World of DODO, issue #24: where it first comes down near an enemy's supply depot (client/shared/rules.ts depotAt, within
        // DEPOT_NEAR of it) it bursts and counts, as on the server; the shooter's own team's depots it only bounces past
        if (!s.touched && s.vy < 0) {
          s.touched = true;
          const dn = depotHitAt(s.x, s.y, s.z, 0, s.owner === 'p' ? NET.team : teamOf(s.by)); if (dn >= 0) { depotBurst(s, dn); break; }
        }
        if (s.vy < 0) { s.vy = -s.vy * SHOT_E; s.vx *= 0.78; s.vz *= 0.78; s.wx *= 0.6; s.wy *= 0.6; if (s.vy < 1.8) s.vy = 0; }
        if (s.vy === 0) {
          s.vx *= Math.max(0, 1 - 4 * h); s.vz *= Math.max(0, 1 - 4 * h);
          if (Math.hypot(s.vx, s.vz) < 0.4) { s.vx = s.vz = 0; s.rest = true; s.g.rotation.x = s.g.rotation.z = 0; break; }
        }
      }
    }
    if (s.ox || s.oz) { const f = Math.exp(-6 * dt); s.ox *= f; s.oz *= f; if (Math.abs(s.ox) + Math.abs(s.oz) < 0.02) s.ox = s.oz = 0; }   // World of DODO: another player's parcel slides onto its real path
    s.g.position.set(s.x + (s.ox || 0), s.y, s.z + (s.oz || 0));
    if (!s.rest) { s.g.rotation.x += s.wx * dt; s.g.rotation.y += s.wy * dt; }
  }
  drawShots();
}

// the parcels' mesh and the ring of SHOT_MAX parcels (main.ts calls this once, after the tank)
export function buildShots() {
  const geo = Bucket();
  addGeo(geo, boxGeo(0.62, 0.46, 0.5), null, COL.white);       // the box (M.white)
  addGeo(geo, boxGeo(0.64, 0.48, 0.12), null, COL.green);      // its strap (M.green)
  parcels = new Inst('parcel', geo, VC_MAT, SHOT_MAX, { cast: true });
  for (let i = 0; i < SHOT_MAX; i++) {
    shots.push({ i, g: new Dummy(), vis: false, on: false, rest: false, touched: false, owner: '', by: 0, sid: 0, scored: false,
      age: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, ox: 0, oz: 0 });
  }
  drawShots();
}
