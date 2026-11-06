// World of DODO, issue #16: the landmarks of the real Karlín, modelled instead of their plain extrusion (karlin.json landmarks, b =
// the building each replaces): the church of sv. Cyril a Metoděj on Karlínské náměstí (a neo-Romanesque basilica: two towers with
// pyramid roofs on the front, nave, aisles, transept, apse; replaces the original's invented twin-tower church), Forum Karlín (a glass
// hall), the Karlín barracks (the long classicist quadrangle, with a pediment), the synagogue (gable front with a rose window and two
// turrets), the Hudební divadlo Karlín just outside the arena (its fly tower), and the Národní památník na Vítkově on the hill with
// the equestrian statue of Jan Žižka, floodlit, seen from everywhere. Each model keeps within its footprint, which stays the solid
// (map.ts); what rises above the solid (towers, the statue) is in EXTRA for the planes (land.ts landHit).
// World of DODO, issue #27: the barracks and the theatre are houses of buildings.ts, with their facades and roofs.
import { DATA, terrainH, nearestEdge } from '../../shared/map.ts';
import { polyCentroid, pointInPoly } from '../../shared/geom.ts';
import { Bucket, type P3 } from '../core/geo';
import { faceN, prism, orient, extent, wall, hash01 } from './poly';
import { tileB } from './tiles';
import { house, shade, mix, SNOW, type Party, type Bld } from './buildings';

// extra solids above the footprints' prisms, for the planes: upright boxes (centre, half sizes along u / across, turned by u)
export const EXTRA: { x: number; z: number; ux: number; uz: number; a: number; b: number; y0: number; y1: number }[] = [];
// the floodlit memorial's walls: their own bucket, baked with a glowing material by city.ts
export const FLOOD = Bucket();
const WARM = 0xf2c46d, GLASS = 0x2c4a4e;

// A local frame: origin (ox, oz) at height y0, u the axis (s along it), v = right of u (t across); boxes, gables, pyramids in it.
class Fr {
  vx: number; vz: number;
  constructor(public ox: number, public oz: number, public ux: number, public uz: number, public y0 = 0) { this.vx = -uz; this.vz = ux; }
  p(s: number, y: number, t: number): P3 { return [this.ox + this.ux * s + this.vx * t, this.y0 + y, this.oz + this.uz * s + this.vz * t]; }
  n(ns: number, ny: number, nt: number): P3 { return [this.ux * ns + this.vx * nt, ny, this.uz * ns + this.vz * nt]; }
  poly(pts: [number, number][]): number[] { const o: number[] = []; for (const [s, t] of pts) { const q = this.p(s, 0, t); o.push(q[0], q[2]); } return orient(o); }
  box(bk: Bucket, s0: number, s1: number, t0: number, t1: number, y0: number, y1: number, col: number, top = col) {
    prism(bk, this.poly([[s0, t0], [s1, t0], [s1, t1], [s0, t1]]), this.y0 + y0, this.y0 + y1, col, top);
  }
  // a gable roof over s0..s1 × t0..t1 from the walls' top yw to the ridge yr, the ridge along s (or along t)
  gable(bk: Bucket, s0: number, s1: number, t0: number, t1: number, yw: number, yr: number, alongS: boolean, roof: number, end: number, rb: Bucket = bk) {
    if (alongS) {
      const tm = (t0 + t1) / 2, hw = (t1 - t0) / 2, rise = yr - yw;
      for (const [ta, sg] of [[t0, -1], [t1, 1]] as [number, number][]) faceN(rb, [this.p(s0, yw, ta), this.p(s1, yw, ta), this.p(s1, yr, tm), this.p(s0, yr, tm)], this.n(0, hw, sg * rise), roof);
      for (const [sa, sg] of [[s0, -1], [s1, 1]] as [number, number][]) faceN(bk, [this.p(sa, yw, t0), this.p(sa, yw, t1), this.p(sa, yr, tm)], this.n(sg, 0, 0), end);
    } else {
      const sm = (s0 + s1) / 2, hw = (s1 - s0) / 2, rise = yr - yw;
      for (const [sa, sg] of [[s0, -1], [s1, 1]] as [number, number][]) faceN(rb, [this.p(sa, yw, t0), this.p(sa, yw, t1), this.p(sm, yr, t1), this.p(sm, yr, t0)], this.n(sg * rise, hw, 0), roof);
      for (const [ta, sg] of [[t0, -1], [t1, 1]] as [number, number][]) faceN(bk, [this.p(s0, yw, ta), this.p(s1, yw, ta), this.p(sm, yr, ta)], this.n(0, 0, sg), end);
    }
  }
  pyramid(bk: Bucket, s0: number, s1: number, t0: number, t1: number, y0: number, y1: number, col: number) {
    const a = this.p((s0 + s1) / 2, y1, (t0 + t1) / 2), c: P3[] = [this.p(s0, y0, t0), this.p(s1, y0, t0), this.p(s1, y0, t1), this.p(s0, y0, t1)];
    const m = [this.n(0, 0.6, -1), this.n(1, 0.6, 0), this.n(0, 0.6, 1), this.n(-1, 0.6, 0)];   // the faces over c0-c1, c1-c2, ...
    for (let k = 0; k < 4; k++) faceN(bk, [c[k], c[(k + 1) % 4], a], m[k], col);
  }
  // a lean-to roof from the outer wall (t = to, height yo) up to an inner wall (t = ti, height yi), over s0..s1
  lean(bk: Bucket, s0: number, s1: number, to: number, ti: number, yo: number, yi: number, col: number, end: number, rb: Bucket = bk) {
    const sg = to < ti ? -1 : 1;
    faceN(rb, [this.p(s0, yo, to), this.p(s1, yo, to), this.p(s1, yi, ti), this.p(s0, yi, ti)], this.n(0, Math.abs(ti - to), sg * (yi - yo)), col);
    for (const [sa, ns] of [[s0, -1], [s1, 1]] as [number, number][]) faceN(bk, [this.p(sa, yo, to), this.p(sa, yo, ti), this.p(sa, yi, ti)], this.n(ns, 0, 0), end);
  }
  // an arched window (lit) on the face s = sf (facing ns) or t = tf, centre c along the face, from y0 to y1, w wide
  archS(bk: Bucket, sf: number, ns: number, c: number, w: number, y0: number, y1: number, col: number) {
    const r = w / 2, yc = y1 - r, P = (t: number, y: number) => this.p(sf + ns * 0.04, y, t), N = this.n(ns, 0, 0);
    faceN(bk, [P(c - r, y0), P(c + r, y0), P(c + r, yc), P(c - r, yc)], N, col);
    for (let k = 0; k < 6; k++) { const a0 = Math.PI * k / 6, a1 = Math.PI * (k + 1) / 6; faceN(bk, [P(c, yc), P(c + r * Math.cos(a0), yc + r * Math.sin(a0)), P(c + r * Math.cos(a1), yc + r * Math.sin(a1))], N, col); }
  }
  archT(bk: Bucket, tf: number, nt: number, c: number, w: number, y0: number, y1: number, col: number) {
    const r = w / 2, yc = y1 - r, P = (s: number, y: number) => this.p(s, y, tf + nt * 0.04), N = this.n(0, 0, nt);
    faceN(bk, [P(c - r, y0), P(c + r, y0), P(c + r, yc), P(c - r, yc)], N, col);
    for (let k = 0; k < 6; k++) { const a0 = Math.PI * k / 6, a1 = Math.PI * (k + 1) / 6; faceN(bk, [P(c, yc), P(c + r * Math.cos(a0), yc + r * Math.sin(a0)), P(c + r * Math.cos(a1), yc + r * Math.sin(a1))], N, col); }
  }
  // a disc on the face t = tf facing nt (a transept's round window)
  discT(bk: Bucket, tf: number, nt: number, s: number, y: number, r: number, col: number, seg = 12) {
    const N = this.n(0, 0, nt), q = tf + nt * 0.05;
    for (let k = 0; k < seg; k++) { const a0 = 2 * Math.PI * k / seg, a1 = 2 * Math.PI * (k + 1) / seg; faceN(bk, [this.p(s, y, q), this.p(s + r * Math.cos(a0), y + r * Math.sin(a0), q), this.p(s + r * Math.cos(a1), y + r * Math.sin(a1), q)], N, col); }
  }
  // a disc (a rose window) on the face s = sf facing ns
  disc(bk: Bucket, sf: number, ns: number, t: number, y: number, r: number, col: number, seg = 14) {
    const N = this.n(ns, 0, 0);
    for (let k = 0; k < seg; k++) { const a0 = 2 * Math.PI * k / seg, a1 = 2 * Math.PI * (k + 1) / seg; faceN(bk, [this.p(sf + ns * 0.05, y, t), this.p(sf + ns * 0.05, y + r * Math.sin(a0), t + r * Math.cos(a0)), this.p(sf + ns * 0.05, y + r * Math.sin(a1), t + r * Math.cos(a1))], N, col); }
  }
  extra(s0: number, s1: number, t0: number, t1: number, y0: number, y1: number) {
    const c = this.p((s0 + s1) / 2, 0, (t0 + t1) / 2);
    EXTRA.push({ x: c[0], z: c[2], ux: this.ux, uz: this.uz, a: (s1 - s0) / 2, b: (t1 - t0) / 2, y0: this.y0 + y0, y1: this.y0 + y1 });
  }
}
// the frame of a footprint along its landmark axis (rot: the long axis, (cos, sin)): s from the end that `front` picks, t across
function frameOf(p: number[], rot: number, front: (e: [number, number, number, number], ux: number, uz: number) => boolean, y0 = 0) {
  let ux = Math.cos(rot), uz = Math.sin(rot);
  let e = extent(p, ux, uz);
  if (!front(e, ux, uz)) { ux = -ux; uz = -uz; e = extent(p, ux, uz); }               // the front is at the axis's low end
  const [a0, a1, b0, b1] = e, tm = (b0 + b1) / 2;
  const F = new Fr(ux * a0 - uz * tm, uz * a0 + ux * tm, ux, uz, y0);                // a0 along, tm across → world
  return { F, L: a1 - a0, W: b1 - b0 };
}
// how wide the footprint is across, between s and s + ds from the axis's low end (points in that slab)
function widthAt(p: number[], ux: number, uz: number, a: number, b: number): number {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < p.length; i += 2) { const s = p[i] * ux + p[i + 1] * uz; if (s < a || s > b) continue; const t = -p[i] * uz + p[i + 1] * ux; lo = Math.min(lo, t); hi = Math.max(hi, t); }
  return hi > lo ? hi - lo : 0;
}

// ---------- the models ----------
type B = Bld;
// sv. Cyril a Metoděj: the towers' front is the footprint's wider end (the apse narrows the other)
function church(b: B, rot: number) {
  const p = orient(b.p);
  const { F, L, W } = frameOf(p, rot, (e, ux, uz) => widthAt(p, ux, uz, e[0], e[0] + 0.06 * (e[1] - e[0])) >= widthAt(p, ux, uz, e[1] - 0.06 * (e[1] - e[0]), e[1]));
  // floodlit, as the real one at night; World of DODO, issue #27: its roofs and spires in the city's vertex colours (their snow thaws
  // with the weather, core/matlib.ts baked). (A sandstone texture on its walls was tried: one more shader to compile at the start,
  // which on a weak device cost more than it showed.)
  const [cx, cz] = polyCentroid(p), VC = FLOOD, RB = tileB('vc', cx, cz), GL = tileB('glow', cx, cz);
  const Wb = 0.93 * W, ts = 0.3 * Wb, tw = Wb / 2, nw = 0.2 * Wb, sA = 0.85 * L, sT0 = 0.63 * L, sT1 = 0.75 * L;
  const WALL = 0xe9dcc0, TRIM = 0xf6f1e4, ROOF = shade(SNOW, 0.97), SPIRE = 0x55605d;
  const HN = 19, RN = 26, HA = 11, RA = 14.5, HT = 38, HB = 45, HS = 58;
  // the nave (and the choir) and its roof; the aisles with lean-to roofs; the transept across
  F.box(VC, ts * 0.5, sA, -nw, nw, 0, HN, WALL); F.gable(VC, ts * 0.5, sA, -nw, nw, HN, RN, true, ROOF, WALL, RB);
  for (const sg of [-1, 1]) {
    F.box(VC, ts, sT0, sg > 0 ? nw : -tw, sg > 0 ? tw : -nw, 0, HA, WALL);
    F.lean(VC, ts, sT0, sg * tw, sg * nw, HA, RA, ROOF, WALL, RB);
    for (let s = ts + 2.5; s < sT0 - 1.5; s += 4) { F.archT(GL, sg * tw, sg, s, 1.3, 3, 8.5, WARM); F.archT(GL, sg * nw, sg, s, 1.1, RA + 0.8, HN - 1.2, WARM); }
  }
  F.box(VC, sT0, sT1, -W / 2, W / 2, 0, HN, WALL); F.gable(VC, sT0, sT1, -W / 2, W / 2, HN, RN, false, ROOF, WALL, RB);
  for (const sg of [-1, 1]) { F.discT(VC, sg * W / 2, sg, (sT0 + sT1) / 2, 13, 2.7, TRIM, 14); F.discT(GL, sg * W / 2 + sg * 0.1, sg, (sT0 + sT1) / 2, 13, 2.1, WARM, 14); }
  // the apse: a half circle (stretched along) with a half-cone roof
  {
    const rt = nw + 0.6, rs = Math.max(2, L - sA - 0.2), n = 10, ring: [number, number][] = [];
    for (let k = 0; k <= n; k++) { const a = -Math.PI / 2 + Math.PI * k / n; ring.push([sA + rs * Math.cos(a), rt * Math.sin(a)]); }
    for (let k = 0; k < n; k++) {
      const [s0, t0] = ring[k], [s1, t1] = ring[k + 1], A = F.p(s0, 0, t0), Bq = F.p(s1, 0, t1), mid = F.n((s0 + s1) / 2 - sA, 0, (t0 + t1) / 2);
      faceN(VC, [A, Bq, F.p(s1, 13, t1), F.p(s0, 13, t0)], mid, WALL);
      faceN(RB, [F.p(s0, 13, t0), F.p(s1, 13, t1), F.p(sA, 18.5, 0)], [mid[0], 1.2, mid[2]], ROOF);
    }
    for (const a of [-0.5, 0, 0.5]) {                                                // three tall windows round the apse
      const c = Math.cos(a), sn = Math.sin(a), s = sA + (rs + 0.06) * c, t = (rt + 0.06) * sn, N = F.n(c, 0, sn);
      faceN(GL, [F.p(s, 4, t - 0.6), F.p(s, 4, t + 0.6), F.p(s, 9, t + 0.6), F.p(s, 9, t - 0.6)], N, WARM);
    }
  }
  // the front between the towers: a gable wall above the nave's, the portal, the rose window
  F.box(VC, 0, ts * 0.5 + 0.2, -tw + ts, tw - ts, 0, HN, WALL);
  faceN(VC, [F.p(0, HN, -nw - 0.4), F.p(0, HN, nw + 0.4), F.p(0, RN + 1.5, 0)], F.n(-1, 0, 0), WALL);
  faceN(VC, [F.p(ts * 0.5, HN, -nw - 0.4), F.p(ts * 0.5, HN, nw + 0.4), F.p(ts * 0.5, RN + 1.5, 0)], F.n(1, 0, 0), WALL);
  for (const sg of [-1, 1]) faceN(RB, [F.p(0, HN, sg * (nw + 0.4)), F.p(ts * 0.5, HN, sg * (nw + 0.4)), F.p(ts * 0.5, RN + 1.5, 0), F.p(0, RN + 1.5, 0)], F.n(0, nw, sg * (RN + 1.5 - HN)), ROOF);
  F.disc(VC, 0, -1, 0, 13.2, 2.9, TRIM, 16); F.disc(GL, -0.12, -1, 0, 13.2, 2.3, WARM, 16);   // the rose window in its frame
  F.archS(VC, 0, -1, 0, 3.4, 0, 6.6, 0x4b3a2c); F.archS(GL, -0.04, -1, 0, 2.6, 0, 5.8, WARM);
  F.box(VC, -0.3, 0.2, -0.25, 0.25, RN + 1.5, RN + 4.2, TRIM); F.box(VC, -0.3, 0.2, -1.1, 1.1, RN + 2.9, RN + 3.4, TRIM);   // the cross
  // the two towers: shaft, belfry with lit openings, cornice, steep pyramid roof with a cross
  for (const sg of [-1, 1]) {
    const t0 = sg > 0 ? tw - ts : -tw, t1 = sg > 0 ? tw : -tw + ts, tc = (t0 + t1) / 2;
    F.box(VC, 0, ts, t0, t1, 0, HT, WALL, TRIM); F.box(VC, -0.25, ts + 0.25, t0 - 0.25, t1 + 0.25, HT, HT + 0.7, TRIM);
    F.box(VC, 0.2, ts - 0.2, t0 + 0.2, t1 - 0.2, HT + 0.7, HB, WALL); F.box(VC, -0.3, ts + 0.3, t0 - 0.3, t1 + 0.3, HB, HB + 0.6, TRIM);
    F.pyramid(RB, -0.1, ts + 0.1, t0 - 0.1, t1 + 0.1, HB + 0.6, HS, SPIRE);
    F.box(VC, ts / 2 - 0.15, ts / 2 + 0.15, tc - 0.15, tc + 0.15, HS - 0.3, HS + 2.6, TRIM); F.box(VC, ts / 2 - 0.15, ts / 2 + 0.15, tc - 0.9, tc + 0.9, HS + 1.4, HS + 1.8, TRIM);
    for (const w of [-1, 1]) { F.archS(GL, 0.2, -1, tc + w * 1.1, 1.2, HT + 2, HB - 1.2, WARM); F.archS(GL, ts - 0.2, 1, tc + w * 1.1, 1.2, HT + 2, HB - 1.2, WARM); F.archT(GL, sg > 0 ? t1 - 0.2 : t0 + 0.2, sg, ts / 2 + w * 1.1, 1.2, HT + 2, HB - 1.2, WARM); }
    for (const y of [10, 20, 29]) F.archS(GL, 0, -1, tc, 1.1, y, y + 3.4, WARM);
    F.archS(VC, 0, -1, tc, 2.2, HT - 7, HT - 2.5, TRIM); F.disc(GL, -0.12, -1, tc, HT - 4.6, 0.8, 0xf6f1e4, 10);   // the clock
    F.extra(0, ts, t0, t1, b.h, HS);
  }
}
// Forum Karlín: a glass hall in a white frame, lit panes here and there, a skylight along the roof
function forum(bi: number, b: B) {
  const p = orient(b.p), [cx, cz] = polyCentroid(p), VC = tileB('vc', cx, cz), GL = tileB('glow', cx, cz), n = p.length >> 1, h = b.h, FR = 0xf1f0ea;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, ax = p[2 * i], az = p[2 * i + 1], bx = p[2 * j], bz = p[2 * j + 1], L = Math.hypot(bx - ax, bz - az); if (L < 0.2) continue;
    const ux = (bx - ax) / L, uz = (bz - az) / L, ox = uz * 0.05, oz = -ux * 0.05;
    wall(VC, ax, az, bx, bz, 0, h, GLASS); wall(VC, ax + ox * 2, az + oz * 2, bx + ox * 2, bz + oz * 2, h - 1.4, h + 0.6, FR); wall(VC, ax + ox * 2, az + oz * 2, bx + ox * 2, bz + oz * 2, 0, 0.9, FR);
    const m = Math.max(1, Math.round(L / 3));
    for (let k = 0; k <= m; k++) { const s = k * L / m, x = ax + ux * s + ox, z = az + uz * s + oz; wall(VC, x - ux * 0.15, z - uz * 0.15, x + ux * 0.15, z + uz * 0.15, 0.9, h - 1.4, FR); }
    for (let k = 0; k < m; k++) for (let y = 0; y < 6; y++) {
      const r = hash01(bi * 64 + i, k * 8 + y); if (r > 0.45 && y > 0) continue;            // the lobby lit, the floors here and there
      const s0 = k * L / m + 0.3, s1 = (k + 1) * L / m - 0.3, y0 = 1.2 + y * (h - 2.8) / 6, y1 = y0 + (h - 2.8) / 6 - 0.4;
      wall(GL, ax + ux * s0 + ox, az + uz * s0 + oz, ax + ux * s1 + ox, az + uz * s1 + oz, y0, y1, y === 0 ? WARM : r < 0.2 ? 0xeef0ea : 0xb2dcd6);
    }
  }
  prism(VC, p, h, h + 0.05, FR, shade(SNOW, 0.97));
  const { F, L, W } = frameOf(p, DATA.landmarks.forum.rot, () => true, h);
  F.box(GL, L * 0.12, L * 0.88, -W * 0.08, W * 0.08, 0.05, 0.9, 0xd8efe9);
  F.box(VC, L * 0.12 - 0.3, L * 0.88 + 0.3, -W * 0.08 - 0.3, -W * 0.08, 0.05, 1.1, FR); F.box(VC, L * 0.12 - 0.3, L * 0.88 + 0.3, W * 0.08, W * 0.08 + 0.3, 0.05, 1.1, FR);
}
// the synagogue: the street end is the front (a gable rising over the roof, a rose window, two turrets), arched windows along
function synagogue(b: B, rot: number) {
  const p = orient(b.p), fr = (e: number[], ux: number, uz: number) => {
    const g = (s: number) => { const tm = (e[2] + e[3]) / 2, x = ux * s - uz * tm, z = uz * s + ux * tm, ne = nearestEdge(x, z); return ne ? ne.d : 99; };
    return g(e[0] - 3) <= g(e[1] + 3);
  };
  const { F, L, W } = frameOf(p, rot, fr), [cx, cz] = polyCentroid(p), VC = tileB('vc', cx, cz), RB = VC, GL = tileB('glow', cx, cz);
  const WALL = 0xf0e6cf, TRIM = 0xfbf7ee, h = b.h, r = h + Math.max(3, b.rh), hw = W / 2;
  F.box(VC, 0, L, -hw, hw, 0, h, WALL); F.gable(VC, 0.3, L, -hw, hw, h, r, true, shade(SNOW, 0.97), WALL, RB);
  faceN(VC, [F.p(0, h, -hw), F.p(0, h, hw), F.p(0, r + 1.6, 0)], F.n(-1, 0, 0), WALL); faceN(VC, [F.p(0.3, h, -hw), F.p(0.3, h, hw), F.p(0.3, r + 1.6, 0)], F.n(1, 0, 0), WALL);
  for (const sg of [-1, 1]) faceN(VC, [F.p(0, h, sg * hw), F.p(0.3, h, sg * hw), F.p(0.3, r + 1.6, 0), F.p(0, r + 1.6, 0)], F.n(0, hw, sg * (r + 1.6 - h)), TRIM);
  F.disc(VC, 0, -1, 0, h * 0.62, Math.min(2.3, hw * 0.5), TRIM, 16); F.disc(GL, -0.12, -1, 0, h * 0.62, Math.min(1.8, hw * 0.4), WARM, 16);
  F.archS(GL, 0, -1, 0, 1.6, 0, 3.2, 0xf6cf8a);
  for (const sg of [-1, 1]) {
    const t0 = sg * hw - (sg > 0 ? 1.1 : 0), t1 = t0 + 1.1;
    F.box(VC, -0.2, 0.9, t0, t1, 0, r + 1.2, TRIM); F.pyramid(RB, -0.3, 1.0, t0 - 0.1, t1 + 0.1, r + 1.2, r + 3.6, 0x55605d);
    for (let s = 3; s < L - 1.5; s += 3.2) F.archT(GL, sg * hw, sg, s, 1.1, 1.6, h - 1.2, WARM);
    F.extra(-0.2, 0.9, t0, t1, h, r + 3.6);
  }
}
// the barracks: an ordinary house of karlin.json in Karlín's classicist ochre, a pediment over the middle of its longest street side
function kasarna(bi: number, b: B, P: Party) {
  const p = b.p; house(bi, b, P, { detail: true, col: 0xe9cf8e });
  let best = -1, bl = 0; const n = p.length >> 1;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n, l = Math.hypot(p[2 * j] - p[2 * i], p[2 * j + 1] - p[2 * i + 1]); if (l > bl) { bl = l; best = i; } }
  if (best < 0 || bl < 30) return;
  const j = (best + 1) % n, ax = p[2 * best], az = p[2 * best + 1], bx = p[2 * j], bz = p[2 * j + 1], ux = (bx - ax) / bl, uz = (bz - az) / bl;
  const F = new Fr((ax + bx) / 2, (az + bz) / 2, uz, -ux), [cx, cz] = polyCentroid(p), VC = tileB('vc', cx, cz), h = b.h, TR = 0xf7f1e1;
  // F's s points out of the house, t along the wall
  F.box(VC, -0.6, 0.6, -11, 11, 0, h, mix(0xe9cf8e, 0xffffff, 0.2), TR);
  for (const t of [-9, -5.4, -1.8, 1.8, 5.4, 9]) F.box(VC, 0.6, 1.1, t - 0.5, t + 0.5, 0.3, h - 0.6, TR);
  F.box(VC, -0.6, 1.3, -11.5, 11.5, h - 0.6, h + 0.3, TR);
  faceN(VC, [F.p(1.3, h + 0.3, -11.5), F.p(1.3, h + 0.3, 11.5), F.p(1.3, h + 5, 0)], F.n(1, 0, 0), TR);
  faceN(VC, [F.p(-0.6, h + 0.3, -11.5), F.p(-0.6, h + 0.3, 11.5), F.p(-0.6, h + 5, 0)], F.n(-1, 0, 0), TR);
  for (const sg of [-1, 1]) faceN(VC, [F.p(1.3, h + 0.3, sg * 11.5), F.p(-0.6, h + 0.3, sg * 11.5), F.p(-0.6, h + 5, 0), F.p(1.3, h + 5, 0)], F.n(0, 11.5, sg * 4.7), shade(SNOW, 0.97));
}
// the theatre outside the arena: its house, and the fly tower over the stage at the back
function theatre(bi: number, b: B, P: Party, rot: number) {
  const p = b.p; house(bi, b, P, { detail: true, col: 0xeedcae });
  const y0 = b.y0 || 0, { F, L, W } = frameOf(p, rot, () => true, y0), [cx, cz] = polyCentroid(p), VC = tileB('vc', cx, cz), y = b.h - y0;
  F.box(VC, L * 0.38, L * 0.62, -W * 0.28, W * 0.32, 0, y + 9, 0xe6d3a4, shade(SNOW, 0.97));
  F.extra(L * 0.38, L * 0.62, -W * 0.28, W * 0.32, y, y + 9);
}
// the memorial on Vítkov: the long granite block floodlit (its own glowing material), and Žižka on his horse on a high pedestal at the
// west end, facing west; both bigger than life, so that they read from the whole city
// (the memorial's other parts in the data, its taller front hall among them, are drawn the same way: parts = their indices)
function vitkov(b: B, rot: number, parts: B[]) {
  const p = orient(b.p), GRAN = 0xc6c3ba;                                       // granite, a shade darker: it is floodlit
  const { F } = frameOf(p, rot, (_e, ux) => ux > 0);                                 // s from the west end
  for (const q of [b, ...parts]) {
    const y0 = q.y0 || 0, h = q.h > y0 ? q.h : y0 + q.h, qp = orient(q.p), n = qp.length >> 1;
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; wall(FLOOD, qp[2 * i], qp[2 * i + 1], qp[2 * j], qp[2 * j + 1], y0, h, GRAN); }
    prism(FLOOD, qp, h, h + 0.6, shade(GRAN, 1.03), shade(SNOW, 0.98));
  }
  // the statue: pedestal and horseman, 14 west of the building
  const sx = F.p(-14, 0, 0), ty = terrainH(sx[0], sx[2]) - 0.6, S = new Fr(sx[0], sx[2], -F.ux, -F.uz, ty), VC = tileB('vc', sx[0], sx[2]);
  const BR = 0x3c4843, PED = 0xcfccc3;
  S.box(FLOOD, -6, 6, -3, 3, 0, 1.2, PED); S.box(FLOOD, -5, 5, -2.4, 2.4, 1.2, 8.5, PED); S.box(FLOOD, -5.4, 5.4, -2.8, 2.8, 8.5, 9.2, shade(PED, 1.04), shade(SNOW, 0.98));
  const Y = 9.2;                                                                       // the horse: s forwards (west), t across
  for (const [ls, lt] of [[2.6, -0.9], [2.6, 0.9], [-2.8, -0.9], [-2.8, 0.9]]) S.box(VC, ls - 0.45, ls + 0.45, lt - 0.4, lt + 0.4, Y, Y + 4.2, BR);
  S.box(VC, -3.8, 3.6, -1.35, 1.35, Y + 3.8, Y + 7, BR, 0xe9eeec);                   // body, snow on its back
  S.box(VC, 2.8, 4.6, -0.75, 0.75, Y + 6, Y + 9.3, BR); S.box(VC, 4.1, 6.4, -0.6, 0.6, Y + 8.2, Y + 9.6, BR);   // neck, head
  S.box(VC, 4.8, 5.4, -0.55, 0.55, Y + 9.6, Y + 10.3, BR);                           // ears
  S.box(VC, -4.6, -3.6, -0.35, 0.35, Y + 4, Y + 6.8, BR);                            // tail
  S.box(VC, -1.2, 1.2, -1.2, 1.2, Y + 7, Y + 10.6, BR, 0xe9eeec); S.box(VC, -0.7, 0.7, -0.7, 0.7, Y + 10.6, Y + 12, BR, 0xe9eeec);   // rider, head
  for (const sg of [-1, 1]) S.box(VC, -0.5, 0.5, sg * 1.2 - 0.3, sg * 1.2 + 0.3, Y + 4.6, Y + 7.6, BR);   // legs along the horse
  S.box(VC, 0.2, 0.7, 1.2, 1.7, Y + 9.5, Y + 13.6, BR); S.box(VC, 0, 0.9, 1.0, 1.9, Y + 13.6, Y + 14.6, BR);   // the raised arm with the mace
  S.extra(-6, 6, -3, 3, 0, Y + 14.6);
}

// Every landmark drawn; returns the buildings whose plain extrusion they replace
export function buildLandmarks(bs: Bld[], P: Party[]): Set<number> {
  const skip = new Set<number>(), Lm = DATA.landmarks, at = (k: string) => Lm[k] && Lm[k].b >= 0 && bs[Lm[k].b] && bs[Lm[k].b].p.length >= 6 ? Lm[k] : null;
  let L = at('church'); if (L) { church(bs[L.b], L.rot); skip.add(L.b); }
  L = at('forum'); if (L) { forum(L.b, bs[L.b]); skip.add(L.b); }
  L = at('synagogue'); if (L) { synagogue(bs[L.b], L.rot); skip.add(L.b); }
  L = at('kasarna'); if (L) { kasarna(L.b, bs[L.b], P[L.b]); skip.add(L.b); }
  L = at('theatre'); if (L) { theatre(L.b, bs[L.b], P[L.b], L.rot); skip.add(L.b); }
  L = at('vitkov');
  if (L) {                                                                            // the memorial and the parts standing on its footprint
    const fp = orient(bs[L.b].p), parts: number[] = [];
    bs.forEach((q, i) => { if (i !== L!.b && q.p.length >= 6 && q.far) { const [x, z] = polyCentroid(q.p); if (pointInPoly(fp, x, z)) parts.push(i); } });
    vitkov(bs[L.b], L.rot, parts.map(i => bs[i])); skip.add(L.b); for (const i of parts) skip.add(i);
  }
  return skip;
}
