// World of DODO, issue #27: the near detail of Karlín's houses, and the roof atlas.
//
// A house of the arena is drawn as in issue #16 at every distance (one quad per wall with the window texture of buildings.ts
// facadeMat, now with the plaster's grain as its normal map, its cornice and shop band): cheap, and the city's lit windows as
// before. Up close, within NEAR_R of the camera, the cells of the arena (CELL × CELL units) add real geometry in the material
// library's materials (core/matlib.ts) in front of it: every window a recess with its surround and sill (and on the
// 19th-century houses a cornice over the windows of the first floor), its pane lit or dark exactly where the texture's window
// is (litAt, the same hash). The near parts stand out of the wall and cover the painted window behind them, so switching them
// on and off changes the relief, not the picture. The windows' parts are one small mesh each (the kit: surround + sill with the
// sashes' cross, the window's cornice, the pane), drawn as thin instances per cell: a matrix and a colour per window instead of
// thousands of merged triangles, one draw call per part and cell (three, and one for the houses' mouldings: the profiled cornice,
// the floor bands, the lesenes, the plinth of buildings.ts). None of it casts a shadow; the cells' boxes cull it, and from a roof or
// the air (the height above the houses counts eight times) the cells stay off. A cell's detail is built the first time the camera
// comes near it, not at boot; on the low quality level never (the page starts sooner, and weak devices keep the look of issue #16).
//
// The roofs of the arena's houses sample the roof atlas (tools/assets/roofs.py: the IPR orthophoto, each house's roof cut out
// and packed, winter-neutral colours; its normal map's alpha says where snow settles first: flat roofs before pitched ones, the
// low parts before the high). There is no snow in it: the material library's weather (setWeatherLook) puts the snow on, so the
// roofs can be dry, wet or white (issue #29). roofs.json is bundled, so the roofs get their atlas uvs as they are built. Up close, on
// the high level, the sloped faces get the library's roof tiles over the photo (RoofTiles below); on the low level the roofs are a
// plain material, the half-size atlas read once and washed white by the snow.
import {
  Mesh, VertexData, Texture, StandardMaterial, Color3, MaterialPluginBase, type Material, type MaterialDefines, type BaseTexture, type UniformBuffer,
  type Nullable,
} from '@babylonjs/core';
import { scene, camera } from '../core/engine';
import { Bucket, bake, type P3, type P2 } from '../core/geo';
import { matTex, matLevel, onMatLevel, onWeather, weatherMat, standIn, loadSwap, retire } from '../core/matlib';
import { want } from '../core/assets';
import { basic } from '../core/mat';
import { ARENA } from '../../shared/map.ts';
import { faceN } from './poly';
import ROOFS from './roofs.json' with { type: 'json' };

// ---------- the cells ----------
export const CELL = 80;
// the near radius per quality level (high, medium, low: 0 = no near detail, the look of issue #16 that the brief allows on weak devices)
export const NEAR_R = [60, 50, 0];
const HYST = 12;
const GX0 = ARENA.x0 - 60, GZ0 = ARENA.z0 - 60, GNX = Math.ceil((ARENA.x1 + 60 - GX0) / CELL), GNZ = Math.ceil((ARENA.z1 + 60 - GZ0) / CELL);
export type InstKind = 'pane' | 'frame' | 'ped';
const INST_KINDS: InstKind[] = ['pane', 'frame', 'ped'];
// A cell's near detail is built the first time the camera comes near it (the jobs buildings.ts left for it), not at boot: on the
// low level, and in the parts of the city nobody drives to, it costs nothing.
export interface Cell {
  trim: Bucket;                              // the houses' mouldings (buildings.ts houseTrims)
  inst: Record<InstKind, number[]>;          // per instance 16 matrix numbers and r, g, b
  jobs: (() => void)[];                      // what fills trim and inst, run when the cell is first needed
  m: Mesh[]; box: number[]; isNear: boolean; built: boolean; n: number;
}
const CELLS: Cell[] = [];
for (let k = 0; k < GNX * GNZ; k++) CELLS.push({ trim: Bucket(), inst: { pane: [], frame: [], ped: [] }, jobs: [], m: [], box: [Infinity, Infinity, -Infinity, -Infinity, 0], isNear: false, built: false, n: k });
// the cell of a house (its middle: a house goes whole into one cell)
export function cellAt(x: number, z: number): Cell {
  const i = Math.max(0, Math.min(GNX - 1, Math.floor((x - GX0) / CELL))), j = Math.max(0, Math.min(GNZ - 1, Math.floor((z - GZ0) / CELL)));
  return CELLS[j * GNX + i];
}

// ---------- the window parts (kits), built once in a local frame ----------
// x across the opening (-0.5..0.5, scaled by the window's width), y up it (0..1, scaled by its height), z out of the wall in units.
// The instance matrix puts them on a wall (addInst); the surround's bars are a share of the opening, so they grow with it.
const TX = 0.13, TY = 0.07, DEP = 0.13;
function box6(bk: Bucket, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, faces: string) {
  const W = 0xffffff;
  if (faces.includes('f')) faceN(bk, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], W);
  if (faces.includes('t')) faceN(bk, [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], [0, 1, 0], W);
  if (faces.includes('b')) faceN(bk, [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0], W);
  if (faces.includes('l')) faceN(bk, [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]], [-1, 0, 0], W);
  if (faces.includes('r')) faceN(bk, [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], [1, 0, 0], W);
}
function kitFrame() {
  const b = Bucket();
  box6(b, -0.5 - TX, -0.5, 0, 1 + TY, 0, DEP, 'fr');          // left bar: its front and the reveal inside
  box6(b, 0.5, 0.5 + TX, 0, 1 + TY, 0, DEP, 'fl');            // right bar
  box6(b, -0.5 - TX, 0.5 + TX, 1, 1 + TY, 0, DEP, 'ftb');     // the head: front, top (snow), the reveal's top underneath
  box6(b, -0.5 - TX - 0.05, 0.5 + TX + 0.05, -0.05, 0, 0, DEP + 0.09, 'ft');    // the sill (its top is the reveal's bottom)
  box6(b, -0.025, 0.025, 0, 1, 0, 0.04, 'f'); box6(b, -0.5, 0.5, 0.64, 0.68, 0, 0.04, 'f');   // the sashes' cross in front of the pane
  return b;
}
function kitPed() {
  const b = Bucket();
  box6(b, -0.5 - TX - 0.1, 0.5 + TX + 0.1, 1 + TY + 0.03, 1 + TY + 0.13, 0, DEP + 0.1, 'ftblr');   // the cornice over the window
  box6(b, -0.5 - TX, 0.5 + TX, 1 + TY, 1 + TY + 0.03, 0, DEP + 0.03, 'f');                          // the frieze under it
  return b;
}
function kitPane() {
  const b = Bucket(), z = 0.015;
  const A: P3 = [-0.5, 0, z], B: P3 = [0.5, 0, z], C: P3 = [0.5, 1, z], D: P3 = [-0.5, 1, z];
  // faceN gives no uvs: the pane is written by hand (counter-clockwise from the front, core/geo.ts)
  const push = (v: P3, u: number, w: number) => { b.p.push(v[0], v[1], v[2]); b.n.push(0, 0, 1); b.u.push(u, w); b.c.push(1, 1, 1); };
  push(A, 0, 0); push(B, 1, 0); push(C, 1, 1); push(A, 0, 0); push(C, 1, 1); push(D, 0, 1);
  return b;
}
// The panes, lit and dark alike: unlit, their instance colour is the light behind them (or the dark glass at night), so lit and dark
// windows are one draw call; the sashes' cross is the frame kit's

// A kit as an indexed mesh: the bucket's corners shared where they are the same (position, normal, uv), so that a quad is drawn from
// four vertices instead of six (thousands of instances up close: the vertex work counts). The triangles' corners go in swapped, as
// core/geo.ts geoMesh does (Babylon's front face in this right-handed scene).
function kitMesh(name: string, g: Bucket, mat: Material, receive: boolean): Mesh {
  const key = new Map<string, number>(), P: number[] = [], N: number[] = [], U: number[] = [], C: number[] = [], I: number[] = [], tri: number[] = [];
  for (let v = 0; v < g.p.length / 3; v++) {
    const k = [g.p[3 * v], g.p[3 * v + 1], g.p[3 * v + 2], g.n[3 * v], g.n[3 * v + 1], g.n[3 * v + 2], g.u[2 * v], g.u[2 * v + 1]].map(x => x.toFixed(4)).join();
    let i = key.get(k);
    if (i === undefined) { i = P.length / 3; key.set(k, i); P.push(g.p[3 * v], g.p[3 * v + 1], g.p[3 * v + 2]); N.push(g.n[3 * v], g.n[3 * v + 1], g.n[3 * v + 2]); U.push(g.u[2 * v], g.u[2 * v + 1]); C.push(1, 1, 1, 1); }
    tri.push(i);
    if (tri.length === 3) { I.push(tri[0], tri[2], tri[1]); tri.length = 0; }
  }
  const m = new Mesh(name, scene), vd = new VertexData();
  vd.positions = P; vd.normals = N; vd.uvs = U; vd.colors = C; vd.indices = I; vd.applyToMesh(m, false);
  m.material = mat; m.isPickable = false; m.receiveShadows = receive;
  return m;
}

// ---------- filling the cells ----------
// the near detail of a house, to be built when its cell first comes near: its job, and the house's box (for the cell's distance)
export function nearJob(c: Cell, p: number[], top: number, job: () => void) {
  const b = c.box;
  for (let i = 0; i < p.length; i += 2) { b[0] = Math.min(b[0], p[i] - 1); b[1] = Math.min(b[1], p[i + 1] - 1); b[2] = Math.max(b[2], p[i] + 1); b[3] = Math.max(b[3], p[i + 1] + 1); }
  b[4] = Math.max(b[4], top);
  c.jobs.push(job);
}
// a window part on the wall line a→b (unit direction ux, uz; the house on its right, so outwards is (uz, -ux)), centred at s along
// it, its opening from y to y + h, w wide; col its colour
export function addInst(c: Cell, k: InstKind, ax: number, az: number, ux: number, uz: number, s: number, y: number, w: number, h: number, col: number) {
  // the kit's x runs against the wall's direction, so that x, y and the outward z make a right-handed frame (no mirrored triangles)
  c.inst[k].push(-ux * w, 0, -uz * w, 0, 0, h, 0, 0, uz, 0, -ux, 0, ax + ux * s, y, az + uz * s, 1, ((col >> 16) & 255) / 255, ((col >> 8) & 255) / 255, (col & 255) / 255);
}

// ---------- the roof atlas ----------
// uv of a point of house bi's roof in the atlas, or null if the atlas has no box for it
const RB = (ROOFS as unknown as { b: Record<string, number[]> }).b;
export function roofUV(bi: number): ((x: number, z: number) => P2) | null {
  const r = RB[bi]; if (!r) return null;
  const [, u0, v0, u1, v1, x0, z0, x1, z1, rot] = r;
  // the atlas is loaded the right way up (Babylon's v runs up the picture): 1 - v from the top
  return (x, z) => {
    const tx = (x - x0) / (x1 - x0), tz = (z - z0) / (z1 - z0);
    return [u0 + (rot ? tz : tx) * (u1 - u0), 1 - (v0 + (rot ? tx : tz) * (v1 - v0))];
  };
}
// The tiles up close (high level only). The atlas is projected from above, so on a pitched roof seen from near by it is a smear of
// a few photo pixels. A small material plugin adds the library's roof tiles (roofTiles, its normal map with the height in its alpha)
// on the sloped faces: rows along the eaves, counted in world units up the slope, their relief lit by the moon and the lamps and their
// joints a little darker, faded out by distance (mip maps would flatten them anyway) and gone on flat roofs. It runs before the
// library's weather (priority 150 < 200), whose snow then covers it as it covers the photo.
const TILE_FADE = 70, TILES_N = 'assets/mat/512/roofTiles_n.webp';
class RoofTiles extends MaterialPluginBase {
  tex: Texture | null = null; on = false; tile = 2.4;
  constructor(m: StandardMaterial) { super(m, 'RoofTiles', 150, { WODTILES: false }, true, true); }
  override getClassName() { return 'RoofTiles'; }
  override prepareDefines(d: MaterialDefines) { d.WODTILES = this.on && !!this.tex; }
  // the material waits for the tiles' map (one shader compile with the tiles, not one without and another once the map is in)
  override isReadyForSubMesh() { return !this.on || !this.tex || this.tex.isReady(); }
  override getSamplers(s: string[]) { s.push('wodTileSampler'); }
  override getUniforms() { return { ubo: [{ name: 'wodTile', size: 2, type: 'vec2' }], fragment: 'uniform vec2 wodTile;\n' }; }
  override getActiveTextures(a: BaseTexture[]) { if (this.tex) a.push(this.tex); }
  override hasTexture(t: BaseTexture) { return t === this.tex; }
  override bindForSubMesh(ubo: UniformBuffer) { ubo.updateFloat2('wodTile', 1 / this.tile, TILE_FADE); if (this.tex) ubo.setTexture('wodTileSampler', this.tex); }
  override getCustomCode(type: string): Nullable<{ [p: string]: string }> {
    if (type !== 'fragment') return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: '#ifdef WODTILES\nuniform sampler2D wodTileSampler;\n#endif\n',
      CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `
#if defined(WODTILES) && defined(NORMAL)
{
  vec3 wtN = normalize(vNormalW);
  float wtF = (1.0 - smoothstep(0.9, 0.98, wtN.y)) * (1.0 - smoothstep(wodTile.y * 0.45, wodTile.y, distance(vEyePosition.xyz, vPositionW)));
  if (wtF > 0.002) {
    vec3 wtT = normalize(vec3(wtN.z, 0.0, -wtN.x)), wtB = cross(wtN, wtT);
    vec4 wtM = texture2D(wodTileSampler, vec2(dot(vPositionW, wtT), dot(vPositionW, wtB)) * wodTile.x);
    vec3 wtn = wtM.xyz * 2.0 - 1.0;
    normalW = normalize(mix(normalW, normalize(wtT * wtn.x + wtB * wtn.y + normalW * max(wtn.z, 0.2)), wtF));
    baseColor.rgb *= 1.0 - wtF * 0.35 * (1.0 - clamp(wtM.a * 2.0 - 1.0, 0.0, 1.0));
  }
}
#endif
`,
    };
  }
}
const RI = ROOFS as unknown as { mean: number; pages: { file: string; low: string; n: string }[] };
// The low quality level (weak devices): the roofs drop the library's weather shader for a plain one, the half-size atlas page read
// once and tinted towards white by the weather's snow (onWeather), as cheap as the snowy roofs of issue #16 were. The roofs' meshes
// (tiles.ts 'roofA') get one material or the other.
let ROOF_LOW: StandardMaterial | null = null;
// an atlas page (or its normal map), clamped at its edges; onLoad when it has arrived (issue #31: it goes in then, a stand-in before)
function roofTex(f: string, onLoad: (t: Texture) => void): Texture {
  const t = loadSwap('assets/roofs/' + f, onLoad); t.wrapU = t.wrapV = Texture.CLAMP_ADDRESSMODE; return t;
}
function roofLowMat(): StandardMaterial {
  if (ROOF_LOW) return ROOF_LOW;
  const m = ROOF_LOW = new StandardMaterial('roofLow', scene);
  m.specularColor = Color3.Black(); m.useEmissiveAsIllumination = true;   // the white added after the photo, not tinted by it
  // World of DODO, issue #31: the page's average until the page has arrived (a map put in while it loads keeps every roof from being
  // drawn); the page on the mesh's own uvs: a stand-in with the identity matrix, as the page has (the same shader)
  m.diffuseTexture = standIn('c', 1, true);
  const t = roofTex(RI.pages[0].low, () => { t.level = 0.5 / RI.mean; const old = m.diffuseTexture; m.diffuseTexture = t; if (old !== t) retire(old); });
  // the snow: the photo washed towards the snow's white (the emissive adds the white, the diffuse keeps the roof's own pattern)
  onWeather(w => { const k = 0.85 * w.snow; m.diffuseColor = new Color3(1 - 0.45 * k, 1 - 0.45 * k, 1 - 0.43 * k); m.emissiveColor = new Color3(0.5 * k, 0.53 * k, 0.53 * k); });
  return m;
}
let ROOF_IS_LOW = false;
function roofLow(l: number) {
  const low = l === 2; if (low === ROOF_IS_LOW && (low || !ROOF_LOW)) return;
  ROOF_IS_LOW = low;
  const mat = low ? roofLowMat() : ROOF_MAT;
  for (const m of scene.meshes) if (m.name.startsWith('city_roofA_')) m.material = mat;
}
// the roofs' meshes exist once tiles.ts has baked them: the first frame sets their material for the level
let ROOF_FIRST = true;
export function roofLevelOnce() { if (ROOF_FIRST) { ROOF_FIRST = false; if (matLevel() === 2) { ROOF_IS_LOW = false; roofLow(2); } } }
// the roofs' material: the atlas page (the half-size page on the low level), its normal map with the snow mask (not on low), the
// library's weather (it takes less snow than the ground: the photo still shows on a pitched roof under today's snow)
let ROOF_MAT: StandardMaterial | null = null;
export function roofMat(): StandardMaterial {
  if (ROOF_MAT) return ROOF_MAT;
  const pg = RI.pages[0];
  // World of DODO, issue #34: every page the roofs can show on any level, wanted now (core/assets.ts downloads them before the game):
  // the page, the low level's half-size page (also roofLowMat's), the normal map with the snow mask, and the tiles up close
  for (const f of [pg.file, pg.low, pg.n]) want('assets/roofs/' + f);
  want(TILES_N);
  // World of DODO, issue #31: the material is made with stand-ins (matlib standIn), the maps go in as they arrive (a map put in while
  // it loads kept every roof of the arena from being drawn until it had come, and its shader from compiling before the start): the
  // photo's average (its level 2: the tint itself, as the page's 1 / mean makes it), and a flat normal map with a middling snow mask
  // in its alpha, so that the library's weather reads the mask from the start (it does so only from a normal map it is given when it
  // is made). Both on the mesh's own uvs, the identity matrix, as the pages have. A quality change swaps them (onMatLevel).
  let lvl = matLevel();
  const map = standIn('c', 2, true), bump = lvl < 2 ? standIn('nh', 0.5, true) : undefined;
  const m = ROOF_MAT = weatherMat({ tint: 0x9a948c, snow: 0.5, wet: 0.8, uv: 'mesh', height: true, map, bumpMap: bump, mean: RI.mean });
  map.level = 2;                                                     // (weatherMat set it to 1 / mean, the real page's level)
  // the page for the level, put in when it has arrived (unless the level has asked for the other page since)
  let wantMap = '', wantN = 0;
  const putMap = (f: string) => {
    wantMap = f;
    const t = roofTex(f, () => {
      if (wantMap !== f) { retire(t); return; }                       // (issue #34: retired, core/matlib.ts retire)
      t.level = 1 / RI.mean; t.anisotropicFilteringLevel = lvl === 0 ? 4 : 1; const old = m.diffuseTexture; m.diffuseTexture = t; if (old !== t) retire(old);
    });
  };
  // the normal map with the snow mask (not on low): its stand-in at once, the map when it has arrived
  const putBump = () => {
    if (!m.bumpTexture) m.bumpTexture = standIn('nh', 0.5, true);
    const my = ++wantN, t = roofTex(pg.n, () => {
      if (my !== wantN || !m.bumpTexture) { retire(t); return; }
      t.level = 0.5; const old = m.bumpTexture; m.bumpTexture = t; if (old !== t) retire(old);
    });
  };
  putMap(lvl === 2 ? pg.low : pg.file);
  if (bump) putBump();
  const tiles = new RoofTiles(m), tilesOn = (l: number) => {
    if (l !== 0) { if (tiles.on) { tiles.on = false; tiles.markAllDefinesAsDirty(); } return; }
    if (tiles.tex) { if (!tiles.on) { tiles.on = true; tiles.markAllDefinesAsDirty(); } return; }
    // issue #31: a stand-in until the tiles' map has arrived, a flat normal with no joint (alpha 255: the photo as it is), so that the
    // shader with the tiles (WODTILES) compiles at once and the roofs are drawn meanwhile; then the map, no shader change
    tiles.tex = standIn('n', 1); tiles.on = true; tiles.markAllDefinesAsDirty();
    const t = loadSwap(TILES_N, () => { const old = tiles.tex; tiles.tex = t; if (old !== t) retire(old); });
  };
  tilesOn(lvl);
  if (new URLSearchParams(location.search).has('test')) (window as unknown as { wodRoofTiles: (on: boolean) => void }).wodRoofTiles = on => { tiles.on = on && !!tiles.tex; tiles.markAllDefinesAsDirty(); };
  onMatLevel(l => {
    tilesOn(l); roofLow(l);
    if (l === lvl) return; const was = lvl; lvl = l;
    if ((l === 2) !== (was === 2)) putMap(l === 2 ? pg.low : pg.file);
    else if (m.diffuseTexture) m.diffuseTexture.anisotropicFilteringLevel = l === 0 ? 4 : 1;
    if (l === 2 && m.bumpTexture) { wantN++; const b = m.bumpTexture; m.bumpTexture = null; retire(b); }
    else if (l < 2 && !m.bumpTexture) putBump();
  });
  return m;
}

// ---------- baking ----------
// the window parts and the mouldings in the library's stucco (the weather's snow settles on their tops: sills, heads, cornices)
let TRIM_MAT: StandardMaterial | null = null;
// (no normal map: the stucco's grain is invisible on a sill or a cornice, and thousands of small faces up close made it costly)
const trimMat = () => TRIM_MAT ??= matTex('stucco', { tint: 0xffffff, flatLow: true, snow: 0.9, bump: 0 });
let KIT: Record<InstKind, { g: Bucket; m: Material }> | null = null;
// a cell's meshes: its jobs run, the mouldings baked, the window parts as thin instances (once; the jobs and the arrays then go)
function buildCell(c: Cell) {
  c.built = true; NEAR.built++;
  const trim = trimMat();
  KIT ??= { pane: { g: kitPane(), m: basic(0xffffff) }, frame: { g: kitFrame(), m: trim }, ped: { g: kitPed(), m: trim } };
  for (const j of c.jobs) j();
  c.jobs = [];
  const t = bake('near_trim_' + c.n, c.trim, trim, false); if (t) c.m.push(t);
  for (const k of INST_KINDS) {
    const a = c.inst[k], cnt = a.length / 19; if (!cnt) continue;
    const m = kitMesh('near_' + k + '_' + c.n, KIT[k].g, KIT[k].m, k !== 'pane');
    const mx = new Float32Array(cnt * 16), col = new Float32Array(cnt * 4);
    for (let i = 0; i < cnt; i++) {
      for (let j = 0; j < 16; j++) mx[i * 16 + j] = a[i * 19 + j];
      col[i * 4] = a[i * 19 + 16]; col[i * 4 + 1] = a[i * 19 + 17]; col[i * 4 + 2] = a[i * 19 + 18]; col[i * 4 + 3] = 1;
    }
    m.thinInstanceSetBuffer('matrix', mx, 16, true);
    m.thinInstanceSetBuffer('color', col, 4, true);
    m.thinInstanceRefreshBoundingInfo(false);
    m.freezeWorldMatrix();
    c.m.push(m);
  }
  for (const m of c.m) m.setEnabled(false);
  c.trim = Bucket(); c.inst = { pane: [], frame: [], ped: [] };
}
// The switch, before every frame: a cell's near detail on within NEAR_R of the camera, its height above the cell's houses counting
// eight times (the relief is for the street: from a roof or a plane it is hardly seen, and there are many more windows in view),
// off beyond it. A cell is built a little before it is needed (within NEAR_R + BUILD_AHEAD), at most one a frame.
const BUILD_AHEAD = 50;
// a cell's distance from the camera at (x, y, z): its houses' box, the height above them counting eight times
function cellDist(c: Cell, x: number, y: number, z: number) {
  const dx = Math.max(c.box[0] - x, 0, x - c.box[2]), dz = Math.max(c.box[1] - z, 0, z - c.box[3]), dy = 8 * Math.max(0, y - c.box[4]);
  return Math.sqrt(dx * dx + dz * dz + dy * dy);
}
// World of DODO, issue #31: how many cells have been built, and how many of them in a drawn frame (by the switch below): the loading
// screen builds the cells round the spawn beforehand (nearAround), so standing there the game builds none (the tests read it)
export const NEAR = { built: 0, inFrame: 0 };
export function bakeCells() {
  scene.onBeforeRenderObservable.add(() => {
    roofLevelOnce();
    const p = camera.position, R = NEAR_R[matLevel()] ?? 0;
    if (!R) { for (const c of CELLS) if (c.isNear) { c.isNear = false; for (const m of c.m) m.setEnabled(false); } return; }
    let built = false;
    for (const c of CELLS) {
      if (c.box[0] === Infinity) continue;
      const d = cellDist(c, p.x, p.y, p.z);
      if (!c.built) { if (d < R + BUILD_AHEAD && (!built || d < R)) { buildCell(c); built = true; NEAR.inFrame++; } else continue; }
      const near = c.isNear ? d < R + HYST : d < R;
      if (near !== c.isNear) { c.isNear = near; for (const m of c.m) m.setEnabled(near); }
    }
  });
  // issue #31: the houses' near detail is drawn in the library's stucco: made now, so that its maps are asked for with the city's and
  // the loading screen's texture step waits for them too. World of DODO, issue #34: also on the low level, which has no near detail:
  // its files are downloaded before the game all the same, for a level change in the game (the material is drawn by no mesh there)
  trimMat();
}
// World of DODO, issue #31: build up to max of the cells the switch above would build for a camera at (x, y, z) (within NEAR_R +
// BUILD_AHEAD, nearest first), before the game starts; returns how many are left to build there (0 on the low level: no near detail).
// The loading screen calls it in slices until 0, so the first frames build nothing (a cell is some milliseconds).
export function nearAround(x: number, y: number, z: number, max: number): number {
  const R = NEAR_R[matLevel()] ?? 0; if (!R) return 0;
  const todo: { c: Cell; d: number }[] = [];
  for (const c of CELLS) {
    if (c.built || c.box[0] === Infinity) continue;
    const d = cellDist(c, x, y, z); if (d < R + BUILD_AHEAD) todo.push({ c, d });
  }
  todo.sort((a, b) => a.d - b.d);
  const n = Math.min(Math.max(0, max), todo.length);
  for (let k = 0; k < n; k++) buildCell(todo[k].c);
  return todo.length - n;
}
