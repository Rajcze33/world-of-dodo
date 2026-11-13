// World of DODO, issue #16: the houses of the real Karlín, every footprint of client/shared/karlin.json extruded: facades with a
// row of windows per floor (the original's facade texture, lit windows glowing at night), the colour of the house, a cornice, a
// darker ground floor with shop windows towards the street, and a snowy roof. Far houses (outside the arena, seen mostly from a
// plane) are the same without the street-level detail.
//
// Roofs: flat ones (r 0) get a snow cap. Pitched ones (r 1) are built edge by edge: every free wall's top line moves inwards by the
// same run and rises by the roof's height, a wall shared with the house next door (Karlín's houses stand wall to wall) stays put
// and rises straight up as a gable. So a row of houses gets one long roof along the street with a ridge, a corner house a hip at the
// corner, a free-standing one a hipped roof. The ring of moved lines is checked (poly.ts insetOk) and the run shortened until it
// does not break; a footprint where no run works gets a flat roof. Mansards (r 2): a steep dark slope and a snowy top.
// Shared walls are found once, by matching the edges of neighbouring footprints; the part a neighbour hides is not drawn at all.
//
// World of DODO, issue #27: real materials and Karlín's facades. Every facade keeps the window texture of issue #16 (one quad per
// wall, its lit windows; now with the plaster's grain as a normal map), which is all that is drawn from afar. On the arena's houses
// the texture's bays are centred on each wall, and up close (world/facade.ts: per cell of the arena, within ~60 of the camera) real
// windows stand in front of the painted ones, lit where those are: a recess with its surround, its sill and the sashes' cross, and
// on the 19th-century blocks (pitched or mansard roofs, three floors or more) a cornice over the windows of the first floor (the
// piano nobile); the shops get frames, the house its door in a stone portal. The mouldings (a stone plinth; on the 19th-century
// blocks a profiled main cornice round the old one, floor bands and lesenes at the corners) are near detail too.
// The offices, shops and hotels with flat roofs get the material library's glass facade, its lit offices included; sheds, garages,
// sites and ruins plain walls; fire walls above a lower neighbour, gables and chimneys stay vertex-coloured as in issue #16.
// The roofs of the arena's houses are the orthophoto's (facade.ts, the roof atlas, its snow the weather's: none baked in, so issue #29
// can melt it); the far houses' roofs and the mansards' slopes stay as in issue #16 (their snow thaws with the weather too, matlib's
// baked vertex colours). The weather's snow also settles on the near sills and cornices.
import { DATA, ARENA, nearestEdge, inArena } from '../../shared/map.ts';
import { Hash, polyArea, polyCentroid } from '../../shared/geom.ts';
import { Texture, StandardMaterial, Color3 } from '@babylonjs/core';
import { tri, boxB, type Bucket, type P3 } from '../core/geo';
import { canvasTex } from '../core/tex';
import { lambert } from '../core/mat';
import { scene } from '../core/engine';
import { matLevel, onMatLevel, standIn, loadSwap, retire } from '../core/matlib';
import { want } from '../core/assets';
import { wall, capUp, faceN, grow, insetEdges, insetOk, minWidth, orient, dedupe, hash01 } from './poly';
import { tileB, tileKind, part, type Build } from './tiles';
import { cellAt, addInst, nearJob, bakeCells, roofUV, roofMat, type Cell } from './facade';

// the facade colours karlin.json's c indexes (KARLIN-DATA.md: cream, ochre, light grey, white, salmon, sage, grey-blue, brick)
export const PALETTE = [0xefe6cf, 0xe3c78a, 0xc9c9c4, 0xf4f4f0, 0xe7b9a5, 0xc2d1b0, 0xb5c3cf, 0xb46a50];
export const SNOW = 0xf2f5f4, SLATE = 0x4a5150, DARK = 0x3d4543;
export const shade = (c: number, k: number) => (Math.min(255, Math.round(((c >> 16) & 255) * k)) << 16) | (Math.min(255, Math.round(((c >> 8) & 255) * k)) << 8) | Math.min(255, Math.round((c & 255) * k));
export const mix = (a: number, b: number, t: number) => {
  const m = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return (m(16) << 16) | (m(8) << 8) | m(0);
};

// ---------- the facade texture: 16 bays × 8 floors, the lit windows in their own glow map ----------
// One tile is 16 bays of BAY units across and 8 floors up; a wall's v counts its own floors (karlin.json's f), so the rows of windows
// fit every house's storey height. The lit pattern is hashed (the same in every browser).
export const BAY = 2.5, BAYS = 16, FLOORS = 8;
const LIT_C = ['#f5cf8a', '#f5cf8a', '#f2d9a8', '#eef0ea', '#b2dcd6'];
// (issue #27: exported, the near windows of facade.ts glow where the texture's do)
export const litAt = (x: number, y: number) => { const r = hash01(x * 7 + 3, y * 13 + 1); return r < 0.32 ? LIT_C[(hash01(x, y + 99) * LIT_C.length) | 0] : null; };
let FAC_MAT: ReturnType<typeof lambert> | null = null;
export function facadeMat() {
  if (FAC_MAT) return FAC_MAT;
  const W = 32, H = 48;
  const map = canvasTex(BAYS * W, FLOORS * H, (g, w, h) => {
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
    for (let y = 0; y < FLOORS; y++) for (let x = 0; x < BAYS; x++) {
      const X = x * W, Y = y * H;
      g.fillStyle = '#e3e5e4'; g.fillRect(X + 7, Y + 36, 18, 3);                       // the sill
      g.fillStyle = '#d9dbda'; g.fillRect(X + 8, Y + 7, 16, 3);                        // the lintel
      g.fillStyle = '#3d4543'; g.fillRect(X + 10, Y + 10, 12, 26);                     // the pane
      g.fillStyle = '#d6d8d7'; g.fillRect(X + 15, Y + 10, 2, 26); g.fillRect(X + 10, Y + 19, 12, 2);   // the cross of the frame
    }
  }, { repeat: true });
  const em = canvasTex(BAYS * W, FLOORS * H, (g, w, h) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
    for (let y = 0; y < FLOORS; y++) for (let x = 0; x < BAYS; x++) {
      const c = litAt(x, y); if (!c) continue;
      g.fillStyle = c; g.fillRect(x * W + 10, y * H + 10, 12, 26);
      g.fillStyle = '#000'; g.fillRect(x * W + 15, y * H + 10, 2, 26); g.fillRect(x * W + 10, y * H + 19, 12, 2);
    }
  }, { repeat: true });
  FAC_MAT = lambert(0xffffff, { map, emissive: 0xffffff, emissiveMap: em, emissiveIntensity: 0.9 });
  // World of DODO, issue #27: the plaster's grain (the material library's fine plaster, its normal map) on every facade, lit by the moon
  // and the lamps; one tile of the facade texture is 16 bays (40 units) across and 8 floors (some 24 units) up. On the high level only
  // (a normal map on every facade of the city costs some GPU time).
  // (World of DODO, issue #31: a flat stand-in at once, scaled as the map is, and the map put in once it has arrived: a normal map
  // put in while it loads kept every facade of the city from being drawn, and its shader from compiling before the start)
  // (World of DODO, issue #34: the map wanted now on every level, core/assets.ts downloads it before the game; maps taken off are
  // retired, core/matlib.ts retire)
  let gen = 0;
  const GRAIN = 'assets/mat/512/plasterBeige_n.webp';
  want(GRAIN);
  const m = FAC_MAT, grain = (l: number) => {
    if (l > 0) { gen++; const b = m.bumpTexture; m.bumpTexture = null; retire(b); return; }
    if (m.bumpTexture) return;
    const my = ++gen, sc = (t: Texture) => { t.uScale = BAYS * BAY / 2.5; t.vScale = 9.5; t.level = 0.8; return t; };
    m.bumpTexture = sc(standIn('n', 0.8));
    const g = loadSwap(GRAIN, () => { if (my !== gen) { retire(g); return; } const old = m.bumpTexture; m.bumpTexture = sc(g); if (old !== g) retire(old); });
  };
  grain(matLevel()); onMatLevel(grain);
  return FAC_MAT;
}
// World of DODO, issue #27: places in the facade texture for faces of the far facades that are not windows: a plain white texel (a
// cornice, the shops' band: their vertex colour shows) and the middle of a warm lit pane and of a dark pane (the far shop windows).
// The texture is drawn upside down in v (canvas row 0 at v 1).
const TEX_WHITE: [number, number] = [4 / (BAYS * 32), 1 - 2 / (FLOORS * 48)];
const paneUV = (want: (c: string | null) => boolean): [number, number] => {
  for (let y = 0; y < FLOORS; y++) for (let x = 0; x < BAYS; x++) if (want(litAt(x, y))) return [(x * 32 + 13) / (BAYS * 32), 1 - (y * 48 + 26) / (FLOORS * 48)];
  return TEX_WHITE;
};
const TEX_LIT = paneUV(c => c === LIT_C[0]), TEX_DARK = paneUV(c => c === null);
// a quad of a far facade at one texel of the texture (its colour from the vertex colour, or from the texel's glow)
function wallAt(bk: Bucket, ax: number, az: number, bx: number, bz: number, y0: number, y1: number, col: number, t: [number, number]) {
  wall(bk, ax, az, bx, bz, y0, y1, col, [t[0], t[0], t[1], t[1]]);
}
function capAt(bk: Bucket, A: P3, B: P3, C: P3, col: number, t: [number, number]) { tri(bk, A, B, C, col, t, t, t); }

// ---------- shared walls ----------
// For every edge of every footprint: how much of it a neighbour's wall covers (0..1), and the neighbour's height there (the one
// covering most). Edges match when they run the opposite way within 0.4 of each other.
export interface Party { cov: number[]; top: number[] }
// (World of DODO, issue #31: a builder, as the city's (tiles.ts Build): the edges' hash a unit, then 1500 edges a unit)
export function* parties(bs: { p: number[]; h: number }[]): Build<Party[]> {
  const H = new Hash<number>(-720, -720, 720, 720, 12), E: number[] = [], Q: number[] = [];   // E: building, edge, ax, az, bx, bz
  bs.forEach((b, bi) => {
    const p = b.p, n = p.length;
    for (let i = 0; i < n; i += 2) {
      const j = (i + 2) % n, k = E.length / 6; E.push(bi, i >> 1, p[i], p[i + 1], p[j], p[j + 1]);
      H.add([Math.min(p[i], p[j]) - 0.4, Math.min(p[i + 1], p[j + 1]) - 0.4, Math.max(p[i], p[j]) + 0.4, Math.max(p[i + 1], p[j + 1]) + 0.4], k);
    }
  });
  const out: Party[] = bs.map(b => ({ cov: new Array(b.p.length >> 1).fill(0), top: new Array(b.p.length >> 1).fill(0) }));
  const iv: number[][] = [], NE = E.length / 6;
  yield 0.2;
  for (let k = 0; k < NE; k++) {
    if (k % 1500 === 1499) yield 0.2 + 0.8 * k / NE;
    const bi = E[6 * k], ax = E[6 * k + 2], az = E[6 * k + 3], bx = E[6 * k + 4], bz = E[6 * k + 5], L = Math.hypot(bx - ax, bz - az); if (L < 0.3) continue;
    const ux = (bx - ax) / L, uz = (bz - az) / L; iv.length = 0;
    for (const f of H.query(Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz), Q)) {
      const fb = E[6 * f]; if (fb === bi) continue;
      const cx = E[6 * f + 2], cz = E[6 * f + 3], dx = E[6 * f + 4], dz = E[6 * f + 5], fl = Math.hypot(dx - cx, dz - cz); if (fl < 0.3) continue;
      if ((dx - cx) / fl * ux + (dz - cz) / fl * uz > -0.96) continue;
      if (Math.abs((cx - ax) * uz - (cz - az) * ux) > 0.4 || Math.abs((dx - ax) * uz - (dz - az) * ux) > 0.4) continue;
      const t1 = (cx - ax) * ux + (cz - az) * uz, t2 = (dx - ax) * ux + (dz - az) * uz, lo = Math.max(0, Math.min(t1, t2)), hi = Math.min(L, Math.max(t1, t2));
      if (hi - lo > 0.05) iv.push([lo, hi, bs[fb].h]);
    }
    if (!iv.length) continue;
    iv.sort((a, b) => a[0] - b[0]);
    let cov = 0, end = -1, best = 0, top = 0;
    for (const [lo, hi, h] of iv) { if (hi > end) { cov += hi - Math.max(lo, end); end = hi; } if (hi - lo > best) { best = hi - lo; top = h; } }
    out[bi].cov[E[6 * k + 1]] = cov / L; out[bi].top[E[6 * k + 1]] = top;
  }
  return out;
}

// ---------- World of DODO, issue #27: the materials of the houses ----------
// tiles.ts kinds (the near detail is facade.ts's): the offices' glass and the arena's roofs (the orthophoto atlas, facade.ts). Each
// kind is a mesh per tile, and another in the shadow pass: few kinds, few draw calls. Everything plain (fire
// walls, gables, chimneys, sheds, the far houses' roofs) stays in the city's vertex-coloured 'vc' tiles as in issue #16.
let KINDS_DONE = false;
function kinds() {
  if (KINDS_DONE) return; KINDS_DONE = true;
  const W = 0xffffff;
  tileKind('bglass', glassMat());
  // the arena's roofs: the orthophoto atlas. No shadows: the walls cast the houses' shadows, and the roofs in the shadow pass cost
  // more than their part of the shadow shows at night
  tileKind('roofA', roofMat(), { cast: false });
}
// The offices' glass: the library's glass facade (its colour map is the lit offices, so it is also the glow), one tile some nine
// floors (GLASS_TILE units). A plain material on the walls' own uvs, not the library's weather shader: a vertical glass wall takes
// no snow, and a shader the less to compile makes the page start sooner on a weak device (and it is cheaper to draw). The map's size
// follows the quality level (1024 on high, 512 else). One of the library's two glass facades only: the second would cost 7 MB more.
const GLASS_TILE = 25.5;
let GLASS_MAT: StandardMaterial | null = null;
function glassMat(): StandardMaterial {
  if (GLASS_MAT) return GLASS_MAT;
  const m = GLASS_MAT = new StandardMaterial('glass', scene);
  m.specularColor = Color3.Black(); m.emissiveColor = Color3.Black(); m.useEmissiveAsIllumination = true;
  // (World of DODO, issue #31: stand-ins at once, a dark glass with no glow, on the walls' own uvs as the map is; the map put in as the
  // glow and the colour once it has arrived: a map put in while it loads kept the offices from being drawn until it had come)
  m.diffuseTexture = standIn('c', 0.3, true); m.emissiveTexture = standIn('e', 1, true);
  // (World of DODO, issue #34: both sizes wanted now, core/assets.ts downloads them before the game; maps taken off are retired)
  const url = (sz: number) => 'assets/mat/' + sz + '/glassOffice_c.webp';
  want(url(1024)); want(url(512));
  let size = 0;
  const maps = (l: number) => {
    const sz = l === 0 ? 1024 : 512; if (sz === size) return; size = sz;
    const d = loadSwap(url(sz), () => { if (size !== sz) { retire(d); return; } const od = m.diffuseTexture; m.diffuseTexture = d; if (od !== d) retire(od); });
    const e = loadSwap(url(sz), () => { if (size !== sz) { retire(e); return; } e.level = 0.85; const oe = m.emissiveTexture; m.emissiveTexture = e; if (oe !== e) retire(oe); });
  };
  maps(matLevel()); onMatLevel(maps);
  return m;
}
// the roof colours as vertex colours over the grey tiles' texture (its own average brought to 1 by the library)
const OFFICE = new Set(['office', 'retail', 'hotel']);
type Style = 'c19' | 'simple' | 'glass' | 'plain' | 'far';

// ---------- one house ----------
// o.detail: street-level detail (cornice, ground floor, shop windows, chimney): the arena's houses; o.col overrides the colour,
// o.flat forces a flat roof. Returns the roof's top ring height (for landmarks that add to it).
export interface HouseOpt { detail?: boolean; col?: number; flat?: boolean; plain?: boolean; roofCol?: number }
export function house(bi: number, B: { p: number[]; h: number; y0?: number; r: number; rh: number; f: number; c: number; k?: string }, P: Party, o: HouseOpt = {}) {
  kinds();
  const p = B.p, n = p.length >> 1, y0 = B.y0 || 0, h = B.h > y0 ? B.h : y0 + B.h, f = Math.max(1, B.f), fh = (h - y0) / f;
  const [cx, cz] = polyCentroid(p), FAC = tileB('fac', cx, cz), VC = tileB('vc', cx, cz), GL = tileB('glow', cx, cz);
  const col = o.col ?? shade(PALETTE[B.c] ?? PALETTE[0], 0.93 + 0.12 * hash01(bi, 5)), fire = shade(col, 0.88);
  const plain = o.plain || B.k === 'garage' || B.k === 'shed' || B.k === 'construction' || B.k === 'ruins';
  const party = P.cov.map(c => c >= 0.6), free: boolean[] = party.map(x => !x);
  // issue #27: which kind of house (see the top); the arena's facades get their near detail in a cell of facade.ts
  const style: Style = !o.detail ? (plain ? 'plain' : 'far') : plain ? 'plain'
    : B.r === 0 && OFFICE.has(B.k ?? '') && f >= 3 ? 'glass'
    : B.r >= 1 && f >= 3 ? 'c19' : 'simple';
  const facade = style === 'c19' || style === 'simple', cell = o.detail && facade ? cellAt(cx, cz) : null;
  // issue #27: the near detail (window parts, mouldings) is left as jobs for the house's cell (facade.ts builds them when it first
  // comes near the camera, never on the low level)
  const late: (() => void)[] = [];
  const V0 = Math.floor(hash01(bi, 2) * FLOORS), v0 = V0 / FLOORS, vt = v0 + f / FLOORS;
  // the free walls with a street in front (the shops; as issue #16 decided it)
  const pl = grow(p, 0.1), street = free.map((fr, i) => {
    if (!fr || !o.detail || !facade || f < 2) return false;
    const j = (i + 1) % n, ax = pl[2 * i], az = pl[2 * i + 1], bx = pl[2 * j], bz = pl[2 * j + 1], L = Math.hypot(bx - ax, bz - az);
    const mx = (ax + bx) / 2 + (bz - az) / (L || 1) * 3, mz = (az + bz) / 2 - (bx - ax) / (L || 1) * 3, ne = nearestEdge(mx, mz);
    return inArena(mx, mz) && !!ne && ne.d - ne.e.w / 2 < 4;
  });
  // the walls: the facade where it is free (or only partly covered), plain above a lower neighbour where it is shared
  let acc = Math.floor(hash01(bi, 1) * BAYS) * BAY;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, ax = p[2 * i], az = p[2 * i + 1], bx = p[2 * j], bz = p[2 * j + 1], L = Math.hypot(bx - ax, bz - az);
    if (party[i]) { const t = Math.max(y0, P.top[i]); if (t < h - 0.15) wall(VC, ax, az, bx, bz, t, h, fire); }
    else if (style === 'plain') wall(VC, ax, az, bx, bz, y0, h, col);
    else if (style === 'glass') wall(tileB('bglass', cx, cz), ax, az, bx, bz, y0, h, 0xffffff, [acc / GLASS_TILE, (acc + L) / GLASS_TILE, y0 / GLASS_TILE, h / GLASS_TILE]);
    else if (cell && L > 0.05) facadeWall(cell, late, FAC, bi, i, style, ax, az, bx, bz, L, y0, f, fh, col, V0, v0, vt, street[i]);
    else wall(FAC, ax, az, bx, bz, y0, h, col, [acc / (BAYS * BAY), (acc + L) / (BAYS * BAY), v0, vt]);
    acc += L;
  }
  if (style === 'glass') {                                                            // issue #27: the offices' parapet, a slim coping
    const g = grow(p, 0.12);
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; if (free[i]) wall(VC, g[2 * i], g[2 * i + 1], g[2 * j], g[2 * j + 1], h - 0.35, h + 0.25, 0xd9dcda); }
  }
  // street-level detail: a cornice along the free walls, a darker ground floor with shop windows where a street is in front
  if (o.detail && facade) {
    const g = grow(p, 0.28), cc = mix(col, 0xffffff, 0.55), ch0 = h - 0.45, ch1 = h + 0.15;
    for (let i = 0; i < n; i++) {
      if (!free[i]) continue;
      const j = (i + 1) % n, ax = p[2 * i], az = p[2 * i + 1], bx = p[2 * j], bz = p[2 * j + 1];
      wall(VC, g[2 * i], g[2 * i + 1], g[2 * j], g[2 * j + 1], ch0, ch1, cc);
      tri(VC, [ax, ch1, az], [bx, ch1, bz], [g[2 * j], ch1, g[2 * j + 1]], cc); tri(VC, [ax, ch1, az], [g[2 * j], ch1, g[2 * j + 1]], [g[2 * i], ch1, g[2 * i + 1]], cc);   // top
      tri(VC, [ax, ch0, az], [g[2 * j], ch0, g[2 * j + 1]], [bx, ch0, bz], shade(cc, 0.8)); tri(VC, [ax, ch0, az], [g[2 * i], ch0, g[2 * i + 1]], [g[2 * j], ch0, g[2 * j + 1]], shade(cc, 0.8));   // underside
    }
    const ph = y0 + Math.min(fh * 0.92, 3.4), dk = shade(col, 0.72), trim = mix(col, 0xffffff, 0.45);
    let door = -1, best = 0;                                                         // issue #27: the house's door, on its longest street wall
    for (let i = 0; i < n; i++) if (street[i]) { const j = (i + 1) % n, L = Math.hypot(pl[2 * j] - pl[2 * i], pl[2 * j + 1] - pl[2 * i + 1]); if (L > best) { best = L; door = i; } }
    if (B.k) door = -1;
    for (let i = 0; i < n; i++) {
      if (!street[i]) continue;
      const j = (i + 1) % n, ax = pl[2 * i], az = pl[2 * i + 1], bx = pl[2 * j], bz = pl[2 * j + 1], L = Math.hypot(bx - ax, bz - az);
      wall(VC, ax, az, bx, bz, y0, ph, dk);
      tri(VC, [p[2 * i], ph, p[2 * i + 1]], [p[2 * j], ph, p[2 * j + 1]], [bx, ph, bz], dk); tri(VC, [p[2 * i], ph, p[2 * i + 1]], [bx, ph, bz], [ax, ph, az], dk);   // its ledge
      const m = Math.floor(L / 4.2); if (m < 1) continue;
      const ux = (bx - ax) / L, uz = (bz - az) / L, ox = uz * 0.03, oz = -ux * 0.03;
      for (let k = 0; k < m; k++) {
        const s = (k + 0.5) * L / m, r = hash01(bi * 31 + i, k), lit = r < 0.5;
        if (i === door && k === Math.floor(m / 2)) {                                  // issue #27: the entrance, a wooden door in a stone portal
          const sy = y0 + 0.12, sh = ph - 0.45 - sy;
          wall(VC, ax + ux * (s - 0.75) + ox, az + uz * (s - 0.75) + oz, ax + ux * (s + 0.75) + ox, az + uz * (s + 0.75) + oz, sy, sy + sh, 0x4a3a2c);
          if (cell) { const c = cell; late.push(() => { addInst(c, 'frame', ax + ox, az + oz, ux, uz, s, sy, 1.5, sh, 0xd9d2c3); addInst(c, 'ped', ax + ox, az + oz, ux, uz, s, sy, 1.5, sh, 0xd9d2c3); }); }
          continue;
        }
        const x0 = ax + ux * (s - 1.1) + ox, z0 = az + uz * (s - 1.1) + oz, x1 = ax + ux * (s + 1.1) + ox, z1 = az + uz * (s + 1.1) + oz;
        wall(lit ? GL : VC, x0, z0, x1, z1, y0 + 0.5, ph - 0.45, lit ? (r < 0.3 ? 0xf6cf8a : r < 0.42 ? 0xeef0ea : 0xb2dcd6) : 0x2b3130);
        if (cell) { const c = cell; late.push(() => addInst(c, 'frame', ax + ox, az + oz, ux, uz, s, y0 + 0.5, 2.2, ph - 0.95, shade(trim, 0.85))); }   // issue #27: its frame
      }
    }
  }
  if (cell) { const c = cell; late.push(() => houseTrims(c.trim, style, p, free, y0, h, f, fh, col)); nearJob(cell, p, h + 1, () => { for (const j of late) j(); }); }
  return roof(bi, B, p, party, h, col, o);
}

// ---------- World of DODO, issue #27: a free facade wall of an arena house ----------
// The wall with the window texture, its bays put where the near windows are (centred on the wall, MARGIN at the ends), and the near
// windows (facade.ts instances: the pane, lit or dark as the texture has it, the surround and sill, the window cornice on the first
// floor of a 19th-century house), on every floor but a street wall's ground floor (the shops).
const WIN_W = 1.05, MARGIN = 0.8, DARK_GLASS = [0x2b3130, 0x272c2c, 0x323837];
function facadeWall(c: Cell, late: (() => void)[], FAC: Bucket, bi: number, i: number, style: Style, ax: number, az: number, bx: number, bz: number, L: number,
  y0: number, f: number, fh: number, col: number, V0: number, v0: number, vt: number, street: boolean) {
  const ux = (bx - ax) / L, uz = (bz - az) / L, h = y0 + f * fh;
  const nb = Math.max(0, Math.floor((L - 2 * MARGIN) / BAY)), s0 = (L - nb * BAY) / 2, bo = Math.floor(hash01(bi * 7 + i, 3) * BAYS);
  // the texture's bays bo.. over the windows, a window-less column of it (TEX_WHITE's) at the wall's ends: no painted half window
  // shows beside the near ones
  const U = (bo + nb) / BAYS, ex = (s: number) => [ax + ux * s, az + uz * s] as [number, number], WU = TEX_WHITE[0];
  if (nb) {
    const [px0, pz0] = ex(s0), [px1, pz1] = ex(L - s0);
    wall(FAC, px0, pz0, px1, pz1, y0, h, col, [bo / BAYS, U, v0, vt]);
    if (s0 > 0.02) { wall(FAC, ax, az, px0, pz0, y0, h, col, [WU, WU, v0, vt]); wall(FAC, px1, pz1, bx, bz, y0, h, col, [WU, WU, v0, vt]); }
  } else wall(FAC, ax, az, bx, bz, y0, h, col, [WU, WU, v0, vt]);
  late.push(() => {
    const tc = mix(col, 0xffffff, 0.45), pedRow = style === 'c19' && f >= 3 ? 1 : -1;
    const ww = Math.min(WIN_W, 0.45 * BAY), wh = Math.min(0.54 * fh, 2.3);
    for (let fl = street ? 1 : 0; fl < f; fl++) {
      // the texture's floor fl is its row FLOORS - 1 - (V0 + fl) % FLOORS from the top (the canvas is drawn upside down in v)
      const yb = y0 + fl * fh + 0.25 * fh, row = FLOORS - 1 - ((V0 + fl) % FLOORS);
      for (let k = 0; k < nb; k++) {
        const s = s0 + (k + 0.5) * BAY, lc = litAt((bo + k) % BAYS, row);
        addInst(c, 'pane', ax, az, ux, uz, s, yb, ww, wh, lc ? parseInt(lc.slice(1), 16) : DARK_GLASS[(bo + k + fl) % 3]);
        addInst(c, 'frame', ax, az, ux, uz, s, yb, ww, wh, tc);
        if (fl === pedRow) addInst(c, 'ped', ax, az, ux, uz, s, yb, ww, wh, tc);
      }
    }
  });
}
// A moulding along the free walls of a footprint: it stands d out of the wall between y0 and y1, mitred at the corners (poly.ts grow);
// its front, its upper face if top, its underside if under
function band(bk: Bucket, p: number[], free: boolean[], d: number, y0: number, y1: number, col: number, top: boolean, under = true) {
  const n = p.length >> 1, g = grow(p, d), cu = shade(col, 0.82);
  for (let i = 0; i < n; i++) {
    if (!free[i]) continue;
    const j = (i + 1) % n;
    wall(bk, g[2 * i], g[2 * i + 1], g[2 * j], g[2 * j + 1], y0, y1, col);
    const A = (y: number): P3 => [p[2 * i], y, p[2 * i + 1]], Bq = (y: number): P3 => [p[2 * j], y, p[2 * j + 1]];
    const C = (y: number): P3 => [g[2 * j], y, g[2 * j + 1]], D = (y: number): P3 => [g[2 * i], y, g[2 * i + 1]];
    if (top) { tri(bk, A(y1), Bq(y1), C(y1), col); tri(bk, A(y1), C(y1), D(y1), col); }
    if (under) { tri(bk, A(y0), C(y0), Bq(y0), cu); tri(bk, A(y0), D(y0), C(y0), cu); }
  }
}
// The near mouldings: the plinth (stone-coloured); on the 19th-century houses the profiled main cornice (three steps, built round the far
// cornice so that it hides it), the floor bands over the ground floor and under the top floor's windows, the lesenes at the corners
function houseTrims(TB: Bucket, style: Style, p: number[], free: boolean[], y0: number, h: number, f: number, fh: number, col: number) {
  const n = p.length >> 1, trim = mix(col, 0xffffff, 0.45);
  const pl = Math.min(1.0, 0.3 * fh);
  band(TB, p, free, 0.13, y0, y0 + pl, 0xa39d90, true, false);
  if (style !== 'c19') return;
  band(TB, p, free, 0.14, h - 0.8, h - 0.52, trim, false);
  band(TB, p, free, 0.32, h - 0.52, h - 0.2, trim, false);
  band(TB, p, free, 0.46, h - 0.2, h + 0.18, mix(trim, 0xffffff, 0.2), true);
  if (f >= 2) band(TB, p, free, 0.15, y0 + fh - 0.1, y0 + fh + 0.18, trim, true);
  if (f >= 4) band(TB, p, free, 0.07, y0 + (f - 1) * fh + 0.08, y0 + (f - 1) * fh + 0.2, trim, true);
  // lesenes: a strip at each end of a free wall whose neighbouring wall is free too (a corner of the house)
  for (let i = 0; i < n; i++) {
    if (!free[i]) continue;
    const j = (i + 1) % n, ax = p[2 * i], az = p[2 * i + 1], bx = p[2 * j], bz = p[2 * j + 1], L = Math.hypot(bx - ax, bz - az); if (L < 3) continue;
    const ux = (bx - ax) / L, uz = (bz - az) / L, nx = uz * 0.07, nz = -ux * 0.07, W = 0.6, ya = y0 + pl, yb = h - 0.8;
    if (free[(i + n - 1) % n]) {                                                       // at a
      const ix = ax + ux * W, iz = az + uz * W;
      wall(TB, ax + nx, az + nz, ix + nx, iz + nz, ya, yb, trim); wall(TB, ix + nx, iz + nz, ix, iz, ya, yb, shade(trim, 0.9));
    }
    if (free[j]) {                                                                     // at b
      const ix = bx - ux * W, iz = bz - uz * W;
      wall(TB, ix + nx, iz + nz, bx + nx, bz + nz, ya, yb, trim); wall(TB, ix, iz, ix + nx, iz + nz, ya, yb, shade(trim, 0.9));
    }
  }
}

// the roof; returns the height of its top. World of DODO, issue #27: an arena house's roof is the orthophoto's (the roof atlas,
// facade.ts: its uvs from the house's box in the atlas, the vertex colour white so that the photo shows); everything else (the far
// houses' roofs, the mansards' slopes, gables, chimneys) stays in the city's vertex colours as in issue #16, whose material (the 'vc'
// tiles) thaws its snow-white tops with the weather (core/matlib.ts baked)
function roof(bi: number, B: { r: number; rh: number; k?: string }, p: number[], party: boolean[], h: number, col: number, o: HouseOpt): number {
  const n = p.length >> 1, [cx, cz] = polyCentroid(p), VC = tileB('vc', cx, cz), uv = o.detail ? roofUV(bi) : null;
  const snow = o.roofCol ?? shade(SNOW, 0.96 + 0.05 * hash01(bi, 3));
  const RB = uv ? tileB('roofA', cx, cz) : VC, rcol = uv ? 0xffffff : snow, fu = uv ?? undefined;
  const flat = () => { capUp(RB, p, h + 0.02, rcol, fu); return h; };
  if (o.flat || B.r === 0 || !B.rh || party.every(x => x)) return flat();
  const d = party.map(x => (x ? 0 : 1)), mw = minWidth(p);
  let D = B.r === 2 ? Math.min(1.1, 0.25 * mw) : Math.min(1.45 * B.rh, 0.5 * mw - 0.03), q: number[] | null = null;
  for (let k = 0; k < 7 && D > 0.15; k++, D *= 0.72) { const t = insetEdges(p, d.map(x => x * D)); if (insetOk(p, t)) { q = t; break; } }
  if (!q) return flat();
  const H = B.r === 2 ? 0.75 * B.rh : Math.min(B.rh, Math.max(2.2 * D, 0.5 * B.rh)), top = h + H;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, A: P3 = [p[2 * i], h, p[2 * i + 1]], Bp: P3 = [p[2 * j], h, p[2 * j + 1]], C: P3 = [q[2 * j], top, q[2 * j + 1]], Dp: P3 = [q[2 * i], top, q[2 * i + 1]];
    const ex = Bp[0] - A[0], ez = Bp[2] - A[2], l = Math.hypot(ex, ez) || 1, nrm: P3 = party[i] ? [ez / l, 0, -ex / l] : [ez / l, D / H, -ex / l];
    const atlas = !party[i] && B.r !== 2 && !!uv, bk = atlas ? RB : VC, c = party[i] ? shade(col, 0.9) : B.r === 2 ? SLATE : rcol;
    if (Math.abs(C[0] - Dp[0]) + Math.abs(C[2] - Dp[2]) < 1e-3) faceN(bk, [A, Bp, C], nrm, c, atlas ? fu : undefined); else faceN(bk, [A, Bp, C, Dp], nrm, c, atlas ? fu : undefined);
  }
  const qq = dedupe(q, 1e-3);
  if (qq.length >= 6 && polyArea(qq) > 0.2) capUp(RB, qq, top, uv ? 0xffffff : B.r === 2 ? snow : shade(snow, 1.02), fu);
  if (o.detail && B.r === 1 && polyArea(p) > 50) {                                   // a chimney on the ridge
    const [rx, rz] = polyCentroid(qq.length >= 6 ? qq : q);
    boxB(VC, rx + (hash01(bi, 7) - 0.5) * 2, top - 0.6, rz + (hash01(bi, 8) - 0.5) * 2, 0.7, 1.9, 0.7, DARK, 0, snow);
  }
  return top;
}

// ---------- all of them ----------
// The footprints as drawn (turned to the data's orientation, doubled points dropped) and their shared walls: landmarks.ts needs them
// too (house() for the barracks and the theatre), so city.ts prepares them once, then draws the landmarks, then the rest.
export type Bld = (typeof DATA.buildings)[number];
// (World of DODO, issue #31: a builder: the materials, then 500 footprints a unit, then the shared walls)
export function* prepareBuildings(): Build<{ bs: Bld[]; P: Party[] }> {
  kinds(); yield 0.1;
  const D = DATA.buildings, bs: Bld[] = [];
  for (let i = 0; i < D.length; i++) { bs.push({ ...D[i], p: dedupe(orient(D[i].p), 0.02) }); if (i % 500 === 499) yield 0.1 + 0.2 * i / D.length; }
  const P = yield* part(parties(bs), 0.3, 1);
  return { bs, P };
}
// Far houses more than FAR_PLAIN beyond the arena's edge (seen only from a plane, through the fog) get plain walls instead of the window
// texture and a flat roof: no lit windows out there, but one draw call less per tile, no texture to sample over a big part of the
// air view, and half the triangles.
const FAR_PLAIN = 140;
// (issue #31: a builder, a house a unit, in the data's order as before)
export function* buildBuildings(bs: Bld[], P: Party[], skip: Set<number>): Build {
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i];
    if (b.p.length < 6 || skip.has(i)) continue;
    let plain = false;
    if (b.far) { const [x, z] = polyCentroid(b.p); plain = Math.max(ARENA.x0 - x, x - ARENA.x1, ARENA.z0 - z, z - ARENA.z1) > FAR_PLAIN; }
    house(i, b, P[i], { detail: !b.far, plain, flat: plain, col: plain ? shade(PALETTE[b.c] ?? PALETTE[0], 0.8 + 0.12 * hash01(i, 5)) : undefined });
    yield (i + 1) / bs.length;
  }
  // World of DODO, issue #27: the arena's houses' near detail (facade.ts cells), baked now (the landmarks that use house() were drawn
  // before)
  bakeCells();
}
