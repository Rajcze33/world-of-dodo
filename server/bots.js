// World of DODO bots: vehicles the server drives, so every player sees the same ones (BOT1, BOT2, ...).
//
// World of DODO, issue #24: the bots play for a team (bot.team, 0 A or 1 B; server/server.js fills both teams up to TEAM_SIZE) and drive
// all three vehicles (bot.kind, as a player's row k: 0 a tank, here; 1 a plane, server/planebot.js; 2 a ship, server/shipbot.js). This
// file holds the tanks and what all bots share: (re)spawning, the hits they take, where they were a moment ago. They never aim at a
// teammate. Their parcels, bullets, shells and torpedoes go out as fire messages, like a player's: the people's browsers fly them and
// the person hit decides it; the server flies them too (server/shots.js) against the other team's bots and supply depots.
//
// A tank bot drives the streets from junction to junction. It heads for the nearest ground zone its team does not own (or one an enemy
// tank is in; client/shared/rules.ts ZONES) and stops inside it while it captures it; then on to the next. An enemy tank or ship within
// HUNT_R draws it away (it takes the turns that bring it closer), and when one is in range with no building in between it fires a parcel
// with some lead and some aim error, so a moving target can dodge; with none about it fires at an enemy depot it passes within range.
// It fires its anti-aircraft gun at an enemy plane flying low and close.
//
// World of DODO, issue #16: the streets are the real Karlín's street graph (client/shared/map.ts through server/city.js: NODES,
// EDGES, route), no longer the 7 × 7 grid's junctions. A bot follows a street's centre line from node to node; at a junction it picks
// the next street (towards its target along the shortest way, route(), most of the time; else straight on or at random, never back
// the way it came), turns back short of a dead end or the arena's edge (a third of Karlín's nodes are such ends), slows down to turn
// round a sharp corner, and is pushed off a wall that juts into its street like a player's tank (map.ts solidPush). Issue #24: it starts
// at its team's spawn point (rules.ts TEAM_SPAWNS) farthest from the enemy tanks.
//
// A hit follows the game's rules for the bot's vehicle (HIT_W in server/game.js, as client/src/game/tank.ts): a tank is slowed for a
// moment by a parcel or a shell, three parcels' worth within 8 s destroy it (it lies on its side, then comes back at a spawn point,
// immune for a few seconds); a plane goes down to one parcel or six bullets, a ship to their weight within 20 s; only a hit that takes
// effect scores. The people's shots that reach a bot are flown here (lag compensated, server/shots.js) or, a bullet, reported by the
// shooter (server.js shot).
'use strict';

const {
  NODES, EDGES, SPAWNS, DEPOT, route, nearestNode, nearestEdge, edgeBetween, edgePos, inArena, solidPush, clearLine, clearRay,
} = require('./city');
const { ZONES, DEPOTS, DEPOT_SOLID, TEAM_SPAWNS } = require('../client/shared/rules.ts');
const { HIT_W, HIT_WIN_MS } = require('./game');
const plane = require('./planebot');
const ship = require('./shipbot');

const SPEED = 11;                     // units/s; a player's tank tops out at 24
const HUNT_R = 150, FIRE_MIN = 10, FIRE_MAX = 50;
const AIM_ERR = 0.2, FIRE_CD = [2.5, 4.5];   // radians of random aim error, seconds between parcels: they should not dominate
const AHEAD = 7, BLOCK_W = 2.6, BLOCK_T = 1.5;   // a tank this close in front stops the bot; after BLOCK_T s it turns back
const SHOT_UP = 4, LEAD_T = 0.79;
const LEAD_SHIP = 1.05;               // issue #20: a parcel's flight down to a ship's deck
const SLOW_T = 2.4, DEAD_T = 3.2, SINK_T = 4.6, SPAWN_IMMUNE_T = 3;   // the same numbers as the players' vehicles (game/tank.ts)
// anti-aircraft: reach, the highest plane, seconds between bullets, a burst and the pause after it, aim error (radians), bullet speed.
// A nuisance for a plane that stays low near a bot, not a threat to one that keeps moving.
const AA_R = 60, AA_TOP = 60, AA_RATE = 0.2, AA_BURST = [0.4, 0.8], AA_PAUSE = [3, 5], AA_ERR = 0.16, BUL_V = 170, AA_Y = 2.3;
// issue #16: a bot turns back this far before a dead end or the arena's edge (its nose stays out of the house at the end of a cul-de-sac
// and inside the arena); its circles against the walls, as a player's tank (TANK_C, TANK_CR in client/src/game/tank.ts); a turn sharper
// than TURN_SLOW (radians off its heading) slows it, from TURN_STOP on it turns on the spot (4 rad/s)
const END_M = 4, BOT_C = [-1.55, 0, 1.55], BOT_CR = 1.0, TURN_SLOW = 0.5, TURN_STOP = 1.5;
// issue #24: a tank bot stops this far inside its zone's edge (or, passing through it, where it gets no nearer the middle); it thinks
// again about which zone to take every ZONE_T s; more than ZONE_CROWD teammates heading for a zone make it look for another
const ZONE_IN = 4, ZONE_T = 2.5, ZONE_CROWD = 3;
const VEH = ['tank', 'plane', 'ship'], KIND = ['parcel', 'bullet', 'shell', 'torp'];

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

// at the end of its edge: the next street. Towards the target point (an enemy, its zone) most of the time (the first street of the
// shortest way to the node nearest to it, or else the one leading nearest to it), otherwise straight on more often than not, otherwise
// at random; never back the way it came, except at a dead end
function arrive(bot, target) {
  const e = EDGES[bot.e], n = bot.dir > 0 ? e.b : e.a;
  if (deadEnd(n)) return turnBack(bot);
  const opts = NODES[n].e.filter(k => k !== e.i).map(k => EDGES[k]);
  if (!opts.length) return turnBack(bot);
  const far = o => NODES[o.a === n ? o.b : o.a];
  let next;
  if (target && Math.random() < 0.75) {
    const tx = target.x, tz = target.z, way = route(n, nearestNode(tx, tz));
    const first = way.length > 1 ? edgeBetween(n, way[1]) : null;
    next = first && first.i !== e.i ? first
      : opts.reduce((a, b) => Math.hypot(far(a).x - tx, far(a).z - tz) <= Math.hypot(far(b).x - tx, far(b).z - tz) ? a : b);
  } else if (Math.random() < 0.5) {                                       // straight on: the street leaving closest to its heading
    const h = dirAt(e, bot.s, bot.dir);
    next = opts.reduce((a, b) => Math.abs(wrapA(leave(a, n) - h)) <= Math.abs(wrapA(leave(b, n) - h)) ? a : b);
  } else next = opts[Math.random() * opts.length | 0];
  enter(bot, next, n);
}

// ---------- every bot ----------
// A new bot (a player record: id, name, team, ...) in vehicle kind at its team's side. ctx: the tick's view of the game (server.js)
function initBot(bot, kind, ctx) {
  bot.sid = bot.sid || 0;
  bot.st = null;
  spawn(bot, kind, ctx);
}
// (re)spawn in vehicle kind (0 tank, 1 plane, 2 ship)
function spawn(bot, kind, ctx) {
  const again = !!bot.st;
  bot.kind = kind;
  Object.assign(bot, { deadT: 0, immT: again ? SPAWN_IMMUNE_T : 0, hitLog: [], hist: [], roll: 0, v: 0, y: 0, p: 0 });
  if (kind === 1) plane.spawn(bot, ctx);
  else if (kind === 2) ship.spawn(bot, ctx);
  else placeTank(bot, ctx);
  bot.st = row(bot);
}
// the snapshot row, as the clients send theirs (docs/PROTOCOL.md): id, x, z, heading, speed, roll, 1 immune after a respawn or 2 destroyed,
// the moment (the server sets it every tick); a plane adds 1, its height and pitch; a ship 2, its heave and sinking, pitch, turrets
function row(b) {
  const r = [b.id, r2(b.x), r2(b.z), Math.round(b.h * 1000) / 1000, r2(b.v), r2(b.roll), b.deadT > 0 ? 2 : b.immT > 0 ? 1 : 0, 0];
  if (b.kind === 1) r.push(1, r2(b.y), Math.round(b.p * 1000) / 1000);
  else if (b.kind === 2) r.push(2, r2(b.y), Math.round(b.p * 1000) / 1000, Math.round(b.a0 * 1000) / 1000, Math.round(b.a1 * 1000) / 1000);
  return r;
}

// one step of a bot: returns what it fires now (a list of { k, sid, x, y, z, vx, vy, vz }, k 0 a parcel, 1 a bullet, 2 a shell, 3 a
// torpedo), maybe empty. ctx.play false (the intermission): it moves, but does not fire.
function stepBot(bot, dt, ctx) {
  bot.immT = Math.max(0, bot.immT - dt);
  let out;
  if (bot.deadT > 0) {
    bot.deadT -= dt;
    if (bot.kind === 1) plane.dying(bot, dt); else if (bot.kind === 2) ship.dying(bot, dt); else dyingTank(bot, dt);
    if (bot.deadT <= 0) spawn(bot, ctx.kindFor(bot), ctx);
    out = [];
  } else {
    out = bot.kind === 1 ? plane.step(bot, dt, ctx) : bot.kind === 2 ? ship.step(bot, dt, ctx) : stepTank(bot, dt, ctx);
    if (bot.crashed) { bot.why = bot.crashed; bot.crashed = false; kill(bot); }   // a plane that flew into something
  }
  bot.st = row(bot);
  const now = ctx.now;
  bot.hist.push({ t: now, x: bot.x, y: bot.y, z: bot.z, h: bot.h });
  while (bot.hist.length > 2 && bot.hist[0].t < now - 1000) bot.hist.shift();
  if (!ctx.play || bot.deadT > 0) return [];
  for (const s of out) s.sid = ++bot.sid;
  return out;
}

// A parcel (k 0), a bullet (1), a shell (2) or a torpedo (3) reached the bot: false if it did not take effect (destroyed already, just
// back and immune, or a kind that does nothing to this vehicle), 'kill' if it destroyed it, otherwise true
function hitBot(bot, k = 0) {
  const veh = VEH[bot.kind || 0], w = HIT_W[veh][KIND[k] || 'parcel'];
  if (bot.deadT > 0 || bot.immT > 0 || !w) return false;
  const t = Date.now();
  bot.hitLog = bot.hitLog.filter(x => t - x[0] < HIT_WIN_MS[veh]);
  bot.hitLog.push([t, w]);
  if (!bot.kind && k !== 1) bot.slowT = SLOW_T;
  if (bot.hitLog.reduce((sum, x) => sum + x[1], 0) < 2.999) return true;
  kill(bot);
  return 'kill';
}
// destroyed (a hit, or a plane that flew into something): a tank lies on its side, a plane blows up where it is, a ship sinks
function kill(bot) {
  bot.deadT = bot.kind === 2 ? SINK_T : DEAD_T;
  bot.hitLog = [];
  bot.rollDir = Math.random() < 0.5 ? 1 : -1;
  if (bot.kind === 1) plane.die(bot); else if (bot.kind === 2) ship.die(bot);
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
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k, h: a.h + wrapA(b.h - a.h) * k };
}
// the bots that can be hit, as server/shots.js fly() wants them: where each was lag ms ago
function targets(bots, lag) {
  const t = Date.now() - lag, out = [];
  for (const b of bots) {
    if (b.deadT > 0 || !b.hist) continue;
    const p = botAt(b, t);
    out.push({ b, kind: b.kind || 0, team: b.team, x: p.x, y: p.y || 0, z: p.z, h: p.h });
  }
  return out;
}

// ---------- the tanks ----------
// (Re)start at the team's spawn point farthest from the enemy tanks (with some chance in it), heading along its street the way the
// spawn point faces (towards the middle of the city)
function placeTank(bot, ctx) {
  const list = TEAM_SPAWNS[bot.team] || SPAWNS;
  let best = list[0] || DEPOT.park, bs = -1;
  for (const p of list) {
    let d = 800;
    for (const o of ctx.veh) if (o.id !== bot.id && o.k === 0 && o.team !== bot.team) d = Math.min(d, Math.hypot(o.x - p.x, o.z - p.z));
    for (const o of ctx.veh) if (o.id !== bot.id && o.k === 0 && Math.hypot(o.x - p.x, o.z - p.z) < 8) d -= 400;   // nobody on top of it
    const sc = d + Math.random() * 60;
    if (sc > bs) { bs = sc; best = p; }
  }
  const ne = nearestEdge(best.x, best.z), e = ne.e, at = edgePos(e, ne.s, 0);
  const dir = Math.sin(best.h) * at.hx + Math.cos(best.h) * at.hz >= 0 ? 1 : -1;
  Object.assign(bot, {
    e: e.i, s: ne.s, dir, send: sEnd(e, dir), x: at.x, z: at.z, y: 0, h: Math.atan2(at.hx * dir, at.hz * dir), v: 0, roll: 0, blockT: 0,
    slowT: 0, fireCd: rand(2, 4), aaCd: 0, aaLeft: 0, zone: -1, zoneT: 0, zd: Infinity, hold: false,
  });
}

// where the bot stands: its place on the street, pushed out of a wall that juts into it (as a player's tank: its three circles, the
// deepest overlap first, a few rounds). Issue #24: and out of a standing supply depot (a circle of DEPOT_SOLID · r, as a player's tank in
// client/src/world/objectives.ts depotPush; the depots stand off the carriageways, so a bot on its street never meets one in practice)
function depotPush(px, pz, depots) {
  let best = null;
  for (const D of DEPOTS) {
    if (depots[D.i].hp <= 0) continue;
    const dx = px - D.x, dz = pz - D.z, dd = Math.hypot(dx, dz), pen = D.r * DEPOT_SOLID + BOT_CR - dd;
    if (pen > 1e-4 && (!best || pen > best.pen)) best = { nx: dd > 1e-6 ? dx / dd : 1, nz: dd > 1e-6 ? dz / dd : 0, pen };
  }
  return best;
}
function standAt(bot, depots) {
  const at = edgePos(EDGES[bot.e], bot.s, 0), fx = Math.sin(bot.h), fz = Math.cos(bot.h);
  let x = at.x, z = at.z;
  for (let it = 0; it < 3; it++) {
    let best = null;
    for (const j of BOT_C) {
      const w = solidPush(x + fx * j, z + fz * j, BOT_CR); if (w && (!best || w.pen > best.pen)) best = w;
      const d = depotPush(x + fx * j, z + fz * j, depots); if (d && (!best || d.pen > best.pen)) best = d;
    }
    if (!best) break;
    x += best.nx * best.pen; z += best.nz * best.pen;
  }
  bot.x = x; bot.z = z;
}

function dyingTank(bot, dt) {                                             // destroyed: roll onto the side and lie there
  bot.roll = Math.min(1, (DEAD_T - bot.deadT) / 0.5) * 1.45 * (bot.rollDir || 1);
  bot.v = 0;
}

// The ground zone a tank bot heads for: the nearest one its team does not own outright, or one an enemy tank is in, a little at random
// so that the team spreads, and not one ZONE_CROWD teammates are already heading for; -1 when its team holds them all in peace.
function zoneFor(bot, ctx) {
  let best = -1, bd = Infinity;
  ZONES.forEach((q, i) => {
    if (q.sea) return;
    const z = ctx.zones[i], ours = bot.team === 0 ? z.p >= 100 : z.p <= -100;
    const foe = ctx.veh.some(o => o.team !== bot.team && o.k === 0 && o.s !== 2 && Math.hypot(o.x - q.x, o.z - q.z) <= q.r + 10);
    if (ours && !foe) return;
    const mates = ctx.veh.filter(o => o.bot && o.id !== bot.id && o.team === bot.team && o.o.kind === 0 && o.o.zone === i).length;
    const d = Math.hypot(q.x - bot.x, q.z - bot.z) * rand(0.8, 1.25) + (mates >= ZONE_CROWD ? 400 : 0) + (foe ? -60 : 0);
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

// one step of a tank bot; returns what it fires
function stepTank(bot, dt, ctx) {
  bot.slowT = Math.max(0, bot.slowT - dt);
  // the nearest enemy tank or ship within HUNT_R (not one that has just (re)spawned, nor a plane)
  let target = null, td = HUNT_R;
  for (const o of ctx.veh) {
    if (o.team === bot.team || o.s || o.k === 1) continue;
    const d = Math.hypot(o.x - bot.x, o.z - bot.z);
    if (d < td) { td = d; target = o; }
  }
  // the zone: chosen again every ZONE_T s (and at once when it is taken); inside it, the bot stops and captures
  if ((bot.zoneT -= dt) <= 0 || bot.zone < 0) { const z = zoneFor(bot, ctx); if (z !== bot.zone) { bot.zone = z; bot.zd = Infinity; } bot.zoneT = rand(ZONE_T, ZONE_T * 1.6); }
  let hold = false;
  if (bot.zone >= 0) {
    const q = ZONES[bot.zone], d = Math.hypot(q.x - bot.x, q.z - bot.z), z = ctx.zones[bot.zone];
    const ours = bot.team === 0 ? z.p >= 100 : z.p <= -100;
    const foe = ctx.veh.some(o => o.team !== bot.team && o.k === 0 && o.s !== 2 && Math.hypot(o.x - q.x, o.z - q.z) <= q.r);
    if (ours && !foe) bot.zoneT = 0;                                      // taken: on to the next one
    else if (d <= q.r - ZONE_IN && (d <= q.r * 0.45 || d >= bot.zd - 0.005)) hold = true;
    bot.zd = d;
  }
  bot.hold = hold;
  const goal = target || (bot.zone >= 0 ? ZONES[bot.zone] : null);

  // drive along the street towards the end of its edge; stop for a tank in the way (inside its zone it simply stays), turn back if
  // it stays there
  let speed = hold ? 0 : SPEED * (bot.slowT > 0 ? 0.55 : 1);
  if (target && td < 25) speed *= 0.5;                                   // close to an enemy: slow down to aim
  let want = dirAt(EDGES[bot.e], bot.s, bot.dir);
  const dx = Math.sin(want), dz = Math.cos(want);
  if (speed > 0 && ctx.veh.some(o => {
    if (o.k !== 0 || o.id === bot.id) return false;
    const ox = o.x - bot.x, oz = o.z - bot.z, a = ox * dx + oz * dz;
    return a > 0 && a < AHEAD && Math.abs(ox * dz - oz * dx) < BLOCK_W;
  })) {
    speed = 0;
    bot.blockT = (bot.blockT || 0) + dt;
    const inZone = bot.zone >= 0 && Math.hypot(ZONES[bot.zone].x - bot.x, ZONES[bot.zone].z - bot.z) <= ZONES[bot.zone].r - ZONE_IN;
    if (bot.blockT > BLOCK_T && !inZone) { turnBack(bot); bot.blockT = 0; want = dirAt(EDGES[bot.e], bot.s, bot.dir); }
  } else bot.blockT = 0;
  // round a sharp corner (and at a dead end) it slows down, and turns on the spot before it drives on
  const off = Math.abs(wrapA(want - bot.h));
  if (off > TURN_SLOW) speed *= Math.max(0, 1 - (off - TURN_SLOW) / (TURN_STOP - TURN_SLOW));
  if (speed > 0 || off > 0.01) {
    if (speed * dt >= (bot.send - bot.s) * bot.dir) { bot.s = bot.send; arrive(bot, goal); }
    else bot.s += bot.dir * speed * dt;
    want = dirAt(EDGES[bot.e], bot.s, bot.dir);
    bot.h = wrapA(bot.h + Math.max(-4 * dt, Math.min(4 * dt, wrapA(want - bot.h))));
    standAt(bot, ctx.depots);
  }
  bot.v = speed;

  // fire: a low enemy plane nearby comes first, then the enemy in range (leading by the parcel's flight time), then an enemy depot
  bot.fireCd -= dt;
  const flak = aa(bot, dt, ctx);
  if (flak) return [flak];
  if (bot.fireCd > 0) return [];
  if (target && td >= FIRE_MIN && td <= FIRE_MAX && clearLine(bot.x, bot.z, target.x, target.z)) {
    const lead = target.k === 2 ? LEAD_SHIP : LEAD_T;
    return [parcelAt(bot, target.x + Math.sin(target.h) * target.v * lead, target.z + Math.cos(target.h) * target.v * lead, lead)];
  }
  for (const D of DEPOTS) {
    if (D.team === bot.team || ctx.depots[D.i].hp <= 0) continue;
    const d = Math.hypot(D.x - bot.x, D.z - bot.z);
    if (d >= FIRE_MIN && d <= FIRE_MAX && clearLine(bot.x, bot.z, D.x, D.z)) return [parcelAt(bot, D.x, D.z, LEAD_T)];
  }
  return [];
}
// a parcel from the bot's gun towards (ax, az), to land there after about lead s, with the aim error
function parcelAt(bot, ax, az, lead) {
  const yaw = Math.atan2(ax - bot.x, az - bot.z) + (Math.random() - 0.5) * AIM_ERR;
  const sp = Math.max(14, Math.min(65, (Math.hypot(ax - bot.x, az - bot.z) - 3.1) / lead)) * rand(0.96, 1.04);
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  bot.fireCd = rand(...FIRE_CD);
  return { k: 0, x: r2(bot.x + fx * 3.1), y: 1.5, z: r2(bot.z + fz * 3.1), vx: r2(fx * sp), vy: SHOT_UP, vz: r2(fz * sp) };
}

// a bullet at the nearest low enemy plane in sight, in bursts, or null
function aa(bot, dt, ctx) {
  bot.aaCd -= dt;
  if (bot.aaCd > 0) return null;
  let best = null, bd = AA_R;
  for (const o of ctx.veh) {
    if (o.team === bot.team || o.k !== 1 || o.s || o.y > AA_TOP) continue;   // an enemy plane, not just (re)spawned nor destroyed
    const d = Math.hypot(o.x - bot.x, o.y - AA_Y, o.z - bot.z);
    if (d < bd && clearRay(bot.x, AA_Y, bot.z, o.x, o.y, o.z)) { bd = d; best = o; }
  }
  if (!best) { bot.aaLeft = 0; bot.aaCd = 0.5; return null; }               // look again in half a second
  if (!bot.aaLeft) bot.aaLeft = Math.max(1, Math.round(rand(...AA_BURST) / AA_RATE));
  bot.aaLeft--;
  bot.aaCd = bot.aaLeft > 0 ? AA_RATE : rand(...AA_PAUSE);
  // lead: where the plane will be when the bullet gets there (its row is up to a tick old and the bullet reaches its player later still)
  const { x: px, y: py, z: pz, h: ph, v: pv, p: pp } = best;
  const vx = Math.sin(ph) * Math.cos(pp) * pv, vy = Math.sin(pp) * pv, vz = Math.cos(ph) * Math.cos(pp) * pv;
  let t = bd / BUL_V + 0.08, ax = px, ay = py, az = pz;
  for (let k = 0; k < 2; k++) { ax = px + vx * t; ay = py + vy * t; az = pz + vz * t; t = Math.hypot(ax - bot.x, ay - AA_Y, az - bot.z) / BUL_V + 0.08; }
  const yaw = Math.atan2(ax - bot.x, az - bot.z) + (Math.random() - 0.5) * AA_ERR;
  const pitch = Math.atan2(ay - AA_Y, Math.hypot(ax - bot.x, az - bot.z)) + (Math.random() - 0.5) * AA_ERR;
  const fx = Math.sin(yaw) * Math.cos(pitch), fy = Math.sin(pitch), fz = Math.cos(yaw) * Math.cos(pitch);
  return { k: 1, x: r2(bot.x + fx), y: r2(AA_Y + fy), z: r2(bot.z + fz), vx: r2(fx * BUL_V), vy: r2(fy * BUL_V), vz: r2(fz * BUL_V) };
}

module.exports = { initBot, stepBot, hitBot, kill, botAt, targets };
