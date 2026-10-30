// The city of client/index.html as plain numbers, for the server's bots: the street grid and the solid
// buildings. It must stay in step with the client (CELL, HALF, roadC, blockC, the *_B blocks and SOLIDS
// there); if the city changes in the game, change it here too.
'use strict';

const CELL = 52, HALF = 156;
const roadC = k => -HALF + CELL * k;          // street centre lines, k = 0..6 (junctions at roadC(i), roadC(j))
const blockC = i => -130 + CELL * i;          // block centres, i = 0..5
const DEPOT_B = [0, 0], PARK_B = [1, 2], PLAZA_B = [3, 3], RIVAL_B = [5, 5];
const TRAM_K = 3;                             // the tram runs along the street z = roadC(3)

// Axis-aligned boxes: block buildings, the two depot halls, the church in the park (same list as the client).
const SOLIDS = (() => {
  const s = [], open = [DEPOT_B, PLAZA_B, PARK_B, RIVAL_B].map(b => b.join(','));
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
    if (open.includes(i + ',' + j)) continue;
    const bx = blockC(i), bz = blockC(j);
    s.push({ x0: bx - 16, x1: bx + 16, z0: bz - 16, z1: bz + 16, h: 17 });
  }
  let bx = blockC(DEPOT_B[0]), bz = blockC(DEPOT_B[1]);
  s.push({ x0: bx - 17, x1: bx + 5, z0: bz - 16, z1: bz + 16, h: 10.5 });
  bx = blockC(RIVAL_B[0]); bz = blockC(RIVAL_B[1]);
  s.push({ x0: bx - 5, x1: bx + 17, z0: bz - 16, z1: bz + 16, h: 10.5 });
  bx = blockC(PARK_B[0]); bz = blockC(PARK_B[1]);
  s.push({ x0: bx - 5, x1: bx + 5, z0: bz - 12, z1: bz + 8, h: 15 });
  for (const sx of [-1, 1]) s.push({ x0: bx + sx * 5.6 - 2, x1: bx + sx * 5.6 + 2, z0: bz + 7.5, z1: bz + 11.5, h: 31 });
  return s;
})();

// the building a point is inside of, or null
function solidAt(x, y, z) {
  for (const b of SOLIDS) if (x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1 && y < b.h) return b;
  return null;
}

// can a parcel get from (x0,z0) to (x1,z1) without a building in between (at parcel height, 2 units apart)?
function clearLine(x0, z0, x1, z1) {
  const d = Math.hypot(x1 - x0, z1 - z0), n = Math.ceil(d / 2);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (solidAt(x0 + (x1 - x0) * t, 1.5, z0 + (z1 - z0) * t)) return false;
  }
  return true;
}

// is (x,z) open ground, at least m from every building and inside the world? (the client's free(), without its trees and lamps)
const WORLD_LIM = 250;
function freeAt(x, z, m) {
  if (Math.abs(x) > WORLD_LIM - m || Math.abs(z) > WORLD_LIM - m) return false;
  for (const b of SOLIDS) if (x > b.x0 - m && x < b.x1 + m && z > b.z0 - m && z < b.z1 + m) return false;
  return true;
}

const DEPOT_PARK = [-107.5, -130];            // where the original van started; no car is placed near it

module.exports = { CELL, HALF, roadC, blockC, TRAM_K, SOLIDS, DEPOT_PARK, solidAt, clearLine, freeAt };
