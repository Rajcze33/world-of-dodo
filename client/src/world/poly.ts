// World of DODO, issue #16: polygon helpers for drawing the real Karlín (the footprints, blocks, plazas, parks and water of
// client/shared/karlin.json): triangulation by ear clipping, the roofs' inset rings, mitred offsets, and the 3D faces in the
// winding core/geo.ts expects.
//
// Polygons as in client/shared/geom.ts: flat [x0,z0,x1,z1,...], the interior on the RIGHT of every edge (positive shoelace), so the
// outward normal of an edge (dx,dz) is (dz,-dx) and the inward one (-dz,dx). Babylon ships no triangulator of its own (its
// PolygonMeshBuilder wants earcut injected), and the shapes here are small (at most ~100 points, no holes): plain ear clipping does.
import { tri, type Bucket, type P3 } from '../core/geo';
import { pointInPoly, closestOnPoly, polyArea, polyReverse, type Near } from '../../shared/geom.ts';

// the polygon turned to the data's orientation if it came the other way
export const orient = (p: number[]) => polyArea(p) < 0 ? polyReverse(p) : p;
// consecutive points closer than eps dropped (and a last point equal to the first)
export function dedupe(p: number[], eps = 1e-4): number[] {
  const o: number[] = [];
  for (let i = 0; i < p.length; i += 2) { const m = o.length; if (m && Math.abs(o[m - 2] - p[i]) < eps && Math.abs(o[m - 1] - p[i + 1]) < eps) continue; o.push(p[i], p[i + 1]); }
  while (o.length >= 6 && Math.abs(o[0] - o[o.length - 2]) < eps && Math.abs(o[1] - o[o.length - 1]) < eps) o.length -= 2;
  return o;
}

// ---------- triangulation ----------
// Ear clipping: triangles as index triples into the polygon's points, each with the polygon's own orientation. A polygon that
// turns out degenerate half way (collinear runs, rounding) is finished as a fan of what is left, never as nothing.
const cross = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number) => (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
export function earClip(p: number[]): number[] {
  const n = p.length >> 1, out: number[] = []; if (n < 3) return out;
  const idx: number[] = []; for (let i = 0; i < n; i++) idx.push(i);
  const X = (i: number) => p[2 * i], Z = (i: number) => p[2 * i + 1];
  let guard = 0;
  while (idx.length > 3 && guard++ < 4 * n * n) {
    const m = idx.length; let done = false;
    for (let k = 0; k < m; k++) {
      const a = idx[(k + m - 1) % m], b = idx[k], c = idx[(k + 1) % m];
      const cr = cross(X(a), Z(a), X(b), Z(b), X(c), Z(c));
      if (cr <= 1e-9) {                                                               // reflex, or straight on: then the point goes
        if (Math.abs(cr) <= 1e-9 && (X(b) - X(a)) * (X(c) - X(b)) + (Z(b) - Z(a)) * (Z(c) - Z(b)) >= 0) { idx.splice(k, 1); done = true; break; }
        continue;
      }
      let ear = true;
      for (let q = 0; q < m && ear; q++) {
        const v = idx[q]; if (v === a || v === b || v === c) continue;
        const x = X(v), z = Z(v);
        if ((x === X(a) && z === Z(a)) || (x === X(b) && z === Z(b)) || (x === X(c) && z === Z(c))) continue;
        if (cross(X(a), Z(a), X(b), Z(b), x, z) >= 0 && cross(X(b), Z(b), X(c), Z(c), x, z) >= 0 && cross(X(c), Z(c), X(a), Z(a), x, z) >= 0) ear = false;
      }
      if (ear) { out.push(a, b, c); idx.splice(k, 1); done = true; break; }
    }
    if (!done) { out.push(idx[0], idx[1], idx[2]); idx.splice(1, 1); }             // no ear (degenerate): one fan triangle, go on
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}

// ---------- 3D faces (core/geo.ts: a triangle's front is where cross(b-a, c-a) points) ----------
// the polygon as a flat cap at height y facing up (fn: the height may vary per point, for a cap on a slope)
export function capUp(bk: Bucket, p: number[], y: number | ((x: number, z: number) => number), col: number) {
  const t = earClip(p), Y = typeof y === 'number' ? () => y : y;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i], b = t[i + 1], c = t[i + 2];
    if (Math.abs(cross(p[2 * a], p[2 * a + 1], p[2 * b], p[2 * b + 1], p[2 * c], p[2 * c + 1])) < 1e-6) continue;
    tri(bk, [p[2 * a], Y(p[2 * a], p[2 * a + 1]), p[2 * a + 1]], [p[2 * c], Y(p[2 * c], p[2 * c + 1]), p[2 * c + 1]], [p[2 * b], Y(p[2 * b], p[2 * b + 1]), p[2 * b + 1]], col);
  }
}
// the same facing down (a slab's underside)
export function capDown(bk: Bucket, p: number[], y: number, col: number) {
  const t = earClip(p);
  for (let i = 0; i < t.length; i += 3) { const a = t[i], b = t[i + 1], c = t[i + 2]; tri(bk, [p[2 * a], y, p[2 * a + 1]], [p[2 * b], y, p[2 * b + 1]], [p[2 * c], y, p[2 * c + 1]], col); }
}
// the outward wall of edge a→b of a polygon (interior on the right) from y0 to y1; uv: [u0, u1, v0, v1] for a texture
export function wall(bk: Bucket, ax: number, az: number, bx: number, bz: number, y0: number, y1: number, col: number, uv?: [number, number, number, number]) {
  const A0: P3 = [ax, y0, az], B0: P3 = [bx, y0, bz], A1: P3 = [ax, y1, az], B1: P3 = [bx, y1, bz];
  if (uv) {
    const [u0, u1, v0, v1] = uv;
    tri(bk, B0, A0, A1, col, [u1, v0], [u0, v0], [u0, v1]); tri(bk, B0, A1, B1, col, [u1, v0], [u0, v1], [u1, v1]);
  } else { tri(bk, B0, A0, A1, col); tri(bk, B0, A1, B1, col); }
}
// a quad given in any winding, turned to face along n
export function faceN(bk: Bucket, v: P3[], n: P3, col: number) {
  const [a, b, c] = v, ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
  const d = (uy * wz - uz * wy) * n[0] + (uz * wx - ux * wz) * n[1] + (ux * wy - uy * wx) * n[2];
  if (v.length === 3) { if (d >= 0) tri(bk, a, b, c, col); else tri(bk, a, c, b, col); return; }
  if (d >= 0) { tri(bk, v[0], v[1], v[2], col); tri(bk, v[0], v[2], v[3], col); } else { tri(bk, v[0], v[2], v[1], col); tri(bk, v[0], v[3], v[2], col); }
}
// an upright prism over polygon p from y0 to y1: walls, top, and the bottom when it floats (a deck)
export function prism(bk: Bucket, p: number[], y0: number, y1: number, col: number, top = col, bottom = false) {
  const n = p.length;
  for (let i = 0; i < n; i += 2) { const j = (i + 2) % n; wall(bk, p[i], p[i + 1], p[j], p[j + 1], y0, y1, col); }
  capUp(bk, p, y1, top); if (bottom) capDown(bk, p, y0, col);
}

// ---------- offsets ----------
// the polygon grown outwards by d (negative: shrunk), mitred, a mitre never longer than lim × |d|; same number of points
export function grow(p: number[], d: number, lim = 2.5): number[] {
  const n = p.length >> 1, o: number[] = [];
  for (let i = 0; i < n; i++) {
    const h = (i + n - 1) % n, j = (i + 1) % n;
    let ax = p[2 * i] - p[2 * h], az = p[2 * i + 1] - p[2 * h + 1], bx = p[2 * j] - p[2 * i], bz = p[2 * j + 1] - p[2 * i + 1];
    const la = Math.hypot(ax, az) || 1, lb = Math.hypot(bx, bz) || 1; ax /= la; az /= la; bx /= lb; bz /= lb;
    let mx = az + bz, mz = -ax - bx; const ml = Math.hypot(mx, mz);                  // the sum of the two outward normals
    if (ml < 1e-6) { mx = az; mz = -ax; } else { mx /= ml; mz /= ml; }
    const c = mx * az - mz * ax, k = d / Math.max(1 / lim, c);                         // cos of the half turn
    o.push(p[2 * i] + mx * k, p[2 * i + 1] + mz * k);
  }
  return o;
}
// Each edge i moved inwards by its own d[i] (0 keeps it: a party wall), the moved lines meeting at the corners: the top ring of a
// roof. Nearly straight corners take the mean offset. No checks here: see insetOk.
export function insetEdges(p: number[], d: number[]): number[] {
  const n = p.length >> 1, q: number[] = [];
  const U = (k: number) => { const j = (k + 1) % n, dx = p[2 * j] - p[2 * k], dz = p[2 * j + 1] - p[2 * k + 1], l = Math.hypot(dx, dz) || 1; return [dx / l, dz / l]; };
  for (let i = 0; i < n; i++) {
    const a = (i + n - 1) % n, [uax, uaz] = U(a), [ubx, ubz] = U(i), x = p[2 * i], z = p[2 * i + 1];
    const pax = x - uaz * d[a], paz = z + uax * d[a], pbx = x - ubz * d[i], pbz = z + ubx * d[i];   // a point of each moved line
    const cr = uax * ubz - uaz * ubx;
    if (Math.abs(cr) < 0.08) { q.push((pax + pbx) / 2, (paz + pbz) / 2); continue; }
    const t = ((pbx - pax) * ubz - (pbz - paz) * ubx) / cr;
    q.push(pax + uax * t, paz + uaz * t);
  }
  return q;
}
const NQ: Near = { x: 0, z: 0, d2: 0, nx: 0, nz: 0, e: 0, t: 0 };
const inOrOn = (p: number[], x: number, z: number) => pointInPoly(p, x, z) || closestOnPoly(p, x, z, NQ).d2 < 1e-4;
// Is q (insetEdges of p) a roof ring that does not break: no edge turned round, every point and edge middle inside p (or on it),
// no two edges crossing, not turned inside out?
export function insetOk(p: number[], q: number[]): boolean {
  const n = p.length >> 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, ux = p[2 * j] - p[2 * i], uz = p[2 * j + 1] - p[2 * i + 1], vx = q[2 * j] - q[2 * i], vz = q[2 * j + 1] - q[2 * i + 1];
    if (ux * vx + uz * vz < -1e-4 * Math.hypot(ux, uz)) return false;
    if (!inOrOn(p, q[2 * i], q[2 * i + 1]) || !inOrOn(p, (q[2 * i] + q[2 * j]) / 2, (q[2 * i + 1] + q[2 * j + 1]) / 2)) return false;
  }
  for (let i = 0; i < n; i++) {
    const i1 = (i + 1) % n, ax = q[2 * i], az = q[2 * i + 1], bx = q[2 * i1], bz = q[2 * i1 + 1];
    if (Math.abs(bx - ax) + Math.abs(bz - az) < 1e-6) continue;
    for (let j = i + 2; j < n; j++) {
      const j1 = (j + 1) % n; if (j1 === i) continue;
      const cx = q[2 * j], cz = q[2 * j + 1], dx = q[2 * j1], dz = q[2 * j1 + 1];
      const o1 = cross(ax, az, bx, bz, cx, cz), o2 = cross(ax, az, bx, bz, dx, dz), o3 = cross(cx, cz, dx, dz, ax, az), o4 = cross(cx, cz, dx, dz, bx, bz);
      if (o1 * o2 < -1e-8 && o3 * o4 < -1e-8) return false;                          // a proper crossing (touching is fine: a ridge)
    }
  }
  return polyArea(q) > -1e-3;
}
// the polygon's least width (rotating calipers over its points, enough for the roofs' sizes)
export function minWidth(p: number[]): number {
  const n = p.length >> 1; let best = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, dx = p[2 * j] - p[2 * i], dz = p[2 * j + 1] - p[2 * i + 1], l = Math.hypot(dx, dz); if (l < 0.5) continue;
    let w = 0; for (let k = 0; k < n; k++) w = Math.max(w, Math.abs((p[2 * k] - p[2 * i]) * dz - (p[2 * k + 1] - p[2 * i + 1]) * dx) / l);
    best = Math.min(best, w);
  }
  return best === Infinity ? 0 : best;
}
// the footprint along an axis (ux,uz) and across it: [a0, a1, b0, b1] (a along, b across = (-uz, ux))
export function extent(p: number[], ux: number, uz: number): [number, number, number, number] {
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) { const a = p[i] * ux + p[i + 1] * uz, b = -p[i] * uz + p[i + 1] * ux; a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b); }
  return [a0, a1, b0, b1];
}
// a small stable hash of two numbers to 0..1 (the looks: which windows are lit, colour shades; no random numbers, so the city looks
// the same in every browser whatever else draws them)
export function hash01(a: number, b: number): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + 0x5bd1e995) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
