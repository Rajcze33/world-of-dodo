// World of DODO, issue #24: the rules of the team game, the same on the client and the server (Node 24 loads this file by stripping
// its types, server/game.js). Two teams, A (0) and B (1), fight each other, and each vehicle has its own way to win points for its
// team: the tanks capture the three ground zones, the ships the river zone (an owned zone gives its team ZONE_PTS a second), the
// planes bomb the other team's supply depots (DEPOT_PTS for the team that destroys one; the ships' shells and the tanks' parcels
// can hit them too), and every hit scores as before (docs/PROTOCOL.md). A round ends at ROUND_PTS or after ROUND_S seconds.
//
// The places are Karlín's (client/shared/map.ts, the frame in KARLIN-DATA.md: x east, z south, 1 unit = 1.5 m); they were picked
// from the map's data and checked against it when this file was written (issue #24): every ground zone's centre is on a carriageway
// (map.ts onRoad) a tank reaches; the river zone lies on the navigable Vltava (naval.ts inWater) in the main channel north of
// Karlín, about midway between the two teams' ends of the river; every depot stands on open ground (map.ts freeAt with its radius
// and a margin) off the carriageways, which a tank can drive up to and a plane dive onto, in its team's half, at least 100 from every
// zone; at least one of each team's lies within a ship's shell range (about 120) of water a ship can sail. Changing karlin.json
// means checking them again (the smoke test does, tools/smoke.js).
//
// Like everything in client/shared: erasable TypeScript only, no DOM; a result that decides something uses only + - * / (the client
// and the server must agree to the bit, see geom.ts).
import { SPAWNS } from './map.ts';
import { SHIP_SPAWNS } from './naval.ts';

// ---------- the teams ----------
// A is the west (the Negrelli viaduct's side, x < 0), B the east (Forum Karlín's, x >= 0). The colours: a DODO teal-green and an
// orange, a pair that stays apart for colour-blind eyes too and reads on the night map and in the HUD (a player keeps their own
// vehicle colour; the team shows on the name tags, the scoreboard, the minimap, the HUD and a small flag on every vehicle).
export const TEAM_N = 2;
export const TEAM_NAME = ['A', 'B'];
export const TEAM_COL: [number, number] = [0x1fc8a0, 0xff8a1f];

// is x in that team's half (its home side: where it spawns, where its depots stand)?
export function homeSide(team: 0 | 1, x: number): boolean { return team === 0 ? x < 0 : x >= 0; }

// ---------- the numbers ----------
// capture: progress per second for every vehicle inside, at most CAP_MAX of a team count; points a second an owned zone gives;
// a depot's hit points, the points for destroying one, the seconds until it is rebuilt; a round: the points that win it, its
// length, the intermission after it (s); the members of a team, humans and bots (the server's TEAM_SIZE env overrides it)
export const CAP_RATE = 12, CAP_MAX = 3, ZONE_PTS = 1, DEPOT_HP = 6, DEPOT_PTS = 30, DEPOT_BACK_S = 90, ROUND_PTS = 1000,
  ROUND_S = 900, INTER_S = 15, TEAM_SIZE = 6;
// issue #24 (the lead, 4. 11.): a zone's capture is worth CAP_PTS to every vehicle of the team inside it at that moment, and a destroyed
// depot's DEPOT_PTS go to whoever destroyed it as well as to the team, so tanks, ships and bombers show in the personal scores too
export const CAP_PTS = 10;
// what a hit takes off a depot: a parcel (a tank's or a plane's) or a ship's shell that comes down within DEPOT_NEAR of it, a bullet
// that hits it (a torpedo never reaches one)
export const DEPOT_DMG = { parcel: 2, shell: 1.5, bullet: 0.25 };
export const DEPOT_NEAR = 4;

// ---------- the zones ----------
// 3 ground zones (tanks only) then the river zone (ships only), radius r. Capture progress runs from -100 (B owns it) to +100 (A).
// - Viadukt: the junction of Sokolovská and Prvního pluku under the Negrelli viaduct (A's side);
// - Náměstí: Křižíkova in front of the church of Sts Cyril and Methodius on Karlínské náměstí, between the square's park and the
//   church (a little west of the middle: the church stands there);
// - Forum: Pernerova in front of Forum Karlín, with the empty lot south of it (B's side);
// - Vltava: mid-river in the main channel north of Karlín (the island and the side channel by the arena lie south of it), where
//   both teams' ships come in from their own end of the river.
export interface Zone { i: number; name: string; x: number; z: number; r: number; sea: boolean }
export const ZONES: Zone[] = [
  { i: 0, name: 'Viadukt', x: -292, z: -55, r: 24, sea: false },
  { i: 1, name: 'Náměstí', x: -16, z: 41, r: 24, sea: false },
  { i: 2, name: 'Forum', x: 284, z: 171, r: 24, sea: false },
  { i: 3, name: 'Vltava', x: 10, z: -383, r: 45, sea: true },
];

// the zone a vehicle at (x, z) stands in (sea: a ship, which counts only in the river zone; else a tank, only in the ground zones),
// or -1
export function zoneAt(x: number, z: number, sea: boolean): number {
  for (const q of ZONES) {
    if (q.sea !== sea) continue;
    const dx = x - q.x, dz = z - q.z;
    if (dx * dx + dz * dz <= q.r * q.r) return q.i;
  }
  return -1;
}

// one step of a zone's capture: a and b, the living vehicles of A and B inside (at most CAP_MAX each count, the two sides cancel out),
// move the progress CAP_RATE a second each towards their side (+100 A, -100 B)
export function capStep(progress: number, a: number, b: number, dt: number): number {
  const n = (a < CAP_MAX ? a : CAP_MAX) - (b < CAP_MAX ? b : CAP_MAX), p = progress + n * CAP_RATE * dt;
  return p > 100 ? 100 : p < -100 ? -100 : p;
}
// who owns the zone after a step (-1 nobody, 0 A, 1 B): a team takes it at ±100, and loses it when the progress crosses 0
export function capOwner(owner: number, progress: number): number {
  if (progress >= 100) return 0;
  if (progress <= -100) return 1;
  if (owner === 0 && progress <= 0) return -1;
  if (owner === 1 && progress >= 0) return -1;
  return owner;
}

// ---------- the supply depots ----------
// 4 of A then 4 of B, each a cluster of fuel tanks and crates (client/src/world) of radius r and height h on the ground at y, its
// front (direction (sin rot, cos rot)) towards the nearest street. A's: the empty lot in the north-west (A0, within a shell's reach of the
// river's side channel), the courtyard of the Karlín barracks (A1), the yard by Rohanské nábřeží (A2), the railway's edge south of
// Pernerova (A3). B's: the lots by U Mlýnského kanálu (B0, B1: within a shell's reach of the river), the lot by Šaldova (B2), the
// yard west of Thámova (B3).
// A standing depot is solid: a tank cannot enter a circle of DEPOT_SOLID · r round its middle (a little inside the drawing, so a tank
// gets close to the crates), a plane that comes within r of its middle below its top (and down to 1.5 under its ground) crashes
// (client/src/world/objectives.ts for the players, server/bots.js and server/planebot.js for the bots). A destroyed one is a ruin
// anything passes.
export const DEPOT_SOLID = 0.85;
export interface Depot { i: number; team: 0 | 1; x: number; z: number; y: number; r: number; h: number; rot: number }
export const DEPOTS: Depot[] = [
  { i: 0, team: 0, x: -236.7, z: -149, y: 0.3, r: 5, h: 4, rot: 2.823 },
  { i: 1, team: 0, x: -214.7, z: 89, y: 0.3, r: 5, h: 4, rot: -0.236 },
  { i: 2, team: 0, x: -118.7, z: -121, y: 0.3, r: 5, h: 4, rot: 2.674 },
  { i: 3, team: 0, x: -116.7, z: 189, y: 0.3, r: 5, h: 4, rot: -3.125 },
  { i: 4, team: 1, x: 127.3, z: -191, y: 0.3, r: 5, h: 4, rot: 1.612 },
  { i: 5, team: 1, x: 215.3, z: -201, y: 0.3, r: 5, h: 4, rot: -1.53 },
  { i: 6, team: 1, x: 319.3, z: 65, y: 0.3, r: 5, h: 4, rot: 1.597 },
  { i: 7, team: 1, x: 155.3, z: 91, y: 0.3, r: 5, h: 4, rot: 1.606 },
];
// The depot a projectile of kind k (0 a parcel, 1 a bullet, 2 a shell) at (x, y, z) hits, or -1. A parcel or a shell counts where it
// comes down (bursts, or first touches the ground) within r + DEPOT_NEAR of a depot's middle, no higher than its top; a bullet where it
// enters the depot (radius r, up to its top). The browser that fired it asks this and reports the hit (thit); the server checks it
// again (server/game.js) and flies the bots' own the same way.
export function depotAt(x: number, y: number, z: number, k: number): number {
  for (const d of DEPOTS) {
    const dx = x - d.x, dz = z - d.z, R = k === 1 ? d.r : d.r + DEPOT_NEAR;
    if (dx * dx + dz * dz <= R * R && y <= d.y + d.h) return d.i;
  }
  return -1;
}

// ---------- where a team's vehicles come in ----------
// The tanks: the map's spawn points (map.ts SPAWNS) in the team's half, none inside a ground zone or right at its edge (a tank that
// came in there would capture it for free); the ships: the river's (naval.ts SHIP_SPAWNS) in the team's half, none within SHIP_IN_M
// of the river zone; the planes: at the edge of the airspace (game/plane.ts, server/planebot.js) where x is on the team's side and
// at least PLANE_SIDE_X from the middle. A list that comes out empty falls back to all spawn points.
export const SPAWN_ZONE_M = 8, SHIP_IN_M = 130, PLANE_SIDE_X = 150;
const outside = (x: number, z: number) => ZONES.every(q => q.sea || (x - q.x) * (x - q.x) + (z - q.z) * (z - q.z) > (q.r + SPAWN_ZONE_M) * (q.r + SPAWN_ZONE_M));
const RZ = ZONES[3];
function sides<T extends { x: number; z: number }>(all: T[], ok: (p: T) => boolean): [T[], T[]] {
  const pick = (t: 0 | 1) => { const l = all.filter(p => homeSide(t, p.x) && ok(p)); return l.length ? l : all.slice(); };
  return [pick(0), pick(1)];
}
export const TEAM_SPAWNS = sides(SPAWNS, p => outside(p.x, p.z));
export const TEAM_SHIP_SPAWNS = sides(SHIP_SPAWNS, p => (p.x - RZ.x) * (p.x - RZ.x) + (p.z - RZ.z) * (p.z - RZ.z) >= SHIP_IN_M * SHIP_IN_M);
