// World of DODO, issue #24: the plane bots. A bot flies the players' plane (client/src/game/plane.ts updateFly): the same arcade flight,
// with the same numbers (V_STALL ... BANK below): it points an aim direction and the plane turns its nose towards it as fast as its
// speed allows, banking into the turn; throttle and gravity trade speed for height; below V_STALL it stalls; above AIR_TOP the engine
// thins out; at the edge of the airspace it turns back. Only the aim is the bot's: what a player does with the mouse.
//
// What it aims at, thought over every THINK s (its reaction time):
// - an enemy plane within CHASE_R: it chases it and fires bursts of bullets when the plane is within GUN_R in front of its nose (the
//   guns fire along the nose, as a player's; the bot points the nose at where the plane will be, with an error per burst);
// - else, with parcels aboard, the nearest enemy supply depot that stands: it comes in at CRUISE, turns onto it, goes down to RUN_Y
//   over it in a shallow dive, drops its parcels where the bomb sight says they land on it (with an error per run), and pulls up and
//   away; then the next run, or the next depot;
// - else an enemy tank (one in a ground zone first): it dives on it, fires bursts, and pulls up before LOW over the ground;
// - else it circles over the middle of Karlín.
// It never flies into the ground or a building on purpose: it looks LOOK ahead along its heading for the highest ground or roof and
// climbs to keep MIN_CLEAR over it (in a dive, a bombing run or the climb after one, less). It is destroyed like a player's plane: by
// the hits (server/bots.js hitBot), or by flying into something (crashed below: the ground, the water, a building, another vehicle).
// Then it blows up where it is (its row says destroyed, the browsers draw the blast) and comes back from its team's edge of the
// airspace (rules.ts PLANE_SIDE_X).
//
// Issue #26: Velemlok (server/monster.js). While it is out a plane bot goes for it before the depots and the tanks (an enemy plane
// near still comes first): with parcels aboard it makes bombing runs on its back as on a depot (leading it by the parcels' fall), else
// it dives on it and fires bursts; near it, it keeps above MON_GEY_TOP + MON_ABOVE (its geysers reach up to MON_GEY_TOP) unless on a run
// or a dive, and when a geyser is announced under it, it notices it with MON_DODGE_P and turns hard and pulls up.
'use strict';

const M = require('./city');
const { surfaceY, WATER_Y } = require('../client/shared/naval.ts');
const { DEPOTS, ZONES, homeSide, zoneAt, PLANE_SIDE_X } = require('../client/shared/rules.ts');
const { shipBox } = require('./shots');
const { MON_GEY_TOP, monSphHit } = require('../client/shared/monster.ts');

// the flight, as client/src/game/plane.ts: stall speed, the best turn's speed, thrust, drag, gravity, the fastest turn (rad/s), the speed a
// turn bleeds, the bank; the guns (seconds between bullets, where their lines meet ahead), the parcels aboard and their reload; where a
// plane comes in (game/plane.ts SPAWN_R, SPAWN_Y, SPAWN_V); bullet speed (game/bullets.ts BUL_V), a parcel's gravity (game/shots.ts SHOT_G),
// the height above which the engine thins out (world/grid.ts AIR_TOP)
const V_STALL = 14, V_TURN = 26, THRUST = 12, DRAG = 0.0075, GRAV = 16, TURN = 1.25, TURN_DRAG = 0.07, BANK = 0.9;
const GUN_RATE = 1 / 12, GUN_CONV = 150, BOMBS = 4, BOMB_RELOAD = 5, BOMB_CD = 0.6;
const SPAWN_R = M.AIR_LIM - 100, SPAWN_Y = 80, SPAWN_V = 32, BUL_V = 170, SHOT_G = 14, AIR_TOP = 220, PLANE_R = 2.4;
// the bot: its cruising height over the ground, the clearance it keeps over the highest ground or roof ahead (in a dive or a run: LOW),
// how far ahead it looks (units along its heading), how often it looks
const CRUISE = 70, MIN_CLEAR = 30, LOW = 18, LOOK = [0, 15, 30, 50, 75, 105, 140, 180], LOOK_T = 0.2;
// an enemy plane within CHASE_R is chased; it fires when the target is within GUN_R and GUN_ANG of its nose, in bursts (s) with
// pauses (s); the aim's error per burst (radians); how often it thinks again (s)
const CHASE_R = 300, GUN_R = 170, GUN_ANG = 0.06, BURST = [0.35, 0.7], PAUSE = [1.5, 3], AIM_ERR = 0.03, THINK = [0.6, 1.2];
const CHASE_T = 14, OFF_T = [10, 16];
// a bombing run: where it starts (horizontal distance), its height over the depot, how near the bomb sight must be to drop (grows a
// little with each parcel of the run), the error per run (units, either way)
const RUN_R = 280, RUN_Y = 45, DROP_OK = 2.5, DROP_ERR = 6;
// strafing a tank: it pulls up at STRAFE_UP over the ground or STRAFE_NEAR from the tank, then climbs away for EGRESS s
const STRAFE_UP = 22, STRAFE_NEAR = 40, EGRESS = [3, 5];
// another plane coming within AVOID in the next AVOID_T s: out of its way
const AVOID = 12, AVOID_T = 1.6;
// the farthest the aim goes off the heading (radians)
const YAW_MAX = 0.9;
// issue #26: Velemlok: how far over its geysers' top a bot keeps within MON_NEAR of it (unless on a run or a dive); how likely it notices
// a geyser announced under it (then it turns hard and pulls up for the warning's length and MON_JINK more); its bombing runs' error;
// how high its back is over the water (where the parcels should come down)
const MON_ABOVE = 8, MON_NEAR = 200, MON_DODGE_P = 0.5, MON_JINK = 0.4, MON_DROP_ERR = 4, MON_BACK = 4, MON_PULL = 34, MON_PULL_NEAR = 60;

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const wrapA = a => Math.atan2(Math.sin(a), Math.cos(a));
const rand = (a, b) => a + Math.random() * (b - a);
const r2 = v => Math.round(v * 100) / 100;
const fwd = (h, p) => [Math.sin(h) * Math.cos(p), Math.sin(p), Math.cos(h) * Math.cos(p)];

// the highest ground or roof within m of (x, z) (the water's surface on the river)
const SQ = [];
function topNear(x, z, m) {
  let t = surfaceY(x, z);
  for (const s of M.solidsIn(x - m, z - m, x + m, z + m, SQ)) { const h = s.top ?? s.h; if (h > t) t = h; }
  return t;
}
// how high the ground and the roofs reach along the first 300 units of the way in from (x, z) towards the middle (game/plane.ts ridge)
function ridge(x, z) {
  const l = Math.hypot(x, z) || 1; let top = 0;
  for (let s = 0; s <= 300; s += 15) top = Math.max(top, topNear(x - x / l * s, z - z / l * s, 15));
  return top;
}

// (re)spawn at its team's edge of the airspace (a point of game/plane.ts's circle on the team's side, as far from the enemies as it
// allows), facing the middle, above the hills on the way in
function spawn(b, ctx) {
  let best = null, bs = -Infinity;
  for (let i = 0; i < 16; i++) {
    const a = i / 16 * Math.PI * 2, x = Math.sin(a) * SPAWN_R, z = Math.cos(a) * SPAWN_R;
    if (!homeSide(b.team, x) || Math.abs(x) < PLANE_SIDE_X) continue;
    let d = 1400; for (const o of ctx.veh) if (o.id !== b.id && o.team !== b.team) d = Math.min(d, Math.hypot(o.x - x, o.z - z));
    for (const o of ctx.veh) if (o.id !== b.id && o.k === 1 && Math.hypot(o.x - x, o.z - z) < 80) d -= 2000;   // not into another plane
    const sc = d + Math.random() * 200; if (sc > bs) { bs = sc; best = a; }
  }
  if (best === null) best = b.team === 0 ? -Math.PI / 2 : Math.PI / 2;
  const x = Math.sin(best) * SPAWN_R, z = Math.cos(best) * SPAWN_R, h = Math.atan2(-x, -z);
  Object.assign(b, {
    x, z, h, y: Math.max(SPAWN_Y, ridge(x, z) + 25), p: 0, v: SPAWN_V, roll: 0, thr: 0.75, aimY: h, aimP: 0, stall: false,
    gunCd: 0, gun: 1, bombs: BOMBS, bombT: 0, bombCd: 0, role: 'patrol', tgt: -1, thinkT: rand(0.5, 1.5), burstT: 0, pauseT: rand(1, 2),
    berr: [0, 0], egressT: 0, chaseT: 0, offT: 0, run: false, rerr: [0, 0], dropped: 0, lookT: 0, ahead: 0, crashed: false, a0: 0, a1: 0,
    jinkT: 0, jinkDir: 1, dodgeI: 0,
  });
}

// what to do next: chase a plane, bomb a depot, strafe a tank, or patrol (see the top)
function think(b, ctx) {
  let foe = null, fd = CHASE_R;
  for (const o of ctx.veh) {
    if (o.team === b.team || o.k !== 1 || o.s) continue;
    const d = Math.hypot(o.x - b.x, o.y - b.y, o.z - b.z); if (d < fd) { fd = d; foe = o; }
  }
  const late = b.role === 'bomb' && b.run && Math.hypot(DEPOTS[b.tgt].x - b.x, DEPOTS[b.tgt].z - b.z) < 160   // the run's last part: finish it
    || b.role === 'mon' && b.run && ctx.mon;
  if (foe && !late && b.offT <= 0) { if (b.role !== 'chase' || b.tgt !== foe.id) { b.role = 'chase'; b.tgt = foe.id; b.chaseT = 0; } return; }
  if (b.egressT > 0 || late) return;
  // issue #26: Velemlok is out: at it (bombs while there are parcels aboard, else the guns)
  if (ctx.mon) {
    if (b.role !== 'mon') { b.role = 'mon'; b.tgt = -1; b.run = false; b.dropped = 0; b.rerr = [rand(-1, 1) * MON_DROP_ERR, rand(-1, 1) * MON_DROP_ERR]; }
    return;
  }
  if (b.bombs > 0) {
    if (b.role === 'bomb' && ctx.depots[b.tgt].hp > 0) return;
    let best = -1, bd = Infinity;
    for (const D of DEPOTS) {
      if (D.team === b.team || ctx.depots[D.i].hp <= 0) continue;
      const d = Math.hypot(D.x - b.x, D.z - b.z) * rand(0.85, 1.2); if (d < bd) { bd = d; best = D.i; }
    }
    if (best >= 0) { b.role = 'bomb'; b.tgt = best; b.run = false; b.dropped = 0; b.rerr = [rand(-1, 1) * DROP_ERR, rand(-1, 1) * DROP_ERR]; return; }
  }
  let tank = null, td = 600;
  for (const o of ctx.veh) {
    if (o.team === b.team || o.k !== 0 || o.s) continue;
    const d = Math.hypot(o.x - b.x, o.z - b.z) - (zoneAt(o.x, o.z, false) >= 0 ? 250 : 0); if (d < td) { td = d; tank = o; }
  }
  if (tank) { b.role = 'strafe'; b.tgt = tank.id; return; }
  b.role = 'patrol'; b.tgt = -1;
}

// the ground, the water, a building (map.ts solidNear, the margins of game/plane.ts crashed), a standing supply depot (issue #24: within
// its r below its top, as client/src/world/objectives.ts depotBody; rules.ts DEPOT_SOLID), Velemlok's body (issue #26: its spheres, as
// game/monster.ts monBody) or another vehicle: destroyed
function crashed(b, ctx) {
  if (b.y < surfaceY(b.x, b.z) + 0.8) return 'ground';
  if (M.solidNear(b.x, b.y, b.z, 0.9, 0.6)) return 'building';
  const m = ctx.mon;
  if (m && b.y < 30 && m.y > -10 && Math.abs(b.x - m.x) < 42 && Math.abs(b.z - m.z) < 42 && monSphHit(m.sph, b.x, b.y, b.z)) return 'monster';
  if (b.y < 12) for (const D of DEPOTS) {
    const dx = b.x - D.x, dz = b.z - D.z;
    if (ctx.depots[D.i].hp > 0 && dx * dx + dz * dz < D.r * D.r && b.y < D.y + D.h && b.y > D.y - 1.5) return 'depot';
  }
  for (const o of ctx.veh) {
    if (o.id === b.id || o.s === 2 || Math.abs(o.x - b.x) > 14 || Math.abs(o.z - b.z) > 14) continue;
    if (o.k === 1 ? Math.hypot(o.x - b.x, o.y - b.y, o.z - b.z) < PLANE_R * 1.1 : o.k === 2 ? shipBox(b.x, b.y, b.z, o.x, o.y, o.z, o.h) : b.y < 3.2 && Math.hypot(o.x - b.x, o.z - b.z) < 3) return 'vehicle';
  }
  return '';
}

// one step of a plane bot; returns what it fires
function step(b, dt, ctx) {
  const out = [];
  b.gunCd -= dt; b.bombCd -= dt; b.egressT -= dt; b.burstT -= dt; b.pauseT -= dt; b.offT -= dt;
  // two planes on each other's tail turn round and round at the same rate: a chase that has not brought a burst for CHASE_T s is given
  // up for OFF_T s (the bot goes about its business)
  if (b.role === 'chase' && (b.chaseT += dt) > CHASE_T) { b.offT = rand(...OFF_T); b.role = 'patrol'; b.thinkT = 0; }
  if (b.bombs < BOMBS && (b.bombT += dt) >= BOMB_RELOAD) { b.bombT = 0; b.bombs++; }
  if ((b.thinkT -= dt) <= 0) { think(b, ctx); b.thinkT = rand(...THINK); }
  if ((b.lookT -= dt) <= 0) {                               // the highest ground or roof ahead (and right under it)
    b.lookT = LOOK_T; const fx = Math.sin(b.h), fz = Math.cos(b.h); let top = -10;
    for (const s of LOOK) top = Math.max(top, topNear(b.x + fx * s, b.z + fz * s, 10));
    b.ahead = top;
  }
  const ground = b.ahead;
  // where to: the point (tx, ty, tz), the throttle, the clearance it keeps, and the vehicle its guns may fire at
  let tx = 0, ty = 0, tz = 0, thr = 0.75, clear = MIN_CLEAR, gunAt = null;
  const find = id => ctx.veh.find(o => o.id === id && o.s !== 2);
  if (b.egressT > 0) {                                          // after a run: straight on and up
    tx = b.x + Math.sin(b.h) * 200; tz = b.z + Math.cos(b.h) * 200; ty = ground + CRUISE + 10; thr = 1; clear = LOW;
  } else if (b.role === 'chase' && find(b.tgt)) {
    const o = find(b.tgt), d = Math.hypot(o.x - b.x, o.y - b.y, o.z - b.z), t = d / (BUL_V + b.v * 0.7);
    tx = o.x + Math.sin(o.h) * Math.cos(o.p) * o.v * t; ty = o.y + Math.sin(o.p) * o.v * t; tz = o.z + Math.cos(o.h) * Math.cos(o.p) * o.v * t;
    thr = d > 120 ? 1 : 0.6; gunAt = o;
  } else if (b.role === 'mon' && ctx.mon && b.bombs > 0) {
    // issue #26: a bombing run on Velemlok's back, leading it by the parcels' fall (about RUN_Y's: 2.5 s)
    const m = ctx.mon, lead = m.v * 2.5;
    [tx, ty, tz, thr, clear] = bombRun(b, m.x + Math.sin(m.h) * lead + b.rerr[0], m.z + Math.cos(m.h) * lead + b.rerr[1], WATER_Y + MON_BACK, ground, out, 'mon');
  } else if (b.role === 'mon' && ctx.mon) {
    // issue #26: no parcels aboard: a dive on its shoulders (the biggest of its spheres), bursts, and up and away at MON_PULL over the
    // water or MON_PULL_NEAR from it (higher and farther than from a tank: rearing up, its head stands 28 over the water)
    const m = ctx.mon, s = m.sph[1], d = Math.hypot(s[0] - b.x, s[1] - b.y, s[2] - b.z), t = d / (BUL_V + b.v * 0.7);
    tx = s[0] + Math.sin(m.h) * m.v * t; ty = s[1] + 1; tz = s[2] + Math.cos(m.h) * m.v * t; thr = 0.7; clear = LOW;
    if (d < 260) gunAt = { x: tx, y: ty, z: tz };
    const hd = Math.hypot(s[0] - b.x, s[2] - b.z);
    if (hd > 260) ty = Math.max(ty, ground + CRUISE * 0.8, MON_GEY_TOP + MON_ABOVE);   // come in high, dive from there
    if (b.y - topNear(b.x, b.z, 8) < MON_PULL || hd < MON_PULL_NEAR) { b.egressT = rand(...EGRESS); b.thinkT = b.egressT; }
  } else if (b.role === 'bomb' && ctx.depots[b.tgt] && ctx.depots[b.tgt].hp > 0) {
    const D = DEPOTS[b.tgt];
    [tx, ty, tz, thr, clear] = bombRun(b, D.x + b.rerr[0], D.z + b.rerr[1], D.y, ground, out, 'bomb');
  } else if (b.role === 'strafe' && find(b.tgt)) {
    const o = find(b.tgt), gy = M.groundH(o.x, o.z), d = Math.hypot(o.x - b.x, gy + 1 - b.y, o.z - b.z), t = d / (BUL_V + b.v * 0.7);
    tx = o.x + Math.sin(o.h) * o.v * t; ty = gy + 1; tz = o.z + Math.cos(o.h) * o.v * t; thr = 0.7; clear = LOW;
    if (d < 260) gunAt = o;
    const hd = Math.hypot(o.x - b.x, o.z - b.z);
    if (hd > 260) ty = Math.max(ty, ground + CRUISE * 0.8);       // come in high, dive from there
    if (b.y - topNear(b.x, b.z, 8) < STRAFE_UP || hd < STRAFE_NEAR) { b.egressT = rand(...EGRESS); b.thinkT = b.egressT; }
  } else {                                                      // patrol: round the middle of Karlín
    if (b.role !== 'patrol') b.thinkT = Math.min(b.thinkT, 0.2);
    const q = ZONES[1], a = Math.atan2(b.x - q.x, b.z - q.z) + 0.6;
    tx = q.x + Math.sin(a) * 220; tz = q.z + Math.cos(a) * 220; ty = ground + CRUISE + 20;
  }
  // issue #26: near Velemlok (and not on a run or a dive at it), over its geysers; one announced under it: maybe noticed (see the top)
  const mon = ctx.mon;
  if (mon) {
    const diving = b.run || (b.role === 'mon' && !b.bombs && b.egressT <= 0) || b.role === 'chase';
    if (!diving && Math.hypot(mon.x - b.x, mon.z - b.z) < MON_NEAR) ty = Math.max(ty, MON_GEY_TOP + MON_ABOVE);
    for (const A of mon.atk) if (A.a === 'geyser' && A.v === b.id && A.i !== b.dodgeI) {
      b.dodgeI = A.i;
      if (Math.random() < MON_DODGE_P) { b.jinkT = A.inS + MON_JINK; b.jinkDir = Math.random() < 0.5 ? -1 : 1; }
    }
  }
  // the aim: towards the point; never steeper than a shallow dive unless strafing; kept over the ground ahead; under AIR_TOP
  b.goal = [tx, ty, tz, clear];
  const hd = Math.hypot(tx - b.x, tz - b.z);
  // (the nose turns towards the aim along the great circle, game/plane.ts: an aim far behind would take it through a loop or a dive,
  // so the aim stays within YAW_MAX of the heading, as the keys keep a player's)
  b.aimY = b.h + clamp(wrapA(Math.atan2(tx - b.x, tz - b.z) + b.berr[0] * (b.burstT > 0 ? 1 : 0) - b.h), -YAW_MAX, YAW_MAX);
  b.aimP = clamp(Math.atan2(ty - b.y, Math.max(hd, 1)) + b.berr[1] * (b.burstT > 0 ? 1 : 0), b.role === 'strafe' || b.role === 'mon' && !b.bombs ? -0.6 : -0.38, 0.5);
  if ((b.jinkT -= dt) > 0) { b.aimY = b.h + b.jinkDir * YAW_MAX; b.aimP = clamp(b.aimP + 0.35, 0.1, 0.5); thr = 1; b.burstT = 0; }
  // no steeper climb than the speed allows (a slow plane stalls: game/plane.ts): level out under 26, nose down a little under 18
  b.aimP = Math.min(b.aimP, clamp((b.v - 18) / 16, -0.12, 0.5));
  if (b.v < 26) thr = 1;
  const over = b.y - ground;
  if (over < clear + 12) b.aimP = Math.max(b.aimP, clamp((clear + 22 - over) / 35, 0.05, b.stall ? 0.1 : 0.6));
  if (b.y > AIR_TOP - 20) b.aimP = Math.min(b.aimP, 0);
  // another plane close ahead: up or down out of its way (a player's plane crashes into a bot's on their screen, and the other way)
  // (where the two come closest within AVOID_T s, both flying straight on: nearer than AVOID, it climbs or dives away and turns right)
  const [vx, vy, vz] = fwd(b.h, b.p);
  for (const o of ctx.veh) {
    if (o.k !== 1 || o.id === b.id || o.s === 2 || Math.abs(o.x - b.x) > 150 || Math.abs(o.z - b.z) > 150) continue;
    const [ox, oy, oz] = fwd(o.h, o.p), rx = o.x - b.x, ry = o.y - b.y, rz = o.z - b.z;
    const wx = ox * o.v - vx * b.v, wy = oy * o.v - vy * b.v, wz = oz * o.v - vz * b.v, w2 = wx * wx + wy * wy + wz * wz;
    const t = w2 > 1 ? clamp(-(rx * wx + ry * wy + rz * wz) / w2, 0, AVOID_T) : 0;
    const mx = rx + wx * t, my = ry + wy * t, mz = rz + wz * t;
    if (Math.hypot(mx, my, mz) < AVOID) { b.aimP = clamp(b.aimP + (my > 0 ? -0.4 : 0.4), -0.5, 0.5); b.aimY += 0.5; b.burstT = 0; }
  }
  // the edge of the airspace: back towards the city (game/plane.ts)
  if (Math.max(Math.abs(b.x), Math.abs(b.z)) > M.AIR_LIM - 40) { b.aimY = b.h + clamp(wrapA(Math.atan2(-b.x, -b.z) - b.h), -YAW_MAX, YAW_MAX); b.aimP = clamp(b.aimP, -0.3, 0.3); }
  b.thr += clamp(thr - b.thr, -0.7 * dt, 0.7 * dt);
  fly(b, dt);
  const why = crashed(b, ctx);
  if (why) { b.y = Math.max(b.y, surfaceY(b.x, b.z) + 0.5); b.crashed = why; return out; }
  // the guns: a burst when the target is in front of the nose and in reach, the two guns taking turns (game/plane.ts)
  if (gunAt) {
    const [nx, ny, nz] = fwd(b.h, b.p), dx = tx - b.x, dy = ty - b.y, dz = tz - b.z, d = Math.hypot(dx, dy, dz) || 1;
    const ang = Math.acos(clamp((nx * dx + ny * dy + nz * dz) / d, -1, 1));
    if (b.burstT <= 0 && b.pauseT <= 0 && ang < GUN_ANG && d < GUN_R && M.segHit(b.x, b.y, b.z, gunAt.x, gunAt.y || M.groundH(gunAt.x, gunAt.z) + 1, gunAt.z) >= 1) {
      b.burstT = rand(...BURST); b.pauseT = b.burstT + rand(...PAUSE); b.berr = [rand(-1, 1) * AIM_ERR, rand(-1, 1) * AIM_ERR]; b.chaseT = 0;
    }
  }
  while (b.burstT > 0 && b.gunCd <= 0 && out.length < 4) {
    b.gunCd += GUN_RATE; b.gun = -b.gun;
    const [mx, my, mz] = fwd(b.h, b.p), lx = Math.cos(b.h) * b.gun * 1.5, lz = -Math.sin(b.h) * b.gun * 1.5;
    const ox = b.x + lx + mx * 1.8, oy = b.y - 0.3 + my * 1.8, oz = b.z + lz + mz * 1.8;
    const cx = b.x + mx * GUN_CONV, cy = b.y + my * GUN_CONV, cz = b.z + mz * GUN_CONV, l = Math.hypot(cx - ox, cy - oy, cz - oz) || 1, sp = (Math.random() - 0.5) * 0.006;
    const ux = (cx - ox) / l + sp, uy = (cy - oy) / l + sp, uz = (cz - oz) / l - sp;
    out.push({ k: 1, x: r2(ox), y: r2(oy), z: r2(oz), vx: r2(ux * BUL_V + mx * b.v), vy: r2(uy * BUL_V + my * b.v), vz: r2(uz * BUL_V + mz * b.v) });
  }
  if (b.gunCd < 0) b.gunCd = 0;
  return out;
}

// A bombing run on (ax, az) at height ay: come in at CRUISE, turn onto it, go down to RUN_Y over it in a shallow dive, drop the parcels
// where the bomb sight says they land on it, pull up and away; then the next run (role `again` while there are parcels aboard).
// Returns the aim point, the throttle and the clearance [tx, ty, tz, thr, clear]; what it drops goes into out.
function bombRun(b, ax, az, ay, ground, out, again) {
  const hd = Math.hypot(ax - b.x, az - b.z), off = Math.abs(wrapA(Math.atan2(ax - b.x, az - b.z) - b.h));
  let tx = ax, tz = az, ty, thr = 0.75, clear = MIN_CLEAR;
  if (!b.run) {
    ty = Math.max(ay + CRUISE, ground + MIN_CLEAR);
    if (hd < RUN_R && off < 0.35) { b.run = true; b.dropped = 0; }
    else if (hd < 120) {                                      // too close to turn onto it: fly out and come round again
      tx = b.x + Math.sin(b.h) * 300; tz = b.z + Math.cos(b.h) * 300;
    }
  } else {
    ty = ay + RUN_Y; thr = 0.65; clear = LOW;
    // where a parcel dropped now lands (game/plane.ts's bomb sight: the parcels' gravity, the plane's speed)
    const [mx, my, mz] = fwd(b.h, b.p), vy = my * b.v, H = Math.max(0, b.y - 1 - ay), t = (vy + Math.sqrt(vy * vy + 2 * SHOT_G * H)) / SHOT_G;
    const lx = b.x + mx * b.v * t, lz = b.z + mz * b.v * t, miss = Math.hypot(lx - ax, lz - az);
    const along = ((ax - lx) * mx + (az - lz) * mz) / (Math.hypot(mx, mz) || 1);     // > 0: it would land short of it
    if (miss < DROP_OK + 2.5 * b.dropped && b.bombs > 0 && b.bombCd <= 0 && b.y - ay < RUN_Y + 40) {
      b.bombs--; b.bombCd = BOMB_CD; b.dropped++;
      out.push({ k: 0, x: r2(b.x), y: r2(b.y - 1), z: r2(b.z), vx: r2(mx * b.v), vy: r2(my * b.v), vz: r2(mz * b.v) });
    }
    if (b.dropped >= 3 || (b.dropped && along < -8) || along < -30 || !b.bombs || off > 1.2) {   // done, or past it: away and round again
      b.run = false; b.egressT = rand(...EGRESS); b.thinkT = b.egressT; b.role = b.bombs || again === 'mon' ? again : 'patrol';
    }
  }
  return [tx, ty, tz, thr, clear];
}

// the flight, as game/plane.ts updateFly: the nose turns towards the aim along the great circle, as fast as the speed allows; the bank;
// the speed (thrust, drag, gravity along the path, the turn's cost); the stall; the move
function fly(b, dt) {
  const [fx, fy, fz] = fwd(b.h, b.p), [ax, ay, az] = fwd(b.aimY, b.aimP);
  const ang = Math.acos(clamp(fx * ax + fy * ay + fz * az, -1, 1));
  const ctrl = b.stall ? 0.12 : clamp((b.v - V_STALL) / (V_TURN - V_STALL), 0.2, 1) * Math.min(1, 40 / b.v);
  const st = Math.min(ang, TURN * ctrl * dt);
  let nx = fx, ny = fy, nz = fz;
  if (st > 1e-6) {
    const s = Math.sin(ang);
    if (s < 1e-3) { const h2 = b.h + st; nx = Math.sin(h2) * Math.cos(b.p); nz = Math.cos(h2) * Math.cos(b.p); }
    else { const w0 = Math.sin(ang - st) / s, w1 = Math.sin(st) / s; nx = fx * w0 + ax * w1; ny = fy * w0 + ay * w1; nz = fz * w0 + az * w1; }
  }
  const nh = Math.atan2(nx, nz);
  let np = Math.asin(clamp(ny / Math.hypot(nx, ny, nz), -1, 1));
  if (b.stall) np += (-1.1 - np) * Math.min(1, dt * 1.2);
  np = clamp(np, -1.45, 1.45);
  const yawRate = wrapA(nh - b.h) / Math.max(dt, 1e-4);
  b.h = nh; b.p = np;
  const bank = clamp(-yawRate * BANK, -1.4, 1.4);
  b.roll += (bank - b.roll) * Math.min(1, dt * 5);
  const thin = b.y > AIR_TOP ? Math.max(0, 1 - (b.y - AIR_TOP) / 60) : 1;
  b.v += (THRUST * (0.12 + 0.88 * b.thr) * thin - DRAG * b.v * b.v - GRAV * Math.sin(b.p) - TURN_DRAG * (st / Math.max(dt, 1e-4)) * b.v) * dt;
  b.v = clamp(b.v, 5, 85);
  if (!b.stall && b.v < V_STALL) b.stall = true;
  else if (b.stall && b.v > V_STALL + 5) b.stall = false;
  const [mx, my, mz] = fwd(b.h, b.p);
  b.x += mx * b.v * dt; b.y += my * b.v * dt - (b.stall ? 3 * dt : 0); b.z += mz * b.v * dt;
  b.x = clamp(b.x, -M.AIR_LIM - 60, M.AIR_LIM + 60); b.z = clamp(b.z, -M.AIR_LIM - 60, M.AIR_LIM + 60);
}

// destroyed: it stops where it is (the browsers draw the blast and the falling pieces when its row says destroyed, as for a player's)
function die(b) { b.v = 0; b.burstT = 0; }
function dying(b) { b.v = 0; }

module.exports = { spawn, step, die, dying, WATER_Y };
