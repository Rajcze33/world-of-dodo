// The world as the game code sees it (game/*.ts, net/net.ts, main.ts): where a tank may drive, what a parcel, a bullet, a plane or
// the camera runs into, the height of the ground, where a player starts.
//
// World of DODO, issue #16: the city is the real Karlín now, written once in client/shared/map.ts and run by the server too (server/
// city.js). This file only re-exports what the game code needs from it and adds what only the browser knows: the standing props
// (trees and lamps, world/props.ts). It used to BE the city: the invented 7 × 7 street grid of the original (CELL, ROAD, HALF, the
// buildings as boxes, the square WORLD_LIM the tanks stayed in), with a hand-kept copy on the server.
import { freeAt } from '../../shared/map.ts';
import { propsNear } from './props';

export {
  UNIT_M, DATA, ARENA, AIR_LIM, inArena, SOLIDS, solidsIn, solidPush, segHit, solidAt, solidNear, solidHit, groundH, terrainH, onRoad,
  SPAWNS, DEPOT, SITE, type Solid,
} from '../../shared/map.ts';
// UNIT_M: 1 unit = 1.5 m (it was 5 m). ARENA: where tanks, bots and cars stay (it replaced WORLD_LIM, the ±250 square). AIR_LIM: the
// planes' airspace, ±AIR_LIM round the middle (about 650, from the map's outer zone; it was 450). SOLIDS: footprint polygons extruded
// from y0 to h (they were boxes). solidPush and segHit keep the original's contracts. DEPOT.park: the fallback spawn (was depot.park).

// World of DODO, issue #14: above AIR_TOP a plane's engine loses power
export const AIR_TOP = 220;

// Drivable space: inside the arena, m away from every solid a tank hits (map.ts freeAt) and from the standing props (trees and lamps,
// until a tank knocks them down; only the browser has them).
export function free(x: number, z: number, m: number): boolean {
  if (!freeAt(x, z, m)) return false;
  for (const p of propsNear(x, z)) if (p.state === 'up' && Math.hypot(x - p.x, z - p.z) < p.r + m) return false;
  return true;
}
