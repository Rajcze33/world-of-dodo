// World of DODO bots: tanks the server drives, so every player sees the same ones (BOT1, BOT2, ...).
//
// A bot drives the streets from junction to junction. Once a player is within HUNT_R it takes the turns that
// bring it closer, and when the player is in range with no building in between it fires a parcel with
// some lead and some aim error, so a moving target can dodge. The players' clients fly the bot's parcels
// and report the hits like any other player's.
//
// World of DODO, issue #16: the streets are the real Karlín's street graph (client/shared/map.ts through server/city.js: NODES,
// EDGES, route), no longer the 7 × 7 grid's junctions. A bot follows a street's centre line from node to node; at a junction it picks
// the next street (towards its target along the shortest way, route(), most of the time; else straight on or at random, never back
// the way it came), turns back short of a dead end or the arena's edge (a third of Karlín's nodes are such ends), slows down to turn
// round a sharp corner, and is pushed off a wall that juts into its street like a player's tank (map.ts solidPush). It starts at the
// map's spawn point farthest from the others (SPAWNS).
//
// Parcels fired AT a bot are flown here, because the bot lives here: the game's ballistics, the ground and
// the buildings (server/city.js); the cars, the tram and the people of each client are not known here. The
// shooter saw the bot late (the browser draws everything a little behind the server's clock, plus the network),
// so a parcel is tested against where the bot was then: the parcel's lag, from the moment of the city the
// shooter's browser showed when firing (lag compensation, in favour of the shooter). A hit follows the game's rules for a tank: slowed for a moment,
// three hits within 8 s destroy it (it lies on its side, then comes back at a spawn point far from the players,
// immune for a few seconds), and only a hit that takes effect scores.
//
// Planes (issue #14): a bot does not hunt them, but one flying low and close (AA_R, below AA_TOP) gets bursts of bullets, led by the
// plane's speed and with some aim error; the plane's player decides the hits, as for any parcel. A person's bullets that hit a bot are
// reported by the shooter (server.js shot); they do a quarter of a parcel's damage and do not slow the bot.
'use strict';

const {
  NODES, EDGES, SPAWNS, DEPOT, route, nearestNode, nearestEdge, edgeBetween, edgePos, inArena, solidAt, solidPush, groundH, clearLine, clearRay,
} = require('./city');

const SPEED = 11;                     // units/s; a player's tank tops out at 24
const HUNT_R = 150, FIRE_MIN = 10, FIRE_MAX = 50;
const AIM_ERR = 0.2, FIRE_CD = [2.5, 4.5];   // radians of random aim error, seconds between parcels: worth 1 point, they should not dominate
const AHEAD = 7, BLOCK_W = 2.6, BLOCK_T = 1.5;   // a tank this close in front stops the bot; after BLOCK_T s it turns back
const SHOT_G = 14, SHOT_UP = 4, SHOT_E = 0.4, LEAD_T = 0.79;
const TANK_L = 2.4, TANK_W = 1.15, TANK_H = 2.1;
const SLOW_T = 2.4, DEAD_T = 3.2, SPAWN_IMMUNE_T = 3, HIT_WINDOW_MS = 8000;   // the same numbers as the players' tanks
const BULLET_W = 0.25;                // a bullet's share of a hit (HIT_W in server.js and client/src/game/tank.ts)
// anti-aircraft: reach, the highest plane, seconds between bullets, a burst and the pause after it, aim error (radians), bullet speed.
// A nuisance for a plane that stays low near a bot, not a threat to one that keeps moving (a bot is worth 1 point).
const AA_R = 60, AA_TOP = 60, AA_RATE = 0.2, AA_BURST = [0.4, 0.8], AA_PAUSE = [3, 5], AA_ERR = 0.16, BUL_V = 170, AA_Y = 2.3;
// issue #16: a bot turns back this far before a dead end or the arena's edge (its nose stays out of the house at the end of a cul-de-sac
// and inside the arena); its circles against the walls, as a player's tank (TANK_C, TANK_CR in client/src/game/tank.ts); a turn sharper
// than TURN_SLOW (radians off its heading) slows it, from TURN_STOP on it turns on the spot (4 rad/s)
const END_M = 4, BOT_C = [-1.55, 0, 1.55], BOT_CR = 1.0, TURN_SLOW = 0.5, TURN_STOP = 1.5;

const wrapA = a => Math.atan2(Math.sin(a), Math.cos(a));
const r2 = v => Math.round(v * 100) / 100;
const rand = (a, b) => a + Math.random() * (b - a);

// ---------- the street graph (issue #16) ----------
// A bot is on edge bot.e (an index into EDGES) at bot.s along it from node a, driving towards node b (dir 1) or node a (dir -1), as far
// as bot.send: the node, or END_M short of it at a dead end (a node with one street, or one on the arena's edge).
const deadEnd = n => NODES[n].e.length < 2 || !inArena(NODES[n].x, NODES[n].z, 3);
function sEnd(e, dir) {
  const n = dir > 0 ? e.b : e.a;
  if (!deadEnd(n)) return dir > 0 ? e.len : 0;
  return dir > 0 ? Math.max(e.len / 2, e.len - END_M) : Math.min(e.len / 2, END_M);
}
// the way along edge e in direction dir at s, as a heading
function dirAt(e, s, dir) { const p = edgePos(e, s, 0); return Math.atan2(p.hx * dir, p.hz * dir); }
// onto edge e from its end at node n
function enter(bot, e, n) {
  bot.e = e.i; bot.dir = e.a === n ? 1 : -1; bot.s = bot.dir > 0 ? 0 : e.len; bot.send = sEnd(e, bot.dir);
}
// turn back along the street it is on
function turnBack(bot) { bot.dir = -bot.dir; bot.send = sEnd(EDGES[bot.e], bot.dir); }
// the heading a bot leaves node n with along edge e
const leave = (e, n) => dirAt(e, e.a === n ? 0 : e.len, e.a === n ? 1 : -1);

// at the end of its edge: the next street. Towards the target most of the time (the first street of the shortest way to the node
// nearest to it, or else the one leading nearest to it), otherwise straight on more often than not, otherwise at random; never back
// the way it came, except at a dead end
function arrive(bot, target) {
  const e = EDGES[bot.e], n = bot.dir > 0 ? e.b : e.a;
  if (deadEnd(n)) return turnBack(bot);
  const opts = NODES[n].e.filter(k => k !== e.i).map(k => EDGES[k]);
  if (!opts.length) return turnBack(bot);
  const far = o => NODES[o.a === n ? o.b : o.a];
  let next;
  if (target && Math.random() < 0.75) {
    const tx = target.st[1], tz = target.st[2], way = route(n, nearestNode(tx, tz));
    const first = way.length > 1 ? edgeBetween(n, way[1]) : null;
    next = first && first.i !== e.i ? first
      : opts.reduce((a, b) => Math.hypot(far(a).x - tx, far(a).z - tz) <= Math.hypot(far(b).x - tx, far(b).z - tz) ? a : b);
  } else if (Math.random() < 0.5) {                                       // straight on: the street leaving closest to its heading
    const h = dirAt(e, bot.s, bot.dir);
    next = opts.reduce((a, b) => Math.abs(wrapA(leave(a, n) - h)) <= Math.abs(wrapA(leave(b, n) - h)) ? a : b);
  } else next = opts[Math.random() * opts.length | 0];
  enter(bot, next, n);
}

// Turn a player record into a bot. others: everyone already in (people and bots)
function initBot(bot, others) {
  bot.sid = 0;
  placeFar(bot, others);
}

// (Re)start at the map's spawn point farthest from the other tanks (with some chance in it), heading along its street the way the
// spawn point faces (towards the middle of the city)
function placeFar(bot, others) {
  let best = SPAWNS[0] || DEPOT.park, bs = -1;
  for (const p of SPAWNS) {
    let d = 800;
    for (const o of others) if (o !== bot && o.st && o.st[8] !== 1) d = Math.min(d, Math.hypot(o.st[1] - p.x, o.st[2] - p.z));
    const sc = d + Math.random() * 60;
    if (sc > bs) { bs = sc; best = p; }
  }
  const ne = nearestEdge(best.x, best.z), e = ne.e, at = edgePos(e, ne.s, 0);
  const dir = Math.sin(best.h) * at.hx + Math.cos(best.h) * at.hz >= 0 ? 1 : -1;
  Object.assign(bot, {
    e: e.i, s: ne.s, dir, send: sEnd(e, dir), x: at.x, z: at.z, h: Math.atan2(at.hx * dir, at.hz * dir), v: 0, roll: 0, blockT: 0,
    slowT: 0, deadT: 0, immT: bot.st ? SPAWN_IMMUNE_T : 0, hitLog: [], fireCd: rand(2, 4), hist: [], aaCd: 0, aaLeft: 0,
  });
  bot.st = state(bot);
}

// where the bot stands: its place on the street, pushed out of a wall that juts into it (as a player's tank: its three circles, the
// deepest overlap first, a few rounds)
function standAt(bot) {
  const at = edgePos(EDGES[bot.e], bot.s, 0), fx = Math.sin(bot.h), fz = Math.cos(bot.h);
  let x = at.x, z = at.z;
  for (let it = 0; it < 3; it++) {
    let best = null;
    for (const j of BOT_C) { const w = solidPush(x + fx * j, z + fz * j, BOT_CR); if (w && (!best || w.pen > best.pen)) best = w; }
    if (!best) break;
    x += best.nx * best.pen; z += best.nz * best.pen;
  }
  bot.x = x; bot.z = z;
}

// the snapshot row, as the clients send theirs: id, x, z, heading, speed, roll, 1 immune after a respawn or 2 destroyed (the server adds the time)
const state = b => [b.id, r2(b.x), r2(b.z), Math.round(b.h * 1000) / 1000, r2(b.v), r2(b.roll), b.deadT > 0 ? 2 : b.immT > 0 ? 1 : 0];

// one step of a bot among the people (humans, in tanks or planes) and every other tank (tanks); returns a parcel or a bullet to fire, or null
function stepBot(bot, dt, humans, tanks) {
  bot.slowT = Math.max(0, bot.slowT - dt);
  bot.immT = Math.max(0, bot.immT - dt);
  if (bot.deadT > 0) {                                                    // destroyed: roll onto the side, lie there, come back elsewhere
    bot.deadT -= dt;
    bot.roll = Math.min(1, (DEAD_T - bot.deadT) / 0.5) * 1.45;
    bot.v = 0;
    bot.st = state(bot);
    if (bot.deadT <= 0) placeFar(bot, tanks);
    return null;
  }

  let target = null, td = HUNT_R;
  for (const h of humans) {
    if (!h.st || h.st[6] || h.st[8] === 1) continue;                      // not a player who has just (re)spawned, nor a plane
    const d = Math.hypot(h.st[1] - bot.x, h.st[2] - bot.z);
    if (d < td) { td = d; target = h; }
  }

  // drive along the street towards the end of its edge; stop for a tank in the way, turn back if it stays there
  let speed = SPEED * (bot.slowT > 0 ? 0.55 : 1);
  if (target && td < 25) speed *= 0.5;                                   // close to a player: slow down to aim
  let want = dirAt(EDGES[bot.e], bot.s, bot.dir);
  const dx = Math.sin(want), dz = Math.cos(want);
  if (tanks.some(o => {
    const ox = o.st[1] - bot.x, oz = o.st[2] - bot.z, a = ox * dx + oz * dz;
    return a > 0 && a < AHEAD && Math.abs(ox * dz - oz * dx) < BLOCK_W;
  })) {
    speed = 0;
    bot.blockT = (bot.blockT || 0) + dt;
    if (bot.blockT > BLOCK_T) { turnBack(bot); bot.blockT = 0; want = dirAt(EDGES[bot.e], bot.s, bot.dir); }
  } else bot.blockT = 0;
  // round a sharp corner (and at a dead end) it slows down, and turns on the spot before it drives on
  const off = Math.abs(wrapA(want - bot.h));
  if (off > TURN_SLOW) speed *= Math.max(0, 1 - (off - TURN_SLOW) / (TURN_STOP - TURN_SLOW));
  if (speed * dt >= (bot.send - bot.s) * bot.dir) { bot.s = bot.send; arrive(bot, target); }
  else bot.s += bot.dir * speed * dt;
  want = dirAt(EDGES[bot.e], bot.s, bot.dir);
  bot.h = wrapA(bot.h + Math.max(-4 * dt, Math.min(4 * dt, wrapA(want - bot.h))));
  standAt(bot);
  bot.v = speed;
  bot.st = state(bot);
  const now = Date.now();
  bot.hist.push({ t: now, x: bot.x, z: bot.z, h: bot.h });
  while (bot.hist.length > 2 && bot.hist[0].t < now - 1000) bot.hist.shift();

  // fire at the player, leading by the parcel's flight time; a low plane nearby comes first
  bot.fireCd -= dt;
  const flak = aa(bot, dt, humans);
  if (flak) return flak;
  if (bot.fireCd > 0 || !target || td < FIRE_MIN || td > FIRE_MAX) return null;
  if (!clearLine(bot.x, bot.z, target.st[1], target.st[2])) return null;
  const [, px, pz, ph, pv] = target.st;
  const ax = px + Math.sin(ph) * pv * LEAD_T, az = pz + Math.cos(ph) * pv * LEAD_T;
  const yaw = Math.atan2(ax - bot.x, az - bot.z) + (Math.random() - 0.5) * AIM_ERR;
  const sp = Math.max(14, Math.min(65, (Math.hypot(ax - bot.x, az - bot.z) - 3.1) / LEAD_T)) * rand(0.96, 1.04);
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  bot.fireCd = rand(...FIRE_CD);
  return { sid: ++bot.sid, x: r2(bot.x + fx * 3.1), y: 1.5, z: r2(bot.z + fz * 3.1), vx: r2(fx * sp), vy: SHOT_UP, vz: r2(fz * sp) };
}

// a bullet at the nearest low plane in sight, in bursts, or null
function aa(bot, dt, humans) {
  bot.aaCd -= dt;
  if (bot.aaCd > 0) return null;
  let best = null, bd = AA_R;
  for (const h of humans) {
    const s = h.st;
    if (!s || s[8] !== 1 || s[6] || s[9] > AA_TOP) continue;              // a plane (k 1, altitude y at 9), not just (re)spawned
    const d = Math.hypot(s[1] - bot.x, s[9] - AA_Y, s[2] - bot.z);
    if (d < bd && clearRay(bot.x, AA_Y, bot.z, s[1], s[9], s[2])) { bd = d; best = s; }
  }
  if (!best) { bot.aaLeft = 0; bot.aaCd = 0.5; return null; }               // look again in half a second
  if (!bot.aaLeft) bot.aaLeft = Math.max(1, Math.round(rand(...AA_BURST) / AA_RATE));
  bot.aaLeft--;
  bot.aaCd = bot.aaLeft > 0 ? AA_RATE : rand(...AA_PAUSE);
  // lead: where the plane will be when the bullet gets there (its row is up to a tick old and the bullet reaches its player later still)
  const [, px, pz, ph, pv, , , , , py, pp] = best;
  const vx = Math.sin(ph) * Math.cos(pp) * pv, vy = Math.sin(pp) * pv, vz = Math.cos(ph) * Math.cos(pp) * pv;
  let t = bd / BUL_V + 0.08, ax = px, ay = py, az = pz;
  for (let k = 0; k < 2; k++) { ax = px + vx * t; ay = py + vy * t; az = pz + vz * t; t = Math.hypot(ax - bot.x, ay - AA_Y, az - bot.z) / BUL_V + 0.08; }
  const yaw = Math.atan2(ax - bot.x, az - bot.z) + (Math.random() - 0.5) * AA_ERR;
  const pitch = Math.atan2(ay - AA_Y, Math.hypot(ax - bot.x, az - bot.z)) + (Math.random() - 0.5) * AA_ERR;
  const fx = Math.sin(yaw) * Math.cos(pitch), fy = Math.sin(pitch), fz = Math.cos(yaw) * Math.cos(pitch);
  return { k: 1, sid: ++bot.sid, x: r2(bot.x + fx), y: r2(AA_Y + fy), z: r2(bot.z + fz), vx: r2(fx * BUL_V), vy: r2(fy * BUL_V), vz: r2(fz * BUL_V) };
}

// where the bot was at time t: between the two records around it (a respawn in between is not slid across)
function botAt(bot, t) {
  const h = bot.hist;
  if (!h.length) return bot;
  let i = 0;
  while (i + 1 < h.length && h[i + 1].t <= t) i++;
  const a = h[i], b = h[i + 1];
  if (!b || t <= a.t || Math.hypot(b.x - a.x, b.z - a.z) > 20) return a;
  const k = (t - a.t) / (b.t - a.t);
  return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k, h: a.h + wrapA(b.h - a.h) * k };
}

function onTank(p, x, y, z) {
  if (y >= TANK_H) return false;
  const hx = Math.sin(p.h), hz = Math.cos(p.h), dx = x - p.x, dz = z - p.z;
  return Math.abs(dx * hx + dz * hz) < TANK_L && Math.abs(dx * hz - dz * hx) < TANK_W;
}

// Fly the players' parcels one step; onHit(bot, parcel) for each one that reaches a bot. s.lag: how many ms behind the
// server the shooter saw the city.
function flyParcels(parcels, bots, dt, onHit) {
  const now = Date.now();
  for (let i = parcels.length - 1; i >= 0; i--) {
    const s = parcels[i];
    const past = bots.map(b => ({ b, p: botAt(b, now - (s.lag ?? 200)) }));
    s.age += dt;
    let alive = s.age < 6;
    const n = Math.max(1, Math.ceil(Math.hypot(s.vx, s.vy, s.vz) * dt / 0.4)), h = dt / n;
    for (let k = 0; k < n && alive; k++) {
      s.vy -= SHOT_G * h; s.x += s.vx * h; s.y += s.vy * h; s.z += s.vz * h;
      if (solidAt(s.x, s.y, s.z)) { alive = false; break; }               // a building stops it (in the game it bounces off)
      // the ground as in the game (client/src/game/shots.ts): the street, the pavement, the terrain outside the arena (issue #16)
      const g0 = groundH(s.x, s.z), gy = (g0 > 0 ? g0 : g0 + 0.04) + 0.25;
      if (s.y < gy) {
        s.y = gy;
        if (s.vy < 0) { s.vy = -s.vy * SHOT_E; s.vx *= 0.78; s.vz *= 0.78; if (s.vy < 1.8) s.vy = 0; }
        if (s.vy === 0) {
          const f = Math.max(0, 1 - 4 * h); s.vx *= f; s.vz *= f;
          if (Math.hypot(s.vx, s.vz) < 0.4) { alive = false; break; }
        }
      }
      for (const { b, p } of past) if (onTank(p, s.x, s.y, s.z)) { onHit(b, s); alive = false; break; }
    }
    if (!alive) parcels.splice(i, 1);
  }
}

// A parcel (k 0) or a bullet (k 1) reached the bot: false if it did not take effect (destroyed already, or just back and immune),
// 'kill' if the hits within 8 s add up to three parcels' worth, otherwise true.
function hitBot(bot, k = 0) {
  if (bot.deadT > 0 || bot.immT > 0) return false;
  const t = Date.now();
  bot.hitLog = bot.hitLog.filter(x => t - x[0] < HIT_WINDOW_MS);
  bot.hitLog.push([t, k === 1 ? BULLET_W : 1]);
  if (k !== 1) bot.slowT = SLOW_T;
  if (bot.hitLog.reduce((sum, x) => sum + x[1], 0) < 2.999) return true;
  bot.deadT = DEAD_T;
  bot.hitLog = [];
  return 'kill';
}

module.exports = { initBot, stepBot, flyParcels, hitBot };
