// The tanks: the model (yours and every other player's), what a hit does to your tank, (re)spawning, and driving it: collide and
// slide against the city, the cars, the tram and the other tanks.
import {
  Matrix, SpotLight, StandardMaterial, TransformNode, Vector3, Color3, type BaseTexture, type Material,
} from '@babylonjs/core';
import { scene, camera, removeCaster } from '../core/engine';
import { Bucket, addGeo, applyMatrix, boxGeo, cylGeo, planeGeo, rotateX, rotateZ, mergeGeos, geoMesh, compose, eulerXYZ, type Geo } from '../core/geo';
import { M, VC_MAT, basic } from '../core/mat';
import { canvasTex, logoTex, poolTex } from '../core/tex';
import { COL, c3 } from '../core/colors';
import { COARSE } from '../core/dom';
import { now } from '../core/util';
import { T } from '../texts';
import { G, car, K, HELD, input, view } from './state';
import { DEPOT, SPAWNS, free, solidPush, groundH, segHit } from '../world/grid';
import { propsNear, knockProp, resetProps } from '../world/props';
import {
  ALLCARS, TRAM, TRAM_L, TRAM_W, TRAM_STOPS, seedTram, seedTraffic, tramNear, TANK_M, CAR_E, carBody, putBody, impulse, toDyn,
  dynBlocked, resetParked,
} from '../world/traffic';
import { resetPeds, hitPeds } from '../world/peds';
import { NET, type NetOther } from '../net/net';
import { WORLD, netProp } from '../net/world';
import { flash, toast, flashMsg, flashUntil } from '../ui/hud';
import { fireShot, clearShots } from './shots';
import { startImpactFx, clearImpactFx } from './fx';
import { fireBullet, clearBullets, BUL_V } from './bullets';
import { spawnPlane } from './plane';
import { spawnShip } from './ship';
import { clearShells } from './shells';
import { WATER_Y } from '../../shared/naval.ts';

// ---------- DODO colours ----------
// the DODO teal of the delivery tanks; every player tank gets a clone in its own colour (three's Phong: a little shine)
export const vanMat = new StandardMaterial('tankPaint', scene);
vanMat.diffuseColor = c3(0x00a99a); vanMat.emissiveColor = c3(0x00332e); vanMat.specularColor = c3(0x14302d); vanMat.specularPower = 30;

// ---------- DODO TANK: replaces the van as the player's vehicle ----------
// Same footprint as the original delivery van (about 4.5 long, 2 wide), so collisions and camera work unchanged.
// metadata.wheels is kept for the callers that spin wheels (empty, see below); metadata.body gets the steering roll.
// hullMat/labelTex: paint and turret label (default: DODO teal + DODO logo). The turret is its own node so it can aim independently of the hull.
const ONE = new Vector3(1, 1, 1);
const mtx = (x: number, y: number, z: number, rx = 0, ry = 0) => Matrix.FromArray(compose(new Vector3(x, y, z), eulerXYZ(rx, ry, 0), ONE));
const at = (geo: Geo, x: number, y: number, z: number, rx?: number, ry?: number) => applyMatrix(geo, mtx(x, y, z, rx, ry));
export function makeTank(withLights: boolean, hullMat?: StandardMaterial, labelTex?: BaseTexture): TransformNode {
  // World of DODO: the parts are merged by material, 6 meshes per tank instead of 36 (hull paint, the vertex-coloured rest, lamps;
  // in the turret: paint, the rest, labels). The road wheels no longer spin (inside the tracks it hardly showed); wheels stays empty.
  const hm = hullMat || vanMat, g = new TransformNode('tank', scene), body = new TransformNode('tankBody', scene); body.parent = g;
  const mesh = (name: string, geo: Geo, mat: Material, cast: boolean, parent: TransformNode) => { const m = geoMesh(name, geo, mat, cast, true); m.parent = parent; return m; };
  const BLACK = 0x1a1d1c, rest = Bucket(), lamps: Geo[] = [];
  // hull + sloped front plate (paint)
  mesh('tankHull', mergeGeos([at(boxGeo(1.5, 0.5, 4.1), 0, 0.95, 0), at(boxGeo(1.5, 0.1, 1.0), 0, 1.0, 2.0, 0.5)]), hm, true, body);
  // engine deck, tracks, fenders, road wheels (tyre + hub), lamps
  addGeo(rest, boxGeo(1.3, 0.18, 0.9), mtx(0, 1.25, -1.7), COL.charcoal);
  const wg = rotateZ(cylGeo(0.28, 0.28, 0.44, 14), Math.PI / 2), hg = rotateZ(cylGeo(0.14, 0.14, 0.48, 10), Math.PI / 2);
  for (const sx of [-1, 1]) {
    addGeo(rest, boxGeo(0.34, 0.62, 4.5), mtx(sx * 0.9, 0.42, 0), BLACK);       // track belt
    addGeo(rest, boxGeo(0.5, 0.08, 4.6), mtx(sx * 0.9, 0.82, 0), COL.charcoal);  // fender
    for (const z of [-1.8, -0.9, 0, 0.9, 1.8]) { addGeo(rest, wg, mtx(sx * 0.9, 0.36, z), COL.charcoal); addGeo(rest, hg, mtx(sx * 0.9, 0.36, z), COL.c20); }
    lamps.push(at(boxGeo(0.2, 0.12, 0.06), sx * 0.5, 1.05, 2.4));
  }
  mesh('tankParts', rest, VC_MAT, true, body); mesh('tankLamps', mergeGeos(lamps), M.lampHead, false, body);
  // turret: a node pivoting at the turret ring (z = -0.2), so it can aim independently of the hull
  const turret = new TransformNode('tankTurret', scene); turret.position.set(0, 0, -0.2); turret.parent = body;
  mesh('tankTurretPaint', mergeGeos([at(cylGeo(0.72, 0.85, 0.5, 22), 0, 1.5, 0), at(boxGeo(0.9, 0.3, 0.5), 0, 1.5, 0.75)]), hm, true, turret);   // turret + gun mantlet
  const trest = Bucket();
  addGeo(trest, rotateX(cylGeo(0.11, 0.11, 2.5, 10), Math.PI / 2), mtx(0, 1.5, 1.95), COL.charcoal);   // barrel
  addGeo(trest, boxGeo(0.26, 0.26, 0.36), mtx(0, 1.5, 3.2), BLACK);                                   // muzzle brake
  addGeo(trest, cylGeo(0.22, 0.22, 0.14, 12), mtx(-0.25, 1.8, -0.1), COL.charcoal);                   // hatch
  mesh('tankTurretParts', trest, VC_MAT, true, turret);
  // label on the turret sides (DODO logo)
  mesh('tankLabel', mergeGeos([-1, 1].map(sx => at(planeGeo(1.1, 0.42), sx * 0.8, 1.5, 0, 0, sx * Math.PI / 2))),
    basic(0xffffff, { map: labelTex || logoTex, transparent: true }), false, turret);
  if (withLights) headlight(g);
  g.metadata = { wheels: [], body, turret };
  return g;
}
// The headlight: three's SpotLight(white, 1.3, reach 48, cone 0.55 rad, penumbra 0.6, decay 1) at (0, 1.1, 2.3) aimed at (0, 0, 14),
// and a soft pool of light on the street in front.
// - Babylon's spot cone is the full angle, three's the half; its fall-off with distance (1 - d/range) is three's decay 1. Babylon's
//   standard material has no penumbra, so a projected texture draws three's soft edge (smoothstep from 0.22 to 0.55 rad).
// - three.js r128 lit Lambert surfaces per vertex: on the big merged city surfaces (streets, facades, roofs; baked, so their world
//   matrix is frozen) the spot hardly showed, it lit the cars, the people, the trees and the other tanks, and the pool mesh drew the
//   light on the street. Babylon lights per pixel, so the spot leaves the baked surfaces out (they exist when main.ts builds the tank).
// - A projected texture needs the light's own position and direction (a parented light does not move it), so they follow the tank
//   before every frame. three hid a light with its hidden group: the light goes out while the tank blinks after a respawn.
function headlight(g: TransformNode) {
  const P = new Vector3(0, 1.1, 2.3), D = new Vector3(0, -1.1, 11.7), I = 1.3, CONE = 0.55, PEN = 0.6;
  const sp = new SpotLight('headlight', P.clone(), D.clone(), CONE * 2, 0, scene);
  sp.intensity = I; sp.range = 48; sp.diffuse = Color3.White(); sp.specular = Color3.White();
  const c0 = Math.cos(CONE), c1 = Math.cos(CONE * (1 - PEN)), tn = Math.tan(CONE);
  sp.projectionTexture = canvasTex(64, 64, (ctx, w, h) => {
    const img = ctx.createImageData(w, h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      // the texture spans the cone: radius 1 at its edge, where tan(angle) = r · tan(CONE)
      const r = Math.hypot((i + 0.5) / w - 0.5, (j + 0.5) / h - 0.5) * 2, cs = 1 / Math.sqrt(1 + r * tn * r * tn);
      const t = Math.min(1, Math.max(0, (cs - c0) / (c1 - c0))), v = Math.round(t * t * (3 - 2 * t) * 255), k = (j * w + i) * 4;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = v; img.data[k + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  });
  sp.excludedMeshes = scene.meshes.filter(m => m.isWorldMatrixFrozen && !m.hasThinInstances);
  const obs = scene.onBeforeRenderObservable.add(() => {
    const m = g.computeWorldMatrix(true);
    sp.position = Vector3.TransformCoordinates(P, m); sp.direction = Vector3.TransformNormal(D, m);   // the setters update the projection
    sp.intensity = g.isEnabled() ? I : 0;
  });
  g.onDisposeObservable.add(() => { scene.onBeforeRenderObservable.remove(obs); sp.projectionTexture?.dispose(); sp.dispose(); });
  // the pool: three cloned M.pool, made it white and a little stronger
  const pool = geoMesh('tankPool', rotateX(planeGeo(9, 14), -Math.PI / 2),
    basic(0xffffff, { map: poolTex, transparent: true, opacity: 0.28, depthWrite: false, additive: true }), false, false);
  pool.position.set(0, 0.08, 9); pool.parent = g;
}
// another player's tank leaves (net/net.ts): its meshes go, with their shadows (the shadow casters are remembered for the next shadow
// map, core/engine.ts) and its own label material. The paint is the caller's (paintMat) and the logo texture is shared.
export function disposeTank(g: TransformNode) {
  for (const m of g.getChildMeshes()) { removeCaster(m); if (m.name === 'tankLabel') m.material?.dispose(); }
  g.dispose();
}

// World of DODO: every player's tank is painted in the colour the server gives them (the delivery tanks kept vanMat)
export function paintMat(mat: StandardMaterial, hex: number): StandardMaterial { mat.diffuseColor = c3(hex); mat.emissiveColor = c3(hex).scale(0.18); return mat; }
export const vanOwnMat = vanMat.clone('tankOwnPaint');
// the player's tank (still called van, as in the original) into view.van; main.ts calls this after the city and the traffic
// World of DODO: the two delivery tanks of the depot are gone (in a shared city they would be one more thing to sync, and players took them for other players)
export function buildTank() { view.van = makeTank(true, vanOwnMat); }

// ---- what a hit does to your tank: slowed down; three hits within 8 s destroy it (in the original REDLINE toppled it,
// it righted itself after a few seconds and was immune for 4 s; in World of DODO it blows up, lies on its side and
// comes back at a free spot, see respawn)
// World of DODO, issue #14: a hit has a weight (HIT_W, the same numbers as in server/server.js), and the vehicle is destroyed once the
// hits within 8 s weigh 3: three parcels or twelve bullets destroy a tank, one parcel or six bullets a plane. A bullet does not slow a tank.
// World of DODO, issue #20: the ships' shells and torpedoes (game/shells.ts), and the ship as a victim: it takes longer to destroy (its
// hits add up over HIT_WIN.ship, 20 s): nine shells, two torpedoes, four parcels, 38 bullets or six rams. A shell weighs a parcel in a
// tank (and slows it), three in a plane (rare: the planes are too fast for the shells); a torpedo hits ships only. A destroyed ship
// sinks for SINK_T before it comes back (game/ship.ts).
export const TOPPLE_T = 3.2, SINK_T = 4.6;
export const HIT_W = {
  tank: { shot: 1, ram: 1, bullet: 0.25, shell: 1, torp: 0 },
  plane: { shot: 3, ram: 3, bullet: 0.5, shell: 3, torp: 0 },
  ship: { shot: 0.75, ram: 0.5, bullet: 0.08, shell: 0.35, torp: 1.5 },
};
export const HIT_WIN = { tank: 8000, plane: 8000, ship: 20000 };
const VEH = ['tank', 'plane', 'ship'] as const;
export function carStatus(dt: number) {
  car.slowT = Math.max(0, car.slowT - dt); car.immT = Math.max(0, car.immT - dt);
  if (car.swT > 0 && car.topT <= 0 && (car.swT -= dt) <= 0) { car.swT = 0; respawn(); return; }    // switched vehicles (switchVehicle)
  if (car.topT > 0) {
    car.topT -= dt; const tt = TOPPLE_T - car.topT;
    if (car.k === 0) car.roll = Math.min(1, tt / 0.5) * car.rollDir * 1.45;
    if (car.topT <= 0) respawn();
  }
}
// destroyed: a tank blows up and lies on its side, a plane blows up where it is (its pieces fall, game/fx.ts)
export function toppleCar(sign: number) {
  if (car.immT > 0 || car.topT > 0) return;
  car.topT = car.k === 2 ? SINK_T : TOPPLE_T; car.rollDir = sign; car.v *= 0.4; car.hitLog.length = 0; car.swT = 0; flash(car.k === 2 ? T.sunk : T.toppled);
  if (car.k === 1) { car.v = 0; startImpactFx(car.x, car.z, 0.5, 0.6, car.y); }
  else if (car.k === 2) startImpactFx(car.x, car.z, 0.5, 0.6, WATER_Y + 1.5);       // a ship: the blast on the water, then it sinks
  else startImpactFx(car.x, car.z, 0.45, 0.6);
}
// returns whether the hit took effect (not while toppled or immune right after): only such a hit scores for another player.
// kind 'ram' was REDLINE's ramming (it slowed the tank more; issue #20: two ships colliding), 'bullet' a plane's or an anti-aircraft
// gun's (issue #14), 'shell' and 'torp' a ship's (issue #20); msg: what the toast says (the original fell back to REDLINE's texts)
export function hitPlayer(kind: 'shot' | 'ram' | 'bullet' | 'shell' | 'torp', sign: number, msg: string): boolean {
  const veh = VEH[car.k], w = HIT_W[veh][kind];
  if (car.immT > 0 || car.topT > 0 || G.state !== 'drive' || !w) return false;
  const t = now(); car.hitLog = car.hitLog.filter(x => t - x[0] < HIT_WIN[veh]); car.hitLog.push([t, w]);
  if (car.k === 0 && kind !== 'bullet') { car.slowT = Math.max(car.slowT, 2.4); car.v *= kind === 'ram' ? 0.6 : 0.7; }
  if (car.hitLog.reduce((s, x) => s + x[1], 0) >= 2.999) toppleCar(sign); else flash(msg);
  return true;
}
// World of DODO, issue #14: the next (re)spawn in the tank (k 0) or the plane (k 1); without k the next one in turn (issue #20: tank,
// plane, ship (k 2), tank). While alive the switch takes SWITCH_T s, in which you cannot fire (no escaping a lost fight for free);
// while destroyed it only picks the next vehicle.
export const SWITCH_T = 2;
export const vehName = (k: number) => [T.vehTank, T.vehPlane, T.vehShip][k];
export function switchVehicle(k?: 0 | 1 | 2) {
  car.next = k ?? (((car.next + 1) % 3) as 0 | 1 | 2);
  if (G.state !== 'drive' || car.topT > 0) return;
  if (car.next === car.k) { car.swT = 0; return; }
  car.swT = SWITCH_T; flash(T.switching(vehName(car.next)));
}

// ---------- game state ----------
// where the camera looks; main.ts eases it after the tank every frame, reset and respawn put it on the tank
export const camLook = new Vector3();
function camBehind() { camera.position.set(car.x - Math.sin(car.h) * 11, 6, car.z - Math.cos(car.h) * 11); camLook.set(car.x, 1.2, car.z); }
export function reset() {
  Object.assign(car, { k: 0, swT: 0, x: DEPOT.park.x, z: DEPOT.park.z, h: DEPOT.park.h, v: 0, steer: 0, gy: 0, y: 0, p: 0, slowT: 0, topT: 0, roll: 0, rollDir: 1, immT: 0, hitLog: [] });
  seedTram(TRAM_STOPS[(Math.random() * TRAM_STOPS.length) | 0] - 30 - Math.random() * 120); seedTraffic((Math.random() * 1e9) | 0);
  G.realSec = 0;
  clearShots(); clearBullets(); clearShells(); clearImpactFx(); resetParked(); resetProps(); resetPeds(); toast(COARSE ? T.hintStart : T.hintStartDesk);
  camBehind();
}
// World of DODO: start on a street, as far from the other players as the city allows, clear of traffic and the tram.
// World of DODO, issue #16: the places are the map's spawn points (client/shared/map.ts SPAWNS: about 40 spots on the real streets'
// centre lines, away from junctions and walls, spread over Karlín, facing along the street towards the middle; tram streets only
// where the others do not give enough). The browser still picks its own spot, as before; the depot's yard when none is free.
export function spawnPoint(): { x: number; z: number; h: number } {
  let best: { x: number; z: number; h: number } | null = null, bs = -1;
  for (const s of SPAWNS) {
    // not into another tank, a tree or a lamp, not next to the tram or a moving car, not onto a parked one
    if (blockedAt(s.x, s.z, s.h) || tramNear(s.x, s.z, 14) || ALLCARS.some(c => Math.hypot(c.x - s.x, c.z - s.z) < (c.parked ? 3.5 : 10))) continue;
    let d = 800; for (const o of NET.others.values()) if (o.on) d = Math.min(d, Math.hypot(o.x - s.x, o.z - s.z));
    const sc = d + Math.random() * 60; if (sc > bs) { bs = sc; best = s; }
  }
  const p = best || DEPOT.park; return { x: p.x, z: p.z, h: p.h };
}
// World of DODO: at the start and after being destroyed, the tank appears at a spawn point, immune for SPAWN_IMMUNE s (it blinks meanwhile);
// a plane (issue #14, car.next) comes in from the edge of the airspace (game/plane.ts), a ship (issue #20) at one of the river's spawn
// points (game/ship.ts)
export const SPAWN_IMMUNE = 3;
export function respawn(first = false) {
  if (car.next === 1) spawnPlane();
  else if (car.next === 2) spawnShip();
  else {
    const p = spawnPoint();
    Object.assign(car, { k: 0, x: p.x, z: p.z, h: p.h, v: 0, steer: 0, gy: groundH(p.x, p.z), y: 0, p: 0, topT: 0, roll: 0, slowT: 0, swT: 0, hitLog: [], immT: SPAWN_IMMUNE });
    camBehind();
  }
  if (!first) flash(T.respawned);
}
export function blockedAt(x: number, z: number, h: number): boolean {
  const fx = Math.sin(h) * 1.55, fz = Math.cos(h) * 1.55; if (!(free(x + fx, z + fz, 1.0) && free(x - fx, z - fz, 1.0))) return true;
  // other players' tanks: you cannot drive into one, but you can always drive out of an overlap (planes fly over, ships sail elsewhere)
  for (const o of NET.others.values()) {
    if (!o.on || o.k !== 0 || Math.abs(o.x - x) > 8 || Math.abs(o.z - z) > 8) continue;
    const g = tankGap(x, z, h, o); if (g < 2.1 && g < tankGap(car.x, car.z, car.h, o)) return true;
  }
  return false;
}
// the closest distance between the front and rear circle centres of a tank at (x,z,h) and another player's tank o
export function tankGap(x: number, z: number, h: number, o: { x: number; z: number; hx: number; hz: number }): number {
  const fx = Math.sin(h) * 1.55, fz = Math.cos(h) * 1.55, gx = o.hx * 1.55, gz = o.hz * 1.55; let d = Infinity;
  for (const a of [-1, 1]) for (const b of [-1, 1]) d = Math.min(d, Math.hypot(x + fx * a - o.x - gx * b, z + fz * a - o.z - gz * b));
  return d;
}
// World of DODO: the tank moves by collide and slide. The original tried the new spot and refused a move that overlapped anything,
// always with the new heading: steering against a wall stopped even a straight move, and on the construction site or next to
// another tank a tank got stuck. Now it moves in short steps, each of its three circles is pushed out of whatever it overlaps
// (buildings and site obstacles, standing trees and lamps, the other tanks), and it loses only the speed that went into the
// obstacle, so it slides along walls (pushLoss). Issue #16: the walls are Karlín's footprint polygons and the arena's edge
// (map.ts solidPush, the same contract as the old boxes'): a tank slides along a slanted or bent facade as along a straight one.
export const TANK_C = [-1.55, 0, 1.55], TANK_CR = 1.0;               // circle centres along the tank, their radius (as free() and blockedAt use it)
export function tankPen(x: number, z: number, h: number): { nx: number; nz: number; pen: number } | null {
  const fx = Math.sin(h), fz = Math.cos(h); let best: { nx: number; nz: number; pen: number } | null = null;
  const take = (nx: number, nz: number, pen: number) => { if (pen > 1e-4 && (!best || pen > best.pen)) best = { nx, nz, pen }; };
  for (const j of TANK_C) {
    const px = x + fx * j, pz = z + fz * j, w = solidPush(px, pz, TANK_CR); if (w) take(w.nx, w.nz, w.pen);
    for (const p of propsNear(px, pz)) { if (p.state !== 'up') continue; const dx = px - p.x, dz = pz - p.z, d = Math.hypot(dx, dz); if (d > 1e-6) take(dx / d, dz / d, p.r + TANK_CR - d); }
    for (const o of NET.others.values()) {
      if (!o.on || o.k !== 0 || Math.abs(o.x - px) > 5 || Math.abs(o.z - pz) > 5) continue;    // another tank: its two circles
      for (const b of [-1.55, 1.55]) { const dx = px - o.x - o.hx * b, dz = pz - o.z - o.hz * b, d = Math.hypot(dx, dz); if (d < 2.1) take(d > 1e-6 ? dx / d : -fx, d > 1e-6 ? dz / d : -fz, 2.1 - d); }
    }
  }
  return best;
}
// turn to heading nh and drive dist along it (steps of at most 0.4, so a thin wall cannot be skipped), pushed out of obstacles on the way
export function moveTank(nh: number, dist: number, dt: number) {
  const n = Math.max(1, Math.ceil(Math.abs(dist) / 0.4)), dh = (nh - car.h) / n, dd = dist / n; let px = 0, pz = 0;
  for (let i = 0; i < n; i++) {
    car.h += dh; car.x += Math.sin(car.h) * dd; car.z += Math.cos(car.h) * dd;
    for (let it = 0; it < 3; it++) { const p = tankPen(car.x, car.z, car.h); if (!p) break; car.x += p.nx * p.pen; car.z += p.nz * p.pen; px += p.nx * p.pen; pz += p.nz * p.pen; }
  }
  pushLoss(px, pz, dt);
}
// pushed by (px,pz) out of something this frame: the tank keeps the speed that runs along the obstacle and loses what went into it;
// a fast crash head-on bounces it back a little, as in the original
export function pushLoss(px: number, pz: number, dt: number) {
  const l = Math.hypot(px, pz); if (l < 1e-4 || Math.abs(car.v) < 0.01) return;
  const d = (Math.sin(car.h) * px + Math.cos(car.h) * pz) / l * Math.sign(car.v);              // -1: straight into it, 0: along it
  if (d >= 0) return;
  if (d < -0.85 && Math.abs(car.v) > 8) { car.v *= -0.25; return; }
  car.v *= Math.exp(-6 * d * d * dt);
}
// tank ↔ car: rigid-body collision. The tank is heavy (TANK_M vs CAR_M), so it shoves cars aside and loses only a little speed.
// Normally the car gives way; if it is jammed against a kerb or a parked car, the tank is pushed back instead.
// World of DODO: a car of the shared city that you shove becomes yours for as long as it moves (toDyn); one someone else is shoving
// does not give way, you slide off it.
export function resolveTraffic(dt: number) {
  const fx = Math.sin(car.h), fz = Math.cos(car.h); let px = 0, pz = 0;
  for (const c of ALLCARS) {
    if (Math.abs(c.x - car.x) > 9 || Math.abs(c.z - car.z) > 9) continue;
    const cl = c.cl || 1.2, thr = 1.05 + (c.cr || 1.05);
    for (let it = 0; it < 4; it++) {
      const chx = c.dyn ? Math.sin(c.ang) : c.hx, chz = c.dyn ? Math.cos(c.ang) : c.hz;
      let best: { pen: number; nx: number; nz: number; px: number; pz: number } | null = null;
      for (const j of [-1.55, 1.55]) for (const k of [-cl, cl]) {
        const tx = car.x + fx * j, tz = car.z + fz * j, qx = c.x + chx * k, qz = c.z + chz * k, dx = qx - tx, dz = qz - tz, d = Math.hypot(dx, dz);
        if (d < thr && (!best || thr - d > best.pen)) best = { pen: thr - d, nx: d > 0.01 ? dx / d : chx, nz: d > 0.01 ? dz / d : chz, px: (tx + qx) / 2, pz: (tz + qz) / 2 };
      }
      if (!best) break;
      if (WORLD.on && c.net) {                                         // a car another player is pushing
        const bx = -best.nx * best.pen, bz = -best.nz * best.pen; if (!blockedAt(car.x + bx, car.z + bz, car.h)) { car.x += bx; car.z += bz; px += bx; pz += bz; }
        continue;
      }
      toDyn(c);
      const A = { cx: car.x, cz: car.z, vx: fx * car.v, vz: fz * car.v, w: 0, im: 1 / TANK_M, iI: 0 }, B = carBody(c);
      impulse(A, B, best.px, best.pz, best.nx, best.nz, CAR_E);
      car.v = Math.max(-7, Math.min(24, A.vx * fx + A.vz * fz)); putBody(c, B);
      const ox = c.x, oz = c.z; c.x += best.nx * best.pen * 0.9; c.z += best.nz * best.pen * 0.9;
      let share = 0.1;
      if (dynBlocked(c)) { c.x = ox; c.z = oz; share = 1; }           // 1 = the vehicle cannot move, the tank backs off the whole overlap
      const bx = -best.nx * best.pen * share, bz = -best.nz * best.pen * share;
      if (!blockedAt(car.x + bx, car.z + bz, car.h)) { car.x += bx; car.z += bz; }
    }
  }
  pushLoss(px, pz, dt);
}

export function resolveTram() {
  const fx = Math.sin(car.h), fz = Math.cos(car.h); let hit = false;
  for (const v of TRAM.vag) {
    if (Math.abs(v.x - car.x) > 12 || Math.abs(v.z - car.z) > 12) continue; const A = TRAM_L / 2 + 0.95, B = TRAM_W / 2 + 0.95;
    for (let it = 0; it < 12; it++) {
      let best: { d: number; x: number; z: number } | null = null;
      const cwx = car.x - v.x, cwz = car.z - v.z, sb = Math.sign(cwx * v.hz - cwz * v.hx) || 1, sa = Math.sign(cwx * v.hx + cwz * v.hz) || 1; // push direction from the van's centre side
      for (const j of [-1.55, 0, 1.55]) {
        const wx = car.x + fx * j - v.x, wz = car.z + fz * j - v.z, a = wx * v.hx + wz * v.hz, b = wx * v.hz - wz * v.hx, pa = A - Math.abs(a), pb = B - Math.abs(b);
        if (pa <= 0 || pb <= 0) continue; const m = pb < pa ? { d: pb, x: v.hz * sb, z: -v.hx * sb } : { d: pa, x: v.hx * sa, z: v.hz * sa }; if (!best || m.d > best.d) best = m;
      }
      if (!best) break; hit = true; const st = Math.min(0.5, best.d + 0.05), sg = car.v < 0 ? -1 : 1; let moved = false;
      // out sideways if there's room, otherwise back the way the van came
      for (const [dx, dz] of [[best.x, best.z], [-fx * sg, -fz * sg], [fx * sg, fz * sg]]) {
        if (dx * best.x + dz * best.z < 0.2) continue; const tx = car.x + dx * st, tz = car.z + dz * st;
        if (!blockedAt(tx, tz, car.h)) { car.x = tx; car.z = tz; moved = true; break; }
      }
      if (!moved) { TRAM.hold = Math.max(TRAM.hold, 1.5); break; }
    }
  }
  if (hit) { car.v *= -0.3; TRAM.hold = Math.max(TRAM.hold, 0.6); }
}
// the player's tank against the props, tested where it is about to move to (same distance at which free() would block it)
export function breakProps(x: number, z: number, h: number) {
  const v = car.v; if (Math.abs(v) < 1) return; const fx = Math.sin(h), fz = Math.cos(h), sg = v > 0 ? 1 : -1;
  for (const j of [-1.55, 1.55]) {
    const px = x + fx * j, pz = z + fz * j;
    for (const p of propsNear(px, pz)) {
      if (p.state !== 'up' || Math.hypot(px - p.x, pz - p.z) >= p.r + 1.0) continue;
      if (((p.x - x) * fx + (p.z - z) * fz) * sg < -0.5) continue;                       // driving away from it
      if (Math.abs(v) >= p.breakV) { knockProp(p, fx * sg, fz * sg); netProp(p); car.v *= p.slow; }   // World of DODO: the others see it fall too
    }
  }
}
// World of DODO, issue #14: the anti-aircraft gun on the turret (E, the right mouse button, the touch button). It aims itself at the
// nearest plane in reach and in sight as drawn here (the shooter decides a bullet's hits, game/bullets.ts), leading it by the bullet's
// flight, with some spread; with no plane about it fires up and ahead.
const AA_RATE = 1 / 7, AA_R = 130, AA_ERR = 0.035, AA_Y = 2.3;
let aaCd = 0;
function fireAA() {
  if (aaCd > 0) return; aaCd = AA_RATE;
  const ox = car.x, oy = car.gy + AA_Y, oz = car.z; let best: NetOther | null = null, bd = AA_R;
  for (const o of NET.others.values()) {
    if (!o.on || o.k !== 1 || o.s === 2) continue;
    const d = Math.hypot(o.x - ox, o.y - oy, o.z - oz); if (d < bd && segHit(ox, oy, oz, o.x, o.y, o.z) >= 1) { bd = d; best = o; }
  }
  let dx = Math.sin(car.h) * 0.8, dy = 0.6, dz = Math.cos(car.h) * 0.8;
  if (best) {
    const vx = Math.sin(best.h) * Math.cos(best.p) * best.v, vy = Math.sin(best.p) * best.v, vz = Math.cos(best.h) * Math.cos(best.p) * best.v;
    let t = bd / BUL_V; for (let i = 0; i < 2; i++) { dx = best.x + vx * t - ox; dy = best.y + vy * t - oy; dz = best.z + vz * t - oz; t = Math.hypot(dx, dy, dz) / BUL_V; }
  }
  const l = Math.hypot(dx, dy, dz) || 1, e = () => (Math.random() - 0.5) * AA_ERR;
  dx = dx / l + e(); dy = dy / l + e(); dz = dz / l + e();
  fireBullet(ox + dx, oy + dy, oz + dz, dx * BUL_V, dy * BUL_V, dz * BUL_V);
}
export function updateDrive(dt: number) {
  carStatus(dt); if (car.k !== 0) return;                          // switched to a plane or a ship (carStatus respawned)
  const dead = car.topT > 0, busy = car.swT > 0;                   // destroyed: no driving, no firing; switching vehicles: no firing
  aaCd = Math.max(0, aaCd - dt);
  if (K.fire && !dead && !busy) fireShot();
  if ((HELD.has('KeyE') || input.rmb || K.alt) && !dead && !busy) fireAA();
  const thr = dead ? 0 : (K.up ? 1 : 0) - (K.down ? 1 : 0), st = dead ? 0 : Math.max(-1, Math.min(1, (K.left ? 1 : 0) - (K.right ? 1 : 0) - input.steerAxis));
  const sl = car.slowT > 0, MAX = 24 * (sl ? 0.55 : 1), REV = 7, ACC = 14 * (sl ? 0.7 : 1), BRK = 32;                  // hit: slowed for a few seconds
  if (dead) car.v *= Math.exp(-4 * dt);
  if (thr > 0) { car.v += car.v < 0 ? BRK * dt : ACC * dt * (1 - car.v / MAX * 0.5); }
  else if (thr < 0) { car.v -= car.v > 0 ? BRK * dt : ACC * 0.6 * dt; }
  else { car.v *= Math.max(0, 1 - 1.1 * dt); if (Math.abs(car.v) < 0.15) car.v = 0; }
  if (K.brake) { const s = Math.sign(car.v); car.v -= s * BRK * 1.3 * dt; if (Math.sign(car.v) !== s) car.v = 0; }
  if (car.v > MAX) car.v = Math.max(MAX, car.v - (car.v - MAX) * Math.min(1, dt * 5) - 6 * dt); car.v = Math.max(-REV, car.v);
  car.steer += (st - car.steer) * Math.min(1, dt * 7);
  const grip = Math.max(-1, Math.min(1, car.v / 7)) * (1 - Math.min(0.45, Math.abs(car.v) / MAX * 0.45));
  const nh = car.h + car.steer * 2.0 * dt * grip;
  breakProps(car.x + Math.sin(nh) * car.v * dt, car.z + Math.cos(nh) * car.v * dt, nh);   // fast enough: trees and lamps go down instead of blocking
  moveTank(nh, car.v * dt, dt);                                    // World of DODO: collide and slide (see tankPen)
  resolveTraffic(dt); resolveTram(); hitPeds();

  // World of DODO: no stops and no shift end; the toast shows the start hint, then hits and network news
  let msg = '';
  if (G.realSec < 7) msg = COARSE ? T.hintStart : T.hintStartDesk;
  if (now() < flashUntil) msg = flashMsg;
  toast(msg);
}
