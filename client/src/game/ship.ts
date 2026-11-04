// ---------- World of DODO, issue #20: the ships ----------
// A small DODO destroyer on the Vltava, the third vehicle after the tank and the plane (#14), with mechanics inspired by the arcade naval
// games (World of Warships, War Thunder's naval battles), not a copy of either:
// - the engine telegraph (W/S, one step a press) runs astern, stop, 1/3, 2/3 and full; the speed follows slowly (about 8 s from stop to
//   full); the rudder (A/D) takes RUD_T to go hard over; the ship turns by its speed (hard over it runs a circle of 2 × TURN_R, so the
//   faster it goes the quicker it comes round), with some inertia, heels into the turn and pitches a little on the swell;
// - the mouse orbits the camera round the ship (locked to the game as for the plane; on a touch screen a drag over the game); the aim
//   is where the middle of the view meets a ship, a tank, a building, the ground or the water; the two twin turrets (fore and aft)
//   traverse towards it at TRAV within their arcs (the bridge blocks the fore turret's view astern, the after deckhouse the aft
//   turret's view ahead); the left button fires every turret that is on target and loaded, two shells each (game/shells.ts), with a
//   dispersion that grows with the range; the right button or Shift looks through the binoculars;
// - Q launches three torpedoes from the side facing the aim; E fires the anti-aircraft guns (as the tank's, a little stronger);
// - it collides with the banks and the bridge piers (client/shared/naval.ts waterPush) and the other ships, three circles along its
//   axis as the tank has; a destroyed ship lists and sinks, then comes back at one of the river's spawn points (SHIP_SPAWNS).
// The ship is the player's vehicle (car, game/state.ts) as the tank and the plane are: x, z, h, v; roll is its heel, p its pitch, y its
// heave and, once destroyed, how deep it has sunk (0 afloat; the water's surface is WATER_Y).
import { TransformNode, Vector3, Matrix, type StandardMaterial } from '@babylonjs/core';
import { scene, camera, removeCaster } from '../core/engine';
import { Bucket, addGeo, boxGeo, cylGeo, planeGeo, quad, rotateX, rotateY, scaleGeo, translate, geoMesh, type Geo, type P3 } from '../core/geo';
import { VC_MAT, VC_GLOW, basic } from '../core/mat';
import { logoTex } from '../core/tex';
import { COL } from '../core/colors';
import { $, COARSE } from '../core/dom';
import { clamp } from '../core/util';
import { T } from '../texts';
import { G, car, K, HELD, input, view } from './state';
import { groundH, segHit } from '../world/grid';
import { WATER_Y, waterPush, surfaceY, SHIP_SPAWNS } from '../../shared/naval.ts';
import { wake, sinkFx } from '../world/water';
import { NET, type NetOther } from '../net/net';
import { flash } from '../ui/hud';
import { carStatus, camLook, vanOwnMat, hitPlayer, SPAWN_IMMUNE, SINK_T } from './tank';
import { fireBullet, BUL_V } from './bullets';
import { fireShell, fireTorp, shipBox, glow, puff, SHELL_V, SHELL_G } from './shells';
import { startImpactFx } from './fx';

// ---------- the numbers ----------
// speed: the top speed (13 u/s, 38 knots), how fast the speed follows the telegraph (up, and down or braking), the telegraph's steps
const V_MAX = 13, ACC = 1.7, DEC = 2.3, TEL = [-0.25, 0, 1 / 3, 2 / 3, 1], TEL_STOP = 1;
// steering: seconds from the centre to hard over, the tightest turn's radius (a circle of 45 hard over), how slowly the turn comes on
// and goes off (s), how far it heels per rad/s of turn (into the turn), the speed a hard turn bleeds
const RUD_T = 1.5, TURN_R = 22.5, YAW_T = 0.9, HEEL = 0.17, TURN_SLOW = 0.15;
// the collision circles along the axis and their radius (as the tank's TANK_C / TANK_CR); a collision with another ship faster than
// RAM_V hurts both (each side its own: a ram hits the rammer too)
export const SHIP_C = [-7.5, 0, 7.5], SHIP_CR = 2.6;
const RAM_V = 5;
// the turrets: where along the axis, the height of their ring over the waterline, their rest (the aft one looks astern), their arc
// either side of it (the superstructure blocks the rest), traverse speed, how close counts as on target, reload; the guns' pivot
// height over the ring and their length; the dispersion as a share of the range (each shell its own)
const TURRETS = [{ z: 5.8, y: 1.24, rest: 0 }, { z: -8.3, y: 1.02, rest: Math.PI }];
const ARC = 150 * Math.PI / 180, TRAV = 40 * Math.PI / 180, ALIGN = 0.03, RELOAD = 6, GUN_Y = 0.62, GUN_L = 2.6, DISP = 0.025;
// torpedoes: reload, the spread either side of the middle one, the arc each side's tubes cover (from the bow), where the tubes are
const TORP_RELOAD = 25, TORP_SPREAD = 8 * Math.PI / 180, TUBE_ARC0 = 30 * Math.PI / 180, TUBE_ARC1 = 150 * Math.PI / 180, TUBE_Z = -4.4, TUBE_X = 1.35;
// anti-aircraft (the tank's: 1/7 s, 130, 0.035): seconds between bullets (the two mounts take turns), reach, aim error, the mounts
const AA_RATE = 1 / 10, AA_R = 150, AA_ERR = 0.03, AA_X = 1.55, AA_Y = 2.6, AA_Z = -0.6;
// the camera: the pivot's height over the water, its distance (C: farther), the mouse's sensitivity, the aim's pitch limits, the
// binoculars' magnification, the farthest point the aim looks for
const CAM_UP = 7, CAM_D = 28, CAM_D_FAR = 44, SENS = 0.0022, AIM_P0 = -0.9, AIM_P1 = 0.15, ZOOM = 5, AIM_L = 700;
// 1 unit is 1.5 m: u/s to knots for the speedometer (a tank's has its own factor, a plane's km/h)
export const KNOTS = 1.5 * 3600 / 1852;

// the ship's own state: the telegraph's step, the rudder (-1..1, + to port), the turn (rad/s), the heel, the aim (camera yaw and pitch),
// the binoculars (zoom: held; zk: the magnification now), the turrets (c: traverse off their rest, cd: reload, el: the guns' elevation,
// st: on target, turning, loading or blocked), torpedoes' and AA's reload, the aim point (ax, ay, az) with its range, the shells' flight
// time there and whether they reach it; t: seconds since it came out, sunk: the sinking's effects started
type TurSt = 'ok' | 'turn' | 'load' | 'block';
export const sh = {
  tel: TEL_STOP, rud: 0, yr: 0, heel: 0, aimY: 0, aimP: -0.05, zoom: false, zk: 1, t: 0, sunk: false, pa: 0,
  tur: TURRETS.map(() => ({ c: 0, cd: 0, el: 0, st: 'ok' as TurSt, d: 0 })),
  torpCd: 0, aaCd: 0, aaGun: 1, ramCd: 0, upWas: false, downWas: false, qWas: false, altWas: false,
  ax: 0, ay: 0, az: 0, aimD: 0, flight: 0, reach: true,
};
export const TEL_N = TEL.length;

// ---------- the model ----------
// A low-poly destroyer, bow along +z, port (+x) and starboard (-x), the waterline at y 0: 22.4 long, 5.2 wide, the deck 1-1.95 over
// the water (rising to the bow), the mast's top 5.5 (it fits under the bridges, client/shared/KARLIN-DATA.md). The hull in the player's
// colour (shared with their tank and plane) over a dark red boot topping, a white superstructure (the bridge, the funnel's deckhouse,
// the after deckhouse), the funnel in the colour with a white band and a black cap, raked aft; two twin turrets on nodes that traverse
// (their guns on nodes that elevate), triple torpedo tubes either side, two anti-aircraft mounts by the funnel, the DODO logo on the
// hull's sides and on the bridge's, the navigation lights. Six meshes and two per turret.
// The hull's stations: z, half beam at the deck, the deck's height, half beam at the keel
const HULL: [number, number, number, number][] = [
  [-11, 1.9, 1.05, 1.15], [-9.5, 2.3, 1.0, 1.55], [-6, 2.55, 1.0, 1.8], [0, 2.6, 1.08, 1.85], [4, 2.5, 1.18, 1.7],
  [7, 2.1, 1.38, 1.2], [9, 1.4, 1.62, 0.55], [10.4, 0.6, 1.82, 0.12], [11.2, 0, 1.95, 0],
];
const KEEL = -1.4, BOOT = 0.12;                    // the hull's bottom, the top of the boot topping (just over the waterline)
const RED = 0x7a2e2a, DECK = 0x4b5251, WH = COL.lgrey, GREY = 0x8d9593, DARK = 0x2b3130;
// a quad a, b, c, d turned to face along (ox, oy, oz)
function face(bk: Bucket, a: P3, b: P3, c: P3, d: P3, col: number, ox: number, oy: number, oz: number) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  if (nx * ox + ny * oy + nz * oz < 0) quad(bk, a, d, c, b, col); else quad(bk, a, b, c, d, col);
}
// the half beam of station st at height y (the sides flare out from the keel to the deck)
const beamAt = (st: number[], y: number) => st[3] + (st[1] - st[3]) * (y - KEEL) / (st[2] - KEEL);
function hull(paint: Bucket, rest: Bucket) {
  for (let i = 0; i + 1 < HULL.length; i++) {
    const A = HULL[i], B = HULL[i + 1];
    for (const sx of [-1, 1]) {
      const p = (st: number[], y: number): P3 => [sx * beamAt(st, y), y, st[0]], top = (st: number[]): P3 => [sx * st[1], st[2], st[0]];
      face(rest, p(A, KEEL), p(B, KEEL), p(B, BOOT), p(A, BOOT), RED, sx, 0, 0);          // the boot topping
      face(paint, p(A, BOOT), p(B, BOOT), top(B), top(A), 0xffffff, sx, 0, 0);           // the side, in the colour
      face(rest, top(A), top(B), [sx * B[1], B[2] + 0.12, B[0]], [sx * A[1], A[2] + 0.12, A[0]], WH, sx, 0, 0);   // a low bulwark
    }
    face(rest, [A[1], A[2], A[0]], [B[1], B[2], B[0]], [-B[1], B[2], B[0]], [-A[1], A[2], A[0]], DECK, 0, 1, 0);   // the deck
    face(rest, [A[3], KEEL, A[0]], [B[3], KEEL, B[0]], [-B[3], KEEL, B[0]], [-A[3], KEEL, A[0]], RED, 0, -1, 0);   // the bottom
  }
  const S = HULL[0], hb = beamAt(S, BOOT);                                                // the transom
  face(rest, [S[3], KEEL, S[0]], [-S[3], KEEL, S[0]], [-hb, BOOT, S[0]], [hb, BOOT, S[0]], RED, 0, 0, -1);
  face(paint, [hb, BOOT, S[0]], [-hb, BOOT, S[0]], [-S[1], S[2], S[0]], [S[1], S[2], S[0]], 0xffffff, 0, 0, -1);
}
let LOGO_MAT: StandardMaterial | null = null;
export function makeShip(paint: StandardMaterial): TransformNode {
  const g = new TransformNode('ship', scene);
  const mesh = (name: string, geo: Geo, mat: StandardMaterial, cast: boolean, parent: TransformNode = g) => { const m = geoMesh(name, geo, mat, cast, false); m.parent = parent; return m; };
  const at = (geo: Geo, x: number, y: number, z: number) => translate(geo, x, y, z);
  const P = Bucket(), R = Bucket(), L = Bucket();
  hull(P, R);
  // the bridge: its block, the wheelhouse with windows all round, the wings with the navigation lights, the mast with a yard and radar
  addGeo(R, at(boxGeo(3.3, 1.95, 3.2), 0, 2.07, 2.2), null, WH);
  addGeo(R, at(boxGeo(2.7, 0.95, 2.0), 0, 3.5, 2.5), null, WH);
  addGeo(R, at(boxGeo(2.85, 0.12, 2.15), 0, 4.0, 2.5), null, GREY);
  addGeo(L, at(boxGeo(2.4, 0.3, 0.05), 0, 3.62, 3.51), null, 0xcfe9e4);
  for (const sx of [-1, 1]) addGeo(L, at(boxGeo(0.05, 0.3, 1.5), sx * 1.36, 3.62, 2.55), null, 0xcfe9e4);
  addGeo(R, at(boxGeo(4.9, 0.1, 0.9), 0, 3.02, 3.0), null, GREY);
  addGeo(L, at(boxGeo(0.18, 0.18, 0.18), 2.4, 3.15, 3.0), null, 0xff4040);              // port (+x) red
  addGeo(L, at(boxGeo(0.18, 0.18, 0.18), -2.4, 3.15, 3.0), null, 0x40ff80);             // starboard green
  addGeo(R, at(cylGeo(0.08, 0.12, 1.45, 6), 0, 4.75, 2.2), null, DARK);
  addGeo(R, at(boxGeo(1.7, 0.07, 0.07), 0, 5.05, 2.2), null, DARK);
  addGeo(R, at(boxGeo(0.95, 0.2, 0.2), 0, 5.3, 2.4), null, GREY);
  addGeo(L, at(boxGeo(0.15, 0.15, 0.15), 0, 5.5, 2.2), null, 0xffffff);                 // the masthead light
  // the funnel's deckhouse, the funnel (the colour, a white band, a black cap; oval, raked aft), the anti-aircraft mounts beside it
  addGeo(R, at(boxGeo(2.6, 0.95, 3.9), 0, 1.52, -1.65), null, WH);
  const funnel = (r0: number, r1: number, h: number, y: number) => rotateX(scaleGeo(at(cylGeo(r0, r1, h, 14), 0, y, 0), 0.72, 1, 1), -0.1);
  addGeo(P, at(funnel(0.8, 0.92, 2.1, 3.0), 0, 0, -1.8), null, 0xffffff);
  addGeo(R, at(funnel(0.83, 0.85, 0.4, 3.75), 0, 0, -1.8), null, WH);
  addGeo(R, at(funnel(0.81, 0.81, 0.3, 4.2), 0, 0, -1.8), null, DARK);
  for (const sx of [-1, 1]) {
    addGeo(R, at(cylGeo(0.45, 0.5, 0.35, 10), sx * AA_X, 2.17, AA_Z), null, GREY);
    for (const k of [-1, 1]) addGeo(R, at(rotateX(cylGeo(0.05, 0.05, 1.1, 5), Math.PI / 2 - 0.7), sx * AA_X + k * 0.13, 2.65, AA_Z + 0.25), null, DARK);
  }
  // the after deckhouse with a searchlight, the torpedo tubes (three on a turntable each side, turned out)
  addGeo(R, at(boxGeo(2.3, 0.95, 1.5), 0, 1.47, -6.2), null, WH);
  addGeo(R, at(cylGeo(0.22, 0.22, 0.3, 8), 0, 2.1, -6.0), null, GREY);
  for (const sx of [-1, 1]) {
    const a = sx * 0.45, ox = Math.cos(a) * 0.33, oz = -Math.sin(a) * 0.33;
    addGeo(R, at(cylGeo(0.62, 0.62, 0.18, 10), sx * TUBE_X, 1.1, TUBE_Z), null, DARK);
    for (const k of [-1, 0, 1]) addGeo(R, at(rotateY(rotateX(cylGeo(0.15, 0.15, 2.4, 6), Math.PI / 2), a), sx * TUBE_X + k * ox, 1.38, TUBE_Z + k * oz), null, GREY);
    addGeo(R, at(boxGeo(0.14, 0.4, 0.5), sx * 1.5, 1.05, 8.6), null, DARK);             // the anchors
  }
  // the jack staff at the bow, the ensign staff at the stern with a little DODO-green flag
  addGeo(R, at(cylGeo(0.04, 0.04, 1.1, 4), 0, 2.5, 10.9), null, DARK);
  addGeo(R, at(cylGeo(0.04, 0.04, 1.5, 4), 0, 1.8, -10.75), null, DARK);
  addGeo(R, at(boxGeo(0.04, 0.45, 0.75), 0, 2.3, -11.1), null, COL.green);
  mesh('shipPaint', P, paint, true); mesh('shipParts', R, VC_MAT, true); mesh('shipLights', L, VC_GLOW, false);
  // the logos: on the hull's sides, leaning out with the flare, and on the bridge's sides, readable from outside
  LOGO_MAT ??= basic(0xffffff, { map: logoTex, transparent: true });
  const lg = Bucket(), st = HULL[3], lean = Math.atan2(st[1] - st[3], st[2] - KEEL);
  for (const sx of [-1, 1]) {
    addGeo(lg, at(rotateY(rotateX(planeGeo(2.7, 0.9), lean), sx * Math.PI / 2), sx * (beamAt(st, 0.6) + 0.03), 0.6, -1.2), null, 0xffffff);
    addGeo(lg, at(rotateY(planeGeo(2.4, 0.8), sx * Math.PI / 2), sx * 1.67, 2.2, 2.2), null, 0xffffff);
  }
  mesh('shipLogo', lg, LOGO_MAT, false);
  // the turrets: a node each at its ring, turned by its traverse; the guns on a node that elevates
  const tur: TransformNode[] = [], guns: TransformNode[] = [];
  TURRETS.forEach((t, i) => {
    const n = new TransformNode('shipTurret', scene); n.parent = g; n.position.set(0, t.y, t.z); n.rotation.y = t.rest;
    const tp = Bucket(), tr = Bucket(), gb = Bucket();
    addGeo(tr, at(cylGeo(1.0, 1.06, 0.22, 14), 0, 0.11, 0), null, DARK);                  // the ring
    addGeo(tp, at(boxGeo(1.9, 0.78, 1.7), 0, 0.6, -0.3), null, 0xffffff);                // the gunhouse, in the colour
    addGeo(tp, at(rotateX(boxGeo(1.9, 0.62, 0.8), 0.55), 0, 0.55, 0.5), null, 0xffffff);  // its sloped face
    addGeo(tr, at(boxGeo(1.96, 0.08, 1.76), 0, 1.0, -0.3), null, GREY);                  // its roof
    addGeo(tr, at(cylGeo(0.2, 0.2, 0.16, 8), -0.45, 1.1, -0.6), null, DARK);             // a hatch
    if (i === 0) addGeo(tr, at(boxGeo(2.5, 0.16, 0.2), 0, 1.12, -0.8), null, DARK);      // the fore turret's rangefinder
    const gn = new TransformNode('shipGuns', scene); gn.parent = n; gn.position.set(0, GUN_Y, 0.55);
    addGeo(gb, boxGeo(1.25, 0.48, 0.3), null, GREY);                                       // the mantlet
    for (const sx of [-0.4, 0.4]) {
      addGeo(gb, at(rotateX(cylGeo(0.09, 0.12, GUN_L - 0.2, 8), Math.PI / 2), sx, 0, (GUN_L - 0.2) / 2 + 0.1), null, DARK);
      addGeo(gb, at(rotateX(cylGeo(0.13, 0.13, 0.22, 8), Math.PI / 2), sx, 0, GUN_L - 0.1), null, DARK);
    }
    mesh('shipTurretPaint', tp, paint, true, n); mesh('shipTurretParts', tr, VC_MAT, true, n); mesh('shipGunParts', gb, VC_MAT, true, gn);
    tur.push(n); guns.push(gn);
  });
  g.metadata = { tur, guns, smokeT: 0 };
  return g;
}
// another player's ship leaves (net/net.ts): its meshes go with their shadows (the paint and the logo are shared)
export function disposeShip(g: TransformNode) {
  for (const m of g.getChildMeshes()) removeCaster(m);
  g.dispose();
}
// the player's ship (main.ts calls this after the plane)
export function buildShip() { view.ship = makeShip(vanOwnMat); view.ship.setEnabled(false); }

// A ship drawn where it is (yours and the others', net/net.ts): its place (y: heave and sinking), heading, pitch, heel, the turrets'
// traverse (yaw against the hull) and the guns' elevation; while afloat, its wake and bow wave (world/water.ts) and smoke from the
// funnel, more the faster it goes
const FUNNEL = new Vector3(0, 4.45, -2.25), FW = new Vector3();
export function poseShip(g: TransformNode, x: number, y: number, z: number, h: number, p: number, r: number, a0: number, a1: number, el: number, v: number, dt: number, afloat: boolean) {
  g.position.set(x, WATER_Y + y, z); g.rotation.set(-p, h, r);
  const md = g.metadata as { tur: TransformNode[]; guns: TransformNode[]; smokeT: number };
  md.tur[0].rotation.y = a0; md.tur[1].rotation.y = a1;
  md.guns[0].rotation.x = md.guns[1].rotation.x = -el;
  if (!afloat) return;
  const hx = Math.sin(h), hz = Math.cos(h);
  wake(x, z, hx, hz, v, 5.2);
  if ((md.smokeT -= dt) <= 0) {
    md.smokeT = 0.45 - 0.3 * Math.min(1, Math.abs(v) / V_MAX);
    Vector3.TransformCoordinatesToRef(FUNNEL, g.computeWorldMatrix(true), FW);
    puff(FW.x, FW.y, FW.z, 0.7 + 0.3 * Math.random(), 2.4, 1.6, -hx * v * 0.35, -hz * v * 0.35);
  }
}

// ---------- spawning ----------
// at one of the river's spawn points (client/shared/naval.ts SHIP_SPAWNS: about 16 spots at least 25 from the banks, facing along the
// river), as far from the others as the river allows, never right onto another ship
export function spawnShip() {
  let best = SHIP_SPAWNS[0] || { x: 0, z: -400, h: Math.PI / 2 }, bs = -1;
  for (const s of SHIP_SPAWNS) {
    let d = 1400, ship = Infinity;
    for (const o of NET.others.values()) if (o.on) { const e = Math.hypot(o.x - s.x, o.z - s.z); d = Math.min(d, e); if (o.k === 2) ship = Math.min(ship, e); }
    const sc = (ship < 30 ? -1000 : 0) + d + Math.random() * 60; if (sc > bs) { bs = sc; best = s; }
  }
  Object.assign(car, { k: 2, x: best.x, z: best.z, h: best.h, y: 0, p: 0, v: 0, gy: WATER_Y, steer: 0, topT: 0, roll: 0, slowT: 0, swT: 0, hitLog: [], immT: SPAWN_IMMUNE });
  Object.assign(sh, { tel: TEL_STOP, rud: 0, yr: 0, heel: 0, aimY: best.h, aimP: -0.05, zoom: false, zk: 1, t: 0, sunk: false, pa: 0, torpCd: 0, aaCd: 0, ramCd: 0 });
  sh.tur.forEach(t => { t.c = 0; t.cd = 0; t.el = 0; t.st = 'ok'; });
  sh.upWas = K.up; sh.downWas = K.down; sh.qWas = HELD.has('KeyQ'); sh.altWas = K.alt;     // a key held through the spawn does not count
  input.mx = input.my = 0;
  aimRay(); shipCam(0, true);
}

// ---------- moving ----------
// the deepest overlap of the ship at (x, z, h) with a bank, a pier or another ship (whose circles are its own SHIP_C); other: the ship
const PEN = { nx: 0, nz: 0, pen: 0, o: null as NetOther | null };
function shipPen(x: number, z: number, h: number): typeof PEN | null {
  const fx = Math.sin(h), fz = Math.cos(h); PEN.pen = 0; PEN.o = null;
  for (const j of SHIP_C) {
    const px = x + fx * j, pz = z + fz * j, w = waterPush(px, pz, SHIP_CR);
    if (w && w.pen > PEN.pen) { PEN.nx = w.nx; PEN.nz = w.nz; PEN.pen = w.pen; PEN.o = null; }
    for (const o of NET.others.values()) {
      if (!o.on || o.k !== 2 || o.s === 2 || Math.abs(o.x - px) > 14 || Math.abs(o.z - pz) > 14) continue;
      for (const b of SHIP_C) {
        const dx = px - o.x - o.hx * b, dz = pz - o.z - o.hz * b, d = Math.hypot(dx, dz), pen = 2 * SHIP_CR - d;
        if (pen > PEN.pen) { PEN.nx = d > 1e-6 ? dx / d : -fx; PEN.nz = d > 1e-6 ? dz / d : -fz; PEN.pen = pen; PEN.o = o; }
      }
    }
  }
  return PEN.pen > 1e-4 ? PEN : null;
}
// turn to heading nh and sail dist along it in steps of at most 0.5, pushed out of whatever it runs into; it keeps the speed that runs
// along a bank and loses what went into it (a hard knock head-on bounces it back a little); a ram faster than RAM_V hurts
function moveShip(nh: number, dist: number, dt: number) {
  const n = Math.max(1, Math.ceil(Math.abs(dist) / 0.5)), dh = (nh - car.h) / n, dd = dist / n;
  let px = 0, pz = 0, rammed: NetOther | null = null, rx = 0, rz = 0;
  for (let i = 0; i < n; i++) {
    car.h += dh; car.x += Math.sin(car.h) * dd; car.z += Math.cos(car.h) * dd;
    for (let it = 0; it < 3; it++) {
      const p = shipPen(car.x, car.z, car.h); if (!p) break;
      car.x += p.nx * p.pen; car.z += p.nz * p.pen; px += p.nx * p.pen; pz += p.nz * p.pen;
      if (p.o) { rammed = p.o; rx = p.nx; rz = p.nz; }
    }
  }
  if (rammed && sh.ramCd <= 0) {
    const close = -(Math.sin(car.h) * car.v - rammed.hx * rammed.v) * rx - (Math.cos(car.h) * car.v - rammed.hz * rammed.v) * rz;   // closing speed
    if (close > RAM_V) { sh.ramCd = 2; hitPlayer('ram', rx * Math.cos(car.h) - rz * Math.sin(car.h) > 0 ? -1 : 1, T.rammed(rammed.name)); }
  }
  const l = Math.hypot(px, pz); if (l < 1e-4 || Math.abs(car.v) < 0.01) return;
  const d = (Math.sin(car.h) * px + Math.cos(car.h) * pz) / l * Math.sign(car.v);      // -1: straight into it, 0: along it
  if (d >= 0) return;
  if (d < -0.8 && Math.abs(car.v) > 4) { car.v *= -0.2; return; }
  car.v *= Math.exp(-4 * d * d * dt);
}

// ---------- the aim ----------
const fwd = (h: number, p: number): P3 => [Math.sin(h) * Math.cos(p), Math.sin(p), Math.cos(h) * Math.cos(p)];
// where the camera's eye is for the aim (yaw, pitch): behind the ship round a pivot CAM_UP over the water, pulled in front of a wall
// and kept over the water; through the binoculars, over the bridge. Into EYE.
const EYE = new Vector3();
function eye(zoom: boolean) {
  const [fx, fy, fz] = fwd(sh.aimY, sh.aimP), base = WATER_Y + car.y;
  if (zoom) { EYE.set(car.x + Math.sin(car.h) * 2, base + 6.6, car.z + Math.cos(car.h) * 2); return EYE; }
  const D = G.camMode ? CAM_D_FAR : CAM_D, cx = car.x, cy = WATER_Y + CAM_UP, cz = car.z;
  let ex = cx - fx * D, ey = cy - fy * D, ez = cz - fz * D;
  const hit = segHit(cx, cy, cz, ex, ey, ez); if (hit < 1) { const k = Math.max(0.15, hit - 0.05); ex = cx + (ex - cx) * k; ey = cy + (ey - cy) * k; ez = cz + (ez - cz) * k; }
  EYE.set(ex, Math.max(ey, surfaceY(ex, ez) + 1.2), ez); return EYE;
}
// a ray from o along d (unit) against a sphere: the distance to where it enters it, or Infinity
function raySphere(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, cx: number, cy: number, cz: number, r: number) {
  const fx = ox - cx, fy = oy - cy, fz = oz - cz, b = fx * dx + fy * dy + fz * dz, c = fx * fx + fy * fy + fz * fz - r * r, disc = b * b - c;
  if (disc < 0) return Infinity; const t = -b - Math.sqrt(disc); return t > 0 ? t : Infinity;
}
// The aim point: where the middle of the view (the camera's ray) first meets another ship or tank, a building, the ground or the
// water, within AIM_L (nothing: the point AIM_L along it, out of reach). Then its range from the ship and whether the shells get there.
function aimRay() {
  const E = eye(sh.zk > 2), [dx, dy, dz] = fwd(sh.aimY, sh.aimP), ox = E.x, oy = E.y, oz = E.z;
  let t = segHit(ox, oy, oz, ox + dx * AIM_L, oy + dy * AIM_L, oz + dz * AIM_L) * AIM_L;
  // the ground or the water: walk along the ray, then halve the last step
  for (let s = 1.5, ps = 0; s < t; ps = s, s += Math.min(6, 1.5 + s * 0.03)) {
    if (oy + dy * s >= surfaceY(ox + dx * s, oz + dz * s)) continue;
    let a = ps, b = s; for (let k = 0; k < 6; k++) { const m = (a + b) / 2; if (oy + dy * m < surfaceY(ox + dx * m, oz + dz * m)) b = m; else a = m; }
    t = b; break;
  }
  for (const o of NET.others.values()) {
    if (!o.on || o.s === 2 || o.k === 1 || Math.hypot(o.x - ox, o.z - oz) > t + 12) continue;
    if (o.k === 2) for (const j of SHIP_C) t = Math.min(t, raySphere(ox, oy, oz, dx, dy, dz, o.x + o.hx * j, WATER_Y + o.y + 1.6, o.z + o.hz * j, 3));
    else t = Math.min(t, raySphere(ox, oy, oz, dx, dy, dz, o.x, groundH(o.x, o.z) + 1.1, o.z, 2));
  }
  sh.ax = ox + dx * t; sh.ay = oy + dy * t; sh.az = oz + dz * t;
}
// The elevation that drops a shell from a muzzle onto a point d away (horizontally) and dy higher, the flatter of the two arcs, and
// its flight time; out of reach: the longest throw (45°), which falls short. Into BAL.
const BAL = { el: 0, t: 0, ok: true };
function ballistic(d: number, dy: number) {
  const v2 = SHELL_V * SHELL_V, g = SHELL_G, disc = v2 * v2 - g * (g * d * d + 2 * dy * v2);
  if (d < 0.5) { BAL.el = 0; BAL.t = 0; BAL.ok = true; return BAL; }
  BAL.ok = disc >= 0; BAL.el = BAL.ok ? Math.atan((v2 - Math.sqrt(disc)) / (g * d)) : Math.PI / 4;
  BAL.t = d / (SHELL_V * Math.cos(BAL.el)); return BAL;
}
// a turret's guns' pivot in the world (on the axis, ignoring the heel): into TP
const TP = new Vector3();
function turretAt(i: number) { const t = TURRETS[i]; TP.set(car.x + Math.sin(car.h) * t.z, WATER_Y + car.y + t.y + GUN_Y, car.z + Math.cos(car.h) * t.z); return TP; }
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

// ---------- the weapons ----------
// a salvo of turret i: two shells, each aimed at the aim point moved by the dispersion (a share of the range, longer along the line of
// fire than across it), the muzzles' flash and smoke
function salvo(i: number) {
  const tu = sh.tur[i], p = turretAt(i), yaw = car.h + TURRETS[i].rest + tu.c, fx = Math.sin(yaw), fz = Math.cos(yaw), lx = fz, lz = -fx;
  const ax0 = sh.ax - p.x, az0 = sh.az - p.z, d0 = Math.hypot(ax0, az0) || 1, ux = ax0 / d0, uz = az0 / d0;
  for (const side of [-0.4, 0.4]) {
    const n = () => Math.random() + Math.random() - 1, along = n() * DISP * d0 * 1.4, across = n() * DISP * d0 * 0.7;
    const tx = sh.ax + ux * along + uz * across - p.x, tz = sh.az + uz * along - ux * across - p.z, d = Math.hypot(tx, tz);
    const b = ballistic(d, sh.ay - p.y), ce = Math.cos(b.el), se = Math.sin(b.el);
    // the shell leaves the muzzle along the turret's bearing (it is on target: within ALIGN of the aim), elevated to its arc
    const mx = p.x + fx * (0.55 + GUN_L * ce) + lx * side, my = p.y + GUN_L * se, mz = p.z + fz * (0.55 + GUN_L * ce) + lz * side;
    const hx = d > 0.5 ? tx / d : fx, hz = d > 0.5 ? tz / d : fz;
    fireShell(mx, my, mz, hx * ce * SHELL_V, se * SHELL_V, hz * ce * SHELL_V);
    glow(mx + fx * 0.8, my, mz + fz * 0.8, 1.6, 0.16); puff(mx + fx * 1.2, my, mz + fz * 1.2, 1.1, 1.3, 0.8, fx * 3, fz * 3);
  }
  tu.cd = RELOAD;
}
// three torpedoes from the side facing the aim, spread about the aim's bearing (kept within the tubes' arc on that side)
function torpedoes() {
  const b = wrap(Math.atan2(sh.ax - car.x, sh.az - car.z) - car.h), side = b >= 0 ? 1 : -1;
  const mid = car.h + side * clamp(Math.abs(b), TUBE_ARC0, TUBE_ARC1);
  const lx = Math.cos(car.h) * side, lz = -Math.sin(car.h) * side, x0 = car.x + Math.sin(car.h) * TUBE_Z + lx * (TUBE_X + 1.2), z0 = car.z + Math.cos(car.h) * TUBE_Z + lz * (TUBE_X + 1.2);
  for (const k of [-1, 0, 1]) fireTorp(x0 + Math.sin(mid) * k * 0.6, z0 + Math.cos(mid) * k * 0.6, mid + k * TORP_SPREAD);
  sh.torpCd = TORP_RELOAD;
}
// the anti-aircraft guns: as the tank's (game/tank.ts fireAA), from the two mounts by the funnel in turn, at the nearest plane in reach
// and in sight as drawn here, led by the bullet's flight; with no plane about they fire up and ahead
function aa() {
  if (sh.aaCd > 0) return; sh.aaCd = AA_RATE; sh.aaGun = -sh.aaGun;
  const hx = Math.sin(car.h), hz = Math.cos(car.h), ox = car.x + hz * AA_X * sh.aaGun + hx * AA_Z, oy = WATER_Y + car.y + AA_Y, oz = car.z - hx * AA_X * sh.aaGun + hz * AA_Z;
  let best: NetOther | null = null, bd = AA_R;
  for (const o of NET.others.values()) {
    if (!o.on || o.k !== 1 || o.s === 2) continue;
    const d = Math.hypot(o.x - ox, o.y - oy, o.z - oz); if (d < bd && segHit(ox, oy, oz, o.x, o.y, o.z) >= 1) { bd = d; best = o; }
  }
  if (!best && COARSE && !HELD.has('KeyE')) return;                // on a touch screen the guns fire by themselves, only at a plane
  let dx = hx * 0.8, dy = 0.6, dz = hz * 0.8;
  if (best) {
    const vx = Math.sin(best.h) * Math.cos(best.p) * best.v, vy = Math.sin(best.p) * best.v, vz = Math.cos(best.h) * Math.cos(best.p) * best.v;
    let t = bd / BUL_V; for (let i = 0; i < 2; i++) { dx = best.x + vx * t - ox; dy = best.y + vy * t - oy; dz = best.z + vz * t - oz; t = Math.hypot(dx, dy, dz) / BUL_V; }
  }
  const l = Math.hypot(dx, dy, dz) || 1, e = () => (Math.random() - 0.5) * AA_ERR;
  dx = dx / l + e(); dy = dy / l + e(); dz = dz / l + e();
  fireBullet(ox + dx, oy + dy, oz + dz, dx * BUL_V, dy * BUL_V, dz * BUL_V);
}

// ---------- the ship, every frame ----------
export function updateShip(dt: number) {
  carStatus(dt);                                                   // immunity, and the countdown to the respawn once destroyed (game/tank.ts)
  if (car.k !== 2) { input.mx = input.my = 0; return; }            // switched to another vehicle (carStatus respawned)
  const dead = car.topT > 0, busy = car.swT > 0;
  sh.t += dt; sh.ramCd -= dt; sh.aaCd -= dt; sh.torpCd = Math.max(0, sh.torpCd - dt);
  // the aim: the mouse (locked to the game) or a drag on a touch screen; slower through the binoculars
  sh.zoom = !dead && (input.rmb || HELD.has('ShiftLeft') || HELD.has('ShiftRight'));
  sh.zk += ((sh.zoom ? ZOOM : 1) - sh.zk) * Math.min(1, dt * 12);
  const sens = SENS / sh.zk;
  sh.aimY -= input.mx * sens; sh.aimP = clamp(sh.aimP - input.my * sens, AIM_P0, AIM_P1); input.mx = input.my = 0;
  if (dead) { sink(dt); return; }
  // the telegraph: one step a press of W/S (the touch gas and brake buttons)
  if (K.up && !sh.upWas) sh.tel = Math.min(TEL.length - 1, sh.tel + 1);
  if (K.down && !sh.downWas) sh.tel = Math.max(0, sh.tel - 1);
  sh.upWas = K.up; sh.downWas = K.down;
  // the rudder follows A/D (the touch pad) at its own pace
  const cmd = clamp((K.left ? 1 : 0) - (K.right ? 1 : 0) - input.steerAxis, -1, 1);
  sh.rud += clamp(cmd - sh.rud, -dt / RUD_T, dt / RUD_T);
  // the speed follows the telegraph (a hard turn bleeds some)
  const v0 = car.v, tv = TEL[sh.tel] * V_MAX * (1 - TURN_SLOW * Math.abs(sh.rud) * Math.min(1, Math.abs(car.v) / V_MAX));
  const dv = tv - car.v, acc = Math.sign(dv) === Math.sign(car.v || dv) ? ACC : DEC;
  car.v += clamp(dv, -acc * dt, acc * dt) * Math.min(1, 0.35 + Math.abs(dv) / 2);
  // the turn: by the rudder and the speed, coming on slowly
  sh.yr += (sh.rud * car.v / TURN_R - sh.yr) * Math.min(1, dt / YAW_T);
  moveShip(car.h + sh.yr * dt, car.v * dt, dt);
  // heel into the turn, pitch (the bow lifts as it speeds up), the swell
  sh.heel += (-sh.yr * HEEL - sh.heel) * Math.min(1, dt * 1.5);
  sh.pa += ((car.v - v0) / Math.max(dt, 1e-4) * 0.012 - sh.pa) * Math.min(1, dt * 2);
  car.roll = sh.heel + Math.sin(sh.t * 0.83) * 0.014;
  car.p = sh.pa + Math.sin(sh.t * 1.07 + 1) * 0.008;
  car.y = Math.sin(sh.t * 1.31) * 0.06;

  // the turrets: towards the aim point within their arcs, then on target, loading, turning or blocked
  aimRay();
  let any = false;
  sh.tur.forEach((tu, i) => {
    const t = TURRETS[i], p = turretAt(i), want = wrap(Math.atan2(sh.ax - p.x, sh.az - p.z) - car.h - t.rest);
    const goal = clamp(want, -ARC, ARC);
    tu.c += clamp(goal - tu.c, -TRAV * dt, TRAV * dt);
    tu.cd = Math.max(0, tu.cd - dt);
    tu.d = Math.hypot(sh.ax - p.x, sh.az - p.z);
    const b = ballistic(tu.d, sh.ay - p.y); tu.el += (b.el - tu.el) * Math.min(1, dt * 3);
    if (i === 0 || !any) { sh.flight = b.t; sh.reach = b.ok; sh.aimD = tu.d; }
    const blocked = Math.abs(want) > ARC;
    tu.st = tu.cd > 0 ? 'load' : blocked ? 'block' : Math.abs(want - tu.c) < ALIGN ? 'ok' : 'turn';
    if (!blocked) any = true;
  });
  // fire: every turret on target and loaded (the left button held, or the touch fire button); not while switching vehicles
  if ((input.lmb || K.fire) && !busy) sh.tur.forEach((tu, i) => { if (tu.st === 'ok') salvo(i); });
  // torpedoes: Q (the touch button for the second weapon), one spread a press
  const q = HELD.has('KeyQ') || (COARSE && K.alt);
  if (q && !sh.qWas && !busy) { if (sh.torpCd <= 0) torpedoes(); else flash(T.torpLoading(Math.ceil(sh.torpCd))); }
  sh.qWas = q;
  if ((HELD.has('KeyE') || COARSE) && !busy) aa();
}
// destroyed: it lists to the side the hit came from, the bow lifts, it settles and goes down (game/tank.ts SINK_T)
function sink(dt: number) {
  const tt = SINK_T - car.topT, e = (a: number) => a <= 0 ? 0 : a >= 1 ? 1 : a * a * (3 - 2 * a);
  if (!sh.sunk) { sh.sunk = true; sinkFx(car.x, car.z); startImpactFx(car.x, car.z, 0.5, 0.5, WATER_Y + 1.5); }
  car.v *= Math.exp(-1.2 * dt); sh.yr *= Math.exp(-2 * dt);
  moveShip(car.h + sh.yr * dt, car.v * dt, dt);
  car.roll = sh.heel + car.rollDir * 0.6 * e(tt / 2.6);
  car.p = 0.16 * e(tt / 3.2);
  car.y = -8 * e((tt - 0.4) / 3.6);
  if (Math.random() < dt * 6) puff(car.x + (Math.random() - 0.5) * 8, WATER_Y + car.y + 3, car.z + (Math.random() - 0.5) * 8, 1.5, 2.2, 1.8);
}

// ---------- drawing ----------
// the player's ship where it is; blinking while immune, gone once it is under
export function shipView(dt: number, tnow: number) {
  const g = view.ship; if (!g) return;
  const on = car.k === 2 && car.y > -7.5;
  g.setEnabled(on && !(car.immT > 0 && Math.floor(tnow / 110) % 2));
  if (on) poseShip(g, car.x, car.y, car.z, car.h, car.p, car.roll, TURRETS[0].rest + sh.tur[0].c, TURRETS[1].rest + sh.tur[1].c, Math.max(sh.tur[0].el, -0.05), car.v, dt, car.topT <= 0);
}
// the turrets' yaw against the hull, for the state row (net/net.ts)
export const turretYaw = (i: number) => wrap(TURRETS[i].rest + sh.tur[i].c);

// the camera: at the eye of the aim (behind the ship, or over the bridge through the binoculars), looking along the aim; destroyed: it
// backs off and up, watching the ship go down
export function shipCam(dt: number, snap = false) {
  if (car.topT > 0) {
    const cx = car.x - Math.sin(sh.aimY) * 34, cz = car.z - Math.cos(sh.aimY) * 34, cy = WATER_Y + 16, k = snap ? 1 : 1 - Math.exp(-dt * 2), c = camera.position;
    c.x += (cx - c.x) * k; c.y += (cy - c.y) * k; c.z += (cz - c.z) * k;
    const q = Math.min(1, dt * 3); camLook.x += (car.x - camLook.x) * q; camLook.y += (WATER_Y - camLook.y) * q; camLook.z += (car.z - camLook.z) * q;
    return;
  }
  const E = eye(sh.zk > 2), [fx, fy, fz] = fwd(sh.aimY, sh.aimP);
  camera.position.copyFrom(E); camLook.set(E.x + fx * 100, E.y + fy * 100, E.z + fz * 100);
}

// ---------- the HUD ----------
// the aim cross where the aim point is (the middle of the view), the shells' flight time under it (or "out of range"), a mark for each
// turret where its guns point now (green on target, amber turning, grey loading or blocked), the binoculars' frame; and the card over
// the speedometer: the telegraph, the rudder, the turrets', the torpedoes' state. Elements change only when their content does.
const VP = new Matrix();
function toScreen(x: number, y: number, z: number, el: HTMLElement): boolean {
  const m = VP.m, w = x * m[3] + y * m[7] + z * m[11] + m[15];
  if (w <= camera.minZ) { el.hidden = true; return false; }
  const sx = (x * m[0] + y * m[4] + z * m[8] + m[12]) / w, sy = (x * m[1] + y * m[5] + z * m[9] + m[13]) / w;
  el.hidden = false; el.style.transform = `translate(${((sx + 1) / 2 * innerWidth).toFixed(1)}px,${((1 - sy) / 2 * innerHeight).toFixed(1)}px) translate(-50%,-50%)`;
  return true;
}
const HUD: Record<string, string> = {};
function setText(id: string, s: string) { if (HUD[id] !== s) { HUD[id] = s; $(id).textContent = s; } }
function setCls(id: string, s: string) { if (HUD['c' + id] !== s) { HUD['c' + id] = s; $(id).className = s; } }
const fmt = (v: number) => v.toFixed(1).replace('.', T.dec);
export function drawShipHud(on: boolean) {
  const x = $('shipX'), show = on && car.k === 2 && car.topT <= 0;
  if (!show) { if (!x.hidden) { x.hidden = true; $('tm0').hidden = $('tm1').hidden = true; $('scope').hidden = true; } return; }
  camera.getViewMatrix().multiplyToRef(camera.getProjectionMatrix(), VP);
  toScreen(sh.ax, sh.ay, sh.az, x);
  setText('shipT', sh.reach ? fmt(sh.flight) + ' s · ' + Math.round(sh.aimD * 1.5) + ' m' : T.outOfRange);
  sh.tur.forEach((tu, i) => {
    const p = turretAt(i), yaw = car.h + TURRETS[i].rest + tu.c, el = $('tm' + i);
    if (tu.st === 'block') { el.hidden = true; return; }
    toScreen(p.x + Math.sin(yaw) * tu.d, sh.ay, p.z + Math.cos(yaw) * tu.d, el);
    setCls('tm' + i, 'tmark ' + tu.st);
  });
  const sc = $('scope'); if (sc.hidden === sh.zk > 2) sc.hidden = !(sh.zk > 2);
}
export function seaHud() {
  for (let i = 0; i < TEL.length; i++) { setText('tel' + i, T.telNames[i]); setCls('tel' + i, i === sh.tel ? 'on' : ''); }
  $('rud').style.transform = `translateX(${(-sh.rud * 26).toFixed(1)}px)`;
  sh.tur.forEach((tu, i) => {
    setCls('tur' + i, 'chip ' + tu.st);
    setText('turS' + i, tu.st === 'load' ? Math.ceil(tu.cd) + ' s' : T.turSt[tu.st]);
  });
  setCls('torp', 'chip ' + (sh.torpCd > 0 ? 'load' : 'ok'));
  setText('torpS', sh.torpCd > 0 ? Math.ceil(sh.torpCd) + ' s' : T.turSt.ok);
}
