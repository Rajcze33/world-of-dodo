// World of DODO bots: tanks the server drives, so every player sees the same ones (BOT1, BOT2, ...).
//
// A bot drives the street grid from junction to junction. Once a player is within HUNT_R it picks the turns
// that bring it closer, and when the player is in range with no building in between it fires a parcel with
// some lead and some aim error, so a moving target can dodge. The players' clients fly the bot's parcels
// and report the hits like any other player's.
//
// Parcels fired AT a bot are flown here, because the bot lives here: the game's ballistics, the ground and
// the buildings (server/city.js); the cars, the tram and the people of each client are not known here. The
// shooter saw the bot NET_DELAY plus the network delay late, so a parcel is tested against where the bot was
// REWIND_MS ago (in favour of the shooter). A hit follows the game's rules for a tank: slowed for a moment,
// three hits within 8 s destroy it (it lies on its side, then comes back at a junction far from the players,
// immune for a few seconds), and only a hit that takes effect scores.
'use strict';

const { roadC, solidAt, clearLine } = require('./city');

const SPEED = 11;                     // units/s; a player's tank tops out at 24
const HUNT_R = 150, FIRE_MIN = 10, FIRE_MAX = 50;
const AIM_ERR = 0.2, FIRE_CD = [2.5, 4.5];   // radians of random aim error, seconds between parcels: worth 1 point, they should not dominate
const AHEAD = 7, BLOCK_W = 2.6, BLOCK_T = 1.5;   // a tank this close in front stops the bot; after BLOCK_T s it turns back
const SHOT_G = 14, SHOT_UP = 4, SHOT_E = 0.4, LEAD_T = 0.79;
const TANK_L = 2.4, TANK_W = 1.15, TANK_H = 2.1;
const SLOW_T = 2.4, DEAD_T = 3.2, SPAWN_IMMUNE_T = 3, HIT_WINDOW_MS = 8000;   // the same numbers as the players' tanks
const REWIND_MS = 200;

const nbrs = (i, j) => [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]].filter(([a, b]) => a >= 0 && a <= 6 && b >= 0 && b <= 6);
const wrapA = a => Math.atan2(Math.sin(a), Math.cos(a));
const r2 = v => Math.round(v * 100) / 100;
const rand = (a, b) => a + Math.random() * (b - a);

// Turn a player record into a bot.
function initBot(bot, humans) {
  bot.sid = 0;
  placeFar(bot, humans);
}

// (Re)start at a junction far from the players (with some chance in it), heading down a street.
function placeFar(bot, humans) {
  let best = [3, 3], bs = -1;
  for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) {
    let d = 400;
    for (const h of humans) if (h.st) d = Math.min(d, Math.hypot(h.st[1] - roadC(i), h.st[2] - roadC(j)));
    const sc = d + Math.random() * 60;
    if (sc > bs) { bs = sc; best = [i, j]; }
  }
  Object.assign(bot, {
    x: roadC(best[0]), z: roadC(best[1]), h: 0, v: 0, roll: 0, prev: null, from: best, to: null,
    slowT: 0, deadT: 0, immT: bot.st ? SPAWN_IMMUNE_T : 0, hitLog: [], fireCd: rand(2, 4), hist: [],
  });
  bot.to = nextJunction(bot, null);
  bot.h = Math.atan2(roadC(bot.to[0]) - bot.x, roadC(bot.to[1]) - bot.z);
  bot.st = state(bot);
}

// the next junction: towards the target most of the time, otherwise at random (straight on more often); never back
function nextJunction(bot, target) {
  const [i, j] = bot.from, opts = nbrs(i, j).filter(n => !bot.prev || n[0] !== bot.prev[0] || n[1] !== bot.prev[1]);
  if (target && Math.random() < 0.75) {
    return opts.reduce((a, b) => Math.hypot(roadC(a[0]) - target.st[1], roadC(a[1]) - target.st[2])
      <= Math.hypot(roadC(b[0]) - target.st[1], roadC(b[1]) - target.st[2]) ? a : b);
  }
  if (bot.prev && Math.random() < 0.5) {
    const s = [2 * i - bot.prev[0], 2 * j - bot.prev[1]];
    if (opts.some(n => n[0] === s[0] && n[1] === s[1])) return s;
  }
  return opts[Math.random() * opts.length | 0];
}

// the snapshot row, as the clients send theirs: id, x, z, heading, speed, roll, immune after a respawn
const state = b => [b.id, r2(b.x), r2(b.z), Math.round(b.h * 1000) / 1000, r2(b.v), r2(b.roll), b.immT > 0 ? 1 : 0];

// one step of a bot among the people (humans) and every other tank (tanks); returns a parcel to fire, or null
function stepBot(bot, dt, humans, tanks) {
  bot.slowT = Math.max(0, bot.slowT - dt);
  bot.immT = Math.max(0, bot.immT - dt);
  if (bot.deadT > 0) {                                                    // destroyed: roll onto the side, lie there, come back elsewhere
    bot.deadT -= dt;
    bot.roll = Math.min(1, (DEAD_T - bot.deadT) / 0.5) * 1.45;
    bot.v = 0;
    bot.st = state(bot);
    if (bot.deadT <= 0) placeFar(bot, humans);
    return null;
  }

  let target = null, td = HUNT_R;
  for (const h of humans) {
    if (!h.st || h.st[6]) continue;                                       // not a player who has just (re)spawned
    const d = Math.hypot(h.st[1] - bot.x, h.st[2] - bot.z);
    if (d < td) { td = d; target = h; }
  }

  // drive along the street towards the next junction; stop for a tank in the way, turn back if it stays there
  let speed = SPEED * (bot.slowT > 0 ? 0.55 : 1);
  if (target && td < 25) speed *= 0.5;                                   // close to a player: slow down to aim
  let tx = roadC(bot.to[0]), tz = roadC(bot.to[1]), dx = tx - bot.x, dz = tz - bot.z, d = Math.hypot(dx, dz);
  if (d > 0 && tanks.some(o => {
    const ox = o.st[1] - bot.x, oz = o.st[2] - bot.z, a = (ox * dx + oz * dz) / d;
    return a > 0 && a < AHEAD && Math.abs(ox * dz - oz * dx) / d < BLOCK_W;
  })) {
    speed = 0;
    bot.blockT = (bot.blockT || 0) + dt;
    if (bot.blockT > BLOCK_T) {
      [bot.from, bot.to, bot.prev, bot.blockT] = [bot.to, bot.from, null, 0];
      tx = roadC(bot.to[0]); tz = roadC(bot.to[1]); dx = tx - bot.x; dz = tz - bot.z; d = Math.hypot(dx, dz);
    }
  } else bot.blockT = 0;
  if (speed * dt >= d) {
    bot.x = tx; bot.z = tz; bot.prev = bot.from; bot.from = bot.to; bot.to = nextJunction(bot, target);
  } else if (d > 0) {
    bot.x += dx / d * speed * dt; bot.z += dz / d * speed * dt;
  }
  const want = Math.atan2(roadC(bot.to[0]) - bot.x, roadC(bot.to[1]) - bot.z);
  bot.h = wrapA(bot.h + Math.max(-4 * dt, Math.min(4 * dt, wrapA(want - bot.h))));
  bot.v = speed;
  bot.st = state(bot);
  const now = Date.now();
  bot.hist.push({ t: now, x: bot.x, z: bot.z, h: bot.h });
  while (bot.hist.length > 2 && bot.hist[0].t < now - 1000) bot.hist.shift();

  // fire at the player, leading by the parcel's flight time
  bot.fireCd -= dt;
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

// where the bot was at time t (the newest record not later than t)
function botAt(bot, t) {
  let p = bot.hist[0] || bot;
  for (const r of bot.hist) { if (r.t > t) break; p = r; }
  return p;
}

function onTank(p, x, y, z) {
  if (y >= TANK_H) return false;
  const hx = Math.sin(p.h), hz = Math.cos(p.h), dx = x - p.x, dz = z - p.z;
  return Math.abs(dx * hx + dz * hz) < TANK_L && Math.abs(dx * hz - dz * hx) < TANK_W;
}

// Fly the players' parcels one step; onHit(bot, parcel) for each one that reaches a bot.
function flyParcels(parcels, bots, dt, onHit) {
  const then = Date.now() - REWIND_MS;
  const past = bots.map(b => ({ b, p: botAt(b, then) }));
  for (let i = parcels.length - 1; i >= 0; i--) {
    const s = parcels[i];
    s.age += dt;
    let alive = s.age < 6;
    const n = Math.max(1, Math.ceil(Math.hypot(s.vx, s.vy, s.vz) * dt / 0.4)), h = dt / n;
    for (let k = 0; k < n && alive; k++) {
      s.vy -= SHOT_G * h; s.x += s.vx * h; s.y += s.vy * h; s.z += s.vz * h;
      if (solidAt(s.x, s.y, s.z)) { alive = false; break; }               // a building stops it (in the game it bounces off)
      if (s.y < 0.29) {
        s.y = 0.29;
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

// A parcel reached the bot: false if it did not take effect (destroyed already, or just back and immune),
// 'kill' if it was the third hit within 8 s, otherwise true.
function hitBot(bot) {
  if (bot.deadT > 0 || bot.immT > 0) return false;
  const t = Date.now();
  bot.hitLog = bot.hitLog.filter(x => t - x < HIT_WINDOW_MS);
  bot.hitLog.push(t);
  bot.slowT = SLOW_T;
  if (bot.hitLog.length < 3) return true;
  bot.deadT = DEAD_T;
  bot.hitLog = [];
  return 'kill';
}

module.exports = { initBot, stepBot, flyParcels, hitBot };
