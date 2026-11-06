// World of DODO, issue #26: Velemlok, the giant river salamander in the Vltava, on the server. Its numbers, its hitbox and what its
// attacks hit are client/shared/monster.ts (the same file the page runs); this module is its state machine and its mind, and it is
// authoritative: the browsers draw it from snap.g and obj.g, report their hits on it (mhit, server.js checks them against the poses
// kept here) and apply its attacks (mon) to their own vehicle; the bots' hits on it are flown on the server (server/shots.js) and its
// attacks on the bots decided here.
//
// - When: MON_FIRST_S after a round starts, then MON_EVERY_S after it has gone (env MON_FIRST_S, MON_EVERY_S, MON_LIFE_S and MON_HP
//   override monster.ts's, for the tests); never in the intermission: the end of a round sends it away, unrewarded. The next
//   appearance is known at all times (obj.g.next), so every ship's HUD counts down to the same moment.
// - Where: it surfaces at a random spot of the Vltava's main channel near Karlín (naval.ts inWater with SPOT_M to spare), at least
//   SPOT_FAR from every ship, and swims on the water only (waterPush against the banks and the piers; it goes under the bridges), at
//   most MON_V, along a flow field over the river towards where it wants to be.
// - Its mind: a threat table (every vehicle's damage in the last MON_THREAT_S). Every MON_ATK_S (MON_RAGE_ATK_S below half its hit
//   points: enraged) it attacks the top threat in reach, else the nearest vehicle in reach (monster.ts: a tail slam on a ship, a water
//   jet at a tank or a ship, a geyser under a plane), else it looks again in a moment; meanwhile it swims towards the top threat, or,
//   when nobody has hurt it lately, wanders along the river. It stands still while it winds an attack up, and rears up for the jets
//   and the geysers (easier to hit then).
// - The fight: every hit's damage counts for the shooter's team and for the shooter (people's through mhit, bots' through the
//   server's flight). It leaves when killed (it rolls over and sinks) or after MON_LIFE_S (it dives). Then the team with more damage
//   gets MON_KILL_PTS or MON_FLEE_PTS (a tie: nobody), everyone who hurt it round(damage / MON_PTS_PER) personal points, and everyone
//   the result (mres).
'use strict';

const S = require('../client/shared/monster.ts');
const N = require('../client/shared/naval.ts');

const envNum = (k, d, lo) => { const v = Number(process.env[k]); return Number.isFinite(v) && v >= lo ? v : d; };
const FIRST_S = envNum('MON_FIRST_S', S.MON_FIRST_S, 1);
const EVERY_S = envNum('MON_EVERY_S', S.MON_EVERY_S, 1);
const LIFE_S = envNum('MON_LIFE_S', S.MON_LIFE_S, 5);
const MAX_HP = Math.round(envNum('MON_HP', S.MON_HP, 1));
const { WATER_Y } = N;

// where it surfaces: the water at least SPOT_M from every bank and pier (the main channel, not the side channel by the arena) within
// SPOT_X of the middle (the stretch of the river along Karlín), at least SPOT_FAR from every ship
const SPOT_M = 30, SPOT_X = 420, SPOT_FAR = 150;
// how it swims: the turn rate (rad/s; a 60-unit body turns slowly), its acceleration, its collision circles along its axis (they keep
// the body off the banks and the piers; the tail may brush a bank), how near a wandering point counts as reached, how long it wanders
// to one point at most
const TURN = 0.55, ACC = 2, BODY_C = [14, 0, -14], BODY_R = 5, WANDER_NEAR = 25, WANDER_T = 25;
// the flow field: cells of FC units on the water a body circle fits in (inWater with FIT to spare), the way to a target cell computed
// again at most every FIELD_T s; how far ahead along it it steers
const FC = 8, FIT = 5, FIELD_T = 1, AHEAD = 4;
// a vehicle it swims towards: it stops this near (its attacks reach farther)
const CLOSE = 20;
// it looks again this soon when nothing was in reach (s); its pose history for the mhit check (ms)
const LOOK_T = 0.4, HIST_MS = 1000;
// the slam's and the jet's lock: it stands still this long after the attack lands (s); the jet's flight time from its distance
const LOCK_AFTER = 0.3, JET_T = d => Math.max(0.7, Math.min(2, 0.55 + d / 85));

const r2 = v => Math.round(v * 100) / 100, r3 = v => Math.round(v * 1000) / 1000;
const wrapA = a => Math.atan2(Math.sin(a), Math.cos(a));
const rand = (a, b) => a + Math.random() * (b - a);

// ---------- the river: the spots it surfaces at, the flow field's grid ----------
const SPOTS = [];
for (let z = -700; z <= 0; z += 10) for (let x = -SPOT_X; x <= SPOT_X; x += 10) if (N.inWater(x, z, SPOT_M)) SPOTS.push([x, z]);
const FX0 = -704, FZ0 = -704, FNX = Math.ceil(1408 / FC) + 1, FNZ = Math.ceil(704 / FC) + 1;
const NAV = new Uint8Array(FNX * FNZ), DIST = new Float64Array(FNX * FNZ);
for (let j = 0; j < FNZ; j++) for (let i = 0; i < FNX; i++) if (N.inWater(FX0 + i * FC, FZ0 + j * FC, FIT)) NAV[j * FNX + i] = 1;
const cellOf = (x, z) => { const i = Math.round((x - FX0) / FC), j = Math.round((z - FZ0) / FC); return i < 0 || j < 0 || i >= FNX || j >= FNZ ? -1 : j * FNX + i; };
// the water cell nearest to (x, z) (within R cells), or -1
function nearCell(x, z, R = 30) {
  const c = cellOf(x, z); if (c >= 0 && NAV[c]) return c;
  const i0 = Math.round((x - FX0) / FC), j0 = Math.round((z - FZ0) / FC); let best = -1, bd = Infinity;
  for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
    const i = i0 + di, j = j0 + dj; if (i < 0 || j < 0 || i >= FNX || j >= FNZ || !NAV[j * FNX + i]) continue;
    const d = di * di + dj * dj; if (d < bd) { bd = d; best = j * FNX + i; }
  }
  return best;
}
// the way along the water to cell t from every cell (Dijkstra, eight neighbours, no corner cutting past a bank) into DIST
const HEAP = [];
function field(t) {
  DIST.fill(Infinity); DIST[t] = 0; HEAP.length = 0; HEAP.push([0, t]);
  const push = (d, c) => { HEAP.push([d, c]); let k = HEAP.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (HEAP[p][0] <= HEAP[k][0]) break; [HEAP[p], HEAP[k]] = [HEAP[k], HEAP[p]]; k = p; } };
  const pop = () => { const top = HEAP[0], last = HEAP.pop(); if (HEAP.length) { HEAP[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < HEAP.length && HEAP[l][0] < HEAP[m][0]) m = l; if (r < HEAP.length && HEAP[r][0] < HEAP[m][0]) m = r; if (m === k) break; [HEAP[m], HEAP[k]] = [HEAP[k], HEAP[m]]; k = m; } } return top; };
  while (HEAP.length) {
    const [d, c] = pop(); if (d > DIST[c]) continue;
    const i = c % FNX, j = (c - i) / FNX;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= FNX || b >= FNZ) continue;
      const k = b * FNX + a; if (!NAV[k]) continue;
      if (di && dj && (!NAV[j * FNX + a] || !NAV[b * FNX + i])) continue;
      const nd = d + (di && dj ? 1.414 : 1); if (nd < DIST[k]) { DIST[k] = nd; push(nd, k); }
    }
  }
}

// ---------- the state ----------
const M = {
  st: 0,            // 0 away, 1 surfacing, 2 out, 3 leaving (diving, or sinking when killed)
  next: 0,          // away: when it comes next; out: when it leaves; leaving: when it is gone (the server's clock, ms)
  since: 0,         // when the current state began
  roundNext: 0,     // in the intermission: when the next round starts (it comes FIRST_S after that)
  hp: MAX_HP, dmg: [0, 0],
  by: new Map(),    // id -> { team, d }: the damage of every player and bot in this appearance
  threat: new Map(),// id -> [[t, d], ...]: its threat table (the last MON_THREAT_S)
  x: 0, z: 0, h: 0, y: S.MON_DEEP, rear: 0, v: 0,
  atkCd: 0, atkN: 0, lock: 0, rearUntil: 0,
  pending: [],      // announced attacks that have not landed yet (each the mon message's fields)
  goalCell: -1, fieldT: 0, wander: null, wanderT: 0,
  hist: [],         // its poses of the last HIST_MS: { t, x, z, h, y, rear }
  dirty: true,      // something the players must hear at once (obj)
  io: null,         // server.js: { broadcast(msg), hitBot(id, A), credit(id, pts), teamScore(team, pts) }
};

// server.js's callbacks
function init(io) { M.io = io; }

// a new round (also the first): it is away and comes FIRST_S later
function reset(now) {
  Object.assign(M, { st: 0, next: now + FIRST_S * 1000, since: now, roundNext: 0, hp: MAX_HP, dmg: [0, 0], y: S.MON_DEEP, rear: 0, v: 0, pending: [], hist: [], dirty: true });
  M.by.clear(); M.threat.clear();
}

// the round has ended (the intermission until nextRound): out, it dives away without a result worth points; away, it comes FIRST_S
// after the next round starts
function roundEnd(now, nextRound) {
  M.roundNext = nextRound;
  if (M.st === 1 || M.st === 2) leave(now, false, true);
  else if (M.st === 0) M.next = nextRound + FIRST_S * 1000;
  M.pending = [];
  M.dirty = true;
}

const out = () => M.st === 1 || M.st === 2;
const pose = () => ({ x: M.x, z: M.z, h: M.h, y: M.y, rear: M.rear });

// ---------- coming and going ----------
// surface at a random spot of the main channel at least SPOT_FAR from every ship (none such: the one farthest from them), facing
// along the river
function surface(now, veh) {
  const ships = veh.filter(o => o.k === 2 && o.s !== 2);
  const far = p => ships.reduce((m, o) => Math.min(m, Math.hypot(o.x - p[0], o.z - p[1])), Infinity);
  const ok = SPOTS.filter(p => far(p) >= SPOT_FAR);
  const p = ok.length ? ok[Math.random() * ok.length | 0] : SPOTS.reduce((a, b) => far(a) >= far(b) ? a : b, SPOTS[0] || [0, -400]);
  const h = N.riverDir(p[0], p[1]) + (Math.random() < 0.5 ? Math.PI : 0);
  Object.assign(M, {
    st: 1, since: now, next: now + LIFE_S * 1000, hp: MAX_HP, dmg: [0, 0], x: p[0], z: p[1], h: wrapA(h), y: S.MON_DEEP, rear: 0, v: 0,
    atkCd: 1.5, lock: 0, rearUntil: 0, pending: [], goalCell: -1, fieldT: 0, wander: null, wanderT: 0, hist: [], dirty: true,
  });
  M.by.clear(); M.threat.clear();
}
// it leaves: killed (it rolls over and sinks) or fled (it dives). The team with more damage gets the bonus, everyone who hurt it their
// personal points, everyone the result. byRound: the end of the round sent it away: no points for anyone.
function leave(now, killed, byRound) {
  const win = byRound ? -1 : M.dmg[0] > M.dmg[1] ? 0 : M.dmg[1] > M.dmg[0] ? 1 : -1;
  const pts = win < 0 ? 0 : killed ? S.MON_KILL_PTS : S.MON_FLEE_PTS;
  const top = [...M.by].sort((a, b) => b[1].d - a[1].d || a[0] - b[0]).slice(0, 3).map(([id, e]) => [id, Math.round(e.d)]);
  M.st = 3; M.since = now; M.next = now + (killed ? S.MON_SINK_S : S.MON_DIVE_S) * 1000; M.v = 0; M.rear = 0; M.dirty = true;
  const io = M.io; if (!io) return;
  const res = { t: 'mres', killed: !!killed, dmg: M.dmg.map(Math.round), win, pts, top };
  if (byRound) res.end = 1;
  if (pts) io.teamScore(win, pts);
  io.broadcast(res);
  if (!byRound) for (const [id, e] of M.by) { const p = Math.round(e.d / S.MON_PTS_PER); if (p > 0) io.credit(id, p); }
}

// ---------- the hits it takes ----------
// is (x, y, z) in its hitbox, give or take slack, at its pose now or at one of the last backMs (the shooter saw it a moment ago)?
function hitAt(x, y, z, slack, backMs, now) {
  if (!out()) return false;
  if (S.monHit(pose(), x, y, z, slack)) return true;
  for (let i = M.hist.length - 1; i >= 0 && now - M.hist[i].t <= backMs; i--) if (S.monHit(M.hist[i], x, y, z, slack)) return true;
  return false;
}
// a hit of kind k (0 parcel, 1 bullet, 2 shell, 3 torpedo) by player or bot p ({ id, team }): its damage counts for p's team, for p
// and in the threat table; at 0 it is killed. Returns whether it counted.
function damage(p, k, now) {
  const d = S.MON_DMG_K[k];
  if (!out() || !p || !(p.team === 0 || p.team === 1) || !(d > 0)) return false;
  const dd = Math.min(d, M.hp);
  M.hp = Math.max(0, M.hp - d); M.dmg[p.team] += dd; M.dirty = true;
  const e = M.by.get(p.id); if (e) { e.d += dd; e.team = p.team; } else M.by.set(p.id, { team: p.team, d: dd });
  let l = M.threat.get(p.id); if (!l) M.threat.set(p.id, l = []);
  l.push([now, dd]);
  if (M.hp <= 0) leave(now, true, false);
  return true;
}
// the threat of player or bot id: its damage in the last MON_THREAT_S
function threatOf(id, now) {
  const l = M.threat.get(id); if (!l) return 0;
  while (l.length && now - l[0][0] > S.MON_THREAT_S * 1000) l.shift();
  let s = 0; for (const e of l) s += e[1];
  return s;
}

// ---------- its attacks ----------
// the attack it can make on vehicle o (a row of server.js view: k 0 tank, 1 plane, 2 ship, x, y, z, h, v, p) from its body sph, or ''
function reach(o, sph) {
  const d = S.monSphDist(sph, o.x, o.z);
  if (o.k === 2) return d <= S.MON_SLAM_REACH ? 'slam' : d <= S.MON_JET_REACH ? 'jet' : '';
  if (o.k === 1) {                                     // a plane low enough, whose geyser would come up from the river
    if (d > S.MON_GEY_REACH || o.y >= S.MON_GEY_BELOW) return '';
    const [px, pz] = planeAt(o, S.MON_GEY_WARN);
    return N.inWater(px, pz, 0) ? 'geyser' : '';
  }
  return d <= S.MON_JET_REACH ? 'jet' : '';
}
// where vehicle o will be in t s, flying on (a plane along its pitch too) or driving on
function planeAt(o, t) { const c = o.k === 1 ? Math.cos(o.p || 0) : 1; return [o.x + Math.sin(o.h) * c * o.v * t, o.z + Math.cos(o.h) * c * o.v * t]; }
// announce attack A (the mon message's fields): everyone hears it, and it lands at A.at
function announce(A) {
  M.pending.push(A);
  if (M.io) M.io.broadcast({ t: 'mon', ...A });
}
function attack(kind, o, now, sph) {
  const A = { a: kind, i: ++M.atkN, v: o.id };
  if (kind === 'slam') {
    // its tail comes down where the ship will be, or where it is if that would be out of the tail's reach
    let [x, z] = planeAt(o, S.MON_SLAM_WARN);
    if (S.monSphDist(sph, x, z) > S.MON_SLAM_REACH + S.MON_SLAM_R / 2) { x = o.x; z = o.z; }
    Object.assign(A, { x: r2(x), y: WATER_Y, z: r2(z), r: S.MON_SLAM_R, at: Math.round(now + S.MON_SLAM_WARN * 1000) });
    M.lock = now + (S.MON_SLAM_WARN + LOCK_AFTER) * 1000;
  } else if (kind === 'jet') {
    // it rears up; at t0 the water leaves its mouth (in front of the head as it will stand) and lands where the vehicle will be
    const head = S.monSpheres({ x: M.x, z: M.z, h: M.h, y: 0, rear: 1 })[0], hx = Math.sin(M.h), hz = Math.cos(M.h);
    const sx = head[0] + hx * 5, sy = head[1] - 1, sz = head[2] + hz * 5;
    const T = JET_T(Math.hypot(o.x - sx, o.z - sz)), [x, z] = planeAt(o, S.MON_JET_WIND + T), y = N.surfaceY(x, z);
    const t0 = Math.round(now + S.MON_JET_WIND * 1000);
    Object.assign(A, {
      x: r2(x), y: r2(y), z: r2(z), r: S.MON_JET_R, at: t0 + Math.round(T * 1000), t0, sx: r2(sx), sy: r2(sy), sz: r2(sz),
      vx: r2((x - sx) / T), vy: r2((y - sy) / T + S.MON_JET_G * T / 2), vz: r2((z - sz) / T),
    });
    M.lock = M.rearUntil = t0 + LOCK_AFTER * 1000;
  } else {
    // a geyser under where the plane will be, after the warning ring
    const [x, z] = planeAt(o, S.MON_GEY_WARN);
    Object.assign(A, { x: r2(x), y: WATER_Y, z: r2(z), r: S.MON_GEY_R, at: Math.round(now + S.MON_GEY_WARN * 1000) });
    M.lock = M.rearUntil = A.at + LOCK_AFTER * 1000;
  }
  announce(A);
}
// the attacks that land now: every bot in one is hit (the people's browsers decide their own); a hit by Velemlok scores for nobody
function land(now, veh) {
  for (let i = M.pending.length - 1; i >= 0; i--) {
    const A = M.pending[i]; if (now < A.at) continue;
    M.pending.splice(i, 1);
    if (!M.io) continue;
    for (const o of veh) if (o.bot && o.s === 0 && S.monAtkHits(A, o.k, o.x, o.k === 1 ? o.y : o.k === 2 ? WATER_Y + o.y : N.surfaceY(o.x, o.z), o.z)) M.io.hitBot(o.id, A);
  }
}

// ---------- every tick ----------
// One step of dt seconds at server time now (ms). veh: every vehicle with a row (server.js view: { id, team, bot, k, x, y, z, h, v,
// p, s }); play: the round is on (not the intermission).
function step(dt, now, veh, play) {
  land(now, veh);
  if (M.st === 0) {
    if (play && now >= M.next) surface(now, veh);
    return;
  }
  if (M.st === 3) {                                   // diving, or sinking (it rolled over: the browsers draw that from hp 0)
    M.y = S.MON_DEEP * Math.min(1, (now - M.since) / (M.next - M.since));
    if (now >= M.next) {
      M.st = 0; M.since = now; M.dirty = true; M.hist = []; M.pending = [];
      M.next = !play && M.roundNext > now ? M.roundNext + FIRST_S * 1000 : now + EVERY_S * 1000;
    }
    return;
  }
  if (M.st === 1) {                                   // surfacing: it comes up where it is
    M.y = S.MON_DEEP * Math.max(0, 1 - (now - M.since) / (S.MON_SURF_S * 1000));
    if (now - M.since >= S.MON_SURF_S * 1000) { M.st = 2; M.y = 0; M.dirty = true; }
  } else if (now >= M.next) { leave(now, false, false); return; }
  else think(dt, now, veh);
  // its pose a moment ago (for the people's hits: they saw it then)
  M.hist.push({ t: now, x: M.x, z: M.z, h: M.h, y: M.y, rear: M.rear });
  while (M.hist.length && now - M.hist[0].t > HIST_MS) M.hist.shift();
}

// out: attack, then swim
function think(dt, now, veh) {
  const sph = S.monSpheres(pose());
  const live = veh.filter(o => o.s === 0 && (o.team === 0 || o.team === 1));
  // the top threat (alive), whatever its reach
  let top = null, ts = 0;
  for (const o of live) { const t = threatOf(o.id, now); if (t > ts) { ts = t; top = o; } }
  // attack: the top threat in reach, else the nearest vehicle in reach
  if ((M.atkCd -= dt) <= 0 && now >= M.lock) {
    let pick = null, kind = '';
    if (top) { kind = reach(top, sph); if (kind) pick = top; }
    if (!pick) {
      let bd = Infinity;
      for (const o of live) { const k = reach(o, sph); if (!k) continue; const d = S.monSphDist(sph, o.x, o.z); if (d < bd) { bd = d; pick = o; kind = k; } }
    }
    if (pick) { attack(kind, pick, now, sph); M.atkCd = M.hp < MAX_HP / 2 ? S.MON_RAGE_ATK_S : S.MON_ATK_S; }
    else M.atkCd = LOOK_T;
  }
  // rear up for a jet or a geyser, down again after it
  const rt = now < M.rearUntil ? 1 : 0;
  M.rear += Math.max(-dt / S.MON_REAR_S, Math.min(dt / S.MON_REAR_S, rt - M.rear));
  // swim: towards the top threat (it stops CLOSE to it; one with no water near, a plane over the city, it cannot follow), or wander
  // along the river; never while it winds an attack up
  let gx, gz, near = WANDER_NEAR;
  if (top && nearCell(top.x, top.z) >= 0) { gx = top.x; gz = top.z; near = CLOSE; M.wander = null; }
  else {
    if (!M.wander || (M.wanderT -= dt) <= 0 || Math.hypot(M.wander[0] - M.x, M.wander[1] - M.z) < WANDER_NEAR) {
      M.wander = SPOTS[Math.random() * SPOTS.length | 0] || [M.x, M.z]; M.wanderT = WANDER_T;
    }
    [gx, gz] = M.wander;
  }
  let want = M.h, speed = 0;
  if (now >= M.lock && Math.hypot(gx - M.x, gz - M.z) > near) {
    const w = waypoint(gx, gz, now);
    if (w) { want = Math.atan2(w[0] - M.x, w[1] - M.z); speed = S.MON_V; }
  }
  const off = wrapA(want - M.h);
  M.h = wrapA(M.h + Math.max(-TURN * dt, Math.min(TURN * dt, off)));
  if (Math.abs(off) > 0.8) speed *= 0.35;                   // a sharp turn: it turns more than it swims
  M.v += Math.max(-ACC * dt, Math.min(ACC * dt, speed - M.v));
  M.x += Math.sin(M.h) * M.v * dt; M.z += Math.cos(M.h) * M.v * dt;
  // off the banks and the piers (its three circles, the deepest first, a few rounds)
  for (let it = 0; it < 3; it++) {
    let best = null;
    for (const a of BODY_C) {
      const w = N.waterPush(M.x + Math.sin(M.h) * a, M.z + Math.cos(M.h) * a, BODY_R);
      if (w && (!best || w.pen > best.pen)) best = w;
    }
    if (!best) break;
    M.x += best.nx * best.pen; M.z += best.nz * best.pen;
  }
}
// the point to swim for on the way to (gx, gz): a few cells down the flow field to the water cell nearest to it (computed again when
// that cell changes, at most every FIELD_T s), or null when there is no way
function waypoint(gx, gz, now) {
  const t = nearCell(gx, gz);
  if (t < 0) return null;
  if (t !== M.goalCell && now >= M.fieldT) { field(t); M.goalCell = t; M.fieldT = now + FIELD_T * 1000; }
  let c = nearCell(M.x, M.z, 4);
  if (c < 0 || !isFinite(DIST[c])) return [gx, gz];
  for (let s = 0; s < AHEAD; s++) {
    const i = c % FNX, j = (c - i) / FNX; let next = c;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= FNX || b >= FNZ) continue;
      const k = b * FNX + a; if (DIST[k] < DIST[next]) next = k;
    }
    if (next === c) break;
    c = next;
  }
  if (c === t) return [gx, gz];
  const i = c % FNX, j = (c - i) / FNX;
  return [FX0 + i * FC, FZ0 + j * FC];
}

// ---------- what the players and the bots see ----------
// snap.g: its pose while it is out, or null
function row() {
  if (M.st === 0) return null;
  return [r2(M.x), r2(M.z), r3(M.h), r2(M.y), M.st, Math.round(M.hp * 10) / 10, r2(M.rear)];
}
// obj.g: its state, always
function state() {
  return { st: M.st, hp: Math.ceil(M.hp), max: MAX_HP, dmg: M.dmg.map(Math.round), next: Math.round(M.next) };
}
// for the bots (server/bots.js and the others): null while it cannot be hit, else its pose, its spheres, its speed along its heading,
// its hit points and the attacks on their way (with the seconds until each lands)
function view(now) {
  if (!out()) return null;
  const p = pose();
  return { ...p, st: M.st, v: M.v, hp: M.hp, sph: S.monSpheres(p), atk: M.pending.map(A => ({ ...A, inS: (A.at - now) / 1000 })) };
}

module.exports = { M, init, reset, roundEnd, step, damage, hitAt, row, state, view, out, FIRST_S, EVERY_S, LIFE_S, MAX_HP };
