// World of DODO, issue #16: the plane geometry of the real Karlín (client/shared/map.ts builds the city with it). Pure helpers:
// no game state, no DOM, the same code on the client and the server.
//
// Polygons are flat arrays [x0,z0,x1,z1,...], first point not repeated, with the interior on the RIGHT of every edge: positive
// shoelace sum(x_i*z_{i+1} - x_{i+1}*z_i), the orientation of karlin.json (map.ts turns any other round). x east, z south; "right"
// of a direction (dx,dz) is (-dz,dx), the outward normal of an edge is (dz,-dx).
//
// Where a result decides something (is this spot free, which loop survives) only + - * / and sqrt are used: they are correctly
// rounded in every JS engine, so the client and the server derive the very same city from the same data. Math.hypot, sin, cos and
// atan2 are not guaranteed to agree to the last bit across engines; they only make outputs (headings), never decisions.

export type Pts = ArrayLike<number>;
export type Box = [number, number, number, number];   // x0, z0, x1, z1

const len = (x: number, z: number) => Math.sqrt(x * x + z * z);
const dd = (x: number, z: number) => x * x + z * z;     // not x ** 2: that is Math.pow, which engines need not round alike

// is (x,z) inside the polygon? Points on the boundary count as inside (a wheel touching a wall touches it). Even-odd rule, the
// half-open crossing test, so a ray through a vertex is counted once.
export function pointInPoly(p: Pts, x: number, z: number): boolean {
  const n = p.length; let c = false;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = p[i], zi = p[i + 1], xj = p[j], zj = p[j + 1];
    if (xi === x && zi === z) return true;                                            // on a vertex
    if ((zi > z) !== (zj > z)) {
      const t = xi + (z - zi) * (xj - xi) / (zj - zi);                                // where the edge crosses this row
      if (x < t) c = !c; else if (x === t) return true;                               // left of it: one crossing; on it: inside
    } else if (zi === z && zj === z && (x - xi) * (x - xj) <= 0) return true;         // on a horizontal edge
  }
  return c;
}

// the nearest point of the polygon's boundary: x, z, d2 its squared distance, nx, nz the outward normal of its edge, e the edge
// (from vertex e to e+1), t where on it. `out` is reused when given (hot paths: no garbage).
export interface Near { x: number; z: number; d2: number; nx: number; nz: number; e: number; t: number }
export function closestOnPoly(p: Pts, x: number, z: number, out?: Near): Near {
  const o = out || { x: 0, z: 0, d2: 0, nx: 0, nz: 0, e: 0, t: 0 }, n = p.length; o.d2 = Infinity;
  for (let i = 0; i < n; i += 2) {
    const ax = p[i], az = p[i + 1], j = i + 2 < n ? i + 2 : 0, dx = p[j] - ax, dz = p[j + 1] - az, l2 = dx * dx + dz * dz;
    let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = ax + dx * t, qz = az + dz * t, d2 = (x - qx) * (x - qx) + (z - qz) * (z - qz);
    if (d2 < o.d2) { const l = Math.sqrt(l2) || 1; o.x = qx; o.z = qz; o.d2 = d2; o.nx = dz / l; o.nz = -dx / l; o.e = i >> 1; o.t = t; }
  }
  return o;
}

// where segment a→b crosses segment c→d: the parameter along a→b (0..1), or -1. A touch counts; for collinear overlapping
// segments, where the overlap starts.
export function segSeg(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): number {
  const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz, den = rx * sz - rz * sx, qx = cx - ax, qz = cz - az;
  if (den === 0) {                                                                    // parallel: only a collinear overlap touches
    if (qx * rz - qz * rx !== 0) return -1;
    const rr = rx * rx + rz * rz; if (rr === 0) return -1;
    let t0 = (qx * rx + qz * rz) / rr, t1 = t0 + (sx * rx + sz * rz) / rr; if (t0 > t1) { const w = t0; t0 = t1; t1 = w; }
    return t1 < 0 || t0 > 1 ? -1 : t0 < 0 ? 0 : t0;
  }
  const u = (qx * sz - qz * sx) / den, v = (qx * rz - qz * rx) / den;
  return u >= 0 && u <= 1 && v >= 0 && v <= 1 ? u : -1;
}

// the first t in 0..1 at which the segment a→b is inside the polygon: 0 if a already is, 2 if it never gets in. (Grazing a vertex
// counts as getting in: for collisions, safer that way.)
export function segPoly(p: Pts, ax: number, az: number, bx: number, bz: number): number {
  if (pointInPoly(p, ax, az)) return 0;
  const n = p.length; let best = 2;
  for (let i = 0; i < n; i += 2) {
    const j = i + 2 < n ? i + 2 : 0, u = segSeg(ax, az, bx, bz, p[i], p[i + 1], p[j], p[j + 1]);
    if (u >= 0 && u < best) best = u;
  }
  return best;
}

// signed area: positive for karlin.json's orientation (interior on the right)
export function polyArea(p: Pts): number {
  let s = 0; const n = p.length;
  for (let i = 0; i < n; i += 2) { const j = i + 2 < n ? i + 2 : 0; s += p[i] * p[j + 1] - p[j] * p[i + 1]; }
  return s / 2;
}
export function polyBox(p: Pts): Box {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) { const x = p[i], z = p[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
  return [x0, z0, x1, z1];
}
// the centroid of the area (falls back to the vertex average for a degenerate polygon)
export function polyCentroid(p: Pts): [number, number] {
  let a = 0, cx = 0, cz = 0; const n = p.length;
  for (let i = 0; i < n; i += 2) { const j = i + 2 < n ? i + 2 : 0, w = p[i] * p[j + 1] - p[j] * p[i + 1]; a += w; cx += (p[i] + p[j]) * w; cz += (p[i + 1] + p[j + 1]) * w; }
  if (Math.abs(a) < 1e-9) { cx = cz = 0; for (let i = 0; i < n; i += 2) { cx += p[i]; cz += p[i + 1]; } return [cx / (n / 2), cz / (n / 2)]; }
  return [cx / (3 * a), cz / (3 * a)];
}
// the same polygon turned the other way round
export function polyReverse(p: Pts): number[] {
  const o: number[] = [];
  for (let i = p.length - 2; i >= 0; i -= 2) o.push(p[i], p[i + 1]);
  return o;
}

// squared distance from (x,z) to the segment a→b
export function distSeg2(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - x, qz = az + dz * t - z; return qx * qx + qz * qz;
}

// Douglas-Peucker: drop the points closer than tol to the line of their neighbours. closed: a polygon (split at the vertex farthest
// from the first one), else an open polyline whose ends stay.
export function simplify(p: Pts, tol: number, closed = true): number[] {
  const n = p.length >> 1; if (n < (closed ? 4 : 3)) return Array.from(p);
  const keep = new Uint8Array(n), t2 = tol * tol;
  const dp = (a: number, b: number) => {                                              // keep the farthest point between a and b, recurse
    const st: number[] = [a, b];
    while (st.length) {
      const j = st.pop() as number, i = st.pop() as number; let far = -1, fd = t2;
      for (let k = i + 1; k < j; k++) { const d = distSeg2(p[2 * k], p[2 * k + 1], p[2 * i], p[2 * i + 1], p[2 * (j % n)], p[2 * (j % n) + 1]); if (d > fd) { fd = d; far = k; } }
      if (far >= 0) { keep[far] = 1; st.push(i, far, far, j); }
    }
  };
  keep[0] = 1;
  if (closed) {
    let far = 0, fd = -1;
    for (let k = 1; k < n; k++) { const d = dd(p[2 * k] - p[0], p[2 * k + 1] - p[1]); if (d > fd) { fd = d; far = k; } }
    keep[far] = 1; dp(0, far); dp(far, n);                                            // index n is vertex 0 again (j % n)
  } else { keep[n - 1] = 1; dp(0, n - 1); }
  const o: number[] = [];
  for (let k = 0; k < n; k++) if (keep[k]) o.push(p[2 * k], p[2 * k + 1]);
  return o;
}

// cumulative lengths along a polyline (flat [x,z,...] or [[x,z],...]): cum[0] = 0, cum[k] = length up to point k; closed adds the
// segment back to the first point, so cum has one entry more than there are points and its last is the loop's length.
type AnyPts = Pts | readonly (readonly [number, number])[];
const px = (p: AnyPts, k: number) => typeof p[0] === 'number' ? (p as Pts)[2 * k] : (p as [number, number][])[k][0];
const pz = (p: AnyPts, k: number) => typeof p[0] === 'number' ? (p as Pts)[2 * k + 1] : (p as [number, number][])[k][1];
const npts = (p: AnyPts) => typeof p[0] === 'number' ? p.length >> 1 : p.length;
export function polylineCum(p: AnyPts, closed = false): number[] {
  const n = npts(p), cum = [0];
  for (let k = 1; k < n; k++) cum.push(cum[k - 1] + len(px(p, k) - px(p, k - 1), pz(p, k) - pz(p, k - 1)));
  if (closed && n > 1) cum.push(cum[n - 1] + len(px(p, 0) - px(p, n - 1), pz(p, 0) - pz(p, n - 1)));
  return cum;
}
// the point at arc length s along a polyline with its cumulative lengths (from polylineCum): x, z, hx, hz the unit direction there,
// k the segment. With a closed loop's cum (one entry more than points) s wraps round; on an open line it is clamped to the ends.
export interface At { x: number; z: number; hx: number; hz: number; k: number }
export function polylineAt(p: AnyPts, cum: ArrayLike<number>, s: number, out?: At): At {
  const o = out || { x: 0, z: 0, hx: 1, hz: 0, k: 0 }, n = npts(p), closed = cum.length > n, L = cum[cum.length - 1];
  if (closed && L > 0) { s %= L; if (s < 0) s += L; } else s = s < 0 ? 0 : s > L ? L : s;
  let lo = 0, hi = cum.length - 2;                                                    // the segment k with cum[k] <= s < cum[k+1]
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (cum[m] <= s) lo = m; else hi = m - 1; }
  const k = lo, j = k + 1 < n ? k + 1 : 0, ax = px(p, k), az = pz(p, k), dx = px(p, j) - ax, dz = pz(p, j) - az, sl = cum[k + 1] - cum[k];
  const t = sl > 0 ? (s - cum[k]) / sl : 0, l = len(dx, dz);
  o.x = ax + dx * t; o.z = az + dz * t; if (l > 0) { o.hx = dx / l; o.hz = dz / l; } o.k = k; return o;
}

// a polyline moved sideways by d (positive: to the right of its direction), mitred joins whose spikes are cut at miter × |d|
// (a bevel instead). closed: the points form a loop (the result is a loop too).
export function offsetPolyline(p: Pts, d: number, closed = false, miter = 2): number[] {
  const n = p.length >> 1, o: number[] = []; if (n < 2) return Array.from(p);
  const nrm = (k: number): [number, number] => {                                      // right normal of segment k → k+1
    const j = (k + 1) % n, dx = p[2 * j] - p[2 * k], dz = p[2 * j + 1] - p[2 * k + 1], l = len(dx, dz) || 1; return [-dz / l, dx / l];
  };
  for (let k = 0; k < n; k++) {
    const x = p[2 * k], z = p[2 * k + 1];
    if (!closed && (k === 0 || k === n - 1)) { const [nx, nz] = nrm(k === 0 ? 0 : n - 2); o.push(x + nx * d, z + nz * d); continue; }
    const [ax, az] = nrm((k - 1 + n) % n), [bx, bz] = nrm(k), mx = ax + bx, mz = az + bz, c = (1 + ax * bx + az * bz) / 2;   // c = cos²(half turn)
    if (c > 1 / (miter * miter) && len(mx, mz) > 1e-9) { const f = d / (2 * c); o.push(x + mx * f, z + mz * f); }       // mitre: |m/2| = cos(half), /cos²
    else o.push(x + ax * d, z + az * d, x + bx * d, z + bz * d);                                                          // too sharp: bevel
  }
  return o;
}

// The polygon shrunk by d (its edges moved d inwards), robust for concave shapes: edges that the shrinking turns round are dropped
// (the neighbours meet instead), long spikes at concave corners are bevelled, and where the result still crosses itself it is cut
// into loops of which the biggest survives. null when nothing of at least minArea is left.
export function insetPoly(p: Pts, d: number, minArea = 1): number[] | null {
  const n = p.length >> 1; if (n < 3) return null;
  const ux: number[] = [], uz: number[] = [], ox: number[] = [], oz: number[] = [];   // edge directions, a point of each moved edge
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n, dx = p[2 * j] - p[2 * k], dz = p[2 * j + 1] - p[2 * k + 1], l = len(dx, dz);
    ux.push(l > 0 ? dx / l : 0); uz.push(l > 0 ? dz / l : 0); ox.push(p[2 * k] - (l > 0 ? dz / l : 0) * d); oz.push(p[2 * k + 1] + (l > 0 ? dx / l : 0) * d);
  }
  let E: number[] = []; for (let k = 0; k < n; k++) if (ux[k] !== 0 || uz[k] !== 0) E.push(k);
  // where moved edge a ends and moved edge b starts (one point, or two at a bevelled concave corner); v = the original corner
  const join = (a: number, b: number): number[] => {
    const cr = ux[a] * uz[b] - uz[a] * ux[b];
    const vx = ox[b] + uz[b] * d, vz = oz[b] - ux[b] * d;                              // b's original start point
    if (Math.abs(cr) < 1e-9) return [ox[b], oz[b]];                                   // straight on (or folded back): b's moved start
    const t = ((ox[b] - ox[a]) * uz[b] - (oz[b] - oz[a]) * ux[b]) / cr, x = ox[a] + ux[a] * t, z = oz[a] + uz[a] * t;
    if (cr < 0 && (x - vx) * (x - vx) + (z - vz) * (z - vz) > 4 * d * d) {           // concave corner, spike longer than 2d: bevel
      return [vx - uz[a] * d, vz + ux[a] * d, vx - uz[b] * d, vz + ux[b] * d];
    }
    return [x, z];
  };
  for (let guard = 0; guard < 4 * n; guard++) {                                       // drop the edge the shrinking turned round the most
    if (E.length < 3) return null;
    const m = E.length, J = E.map((a, i) => join(a, E[(i + 1) % m]));
    let worst = -1, wv = -1e-9;
    for (let i = 0; i < m; i++) {
      const s = J[(i - 1 + m) % m], e = J[i], sx = s[s.length - 2], sz = s[s.length - 1], v = (e[0] - sx) * ux[E[i]] + (e[1] - sz) * uz[E[i]];
      if (v < wv) { wv = v; worst = i; }
    }
    if (worst < 0) {
      const q: number[] = []; for (const j of J) q.push(...j);
      let best: number[] | null = null, ba = minArea;
      for (const L of splitLoops(q, 0)) { const a = polyArea(L); if (a >= ba) { ba = a; best = L; } }
      return best;
    }
    E.splice(worst, 1);
  }
  return null;
}
// cut a closed point list where its edges cross into simple loops (both orientations come back; the caller keeps what it wants)
function splitLoops(q: number[], depth: number): number[][] {
  const n = q.length >> 1;
  if (depth < 24) for (let i = 0; i < n; i++) {
    const i1 = (i + 1) % n;
    for (let j = i + 2; j < n; j++) {
      const j1 = (j + 1) % n; if (j1 === i) continue;                                 // neighbours share a point, not a crossing
      const u = segSeg(q[2 * i], q[2 * i + 1], q[2 * i1], q[2 * i1 + 1], q[2 * j], q[2 * j + 1], q[2 * j1], q[2 * j1 + 1]);
      if (u < 0) continue;
      const X = q[2 * i] + (q[2 * i1] - q[2 * i]) * u, Z = q[2 * i + 1] + (q[2 * i1 + 1] - q[2 * i + 1]) * u, A = [X, Z], B = [X, Z];
      for (let k = i1; k !== j1; k = (k + 1) % n) A.push(q[2 * k], q[2 * k + 1]);     // X, i+1 .. j
      for (let k = j1; k !== i1; k = (k + 1) % n) B.push(q[2 * k], q[2 * k + 1]);     // X, j+1 .. i
      return [...splitLoops(dedupe(A), depth + 1), ...splitLoops(dedupe(B), depth + 1)];
    }
  }
  return n >= 3 ? [q] : [];
}
// drop points equal to their predecessor (a cut at a vertex repeats it)
function dedupe(q: number[]): number[] {
  const o: number[] = [], n = q.length >> 1;
  for (let k = 0; k < n; k++) {
    const x = q[2 * k], z = q[2 * k + 1], m = o.length;
    if (m && Math.abs(o[m - 2] - x) < 1e-9 && Math.abs(o[m - 1] - z) < 1e-9) continue;
    o.push(x, z);
  }
  if (o.length >= 4 && Math.abs(o[0] - o[o.length - 2]) < 1e-9 && Math.abs(o[1] - o[o.length - 1]) < 1e-9) o.length -= 2;
  return o;
}

// A uniform grid over a fixed extent (things outside it are kept in the border cells, so nothing gets lost): add an item by its
// box, query a box for every item whose box may overlap it, each once.
export class Hash<T> {
  readonly x0: number; readonly z0: number; readonly cell: number; readonly nx: number; readonly nz: number;
  private cells: number[][]; private items: T[] = []; private boxes: number[] = []; private stamp: number[] = []; private q = 0;
  constructor(x0: number, z0: number, x1: number, z1: number, cell = 16) {
    this.x0 = x0; this.z0 = z0; this.cell = cell;
    this.nx = Math.max(1, Math.ceil((x1 - x0) / cell)); this.nz = Math.max(1, Math.ceil((z1 - z0) / cell));
    this.cells = Array.from({ length: this.nx * this.nz }, () => []);
  }
  private ix(x: number) { const i = Math.floor((x - this.x0) / this.cell); return i < 0 ? 0 : i >= this.nx ? this.nx - 1 : i; }
  private iz(z: number) { const i = Math.floor((z - this.z0) / this.cell); return i < 0 ? 0 : i >= this.nz ? this.nz - 1 : i; }
  add(b: ArrayLike<number>, item: T) {
    const k = this.items.length; this.items.push(item); this.boxes.push(b[0], b[1], b[2], b[3]); this.stamp.push(0);
    for (let j = this.iz(b[1]), j1 = this.iz(b[3]); j <= j1; j++) for (let i = this.ix(b[0]), i1 = this.ix(b[2]); i <= i1; i++) this.cells[j * this.nx + i].push(k);
  }
  // items whose box overlaps x0..x1 × z0..z1 (pushed onto out, which is returned; cleared first)
  query(x0: number, z0: number, x1: number, z1: number, out: T[] = []): T[] {
    out.length = 0; const q = ++this.q, B = this.boxes;
    for (let j = this.iz(z0), j1 = this.iz(z1); j <= j1; j++) for (let i = this.ix(x0), i1 = this.ix(x1); i <= i1; i++) {
      const c = this.cells[j * this.nx + i];
      for (let m = 0; m < c.length; m++) {
        const k = c[m]; if (this.stamp[k] === q) continue; this.stamp[k] = q;
        if (B[4 * k] > x1 || B[4 * k + 2] < x0 || B[4 * k + 1] > z1 || B[4 * k + 3] < z0) continue;
        out.push(this.items[k]);
      }
    }
    return out;
  }
  get size() { return this.items.length; }
}

// A* over a graph of n nodes: nbr(i, visit) calls visit(j, cost) for every way out of i, h(i) a lower bound of the cost from i to
// the goal (0 makes it Dijkstra). The node path from start to goal, [] when the goal cannot be reached.
export function astar(n: number, start: number, goal: number, nbr: (i: number, visit: (j: number, w: number) => void) => void, h: (i: number) => number): number[] {
  if (start === goal) return [start];
  const g = new Float64Array(n).fill(Infinity), from = new Int32Array(n).fill(-1), done = new Uint8Array(n);
  const hf: number[] = [], hn: number[] = [];                                         // binary heap of (f, node)
  const push = (f: number, v: number) => {
    let i = hf.length; hf.push(f); hn.push(v);
    while (i > 0) { const pi = (i - 1) >> 1; if (hf[pi] <= f) break; hf[i] = hf[pi]; hn[i] = hn[pi]; i = pi; }
    hf[i] = f; hn[i] = v;
  };
  const pop = () => {
    const v = hn[0], lf = hf.pop() as number, ln = hn.pop() as number, m = hf.length;
    if (m) {
      let i = 0;
      for (;;) { let c = 2 * i + 1; if (c >= m) break; if (c + 1 < m && hf[c + 1] < hf[c]) c++; if (hf[c] >= lf) break; hf[i] = hf[c]; hn[i] = hn[c]; i = c; }
      hf[i] = lf; hn[i] = ln;
    }
    return v;
  };
  g[start] = 0; push(h(start), start);
  let cur = -1;
  const visit = (j: number, w: number) => { const ng = g[cur] + w; if (ng < g[j]) { g[j] = ng; from[j] = cur; push(ng + h(j), j); } };
  while (hf.length) {
    cur = pop(); if (done[cur]) continue; done[cur] = 1;
    if (cur === goal) { const path = [goal]; for (let v = from[goal]; v >= 0; v = from[v]) path.push(v); return path.reverse(); }
    nbr(cur, visit);
  }
  return [];
}
