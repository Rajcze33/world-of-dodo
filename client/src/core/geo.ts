// Geometry: merged buckets (few draw calls → smooth on weak GPUs), the primitive shapes, instanced meshes.
//
// Everything is built here as plain triangle lists (no index sharing) that wind counter-clockwise seen from the front, the
// convention of the right-handed scene (core/engine.ts). The primitives and the helpers follow three.js, which the original
// game used: a cylinder stands on the y axis centred on 0, a plane or a circle lies in the xy plane facing +z, rotateX/Y/Z turn
// the points the right-hand way, a matrix array has the translation at 12, 13, 14 (Babylon's Matrix.m has the same layout).
import { Mesh, VertexData, Quaternion, Vector3, Matrix, type Material } from '@babylonjs/core';
import { scene, addCaster } from './engine';
import { rgbInto } from './colors';

// ---------- buckets and shapes ----------
// p positions, n normals, u uvs, c colours (r, g, b per vertex; empty for a shape without colours)
export interface Bucket { p: number[]; n: number[]; u: number[]; c: number[] }
export type Geo = Bucket;
export type P3 = [number, number, number];
export type P2 = [number, number];
export const Bucket = (): Bucket => ({ p: [], n: [], u: [], c: [] });
// the buckets of the whole city, baked once it is built (world/city.ts)
export const BK = { fac: Bucket(), roof: Bucket(), trim: Bucket(), glow: Bucket(), road: Bucket(), pool: Bucket(), car: Bucket() };

const COLR = [0, 0, 0];
// a flat triangle a, b, c in colour col (its normal from the winding)
export function tri(bk: Bucket, a: P3, b: P3, c: P3, col: number, ua?: P2, ub?: P2, uc?: P2) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
  rgbInto(col, COLR, 0);
  for (const [v, u] of [[a, ua], [b, ub], [c, uc]] as [P3, P2 | undefined][]) {
    bk.p.push(v[0], v[1], v[2]); bk.n.push(nx, ny, nz); bk.u.push(u ? u[0] : 0, u ? u[1] : 0); bk.c.push(COLR[0], COLR[1], COLR[2]);
  }
}
export function quad(bk: Bucket, a: P3, b: P3, c: P3, d: P3, col: number, uv?: P2[]) {
  tri(bk, a, b, c, col, uv && uv[0], uv && uv[1], uv && uv[2]); tri(bk, a, c, d, col, uv && uv[0], uv && uv[2], uv && uv[3]);
}
export const centroid = (P: P2[]): P2 => { let x = 0, z = 0; P.forEach(p => { x += p[0]; z += p[1]; }); return [x / P.length, z / P.length]; };
// side walls between a bottom ring and a top ring (convex polygons in x, z, same vertex count); u runs along the facade in world units
export function ring(bk: Bucket, PB: P2[], yB: number, PT: P2[], yT: number, col: number, u0?: number) {
  const n = PB.length, c = centroid(PB); let acc = u0 || 0;
  for (let i = 0; i < n; i++) {
    const a = PB[i], b = PB[(i + 1) % n], at = PT[i], bt = PT[(i + 1) % n], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let A: P3 = [a[0], yB, a[1]], B: P3 = [b[0], yB, b[1]], C: P3 = [bt[0], yT, bt[1]], D: P3 = [at[0], yT, at[1]];
    const ex = B[0] - A[0], ez = B[2] - A[2], nx = -ez, nz = ex, mx = (a[0] + b[0]) / 2 - c[0], mz = (a[1] + b[1]) / 2 - c[1];
    const uv: P2[] = [[acc, yB], [acc + len, yB], [acc + len, yT], [acc, yT]];
    if (nx * mx + nz * mz < 0) { [A, B] = [B, A]; [C, D] = [D, C]; }
    // quad winding: A, B, C, D must give the outward normal (B-A)x(D-A)
    const t1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], t2 = [D[0] - A[0], D[1] - A[1], D[2] - A[2]], cx = t1[1] * t2[2] - t1[2] * t2[1], cz = t1[0] * t2[1] - t1[1] * t2[0];
    if (cx * mx + cz * mz < 0) quad(bk, A, D, C, B, col, [uv[0], uv[3], uv[2], uv[1]]); else quad(bk, A, B, C, D, col, uv);
    acc += len;
  }
}
// the top of a convex polygon at height y, facing up
export function cap(bk: Bucket, P: P2[], y: number, col: number) {
  const p0: P3 = [P[0][0], y, P[0][1]];
  for (let i = 1; i < P.length - 1; i++) {
    let b: P3 = [P[i][0], y, P[i][1]], c: P3 = [P[i + 1][0], y, P[i + 1][1]];
    const cr = (b[2] - p0[2]) * (c[0] - p0[0]) - (b[0] - p0[0]) * (c[2] - p0[2]); if (cr < 0) [b, c] = [c, b];
    tri(bk, p0, b, c, col, [p0[0], p0[2]], [b[0], b[2]], [c[0], c[2]]);
  }
}
// a convex polygon grown outwards by d
export function offsetPoly(P: P2[], d: number): P2[] {
  const n = P.length, c = centroid(P), out: P2[] = [];
  const norm = (a: P2, b: P2): P2 => { let nx = -(b[1] - a[1]), nz = b[0] - a[0]; const l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l; const mx = (a[0] + b[0]) / 2 - c[0], mz = (a[1] + b[1]) / 2 - c[1]; if (nx * mx + nz * mz < 0) { nx = -nx; nz = -nz; } return [nx, nz]; };
  for (let i = 0; i < n; i++) {
    const p = P[(i + n - 1) % n], q = P[i], r = P[(i + 1) % n], n1 = norm(p, q), n2 = norm(q, r);
    let ax = n1[0] + n2[0], az = n1[1] + n2[1]; const l = Math.hypot(ax, az) || 1; ax /= l; az /= l;
    const k = d / Math.max(0.3, ax * n1[0] + az * n1[1]); out.push([q[0] + ax * k, q[1] + az * k]);
  }
  return out;
}
export const rectPoly = (cx: number, cz: number, w: number, d: number, rot = 0): P2[] => {
  const c = Math.cos(rot), s = Math.sin(rot);
  return ([[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]] as P2[]).map(([x, z]) => [cx + x * c + z * s, cz - x * s + z * c] as P2);
};
// a box standing at y0 (centre cx, cz, turned by rot), walls in col and the top in topCol
export function boxB(bk: Bucket, cx: number, y0: number, cz: number, w: number, h: number, d: number, col: number, rot?: number, topCol?: number | null) {
  const P = rectPoly(cx, cz, w, d, rot); ring(bk, P, y0, P, y0 + h, col); cap(bk, P, y0 + h, topCol == null ? col : topCol);
}
// a shape (any Geo) moved by the matrix m (or as it is) into a bucket, in colour col
export function addGeo(bk: Bucket, g: Geo, m: Matrix | null, col: number) {
  const s = m ? applyMatrix(cloneGeo(g), m) : g; rgbInto(col, COLR, 0);
  for (let i = 0; i < s.p.length; i += 3) { bk.p.push(s.p[i], s.p[i + 1], s.p[i + 2]); bk.n.push(s.n[i], s.n[i + 1], s.n[i + 2]); bk.c.push(COLR[0], COLR[1], COLR[2]); }
  for (let i = 0; i < s.p.length / 3; i++) bk.u.push(s.u[i * 2] ?? 0, s.u[i * 2 + 1] ?? 0);
}
// several shapes as one (positions, normals and uvs; colours only if every one has them)
export function mergeGeos(list: Geo[]): Geo {
  const g = Bucket(); const withC = list.every(x => x.c.length);
  for (const x of list) { g.p.push(...x.p); g.n.push(...x.n); g.u.push(...x.u); if (withC) g.c.push(...x.c); }
  return g;
}

// ---------- primitive shapes (three.js conventions, see the top) ----------
// a vertex with its own normal: the triangle is turned so that it faces the way its normals point
function triS(g: Geo, v: number[][], nrm: number[][], uv: number[][]) {
  const [a, b, c] = v, ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
  const fx = uy * wz - uz * wy, fy = uz * wx - ux * wz, fz = ux * wy - uy * wx;
  const sx = nrm[0][0] + nrm[1][0] + nrm[2][0], sy = nrm[0][1] + nrm[1][1] + nrm[2][1], sz = nrm[0][2] + nrm[1][2] + nrm[2][2];
  const order = fx * sx + fy * sy + fz * sz < 0 ? [0, 2, 1] : [0, 1, 2];
  for (const k of order) { g.p.push(v[k][0], v[k][1], v[k][2]); g.n.push(nrm[k][0], nrm[k][1], nrm[k][2]); g.u.push(uv[k][0], uv[k][1]); }
}
// a flat quad a, b, c, d facing along n
function quadN(g: Geo, a: number[], b: number[], c: number[], d: number[], n: number[], uv = [[0, 0], [1, 0], [1, 1], [0, 1]]) {
  triS(g, [a, b, c], [n, n, n], [uv[0], uv[1], uv[2]]); triS(g, [a, c, d], [n, n, n], [uv[0], uv[2], uv[3]]);
}
export function boxGeo(w: number, h: number, d: number): Geo {
  const g = Bucket(), x = w / 2, y = h / 2, z = d / 2;
  quadN(g, [x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z], [1, 0, 0]);
  quadN(g, [-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z], [-1, 0, 0]);
  quadN(g, [-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z], [0, 1, 0]);
  quadN(g, [-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z], [0, -1, 0]);
  quadN(g, [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z], [0, 0, 1]);
  quadN(g, [x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z], [0, 0, -1]);
  return g;
}
// a cylinder (or a cone with rTop 0) on the y axis from -h/2 to h/2; smooth sides, flat caps (none if open)
export function cylGeo(rTop: number, rBot: number, h: number, segs = 8, open = false): Geo {
  const g = Bucket(), y0 = -h / 2, y1 = h / 2, slope = (rBot - rTop) / h;
  const at = (i: number) => { const t = i / segs * Math.PI * 2; return [Math.sin(t), Math.cos(t)]; };
  for (let i = 0; i < segs; i++) {
    const [s0, c0] = at(i), [s1, c1] = at(i + 1);
    const n0 = norm3([s0, slope, c0]), n1 = norm3([s1, slope, c1]);
    const b0 = [rBot * s0, y0, rBot * c0], b1 = [rBot * s1, y0, rBot * c1], t0 = [rTop * s0, y1, rTop * c0], t1 = [rTop * s1, y1, rTop * c1];
    const u0 = i / segs, u1 = (i + 1) / segs;
    triS(g, [b0, b1, t1], [n0, n1, n1], [[u0, 0], [u1, 0], [u1, 1]]);
    if (rTop > 0) triS(g, [b0, t1, t0], [n0, n1, n0], [[u0, 0], [u1, 1], [u0, 1]]);
    if (!open) {
      if (rTop > 0) triS(g, [[0, y1, 0], t0, t1], [[0, 1, 0], [0, 1, 0], [0, 1, 0]], [[0.5, 0.5], [0.5 + s0 / 2, 0.5 + c0 / 2], [0.5 + s1 / 2, 0.5 + c1 / 2]]);
      if (rBot > 0) triS(g, [[0, y0, 0], b1, b0], [[0, -1, 0], [0, -1, 0], [0, -1, 0]], [[0.5, 0.5], [0.5 + s1 / 2, 0.5 + c1 / 2], [0.5 + s0 / 2, 0.5 + c0 / 2]]);
    }
  }
  return g;
}
export const coneGeo = (r: number, h: number, segs = 8) => cylGeo(0, r, h, segs);
export function sphereGeo(r: number, wSeg = 8, hSeg = 6, thetaLen = Math.PI): Geo {
  const g = Bucket(), pt = (i: number, j: number) => {
    const ph = i / wSeg * Math.PI * 2, th = j / hSeg * thetaLen;
    return [-Math.cos(ph) * Math.sin(th), Math.cos(th), Math.sin(ph) * Math.sin(th)];
  };
  for (let j = 0; j < hSeg; j++) for (let i = 0; i < wSeg; i++) {
    const a = pt(i, j), b = pt(i + 1, j), c = pt(i + 1, j + 1), d = pt(i, j + 1), s = (v: number[]) => [v[0] * r, v[1] * r, v[2] * r];
    const uv = (i2: number, j2: number) => [i2 / wSeg, 1 - j2 / hSeg];
    if (j > 0) triS(g, [s(a), s(b), s(c)], [a, b, c], [uv(i, j), uv(i + 1, j), uv(i + 1, j + 1)]);
    if (j < hSeg - 1 || thetaLen < Math.PI) triS(g, [s(a), s(c), s(d)], [a, c, d], [uv(i, j), uv(i + 1, j + 1), uv(i, j + 1)]);
  }
  return g;
}
// a plane w × h in the xy plane, facing +z
export function planeGeo(w: number, h: number): Geo {
  const g = Bucket(), x = w / 2, y = h / 2;
  quadN(g, [-x, -y, 0], [x, -y, 0], [x, y, 0], [-x, y, 0], [0, 0, 1]); return g;
}
// a disc (or a ring from rIn) in the xy plane, facing +z
export function ringGeo(rIn: number, rOut: number, segs = 32): Geo {
  const g = Bucket(), n = [0, 0, 1];
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs * Math.PI * 2, t1 = (i + 1) / segs * Math.PI * 2;
    const o0 = [rOut * Math.cos(t0), rOut * Math.sin(t0), 0], o1 = [rOut * Math.cos(t1), rOut * Math.sin(t1), 0];
    const uvo = (t: number) => [0.5 + Math.cos(t) / 2, 0.5 + Math.sin(t) / 2], uvi = (t: number) => [0.5 + Math.cos(t) * rIn / rOut / 2, 0.5 + Math.sin(t) * rIn / rOut / 2];
    if (rIn <= 0) { triS(g, [[0, 0, 0], o0, o1], [n, n, n], [[0.5, 0.5], uvo(t0), uvo(t1)]); continue; }
    const i0 = [rIn * Math.cos(t0), rIn * Math.sin(t0), 0], i1 = [rIn * Math.cos(t1), rIn * Math.sin(t1), 0];
    quadN(g, i0, o0, o1, i1, n, [uvi(t0), uvo(t0), uvo(t1), uvi(t1)]);
  }
  return g;
}
export const circleGeo = (r: number, segs = 32) => ringGeo(0, r, segs);
// a torus around the z axis (radius R, tube radius r)
export function torusGeo(R: number, r: number, radSegs = 8, tubSegs = 24, arc = Math.PI * 2): Geo {
  const g = Bucket(), pt = (i: number, j: number) => {
    const u = i / tubSegs * arc, v = j / radSegs * Math.PI * 2;
    const p = [(R + r * Math.cos(v)) * Math.cos(u), (R + r * Math.cos(v)) * Math.sin(u), r * Math.sin(v)];
    const c = [R * Math.cos(u), R * Math.sin(u), 0]; return { p, n: norm3([p[0] - c[0], p[1] - c[1], p[2] - c[2]]) };
  };
  for (let i = 0; i < tubSegs; i++) for (let j = 0; j < radSegs; j++) {
    const a = pt(i, j), b = pt(i + 1, j), c = pt(i + 1, j + 1), d = pt(i, j + 1), z = [0, 0];
    triS(g, [a.p, b.p, c.p], [a.n, b.n, c.n], [z, z, z]); triS(g, [a.p, c.p, d.p], [a.n, c.n, d.n], [z, z, z]);
  }
  return g;
}
// an octahedron of radius r (flat faces)
export function octaGeo(r: number): Geo {
  const g = Bucket(), V = [[r, 0, 0], [-r, 0, 0], [0, r, 0], [0, -r, 0], [0, 0, r], [0, 0, -r]];
  for (const x of [0, 1]) for (const y of [2, 3]) for (const z of [4, 5]) {
    const a = V[x], b = V[y], c = V[z], n = norm3([a[0] + b[0] + c[0], a[1] + b[1] + c[1], a[2] + b[2] + c[2]]);
    triS(g, [a, b, c], [n, n, n], [[0, 0], [1, 0], [0, 1]]);
  }
  return g;
}
function norm3(v: number[]) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }

// ---------- moving shapes (in place, like three.js; each returns the shape) ----------
export function cloneGeo(g: Geo): Geo { return { p: g.p.slice(), n: g.n.slice(), u: g.u.slice(), c: g.c.slice() }; }
export function translate(g: Geo, x: number, y: number, z: number) { for (let i = 0; i < g.p.length; i += 3) { g.p[i] += x; g.p[i + 1] += y; g.p[i + 2] += z; } return g; }
function rot(g: Geo, a: number, i0: number, i1: number) {
  const c = Math.cos(a), s = Math.sin(a);
  for (const arr of [g.p, g.n]) for (let i = 0; i < arr.length; i += 3) { const u = arr[i + i0], v = arr[i + i1]; arr[i + i0] = u * c - v * s; arr[i + i1] = u * s + v * c; }
  return g;
}
export const rotateX = (g: Geo, a: number) => rot(g, a, 1, 2);
export const rotateY = (g: Geo, a: number) => rot(g, a, 2, 0);
export const rotateZ = (g: Geo, a: number) => rot(g, a, 0, 1);
export function scaleGeo(g: Geo, sx: number, sy: number, sz: number) {
  for (let i = 0; i < g.p.length; i += 3) { g.p[i] *= sx; g.p[i + 1] *= sy; g.p[i + 2] *= sz; const n = norm3([g.n[i] / sx, g.n[i + 1] / sy, g.n[i + 2] / sz]); g.n[i] = n[0]; g.n[i + 1] = n[1]; g.n[i + 2] = n[2]; }
  return g;
}
// by a matrix (three.js layout = Babylon's Matrix.m: translation at 12..14); normals by its rotation and scale
export function applyMatrix(g: Geo, mtx: Matrix | ArrayLike<number>) {
  const e = mtx instanceof Matrix ? mtx.m : mtx;
  for (let i = 0; i < g.p.length; i += 3) {
    const x = g.p[i], y = g.p[i + 1], z = g.p[i + 2];
    g.p[i] = e[0] * x + e[4] * y + e[8] * z + e[12]; g.p[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13]; g.p[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    const nx = g.n[i], ny = g.n[i + 1], nz = g.n[i + 2];
    const n = norm3([e[0] * nx + e[4] * ny + e[8] * nz, e[1] * nx + e[5] * ny + e[9] * nz, e[2] * nx + e[6] * ny + e[10] * nz]);
    g.n[i] = n[0]; g.n[i + 1] = n[1]; g.n[i + 2] = n[2];
  }
  return g;
}

// ---------- meshes ----------
// a mesh from a shape or a bucket (vertex colours if it has them). Shadows: receives them; casts them if cast. Hidden from
// picking. A mesh that gets no material here is given one later.
export function geoMesh(name: string, g: Geo, mat: Material | null, cast = false, receive = true): Mesh {
  const m = new Mesh(name, scene), vd = new VertexData(), nv = g.p.length / 3;
  vd.positions = g.p; vd.normals = g.n;
  if (g.u.length === nv * 2) vd.uvs = g.u;
  if (g.c.length === nv * 3) { const c = new Array(nv * 4); for (let i = 0; i < nv; i++) { c[i * 4] = g.c[i * 3]; c[i * 4 + 1] = g.c[i * 3 + 1]; c[i * 4 + 2] = g.c[i * 3 + 2]; c[i * 4 + 3] = 1; } vd.colors = c; }
  // Babylon's standard material takes the clockwise side as the front even in a right-handed scene, so every triangle goes in
  // with its last two corners swapped (the shapes above keep the counter-clockwise convention of the original)
  const idx = nv > 65535 ? new Uint32Array(nv) : new Uint16Array(nv); for (let i = 0; i < nv; i += 3) { idx[i] = i; idx[i + 1] = i + 2; idx[i + 2] = i + 1; }
  vd.indices = idx;
  vd.applyToMesh(m, false);
  if (mat) m.material = mat;
  m.isPickable = false;
  m.receiveShadows = receive;
  if (cast) addCaster(m);
  return m;
}
// a finished bucket as one mesh in the scene (null if nothing went into it)
export function bake(name: string, bk: Bucket, mat: Material, cast: boolean): Mesh | null {
  if (!bk.p.length) return null;
  const m = geoMesh(name, bk, mat, cast, true); m.freezeWorldMatrix(); return m;
}
// a box mesh w × h × d at x, y, z (three's `box` helper of the original): casts a shadow unless cast is false, receives one
export function box(w: number, h: number, d: number, mat: Material, x: number, y: number, z: number, cast = true): Mesh {
  const m = geoMesh('box', boxGeo(w, h, d), mat, cast, true); m.position.set(x, y, z); return m;
}

// ---------- matrices for instances (three.js Object3D, as the original built them) ----------
// rotation as Euler angles in three.js's XYZ order; setting it updates the quaternion
export class Euler {
  constructor(private o: Dummy, private _x = 0, private _y = 0, private _z = 0) {}
  get x() { return this._x; } set x(v) { this._x = v; this.o.fromEuler(); }
  get y() { return this._y; } set y(v) { this._y = v; this.o.fromEuler(); }
  get z() { return this._z; } set z(v) { this._z = v; this.o.fromEuler(); }
  set(x: number, y: number, z: number) { this._x = x; this._y = y; this._z = z; this.o.fromEuler(); return this; }
}
export class Dummy {
  position = new Vector3();
  quaternion = new Quaternion();
  scale = new Vector3(1, 1, 1);
  rotation: Euler = new Euler(this);
  matrix = new Float32Array(16);
  fromEuler() { eulerXYZ(this.rotation.x, this.rotation.y, this.rotation.z, this.quaternion); }
  updateMatrix() { compose(this.position, this.quaternion, this.scale, this.matrix); return this.matrix; }
}
// three.js's Euler XYZ → quaternion
export function eulerXYZ(x: number, y: number, z: number, q = new Quaternion()) {
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2), s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  q.x = s1 * c2 * c3 + c1 * s2 * s3; q.y = c1 * s2 * c3 - s1 * c2 * s3; q.z = c1 * c2 * s3 + s1 * s2 * c3; q.w = c1 * c2 * c3 - s1 * s2 * s3;
  return q;
}
// position, quaternion, scale → a matrix array (three.js's Matrix4.compose)
export function compose(p: Vector3, q: Quaternion, s: Vector3, e: Float32Array | number[] = new Float32Array(16)) {
  const x = q.x, y = q.y, z = q.z, w = q.w, x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  e[0] = (1 - (yy + zz)) * s.x; e[1] = (xy + wz) * s.x; e[2] = (xz - wy) * s.x; e[3] = 0;
  e[4] = (xy - wz) * s.y; e[5] = (1 - (xx + zz)) * s.y; e[6] = (yz + wx) * s.y; e[7] = 0;
  e[8] = (xz + wy) * s.z; e[9] = (yz - wx) * s.z; e[10] = (1 - (xx + yy)) * s.z; e[11] = 0;
  e[12] = p.x; e[13] = p.y; e[14] = p.z; e[15] = 1;
  return e;
}

// ---------- instanced meshes (three.js InstancedMesh: one draw call for many copies) ----------
// Babylon's thin instances underneath. setMatrixAt / setColorAt as in three.js, then update() once (three's needsUpdate).
export class Inst {
  readonly mesh: Mesh;
  private m: Float32Array;
  private col: Float32Array | null;
  private n = 0;
  constructor(name: string, g: Geo, mat: Material, readonly max: number, opt: { colors?: boolean; cast?: boolean; receive?: boolean } = {}) {
    this.mesh = geoMesh(name, g, mat, !!opt.cast, opt.receive !== false);
    this.m = new Float32Array(max * 16);
    for (let i = 0; i < max; i++) this.m[i * 16] = this.m[i * 16 + 5] = this.m[i * 16 + 10] = this.m[i * 16 + 15] = 1;
    this.mesh.thinInstanceSetBuffer('matrix', this.m, 16, false);
    this.col = null;
    if (opt.colors) { this.col = new Float32Array(max * 4).fill(1); this.mesh.thinInstanceSetBuffer('color', this.col, 4, false); }
    this.mesh.alwaysSelectAsActiveMesh = true;       // the copies spread over the city: never culled by the base shape's box
    this.count = max;
  }
  get count() { return this.n; }
  set count(v: number) { this.n = Math.max(0, Math.min(this.max, v)); this.mesh.thinInstanceCount = this.n; }
  setMatrixAt(i: number, e: ArrayLike<number>) { this.m.set(e as Float32Array, i * 16); }
  getMatrixAt(i: number, out: Float32Array) { out.set(this.m.subarray(i * 16, i * 16 + 16)); return out; }
  setColorAt(i: number, hex: number) { if (this.col) { rgbInto(hex, this.col, i * 4); this.col[i * 4 + 3] = 1; } }
  // after setMatrixAt / setColorAt (three's needsUpdate); colors false: only the matrices changed, the colours stay as uploaded
  update(colors = true) { this.mesh.thinInstanceBufferUpdated('matrix'); if (colors && this.col) this.mesh.thinInstanceBufferUpdated('color'); }
  set visible(v: boolean) { this.mesh.setEnabled(v); }
}
