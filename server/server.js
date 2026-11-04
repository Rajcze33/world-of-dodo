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
const { initBot, stepBot, flyParcels, hitBot } = require('./bots');
const world = require('./world');

const PORT = Number(process.env.PORT) || 3000;
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 24;     // people; the bots come on top
const BOTS = Math.max(0, Math.min(8, Number(process.env.BOTS ?? 3)));
const CLIENT_DIR = path.join(__dirname, '..', 'client');
const DIST_DIR = path.join(CLIENT_DIR, 'dist');         // the built game page (npm run build: Vite, TypeScript, Babylon.js)
const SHARED_DIR = path.join(CLIENT_DIR, 'shared');     // data the server uses too (the construction site), loaded by the page as it is
const TICK_MS = 50;                // snapshot rate, 20 Hz (the clients send at the same rate)
const REWIND_MAX_MS = 400;         // a parcel aimed at a bot is tested against where the bot was up to this long ago
const SHOT_TTL_MS = 15000;         // a parcel can score this long after it was fired (it lives 14 s in the game)
const REJOIN_MS = 60000;           // a player who lost the connection and comes back from the same page keeps the score
const HEARTBEAT_MS = 15000;        // ping every socket; one that has not answered since the last ping is dropped
const MSG_PER_SEC = 90;            // a client sends 20 states, a ping, at most ~4 parcels and a few hits a second
const NAME_MAX = 16;
const WORLD = 520;                 // the tanks' world ends at 250 units from the centre, the planes' airspace at 450
const BULLET_TTL_MS = 3000;        // a bullet can score this long after it was fired (it flies 1.6 s in the game)
const BULLET_RANGE = 400;          // a bullet hit claimed by a shooter farther than this from the victim is ignored
const PLANE = 1;                   // the vehicle kind of a state row (k): 0 or nothing a tank, 1 a plane

// Points for a hit that takes effect: its share of what destroys the vehicle (HIT_W, the same numbers as in client/src/game/tank.ts),
// times 10 for a person. Three parcels or twelve bullets destroy a tank, one parcel or six bullets a plane: a person is worth 10 a parcel
// and 3 a bullet in a tank, 30 and 5 in a plane. A bot (always a tank) is worth 1 a parcel, and 1 for the bullet that destroys it.
const POINTS_PLAYER = 10;
const POINTS_BOT = 1;
const HIT_W = { tank: { parcel: 1, bullet: 0.25 }, plane: { parcel: 3, bullet: 0.5 } };

// The tank colours a player can pick when joining; client/index.html offers the same list (TANK_COLORS).
// Grey is the bots' and red is REDLINE's, so neither is on it.
const COLORS = [0x00a99a, 0xf9aa8f, 0x4d8dff, 0xf2c94c, 0x9b6bff, 0xff7eb6, 0x5ad1e6, 0xff9f43, 0xa3d977, 0xeaebeb, 0x7b8cff, 0xc59b6d];
const BOT_COLOR = 0x8f9997;

// ---------- static files ----------
// Only the page and the three folders it loads from; anything else is a 404.
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',          // the font licenses next to the fonts
};
// The built page's folders (app: the scripts Vite built, named by their content, so they never change under the same name)
// and the shared data. Anything else is a 404.
const STATIC_DIRS = { app: DIST_DIR, fonts: DIST_DIR, assets: DIST_DIR, licenses: DIST_DIR, shared: CLIENT_DIR };
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
    return res.end(JSON.stringify({ ok: true, players: humans().length, bots: bots().length }));
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
const recent = new Map();          // key -> { name, pts, until }: who left a moment ago, for a rejoin
const parcels = [];                // the people's parcels in flight, flown here against the bots
let nextId = 1;
const humans = () => [...players.values()].filter(p => !p.bot);
const bots = () => [...players.values()].filter(p => p.bot);

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

const pub = p => ({ id: p.id, name: p.name, color: p.color, pts: p.pts, bot: !!p.bot });

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

function welcome(p) {
  send(p.ws, { t: 'welcome', id: p.id, name: p.name, color: p.color, pts: p.pts,
    players: [...players.values()].filter(o => o !== p).map(pub), props: world.propsDown() });
}

function hello(ws, m) {
  if (ws.player) return;
  const name = cleanName(m.name);
  const key = typeof m.key === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(m.key) ? m.key : null;
  if (!name) return refuse(ws, 'name_invalid');
  if (botName(name)) return refuse(ws, 'name_reserved');
  const holder = [...players.values()].find(p => sameName(p.name, name));
  if (holder) {
    // The same page reconnecting before its old socket was noticed as dead: the new socket takes over.
    if (!key || holder.key !== key) return refuse(ws, 'name_taken');
    holder.ws.player = null;
    holder.ws.terminate();
    holder.ws = ws;
    ws.player = holder;
    return welcome(holder);
  }
  if (humans().length >= MAX_PLAYERS) return refuse(ws, 'full');
  if (!humans().length) addBots();                      // the first person in: the bots drive out
  const back = key && recent.get(key);
  const p = {
    id: nextId++, ws, name, key, color: pickColor(m.color),
    pts: back && sameName(back.name, name) ? back.pts : 0,
    st: null, shots: new Map(),
  };
  if (back) recent.delete(key);
  players.set(p.id, p);
  ws.player = p;
  welcome(p);
  broadcast({ t: 'join', p: pub(p) }, p);
  console.log(`join #${p.id} (${humans().length} online)`);
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
  if (p.key) recent.set(p.key, { name: p.name, pts: p.pts, until: Date.now() + REJOIN_MS });
  world.dropOwner(p.id);                                // the cars they were pushing go back to the traffic
  broadcast({ t: 'leave', id: p.id });
  if (!humans().length) removeBots();                   // nobody left to play with: the bots go home
  console.log(`leave #${p.id} (${humans().length} online)`);
}

// A player's tank or plane (and the cars a tank pushes, field c). ct is the moment the browser took it, on the browser's own clock. Its offset
// to the server's clock is the smallest arrival delay seen so far (a report that came faster shows the true offset better; the
// estimate creeps up slowly in case the route got longer), so the stamp keeps the browser's pace whatever the network does.
// A plane (k 1) also has its altitude y and pitch p; they go at the end of its row.
function state(p, m) {
  const plane = m.k === PLANE;
  if (!num(m.x, WORLD) || !num(m.z, WORLD) || !num(m.h, 100) || !num(m.v, plane ? 90 : 40) || !num(m.r, 4)) return;
  if (plane && (!num(m.y, 400) || m.y < 0 || !num(m.p, 2))) return;
  const now = clock();
  let ts = now;
  if (num(m.ct, 1e12)) {
    const off = now - m.ct;
    p.off = p.off === undefined || off < p.off ? off : p.off + (off - p.off) * 0.01;
    ts = Math.round(m.ct + p.off);
  }
  if (p.st && ts <= p.st[7]) ts = p.st[7] + 1;
  p.st = [p.id, m.x, m.z, m.h, m.v, m.r, m.s === 1 || m.s === 2 ? m.s : 0, ts];  // s: 1 just (re)spawned and immune (the others draw it blinking), 2 destroyed
  if (plane) p.st.push(PLANE, m.y, m.p);
  else if (Array.isArray(m.c)) world.carsFrom(p.id, { x: m.x, z: m.z }, m.c, ts);
}

// k: what was fired, 0 a parcel, 1 a bullet
function remember(p, sid, k = 0) {
  const now = Date.now();
  p.shots.set(sid, { t: now, scored: false, k });
  if (p.shots.size > 120) for (const [s, v] of p.shots) if (now - v.t > SHOT_TTL_MS) p.shots.delete(s);
}

// A parcel (from a tank's gun or dropped from a plane) or, with k 1, a bullet.
function fire(p, m) {
  if (!Number.isInteger(m.sid) || m.sid < 1) return;
  if (!num(m.x, WORLD) || !num(m.y, 400) || !num(m.z, WORLD) || !num(m.vx, 300) || !num(m.vy, 300) || !num(m.vz, 300)) return;
  const k = m.k === 1 ? 1 : 0;
  remember(p, m.sid, k);
  const shot = { t: 'fire', id: p.id, sid: m.sid, x: m.x, y: m.y, z: m.z, vx: m.vx, vy: m.vy, vz: m.vz };
  if (k) shot.k = 1;
  broadcast(shot, p);
  if (k) return;                                        // a bullet's hits are reported by the shooter (shot)
  // rt: the moment of the city the shooter saw when firing (server clock); the bots are tested where they were then
  const lag = num(m.rt, 1e12) ? Math.max(0, Math.min(REWIND_MAX_MS, clock() - m.rt)) : 200;
  if (players.size > humans().length && parcels.length < 300) parcels.push({ ...shot, by: p.id, age: 0, lag });
}

// A scoring hit: once per parcel or bullet, only for one the shooter really fired and only while it can still fly. The points
// follow from what hit what (HIT_W): the victim's vehicle is in its state row.
function score(shooter, victim, sid, kill) {
  const shot = shooter && shooter !== victim && shooter.shots.get(sid);
  if (!shot || shot.scored || Date.now() - shot.t > (shot.k ? BULLET_TTL_MS : SHOT_TTL_MS)) return;
  shot.scored = true;
  const gain = victim.bot ? (shot.k ? (kill ? POINTS_BOT : 0) : POINTS_BOT)
    : Math.round(POINTS_PLAYER * HIT_W[victim.st && victim.st[8] === PLANE ? 'plane' : 'tank'][shot.k ? 'bullet' : 'parcel']);
  shooter.pts += gain;
  broadcast({ t: 'hit', by: shooter.id, v: victim.id, pts: shooter.pts, gain, kill: !!kill });
}

// A person reports that a parcel or a bullet hit them (and whether that hit destroyed their tank or plane).
function hit(victim, m) {
  if (!Number.isInteger(m.sid)) return;
  score(players.get(m.by), victim, m.sid, m.kill === true);
}

// A person's bullet hit someone on their screen. A bot takes it here; a person gets it passed on (dmg) and answers with hit if it took effect.
function shot(p, m) {
  const v = players.get(m.v), s = Number.isInteger(m.sid) && p.shots.get(m.sid);
  if (!v || v === p || !s || s.k !== 1 || s.scored || Date.now() - s.t > BULLET_TTL_MS || !p.st || !v.st) return;
  if (Math.hypot(p.st[1] - v.st[1], p.st[2] - v.st[2]) > BULLET_RANGE) return;
  if (!v.bot) return send(v.ws, { t: 'dmg', by: p.id, sid: m.sid });
  const fx = hitBot(v, 1);
  if (fx) score(p, v, m.sid, fx === 'kill'); else s.scored = true;
}

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
function addBots() {
  for (let i = 1; i <= BOTS; i++) {
    const b = { id: nextId++, bot: true, ws: null, key: null, name: 'BOT' + i, color: BOT_COLOR, pts: 0, shots: new Map() };
    initBot(b, humans());
    players.set(b.id, b);
    broadcast({ t: 'join', p: pub(b) });
  }
}

function removeBots() {
  for (const b of bots()) { players.delete(b.id); broadcast({ t: 'leave', id: b.id }); }
  parcels.length = 0;
}

// people: everyone the bots can shoot at (tanks get parcels, low planes bullets); the tanks block a bot's way, the planes do not
function stepBots(dt) {
  const people = humans(), list = bots();
  if (!list.length) return;
  for (const b of list) {
    const shot = stepBot(b, dt, people, [...players.values()].filter(o => o !== b && o.st && o.st[8] !== PLANE));
    if (!shot) continue;
    remember(b, shot.sid, shot.k || 0);
    broadcast({ t: 'fire', id: b.id, ...shot });
  }
  flyParcels(parcels, list, dt, (b, s) => {
    const fx = hitBot(b, 0);
    if (fx) score(players.get(s.by), b, s.sid, fx === 'kill');
  });
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
    else if (m.t === 'ped') ped(p, m);
    else if (m.t === 'prop') prop(p, m);
    else if (m.t === 'ping' && num(m.c, 1e12)) send(ws, { t: 'pong', c: m.c });   // the client's ping readout
  });
  ws.on('close', () => leave(ws));
  ws.on('error', () => {});
});

// Each tick: the bots drive and fire, the city moves on (in two half steps: its code was written for browser frames),
// then one snapshot goes to everyone: every tank and plane, the cars and the tram; every second tick also the pedestrians. The cars and the
// tram stop for the tanks only.
// ts: the server's clock now, the moment of the bots, the traffic and the tram; n: the tick (the same for everyone).
let lastTick = Date.now(), tick = 0;
setInterval(() => {
  const now = Date.now(), dt = Math.min(0.2, (now - lastTick) / 1000);
  lastTick = now;
  if (!humans().length) return;                         // nobody to watch: the city waits
  stepBots(dt);
  const ts = clock(), p = [], tanks = [];
  for (const pl of players.values()) {
    if (!pl.st) continue;
    if (pl.bot) pl.st[7] = ts;
    p.push(pl.st);
    if (pl.st[8] !== PLANE) tanks.push({ x: pl.st[1], z: pl.st[2], h: pl.st[3], v: pl.st[4] });
  }
  for (let k = 0; k < 2; k++) for (const i of world.step(dt / 2, tanks)) broadcast({ t: 'prop', i, up: 1 });
  tick++;
  broadcast({ t: 'snap', ts, n: tick, p, ...world.fast() });
  if (tick % 2 === 0) broadcast({ t: 'w', ts, n: tick, ...world.slow() });
}, TICK_MS);

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
server.listen(PORT, '0.0.0.0', () => console.log(`World of DODO on :${PORT}, ${BOTS} bot(s)`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    for (const ws of wss.clients) ws.close(1001, 'server restart');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
