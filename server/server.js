// World of DODO: the multiplayer server.
//
// It serves the game (client/) and relays the players over one WebSocket at /ws. It does not simulate the
// players: each client drives its own tank and its own city, sends where the tank is about 15 times a
// second and gets everyone's tanks back in one snapshot per tick. A parcel fired by one player is passed on
// to the others, who fly the same parcel in their own world. Whether it hits is decided by the player it
// hits (on that screen the target tank is exactly where it is), and the server scores it for the shooter.
//
// The bots (BOT1, BOT2, ...) are the exception: they live here (server/bots.js), so this server drives them,
// fires their parcels and decides when a parcel hits one of them.
//
// Everything lives in memory: a player is a name, a colour and a score for as long as they are connected.
// Nothing is written anywhere.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { initBot, stepBot, flyParcels, hitBot } = require('./bots');

const PORT = Number(process.env.PORT) || 3000;
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 24;     // people; the bots come on top
const BOTS = Math.max(0, Math.min(8, Number(process.env.BOTS ?? 3)));
const CLIENT_DIR = path.join(__dirname, '..', 'client');
const TICK_MS = 66;                // snapshot rate, about 15 Hz (the clients send at the same rate)
const SHOT_TTL_MS = 15000;         // a parcel can score this long after it was fired (it lives 14 s in the game)
const REJOIN_MS = 60000;           // a player who lost the connection and comes back from the same page keeps the score
const HEARTBEAT_MS = 15000;        // ping every socket; one that has not answered since the last ping is dropped
const MSG_PER_SEC = 60;            // a client sends about 15 states, at most ~4 parcels and a few hits a second
const NAME_MAX = 16;
const WORLD = 300;                 // the game's world ends at 250 units from the centre

// Points for a hit that takes effect: a person is worth much more than a bot.
const POINTS_PLAYER = 10;
const POINTS_BOT = 1;

// The tank colours a player can pick when joining; client/index.html offers the same list (TANK_COLORS).
// Grey is the bots' and red is REDLINE's, so neither is on it.
const COLORS = [0x00a99a, 0xf9aa8f, 0x4d8dff, 0xf2c94c, 0x9b6bff, 0xff7eb6, 0x5ad1e6, 0xff9f43, 0xa3d977, 0xeaebeb, 0x7b8cff, 0xc59b6d];
const BOT_COLOR = 0x8f9997;

// ---------- static files ----------
// Only the page and the three folders it loads from; anything else is a 404.
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',          // the font licenses next to the fonts
};
const STATIC_DIRS = ['vendor', 'fonts', 'assets'];
// The page is one document with inline script and style; it connects only to this host's /ws.
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

function sendFile(res, file, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return notFound(res);
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
    return sendFile(res, path.join(CLIENT_DIR, 'index.html'), 'no-cache');
  }
  const top = pathname.split('/')[1];
  if (!STATIC_DIRS.includes(top)) return notFound(res);
  const file = path.resolve(CLIENT_DIR, '.' + pathname);
  if (!file.startsWith(path.join(CLIENT_DIR, top) + path.sep)) return notFound(res);
  sendFile(res, file, 'public, max-age=86400');
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

function welcome(p) {
  send(p.ws, { t: 'welcome', id: p.id, name: p.name, color: p.color, pts: p.pts,
    players: [...players.values()].filter(o => o !== p).map(pub) });
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
  broadcast({ t: 'leave', id: p.id });
  if (!humans().length) removeBots();                   // nobody left to play with: the bots go home
  console.log(`leave #${p.id} (${humans().length} online)`);
}

function state(p, m) {
  if (!num(m.x, WORLD) || !num(m.z, WORLD) || !num(m.h, 100) || !num(m.v, 40) || !num(m.r, 4)) return;
  p.st = [p.id, m.x, m.z, m.h, m.v, m.r, m.s === 1 ? 1 : 0];     // s: just (re)spawned and immune, the others draw it blinking
}

function remember(p, sid) {
  const now = Date.now();
  p.shots.set(sid, { t: now, scored: false });
  if (p.shots.size > 120) for (const [s, v] of p.shots) if (now - v.t > SHOT_TTL_MS) p.shots.delete(s);
}

function fire(p, m) {
  if (!Number.isInteger(m.sid) || m.sid < 1) return;
  if (!num(m.x, WORLD) || !num(m.y, 100) || !num(m.z, WORLD) || !num(m.vx, 120) || !num(m.vy, 120) || !num(m.vz, 120)) return;
  remember(p, m.sid);
  const shot = { t: 'fire', id: p.id, sid: m.sid, x: m.x, y: m.y, z: m.z, vx: m.vx, vy: m.vy, vz: m.vz };
  broadcast(shot, p);
  if (players.size > humans().length && parcels.length < 300) parcels.push({ ...shot, by: p.id, age: 0 });
}

// A scoring hit: once per parcel, only for a parcel the shooter really fired and only while it can still fly.
function score(shooter, victim, sid, gain, kill) {
  const shot = shooter && shooter !== victim && shooter.shots.get(sid);
  if (!shot || shot.scored || Date.now() - shot.t > SHOT_TTL_MS) return;
  shot.scored = true;
  shooter.pts += gain;
  broadcast({ t: 'hit', by: shooter.id, v: victim.id, pts: shooter.pts, gain, kill: !!kill });
}

// A person reports that a parcel hit them (and whether that hit destroyed their tank).
function hit(victim, m) {
  if (!Number.isInteger(m.sid)) return;
  score(players.get(m.by), victim, m.sid, POINTS_PLAYER, m.kill === true);
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

function stepBots(dt) {
  const people = humans(), list = bots();
  if (!list.length) return;
  for (const b of list) {
    const shot = stepBot(b, dt, people, [...players.values()].filter(o => o !== b && o.st));
    if (!shot) continue;
    remember(b, shot.sid);
    broadcast({ t: 'fire', id: b.id, ...shot });
  }
  flyParcels(parcels, list, dt, (b, s) => {
    const fx = hitBot(b);
    if (fx) score(players.get(s.by), b, s.sid, POINTS_BOT, fx === 'kill');
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
    else if (m.t === 'ping' && num(m.c, 1e12)) send(ws, { t: 'pong', c: m.c });   // the client's ping readout
  });
  ws.on('close', () => leave(ws));
  ws.on('error', () => {});
});

// Each tick: the bots drive and fire, then one snapshot of every tank in the city goes to everyone.
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now(), dt = Math.min(0.2, (now - lastTick) / 1000);
  lastTick = now;
  if (!players.size) return;
  stepBots(dt);
  const p = [];
  for (const pl of players.values()) if (pl.st) p.push(pl.st);
  if (p.length) broadcast({ t: 'snap', p });
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
