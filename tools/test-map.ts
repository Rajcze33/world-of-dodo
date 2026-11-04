// World of DODO, issue #16: the tests of the shared city core (client/shared/geom.ts, map.ts, site.ts) on the real data
// (client/shared/karlin.json). Run: node tools/test-map.ts (Node 24 runs the TypeScript as it is). Exits with 1 on a failure.
// It checks the plane geometry on tricky shapes, the collisions against every building of the arena and under the Negrelli
// viaduct, the ground, the spawn points, the parked cars' spots, the pedestrians' loops, the street graph, and how fast the hot
// functions are (they run many times a frame on the client and for every car and bot at 20 Hz on the server).
import {
  pointInPoly, closestOnPoly, segPoly, polyArea, polyBox, insetPoly, offsetPolyline, polylineCum, polylineAt, simplify, Hash, astar,
} from '../client/shared/geom.ts';
import {
  DATA, ARENA, SOLIDS, LOW_Y, NODES, EDGES, BLOCKS, SPAWNS, KERB_SPOTS, KERB_OUT, TRAM_LOOP, SITE, DEPOT, BUILD_MS, AIR_LIM, PED_IN, PED_OUT,
  solidPush, segHit, solidAt, freeAt, groundH, terrainH, onRoad, paved, route, edgeBetween, edgePos, nearestEdge, nearestNode, lineHit,
  solidNear, solidHit, type Solid,
} from '../client/shared/map.ts';
import { makeSite } from '../client/shared/site.ts';

declare const process: { exitCode: number; argv: string[] };
let fails = 0, checks = 0;
const ok = (c: boolean, msg: string) => { checks++; if (!c) { fails++; if (fails < 60) console.log('  FAIL ' + msg); } };
const near = (a: number, b: number, e = 1e-6) => Math.abs(a - b) <= e;
const f2 = (v: number) => v.toFixed(2);
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const section = (s: string) => console.log('- ' + s);

// ---------- geom ----------
section('geom');
{
  const sqr = [0, 0, 10, 0, 10, 10, 0, 10];                                     // interior on the right: positive area
  ok(polyArea(sqr) === 100, 'square area +100');
  ok(pointInPoly(sqr, 5, 5) && !pointInPoly(sqr, 15, 5) && !pointInPoly(sqr, -1e-9, 5), 'square in/out');
  ok(pointInPoly(sqr, 0, 5) && pointInPoly(sqr, 10, 5) && pointInPoly(sqr, 5, 0) && pointInPoly(sqr, 5, 10), 'edges count as inside');
  ok(pointInPoly(sqr, 0, 0) && pointInPoly(sqr, 10, 10) && pointInPoly(sqr, 10, 0), 'vertices count as inside');
  const U = [-25, 10, -15, 10, -15, 40, 15, 40, 15, 10, 25, 10, 25, 52, -25, 52];   // a U, its notch open to the north
  ok(polyArea(U) > 0, 'U positive');
  ok(!pointInPoly(U, 0, 20) && pointInPoly(U, -20, 20) && pointInPoly(U, 0, 45), 'U notch is outside, arms inside');
  ok(!pointInPoly(U, -30, 10) && !pointInPoly(U, 30, 40) && !pointInPoly(U, 0, 10), 'rays through vertices of the U');
  ok(pointInPoly(U, -15, 25) && pointInPoly(U, 15, 40) && pointInPoly(U, 0, 40), 'U boundary inside');
  const tri = [0, 0, 10, 5, 0, 10];
  ok(!pointInPoly(tri, -1, 5) && pointInPoly(tri, 1, 5) && !pointInPoly(tri, 11, 5) && pointInPoly(tri, 10, 5), 'triangle apex row');
  let c = closestOnPoly(sqr, 5, -3); ok(near(c.x, 5) && near(c.z, 0) && near(c.d2, 9) && near(c.nx, 0) && near(c.nz, -1), 'closest north, normal out (0,-1)');
  c = closestOnPoly(sqr, 8, 5); ok(near(c.x, 10) && near(c.nx, 1) && near(c.d2, 4), 'closest from inside: east wall, normal (1,0)');
  c = closestOnPoly(U, 0, 30); ok(near(c.z, 40) && near(c.nz, -1), 'closest in the notch: its bottom, normal north');
  c = closestOnPoly(U, -14, 20); ok(near(c.x, -15) && near(c.nx, 1), 'inside an arm: notch wall, normal east');
  ok(segPoly(U, 0, 0, 0, 30) === 2, 'segment into the notch misses');
  ok(near(segPoly(U, 0, 0, 0, 50), 40 / 50), 'segment through the notch hits the bottom');
  ok(near(segPoly(U, -40, 20, 40, 20), 15 / 80), 'segment across the arms enters at the first arm');
  ok(segPoly(U, -20, 20, 0, 20) === 0, 'starting inside: 0');
  ok(near(segPoly(sqr, -5, 0, 15, 0), 0.25), 'collinear along an edge touches');
  ok(near(segPoly(sqr, -5, -5, 0, 0), 1), 'touching a vertex at the end');
  // inset: a square, a U with thin arms (they vanish), a thin strip (gone), a dumbbell (the bigger part stays)
  let q = insetPoly(sqr, 1); ok(!!q && near(polyArea(q), 64, 1e-6), 'inset square 8x8');
  q = insetPoly(U, 5.5); ok(!!q && polyArea(q) > 30 && polyArea(q) < 45, 'inset U by 5.5: arms (10 wide) gone, a strip of the base left');
  if (q) for (let i = 0; i < q.length; i += 2) ok(pointInPoly(U, q[i], q[i + 1]) && closestOnPoly(U, q[i], q[i + 1]).d2 > 5.45 * 5.45, 'inset U point ' + i + ' at least 5.5 in (a dropped arm may cost a little)');
  ok(insetPoly(U, 6.5) === null, 'inset U by 6.5: nothing left');
  q = insetPoly(U, 2); ok(!!q && polyArea(q) > 0, 'inset U by 2');
  if (q) for (let i = 0; i < q.length; i += 2) { const d = Math.sqrt(closestOnPoly(U, q[i], q[i + 1]).d2); ok(d > 2 - 1e-6 && d < 2 * Math.SQRT2 + 1e-6 && pointInPoly(U, q[i], q[i + 1]), 'inset U by 2: point ' + i + ' 2 in (2√2 at a concave corner)'); }
  ok(insetPoly([0, 0, 30, 0, 30, 2, 0, 2], 1.4) === null, 'thin strip collapses');
  const db = [0, 0, 20, 0, 20, 8, 22, 8, 22, 0, 32, 0, 32, 10, 22, 10, 22, 9, 20, 9, 20, 20, 0, 20];   // two rooms, a 1-wide neck
  q = insetPoly(db, 1.4); ok(!!q && polyArea(q) > 250 && polyBox(q)[2] < 20, 'dumbbell: the big room stays, the neck goes');
  const spike = [0, 0, 40, 0, 40, 10, 20.2, 10, 20, 30, 19.8, 10, 0, 10];          // a thin spike sticking out
  q = insetPoly(spike, 1.4); ok(!!q && polyBox(q)[3] < 10, 'thin spike dropped');
  const zig: number[] = []; for (let k = 0; k <= 20; k++) zig.push(k * 3, k % 2 ? 1 : 0); for (let k = 20; k >= 0; k--) zig.push(k * 3, 30);
  q = insetPoly(zig, 1.4); ok(!!q && polyArea(q) > 0, 'zigzag kerb inset');
  // offsets, arc lengths, simplify, hash, A*
  const o = offsetPolyline([0, 0, 10, 0, 10, 10], 1); ok(o.length === 6 && near(o[0], 0) && near(o[1], 1) && near(o[2], 9) && near(o[3], 1) && near(o[4], 9) && near(o[5], 10), 'offset right of a right turn');
  const sharp = offsetPolyline([0, 0, 10, 0, 0, 1], 1); ok(sharp.length === 8, 'sharp turn bevelled');
  const cum = polylineCum([[0, 0], [10, 0], [10, 10]], true); ok(cum.length === 4 && near(cum[3], 20 + Math.sqrt(200)), 'closed cum');
  let a = polylineAt([[0, 0], [10, 0], [10, 10]], cum, 15); ok(near(a.x, 10) && near(a.z, 5) && near(a.hz, 1), 'polylineAt');
  a = polylineAt([0, 0, 10, 0, 10, 10], cum, cum[3] + 5); ok(near(a.x, 5) && near(a.z, 0), 'closed wraps round');
  a = polylineAt([0, 0, 10, 0], [0, 10], 99); ok(near(a.x, 10), 'open clamps');
  ok(simplify([0, 0, 5, 0.01, 10, 0, 10, 10, 0, 10], 0.25).length === 8, 'simplify drops a near-collinear point');
  const H = new Hash<number>(-100, -100, 100, 100, 16); H.add([-50, -50, 50, 50], 1); H.add([60, 60, 70, 70], 2); H.add([-500, -500, -490, -490], 3);
  ok(H.query(-60, -60, 59, 59).length === 1 && H.query(-60, -60, 60, 60).length === 2 && H.query(-1000, -1000, 1000, 1000).length === 3 && H.query(-495, -495, -494, -494)[0] === 3, 'hash');
  const g = [[1, 2], [0, 3], [0, 3], [1, 2, 4], [3]], P = astar(5, 0, 4, (i, v) => g[i].forEach(j => v(j, 1)), () => 0);
  ok(P.length === 4 && P[0] === 0 && P[3] === 4, 'astar');
  // the site on lots of several sizes: inside its lot, nothing overlapping, the gates free
  for (const [w, d] of [[300, 70], [180, 60], [120, 50], [90, 35], [60, 40], [40, 120]]) {
    const S = makeSite(0, 0, w, d, 0, -1), A = S.area, loose = S.solids.filter(s => !['fence', 'wall', 'column', 'container'].includes(s.kind));
    ok(S.solids.every(s => s.x0 >= A.x0 - 0.41 && s.x1 <= A.x1 + 0.41 && s.z0 >= A.z0 - 0.41 && s.z1 <= A.z1 + 0.41), `site ${w}x${d} inside its fence`);
    let ov = 0; for (let i = 0; i < loose.length; i++) for (let j = i + 1; j < loose.length; j++) { const p = loose[i], r = loose[j]; if (p.x0 < r.x1 && p.x1 > r.x0 && p.z0 < r.z1 && p.z1 > r.z0) ov++; }
    ok(ov === 0, `site ${w}x${d}: loose things do not overlap (${ov})`);
    console.log(`  site on ${w} x ${d}: ${S.solids.length} solids, house ${f2(S.house)}, containers ${f2(S.yard)}, dropped [${S.dropped}], rot ${S.rot}`);
  }
}

// ---------- the data, the solids ----------
section(`data: ${DATA.buildings.length} buildings, ${SOLIDS.length} solids, ${NODES.length} nodes, ${EDGES.length} edges, ${BLOCKS.length} blocks, ${DATA.plazas.length} plazas, ${DATA.lots.length} lots`);
console.log(`  arena ${ARENA.x0}..${ARENA.x1} x ${ARENA.z0}..${ARENA.z1}, AIR_LIM ${AIR_LIM}; build ms ${JSON.stringify(BUILD_MS)}`);
console.log(`  site: ${SITE ? `house ${f2(SITE.house)} containers ${f2(SITE.yard)} dropped [${SITE.dropped}] area ${JSON.stringify(SITE.area)}` : 'off (map.ts SITE_LOT)'}; depot ${JSON.stringify({ x: DEPOT.x, z: DEPOT.z, rot: DEPOT.rot, w: DEPOT.w, d: DEPOT.d, park: DEPOT.park })}`);
const arenaB = SOLIDS.filter(s => s.b !== undefined && !s.far && s.y0 < LOW_Y);
// a point inside a polygon (the centroid if it is in, else a grid search)
const inner = (p: number[]): [number, number] | null => {
  let cx = 0, cz = 0, a = 0; for (let i = 0; i < p.length; i += 2) { const j = (i + 2) % p.length, w = p[i] * p[j + 1] - p[j] * p[i + 1]; a += w; cx += (p[i] + p[j]) * w; cz += (p[i + 1] + p[j + 1]) * w; }
  if (a) { cx /= 3 * a; cz /= 3 * a; if (pointInPoly(p, cx, cz)) return [cx, cz]; }
  const b = polyBox(p); let best: [number, number] | null = null, bd = -1;
  for (let i = 1; i < 12; i++) for (let j = 1; j < 12; j++) { const x = b[0] + (b[2] - b[0]) * i / 12, z = b[1] + (b[3] - b[1]) * j / 12; if (pointInPoly(p, x, z)) { const d = closestOnPoly(p, x, z).d2; if (d > bd) { bd = d; best = [x, z]; } } }
  return best;
};
section(`solidPush: out of each of ${arenaB.length} arena buildings, from inside and from its walls`);
{
  let stuck = 0, crev = 0, edgeBad = 0, edgeN = 0;
  for (const s of arenaB) {
    const c = inner(s.p); if (!c) continue;
    let [x, z] = c; ok(!!solidPush(x, z, 1), `push inside building ${s.b}`);
    for (let it = 0; it < 80; it++) { const w = solidPush(x, z, 1); if (!w) break; x += w.nx * w.pen; z += w.nz * w.pen; }
    // out: the centre left every solid; where the nearest way out is a gap narrower than a tank the circle still touches both sides
    // (a tank never gets there: it is pushed off each wall it comes near, 0.4 at a time)
    const out = !SOLIDS.some(o => o.y0 < LOW_Y && pointInPoly(o.p, x, z)); if (out && (solidPush(x, z, 1)?.pen || 0) > 1e-3) crev++;
    if (!out) { stuck++; if (stuck < 6) console.log(`  stuck in building ${s.b} from ${f2(c[0])},${f2(c[1])}: at ${f2(x)},${f2(z)}`); }
    for (let i = 0; i < s.p.length; i += 2) {                                       // the middle of every wall that faces open ground
      const j = (i + 2) % s.p.length, mx = (s.p[i] + s.p[j]) / 2, mz = (s.p[i + 1] + s.p[j + 1]) / 2, dx = s.p[j] - s.p[i], dz = s.p[j + 1] - s.p[i + 1], l = Math.hypot(dx, dz);
      if (l < 2.5) continue;
      const nx = dz / l, nz = -dx / l;
      if (!freeAt(mx + nx * 1.2, mz + nz * 1.2, 1.1)) continue;                     // a shared wall, a corner, the arena's edge
      edgeN++; const w = solidPush(mx, mz, 1);
      if (!w || w.nx * nx + w.nz * nz < 0.7 || w.pen < 0.99) { edgeBad++; if (edgeBad < 6) console.log(`  wall push of building ${s.b} at ${f2(mx)},${f2(mz)}: ${JSON.stringify(w)} want (${f2(nx)},${f2(nz)})`); }
    }
  }
  console.log(`  ${crev} came out into a gap narrower than a tank (the circle touches both sides; a tank never gets in there)`);
  ok(stuck === 0, `pushed out of every building (${stuck} stuck; ${crev} came out into a gap narrower than a tank)`);
  ok(edgeBad === 0, `walls push outwards (${edgeBad} of ${edgeN} bad)`);
  console.log(`  ${arenaB.length} buildings, ${edgeN} open walls`);
}
section('segHit, solidAt, lineHit, solidNear, solidHit');
{
  let n = 0, miss = 0, over = 0;
  for (let k = 0; k < arenaB.length; k += Math.max(1, Math.floor(arenaB.length / 300))) {
    const s = arenaB[k], c = inner(s.p); if (!c) continue;
    const y = Math.min(s.h - 0.2, (s.y0 + s.h) / 2);
    ok(solidAt(c[0], y, c[1]) !== null, `solidAt inside building ${s.b}`);
    for (let a = 0; a < 8; a++) {                                                   // from a free point outside, straight at it
      const ang = a * Math.PI / 4, sx = c[0] + Math.sin(ang) * 60, sz = c[1] + Math.cos(ang) * 60;
      n++; const t = segHit(sx, y, sz, c[0], y, c[1]);
      if (t >= 1) { miss++; if (miss < 5) console.log(`  segHit missed building ${s.b}`); }
      const top = s.h + 3, t2 = segHit(c[0], top, c[1], c[0] + 0.01, top + 20, c[1]);
      if (t2 < 1 && solidAt(c[0], top + 1, c[1]) === null) over++;
    }
    const h = solidHit(c[0], y, c[1], c[0], s.h + 1, c[1]); ok(!!h && h.n[1] === 1, `solidHit from above lands on the roof of ${s.b}`);
    ok(solidNear(c[0], s.h + 0.3, c[1], 0.9, 0.6) !== null && solidNear(c[0], s.h + 20, c[1], 0.9, 0.6) === null, `solidNear over ${s.b}`);
  }
  ok(miss === 0, `segHit hits every building (${miss} of ${n} missed)`);
  ok(over === 0, `nothing above the roofs (${over})`);
  // a ray along an open street at tank height hits nothing, one at the height of the buildings across the block does
  let roadFree = 0, roadN = 0;
  for (const e of EDGES) {
    if (e.len < 20) continue;
    const p = edgePos(e, 4, 0), q = edgePos(e, e.len - 4, 0);
    if (!freeAt(p.x, p.z, 1) || !freeAt(q.x, q.z, 1)) continue;
    roadN++; if (lineHit(p.x, p.z, q.x, q.z, 1.5) >= 1) roadFree++;
  }
  console.log(`  ${roadFree} of ${roadN} straight-ish streets have a clear line end to end (curved ones need not)`);
}
section('the Negrelli viaduct');
{
  const deck = SOLIDS.filter(s => s.kind === 'deck'), piers = SOLIDS.filter(s => s.kind === 'pier');
  ok(deck.length > 0, 'viaduct has a deck'); ok(piers.length > 0, 'viaduct has piers');
  let under = 0, blocked = 0, pierHit = 0;
  for (const e of EDGES) for (let s = 1; s < e.len; s += 2) {                      // street points under the deck
    const p = edgePos(e, s, 0); if (!inArenaPt(p.x, p.z)) continue;
    const d = deck.find(D => p.x >= D.box[0] && p.x <= D.box[2] && p.z >= D.box[1] && p.z <= D.box[3] && pointInPoly(D.p, p.x, p.z)); if (!d) continue;
    under++;
    if (solidPush(p.x, p.z, 1)) { blocked++; if (blocked < 5) console.log(`  under the viaduct at ${f2(p.x)},${f2(p.z)} a tank is pushed: ${JSON.stringify(solidPush(p.x, p.z, 1))}`); }
    ok(segHit(p.x, 1.5, p.z - 0.01, p.x, 1.6, p.z + 0.01) >= 1, 'tank height free under the deck');
    ok(segHit(p.x, d.h + 5, p.z, p.x, d.y0 - 0.5, p.z) < 1, 'a ray from above hits the deck');
  }
  for (const s of piers.slice(0, 50)) { const c = inner(s.p); if (c && solidPush(c[0], c[1], 1)) pierHit++; }
  ok(under > 0, `streets pass under the viaduct (${under} points)`);
  ok(blocked === 0, `a tank drives under the arches (${blocked} of ${under} blocked)`);
  ok(pierHit === Math.min(50, piers.length), 'piers are solid');
  console.log(`  ${deck.length} deck pieces, ${piers.length} piers, ${under} street points under the deck`);
}
// on a carriageway: within half its width of a street's centre line (the streets win over the block polygons)
function street(x: number, z: number) {
  for (const e of EDGES) for (let k = 0; k + 1 < e.pts.length; k++) {
    const [ax, az] = e.pts[k], [bx, bz] = e.pts[k + 1], dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0, qx = ax + dx * t - x, qz = az + dz * t - z;
    if (qx * qx + qz * qz <= e.w * e.w / 4) return true;
  }
  return false;
}
function inArenaPt(x: number, z: number) { return x > ARENA.x0 + 1 && x < ARENA.x1 - 1 && z > ARENA.z0 + 1 && z < ARENA.z1 - 1; }

// ---------- the ground ----------
section('groundH');
{
  let bad0 = 0, n0 = 0, bad3 = 0, n3 = 0;
  for (const e of EDGES) {
    const p = edgePos(e, e.len / 2, 0); if (!inArenaPt(p.x, p.z) || paved(p.x, p.z)) continue;   // a plaza across the street is paved
    n0++; if (groundH(p.x, p.z) !== 0) bad0++;
  }
  for (const B of BLOCKS) for (let i = 0; i < B.ped.length; i += 2) {             // the loop's corners on the pavement (not where it steps
    const x = B.ped[i], z = B.ped[i + 1]; if (!pointInPoly(B.p, x, z) || street(x, z)) continue;   // round a house or crosses a lane)
    n3++; if (groundH(x, z) !== 0.3) bad3++;
  }
  let mid = 0, midN = 0; for (const e of EDGES) { const p = edgePos(e, e.len / 2, 0); if (inArenaPt(p.x, p.z)) { midN++; if (paved(p.x, p.z)) mid++; } }
  ok(bad0 === 0, `0 at road midpoints (${bad0} of ${n0} not)`); ok(bad3 === 0, `0.3 on the pavements (${bad3} of ${n3} not)`);
  ok(mid <= midN * 0.05, `few street midpoints are paved (${mid} of ${midN}: plazas across streets)`);
  ok(groundH(ARENA.x0 - 500, 0) === terrainH(ARENA.x0 - 500, 0), 'terrain outside the arena');
  // the raster against the polygons, at random points
  let diff = 0; for (let k = 0; k < 20000; k++) {
    const x = ARENA.x0 + rnd() * (ARENA.x1 - ARENA.x0), z = ARENA.z0 + rnd() * (ARENA.z1 - ARENA.z0);
    const exact = (BLOCKS.some(B => pointInPoly(B.p, x, z)) || DATA.plazas.some(p => pointInPoly(p, x, z))) && !street(x, z);
    if (exact !== paved(x, z)) diff++;
  }
  ok(diff === 0, `raster = polygons at 20000 random points (${diff} differ)`);
}

// ---------- spawns, kerb spots, pedestrians ----------
section(`${SPAWNS.length} spawns`);
{
  ok(SPAWNS.length >= Math.min(40, 10), 'enough spawn points');
  for (const s of SPAWNS) { ok(freeAt(s.x, s.z, 2.5), `spawn ${f2(s.x)},${f2(s.z)} free`); ok(onRoad(s.x, s.z), `spawn ${f2(s.x)},${f2(s.z)} on a road`); }
  let md = Infinity; for (let i = 0; i < SPAWNS.length; i++) for (let j = i + 1; j < SPAWNS.length; j++) md = Math.min(md, Math.hypot(SPAWNS[i].x - SPAWNS[j].x, SPAWNS[i].z - SPAWNS[j].z));
  const bx = [Math.min(...SPAWNS.map(s => s.x)), Math.max(...SPAWNS.map(s => s.x)), Math.min(...SPAWNS.map(s => s.z)), Math.max(...SPAWNS.map(s => s.z))];
  console.log(`  closest two ${f2(md)} apart; spread x ${f2(bx[0])}..${f2(bx[1])}, z ${f2(bx[2])}..${f2(bx[3])}`);
  ok(bx[1] - bx[0] > (ARENA.x1 - ARENA.x0) * 0.6 && bx[3] - bx[2] > (ARENA.z1 - ARENA.z0) * 0.5, 'spawns spread over the arena');
  ok(freeAt(DEPOT.park.x, DEPOT.park.z, 2.5), 'the depot start point is free');
}
section(`${KERB_SPOTS.length} kerb spots`);
{
  for (const k of KERB_SPOTS) {
    const hx = Math.sin(k.h), hz = Math.cos(k.h);
    let bd = Infinity; for (const B of BLOCKS) bd = Math.min(bd, closestOnPoly(B.p, k.x, k.z).d2);
    ok(!paved(k.x, k.z) && Math.abs(Math.sqrt(bd) - KERB_OUT) < 0.06, `kerb spot ${f2(k.x)},${f2(k.z)} on the road side, ${KERB_OUT} out (${f2(Math.sqrt(bd))})`);
    ok(!solidPush(k.x + hx * 1.2, k.z + hz * 1.2, 1) && !solidPush(k.x - hx * 1.2, k.z - hz * 1.2, 1), `kerb spot ${f2(k.x)},${f2(k.z)} clear of solids`);
    ok(!EDGES[k.e].tram, 'kerb spot not on a tram street');
    for (const n of NODES) if (n.e.length >= 3 && Math.hypot(n.x - k.x, n.z - k.z) < 8) ok(false, `kerb spot ${f2(k.x)},${f2(k.z)} within 8 of junction ${n.i}`);
  }
}
section(`pedestrian loops (${BLOCKS.filter(b => b.pedLen > 0).length} of ${BLOCKS.length} blocks have one)`);
{
  let outB = 0, outOk = 0, inS = 0, n = 0;
  const lowAt = (x: number, z: number) => SOLIDS.some(S => S.y0 < LOW_Y && pointInPoly(S.p, x, z));
  for (const B of BLOCKS) {
    if (!B.pedLen) continue;
    ok(B.pedCum.length === B.ped.length / 2 + 1 && near(B.pedCum[B.pedCum.length - 1], B.pedLen), 'pedCum shape');
    const at = { x: 0, z: 0, hx: 0, hz: 0, k: 0 };
    for (let s = 0; s < B.pedLen; s += 1) {
      polylineAt(B.ped, B.pedCum, s, at); n++;
      if (!pointInPoly(B.p, at.x, at.z)) {                                          // out of the block only to step round a house
        if (Math.sqrt(closestOnPoly(B.p, at.x, at.z).d2) <= PED_OUT + 0.01) outOk++; else outB++;
      }
      if (lowAt(at.x, at.z)) inS++;
    }
  }
  ok(outB === 0, `ped loops inside their blocks (${outB} of ${n} samples farther out than PED_OUT)`);
  ok(inS <= n * 0.005, `ped loops clear of solids (${inS} of ${n} samples inside one; the data's houses on the kerbs)`);
  console.log(`  ${outOk} of ${n} samples step out of the block round a house, ${inS} are inside a solid`);
  const dropped = BLOCKS.filter(b => !b.pedLen).length; console.log(`  ${n} samples; ${dropped} blocks too thin for a loop; inset ${PED_IN}`);
}

// ---------- the street graph ----------
section('street graph');
{
  const seen = new Uint8Array(NODES.length), st = [0]; seen[0] = 1;
  while (st.length) { const i = st.pop() as number; for (const k of NODES[i].e) { const e = EDGES[k], j = e.a === i ? e.b : e.a; if (!seen[j]) { seen[j] = 1; st.push(j); } } }
  const reach = seen.reduce((a, b) => a + b, 0); ok(reach === NODES.length, `graph connected (${reach} of ${NODES.length})`);
  for (const e of EDGES) {
    const A = NODES[e.a], B = NODES[e.b], p0 = e.pts[0], p1 = e.pts[e.pts.length - 1];
    ok(Math.hypot(p0[0] - A.x, p0[1] - A.z) < 0.5 && Math.hypot(p1[0] - B.x, p1[1] - B.z) < 0.5, `edge ${e.i} runs from node a to node b`);
    ok(e.len > 0 && e.w > 0, `edge ${e.i} length and width`);
  }
  for (const n of NODES) if (n.e.length >= 2) for (const k of n.e) ok(n.r < EDGES[k].len * 0.5, `junction radius of ${n.i} fits edge ${k}`);
  let bad = 0;
  for (let k = 0; k < 300; k++) {
    const a = Math.floor(rnd() * NODES.length), b = Math.floor(rnd() * NODES.length), P = route(a, b);
    let good = P.length > 0 && P[0] === a && P[P.length - 1] === b;
    for (let i = 0; good && i + 1 < P.length; i++) if (!edgeBetween(P[i], P[i + 1])) good = false;
    if (!good) bad++;
  }
  ok(bad === 0, `route() connects random pairs (${bad} of 300 bad)`);
  const e0 = EDGES[0], p = edgePos(e0, e0.len / 2, 2), ne = nearestEdge(p.x, p.z);
  ok(!!ne && ne.e === e0 && near(ne.d, 2, 0.05) && ne.off > 0 && near(ne.s, e0.len / 2, 0.5), 'edgePos right offset ↔ nearestEdge');
  ok(nearestNode(NODES[3 % NODES.length].x + 0.1, NODES[3 % NODES.length].z) === 3 % NODES.length, 'nearestNode');
  ok(TRAM_LOOP.pts.length > 2 && TRAM_LOOP.cum.length === TRAM_LOOP.pts.length + 1 && TRAM_LOOP.len > 0, 'tram loop closed');
  ok(TRAM_LOOP.stops.every(s => s >= 0 && s <= TRAM_LOOP.len), 'tram stops on the loop');
}

// ---------- timings ----------
section('timings');
{
  const pts: [number, number][] = [];                                             // where tanks really are: streets, near walls
  for (const s of SPAWNS) pts.push([s.x, s.z]); for (const k of KERB_SPOTS) pts.push([k.x, k.z]);
  for (const B of BLOCKS) for (let i = 0; i < B.p.length; i += 2) pts.push([B.p[i] + 0.5, B.p[i + 1] + 0.5]);
  const nStreet = pts.length;
  while (pts.length < 4000) pts.push([ARENA.x0 + rnd() * (ARENA.x1 - ARENA.x0), ARENA.z0 + rnd() * (ARENA.z1 - ARENA.z0)]);
  const time = (n: number, f: (i: number) => void) => { for (let i = 0; i < Math.min(n, 2000); i++) f(i); const t = performance.now(); for (let i = 0; i < n; i++) f(i); return (performance.now() - t) * 1000 / n; };
  let sink = 0;
  const tp = time(200000, i => { const p = pts[i % pts.length], w = solidPush(p[0], p[1], 1); if (w) sink += w.pen; });
  const tpS = time(200000, i => { const p = pts[i % nStreet], w = solidPush(p[0], p[1], 1); if (w) sink += w.pen; });
  const segs: number[][] = []; for (let k = 0; k < 2000; k++) {
    const p = pts[k % pts.length], a = rnd() * Math.PI * 2; segs.push([p[0], 1.6, p[1], p[0] + Math.sin(a) * 100, 1.6 + rnd() * 10, p[1] + Math.cos(a) * 100]);
  }
  const ts = time(50000, i => { const s = segs[i % segs.length]; sink += segHit(s[0], s[1], s[2], s[3], s[4], s[5]); });
  const tsHigh = time(50000, i => { const s = segs[i % segs.length]; sink += segHit(s[0], 60, s[2], s[3], 70, s[5]); });
  const tg = time(1000000, i => { const p = pts[i % pts.length]; sink += groundH(p[0], p[1]); });
  const tf = time(200000, i => { const p = pts[i % pts.length]; sink += freeAt(p[0], p[1], 2.5) ? 1 : 0; });
  const te = time(100000, i => { const p = pts[i % pts.length]; sink += nearestEdge(p[0], p[1])?.d || 0; });
  const tr = time(2000, i => { sink += route(i % NODES.length, (i * 7919) % NODES.length).length; });
  console.log(`  solidPush ${f2(tp)} µs (${f2(tpS)} on the streets; random points inside houses look for a way out), segHit 100 u ${f2(ts)} µs (over the roofs ${f2(tsHigh)}), groundH ${f2(tg)} µs, freeAt ${f2(tf)} µs, nearestEdge ${f2(te)} µs, route ${f2(tr)} µs (${sink > 0 ? '' : '-'})`);
  ok(tp < 5, `solidPush < 5 µs (${f2(tp)})`); ok(ts < 20, `segHit of 100 u < 20 µs (${f2(ts)})`); ok(tg < 1, `groundH < 1 µs (${f2(tg)})`);
  ok((BUILD_MS.ground || 0) < 150, `ground raster builds in < 150 ms (${BUILD_MS.ground})`);
}
void (0 as unknown as Solid);

console.log(fails ? `FAILED: ${fails} of ${checks} checks` : `ok: ${checks} checks`);
if (fails) process.exitCode = 1;
