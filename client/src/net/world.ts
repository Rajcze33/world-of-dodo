// ---------- WORLD OF DODO: the shared city ----------
// Once you play, the cars, the tram and the pedestrians come from the server (server/world.js), which moves them for everyone; this
// browser draws them like the other tanks, INTERP ms behind the server's clock (the pedestrians, sent half as often, PED_INTERP).
// A car your tank (or a car you pushed) runs into becomes yours, as the original let the van shove the traffic about: this browser
// moves it with the original body physics, reports it with every state of your tank, and lets go of it once it has come to rest;
// the server then puts it back into the traffic (a parked car stays where it ended up). A car someone else is pushing is theirs
// (snapshot field k): for you it is solid and does not give way until they let go. A pedestrian your tank or your own parcel hits
// falls here at once and is reported; the server knocks them over for everyone (if it does not, because someone else was first,
// they stand up again here). A tree or a lamp you knock down falls here at once and is passed on to the others. Before you join,
// the intro shows the browser's own city as before.
// World of DODO, issue #16: the server moves the city with the same code the intro runs here (client/shared/traffic.ts, tram.ts,
// peds.ts), so the rows are the same N_CARS cars, the same tram track and the same PED_N pedestrians as this browser's.
import { lerp, angLerp, now, r2 } from '../core/util';
import { groundH } from '../../shared/map.ts';
import type { Car, Ped, Prop } from '../game/types';
import { TRAFFIC, N_CARS, PARKED, TRAM, TRAM_PATH, placeTram, updateDyn, towHome, placeParked, resetParked } from '../world/traffic';
import { PEDS, placePed, pedDirty, pedEase } from '../world/peds';
import { PROPS, FALLING } from '../world/props';
import { NET, INTERP, PED_INTERP, clockSample, serverNow, pushRow, bodyAt, netSend, spinWheels } from './net';

export { PED_INTERP };                                 // defined next to INTERP in net.ts: INTERP + 50, the pedestrians come every other tick
// the pedestrians of one 'w' message: the moment it shows, the tick, x, z, heading, tilt, fall direction for each (flat)
export interface PedRows { t: number; n: number; p: number[] }
export const WORLD = { on: false, buf: [] as PedRows[] };
// what the server shares: the moving cars, then the parked cars; index i in its messages (c.ni). Filled by buildNet().
export const BODIES: Car[] = [];
// The original filled BODIES as the page loaded; here the cars exist only once buildTraffic() has run, so this fills it then.
// main.ts may call it after buildTraffic(); the first welcome (worldClear) does it otherwise. Safe to call again.
export function buildNet() {
  if (BODIES.length) return;
  BODIES.push(...TRAFFIC.slice(0, N_CARS), ...PARKED);
  BODIES.forEach((c, i) => { c.ni = i; c.nb = []; });
  TRAM.nb = [];                                      // the tram's rows: its place along the track in x
}
export function worldClear() {
  buildNet();
  WORLD.buf.length = 0; TRAM.nb.length = 0;
  BODIES.forEach(c => { c.nb.length = 0; c.net = 0; if (c.mine) dropBody(c); }); resetParked();
}
// pedestrians, every other snapshot: kept whole, by the moment they show
export function worldMsg(m: any) {
  clockSample(m.ts);
  const b = WORLD.buf; if (b.length && m.ts <= b[b.length - 1].t) return;
  b.push({ t: m.ts, n: m.n, p: m.p }); if (b.length > 40) b.shift();
}
// the cars and the tram of a tank snapshot: a row for every car (a pushed one at the moment its owner reported it) and whose it is
export function worldSnap(m: any) {
  if (!m.c) return;
  const own = new Map<number, number[]>(), rest = new Map<number, number[]>();
  for (const k of m.k || []) own.set(k[0], k);
  for (const q of m.q || []) rest.set(q[0], q);
  for (const c of BODIES) {
    const i = c.ni, k = own.get(i); netOwner(c, k ? k[1] : 0);
    if (k) pushRow(c.nb, { t: k[2], x: k[3], z: k[4], h: k[5], v: k[6] });
    else if (i < N_CARS) { const j = i * 4; pushRow(c.nb, { t: m.ts, x: m.c[j], z: m.c[j + 1], h: m.c[j + 2], v: m.c[j + 3] }); }
    else {
      const q = rest.get(i); if (q) pushRow(c.nb, { t: m.ts, x: q[1], z: q[2], h: q[3], v: 0 });
      else if (c.nb.length && !c.mine) { c.nb.length = 0; c.tow = true; }                    // a parked car that is not out of its spot any more: towed home
    }
  }
  pushRow(TRAM.nb, { t: m.ts, x: m.m, z: 0, h: 0, v: 0 });
}
// whose the car is: c.net = the id of another player pushing it (0: nobody else). A car this tank claimed and the server did not give
// it (someone else was first, or it was refused) is given up after a moment, and from then on drawn from the server again.
export function netOwner(c: Car, o: number) {
  c.net = o && o !== NET.id ? o : 0;
  if (!c.mine) return;
  if (o === NET.id) c.ackAt = now(); else if (c.net || now() - (c.ackAt || c.claimAt)! > 1500) dropBody(c);
}
export function dropBody(c: Car) { c.dyn = false; c.mine = false; c.rel = false; c.calm = 0; if (c.parked && !c.nb.length) towHome(c); }   // a parked car the server never had out of its spot goes back to it
// let go of a car that has come to rest: the next state of the tank tells the server, which puts it back into the traffic
export function letGo(c: Car) { c.dyn = false; c.mine = false; c.rel = true; c.calm = 0; }
// the city at server time t, from the rows this browser holds (tools/browser-test.js compares two players with it), or null
export function worldAt(t: number): { cars: number[][]; peds: number[][] } | null {
  const b = WORLD.buf; let peds: number[][] | null = null;
  for (let i = 0; i + 1 < b.length; i++) {
    const a = b[i], n = b[i + 1]; if (a.t > t || n.t < t) continue;
    const k = (t - a.t) / ((n.t - a.t) || 1);
    peds = PEDS.map((_p, q) => [lerp(a.p[q * 5], n.p[q * 5], k), lerp(a.p[q * 5 + 1], n.p[q * 5 + 1], k)]); break;
  }
  if (!peds) return null;
  const cars: number[][] = [];
  for (let i = 0; i < N_CARS; i++) {
    const nb = TRAFFIC[i].nb; if (!nb.length || nb[0].t > t || nb[nb.length - 1].t < t) return null;
    const s = bodyAt(nb, t, 4)!; cars.push([s.x, s.z]);
  }
  return { cars, peds };
}
// your tank or your own parcel knocked pedestrian p over: they fall here at once, as the server will make them fall for everyone
export function predictPed(p: Ped, vx: number, vz: number) {
  if (p.pred || p.state !== 'walk') return;
  const l = Math.hypot(vx, vz) || 1; p.pred = { t: now(), x: p.x, z: p.z, fx: vx / l, fz: vz / l, sp: Math.min(8, l * 0.5) };
}
export function netPed(p: Ped, vx: number, vz: number) {
  predictPed(p, vx, vz);
  const t = now(); if (t - (p.sentAt || 0) < 600) return;
  p.sentAt = t; netSend({ t: 'ped', i: p.id, vx: r2(vx), vz: r2(vz) });
}
export function netProp(p: Prop) { if (WORLD.on) netSend({ t: 'prop', i: p.i, fx: r2(p.fx), fz: r2(p.fz) }); }
// another player's tank knocked a prop down (it falls the way they saw it fall), or it stands up again after a while
export function propMsg(m: any) {
  const p = PROPS[m.i]; if (!p) return;
  if (m.up) { const k = FALLING.indexOf(p); if (k >= 0) FALLING.splice(k, 1); p.state = 'up'; p.th = 0; p.w = 0; p.bounced = false; p.apply(p); }
  else if (p.state === 'up') { p.fx = m.fx; p.fz = m.fz; p.state = 'fall'; p.th = 0.001; p.w = p.w0; p.bounced = false; FALLING.push(p); }
}
// props that were down already when you joined
export function propsDown(list: [number, number, number][] | undefined) {
  for (const [i, fx, fz] of list || []) { const p = PROPS[i]; if (!p) continue; p.fx = fx; p.fz = fz; p.state = 'down'; p.th = p.th0; p.apply(p); }
}
// every frame once you play (main.ts; before, the intro's own city moves): the shared city INTERP ms behind the server's clock.
// World of DODO (this port): the original first drove REDLINE's parked tanks here (updateScript); they are gone, so tnow is unused.
export function worldUpdate(dt: number, _tnow: number) {
  if (NET.off === null) return;
  const R = serverNow() - INTERP;
  // the cars (and the parked cars out of their spot): yours run the original physics until they rest, the others come from their rows
  for (const c of BODIES) {
    if (c.mine && c.dyn) { updateDyn(c, dt); continue; }
    if (c.parked) { if (c.tow) { c.tow = false; towHome(c); } if (!c.nb.length) continue; }
    const s = bodyAt(c.nb, R, 4); if (!s) continue;                                                    // 4: a car turning back changes lane, no sliding across
    if (c.parked) { if (s.x !== c.x || s.z !== c.z || s.h !== c.ang) { c.x = s.x; c.z = s.z; c.ang = s.h; c.hx = Math.sin(s.h); c.hz = Math.cos(s.h); c.moved = true; placeParked(c); } continue; }
    c.x = s.x; c.z = s.z; c.ang = s.h; c.hx = Math.sin(s.h); c.hz = Math.cos(s.h); c.v = s.v; c.gy = (c.gy || 0) + (groundH(c.x, c.z) - (c.gy || 0)) * Math.min(1, dt * 12);
    const g = c.g!; g.position.set(c.x, c.gy, c.z); g.rotation.y = s.h; spinWheels(g, c.v * dt / 0.34);
  }
  // the tram: its place along the track, which wraps around at the end of the loop
  const tb = TRAM.nb;
  if (tb.length) {
    const Lp = TRAM_PATH.len; let i = tb.length - 1; while (i > 0 && tb[i].t > R) i--;
    const a = tb[i], b = tb[i + 1]; let ts = a.x;
    if (b && R > a.t) { let ds = b.x - a.x; if (ds < -Lp / 2) ds += Lp; else if (ds > Lp / 2) ds -= Lp; ts = a.x + ds * (R - a.t) / (b.t - a.t); }
    TRAM.s = ((ts % Lp) + Lp) % Lp; placeTram();
  }
  // pedestrians as x, z, heading, tilt, fall direction
  const b = WORLD.buf; if (!b.length) return;
  const Rp = serverNow() - PED_INTERP; let i = b.length - 1; while (i > 0 && b[i].t > Rp) i--;
  const a = b[i], n = b[i + 1] || a, k = n.t > a.t ? Math.max(0, Math.min(1, (Rp - a.t) / (n.t - a.t))) : 1, tn = now();
  if (a.p.length < PEDS.length * 5) return;
  for (let q = 0; q < PEDS.length; q++) {
    const p = PEDS[q], j = q * 5, jump = Math.hypot(n.p[j] - a.p[j], n.p[j + 1] - a.p[j + 1]) > 6, kk = jump ? (k < 0.5 ? 0 : 1) : k;   // jump: gone, and back elsewhere
    const x = lerp(a.p[j], n.p[j], kk), z = lerp(a.p[j + 1], n.p[j + 1], kk), th = lerp(a.p[j + 3], n.p[j + 3], kk);
    if (p.pred) {
      const d = p.pred, e = (tn - d.t) / 1000;                                                     // knocked over here: falling ahead of the server
      if (th >= 1.4 || (e > 1.5 && th < 0.01) || e > 4) p.pred = null;                             // the server's fall has caught up (or never came)
      else { const o = d.sp * (1 - Math.exp(-4 * e)) / 4; p.x = d.x + d.fx * o; p.z = d.z + d.fz * o; p.th = Math.max(th, pedEase(e / 0.4) * 1.45); p.fx = d.fx; p.fz = d.fz; p.state = 'down'; placePed(p); continue; }
    }
    const dd = Math.hypot(x - p.x, z - p.z);
    if (dd < 3) p.phase += dd * 3.2;
    p.x = x; p.z = z; p.h = angLerp(a.p[j + 2], n.p[j + 2], kk); p.th = th;
    const fa = (kk < 0.5 ? a : n).p[j + 4]; p.fx = Math.sin(fa); p.fz = Math.cos(fa); p.state = p.th > 0.001 ? 'down' : 'walk'; placePed(p);
  }
  pedDirty();
}
