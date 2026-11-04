// ---------- pedestrians: people walk loops along the pavement around the blocks; a parcel (or the tank) knocks them over, they get back up ----------
// Drawn as instanced meshes (coat colours, legs, heads, hair: ~8 draw calls for all of them; World of DODO: up to 18 with her parts). A hit
// sends a pedestrian sliding and tipping over away from the impact; after a few seconds on the ground they get up and walk on.
// World of DODO: the city dresses up. About half the pedestrians are women with an hourglass figure: long hair, a loud crop top over a
// bare waist, a short skirt or shorts, coloured tights, a big cartoon bust and bottom. The men wear a loud top and coloured trousers.
// (The original's people wore the DODO palette.) The looks come from their own seed (PED_RNG), so every player sees the same people in
// the same clothes; where they walk comes from the server (net/world.ts places them then; updatePeds walks them only in the intro's city).
import { Quaternion, Vector3 } from '@babylonjs/core';
import { Inst, boxGeo, sphereGeo, cylGeo, compose, type Geo } from '../core/geo';
import { lambert } from '../core/mat';
import { rng } from '../core/util';
import { blockC, free, groundH } from './grid';
import { car } from '../game/state';
import type { Ped } from '../game/types';
import { WORLD, netPed } from '../net/world';

// a pedestrian as this module keeps it: the shared fields (game/types.ts), the walk around its block, the fall and the looks
export interface Walker extends Ped {
  coat: number; ci: number;              // coat colour, and its index among the instances of that colour
  bx: number; bz: number;                // centre of the block it walks around
  s: number; dsg: number; speed: number; // distance along the loop, direction (1 or -1), walking speed
  t: number; timer: number;              // time in the current state, how long it stays down
  ox: number; oz: number; vx: number; vz: number;   // shoved off its loop by this much, sliding at this speed
  leg: number; hair: number; skirt: boolean; bottom: number; woman: boolean;   // World of DODO: who and what they wear
}

export const PED_N = 50;
export const PEDS: Walker[] = [];
const PED_COATS = [0xff2fa0, 0x9dff00, 0x8a2be2, 0xffc400, 0x00e5d4, 0xff6a00, 0xd400ff, 0x2fa8ff];
const PED_LEGS = [0xff2fa0, 0x2fa8ff, 0xffffff, 0x111111, 0xffc400, 0x9dff00, 0xd400ff, 0xd9b9a0, 0xd9b9a0],
  PED_HAIR = [0x2b2623, 0x6b4423, 0xe8c66a, 0xb5482a, 0x111111, 0xf2e7c9, 0xff6fb5],
  PED_BOTTOMS = [0x111111, 0x2fa8ff, 0xffffff, 0xff2fa0, 0x8a2be2, 0xffc400, 0x00e5d4], PED_RNG = rng(7717);
const PED_HW = 17.2, PED_RC = 3.0, PED_L = 2 * (PED_HW - PED_RC), PED_A = Math.PI / 2 * PED_RC, PED_SEG = PED_L + PED_A;   // pavement loop around a block: rounded square

// the instanced meshes, built in buildPeds (PCOAT: one per coat colour that someone wears, three instances each: top and two arms)
const PCOAT: (Inst | undefined)[] = [];
let PLEG: Inst, PHEAD: Inst, PHAIR: Inst, PBUST: Inst, PHAIRL: Inst, PSKIRT: Inst, PSHORT: Inst, PWAIST: Inst, PHIP: Inst, PBUTT: Inst;
// scratch for the matrices: plain arrays in three.js's layout (Babylon's Matrix.m is the same), doubles as three's Matrix4 kept them
const PM4: number[] = new Array(16).fill(0), PB4: number[] = new Array(16).fill(0), PMT: number[] = new Array(16).fill(0);
const PQh = new Quaternion(), PQf = new Quaternion(), PQx = new Quaternion(), PPos = new Vector3(), PScl = new Vector3();

// three's Quaternion.setFromAxisAngle: the axis as it is (Babylon's RotationAxis would normalise it in place)
function axisAngle(q: Quaternion, x: number, y: number, z: number, a: number) { const s = Math.sin(a / 2); q.set(x * s, y * s, z * s, Math.cos(a / 2)); return q; }
// three's Matrix4.premultiply: m = a·m, a applied after m (the same sums in the same order as three's multiplyMatrices)
function premultiply(m: number[], a: number[]) {
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) PMT[r + 4 * c] = a[r] * m[4 * c] + a[r + 4] * m[4 * c + 1] + a[r + 8] * m[4 * c + 2] + a[r + 12] * m[4 * c + 3];
  for (let i = 0; i < 16; i++) m[i] = PMT[i];
}

// position and walking direction at distance s along the loop around block (bx,bz) (counter-clockwise on screen)
function pedRing(bx: number, bz: number, s: number): [number, number, number, number] {
  const P = 4 * PED_SEG; s = ((s % P) + P) % P;
  const k = Math.floor(s / PED_SEG), u = s - k * PED_SEG, hw = PED_HW, rc = PED_RC, q = hw - rc;
  let x: number, z: number, dx: number, dz: number;
  if (u < PED_L) {
    if (k === 0) { x = hw; z = -q + u; dx = 0; dz = 1; } else if (k === 1) { x = q - u; z = hw; dx = -1; dz = 0; }
    else if (k === 2) { x = -hw; z = q - u; dx = 0; dz = -1; } else { x = -q + u; z = -hw; dx = 1; dz = 0; }
  } else {
    const ph = k * Math.PI / 2 + (u - PED_L) / rc, cx = (k === 0 || k === 3) ? q : -q, cz = (k === 0 || k === 1) ? q : -q;
    x = cx + rc * Math.cos(ph); z = cz + rc * Math.sin(ph); dx = -Math.sin(ph); dz = Math.cos(ph);
  }
  return [bx + x, bz + z, dx, dz];
}
// box/ball with its pivot at (lx,ly,lz), swung by rx about x, centre 'off' below/above the pivot; placed in the body's frame (PB4)
function pedPart(im: Inst, i: number, lx: number, ly: number, lz: number, sx: number, sy: number, sz: number, rx: number, off: number) {
  axisAngle(PQx, 1, 0, 0, rx); PPos.set(lx, ly + off * Math.cos(rx), lz + off * Math.sin(rx)); PScl.set(sx, sy, sz);
  compose(PPos, PQx, PScl, PM4); premultiply(PM4, PB4); im.setMatrixAt(i, PM4);
}
// the body's frame: heading h, then tipped by th about the horizontal axis across the fall direction (fx, fz)
export function placePed(ped: Ped) {
  const p = ped as Walker;
  axisAngle(PQh, 0, 1, 0, p.h);
  if (p.th > 0) { axisAngle(PQf, p.fz, 0, -p.fx, p.th); PQf.multiplyInPlace(PQh); } else PQf.copyFrom(PQh);
  PPos.set(p.x, groundH(p.x, p.z) + 0.2 * Math.sin(p.th), p.z); PScl.set(1, 1, 1); compose(PPos, PQf, PScl, PB4);
  const sw = p.state === 'walk' ? Math.sin(p.phase) * 0.6 : 0, aw = -sw * 0.8, co = PCOAT[p.coat]!, ci = p.ci * 3;
  const w = p.woman ? 1 : 0;                                              // World of DODO: what only the women wear is scaled to nothing on the men
  if (w) pedPart(co, ci, 0, 1.5, 0, 0.62, 0.42, 0.36, 0, 0);              // her crop top
  else pedPart(co, ci, 0, 1.29, 0, 0.66, 0.82, 0.36, 0, 0);               // his top down to the hips (the original's torso)
  pedPart(co, ci + 1, -0.44, 1.66, 0, 0.17, 0.9, 0.2, aw, -0.45);         // arms
  pedPart(co, ci + 2, 0.44, 1.66, 0, 0.17, 0.9, 0.2, -aw, -0.45);
  pedPart(PLEG, p.id * 2, -0.15, 0.86, 0, 0.25, 0.82, 0.27, sw, -0.41);   // legs
  pedPart(PLEG, p.id * 2 + 1, 0.15, 0.86, 0, 0.25, 0.82, 0.27, -sw, -0.41);
  pedPart(PHEAD, p.id, 0, 1.93, 0, 0.22, 0.22, 0.22, 0, 0);
  pedPart(PHAIR, p.id, 0, 1.99, -0.02, 0.235, 0.2, 0.235, 0, 0);
  pedPart(PBUST, p.id * 2, -0.15, 1.45, 0.21, 0.24 * w, 0.22 * w, 0.21 * w, 0, 0);   // her bust, waist, hips, bottom, long hair, skirt or shorts
  pedPart(PBUST, p.id * 2 + 1, 0.15, 1.45, 0.21, 0.24 * w, 0.22 * w, 0.21 * w, 0, 0);
  pedPart(PWAIST, p.id, 0, 1.13, 0, 0.44 * w, 0.36 * w, 0.27 * w, 0, 0);  // the bare waist, narrower than the shoulders and the hips
  pedPart(PHIP, p.id, 0, 0.94, 0, 0.64 * w, 0.2 * w, 0.36 * w, 0, 0);
  pedPart(PBUTT, p.id * 2, -0.14, 0.88, -0.17, 0.21 * w, 0.21 * w, 0.19 * w, 0, 0);
  pedPart(PBUTT, p.id * 2 + 1, 0.14, 0.88, -0.17, 0.21 * w, 0.21 * w, 0.19 * w, 0, 0);
  pedPart(PHAIRL, p.id, 0, 1.74, -0.13, 0.44 * w, 0.62 * w, 0.14 * w, 0, 0);
  const sk = p.skirt ? w : 0, sh = w - sk;                                // the one she does not wear (and he never does) is scaled to nothing
  pedPart(PSKIRT, p.id, 0, 0.8, 0, 0.46 * sk, 0.34 * sk, 0.38 * sk, 0, 0); // a short flared skirt
  pedPart(PSHORT, p.id * 2, -0.15, 0.86, 0, 0.28 * sh, 0.3 * sh, 0.3 * sh, sw, -0.14);
  pedPart(PSHORT, p.id * 2 + 1, 0.15, 0.86, 0, 0.28 * sh, 0.3 * sh, 0.3 * sh, -sw, -0.14);
}
// the placed matrices go to the GPU (three's instanceMatrix.needsUpdate; Inst.update also sends the colours, set once in buildPeds)
export function pedDirty() {
  PCOAT.forEach(m => { if (m) m.update(); });
  for (const m of [PLEG, PHEAD, PHAIR, PBUST, PHAIRL, PSKIRT, PSHORT, PWAIST, PHIP, PBUTT]) m.update();
}
export function knockPed(ped: Ped, vx: number, vz: number) {
  const p = ped as Walker; if (p.state !== 'walk') return;
  const l = Math.hypot(vx, vz) || 1, sp = Math.min(8, l * 0.5);
  p.fx = vx / l; p.fz = vz / l; p.vx = p.fx * sp; p.vz = p.fz * sp; p.state = 'fall'; p.t = 0; p.th = 0.001; p.timer = 2.5 + Math.random() * 2;
}
export const pedEase = (t: number) => t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t);
// the intro's local city: walking, falling, lying, getting up (in the game net/world.ts places them from the server's rows)
export function updatePeds(dt: number) {
  for (const p of PEDS) {
    if (p.state === 'walk') {
      p.s += p.dsg * p.speed * dt; p.phase += p.speed * dt * 3.2;
      const r = pedRing(p.bx, p.bz, p.s); p.h = Math.atan2(r[2] * p.dsg, r[3] * p.dsg);
      const f = Math.exp(-3 * dt); p.ox *= f; p.oz *= f; p.x = r[0] + p.ox; p.z = r[1] + p.oz;
    } else {
      p.t += dt;
      const nx = p.ox + p.vx * dt, nz = p.oz + p.vz * dt, r = pedRing(p.bx, p.bz, p.s);
      if (free(r[0] + nx, r[1] + nz, 0.3)) { p.ox = nx; p.oz = nz; } else p.vx = p.vz = 0;   // slides, but not into a building
      const d = Math.exp(-4 * dt); p.vx *= d; p.vz *= d; p.x = r[0] + p.ox; p.z = r[1] + p.oz;
      if (p.state === 'fall') { p.th = pedEase(p.t / 0.4) * 1.45; if (p.t >= 0.4) { p.state = 'down'; p.t = 0; } }
      else if (p.state === 'down') { if (p.t >= p.timer) { p.state = 'rise'; p.t = 0; } }
      else if (p.state === 'rise') { p.th = 1.45 * (1 - pedEase(p.t / 0.7)); if (p.t >= 0.7) { p.state = 'walk'; p.th = 0; } }
    }
    placePed(p);
  }
  pedDirty();
}
export function resetPeds() {
  PEDS.forEach(p => {
    p.state = 'walk'; p.th = 0; p.t = 0; p.ox = p.oz = p.vx = p.vz = 0; p.s = Math.random() * 4 * PED_SEG;
    const r = pedRing(p.bx, p.bz, p.s); p.x = r[0]; p.z = r[1]; p.h = Math.atan2(r[2] * p.dsg, r[3] * p.dsg); placePed(p);
  });
  pedDirty();
}
// the player's tank walks into people on the pavement: they get shoved and fall over
export function hitPeds() {
  if (Math.abs(car.v) < 0.8) return; const fx = Math.sin(car.h), fz = Math.cos(car.h), sg = car.v > 0 ? 1 : -1;
  for (const p of PEDS) {
    if (p.state !== 'walk' || Math.abs(p.x - car.x) > 5 || Math.abs(p.z - car.z) > 5) continue;
    for (const j of [-1.55, 1.55]) {
      if (Math.hypot(p.x - (car.x + fx * j), p.z - (car.z + fz * j)) >= 1.4) continue;
      const dx = p.x - car.x, dz = p.z - car.z, l = Math.hypot(dx, dz) || 1, sp = Math.abs(car.v);
      const kx = (fx * sg * 0.6 + dx / l * 0.8) * sp + 0.01, kz = (fz * sg * 0.6 + dz / l * 0.8) * sp;
      if (WORLD.on) netPed(p, kx, kz); else knockPed(p, kx, kz);   // World of DODO: the server knocks shared pedestrians; no police (wantedHit)
      car.v *= 0.97; break;
    }
  }
}

// who walks where and what they wear, then the meshes (main.ts calls this once, after the shots)
export function buildPeds() {
  const cnt = PED_COATS.map(() => 0);
  for (let k = 0; k < PED_N; k++) {
    // one person per block for the first 36, the rest anywhere; PED_RNG draws coat, leg, hair, skirt, bottom, woman in this order
    const i = (k < 36 ? k % 6 : (Math.random() * 6) | 0), j = (k < 36 ? (k / 6) | 0 : (Math.random() * 6) | 0), coat = (PED_RNG() * PED_COATS.length) | 0;
    PEDS.push({
      id: k, coat, ci: cnt[coat]++, bx: blockC(i), bz: blockC(j), s: 0, dsg: Math.random() < 0.5 ? 1 : -1, speed: 1.0 + Math.random() * 0.8, phase: Math.random() * 6,
      state: 'walk', t: 0, th: 0, fx: 0, fz: 1, ox: 0, oz: 0, vx: 0, vz: 0, h: 0, x: 0, z: 0, timer: 3,
      pred: null,                                                         // knocked over here, ahead of the server (net/world.ts)
      leg: (PED_RNG() * PED_LEGS.length) | 0, hair: (PED_RNG() * PED_HAIR.length) | 0, skirt: PED_RNG() < 0.5, bottom: (PED_RNG() * PED_BOTTOMS.length) | 0, woman: PED_RNG() < 0.5,
    });   // World of DODO: who and what they wear
  }
  // cast shadows, receive none (three's default for the original's InstancedMesh); never culled (Inst)
  const box = boxGeo(1, 1, 1), ball = sphereGeo(1, 10, 8), cyl = cylGeo(0.75, 1, 1, 12),
    mk = (name: string, g: Geo, color: number, n: number, colors = false) => new Inst(name, g, lambert(color), n, { colors, cast: true, receive: false });
  PED_COATS.forEach((col, c) => { if (cnt[c]) PCOAT[c] = mk('pedCoat' + c, box, col, cnt[c] * 3); });
  PLEG = mk('pedLeg', box, 0xffffff, PED_N * 2, true); PHEAD = mk('pedHead', ball, 0xd9b9a0, PED_N); PHAIR = mk('pedHair', ball, 0xffffff, PED_N, true);
  PBUST = mk('pedBust', ball, 0xffffff, PED_N * 2, true); PHAIRL = mk('pedHairLong', box, 0xffffff, PED_N, true);
  PSKIRT = mk('pedSkirt', cyl, 0xffffff, PED_N, true); PSHORT = mk('pedShorts', box, 0xffffff, PED_N * 2, true);   // white materials: the colour comes per instance
  PWAIST = mk('pedWaist', box, 0xd9b9a0, PED_N); PHIP = mk('pedHip', box, 0xffffff, PED_N, true); PBUTT = mk('pedButt', ball, 0xffffff, PED_N * 2, true);
  for (const p of PEDS) {
    let c = p.woman ? PED_LEGS[p.leg] : PED_BOTTOMS[p.bottom]; PLEG.setColorAt(p.id * 2, c); PLEG.setColorAt(p.id * 2 + 1, c);   // her tights, his trousers
    c = PED_COATS[p.coat]; PBUST.setColorAt(p.id * 2, c); PBUST.setColorAt(p.id * 2 + 1, c);
    c = PED_HAIR[p.hair]; PHAIR.setColorAt(p.id, c); PHAIRL.setColorAt(p.id, c);
    c = PED_BOTTOMS[p.bottom]; PSKIRT.setColorAt(p.id, c); PSHORT.setColorAt(p.id * 2, c); PSHORT.setColorAt(p.id * 2 + 1, c);
    PHIP.setColorAt(p.id, c); PBUTT.setColorAt(p.id * 2, c); PBUTT.setColorAt(p.id * 2 + 1, c);
  }
  resetPeds();
}
