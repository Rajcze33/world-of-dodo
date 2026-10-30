// World of DODO: the life of the city, run here so that every player sees the same one: 33 cars (the last three
// are police), the tram, 50 pedestrians, and the trees and lamps knocked down.
//
// It is a port of the traffic, tram and pedestrian code of client/index.html, where the original game ran it in the
// browser for one player. What changes is what cannot be shared: the cars give way to every tank (the players' and the
// bots') instead of to one van, and nothing shoves them, because a car pushed on one screen would be somewhere else on
// the others; a tank meets a car like a wall. Parked cars stay where they are (the clients place them alike, from the
// city's seed). A car that a tank keeps blocking turns back after a while.
//
// Pedestrians walk their loops here; a client that hits one with its tank or its own parcel reports it, and the fall
// happens here, for everyone. Knocked-down trees and lamps are only remembered and passed on, and stand up again
// after PROP_BACK_MS.
'use strict';

const THREE = require('../client/vendor/three.r128.min.js');   // only for the tram's curve, so its track matches the client's
const { roadC, blockC, TRAM_K, DEPOT_PARK, freeAt } = require('./city');

// ---------- traffic (client: "moving traffic") ----------
const LANE = 2.6, JT = 9, N_CARS = 33, VMAX_CAR = 9;
const TANK_BLOCK_T = 5;                     // seconds a tank may stand in a car's way before the car turns back
const nodeP = (i, j) => [roadC(i), roadC(j)];
const nbrs = (i, j) => [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]].filter(([a, b]) => a >= 0 && a <= 6 && b >= 0 && b <= 6);
const unit = (a, b) => { const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1; return [dx / l, dz / l]; };
const rightOf = d => [-d[1], d[0]];
function bez(a, c, b, t) { const s = 1 - t; return [s * s * a[0] + 2 * s * t * c[0] + t * t * b[0], s * s * a[1] + 2 * s * t * c[1] + t * t * b[1]]; }
function bezD(a, c, b, t) { return unit([0, 0], [2 * (1 - t) * (c[0] - a[0]) + 2 * t * (b[0] - c[0]), 2 * (1 - t) * (c[1] - a[1]) + 2 * t * (b[1] - c[1])]); }

const CARS = [];
function startEdge(c) {
  const f = nodeP(...c.from), t = nodeP(...c.to);
  c.dir = unit(f, t); c.S = [f[0] + c.dir[0] * JT, f[1] + c.dir[1] * JT]; c.E = [t[0] - c.dir[0] * JT, t[1] - c.dir[1] * JT];
  c.len = Math.hypot(c.E[0] - c.S[0], c.E[1] - c.S[1]); c.phase = 'edge'; c.u = 0;
}
// prefer going straight a bit more often, like real traffic
function pickExit(c) {
  const opts = nbrs(...c.to).filter(([a, b]) => a !== c.from[0] || b !== c.from[1]);
  let n = opts[(Math.random() * opts.length) | 0];
  const st = opts.find(([a, b]) => a - c.to[0] === c.to[0] - c.from[0] && b - c.to[1] === c.to[1] - c.from[1]);
  if (st && Math.random() < 0.35) n = st;
  return n;
}
// junction right of way: a car enters only when no car already in that junction crosses its path
function turnKind(dir, node, n) {
  const d2 = unit(nodeP(...node), nodeP(...n)), r = rightOf(dir);
  return d2[0] * dir[0] + d2[1] * dir[1] > 0.5 ? 'S' : d2[0] * r[0] + d2[1] * r[1] > 0.5 ? 'R' : 'L';
}
function junctionBusy(c) {
  const kc = turnKind(c.dir, c.to, c.plan);
  for (const o of CARS) {
    if (o === c || o.phase !== 'turn' || o.to[0] !== c.to[0] || o.to[1] !== c.to[1]) continue;
    if (o.next[0] === c.plan[0] && o.next[1] === c.plan[1]) return true;
    const ko = turnKind(o.dir, o.to, o.next);
    if (kc === 'R' || ko === 'R') continue;
    if (kc === 'S' && ko === 'S' && o.dir[0] * c.dir[0] + o.dir[1] * c.dir[1] < -0.5) continue;
    return true;
  }
  return false;
}
function startTurn(c) {
  const n = c.plan || pickExit(c); c.plan = null;
  const t = nodeP(...c.to), d2 = unit(t, nodeP(...n));
  c.A = [t[0] - c.dir[0] * JT, t[1] - c.dir[1] * JT]; c.C = t; c.B = [t[0] + d2[0] * JT, t[1] + d2[1] * JT];
  let L = 0, p = c.A;
  for (let k = 1; k <= 8; k++) { const q = bez(c.A, c.C, c.B, k / 8); L += Math.hypot(q[0] - p[0], q[1] - p[1]); p = q; }
  c.len = L; c.u = 0; c.phase = 'turn'; c.next = n;
}
function placeCar(c) {
  let p, d;
  if (c.phase === 'edge') { const k = c.u / c.len; p = [c.S[0] + (c.E[0] - c.S[0]) * k, c.S[1] + (c.E[1] - c.S[1]) * k]; d = c.dir; }
  else { const k = Math.min(1, c.u / c.len); p = bez(c.A, c.C, c.B, k); d = bezD(c.A, c.C, c.B, k); }
  const r = rightOf(d); c.x = p[0] + r[0] * LANE; c.z = p[1] + r[1] * LANE; c.hx = d[0]; c.hz = d[1];
}
// where will car c be after driving du further along its real route (edge → junction turn → next street)?
function pathAt(c, du) {
  let u = c.u + du, p, d;
  const turnPt = (A, C, B, L, uu, d2) => uu <= L ? [bez(A, C, B, uu / L), bezD(A, C, B, uu / L)] : [[B[0] + d2[0] * (uu - L), B[1] + d2[1] * (uu - L)], d2];
  if (c.phase === 'edge') {
    if (u <= c.len) { p = [c.S[0] + c.dir[0] * u, c.S[1] + c.dir[1] * u]; d = c.dir; }
    else if (!c.plan) { u -= c.len; p = [c.E[0] + c.dir[0] * u, c.E[1] + c.dir[1] * u]; d = c.dir; }
    else {
      u -= c.len;
      const t = nodeP(...c.to), d2 = unit(t, nodeP(...c.plan)), B = [t[0] + d2[0] * JT, t[1] + d2[1] * JT], st = d2[0] * c.dir[0] + d2[1] * c.dir[1] > 0.5;
      [p, d] = turnPt(c.E, t, B, st ? 18 : 14.6, u, d2);
    }
  } else { const d2 = unit(c.C, c.B); [p, d] = turnPt(c.A, c.C, c.B, c.len, u, d2); }
  const r = rightOf(d); return [p[0] + r[0] * LANE, p[1] + r[1] * LANE, d[0], d[1]];
}
// will this vehicle (following its route at speed sp) and any tank (on its heading and speed) meet within T seconds?
// If so, the vehicle gives way: tanks always have right of way. A tank following right behind it in the same direction is left alone.
function tankConflict(pos, sp, offs, T, R, tanks) {
  const p0 = pos(0), near = [];
  for (const k of tanks) {
    if (Math.abs(k.x - p0[0]) > 80 || Math.abs(k.z - p0[1]) > 80) continue;
    const vhx = Math.sin(k.h), vhz = Math.cos(k.h);
    if ((k.x - p0[0]) * p0[2] + (k.z - p0[1]) * p0[3] < -1.5 && vhx * p0[2] + vhz * p0[3] > 0.7) continue;
    near.push({ x: k.x, z: k.z, vx: vhx * k.v, vz: vhz * k.v, fx: vhx * 1.55, fz: vhz * 1.55 });
  }
  if (!near.length) return false;
  for (let t = 0; t <= T; t += 0.2) {
    const q = pos(sp * t);
    for (const k of near) {
      const px = k.x + k.vx * t, pz = k.z + k.vz * t;
      for (const a of offs) for (const b of [-1, 0, 1]) if (Math.hypot(q[0] + q[2] * a - px - k.fx * b, q[1] + q[3] * a - pz - k.fz * b) < R) return true;
    }
  }
  return false;
}
// is point (x,z) in the strip right in front of car c? (forward 0..fa, sideways ±fl): oncoming cars in the other lane don't count
function ahead(c, x, z, fa, fl) {
  const wx = x - c.x, wz = z - c.z;
  if (Math.abs(wx) > fa + 3 || Math.abs(wz) > fa + 3) return false;
  const a = wx * c.hx + wz * c.hz;
  if (a <= 0.3 || a > fa) return false;
  return Math.abs(wx * c.hz - wz * c.hx) < fl;
}
const tankAhead = (c, k) => {
  const fx = Math.sin(k.h) * 1.55, fz = Math.cos(k.h) * 1.55;
  return ahead(c, k.x, k.z, 9, 2.6) || ahead(c, k.x + fx, k.z + fz, 9, 2.6) || ahead(c, k.x - fx, k.z - fz, 9, 2.6);
};

function stepTraffic(dt, tanks) {
  const VMAX = VMAX_CAR;
  for (const c of CARS) {
    let target = VMAX, byCar = false, byTank = false;
    if (c.ghost > 0) c.ghost -= dt;
    // keep distance to whatever is ahead: other cars, the tanks, the tram
    for (const o of CARS) {
      if (o === c || (c.phase === 'turn' && o.waitJ)) continue;
      if (!(ahead(c, o.x, o.z, 8, 2.1) || ahead(c, o.x - o.hx * 1.9, o.z - o.hz * 1.9, 8, 2.1) || ahead(c, o.x + o.hx * 1.9, o.z + o.hz * 1.9, 8, 2.1))) continue;
      // a car resolving a deadlock passes crossing cars, but never drives into the car ahead in its own lane
      if (c.ghost > 0 && o.hx * c.hx + o.hz * c.hz < 0.7) continue;
      target = 0; byCar = true;
    }
    // give way to the tanks early: 'if I keep my speed' and 'if I speed up', and keep yielding a moment so the car doesn't creep into them
    {
      const pos = du => pathAt(c, du), O = [-1.4, 0, 1.4];
      if (c.phase === 'edge') { if (tankConflict(pos, VMAX, O, 2.6, 2.6, tanks) || tankConflict(pos, Math.max(c.v, 3), O, 2.6, 2.6, tanks)) c.yieldT = 0.6; }
      // already inside the junction: clear it if that avoids the tank, stop only if stopping is the safe option
      else if (tankConflict(pos, Math.max(c.v, 6), O, 2.6, 2.6, tanks)) { if (!tankConflict(pos, 0, O, 2.6, 2.6, tanks)) c.yieldT = 0.6; else { c.yieldT = 0; c.hurry = 0.8; } }
    }
    if (c.hurry > 0) { c.hurry -= dt; c.yieldT = 0; }
    if (c.yieldT > 0) { c.yieldT -= dt; target = 0; }
    for (const k of tanks) if (tankAhead(c, k)) { target = 0; byTank = true; }
    // behind the tram in its lane (a car already inside a junction is committed and drives on: the tram waits for it)
    if (c.phase === 'edge') for (const p of TRAM.pts) if (ahead(c, p[0], p[1], 9, 2.2)) target = 0;
    // entering or crossing the avenue (anything but going straight on / turning right off it): give way to the tram
    if (c.phase === 'edge' && c.to[1] === TRAM_K && c.len - c.u < 6 && c.plan) {
      const k = turnKind(c.dir, c.to, c.plan);
      if (!(c.from[1] === TRAM_K && k !== 'L')) { const t = nodeP(...c.to); if (tramNear(t[0], t[1], 22)) target = 0; }
    }
    // approaching a junction: slow down and wait if a crossing car is inside it
    c.waitJ = false;
    if (c.phase === 'edge' && !c.plan && c.len - c.u < 30) c.plan = pickExit(c);
    if (c.phase === 'edge' && c.len - c.u < 8) {
      if (!c.plan) c.plan = pickExit(c);
      if (junctionBusy(c)) { c.waitJ = true; target = Math.min(target, Math.sqrt(2 * 12 * Math.max(0, c.len - c.u - 0.3))); }
    }
    // two cars waiting for each other inside a junction: after a moment one of them simply goes
    if (byCar && c.v < 0.5) {
      c.stuck += dt;
      if (c.stuck > 4 + (c.id % 4) * 0.5 && !CARS.some(o => o !== c && o.ghost > 0 && Math.abs(o.x - c.x) < 16 && Math.abs(o.z - c.z) < 16)) { c.ghost = 1.6; c.stuck = 0; }
    } else c.stuck = 0;
    // a tank parked in the way: after a while the car turns back down its street (it switches to the other lane)
    if (byTank && c.v < 0.5 && c.phase === 'edge') {
      c.tankT += dt;
      if (c.tankT > TANK_BLOCK_T) { const u = c.u; [c.from, c.to] = [c.to, c.from]; startEdge(c); c.u = Math.max(0, c.len - u); c.plan = null; c.tankT = 0; }
    } else c.tankT = 0;
    c.v += Math.max(-14 * dt, Math.min(6 * dt, target - c.v));
    if (c.phase === 'turn' && c.v > 6 && !(c.hurry > 0)) c.v = Math.max(6, c.v - 10 * dt);   // slow down in turns
    c.u += c.v * dt;
    if (c.waitJ && c.u >= c.len) { c.u = c.len - 0.01; c.v = 0; }
    if (c.u >= c.len) { const over = c.u - c.len; if (c.phase === 'edge') startTurn(c); else { c.from = c.to; c.to = c.next; startEdge(c); } c.u = over; }
    if (c.u < 0) c.u = 0;
    placeCar(c);
  }
}

// ---------- tram (client: "tram") ----------
const TRAM_L = 8.6, TRAM_GAP = 0.7, TRAM_VMAX = 8, TRAM_N = 3;
const TRAM = { s: 0, v: TRAM_VMAX, hold: 0, dwell: 0, atStop: -1, yieldT: 0, vag: [], pts: [] };
const TRAM_PATH = (() => {
  const z0 = roadC(TRAM_K), P = [], a = 2.2, loop = [[162, 2.6], [170, 5], [177, 9.5], [185, 11], [192, 8], [195, 0], [192, -8], [185, -11], [177, -9.5], [170, -5], [162, -2.6]];
  for (let x = -150; x <= 150; x += 25) P.push([x, z0 + a]);
  loop.forEach(([x, z]) => P.push([x, z0 + z]));
  for (let x = 150; x >= -150; x -= 25) P.push([x, z0 - a]);
  loop.forEach(([x, z]) => P.push([-x, z0 - z]));
  const curve = new THREE.CatmullRomCurve3(P.map(p => new THREE.Vector3(p[0], 0, p[1])), true, 'centripetal');
  const N = 1600, pts = curve.getSpacedPoints(N).map(v => [v.x, v.z]); pts.pop();
  return { pts, N: pts.length, len: curve.getLength() };
})();
function tramAt(s) {
  const L = TRAM_PATH.len; s = ((s % L) + L) % L;
  const f = s / L * TRAM_PATH.N, i = Math.floor(f), t = f - i, a = TRAM_PATH.pts[i % TRAM_PATH.N], b = TRAM_PATH.pts[(i + 1) % TRAM_PATH.N];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
// stops: tram centred on the shelter (north side = eastbound, south side = westbound)
const TRAM_STOPS = (() => {
  const z0 = roadC(TRAM_K), res = [];
  for (const [x, z, dx] of [[26, z0 + 2.2, 1], [-26, z0 - 2.2, -1]]) {
    let best = 0, bd = 1e9;
    TRAM_PATH.pts.forEach((p, i) => { const q = TRAM_PATH.pts[(i + 1) % TRAM_PATH.N]; if ((q[0] - p[0]) * dx <= 0) return; const d = Math.hypot(p[0] - x, p[1] - z); if (d < bd) { bd = d; best = i; } });
    res.push(best / TRAM_PATH.N * TRAM_PATH.len + (TRAM_N * TRAM_L + (TRAM_N - 1) * TRAM_GAP) / 2);
  }
  return res;
})();
function placeTram() {
  TRAM.pts.length = 0; TRAM.vag.length = 0;
  for (let k = 0; k < TRAM_N; k++) {
    const c = TRAM.s - k * (TRAM_L + TRAM_GAP) - TRAM_L / 2, f = tramAt(c + TRAM_L * 0.35), r = tramAt(c - TRAM_L * 0.35), d = unit(r, f);
    const v = { x: (f[0] + r[0]) / 2, z: (f[1] + r[1]) / 2, hx: d[0], hz: d[1] };
    TRAM.vag.push(v);
    for (const a of [-0.5, 0, 0.5]) TRAM.pts.push([v.x + d[0] * TRAM_L * a, v.z + d[1] * TRAM_L * a]);
  }
}
const tramNear = (x, z, r) => TRAM.pts.some(p => Math.abs(p[0] - x) < r && Math.abs(p[1] - z) < r);
function stepTram(dt, tanks) {
  let target = TRAM_VMAX;
  const f = TRAM.vag[0], fx = f.x + f.hx * TRAM_L / 2, fz = f.z + f.hz * TRAM_L / 2;
  // wait for anything on the track in front: a tank or a car
  const inFront = (x, z) => { const wx = x - fx, wz = z - fz, a = wx * f.hx + wz * f.hz, l = Math.abs(wx * f.hz - wz * f.hx); return a > -1 && a < 11 && l < 2.5; };
  for (const k of tanks) {
    const vx = Math.sin(k.h) * 1.55, vz = Math.cos(k.h) * 1.55;
    if (inFront(k.x, k.z) || inFront(k.x + vx, k.z + vz) || inFront(k.x - vx, k.z - vz)) target = 0;
  }
  {
    const pos = ds => { const a = tramAt(TRAM.s + ds), b = tramAt(TRAM.s + ds - 1), d = unit(b, a); return [a[0], a[1], d[0], d[1]]; };
    const O = [0, -TRAM_L * 0.25, -TRAM_L / 2];
    if (tankConflict(pos, TRAM_VMAX, O, 3.5, 2.9, tanks) || tankConflict(pos, Math.max(TRAM.v, 2), O, 3.5, 2.9, tanks)) TRAM.yieldT = 0.8;
  }
  if (TRAM.yieldT > 0) { TRAM.yieldT -= dt; target = 0; }
  for (const c of CARS) {
    if (Math.abs(c.x - fx) > 14 || Math.abs(c.z - fz) > 14) continue;
    if (inFront(c.x, c.z) || inFront(c.x + c.hx * 1.9, c.z + c.hz * 1.9) || inFront(c.x - c.hx * 1.9, c.z - c.hz * 1.9)) target = 0;
  }
  // stop at the shelters
  const Lp = TRAM_PATH.len;
  if (TRAM.dwell > 0) { TRAM.dwell -= dt; target = 0; }
  else TRAM_STOPS.forEach((S, i) => {
    const ds = ((S - TRAM.s) % Lp + Lp) % Lp;
    if (ds < 40 && TRAM.atStop !== i) { target = Math.min(target, Math.sqrt(2 * 2.2 * ds) + 0.3); if (ds < 0.4) { TRAM.dwell = 6; TRAM.atStop = i; } }
  });
  TRAM.v += Math.max(-(TRAM.yieldT > 0 ? 14 : 10) * dt, Math.min(2.5 * dt, target - TRAM.v)); if (TRAM.v < 0) TRAM.v = 0;
  TRAM.s = (TRAM.s + TRAM.v * dt) % Lp;
  if (TRAM.atStop >= 0 && TRAM.dwell <= 0) { const ds = ((TRAM.s - TRAM_STOPS[TRAM.atStop]) % Lp + Lp) % Lp; if (ds > 5 && ds < Lp - 50) TRAM.atStop = -1; }
  placeTram();
}

// spread the cars over the grid: never near the depot, never on top of each other or the tram
function seedTraffic() {
  const used = new Set();
  let placed = 0, tries = 0;
  while (placed < N_CARS && tries < 8000) {
    tries++;
    const i = (Math.random() * 7) | 0, j = (Math.random() * 7) | 0, ns = nbrs(i, j), n = ns[(Math.random() * ns.length) | 0], key = [i, j, n].join();
    if (used.has(key)) continue;
    const c = CARS[placed]; c.from = [i, j]; c.to = n; startEdge(c); c.u = c.len * (0.15 + Math.random() * 0.7); placeCar(c);
    if (Math.hypot(c.x - DEPOT_PARK[0], c.z - DEPOT_PARK[1]) < 50) continue;
    if (CARS.slice(0, placed).some(o => Math.hypot(o.x - c.x, o.z - c.z) < 16)) continue;
    if (tramNear(c.x, c.z, 18)) continue;
    used.add(key);
    Object.assign(c, { v: VMAX_CAR * 0.7, yieldT: 0, hurry: 0, hold: 0, stuck: 0, ghost: 0, tankT: 0, plan: null, waitJ: false });
    placed++;
  }
}

// ---------- pedestrians (client: "pedestrians") ----------
const PED_N = 50, PED_HW = 17.2, PED_RC = 3.0, PED_L = 2 * (PED_HW - PED_RC), PED_A = Math.PI / 2 * PED_RC, PED_SEG = PED_L + PED_A;
const PEDS = [];
// position and walking direction at distance s along the pavement loop around block (bx,bz)
function pedRing(bx, bz, s) {
  const P = 4 * PED_SEG; s = ((s % P) + P) % P;
  const k = Math.floor(s / PED_SEG), u = s - k * PED_SEG, hw = PED_HW, rc = PED_RC, q = hw - rc;
  let x, z, dx, dz;
  if (u < PED_L) {
    if (k === 0) { x = hw; z = -q + u; dx = 0; dz = 1; } else if (k === 1) { x = q - u; z = hw; dx = -1; dz = 0; }
    else if (k === 2) { x = -hw; z = q - u; dx = 0; dz = -1; } else { x = -q + u; z = -hw; dx = 1; dz = 0; }
  } else {
    const ph = k * Math.PI / 2 + (u - PED_L) / rc, cx = (k === 0 || k === 3) ? q : -q, cz = (k === 0 || k === 1) ? q : -q;
    x = cx + rc * Math.cos(ph); z = cz + rc * Math.sin(ph); dx = -Math.sin(ph); dz = Math.cos(ph);
  }
  return [bx + x, bz + z, dx, dz];
}
const pedEase = t => t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t);
function initPeds() {
  for (let k = 0; k < PED_N; k++) {
    const i = k < 36 ? k % 6 : (Math.random() * 6) | 0, j = k < 36 ? (k / 6) | 0 : (Math.random() * 6) | 0;
    const p = { id: k, bx: blockC(i), bz: blockC(j), s: Math.random() * 4 * PED_SEG, dsg: Math.random() < 0.5 ? 1 : -1, speed: 1.0 + Math.random() * 0.8,
      state: 'walk', t: 0, th: 0, fx: 0, fz: 1, ox: 0, oz: 0, vx: 0, vz: 0, h: 0, x: 0, z: 0, timer: 3 };
    const r = pedRing(p.bx, p.bz, p.s); p.x = r[0]; p.z = r[1]; p.h = Math.atan2(r[2] * p.dsg, r[3] * p.dsg);
    PEDS.push(p);
  }
}
// a hit sends a pedestrian sliding and tipping over away from the impact; a few seconds later they get up and walk on
function knockPed(p, vx, vz) {
  if (p.state !== 'walk') return false;
  const l = Math.hypot(vx, vz) || 1, sp = Math.min(8, l * 0.5);
  p.fx = vx / l; p.fz = vz / l; p.vx = p.fx * sp; p.vz = p.fz * sp; p.state = 'fall'; p.t = 0; p.th = 0.001; p.timer = 2.5 + Math.random() * 2;
  return true;
}
function stepPeds(dt) {
  for (const p of PEDS) {
    if (p.state === 'walk') {
      p.s += p.dsg * p.speed * dt;
      const r = pedRing(p.bx, p.bz, p.s), f = Math.exp(-3 * dt);
      p.h = Math.atan2(r[2] * p.dsg, r[3] * p.dsg); p.ox *= f; p.oz *= f; p.x = r[0] + p.ox; p.z = r[1] + p.oz;
    } else {
      p.t += dt;
      const nx = p.ox + p.vx * dt, nz = p.oz + p.vz * dt, r = pedRing(p.bx, p.bz, p.s);
      if (freeAt(r[0] + nx, r[1] + nz, 0.3)) { p.ox = nx; p.oz = nz; } else p.vx = p.vz = 0;   // slides, but not into a building
      const d = Math.exp(-4 * dt); p.vx *= d; p.vz *= d; p.x = r[0] + p.ox; p.z = r[1] + p.oz;
      if (p.state === 'fall') { p.th = pedEase(p.t / 0.4) * 1.45; if (p.t >= 0.4) { p.state = 'down'; p.t = 0; } }
      else if (p.state === 'down') { if (p.t >= p.timer) { p.state = 'rise'; p.t = 0; } }
      else if (p.state === 'rise') { p.th = 1.45 * (1 - pedEase(p.t / 0.7)); if (p.t >= 0.7) { p.state = 'walk'; p.th = 0; } }
    }
  }
}

// ---------- trees and lamps knocked down ----------
const PROP_BACK_MS = 90000;
const PROPS_DOWN = new Map();               // prop index -> { fx, fz, t }

// ---------- the world ----------
function init() {
  for (let k = 0; k < N_CARS; k++) { const c = { id: k, from: [0, 0], to: [1, 0], v: VMAX_CAR, hold: 0, stuck: 0, ghost: 0, tankT: 0 }; startEdge(c); CARS.push(c); }
  TRAM.s = TRAM_STOPS[1] - 60; placeTram();
  seedTraffic();
  initPeds();
}

// one step; tanks: every tank in the city as { x, z, h, v }. Returns the props that stand up again now (their indexes).
function step(dt, tanks) {
  stepTram(dt, tanks);
  stepTraffic(dt, tanks);
  stepPeds(dt);
  const up = [], now = Date.now();
  for (const [i, d] of PROPS_DOWN) if (now - d.t > PROP_BACK_MS) { PROPS_DOWN.delete(i); up.push(i); }
  return up;
}

const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;
// the snapshot for the clients: c = cars as x, z, heading, speed; m = the tram's place on its track; p = pedestrians as
// x, z, heading, tilt, fall direction (flat arrays, in the order of the client's TRAFFIC and PEDS)
function snapshot() {
  const c = [], p = [];
  for (const k of CARS) c.push(r2(k.x), r2(k.z), r2(Math.atan2(k.hx, k.hz)), r1(k.v));
  for (const q of PEDS) p.push(r1(q.x), r1(q.z), r2(q.h), r2(q.th), q.th > 0 ? r2(Math.atan2(q.fx, q.fz)) : 0);
  return { t: 'w', c, m: r2(TRAM.s), p };
}

// a player reports a pedestrian their tank or their parcel hit; only one near that player counts
function hitPed(i, vx, vz, from) {
  const p = PEDS[i];
  if (!p || (from && Math.hypot(p.x - from.x, p.z - from.z) > 80)) return false;
  return knockPed(p, vx, vz);
}
// a player knocked a tree or a lamp down: remembered until it stands up again; false if it is down already
function propDown(i, fx, fz) {
  if (PROPS_DOWN.has(i) || PROPS_DOWN.size >= 1000) return false;
  PROPS_DOWN.set(i, { fx, fz, t: Date.now() });
  return true;
}
const propsDown = () => [...PROPS_DOWN].map(([i, d]) => [i, d.fx, d.fz]);

init();
module.exports = { step, snapshot, hitPed, propDown, propsDown, N_CARS, PED_N };
