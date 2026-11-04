// World of DODO, issue #16: the pedestrians, the same code on the client and the server. They walk the pavement loops round the blocks
// (map.ts's BLOCKS[i].ped, 1.4 inside the kerb, round the houses that stand on it), both ways round; a tank or a parcel knocks one
// over: they slide and tip away from the impact, lie there, and then walk again. The server (server/world.js) walks PED_N of them
// for everyone and sends where they are (message w); the client draws them (client/src/net/world.ts, which also lets one fall at once
// when its own tank hit them) and walks them itself only in the intro's own city (client/src/world/peds.ts).
//
// It replaces the walk round the invented grid's square blocks (a rounded square of the same size for every block, written in the
// client and as a port in server/world.js). Only erasable TypeScript, no DOM: Node loads this file as it is.
import { BLOCKS, freeAt } from './map.ts';
import { polylineAt, type At } from './geom.ts';

export const PED_N = 50;
// how long a knocked-down pedestrian stays down: in the shared city PED_DOWN_T (then gone, and walking again somewhere else, out of
// every tank's sight where possible: PED_RESPAWN_FAR); in the intro's own city a few seconds (then up again where they fell)
export const PED_DOWN_T = [8, 12], PED_RESPAWN_FAR = 60, PED_GETUP_T = [2.5, 4.5];
// the loops they walk: blocks whose loop is long enough to walk round (a tiny one would have them turning on the spot), biggest first
export const PED_LOOPS: number[] = BLOCKS.map((_b, i) => i).filter(i => BLOCKS[i].pedLen >= 30).sort((a, b) => BLOCKS[b].pedLen - BLOCKS[a].pedLen);
const LOOP_SUM = PED_LOOPS.reduce((a, i) => a + BLOCKS[i].pedLen, 0);

// a pedestrian: on loop b (a block index) at distance s along it, going dsg (1 or -1) at speed; state walk → fall → down → (rise →
// walk in the intro | respawn in the shared city); th the tilt, fx, fz the direction of the fall; ox, oz how far a hit shoved them off
// the loop, vx, vz the slide; h the heading; t the time in the state, timer how long they stay down
export interface SimPed {
  id: number; b: number; s: number; dsg: number; speed: number;
  state: string; t: number; th: number; fx: number; fz: number;
  ox: number; oz: number; vx: number; vz: number; h: number; x: number; z: number; timer: number;
}
const AT: At = { x: 0, z: 0, hx: 1, hz: 0, k: 0 };
// position and walking direction at distance s along the loop of block b
export function pedAt(b: number, s: number, out: At = AT): At { const B = BLOCKS[b]; return polylineAt(B.ped, B.pedCum, s, out); }
// a loop for pedestrian k: one each on the biggest loops for the first half of them, the rest by the loops' length
export function pedLoop(k: number, rnd: () => number): number {
  if (!PED_LOOPS.length) return 0;
  if (k < Math.min(PED_LOOPS.length, PED_N >> 1)) return PED_LOOPS[k];
  return randLoop(rnd);
}
function randLoop(rnd: () => number) {
  let r = rnd() * LOOP_SUM;
  for (const i of PED_LOOPS) { r -= BLOCKS[i].pedLen; if (r <= 0) return i; }
  return PED_LOOPS[PED_LOOPS.length - 1];
}
// where pedestrian p stands when walking (x, z, heading from b, s, dsg, plus the shove ox, oz fading out)
export function walkPlace(p: SimPed) {
  pedAt(p.b, p.s); p.h = Math.atan2(AT.hx * p.dsg, AT.hz * p.dsg); p.x = AT.x + p.ox; p.z = AT.z + p.oz;
}
export function newPed(k: number, rnd: () => number = Math.random): SimPed {
  const b = pedLoop(k, rnd);
  const p: SimPed = { id: k, b, s: rnd() * (BLOCKS[b]?.pedLen || 1), dsg: rnd() < 0.5 ? 1 : -1, speed: 1.0 + rnd() * 0.8,
    state: 'walk', t: 0, th: 0, fx: 0, fz: 1, ox: 0, oz: 0, vx: 0, vz: 0, h: 0, x: 0, z: 0, timer: 3 };
  walkPlace(p); return p;
}
// back on its loop, walking, somewhere along it
export function resetPed(p: SimPed, rnd: () => number = Math.random) {
  Object.assign(p, { state: 'walk', t: 0, th: 0, ox: 0, oz: 0, vx: 0, vz: 0, s: rnd() * (BLOCKS[p.b]?.pedLen || 1) });
  walkPlace(p);
}
export const pedEase = (t: number) => t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t);
// A hit sends a pedestrian sliding and tipping over away from the impact (vx, vz); down: how long they stay down. False if they were
// down already.
export function knockPed(p: SimPed, vx: number, vz: number, down: number): boolean {
  if (p.state !== 'walk') return false;
  const l = Math.hypot(vx, vz) || 1, sp = Math.min(8, l * 0.5);
  p.fx = vx / l; p.fz = vz / l; p.vx = p.fx * sp; p.vz = p.fz * sp; p.state = 'fall'; p.t = 0; p.th = 0.001; p.timer = down;
  return true;
}
// gone, and walking again on some loop, at least PED_RESPAWN_FAR from every tank where possible (the best of 12 tries)
export function respawnPed(p: SimPed, tanks: { x: number; z: number }[], rnd: () => number = Math.random) {
  let bb = p.b, bs = p.s, best = -1;
  for (let k = 0; k < 12; k++) {
    const b = randLoop(rnd), s = rnd() * BLOCKS[b].pedLen; pedAt(b, s);
    let d = 400; for (const t of tanks) d = Math.min(d, Math.hypot(t.x - AT.x, t.z - AT.z));
    if (d > best) { best = d; bb = b; bs = s; }
    if (d >= PED_RESPAWN_FAR) break;
  }
  Object.assign(p, { b: bb, s: bs, state: 'walk', t: 0, th: 0, ox: 0, oz: 0, vx: 0, vz: 0, dsg: rnd() < 0.5 ? 1 : -1 });
  walkPlace(p);
}
// One step of the pedestrians. getUp: the intro's own city (they get up where they fell) or the shared one (they respawn elsewhere);
// free: where a sliding pedestrian may go (the client adds its standing trees and lamps to map.ts's freeAt)
export function stepPeds(peds: SimPed[], dt: number, tanks: { x: number; z: number }[], getUp: boolean,
  rnd: () => number = Math.random, free: (x: number, z: number, m: number) => boolean = freeAt) {
  for (const p of peds) {
    if (p.state === 'walk') {
      p.s += p.dsg * p.speed * dt;
      const f = Math.exp(-3 * dt); p.ox *= f; p.oz *= f;
      walkPlace(p);
      continue;
    }
    p.t += dt;
    pedAt(p.b, p.s);
    const nx = p.ox + p.vx * dt, nz = p.oz + p.vz * dt;
    if (free(AT.x + nx, AT.z + nz, 0.3)) { p.ox = nx; p.oz = nz; } else p.vx = p.vz = 0;   // slides, but not into a building
    const d = Math.exp(-4 * dt); p.vx *= d; p.vz *= d; p.x = AT.x + p.ox; p.z = AT.z + p.oz;
    if (p.state === 'fall') { p.th = pedEase(p.t / 0.4) * 1.45; if (p.t >= 0.4) { p.state = 'down'; p.t = 0; } }
    else if (p.state === 'down') { if (p.t >= p.timer) { if (getUp) { p.state = 'rise'; p.t = 0; } else respawnPed(p, tanks, rnd); } }
    else if (p.state === 'rise') { p.th = 1.45 * (1 - pedEase(p.t / 0.7)); if (p.t >= 0.7) { p.state = 'walk'; p.th = 0; } }
  }
}
