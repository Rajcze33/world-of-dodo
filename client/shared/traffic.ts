// World of DODO, issue #16: the traffic on the real streets of Karlín, the same code on the client and the server. The cars drive on
// the right of the street graph's edges (map.ts), cross the junctions on a curve from their lane into the next one, give way at the
// junctions, to the tanks (always) and to the tram, follow the car ahead, turn back at the dead ends (most of them where a street
// leaves the arena) and pass the parked cars. The server (server/world.js) drives N_CARS cars for everyone and sends where they are;
// the client draws them (client/src/net/world.ts) and drives them itself only in the intro's own city (client/src/world/traffic.ts).
//
// It replaces the traffic of the invented 7 × 7 grid (written twice: in the client and as a port in server/world.js). What the grid
// had for free is general now: a street is an edge with its own width (the lane a quarter of it, so the narrow ones hold one car at a
// time, see NARROW), a junction any number of streets at any angle (the turn kinds and the right of way come from the angles), the end
// of a street that goes nowhere a U-turn. The behaviour is the original's: the same speeds, the same rules for the junctions, the tanks
// and the tram, the same "two cars waiting for each other: after a moment one simply goes" and "a tank parked in the way: after a
// while the car turns back".
//
// The parked cars stand at map.ts's KERB_SPOTS, picked here with the city's seed (PARK), so every client and the server know the same
// ones: the client draws them and pushes them about, the server keeps those pushed out of their spot (by index N_CARS + k) and the
// cars of the traffic move over to pass the others (laneAt).
// Only erasable TypeScript, no DOM: Node loads this file as it is.
import { NODES, EDGES, KERB_SPOTS, SPAWNS, DEPOT, SITE, edgePos, nearestEdge, inArena, type REdge } from './map.ts';
import { tramNear, tankConflict, type Tram, type Tank, type Mover } from './tram.ts';

export type { Tank, Mover };
// 42 cars for 7554 units of street (the grid had 33 for 7553; Karlín's narrow streets fill up sooner). The snapshot carries N_CARS rows.
export const N_CARS = 42, VMAX_CAR = 9;
export const TANK_BLOCK_T = 5;                                        // seconds a tank may stand in a car's way before the car turns back
export const CAR_HW = 0.9, CAR_HL = 2.05;                             // half the car's width and length (the body: 1.8 × 4.1)

// ---------- the lanes ----------
// LANE[e]: how far right of the centre line a car drives: a quarter of the carriageway, never so far that the car touches the kerb.
// Where two cars do not fit side by side (2 × LANE < PASS: the streets of 3.3 and less) the street is NARROW: one lane in the middle
// and one direction at a time (a car waits at its end while one comes the other way, narrowBusy).
const PASS = 1.9, TAPER = 6;                                          // PASS: centre to centre of two cars side by side
export const LANE: number[] = [], NARROW: boolean[] = [];
const MAXLAT: number[] = [];                                          // the farthest out a car may drive on it
for (const e of EDGES) {
  const l = Math.min(e.w / 4, e.w / 2 - CAR_HW - 0.05), n = 2 * l < PASS;
  NARROW.push(n); LANE.push(n ? 0 : Math.max(0, l)); MAXLAT.push(Math.max(0, e.w / 2 - CAR_HW - 0.05));
}
const DEAD = NODES.map(n => n.e.length === 1);
const TRAM_NODE = NODES.map(n => n.e.some(k => !!EDGES[k].tram));
const ahead_ = (e: REdge, d: number) => d > 0 ? e.b : e.a;            // the node a car on e going d drives towards
// Narrow streets joined end to end at a node with no other street (a bend the generator kept as a node) are one narrow stretch:
// NG[e] the stretch, NS[e] whether e runs along it (+1) or against it (-1), NDEAD[g] whether it ends in a dead end
const NG: number[] = EDGES.map(e => e.i), NS: number[] = EDGES.map(() => 1);
{
  const done = EDGES.map(() => false);
  for (const e0 of EDGES) {
    if (!NARROW[e0.i] || done[e0.i]) continue;
    done[e0.i] = true;
    // walk on from both ends through nodes of two streets; the stretch runs the way of e0's a→b, so from e0's b (fw) a street left
    // along its own a→b runs with it, from e0's a against it
    for (const [n0, fw] of [[e0.b, true], [e0.a, false]] as [number, boolean][]) {
      let n = n0, prev = e0.i;
      for (let guard = 0; guard < EDGES.length; guard++) {
        const N = NODES[n]; if (N.e.length !== 2) break;
        const k = N.e[0] === prev ? N.e[1] : N.e[0]; if (!NARROW[k] || done[k]) break;
        const E = EDGES[k], ab = E.a === n;                             // leaving n along its a→b?
        done[k] = true; NG[k] = e0.i; NS[k] = ab === fw ? 1 : -1;
        prev = k; n = ab ? E.b : E.a;
      }
    }
  }
}
const DEAD1 = EDGES.map(e => DEAD[e.a] || DEAD[e.b]);
const NDEAD: boolean[] = EDGES.map(() => false);
EDGES.forEach((e, i) => { if (NARROW[i] && DEAD1[i]) NDEAD[NG[i]] = true; });
const DEADEND = DEAD1;
// The U-turn at a dead end: from the lane round to the other one (at least UR out, so it is a turn and not a spin on the spot),
// UB short of the street's end, so the car's nose stays on the street. Where the street leaves the arena at a slant (Rohanské nábřeží
// into the river bank), farther in, until both lanes are inside the arena.
// OUTSIDE[e]: a dead end that runs along the arena's edge, half outside it, all the way (and a street that leads only into one):
// the cars keep out of it while they have another way
const OUTSIDE: boolean[] = EDGES.map(() => false);
const UR = 0.9, UBE: number[] = EDGES.map(e => {
  const R = Math.max(UR, LANE[e.i]), base = Math.max(2.2, R + 1.5), d = DEAD[e.b] ? 1 : DEAD[e.a] ? -1 : 0;
  if (!d) return base;
  const P = { x: 0, z: 0, hx: 0, hz: 1 };
  for (let t = 0; t < 0.6 * e.len; t += 0.5) {
    const s = d > 0 ? e.len - t : t; let ok = true;
    for (const o of [-R, R]) { edgePos(e, s, o, P); if (!inArena(P.x, P.z, CAR_HW + 0.3)) ok = false; }
    if (ok) return Math.max(base, t + R + 1.2);
  }
  OUTSIDE[e.i] = true;
  return Math.max(base, Math.min(0.6 * e.len, base + 3));
});
for (let more = true, guard = 0; more && guard < 8; guard++) {
  more = false;
  for (const n of NODES) if (n.e.length === 2 && OUTSIDE[n.e[0]] !== OUTSIDE[n.e[1]]) { OUTSIDE[n.e[0]] = OUTSIDE[n.e[1]] = true; more = true; }
}
// A narrow street that is the only way into a small part of the network (a bridge of the graph: a narrow dead end, or a lane to a
// little loop round a courtyard) is a trap for two-way traffic on one lane: whoever goes in must come out the same way, past whoever
// follows. The cars keep out of such a street and what lies behind it while they have another way (OUTSIDE too).
{
  const disc = NODES.map(() => -1), low = NODES.map(() => 0), bridge = EDGES.map(() => false); let t = 0;
  const dfs = (u: number, pe: number) => {
    disc[u] = low[u] = t++;
    for (const k of NODES[u].e) {
      if (k === pe) continue;
      const E = EDGES[k], v = E.a === u ? E.b : E.a;
      if (disc[v] < 0) { dfs(v, k); low[u] = Math.min(low[u], low[v]); if (low[v] > disc[u]) bridge[k] = true; }
      else low[u] = Math.min(low[u], disc[v]);
    }
  };
  NODES.forEach(n => { if (disc[n.i] < 0) dfs(n.i, -1); });
  const side = (from: number, cut: number) => {                       // the nodes reachable from `from` without crossing edge cut
    const seen = new Set([from]), st = [from];
    while (st.length) { const u = st.pop() as number; for (const k of NODES[u].e) { if (k === cut) continue; const E = EDGES[k], v = E.a === u ? E.b : E.a; if (!seen.has(v)) { seen.add(v); st.push(v); } } }
    return seen;
  };
  EDGES.forEach(E => {
    if (!bridge[E.i] || !NARROW[E.i]) return;
    const A = side(E.a, E.i), B = side(E.b, E.i), small = A.size <= B.size ? A : B;
    if (small.size > 12) return;
    OUTSIDE[E.i] = true;
    for (const F of EDGES) if (small.has(F.a) && small.has(F.b)) OUTSIDE[F.i] = true;
  });
}
const UB = (e: number) => UBE[e];
// RR[e]: how far from its two nodes (a, b) a car leaves the street's line for the junction: the node's radius (map.ts), farther out
// where two streets meet at a sharp angle, so that cars waiting on the two do not stand in each other
const RR: number[][] = EDGES.map(e => [NODES[e.a].r, NODES[e.b].r]);
for (const n of NODES) {
  if (n.e.length < 2) continue;
  const ang = n.e.map(k => { const e = EDGES[k], p = edgePos(e, e.a === n.i ? Math.min(e.len, n.r + 1) : Math.max(0, e.len - n.r - 1), 0); return Math.atan2(p.x - n.x, p.z - n.z); });
  for (let i = 0; i < n.e.length; i++) for (let j = i + 1; j < n.e.length; j++) {
    let a = Math.abs(ang[i] - ang[j]); if (a > Math.PI) a = 2 * Math.PI - a;
    if (a >= 2.6) continue;                                           // (nearly straight on: the node's own radius does)
    // side by side at a sharp angle; else at least a car's half length and width from a bend (a node of two streets has only w/4)
    const need = Math.max(a < Math.PI / 2 ? (CAR_HW + 0.4) / Math.sin(Math.max(a, 0.05) / 2) : 0, 3.2);
    for (const k of [n.e[i], n.e[j]]) { const e = EDGES[k], w = e.a === n.i ? 0 : 1; RR[k][w] = Math.max(RR[k][w], Math.min(need, 0.42 * e.len, 14)); }
  }
}
// where a car on edge e going d (1: from a to b) enters it after a junction, and leaves it for the next junction (or its U-turn)
function sIn(e: number, d: number) { const E = EDGES[e]; return d > 0 ? RR[e][0] : E.len - RR[e][1]; }
function sOut(e: number, d: number) {
  const E = EDGES[e], n = ahead_(E, d), si = sIn(e, d);
  if (DEAD[n]) return d > 0 ? Math.max(si + 0.5, E.len - UB(e)) : Math.min(si - 0.5, UB(e));
  return d > 0 ? E.len - RR[e][1] : RR[e][0];
}

// ---------- the parked cars ----------
// From KERB_SPOTS with the city's seed: only on streets of 6 and more, where a car still passes them in its lane while the other
// lane stays free. (Karlín's 4.5 to 5.9 wide streets are one-way in reality, with cars parked on both sides; here they are two-way,
// and a car parked there would close a lane for both directions.) On one side of the street unless it is 7.9 wide; not within 10 of a dead end (the U-turns), 7 of a tank's spawn point, 12 of the
// depot's yard and 10 of the construction site's gates. PARK[k] is the server's car N_CARS + k; ci its paint (0..PARK_COLS-1).
export interface ParkSpot { x: number; z: number; h: number; e: number; ci: number }
export const PARK_COLS = 7, PARK_P = 0.45, PARK_SEED = 2026;
export const PARK: ParkSpot[] = [];
// where the lane moves over: per edge, for each direction, [s0, s1, hi, lo] flat: between s0 and s1 the car keeps at most hi and
// at least lo right of the centre line (TAPER units to get there)
const BUMP: number[][][] = EDGES.map(() => [[], []]);                 // [e][d > 0 ? 0 : 1]
// mulberry32, as client/src/core/util.ts's rng: integer arithmetic, the same on every engine
function rng(seed: number): () => number {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
// (x,z) projected onto edge e: s along it, off right of a→b
function onEdge(e: REdge, x: number, z: number): { s: number; off: number } {
  let bd = Infinity, bs = 0, bo = 0;
  for (let k = 0; k + 1 < e.pts.length; k++) {
    const [ax, az] = e.pts[k], [bx, bz] = e.pts[k + 1], dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / l2)) : 0, qx = ax + dx * t - x, qz = az + dz * t - z, d = qx * qx + qz * qz;
    if (d < bd) { bd = d; bs = e.cum[k] + t * Math.sqrt(l2); bo = (dx * (z - az) - dz * (x - ax) >= 0 ? 1 : -1) * Math.sqrt(d); }
  }
  return { s: bs, off: bo };
}
{
  const near = (x: number, z: number, pts: { x: number; z: number }[], r: number) => pts.some(p => (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z) < r * r);
  const deadPts = NODES.filter(n => DEAD[n.i]), avoid = [DEPOT.park], gates = SITE ? SITE.gates : [];
  const cand = KERB_SPOTS.map(p => {
    const E = EDGES[p.e], q = onEdge(E, p.x, p.z);
    const ok = E.w >= 6 && !E.tram && Math.abs(q.off) >= E.w / 2 - 1.4 && !near(p.x, p.z, deadPts, 10) && !near(p.x, p.z, SPAWNS, 7) && !near(p.x, p.z, avoid, 12) && !near(p.x, p.z, gates, 10);
    return { p, s: q.s, off: q.off, ok };
  });
  const side: number[] = EDGES.map(() => 0);                          // per edge: which side gets the cars (+1 right of a→b, -1 left)
  {
    const cnt = EDGES.map(() => [0, 0]);
    for (const c of cand) if (c.ok) cnt[c.p.e][c.off > 0 ? 0 : 1]++;
    EDGES.forEach((E, i) => { side[i] = cnt[i][0] >= cnt[i][1] ? 1 : -1; });
  }
  const rnd = rng(PARK_SEED), raw: number[][][] = EDGES.map(() => [[], []]);
  for (const c of cand) {
    const r = rnd(), ci = (rnd() * PARK_COLS) | 0, E = EDGES[c.p.e], sg = c.off > 0 ? 1 : -1;
    if (!c.ok || r >= PARK_P || (E.w < 7.9 && sg !== side[E.i])) continue;
    PARK.push({ x: c.p.x, z: c.p.z, h: c.p.h, e: c.p.e, ci });
    // the car passing it keeps PASS - CAR_HW + gap from its middle; the one the other way keeps PASS from that car
    const hi = Math.abs(c.off) - CAR_HW - 0.12 - CAR_HW, lo = Math.min(MAXLAT[E.i], PASS - hi), s0 = c.s - CAR_HL - 0.6, s1 = c.s + CAR_HL + 0.6;
    raw[E.i][sg > 0 ? 0 : 1].push(s0, s1, hi, -Infinity);
    if (lo > LANE[E.i]) raw[E.i][sg > 0 ? 1 : 0].push(s0, s1, Infinity, lo);
  }
  // a narrow dead end: both lanes a little apart near its end, so the U-turn is a turn
  EDGES.forEach((E, i) => {
    if (!NARROW[i] || !DEADEND[i]) return;
    const d = DEAD[E.b] ? 1 : -1, so = sOut(i, d), lo = Math.min(UR, MAXLAT[i]);
    for (const k of [0, 1]) raw[i][k].push(so - 3, so + 3, Infinity, lo);
  });
  // merged where they nearly touch, so a row of parked cars is passed in one move and not in a wobble
  raw.forEach((dirs, i) => dirs.forEach((B, k) => {
    const iv: number[][] = []; for (let j = 0; j < B.length; j += 4) iv.push(B.slice(j, j + 4));
    iv.sort((a, b) => a[0] - b[0]);
    const out: number[] = [];
    for (const v of iv) {
      const n = out.length;
      if (n && v[0] - out[n - 3] < 2 * TAPER) { out[n - 3] = Math.max(out[n - 3], v[1]); out[n - 2] = Math.min(out[n - 2], v[2]); out[n - 1] = Math.max(out[n - 1], v[3]); }
      else out.push(...v);
    }
    BUMP[i][k] = out;
  }));
}
// how far right of the centre line a car on edge e going d drives at s
export function laneAt(e: number, d: number, s: number): number {
  const base = LANE[e], B = BUMP[e][d > 0 ? 0 : 1]; if (!B.length) return base;
  let hi = base, lo = -Infinity;
  for (let i = 0; i < B.length; i += 4) {
    const out = s < B[i] ? B[i] - s : s > B[i + 1] ? s - B[i + 1] : 0; if (out >= TAPER) continue;
    const f = out / TAPER, k = f * f * (3 - 2 * f);
    if (B[i + 2] < base) hi = Math.min(hi, B[i + 2] + (base - B[i + 2]) * k);
    if (B[i + 3] > base) lo = Math.max(lo, B[i + 3] + (base - B[i + 3]) * k);
  }
  return Math.max(hi, lo);
}

// ---------- a car ----------
// On its route: phase 'edge' along a street (edge e, d 1 from a to b or -1, s from node a, lat right of the way it goes) or 'turn'
// through a junction (node jn, a cubic Bézier P from its lane into the exit's: edge ne, direction nd, from ns on); 'dyn': a free
// body a player pushes (the server: their browser moves it; the client: world/traffic.ts's body physics).
export interface SimCar {
  id: number;
  x: number; z: number; hx: number; hz: number; v: number;        // where it is (in its lane), its heading, its speed
  phase: 'edge' | 'turn' | 'dyn';
  e: number; d: number; s: number; lat: number;
  pe: number; pd: number; pns: number; ptk: string; pdx: number; pdz: number; PP: number[]; plen: number;   // the exit it picked (-1 none)
  jn: number; ne: number; nd: number; ns: number; tk: string; dax: number; daz: number; P: number[]; len: number; u: number;
  ox: number; oz: number; oa: number;                              // back from a push: offset from the lane, fading out (glides back)
  yieldT: number; hurry: number; hold: number; stuck: number; ghost: number; tankT: number; waitJ: boolean;
  rsv: number; rsvD: number; wn: number; tramT: number; still: number;   // wn, tramT, still: how long it has waited at a junction, for
                                                                   // the tram, at all                                       // the narrow street it has the right to enter next, and which way
  rnd: () => number;                                               // its dice for the junctions
}
export function newCar(id: number, rnd: () => number = Math.random): SimCar {
  return {
    id, x: 0, z: 0, hx: 0, hz: 1, v: VMAX_CAR, phase: 'edge', e: 0, d: 1, s: 0, lat: 0,
    pe: -1, pd: 1, pns: 0, ptk: 'S', pdx: 0, pdz: 1, PP: [0, 0, 0, 0, 0, 0, 0, 0], plen: 1,
    jn: -1, ne: 0, nd: 1, ns: 0, tk: 'S', dax: 0, daz: 1, P: [0, 0, 0, 0, 0, 0, 0, 0], len: 1, u: 0,
    ox: 0, oz: 0, oa: 0, yieldT: 0, hurry: 0, hold: 0, stuck: 0, ghost: 0, tankT: 0, waitJ: false, rsv: -1, rsvD: 1, wn: 0, tramT: 0, still: 0, rnd,
  };
}
const AT = { x: 0, z: 0, hx: 0, hz: 1 }, A2 = { x: 0, z: 0, hx: 0, hz: 1 }, A3 = { x: 0, z: 0, hx: 0, hz: 1 };
const clampS = (E: REdge, s: number) => s < 0 ? 0 : s > E.len ? E.len : s;
const remOf = (c: SimCar) => c.d > 0 ? sOut(c.e, c.d) - c.s : c.s - sOut(c.e, c.d);
// the point of the lane of edge e going d at s (into o)
function lanePt(e: number, d: number, s: number, o: typeof AT) { return edgePos(EDGES[e], s, d * laneAt(e, d, s), o); }
// the cubic Bézier P at t: point and unit direction
function bez(P: number[], t: number, o: typeof AT) {
  const s = 1 - t, a = s * s * s, b = 3 * s * s * t, c = 3 * s * t * t, d = t * t * t;
  o.x = a * P[0] + b * P[2] + c * P[4] + d * P[6]; o.z = a * P[1] + b * P[3] + c * P[5] + d * P[7];
  let dx = s * s * (P[2] - P[0]) + 2 * s * t * (P[4] - P[2]) + t * t * (P[6] - P[4]), dz = s * s * (P[3] - P[1]) + 2 * s * t * (P[5] - P[3]) + t * t * (P[7] - P[5]);
  let l = Math.hypot(dx, dz); if (l < 1e-9) { dx = P[6] - P[0]; dz = P[7] - P[1]; l = Math.hypot(dx, dz) || 1; }
  o.hx = dx / l; o.hz = dz / l; return o;
}
// The curve from a (heading ah) to b (heading bh) into P, its length returned. The original's turn was a quadratic Bézier through the
// junction's middle on a right-angled grid; for any angle a cubic whose handles make it a circular arc when the two ends are alike
// ((4/3) tan(θ/4) of the radius): a right turn, a left turn across the other lane, a slight bend, a U-turn alike.
function curve(ax: number, az: number, ahx: number, ahz: number, bx: number, bz: number, bhx: number, bhz: number, P: number[]): number {
  const ch = Math.hypot(bx - ax, bz - az), th = Math.acos(Math.max(-1, Math.min(1, ahx * bhx + ahz * bhz)));
  const k = th < 0.05 ? ch / 3 : ch * (4 / 3) * Math.tan(th / 4) / (2 * Math.sin(th / 2));
  P[0] = ax; P[1] = az; P[2] = ax + ahx * k; P[3] = az + ahz * k; P[4] = bx - bhx * k; P[5] = bz - bhz * k; P[6] = bx; P[7] = bz;
  let L = 0, px = ax, pz = az;
  for (let i = 1; i <= 12; i++) { bez(P, i / 12, A3); L += Math.hypot(A3.x - px, A3.z - pz); px = A3.x; pz = A3.z; }
  return Math.max(L, 0.1);
}
// where the car is and which way it faces, from its route
export function placeCar(c: SimCar) {
  if (c.phase === 'edge') {
    const E = EDGES[c.e]; c.lat = laneAt(c.e, c.d, c.s); edgePos(E, c.s, c.d * c.lat, AT); c.x = AT.x; c.z = AT.z;
    // heading: from a point a little behind to one a little ahead, smooth over the corners of the street's line and the lane's moves
    lanePt(c.e, c.d, clampS(E, c.s + c.d * 0.8), A2); lanePt(c.e, c.d, clampS(E, c.s - c.d * 0.8), A3);
    const hx = A2.x - A3.x, hz = A2.z - A3.z, l = Math.hypot(hx, hz);
    if (l > 1e-6) { c.hx = hx / l; c.hz = hz / l; } else { c.hx = c.d * AT.hx; c.hz = c.d * AT.hz; }
  } else if (c.phase === 'turn') { bez(c.P, Math.min(1, c.u / c.len), AT); c.x = AT.x; c.z = AT.z; c.hx = AT.hx; c.hz = AT.hz; }
}

// ---------- the junctions ----------
// prefer going straight a bit more often, like real traffic; into a dead end and a narrow street less often; never back the way it
// came (only at a dead end) nor round a hairpin when there is anything else
function pickExit(c: SimCar): [number, number] {
  const E = EDGES[c.e], n = ahead_(E, c.d); if (DEAD[n]) return [c.e, -c.d];
  const so = sOut(c.e, c.d); edgePos(E, so, 0, AT); const dx = c.d * AT.hx, dz = c.d * AT.hz;
  const opts: { e: number; d: number; dot: number; w: number }[] = [];
  for (const k of NODES[n].e) {
    if (k === c.e) continue;
    const E2 = EDGES[k], d2 = E2.a === n ? 1 : -1; edgePos(E2, sIn(k, d2), 0, AT);
    opts.push({ e: k, d: d2, dot: dx * d2 * AT.hx + dz * d2 * AT.hz, w: (DEADEND[k] ? 0.35 : 1) * (NARROW[k] ? 0.6 : 1) });
  }
  let use = opts.filter(o => o.dot > -0.8 && !OUTSIDE[o.e]);
  if (!use.length) use = opts.filter(o => !OUTSIDE[o.e]);
  if (!use.length) use = opts.filter(o => o.dot > -0.8);
  if (!use.length) use = opts;
  if (!use.length) return [c.e, -c.d];
  const st = use.reduce((a, b) => b.dot > a.dot ? b : a);
  if (st.dot > 0.7 && c.rnd() < 0.35) return [st.e, st.d];
  let sum = 0; for (const o of use) sum += o.w;
  let r = c.rnd() * sum; for (const o of use) { r -= o.w; if (r <= 0) return [o.e, o.d]; }
  return [use[use.length - 1].e, use[use.length - 1].d];
}
// the turn into exit (e2, d2) at the end of the car's street: curve, length, kind (S straight, R right, L left, U back)
function planTurn(c: SimCar, e2: number, d2: number) {
  const so = sOut(c.e, c.d); lanePt(c.e, c.d, so, A2); edgePos(EDGES[c.e], so, 0, AT);
  const ahx = c.d * AT.hx, ahz = c.d * AT.hz, ax = A2.x, az = A2.z;
  const ns = e2 === c.e ? so : sIn(e2, d2); lanePt(e2, d2, ns, A2); edgePos(EDGES[e2], ns, 0, AT);
  const bhx = d2 * AT.hx, bhz = d2 * AT.hz;
  c.pe = e2; c.pd = d2; c.pns = ns; c.pdx = ahx; c.pdz = ahz;
  c.plen = curve(ax, az, ahx, ahz, A2.x, A2.z, bhx, bhz, c.PP);
  c.ptk = e2 === c.e ? 'U' : bhx * ahx + bhz * ahz > 0.5 ? 'S' : bhx * -ahz + bhz * ahx > 0.5 ? 'R' : 'L';
}
function plan(c: SimCar) { const [e2, d2] = pickExit(c); planTurn(c, e2, d2); }
// junction right of way: a car enters only when no car already in that junction crosses its path (the original's rule: the same
// exit, or two turns that cross; a right turn crosses nothing, nor do two cars going straight on from opposite sides; a U-turn has
// the junction to itself)
function junctionBusy(c: SimCar, cars: SimCar[]) {
  const n = ahead_(EDGES[c.e], c.d), kc = c.ptk;
  for (const o of cars) {
    if (o === c || o.phase !== 'turn' || o.jn !== n) continue;
    if (o.ne === c.pe && o.nd === c.pd) return true;
    if (kc === 'U' || o.tk === 'U') return true;
    if (kc === 'R' || o.tk === 'R') continue;
    if (kc === 'S' && o.tk === 'S' && o.dax * c.pdx + o.daz * c.pdz < -0.5) continue;
    return true;
  }
  return false;
}
// World of DODO, issue #16: do not block the junction. Karlín has streets of 8 to 12 units between two junctions: a car enters only
// when its exit has room for it (no car standing in that lane within a car's length and a bit of where the turn comes out).
function exitFull(c: SimCar, cars: SimCar[], e2 = c.pe, d2 = c.pd, ns = c.pns) {
  for (const o of cars) {
    if (o === c || o.phase !== 'edge' || o.e !== e2 || o.d !== d2 || o.v > 2) continue;
    const ahead = o.d > 0 ? o.s - ns : ns - o.s;
    if (ahead > -1 && ahead < 2 * CAR_HL + 2.5) return true;
  }
  return false;
}
// World of DODO, issue #16: a narrow street takes one direction at a time: busy while a car is on it (or turning into it, or has the
// right to enter it next) going the other way; a narrow dead end is busy with anyone on it (they all come back out)
// (a stretch of narrow streets, NG, counts as one)
function narrowBusy(c: SimCar, cars: SimCar[], e2: number, d2: number) {
  const g = NG[e2], both = NDEAD[g], D = d2 * NS[e2];
  for (const o of cars) {
    if (o === c || o.phase === 'dyn') continue;
    if (o.phase === 'edge' && NARROW[o.e] && NG[o.e] === g && (both || o.d * NS[o.e] !== D)) return true;
    if (o.phase === 'turn' && NARROW[o.ne] && NG[o.ne] === g && (both || o.nd * NS[o.ne] !== D)) return true;
    if (o.rsv >= 0 && NG[o.rsv] === g && (both || o.rsvD * NS[o.rsv] !== D)) return true;
  }
  return false;
}
// World of DODO, issue #16: out of a knot. A car that has waited long at the end of its street (for a narrow street taken the other
// way, whose car may be waiting for this one's; for a junction or an exit that does not clear: on Karlín's short streets a ring of
// queues can close) takes another exit that is free (not into a trap, not round a hairpin, while there is anything else), and after
// UNKNOT_BACK s turns back. True when it turned back (the car's step ends there).
const UNKNOT_BACK = 20;
function unknot(c: SimCar, cars: SimCar[]): boolean {
  const n = ahead_(EDGES[c.e], c.d); if (DEAD[n]) return c.wn > UNKNOT_BACK && turnBack(c, cars);
  const so = sOut(c.e, c.d); edgePos(EDGES[c.e], so, 0, AT); const dx = c.d * AT.hx, dz = c.d * AT.hz;
  let best = -1, bd = 0, bs = -1;
  for (const k of NODES[n].e) {
    if (k === c.e || k === c.pe) continue;
    const E2 = EDGES[k], d2 = E2.a === n ? 1 : -1, ns = sIn(k, d2);
    if ((NARROW[k] && narrowBusy(c, cars, k, d2)) || exitFull(c, cars, k, d2, ns)) continue;
    edgePos(E2, ns, 0, AT); const dot = dx * d2 * AT.hx + dz * d2 * AT.hz, sc = (OUTSIDE[k] ? 0 : 2) + (dot > -0.8 ? 1 : 0);
    if (sc > bs) { bs = sc; best = k; bd = d2; }
  }
  if (best >= 0) { planTurn(c, best, bd); return false; }
  return c.wn > UNKNOT_BACK && turnBack(c, cars);
}
function startTurn(c: SimCar) {
  if (c.pe < 0) plan(c);
  c.jn = ahead_(EDGES[c.e], c.d); c.ne = c.pe; c.nd = c.pd; c.ns = c.pns; c.tk = c.ptk; c.dax = c.pdx; c.daz = c.pdz;
  for (let i = 0; i < 8; i++) c.P[i] = c.PP[i];
  c.len = c.plen; c.u = 0; c.phase = 'turn'; c.pe = -1; c.rsv = -1;
}
function endTurn(c: SimCar, over: number) {
  c.phase = 'edge'; c.e = c.ne; c.d = c.nd; c.s = c.ns; c.jn = -1;
  const r = remOf(c); c.s += c.d * Math.min(Math.max(0, r), over);
}
// a tank (or a pushed car left there) keeps standing in the way: the car turns back down its street, into the other lane
// (true when it did; not onto a car in the other lane: World of DODO, issue #16, the lanes are close; it tries again next step)
export function turnBack(c: SimCar, cars?: SimCar[]): boolean {
  if (c.phase !== 'edge') return false;
  if (cars) for (const o of cars) {
    if (o === c || o.phase !== 'edge' || o.e !== c.e) continue;
    if (o.d === -c.d ? Math.abs(o.s - c.s) < 2 * CAR_HL + 1.5 : NARROW[c.e] && (o.s - c.s) * c.d < 0) return false;   // (one lane: the one behind too)
  }
  c.d = -c.d; c.pe = -1; c.rsv = -1; c.tankT = 0; c.wn = 0;
  const r = remOf(c); if (r < 0) c.s = sOut(c.e, c.d);
  placeCar(c); return true;
}
// where car c will be after driving du further along its real route (street → planned turn → the next street), as [x, z, hx, hz]
function curveAt(P: number[], L: number, u: number): number[] {
  if (u <= L) { bez(P, u / L, A3); return [A3.x, A3.z, A3.hx, A3.hz]; }
  bez(P, 1, A3); return [A3.x + A3.hx * (u - L), A3.z + A3.hz * (u - L), A3.hx, A3.hz];
}
function routeAt(c: SimCar, du: number): number[] {
  if (c.phase !== 'edge') return curveAt(c.P, c.len, c.u + du);
  const E = EDGES[c.e], rem = remOf(c);
  if (du <= rem) { const s = c.s + c.d * du; lanePt(c.e, c.d, s, A3); return [A3.x, A3.z, c.d * A3.hx, c.d * A3.hz]; }
  if (c.pe >= 0) return curveAt(c.PP, c.plen, du - rem);
  const so = sOut(c.e, c.d); lanePt(c.e, c.d, so, A3); const hx = c.d * A3.hx, hz = c.d * A3.hz, k = du - rem;
  return [A3.x + hx * k, A3.z + hz * k, hx, hz];
}

// ---------- seeing what is ahead ----------
// is point (x,z) in the strip right in front of car c? (forward 0..fa, sideways ±fl)
function ahead(c: SimCar, x: number, z: number, fa: number, fl: number) {
  const wx = x - c.x, wz = z - c.z; if (Math.abs(wx) > fa + 3 || Math.abs(wz) > fa + 3) return false;
  const a = wx * c.hx + wz * c.hz; if (a <= 0.3 || a > fa) return false;
  return Math.abs(wx * c.hz - wz * c.hx) < fl;
}
const carAhead = (c: SimCar, o: Mover) => ahead(c, o.x, o.z, 8, 2.1) || ahead(c, o.x - o.hx * 1.9, o.z - o.hz * 1.9, 8, 2.1) || ahead(c, o.x + o.hx * 1.9, o.z + o.hz * 1.9, 8, 2.1);
const tankAhead = (c: SimCar, k: Tank) => {
  const fx = Math.sin(k.h) * 1.55, fz = Math.cos(k.h) * 1.55;
  return ahead(c, k.x, k.z, 9, 2.6) || ahead(c, k.x + fx, k.z + fz, 9, 2.6) || ahead(c, k.x - fx, k.z - fz, 9, 2.6);
};

// ---------- one step of the traffic ----------
// cars: the traffic (a car in phase 'dyn' is left alone, its body moves elsewhere, but the others stop for it); tanks: every tank in
// the city; tram: the tram; bodies: the parked cars out of their spots (they stand in the way like cars that do not move)
const O_TANK = [-1.4, 0, 1.4], STILL_GONE = 40, SIGHT = 70;
export function stepTraffic(cars: SimCar[], dt: number, tanks: Tank[], tram: Tram, bodies: readonly Mover[]) {
  for (const c of cars) {
    if (c.phase === 'dyn') continue;
    if (c.ox || c.oz || c.oa) {                                        // back from a push: glide into the lane
      const f = Math.exp(-3 * dt); c.ox *= f; c.oz *= f; c.oa *= f;
      if (Math.abs(c.ox) + Math.abs(c.oz) + Math.abs(c.oa) < 0.01) c.ox = c.oz = c.oa = 0;
    }
    if (c.rsv >= 0 && !(c.phase === 'edge' && c.pe === c.rsv && c.pd === c.rsvD)) c.rsv = -1;
    let target = VMAX_CAR, byCar = false, byTank = false, byBody = false, byYield = false;
    if (c.ghost > 0) c.ghost -= dt;
    // keep distance to whatever is ahead: other cars (not those coming the other way in their own lane), the tanks, the tram
    // (a car crossing a junction passes the cars waiting to enter that junction; World of DODO, issue #16: only those, not one waiting
    // at the next junction, which on Karlín's short streets can stand right where the turn comes out)
    const le = c.phase === 'turn' ? c.ne : c.e, ld = c.phase === 'turn' ? c.nd : c.d;
    for (const o of cars) {
      if (o === c || (c.phase === 'turn' && o.waitJ && o.phase === 'edge' && ahead_(EDGES[o.e], o.d) === c.jn)) continue;
      const dot = o.hx * c.hx + o.hz * c.hz;
      if (o.phase !== 'dyn' && dot < -0.7) continue;
      if (!carAhead(c, o)) continue;
      // a car resolving a deadlock passes crossing cars, but never drives into the car ahead in its own lane
      if (c.ghost > 0 && dot < 0.7 && o.phase !== 'dyn' && !(o.phase === 'edge' && o.e === le && o.d === ld)) continue;
      target = 0; byCar = true; if (o.phase === 'dyn') byBody = true;
    }
    for (const o of bodies) if (carAhead(c, o)) { target = 0; byCar = true; byBody = true; }
    // give way to the tanks early: 'if I keep my speed' and 'if I speed up', and keep yielding a moment so the car doesn't creep into them
    {
      const pos = (du: number) => routeAt(c, du);
      if (c.phase === 'edge') { if (tankConflict(pos, VMAX_CAR, O_TANK, 2.6, 2.6, tanks) || tankConflict(pos, Math.max(c.v, 3), O_TANK, 2.6, 2.6, tanks)) c.yieldT = 0.6; }
      // already inside the junction: clear it if that avoids the tank, stop only if stopping is the safe option
      else if (tankConflict(pos, Math.max(c.v, 6), O_TANK, 2.6, 2.6, tanks)) { if (!tankConflict(pos, 0, O_TANK, 2.6, 2.6, tanks)) c.yieldT = 0.6; else { c.yieldT = 0; c.hurry = 0.8; } }
    }
    if (c.hurry > 0) { c.hurry -= dt; c.yieldT = 0; }
    if (c.yieldT > 0) { c.yieldT -= dt; target = 0; byYield = true; }
    for (const k of tanks) if (tankAhead(c, k)) { target = 0; byTank = true; }
    // behind the tram in its lane (not the one coming the other way; a car already inside a junction is committed and drives on:
    // the tram waits for it)
    let byTram = false;
    if (c.phase === 'edge') for (let i = 0; i < tram.pts.length; i++) {
      const v = tram.vag[(i / 3) | 0]; if (v && v.hx * c.hx + v.hz * c.hz < -0.5) continue;
      const p = tram.pts[i]; if (ahead(c, p[0], p[1], 9, 2.2)) { target = 0; byTram = true; }
    }
    // entering or crossing the tram's street at a junction (anything but going straight on along it or turning right off it): give way
    // to the tram. (World of DODO, issue #16: every node on a street with tram: 1, where the grid had its avenue TRAM_K; and only to
    // the tram ahead of the car: one right behind it in its lane waits for it, the two would wait for each other)
    if (c.phase === 'edge' && c.pe >= 0 && TRAM_NODE[ahead_(EDGES[c.e], c.d)] && remOf(c) < 6 && !(EDGES[c.e].tram && c.ptk !== 'L')) {
      const N = NODES[ahead_(EDGES[c.e], c.d)];
      if (tram.pts.some(p => Math.abs(p[0] - N.x) < 22 && Math.abs(p[1] - N.z) < 22 && (p[0] - c.x) * c.hx + (p[1] - c.z) * c.hz > -2)) { target = 0; byTram = true; }
    }
    // stuck behind a tram that does not move (a tank parked on its track): after a long while the car turns back too
    c.tramT = byTram && c.v < 0.5 ? c.tramT + dt : 0;
    // approaching a junction: pick the exit, slow down and wait if a crossing car is inside it (or a narrow street ahead is taken)
    c.waitJ = false;
    if (c.phase === 'edge') {
      const rem = remOf(c);
      if (c.pe < 0 && rem < 30) plan(c);
      if (rem < 8) {
        if (c.pe < 0) plan(c);
        let busy = junctionBusy(c, cars) || exitFull(c, cars), nb = false;
        if (!busy && NARROW[c.pe] && c.pe !== c.e && !(NARROW[c.e] && NG[c.e] === NG[c.pe])) { if (narrowBusy(c, cars, c.pe, c.pd)) busy = nb = true; else { c.rsv = c.pe; c.rsvD = c.pd; } }
        if (busy) { c.waitJ = true; target = Math.min(target, Math.sqrt(2 * 12 * Math.max(0, rem - 0.3))); }
        // waiting long (for a narrow street sooner: its car may be waiting for this one's): another way, else back
        if (busy && c.v < 0.5) { c.wn += dt; if (c.wn > (nb ? 6 : 12) && unknot(c, cars)) continue; } else c.wn = 0;
      }
    }
    if (c.hold > 0) { c.hold -= dt; target = 0; }
    // two cars waiting for each other inside a junction: after a moment one of them simply goes
    if (byCar && c.v < 0.5) {
      c.stuck += dt;
      if (c.stuck > 4 + (c.id % 4) * 0.5 && !cars.some(o => o !== c && o.ghost > 0 && Math.abs(o.x - c.x) < 16 && Math.abs(o.z - c.z) < 16)) { c.ghost = 1.6; c.stuck = 0; }
    } else c.stuck = 0;
    // a tank parked in the way (or a pushed car left there): after a while the car turns back down its street (into the other lane).
    // World of DODO, issue #16: also a tank it keeps giving way to (one driving to and fro in front of it), not only one right ahead
    if (c.tramT > 3 * TANK_BLOCK_T && c.phase === 'edge' && turnBack(c, cars)) { c.tramT = 0; continue; }
    if ((byTank || byBody || byYield) && c.v < 0.5 && c.phase === 'edge') { c.tankT += dt; if (c.tankT > TANK_BLOCK_T && turnBack(c, cars)) continue; }
    else c.tankT = 0;
    // World of DODO, issue #16: the last resort against a knot nothing above undid (a car standing STILL_GONE s): where no tank is near,
    // the car is gone and drives on somewhere else, out of sight too
    c.still = c.v < 0.3 ? c.still + dt : 0;
    if (c.still > STILL_GONE && !tanks.some(t => Math.hypot(t.x - c.x, t.z - c.z) < SIGHT)) {
      if (placeOne(c, cars, cars.length, c.rnd, tram, tanks, SIGHT)) continue;
      c.still = 0;
    }
    c.v += Math.max(-14 * dt, Math.min(6 * dt, target - c.v));
    if (c.phase === 'turn' && c.v > 6 && !(c.hurry > 0)) c.v = Math.max(6, c.v - 10 * dt);   // slow down in turns
    if (c.v < 0) c.v = 0;
    const mv = c.v * dt;
    if (c.phase === 'edge') {
      const rem = remOf(c);
      if (mv < rem) c.s += c.d * mv;
      else if (c.waitJ) { c.s = sOut(c.e, c.d) - c.d * 0.01; c.v = 0; }
      else { startTurn(c); c.u = Math.max(0, mv - Math.max(0, rem)); if (c.u >= c.len) endTurn(c, c.u - c.len); }
    } else { c.u += mv; if (c.u >= c.len) endTurn(c, c.u - c.len); }
    placeCar(c);
  }
}

// ---------- placing the cars ----------
// the streets by the length a car can be placed on (none on the traps the cars keep out of)
const SEED_W = EDGES.map(E => OUTSIDE[E.i] ? 0 : Math.max(0, E.len - RR[E.i][0] - RR[E.i][1] - 4)), SEED_TOT = SEED_W.reduce((a, b) => a + b, 0);
// car c (one of cars, of which the first `placed` stand already) somewhere on the streets: not near the tanks' start in front of the
// depot nor within far of a tank, never on top of another car or the tram, one at most on a narrow street. False if it found no place.
function placeOne(c: SimCar, cars: SimCar[], placed: number, rnd: () => number, tram?: Tram, tanks: Tank[] = [], far = 0): boolean {
  for (let tries = 0; tries < 400; tries++) {
    let r = rnd() * SEED_TOT, e = 0; while (e < SEED_W.length - 1 && r > SEED_W[e]) { r -= SEED_W[e]; e++; }
    const d = rnd() < 0.5 ? 1 : -1, a = sIn(e, d), b = sOut(e, d), k = 0.15 + rnd() * 0.7;
    Object.assign(c, { phase: 'edge', e, d, s: a + (b - a) * k, v: VMAX_CAR * 0.7, pe: -1, jn: -1, rsv: -1, ox: 0, oz: 0, oa: 0,
      yieldT: 0, hurry: 0, hold: 0, stuck: 0, ghost: 0, tankT: 0, waitJ: false, wn: 0, tramT: 0, still: 0 });
    placeCar(c);
    if (Math.hypot(c.x - DEPOT.park.x, c.z - DEPOT.park.z) < 25 || tanks.some(t => Math.hypot(t.x - c.x, t.z - c.z) < far)) continue;
    let bad = false;
    for (let i = 0; i < placed && !bad; i++) { const o = cars[i]; if (o !== c && (Math.hypot(o.x - c.x, o.z - c.z) < 14 || (NARROW[e] && o.e === e))) bad = true; }
    if (bad || (tram && tramNear(tram, c.x, c.z, 18))) continue;
    return true;
  }
  return false;
}
// Spread the cars over the streets (by their length). rnd: the dice for the places, also kept as each car's dice for its junctions.
export function seedTraffic(cars: SimCar[], rnd: () => number, tram?: Tram) {
  for (let i = 0; i < cars.length; i++) { cars[i].rnd = rnd; placeOne(cars[i], cars, i, rnd, tram); }
}
// Back onto the street after a push (the client's body physics brought it to rest at x, z facing ang): the nearest street, the lane
// that goes the way it points, gliding there from where it stands (ox, oz, oa fade out)
export function rejoin(c: SimCar, x: number, z: number, ang: number) {
  const n = nearestEdge(x, z); if (!n) return;
  const E = n.e; edgePos(E, n.s, 0, AT);
  const d = Math.sin(ang) * AT.hx + Math.cos(ang) * AT.hz >= 0 ? 1 : -1, a = sIn(E.i, d), b = sOut(E.i, d);
  Object.assign(c, { phase: 'edge', e: E.i, d, s: Math.min(Math.max(a, b), Math.max(Math.min(a, b), n.s)), v: 0, pe: -1, jn: -1, rsv: -1,
    waitJ: false, yieldT: 0, hurry: 0, hold: 0, stuck: 0, ghost: 0, tankT: 0, wn: 0, tramT: 0, still: 0, ox: 0, oz: 0, oa: 0 });
  placeCar(c);
  c.ox = x - c.x; c.oz = z - c.z; const da = ang - Math.atan2(c.hx, c.hz); c.oa = Math.atan2(Math.sin(da), Math.cos(da));
}
