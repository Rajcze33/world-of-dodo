// World of DODO, issue #16: the ground of the real Karlín and what runs on it: the carriageways (one dark plane over the arena: the
// street graph's faces, the blocks, stand on it, so whatever is not a block is street), the raised pavements (the blocks' kerb
// polygons at 0.3 with a kerb edge, as map.ts groundH says), the paved squares and the parks on them, lane dashes on the wider
// streets, zebra crossings at the junctions, the tram's rails along the track it drives (client/shared/tram.ts) and its stops'
// shelters, the other tram tracks round the city, and the railway: on the ground, on bridges (decks on piers, as map.ts's solids),
// and the Negrelli viaduct's stone arches between its piers.
// Replaces the original's 7 × 7 grid of roads and rounded blocks.
import {
  DATA, ARENA, NODES, EDGES, BLOCKS, SOLIDS, TRAM_LOOP, VIADUCT_W, PIER_STEP, PIER_L, groundH, terrainH, paved, inArena, edgePos,
  freeAt, solidsIn,
} from '../../shared/map.ts';
import { polylineCum, polylineAt, polyCentroid, distSeg2, type At } from '../../shared/geom.ts';
import { TRAM_PATH, TRAM_STOP_AT } from '../../shared/tram.ts';
import { Bucket, quad, boxB, bake, geoMesh, rotateX, planeGeo, type P3 } from '../core/geo';
import { lambert, M } from '../core/mat';
import { COL } from '../core/colors';
import { wall, capUp, faceN, prism, orient } from './poly';
import { tileB } from './tiles';
import { shade } from './buildings';

const KERB = 0xb4b8b6, PAVE = 0xe4e7e6, PLAZA = 0xdcd8cf, PARK = 0xf7f9f8, MARK = COL.c20, RAIL = COL.grey, BED = 0x9a9893,
  STONE = 0xb8ad9a, STONE_D = 0x8f8778, STEEL = 0x5f6866, FAR_ROAD = 0x5b6260;
const RAIL_HALF = 0.55;                                       // half the track gauge (a little wider than 1.435 m: cartoon)
export const SHELTERS: { x: number; z: number; a: number }[] = [];   // the tram stops' shelters (city.ts keeps lamps and trees off them)

// the buckets of this module (baked at the end of buildRoads)
let PV = Bucket(), DECO = Bucket(), MK = Bucket();
// the material for things lying on another surface: drawn in front of it (polygon offset), so they never flicker far off
const decal = (units: number) => { const m = lambert(0xffffff); m.zOffset = -units / 4; m.zOffsetUnits = -units; return m; };

// a flat strip lying on the ground along the polyline pts (pairs), from offset o0 to o1 to the right of it, dy above the ground
function strip(bk: Bucket, pts: [number, number][], o0: number, o1: number, dy: number, col: number, gy: (x: number, z: number) => number = groundH) {
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1], dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz); if (l < 1e-6) continue;
    const rx = -dz / l, rz = dx / l, P = (x: number, z: number, o: number): P3 => { const X = x + rx * o, Z = z + rz * o; return [X, gy(X, Z) + dy, Z]; };
    faceN(bk, [P(ax, az, o0), P(bx, bz, o0), P(bx, bz, o1), P(ax, az, o1)], [0, 1, 0], col);
  }
}
// the polyline (flat or pairs) cut into pieces of at most step, as pairs (so a strip on the ground follows it)
function dense(p: ArrayLike<number> | [number, number][], step: number, closed = false): [number, number][] {
  const pts: [number, number][] = typeof p[0] === 'number' ? [] : (p as [number, number][]).map(q => [q[0], q[1]] as [number, number]);
  if (typeof p[0] === 'number') { const f = p as ArrayLike<number>; for (let i = 0; i + 1 < f.length; i += 2) pts.push([f[i], f[i + 1]]); }
  if (closed && pts.length) pts.push([pts[0][0], pts[0][1]]);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
    for (let k = 0; k < n; k++) out.push([ax + (bx - ax) * k / n, az + (bz - az) * k / n]);
  }
  if (pts.length) out.push(pts[pts.length - 1]);
  return out;
}
// two rails (and a gravel bed under them when bed) along a dense polyline
function rails(pts: [number, number][], dy: number, bed: boolean, gy?: (x: number, z: number) => number) {
  if (bed) strip(MK, pts, -1.6, 1.6, dy, BED, gy);
  strip(MK, pts, -RAIL_HALF - 0.08, -RAIL_HALF + 0.08, dy + 0.03, RAIL, gy); strip(MK, pts, RAIL_HALF - 0.08, RAIL_HALF + 0.08, dy + 0.03, RAIL, gy);
}

export function buildRoads() {
  PV = Bucket(); DECO = Bucket(); MK = Bucket(); SHELTERS.length = 0;
  // the carriageways: one plane over the arena at 0 (the terrain outside it lies a hair lower, land.ts)
  const A = ARENA, asphalt = geoMesh('streets', rotateX(planeGeo(A.x1 - A.x0, A.z1 - A.z0), -Math.PI / 2), M.road, false, true);
  asphalt.position.set((A.x0 + A.x1) / 2, 0, (A.z0 + A.z1) / 2); asphalt.freezeWorldMatrix();
  // the pavements: every block raised to 0.3 with its kerb
  for (const B of BLOCKS) {
    const p = B.p, n = p.length;
    for (let i = 0; i < n; i += 2) { const j = (i + 2) % n; wall(PV, p[i], p[i + 1], p[j], p[j + 1], 0, 0.3, KERB); }
    capUp(PV, p, 0.3, PAVE);
  }
  // the squares (paved, a little warmer than the pavements) and the parks lying on the blocks (fresh snow)
  for (const q of DATA.plazas) capUp(DECO, orient(q), 0.315, PLAZA);
  for (const q of DATA.parks) if (onBlocks(q)) capUp(DECO, orient(q), 0.33, PARK);
  // World of DODO, issue #16 (4. 11.): the streets of Prague round the arena, for the planes: strips lying on the terrain (or on a
  // bridge's deck), going on where the arena's streets leave it
  for (const r of DATA.farRoads || []) {
    const y = r.y, gy = y === undefined ? terrainH : () => y;
    strip(MK, dense(r.pts, 5), -r.w / 2, r.w / 2, y === undefined ? 0.06 : 0.25, FAR_ROAD, gy);
  }
  laneDashes(); zebras(); tram(); railway();
  bake('pavements', PV, lambert(0xffffff), false);
  bake('squares', DECO, decal(4), false);
  bake('roadMarks', MK, decal(8), false);
  PV = Bucket(); DECO = Bucket(); MK = Bucket();
}
// a park polygon is drawn only where it lies wholly on the raised blocks (else it would cover a street at the wrong height)
function onBlocks(q: number[]): boolean {
  let any = false;
  for (let i = 0; i < q.length; i += 2) { if (!inArena(q[i], q[i + 1])) return false; any = true; if (!paved(q[i], q[i + 1])) return false; }
  const [cx, cz] = polyCentroid(q); return any && paved(cx, cz);
}

// lane dashes along the middle of the wider streets (two lanes), not on the tram's street, not in the junctions
function laneDashes() {
  const at = { x: 0, z: 0, hx: 0, hz: 1 };
  for (const e of EDGES) {
    if (e.w < 6.4 || e.tram || e.c > 2) continue;
    const s0 = NODES[e.a].r + 3, s1 = e.len - NODES[e.b].r - 3;
    for (let s = s0 + 1; s < s1 - 1; s += 4.5) {
      edgePos(e, s, 0, at); if (paved(at.x, at.z)) continue;
      const ax = at.x - at.hx, az = at.z - at.hz, bx = at.x + at.hx, bz = at.z + at.hz, rx = -at.hz * 0.09, rz = at.hx * 0.09;
      quad(MK, [ax - rx, 0.02, az - rz], [ax + rx, 0.02, az + rz], [bx + rx, 0.02, bz + rz], [bx - rx, 0.02, bz - rz], MARK);
    }
  }
}
// zebra crossings: on every street into a junction of three or more (not on the arena's edge), just outside the junction
function zebras() {
  const at = { x: 0, z: 0, hx: 0, hz: 1 };
  for (const N of NODES) {
    if (N.e.length < 3 || !inArena(N.x, N.z, 8)) continue;
    for (const k of N.e) {
      const e = EDGES[k]; if (e.w < 4.5 || e.c > 3 || e.len < 2 * N.r + 9) continue;
      const d = N.r + 1.6; edgePos(e, e.a === N.i ? d : e.len - d, 0, at);
      if (paved(at.x, at.z)) continue;
      const rx = -at.hz, rz = at.hx, hx = at.hx * 1.2, hz = at.hz * 1.2;
      for (let o = -e.w / 2 + 0.6; o <= e.w / 2 - 0.6 + 1e-6; o += 0.9) {
        const cx = at.x + rx * o, cz = at.z + rz * o, wx = rx * 0.22, wz = rz * 0.22;
        faceN(MK, [[cx - wx - hx, 0.025, cz - wz - hz], [cx - wx + hx, 0.025, cz - wz + hz], [cx + wx + hx, 0.025, cz + wz + hz], [cx + wx - hx, 0.025, cz + wz - hz]], [0, 1, 0], MARK);
      }
    }
  }
}

// ---------- the tram ----------
// Rails along the track the tram really drives (client/shared/tram.ts TRAM_PATH: the data's loop, pulled in towards Sokolovská's
// middle so that a tram fits on its narrow carriageway, the turning loops outside the arena on a gravel bed), the other tram tracks
// of the outer zone (where they are not the loop's own), and a shelter at every stop on the right of the track (the doors' side)
function tram() {
  const P = TRAM_PATH.pts; if (P.length < 2) return;
  const track: [number, number][] = []; for (let i = 0; i < P.length; i += 2) track.push(P[i]);   // a point every ~2 units is enough
  track.push(P[0]);
  rails(track, 0.035, false);
  const out: [number, number][][] = []; let cur: [number, number][] = [];
  for (const q of track) { if (!inArena(q[0], q[1], -2)) cur.push(q); else if (cur.length) { out.push(cur); cur = []; } }
  if (cur.length) out.push(cur);
  for (const c of out) if (c.length > 1) strip(MK, c, -1.5, 1.5, 0.02, BED);
  // the other tracks: segments at least 3.5 from the loop (TRAM_LOOP: the data's own Sokolovská tracks are near it)
  const L = TRAM_LOOP, near = (x: number, z: number) => { for (let i = 0; i < L.pts.length; i++) { const a = L.pts[i], b = L.pts[(i + 1) % L.pts.length]; if (distSeg2(x, z, a[0], a[1], b[0], b[1]) < 12.25) return true; } return false; };
  for (const t of DATA.tram.tracks) {
    const d = dense(t, 3); let run: [number, number][] = [];
    for (const q of d) { if (!near(q[0], q[1])) run.push(q); else { if (run.length > 1) rails(run, 0.06, false); run = []; } }
    if (run.length > 1) rails(run, 0.06, false);
  }
  // the shelters: on the pavement beyond the kerb to the right of the stop (tram.ts TRAM_STOP_AT), facing the track, moved along it
  // a little where a house or a lamp's corner is in the way
  for (const st of TRAM_STOP_AT) {
    for (const ds of [0, 3, -3, 6, -6, 9, -9]) {
      const cx = st.x + st.hx * ds, cz = st.z + st.hz * ds, rx = -st.hz, rz = st.hx;
      let o = 1.4; while (o < 7 && groundH(cx + rx * o, cz + rz * o) < 0.29) o += 0.25;      // the tram is 2.4 wide: start past its side
      if (o >= 7) continue;
      const x = cx + rx * (o + 1.3), z = cz + rz * (o + 1.3);
      if (!freeAt(x, z, 1.2) || !freeAt(x + st.hx * 3, z + st.hz * 3, 0.6) || !freeAt(x - st.hx * 3, z - st.hz * 3, 0.6)) continue;
      shelter(x, z, Math.atan2(rx, rz)); break;
    }
  }
}
// a tram shelter at (x, z) whose back faces the heading a (sin a, cos a): roof, lit glass back panel, posts, a stop sign
function shelter(x: number, z: number, a: number) {
  const VC = tileB('vc', x, z), GL = tileB('glow', x, z), y = groundH(x, z);
  const fx = Math.sin(a), fz = Math.cos(a), sx = fz, sz = -fx, rot = Math.atan2(-sz, sx);   // back, along the track; boxes' x along it
  boxB(VC, x, y + 2.55, z, 6.4, 0.18, 2, COL.charcoal, rot, COL.paper);
  boxB(GL, x + fx * 0.8, y + 0.35, z + fz * 0.8, 5.8, 2.1, 0.06, COL.light, rot);
  for (const e of [-1, 1]) boxB(VC, x + sx * 3.05 * e + fx * 0.8, y, z + sz * 3.05 * e + fz * 0.8, 0.12, 2.55, 0.12, COL.charcoal);
  boxB(VC, x + sx * 1.2 + fx * 0.3, y, z + sz * 1.2 + fz * 0.3, 2.6, 0.45, 0.5, 0x6d7472, rot);   // the bench
  const px = x - sx * 3.9 - fx * 0.6, pz = z - sz * 3.9 - fz * 0.6;
  boxB(VC, px, y, pz, 0.12, 3.2, 0.12, COL.charcoal); boxB(GL, px, y + 2.7, pz, 0.7, 0.7, 0.08, 0xf2d26b, rot);   // the stop's sign
  SHELTERS.push({ x, z, a });
}

// ---------- the railway ----------
// lines on the ground: a gravel bed and two rails on the terrain; bridges: the deck slabs and piers map.ts made solid, with parapets
// and the rails on top; the Negrelli viaduct (the decks at 6.4, in and by the arena): stone arches between its piers
function railway() {
  for (const r of DATA.rail) {
    const d = r.bridge ? dense(r.pts, 1e9) : dense(r.pts, 8);                         // on a bridge it is level: no need to follow the ground
    if (r.bridge) rails(d, 0.02, false, () => r.deck); else rails(d, 0.08, true, (x, z) => inArena(x, z) ? groundH(x, z) : terrainH(x, z) + 0.06);
  }
  for (const s of SOLIDS) {
    if (s.kind !== 'deck' && s.kind !== 'pier') continue;
    const [cx, cz] = polyCentroid(s.p), VC = tileB('vc', cx, cz), stone = s.h <= 6.41 && s.h >= 5.39 || s.kind === 'pier';
    if (s.kind === 'pier') { prism(VC, s.p, s.y0, s.h, STONE); continue; }
    // the slab (the two tracks of a viaduct are two overlapping decks: their tops a hair apart, so they do not flicker)
    const top = s.h + (s.i % 3) * 0.012;
    prism(VC, s.p, s.y0, top, stone ? shade(STONE, 1.08) : STEEL, BED, true);
    // the parapets along the deck's two long sides (map.ts's strips: edges 0→1 and 2→3); on the viaduct a deeper stone face below
    // them (drawn only: nothing solid hangs below the deck), so that the slab reads as a stone viaduct where it has no piers
    const p = s.p;
    for (const i of [0, 4]) {
      const j = (i + 2) % 8, ax = p[i], az = p[i + 1], bx = p[j], bz = p[j + 1], l = Math.hypot(bx - ax, bz - az); if (l < 0.5) continue;
      const nx = -(bz - az) / l * 0.35, nz = (bx - ax) / l * 0.35;               // inwards (the interior is on the right)
      prism(VC, [ax, az, bx, bz, bx + nx, bz + nz, ax + nx, az + nz], top, top + 0.7, stone ? STONE : STEEL);
      if (stone) { const ox = -nx * 0.06, oz = -nz * 0.06; wall(VC, ax + ox, az + oz, bx + ox, bz + oz, s.y0 - 1.1, s.y0 + 0.15, STONE_D); }
    }
  }
  // the arches: between two piers of the same line at most three steps apart (wider where a street passes and a pier was left out)
  const at: At = { x: 0, z: 0, hx: 1, hz: 0, k: 0 }, tmp: typeof SOLIDS = [];
  for (const r of DATA.rail) {
    if (!r.bridge || Math.abs(r.deck - 6.4) > 0.01) continue;
    const P = r.pts, cum = polylineCum(P), L = cum[cum.length - 1], piers: number[] = [];
    for (let s = PIER_STEP / 2; s < L; s += PIER_STEP) {
      polylineAt(P, cum, s, at);
      if (solidsIn(at.x - 0.4, at.z - 0.4, at.x + 0.4, at.z + 0.4, tmp).some(o => o.kind === 'pier' && Math.hypot(polyCentroid(o.p)[0] - at.x, polyCentroid(o.p)[1] - at.z) < 0.4)) piers.push(s);
    }
    for (let k = 0; k + 1 < piers.length; k++) {
      const s0 = piers[k] + PIER_L / 2, s1 = piers[k + 1] - PIER_L / 2; if (s1 - s0 > 3 * PIER_STEP) continue;
      arch(P, cum, s0, s1, r.deck - 1);
    }
  }
}
// one arch from s0 to s1 along the line: the curved underside and the two faces up to the deck's underside yd
function arch(P: number[], cum: number[], s0: number, s1: number, yd: number) {
  const N = 10, W = VIADUCT_W / 2, ys = 3.3, at: At = { x: 0, z: 0, hx: 1, hz: 0, k: 0 }, pts: { x: number; z: number; rx: number; rz: number; y: number }[] = [];
  for (let k = 0; k <= N; k++) {
    const t = k / N; polylineAt(P, cum, s0 + (s1 - s0) * t, at);
    pts.push({ x: at.x, z: at.z, rx: -at.hz, rz: at.hx, y: ys + (yd - 0.05 - ys) * Math.sin(Math.PI * t) });
  }
  polylineAt(P, cum, (s0 + s1) / 2, at);
  const C: P3 = [at.x, ys - (s1 - s0) / 2, at.z], VC = tileB('vc', at.x, at.z);
  for (let k = 0; k < N; k++) {
    const a = pts[k], b = pts[k + 1];
    const L = (q: typeof a, sg: number, y: number): P3 => [q.x + q.rx * W * sg, y, q.z + q.rz * W * sg];
    const mid: P3 = [(a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2];
    faceN(VC, [L(a, -1, a.y), L(b, -1, b.y), L(b, 1, b.y), L(a, 1, a.y)], [C[0] - mid[0], C[1] - mid[1], C[2] - mid[2]], STONE_D);   // the underside
    for (const sg of [-1, 1]) faceN(VC, [L(a, sg, a.y), L(b, sg, b.y), L(b, sg, yd), L(a, sg, yd)], [a.rx * sg, 0, a.rz * sg], STONE);   // the faces
  }
}
