// World of DODO: the land around the city, for the planes (issue #14). World of DODO, issue #16: the real surroundings of Karlín
// instead of the invented countryside (villages, farms, the wind farm, the airfield): the terrain of DATA.terrain (ČÚZK's DMR 5G:
// Vítkov in the south, the river banks, Letná and Holešovice behind the Vltava), the Vltava itself, the woods of the parks
// (Vítkov's slopes, Štvanice) as instanced trees, and beyond the outer square the land fading into the fog over a snowy plain. The
// far houses are drawn by world/buildings.ts with the city's.
// World of DODO, issue #20 (warships): the Vltava is no longer frozen. Its water lies WATER_Y (client/shared/naval.ts) under the
// embankments, dark winter water whose small waves move and catch the moon (a shader of its own: two scrolling normal maps, a
// Fresnel sky, the fog); stone embankment walls with a coping and a parapet run along every bank from the land down into the water;
// ice floes drift slowly downstream along the banks. The ponds stay frozen. The terrain is drawn up to the bank exactly (the 10 u
// grid's quads that the bank crosses in 1 u cells), never under LAND_MIN on land.
//
// It draws from no random numbers (hashes only; the floes' drifting has its own small generator). Built last (main.ts), after
// everything else. Few draw calls: the terrain is one mesh, the embankment one, the river one, the ponds one, the floes one
// instanced mesh, the woods two instanced meshes (near and far, each culled by its own box), the plain one.
// landHit() tells the planes whether a point is under the ground or the water, or inside a tree of the woods or something a landmark
// raises above its footprint's solid (the church's towers, Žižka's statue: world/landmarks.ts EXTRA). The buildings themselves are
// map.ts's solids (solidNear), the planes ask those separately.
import { ShaderMaterial, RawTexture, Texture, Vector3, Color3, type StandardMaterial } from '@babylonjs/core';
import { DATA, ARENA, OUTER, solidAt } from '../../shared/map.ts';
import { WATER_Y, LAND_MIN, inRiver, bankDist, riverDir, waterPush, inWater, landY, BANK, BANK_N, BANK_RIM, RIVER } from '../../shared/naval.ts';
import { Hash, pointInPoly, polyBox, polyCentroid } from '../../shared/geom.ts';
import { scene, engine, camera } from '../core/engine';
import { Bucket, tri, quad, cylGeo, translate, addGeo, bake, geoMesh, Inst, Dummy, type P3, type Geo } from '../core/geo';
import { lambert } from '../core/mat';
import { canvasTex } from '../core/tex';
import { COL } from '../core/colors';
import { COARSE } from '../core/dom';
import { earClip, orient, hash01, faceN } from './poly';
import { EXTRA } from './landmarks';
import { eachShip } from './water';
import { mix, shade } from './buildings';

// the river's surface (issue #20: client/shared/naval.ts; the game may import it from here too)
export { WATER_Y };
export const POND_Y = -0.8;                           // the frozen ponds: above their shallow bed (-2), below all land
// the ground's height around the city as drawn (inside the arena it is 0, the streets' level): naval.ts landY, the terrain kept at the
// land's own level up to the river's bank and never under LAND_MIN
export const landH = landY;

// ---------- what the planes can hit out here: trees (cones) and the landmarks' extra boxes, in a coarse grid ----------
interface Sol { k: number; x: number; z: number; y0: number; h: number; a: number; b: number; ux: number; uz: number }
const HC = 25, HH = 750, HNC = HH * 2 / HC, HIT: (Sol[] | null)[] = new Array(HNC * HNC).fill(null);
let HIT_TOP = 0;
function solid(o: Sol, rad: number) {
  HIT_TOP = Math.max(HIT_TOP, o.h);
  const i0 = Math.max(0, Math.floor((o.x - rad + HH) / HC)), i1 = Math.min(HNC - 1, Math.floor((o.x + rad + HH) / HC));
  const j0 = Math.max(0, Math.floor((o.z - rad + HH) / HC)), j1 = Math.min(HNC - 1, Math.floor((o.z + rad + HH) / HC));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) (HIT[j * HNC + i] ??= []).push(o);
}
// For the planes, every frame: is (x, y, z) under the terrain or the water (issue #20: the river's surface, WATER_Y), inside a tree
// of the woods, or inside something a landmark raises above its solid? (The houses, the viaduct, the bridges and the site are
// map.ts's solids: solidNear.)
export function landHit(x: number, y: number, z: number): boolean {
  if (y < (inRiver(x, z) ? WATER_Y : landH(x, z))) return true;
  if (y > HIT_TOP) return false;
  const i = Math.floor((x + HH) / HC), j = Math.floor((z + HH) / HC);
  if (i < 0 || j < 0 || i >= HNC || j >= HNC) return false;
  const L = HIT[j * HNC + i]; if (!L) return false;
  for (const o of L) {
    const dx = x - o.x, dz = z - o.z, dy = y - o.y0;
    if (dy < 0 || y > o.h) continue;
    if (o.k === 0) { if (Math.abs(dx * o.ux + dz * o.uz) < o.a && Math.abs(-dx * o.uz + dz * o.ux) < o.b) return true; }
    else { const rr = o.a * (1 - dy / (o.h - o.y0)); if (dx * dx + dz * dz < rr * rr) return true; }
  }
  return false;
}

// ---------- the terrain ----------
const SNOW = COL.paper, ROCK = 0xa2a8a6, BED = 0x4f5a58, WOOD = 0x6f8f88;
// is (x, z) in a park (the woods, gardens)? A box hash over the parks, built once
let PARKS: Hash<number> | null = null; const PQ: number[] = [];
const PB: number[][] = [];
function inPark(x: number, z: number) {
  if (!PARKS) { PARKS = new Hash<number>(OUTER.x0, OUTER.z0, OUTER.x1, OUTER.z1, 40); DATA.parks.forEach((q, i) => { PB[i] = polyBox(q); PARKS!.add(PB[i] as [number, number, number, number], i); }); }
  for (const i of PARKS.query(x, z, x, z, PQ)) { const b = PB[i]; if (x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3] && pointInPoly(DATA.parks[i], x, z)) return true; }
  return false;
}
// in any water piece of the data (the river or a pond)
let WATERS: Hash<number> | null = null; const WQ: number[] = [];
function inAnyWater(x: number, z: number) {
  if (!WATERS) { WATERS = new Hash<number>(OUTER.x0, OUTER.z0, OUTER.x1, OUTER.z1, 40); DATA.water.forEach((q, i) => WATERS!.add(polyBox(q), i)); }
  for (const i of WATERS.query(x, z, x, z, WQ)) if (pointInPoly(DATA.water[i], x, z)) return true;
  return false;
}
// a flat-shaded triangle facing up with a colour at each corner (soft patches between the vertices)
const TC = [0, 0, 0];
function triV(bk: Bucket, a: P3, b: P3, c: P3, ca: number, cb: number, cc: number) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
  let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
  if (ny < 0) { [b, c] = [c, b]; [cb, cc] = [cc, cb]; nx = -nx; ny = -ny; nz = -nz; }
  const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
  for (const [v, col] of [[a, ca], [b, cb], [c, cc]] as [P3, number][]) {
    TC[0] = ((col >> 16) & 255) / 255; TC[1] = ((col >> 8) & 255) / 255; TC[2] = (col & 255) / 255;
    bk.p.push(v[0], v[1], v[2]); bk.n.push(nx, ny, nz); bk.u.push(0, 0); bk.c.push(TC[0], TC[1], TC[2]);
  }
}
function terrain(G: Bucket, Wt: Bucket) {
  const T = DATA.terrain, N = T.nx, H = T.h, at = (i: number, j: number) => H[j * N + i];
  // the colour of each vertex: snow; a pond's bed darker; the woods a little darker and greener; rock where it is steep. (Issue #20:
  // no darker bank any more, the embankment's coping runs along it; a vertex in the river takes the land's colours, for the cells by
  // the bank that blend towards it.)
  const C = new Array(N * T.nz);
  for (let j = 0; j < T.nz; j++) for (let i = 0; i < N; i++) {
    const x = T.x0 + i * T.step, z = T.z0 + j * T.step, river = inRiver(x, z), h = river ? LAND_MIN : at(i, j);
    const sl = river ? 0 : Math.max(Math.abs(at(Math.min(N - 1, i + 1), j) - at(Math.max(0, i - 1), j)), Math.abs(at(i, Math.min(T.nz - 1, j + 1)) - at(i, Math.max(0, j - 1)))) / (2 * T.step);
    let c = h < -1.2 ? BED : inPark(x, z) ? mix(SNOW, WOOD, 0.45) : SNOW;
    if (sl > 0.45 && h > 0) c = mix(c, ROCK, Math.min(1, (sl - 0.45) * 2.5));
    C[j * N + i] = shade(c, 0.97 + 0.05 * hash01(i, j));
  }
  const HALF = T.step * 0.7072;                                        // half a quad's diagonal
  for (let j = 0; j + 1 < T.nz; j++) for (let i = 0; i + 1 < N; i++) {
    const x = T.x0 + i * T.step, z = T.z0 + j * T.step, x1 = x + T.step, z1 = z + T.step;
    if (x >= ARENA.x0 && x1 <= ARENA.x1 && z >= ARENA.z0 && z1 <= ARENA.z1) continue;   // the streets' plane covers it
    const k = j * N + i, K = [k, k + 1, k + N + 1, k + N], bd = bankDist(x + T.step / 2, z + T.step / 2);
    if (bd > HALF) continue;                                          // wholly on the river: the water covers it
    if (bd < -HALF) {                                                 // wholly on land
      if (H[k] < -1.5 && H[k + 1] < -1.5 && H[k + N] < -1.5 && H[k + N + 1] < -1.5) continue;   // a pond's bed, under its ice
      const V: P3[] = [[x, H[k] - 0.02, z], [x1, H[k + 1] - 0.02, z], [x1, H[k + N + 1] - 0.02, z1], [x, H[k + N] - 0.02, z1]];
      triV(G, V[0], V[1], V[2], C[K[0]], C[K[1]], C[K[2]]); triV(G, V[0], V[2], V[3], C[K[0]], C[K[2]], C[K[3]]);
      continue;
    }
    // the bank crosses this quad: its land in 1 u cells (a cell whose middle is at least 0.71 inland: none reaches over the water;
    // the embankment's coping covers the ragged edge), joined into runs along x; heights from the terrain, never under LAND_MIN
    const col = (u: number, v: number) => mix(mix(C[K[0]], C[K[1]], u), mix(C[K[3]], C[K[2]], u), v);
    for (let r = 0; r < T.step; r++) {
      let c0 = -1;
      for (let c = 0; c <= T.step; c++) {
        const land = c < T.step && bankDist(x + c + 0.5, z + r + 0.5) < -0.71;
        if (land && c0 < 0) c0 = c;
        if (!land && c0 >= 0) {
          const xa = x + c0, xb = x + c, za = z + r, zb = z + r + 1, u0 = c0 / T.step, u1 = c / T.step, v0 = r / T.step, v1 = (r + 1) / T.step;
          const A: P3 = [xa, landH(xa, za) - 0.02, za], B: P3 = [xb, landH(xb, za) - 0.02, za], Cc: P3 = [xb, landH(xb, zb) - 0.02, zb], D: P3 = [xa, landH(xa, zb) - 0.02, zb];
          triV(G, A, B, Cc, col(u0, v0), col(u1, v0), col(u1, v1)); triV(G, A, Cc, D, col(u0, v0), col(u1, v1), col(u0, v1));
          c0 = -1;
        }
      }
    }
  }
  // the skirt: from the outer square's edge 450 further out, sinking to a fifth of the edge's height, into the fog. Where the river
  // leaves the square the skirt dips under the water and the water goes on over it (Wt), so the Vltava runs on into the fog.
  const X0 = T.x0, Z0 = T.z0, X1 = T.x0 + (N - 1) * T.step, Z1 = T.z0 + (T.nz - 1) * T.step, S = 450;
  const wetE = (i: number, j: number) => inRiver(T.x0 + i * T.step, T.z0 + j * T.step);
  const edge = (i0: number, j0: number, di: number, dj: number, n: number, ox: number, oz: number) => {
    for (let k = 0; k + 1 < n; k++) {
      const ia = i0 + di * k, ja = j0 + dj * k, ib = ia + di, jb = ja + dj, wa = wetE(ia, ja), wb = wetE(ib, jb);
      const ha = wa ? WATER_Y - 1.5 : at(ia, ja), hb = wb ? WATER_Y - 1.5 : at(ib, jb), oa = wa ? WATER_Y - 1.5 : ha * 0.2 - 0.3, ob = wb ? WATER_Y - 1.5 : hb * 0.2 - 0.3;
      const A: P3 = [T.x0 + ia * T.step, ha - 0.02, T.z0 + ja * T.step], B: P3 = [T.x0 + ib * T.step, hb - 0.02, T.z0 + jb * T.step];
      triV(G, A, B, [B[0] + ox * S, ob, B[2] + oz * S], C[ja * N + ia], C[jb * N + ib], SNOW);
      triV(G, A, [B[0] + ox * S, ob, B[2] + oz * S], [A[0] + ox * S, oa, A[2] + oz * S], C[ja * N + ia], SNOW, SNOW);
      if (wa || wb) quad(Wt, [A[0], WATER_Y, A[2]], [B[0], WATER_Y, B[2]], [B[0] + ox * S, WATER_Y, B[2] + oz * S], [A[0] + ox * S, WATER_Y, A[2] + oz * S], 0xffffff);
    }
  };
  edge(0, 0, 1, 0, N, 0, -1); edge(0, T.nz - 1, 1, 0, N, 0, 1); edge(0, 0, 0, 1, T.nz, -1, 0); edge(N - 1, 0, 0, 1, T.nz, 1, 0);
  for (const [cx, cz, ox, oz, i, j] of [[X0, Z0, -1, -1, 0, 0], [X1, Z0, 1, -1, N - 1, 0], [X1, Z1, 1, 1, N - 1, T.nz - 1], [X0, Z1, -1, 1, 0, T.nz - 1]]) {
    const h = at(i, j), y = h * 0.2 - 0.3, A: P3 = [cx, h - 0.02, cz];
    triV(G, A, [cx + ox * S, y, cz], [cx + ox * S, y, cz + oz * S], C[j * N + i], SNOW, SNOW); triV(G, A, [cx + ox * S, y, cz + oz * S], [cx, y, cz + oz * S], C[j * N + i], SNOW, SNOW);
  }
  // and beyond the skirt a snowy plain round it (a ring: inside, the land and the river)
  const R0 = X1 + S, R1 = 4000, y = -0.3;
  for (const [a0, b0, a1, b1] of [[-R1, -R1, R1, -R0], [-R1, R0, R1, R1], [-R1, -R0, -R0, R0], [R0, -R0, R1, R0]]) quad(G, [a0, y, b0], [a0, y, b1], [a1, y, b1], [a1, y, b0], SNOW);
}

// ---------- the Vltava (issue #20): liquid, dark, its small waves moving ----------
// The river's pieces at WATER_Y in one mesh, drawn by a shader of its own: the surface's normal from two normal maps scrolling at
// different scales and speeds (the waves drift east, downstream); dark water that mirrors the night sky (core/engine.ts's dome: the
// charcoal horizon, the near-black zenith) along the view reflected by the waves, more of it the flatter it is seen (Fresnel), so
// that from a plane the ripples show as faint light and dark; the moon's glints (its direction as core/engine.ts lights the scene);
// the scene's linear fog. No lights, no shadows, two texture reads a pixel: cheap even where the river fills the view.
const WATER_VS = `precision highp float;
attribute vec3 position;
uniform mat4 viewProjection;
varying vec3 vW;
void main(void) { vW = position; gl_Position = viewProjection * vec4(position, 1.0); }`;
const WATER_FS = `precision highp float;
uniform sampler2D nrm;
uniform vec3 cam;
uniform float time;
uniform vec3 deep;
uniform vec3 sky;
uniform vec3 zenith;
uniform vec3 moonDir;
uniform vec3 fogColor;
uniform float fogStart;
uniform float fogEnd;
varying vec3 vW;
void main(void) {
  // the two layers turned against each other and against the streets' grid (their tiles must not line up), the second one's
  // slopes turned back into the world
  vec2 p = vW.xz, q = mat2(0.866, 0.5, -0.5, 0.866) * p, s = mat2(0.643, -0.766, 0.766, 0.643) * p;
  vec2 a = texture2D(nrm, q * 0.043 + vec2(time * 0.010, time * 0.0035)).xy * 2.0 - 1.0;
  vec2 b = texture2D(nrm, s * 0.121 + vec2(time * 0.004, -time * 0.012)).xy * 2.0 - 1.0;
  a = mat2(0.866, -0.5, 0.5, 0.866) * a; b = mat2(0.643, 0.766, -0.766, 0.643) * b;
  vec3 n = normalize(vec3(a.x + 0.5 * b.x, 3.2, a.y + 0.5 * b.y));
  vec3 e = cam - vW; float d = length(e); vec3 v = e / d;
  float fr = pow(1.0 - max(dot(n, v), 0.0), 4.0);
  vec3 r = reflect(-v, n);
  vec3 refl = mix(sky, zenith, smoothstep(0.02, 0.6, r.y));
  float sp = pow(max(dot(r, moonDir), 0.0), 300.0);
  vec3 c = mix(deep, refl, 0.35 + 0.6 * fr) + vec3(0.7, 0.77, 0.77) * sp;
  float f = clamp((fogEnd - d) / (fogEnd - fogStart), 0.0, 1.0);
  gl_FragColor = vec4(mix(fogColor, c, f), 1.0);
}`;
// the normal map: a sum of sine waves whose wave numbers are whole, so that it tiles; red and green the slopes in x and z
function waveTex(): RawTexture {
  const S = 128, data = new Uint8Array(S * S * 4), W: number[][] = [];
  for (let k = 0; k < 18; k++) {                                       // no wave straight along an axis (they would line up as a grid)
    const kx = (1 + Math.floor(hash01(k, 31) * 7)) * (hash01(k, 34) < 0.5 ? -1 : 1), kz = (1 + Math.floor(hash01(k, 32) * 7)) * (hash01(k, 35) < 0.5 ? -1 : 1);
    W.push([kx, kz, 1 / Math.pow(kx * kx + kz * kz, 0.75), hash01(k, 33) * Math.PI * 2]);
  }
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    let sx = 0, sz = 0;
    for (const [kx, kz, A, ph] of W) { const c = Math.cos(2 * Math.PI * (kx * i + kz * j) / S + ph) * A * 2 * Math.PI; sx += kx * c; sz += kz * c; }
    const o = (j * S + i) * 4;
    data[o] = Math.max(0, Math.min(255, Math.round(128 - sx * 9))); data[o + 1] = Math.max(0, Math.min(255, Math.round(128 - sz * 9))); data[o + 2] = 255; data[o + 3] = 255;
  }
  const t = RawTexture.CreateRGBATexture(data, S, S, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  t.wrapU = t.wrapV = Texture.WRAP_ADDRESSMODE; t.anisotropicFilteringLevel = 4;
  return t;
}
function riverMat(): ShaderMaterial {
  const m = new ShaderMaterial('vltava', scene, { vertexSource: WATER_VS, fragmentSource: WATER_FS }, {
    attributes: ['position'], uniforms: ['viewProjection', 'cam', 'time', 'deep', 'sky', 'zenith', 'moonDir', 'fogColor', 'fogStart', 'fogEnd'], samplers: ['nrm'],
  });
  m.setTexture('nrm', waveTex()); m.backFaceCulling = false;
  m.setColor3('deep', new Color3(0.06, 0.085, 0.095)); m.setColor3('sky', new Color3(0.25, 0.29, 0.29)); m.setColor3('zenith', new Color3(0.035, 0.05, 0.05));
  m.setVector3('moonDir', new Vector3(-50, 110, 40).normalize());   // towards the moon (core/engine.ts: it shines along (50, -110, -40))
  return m;
}
// the river's pieces, faced up, at WATER_Y (into Wt, which also has the part beyond the outer square, under the skirt)
function river(Wt: Bucket) {
  for (const q of RIVER) {
    const t = earClip(q);
    for (let i = 0; i < t.length; i += 3) {
      const a = t[i], b = t[i + 2], c = t[i + 1];                    // turned to face up
      tri(Wt, [q[2 * a], WATER_Y, q[2 * a + 1]], [q[2 * b], WATER_Y, q[2 * b + 1]], [q[2 * c], WATER_Y, q[2 * c + 1]], 0xffffff);
    }
  }
}

// ---------- the embankments (issue #20): stone walls from the land down into the water along every bank ----------
// Along each bank segment of naval.ts (not the outer square's cut): the wall's face over the water (a darker wet band at the water
// line, down under the surface), on top a coping a little proud of the face, and a low parapet along the water's side. The top
// follows the land 1.6 inland (never under LAND_MIN); the piers' holes and the locks' walls in the river get the same stone.
const STONE = 0xaaa498, WET = 0x5f6561, COPING = 0xc3bdb1, CAP = 0xe4e9e8;
function embankment(E: Bucket) {
  for (let k = 0; k < BANK_N; k++) {
    if (BANK_RIM[k]) continue;
    const o = 6 * k, ax = BANK[o], az = BANK[o + 1], bx = BANK[o + 2], bz = BANK[o + 3], nx = BANK[o + 4], nz = BANK[o + 5];
    const tA = landH(ax - nx * 1.6, az - nz * 1.6) + 0.15, tB = landH(bx - nx * 1.6, bz - nz * 1.6) + 0.15, N: P3 = [nx, 0, nz], Nb: P3 = [-nx, 0, -nz];
    const P = (x: number, z: number, off: number, y: number): P3 => [x + nx * off, y, z + nz * off];
    const wl = WATER_Y + 0.45, bot = WATER_Y - 1.6, cA = tA + 0.25, cB = tB + 0.25, pA = cA + 0.85, pB = cB + 0.85;
    faceN(E, [P(ax, az, 0, tA), P(bx, bz, 0, tB), P(bx, bz, 0, wl), P(ax, az, 0, wl)], N, STONE);                  // the face
    faceN(E, [P(ax, az, 0, wl), P(bx, bz, 0, wl), P(bx, bz, 0, bot), P(ax, az, 0, bot)], N, WET);                  // the wet band
    faceN(E, [P(ax, az, 0.3, tA - 0.08), P(bx, bz, 0.3, tB - 0.08), P(bx, bz, 0, tB - 0.08), P(ax, az, 0, tA - 0.08)], [0, -1, 0], STONE);   // the coping's underside
    faceN(E, [P(ax, az, 0.3, pA), P(bx, bz, 0.3, pB), P(bx, bz, 0.3, tB - 0.08), P(ax, az, 0.3, tA - 0.08)], N, COPING);   // its face and the parapet's
    faceN(E, [P(ax, az, 0.3, pA), P(bx, bz, 0.3, pB), P(bx, bz, -0.35, pB), P(ax, az, -0.35, pA)], [0, 1, 0], CAP);       // the parapet's top
    faceN(E, [P(ax, az, -0.35, pA), P(bx, bz, -0.35, pB), P(bx, bz, -0.35, cB), P(ax, az, -0.35, cA)], Nb, COPING);       // its land side
    faceN(E, [P(ax, az, -0.35, cA), P(bx, bz, -0.35, cB), P(bx, bz, -1.8, cB), P(ax, az, -1.8, cA)], [0, 1, 0], CAP);     // the coping's top
    faceN(E, [P(ax, az, -1.8, cA), P(bx, bz, -1.8, cB), P(bx, bz, -1.8, tB - 0.45), P(ax, az, -1.8, tA - 0.45)], Nb, COPING);   // its land edge
  }
}

// ---------- the floes (issue #20): ice drifting slowly downstream along the banks ----------
// Flat irregular slabs, one instanced mesh. Each starts near a bank (a bank segment picked by length, 1.5 to 10 out into the water),
// drifts along riverDir at its own slow speed, turns a little, is shoved aside by a ship's hull (world/water.ts eachShip: the ships
// that made a wake this moment), slides along the banks and piers (waterPush), and starts again near another bank when it has
// drifted out into the middle, off the river, or far enough (only where the camera does not see it go).
const FLOE_N = COARSE ? 140 : 260;
interface Floe { x: number; z: number; r: number; sx: number; sz: number; rot: number; w: number; v: number; trip: number }
const FLOES: Floe[] = [];
let floeInst: Inst | null = null, fseed = 7;
const frnd = () => { fseed = (fseed * 16807) % 2147483647; return fseed / 2147483647; };
let BANK_CUM: Float64Array | null = null;
function floeAt(f: Floe, away: boolean) {
  if (!BANK_CUM) { BANK_CUM = new Float64Array(BANK_N + 1); for (let k = 0; k < BANK_N; k++) { const o = 6 * k; BANK_CUM[k + 1] = BANK_CUM[k] + (BANK_RIM[k] ? 0 : Math.hypot(BANK[o + 2] - BANK[o], BANK[o + 3] - BANK[o + 1])); } }
  const L = BANK_CUM[BANK_N], c = camera.position;
  for (let tries = 0; tries < 12; tries++) {
    const s = frnd() * L; let lo = 0, hi = BANK_N - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (BANK_CUM[m] <= s) lo = m; else hi = m - 1; }
    const o = 6 * lo, t = frnd(), r = 1 + frnd() * frnd() * 3.2, d = 1.5 + r + frnd() * 8.5;
    const x = BANK[o] + (BANK[o + 2] - BANK[o]) * t + BANK[o + 4] * d, z = BANK[o + 1] + (BANK[o + 3] - BANK[o + 1]) * t + BANK[o + 5] * d;
    if (!inWater(x, z, r)) continue;
    if (away && (x - c.x) * (x - c.x) + (z - c.z) * (z - c.z) < 160 * 160) continue;
    f.x = x; f.z = z; f.r = r; f.sx = r * (0.75 + 0.5 * frnd()); f.sz = r * (0.75 + 0.5 * frnd()); f.rot = frnd() * 6.283;
    f.w = (frnd() - 0.5) * 0.06; f.v = 0.3 + frnd() * 0.45; f.trip = 0; return true;
  }
  return false;
}
function floeGeo(): Geo {
  const g = Bucket(), n = 9, top: [number, number][] = [];
  for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2, r = 0.72 + 0.28 * hash01(i, 41); top.push([Math.sin(a) * r, Math.cos(a) * r]); }
  for (let i = 0; i < n; i++) {
    const [ax, az] = top[i], [bx, bz] = top[(i + 1) % n];
    tri(g, [0, 0.16, 0], [ax, 0.16, az], [bx, 0.16, bz], 0xe8f0f0);                // the top, facing up
    quad(g, [ax, 0.16, az], [ax, -0.12, az], [bx, -0.12, bz], [bx, 0.16, bz], 0xa9bfc0);   // the sides, facing out
  }
  return g;
}
function buildFloes() {
  FLOES.length = 0;
  for (let i = 0; i < FLOE_N; i++) { const f: Floe = { x: 0, z: 0, r: 1, sx: 1, sz: 1, rot: 0, w: 0, v: 0, trip: 0 }; if (floeAt(f, false)) FLOES.push(f); }
  floeInst = new Inst('floes', floeGeo(), lambert(0xffffff), FLOES.length, { receive: false });
  placeFloes();
}
const FD = new Dummy();
function placeFloes() {
  if (!floeInst) return;
  FLOES.forEach((f, i) => { FD.position.set(f.x, WATER_Y, f.z); FD.rotation.set(0, f.rot, 0); FD.scale.set(f.sx, 1, f.sz); floeInst!.setMatrixAt(i, FD.updateMatrix()); });
  floeInst.update(false);
}
function driftFloes(dt: number) {
  eachShip((x, z, hx, hz, w) => {                                   // the hull as a segment 4.4 beams long, the floe a circle
    const L = 2.2 * w, R = L + w;
    for (const f of FLOES) {
      const dx = f.x - x, dz = f.z - z; if (dx * dx + dz * dz > (R + f.r) * (R + f.r)) continue;
      const u = Math.max(-L, Math.min(L, dx * hx + dz * hz)), px = x + hx * u, pz = z + hz * u, m = w * 0.55 + f.r * 0.8;
      let ex = f.x - px, ez = f.z - pz, d = Math.hypot(ex, ez);
      if (d >= m) continue;
      if (d < 1e-6) { ex = -hz; ez = hx; d = 1; }
      f.x = px + ex / d * m; f.z = pz + ez / d * m;
    }
  });
  for (const f of FLOES) {
    const h = riverDir(f.x, f.z), d = f.v * dt;
    f.x += Math.sin(h) * d; f.z += Math.cos(h) * d; f.rot += f.w * dt; f.trip += d;
    const p = waterPush(f.x, f.z, f.r * 0.9); if (p) { f.x += p.nx * p.pen; f.z += p.nz * p.pen; }
    if (f.trip > 260 || !inRiver(f.x, f.z) || bankDist(f.x, f.z) > 24) floeAt(f, true);
  }
  placeFloes();
}

// ---------- the ponds: still frozen (the old ice with snow drifts and dark cracks, a texture tiled in world units) ----------
function iceTex() {
  return canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#a9c9c6'; g.fillRect(0, 0, w, h);
    for (let k = 0; k < 26; k++) {                                                  // snow drifts
      const x = hash01(k, 1) * w, y = hash01(k, 2) * h, r = 10 + hash01(k, 3) * 34, grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, 'rgba(245,247,246,0.85)'); grd.addColorStop(1, 'rgba(245,247,246,0)'); g.fillStyle = grd;
      for (const [dx, dy] of [[0, 0], [w, 0], [-w, 0], [0, h], [0, -h]]) { g.save(); g.translate(dx, dy); g.fillRect(x - r, y - r, 2 * r, 2 * r); g.restore(); }
    }
    g.strokeStyle = 'rgba(40,64,68,0.75)'; g.lineWidth = 1.4;                       // cracks: a few jagged lines, wrapping round the tile
    for (let k = 0; k < 9; k++) {
      let x = hash01(k, 11) * w, y = hash01(k, 12) * h, a = hash01(k, 13) * Math.PI * 2;
      g.beginPath(); g.moveTo(x, y);
      for (let s = 0; s < 9; s++) { a += (hash01(k * 17 + s, 14) - 0.5) * 1.6; x += Math.cos(a) * 14; y += Math.sin(a) * 14; g.lineTo(x, y); }
      g.stroke();
    }
  }, { repeat: true });
}
function ponds(): Bucket {
  const W = Bucket(), U = 60;
  for (const q0 of DATA.water) {
    const [cx, cz] = polyCentroid(q0); if (inRiver(cx, cz)) continue;                // the Vltava is liquid now
    const q = orient(q0), t = earClip(q);
    for (let i = 0; i < t.length; i += 3) {
      const a = t[i], b = t[i + 2], c = t[i + 1];                                    // turned to face up
      const P = (k: number): P3 => [q[2 * k], POND_Y, q[2 * k + 1]], UV = (k: number): [number, number] => [q[2 * k] / U, q[2 * k + 1] / U];
      tri(W, P(a), P(b), P(c), 0xffffff, UV(a), UV(b), UV(c));
    }
  }
  return W;
}

// ---------- the woods: trees in the parks of the outer zone (Vítkov's slopes, Štvanice, Letná's edge), a jittered grid ----------
const TREES: number[] = [];                                    // x, y, z, scale, height scale, yaw per tree
function woods() {
  TREES.length = 0;
  const STEP = 15, MAX = 2200;
  for (let z = OUTER.z0 + 5; z < OUTER.z1 && TREES.length < MAX * 6; z += STEP) for (let x = OUTER.x0 + 5; x < OUTER.x1; x += STEP) {
    const i = Math.round(x), j = Math.round(z), tx = x + (hash01(i, j) - 0.5) * 12, tz = z + (hash01(j, i + 7) - 0.5) * 12;
    if (tx > ARENA.x0 - 20 && tx < ARENA.x1 + 20 && tz > ARENA.z0 - 20 && tz < ARENA.z1 + 20) continue;
    if (!inPark(tx, tz) || inAnyWater(tx, tz)) continue;
    const y = landH(tx, tz); if (y < -0.3 || bankDist(tx, tz) > -3) continue;      // issue #20: not on the embankment's coping
    if (solidAt(tx, y + 1, tz)) continue;                                          // not in a house
    const s = 0.9 + hash01(i * 3, j * 5) * 0.8, sy = s * (0.85 + hash01(i, j * 3) * 0.35);
    TREES.push(tx, y - 0.2, tz, s, sy, hash01(j, i) * Math.PI * 2);
    solid({ k: 1, x: tx, z: tz, y0: y - 0.2, h: y - 0.2 + 6.4 * sy, a: 2.3 * s, b: 0, ux: 0, uz: 0 }, 2.3 * s);
  }
}
// the city's tree (world/city.ts) made cheaper for the woods, seen from afar: two tiers, five-sided, open below, snow on the top one
function treeGeo(): Geo {
  const g = Bucket();
  for (let i = 0; i < 2; i++) {
    const rr = 2.3 - i * 0.75, h = 3.4 - i * 0.6, y = 1.2 + i * 2.4;
    addGeo(g, translate(cylGeo(0, rr, h, 5, true), 0, y + h / 2, 0), null, COL.teal);
  }
  addGeo(g, translate(cylGeo(0, 0.85, 1.2, 5, true), 0, 6.1, 0), null, SNOW);
  return g;
}
function treeInst(name: string, idx: number[], mat: StandardMaterial) {
  if (!idx.length) return;
  const im = new Inst(name, treeGeo(), mat, idx.length, { receive: false }), o = new Dummy();
  idx.forEach((t, i) => { o.position.set(TREES[t], TREES[t + 1], TREES[t + 2]); o.rotation.set(0, TREES[t + 5], 0); o.scale.set(TREES[t + 3], TREES[t + 4], TREES[t + 3]); im.setMatrixAt(i, o.updateMatrix()); });
  im.update();
  im.mesh.alwaysSelectAsActiveMesh = false; im.mesh.thinInstanceRefreshBoundingInfo(false); im.mesh.freezeWorldMatrix();   // culled by its own box
}

export function buildLand() {
  const G = Bucket(), Wt = Bucket(), E = Bucket();
  terrain(G, Wt);
  bake('landGround', G, lambert(0xffffff), false);                                  // lies on the ground: takes the tanks' shadows
  // issue #20: the river, its embankments and floes; the ponds frozen as before
  river(Wt);
  const wm = riverMat(), water = geoMesh('vltava', Wt, wm, false, false); water.freezeWorldMatrix();
  embankment(E); bake('embankment', E, lambert(0xffffff), false);
  const ice = geoMesh('ponds', ponds(), lambert(0xffffff, { map: iceTex() }), false, true); ice.freezeWorldMatrix();
  buildFloes();
  let t = 0;
  scene.onBeforeRenderObservable.add(() => {                                       // the waves move, the floes drift (every drawn frame)
    const dt = Math.min(0.05, engine.getDeltaTime() / 1000); t += dt;
    wm.setFloat('time', t); wm.setVector3('cam', camera.position);
    wm.setFloat('fogStart', scene.fogStart); wm.setFloat('fogEnd', scene.fogEnd); wm.setColor3('fogColor', scene.fogColor);
    driftFloes(dt);
  });
  woods();
  for (const e of EXTRA) solid({ k: 0, x: e.x, z: e.z, y0: e.y0, h: e.y1, a: e.a, b: e.b, ux: e.ux, uz: e.uz }, Math.hypot(e.a, e.b));
  // the woods in two instanced meshes, the south (Vítkov) and the north, each culled by its own box
  const south: number[] = [], north: number[] = [];
  for (let k = 0; k < TREES.length; k += 6) (TREES[k + 2] > 0 ? south : north).push(k);
  const treeMat = lambert(0xffffff);
  treeInst('landTrees', south, treeMat); treeInst('landTreesNorth', north, treeMat);
}
// how many floes drift (tests)
export const floeCount = () => FLOES.length;
