// World of DODO, issue #16: the 2D geometry the generator needs, written out here so that it has no npm dependency.
// Points are [x, z] pairs, rings are arrays of them (first point not repeated). Orientation: a ring is "positive" when
// sum(x_i*z_(i+1) - x_(i+1)*z_i) > 0, the convention of karlin.json (interior on the left in math terms, x right, z up).

export const area = r => { let s = 0; for (let i = 0, n = r.length; i < n; i++) { const a = r[i], b = r[(i + 1) % n]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };
export const box = r => { let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9; for (const [x, z] of r) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; } return [x0, z0, x1, z1]; };
export const boxHit = (a, b, m = 0) => a[0] <= b[2] + m && b[0] <= a[2] + m && a[1] <= b[3] + m && b[1] <= a[3] + m;
export const len = pts => { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return s; };
export const ccw = r => area(r) < 0 ? r.slice().reverse() : r;
export function centroid(r) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, n = r.length; i < n; i++) { const p = r[i], q = r[(i + 1) % n], c = p[0] * q[1] - q[0] * p[1]; a += c; cx += (p[0] + q[0]) * c; cz += (p[1] + q[1]) * c; }
  if (Math.abs(a) < 1e-12) { const b = box(r); return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; }
  return [cx / (3 * a), cz / (3 * a)];
}
export function pip(r, x, z) {
  let in_ = false;
  for (let i = 0, n = r.length, j = n - 1; i < n; j = i++) {
    const a = r[i], b = r[j];
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) in_ = !in_;
  }
  return in_;
}
// a point surely inside the ring (the centroid if it is inside, else the middle of the widest span on a scanline)
export function inner(r) {
  const c = centroid(r); if (pip(r, c[0], c[1])) return c;
  const b = box(r); let best = null, bw = -1;
  for (let k = 1; k < 8; k++) {
    const z = b[1] + (b[3] - b[1]) * k / 8, xs = [];
    for (let i = 0, n = r.length, j = n - 1; i < n; j = i++) { const p = r[i], q = r[j]; if ((p[1] > z) !== (q[1] > z)) xs.push(p[0] + (q[0] - p[0]) * (z - p[1]) / (q[1] - p[1])); }
    xs.sort((u, v) => u - v);
    for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > bw) { bw = xs[i + 1] - xs[i]; best = [(xs[i] + xs[i + 1]) / 2, z]; }
  }
  return best || c;
}
export function distSeg2(px, pz, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz;
  let t = l2 ? ((px - a[0]) * dx + (pz - a[1]) * dz) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = a[0] + dx * t - px, z = a[1] + dz * t - pz; return x * x + z * z;
}
export function distPoly2(pts, x, z, closed) {
  let d = 1e18; const n = pts.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) d = Math.min(d, distSeg2(x, z, pts[i], pts[(i + 1) % n]));
  return d;
}
// nearest point on a polyline: { d2, s (arc length), x, z, i (segment) }
export function project(pts, x, z) {
  let best = { d2: 1e18, s: 0, x: 0, z: 0, i: 0 }, acc = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1], dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz, L = Math.sqrt(l2);
    let t = l2 ? ((x - a[0]) * dx + (z - a[1]) * dz) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = a[0] + dx * t, qz = a[1] + dz * t, d2 = (qx - x) ** 2 + (qz - z) ** 2;
    if (d2 < best.d2) best = { d2, s: acc + L * t, x: qx, z: qz, i };
    acc += L;
  }
  return best;
}

// ---- simplification (Douglas-Peucker) ----
function dp(pts, a, b, tol2, keep) {
  let md = -1, mi = -1;
  for (let i = a + 1; i < b; i++) { const d = distSeg2(pts[i][0], pts[i][1], pts[a], pts[b]); if (d > md) { md = d; mi = i; } }
  if (md > tol2) { keep[mi] = 1; dp(pts, a, mi, tol2, keep); dp(pts, mi, b, tol2, keep); }
}
export function simplifyLine(pts, tol) {
  if (pts.length < 3 || tol <= 0) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  dp(pts, 0, pts.length - 1, tol * tol, keep);
  return pts.filter((_, i) => keep[i]);
}
export function simplifyRing(r, tol) {
  r = dedupe(r);
  if (r.length < 4 || tol <= 0) return r;
  let far = 0, fd = -1;
  for (let i = 1; i < r.length; i++) { const d = (r[i][0] - r[0][0]) ** 2 + (r[i][1] - r[0][1]) ** 2; if (d > fd) { fd = d; far = i; } }
  const a = simplifyLine(r.slice(0, far + 1), tol), b = simplifyLine([...r.slice(far), r[0]], tol);
  return dropCollinear([...a, ...b.slice(1, -1)]);
}
export function dedupe(r, eps = 1e-6, closed = true) {
  const o = [];
  for (const p of r) if (!o.length || Math.abs(p[0] - o[o.length - 1][0]) > eps || Math.abs(p[1] - o[o.length - 1][1]) > eps) o.push(p);
  while (closed && o.length > 1 && Math.abs(o[0][0] - o[o.length - 1][0]) <= eps && Math.abs(o[0][1] - o[o.length - 1][1]) <= eps) o.pop();
  return o;
}
// drop points that lie on the line of their neighbours (also spikes that fold back)
export function dropCollinear(r, eps = 1e-9) {
  let o = r.slice(), changed = true;
  while (changed && o.length > 3) {
    changed = false;
    for (let i = 0; i < o.length && o.length > 3; i++) {
      const a = o[(i + o.length - 1) % o.length], b = o[i], c = o[(i + 1) % o.length];
      const cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      const l = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
      if (Math.abs(cr) / l < eps * 10 + 1e-7) { o.splice(i, 1); i--; changed = true; }
    }
  }
  return o;
}

// ---- validity ----
const orient = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const onSeg = (a, b, p) => Math.min(a[0], b[0]) - 1e-9 <= p[0] && p[0] <= Math.max(a[0], b[0]) + 1e-9 && Math.min(a[1], b[1]) - 1e-9 <= p[1] && p[1] <= Math.max(a[1], b[1]) + 1e-9;
export function segsHit(a, b, c, d) {
  const e = 1e-12, o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  if (((o1 > e && o2 < -e) || (o1 < -e && o2 > e)) && ((o3 > e && o4 < -e) || (o3 < -e && o4 > e))) return true;
  if (Math.abs(o1) <= e && onSeg(a, b, c)) return true;
  if (Math.abs(o2) <= e && onSeg(a, b, d)) return true;
  if (Math.abs(o3) <= e && onSeg(c, d, a)) return true;
  if (Math.abs(o4) <= e && onSeg(c, d, b)) return true;
  return false;
}
// the parameter t along a->b where it crosses c->d (proper crossings only), or -1
export function segX(a, b, c, d) {
  const rx = b[0] - a[0], rz = b[1] - a[1], sx = d[0] - c[0], sz = d[1] - c[1], den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-12) return [-1, -1];
  const t = ((c[0] - a[0]) * sz - (c[1] - a[1]) * sx) / den, u = ((c[0] - a[0]) * rz - (c[1] - a[1]) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [t, u] : [-1, -1];
}
// edge pairs (i, j) of a ring that touch or cross (non-adjacent), via a grid so that big rings stay fast
export function selfHits(r, max = 1) {
  const n = r.length, out = [];
  if (n < 3) return [[0, 0]];
  const b = box(r), cs = Math.max((b[2] - b[0]) + (b[3] - b[1]), 1e-6) / Math.max(4, Math.sqrt(n)), G = new Map();
  const key = (i, j) => i * 100003 + j;
  for (let i = 0; i < n; i++) {
    const p = r[i], q = r[(i + 1) % n];
    const i0 = Math.floor((Math.min(p[0], q[0]) - b[0]) / cs), i1 = Math.floor((Math.max(p[0], q[0]) - b[0]) / cs);
    const j0 = Math.floor((Math.min(p[1], q[1]) - b[1]) / cs), j1 = Math.floor((Math.max(p[1], q[1]) - b[1]) / cs);
    for (let x = i0; x <= i1; x++) for (let z = j0; z <= j1; z++) { const k = key(x, z); let c = G.get(k); if (!c) G.set(k, c = []); c.push(i); }
  }
  const seen = new Set();
  for (const c of G.values()) for (let a = 0; a < c.length; a++) for (let bb = a + 1; bb < c.length; bb++) {
    let i = c[a], j = c[bb]; if (i > j) [i, j] = [j, i];
    const pk = i * n + j; if (seen.has(pk)) continue; seen.add(pk);
    const adj = j === i + 1 || (i === 0 && j === n - 1);
    const p1 = r[i], p2 = r[(i + 1) % n], q1 = r[j], q2 = r[(j + 1) % n];
    if (adj) {
      // neighbours share a point: bad only if they fold back over each other
      const s = j === i + 1 ? [p1, p2, q2] : [q1, q2, p2];
      if (Math.abs(orient(s[0], s[1], s[2])) < 1e-12 && (s[1][0] - s[0][0]) * (s[2][0] - s[1][0]) + (s[1][1] - s[0][1]) * (s[2][1] - s[1][1]) < 0) { out.push([i, j]); if (out.length >= max) return out; }
      continue;
    }
    if (segsHit(p1, p2, q1, q2)) { out.push([i, j]); if (out.length >= max) return out; }
  }
  return out;
}
export const isSimple = r => r.length >= 3 && Math.abs(area(r)) > 1e-9 && selfHits(r).length === 0;

// a valid, positive, simplified ring or null: DP with tol, falling back to smaller tolerances when DP makes it cross itself,
// rounding to 0.1 at the end (and checking again, rounding can fold a thin ring)
export const r1 = v => Math.round(v * 10) / 10;
export function cleanRing(r, tol, minArea = 0) {
  r = dedupe(r);
  if (r.length < 3) return null;
  if (area(r) < 0) r = r.slice().reverse();
  for (const t of [tol, tol / 2, tol / 4, 0]) {
    let s = simplifyRing(r, t);
    s = dropCollinear(dedupe(s.map(p => [r1(p[0]), r1(p[1])])), 1e-9);
    if (s.length < 3) continue;
    if (area(s) <= Math.max(minArea, 1e-6)) continue;
    if (isSimple(s)) return s;
  }
  return null;
}

// ---- clipping by a half-plane, holes kept right (the pieces of a polygon with holes) ----
// rings: outer rings positive, holes negative. Returns [{ outer, holes }].
function frameOf(axis, keepLE, c) {
  if (axis === 0) return keepLE ? [p => [p[0] - c, p[1]], q => [q[0] + c, q[1]]] : [p => [c - p[0], -p[1]], q => [c - q[0], -q[1]]];
  return keepLE ? [p => [p[1] - c, -p[0]], q => [-q[1], q[0] + c]] : [p => [c - p[1], p[0]], q => [q[1], c - q[0]]];
}
export function clipHalf(rings, axis, c, keepLE) {
  const [fw, inv] = frameOf(axis, keepLE, c);
  const loc = rings.map(r => r.map(fw)), chains = [], whole = [];
  for (const r of loc) {
    const n = r.length, ins = r.map(p => p[0] <= 0);
    if (ins.every(Boolean)) { whole.push(r); continue; }
    if (!ins.some(Boolean)) continue;
    const s = ins.indexOf(false); let cur = null;
    for (let k = 0; k < n; k++) {
      const i = (s + k) % n, j = (i + 1) % n, a = r[i], b = r[j];
      if (ins[i]) cur.push(a);
      if (ins[i] !== ins[j]) {
        const t = -a[0] / (b[0] - a[0]), p = [0, a[1] + (b[1] - a[1]) * t];
        if (!ins[i]) cur = [p]; else { cur.push(p); chains.push(cur); cur = null; }
      }
    }
  }
  const outers = [], holes = [];
  if (chains.length) {
    const entries = chains.map((ch, i) => [ch[0][1], i]).sort((a, b) => a[0] - b[0]);
    const next = chains.map(ch => {
      const v = ch[ch.length - 1][1];
      let lo = 0, hi = entries.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (entries[m][0] < v - 1e-12) lo = m + 1; else hi = m; }
      return entries[Math.min(lo, entries.length - 1)][1];
    });
    const used = new Uint8Array(chains.length);
    for (let i = 0; i < chains.length; i++) {
      if (used[i]) continue;
      const ring = []; let k = i, guard = 0;
      while (!used[k] && guard++ <= chains.length) { used[k] = 1; ring.push(...chains[k]); k = next[k]; }
      const d = dedupe(ring);
      if (d.length >= 3 && area(d) > 1e-9) outers.push(d);
    }
  }
  for (const r of whole) (area(r) > 0 ? outers : holes).push(r);
  const res = outers.map(o => ({ outer: o, holes: [] }));
  for (const h of holes) {
    const p = h[0], f = res.find(pg => pip(pg.outer, p[0], p[1]));
    if (f) f.holes.push(h);
  }
  return res.map(pg => ({ outer: pg.outer.map(inv), holes: pg.holes.map(h => h.map(inv)) }));
}
export function clipRect(outer, holes, x0, z0, x1, z1) {
  let polys = [{ outer, holes }];
  for (const [axis, c, le] of [[0, x0, false], [0, x1, true], [1, z0, false], [1, z1, true]]) {
    polys = polys.flatMap(pg => clipHalf([pg.outer, ...pg.holes], axis, c, le));
  }
  return polys;
}
// a polygon with holes as simple rings without holes: cut it across every hole (a vertical line through the hole's middle)
export function decompose(outer, holes, depth = 0) {
  holes = holes.filter(h => Math.abs(area(h)) > 1e-6);
  if (!holes.length || depth > 40) return [outer];
  const b = box(holes[0]), c = (b[0] + b[2]) / 2 + 1.234567e-5;
  const rings = [outer, ...holes];
  return [...clipHalf(rings, 0, c, true), ...clipHalf(rings, 0, c, false)].flatMap(pg => decompose(pg.outer, pg.holes, depth + 1));
}

// ---- closed rings from multipolygon member ways (joined end to end) ----
export function joinRings(lines, eps = 1e-9) {
  const open = lines.filter(l => l.length >= 2).map(l => l.slice()), rings = [];
  const same = (a, b) => Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps;
  while (open.length) {
    let cur = open.shift();
    for (let guard = 0; !same(cur[0], cur[cur.length - 1]) && guard < 10000; guard++) {
      const end = cur[cur.length - 1];
      const i = open.findIndex(l => same(l[0], end) || same(l[l.length - 1], end));
      if (i < 0) break;
      const l = open.splice(i, 1)[0];
      cur = cur.concat(same(l[0], end) ? l.slice(1) : l.slice().reverse().slice(1));
    }
    if (same(cur[0], cur[cur.length - 1]) && cur.length >= 4) rings.push(cur.slice(0, -1));
  }
  return rings;
}

// ---- convex hull and the minimum-area bounding rectangle (the main axis of a building) ----
export function hull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]); if (p.length < 3) return p;
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && orient(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && orient(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
export function minRect(r) {
  const h = hull(r); let best = { a: 0, area: 1e18, L: 0, W: 0, c: [0, 0] };
  for (let i = 0; i < h.length; i++) {
    const p = h[i], q = h[(i + 1) % h.length], ang = Math.atan2(q[1] - p[1], q[0] - p[0]), cs = Math.cos(ang), sn = Math.sin(ang);
    let u0 = 1e18, u1 = -1e18, v0 = 1e18, v1 = -1e18;
    for (const s of h) { const u = s[0] * cs + s[1] * sn, v = -s[0] * sn + s[1] * cs; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const A = (u1 - u0) * (v1 - v0);
    if (A < best.area) {
      const L = u1 - u0, W = v1 - v0, um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
      best = { area: A, a: L >= W ? ang : ang + Math.PI / 2, L: Math.max(L, W), W: Math.min(L, W), c: [um * cs - vm * sn, um * sn + vm * cs] };
    }
  }
  // the main axis as an angle in (-pi/2, pi/2]
  while (best.a <= -Math.PI / 2) best.a += Math.PI; while (best.a > Math.PI / 2) best.a -= Math.PI;
  return best;
}

// ---- inward offset of a positive ring by a distance per edge (the kerb of a block) ----
// d[i] belongs to the edge r[i] -> r[i+1]. Returns positive simple rings (an offset can split a ring), maybe none.
export function offsetRing(r, d, minArea = 1) {
  let Ls = [];
  for (let i = 0; i < r.length; i++) {
    const p = r[i], q = r[(i + 1) % r.length], dx = q[0] - p[0], dz = q[1] - p[1], l = Math.hypot(dx, dz);
    if (l < 1e-6) continue;
    const tx = dx / l, tz = dz / l;
    Ls.push({ p, tx, tz, d: d[i], px: p[0] - tz * d[i], pz: p[1] + tx * d[i] });
  }
  for (let guard = 0; guard < 5000 && Ls.length >= 3; guard++) {
    const n = Ls.length, VIN = [], VOUT = [];
    for (let i = 0; i < n; i++) {
      const a = Ls[(i + n - 1) % n], b = Ls[i], cr = a.tx * b.tz - a.tz * b.tx, dot = a.tx * b.tx + a.tz * b.tz, c = b.p;
      const ea = [c[0] - a.tz * a.d, c[1] + a.tx * a.d], eb = [c[0] - b.tz * b.d, c[1] + b.tx * b.d];
      // parallel: straight on (a step where the widths differ), or turning right round: the end of a dead-end street (a cap)
      if (Math.abs(cr) < 1e-9) { VIN.push(dot > 0 && Math.abs(a.d - b.d) < 1e-9 ? eb : ea); VOUT.push(eb); continue; }
      const t = ((b.px - a.px) * b.tz - (b.pz - a.pz) * b.tx) / cr, v = [a.px + a.tx * t, a.pz + a.tz * t];
      // a very sharp reflex corner gets a bevel instead of a long spike
      if (cr < 0 && Math.hypot(v[0] - c[0], v[1] - c[1]) > 4 * Math.max(a.d, b.d, 0.5)) { VIN.push(ea); VOUT.push(eb); } else { VIN.push(v); VOUT.push(v); }
    }
    // an edge whose offset runs backwards has vanished: drop its line, its neighbours meet instead
    let bad = -1;
    for (let i = 0; i < n; i++) { const s = VOUT[i], e = VIN[(i + 1) % n]; if ((e[0] - s[0]) * Ls[i].tx + (e[1] - s[1]) * Ls[i].tz < -1e-9) { bad = i; break; } }
    if (bad < 0) {
      const out = []; for (let i = 0; i < n; i++) { out.push(VIN[i]); if (VIN[i] !== VOUT[i]) out.push(VOUT[i]); }
      return untangle(dedupe(out)).filter(x => area(x) >= minArea);
    }
    Ls.splice(bad, 1);
  }
  return [];
}
// split a ring at its self-crossings and keep the positive loops
export function untangle(r, depth = 0) {
  if (r.length < 3) return [];
  if (depth > 60) return isSimple(r) && area(r) > 0 ? [r] : [];
  const h = selfHits(r);
  if (!h.length) return area(r) > 0 ? [r] : [];
  const [i, j] = h[0], n = r.length;
  const a = r[i], b = r[(i + 1) % n], c = r[j], e = r[(j + 1) % n];
  let [t] = segX(a, b, c, e);
  if (t < 0) {
    // touching or overlapping: cut at the shared point (the nearer end) or drop the fold
    if (j === i + 1 || (i === 0 && j === n - 1)) { const k = j === i + 1 ? (i + 1) % n : 0; const o = r.slice(); o.splice(k, 1); return untangle(o, depth + 1); }
    t = 0.5;
  }
  const X = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const A = [X, ...r.slice(i + 1, j + 1)], B = [X, ...r.slice(j + 1), ...r.slice(0, i + 1)];
  return [...untangle(dedupe(A), depth + 1), ...untangle(dedupe(B), depth + 1)];
}

// ---- rasters (the lots, the plazas) ----
export class Grid {
  constructor(x0, z0, x1, z1, cs) { this.x0 = x0; this.z0 = z0; this.cs = cs; this.W = Math.ceil((x1 - x0) / cs); this.H = Math.ceil((z1 - z0) / cs); this.a = new Uint8Array(this.W * this.H); }
  // set every cell whose centre is inside the ring (op: 'set' v, 'and', 'clear')
  fill(r, v = 1) {
    const b = box(r), j0 = Math.max(0, Math.floor((b[1] - this.z0) / this.cs)), j1 = Math.min(this.H - 1, Math.ceil((b[3] - this.z0) / this.cs));
    for (let j = j0; j <= j1; j++) {
      const z = this.z0 + (j + 0.5) * this.cs, xs = [];
      for (let i = 0, n = r.length, k = n - 1; i < n; k = i++) { const p = r[i], q = r[k]; if ((p[1] > z) !== (q[1] > z)) xs.push(p[0] + (q[0] - p[0]) * (z - p[1]) / (q[1] - p[1])); }
      xs.sort((u, w) => u - w);
      for (let m = 0; m + 1 < xs.length; m += 2) {
        const i0 = Math.max(0, Math.ceil((xs[m] - this.x0) / this.cs - 0.5)), i1 = Math.min(this.W - 1, Math.floor((xs[m + 1] - this.x0) / this.cs - 0.5));
        for (let i = i0; i <= i1; i++) this.a[j * this.W + i] = v;
      }
    }
  }
  // cells within d of a polyline get v (a thick line)
  stroke(pts, d, v = 1) {
    const b = box(pts), cs = this.cs;
    const i0 = Math.max(0, Math.floor((b[0] - d - this.x0) / cs)), i1 = Math.min(this.W - 1, Math.ceil((b[2] + d - this.x0) / cs));
    const j0 = Math.max(0, Math.floor((b[1] - d - this.z0) / cs)), j1 = Math.min(this.H - 1, Math.ceil((b[3] + d - this.z0) / cs));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = this.x0 + (i + 0.5) * cs, z = this.z0 + (j + 0.5) * cs;
      if (distPoly2(pts, x, z, false) <= d * d) this.a[j * this.W + i] = v;
    }
  }
  // grow the cells with value v by r cells (square)
  dilate(r, v = 1) {
    const { W, H } = this, src = this.a.slice();
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) if (src[j * W + i] === v) {
      for (let y = Math.max(0, j - r); y <= Math.min(H - 1, j + r); y++) for (let x = Math.max(0, i - r); x <= Math.min(W - 1, i + r); x++) this.a[y * W + x] = v;
    }
  }
  // the outlines of the cells with value 1, as rings in world units (positive outers, negative holes)
  trace() {
    const { W, H, cs, x0, z0 } = this, at = (i, j) => i >= 0 && j >= 0 && i < W && j < H && this.a[j * W + i] === 1;
    const out = new Map(), K = (i, j) => j * (W + 1) + i, edges = [];
    const add = (ai, aj, bi, bj) => { const e = { a: [ai, aj], b: [bi, bj], used: false }; edges.push(e); const k = K(ai, aj); (out.get(k) || out.set(k, []).get(k)).push(e); };
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) if (at(i, j)) {
      if (!at(i, j - 1)) add(i, j, i + 1, j);
      if (!at(i + 1, j)) add(i + 1, j, i + 1, j + 1);
      if (!at(i, j + 1)) add(i + 1, j + 1, i, j + 1);
      if (!at(i - 1, j)) add(i, j + 1, i, j);
    }
    const rings = [];
    for (const e0 of edges) {
      if (e0.used) continue;
      const ring = []; let e = e0;
      while (e && !e.used) {
        e.used = true; ring.push(e.a);
        const cand = (out.get(K(e.b[0], e.b[1])) || []).filter(f => !f.used);
        if (cand.length <= 1) { e = cand[0]; continue; }
        // a saddle: take the left turn so that cells touching at a corner stay apart
        const dx = e.b[0] - e.a[0], dz = e.b[1] - e.a[1];
        e = cand.find(f => { const fx = f.b[0] - f.a[0], fz = f.b[1] - f.a[1]; return dx * fz - dz * fx > 0; }) || cand[0];
      }
      rings.push(dropCollinear(ring.map(([i, j]) => [x0 + i * cs, z0 + j * cs])));
    }
    return rings;
  }
}
// the biggest axis-aligned rectangle of cells == 1 (both sides >= minSide cells), scored by area with the long side capped at
// `aspect` times the short one (a long thin strip is of no use for a building site). Returns [i0, j0, i1, j1] (exclusive) or null.
export function maxRect(g, minSide, aspect = 4) {
  const { W, H } = g, h = new Int32Array(W);
  let best = null, bs = 0;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) h[i] = g.a[j * W + i] === 1 ? h[i] + 1 : 0;
    const st = [];
    for (let i = 0; i <= W; i++) {
      const cur = i < W ? h[i] : 0;
      let start = i;
      while (st.length && st[st.length - 1][1] >= cur) {
        const [s, hh] = st.pop(), w = i - s;
        if (hh >= minSide && w >= minSide) {
          const sh = Math.min(w, hh), lg = Math.min(Math.max(w, hh), sh * aspect), sc = sh * lg;
          if (sc > bs) {
            bs = sc;
            // cap the long side: keep the middle part
            let ww = w, hh2 = hh; if (w > hh * aspect) ww = Math.floor(hh * aspect); if (hh > w * aspect) hh2 = Math.floor(w * aspect);
            const i0 = s + ((w - ww) >> 1), j1 = j + 1 - ((hh - hh2) >> 1);
            best = [i0, j1 - hh2, i0 + ww, j1];
          }
        }
        start = s;
      }
      st.push([start, cur]);
    }
  }
  return best;
}

// ---- polylines ----
// cut a polyline by an axis-aligned rectangle: the inside pieces, with flags telling which end lies on the rectangle's edge
export function clipLine(pts, x0, z0, x1, z1) {
  const ins = p => p[0] >= x0 && p[0] <= x1 && p[1] >= z0 && p[1] <= z1, out = [];
  let cur = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    let a = pts[i], b = pts[i + 1], t0 = 0, t1 = 1;
    const dx = b[0] - a[0], dz = b[1] - a[1];
    let ok = true;
    for (const [p, q] of [[-dx, a[0] - x0], [dx, x1 - a[0]], [-dz, a[1] - z0], [dz, z1 - a[1]]]) {
      if (Math.abs(p) < 1e-15) { if (q < 0) { ok = false; break; } continue; }
      const t = q / p; if (p < 0) { if (t > t1) { ok = false; break; } if (t > t0) t0 = t; } else { if (t < t0) { ok = false; break; } if (t < t1) t1 = t; }
    }
    if (!ok) { if (cur) { out.push(cur); cur = null; } continue; }
    const A = [a[0] + dx * t0, a[1] + dz * t0], B = [a[0] + dx * t1, a[1] + dz * t1];
    if (!cur) cur = { pts: [A], ia: i === 0 && t0 === 0 ? 0 : 1, ib: 0, first: i, a0: t0 > 0 || !ins(a) };
    cur.pts.push(B);
    if (t1 < 1) { cur.b1 = true; out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out.map(c => ({ pts: dedupe(c.pts, 1e-9, false), aEdge: !!c.a0, bEdge: !!c.b1 }));
}
export function resample(pts, step) {
  const out = [pts[0]]; let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let s = step - acc;
    while (s <= l) { out.push([a[0] + (b[0] - a[0]) * s / l, a[1] + (b[1] - a[1]) * s / l]); s += step; }
    acc = (acc + l) % step;
  }
  return out;
}
