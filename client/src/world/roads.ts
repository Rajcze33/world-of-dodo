// World of DODO, issue #16: the ground of the real Karlín and what runs on it: the carriageways (one dark plane over the arena: the
// street graph's faces, the blocks, stand on it, so whatever is not a block is street), the raised pavements (the blocks' kerb
// polygons at 0.3 with a kerb edge, as map.ts groundH says), the paved squares and the parks on them, lane dashes on the wider
// streets, zebra crossings at the junctions, the tram's rails along the track it drives (client/shared/tram.ts) and its stops'
// shelters, the other tram tracks round the city, and the railway: on the ground, on bridges (decks on piers, as map.ts's solids),
// and the Negrelli viaduct's stone arches between its piers.
// World of DODO, issue #20 (warships): the road bridges over the Vltava stand on their decks and piers (map.ts's 'roaddeck' and 'pier'
// solids: high enough for a ship to pass under), the trams cross on them; the viaduct's arches span the river between its new piers;
// whatever lies on the land out there never dips under it (the river's banks: client/shared/naval.ts LAND_MIN).
// World of DODO, issue #27: real materials (core/matlib.ts) instead of flat colours: the streets dry asphalt that the weather turns to
// trodden snow (or wet), the pavements the Prague mosaic with granite kerbs (a granite strip on top of the kerb's edge too), the squares
// setts, the parks a winter lawn under the snow, the tram's track in the street set in concrete with its grooved rails (one strip of
// the rails texture along it), out of the street a gravel bed under the rails, the bridges' piers, arches and the viaduct sandstone,
// the road bridges' decks concrete. The snow lies on all of it as the weather says (matlib's setWeatherLook), nothing is baked in.
// The vertex colours stay as they were where they shade a material (the viaduct's darker underside, the bridges' fascia), else white.
// Replaces the original's 7 × 7 grid of roads and rounded blocks.
import {
  DATA, ARENA, NODES, EDGES, BLOCKS, SOLIDS, TRAM_LOOP, VIADUCT_W, PIER_STEP, PIER_L, groundH, paved, inArena, edgePos,
  freeAt, solidsIn,
} from '../../shared/map.ts';
import { polylineCum, polylineAt, polyCentroid, distSeg2, pointInPoly, closestOnPoly, type At } from '../../shared/geom.ts';
import { inRiver, landY } from '../../shared/naval.ts';
import { TRAM_PATH, TRAM_STOP_AT } from '../../shared/tram.ts';
import { Bucket, quad, tri, boxB, bake, geoMesh, rotateX, planeGeo, type P3, type P2 } from '../core/geo';
import { lambert } from '../core/mat';
import { COL } from '../core/colors';
import { matTex } from '../core/matlib';
import { wall, capUp, capDown, faceN, prism, orient, grow } from './poly';
import { tileB, tileKind, part, type Build } from './tiles';
import { shade } from './buildings';

// (issue #27: the pavements', kerbs', squares', parks' and roads' colours are their materials' tints now, core/matlib.ts)
const MARK = COL.c20, RAIL = COL.grey, BED = 0x9a9893, STONE = 0xb8ad9a, STONE_D = 0x8f8778, STEEL = 0x5f6866, WHITE = 0xffffff;
const RAIL_HALF = 0.55;                                       // half the track gauge (a little wider than 1.435 m: cartoon)
// issue #27: the tram's track in the street is one tile of the rails texture across (Rails001: its two grooved rails 0.56 of a tile
// apart, round the middle), as wide as puts them where the trams' wheels run; the granite strip along the top of a kerb
const TRACK_W = 2 * RAIL_HALF / 0.56, KERB_TOP = 0.22;
const CONCRETE = 0xa7aaa5, FASCIA = 0x7d827f;                  // the road bridges' decks (issue #20)
// World of DODO, issue #20: out of the arena things lie on the land as it is drawn (naval.ts landY, world/land.ts): the coarse terrain
// grid dips towards the river bed by the banks, a road or a track along the embankment must not
// the top of a road bridge's deck over the river within r of (x, z), or NaN (map.ts 'roaddeck' solids)
const DQ: typeof SOLIDS = [];
function deckTop(x: number, z: number, r: number): number {
  let top = NaN;
  for (const s of solidsIn(x - r, z - r, x + r, z + r, DQ)) {
    if (s.kind !== 'roaddeck') continue;
    if (pointInPoly(s.p, x, z) || closestOnPoly(s.p, x, z).d2 < r * r) top = top === top ? Math.max(top, s.h) : s.h;
  }
  return top;
}
export const SHELTERS: { x: number; z: number; a: number }[] = [];   // the tram stops' shelters (city.ts keeps lamps and trees off them)

// the buckets of this module (baked at the end of buildRoads). Issue #27: one per material: PV the pavements' tops, KB the kerbs'
// faces, KT the granite strips on the kerbs' edges, SQ the squares, PK the parks, MK the marks and the steel rails, TR the tram's
// track in the street, BD the gravel beds, FR the roads round the arena
let PV = Bucket(), KB = Bucket(), KT = Bucket(), SQ = Bucket(), PK = Bucket(), MK = Bucket(), TR = Bucket(), BD = Bucket(), FR = Bucket();
// issue #27: the tile kinds of the bridges and the viaduct (world/tiles.ts): sandstone (piers, arches, the viaduct's stone), concrete
// (the road bridges' decks), the gravel on top of a railway deck; white tints, the vertex colours shade them as before
let KINDS = false;
function kinds() {
  if (KINDS) return; KINDS = true;
  tileKind('stone', matTex('sandstone', { tint: WHITE }));
  tileKind('concrete', matTex('concrete', { tint: WHITE }));
  tileKind('ballast', matTex('gravel', { tint: WHITE }), { cast: false });
}
// issue #27: the streets' material (zOffset: lying on the terrain, the roads round the arena)
const STREET = (zOffset: number) => matTex('asphalt', { alt: 'asphaltSnow', macro: 0.3, snow: 0, zOffset });
// the material for things lying on another surface: drawn in front of it (polygon offset), so they never flicker far off
const decal = (units: number) => { const m = lambert(0xffffff); m.zOffset = -units / 4; m.zOffsetUnits = -units; return m; };

// a flat strip lying on the ground along the polyline pts (pairs), from offset o0 to o1 to the right of it, dy above the ground
// (issue #27: uv: uvs in game units, u along the polyline from its start, v the offset from o0: a texture laid along it)
function strip(bk: Bucket, pts: [number, number][], o0: number, o1: number, dy: number, col: number, gy: (x: number, z: number) => number = groundH, uv = false) {
  let s = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1], dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz); if (l < 1e-6) continue;
    const rx = -dz / l, rz = dx / l, P = (x: number, z: number, o: number): P3 => { const X = x + rx * o, Z = z + rz * o; return [X, gy(X, Z) + dy, Z]; };
    if (uv) quadUp(bk, P(ax, az, o0), P(bx, bz, o0), P(bx, bz, o1), P(ax, az, o1), col, [[s, 0], [s + l, 0], [s + l, o1 - o0], [s, o1 - o0]]);
    else faceN(bk, [P(ax, az, o0), P(bx, bz, o0), P(bx, bz, o1), P(ax, az, o1)], [0, 1, 0], col);
    s += l;
  }
}
// issue #27: a quad a, b, c, d with uvs, turned to face up
function quadUp(bk: Bucket, a: P3, b: P3, c: P3, d: P3, col: number, uv: P2[]) {
  const up = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]) > 0;   // the y of (b - a) × (c - a)
  if (up) { tri(bk, a, b, c, col, uv[0], uv[1], uv[2]); tri(bk, a, c, d, col, uv[0], uv[2], uv[3]); }
  else { tri(bk, a, c, b, col, uv[0], uv[2], uv[1]); tri(bk, a, d, c, col, uv[0], uv[3], uv[2]); }
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
// two rails (and a gravel bed under them when bed) along a dense polyline (issue #27: the bed in the gravel material)
function rails(pts: [number, number][], dy: number, bed: boolean, gy?: (x: number, z: number) => number) {
  if (bed) strip(BD, pts, -1.6, 1.6, dy, WHITE, gy);
  strip(MK, pts, -RAIL_HALF - 0.08, -RAIL_HALF + 0.08, dy + 0.03, RAIL, gy); strip(MK, pts, RAIL_HALF - 0.08, RAIL_HALF + 0.08, dy + 0.03, RAIL, gy);
}
// issue #27: a tram track set in the street: one strip of the rails texture along it
const trackIn = (pts: [number, number][], dy: number, gy?: (x: number, z: number) => number) => strip(TR, pts, -TRACK_W / 2, TRACK_W / 2, dy, WHITE, gy, true);

// (issue #31: a builder: a block's pavement, a far road, each of the other parts and each bake a unit, in the same order as before)
export function* buildRoads(): Build {
  PV = Bucket(); KB = Bucket(); KT = Bucket(); SQ = Bucket(); PK = Bucket(); MK = Bucket(); TR = Bucket(); BD = Bucket(); FR = Bucket(); SHELTERS.length = 0;
  kinds();
  // the carriageways: one plane over the arena at 0 (the terrain outside it lies a hair lower, land.ts). Issue #27: dry asphalt; under
  // the weather's snow the trodden snow of asphaltSnow, its low parts last; large patches against the repeat. No snow layer of its own
  // (snow 0): the asphalt has no joints to fill, asphaltSnow is its snow, and the street is most of the picture: a texture read less
  const A = ARENA, asphalt = geoMesh('streets', rotateX(planeGeo(A.x1 - A.x0, A.z1 - A.z0), -Math.PI / 2), STREET(0), false, true);
  asphalt.position.set((A.x0 + A.x1) / 2, 0, (A.z0 + A.z1) / 2); asphalt.freezeWorldMatrix();
  yield 0.01;
  // the pavements: every block raised to 0.3 with its kerb (issue #27: mosaic on top, granite kerbs with a granite strip on their edge)
  for (let b = 0; b < BLOCKS.length; b++) {
    const p = BLOCKS[b].p, n = p.length, g = grow(p, -KERB_TOP);
    for (let i = 0; i < n; i += 2) {
      const j = (i + 2) % n; wall(KB, p[i], p[i + 1], p[j], p[j + 1], 0, 0.3, WHITE);
      faceN(KT, [[p[i], 0.3, p[i + 1]], [p[j], 0.3, p[j + 1]], [g[j], 0.3, g[j + 1]], [g[i], 0.3, g[i + 1]]], [0, 1, 0], WHITE);
    }
    capUp(PV, p, 0.3, WHITE);
    yield 0.01 + 0.02 * (b + 1) / BLOCKS.length;
  }
  // the squares (setts) and the parks lying on the blocks (a winter lawn under the snow)
  for (const q of DATA.plazas) capUp(SQ, orient(q), 0.315, WHITE);
  yield 0.04;
  for (const q of DATA.parks) if (onBlocks(q)) capUp(PK, orient(q), 0.33, WHITE);
  yield 0.06;
  // World of DODO, issue #16 (4. 11.): the streets of Prague round the arena, for the planes: strips lying on the terrain (or on a
  // bridge's deck), going on where the arena's streets leave it
  // (issue #20: a bridge over the river lies on its deck slab, its top at y; the others float as before)
  const far = DATA.farRoads || [];
  for (let k = 0; k < far.length; k++) {
    const r = far[k], y = r.y, onDeck = y !== undefined && deckTop((r.pts[0] + r.pts[2]) / 2, (r.pts[1] + r.pts[3]) / 2, 0.1) === y;
    const gy = y === undefined ? landY : () => y;
    strip(FR, dense(r.pts, 5), -r.w / 2, r.w / 2, y === undefined ? 0.06 : onDeck ? 0.03 : 0.25, WHITE, gy);
    if (k % 8 === 7) yield 0.06 + 0.24 * (k + 1) / far.length;
  }
  yield 0.3;
  laneDashes(); yield 0.33;
  zebras(); yield 0.36;
  yield* part(tram(), 0.36, 0.55);
  yield* part(railway(), 0.55, 0.7);
  bake('pavements', PV, matTex('mosaic', { macro: 0.2 }), false); yield 0.74;
  bake('kerbs', KB, matTex('granite'), false); yield 0.78;
  bake('kerbTops', KT, matTex('granite', { zOffset: 3 }), false); yield 0.82;
  bake('squares', SQ, matTex('setts', { zOffset: 4, macro: 0.2 }), false); yield 0.85;
  bake('parks', PK, matTex('gravel', { tint: 0x5e6553, scale: 2.5, zOffset: 4, macro: 0.45, wet: 0.5 }), false); yield 0.88;
  bake('roadMarks', MK, decal(8), false); yield 0.91;
  bake('tramTrack', TR, matTex('rails', { uv: 'mesh', scale: TRACK_W / 1.9, zOffset: 6, snow: 0.3 }), false); yield 0.94;
  bake('trackBeds', BD, matTex('gravel', { zOffset: 6 }), false); yield 0.97;
  bake('farRoads', FR, STREET(2), false);
  PV = Bucket(); KB = Bucket(); KT = Bucket(); SQ = Bucket(); PK = Bucket(); MK = Bucket(); TR = Bucket(); BD = Bucket(); FR = Bucket();
  yield 1;
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
// (World of DODO, issue #31: a builder: the loop's track, then four of the other tracks a unit, then the shelters)
function* tram(): Build {
  const P = TRAM_PATH.pts; if (P.length < 2) return;
  const track: [number, number][] = []; for (let i = 0; i < P.length; i += 2) track.push(P[i]);   // a point every ~2 units is enough
  track.push(P[0]);
  // issue #27: in the arena the track is set in the street (the rails texture), out of it the rails lie on a gravel bed
  for (const r of runs(track, q => inArena(q[0], q[1], -2))) {
    if (r.on) trackIn(r.pts, 0.035); else { strip(BD, r.pts, -1.5, 1.5, 0.02, WHITE); rails(r.pts, 0.035, false); }
  }
  // the other tracks: segments at least 3.5 from the loop (TRAM_LOOP: the data's own Sokolovská tracks are near it)
  const L = TRAM_LOOP, near = (x: number, z: number) => { for (let i = 0; i < L.pts.length; i++) { const a = L.pts[i], b = L.pts[(i + 1) % L.pts.length]; if (distSeg2(x, z, a[0], a[1], b[0], b[1]) < 12.25) return true; } return false; };
  // (issue #20: out of the arena on the land as drawn, over the river on a road bridge's deck; none under the water)
  const trackY = (x: number, z: number) => { if (inArena(x, z)) return groundH(x, z); const d = deckTop(x, z, 2.5); return d === d ? d : landY(x, z); };
  const wetTrack = (x: number, z: number) => !inArena(x, z) && inRiver(x, z) && deckTop(x, z, 2.5) !== deckTop(x, z, 2.5);
  // (issue #27: set in the street in the arena and on a bridge's deck, on a gravel bed out on the land)
  const setIn = (q: [number, number]) => inArena(q[0], q[1]) || deckTop(q[0], q[1], 2.5) === deckTop(q[0], q[1], 2.5);
  const other = (run: [number, number][]) => {
    for (const r of runs(run, setIn)) { if (r.on) trackIn(r.pts, 0.06, trackY); else { strip(BD, r.pts, -1.5, 1.5, 0.04, WHITE, trackY); rails(r.pts, 0.06, false, trackY); } }
  };
  yield 0.2;
  const TT = DATA.tram.tracks;
  for (let k = 0; k < TT.length; k++) {
    if (k % 4 === 3) yield 0.2 + 0.6 * k / TT.length;
    const d = dense(TT[k], 3); let run: [number, number][] = [];
    for (const q of d) { if (!near(q[0], q[1]) && !wetTrack(q[0], q[1])) run.push(q); else { if (run.length > 1) other(run); run = []; } }
    if (run.length > 1) other(run);
  }
  yield 0.8;
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
  yield 1;
}
// issue #27: a polyline cut into the runs where on(point) is the same (each run starts at the last point of the one before)
function runs(pts: [number, number][], on: (q: [number, number]) => boolean): { on: boolean; pts: [number, number][] }[] {
  const out: { on: boolean; pts: [number, number][] }[] = [];
  for (const q of pts) {
    const v = on(q), r = out[out.length - 1];
    if (r && r.on === v) r.pts.push(q); else out.push({ on: v, pts: r ? [r.pts[r.pts.length - 1], q] : [q] });
  }
  return out.filter(r => r.pts.length > 1);
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
// (World of DODO, issue #31: a builder: 16 lines' rails a unit, the decks and piers, then each viaduct's arches a unit)
function* railway(): Build {
  for (let k = 0; k < DATA.rail.length; k++) {
    if (k % 16 === 15) yield 0.3 * k / DATA.rail.length;
    const r = DATA.rail[k], d = r.bridge ? dense(r.pts, 1e9) : dense(r.pts, 8);         // on a bridge it is level: no need to follow the ground
    if (r.bridge) rails(d, 0.02, false, () => r.deck); else rails(d, 0.08, true, (x, z) => inArena(x, z) ? groundH(x, z) : landY(x, z) + 0.06);
  }
  yield 0.3;
  for (const s of SOLIDS) {
    if (s.kind !== 'deck' && s.kind !== 'pier' && s.kind !== 'roaddeck') continue;
    // (issue #27: the stone in the sandstone material, the road decks concrete, the track's bed on a deck gravel: tiles.ts kinds)
    const [cx, cz] = polyCentroid(s.p), stone = s.h <= 6.41 && s.h >= 5.39 || s.kind === 'pier', VC = tileB(stone ? 'stone' : 'vc', cx, cz);
    if (s.kind === 'pier') { prism(VC, s.p, s.y0, s.h, STONE); continue; }
    if (s.kind === 'roaddeck') { roadDeck(tileB('concrete', cx, cz), s.p, s.y0, s.h); continue; }
    // the slab (the two tracks of a viaduct are two overlapping decks: their tops a hair apart, so they do not flicker)
    const top = s.h + (s.i % 3) * 0.012, sc = stone ? shade(STONE, 1.08) : STEEL;
    for (let i = 0; i < s.p.length; i += 2) { const j = (i + 2) % s.p.length; wall(VC, s.p[i], s.p[i + 1], s.p[j], s.p[j + 1], s.y0, top, sc); }
    capUp(tileB('ballast', cx, cz), s.p, top, BED); capDown(VC, s.p, s.y0, sc);
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
  // the arches: between two piers of the same line at most three steps apart (wider where a street passes and a pier was left out).
  // World of DODO, issue #20: the piers found where they stand on the line (over the river they keep the river's spans, not the land's
  // step), each pier's middle within 0.4 of it
  yield 0.6;
  const at: At = { x: 0, z: 0, hx: 1, hz: 0, k: 0 }, tmp: typeof SOLIDS = [];
  for (const r of DATA.rail) {
    if (!r.bridge || Math.abs(r.deck - 6.4) > 0.01) continue;
    const P = r.pts, cum = polylineCum(P), L = cum[cum.length - 1], piers: number[] = [], seen = new Set<number>();
    for (let s = 0; s < L; s += 2) {
      polylineAt(P, cum, s, at);
      for (const o of solidsIn(at.x - 2, at.z - 2, at.x + 2, at.z + 2, tmp)) {
        if (o.kind !== 'pier' || o.road || seen.has(o.i)) continue;
        const [px, pz] = polyCentroid(o.p), u = (px - at.x) * at.hx + (pz - at.z) * at.hz, v = -(px - at.x) * at.hz + (pz - at.z) * at.hx;
        if (Math.abs(v) < 0.4 && u >= -1 && u < 1) { seen.add(o.i); piers.push(s + u); }
      }
    }
    piers.sort((a, b) => a - b);
    for (let k = 0; k + 1 < piers.length; k++) {
      const s0 = piers[k] + PIER_L / 2, s1 = piers[k + 1] - PIER_L / 2; if (s1 - s0 > 3 * PIER_STEP) continue;
      arch(P, cum, s0, s1, r.deck - 1);
    }
    yield 0.8;
  }
  yield 1;
}
// World of DODO, issue #20: a road bridge's deck over the river (a map.ts 'roaddeck' strip, its long sides edges 0→1 and 2→3): a
// concrete slab with a darker fascia, and a parapet along both sides
function roadDeck(VC: ReturnType<typeof tileB>, p: number[], y0: number, y1: number) {
  prism(VC, p, y0, y1, CONCRETE, CONCRETE, true);
  for (const i of [0, 4]) {
    const j = (i + 2) % 8, ax = p[i], az = p[i + 1], bx = p[j], bz = p[j + 1], l = Math.hypot(bx - ax, bz - az); if (l < 0.3) continue;
    const nx = -(bz - az) / l * 0.3, nz = (bx - ax) / l * 0.3, ox = -nx * 0.05, oz = -nz * 0.05;   // inwards; a hair outwards
    prism(VC, [ax, az, bx, bz, bx + nx, bz + nz, ax + nx, az + nz], y1, y1 + 0.8, CONCRETE, shade(CONCRETE, 1.12));
    wall(VC, ax + ox, az + oz, bx + ox, bz + oz, y0 - 0.02, y1 - 0.25, FASCIA);
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
  const C: P3 = [at.x, ys - (s1 - s0) / 2, at.z], VC = tileB('stone', at.x, at.z);
  for (let k = 0; k < N; k++) {
    const a = pts[k], b = pts[k + 1];
    const L = (q: typeof a, sg: number, y: number): P3 => [q.x + q.rx * W * sg, y, q.z + q.rz * W * sg];
    const mid: P3 = [(a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2];
    faceN(VC, [L(a, -1, a.y), L(b, -1, b.y), L(b, 1, b.y), L(a, 1, a.y)], [C[0] - mid[0], C[1] - mid[1], C[2] - mid[2]], STONE_D);   // the underside
    for (const sg of [-1, 1]) faceN(VC, [L(a, sg, a.y), L(b, sg, b.y), L(b, sg, yd), L(a, sg, yd)], [a.rx * sg, 0, a.rz * sg], STONE);   // the faces
  }
}
