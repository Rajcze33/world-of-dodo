// World of DODO, issue #16: the tram, the same code on the client and the server. Three cars run round TRAM_LOOP (map.ts: along
// Sokolovská from the arena's west edge to its east edge and back, with a turning loop just outside the arena at each end), stop at
// the real stops (Karlínské náměstí and Křižíkova, each direction its own), wait for anything on the track in front of them and give
// way to the tanks early. The server (server/world.js) runs the tram for everyone and sends only its place along the track (snapshot
// field m); the client draws it there (client/src/net/world.ts) and runs it itself only in the intro's own city (world/traffic.ts).
//
// It replaces the tram of the invented grid (a straight avenue with balloon loops made up in the code, three.js's curve on the server
// and its port on the client): the track now comes from the data and both sides build it with the same code (catmull.ts).
// Only erasable TypeScript, no DOM: Node loads this file as it is.
import { EDGES, TRAM_LOOP, ARENA, edgePos, inArena, type REdge } from './map.ts';
import { polylineAt, polylineCum, distSeg2 } from './geom.ts';
import { CatmullRomCurve3 } from './catmull.ts';

type V2 = [number, number];
export const TRAM_L = 8.6, TRAM_W = 2.4, TRAM_GAP = 0.7, TRAM_VMAX = 8, TRAM_N = 3;
const TRAIN = TRAM_N * TRAM_L + (TRAM_N - 1) * TRAM_GAP;               // the whole train, front to back

// ---------- the track ----------
// TRAM_LOOP sampled every 3 units. In the data the tracks run 2.2 from Sokolovská's centre line, but its carriageway is only 4.7 to
// 5.3 wide there (the generator narrows streets to leave a pavement in front of the houses), so a tram 2.4 wide would ride half on
// the pavement: inside the arena the track is pulled in until the tram stays on the carriageway (blending over 25 units from the
// arena's edge into the loops outside, which stay as they are). Then a closed centripetal Catmull-Rom curve through the samples,
// TRAM_PATH.N points evenly spaced along its length (about one a unit), as the original kept its track.
export const TRAM_PATH: { pts: V2[]; N: number; len: number } = { pts: [], N: 0, len: 0 };
// TRAM_STOPS: where the tram's front is when the train stands centred on stop i (in the order of TRAM_LOOP.stops);
// TRAM_STOP_AT: the stop itself on the track, with the direction the tram runs there (for the shelters)
export const TRAM_STOPS: number[] = [];
export const TRAM_STOP_AT: { x: number; z: number; hx: number; hz: number }[] = [];
{
  const L = TRAM_LOOP, TE = EDGES.filter(e => e.tram), at = { x: 0, z: 0, hx: 1, hz: 0, k: 0 }, smp: V2[] = [];
  // the nearest point of a tram street's centre line: the edge, s along it, the signed offset (+ right of a→b), the distance
  const near = (x: number, z: number) => {
    let be: REdge | null = null, bd = Infinity, bs = 0, bo = 0;
    for (const e of TE) for (let k = 0; k + 1 < e.pts.length; k++) {
      const [ax, az] = e.pts[k], [bx, bz] = e.pts[k + 1], d = distSeg2(x, z, ax, az, bx, bz);
      if (d >= bd) continue;
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz, t = l2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
      bd = d; be = e; bs = e.cum[k] + t * Math.sqrt(l2); bo = (dx * (z - az) - dz * (x - ax) >= 0 ? 1 : -1) * Math.sqrt(d);
    }
    return { e: be, s: bs, off: bo, d: Math.sqrt(bd) };
  };
  if (L.len > 0) {
    const n = Math.max(8, Math.round(L.len / 3));
    for (let i = 0; i < n; i++) {
      polylineAt(L.pts, L.cum, i * L.len / n, at); let x = at.x, z = at.z;
      const depth = Math.min(x - ARENA.x0, ARENA.x1 - x, z - ARENA.z0, ARENA.z1 - z);
      if (depth > 0 && inArena(x, z) && TE.length) {
        const q = near(x, z);
        if (q.e && q.d < 6) {
          const max = Math.max(0.6, q.e.w / 2 - TRAM_W / 2 - 0.05), want = Math.sign(q.off) * Math.min(Math.abs(q.off), max), b = Math.min(1, depth / 25);
          const p = edgePos(q.e, q.s, q.off + (want - q.off) * b); x = p.x; z = p.z;
        }
      }
      smp.push([x, z]);
    }
    const curve = new CatmullRomCurve3(smp.map(p => ({ x: p[0], y: 0, z: p[1] })), true, 'centripetal');
    curve.arcLengthDivisions = smp.length * 8;                       // fine enough for so many control points (three's default is 200)
    const len = curve.getLength(), N = Math.max(16, Math.round(len)), pts = curve.getSpacedPoints(N).map(v => [v.x, v.z] as V2);
    pts.pop();
    TRAM_PATH.pts.push(...pts); TRAM_PATH.N = pts.length; TRAM_PATH.len = len;
    // the stops: the point of the new track nearest to the data's stop, running the same way
    for (const s0 of L.stops) {
      polylineAt(L.pts, L.cum, s0, at);
      let bi = 0, bd = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], q = pts[(i + 1) % pts.length], dx = q[0] - p[0], dz = q[1] - p[1];
        if (dx * at.hx + dz * at.hz <= 0) continue;
        const d = (p[0] - at.x) * (p[0] - at.x) + (p[1] - at.z) * (p[1] - at.z); if (d < bd) { bd = d; bi = i; }
      }
      const s = bi / TRAM_PATH.N * len, p = tramAt(s), r = tramAt(s - 1), l = Math.hypot(p[0] - r[0], p[1] - r[1]) || 1;
      TRAM_STOPS.push(s + TRAIN / 2);
      TRAM_STOP_AT.push({ x: p[0], z: p[1], hx: (p[0] - r[0]) / l, hz: (p[1] - r[1]) / l });
    }
  }
}
// the point at distance s along the track (it wraps round)
export function tramAt(s: number, out?: V2): V2 {
  const o = out || [0, 0], P = TRAM_PATH, L = P.len; if (!P.N) { o[0] = o[1] = 0; return o; }
  s = ((s % L) + L) % L;
  const f = s / L * P.N, i = Math.floor(f), t = f - i, a = P.pts[i % P.N], b = P.pts[(i + 1) % P.N];
  o[0] = a[0] + (b[0] - a[0]) * t; o[1] = a[1] + (b[1] - a[1]) * t; return o;
}
// the track as a polyline with its lengths, for whoever draws the rails (world/traffic.ts)
export const TRAM_CUM = polylineCum(TRAM_PATH.pts, true);

// ---------- the tram ----------
// s: its front's distance along the track; v: speed; hold: waits after a tank bumped it (the client's tank sets it); dwell/atStop: at a
// stop; yieldT: giving way to a tank; vag: the three cars (centre, heading); pts: points along the cars (who is near the tram)
export interface TramCar { x: number; z: number; hx: number; hz: number }
export interface Tram { s: number; v: number; hold: number; dwell: number; atStop: number; yieldT: number; vag: TramCar[]; pts: V2[] }
// a tank as the city sees it: where it is, its heading (direction sin h, cos h) and speed
export interface Tank { x: number; z: number; h: number; v: number }
// anything the tram waits for on its track: a car of the traffic or a parked car out of its spot
export interface Mover { x: number; z: number; hx: number; hz: number }

export function newTram(): Tram {
  const T: Tram = { s: 0, v: TRAM_VMAX, hold: 0, dwell: 0, atStop: -1, yieldT: 0, vag: [], pts: [] };
  for (let k = 0; k < TRAM_N; k++) T.vag.push({ x: 0, z: 0, hx: 0, hz: 1 });
  placeTram(T); return T;
}
// the cars where the front's place s puts them (written into T.vag in place: the client's cars carry their meshes there too)
const F: V2 = [0, 0], B: V2 = [0, 0];
export function placeTram(T: Tram) {
  T.pts.length = 0;
  for (let k = 0; k < T.vag.length; k++) {
    const v = T.vag[k], c = T.s - k * (TRAM_L + TRAM_GAP) - TRAM_L / 2;
    tramAt(c + TRAM_L * 0.35, F); tramAt(c - TRAM_L * 0.35, B);
    const dx = F[0] - B[0], dz = F[1] - B[1], l = Math.hypot(dx, dz) || 1;
    v.x = (F[0] + B[0]) / 2; v.z = (F[1] + B[1]) / 2; v.hx = dx / l; v.hz = dz / l;
    for (const a of [-0.5, 0, 0.5]) T.pts.push([v.x + v.hx * TRAM_L * a, v.z + v.hz * TRAM_L * a]);
  }
}
export function seedTram(T: Tram, s: number) { T.s = ((s % TRAM_PATH.len) + TRAM_PATH.len) % TRAM_PATH.len; T.yieldT = 0; T.v = TRAM_VMAX; T.hold = 0; T.dwell = 0; T.atStop = -1; placeTram(T); }
export const tramNear = (T: Tram, x: number, z: number, r: number) => T.pts.some(p => Math.abs(p[0] - x) < r && Math.abs(p[1] - z) < r);

// Will this vehicle (following its route at speed sp: pos(du) is where it is du further on, as [x, z, hx, hz]; offs: points along it)
// and any tank (on its heading and speed) meet within T seconds? If so, the vehicle gives way: tanks always have right of way.
// A tank following right behind it in the same direction is left alone. (The original's vanConflict, for every tank.)
export function tankConflict(pos: (du: number) => number[], sp: number, offs: number[], T: number, R: number, tanks: Tank[]): boolean {
  const p0 = pos(0), near: { x: number; z: number; vx: number; vz: number; fx: number; fz: number }[] = [];
  for (const k of tanks) {
    if (Math.abs(k.x - p0[0]) > 80 || Math.abs(k.z - p0[1]) > 80) continue;
    const vhx = Math.sin(k.h), vhz = Math.cos(k.h);
    if ((k.x - p0[0]) * p0[2] + (k.z - p0[1]) * p0[3] < -1.5 && vhx * p0[2] + vhz * p0[3] > 0.7) continue;
    near.push({ x: k.x, z: k.z, vx: vhx * k.v, vz: vhz * k.v, fx: vhx * 1.55, fz: vhz * 1.55 });
  }
  if (!near.length) return false;
  for (let t = 0; t <= T; t += 0.2) {
    const q = pos(sp * t);
    for (const k of near) {
      const px = k.x + k.vx * t, pz = k.z + k.vz * t;
      for (const a of offs) for (let b = -1; b <= 1; b++) if (Math.hypot(q[0] + q[2] * a - px - k.fx * b, q[1] + q[3] * a - pz - k.fz * b) < R) return true;
    }
  }
  return false;
}

// One step of the tram: wait for anything on the track in front (a tank, a car), give way to the tanks early, stop at the stops.
// cars: the traffic and the parked cars out of their spots.
export function stepTram(T: Tram, dt: number, tanks: Tank[], cars: readonly Mover[]) {
  if (!TRAM_PATH.N) return;
  let target = TRAM_VMAX;
  const f = T.vag[0], fx = f.x + f.hx * TRAM_L / 2, fz = f.z + f.hz * TRAM_L / 2;
  // in the strip in front of the train: forward 0..11, sideways ±l. World of DODO, issue #16: ±2.0 for cars (was 2.5): the lanes are
  // narrow in Karlín, and a car passing the other way on a 4.7 street is 2.3 from the tram's middle
  const inFront = (x: number, z: number, l: number) => { const wx = x - fx, wz = z - fz, a = wx * f.hx + wz * f.hz; return a > -1 && a < 11 && Math.abs(wx * f.hz - wz * f.hx) < l; };
  for (const k of tanks) {
    const vx = Math.sin(k.h) * 1.55, vz = Math.cos(k.h) * 1.55;
    if (inFront(k.x, k.z, 2.5) || inFront(k.x + vx, k.z + vz, 2.5) || inFront(k.x - vx, k.z - vz, 2.5)) target = 0;
  }
  {
    const a: V2 = [0, 0], b: V2 = [0, 0];
    const pos = (ds: number) => { tramAt(T.s + ds, a); tramAt(T.s + ds - 1, b); const dx = a[0] - b[0], dz = a[1] - b[1], l = Math.hypot(dx, dz) || 1; return [a[0], a[1], dx / l, dz / l]; };
    const O = [0, -TRAM_L * 0.25, -TRAM_L / 2];
    if (tankConflict(pos, TRAM_VMAX, O, 3.5, 2.9, tanks) || tankConflict(pos, Math.max(T.v, 2), O, 3.5, 2.9, tanks)) T.yieldT = 0.8;
  }
  if (T.yieldT > 0) { T.yieldT -= dt; target = 0; }
  for (const c of cars) {
    if (Math.abs(c.x - fx) > 14 || Math.abs(c.z - fz) > 14) continue;
    if (inFront(c.x, c.z, 2.0) || inFront(c.x + c.hx * 1.9, c.z + c.hz * 1.9, 2.0) || inFront(c.x - c.hx * 1.9, c.z - c.hz * 1.9, 2.0)) target = 0;
  }
  if (T.hold > 0) { T.hold -= dt; target = 0; }
  // stop at the stops
  const Lp = TRAM_PATH.len;
  if (T.dwell > 0) { T.dwell -= dt; target = 0; }
  else TRAM_STOPS.forEach((S, i) => {
    const ds = ((S - T.s) % Lp + Lp) % Lp;
    if (ds < 40 && T.atStop !== i) { target = Math.min(target, Math.sqrt(2 * 2.2 * ds) + 0.3); if (ds < 0.4) { T.dwell = 6; T.atStop = i; } }
  });
  T.v += Math.max(-(T.yieldT > 0 ? 14 : 10) * dt, Math.min(2.5 * dt, target - T.v)); if (T.v < 0) T.v = 0;
  T.s = (T.s + T.v * dt) % Lp;
  if (T.atStop >= 0 && T.dwell <= 0) { const ds = ((T.s - TRAM_STOPS[T.atStop]) % Lp + Lp) % Lp; if (ds > 5 && ds < Lp - 50) T.atStop = -1; }
  placeTram(T);
}
