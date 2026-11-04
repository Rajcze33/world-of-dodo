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
import { DATA, ARENA, nearestEdge, inArena } from '../../shared/map.ts';
import { Hash, polyArea, polyCentroid } from '../../shared/geom.ts';
import { tri, boxB, type Bucket, type P3 } from '../core/geo';
import { canvasTex } from '../core/tex';
import { lambert } from '../core/mat';
import { wall, capUp, faceN, grow, insetEdges, insetOk, minWidth, orient, dedupe, hash01 } from './poly';
import { tileB } from './tiles';

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
const litAt = (x: number, y: number) => { const r = hash01(x * 7 + 3, y * 13 + 1); return r < 0.32 ? LIT_C[(hash01(x, y + 99) * LIT_C.length) | 0] : null; };
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
  return FAC_MAT;
}

// ---------- shared walls ----------
// For every edge of every footprint: how much of it a neighbour's wall covers (0..1), and the neighbour's height there (the one
// covering most). Edges match when they run the opposite way within 0.4 of each other.
export interface Party { cov: number[]; top: number[] }
export function parties(bs: { p: number[]; h: number }[]): Party[] {
  const H = new Hash<number>(-720, -720, 720, 720, 12), E: number[] = [], Q: number[] = [];   // E: building, edge, ax, az, bx, bz
  bs.forEach((b, bi) => {
    const p = b.p, n = p.length;
    for (let i = 0; i < n; i += 2) {
      const j = (i + 2) % n, k = E.length / 6; E.push(bi, i >> 1, p[i], p[i + 1], p[j], p[j + 1]);
      H.add([Math.min(p[i], p[j]) - 0.4, Math.min(p[i + 1], p[j + 1]) - 0.4, Math.max(p[i], p[j]) + 0.4, Math.max(p[i + 1], p[j + 1]) + 0.4], k);
    }
  });
  const out: Party[] = bs.map(b => ({ cov: new Array(b.p.length >> 1).fill(0), top: new Array(b.p.length >> 1).fill(0) }));
  const iv: number[][] = [];
  for (let k = 0; k < E.length / 6; k++) {
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

// ---------- one house ----------
// o.detail: street-level detail (cornice, ground floor, shop windows, chimney): the arena's houses; o.col overrides the colour,
// o.flat forces a flat roof. Returns the roof's top ring height (for landmarks that add to it).
export interface HouseOpt { detail?: boolean; col?: number; flat?: boolean; plain?: boolean; roofCol?: number }
export function house(bi: number, B: { p: number[]; h: number; y0?: number; r: number; rh: number; f: number; c: number; k?: string }, P: Party, o: HouseOpt = {}) {
  const p = B.p, n = p.length >> 1, y0 = B.y0 || 0, h = B.h > y0 ? B.h : y0 + B.h, f = Math.max(1, B.f), fh = (h - y0) / f;
  const [cx, cz] = polyCentroid(p), FAC = tileB('fac', cx, cz), VC = tileB('vc', cx, cz), GL = tileB('glow', cx, cz);
  const col = o.col ?? shade(PALETTE[B.c] ?? PALETTE[0], 0.93 + 0.12 * hash01(bi, 5)), fire = shade(col, 0.88);
  const plain = o.plain || B.k === 'garage' || B.k === 'shed' || B.k === 'construction' || B.k === 'ruins';
  const party = P.cov.map(c => c >= 0.6), free: boolean[] = party.map(x => !x);
  const u0 = Math.floor(hash01(bi, 1) * BAYS) * BAY, v0 = Math.floor(hash01(bi, 2) * FLOORS) / FLOORS, vt = v0 + f / FLOORS;
  // the walls: the facade where it is free (or only partly covered), plain above a lower neighbour where it is shared
  let acc = u0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, ax = p[2 * i], az = p[2 * i + 1], bx = p[2 * j], bz = p[2 * j + 1], L = Math.hypot(bx - ax, bz - az);
    if (party[i]) { const t = Math.max(y0, P.top[i]); if (t < h - 0.15) wall(VC, ax, az, bx, bz, t, h, fire); }
    else if (plain) wall(VC, ax, az, bx, bz, y0, h, col);
    else wall(FAC, ax, az, bx, bz, y0, h, col, [acc / (BAYS * BAY), (acc + L) / (BAYS * BAY), v0, vt]);
    acc += L;
  }
  // street-level detail: a cornice along the free walls, a darker ground floor with shop windows where a street is in front
  if (o.detail && !plain) {
    const g = grow(p, 0.28), cc = mix(col, 0xffffff, 0.55), ch0 = h - 0.45, ch1 = h + 0.15;
    for (let i = 0; i < n; i++) {
      if (!free[i]) continue;
      const j = (i + 1) % n, ax = p[2 * i], az = p[2 * i + 1], bx = p[2 * j], bz = p[2 * j + 1];
      wall(VC, g[2 * i], g[2 * i + 1], g[2 * j], g[2 * j + 1], ch0, ch1, cc);
      tri(VC, [ax, ch1, az], [bx, ch1, bz], [g[2 * j], ch1, g[2 * j + 1]], cc); tri(VC, [ax, ch1, az], [g[2 * j], ch1, g[2 * j + 1]], [g[2 * i], ch1, g[2 * i + 1]], cc);   // top
      tri(VC, [ax, ch0, az], [g[2 * j], ch0, g[2 * j + 1]], [bx, ch0, bz], shade(cc, 0.8)); tri(VC, [ax, ch0, az], [g[2 * i], ch0, g[2 * i + 1]], [g[2 * j], ch0, g[2 * j + 1]], shade(cc, 0.8));   // underside
    }
    if (f >= 2) {
      const pl = grow(p, 0.1), ph = y0 + Math.min(fh * 0.92, 3.4), dk = shade(col, 0.72);
      for (let i = 0; i < n; i++) {
        if (!free[i]) continue;
        const j = (i + 1) % n, ax = pl[2 * i], az = pl[2 * i + 1], bx = pl[2 * j], bz = pl[2 * j + 1], L = Math.hypot(bx - ax, bz - az);
        const mx = (ax + bx) / 2 + (bz - az) / (L || 1) * 3, mz = (az + bz) / 2 - (bx - ax) / (L || 1) * 3, ne = nearestEdge(mx, mz);
        const street = inArena(mx, mz) && !!ne && ne.d - ne.e.w / 2 < 4;
        if (!street) continue;
        wall(VC, ax, az, bx, bz, y0, ph, dk);
        tri(VC, [p[2 * i], ph, p[2 * i + 1]], [p[2 * j], ph, p[2 * j + 1]], [bx, ph, bz], dk); tri(VC, [p[2 * i], ph, p[2 * i + 1]], [bx, ph, bz], [ax, ph, az], dk);   // its ledge
        const m = Math.floor(L / 4.2); if (m < 1) continue;
        const ux = (bx - ax) / L, uz = (bz - az) / L, ox = uz * 0.03, oz = -ux * 0.03;
        for (let k = 0; k < m; k++) {
          const s = (k + 0.5) * L / m, r = hash01(bi * 31 + i, k), lit = r < 0.5;
          const x0 = ax + ux * (s - 1.1) + ox, z0 = az + uz * (s - 1.1) + oz, x1 = ax + ux * (s + 1.1) + ox, z1 = az + uz * (s + 1.1) + oz;
          wall(lit ? GL : VC, x0, z0, x1, z1, y0 + 0.5, ph - 0.45, lit ? (r < 0.3 ? 0xf6cf8a : r < 0.42 ? 0xeef0ea : 0xb2dcd6) : 0x2b3130);
        }
      }
    }
  }
  return roof(bi, B, p, party, h, VC, col, o);
}

// the roof; returns the height of its top
function roof(bi: number, B: { r: number; rh: number; k?: string }, p: number[], party: boolean[], h: number, VC: Bucket, col: number, o: HouseOpt): number {
  const n = p.length >> 1, snow = o.roofCol ?? shade(SNOW, 0.96 + 0.05 * hash01(bi, 3));
  const flat = () => { capUp(VC, p, h + 0.02, snow); return h; };
  if (o.flat || B.r === 0 || !B.rh || party.every(x => x)) return flat();
  const d = party.map(x => (x ? 0 : 1)), mw = minWidth(p);
  let D = B.r === 2 ? Math.min(1.1, 0.25 * mw) : Math.min(1.45 * B.rh, 0.5 * mw - 0.03), q: number[] | null = null;
  for (let k = 0; k < 7 && D > 0.15; k++, D *= 0.72) { const t = insetEdges(p, d.map(x => x * D)); if (insetOk(p, t)) { q = t; break; } }
  if (!q) return flat();
  const H = B.r === 2 ? 0.75 * B.rh : Math.min(B.rh, Math.max(2.2 * D, 0.5 * B.rh)), top = h + H, slope = B.r === 2 ? SLATE : snow;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, A: P3 = [p[2 * i], h, p[2 * i + 1]], Bp: P3 = [p[2 * j], h, p[2 * j + 1]], C: P3 = [q[2 * j], top, q[2 * j + 1]], Dp: P3 = [q[2 * i], top, q[2 * i + 1]];
    const ex = Bp[0] - A[0], ez = Bp[2] - A[2], l = Math.hypot(ex, ez) || 1, nrm: P3 = party[i] ? [ez / l, 0, -ex / l] : [ez / l, D / H, -ex / l];
    const c = party[i] ? shade(col, 0.9) : slope;
    if (Math.abs(C[0] - Dp[0]) + Math.abs(C[2] - Dp[2]) < 1e-3) faceN(VC, [A, Bp, C], nrm, c); else faceN(VC, [A, Bp, C, Dp], nrm, c);
  }
  const qq = dedupe(q, 1e-3);
  if (qq.length >= 6 && polyArea(qq) > 0.2) capUp(VC, qq, top, B.r === 2 ? snow : shade(snow, 1.02));
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
export function prepareBuildings(): { bs: Bld[]; P: Party[] } {
  const bs = DATA.buildings.map(b => ({ ...b, p: dedupe(orient(b.p), 0.02) }));
  return { bs, P: parties(bs) };
}
// Far houses more than FAR_PLAIN beyond the arena's edge (seen only from a plane, through the fog) get plain walls instead of the window
// texture and a flat roof: no lit windows out there, but one draw call less per tile, no texture to sample over a big part of the
// air view, and half the triangles.
const FAR_PLAIN = 140;
export function buildBuildings(bs: Bld[], P: Party[], skip: Set<number>) {
  bs.forEach((b, i) => {
    if (b.p.length < 6 || skip.has(i)) return;
    let plain = false;
    if (b.far) { const [x, z] = polyCentroid(b.p); plain = Math.max(ARENA.x0 - x, x - ARENA.x1, ARENA.z0 - z, z - ARENA.z1) > FAR_PLAIN; }
    house(i, b, P[i], { detail: !b.far, plain, flat: plain, col: plain ? shade(PALETTE[b.c] ?? PALETTE[0], 0.8 + 0.12 * hash01(i, 5)) : undefined });
  });
}
