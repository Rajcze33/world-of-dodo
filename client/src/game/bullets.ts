// ---------- World of DODO, issue #14: bullets (the planes' guns, the tanks' anti-aircraft gun, the bots' bursts) ----------
// A bullet flies straight for BUL_LIFE s (no drop at this range), drawn as a glowing tracer, and stops at the first building, the
// ground (issue #16: the terrain round Karlín too) or vehicle on its way. Who decides that it hit:
// - a person's bullet: the shooter. Their browser tests it against the others as drawn there, a little in the past (net/net.ts INTERP);
//   if the victim decided, as for the slow parcels, a fast plane would be out of reach of any gun. The server passes the hit on
//   (netShotHit, then dmg to the victim, who applies it unless immune and answers like a parcel hit).
// - a bot's bullet: the player it hits, as for a parcel (the bot aims at where the server has the plane, server/bots.js).
// Other people's bullets that reach your vehicle on your screen only stop there. World of DODO, issue #20: they hit the ships too (a
// ship is three spheres along its axis), and on the river they raise a little splash.
import { Quaternion } from '@babylonjs/core';
import { Bucket, Inst, Dummy, addGeo, boxGeo } from '../core/geo';
import { basic } from '../core/mat';
import { T } from '../texts';
import { car } from './state';
import { segHit, groundH } from '../world/grid';
import { WATER_Y, surfaceY } from '../../shared/naval.ts';
import { splash } from '../world/water';
import { NET, netFire, netHit, netName, netShotHit, netThit, type NetOther } from '../net/net';
import { flash } from '../ui/hud';
import { hitPlayer } from './tank';
import { friendly } from './teams';
import { depotSeg } from '../world/objectives';
import { monSeg, monReport, monSpark } from './monster';

export const BUL_V = 170, BUL_LIFE = 1.6;                  // speed (units/s, plus the shooter's own), seconds in flight
const BUL_MAX = 192;
export const PLANE_R = 2.4, TANK_R = 1.35, SHIP_R = 3;     // what a bullet hits: a sphere round a plane, two round a tank (front and back), three along a ship

interface Bullet {
  i: number; on: boolean; mine: boolean; bot: boolean; by: number; sid: number;
  x: number; y: number; z: number; vx: number; vy: number; vz: number; age: number;
}
const bullets: Bullet[] = [];
let next = 0, tracers: Inst | null = null;
const D = new Dummy(), HIDDEN = new Float32Array(16); HIDDEN[13] = -1000; HIDDEN[15] = 1;

function spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number): Bullet {
  const b = bullets[next]; next = (next + 1) % BUL_MAX;
  Object.assign(b, { on: true, mine: false, bot: false, by: 0, sid: 0, x, y, z, vx, vy, vz, age: 0 });
  return b;
}
// one of mine: drawn here and sent to the others (net/net.ts netFire, k 1)
export function fireBullet(x: number, y: number, z: number, vx: number, vy: number, vz: number) {
  const b = spawn(x, y, z, vx, vy, vz); b.mine = true;
  const m = { x, y, z, vx, vy, vz, sid: 0 }; netFire(m, 1); b.sid = m.sid;
}
// someone else's (net/net.ts, a fire message with k 1); a bot's can hit me
export function netBullet(m: { id: number; sid: number; x: number; y: number; z: number; vx: number; vy: number; vz: number }, bot: boolean) {
  const b = spawn(m.x, m.y, m.z, m.vx, m.vy, m.vz); b.bot = bot; b.by = m.id; b.sid = m.sid;
}
export function clearBullets() { for (const b of bullets) b.on = false; draw(); }

// where along the segment a + d·t (t in 0..1) it first touches the sphere round c, or 2 if it does not
function segSphere(ax: number, ay: number, az: number, dx: number, dy: number, dz: number, cx: number, cy: number, cz: number, r: number) {
  const fx = ax - cx, fy = ay - cy, fz = az - cz, a = dx * dx + dy * dy + dz * dz, b = fx * dx + fy * dy + fz * dz, c = fx * fx + fy * fy + fz * fz - r * r;
  if (c <= 0) return 0;                                    // starts inside
  const disc = b * b - a * c; if (disc < 0 || a < 1e-9) return 2;
  const t = (-b - Math.sqrt(disc)) / a; return t >= 0 && t <= 1 ? t : 2;
}
// the same for a vehicle: a plane (k 1) at x, y, z, or a tank at x, z on the ground gy, heading h; issue #20: a ship (k 2) at x, z,
// heading h, y its heave and sinking (its spheres round the collision circles' centres, game/ship.ts SHIP_C)
export function vehicleT(ax: number, ay: number, az: number, dx: number, dy: number, dz: number,
  k: number, x: number, y: number, z: number, h: number, gy: number) {
  if (k === 1) return segSphere(ax, ay, az, dx, dy, dz, x, y, z, PLANE_R);
  if (k === 2) {
    const hx = Math.sin(h), hz = Math.cos(h), cy = WATER_Y + y + 1.6; let t = 2;
    for (const j of [-7, 0, 7]) t = Math.min(t, segSphere(ax, ay, az, dx, dy, dz, x + hx * j, cy, z + hz * j, SHIP_R));
    return t;
  }
  const hx = Math.sin(h) * 1.2, hz = Math.cos(h) * 1.2;
  return Math.min(segSphere(ax, ay, az, dx, dy, dz, x + hx, gy + 1.1, z + hz, TANK_R), segSphere(ax, ay, az, dx, dy, dz, x - hx, gy + 1.1, z - hz, TANK_R));
}

export function updateBullets(dt: number) {
  for (const b of bullets) {
    if (!b.on) continue;
    b.age += dt; if (b.age > BUL_LIFE) { b.on = false; continue; }
    const dx = b.vx * dt, dy = b.vy * dt, dz = b.vz * dt;
    // the first solid (issue #16: map.ts segHit, the footprint polygons, the viaduct, the houses out on the hills), then the ground:
    // the street, or outside the arena the terrain (issue #20: the river's surface, client/shared/naval.ts surfaceY) where the step
    // ends (a step is about the terrain grid's 10 units; a bullet that would end inside a hill stops where it is)
    let t = segHit(b.x, b.y, b.z, b.x + dx, b.y + dy, b.z + dz), who: NetOther | 'me' | null = null, wet = false;
    const se = surfaceY(b.x + dx, b.z + dz), ge = se + 0.05;
    if (b.y + dy < ge) { const u = dy < 0 ? Math.max(0, (b.y - ge) / -dy) : 0; if (u < t) { t = u; wet = se === WATER_Y; } }
    const ex = b.x + dx * 0.5, ez = b.z + dz * 0.5, reach = Math.hypot(dx, dz) * 0.5 + 6;
    for (const o of NET.others.values()) {
      const r = o.k === 2 ? reach + 8 : reach;
      if (!o.on || (o.s === 2 && o.k !== 0) || o.id === b.by || Math.abs(o.x - ex) > r || Math.abs(o.z - ez) > r) continue;
      const u = vehicleT(b.x, b.y, b.z, dx, dy, dz, o.k, o.x, o.y, o.z, o.h, groundH(o.x, o.z)); if (u < t) { t = u; who = o; wet = false; }
    }
    const rm = car.k === 2 ? reach + 8 : reach;
    if (!b.mine && car.topT <= 0 && Math.abs(car.x - ex) < rm && Math.abs(car.z - ez) < rm) {
      const u = vehicleT(b.x, b.y, b.z, dx, dy, dz, car.k, car.x, car.y, car.z, car.h, car.gy); if (u < t) { t = u; who = 'me'; wet = false; }
    }
    // World of DODO, issue #24: a standing supply depot stops it too; mine tells the server (net/net.ts netThit), which decides the damage
    let dep = -1; const dh = depotSeg(b.x, b.y, b.z, dx, dy, dz); if (dh && dh.t < t) { t = dh.t; who = null; wet = false; dep = dh.i; }
    // World of DODO, issue #26: Velemlok stops it too; mine reports it (mhit, k 1)
    let mon = false; const mt = monSeg(b.x, b.y, b.z, b.x + dx, b.y + dy, b.z + dz); if (mt < t) { t = mt; who = null; wet = false; dep = -1; mon = true; }
    b.x += dx * Math.min(1, t); b.y += dy * Math.min(1, t); b.z += dz * Math.min(1, t);
    if (t >= 1) continue;
    b.on = false;
    if (wet) splash(b.x, b.z, 0.15);
    if (dep >= 0 && b.mine) netThit(dep, 1, b.x, b.y, b.z, b.sid);
    if (mon) { monSpark(b.x, b.y, b.z, 1); if (b.mine) monReport(1, b.sid, b.x, b.y, b.z); }
    // a bot's bullet that took effect: scores for the bot. Issue #24: a teammate's (a bot's or, passed on as dmg, a person's) does nothing,
    // and mine in a teammate is not reported
    if (who === 'me' && b.bot && !friendly(b.by) && hitPlayer('bullet', 1, T.gunBy(netName(b.by)))) {
      const kill = car.topT > 0; if (kill) flash(T.killedBy(netName(b.by))); netHit(b, kill);
    }
    else if (who && who !== 'me' && b.mine && !friendly(who.id)) netShotHit(who.id, b.sid);   // mine hit someone here: the server passes it on
  }
  draw();
}

// the tracers: one instanced mesh, a thin glowing bar along the flight
const Q = new Quaternion();
function draw() {
  if (!tracers) return;
  for (const b of bullets) {
    if (!b.on) { tracers.setMatrixAt(b.i, HIDDEN); continue; }
    Quaternion.RotationYawPitchRollToRef(Math.atan2(b.vx, b.vz), -Math.atan2(b.vy, Math.hypot(b.vx, b.vz)), 0, Q);
    D.quaternion.copyFrom(Q); D.position.set(b.x, b.y, b.z); tracers.setMatrixAt(b.i, D.updateMatrix());
  }
  tracers.update();
}
// main.ts calls this once, after the parcels
export function buildBullets() {
  const g = Bucket(); addGeo(g, boxGeo(0.11, 0.11, 2.6), null, 0xffffff);
  tracers = new Inst('tracers', g, basic(0xffd98a, { fog: false }), BUL_MAX, { receive: false });
  for (let i = 0; i < BUL_MAX; i++) bullets.push({ i, on: false, mine: false, bot: false, by: 0, sid: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0 });
  draw();
}
