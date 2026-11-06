// World of DODO: the multiplayer server.
//
// It serves the game (client/dist, built from client/ by `npm run build`) and relays the players over one WebSocket at /ws. It does not simulate the
// players: each client drives its own tank, sends where the tank is 20 times a second and gets everyone's
// tanks back in one snapshot per tick. A parcel fired by one player is passed on
// to the others, who fly the same parcel in their own world. Whether it hits is decided by the player it
// hits (on that screen the target tank is exactly where it is), and the server scores it for the shooter.
//
// The bots (BOT1, BOT2, ...) are the exception: they live here (server/bots.js), so this server drives them,
// fires their parcels and decides when a parcel hits one of them. So does the life of the city (server/world.js):
// the cars, the tram and the pedestrians move here and everyone gets the same picture of them. A car a player's
// tank shoves is that player's until it comes to rest: their browser moves it and the server passes it on.
//
// A player flies a plane or drives a tank (issue #14; k in the state row). Planes fire bullets: the shooter's browser decides what its
// bullets hit (there the others are drawn a little in the past, and a fast plane would be out of reach otherwise), the server passes
// the hit on to the victim, who applies it unless immune and answers like a parcel hit. A bot fires bullets at low planes.
//
// Issue #20: or a player sails a warship on the Vltava (k 2), which fires shells (fire k 2) and torpedoes (fire k 3). Both are slow: the
// victim decides them as it decides parcels, and the server flies the shells against the bots as it flies the parcels. A ship's row
// counts only on the river (client/shared/naval.ts), and only a ship may fire shells and torpedoes.
//
// Issue #24: the team game. Every player and bot is in team A (0) or B (1) (hello asks, the server balances), teammates do not hurt each
// other and score nothing for it, and the server keeps the objectives authoritatively (server/game.js, client/shared/rules.ts): the
// team scores, the zones the tanks and the ships capture, the supply depots the planes (and the tanks' parcels, the ships' shells) destroy
// (a player's browser reports where its projectile hit one, thit), the rounds with their intermission. It tells everyone in obj. The bots
// fill both teams up to TEAM_SIZE and drive tanks (server/bots.js), fly planes (server/planebot.js) and sail ships (server/shipbot.js);
// the server flies their fire against the other team's bots and depots (server/shots.js).
//
// Issue #26: Velemlok, a giant salamander in the Vltava that both teams fight (server/monster.js, client/shared/monster.ts). The server
// decides when it comes and goes, where it swims and whom it attacks; it announces its attacks (mon) and every browser applies them to
// its own vehicle (the bots' are decided here); a player's browser reports where its projectile hit it (mhit), the bots' fire at it is
// flown here; the team that dealt more damage gets a bonus when it leaves (mres). Its pose goes out in snap.g, its state in obj.g.
//
// Timing, as in the usual snapshot interpolation of network games: every row of a snapshot carries the moment it
// describes on this server's clock (ms since the start). A player's row gets the moment the player's browser
// took it, mapped onto the server's clock (see state()), so the pace of their tank survives the network and
// the tick. The browsers draw everything a fixed delay behind the server's clock, between two such rows.
//
// Everything lives in memory: a player is a name, a colour and a score for as long as they are connected.
// Nothing is written anywhere.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const B = require('./bots');
const { fly } = require('./shots');
const game = require('./game');
const monster = require('./monster');                // issue #26: Velemlok
const world = require('./world');
const { AIR_LIM } = require('./city');
const N = require('../client/shared/naval.ts');      // issue #20: the Vltava for the ships (the same file the page runs)
const { DEPOTS, DEPOT_DMG, DEPOT_NEAR } = game.R;    // issue #24: client/shared/rules.ts

const PORT = Number(process.env.PORT) || 3000;
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 24;     // people; the bots come on top
// issue #24: the members of a team, people and bots (env TEAM_SIZE, rules.ts's 6 by default); the old BOTS (a number of bots) is gone
const TEAM_SIZE = game.TEAM_SIZE;
const CLIENT_DIR = path.join(__dirname, '..', 'client');
let DIST_DIR = path.join(CLIENT_DIR, 'dist');         // the built game page (npm run build: Vite, TypeScript, Babylon.js)
// (DIST_DIR in the environment points it at another build, so that several test builds can run side by side)
if (process.env.DIST_DIR) DIST_DIR = path.resolve(process.env.DIST_DIR);
const TICK_MS = 50;                // snapshot rate, 20 Hz (the clients send at the same rate)
const REWIND_MAX_MS = 400;         // a parcel aimed at a bot is tested against where the bot was up to this long ago
const SHOT_TTL_MS = 15000;         // a parcel can score this long after it was fired (it lives 14 s in the game)
const REJOIN_MS = 60000;           // a player who lost the connection and comes back from the same page keeps the score
const HEARTBEAT_MS = 15000;        // ping every socket; one that has not answered since the last ping is dropped
const MSG_PER_SEC = 90;            // a client sends 20 states, a ping, at most ~4 parcels and a few hits a second
const NAME_MAX = 16;
// World of DODO, issue #16: a row or a parcel farther than WORLD from the middle is ignored. The planes fly within ±AIR_LIM (about 650,
// client/shared/map.ts) and are turned back up to 60 past it (client/src/game/plane.ts); the tanks stay in the arena, well inside.
const WORLD = AIR_LIM + 70;
const BULLET_TTL_MS = 3000;        // a bullet can score this long after it was fired (it flies 1.6 s in the game)
const BULLET_RANGE = 400;          // a bullet hit claimed by a shooter farther than this from the victim is ignored
const PLANE = 1;                   // the vehicle kind of a state row (k): 0 or nothing a tank, 1 a plane, 2 a ship (issue #20)
const SHIP = 2;
// issue #20: what was fired (fire k): 0 a parcel, 1 a bullet, 2 a ship's shell, 3 a torpedo; how long each can score after it was fired
// (a parcel lives 14 s, a bullet flies 1.6 s, a shell at most 5, a torpedo runs 16: client/src/game/shells.ts)
const SHELL = 2, TORP = 3;
const SCORE_TTL_MS = [15000, 3000, 10000, 20000];
// a ship's speed cap (13 at full), how far over a bank its row may be (its circles keep it off: rounding, a bridge pier's corner), the
// fastest shell (110 from the muzzle) and torpedo (22) the server passes on
const SHIP_V = 15, SHIP_LAND = 2, SHELL_V_MAX = 125, TORP_V_MAX = 25;
// issue #24: a depot hit (thit) counts from a shooter at most this far (parcel, bullet, shell) from where it hit, and this much off the
// depot (the browser saw it a moment earlier, rounding)
const THIT_RANGE = [120, 400, 400], THIT_SLACK = 1.5;
// issue #26: a hit on Velemlok (mhit) counts from a shooter at most this far (parcel, bullet, shell, torpedo) from where it hit, and
// where its hitbox was in the last MHIT_BACK_MS give or take MHIT_SLACK (the browser drew it a moment ago, rounding)
const MHIT_RANGE = [120, 400, 400, 400], MHIT_SLACK = 3, MHIT_BACK_MS = 600;
// at most this many of the server's projectiles in flight (the people's at the bots, the bots' own)
const FLY_MAX = 600;
// the objectives (obj) go out once a second, and on a change at once but not more often than this (ms)
const OBJ_MIN_MS = 200;

// Points for a hit that takes effect: its share of what destroys the vehicle (HIT_W in server/game.js, the same numbers as in
// client/src/game/tank.ts), times 10 for a person: three parcels or twelve bullets destroy a tank, one parcel or six bullets a plane, so a
// person is worth 10 a parcel and 3 a bullet in a tank, 30 and 5 in a plane. Issue #20: a shell weighs a parcel in a tank and in a plane; a
// ship takes 0.35 a shell, 1.5 a torpedo, 0.75 a parcel and 0.08 a bullet (4, 15, 8 and 1 points; its hits add up over 20 s in the
// browser, a tank's and a plane's over 8). Issue #24: a bot (a tank, a plane or a ship) is worth half of that, rounded, at least 1; every
// point a player or a bot scores counts for its team too (game.addScore), and a hit on a teammate scores nothing.

// The tank colours a player can pick when joining; client/index.html offers the same list (TANK_COLORS).
// Grey is the bots' and red is REDLINE's, so neither is on it.
const COLORS = [0x00a99a, 0xf9aa8f, 0x4d8dff, 0xf2c94c, 0x9b6bff, 0xff7eb6, 0x5ad1e6, 0xff9f43, 0xa3d977, 0xeaebeb, 0x7b8cff, 0xc59b6d];
const BOT_COLOR = 0x8f9997;

// ---------- static files ----------
// Only the page and the folders it loads from; anything else is a 404.
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',          // the font licenses next to the fonts
};
// The built page's folders (app: the scripts Vite built, named by their content, so they never change under the same name).
// Anything else is a 404. World of DODO, issue #16: client/shared is no longer served: the page has the map and the construction site
// in its built script (Vite bundles client/shared), the server requires the same files (server/city.js).
const STATIC_DIRS = { app: DIST_DIR, fonts: DIST_DIR, assets: DIST_DIR, licenses: DIST_DIR };
// The page loads its scripts from this host, keeps its styles inline and connects only to this host's /ws.
const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' ws: wss:",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ');

// enc: the encodings the browser accepts (Accept-Encoding); a .br or .gz copy written by the build (tools/compress.js) goes out
// instead of the file when there is one
function sendFile(res, file, cache, enc = '') {
  const takes = name => String(enc || '').split(',').some(e => e.trim().split(';')[0] === name);
  const alt = takes('br') ? ['.br', 'br'] : takes('gzip') ? ['.gz', 'gzip'] : null;
  if (alt) {
    return fs.stat(file + alt[0], (err, st) => {
      if (err || !st.isFile()) return sendFile(res, file, cache);
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Content-Encoding': alt[1],
        'Content-Length': st.size,
        'Cache-Control': cache,
        'Vary': 'Accept-Encoding',
        'X-Content-Type-Options': 'nosniff',
      });
      fs.createReadStream(file + alt[0]).pipe(res);
    });
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      if (file === path.join(DIST_DIR, 'index.html')) {        // the server runs, but nobody built the page
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('The game is not built yet: run npm run build');
      }
      return notFound(res);
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(file).pipe(res);
  });
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return notFound(res);
  }
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    // issue #24: + how long the ticks take (ms: the mean and the longest of the last 200)
    return res.end(JSON.stringify({ ok: true, players: humans().length, bots: bots().length, tick: tickStats() }));
  }
  if (pathname === '/' || pathname === '/index.html') {
    res.setHeader('Content-Security-Policy', PAGE_CSP);
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    return sendFile(res, path.join(DIST_DIR, 'index.html'), 'no-cache', req.headers['accept-encoding']);
  }
  const top = pathname.split('/')[1];
  if (!Object.hasOwn(STATIC_DIRS, top)) return notFound(res);
  const root = STATIC_DIRS[top];
  const file = path.resolve(root, '.' + pathname);
  if (!file.startsWith(path.join(root, top) + path.sep)) return notFound(res);
  sendFile(res, file, top === 'app' ? 'public, max-age=31536000, immutable' : 'public, max-age=86400', req.headers['accept-encoding']);
});

// ---------- players ----------
const players = new Map();         // id -> player (people and bots)
const recent = new Map();          // key -> { name, pts, team, until }: who left a moment ago, for a rejoin
const flying = [];                 // what the server flies (server/shots.js): the people's shots at the bots, the bots' own
let nextId = 1, joins = 0;
const humans = () => [...players.values()].filter(p => !p.bot);
const bots = () => [...players.values()].filter(p => p.bot);
const humansIn = t => humans().filter(p => p.team === t).length;
const botsIn = t => bots().filter(p => p.team === t);

// The name is all a player gives us. Shown on the tank, in the scoreboard and in messages, always as text.
// Control, format and invisible characters go (bidi overrides, zero-width), and so do < and >.
function cleanName(s) {
  if (typeof s !== 'string') return '';
  const t = s.normalize('NFC').replace(/[\p{C}<>]/gu, '').replace(/\s+/g, ' ').trim();
  return Array.from(t).slice(0, NAME_MAX).join('').trim();
}

const sameName = (a, b) => a.localeCompare(b, 'cs', { sensitivity: 'accent' }) === 0;
const botName = s => /^bot\s*\d+$/i.test(s);       // BOT1, bot 2, ...: the bots' names, not for people

function pickColor(asked) {
  if (COLORS.includes(asked)) return asked;
  const used = new Set(humans().map(p => p.color));
  return COLORS.find(c => !used.has(c)) ?? COLORS[nextId % COLORS.length];
}

// issue #24: + team (0 A, 1 B)
const pub = p => ({ id: p.id, name: p.name, color: p.color, pts: p.pts, bot: !!p.bot, team: p.team });

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}

function broadcast(msg, except) {
  const data = JSON.stringify(msg);
  for (const p of players.values()) if (p !== except) send(p.ws, data);
}

const num = (v, lim) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= lim;
// the server's clock for the snapshots: ms since the start, monotonic (a clock adjustment of the machine must not jump it)
const clock = () => Math.round(performance.now());

// issue #24: + the player's team and the game's state (obj without its t: scores, zones, depots, round; issue #26: and Velemlok, g)
const objState = now => ({ ...game.state(now), g: monster.state() });
function welcome(p) {
  send(p.ws, { t: 'welcome', id: p.id, name: p.name, color: p.color, pts: p.pts, team: p.team,
    players: [...players.values()].filter(o => o !== p).map(pub), props: world.propsDown(), game: objState(clock()) });
}

// Issue #24: the team a joining person goes into. Asked for a team (0 or 1; or coming back, the team they had): that one, unless it
// already has 2 or more people than the other, then the other. Auto: the team with fewer people (a tie: the one with fewer points,
// then A).
function pickTeam(asked, back) {
  const n = [humansIn(0), humansIn(1)];
  const t = asked === 0 || asked === 1 ? asked : back && (back.team === 0 || back.team === 1) ? back.team : -1;
  if (t >= 0) return n[t] - n[1 - t] >= 2 ? 1 - t : t;
  if (n[0] !== n[1]) return n[0] < n[1] ? 0 : 1;
  const sc = game.G.sc;
  return sc[1] < sc[0] ? 1 : 0;
}

function hello(ws, m) {
  if (ws.player) return;
  const name = cleanName(m.name);
  const key = typeof m.key === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(m.key) ? m.key : null;
  if (!name) return refuse(ws, 'name_invalid');
  if (botName(name)) return refuse(ws, 'name_reserved');
  const holder = [...players.values()].find(p => sameName(p.name, name));
  if (holder) {
    // The same page reconnecting before its old socket was noticed as dead: the new socket takes over (and keeps the team).
    if (!key || holder.key !== key) return refuse(ws, 'name_taken');
    holder.ws.player = null;
    holder.ws.terminate();
    holder.ws = ws;
    ws.player = holder;
    return welcome(holder);
  }
  if (humans().length >= MAX_PLAYERS) return refuse(ws, 'full');
  if (!humans().length) { game.newRound(clock()); monster.reset(clock()); }   // the first person in: a new round (the bots drive out below)
  const back = key && recent.get(key);
  const known = back && sameName(back.name, name);
  const p = {
    id: nextId++, ws: null, name, key, color: pickColor(m.color), team: pickTeam(m.team, known ? back : null), join: ++joins,
    pts: known ? back.pts : 0, st: null, shots: new Map(),
  };
  if (back) recent.delete(key);
  players.set(p.id, p);
  fillBots();                                           // a bot of their team makes room (the others hear it before p arrives)
  p.ws = ws;
  ws.player = p;
  welcome(p);
  broadcast({ t: 'join', p: pub(p) }, p);
  console.log(`join #${p.id} team ${p.team} (${humans().length} online)`);
}

function refuse(ws, code) {
  send(ws, { t: 'err', code });
  ws.close(4000, code);
}

function leave(ws) {
  const p = ws.player;
  if (!p || p.ws !== ws) return;
  ws.player = null;
  players.delete(p.id);
  if (p.key) recent.set(p.key, { name: p.name, pts: p.pts, team: p.team, until: Date.now() + REJOIN_MS });
  world.dropOwner(p.id);                                // the cars they were pushing go back to the traffic
  broadcast({ t: 'leave', id: p.id });
  if (!humans().length) removeBots();                   // nobody left to play with: the bots go home
  else fillBots();                                      // a bot takes their place
  console.log(`leave #${p.id} (${humans().length} online)`);
}

// A player's tank or plane (and the cars a tank pushes, field c). ct is the moment the browser took it, on the browser's own clock. Its offset
// to the server's clock is the smallest arrival delay seen so far (a report that came faster shows the true offset better; the
// estimate creeps up slowly in case the route got longer), so the stamp keeps the browser's pace whatever the network does.
// A plane (k 1) also has its altitude y and pitch p; they go at the end of its row. Issue #20: a ship (k 2) its heave and sinking y
// (0 afloat, down to -12), pitch p and its turrets' yaw a [fore, aft]; it counts only on the river, give or take SHIP_LAND.
function state(p, m) {
  const k = m.k === PLANE || m.k === SHIP ? m.k : 0;
  if (!num(m.x, WORLD) || !num(m.z, WORLD) || !num(m.h, 100) || !num(m.v, k === PLANE ? 90 : k === SHIP ? SHIP_V : 40) || !num(m.r, 4)) return;
  if (k === PLANE && (!num(m.y, 400) || m.y < 0 || !num(m.p, 2))) return;
  if (k === SHIP && (!num(m.y, 12) || m.y > 1 || !num(m.p, 1) || !Array.isArray(m.a) || m.a.length !== 2 || !num(m.a[0], 7) || !num(m.a[1], 7)
    || N.bankDist(m.x, m.z) < -SHIP_LAND)) return;
  const now = clock();
  let ts = now;
  if (num(m.ct, 1e12)) {
    const off = now - m.ct;
    p.off = p.off === undefined || off < p.off ? off : p.off + (off - p.off) * 0.01;
    ts = Math.round(m.ct + p.off);
  }
  if (p.st && ts <= p.st[7]) ts = p.st[7] + 1;
  p.st = [p.id, m.x, m.z, m.h, m.v, m.r, m.s === 1 || m.s === 2 ? m.s : 0, ts];  // s: 1 just (re)spawned and immune (the others draw it blinking), 2 destroyed
  if (k === PLANE) p.st.push(PLANE, m.y, m.p);
  else if (k === SHIP) p.st.push(SHIP, m.y, m.p, m.a[0], m.a[1]);
  else if (Array.isArray(m.c)) world.carsFrom(p.id, { x: m.x, z: m.z }, m.c, ts);
}

// k: what was fired, 0 a parcel, 1 a bullet, 2 a shell, 3 a torpedo
function remember(p, sid, k = 0) {
  const now = Date.now();
  p.shots.set(sid, { t: now, scored: false, k });
  if (p.shots.size > 120) for (const [s, v] of p.shots) if (now - v.t > Math.max(SHOT_TTL_MS, SCORE_TTL_MS[TORP])) p.shots.delete(s);
}

// A parcel (from a tank's gun or dropped from a plane) or, with k 1, a bullet. Issue #20: with k 2 a ship's shell, with k 3 a torpedo,
// only from a player whose row is a ship; a torpedo runs on the water (y at the surface, no vy) at its speed, a shell no faster than
// from the muzzle. Issue #24: nothing is fired in the intermission between two rounds.
function fire(p, m) {
  if (!game.playing()) return;
  if (!Number.isInteger(m.sid) || m.sid < 1) return;
  if (!num(m.x, WORLD) || !num(m.y, 400) || !num(m.z, WORLD) || !num(m.vx, 300) || !num(m.vy, 300) || !num(m.vz, 300)) return;
  const k = m.k === 1 || m.k === SHELL || m.k === TORP ? m.k : 0;
  if (k >= SHELL && !(p.st && p.st[8] === SHIP)) return;
  if (k === SHELL && Math.hypot(m.vx, m.vy, m.vz) > SHELL_V_MAX) return;
  if (k === TORP && (Math.abs(m.y - N.WATER_Y) > 1 || m.vy !== 0 || Math.hypot(m.vx, m.vz) > TORP_V_MAX)) return;
  remember(p, m.sid, k);
  const shot = { t: 'fire', id: p.id, sid: m.sid, x: m.x, y: m.y, z: m.z, vx: m.vx, vy: m.vy, vz: m.vz };
  if (k) shot.k = k;
  broadcast(shot, p);
  if (k === 1) return;                                  // a bullet's hits are reported by the shooter (shot, thit)
  // rt: the moment of the city the shooter saw when firing (server clock); the bots are tested where they were then. Issue #24: only the
  // other team's bots (and since then the torpedoes too: at the bot ships)
  const lag = num(m.rt, 1e12) ? Math.max(0, Math.min(REWIND_MAX_MS, clock() - m.rt)) : 200;
  if (bots().some(b => b.team !== p.team) && flying.length < FLY_MAX) flying.push({ ...shot, k, by: p.id, team: p.team, bot: false, age: 0, lag });
}

// A scoring hit: once per parcel or bullet (or shell, torpedo), only for one the shooter really fired and only while it can still fly. The
// points follow from what hit what (game.hitPoints): the victim's vehicle is in its state row (a bot's: its kind). Issue #24: a hit on a
// teammate scores nothing (the victim's browser ignores it too), nor does anything in the intermission; the points count for the team.
function score(shooter, victim, sid, kill) {
  const shot = shooter && shooter !== victim && shooter.shots.get(sid);
  if (!shot || shot.scored || Date.now() - shot.t > (shot.k === 1 ? BULLET_TTL_MS : SCORE_TTL_MS[shot.k])) return;
  shot.scored = true;
  if (shooter.team === victim.team || !game.playing()) return;
  const veh = victim.bot ? victim.kind || 0 : (victim.st && victim.st[8]) || 0;
  const gain = game.hitPoints(veh, shot.k, !!victim.bot);
  shooter.pts += gain;
  game.addScore(shooter.team, gain);
  broadcast({ t: 'hit', by: shooter.id, v: victim.id, pts: shooter.pts, gain, kill: !!kill });
}

// A person reports that a parcel or a bullet hit them (and whether that hit destroyed their tank or plane).
function hit(victim, m) {
  if (!Number.isInteger(m.sid)) return;
  score(players.get(m.by), victim, m.sid, m.kill === true);
}

// A person's bullet hit someone on their screen. A bot takes it here; a person gets it passed on (dmg) and answers with hit if it took effect.
// Issue #24: not a teammate.
function shot(p, m) {
  const v = players.get(m.v), s = Number.isInteger(m.sid) && p.shots.get(m.sid);
  if (!v || v === p || v.team === p.team || !s || s.k !== 1 || s.scored || Date.now() - s.t > BULLET_TTL_MS || !p.st || !v.st) return;
  if (Math.hypot(p.st[1] - v.st[1], p.st[2] - v.st[2]) > BULLET_RANGE) return;
  if (!v.bot) return send(v.ws, { t: 'dmg', by: p.id, sid: m.sid });
  const fx = B.hitBot(v, 1);
  if (fx) score(p, v, m.sid, fx === 'kill'); else s.scored = true;
}

// Issue #24: a person's projectile hit supply depot i on their screen: k 0 a parcel, 1 a bullet, 2 a shell, at (x, y, z). It counts once
// per projectile (sid), only one they really fired of that kind and only while it can still fly, only from a living player of the other
// team within THIT_RANGE of where it hit, and only where the depot is (rules.ts depotAt, give or take THIT_SLACK); game.js applies it.
function thit(p, m) {
  const k = m.k, i = m.i, D = DEPOTS[i], s = Number.isInteger(m.sid) && p.shots.get(m.sid);
  if (!D || !Number.isInteger(i) || !(k === 0 || k === 1 || k === 2) || !num(m.x, WORLD) || !num(m.y, 400) || !num(m.z, WORLD)) return;
  if (D.team === p.team || !p.st || p.st[6] === 2 || !s || s.k !== k || s.depot || Date.now() - s.t > SCORE_TTL_MS[k]) return;
  if (Math.hypot(p.st[1] - m.x, p.st[2] - m.z) > THIT_RANGE[k]) return;
  const R = (k === 1 ? D.r : D.r + DEPOT_NEAR) + THIT_SLACK;
  if (Math.hypot(m.x - D.x, m.z - D.z) > R || m.y > D.y + D.h + THIT_SLACK) return;
  s.depot = true;
  if (game.hitDepot(i, DEPOT_DMG[['parcel', 'bullet', 'shell'][k]], p.team, clock()) === 2) credit(p, game.R.DEPOT_PTS, false);
}

// Issue #26: a person's projectile hit Velemlok on their screen: k 0 a parcel, 1 a bullet, 2 a shell, 3 a torpedo, at (x, y, z). It counts
// once per projectile (sid), only one they really fired of that kind and while it can still score, only while Velemlok is out and the
// round is on, only from a living player within MHIT_RANGE of where it hit, and only where its hitbox was a moment ago (server/monster.js
// hitAt); both teams may hit it. Its damage counts for the player and their team (obj.g at once).
function mhit(p, m) {
  const k = m.k, s = Number.isInteger(m.sid) && p.shots.get(m.sid), now = clock();
  if (!(k === 0 || k === 1 || k === SHELL || k === TORP) || !num(m.x, WORLD) || !num(m.y, 400) || !num(m.z, WORLD) || !game.playing()) return;
  if (!p.st || p.st[6] === 2 || !s || s.k !== k || s.mon || Date.now() - s.t > (k === 1 ? BULLET_TTL_MS : SCORE_TTL_MS[k])) return;
  if (Math.hypot(p.st[1] - m.x, p.st[2] - m.z) > MHIT_RANGE[k] || !monster.hitAt(m.x, m.y, m.z, MHIT_SLACK, MHIT_BACK_MS, now)) return;
  s.mon = true;
  monster.damage(p, k, now);
}

// Points outside the hits (issue #24): a zone a player or a bot helped take (CAP_PTS, for its team too), a depot it destroyed (DEPOT_PTS;
// game.hitDepot already gave them to the team). Everyone learns the new personal points from a pts message.
function credit(pl, pts, team) {
  if (!pl || !game.playing()) return;
  pl.pts += pts; if (team) game.addScore(pl.team, pts);
  broadcast({ t: 'pts', id: pl.id, pts: pl.pts, gain: pts });
}

// Issue #26: what Velemlok needs from the server: to tell everyone (mon, mres), to hit a bot (its attacks score for nobody; a slam rocks
// a ship), to give the personal points of the fight and the team's bonus
monster.init({
  broadcast,
  hitBot(id, A) {
    const b = players.get(id); if (!b || !b.bot) return;
    if (B.hitBot(b, 4) && A.a === 'slam' && b.kind === 2) b.heel = (b.heel || 0) + (Math.random() < 0.5 ? -0.2 : 0.2);
  },
  credit: (id, pts) => credit(players.get(id), pts, false),
  teamScore: (team, pts) => game.addScore(team, pts),
});

// A person's tank or parcel hit a pedestrian (index i, pushed along vx, vz): the fall happens in the shared world.
function ped(p, m) {
  if (!Number.isInteger(m.i) || !num(m.vx, 120) || !num(m.vz, 120) || !p.st) return;
  world.hitPed(m.i, m.vx, m.vz, { x: p.st[1], z: p.st[2] });
}

// A person's tank knocked a tree or a lamp down (index i in the client's list of props, falling towards fx, fz).
function prop(p, m) {
  if (!Number.isInteger(m.i) || m.i < 0 || m.i > 5000 || !num(m.fx, 1.01) || !num(m.fz, 1.01)) return;
  if (world.propDown(m.i, m.fx, m.fz)) broadcast({ t: 'prop', i: m.i, fx: m.fx, fz: m.fz }, p);
}

// ---------- bots ----------
// Issue #24: the tick's view of the game for the bots (server/bots.js): every vehicle with a row as { o, id, team, bot, k, x, y, z, h, v,
// p, s }, the zones and the depots, whether the round is on, and which vehicle a bot takes when it (re)spawns
function view() {
  const veh = [];
  for (const o of players.values()) {
    const s = o.st; if (!s) continue;
    const k = s[8] || 0;
    veh.push({ o, id: o.id, team: o.team, bot: !!o.bot, k, x: s[1], z: s[2], h: s[3], v: s[4], s: s[6], y: k ? s[9] : 0, p: k ? s[10] : 0 });
  }
  // (issue #26: + Velemlok while it can be hit, server/monster.js view)
  return { now: Date.now(), veh, zones: game.G.zones, depots: game.G.depots, play: game.playing(), kindFor: b => kindFor(b.team, b), mon: monster.view(clock()) };
}
// The vehicle a bot of team t takes (other than bot `but`): a plane if nobody of the team flies one, a ship if nobody sails one, else a
// tank (a person's vehicle is the one in their row)
function kindFor(t, but) {
  let plane = false, ship = false;
  for (const o of players.values()) {
    if (o === but || o.team !== t) continue;
    const k = o.bot ? o.kind : o.st ? o.st[8] || 0 : 0;
    if (k === 1) plane = true; else if (k === 2) ship = true;
  }
  return !plane ? 1 : !ship ? 2 : 0;
}
// Bots fill each team up to TEAM_SIZE members, people counted: a person who comes in replaces a bot of their team at once (a tank first),
// one who leaves gets a bot in their place. A team's bots fly a plane and sail a ship when no person of the team does, the rest drive tanks.
function fillBots() {
  for (const t of [0, 1]) {
    const want = humans().length ? Math.max(0, TEAM_SIZE - humansIn(t)) : 0;
    let list = botsIn(t);
    while (list.length > want) {
      const b = list.find(x => x.kind === 0) || list.find(x => kindFor(t, x) !== x.kind) || list[list.length - 1];
      players.delete(b.id); broadcast({ t: 'leave', id: b.id });
      list = list.filter(x => x !== b);
    }
    while (list.length < want) { list.push(addBot(t)); }
  }
}
function addBot(t) {
  const used = new Set(bots().map(b => b.name));
  let n = 1; while (used.has('BOT' + n)) n++;
  const b = { id: nextId++, bot: true, ws: null, key: null, name: 'BOT' + n, color: BOT_COLOR, pts: 0, shots: new Map(), team: t, join: 0 };
  B.initBot(b, kindFor(t, null), view());               // at its team's side, far from the enemies
  players.set(b.id, b);
  broadcast({ t: 'join', p: pub(b) });
  return b;
}

function removeBots() {
  for (const b of bots()) { players.delete(b.id); broadcast({ t: 'leave', id: b.id }); }
  flying.length = 0;
}

// the bots drive and fire (what they fire goes to everyone and into the server's own flight, against the other team's bots and depots);
// then the server flies everything it flies: a hit on a bot scores for the shooter, a bot's hit on a depot damages it. Issue #26: and
// everything stops on Velemlok; a bot's hit on it counts (a person's comes as mhit). v: the tick's view (view())
function stepBots(dt, v) {
  const list = bots();
  if (!list.length) return;
  for (const b of list) {
    for (const s of B.stepBot(b, dt, v)) {
      remember(b, s.sid, s.k);
      const m = { t: 'fire', id: b.id, sid: s.sid, x: s.x, y: s.y, z: s.z, vx: s.vx, vy: s.vy, vz: s.vz };
      if (s.k) m.k = s.k;
      broadcast(m);
      if (flying.length < FLY_MAX) flying.push({ ...m, k: s.k, by: b.id, team: b.team, bot: true, age: 0, lag: 0 });
    }
  }
  fly(flying, dt, lag => B.targets(list, lag), (b, s) => {
    const fx = B.hitBot(b, s.k);                        // a parcel, a bullet, a shell or a torpedo
    if (fx) score(players.get(s.by), b, s.sid, fx === 'kill');
  }, (i, s) => {
    const r = game.hitDepot(i, DEPOT_DMG[s.k === SHELL ? 'shell' : s.k === 1 ? 'bullet' : 'parcel'], s.team, clock());
    if (r === 2) credit(players.get(s.by), game.R.DEPOT_PTS, false);
    return r;
  }, v.mon && { x: v.mon.x, z: v.mon.z, sph: v.mon.sph, hit: s => { if (s.bot && game.playing()) monster.damage(players.get(s.by) || { id: s.by, team: s.team }, s.k, clock()); } });
}

// ---------- rounds (issue #24) ----------
// the round's best: the three with the most points, people and bots
const best = () => [...players.values()].sort((a, b) => b.pts - a.pts || a.id - b.id).slice(0, 3).filter(p => p.pts > 0).map(p => [p.id, p.pts]);
// A new round: everyone's points are 0 again (the browsers zero their scoreboards when obj.r.st turns from end to play, and bring their
// vehicles back in their half), the teams are evened out (the most recently joined people of a team that has 2 or more more than the
// other go over, told by a team message), the bots fill the teams again and come back at their side.
function newRound() {
  for (const p of players.values()) p.pts = 0;
  for (const r of recent.values()) r.pts = 0;
  flying.length = 0;
  for (;;) {
    const d = humansIn(0) - humansIn(1); if (Math.abs(d) < 2) break;
    const from = d > 0 ? 0 : 1, p = humans().filter(h => h.team === from).sort((a, b) => b.join - a.join)[0];
    p.team = 1 - from;
    broadcast({ t: 'team', id: p.id, team: p.team });
  }
  fillBots();
  const v = view();
  for (const b of bots()) B.initBot(b, kindFor(b.team, b), v);
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });

server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { /* bad URL */ }
  if (pathname !== '/ws') return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

wss.on('connection', ws => {
  ws.alive = true;
  ws.player = null;
  ws.budget = MSG_PER_SEC;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (data, isBinary) => {
    ws.alive = true;
    if (isBinary || --ws.budget < 0) return;
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hello') return hello(ws, m);
    const p = ws.player;
    if (!p) return;
    if (m.t === 'st') state(p, m);
    else if (m.t === 'fire') fire(p, m);
    else if (m.t === 'hit') hit(p, m);
    else if (m.t === 'shot') shot(p, m);
    else if (m.t === 'thit') thit(p, m);
    else if (m.t === 'mhit') mhit(p, m);
    else if (m.t === 'ped') ped(p, m);
    else if (m.t === 'prop') prop(p, m);
    else if (m.t === 'ping' && num(m.c, 1e12)) send(ws, { t: 'pong', c: m.c });   // the client's ping readout
  });
  ws.on('close', () => leave(ws));
  ws.on('error', () => {});
});

// Each tick: the bots drive and fire, the city moves on (in two half steps: its code was written for browser frames), the team game
// steps (issue #24: the zones, the depots, the round), then one snapshot goes to everyone: every tank, plane and ship, the cars and the
// tram; every second tick also the pedestrians; the objectives (obj) once a second and at once when something changed. The cars and the
// tram stop for the tanks only.
// ts: the server's clock now, the moment of the bots, the traffic and the tram; n: the tick (the same for everyone).
// TICK: how long the ticks take (ms; /health shows the mean and the longest of the last 200, and the mean processor time: the time
// includes waiting for a busy machine, the processor time only what the tick itself took)
let lastTick = Date.now(), tick = 0, lastObj = 0;
const TICK = { ms: [], cpu: [], i: 0 };
setInterval(() => {
  const t0 = performance.now(), c0 = process.cpuUsage(), now = Date.now(), dt = Math.min(0.2, (now - lastTick) / 1000);
  lastTick = now;
  if (!humans().length) return;                         // nobody to watch: the city waits
  const v = view();
  stepBots(dt, v);
  const t1 = performance.now(), ts = clock(), p = [], tanks = [], capture = [];
  for (const pl of players.values()) {
    if (!pl.st) continue;
    if (pl.bot) pl.st[7] = ts;
    p.push(pl.st);
    const k = pl.st[8] || 0;
    if (!k) tanks.push({ x: pl.st[1], z: pl.st[2], h: pl.st[3], v: pl.st[4] });   // (the cars stop for the tanks only)
    if (k !== PLANE && pl.st[6] !== 2) capture.push({ id: pl.id, team: pl.team, k, x: pl.st[1], z: pl.st[2] });
  }
  for (let k = 0; k < 2; k++) for (const i of world.step(dt / 2, tanks)) broadcast({ t: 'prop', i, up: 1 });
  const t2 = performance.now(), ev = game.step(dt, ts, capture, best);
  for (const c of game.G.captured.splice(0)) for (const id of c.ids) credit(players.get(id), game.R.CAP_PTS, true);
  if (ev === 'end') { flying.length = 0; monster.roundEnd(ts, game.G.endAt); }
  else if (ev === 'new') { newRound(); monster.reset(ts); }
  // issue #26: Velemlok (it surfaces, swims, attacks, leaves; its attacks on the bots land here)
  monster.step(dt, ts, v.veh, game.playing());
  tick++;
  const g = monster.row();
  broadcast({ t: 'snap', ts, n: tick, p, ...world.fast(), ...(g ? { g } : {}) });
  if (tick % 2 === 0) broadcast({ t: 'w', ts, n: tick, ...world.slow() });
  // (a change goes out at once, but at most every OBJ_MIN_MS: in a busy fight the hits change the scores every tick)
  if (((game.G.dirty || monster.M.dirty) && ts - lastObj >= OBJ_MIN_MS) || ts - lastObj >= 1000) {
    game.G.dirty = false; monster.M.dirty = false; lastObj = ts; broadcast({ t: 'obj', ...objState(ts) });
  }
  const c = process.cpuUsage(c0), t3 = performance.now();
  TICK.cpu[TICK.i % 200] = (c.user + c.system) / 1000;
  TICK.ms[TICK.i++ % 200] = t3 - t0;
  // a tick that takes longer than a second says where the time went (the bots and their fire, the city, the team game and the messages)
  if (t3 - t0 > 1000) console.log(`slow tick: ${Math.round(t3 - t0)} ms (cpu ${Math.round((c.user + c.system) / 1000)}): bots ${Math.round(t1 - t0)}, city ${Math.round(t2 - t1)}, game, Velemlok and sending ${Math.round(t3 - t2)}; ${bots().length} bots, ${flying.length} in flight`);
}, TICK_MS);
const tickStats = () => {
  const l = TICK.ms, r2 = v => Math.round(v * 100) / 100; if (!l.length) return { avg: 0, max: 0, cpu: 0 };
  return { avg: r2(l.reduce((s, v) => s + v, 0) / l.length), max: r2(Math.max(...l)), cpu: r2(TICK.cpu.reduce((s, v) => s + v, 0) / TICK.cpu.length) };
};

// The message budget refills once a second.
setInterval(() => { for (const ws of wss.clients) ws.budget = MSG_PER_SEC; }, 1000);

// Drop sockets that stopped answering; forget players who left too long ago to rejoin.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const [key, r] of recent) if (r.until < now) recent.delete(key);
}, HEARTBEAT_MS);

// 0.0.0.0: on Zerops the balancer reaches the container over the project network.
server.listen(PORT, '0.0.0.0', () => console.log(`World of DODO on :${PORT}, teams of ${TEAM_SIZE}, rounds to ${game.ROUND_POINTS} points or ${game.ROUND_SEC} s; Velemlok (${monster.MAX_HP} HP) ${monster.FIRST_S} s into a round, every ${monster.EVERY_S} s, for ${monster.LIFE_S} s`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    for (const ws of wss.clients) ws.close(1001, 'server restart');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
