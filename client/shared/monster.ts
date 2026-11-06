// World of DODO, issue #26: Velemlok, a colossal, ancient river salamander that comes up in the Vltava once in a while and that the
// two teams fight over (a nod to Karel Čapek's Válka s mloky). The same file on the client and the server (Node 24 loads it by
// stripping its types, server/monster.js): the numbers of the fight, its hitbox and what its attacks hit.
//
// The server decides it all (server/monster.js, docs/PROTOCOL.md): when it comes (MON_FIRST_S after a round starts, then MON_EVERY_S
// after it has gone, never in the intermission), where it swims, whom it attacks, how much damage each team and each player deals,
// and the points when it leaves (killed, or fled after MON_LIFE_S). The browsers draw it from snap.g (its pose) and obj.g (its state),
// report their hits on it (mhit, checked against monHit here) and apply its attacks (mon) to their own vehicle (monAtkHits here).
//
// Like everything in client/shared: erasable TypeScript only, no DOM. The hitbox uses sin and cos (a heading, the angle it rears up
// by): the server checks a reported hit against it with slack, so the last bit does not matter here.
import { WATER_Y } from './naval.ts';

// ---------- the numbers ----------
// its hit points; the first appearance after a round starts, the next one after it has gone, how long it stays (s, from the moment it
// starts to surface); seconds between its attacks, and when enraged (below half its hit points); the team bonus when it is killed and
// when it flees (for the team that dealt more damage; a tie: none); one personal point per MON_PTS_PER damage (rounded)
export const MON_HP = 900, MON_FIRST_S = 300, MON_EVERY_S = 360, MON_LIFE_S = 180, MON_ATK_S = 3.5, MON_RAGE_ATK_S = 2.2,
  MON_KILL_PTS = 150, MON_FLEE_PTS = 60, MON_PTS_PER = 6;
// the damage a hit deals, by what hit it; MON_DMG_K the same by the kind of fire and mhit (k: 0 parcel, 1 bullet, 2 shell, 3 torpedo)
export const MON_DMG = { parcel: 9, shell: 7, torp: 30, bullet: 0.6 };
export const MON_DMG_K = [MON_DMG.parcel, MON_DMG.bullet, MON_DMG.shell, MON_DMG.torp];
// what one of its attacks weighs against a vehicle (the kind 'mon' of HIT_W in client/src/game/tank.ts and server/game.js: a vehicle
// is destroyed at 3, so a tank takes two, a plane one, a ship four within its 20 s); its hits score for nobody
export const MON_HIT_W = { tank: 1.5, plane: 3, ship: 0.9 };

// ---------- its body and how it moves ----------
// About MON_LEN long: head 12, body 28, tail 20. It swims at most MON_V, mostly submerged (the back MON_BACK over the water; it goes
// under the bridges, the piers stop it). Surfacing takes MON_SURF_S (snap.g y from MON_DEEP up to 0), diving MON_DIVE_S, sinking
// when killed (it rolls over first) MON_SINK_S (y down to MON_DEEP again). It rears up (rear 0..1, the front half standing up round
// the hips to MON_REAR_A, the head's middle about 21 over the water) in MON_REAR_S for its water jets and geysers, so it is easier
// to hit then.
export const MON_LEN = 60, MON_V = 6, MON_BACK = 5.5, MON_SURF_S = 4, MON_DIVE_S = 5, MON_SINK_S = 6, MON_DEEP = -16;
export const MON_REAR_A = 1.06, MON_REAR_S = 0.6;
// where it is: (x, z) the middle of its body (between the shoulders and the hips), h its heading (the head points (sin h, cos h)),
// y how far it is under its swimming height (0 out, MON_DEEP gone), rear 0..1
export interface MonPose { x: number; z: number; h: number; y: number; rear: number }
// The hitbox: spheres along the spine, head first, swimming: [along the heading from (x, z), height of the middle over the water,
// radius]. The head and the shoulders turn up round the hips (MON_HIP) by rear · MON_REAR_A; the hips and the tail stay.
// head (12 long, broad and flat), shoulders, hips, tail base, tail tip
const SPINE: [number, number, number][] = [[20, -0.5, 6], [7, -2.5, 8], [-7, -2.5, 8], [-20, -2, 5.5], [-30, -1.5, 4.5]];
const MON_HIP = 2;                                   // the sphere the front half turns round
export const MON_SPHERES = SPINE.length;

// the spheres at pose p as [x, y, z, r] (y absolute), head first (out: reused when given)
export function monSpheres(p: MonPose, out?: [number, number, number, number][]): [number, number, number, number][] {
  const o = out || SPINE.map(() => [0, 0, 0, 0] as [number, number, number, number]);
  const hx = Math.sin(p.h), hz = Math.cos(p.h), a = (p.rear < 0 ? 0 : p.rear > 1 ? 1 : p.rear) * MON_REAR_A;
  const ca = Math.cos(a), sa = Math.sin(a), [pa, py] = SPINE[MON_HIP];
  for (let i = 0; i < SPINE.length; i++) {
    let [al, ht] = SPINE[i]; const r = SPINE[i][2];
    if (i < MON_HIP) { const d = al - pa, e = ht - py; al = pa + d * ca - e * sa; ht = py + d * sa + e * ca; }
    const s = o[i]; s[0] = p.x + hx * al; s[1] = WATER_Y + ht + p.y; s[2] = p.z + hz * al; s[3] = r;
  }
  return o;
}
const SP = SPINE.map(() => [0, 0, 0, 0] as [number, number, number, number]);
type Sph = [number, number, number, number][];
// The same three tests on spheres computed once (monSpheres) for many points or segments in a frame or a tick:
// is (x, y, z) inside them (give or take slack)?
export function monSphHit(sph: Sph, x: number, y: number, z: number, slack = 0): boolean {
  for (const s of sph) {
    const dx = x - s[0], dy = y - s[1], dz = z - s[2], r = s[3] + slack;
    if (dx * dx + dy * dy + dz * dz <= r * r) return true;
  }
  return false;
}
// where along the segment a → b (0..1) it first enters them, or 2 if never (a bullet)
export function monSphSegT(sph: Sph, ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const dx = bx - ax, dy = by - ay, dz = bz - az, a = dx * dx + dy * dy + dz * dz; let best = 2;
  for (const s of sph) {
    const fx = ax - s[0], fy = ay - s[1], fz = az - s[2], c = fx * fx + fy * fy + fz * fz - s[3] * s[3];
    if (c <= 0) return 0;
    const b = fx * dx + fy * dy + fz * dz, disc = b * b - a * c; if (disc < 0 || a < 1e-9) continue;
    const t = (-b - Math.sqrt(disc)) / a; if (t >= 0 && t <= 1 && t < best) best = t;
  }
  return best;
}
// how far (x, z) is from them, horizontally (0 inside a sphere's circle)
export function monSphDist(sph: Sph, x: number, z: number): number {
  let best = Infinity;
  for (const s of sph) { const d = Math.sqrt((x - s[0]) * (x - s[0]) + (z - s[2]) * (z - s[2])) - s[3]; if (d < best) best = d; }
  return best < 0 ? 0 : best;
}
// is (x, y, z) inside it at pose p (give or take slack)?
export function monHit(p: MonPose, x: number, y: number, z: number, slack = 0): boolean { return monSphHit(monSpheres(p, SP), x, y, z, slack); }
// where along the segment a → b (0..1) it first enters it at pose p, or 2 if never (a bullet)
export function monSegT(p: MonPose, ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  return monSphSegT(monSpheres(p, SP), ax, ay, az, bx, by, bz);
}
// how far (x, z) is from its body at pose p, horizontally (0 inside a sphere's circle): what its attacks and the bots measure
export function monDist(p: MonPose, x: number, z: number): number { return monSphDist(monSpheres(p, SP), x, z); }

// ---------- its attacks ----------
// Every MON_ATK_S (enraged MON_RAGE_ATK_S) it attacks the vehicle that dealt it the most damage in the last MON_THREAT_S and is in
// reach (else the nearest one in reach); the server announces each attack (mon) with where and when it lands, every browser applies
// it to its own vehicle then (monAtkHits), the server to the bots. Reach is measured from its body (monDist).
// - slam: its tail comes down on a ship within MON_SLAM_REACH: a ring of water of radius MON_SLAM_R round where the ship will be,
//   MON_SLAM_WARN s after the announcement (the tail rises meanwhile); every ship in it is hit (and rocks);
// - jet: it rears up (MON_JET_WIND s) and spits a heavy arc of water at a tank on the embankment or a ship within MON_JET_REACH: from
//   (sx, sy, sz) with (vx, vy, vz) at t0, falling at MON_JET_G, landing at (x, y, z) at `at`; every tank and ship within MON_JET_R
//   (the splash) is hit;
// - geyser: under a plane within MON_GEY_REACH horizontally and lower than MON_GEY_BELOW: a warning ring on the water, MON_GEY_WARN s
//   later a column of water of radius MON_GEY_R from the surface up to MON_GEY_TOP (absolute height), where the plane would be by
//   then; every plane in it is hit.
export const MON_THREAT_S = 20;
export const MON_SLAM_REACH = 30, MON_SLAM_R = 14, MON_SLAM_WARN = 1;
export const MON_JET_REACH = 120, MON_JET_R = 6, MON_JET_WIND = 0.7, MON_JET_G = 30;
export const MON_GEY_REACH = 90, MON_GEY_BELOW = 70, MON_GEY_R = 8, MON_GEY_TOP = 80, MON_GEY_WARN = 0.8;
// how much of a vehicle's size counts towards a hit (a ship's hull reaches into the ring, a tank's into the splash, a plane's wings
// into the column)
const PAD = [2, 2.4, 4];
// An attack as the mon message carries it (docs/PROTOCOL.md): a its kind, i its number, v the vehicle it was aimed at, (x, y, z)
// where it lands (y the surface there; a geyser's base), r its radius, at the moment it lands (the server's clock, ms); a jet also its
// start (sx, sy, sz) at t0 and its velocity.
export interface MonAtk {
  a: 'slam' | 'jet' | 'geyser'; i: number; v: number; x: number; y: number; z: number; r: number; at: number;
  t0?: number; sx?: number; sy?: number; sz?: number; vx?: number; vy?: number; vz?: number;
}
// does attack A, when it lands, hit a vehicle of kind k (0 tank, 1 plane, 2 ship) at (x, y, z)?
export function monAtkHits(A: MonAtk, k: number, x: number, y: number, z: number): boolean {
  if (A.a === 'slam' ? k !== 2 : A.a === 'jet' ? k === 1 : k !== 1) return false;
  const dx = x - A.x, dz = z - A.z, r = A.r + PAD[k];
  if (dx * dx + dz * dz > r * r) return false;
  return A.a !== 'geyser' || (y <= MON_GEY_TOP && y >= A.y - 2);
}
// where a jet's water is at time t (server clock, ms), between t0 and at: into out [x, y, z]
export function monJetAt(A: MonAtk, t: number, out: number[] = [0, 0, 0]): number[] {
  const at = A.at > (A.t0 ?? 0) ? A.at : (A.t0 ?? 0), s = ((t < (A.t0 ?? 0) ? A.t0 ?? 0 : t > at ? at : t) - (A.t0 ?? 0)) / 1000;
  out[0] = (A.sx ?? A.x) + (A.vx ?? 0) * s; out[1] = (A.sy ?? A.y) + (A.vy ?? 0) * s - MON_JET_G * s * s / 2; out[2] = (A.sz ?? A.z) + (A.vz ?? 0) * s;
  return out;
}
