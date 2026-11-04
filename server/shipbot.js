// World of DODO, issue #24: the ship bots. A bot sails the players' destroyer (client/src/game/ship.ts): the same engine telegraph
// (TEL), speed that follows it slowly, rudder that takes RUD_T to go hard over, turn by speed, heel and pitch, the same collisions with
// the banks and the bridge piers (client/shared/naval.ts waterPush, three circles along its axis) and the other ships; the same weapons
// with the same numbers: two twin turrets that traverse within their arcs and fire two shells a salvo (with the game's dispersion), the
// torpedo tubes either side, the anti-aircraft guns. Only the helm, the aim and the trigger are the bot's.
//
// What it does: it sails for the river zone (client/shared/rules.ts ZONES, the Vltava) along the river, by a flow field computed once
// below (on a FC-unit grid of the water a ship fits in, the way to the zone from every cell), and once there it holds the zone, circling
// inside it. On the way and in the zone it fights: its turrets take the nearest enemy ship within SEA_R (leading it by the shells' flight,
// with an error that shrinks as it ranges in: the first salvos fall wide), else an enemy supply depot within DEPOT_R; it launches its
// torpedoes at an enemy ship within TORP_R whose intercept course lies within the tubes' arc on a clear run of water; its anti-aircraft
// guns fire bursts at an enemy plane within AA_R in sight. It feels ahead for the banks and backs off when it is stuck. Sunk (server/
// bots.js hitBot), it lists and goes down like a player's ship, and comes back at one of its team's spawn points on the river.
'use strict';

const { segHit } = require('./city');
const N = require('../client/shared/naval.ts');
const { ZONES, DEPOTS, TEAM_SHIP_SPAWNS } = require('../client/shared/rules.ts');

const { WATER_Y } = N;
// the ship, as client/src/game/ship.ts: top speed, how fast the speed follows the telegraph, its steps (astern, stop, 1/3, 2/3, full),
// rudder time, the tightest turn's radius, the turn's lag, heel, the speed a hard turn bleeds; the collision circles
const V_MAX = 13, ACC = 1.7, DEC = 2.3, TEL = [-0.25, 0, 1 / 3, 2 / 3, 1], RUD_T = 1.5, TURN_R = 22.5, YAW_T = 0.9, HEEL = 0.17, TURN_SLOW = 0.15;
const SHIP_C = [-7.5, 0, 7.5], SHIP_CR = 2.6;
// the turrets (where along the axis, their ring's height, their rest), their arc, traverse, on-target margin, reload, the guns' pivot
// and length, the dispersion; the torpedoes (reload, spread, the tubes' arc, where the tubes are); the anti-aircraft guns
const TURRETS = [{ z: 5.8, y: 1.24, rest: 0 }, { z: -8.3, y: 1.02, rest: Math.PI }];
const ARC = 150 * Math.PI / 180, TRAV = 40 * Math.PI / 180, ALIGN = 0.03, RELOAD = 6, GUN_Y = 0.62, GUN_L = 2.6, DISP = 0.025;
const TORP_RELOAD = 25, TORP_SPREAD = 8 * Math.PI / 180, TUBE_ARC0 = 30 * Math.PI / 180, TUBE_ARC1 = 150 * Math.PI / 180, TUBE_Z = -4.4, TUBE_X = 1.35;
const AA_RATE = 1 / 10, AA_R = 150, AA_ERR = 0.03, AA_X = 1.55, AA_Y = 2.6, AA_Z = -0.6;
// a shell's muzzle speed and gravity (game/shells.ts), a torpedo's speed, a bullet's, how long a sinking takes (game/tank.ts SINK_T)
const SHELL_V = 110, SHELL_G = 38, TORP_V = 22, BUL_V = 170, SINK_T = 4.6;
// the bot: how far it engages ships and depots, launches torpedoes; its ranging error (a share of the range, times RANGE_IN after each
// salvo at the same target); its AA bursts and their extra error; how far inside the zone it circles; how often it picks a target
const SEA_R = 300, DEPOT_R = 300, TORP_R = 250, RANGE_ERR = 0.08, RANGE_IN = 0.7, AA_BURST = [0.8, 1.4], AA_PAUSE = [1.2, 2.4], AA_BOT_ERR = 0.04;
const CIRCLE = 22, AIM_T = 1;

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const wrapA = a => Math.atan2(Math.sin(a), Math.cos(a));
const rand = (a, b) => a + Math.random() * (b - a);
const r2 = v => Math.round(v * 100) / 100;
const RZ = ZONES.find(q => q.sea);

// ---------- the way to the river zone: a flow field ----------
// The water on a FC-unit grid where a ship fits (inWater with FIT to spare: its circles are SHIP_CR), and from every such cell its distance to the zone's middle
// cells along the water (Dijkstra, eight neighbours). A ship follows it downhill a few cells ahead (waypoint).
const FC = 4, FIT = 4, FX0 = -704, FZ0 = -648, FNX = Math.ceil(1408 / FC) + 1, FNZ = Math.ceil(460 / FC) + 1;
const NAV = new Uint8Array(FNX * FNZ), DIST = new Float64Array(FNX * FNZ).fill(Infinity);
{
  for (let j = 0; j < FNZ; j++) for (let i = 0; i < FNX; i++) if (N.inWater(FX0 + i * FC, FZ0 + j * FC, FIT)) NAV[j * FNX + i] = 1;
  const heap = [];                                       // [dist, cell], a binary heap
  const push = (d, c) => { heap.push([d, c]); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
  for (let j = 0; j < FNZ; j++) for (let i = 0; i < FNX; i++) {
    const c = j * FNX + i, x = FX0 + i * FC, z = FZ0 + j * FC;
    if (NAV[c] && Math.hypot(x - RZ.x, z - RZ.z) < RZ.r * 0.5) { DIST[c] = 0; push(0, c); }
  }
  while (heap.length) {
    const [d, c] = pop(); if (d > DIST[c]) continue;
    const i = c % FNX, j = (c - i) / FNX;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const a = i + di, b2 = j + dj; if (a < 0 || b2 < 0 || a >= FNX || b2 >= FNZ) continue;
      const k = b2 * FNX + a; if (!NAV[k]) continue;
      if (di && dj && (!NAV[j * FNX + a] || !NAV[b2 * FNX + i])) continue;        // no corner cutting past a bank
      const nd = d + (di && dj ? 1.414 : 1);
      if (nd < DIST[k]) { DIST[k] = nd; push(nd, k); }
    }
  }
}
const cellOf = (x, z) => { const i = Math.round((x - FX0) / FC), j = Math.round((z - FZ0) / FC); return i < 0 || j < 0 || i >= FNX || j >= FNZ ? -1 : j * FNX + i; };
// the point to steer for from (x, z): a few cells down the flow field (null: no way from here; the bot then follows the river)
function waypoint(x, z) {
  let c = cellOf(x, z);
  if (c < 0 || !isFinite(DIST[c])) {                     // off the grid's water (near a bank): the nearest cell that has a way
    let best = -1, bd = Infinity; const i0 = Math.round((x - FX0) / FC), j0 = Math.round((z - FZ0) / FC);
    for (let dj = -4; dj <= 4; dj++) for (let di = -4; di <= 4; di++) {
      const i = i0 + di, j = j0 + dj; if (i < 0 || j < 0 || i >= FNX || j >= FNZ) continue;
      const k = j * FNX + i; if (!isFinite(DIST[k])) continue;
      const d = di * di + dj * dj; if (d < bd) { bd = d; best = k; }
    }
    if (best < 0) return null;
    c = best;
  }
  for (let s = 0; s < 8; s++) {
    const i = c % FNX, j = (c - i) / FNX; let next = c;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const a = i + di, b2 = j + dj; if (a < 0 || b2 < 0 || a >= FNX || b2 >= FNZ) continue;
      const k = b2 * FNX + a; if (DIST[k] < DIST[next]) next = k;
    }
    if (next === c) break;
    c = next;
  }
  const i = c % FNX, j = (c - i) / FNX;
  return { x: FX0 + i * FC, z: FZ0 + j * FC };
}

// ---------- spawning ----------
// at one of its team's spawn points on the river (rules.ts TEAM_SHIP_SPAWNS): away from the enemies (up to 250), but not too far from the
// river zone (the river is long: a ship from its far end takes a minute), never onto a ship
function spawn(b, ctx) {
  const list = TEAM_SHIP_SPAWNS[b.team] || N.SHIP_SPAWNS;
  let best = list[0] || { x: 0, z: -400, h: Math.PI / 2 }, bs = -Infinity;
  for (const s of list) {
    let d = 1400, near = Infinity;
    for (const o of ctx.veh) {
      if (o.id === b.id) continue;
      const e = Math.hypot(o.x - s.x, o.z - s.z);
      if (o.team !== b.team) d = Math.min(d, e);
      if (o.k === 2) near = Math.min(near, e);
    }
    const sc = (near < 30 ? -1000 : 0) + Math.min(d, 250) - 0.3 * Math.hypot(s.x - RZ.x, s.z - RZ.z) + Math.random() * 60; if (sc > bs) { bs = sc; best = s; }
  }
  Object.assign(b, {
    x: best.x, z: best.z, h: best.h, y: 0, p: 0, v: 0, roll: 0, tel: 4, rud: 0, yr: 0, heel: 0, pa: 0, t: Math.random() * 10,
    tur: TURRETS.map(t => ({ c: 0, cd: rand(0, 2), el: 0 })), a0: 0, a1: Math.PI, torpCd: rand(4, 10), aaCd: 0, aaOn: 0, aaOff: rand(0, 1),
    circ: Math.random() < 0.5 ? 1 : -1, backT: 0, stuckT: 0, aimT: 0, aim: null, aimId: null, rerr: RANGE_ERR, crashed: false,
  });
}

// ---------- moving ----------
// the deepest overlap at (x, z, h) with a bank, a pier or another ship (game/ship.ts shipPen), into PEN
const PEN = { nx: 0, nz: 0, pen: 0 };
function shipPen(b, x, z, h, ships) {
  const fx = Math.sin(h), fz = Math.cos(h); PEN.pen = 0;
  for (const j of SHIP_C) {
    const px = x + fx * j, pz = z + fz * j, w = N.waterPush(px, pz, SHIP_CR);
    if (w && w.pen > PEN.pen) { PEN.nx = w.nx; PEN.nz = w.nz; PEN.pen = w.pen; }
    for (const o of ships) {
      if (Math.abs(o.x - px) > 14 || Math.abs(o.z - pz) > 14) continue;
      const ox = Math.sin(o.h), oz = Math.cos(o.h);
      for (const k of SHIP_C) {
        const dx = px - o.x - ox * k, dz = pz - o.z - oz * k, d = Math.hypot(dx, dz), pen = 2 * SHIP_CR - d;
        if (pen > PEN.pen) { PEN.nx = d > 1e-6 ? dx / d : -fx; PEN.nz = d > 1e-6 ? dz / d : -fz; PEN.pen = pen; }
      }
    }
  }
  return PEN.pen > 1e-4 ? PEN : null;
}
// turn to nh and sail dist, in steps of at most 0.5, pushed out of what it runs into; it loses the speed that went into it (game/ship.ts)
function move(b, nh, dist, dt, ships) {
  const n = Math.max(1, Math.ceil(Math.abs(dist) / 0.5)), dh = wrapA(nh - b.h) / n, dd = dist / n;
  let px = 0, pz = 0;
  for (let i = 0; i < n; i++) {
    b.h = wrapA(b.h + dh); b.x += Math.sin(b.h) * dd; b.z += Math.cos(b.h) * dd;
    for (let it = 0; it < 3; it++) {
      const p = shipPen(b, b.x, b.z, b.h, ships); if (!p) break;
      b.x += p.nx * p.pen; b.z += p.nz * p.pen; px += p.nx * p.pen; pz += p.nz * p.pen;
    }
  }
  const l = Math.hypot(px, pz); if (l < 1e-4 || Math.abs(b.v) < 0.01) return;
  const d = (Math.sin(b.h) * px + Math.cos(b.h) * pz) / l * Math.sign(b.v);
  if (d >= 0) return;
  if (d < -0.8 && Math.abs(b.v) > 4) { b.v *= -0.2; return; }
  b.v *= Math.exp(-4 * d * d * dt);
}
// is the water clear for a ship L ahead along heading h (with m to spare)?
const clearAhead = (b, h, L, m) => N.inWater(b.x + Math.sin(h) * L, b.z + Math.cos(h) * L, m);

// ---------- aiming ----------
// the elevation that drops a shell d away (horizontally) and dy higher, the flatter arc, and its flight time (game/ship.ts ballistic)
function ballistic(d, dy) {
  const v2 = SHELL_V * SHELL_V, g = SHELL_G, disc = v2 * v2 - g * (g * d * d + 2 * dy * v2);
  if (d < 0.5) return { el: 0, t: 0, ok: true };
  const ok = disc >= 0, el = ok ? Math.atan((v2 - Math.sqrt(disc)) / (g * d)) : Math.PI / 4;
  return { el, t: d / (SHELL_V * Math.cos(el)), ok };
}
function turretAt(b, i) { const t = TURRETS[i]; return { x: b.x + Math.sin(b.h) * t.z, y: WATER_Y + b.y + t.y + GUN_Y, z: b.z + Math.cos(b.h) * t.z }; }
// the turrets' target: the nearest enemy ship within SEA_R, else the nearest standing enemy depot within DEPOT_R; null: none
function pickAim(b, ctx) {
  let best = null, bd = SEA_R;
  for (const o of ctx.veh) {
    if (o.team === b.team || o.k !== 2 || o.s) continue;
    const d = Math.hypot(o.x - b.x, o.z - b.z); if (d < bd) { bd = d; best = { id: o.id, o }; }
  }
  if (best) return best;
  bd = DEPOT_R;
  for (const D of DEPOTS) {
    if (D.team === b.team || ctx.depots[D.i].hp <= 0) continue;
    const d = Math.hypot(D.x - b.x, D.z - b.z); if (d < bd) { bd = d; best = { id: 'd' + D.i, d: D }; }
  }
  return best;
}
// where to aim now: the depot, or the ship where it will be when the shells get there (its speed along its heading, twice refined)
function aimPoint(b, a, ctx) {
  if (a.d) return { x: a.d.x, y: a.d.y + 0.5, z: a.d.z };
  const o = ctx.veh.find(v => v.id === a.id && v.s !== 2); if (!o) return null;
  const vx = Math.sin(o.h) * o.v, vz = Math.cos(o.h) * o.v, y = WATER_Y + 1.2;
  let x = o.x, z = o.z;
  for (let k = 0; k < 2; k++) { const t = ballistic(Math.hypot(x - b.x, z - b.z), y - WATER_Y - 2).t; x = o.x + vx * t; z = o.z + vz * t; }
  return { x, y, z };
}
// a salvo of turret i at (ax, ay, az): two shells, each aimed at the point moved by the game's dispersion (game/ship.ts salvo)
function salvo(b, i, A, out) {
  const tu = b.tur[i], p = turretAt(b, i), yaw = b.h + TURRETS[i].rest + tu.c, fx = Math.sin(yaw), fz = Math.cos(yaw), lx = fz, lz = -fx;
  const ax0 = A.x - p.x, az0 = A.z - p.z, d0 = Math.hypot(ax0, az0) || 1, ux = ax0 / d0, uz = az0 / d0;
  for (const side of [-0.4, 0.4]) {
    const n = () => Math.random() + Math.random() - 1, along = n() * DISP * d0 * 1.4, across = n() * DISP * d0 * 0.7;
    const tx = A.x + ux * along + uz * across - p.x, tz = A.z + uz * along - ux * across - p.z, d = Math.hypot(tx, tz);
    const bl = ballistic(d, A.y - p.y), ce = Math.cos(bl.el), se = Math.sin(bl.el);
    const mx = p.x + fx * (0.55 + GUN_L * ce) + lx * side, my = p.y + GUN_L * se, mz = p.z + fz * (0.55 + GUN_L * ce) + lz * side;
    const hx = d > 0.5 ? tx / d : fx, hz = d > 0.5 ? tz / d : fz;
    out.push({ k: 2, x: r2(mx), y: r2(my), z: r2(mz), vx: r2(hx * ce * SHELL_V), vy: r2(se * SHELL_V), vz: r2(hz * ce * SHELL_V) });
  }
  tu.cd = RELOAD;
}

// ---------- the ship, every tick ----------
function step(b, dt, ctx) {
  const out = [];
  b.t += dt; b.torpCd = Math.max(0, b.torpCd - dt); b.aaCd -= dt; b.backT -= dt;
  const ships = ctx.veh.filter(o => o.k === 2 && o.id !== b.id && o.s !== 2);
  // the helm: to the zone along the flow field, or round inside it; feel ahead for a bank; back off when stuck
  const dz = Math.hypot(b.x - RZ.x, b.z - RZ.z);
  let wx, wz, tel;
  if (dz < RZ.r - 10) {
    const a = Math.atan2(b.x - RZ.x, b.z - RZ.z) + 0.8 * b.circ;
    wx = RZ.x + Math.sin(a) * CIRCLE; wz = RZ.z + Math.cos(a) * CIRCLE; tel = 3;
  } else {
    const w = waypoint(b.x, b.z);
    if (w) { wx = w.x; wz = w.z; } else { const h = N.riverDir(b.x, b.z), s = RZ.x > b.x ? 1 : -1; wx = b.x + Math.sin(h) * 40 * s; wz = b.z + Math.cos(h) * 40 * s; }
    tel = dz > 150 ? 4 : 3;
  }
  let want = Math.atan2(wx - b.x, wz - b.z);
  const near = !clearAhead(b, b.h, 13, 2);
  if (near || !clearAhead(b, b.h, 24, 2)) {                               // a bank ahead: towards the clearer side, slower
    const l = clearAhead(b, b.h + 0.6, 20, 2) + clearAhead(b, b.h + 1.1, 14, 2), r = clearAhead(b, b.h - 0.6, 20, 2) + clearAhead(b, b.h - 1.1, 14, 2);
    if (l !== r) want = b.h + (l > r ? 1 : -1);
    tel = Math.min(tel, near ? 2 : 3);
  }
  let cmd = clamp(wrapA(want - b.h) * 2, -1, 1);
  if (Math.abs(b.v) < 0.8 && b.tel >= 2 && b.backT <= 0) { if ((b.stuckT += dt) > 3) { b.backT = 3; b.stuckT = 0; } } else b.stuckT = 0;
  if (b.backT > 0) { tel = 0; cmd = -cmd || 1; }
  b.tel = tel;
  // the ship, as game/ship.ts updateShip: the rudder at its pace, the speed after the telegraph, the turn by speed, heel, pitch, swell
  b.rud += clamp(cmd - b.rud, -dt / RUD_T, dt / RUD_T);
  const v0 = b.v, tv = TEL[b.tel] * V_MAX * (1 - TURN_SLOW * Math.abs(b.rud) * Math.min(1, Math.abs(b.v) / V_MAX));
  const dv = tv - b.v, acc = Math.sign(dv) === Math.sign(b.v || dv) ? ACC : DEC;
  b.v += clamp(dv, -acc * dt, acc * dt) * Math.min(1, 0.35 + Math.abs(dv) / 2);
  b.yr += (b.rud * b.v / TURN_R - b.yr) * Math.min(1, dt / YAW_T);
  move(b, b.h + b.yr * dt, b.v * dt, dt, ships);
  b.heel += (-b.yr * HEEL - b.heel) * Math.min(1, dt * 1.5);
  b.pa += ((b.v - v0) / Math.max(dt, 1e-4) * 0.012 - b.pa) * Math.min(1, dt * 2);
  b.roll = b.heel + Math.sin(b.t * 0.83) * 0.014;
  b.p = b.pa + Math.sin(b.t * 1.07 + 1) * 0.008;
  b.y = Math.sin(b.t * 1.31) * 0.06;

  // the turrets: a target every AIM_T s; towards it within their arcs; a salvo from each that is on it and loaded
  if ((b.aimT -= dt) <= 0) {
    b.aimT = AIM_T; const a = pickAim(b, ctx);
    if (!a || !b.aim || a.id !== b.aim.id) { b.rerr = RANGE_ERR; b.roff = [rand(-1, 1), rand(-1, 1)]; }
    b.aim = a;
  }
  const A0 = b.aim && aimPoint(b, b.aim, ctx);
  let A = null;
  if (A0) {                                                  // the ranging error: along the line of fire and across it
    const d = Math.hypot(A0.x - b.x, A0.z - b.z) || 1, ux = (A0.x - b.x) / d, uz = (A0.z - b.z) / d, e = b.rerr * d;
    A = { x: A0.x + ux * e * b.roff[0] + uz * e * 0.4 * b.roff[1], y: A0.y, z: A0.z + uz * e * b.roff[0] - ux * e * 0.4 * b.roff[1] };
  }
  let fired = false;
  b.tur.forEach((tu, i) => {
    const t = TURRETS[i], p = turretAt(b, i), want2 = A ? wrapA(Math.atan2(A.x - p.x, A.z - p.z) - b.h - t.rest) : 0;
    tu.c += clamp(clamp(want2, -ARC, ARC) - tu.c, -TRAV * dt, TRAV * dt);
    tu.cd = Math.max(0, tu.cd - dt);
    if (!A) { tu.el *= 1 - Math.min(1, dt * 3); return; }
    const d = Math.hypot(A.x - p.x, A.z - p.z), bl = ballistic(d, A.y - p.y);
    tu.el += (bl.el - tu.el) * Math.min(1, dt * 3);
    if (Math.abs(want2) <= ARC && Math.abs(want2 - tu.c) < ALIGN && tu.cd <= 0 && bl.ok && d > 25) { salvo(b, i, A, out); fired = true; }
  });
  if (fired) { b.rerr = Math.max(0.02, b.rerr * RANGE_IN); b.roff = [rand(-1, 1), rand(-1, 1)]; }
  b.a0 = wrapA(TURRETS[0].rest + b.tur[0].c); b.a1 = wrapA(TURRETS[1].rest + b.tur[1].c);

  // torpedoes: at an enemy ship within TORP_R whose intercept course is within the tubes' arc, on a clear run of water
  if (b.torpCd <= 0) {
    for (const o of ctx.veh) {
      if (o.team === b.team || o.k !== 2 || o.s) continue;
      const rx = o.x - b.x, rz = o.z - b.z, dist = Math.hypot(rx, rz); if (dist > TORP_R) continue;
      const vx = Math.sin(o.h) * o.v, vz = Math.cos(o.h) * o.v, qa = vx * vx + vz * vz - TORP_V * TORP_V, qb = 2 * (rx * vx + rz * vz), qc = rx * rx + rz * rz;
      const disc = qb * qb - 4 * qa * qc; if (disc < 0) continue;
      const t = (-qb - Math.sqrt(disc)) / (2 * qa); if (!(t > 0)) continue;
      const head = Math.atan2(rx + vx * t, rz + vz * t) + rand(-0.06, 0.06), rel = wrapA(head - b.h), side = rel >= 0 ? 1 : -1;
      if (Math.abs(rel) < TUBE_ARC0 || Math.abs(rel) > TUBE_ARC1) continue;
      let clear = true; for (let s = 10; s < TORP_V * t && clear; s += 10) clear = N.inWater(b.x + Math.sin(head) * s, b.z + Math.cos(head) * s, 1);
      if (!clear) continue;
      const mid = b.h + side * clamp(Math.abs(rel), TUBE_ARC0, TUBE_ARC1), lx = Math.cos(b.h) * side, lz = -Math.sin(b.h) * side;
      const x0 = b.x + Math.sin(b.h) * TUBE_Z + lx * (TUBE_X + 1.2), z0 = b.z + Math.cos(b.h) * TUBE_Z + lz * (TUBE_X + 1.2);
      for (const k of [-1, 0, 1]) {
        const h = mid + k * TORP_SPREAD;
        out.push({ k: 3, x: r2(x0 + Math.sin(mid) * k * 0.6), y: WATER_Y, z: r2(z0 + Math.cos(mid) * k * 0.6), vx: r2(Math.sin(h) * TORP_V), vy: 0, vz: r2(Math.cos(h) * TORP_V) });
      }
      b.torpCd = TORP_RELOAD;
      break;
    }
  }

  // anti-aircraft: bursts at the nearest enemy plane within AA_R in sight, the two mounts in turn, led by the bullet's flight
  if (b.aaCd <= 0) {
    const hx = Math.sin(b.h), hz = Math.cos(b.h), side = (b.aaSide = -(b.aaSide || 1));
    const ox = b.x + hz * AA_X * side + hx * AA_Z, oy = WATER_Y + b.y + AA_Y, oz = b.z - hx * AA_X * side + hz * AA_Z;
    let best = null, bd = AA_R;
    for (const o of ctx.veh) {
      if (o.team === b.team || o.k !== 1 || o.s) continue;
      const d = Math.hypot(o.x - ox, o.y - oy, o.z - oz); if (d < bd && segHit(ox, oy, oz, o.x, o.y, o.z) >= 1) { bd = d; best = o; }
    }
    if (!best) { b.aaOn = 0; b.aaCd = 0.5; }
    else if (b.aaOn <= 0 && (b.aaOff -= 0.5) > 0) b.aaCd = 0.5;
    else {
      if (b.aaOn <= 0) b.aaOn = rand(...AA_BURST);
      b.aaOn -= AA_RATE; b.aaCd = AA_RATE;
      if (b.aaOn <= 0) b.aaOff = rand(...AA_PAUSE);
      const vx = Math.sin(best.h) * Math.cos(best.p) * best.v, vy = Math.sin(best.p) * best.v, vz = Math.cos(best.h) * Math.cos(best.p) * best.v;
      let dx = 0, dy = 0, dz = 0, t = bd / BUL_V;
      for (let i = 0; i < 2; i++) { dx = best.x + vx * t - ox; dy = best.y + vy * t - oy; dz = best.z + vz * t - oz; t = Math.hypot(dx, dy, dz) / BUL_V; }
      const l = Math.hypot(dx, dy, dz) || 1, e = () => (Math.random() - 0.5) * (AA_ERR + AA_BOT_ERR);
      dx = dx / l + e(); dy = dy / l + e(); dz = dz / l + e();
      out.push({ k: 1, x: r2(ox + dx), y: r2(oy + dy), z: r2(oz + dz), vx: r2(dx * BUL_V), vy: r2(dy * BUL_V), vz: r2(dz * BUL_V) });
    }
  }
  return out;
}

// sunk: it lists to one side, the bow lifts, it settles and goes down (game/ship.ts sink), drifting to a stop
function die(b) { b.sinkT = 0; b.aim = null; }
function dying(b, dt, ctx) {
  const tt = SINK_T - Math.max(0, b.deadT), e = a => a <= 0 ? 0 : a >= 1 ? 1 : a * a * (3 - 2 * a);
  b.v *= Math.exp(-1.2 * dt); b.yr *= Math.exp(-2 * dt);
  move(b, b.h + b.yr * dt, b.v * dt, dt, []);
  b.roll = b.heel + (b.rollDir || 1) * 0.6 * e(tt / 2.6);
  b.p = 0.16 * e(tt / 3.2);
  b.y = -8 * e((tt - 0.4) / 3.6);
}

module.exports = { spawn, step, die, dying, waypoint, NAV, DIST, FNX, FNZ, FX0, FZ0, FC };
