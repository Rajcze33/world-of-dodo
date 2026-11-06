// ---------- World of DODO, issue #20: the ships' shells and torpedoes, and the small blasts they make ----------
// A shell flies a ballistic arc (stronger gravity than a parcel's, so a ship's guns reach about 320) and blows up at the first thing it
// touches: a building or the ground (a burst of fire and smoke), the water (a white column, world/water.ts splash), a ship or a tank.
// Planes are too fast for shells: they fly through. A torpedo runs straight along the surface at TORP_V for TORP_RUN, leaving a wake
// (world/water.ts torpWake), and blows up against a ship, a bank or a bridge pier (client/shared/naval.ts inWater); it never hits a tank.
// Who decides a hit (docs/PROTOCOL.md):
// - on a person's ship or tank: that person, as for a parcel (both are slow). Every browser flies everyone's shells and torpedoes, and
//   the one whose own vehicle is hit applies it (game/tank.ts hitPlayer) and tells the server (net/net.ts netHit), which scores it;
// - on a bot (always a tank): the server, which flies the shells against the bots as it flies the parcels (server/bots.js flyParcels).
// Anywhere else a shell or a torpedo only blows up where it hits, on every screen alike.
import { Quaternion } from '@babylonjs/core';
import { camera } from '../core/engine';
import { Bucket, Inst, Dummy, addGeo, boxGeo, cylGeo, planeGeo, rotateX } from '../core/geo';
import { basic, lambert } from '../core/mat';
import { canvasTex, poolTex } from '../core/tex';
import { T } from '../texts';
import { car } from './state';
import { solidAt, groundH } from '../world/grid';
import { WATER_Y, inWater, surfaceY } from '../../shared/naval.ts';
import { splash, torpWake } from '../world/water';
import { NET, netFire, netHit, netName, netThit } from '../net/net';
import { flash } from '../ui/hud';
import { hitPlayer } from './tank';
import { fx } from './fx';
import { friendly } from './teams';
import { depotBody, depotHitAt } from '../world/objectives';
import { monBody, monReport, monSpark } from './monster';

// muzzle speed and gravity of a shell (server/bots.js has the same SHELL_G): at 45° it reaches SHELL_V² / SHELL_G, about 320
export const SHELL_V = 110, SHELL_G = 38;
// a torpedo's speed and run (it runs about 16 s, server/server.js lets it score for 20)
export const TORP_V = 22, TORP_RUN = 350;
const SHELL_MAX = 64, SHELL_LIFE = 9, TORP_MAX = 24;

// ---------- what a shell or a torpedo hits ----------
// a ship's hit box (game/ship.ts builds the ship to it): half its length, half its beam, how high over the water it counts (the hull
// and the bridge). sy: the ship's heave and sinking (its row's y; 0 afloat). The bow narrows over its last 5 units.
export const SHIP_HL = 11, SHIP_HW = 2.6, SHIP_HH = 3.8;
export function shipBox(x: number, y: number, z: number, sx: number, sy: number, sz: number, h: number): boolean {
  const ly = y - (WATER_Y + sy); if (ly < -1.2 || ly >= SHIP_HH) return false;
  const hx = Math.sin(h), hz = Math.cos(h), dx = x - sx, dz = z - sz, a = dx * hx + dz * hz;
  if (a > SHIP_HL || a < -SHIP_HL) return false;
  const w = a > 6 ? SHIP_HW * (SHIP_HL - a) / (SHIP_HL - 6) + 0.2 : SHIP_HW;
  return Math.abs(dx * hz - dz * hx) < w;
}
// a tank's box (as the parcels see it, game/shots.ts): half length 2.4, half width 1.15, 2.1 tall over its ground gy
function tankBox(x: number, y: number, z: number, tx: number, gy: number, tz: number, h: number): boolean {
  if (y < gy - 0.2 || y > gy + 2.1) return false;
  const hx = Math.sin(h), hz = Math.cos(h), dx = x - tx, dz = z - tz;
  return Math.abs(dx * hx + dz * hz) < 2.4 && Math.abs(dx * hz - dz * hx) < 1.15;
}

// ---------- blasts: a ball of fire that swells and goes (glow), grey smoke that rises, swells and thins away (puff) ----------
// two instanced meshes of soft round sprites, turned to the camera every frame (each a little turned about its middle, rot); a blob
// not in use is shrunk to a point far below the city. The smoke's sprite is a few soft spots on top of each other (a cloud).
interface Blob { on: boolean; x: number; y: number; z: number; vx: number; vy: number; vz: number; age: number; life: number; s: number; rot: number }
const GLOW_N = 48, PUFF_N = 240;
const glows: Blob[] = [], puffs: Blob[] = [];
let glowI: Inst | null = null, puffI: Inst | null = null, gNext = 0, pNext = 0;
const D = new Dummy(), HIDDEN = new Float32Array(16); HIDDEN[13] = -1000; HIDDEN[15] = 1;
const newBlob = (): Blob => ({ on: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: 1, s: 1, rot: 0 });
function blob(list: Blob[], i: number, x: number, y: number, z: number, s: number, life: number, vx: number, vy: number, vz: number) {
  Object.assign(list[i], { on: true, x, y, z, vx, vy, vz, age: 0, life, s, rot: Math.random() * 6.283 });
}
// a sprite at b of size s facing the camera, into the instanced mesh im at i
const BQ = new Quaternion();
function sprite(im: Inst, i: number, b: Blob, s: number) {
  const c = camera.position, dx = c.x - b.x, dy = c.y - b.y, dz = c.z - b.z, l = Math.hypot(dx, dy, dz) || 1;
  Quaternion.RotationYawPitchRollToRef(Math.atan2(dx, dz), -Math.asin(dy / l), b.rot, BQ);
  D.quaternion.copyFrom(BQ); D.position.set(b.x, b.y, b.z); D.scale.setAll(Math.max(0.01, s)); im.setMatrixAt(i, D.updateMatrix());
}
// a flash of fire of size s (a muzzle, a hit) for life seconds
export function glow(x: number, y: number, z: number, s: number, life = 0.22) { blob(glows, gNext, x, y, z, s, life, 0, 0, 0); gNext = (gNext + 1) % GLOW_N; }
// a puff of smoke of size s rising at vy, drifting along (vx, vz)
export function puff(x: number, y: number, z: number, s: number, life = 1.6, vy = 1.5, vx = 0, vz = 0) { blob(puffs, pNext, x, y, z, s, life, vx, vy, vz); pNext = (pNext + 1) % PUFF_N; }
// a shell's blast: fire, smoke, and a jolt of the camera when it is close
export function burst(x: number, y: number, z: number, s = 1) {
  glow(x, y + 0.4 * s, z, 2.2 * s, 0.3);
  for (let k = 0; k < 3; k++) puff(x + (Math.random() - 0.5) * 1.6 * s, y + 0.6 * s + k * 0.5, z + (Math.random() - 0.5) * 1.6 * s, 1.3 * s, 1.4 + Math.random() * 0.6, 2 + Math.random() * 1.5);
  const d = Math.hypot(x - camera.position.x, y - camera.position.y, z - camera.position.z);
  if (d < 35) fx.shakeT = Math.max(fx.shakeT, 0.25 * (1 - d / 35) * s);
}
function drawBlobs(dt: number) {
  if (!glowI || !puffI) return;
  for (let i = 0; i < GLOW_N; i++) {
    const b = glows[i];
    if (b.on && (b.age += dt) >= b.life) b.on = false;
    if (!b.on) { glowI.setMatrixAt(i, HIDDEN); continue; }
    const k = b.age / b.life;
    sprite(glowI, i, b, b.s * Math.sin(Math.PI * Math.min(1, 0.15 + k * 0.85)));       // swells fast, shrinks away
  }
  for (let i = 0; i < PUFF_N; i++) {
    const b = puffs[i];
    if (b.on && (b.age += dt) >= b.life) b.on = false;
    if (!b.on) { puffI.setMatrixAt(i, HIDDEN); continue; }
    b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt; b.vy *= Math.exp(-0.6 * dt);
    const k = b.age / b.life;
    sprite(puffI, i, b, b.s * (0.5 + 1.2 * k) * (k < 0.6 ? 1 : (1 - k) / 0.4));      // grows as it rises, thins away at the end
  }
  glowI.update(); puffI.update();
  D.quaternion.set(0, 0, 0, 1);
}

// ---------- shells ----------
// mine: fired here (drawn and sent to the others, net/net.ts netFire with k 2); by, sid: who fired it and its number in their messages
interface Shell { i: number; on: boolean; mine: boolean; by: number; sid: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; age: number }
const shells: Shell[] = [];
let sNext = 0, slugs: Inst | null = null;
function nextShell(x: number, y: number, z: number, vx: number, vy: number, vz: number): Shell {
  const s = shells[sNext]; sNext = (sNext + 1) % SHELL_MAX;
  Object.assign(s, { on: true, mine: false, by: 0, sid: 0, x, y, z, vx, vy, vz, age: 0 });
  return s;
}
// one of my ship's shells, leaving a muzzle at (x, y, z)
export function fireShell(x: number, y: number, z: number, vx: number, vy: number, vz: number) {
  const s = nextShell(x, y, z, vx, vy, vz); s.mine = true; s.by = NET.id;
  const m = { x, y, z, vx, vy, vz, sid: 0 }; netFire(m, 2); s.sid = m.sid;
}
// someone else's (a fire message with k 2): flown here too, and if it hits my ship or my tank, I say so
export function netShell(m: { id: number; sid: number; x: number; y: number; z: number; vx: number; vy: number; vz: number }) {
  const s = nextShell(m.x, m.y, m.z, m.vx, m.vy, m.vz); s.by = m.id; s.sid = m.sid;
  glow(m.x, m.y, m.z, 1.4, 0.15);                                   // its muzzle flash
}
// the shell blows up here (s: the blast's size). World of DODO, issue #24: mine that bursts near an enemy's supply depot (client/shared/
// rules.ts depotAt: within DEPOT_NEAR of it, below its top) tells the server, which decides the damage (net/net.ts netThit, k 2)
function boom(s: Shell, size: number) {
  burst(s.x, s.y, s.z, size); s.on = false;
  if (s.mine) { const di = depotHitAt(s.x, s.y, s.z, 2, NET.team); if (di >= 0) netThit(di, 2, s.x, s.y, s.z, s.sid); }
}
// one step of a shell: what is it in now?
function shellStep(s: Shell) {
  const x = s.x, y = s.y, z = s.z;
  if (Math.abs(x) > 780 || Math.abs(z) > 780 || y < WATER_Y - 20) { s.on = false; return; }
  // my own ship or tank, hit by another's shell: I decide (it took effect: it scores for them)
  // (World of DODO, issue #24: a teammate's shell bursts on it and does nothing)
  if (!s.mine && car.topT <= 0 && (car.k === 2 ? shipBox(x, y, z, car.x, car.y, car.z, car.h) : car.k === 0 && tankBox(x, y, z, car.x, car.gy, car.z, car.h))) {
    if (!friendly(s.by) && hitPlayer('shell', Math.random() < 0.5 ? 1 : -1, T.shellBy(netName(s.by)))) {
      const kill = car.topT > 0; if (kill) flash(T.killedBy(netName(s.by))); netHit(s, kill);
    }
    return boom(s, 1.1);
  }
  // another player's ship or tank (or a bot): it blows up there; their browser (the server for a bot) decides the hit
  for (const o of NET.others.values()) {
    if (!o.on || o.id === s.by || Math.abs(o.x - x) > 12 || Math.abs(o.z - z) > 12) continue;
    if (o.k === 2 ? o.s !== 2 && shipBox(x, y, z, o.x, o.y, o.z, o.h) : o.k === 0 && tankBox(x, y, z, o.x, groundH(o.x, o.z), o.z, o.h)) return boom(s, 1.1);
  }
  // World of DODO, issue #26: Velemlok: it bursts on it on every screen, mine reports it (mhit, k 2)
  if (monBody(x, y, z)) { burst(x, y, z, 1.1); monSpark(x, y, z, 2); if (s.mine) monReport(2, s.sid, x, y, z); s.on = false; return; }
  if (depotBody(x, y, z) >= 0) return boom(s, 1.3);              // World of DODO, issue #24: a standing supply depot
  if (solidAt(x, y, z)) return boom(s, 1.3);                     // a building (the viaduct, a bridge's deck or pier)
  const g = surfaceY(x, z);                                       // the river's surface or the ground (client/shared/naval.ts)
  if (y < g) { if (g === WATER_Y) { splash(x, z, 1); s.on = false; } else { s.y = g + 0.2; boom(s, 1.3); } }
}
const Q = new Quaternion();
function drawShells() {
  if (!slugs) return;
  for (const s of shells) {
    if (!s.on) { slugs.setMatrixAt(s.i, HIDDEN); continue; }
    Quaternion.RotationYawPitchRollToRef(Math.atan2(s.vx, s.vz), -Math.atan2(s.vy, Math.hypot(s.vx, s.vz)), 0, Q);
    D.quaternion.copyFrom(Q); D.position.set(s.x, s.y, s.z); D.scale.setAll(1); slugs.setMatrixAt(s.i, D.updateMatrix());
  }
  slugs.update();
  D.quaternion.set(0, 0, 0, 1);
}

// ---------- torpedoes ----------
interface Torp { i: number; on: boolean; mine: boolean; by: number; sid: number; x: number; z: number; hx: number; hz: number; run: number }
const torps: Torp[] = [];
let tNext = 0, fish: Inst | null = null;
function nextTorp(x: number, z: number, hx: number, hz: number): Torp {
  const t = torps[tNext]; tNext = (tNext + 1) % TORP_MAX;
  Object.assign(t, { on: true, mine: false, by: 0, sid: 0, x, z, hx, hz, run: 0 });
  return t;
}
// one of my ship's torpedoes, launched at (x, z) along heading h
export function fireTorp(x: number, z: number, h: number) {
  const hx = Math.sin(h), hz = Math.cos(h), t = nextTorp(x, z, hx, hz); t.mine = true; t.by = NET.id;
  const m = { x, y: WATER_Y, z, vx: hx * TORP_V, vy: 0, vz: hz * TORP_V, sid: 0 }; netFire(m, 3); t.sid = m.sid;
  puff(x, WATER_Y + 1, z, 0.8, 0.9, 1);
}
// someone else's (a fire message with k 3)
export function netTorp(m: { id: number; sid: number; x: number; z: number; vx: number; vz: number }) {
  const l = Math.hypot(m.vx, m.vz); if (l < 1) return;
  const t = nextTorp(m.x, m.z, m.vx / l, m.vz / l); t.by = m.id; t.sid = m.sid;
}
function torpBoom(t: Torp, size: number) { splash(t.x, t.z, size); burst(t.x, WATER_Y + 0.6, t.z, 1.2); t.on = false; }
function torpStep(t: Torp) {
  const x = t.x, z = t.z;
  if (!inWater(x, z, 0.3)) return torpBoom(t, 1.6);               // a bank or a bridge pier
  // World of DODO, issue #26: Velemlok's body in the water (mine reports it, mhit k 3)
  if (monBody(x, WATER_Y + 0.3, z)) { monSpark(x, WATER_Y + 0.8, z, 3); if (t.mine) monReport(3, t.sid, x, WATER_Y + 0.3, z); return torpBoom(t, 2.4); }
  if (!t.mine && car.k === 2 && car.topT <= 0 && shipBox(x, WATER_Y + 0.3, z, car.x, car.y, car.z, car.h)) {
    const side = (x - car.x) * Math.cos(car.h) - (z - car.z) * Math.sin(car.h) > 0 ? 1 : -1;   // hit on the port (+x) side: it lists that way
    if (!friendly(t.by) && hitPlayer('torp', side, T.torpBy(netName(t.by)))) {   // (issue #24: a teammate's torpedo bursts harmlessly)
      const kill = car.topT > 0; if (kill) flash(T.killedBy(netName(t.by))); netHit(t, kill);
    }
    return torpBoom(t, 2.4);
  }
  for (const o of NET.others.values()) {
    if (!o.on || o.k !== 2 || o.s === 2 || o.id === t.by || Math.abs(o.x - x) > 12 || Math.abs(o.z - z) > 12) continue;
    if (shipBox(x, WATER_Y + 0.3, z, o.x, o.y, o.z, o.h)) return torpBoom(t, 2.4);
  }
}
function drawTorps() {
  if (!fish) return;
  for (const t of torps) {
    if (!t.on) { fish.setMatrixAt(t.i, HIDDEN); continue; }
    D.rotation.set(0, Math.atan2(t.hx, t.hz), 0); D.position.set(t.x, WATER_Y - 0.05, t.z); D.scale.setAll(1); fish.setMatrixAt(t.i, D.updateMatrix());
  }
  fish.update();
  D.rotation.set(0, 0, 0);
}

// every frame (main.ts): the shells and the torpedoes fly, the blasts swell and fade
export function updateShells(dt: number) {
  for (const s of shells) {
    if (!s.on) continue;
    if ((s.age += dt) > SHELL_LIFE) { s.on = false; continue; }
    const n = Math.max(1, Math.ceil(Math.hypot(s.vx, s.vy, s.vz) * dt)), h = dt / n;   // steps of about a unit: a tank is 2.3 wide
    for (let i = 0; i < n && s.on; i++) { s.vy -= SHELL_G * h; s.x += s.vx * h; s.y += s.vy * h; s.z += s.vz * h; shellStep(s); }
  }
  for (const t of torps) {
    if (!t.on) continue;
    const n = Math.max(1, Math.ceil(TORP_V * dt / 1.2)), d = TORP_V * dt / n;
    for (let i = 0; i < n && t.on; i++) { t.x += t.hx * d; t.z += t.hz * d; t.run += d; torpStep(t); }
    if (!t.on) continue;
    if (t.run >= TORP_RUN) { t.on = false; continue; }             // its run is over: it sinks
    torpWake(t.x, t.z, t.hx, t.hz);
  }
  drawShells(); drawTorps(); drawBlobs(dt);
}
export function clearShells() {
  for (const s of shells) s.on = false; for (const t of torps) t.on = false; for (const b of glows) b.on = false; for (const b of puffs) b.on = false;
  drawShells(); drawTorps(); drawBlobs(0);
}

// the meshes (main.ts calls this once, after the bullets): the shells as glowing slugs, the torpedoes as dark cigars awash, the blasts
export function buildShells() {
  const g = Bucket(); addGeo(g, boxGeo(0.26, 0.26, 1.3), null, 0xffffff);
  slugs = new Inst('shells', g, basic(0xffc86e, { fog: false }), SHELL_MAX, { receive: false });
  const f = Bucket(); addGeo(f, rotateX(cylGeo(0.3, 0.3, 3.2, 8), Math.PI / 2), null, 0xffffff);
  fish = new Inst('torpedoes', f, lambert(0x2b3130), TORP_MAX, { receive: false });
  const quad = Bucket(); addGeo(quad, planeGeo(2, 2), null, 0xffffff);
  const smokeTex = canvasTex(128, 128, g => {
    for (const [x, y, r, a] of [[64, 64, 60, 0.55], [48, 56, 34, 0.5], [80, 52, 30, 0.45], [60, 80, 32, 0.45], [78, 76, 26, 0.4]]) {
      const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, 'rgba(255,255,255,' + a + ')'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    }
  }, { alpha: true });
  glowI = new Inst('blastFire', quad, basic(0xffa040, { map: poolTex, transparent: true, additive: true, depthWrite: false, fog: false }), GLOW_N, { receive: false });
  puffI = new Inst('blastSmoke', quad, lambert(0x8a908f, { map: smokeTex, transparent: true, depthWrite: false }), PUFF_N, { receive: false });
  for (let i = 0; i < SHELL_MAX; i++) shells.push({ i, on: false, mine: false, by: 0, sid: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0 });
  for (let i = 0; i < TORP_MAX; i++) torps.push({ i, on: false, mine: false, by: 0, sid: 0, x: 0, z: 0, hx: 0, hz: 1, run: 0 });
  for (let i = 0; i < GLOW_N; i++) glows.push(newBlob());
  for (let i = 0; i < PUFF_N; i++) puffs.push(newBlob());
  drawShells(); drawTorps(); drawBlobs(0);
}
