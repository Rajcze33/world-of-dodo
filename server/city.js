// The city for the server: the real Karlín of the game, from the very same code the page runs (client/shared/map.ts; Node 24 loads
// the TypeScript by stripping its types). Nothing here is kept in step by hand any more.
//
// World of DODO, issue #16: this file used to mirror the invented 7 × 7 street grid (CELL, HALF, roadC, blockC, TRAM_K, DEPOT_PARK)
// and its buildings as boxes. Those names are gone: the bots and the city's traffic use the street graph (NODES, EDGES, route,
// edgePos, nearestEdge), the spawn points (SPAWNS), the kerb spots (KERB_SPOTS), the tram's loop (TRAM_LOOP) and the depot (DEPOT).
'use strict';

const M = require('../client/shared/map.ts');

// can a parcel get from (x0,z0) to (x1,z1) without an obstacle taller than a parcel flies low (1.5) in between? (the ground line
// against every low solid: the site's thin walls and fence count, the viaduct's deck does not)
function clearLine(x0, z0, x1, z1) { return M.lineHit(x0, z0, x1, z1, 1.5) >= 1; }

// can a bullet fly from a to b without a building in between? (the 3D segment, as segHit in the client)
function clearRay(ax, ay, az, bx, by, bz) { return M.segHit(ax, ay, az, bx, by, bz) >= 1; }

// everything map.ts exports (SOLIDS, solidAt, freeAt, solidPush, segHit, groundH, onRoad, ARENA, NODES, EDGES, route, edgePos,
// nearestEdge, nearestNode, edgeBetween, BLOCKS, SPAWNS, KERB_SPOTS, TRAM_LOOP, SITE, DEPOT, ...) plus the two tests above
module.exports = { ...M, clearLine, clearRay };
