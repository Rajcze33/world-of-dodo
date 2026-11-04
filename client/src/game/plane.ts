// ---------- World of DODO, issue #14: the planes ----------
// A plane flies where the mouse aims, as the "mouse aim" of War Thunder's arcade battles: the mouse turns an aim direction (the camera
// looks along it from behind the plane) and an instructor turns the plane towards it, as fast as its speed allows, banking into the
// turn. The arrow keys (A, D) and the touch pad move the aim too. The flight is arcade: throttle and gravity trade speed for height (a
// climb slows the plane, a dive speeds it up, a hard turn bleeds speed); below V_STALL it stalls and the nose drops until it is fast
// again; the ground, a building, a standing tree or another vehicle destroy it; at the edge of the airspace (AIR_LIM) it is turned
// back. It fires two guns (game/bullets.ts) and drops parcels on the tanks (game/shots.ts dropShot), a few at a time, reloading in
// the air. World of DODO, issue #16: the ground round Karlín is the real terrain (Vítkov rises some 60 units south of the arena, Letná
// behind the river), and the houses out there are solid too (client/shared/map.ts): a plane can fly into the hill.
//
// The plane is the player's vehicle (car, game/state.ts) as the tank is: x, z, h (heading), v, roll (its bank), plus y (altitude) and
// p (pitch, nose up positive). Its forward direction is (sin h cos p, sin p, cos h cos p).
import { Matrix, TransformNode, Vector3, type StandardMaterial } from '@babylonjs/core';
import { scene, camera, removeCaster } from '../core/engine';
import { Bucket, addGeo, boxGeo, cylGeo, coneGeo, sphereGeo, planeGeo, circleGeo, ringGeo, rotateX, rotateY, rotateZ, scaleGeo, translate, geoMesh, type Geo } from '../core/geo';
import { VC_MAT, VC_GLOW, basic, lambert } from '../core/mat';
import { logoTex } from '../core/tex';
import { COL } from '../core/colors';
import { $, COARSE } from '../core/dom';
import { clamp, angLerp } from '../core/util';
import { T } from '../texts';
import { G, car, K, HELD, input, view } from './state';
import { solidNear, solidsIn, groundH, terrainH, AIR_LIM, AIR_TOP, UNIT_M, type Solid } from '../world/grid';
import { propsNear } from '../world/props';
import { landHit, WATER_Y } from '../world/land';
import { NET } from '../net/net';
import { flash } from '../ui/hud';
import { carStatus, toppleCar, camLook, vanOwnMat, SPAWN_IMMUNE } from './tank';
import { fireBullet, BUL_V, PLANE_R } from './bullets';
import { dropShot, SHOT_G } from './shots';

// flight: stall speed, the speed of the best turn, engine thrust, drag, gravity (arcade: stronger than real, so height costs speed),
// the fastest turn (rad/s), the speed a hard turn bleeds, how far the plane banks into a turn
const V_STALL = 14, V_TURN = 26, THRUST = 12, DRAG = 0.0075, GRAV = 16, TURN = 1.25, TURN_DRAG = 0.07, BANK = 0.9;
const AIM_P = 1.35, SENS = 0.0022;                          // the aim's pitch limit (rad), mouse sensitivity (rad per pixel)
const GUN_RATE = 1 / 12, GUN_CONV = 150;                    // seconds between bullets (the two guns take turns), where their lines meet
const BOMBS = 4, BOMB_RELOAD = 5, BOMB_CD = 0.6;            // parcels on board, seconds to load another, seconds between drops
// a plane comes in from the edge of the airspace (issue #16: 100 inside it, as 380 was inside 450), at this height (or higher over
// the hills, see spawnPlane) and speed
const SPAWN_R = AIR_LIM - 100, SPAWN_Y = 80, SPAWN_V = 32;
// the speed in km/h and the height in metres. World of DODO, issue #16: 1 unit is 1.5 m in the real Karlín (UNIT_M; it was 5 m, which
// made a plane at its top speed fly 1530 km/h); a tank's speedometer keeps the original's own factor (main.ts)
export const KMH = UNIT_M * 3.6, M_PER_U = UNIT_M;

// the plane's own state: throttle (0..1), the aim (yaw, pitch), stalled, the guns, the parcels on board and their reload, the warning
// at the edge of the airspace
export const pl = { thr: 0.75, aimY: 0, aimP: 0, stall: false, gunCd: 0, gun: 1, bombCd: 0, bombs: BOMBS, bombT: 0, t: 0 };   // t: seconds since it came in

// ---------- the model ----------
// A low-poly propeller fighter, nose along +z, the right wing towards -x, about 5.6 long with a 7.4 wingspan (the game's vehicles are
// about twice their real size). Seven meshes: the paint (the player's colour, shared with their tank), the vertex-coloured rest, the
// canopy, the navigation lights, the DODO logos on the wings, and the propeller (its blades and a faint disc) on a node that spins.
export function makePlane(paint: StandardMaterial): TransformNode {
  const g = new TransformNode('plane', scene);
  const mesh = (name: string, geo: Geo, mat: StandardMaterial, cast: boolean, parent: TransformNode = g) => { const m = geoMesh(name, geo, mat, cast, false); m.parent = parent; return m; };
  const at = (geo: Geo, x: number, y: number, z: number) => translate(geo, x, y, z);
  const along = (geo: Geo) => rotateX(geo, Math.PI / 2);                            // a cylinder's top end to the nose (+z)
  const paintG = Bucket(), rest = Bucket(), glow = Bucket();
  addGeo(paintG, at(along(cylGeo(0.5, 0.62, 2.0, 10)), 0, 0, 1.45), null, 0xffffff);        // the fuselage: engine section
  addGeo(paintG, at(along(cylGeo(0.62, 0.2, 3.0, 10)), 0, 0, -1.05), null, 0xffffff);       // and the tail cone
  for (const sx of [-1, 1]) {
    addGeo(paintG, at(rotateZ(boxGeo(3.3, 0.16, 1.5), sx * 0.06), sx * 1.95, -0.28, 0.55), null, 0xffffff);   // wings, a little dihedral
    addGeo(rest, at(rotateZ(boxGeo(0.45, 0.17, 1.52), sx * 0.06), sx * 3.1, -0.21, 0.55), null, COL.white);  // white stripes near the tips
    addGeo(rest, at(along(cylGeo(0.05, 0.05, 0.7, 6)), sx * 1.5, -0.3, 1.45), null, COL.charcoal);            // the guns
    addGeo(glow, at(boxGeo(0.18, 0.12, 0.18), sx * 3.62, -0.15, 0.55), null, sx > 0 ? 0xff4040 : 0x40ff80);   // port red (+x), starboard green
  }
  addGeo(paintG, at(boxGeo(2.8, 0.1, 0.75), 0, 0.05, -2.3), null, 0xffffff);                // tailplane
  addGeo(paintG, at(boxGeo(0.1, 1.05, 0.95), 0, 0.55, -2.3), null, 0xffffff);               // fin
  addGeo(rest, at(along(cylGeo(0.52, 0.52, 0.22, 12)), 0, 0, 2.5), null, COL.charcoal);     // the cowling's ring
  addGeo(rest, at(along(coneGeo(0.24, 0.55, 10)), 0, 0, 2.86), null, COL.white);            // the spinner
  addGeo(glow, at(boxGeo(0.14, 0.14, 0.14), 0, 0.3, -2.8), null, 0xffffff);                 // the tail light
  mesh('planePaint', paintG, paint, true); mesh('planeParts', rest, VC_MAT, true); mesh('planeLights', glow, VC_GLOW, false);
  mesh('planeCanopy', at(scaleGeo(sphereGeo(0.42, 10, 6, Math.PI / 2), 1, 1, 2.1), 0, 0.42, 0.1), lambert(0x1d2a33, { emissive: COL.light, emissiveIntensity: 0.3 }), false);
  // the logo on top of each wing, readable from behind the plane
  const logo = (sx: number) => at(rotateY(rotateX(planeGeo(1.9, 0.64), -Math.PI / 2), Math.PI), sx * 2.0, -0.19 + sx * 0.0, 0.55);
  const lg = Bucket(); addGeo(lg, logo(-1), null, 0xffffff); addGeo(lg, logo(1), null, 0xffffff);
  mesh('planeLogo', lg, basic(0xffffff, { map: logoTex, transparent: true }), false);
  // the propeller: three blades and a faint disc, spun by planeView
  const prop = new TransformNode('planeProp', scene); prop.parent = g; prop.position.set(0, 0, 2.66);
  const blades = Bucket(); for (let k = 0; k < 3; k++) addGeo(blades, rotateZ(at(boxGeo(0.18, 1.15, 0.05), 0, 0.62, 0), k * Math.PI * 2 / 3), null, COL.charcoal);
  mesh('planeBlades', blades, VC_MAT, false, prop);
  mesh('planeDisc', circleGeo(1.25, 24), basic(0xffffff, { transparent: true, opacity: 0.06, double: true, depthWrite: false }), false, prop);
  g.metadata = { prop };
  return g;
}
// another player's plane leaves (net/net.ts): its meshes go, with their shadows and own materials (the paint is the caller's)
export function disposePlane(g: TransformNode) {
  for (const m of g.getChildMeshes()) { removeCaster(m); if (m.material && m.material !== VC_MAT && m.material !== VC_GLOW && m.name !== 'planePaint') m.material.dispose(); }
  g.dispose();
}

// the player's plane mesh and the bomb sight (a ring where a parcel dropped now would land); main.ts calls this after the tank
let sight: TransformNode | null = null;
export function buildPlane() {
  view.plane = makePlane(vanOwnMat); view.plane.setEnabled(false);
  const ring = geoMesh('bombSight', rotateX(ringGeo(2.2, 2.8, 32), -Math.PI / 2), basic(0xffffff, { transparent: true, opacity: 0.55, depthWrite: false, additive: true, double: true }), false, false);
  sight = ring; ring.setEnabled(false);
}

// ---------- spawning ----------
// on a circle round the city at the edge of the airspace, facing its centre, as far from the others as it allows
export function spawnPlane() {
  let best = 0, bs = -1;
  for (let i = 0; i < 16; i++) {
    const a = i / 16 * Math.PI * 2, x = Math.sin(a) * SPAWN_R, z = Math.cos(a) * SPAWN_R;
    let d = 1400; for (const o of NET.others.values()) if (o.on) d = Math.min(d, Math.hypot(o.x - x, o.z - z));
    const sc = d + Math.random() * 60; if (sc > bs) { bs = sc; best = a; }
  }
  const x = Math.sin(best) * SPAWN_R, z = Math.cos(best) * SPAWN_R, h = Math.atan2(-x, -z), y = Math.max(SPAWN_Y, ridge(x, z) + 25);
  Object.assign(car, { k: 1, x, z, h, y, p: 0, v: SPAWN_V, gy: 0, steer: 0, topT: 0, roll: 0, slowT: 0, swT: 0, hitLog: [], immT: SPAWN_IMMUNE });
  Object.assign(pl, { thr: 0.75, aimY: h, aimP: 0, stall: false, gunCd: 0, bombCd: 0, bombs: BOMBS, bombT: 0, t: 0 });
  input.mx = input.my = 0;
  planeCam(0, true);
}

// ---------- flying ----------
// World of DODO, issue #16: how high the ground and the roofs reach along the first 300 units of the way in from (x,z) towards the
// middle: a plane that comes in over Vítkov starts above the hill and the memorial, not inside them
const RQ: Solid[] = [];
function ridge(x: number, z: number): number {
  const l = Math.hypot(x, z) || 1; let top = 0;
  for (let s = 0; s <= 300; s += 15) {
    const px = x - x / l * s, pz = z - z / l * s; top = Math.max(top, terrainH(px, pz));
    for (const b of solidsIn(px - 15, pz - 15, px + 15, pz + 15, RQ)) top = Math.max(top, b.top ?? b.h);
  }
  return top;
}

const fwd = (h: number, p: number) => [Math.sin(h) * Math.cos(p), Math.sin(p), Math.cos(h) * Math.cos(p)];
// the ground (outside the arena the terrain, the river's ice), a building (with a margin), a standing tree or lamp, the land round the
// city (the woods' trees, a landmark's towers), or too close to another vehicle?
// World of DODO, issue #16: the buildings are Karlín's footprint polygons with the viaduct and the site (map.ts solidNear: 0.9 aside,
// 0.6 over the top, the old box test's margins), the land round the city is the real terrain (groundH outside the arena).
const floorH = (x: number, z: number) => Math.max(groundH(x, z), WATER_Y);   // the ground, or the river's ice over its bed
function crashed(x: number, y: number, z: number): boolean {
  if (y < floorH(x, z) + 0.8) return true;
  if (solidNear(x, y, z, 0.9, 0.6)) return true;
  if (y < 8) for (const p of propsNear(x, z)) if (p.state === 'up' && Math.hypot(x - p.x, z - p.z) < p.r + 1.2) return true;
  if (landHit(x, y, z)) return true;
  for (const o of NET.others.values()) {
    if (!o.on || o.s === 2) continue;
    if (o.k === 1 ? Math.hypot(o.x - x, o.y - y, o.z - z) < PLANE_R * 1.1 : y < 3.2 && Math.hypot(o.x - x, o.z - z) < 3) return true;
  }
  return false;
}
// the rotation of the plane (yaw h, pitch p, bank r) as a matrix, for the points on it (the guns)
const RM = new Matrix(), V0 = new Vector3(), V1 = new Vector3();
function onPlane(lx: number, ly: number, lz: number, out: Vector3) {
  Matrix.RotationYawPitchRollToRef(car.h, -car.p, car.roll, RM);
  Vector3.TransformCoordinatesFromFloatsToRef(lx, ly, lz, RM, out); out.x += car.x; out.y += car.y; out.z += car.z; return out;
}

export function updateFly(dt: number) {
  carStatus(dt);                                             // immunity, and the countdown to the respawn once destroyed (game/tank.ts)
  if (car.k !== 1 || car.topT > 0) { input.mx = input.my = 0; return; }   // destroyed, or just switched to the tank
  pl.t += dt;
  // the aim: the mouse (locked to the game), the arrows or A/D, the touch pad. Keys and the pad keep it within 0.9 rad of the nose, so
  // letting go does not leave the plane turning for long
  pl.aimY -= input.mx * SENS; pl.aimP = clamp(pl.aimP - input.my * SENS, -AIM_P, AIM_P); input.mx = input.my = 0;
  const turnK = (HELD.has('KeyA') || HELD.has('ArrowLeft') ? 1 : 0) - (HELD.has('KeyD') || HELD.has('ArrowRight') ? 1 : 0) - input.steerAxis;
  const pitchK = (HELD.has('ArrowUp') ? 1 : 0) - (HELD.has('ArrowDown') ? 1 : 0) - input.pitchAxis;
  if (turnK || pitchK) {
    pl.aimY += turnK * 1.4 * dt; pl.aimP = clamp(pl.aimP + pitchK * dt, -AIM_P, AIM_P);
    const d = Math.atan2(Math.sin(pl.aimY - car.h), Math.cos(pl.aimY - car.h)); pl.aimY = car.h + clamp(d, -0.9, 0.9);
  }
  // the edge of the airspace: the aim turns back towards the city
  const out = Math.max(Math.abs(car.x), Math.abs(car.z)) - AIR_LIM;
  if (out > 0) { pl.aimY = angLerp(pl.aimY, Math.atan2(-car.x, -car.z), Math.min(1, dt * 2)); pl.aimP = clamp(pl.aimP, -0.3, 0.3); }
  // throttle: W/S (the touch gas and brake buttons)
  const tu = HELD.has('KeyW') || (COARSE && K.up), td = HELD.has('KeyS') || (COARSE && K.down);
  pl.thr = clamp(pl.thr + ((tu ? 1 : 0) - (td ? 1 : 0)) * 0.7 * dt, 0, 1);

  // turn the nose towards the aim, along the great circle between them, as fast as the speed allows
  const [fx, fy, fz] = fwd(car.h, car.p), [ax, ay, az] = fwd(pl.aimY, pl.aimP);
  const ang = Math.acos(clamp(fx * ax + fy * ay + fz * az, -1, 1));
  const ctrl = pl.stall ? 0.12 : clamp((car.v - V_STALL) / (V_TURN - V_STALL), 0.2, 1) * Math.min(1, 40 / car.v);
  const step = Math.min(ang, TURN * ctrl * dt);
  let nx = fx, ny = fy, nz = fz;
  if (step > 1e-6) {
    const s = Math.sin(ang);
    if (s < 1e-3) { const h2 = car.h + step; nx = Math.sin(h2) * Math.cos(car.p); nz = Math.cos(h2) * Math.cos(car.p); }   // straight behind: turn level
    else { const w0 = Math.sin(ang - step) / s, w1 = Math.sin(step) / s; nx = fx * w0 + ax * w1; ny = fy * w0 + ay * w1; nz = fz * w0 + az * w1; }
  }
  let nh = Math.atan2(nx, nz), np = Math.asin(clamp(ny / Math.hypot(nx, ny, nz), -1, 1));
  if (pl.stall) np += (-1.1 - np) * Math.min(1, dt * 1.2);                                  // stalled: the nose drops
  np = clamp(np, -1.45, 1.45);
  const yawRate = Math.atan2(Math.sin(nh - car.h), Math.cos(nh - car.h)) / Math.max(dt, 1e-4);
  car.h = nh; car.p = np;
  // bank into the turn (a left turn, heading growing, lowers the left wing: negative roll); a stalled plane rocks
  const bank = clamp(-yawRate * BANK, -1.4, 1.4) + (pl.stall ? Math.sin(performance.now() / 140) * 0.35 : 0);
  car.roll += (bank - car.roll) * Math.min(1, dt * 5);
  // speed: thrust (less above AIR_TOP), drag, gravity along the flight path, and what the turn costs
  const thin = car.y > AIR_TOP ? Math.max(0, 1 - (car.y - AIR_TOP) / 60) : 1;
  car.v += (THRUST * (0.12 + 0.88 * pl.thr) * thin - DRAG * car.v * car.v - GRAV * Math.sin(car.p) - TURN_DRAG * (step / Math.max(dt, 1e-4)) * car.v) * dt;
  car.v = clamp(car.v, 5, 85);
  if (!pl.stall && car.v < V_STALL) { pl.stall = true; flash(T.stall); }
  else if (pl.stall && car.v > V_STALL + 5) pl.stall = false;
  // move
  const [mx, my, mz] = fwd(car.h, car.p);
  car.x += mx * car.v * dt; car.y += my * car.v * dt - (pl.stall ? 3 * dt : 0); car.z += mz * car.v * dt;
  car.x = clamp(car.x, -AIR_LIM - 60, AIR_LIM + 60); car.z = clamp(car.z, -AIR_LIM - 60, AIR_LIM + 60);
  if (crashed(car.x, car.y, car.z)) { car.y = Math.max(car.y, floorH(car.x, car.z) + 0.5); toppleCar(1); flash(T.crashed); return; }

  // the guns: the two take turns, their lines meet GUN_CONV ahead
  pl.gunCd -= dt; pl.bombCd -= dt;
  const busy = car.swT > 0;                                  // switching to the other vehicle: no firing
  if ((K.fire || input.lmb) && pl.gunCd <= 0 && !busy) {
    pl.gunCd = Math.max(0, pl.gunCd + GUN_RATE); pl.gun = -pl.gun;
    const o = onPlane(pl.gun * 1.5, -0.3, 1.8, V0), c = V1.set(car.x + mx * GUN_CONV, car.y + my * GUN_CONV, car.z + mz * GUN_CONV);
    const dx = c.x - o.x, dy = c.y - o.y, dz = c.z - o.z, l = Math.hypot(dx, dy, dz) || 1, sp = (Math.random() - 0.5) * 0.006;
    fireBullet(o.x, o.y, o.z, (dx / l + sp) * BUL_V + mx * car.v, (dy / l + sp) * BUL_V + my * car.v, (dz / l - sp) * BUL_V + mz * car.v);
  }
  // parcels: dropped with the plane's speed; one more on board every BOMB_RELOAD s
  if (pl.bombs < BOMBS && (pl.bombT += dt) >= BOMB_RELOAD) { pl.bombT = 0; pl.bombs++; }
  if ((HELD.has('KeyE') || input.rmb || K.alt) && pl.bombCd <= 0 && pl.bombs > 0 && !busy) {
    pl.bombs--; pl.bombCd = BOMB_CD;
    dropShot(car.x, car.y - 1.0, car.z, mx * car.v, my * car.v, mz * car.v);
  }
}

// ---------- drawing ----------
// the player's plane (and the bomb sight) where the plane is; hidden while destroyed, blinking while immune
export function planeView(dt: number, tnow: number) {
  const g = view.plane; if (!g) return;
  const on = car.k === 1 && car.topT <= 0;
  g.setEnabled(on && !(car.immT > 0 && Math.floor(tnow / 110) % 2));
  if (on) {
    g.position.set(car.x, car.y, car.z); g.rotation.set(-car.p, car.h, car.roll);
    (g.metadata.prop as TransformNode).rotation.z += dt * (25 + pl.thr * 35);
  }
  // the bomb sight: where a parcel dropped now lands (the parcels' gravity, game/shots.ts), low enough to aim with it
  if (!sight) return;
  const show = on && pl.bombs > 0 && car.y < 160;
  sight.setEnabled(show);
  if (show) {
    const [mx, my, mz] = fwd(car.h, car.p), vy = my * car.v, h = car.y - 1.0 - 0.3, t = (vy + Math.sqrt(vy * vy + 2 * SHOT_G * Math.max(0, h))) / SHOT_G;
    const x = car.x + mx * car.v * t, z = car.z + mz * car.v * t; sight.position.set(x, floorH(x, z) + 0.15, z);
  }
}
// spinning propellers, for the other players' planes (net/net.ts)
export function spinProp(g: TransformNode, a: number) { const p = g.metadata?.prop as TransformNode | undefined; if (p) p.rotation.z += a; }

// the camera: behind the plane along the aim, a little above, looking far along the aim (so the aim sits in the middle of the view).
// Destroyed: it backs off and up, watching the blast from outside its cloud. C (G.camMode) moves it farther back, for a wider view.
export function planeCam(dt: number, snap = false) {
  const [ax, ay, az] = fwd(pl.aimY, pl.aimP), dead = car.topT > 0, back = dead ? 34 : G.camMode ? 30 : 15, up = dead ? 16 : G.camMode ? 7 : 3.6;
  const cx = car.x - ax * back, cz = car.z - az * back, cy = Math.max(car.y - (dead ? 0 : ay * back) + up, floorH(cx, cz) + 1.5);
  const k = snap ? 1 : 1 - Math.exp(-dt * (dead ? 3 : 12)), c = camera.position;
  c.x += (cx - c.x) * k; c.y += (cy - c.y) * k; c.z += (cz - c.z) * k;
  if (dead) { const q = Math.min(1, dt * 3); camLook.x += (car.x - camLook.x) * q; camLook.y += (car.y - camLook.y) * q; camLook.z += (car.z - camLook.z) * q; }
  else camLook.set(car.x + ax * 80, car.y + ay * 80 + up * 0.5, car.z + az * 80);
}

// the aim circle (where the mouse points the plane) and the gun cross (where the guns hit, GUN_CONV ahead of the nose), over the canvas
const VP = new Matrix();
function toScreen(x: number, y: number, z: number, el: HTMLElement) {
  const m = VP.m, w = x * m[3] + y * m[7] + z * m[11] + m[15];
  if (w <= camera.minZ) { el.hidden = true; return; }
  const sx = (x * m[0] + y * m[4] + z * m[8] + m[12]) / w, sy = (x * m[1] + y * m[5] + z * m[9] + m[13]) / w;
  el.hidden = false; el.style.transform = `translate(${((sx + 1) / 2 * innerWidth).toFixed(1)}px,${((1 - sy) / 2 * innerHeight).toFixed(1)}px) translate(-50%,-50%)`;
}
export function drawReticle(on: boolean) {
  const aim = $('aimC'), gun = $('gunX');
  if (!on || car.k !== 1 || car.topT > 0) { aim.hidden = gun.hidden = true; return; }
  camera.getViewMatrix().multiplyToRef(camera.getProjectionMatrix(), VP);
  const [ax, ay, az] = fwd(pl.aimY, pl.aimP), [fx, fy, fz] = fwd(car.h, car.p);
  toScreen(car.x + ax * 400, car.y + ay * 400, car.z + az * 400, aim);
  toScreen(car.x + fx * GUN_CONV, car.y + fy * GUN_CONV, car.z + fz * GUN_CONV, gun);
}
